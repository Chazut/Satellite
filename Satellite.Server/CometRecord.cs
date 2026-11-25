using System.Buffers;
using System.Collections.Concurrent;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;

namespace Satellite.Server;

// COMET's decisions in a raid's recording: what each bot chose and why, for the replay (see the game plugin's
// CometLog). They come on a link of their own (api/link/comet), a second's worth at a time, and are written beside
// the raid's reports in <id>.comet.gz, one a line: <ms><tab><whose: profile id><tab><feature><tab><stage><tab><the
// decision>, ms as the recording's own lines have it (since it began). Each second's lines are
// packed as one piece of the file (pieces one after another are one gzip file to read), so nothing is held here
// meanwhile. Never sent to the pages as they come: a replay asks for one bot's (api/history/comet?id=&p=).
//
// config.jsonc's "history": "comet" (false as it ships: on once tested in raids) records them, without COMET's settings in each (its
// "...Config" parts); "cometDebug" (false) records all of it, and COMET's reports of the whole raid (T01-T04), with
// each of the settings written once (a line c<tab><n><tab>{...}, and {"$c":n} where it was); "cometMb" (100): the most
// a raid's file may take, after which the rest of its decisions are left out (the raid is recorded as before).
public partial class LiveMapRoute
{
    private sealed class CometFile
    {
        public readonly Lock Lock = new();
        public readonly Dictionary<string, int> Settings = new(StringComparer.Ordinal);
        public bool Full;
    }

    private readonly ConcurrentDictionary<string, CometFile> _cometFiles = new(StringComparer.Ordinal);
    private (bool On, bool Debug, long Most)? _cometSettings;

    private (bool On, bool Debug, long Most) CometSettings()
    {
        if (_cometSettings is { } read)
        {
            return read;
        }

        var on = false;
        var debug = false;
        var mb = 100;
        try
        {
            var file = ConfigFile();
            if (File.Exists(file))
            {
                var options = new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true };
                var history = JsonNode.Parse(File.ReadAllText(file), null, options)?["history"];
                if (history?["comet"] is JsonValue a && a.TryGetValue<bool>(out var said))
                {
                    on = said;
                }

                if (history?["cometDebug"] is JsonValue b && b.TryGetValue<bool>(out var all))
                {
                    debug = all;
                }

                if (history?["cometMb"] is JsonValue c && c.TryGetValue<int>(out var most))
                {
                    mb = Math.Clamp(most, 1, 2000);
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException)
        {
            // as it ships
        }

        _cometSettings = (on, debug, mb * 1_000_000L);
        return _cometSettings.Value;
    }

    // what the push answer asks the plugin for ("cm"): 0 nothing, 1 the decisions, 2 all of it (see above)
    private int CometAsked(Session session)
    {
        if (!Recorded(session))
        {
            return 0;
        }

        var (on, debug, _) = CometSettings();
        return !on ? 0 : debug ? 2 : 1;
    }

    // A second's decisions from the game: {"rid":"<the plugin's raid>","ev":[{"t":<ms>,"d":{...}},..]}. Into the
    // recording of that raid, going on or just over (COMET's reports of the whole raid come as it's cleaned up).
    // True: taken (kept or not).
    private bool CometTaken(string id, byte[] body)
    {
        using var said = JsonDocument.Parse(body);
        var root = said.RootElement;
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("rid", out var ridAt) || ridAt.ValueKind != JsonValueKind.String
            || !root.TryGetProperty("ev", out var list) || list.ValueKind != JsonValueKind.Array)
        {
            return false;
        }

        var rid = ridAt.GetString() ?? "";
        Recording? to = _recording.TryGetValue(id, out var now) && now.Rid == rid ? now
            : _ended.TryGetValue(id, out var was) && was.Rid == rid ? was : null;
        var (on, debug, most) = CometSettings();
        if (to == null || !on || !RecordOn())
        {
            return true;
        }

        var keep = _cometFiles.GetOrAdd(to.Id, _ => new CometFile());
        var file = Path.Combine(HistoryFolder, to.Id + ".comet.gz");
        lock (keep.Lock)
        {
            if (keep.Full)
            {
                return true;
            }

            var size = File.Exists(file) ? new FileInfo(file).Length : 0;
            if (size >= most)
            {
                keep.Full = true;
                logger.Warning($"[Satellite] Raid {to.Id}: COMET's decisions came to more than history.cometMb; the rest of them aren't recorded.");
                return true;
            }

            try
            {
                using var stream = new FileStream(file, FileMode.Append, FileAccess.Write, FileShare.Read);
                using var packed = new GZipStream(stream, CompressionLevel.Fastest);
                using var text = new StreamWriter(packed, new UTF8Encoding(false));
                // the plugin's raid clock to the recording's: as the latest full report had them (else as of now)
                var lag = to.ClockLag != long.MinValue ? to.ClockLag : 0;
                foreach (var e in list.EnumerateArray())
                {
                    if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty("t", out var t) || !t.TryGetInt64(out var at)
                        || !e.TryGetProperty("d", out var d) || d.ValueKind != JsonValueKind.Object)
                    {
                        continue;
                    }

                    // (worked out first: a setting seen for the first time writes its own line before this one)
                    var line = debug ? Shared(d, keep, text) : d.GetRawText();
                    text.Write(Math.Max(0, at + lag));
                    foreach (var column in new[] { "p", "f", "s" })
                    {
                        text.Write('\t');
                        text.Write(e.TryGetProperty(column, out var c) && c.ValueKind == JsonValueKind.String ? Column(c.GetString()) : "");
                    }

                    text.Write('\t');
                    text.Write(line);
                    text.Write('\n');
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                logger.Debug($"[Satellite] COMET's decisions not recorded: {ex.Message}");
            }
        }

        return true;
    }

