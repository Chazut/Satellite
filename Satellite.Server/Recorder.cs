using System.Collections.Concurrent;
using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;

namespace Satellite.Server;

// Raid history: every raid a game reports is kept, so the page can play it back afterwards (its History tab).
//
// A recording is what the page was sent while the raid ran: the full and fast reports of one game, each with when it
// came. Played back through the page's own code, a raid looks as it did live. While nobody watches, the server asks
// the game to keep reporting, slower (the push answer's "slow"), so a raid is recorded whether a page is open or not.
//
// Kept in the mod's folder, history/:
//   <id>.json    about the raid: {"id","sid","name","loc","began" (ms since 1970, UTC),"ms" (how long),"kills",
//                "mine" (the player's own kills),"died","most" (the most markers at once),"live" (still recording),
//                "lead" (ms it waited loaded before the raid began: left out when played back),
//                "exit" (how it ended: "Survived", "Killed"..),"exitName" (the extract),"hl" (a Fika headless ran it),
//                "side" (the player's: "Usec", "Bear", or "Savage" in a Scav raid)}
//   <id>.rec     the reports while it's recorded, one a line: <ms since it began><tab><the report>
//   <id>.rec.gz  the same, packed, once the raid is over
//
//   /satellite/api/history               the raids kept, the newest first
//   /satellite/api/history/rec?id=       a raid's reports
//   POST /satellite/api/history/delete?id=
//   /satellite/api/history/export?id=    a raid as a zip (raid.json, raid.rec), to give to somebody else
//   POST /satellite/api/history/import   such a zip: the raid is added, marked "imported", and never deleted to make room
//   POST /satellite/api/history/names    ["template",..]: what those items are called and worth, as in api/things
//   POST /satellite/api/history/deleteAll   every raid; POST api/history/tidy: files a stopped import or recording left
//   (raids Raid Review recorded: see RaidReviewImport)
//
// config.jsonc: "history": {"record": true, "keep": 30}. keep: the raids kept, the oldest deleted beyond it, until the
// raid history page sets what's kept (history/keep.json: so many raids and/or megabytes, for everyone or each player).
// A raid holding one of a player's records, and an imported one, is never deleted to make room.
public partial class LiveMapRoute
{
    // a raid shorter than this isn't kept (a raid left as it loads, a map scan's)
    private const int ShortestRaid = 45_000;
    // a raid not heard from for this long is over
    private const int RaidGoneAfter = 30_000;

    private sealed class Recording(string id, string sid, string rid)
    {
        public string Id { get; } = id;
        public string Sid { get; } = sid;
        public string Rid { get; } = rid;
        public readonly Lock Lock = new();
        public StreamWriter? Out;
        public long BeganTick;
        public long LastTick;
        public long AboutAt;
        public long Began;
        public string Name = "";
        public string Loc = "";
        public int Kills;
        public int Mine;
        public bool Died;
        public int Most;
        public bool Over;
        // a Fika headless ran the raid; when what lies about was last kept
        public bool Headless;
        public long ThingsAt;
        // how it ended for the player ("Survived", "Killed", "Runner"..), and by which extract
        public string Exit = "";
        public string ExitName = "";
        // what the player had on them as the raid ended (the "end" event's "inv": [template, how many]), priced as
        // "out" when it's kept: what they got out with, when they got out
        public readonly List<(string Tpl, int Count)> HadOn = [];
        // what the player went in with, as their profile had it when the raid began (as a PMC, and as a Scav): what they
        // got out with less this is what the raid gained them ("gain")
        public List<(string Tpl, int Count)>? WentIn;
        public List<(string Tpl, int Count)>? WentInScav;
        // the wait before the raid began (the game said "go":0), and how long it was: -1 until the raid has begun
        public bool Waited;
        public long Lead = -1;
        // the player's side ("Usec", "Bear", or "Savage" for a Scav raid), as their marker says: the raid history's Type
        public string Side = "";
        // the raid's numbers for the raid history's records (see Tally)
        public readonly Tally Tally = new();
    }

    // What the raid history's records are made of, counted from a raid's full reports as they come (or, for a raid
    // recorded before they were kept, from its file once): the damage the player took, the bots seen, and what the
    // player picked up (priced when it's saved).
    private sealed class Tally
    {
        private int _hp = -1;
        public double Hurt;
        public readonly HashSet<long> Bots = [];
        public readonly List<(string Tpl, string Name, int Count)> Loot = [];

        public void Take(JsonElement report)
        {
            if (report.TryGetProperty("markers", out var markers) && markers.ValueKind == JsonValueKind.Array)
            {
                foreach (var m in markers.EnumerateArray())
                {
                    if (m.ValueKind != JsonValueKind.Object || !m.TryGetProperty("c", out var kind) || kind.ValueKind != JsonValueKind.String)
                    {
                        continue;
                    }

                    if (kind.ValueEquals("Main Player"))
                    {
                        // the player's health: every drop in it is damage taken (healing isn't taken off)
                        if (m.TryGetProperty("hp", out var hp) && hp.ValueKind == JsonValueKind.Array && hp.GetArrayLength() > 0 && hp[0].TryGetInt32(out var now))
                        {
                            if (_hp >= 0 && now < _hp)
                            {
                                Hurt += _hp - now;
                            }

                            _hp = now;
                        }

                        continue;
                    }

                    if (m.TryGetProperty("dyn", out _) && !kind.ValueEquals("Friendly Player") && !kind.ValueEquals("Corpse") && !kind.ValueEquals("BTR")
                        && !kind.ValueEquals("Airdrop") && m.TryGetProperty("id", out var id) && id.TryGetInt64(out var number))
                    {
                        Bots.Add(number);
                    }
                }
            }

            if (!report.TryGetProperty("ev", out var events) || events.ValueKind != JsonValueKind.Array)
            {
                return;
            }

            foreach (var e in events.EnumerateArray())
            {
                if (e.ValueKind == JsonValueKind.Object && e.TryGetProperty("k", out var k) && k.ValueEquals("loot") && e.TryGetProperty("d", out var d)
                    && d.ValueKind == JsonValueKind.Object && d.TryGetProperty("wk", out var who) && who.ValueEquals("Main Player")
                    && d.TryGetProperty("tpl", out var tpl) && tpl.ValueKind == JsonValueKind.String)
                {
                    var name = d.TryGetProperty("i", out var i) && i.ValueKind == JsonValueKind.String ? i.GetString() ?? "" : "";
                    var count = d.TryGetProperty("q", out var q) && q.TryGetInt32(out var many) ? Math.Max(1, many) : 1;
                    Loot.Add((tpl.GetString() ?? "", name, count));
                }
            }
        }
    }

