using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Satellite.Server;

// Raids that Raid Review recorded, brought into Satellite's history. Raid Review (by ekky and Chazut) kept its raids
// in a SQLite file (raid_review_mod.db) with where everybody was in a file beside it, and gave a raid to others as a
// zip of the same tables. Either is read here and written again as one of Satellite's own recordings: the reports a
// game would have sent, four a second, so the page plays it back as it plays its own.
//
//   /satellite/api/history/rr                  the raids found in a Raid Review folder beside this mod
//   POST /satellite/api/history/rr/import?id=  one of them (or "all") into the history
//   POST /satellite/api/history/import         also takes a zip Raid Review exported
//
// What a Raid Review raid doesn't hold isn't made up: bots say what they had decided ("dc") rather than which brain
// layer was deciding, and what lay in containers is listed (the Raid window's Loot tab) but not drawn on the map.
public partial class LiveMapRoute
{
    private sealed class RrRow(Dictionary<string, object?> values)
    {
        public string S(string key) => values.TryGetValue(key, out var v) && v != null ? Convert.ToString(v, CultureInfo.InvariantCulture) ?? "" : "";

        public double D(string key)
        {
            if (!values.TryGetValue(key, out var v) || v == null)
            {
                return 0;
            }

            return v switch
            {
                double d => d,
                long l => l,
                _ => double.TryParse(Convert.ToString(v, CultureInfo.InvariantCulture), NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed) ? parsed : 0
            };
        }

        public long L(string key) => (long)Math.Round(D(key));

        public bool B(string key)
        {
            var said = S(key);
            return said == "1" || said.Equals("true", StringComparison.OrdinalIgnoreCase);
        }
    }

    private delegate IEnumerable<RrRow> RrTable(string name);

    // the Raid Review folders beside this mod that hold a database
    private IEnumerable<string> RrFolders()
    {
        var mods = Path.GetDirectoryName(Folder.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        if (mods == null || !Directory.Exists(mods))
        {
            yield break;
        }

        foreach (var mod in Directory.GetDirectories(mods))
        {
            var data = Path.Combine(mod, "data");
            if (File.Exists(Path.Combine(data, "raid_review_mod.db")))
            {
                yield return data;
            }
        }
    }

    private static string RrId(string raidId, string time)
    {
        var began = DateTimeOffset.TryParse(time, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at) ? at : DateTimeOffset.UnixEpoch;
        var hex = new string(raidId.Where(Uri.IsHexDigit).Take(6).ToArray()).ToLowerInvariant().PadRight(6, '0');
        return began.ToLocalTime().ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture) + "-" + hex;
    }

