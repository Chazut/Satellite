using System;
using System.IO;
using System.Security.Authentication;
using SPT.Common.Http;
using WebSocketSharp;

namespace Satellite.Client
{
    // One WebSocket to the server's api/link/<route>, kept open while the game runs, so a report is a message on it
    // and not a request of its own: SPT logs one line for the link, where it logs one for every POST. Each message is
    // answered in turn, as its POST would have been; an empty answer is a report the server didn't take. Until the
    // link is open (the first moments, a server restarting, or a server without links), Plugin.Post sends by POST.
    internal sealed class Link
    {
        // tried again after this, doubled after each failure up to the most
        private const float FirstWait = 2f;
        private const float MostWait = 60f;

        private readonly string _route;
        private readonly object _lock = new object();
        private WebSocket _socket;
        private bool _connecting;
        private float _wait;
        private float _retryIn;
        private Action<bool, string> _waiting;
        // tries in a row that didn't open, and why the last didn't: said once in the log after a few
        private int _misses;
        private string _why;
        private bool _said;
        private const int SayAfter = 3;

        internal Link(string route)
        {
            _route = route;
            _wait = FirstWait;
        }

        internal bool Open
        {
            get
            {
                var socket = _socket;
                return socket != null && !_connecting && socket.ReadyState == WebSocketState.Open;
            }
        }

        // From Update: opens the link when it's shut and the wait is over. Never waits itself.
        internal void Tick(float delta)
        {
            if (_connecting || Open)
            {
                return;
            }

            _retryIn -= delta;
            if (_retryIn > 0f)
            {
                return;
            }

            if (_misses >= SayAfter && !_said)
            {
                _said = true;
                Plugin.Log?.LogWarning($"Couldn't open the link to the server's /satellite/api/link/{_route} ({_why ?? "no answer"}). Reports go by POST meanwhile, so SPT logs a line for each.");
            }

            _retryIn = _wait;
            _wait = Math.Min(_wait * 2f, MostWait);
            Connect();
        }

        private void Connect()
        {
            var host = RequestHandler.Host;
            if (string.IsNullOrEmpty(host))
            {
                return;
            }

            var secure = host.StartsWith("https://", StringComparison.OrdinalIgnoreCase);
            var address = (secure ? "wss://" + host.Substring(8) : host.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ? "ws://" + host.Substring(7) : host)
                .TrimEnd('/') + "/satellite/api/link/" + _route;

            WebSocket socket;
            try
            {
                socket = new WebSocket(address);
                // its own log only: nothing written for a server that's restarting or has no links
                socket.Log.Level = LogLevel.Fatal;
                socket.Log.Output = (data, file) => { };
                if (secure)
                {
                    // for this link alone: the server's own certificate, as the game's connection takes it
                    socket.SslConfiguration.ServerCertificateValidationCallback = (sender, certificate, chain, errors) => true;
                    socket.SslConfiguration.EnabledSslProtocols = SslProtocols.Tls12;
                }

                socket.SetCookie(new WebSocketSharp.Net.Cookie("PHPSESSID", RequestHandler.SessionId));
                socket.OnOpen += (sender, e) =>
                {
                    _connecting = false;
                    _wait = FirstWait;
                    _misses = 0;
                };
                socket.OnMessage += (sender, e) => Answered(true, e.Data);
                socket.OnClose += (sender, e) =>
                {
                    _why = "closed " + e.Code + (string.IsNullOrEmpty(e.Reason) ? "" : ": " + e.Reason);
                    Shut(socket);
                };
                socket.OnError += (sender, e) =>
                {
                    _why = e.Message;
                    Shut(socket);
                };
            }
            catch (Exception)
            {
                return;
            }

            _socket = socket;
            _connecting = true;
            try
            {
                socket.ConnectAsync();
            }
            catch (Exception)
            {
                Shut(socket);
            }
        }

        private void Shut(WebSocket socket)
        {
            if (socket != _socket)
            {
                return;
            }

            if (_connecting)
            {
                _misses++;
            }

            _connecting = false;
            _socket = null;
            Answered(false, null);
            try
            {
                socket.CloseAsync();
            }
            catch (Exception)
            {
                // gone already
            }
        }

        private void Answered(bool ok, string answer)
        {
            Action<bool, string> done;
            lock (_lock)
            {
                done = _waiting;
                _waiting = null;
            }

            if (done == null)
            {
                return;
            }

            // an empty answer: the server didn't take it (as a POST answered 400)
            done(ok && !string.IsNullOrEmpty(answer), answer);
        }

        // Sends bytes[0..count) and calls done with the answer, on another thread. False (and done never called) when
        // the link isn't open or something is still waiting for its answer: then it goes by POST.
        internal bool Send(byte[] bytes, int count, Action<bool, string> done)
        {
            var socket = _socket;
            if (socket == null || !Open)
            {
                return false;
            }

            lock (_lock)
            {
                if (_waiting != null)
                {
                    return false;
                }

                _waiting = done;
            }

            try
            {
                socket.SendAsync(new MemoryStream(bytes, 0, count, false), count, sent =>
                {
                    if (!sent)
                    {
                        Shut(socket);
                    }
                });
            }
            catch (Exception)
            {
                Shut(socket);
            }

            return true;
        }

        internal void Close()
        {
            var socket = _socket;
            _socket = null;
            _connecting = false;
            if (socket == null)
            {
                return;
            }

            try
            {
                socket.CloseAsync();
            }
            catch (Exception)
            {
                // gone already
            }
        }
    }
}