    // The tally's numbers into a raid's about: "hurt", "bots", "loot" (what the player picked up is worth), "best" (the
    // dearest thing they picked up: {"i","v"}), and "st" (counted, so an older raid is counted once)
    private void Tallied(JsonObject about, Tally tally)
    {
        about["hurt"] = (int)Math.Round(tally.Hurt);
        about["bots"] = tally.Bots.Count;
        double total = 0, top = 0;
        var best = "";
        if (tally.Loot.Count > 0)
        {
            var names = Names(tally.Loot.Select(l => l.Tpl).Distinct());
            foreach (var (tpl, name, count) in tally.Loot)
            {
                var each = names[tpl]?["p"] is JsonValue p && p.TryGetValue<double>(out var price) ? price : 0;
                total += each * count;
                if (each * count > top)
                {
                    top = each * count;
                    best = (name.Length > 0 ? name : names[tpl]?["s"]?.GetValue<string>() ?? tpl) + (count > 1 ? " ×" + count : "");
                }
            }
        }

        about["loot"] = Math.Round(total);
        if (top > 0)
        {
            about["best"] = new JsonObject { ["i"] = best, ["v"] = Math.Round(top) };
        }

        about["st"] = 1;
    }

    // An older raid's tally, read from its file once (the raid history page's records want it)
    private Tally TallyRecorded(string id)
    {
        var tally = new Tally();
        try
        {
            var packed = Path.Combine(HistoryFolder, id + ".rec.gz");
            var plain = Path.Combine(HistoryFolder, id + ".rec");
            Stream? from = File.Exists(packed) ? new GZipStream(File.OpenRead(packed), CompressionMode.Decompress)
                : File.Exists(plain) ? new FileStream(plain, FileMode.Open, FileAccess.Read, FileShare.ReadWrite) : null;
            if (from == null)
            {
                return tally;
            }

            using var reader = new StreamReader(from, Encoding.UTF8);
            while (reader.ReadLine() is { } line)
            {
                var tab = line.IndexOf('\t');
                if (tab < 0 || !line.AsSpan(tab + 1).StartsWith("{\"t\":\"full\""))
                {
                    continue;
                }

                try
                {
                    using var report = JsonDocument.Parse(line.AsMemory(tab + 1));
                    tally.Take(report.RootElement);
                }
                catch (JsonException)
                {
                    // a line cut short
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidDataException)
        {
            logger.Debug($"[Satellite] Raid's numbers not read: {ex.Message}");
        }

        return tally;
    }

    // the older raids not yet counted, counted one after another away from any request (once each)
    private int _tallying;

    private void TallyOlder(List<string> ids)
    {
        if (ids.Count == 0 || Interlocked.Exchange(ref _tallying, 1) != 0)
        {
            return;
        }

        Task.Run(() =>
        {
            try
            {
                foreach (var id in ids)
                {
                    var file = Path.Combine(HistoryFolder, id + ".json");
                    if (!File.Exists(file) || _recording.Values.Any(r => r.Id == id))
                    {
                        continue;
                    }

                    var tally = TallyRecorded(id);
                    if (JsonNode.Parse(File.ReadAllText(file)) is JsonObject about && !about.ContainsKey("st"))
                    {
                        Tallied(about, tally);
                        File.WriteAllText(file, about.ToJsonString());
                    }
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException)
            {
                logger.Debug($"[Satellite] Raids' numbers not counted: {ex.Message}");
            }
            finally
            {
                Interlocked.Exchange(ref _tallying, 0);
            }
        });
    }

    // What lies about in the raid and what everybody carries, as a page is told it (api/things): kept with the raid's
    // reports once a minute at the most, as a line {"t":"th","d":{...}}, so a replay has the loot of the time.
    private void RecordThings(Session session)
    {
        if (!RecordOn() || !_recording.TryGetValue(session.Id, out var to) || (to.ThingsAt != 0 && Now - to.ThingsAt < 60_000))
        {
            return;
        }

        try
        {
            var text = ThingsFor(session.Id).Text;
            if (text.Length < 20)
            {
                return;
            }

            to.ThingsAt = Now;
            Write(to, "{\"t\":\"th\",\"d\":" + text.Replace("\r", "").Replace("\n", "") + "}");
        }
        catch (Exception ex) when (ex is IOException or JsonException or InvalidOperationException or ObjectDisposedException)
        {
            logger.Debug($"[Satellite] Loot not recorded: {ex.Message}");
        }
    }

    private readonly ConcurrentDictionary<string, Recording> _recording = new();
    // each game's raid recorded last, once it's over: how it ended can come a moment later (see Record)
    private readonly ConcurrentDictionary<string, Recording> _ended = new();
    private Timer? _recordingWatch;
    private (bool Record, int Keep)? _history;

    [GeneratedRegex("^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$")]
    private static partial Regex RaidId();

    private string HistoryFolder => Path.Combine(Folder, "history");

    // config.jsonc's "history": recorded unless it says not, thirty raids kept unless it says another number
    private (bool Record, int Keep) History()
    {
        if (_history is { } read)
        {
            return read;
        }

        var record = true;
        var keep = 30;
        try
        {
            var file = ConfigFile();
            if (File.Exists(file))
            {
                var options = new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true };
                var history = JsonNode.Parse(File.ReadAllText(file), null, options)?["history"];
                if (history?["record"] is JsonValue on && on.TryGetValue<bool>(out var said))
                {
                    record = said;
                }

                if (history?["keep"] is JsonValue count && count.TryGetValue<int>(out var most))
                {
                    keep = Math.Clamp(most, 1, 500);
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException)
        {
            // as it ships
        }

        _history = (record, keep);
        if (record)
        {
            // the raids a server that was stopped mid-raid left open, and the ones gone quiet from here on
            Task.Run(Tidy);
            _recordingWatch = new Timer(_ => EndQuiet(), null, 15_000, 15_000);
        }

        return (record, keep);
    }

    // whether the game should report though nobody watches: it's in a raid, and raids are recorded
    private bool Recorded(Session session) => session.Raid && RecordOn();

    // Recording stopped from the page (the live map's REC button): nothing is recorded, the raid going on included,
    // until it's started again. Kept as the file history/paused being there, so a restart keeps it stopped.
    private string PausedFile => Path.Combine(HistoryFolder, "paused");
    private bool? _paused;
    private bool Paused() => _paused ??= File.Exists(PausedFile);
    private bool RecordOn() => History().Record && !Paused();

    // GET api/history/pause: {"on": config.jsonc records, "paused"}; POST ?paused=1 stops recording (the raids being
    // recorded are ended as far as they got), ?paused=0 starts it again from the next report
    private string Pausing(HttpContext context, bool post)
    {
        if (post)
        {
            var stop = context.Request.Query["paused"] == "1";
            try
            {
                Directory.CreateDirectory(HistoryFolder);
                if (stop)
                {
                    File.WriteAllText(PausedFile, "");
                }
                else if (File.Exists(PausedFile))
                {
                    File.Delete(PausedFile);
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                logger.Warning($"[Satellite] Couldn't {(stop ? "stop" : "start")} recording for good (only until the server restarts): {ex.Message}");
            }

            _paused = stop;
            if (stop)
            {
                foreach (var (sid, of) in _recording)
                {
                    if (_recording.TryRemove(new KeyValuePair<string, Recording>(sid, of)))
                    {
                        End(of);
                    }
                }
            }
        }

        return new JsonObject { ["on"] = History().Record, ["paused"] = Paused() }.ToJsonString();
    }

    // A report on its way to the pages: kept, when it's a raid's.
    private void Record(Session session, string report)
    {
        if (!RecordOn() || !report.StartsWith("{\"t\":\"", StringComparison.Ordinal))
        {
            return;
        }

        try
        {
            var fast = report.AsSpan(6).StartsWith("fast\"");
            if (fast)
            {
                if (_recording.TryGetValue(session.Id, out var going))
                {
                    Write(going, report);
                }

                return;
            }

            if (!report.AsSpan(6).StartsWith("full\""))
            {
                // idle: out of the raid
                if (!session.Raid && _recording.TryRemove(session.Id, out var left))
                {
                    End(left);
                }

                return;
            }

            using var document = JsonDocument.Parse(report);
            var root = document.RootElement;
            var raid = root.TryGetProperty("raid", out var inRaid) && inRaid.ValueKind == JsonValueKind.True;
            var rid = root.TryGetProperty("rid", out var said) && said.ValueKind == JsonValueKind.String ? said.GetString() ?? "" : "";
            _recording.TryGetValue(session.Id, out var now);
            if (now != null && (!raid || rid != now.Rid))
            {
                // the first report after the raid brings what happened in its last moments (how it ended): kept
                if (!raid && rid == now.Rid && root.TryGetProperty("ev", out var last) && last.ValueKind == JsonValueKind.Array)
                {
                    Counted(now, last);
                    Write(now, report);
                }

                _recording.TryRemove(session.Id, out _);
                End(now);
                now = null;
            }

            if (!raid || rid.Length == 0)
            {
                // how a raid that's over ended, told after its recording was closed: added to what's kept of it
                if (!raid && now == null && rid.Length > 0 && _ended.TryGetValue(session.Id, out var was) && was.Rid == rid
                    && root.TryGetProperty("ev", out var late) && late.ValueKind == JsonValueKind.Array)
                {
                    var exit = was.Exit;
                    Counted(was, late);
                    if (was.Exit != exit && was.LastTick - was.BeganTick >= ShortestRaid && was.Loc.Length > 0)
                    {
                        Task.Run(() =>
                        {
                            try
                            {
                                lock (was.Lock)
                                {
                                    SaveAbout(was, false);
                                }
                            }
                            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                            {
                                logger.Debug($"[Satellite] Raid's end not kept: {ex.Message}");
                            }
                        });
                    }
                }

                return;
            }

            if (now == null)
            {
                now = Begin(session, rid);
                if (now == null)
                {
                    return;
                }

                _recording[session.Id] = now;
            }

            if (root.TryGetProperty("loc", out var loc) && loc.ValueKind == JsonValueKind.String && LocationName().IsMatch(loc.GetString() ?? ""))
            {
                now.Loc = loc.GetString() ?? now.Loc;
            }

            if (root.TryGetProperty("markers", out var markers) && markers.ValueKind == JsonValueKind.Array)
            {
                now.Most = Math.Max(now.Most, markers.GetArrayLength());
                if (now.Side.Length == 0)
                {
                    foreach (var marker in markers.EnumerateArray())
                    {
                        if (marker.ValueKind == JsonValueKind.Object && marker.TryGetProperty("c", out var kind) && kind.ValueEquals("Main Player")
                            && marker.TryGetProperty("sd", out var side) && side.ValueKind == JsonValueKind.String && side.GetString() is { Length: > 0 and <= 16 } playerSide)
                        {
                            now.Side = playerSide;
                            break;
                        }
                    }
                }
            }

            if (root.TryGetProperty("ev", out var events) && events.ValueKind == JsonValueKind.Array)
            {
                Counted(now, events);
            }

            now.Tally.Take(root);

            if (root.TryGetProperty("go", out var go) && go.ValueKind == JsonValueKind.Number && go.GetInt32() == 0)
            {
                now.Waited = true;
            }
            else if (now.Lead < 0)
            {
                now.Lead = now.Waited ? Now - now.BeganTick : 0;
            }

            now.Headless = HostOf(session) is { Headless: true };
            now.Name = session.Name is { } name ? JsonSerializer.Deserialize<string>(name) ?? "" : now.Name;
            Write(now, report);
            // what's known of it so far, every half a minute: a server stopped mid-raid leaves a raid that can be read
            if (Now - now.AboutAt > 30_000)
            {
                now.AboutAt = Now;
                SaveAbout(now, true);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or ObjectDisposedException)
        {
            logger.Debug($"[Satellite] Raid not recorded: {ex.Message}");
        }
    }

    // what a report's events say of the raid as a whole: the kills, and how it ended for the player
    private static void Counted(Recording of, JsonElement events)
    {
        foreach (var one in events.EnumerateArray())
        {
            if (one.ValueKind != JsonValueKind.Object || !one.TryGetProperty("k", out var kind)
                || !one.TryGetProperty("d", out var detail) || detail.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            if (kind.ValueEquals("end"))
            {
                of.Exit = detail.TryGetProperty("st", out var status) && status.ValueKind == JsonValueKind.String ? status.GetString() ?? "" : "";
                of.ExitName = detail.TryGetProperty("ex", out var exit) && exit.ValueKind == JsonValueKind.String ? exit.GetString() ?? "" : "";
                if (detail.TryGetProperty("inv", out var had) && had.ValueKind == JsonValueKind.Array)
                {
                    of.HadOn.Clear();
                    foreach (var row in had.EnumerateArray())
                    {
                        if (row.ValueKind == JsonValueKind.Array && row.GetArrayLength() >= 2 && row[0].ValueKind == JsonValueKind.String && row[1].TryGetInt32(out var many))
                        {
                            of.HadOn.Add((row[0].GetString() ?? "", Math.Max(1, many)));
                        }
                    }
                }

                continue;
            }

            if (!kind.ValueEquals("kill"))
            {
                continue;
            }

            of.Kills++;
            if (detail.TryGetProperty("kk", out var killer) && killer.ValueEquals("Main Player"))
            {
                of.Mine++;
            }

            if (detail.TryGetProperty("vk", out var victim) && victim.ValueEquals("Main Player"))
            {
                of.Died = true;
            }
        }
    }

    private Recording? Begin(Session session, string rid)
    {
        Directory.CreateDirectory(HistoryFolder);
        var began = DateTime.UtcNow;
        var tail = session.Id.Length >= 6 ? session.Id[^6..].ToLowerInvariant() : "000000";
        var id = began.ToLocalTime().ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture) + "-" + tail;
        if (!RaidId().IsMatch(id))
        {
            return null;
        }

        var file = Path.Combine(HistoryFolder, id + ".rec");
        return new Recording(id, session.Id, rid)
        {
            WentIn = KitOf(session.Id, false),
            WentInScav = KitOf(session.Id, true),
            Out = new StreamWriter(new FileStream(file, FileMode.Create, FileAccess.Write, FileShare.Read, 1 << 16), new UTF8Encoding(false)),
            BeganTick = Now,
            LastTick = Now,
            AboutAt = Now,
            Began = new DateTimeOffset(began).ToUnixTimeMilliseconds()
        };
    }

    // Everything a profile's character has on them (worn, and all that's in it, the pockets' and secure container's
    // too): [template, how many]. Until the raid is over the profile holds what they went in with. Read wider than the
    // game's plugin reads what they got out with (Recorded.Had), so nothing they went in with is ever counted as gained.
    private List<(string Tpl, int Count)>? KitOf(string sid, bool scav)
    {
        try
        {
            foreach (var (profileId, profile) in saveServer.GetProfiles())
            {
                if (profileId.ToString() != sid)
                {
                    continue;
                }

                var inventory = scav ? profile?.CharacterData?.ScavData?.Inventory : profile?.CharacterData?.PmcData?.Inventory;
                if (inventory?.Items is not { } items || inventory.Equipment?.ToString() is not { Length: > 0 } worn)
                {
                    return null;
                }

                var inside = items.Where(i => i.ParentId != null).ToLookup(i => i.ParentId!.ToString());
                var kit = new List<(string Tpl, int Count)>();
                var seen = new HashSet<string>();
                var next = new Queue<string>();
                next.Enqueue(worn);
                while (next.Count > 0 && kit.Count < 2000)
                {
                    foreach (var item in inside[next.Dequeue()])
                    {
                        var id = item.Id.ToString();
                        if (!seen.Add(id))
                        {
                            continue;
                        }

                        kit.Add((item.Template.ToString(), Math.Max(1, (int)Math.Round(item.Upd?.StackObjectsCount ?? 1))));
                        next.Enqueue(id);
                    }
                }

                return kit;
            }
        }
        catch (Exception ex)
        {
            logger.Debug($"[Satellite] What was taken into the raid isn't known: {ex.Message}");
        }

        return null;
    }

    // an extract's name as the game shows it in English ("E8_yard" is "Courtyard"); null when the game has none
    private string? ExitTitle(string exit)
    {
        if (exit.Length == 0)
        {
            return null;
        }

        lock (_namesLock)
        {
            return Locale().TryGetValue(exit, out var title) && !string.IsNullOrWhiteSpace(title) && title != exit ? title : null;
        }
    }

    private static void Write(Recording to, string report)
    {
        lock (to.Lock)
        {
            if (to.Over || to.Out == null)
            {
                return;
            }

            to.LastTick = Now;
            to.Out.Write(to.LastTick - to.BeganTick);
            to.Out.Write('\t');
            to.Out.Write(report);
            to.Out.Write('\n');
        }
    }

    private void SaveAbout(Recording of, bool live)
    {
        var about = new JsonObject
        {
            ["id"] = of.Id,
            ["sid"] = of.Sid,
            ["name"] = of.Name,
            ["loc"] = of.Loc,
            ["began"] = of.Began,
            ["ms"] = of.LastTick - of.BeganTick,
            ["kills"] = of.Kills,
            ["mine"] = of.Mine,
            ["died"] = of.Died,
            ["most"] = of.Most
        };
        if (of.Headless)
        {
            about["hl"] = true;
        }

        if (of.Lead > 0)
        {
            about["lead"] = of.Lead;
        }

        if (of.Side.Length > 0)
        {
            about["side"] = of.Side;
        }

        if (of.Exit.Length > 0)
        {
            about["exit"] = of.Exit;
            about["exitName"] = of.ExitName;
        }

        if (ExitTitle(of.ExitName) is { } exitTitle)
        {
            about["exitTitle"] = exitTitle;
        }

        // what the player got out with, priced (only told by a newer plugin, as the raid ends): "out" all of it, kit and
        // all; "gain" only what they hadn't on them going in (by template and how many, so kit lost or used up doesn't
        // take from what was found)
        if (of.HadOn.Count > 0)
        {
            var names = Names(of.HadOn.Select(o => o.Tpl).Distinct());
            double PriceOf(string tpl) => names[tpl]?["p"] is JsonValue p && p.TryGetValue<double>(out var price) ? price : 0;
            double carried = 0;
            foreach (var (tpl, count) in of.HadOn)
            {
                carried += PriceOf(tpl) * count;
            }

            about["out"] = Math.Round(carried);
            var wentIn = of.Side.Equals("Savage", StringComparison.OrdinalIgnoreCase) ? of.WentInScav : of.WentIn;
            if (wentIn != null)
            {
                var before = wentIn.GroupBy(o => o.Tpl).ToDictionary(g => g.Key, g => g.Sum(o => o.Count));
                double gain = 0;
                foreach (var got in of.HadOn.GroupBy(o => o.Tpl))
                {
                    gain += PriceOf(got.Key) * Math.Max(0, got.Sum(o => o.Count) - before.GetValueOrDefault(got.Key));
                }

                about["gain"] = Math.Round(gain);
                about["in"] = Math.Round(Math.Max(0, carried - gain));
            }
        }

        Tallied(about, of.Tally);

        if (live)
        {
            about["live"] = true;
            lock (of.Lock)
            {
                of.Out?.Flush();
            }
        }

        File.WriteAllText(Path.Combine(HistoryFolder, of.Id + ".json"), about.ToJsonString());
    }

    // The raid is over: its reports are packed, and the oldest raids beyond the number kept are deleted.
    private void End(Recording of)
    {
        lock (of.Lock)
        {
            if (of.Over)
            {
                return;
            }

            of.Over = true;
            of.Out?.Dispose();
            of.Out = null;
        }

        _ended[of.Sid] = of;

        Task.Run(() =>
        {
            try
            {
                var rec = Path.Combine(HistoryFolder, of.Id + ".rec");
                if (of.LastTick - of.BeganTick < ShortestRaid || of.Loc.Length == 0)
                {
                    File.Delete(rec);
                    File.Delete(Path.Combine(HistoryFolder, of.Id + ".json"));
                    return;
                }

                SaveAbout(of, false);
                Pack(rec);
                Trim();
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                logger.Warning($"[Satellite] Couldn't finish the recording of raid {of.Id}: {ex.Message}");
            }
        });
    }

    private static void Pack(string rec)
    {
        var part = rec + ".gz.part";
        using (var from = File.OpenRead(rec))
        using (var to = new GZipStream(File.Create(part), CompressionLevel.Optimal))
        {
            from.CopyTo(to);
        }

        File.Move(part, rec + ".gz", true);
        File.Delete(rec);
    }

    // What's kept, as set on the raid history page (history/keep.json), else config.jsonc's history.keep:
    // "keep" raids (0: no limit), "mb" megabytes on the disk (0: no limit), "per": "all" (the limits are for every
    // raid together) or "player" (for each player's own: in a Fika raid each friend's game records too).
    private sealed record KeepRule(int Keep, int Mb, string Per);
    private string KeepFile => Path.Combine(HistoryFolder, "keep.json");
    private readonly object _keepLock = new();

    private KeepRule Keeping()
    {
        var rule = new KeepRule(History().Keep, 0, "all");
        try
        {
            if (File.Exists(KeepFile) && JsonNode.Parse(File.ReadAllText(KeepFile)) is JsonObject set)
            {
                var keep = set["keep"] is JsonValue k && k.TryGetValue<int>(out var n) ? Math.Clamp(n, 0, 5000) : rule.Keep;
                var mb = set["mb"] is JsonValue m && m.TryGetValue<int>(out var size) ? Math.Clamp(size, 0, 1_000_000) : 0;
                var per = set["per"]?.GetValue<string>() == "player" ? "player" : "all";
                rule = new KeepRule(keep, mb, per);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or FormatException)
        {
            // as config.jsonc has it
        }

        return rule;
    }

    // POST api/history/keep?keep=&mb=&per=: kept, and what's over the limits deleted now
    private string SaveKeep(HttpContext context)
    {
        var q = context.Request.Query;
        var keep = int.TryParse(q["keep"], out var k) ? Math.Clamp(k, 0, 5000) : Keeping().Keep;
        var mb = int.TryParse(q["mb"], out var m) ? Math.Clamp(m, 0, 1_000_000) : 0;
        var per = q["per"] == "player" ? "player" : "all";
        Directory.CreateDirectory(HistoryFolder);
        File.WriteAllText(KeepFile, new JsonObject { ["keep"] = keep, ["mb"] = mb, ["per"] = per }.ToJsonString());
        Trim();
        return "{\"ok\":true}";
    }

    // The raids that hold one of a player's records (the raid history page's Records: most kills, most looted, best
    // loot, most bots, most damage taken, longest raid extracted, most got out with): kept, whatever the limits, until
    // another raid beats them. A Fika headless's raids hold none.
    private static HashSet<string> RecordHolders(List<(string Id, JsonObject About)> raids)
    {
        var keep = new HashSet<string>();
        double Num(JsonObject a, string key) => a[key] is JsonValue v && v.TryGetValue<double>(out var d) ? d : 0;
        bool Out(JsonObject a) => a["exit"]?.GetValue<string>() == "Survived" && a["exitName"]?.GetValue<string>() != "Map scan";
        double Best(JsonObject a) => a["best"] is JsonObject b ? Num(b, "v") : 0;
        // (nor do the map scanner's runs: "Map scan" is how they end)
        foreach (var mine in raids.Where(r => !(r.About["hl"] is JsonValue h && h.TryGetValue<bool>(out var hl) && hl) && r.About["exitName"]?.GetValue<string>() != "Map scan")
                     .GroupBy(r => r.About["sid"]?.GetValue<string>() ?? r.About["name"]?.GetValue<string>() ?? ""))
        {
            foreach (var of in new Func<JsonObject, double>[]
                     {
                         a => Num(a, "mine"), a => Num(a, "loot"), Best, a => Num(a, "bots"), a => Num(a, "hurt"),
                         a => Out(a) ? Num(a, "ms") - Num(a, "lead") : 0,
                         // (what the raid gained them: a raid from before that was kept counts what was picked up)
                         a => Out(a) ? (a.ContainsKey("gain") ? Num(a, "gain") : Num(a, "loot")) : 0
                     })
            {
                var top = mine.OrderByDescending(r => of(r.About)).FirstOrDefault();
                if (top.About != null && of(top.About) > 0)
                {
                    keep.Add(top.Id);
                }
            }
        }

        return keep;
    }

    private void Trim()
    {
        lock (_keepLock)
        {
            var rule = Keeping();
            var raids = new List<(string Id, JsonObject About)>();
            foreach (var file in Directory.GetFiles(HistoryFolder, "*.json"))
            {
                var id = Path.GetFileNameWithoutExtension(file);
                if (!RaidId().IsMatch(id))
                {
                    continue;
                }

                try
                {
                    if (JsonNode.Parse(File.ReadAllText(file)) is JsonObject about)
                    {
                        raids.Add((id, about));
                    }
                }
                catch (Exception ex) when (ex is IOException or JsonException)
                {
                    // read next time
                }
            }

            // never deleted to make room: imported raids, one being recorded, and the ones that hold a record
            var held = RecordHolders(raids);
            bool Spared((string Id, JsonObject About) r) => held.Contains(r.Id) || _recording.Values.Any(o => o.Id == r.Id)
                || (r.About["imported"] is JsonValue v && v.TryGetValue<bool>(out var yes) && yes);
            long Size(string id) => new[] { ".json", ".rec", ".rec.gz" }.Select(e => new FileInfo(Path.Combine(HistoryFolder, id + e))).Where(f => f.Exists).Sum(f => f.Length);
            var groups = rule.Per == "player"
                ? raids.GroupBy(r => r.About["sid"]?.GetValue<string>() ?? r.About["name"]?.GetValue<string>() ?? "").Select(g => g.ToList())
                : [raids];
            foreach (var group in groups)
            {
                // newest first: the newest "keep" of the ones that may go are kept, then the oldest go while it's over the size
                var newest = group.OrderByDescending(r => r.Id, StringComparer.Ordinal).ToList();
                var gone = new HashSet<string>();
                if (rule.Keep > 0)
                {
                    foreach (var r in newest.Where(r => !Spared(r)).Skip(rule.Keep))
                    {
                        gone.Add(r.Id);
                    }
                }

                if (rule.Mb > 0)
                {
                    var limit = (long)rule.Mb << 20;
                    var total = newest.Where(r => !gone.Contains(r.Id)).Sum(r => Size(r.Id));
                    foreach (var r in Enumerable.Reverse(newest).Where(r => !Spared(r) && !gone.Contains(r.Id)))
                    {
                        if (total <= limit)
                        {
                            break;
                        }

                        total -= Size(r.Id);
                        gone.Add(r.Id);
                    }
                }

                foreach (var id in gone)
                {
                    Forget(id);
                }
            }
        }
    }

    private static bool Imported(string about)
    {
        try
        {
            return JsonNode.Parse(File.ReadAllText(about))?["imported"] is JsonValue v && v.TryGetValue<bool>(out var yes) && yes;
        }
        catch (Exception ex) when (ex is IOException or JsonException)
        {
            return false;
        }
    }

    private void Forget(string id)
    {
        foreach (var end in new[] { ".json", ".rec", ".rec.gz" })
        {
            File.Delete(Path.Combine(HistoryFolder, id + end));
        }
    }

    // raids not heard from in a while (the game was closed, or its server lost): over
    private void EndQuiet()
    {
        foreach (var (sid, of) in _recording)
        {
            if (Now - of.LastTick > RaidGoneAfter && _recording.TryRemove(new KeyValuePair<string, Recording>(sid, of)))
            {
                End(of);
            }
        }
    }

    // at start-up: a raid the server was stopped in the middle of is packed as far as it got
    private void Tidy()
    {
        try
        {
            if (!Directory.Exists(HistoryFolder))
            {
                return;
            }

            foreach (var rec in Directory.GetFiles(HistoryFolder, "*.rec"))
            {
                var id = Path.GetFileNameWithoutExtension(rec);
                if (_recording.Values.Any(r => r.Id == id))
                {
                    continue;
                }

                var about = Path.Combine(HistoryFolder, id + ".json");
                if (!File.Exists(about) || JsonNode.Parse(File.ReadAllText(about)) is not JsonObject known
                    || (known["ms"]?.GetValue<long>() ?? 0) < ShortestRaid)
                {
                    Forget(id);
                    continue;
                }

                known.Remove("live");
                File.WriteAllText(about, known.ToJsonString());
                Pack(rec);
            }

            foreach (var part in Directory.GetFiles(HistoryFolder, "*.part"))
            {
                File.Delete(part);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or FormatException)
        {
            logger.Debug($"[Satellite] Raid history not tidied: {ex.Message}");
        }
    }

    // {"on":true,"raids":[{...},...]}: the newest first
    private string HistoryList()
    {
        var on = History().Record;
        var raids = new JsonArray();
        var older = new List<string>();
        try
        {
            if (Directory.Exists(HistoryFolder))
            {
                foreach (var file in Directory.GetFiles(HistoryFolder, "*.json").OrderByDescending(f => Path.GetFileName(f), StringComparer.Ordinal))
                {
                    var id = Path.GetFileNameWithoutExtension(file);
                    if (!RaidId().IsMatch(id))
                    {
                        continue;
                    }

                    // one being recorded: as it is now, not as it was last saved
                    var going = _recording.Values.FirstOrDefault(r => r.Id == id);
                    if (going != null)
                    {
                        SaveAbout(going, true);
                    }

                    if (JsonNode.Parse(File.ReadAllText(file)) is JsonObject about)
                    {
                        // a raid recorded before its player's side was kept: read from its first reports, once
                        if (going == null && !about.ContainsKey("side"))
                        {
                            about["side"] = SideRecorded(id);
                            File.WriteAllText(file, about.ToJsonString());
                        }

                        // its extract by the name the game shows (not kept: a raid from before has it this way too)
                        if (!about.ContainsKey("exitTitle") && about["exitName"] is JsonValue exitName && exitName.TryGetValue<string>(out var exitId)
                            && ExitTitle(exitId) is { } exitTitle)
                        {
                            about["exitTitle"] = exitTitle;
                        }

                        // (and one recorded before its numbers were kept: counted in the background, listed next time)
                        if (going == null && !about.ContainsKey("st"))
                        {
                            older.Add(id);
                        }

                        raids.Add(about);
                    }
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            logger.Debug($"[Satellite] Raid history not listed: {ex.Message}");
        }

        TallyOlder(older);
        // "bytes": how much the history takes on the disk; "rr": a Raid Review folder with raids of its own is here;
        // "counting": older raids are being counted for the records (asked again in a while)
        // "keep": what's kept (see Keeping); "held": the raids kept because they hold a record
        var rule = Keeping();
        var held = RecordHolders(raids.OfType<JsonObject>().Select(a => (a["id"]?.GetValue<string>() ?? "", a)).ToList());
        return new JsonObject { ["counting"] = older.Count, ["on"] = on, ["paused"] = Paused(), ["raids"] = raids, ["bytes"] = HistoryBytes(), ["keep"] = rule.Keep, ["mb"] = rule.Mb, ["per"] = rule.Per,
            ["held"] = new JsonArray(held.Select(h => (JsonNode?)JsonValue.Create(h)).ToArray()), ["rr"] = RrFolders().Any() }.ToJsonString();
    }

    // The player's side in a recording ("Usec", "Bear", "Savage"): the "sd" of the Main Player marker in its first full
    // reports. "" when none of its first two hundred lines says (an imported raid of Raid Review's, say).
    private string SideRecorded(string id)
    {
        try
        {
            var packed = Path.Combine(HistoryFolder, id + ".rec.gz");
            var plain = Path.Combine(HistoryFolder, id + ".rec");
            Stream? from = File.Exists(packed) ? new GZipStream(File.OpenRead(packed), CompressionMode.Decompress)
                : File.Exists(plain) ? new FileStream(plain, FileMode.Open, FileAccess.Read, FileShare.ReadWrite) : null;
            if (from == null)
            {
                return "";
            }

            using var reader = new StreamReader(from, Encoding.UTF8);
            for (var n = 0; n < 200 && reader.ReadLine() is { } line; n++)
            {
                var tab = line.IndexOf('\t');
                if (tab < 0 || !line.AsSpan(tab + 1).StartsWith("{\"t\":\"full\"") || !line.Contains("\"Main Player\"", StringComparison.Ordinal))
                {
                    continue;
                }

                using var report = JsonDocument.Parse(line.AsMemory(tab + 1));
                if (!report.RootElement.TryGetProperty("markers", out var markers) || markers.ValueKind != JsonValueKind.Array)
                {
                    continue;
                }

                foreach (var marker in markers.EnumerateArray())
                {
                    if (marker.ValueKind == JsonValueKind.Object && marker.TryGetProperty("c", out var kind) && kind.ValueEquals("Main Player")
                        && marker.TryGetProperty("sd", out var side) && side.ValueKind == JsonValueKind.String && side.GetString() is { Length: > 0 and <= 16 } said)
                    {
                        return said;
                    }
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidDataException)
        {
            logger.Debug($"[Satellite] Raid's side not read: {ex.Message}");
        }

        return "";
    }

    private async Task SendRecording(HttpContext context, string id, CancellationToken cancellationToken)
    {
        if (!RaidId().IsMatch(id))
        {
            context.Response.StatusCode = 400;
            return;
        }

        context.Response.ContentType = "text/plain; charset=utf-8";
        var packed = Path.Combine(HistoryFolder, id + ".rec.gz");
        var plain = Path.Combine(HistoryFolder, id + ".rec");
        if (File.Exists(packed))
        {
            await using var file = new FileStream(packed, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 16, true);
            if (TakesGzip(context))
            {
                context.Response.Headers.ContentEncoding = "gzip";
                context.Response.ContentLength = file.Length;
                await file.CopyToAsync(context.Response.Body, cancellationToken);
            }
            else
            {
                await using var unpacked = new GZipStream(file, CompressionMode.Decompress);
                await unpacked.CopyToAsync(context.Response.Body, cancellationToken);
            }

            return;
        }

        if (File.Exists(plain))
        {
            // still being recorded: as far as it's got
            var going = _recording.Values.FirstOrDefault(r => r.Id == id);
            if (going != null)
            {
                lock (going.Lock)
                {
                    going.Out?.Flush();
                }
            }

            await using var file = new FileStream(plain, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 1 << 16, true);
            await file.CopyToAsync(context.Response.Body, cancellationToken);
            return;
        }

        context.Response.StatusCode = 404;
    }

    private string DeleteRecording(string id)
    {
        if (!RaidId().IsMatch(id) || _recording.Values.Any(r => r.Id == id))
        {
            return "{\"ok\":false}";
        }

        try
        {
            Forget(id);
            return "{\"ok\":true}";
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.Debug($"[Satellite] Raid {id} not deleted: {ex.Message}");
            return "{\"ok\":false}";
        }
    }

    // the most a raid's zip, and what's in it unpacked, may be
    private const long MostZip = 256L << 20;
    private const long MostUnpacked = 1L << 30;

    private async Task ExportRecording(HttpContext context, string id, CancellationToken cancellationToken)
    {
        var about = Path.Combine(HistoryFolder, id + ".json");
        var packed = Path.Combine(HistoryFolder, id + ".rec.gz");
        if (!RaidId().IsMatch(id) || !File.Exists(about) || !File.Exists(packed))
        {
            context.Response.StatusCode = 404;
            return;
        }

        var zip = Path.Combine(HistoryFolder, id + "." + Guid.NewGuid().ToString("N")[..8] + ".zip.part");
        try
        {
            using (var archive = new ZipArchive(File.Create(zip), ZipArchiveMode.Create))
            {
                archive.CreateEntryFromFile(about, "raid.json", CompressionLevel.Optimal);
                using var to = archive.CreateEntry("raid.rec", CompressionLevel.Optimal).Open();
                using var from = new GZipStream(File.OpenRead(packed), CompressionMode.Decompress);
                from.CopyTo(to);
            }

            context.Response.ContentType = "application/zip";
            context.Response.Headers.ContentDisposition = "attachment; filename=\"Satellite-raid-" + id + ".zip\"";
            await using var file = new FileStream(zip, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 16, true);
            context.Response.ContentLength = file.Length;
            await file.CopyToAsync(context.Response.Body, cancellationToken);
        }
        finally
        {
            File.Delete(zip);
        }
    }

    private async Task<string> ImportRecording(HttpContext context, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(HistoryFolder);
        var zip = Path.Combine(HistoryFolder, "import." + Guid.NewGuid().ToString("N")[..8] + ".zip.part");
        var rec = zip + ".rec";
        try
        {
            if (context.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit)
            {
                limit.MaxRequestBodySize = MostZip;
            }

            await using (var to = File.Create(zip))
            {
                var buffer = new byte[1 << 16];
                long total = 0;
                int read;
                while ((read = await context.Request.Body.ReadAsync(buffer, cancellationToken)) > 0)
                {
                    total += read;
                    if (total > MostZip)
                    {
                        return "{\"ok\":false,\"why\":\"big\"}";
                    }

                    await to.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
                }
            }

            using var archive = ZipFile.OpenRead(zip);
            // one Raid Review exported: read as its own kind
            if (archive.GetEntry("manifest.json") != null && archive.GetEntry("tables/raid.json") != null)
            {
                var made = RrImportZip(archive);
                return string.IsNullOrEmpty(made) ? "{\"ok\":false,\"why\":\"form\"}" : new JsonObject { ["ok"] = true, ["id"] = made }.ToJsonString();
            }

            var aboutEntry = archive.GetEntry("raid.json");
            var recEntry = archive.GetEntry("raid.rec");
            if (aboutEntry == null || recEntry == null || aboutEntry.Length > 65536 || recEntry.Length > MostUnpacked)
            {
                return "{\"ok\":false,\"why\":\"form\"}";
            }

            JsonObject? about;
            using (var reader = new StreamReader(aboutEntry.Open()))
            {
                about = JsonNode.Parse(await reader.ReadToEndAsync(cancellationToken)) as JsonObject;
            }

            var id = about?["id"] is JsonValue said && said.TryGetValue<string>(out var text) ? text : "";
            if (about == null || !RaidId().IsMatch(id) || about["loc"] is not JsonValue loc || !loc.TryGetValue<string>(out var place)
                || !LocationName().IsMatch(place))
            {
                return "{\"ok\":false,\"why\":\"form\"}";
            }

            if (File.Exists(Path.Combine(HistoryFolder, id + ".json")))
            {
                return new JsonObject { ["ok"] = true, ["id"] = id, ["had"] = true }.ToJsonString();
            }

            // the reports, packed as the server's own are: no more than allowed, and they must begin as reports do
            var fine = false;
            await using (var from = recEntry.Open())
            await using (var to = new GZipStream(File.Create(rec), CompressionLevel.Optimal))
            {
                var buffer = new byte[1 << 16];
                long total = 0;
                int read;
                while ((read = await from.ReadAsync(buffer, cancellationToken)) > 0)
                {
                    if (total == 0 && !Regex.IsMatch(Encoding.UTF8.GetString(buffer, 0, Math.Min(read, 24)), "^[0-9]+\t\\{\"t\":\""))
                    {
                        break;
                    }

                    total += read;
                    if (total > MostUnpacked)
                    {
                        return "{\"ok\":false,\"why\":\"big\"}";
                    }

                    await to.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
                    fine = true;
                }
            }

            if (!fine)
            {
                return "{\"ok\":false,\"why\":\"form\"}";
            }

            about.Remove("live");
            about["imported"] = true;
            File.Move(rec, Path.Combine(HistoryFolder, id + ".rec.gz"));
            File.WriteAllText(Path.Combine(HistoryFolder, id + ".json"), about.ToJsonString());
            return new JsonObject { ["ok"] = true, ["id"] = id }.ToJsonString();
        }
        catch (Exception ex) when (ex is InvalidDataException or JsonException or IOException or UnauthorizedAccessException or FormatException or KeyNotFoundException)
        {
            logger.Debug($"[Satellite] Raid not imported: {ex.Message}");
            return "{\"ok\":false,\"why\":\"form\"}";
        }
        finally
        {
            File.Delete(zip);
            File.Delete(rec);
        }
    }

    // what the items of a replay are called and worth: the page asks with the templates its "loot" events name
    private async Task<string> HistoryNames(HttpContext context, CancellationToken cancellationToken)
    {
        var body = await ReadBody(context, cancellationToken);
        var ids = new HashSet<string>();
        if (body.Length > 0 && JsonNode.Parse(body) is JsonArray asked)
        {
            foreach (var one in asked)
            {
                if (ids.Count < 3000 && one is JsonValue v && v.TryGetValue<string>(out var id) && id.Length == 24)
                {
                    ids.Add(id);
                }
            }
        }

        return Names(ids).ToJsonString();
    }
}