    // (a column: no tabs or line ends, not too long)
    private static string Column(string? text) =>
        string.IsNullOrEmpty(text) ? "" : (text.Length > 64 ? text[..64] : text).Replace('\t', ' ').Replace('\n', ' ').Replace('\r', ' ');

    // A decision with each of COMET's settings in it ("...Config") written once a raid: a line "c<tab><n><tab>{...}"
    // goes before the first decision to have them, and {"$c":n} stands in its place
    private static string Shared(JsonElement d, CometFile keep, StreamWriter text)
    {
        var any = false;
        foreach (var part in d.EnumerateObject())
        {
            if (part.Name.EndsWith("Config", StringComparison.Ordinal) && part.Value.ValueKind == JsonValueKind.Object)
            {
                any = true;
                break;
            }
        }

        if (!any)
        {
            return d.GetRawText();
        }

        var buffer = new ArrayBufferWriter<byte>(4096);
        using (var w = new Utf8JsonWriter(buffer))
        {
            w.WriteStartObject();
            foreach (var part in d.EnumerateObject())
            {
                if (part.Name.EndsWith("Config", StringComparison.Ordinal) && part.Value.ValueKind == JsonValueKind.Object)
                {
                    var body = part.Value.GetRawText();
                    if (!keep.Settings.TryGetValue(body, out var n))
                    {
                        n = keep.Settings.Count + 1;
                        keep.Settings[body] = n;
                        // (before the decision's own line: it's written first, its decision after)
                        text.Write("c\t");
                        text.Write(n);
                        text.Write('\t');
                        text.Write(body);
                        text.Write('\n');
                    }

                    w.WritePropertyName(part.Name);
                    w.WriteStartObject();
                    w.WriteNumber("$c", n);
                    w.WriteEndObject();
                }
                else
                {
                    part.WriteTo(w);
                }
            }

            w.WriteEndObject();
        }

        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    // GET api/history/comet?id=<raid>&p=<profile id>: that one's decisions, {"ev":[{"t":ms,"d":{...}},..]}, oldest
    // first; with &sum=1, COMET's reports of the whole raid instead (recorded with history.cometDebug). {"none":true}:
    // the raid has none recorded.
    private async Task SendComet(HttpContext context, string id, string profile, bool summaries, CancellationToken cancellationToken)
    {
        var file = Path.Combine(HistoryFolder, id + ".comet.gz");
        if (!RaidId().IsMatch(id) || !File.Exists(file) || !summaries && (profile.Length == 0 || profile.Length > 64))
        {
            await SendJson(context, "{\"none\":true}", cancellationToken);
            return;
        }

        var answer = new StringBuilder(1 << 16).Append("{\"ev\":[");
        var first = true;
        try
        {
            await using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 1 << 16, true);
            await using var unpacked = new GZipStream(stream, CompressionMode.Decompress);
            using var reader = new StreamReader(unpacked, Encoding.UTF8);
            string? line;
            while ((line = await reader.ReadLineAsync(cancellationToken)) != null)
            {
                // <ms> whose feature stage {...}; a setting's line ("c") isn't a decision
                if (line.Length == 0 || line[0] == 'c')
                {
                    continue;
                }

                var cols = line.Split('\t', 5);
                if (cols.Length < 5 || !(summaries ? cols[3] == "summary" && cols[2].StartsWith("T0", StringComparison.Ordinal) : cols[1] == profile))
                {
                    continue;
                }

                if (!first)
                {
                    answer.Append(',');
                }

                first = false;
                answer.Append("{\"t\":").Append(cols[0]).Append(",\"d\":").Append(cols[4]).Append('}');
            }
        }
        catch (Exception ex) when (ex is InvalidDataException or IOException)
        {
            // what could be read of it (a raid going on, or a file cut short)
        }

        await SendJson(context, answer.Append("]}").ToString(), cancellationToken);
    }
}
