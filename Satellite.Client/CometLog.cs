using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace Satellite.Client
{
    // Every decision COMET makes, for the raid's recording (the replay's "why" for each bot): COMET says each one as a
    // line of JSON (Comet.Api.Decisions.Published). Each is only put by as it's said (COMET gives a listener a
    // millisecond), and once a second the lot goes to the server on a link of its own (api/link/comet), never with the
    // reports the pages are sent. Only while the server records the raid and asks for them (the push answer's "cm":
    // 1, each decision without its settings, the "...Config" parts; 2, all of it, and COMET's reports of the whole raid
    // as it's cleaned up, T01-T04: history.cometDebug). Nothing is kept while it's off.
    internal static class CometLog
    {
        // a decision longer than this is left out (COMET's own cap is 32 KiB)
        private const int MostLength = 32768;
        // what may wait for the link at most (a link that's down a long while): the oldest go
        private const int MostWaiting = 20000;
        // a message to the server at most this long (it takes 4 MB)
        private const int MostMessage = 1_500_000;

        // 0: none asked for; 1: decisions without their settings; 2: everything (see above). As the server asks now:
        // out of a raid it asks for none, but what COMET says of the raid just left (as it's cleaned up, its reports
        // of the whole raid) comes after, so the raid's own is kept for a while once it's left (Asked)
        internal static volatile int Mode;
        private static volatile int _leftMode;
        private static int _leftUntil;
        // (how long after the raid is left what COMET says still goes with it, ms)
        private const int AfterRaid = 120_000;

        // what's asked for now, the raid just left's for a while after it (any thread: no Unity calls)
        private static int Asked
        {
            get
            {
                var now = Mode;
                return now != 0 ? now : _leftMode != 0 && unchecked(Environment.TickCount - _leftUntil) < 0 ? _leftMode : 0;
            }
        }

        private static readonly object Gate = new object();
        private static List<string> _waiting = new List<string>();
        private static readonly Link Linked = new Link("comet");
        private static Delegate _listener;
        private static Delegate _summaryListener;
        private static Action _flushPending;
        private static bool _bound;
        private static volatile bool _sending;
        private static float _next;
        private static int _dropped;
        private static bool _saidDropped;

        internal static void Bind(Type decisions)
        {
            if (_bound || decisions == null)
            {
                return;
            }

            try
            {
                // (only the version of what it says that's known)
                var schema = decisions.GetField("SchemaVersion", BindingFlags.Public | BindingFlags.Static);
                var published = decisions.GetEvent("Published", BindingFlags.Public | BindingFlags.Static);
                if (published == null || schema == null || !(schema.GetRawConstantValue() is int version) || version != 1)
                {
                    return;
                }

                Action<string> hear = Hear;
                _listener = hear;
                published.AddEventHandler(null, _listener);
                // the reports of the whole raid, said once it's cleaned up (an older COMET has none)
                var summaries = decisions.GetEvent("SummaryPublished", BindingFlags.Public | BindingFlags.Static);
                if (summaries != null)
                {
                    Action<string> summary = HearSummary;
                    _summaryListener = summary;
                    summaries.AddEventHandler(null, _summaryListener);
                }

                var flush = decisions.GetMethod("FlushPending", BindingFlags.Public | BindingFlags.Static, null, Type.EmptyTypes, null);
                if (flush != null)
                {
                    _flushPending = (Action)Delegate.CreateDelegate(typeof(Action), flush);
                }

                _bound = true;
            }
            catch (Exception)
            {
                // without, then
            }
        }

        // On COMET's thread: put by, nothing more
        private static void Hear(string json)
        {
            if (Asked == 0 || json == null || json.Length > MostLength)
            {
                return;
            }

            Put(json);
        }

        // (on whichever thread COMET writes its reports from)
        private static void HearSummary(string json)
        {
            if (Asked != 2 || json == null || json.Length > MostLength)
            {
                return;
            }

            Put(json);
        }

        private static void Put(string json)
        {
            lock (Gate)
            {
                if (_waiting.Count >= MostWaiting)
                {
                    _waiting.RemoveAt(0);
                    _dropped++;
                }

                _waiting.Add(json);
            }
        }

        // The raid's just been left: what COMET still has to say of it (its reports of the whole raid) is said now
        internal static void RaidLeft()
        {
            _leftMode = Mode;
            _leftUntil = unchecked(Environment.TickCount + AfterRaid);
            if (Mode == 2 && _flushPending != null)
            {
                try
                {
                    _flushPending();
                }
                catch (Exception)
                {
                    // not this time
                }
            }
        }

        // From Update: once a second, what's waiting goes to the server
        internal static void Tick(float delta)
        {
            if (!_bound || Asked == 0 && _waiting.Count == 0)
            {
                return;
            }

            Linked.Tick(delta);
            _next -= delta;
            if (_next > 0f || _sending || !Linked.Open)
            {
                return;
            }

            _next = 1f;
            List<string> lines;
            lock (Gate)
            {
                if (_waiting.Count == 0)
                {
                    return;
                }

                lines = _waiting;
                _waiting = new List<string>();
            }

            if (!Events.ClockOf(out var raid, out var began))
            {
                return;
            }

            if (_dropped > 0 && !_saidDropped)
            {
                _saidDropped = true;
                Plugin.Log?.LogWarning($"COMET said more than Satellite could send to the server: {_dropped} of its decisions were left out of the raid's recording.");
            }

            var full = Asked == 2;
            _sending = true;
            Task.Run(() =>
            {
                try
                {
                    Send(lines, raid, began, full, 0);
                }
                catch (Exception)
                {
                    _sending = false;
                }
            });
        }

        // lines[from..] as messages of up to MostMessage, one after another (each waits for the last's answer)
        private static void Send(List<string> lines, string raid, float began, bool full, int from)
        {
            var to = new StringBuilder(64 * 1024);
            to.Append("{\"rid\":").Append(JsonConvert.ToString(raid)).Append(",\"ev\":[");
            var first = true;
            var i = from;
            for (; i < lines.Count && to.Length < MostMessage; i++)
            {
                var line = Line(lines[i], began, full);
                if (line == null)
                {
                    continue;
                }

                if (!first)
                {
                    to.Append(',');
                }

                first = false;
                to.Append(line);
            }

            to.Append("]}");
            var bytes = Encoding.UTF8.GetBytes(to.ToString());
            var next = i;
            var sent = Linked.Send(bytes, bytes.Length, (ok, answer) =>
            {
                if (next < lines.Count)
                {
                    try
                    {
                        Send(lines, raid, began, full, next);
                        return;
                    }
                    catch (Exception)
                    {
                        // the rest are left out
                    }
                }

                _sending = false;
            });
            if (!sent)
            {
                _sending = false;
            }
        }

        // One decision as {"t":<ms on the raid's clock>,"p":whose (profile id),"f":feature,"s":stage,"d":{...}}, without
        // its settings unless full; null: unreadable
        private static string Line(string json, float began, bool full)
        {
            JObject said;
            try
            {
                said = JObject.Parse(json);
            }
            catch (JsonException)
            {
                return null;
            }

            var realtime = said.Value<double?>("realtime");
            var t = realtime.HasValue ? Math.Max(0L, (long)((realtime.Value - began) * 1000.0)) : 0L;
            var head = "{\"t\":" + t + ",\"p\":" + JsonConvert.ToString(Word(said, "profileId")) + ",\"f\":" + JsonConvert.ToString(Word(said, "feature"))
                + ",\"s\":" + JsonConvert.ToString(Word(said, "stage")) + ",\"d\":";
            if (!full)
            {
                List<string> settings = null;
                foreach (var part in said.Properties())
                {
                    if (part.Name.EndsWith("Config", StringComparison.Ordinal) && part.Value is JObject)
                    {
                        (settings ?? (settings = new List<string>())).Add(part.Name);
                    }
                }

                if (settings != null)
                {
                    foreach (var name in settings)
                    {
                        said.Remove(name);
                    }
                }

                return head + said.ToString(Formatting.None) + "}";
            }

            return head + json + "}";
        }

        // a text field of it, without tabs or line ends (the server writes these as columns)
        private static string Word(JObject said, string name)
        {
            var value = said[name] as JValue;
            var text = value != null && value.Type == JTokenType.String ? (string)value : "";
            return (text.Length > 64 ? text.Substring(0, 64) : text).Replace('\t', ' ').Replace('\n', ' ').Replace('\r', ' ');
        }
    }
}