    // {"found":true,"raids":[{"rid","loc","began","ms","exit","have":already in the history,"pos":its positions are there}]}
    private string RrList()
    {
        var raids = new JsonArray();
        var found = false;
        foreach (var data in RrFolders())
        {
            found = true;
            try
            {
                using var db = new SqliteFile(Path.Combine(data, "raid_review_mod.db"));
                foreach (var values in db.Table("raid"))
                {
                    var raid = new RrRow(values);
                    var rid = raid.S("raidId");
                    if (!Guid.TryParseExact(rid, "D", out _))
                    {
                        continue;
                    }

                    var id = RrId(rid, raid.S("time"));
                    raids.Add(new JsonObject
                    {
                        ["rid"] = rid,
                        ["loc"] = raid.S("location"),
                        ["began"] = DateTimeOffset.TryParse(raid.S("time"), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at) ? at.ToUnixTimeMilliseconds() : 0,
                        ["ms"] = raid.L("timeInRaid"),
                        ["exit"] = raid.S("exitStatus"),
                        ["have"] = File.Exists(Path.Combine(HistoryFolder, id + ".json")),
                        ["pos"] = File.Exists(Path.Combine(data, "positions", rid + "_V4_positions.json"))
                    });
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidDataException or JsonException)
            {
                logger.Debug($"[Satellite] Raid Review's raids not read: {ex.Message}");
            }
        }

        return new JsonObject { ["found"] = found, ["raids"] = raids }.ToJsonString();
    }

    private string RrImport(string wanted)
    {
        var done = 0;
        var failed = 0;
        foreach (var data in RrFolders())
        {
            try
            {
                using var db = new SqliteFile(Path.Combine(data, "raid_review_mod.db"));
                var ids = db.Table("raid").Select(v => new RrRow(v).S("raidId")).Where(r => Guid.TryParseExact(r, "D", out _) && (wanted == "all" || wanted == r)).ToList();
                foreach (var rid in ids)
                {
                    var positions = Path.Combine(data, "positions", rid + "_V4_positions.json");
                    try
                    {
                        using var stream = File.Exists(positions) ? new FileStream(positions, FileMode.Open, FileAccess.Read, FileShare.ReadWrite) : null;
                        // (each table read once and kept: a raid's rows are asked for more than once)
                        var kept = new Dictionary<string, List<RrRow>>();
                        IEnumerable<RrRow> Table(string name)
                        {
                            if (!kept.TryGetValue(name, out var rows))
                            {
                                rows = db.Has(name) ? db.Table(name).Select(v => new RrRow(v)).Where(r => r.S("raidId") == rid).ToList() : [];
                                kept[name] = rows;
                            }

                            return rows;
                        }

                        if (RrConvert(Table, stream) is { Length: > 0 })
                        {
                            done++;
                        }
                        else
                        {
                            failed++;
                        }
                    }
                    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidDataException or JsonException or FormatException or KeyNotFoundException)
                    {
                        failed++;
                        logger.Warning($"[Satellite] Raid Review raid {rid} not imported: {ex.Message}");
                    }
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidDataException)
            {
                logger.Warning($"[Satellite] Raid Review's raids not read: {ex.Message}");
            }
        }

        return new JsonObject { ["ok"] = done > 0 || failed == 0, ["n"] = done, ["failed"] = failed }.ToJsonString();
    }

    // a zip Raid Review exported: manifest.json, tables/<name>.json, positions.json
    private string? RrImportZip(ZipArchive archive)
    {
        IEnumerable<RrRow> Table(string name)
        {
            var entry = archive.GetEntry("tables/" + name + ".json");
            if (entry == null || entry.Length > 128L << 20)
            {
                return [];
            }

            using var stream = entry.Open();
            using var document = JsonDocument.Parse(stream);
            var rows = new List<RrRow>();
            if (document.RootElement.ValueKind != JsonValueKind.Array)
            {
                return rows;
            }

            foreach (var one in document.RootElement.EnumerateArray())
            {
                if (one.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                var values = new Dictionary<string, object?>();
                foreach (var field in one.EnumerateObject())
                {
                    values[field.Name] = field.Value.ValueKind switch
                    {
                        JsonValueKind.String => field.Value.GetString(),
                        JsonValueKind.Number => field.Value.GetDouble(),
                        JsonValueKind.True => "1",
                        JsonValueKind.False => "0",
                        _ => null
                    };
                }

                rows.Add(new RrRow(values));
            }

            return rows;
        }

        var positions = archive.GetEntry("positions.json");
        if (positions != null && positions.Length > MostUnpacked)
        {
            return null;
        }

        using var stream = positions?.Open();
        return RrConvert(Table, stream);
    }

    private sealed class RrSample
    {
        public long T;
        public double X, Y, Z, Dir, Hp, HpMax;
        public string Decision = "";
        public bool Ghost;
    }

    private sealed class RrPerson
    {
        public int Id;
        public string Pid = "", Name = "", Kind = "", Side = "", Personality = "", Difficulty = "";
        public int Level, Group;
        public bool Person;
        public List<RrSample> Samples = [];
        public int At = -1;
        public long Gone = long.MaxValue;
        public long Dead = long.MaxValue;
        public double[]? DiedAt;
        public string KilledBy = "";
        public List<(long T, bool Down)> Downs = [];
        public List<(long T, string What, string By, double X, double Y, double Z)> Goals = [];
        public int GoalAt = -1;
    }

    // what Raid Review called a kind of bot ("PMC|BEAR", "SCAV|SCAV", "ISB MARKSMAN|ISB"), as Satellite names it
    private static string RrKind(string type, bool main)
    {
        var parts = type.ToUpperInvariant().Split('|');
        var name = parts[0];
        var sort = parts.Length > 1 ? parts[1] : parts[0];
        if (name == "HUMAN" || sort == "HUMAN" || name == "PLAYER")
        {
            return main ? "Main Player" : "Friendly Player";
        }

        if (name == "PMC" || sort is "USEC" or "BEAR" or "PMC")
        {
            return "Enemy Player";
        }

        if (name.Contains("SNIPER") || sort == "SNIPER")
        {
            return "Sniper";
        }

        if (sort == "ISB_WT" || name.Contains("WHITE TUSK"))
        {
            return "ISB WT";
        }

        if (name.Contains("REMNANT"))
        {
            return "RUAF Remnant";
        }

        return sort switch
        {
            "SCAV" or "PLAYER_SCAV" => "Scav",
            "BOSS" => "Boss",
            "FOLLOWER" => "Guard",
            "GOON" => "Goon",
            "RAIDER" => "Raider",
            "ROGUE" => "Rogue",
            "CULT" => "Cultist",
            "BLOODHOUND" => "Bloodhound",
            "MERCENARY" => "Mercenary",
            "RUAF" => "RUAF",
            "UNTAR" => "UNTAR",
            "BLACKDIV" or "BLACK DIV" or "BLACK_DIV" => "Black Division",
            "ISB" => "ISB",
            "COMBINE" => "Combine",
            "INFECTED" => "Infected",
            "FACTION_MOD" => name.StartsWith("BOSS", StringComparison.Ordinal) ? "Boss" : name.StartsWith("COMBINE", StringComparison.Ordinal) ? "Combine" : "Guard",
            _ => "Other AI"
        };
    }

    private static string Num(double value) => double.IsFinite(value) ? Math.Round(value, 2).ToString(CultureInfo.InvariantCulture) : "0";

    private static string Quoted(string text) => JsonSerializer.Serialize(text);

    // [east, north, height] of Raid Review's {"x","y" (height),"z"}
    private static string Spot(double x, double y, double z) => "[" + Num(x) + "," + Num(z) + "," + Num(y) + "]";

    private static double[]? RrPlace(string json)
    {
        try
        {
            if (json.Length < 5 || JsonNode.Parse(json) is not JsonObject at)
            {
                return null;
            }

            return [at["x"]?.GetValue<double>() ?? 0, at["y"]?.GetValue<double>() ?? 0, at["z"]?.GetValue<double>() ?? 0];
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or FormatException)
        {
            return null;
        }
    }

    // Raid Review's own names (camelCase) as ORBIT's (PascalCase), all the way down
    private static JsonNode? Pascal(JsonNode? node)
    {
        switch (node)
        {
            case JsonObject map:
                var renamed = new JsonObject();
                foreach (var (key, value) in map)
                {
                    renamed[key.Length > 0 ? char.ToUpperInvariant(key[0]) + key[1..] : key] = Pascal(value);
                }

                return renamed;
            case JsonArray list:
                var copy = new JsonArray();
                foreach (var one in list)
                {
                    copy.Add(Pascal(one));
                }

                return copy;
            default:
                return node?.DeepClone();
        }
    }

    private static JsonNode? Parsed(string json)
    {
        try
        {
            return json.Length > 1 ? JsonNode.Parse(json) : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    // One Raid Review raid, written as a recording. Returns its id in the history ("" when it couldn't be read).
    private string RrConvert(RrTable table, Stream? positions)
    {
        var raid = table("raid").FirstOrDefault();
        if (raid == null)
        {
            return "";
        }

        var rid = raid.S("raidId");
        var loc = raid.S("location");
        if (!Guid.TryParseExact(rid, "D", out _) || !LocationName().IsMatch(loc))
        {
            return "";
        }

        var id = RrId(rid, raid.S("time"));
        Directory.CreateDirectory(HistoryFolder);
        if (File.Exists(Path.Combine(HistoryFolder, id + ".json")))
        {
            return id;
        }

        var mainPid = raid.S("profileId");
        var people = new Dictionary<string, RrPerson>();
        foreach (var row in table("player"))
        {
            var pid = row.S("profileId");
            if (pid.Length == 0 || people.ContainsKey(pid))
            {
                continue;
            }

            var type = row.S("type");
            var person = new RrPerson
            {
                Id = people.Count + 1, Pid = pid, Name = row.S("name"), Level = (int)row.L("level"), Group = (int)row.L("group"),
                Side = row.S("team"), Personality = row.S("mod_SAIN_brain"), Difficulty = row.S("mod_SAIN_difficulty"),
                Person = type.Equals("HUMAN", StringComparison.OrdinalIgnoreCase)
            };
            person.Kind = RrKind(type, pid == mainPid);
            if (person.Kind == "Other AI" && person.Side is "Usec" or "Bear")
            {
                person.Kind = "Enemy Player";
            }

            people[pid] = person;
        }

        long last = raid.L("timeInRaid");
        if (positions != null)
        {
            using var document = JsonDocument.Parse(positions);
            if (document.RootElement.ValueKind == JsonValueKind.Object)
            {
                foreach (var of in document.RootElement.EnumerateObject())
                {
                    if (!people.TryGetValue(of.Name, out var person) || of.Value.ValueKind != JsonValueKind.Array)
                    {
                        continue;
                    }

                    foreach (var one in of.Value.EnumerateArray())
                    {
                        double Read(string name) => one.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : 0;
                        person.Samples.Add(new RrSample
                        {
                            T = (long)Read("time"), X = Read("x"), Y = Read("y"), Z = Read("z"), Dir = Read("dir"), Hp = Read("health"), HpMax = Read("maxHealth"),
                            Decision = one.TryGetProperty("decision", out var decision) && decision.ValueKind == JsonValueKind.String ? decision.GetString() ?? "" : "",
                            Ghost = one.TryGetProperty("ghost", out var ghost) && ghost.ValueKind == JsonValueKind.True
                        });
                    }

                    person.Samples.Sort((a, b) => a.T.CompareTo(b.T));
                    if (person.Samples.Count > 0)
                    {
                        last = Math.Max(last, person.Samples[^1].T);
                    }
                }
            }
        }

        // what happened, each as one of Satellite's events: (when, kind, whose, their name, the rest)
        var events = new List<(long T, string Line)>();
        var number = 0;
        void Event(long t, string kind, string? pid, string? name, string detail)
        {
            var text = new StringBuilder("{\"n\":").Append(0).Append(",\"t\":").Append(t).Append(",\"k\":").Append(Quoted(kind));
            if (!string.IsNullOrEmpty(pid))
            {
                text.Append(",\"p\":").Append(Quoted(pid));
            }

            if (!string.IsNullOrEmpty(name))
            {
                text.Append(",\"nm\":").Append(Quoted(name));
            }

            events.Add((t, text.Append(",\"d\":").Append(detail).Append('}').ToString()));
        }

        var kills = 0;
        var mine = 0;
        var died = false;
        foreach (var row in table("kills"))
        {
            var t = row.L("time");
            people.TryGetValue(row.S("killedId"), out var dead);
            people.TryGetValue(row.S("profileId"), out var killer);
            var at = RrPlace(row.S("positionKilled"));
            var from = RrPlace(row.S("positionKiller"));
            kills++;
            mine += killer != null && killer.Pid == mainPid ? 1 : 0;
            died |= dead != null && dead.Pid == mainPid;
            if (dead != null)
            {
                dead.Dead = Math.Min(dead.Dead, t);
                dead.DiedAt = at;
                dead.KilledBy = killer is { Person: true } ? killer.Pid : "";
            }

            var detail = new StringBuilder("{\"vk\":").Append(Quoted(dead?.Kind ?? "Other AI"));
            if (killer != null && killer != dead)
            {
                detail.Append(",\"k\":").Append(Quoted(killer.Pid)).Append(",\"kn\":").Append(Quoted(killer.Name)).Append(",\"kk\":").Append(Quoted(killer.Kind));
            }

            if (row.S("weapon").Length > 0)
            {
                detail.Append(",\"w\":").Append(Quoted(row.S("weapon")));
            }

            if (row.S("bodyPart").Length > 0)
            {
                detail.Append(",\"bp\":").Append(Quoted(row.S("bodyPart")));
            }

            detail.Append(",\"m\":").Append((long)Math.Round(row.D("distance")));
            if (at != null)
            {
                detail.Append(",\"at\":").Append(Spot(at[0], at[1], at[2]));
            }

            if (from != null)
            {
                detail.Append(",\"ka\":").Append(Spot(from[0], from[1], from[2]));
            }

            Event(t, "kill", row.S("killedId"), dead?.Name, detail.Append('}').ToString());
        }

        var names = new JsonObject();
        void Named(string template, string name, long price)
        {
            if (template.Length == 24 && !names.ContainsKey(template))
            {
                names[template] = new JsonObject { ["n"] = name, ["s"] = name, ["p"] = price };
            }
        }

        foreach (var row in table("looting"))
        {
            people.TryGetValue(row.S("profileId"), out var who);
            Named(row.S("templateId"), row.S("itemName"), row.L("price"));
            var detail = new StringBuilder("{\"tpl\":").Append(Quoted(row.S("templateId"))).Append(",\"i\":").Append(Quoted(row.S("itemName")));
            if (row.L("qty") > 1)
            {
                detail.Append(",\"q\":").Append(row.L("qty"));
            }

            detail.Append(",\"wk\":").Append(Quoted(who?.Kind ?? "Other AI"));
            if (row.D("x") != 0 || row.D("z") != 0)
            {
                detail.Append(",\"at\":").Append(Spot(row.D("x"), row.D("y"), row.D("z")));
            }

            Event(row.L("time"), row.B("added") ? "loot" : "drop", row.S("profileId"), who?.Name, detail.Append('}').ToString());
        }

        foreach (var row in table("player_status"))
        {
            if (!people.TryGetValue(row.S("profileId"), out var who))
            {
                continue;
            }

            var t = row.L("time");
            switch (row.S("status"))
            {
                case "Dead":
                    who.Dead = Math.Min(who.Dead, t);
                    break;
                case "Extracted":
                    who.Gone = Math.Min(who.Gone, t);
                    if (who.Pid != mainPid)
                    {
                        var at = who.Samples.LastOrDefault(s => s.T <= t) ?? who.Samples.LastOrDefault();
                        Event(t, "left", who.Pid, who.Name, "{\"wk\":" + Quoted(who.Kind) + ",\"x\":1" + (at != null ? ",\"at\":" + Spot(at.X, at.Y, at.Z) : "") + "}");
                    }

                    break;
                case "Unspawned":
                    who.Gone = Math.Min(who.Gone, t);
                    break;
                case "Downed":
                    who.Downs.Add((t, true));
                    break;
                case "Alive":
                    who.Downs.Add((t, false));
                    break;
            }
        }

        foreach (var row in table("switch_state"))
        {
            Event(row.L("time"), "switch", null, null, "{\"id\":" + Quoted(row.S("switchId")) + ",\"nm\":" + Quoted(row.S("name")) + ",\"st\":" + Quoted(row.S("state"))
                + ",\"at\":" + Spot(row.D("x"), row.D("y"), row.D("z")) + "}");
        }

        foreach (var row in table("orbit_main_objectives"))
        {
            if (Pascal(Parsed(row.S("squads"))) is JsonArray squads)
            {
                Event(row.L("time"), "orbit.main", null, null, "{\"s\":" + squads.ToJsonString() + "}");
            }
        }

        foreach (var (name, kind) in new[] { ("orbit_field", "orbit.field"), ("phobos_field", "phobos.field") })
        {
            foreach (var row in table(name))
            {
                var field = new JsonObject
                {
                    ["GridCols"] = row.L("gridCols"), ["GridRows"] = row.L("gridRows"), ["WorldMinX"] = row.D("worldMinX"), ["WorldMinZ"] = row.D("worldMinZ"),
                    ["CellSize"] = row.D("cellSize"), ["Advection"] = Pascal(Parsed(row.S("advection"))) ?? new JsonArray(),
                    ["Convergence"] = Pascal(Parsed(row.S("convergence"))) ?? new JsonArray(), ["Zones"] = Pascal(Parsed(row.S("zones"))) ?? new JsonArray()
                };
                Event(row.L("time"), kind, null, null, "{\"s\":" + field.ToJsonString() + "}");
            }
        }

        foreach (var row in table("orbit_ghost_fight"))
        {
            Event(row.L("time"), "orbit.fight", null, null, "{\"a\":" + Spot(row.D("aX"), row.D("aY"), row.D("aZ")) + ",\"b\":" + Spot(row.D("bX"), row.D("bY"), row.D("bZ"))
                + ",\"s\":" + (row.L("durationMs") / 1000) + ",\"n\":" + row.L("casualties") + "}");
        }

        foreach (var row in table("orbit_ghost_wake"))
        {
            Event(row.L("time"), "orbit.wake", row.S("profileId"), row.S("name"), "{\"c\":" + Quoted(row.S("cause")) + ",\"dt\":" + Quoted(row.S("detail"))
                + ",\"by\":" + Quoted(row.S("triggerName")) + ",\"m\":" + (long)Math.Round(row.D("distance")) + "}");
        }

        foreach (var row in table("orbit_ghost_hearing"))
        {
            people.TryGetValue(row.S("profileId"), out var who);
            Event(row.L("time"), "orbit.hear", row.S("profileId"), who?.Name, "{\"s\":" + Spot(row.D("sourceX"), row.D("sourceY"), row.D("sourceZ"))
                + ",\"l\":" + Spot(row.D("listenerX"), row.D("listenerY"), row.D("listenerZ")) + ",\"r\":" + (long)Math.Round(row.D("range"))
                + ",\"m\":" + (long)Math.Round(row.D("distance")) + ",\"sh\":" + row.L("shots") + (row.L("investigate") != 0 ? ",\"inv\":1" : "") + "}");
        }

        // where each bot was sent, over the raid: ORBIT's, Phobos's and QuestingBots's
        foreach (var (name, by) in new[] { ("orbit_bot_objective", ""), ("bot_objective", "Phobos") })
        {
            foreach (var row in table(name))
            {
                if (people.TryGetValue(row.S("profileId"), out var who))
                {
                    var category = row.S("category");
                    var status = row.S("status");
                    who.Goals.Add((row.L("time"), category.Length == 0 ? "" : status.Length > 0 && status != "None" ? category + " (" + status + ")" : category, by,
                        row.D("objectiveX"), row.D("objectiveY"), row.D("objectiveZ")));
                }
            }
        }

        foreach (var row in table("bot_quest"))
        {
            if (people.TryGetValue(row.S("profileId"), out var who))
            {
                var active = row.S("status") is "Active" or "Pending";
                who.Goals.Add((row.L("time"), active ? row.S("questName") : "", "QuestingBots", row.D("objectiveX"), row.D("objectiveY"), row.D("objectiveZ")));
            }
        }

        foreach (var who in people.Values)
        {
            who.Goals.Sort((a, b) => a.T.CompareTo(b.T));
            who.Downs.Sort((a, b) => a.T.CompareTo(b.T));
            if (who.Dead != long.MaxValue && who.DiedAt == null)
            {
                var at = who.Samples.LastOrDefault(s => s.T <= who.Dead) ?? who.Samples.LastOrDefault();
                who.DiedAt = at != null ? [at.X, at.Y, at.Z] : null;
            }
        }

        var exit = raid.S("exitStatus");
        if (exit.Length > 0)
        {
            Event(last, "end", mainPid, null, "{\"st\":" + Quoted(exit) + ",\"ex\":" + Quoted(raid.S("exitName")) + "}");
        }

        events.Sort((a, b) => a.T.CompareTo(b.T));

        var shots = table("ballistic").Select(row => (T: row.L("time"), Who: row.S("profileId"), Hit: row.S("hitPlayerId"), From: RrPlace(row.S("source")), To: RrPlace(row.S("target"))))
            .Where(s => s.From != null && s.To != null).OrderBy(s => s.T).ToList();
        var drops = table("airdrop_landing").Select(row => (T: row.L("time"), X: row.D("x"), Y: row.D("y"), Z: row.D("z"))).OrderBy(d => d.T).ToList();
        var flights = table("airdrop_flight").Select(row => (T: row.L("time"), X: row.D("x"), Y: row.D("y"), Z: row.D("z"), Heading: row.D("heading"))).OrderBy(f => f.T).ToList();

        // the mods Raid Review saw, as the page knows them
        var mods = raid.S("detectedMods").ToUpperInvariant();
        var brains = new List<string>();
        foreach (var (word, mod) in new[] { ("SAIN", "SAIN"), ("ORBIT", "ORBIT"), ("COMET", "COMET"), ("QUESTING", "QuestingBots"), ("PHOBOS", "Phobos") })
        {
            if (mods.Contains(word))
            {
                brains.Add(Quoted(mod));
            }
        }

        var part = Path.Combine(HistoryFolder, id + ".rec.gz.part");
        var most = 0;
        try
        {
            using (var to = new StreamWriter(new GZipStream(File.Create(part), CompressionLevel.Optimal), new UTF8Encoding(false)))
            {
                // what lay on the ground as the raid began, and what everybody came in with
                var loose = new StringBuilder();
                var inside = new Dictionary<string, StringBuilder>();
                foreach (var row in table("loose_loot"))
                {
                    if (row.S("templateId").Length != 24)
                    {
                        continue;
                    }

                    Named(row.S("templateId"), row.S("itemName"), row.L("price"));
                    if (row.B("inContainer"))
                    {
                        // what a container held, by the container's name and place
                        var box = "rr:" + row.S("containerName") + "@" + Num(row.D("x")) + "," + Num(row.D("z"));
                        if (!inside.TryGetValue(box, out var held))
                        {
                            inside[box] = held = new StringBuilder();
                        }

                        held.Append(held.Length > 0 ? "," : "").Append('[').Append(Quoted(row.S("templateId"))).Append(',').Append(Math.Max(1, row.L("qty"))).Append(']');
                        continue;
                    }

                    loose.Append(loose.Length > 0 ? "," : "").Append('[').Append(Quoted(row.S("itemId"))).Append(',').Append(Quoted(row.S("templateId"))).Append(',')
                        .Append(Num(row.D("x"))).Append(',').Append(Num(row.D("z"))).Append(',').Append(Num(row.D("y"))).Append(',').Append(Math.Max(1, row.L("qty"))).Append(",0]");
                }

                var carried = new Dictionary<string, StringBuilder>();
                foreach (var row in table("player_inventory"))
                {
                    var pid = row.S("profileId");
                    var slot = row.S("slot");
                    if (row.S("templateId").Length != 24 || row.S("itemName") == "Default Inventory")
                    {
                        continue;
                    }

                    Named(row.S("templateId"), row.S("itemName"), row.L("price"));
                    if (!carried.TryGetValue(pid, out var items))
                    {
                        carried[pid] = items = new StringBuilder();
                    }

                    items.Append(items.Length > 0 ? "," : "").Append('[').Append(Quoted(row.S("templateId"))).Append(',').Append(Math.Max(1, row.L("qty")));
                    // (a slot's name, not the id of the thing it lies in)
                    if (slot.Length is > 0 and < 24 && slot.All(char.IsLetter))
                    {
                        items.Append(',').Append(Quoted(slot));
                    }

                    items.Append(']');
                }

                to.Write("0\t{\"t\":\"th\",\"d\":{\"loc\":" + Quoted(loc) + ",\"names\":" + names.ToJsonString() + ",\"loose\":[" + loose + "],\"inside\":{" + string.Join(",", inside.Select(c => Quoted(c.Key) + ":[" + c.Value + "]")) + "},\"carried\":{"
                    + string.Join(",", carried.Select(c => Quoted(c.Key) + ":[" + c.Value + "]")) + "},\"open\":[],\"bodies\":[]}}\n");

                var eventAt = 0;
                var shotAt = 0;
                var sequence = 0;
                var line = new StringBuilder(1 << 16);
                for (long t = 0; t <= last + 250; t += 250)
                {
                    var full = t % 1000 == 0 || t > last;
                    line.Clear();
                    line.Append(t).Append('\t');
                    foreach (var who in people.Values)
                    {
                        while (who.At + 1 < who.Samples.Count && who.Samples[who.At + 1].T <= t)
                        {
                            who.At++;
                        }
                    }

                    bool Here(RrPerson who) => who.At >= 0 && t < who.Dead && t < who.Gone && t - who.Samples[who.At].T < 2500;
                    people.TryGetValue(mainPid, out var main);
                    var me = main != null && Here(main)
                        ? "[" + Num(main.Samples[main.At].X) + "," + Num(main.Samples[main.At].Z) + "," + Num(main.Samples[main.At].Y) + "," + Num(main.Samples[main.At].Dir) + ",0]"
                        : "null";
                    if (full)
                    {
                        line.Append("{\"t\":\"full\",\"seq\":").Append(++sequence).Append(",\"raid\":true,\"loc\":").Append(Quoted(loc)).Append(",\"has\":[],\"brains\":[")
                            .Append(string.Join(",", brains)).Append("],\"me\":").Append(me).Append(",\"markers\":[");
                        var count = 0;
                        foreach (var who in people.Values)
                        {
                            if (Here(who))
                            {
                                var s = who.Samples[who.At];
                                line.Append(count++ > 0 ? "," : "").Append("{\"id\":").Append(who.Id).Append(",\"c\":").Append(Quoted(who.Kind)).Append(",\"t\":").Append(Quoted(who.Name))
                                    .Append(",\"p\":").Append(Spot(s.X, s.Y, s.Z)).Append(",\"r\":").Append(Num(s.Dir)).Append(",\"dyn\":1");
                                line.Append(who.Person ? ",\"u\":" : ",\"pid\":").Append(Quoted(who.Pid));
                                var team = who.Kind is "Main Player" or "Friendly Player" or "Enemy Player";
                                if (team && who.Group > 0)
                                {
                                    line.Append(",\"g\":").Append(Quoted("rr" + who.Group));
                                }
                                else if (who.Group > 0)
                                {
                                    line.Append(",\"bg\":").Append(who.Group);
                                }

                                if (who.Level > 0)
                                {
                                    line.Append(team ? ",\"lv\":" : ",\"bl\":").Append(who.Level);
                                }

                                if (team && who.Side.Length > 0)
                                {
                                    line.Append(",\"sd\":").Append(Quoted(who.Side));
                                }

                                if (s.HpMax > 0)
                                {
                                    line.Append(",\"hp\":[").Append((long)Math.Round(s.Hp)).Append(',').Append((long)Math.Round(s.HpMax)).Append(']');
                                }

                                var down = false;
                                foreach (var d in who.Downs)
                                {
                                    if (d.T <= t)
                                    {
                                        down = d.Down;
                                    }
                                }

                                if (down)
                                {
                                    line.Append(",\"dn\":1");
                                }

                                if (!who.Person)
                                {
                                    if (who.Difficulty.Length > 0)
                                    {
                                        line.Append(",\"df\":").Append(Quoted(who.Difficulty));
                                    }

                                    if (who.Personality.Length > 0 && who.Personality != "UNKNOWN" && who.Personality != "PLAYER")
                                    {
                                        line.Append(",\"ps\":").Append(Quoted(who.Personality));
                                    }

                                    line.Append(",\"dc\":").Append(Quoted(s.Decision));
                                    if (s.Ghost)
                                    {
                                        line.Append(",\"gh\":1");
                                    }

                                    while (who.GoalAt + 1 < who.Goals.Count && who.Goals[who.GoalAt + 1].T <= t)
                                    {
                                        who.GoalAt++;
                                    }

                                    if (who.GoalAt >= 0 && who.Goals[who.GoalAt].What.Length > 0)
                                    {
                                        var goal = who.Goals[who.GoalAt];
                                        line.Append(",\"ob\":").Append(Quoted(goal.What));
                                        if (goal.By.Length > 0)
                                        {
                                            line.Append(",\"os\":").Append(Quoted(goal.By));
                                        }

                                        if (goal.X != 0 || goal.Z != 0)
                                        {
                                            line.Append(",\"og\":").Append(Spot(goal.X, goal.Y, goal.Z));
                                        }
                                    }
                                }

                                line.Append('}');
                            }
                            else if (t >= who.Dead && who.DiedAt != null)
                            {
                                line.Append(count++ > 0 ? "," : "").Append("{\"id\":").Append(100000 + who.Id).Append(",\"c\":\"Corpse\",\"t\":").Append(Quoted(who.Name))
                                    .Append(",\"p\":").Append(Spot(who.DiedAt[0], who.DiedAt[1], who.DiedAt[2])).Append(",\"r\":0,\"pid\":").Append(Quoted(who.Pid))
                                    .Append(",\"was\":").Append(Quoted(who.Kind));
                                if (who.KilledBy.Length > 0)
                                {
                                    line.Append(",\"kp\":1,\"kb\":").Append(Quoted(who.KilledBy));
                                }

                                line.Append('}');
                            }
                        }

                        for (var i = 0; i < drops.Count; i++)
                        {
                            if (drops[i].T <= t)
                            {
                                line.Append(count++ > 0 ? "," : "").Append("{\"id\":").Append(200000 + i).Append(",\"c\":\"Airdrop\",\"t\":\"Common\",\"p\":")
                                    .Append(Spot(drops[i].X, drops[i].Y, drops[i].Z)).Append(",\"r\":0,\"dyn\":1}");
                            }
                        }

                        most = Math.Max(most, count);
                        line.Append("],\"rid\":").Append(Quoted(rid)).Append(",\"clk\":").Append(t).Append(",\"ev\":[");
                        var first = true;
                        while (eventAt < events.Count && events[eventAt].T <= t)
                        {
                            // (numbered in the order they're told)
                            line.Append(first ? "" : ",").Append("{\"n\":").Append(++number).Append(events[eventAt].Line, 6, events[eventAt].Line.Length - 6);
                            first = false;
                            eventAt++;
                        }

                        line.Append(']');
                    }
                    else
                    {
                        line.Append("{\"t\":\"fast\",\"seq\":").Append(++sequence).Append(",\"me\":").Append(me).Append(",\"m\":[");
                        var count = 0;
                        foreach (var who in people.Values)
                        {
                            if (Here(who))
                            {
                                var s = who.Samples[who.At];
                                line.Append(count++ > 0 ? "," : "").Append('[').Append(who.Id).Append(',').Append(Num(s.X)).Append(',').Append(Num(s.Z)).Append(',')
                                    .Append(Num(s.Y)).Append(',').Append(Num(s.Dir)).Append(']');
                            }
                        }

                        line.Append(']');
                    }

                    var shot = false;
                    while (shotAt < shots.Count && shots[shotAt].T <= t)
                    {
                        var s = shots[shotAt++];
                        line.Append(shot ? "," : ",\"sh\":[").Append('[').Append(people.TryGetValue(s.Who, out var shooter) ? shooter.Id : 0).Append(',')
                            .Append(Num(s.From![0])).Append(',').Append(Num(s.From[2])).Append(',').Append(Num(s.To![0])).Append(',').Append(Num(s.To[2]));
                        if (s.Hit.Length > 0)
                        {
                            line.Append(',').Append(people.TryGetValue(s.Hit, out var struck) ? struck.Id : 0);
                        }

                        line.Append(']');
                        shot = true;
                    }

                    if (shot)
                    {
                        line.Append(']');
                    }

                    if (full)
                    {
                        // the airdrop's plane, while it's told of
                        var flown = flights.Where(f => f.T <= t && t - f.T < 2500).ToList();
                        if (flown.Count > 0)
                        {
                            var now = flown[^1];
                            line.Append(",\"plane\":{\"p\":").Append(Spot(now.X, now.Y, now.Z)).Append(",\"r\":").Append(Num(now.Heading)).Append(",\"path\":[")
                                .Append(string.Join(",", flights.Where(f => f.T <= t).Select(f => Num(f.X) + "," + Num(f.Z)))).Append("]}");
                        }
                    }

                    line.Append("}\n");
                    to.Write(line);
                }
            }

            people.TryGetValue(mainPid, out var player);
            var about = new JsonObject
            {
                ["id"] = id, ["sid"] = mainPid, ["name"] = player?.Name ?? "", ["loc"] = loc,
                ["began"] = DateTimeOffset.TryParse(raid.S("time"), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var began) ? began.ToUnixTimeMilliseconds() : 0,
                ["ms"] = last, ["kills"] = kills, ["mine"] = mine, ["died"] = died, ["most"] = most, ["imported"] = true, ["rr"] = rid
            };
            if (exit.Length > 0)
            {
                about["exit"] = exit;
                about["exitName"] = raid.S("exitName");
            }

            if (raid.B("importedIsHeadless") || raid.S("type").Contains("HEADLESS", StringComparison.OrdinalIgnoreCase))
            {
                about["hl"] = true;
            }

            File.Move(part, Path.Combine(HistoryFolder, id + ".rec.gz"), true);
            File.WriteAllText(Path.Combine(HistoryFolder, id + ".json"), about.ToJsonString());
            return id;
        }
        finally
        {
            File.Delete(part);
        }
    }

    // ---- everything recorded, and what's left lying in the folder ----

    // every raid that isn't being recorded this moment
    private string DeleteAllRecordings()
    {
        var count = 0;
        try
        {
            if (Directory.Exists(HistoryFolder))
            {
                foreach (var about in Directory.GetFiles(HistoryFolder, "*.json"))
                {
                    var id = Path.GetFileNameWithoutExtension(about);
                    if (RaidId().IsMatch(id) && _recording.Values.All(r => r.Id != id))
                    {
                        Forget(id);
                        count++;
                    }
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.Debug($"[Satellite] Raids not deleted: {ex.Message}");
        }

        return new JsonObject { ["ok"] = true, ["n"] = count }.ToJsonString();
    }

    // what a stopped import, export or recording left behind: part files, and reports with nothing about them
    private string TidyRecordings()
    {
        var count = 0;
        try
        {
            if (Directory.Exists(HistoryFolder))
            {
                foreach (var file in Directory.GetFiles(HistoryFolder))
                {
                    var name = Path.GetFileName(file);
                    var id = name.Split('.')[0];
                    var stray = name.EndsWith(".part", StringComparison.Ordinal) || name.EndsWith(".part.rec", StringComparison.Ordinal)
                        || ((name.EndsWith(".rec", StringComparison.Ordinal) || name.EndsWith(".rec.gz", StringComparison.Ordinal))
                            && !File.Exists(Path.Combine(HistoryFolder, id + ".json")))
                        || (name.EndsWith(".json", StringComparison.Ordinal) && !File.Exists(Path.Combine(HistoryFolder, id + ".rec"))
                            && !File.Exists(Path.Combine(HistoryFolder, id + ".rec.gz")));
                    if (stray && _recording.Values.All(r => r.Id != id) && File.GetLastWriteTimeUtc(file) < DateTime.UtcNow.AddMinutes(-2))
                    {
                        File.Delete(file);
                        count++;
                    }
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.Debug($"[Satellite] Raid history not tidied: {ex.Message}");
        }

        return new JsonObject { ["ok"] = true, ["n"] = count }.ToJsonString();
    }

    private long HistoryBytes()
    {
        try
        {
            return Directory.Exists(HistoryFolder) ? new DirectoryInfo(HistoryFolder).GetFiles().Sum(f => f.Length) : 0;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return 0;
        }
    }
}

// A SQLite file, read (never written): its tables' rows as they stand, with what its write-ahead log (the "-wal" file
// beside it) has committed since. Enough of the format for Raid Review's database: tables of numbers and text.
internal sealed class SqliteFile : IDisposable
{
    private readonly FileStream _file;
    private readonly FileStream? _log;
    private readonly int _page;
    private readonly int _usable;
    private readonly Dictionary<uint, long> _logged = [];
    private readonly Dictionary<uint, byte[]> _pages = [];
    private readonly Dictionary<string, (uint Root, string[] Columns)> _tables = new(StringComparer.OrdinalIgnoreCase);

    public SqliteFile(string path)
    {
        _file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var head = new byte[100];
        if (_file.Read(head, 0, 100) != 100 || Encoding.ASCII.GetString(head, 0, 15) != "SQLite format 3")
        {
            _file.Dispose();
            throw new InvalidDataException("not a SQLite file");
        }

        _page = (head[16] << 8) | head[17];
        _page = _page == 1 ? 65536 : _page;
        _usable = _page - head[20];
        if (_page < 512 || (_page & (_page - 1)) != 0)
        {
            _file.Dispose();
            throw new InvalidDataException("not a SQLite file");
        }

        var log = path + "-wal";
        if (File.Exists(log))
        {
            try
            {
                _log = new FileStream(log, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                ReadLog();
            }
            catch (IOException)
            {
                _log = null;
            }
        }

        foreach (var row in Rows(1))
        {
            if (row.Length >= 5 && row[0] as string == "table" && row[1] is string name && row[3] is long root && row[4] is string sql)
            {
                _tables[name] = ((uint)root, Columns(sql));
            }
        }
    }

    public void Dispose()
    {
        _file.Dispose();
        _log?.Dispose();
    }

    public bool Has(string table) => _tables.ContainsKey(table);

    public IEnumerable<Dictionary<string, object?>> Table(string name)
    {
        if (!_tables.TryGetValue(name, out var table))
        {
            yield break;
        }

        foreach (var row in Rows(table.Root))
        {
            var values = new Dictionary<string, object?>(table.Columns.Length);
            for (var i = 0; i < table.Columns.Length; i++)
            {
                values[table.Columns[i]] = i < row.Length ? row[i] : null;
            }

            yield return values;
        }
    }

    // the log: frames of (page number, pages in the database once committed, two salts, two checksums) and the page;
    // a page counts once a frame after it commits, and the last such frame of a page is the page
    private void ReadLog()
    {
        var head = new byte[32];
        if (_log == null || _log.Read(head, 0, 32) != 32)
        {
            return;
        }

        var magic = U32(head, 0);
        if ((magic != 0x377f0682 && magic != 0x377f0683) || U32(head, 8) != (uint)(_page == 65536 ? 65536 : _page))
        {
            return;
        }

        uint salt1 = U32(head, 16), salt2 = U32(head, 20);
        var pending = new Dictionary<uint, long>();
        var frame = new byte[24];
        for (long at = 32; at + 24 + _page <= _log.Length; at += 24 + _page)
        {
            _log.Position = at;
            if (_log.Read(frame, 0, 24) != 24 || U32(frame, 8) != salt1 || U32(frame, 12) != salt2)
            {
                break;
            }

            pending[U32(frame, 0)] = at + 24;
            if (U32(frame, 4) != 0)
            {
                foreach (var (page, where) in pending)
                {
                    _logged[page] = where;
                }

                pending.Clear();
            }
        }
    }

    private byte[] Page(uint number)
    {
        if (_pages.TryGetValue(number, out var known))
        {
            return known;
        }

        var page = new byte[_page];
        var from = _logged.TryGetValue(number, out var where) && _log != null ? _log : _file;
        from.Position = from == _file ? (long)(number - 1) * _page : where;
        var read = 0;
        while (read < _page)
        {
            var got = from.Read(page, read, _page - read);
            if (got <= 0)
            {
                throw new InvalidDataException("the database is cut short");
            }

            read += got;
        }

        if (_pages.Count > 512)
        {
            _pages.Clear();
        }

        return _pages[number] = page;
    }

    private static uint U32(byte[] b, int at) => ((uint)b[at] << 24) | ((uint)b[at + 1] << 16) | ((uint)b[at + 2] << 8) | b[at + 3];

    private static int U16(byte[] b, int at) => (b[at] << 8) | b[at + 1];

    private static long Varint(byte[] b, ref int at)
    {
        long value = 0;
        for (var i = 0; i < 8; i++)
        {
            var one = b[at++];
            value = (value << 7) | (long)(one & 0x7f);
            if ((one & 0x80) == 0)
            {
                return value;
            }
        }

        return (value << 8) | b[at++];
    }

    private IEnumerable<object?[]> Rows(uint root)
    {
        var todo = new Stack<uint>();
        todo.Push(root);
        var seen = 0;
        while (todo.Count > 0)
        {
            if (++seen > 4_000_000)
            {
                throw new InvalidDataException("the database goes round in circles");
            }

            var number = todo.Pop();
            var page = Page(number);
            var head = number == 1 ? 100 : 0;
            var cells = U16(page, head + 3);
            if (page[head] == 5)
            {
                todo.Push(U32(page, head + 8));
                for (var i = cells - 1; i >= 0; i--)
                {
                    todo.Push(U32(page, U16(page, head + 12 + 2 * i)));
                }
            }
            else if (page[head] == 13)
            {
                for (var i = 0; i < cells; i++)
                {
                    var at = U16(page, head + 8 + 2 * i);
                    var size = Varint(page, ref at);
                    Varint(page, ref at);
                    yield return Record(Payload(page, at, size));
                }
            }
        }
    }

    // a row's bytes: what fits on its page, and the rest along a chain of overflow pages
    private byte[] Payload(byte[] page, int at, long size)
    {
        if (size < 0 || size > 256 << 20)
        {
            throw new InvalidDataException("a row too big");
        }

        var all = new byte[size];
        var most = _usable - 35;
        var local = (int)size;
        if (size > most)
        {
            var least = (_usable - 12) * 32 / 255 - 23;
            var k = least + (int)((size - least) % (_usable - 4));
            local = k <= most ? k : least;
        }

        Array.Copy(page, at, all, 0, local);
        var have = local;
        if (local < size)
        {
            var next = U32(page, at + local);
            while (next != 0 && have < size)
            {
                var more = Page(next);
                var take = (int)Math.Min(size - have, _usable - 4);
                Array.Copy(more, 4, all, have, take);
                have += take;
                next = U32(more, 0);
            }
        }

        return all;
    }

    private static object?[] Record(byte[] b)
    {
        var at = 0;
        var head = (int)Varint(b, ref at);
        var types = new List<long>();
        while (at < head)
        {
            types.Add(Varint(b, ref at));
        }

        var values = new object?[types.Count];
        at = head;
        for (var i = 0; i < types.Count; i++)
        {
            var type = types[i];
            switch (type)
            {
                case 0:
                    values[i] = null;
                    break;
                case >= 1 and <= 6:
                    var bytes = type == 5 ? 6 : type == 6 ? 8 : (int)type;
                    long whole = (sbyte)b[at];
                    for (var k = 1; k < bytes; k++)
                    {
                        whole = (whole << 8) | b[at + k];
                    }

                    values[i] = whole;
                    at += bytes;
                    break;
                case 7:
                    long bits = 0;
                    for (var k = 0; k < 8; k++)
                    {
                        bits = (bits << 8) | b[at + k];
                    }

                    values[i] = BitConverter.Int64BitsToDouble(bits);
                    at += 8;
                    break;
                case 8:
                    values[i] = 0L;
                    break;
                case 9:
                    values[i] = 1L;
                    break;
                default:
                    var length = (int)((type - (type % 2 == 0 ? 12 : 13)) / 2);
                    values[i] = type % 2 == 0 ? b.AsSpan(at, length).ToArray() : Encoding.UTF8.GetString(b, at, length);
                    at += length;
                    break;
            }
        }

        return values;
    }

    // the columns of a CREATE TABLE, in order: each part between the outer brackets that isn't a constraint
    private static string[] Columns(string sql)
    {
        var from = sql.IndexOf('(');
        var to = sql.LastIndexOf(')');
        var columns = new List<string>();
        if (from < 0 || to <= from)
        {
            return [];
        }

        var depth = 0;
        var quote = '\0';
        var part = new StringBuilder();
        void Done()
        {
            var text = part.ToString().Trim();
            part.Clear();
            if (text.Length == 0)
            {
                return;
            }

            string name;
            if (text[0] is '"' or '`' or '[' or '\'')
            {
                var close = text.IndexOf(text[0] == '[' ? ']' : text[0], 1);
                name = close > 0 ? text[1..close] : text[1..];
            }
            else
            {
                var end = text.IndexOfAny([' ', '\t', '\r', '\n']);
                name = end > 0 ? text[..end] : text;
                if (name.ToUpperInvariant() is "FOREIGN" or "UNIQUE" or "PRIMARY" or "CHECK" or "CONSTRAINT")
                {
                    return;
                }
            }

            columns.Add(name);
        }

        for (var i = from + 1; i < to; i++)
        {
            var c = sql[i];
            if (quote != '\0')
            {
                quote = c == quote ? '\0' : quote;
            }
            else if (c is '"' or '`' or '\'')
            {
                quote = c;
            }
            else if (c == '(')
            {
                depth++;
            }
            else if (c == ')')
            {
                depth--;
            }
            else if (c == ',' && depth == 0)
            {
                Done();
                continue;
            }

            part.Append(c);
        }

        Done();
        return columns.ToArray();
    }
}
