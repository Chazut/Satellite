using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using SPTarkov.Server.Core.Models.Common;

namespace Satellite.Server;

// The game plugin's link: one WebSocket for each kind of thing it sends (api/link/push, api/link/things), kept open
// for as long as the game runs. Each message is what it would have POSTed to api/push or api/things, and is answered
// with what that POST would have been answered with: an empty answer when it wasn't taken. One request line in
// SPT's log for the whole game, where a POST is a line every time (ten a second in a raid).
public partial class LiveMapRoute
{
    private async Task Link(MongoId sessionId, HttpContext context, string route, CancellationToken cancellationToken)
    {
        var id = GameSession(sessionId);
        if (id == null || (route != "push" && route != "things"))
        {
            context.Response.StatusCode = id == null ? 403 : 404;
            return;
        }

        using var socket = await context.WebSockets.AcceptWebSocketAsync();
        try
        {
            await AnswerLink(socket, id, route, cancellationToken);
        }
        catch (WebSocketException)
        {
            // the game went away without closing it (quit, crashed): nothing to say
        }
    }

    private async Task AnswerLink(WebSocket socket, string id, string route, CancellationToken cancellationToken)
    {
        var buffer = new byte[64 * 1024];
        using var message = new MemoryStream();
        while (socket.State == WebSocketState.Open && !cancellationToken.IsCancellationRequested)
        {
            // a message comes in frames: put together, up to what a POST may carry
            message.SetLength(0);
            WebSocketReceiveResult got;
            do
            {
                got = await socket.ReceiveAsync(buffer, cancellationToken);
                if (got.MessageType == WebSocketMessageType.Close)
                {
                    await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, cancellationToken);
                    return;
                }

                if (message.Length + got.Count > MaxBody)
                {
                    await socket.CloseOutputAsync(WebSocketCloseStatus.MessageTooBig, null, cancellationToken);
                    return;
                }

                message.Write(buffer, 0, got.Count);
            }
            while (!got.EndOfMessage);

            string? answer;
            try
            {
                var body = message.ToArray();
                answer = route == "push" ? Pushed(id, body) : ThingsTaken(id, body) ? "{\"saved\":true}" : null;
            }
            catch (Exception ex) when (ex is JsonException or InvalidOperationException or FormatException or KeyNotFoundException)
            {
                answer = null;
            }

            await socket.SendAsync(Encoding.UTF8.GetBytes(answer ?? ""), WebSocketMessageType.Text, true, cancellationToken);
        }
    }
}
