using System.Text.Json;
using System.Text.Json.Nodes;

namespace Satellite.Server;

// A Fika raid is shown from its host's game: the headless, or the player hosting it. Only the host has the raid's real
// bots (what each one is, what SAIN, ORBIT and COMET have it doing, who killed whom); a player who joined has copies
// kept in step from the host. So for a player in a raid with a host that reports ("fh":1), the page gets the host's
// report, with that player's own part from their own game: where they are, their extracts, the map and its season.
//
// The player is found in the host's report by "u", the id each person has in the raid. Their marker becomes the Main
// Player, named as on their account (a player scav's own name is made up), and is put where their own game says they
// are. The host's own marker goes when it's a headless (nobody plays it); a player hosting is a friend like any other.
// A headless is never offered as a game to watch.
//
// Without a host that reports (no Satellite on it, say), a player's report goes on as it is, with what a headless says
// its bots are up to added where the player's game knows nothing (HostBots).
public partial class LiveMapRoute
{
    // the player's extracts, numbered apart from the host's markers
    private const long OwnIdsFrom = 1_000_000_000;

    // the bots' minds as a host last said, by profile id, and the bot mods it has
    private sealed record HostBots(Dictionary<string, JsonObject> Bots, string[] Mods);

    // a host's last full report (censored), the people in it ("u" to the marker's id), and its own marker's id
    private sealed record HostView(string Full, Dictionary<string, long> People, long? Own);

    // "hl":1 in the plugin's reports, or Fika's own name for its headless profiles
    private static bool IsHeadless(Session session, JsonElement root) =>
        session.Headless
        || (root.TryGetProperty("hl", out var flag) && flag.ValueKind == JsonValueKind.Number && flag.GetInt32() == 1)
        || (session.Name is { } name && name.StartsWith("\"headless_", StringComparison.Ordinal));

    private static bool Flag(JsonElement root, string name) =>
        root.TryGetProperty(name, out var flag) && flag.ValueKind == JsonValueKind.Number && flag.GetInt32() == 1;

    private bool Fresh(Session session) => Now - Interlocked.Read(ref session.SeenAt) < GoneAfter;

    // the host of the raid a player is in, when it reports
    private Session? HostOf(Session player)
    {
        if (player.Headless || !player.Raid || player.Own is not { } own || !Fresh(player))
        {
            return null;
        }

        foreach (var session in _sessions.Values)
        {
            if (session != player && session.IsHost && session.Raid && Fresh(session) && session.Host is { } view && view.People.ContainsKey(own))
            {
                return session;
            }
        }

        return null;
    }

    // a host reports in full while anyone watches a player in its raid (a player hosting, also for its own pages)
    private int HostWatchers(Session host)
    {
        var own = host.Headless ? 0 : Watchers(host);
        foreach (var session in _sessions.Values)
        {
            if (session != host && !session.Headless && session.Raid && Fresh(session) && Watchers(session) > 0
                && (HostOf(session) == host || HostOf(session) == null))
            {
                return Math.Max(own, 1);
            }
        }

        return own;
    }

    // what a player's own report says of them: their id in the raid, and where they are
    private static void KeepOwn(Session session, JsonObject node)
    {
        if (node["me"] is JsonArray me)
        {
            session.Me = me.ToJsonString();
        }

        if (node["markers"] is JsonArray markers)
        {
            foreach (var marker in markers)
            {
                if (marker is JsonObject one && one["c"] is JsonValue c && c.TryGetValue<string>(out var kind) && kind == "Main Player"
                    && one["u"] is JsonValue u && u.TryGetValue<string>(out var id))
                {
                    session.Own = id;
                    // as their own game names them ("Nikita Berg (fums)" for a player scav)
                    session.OwnName = one["t"] is JsonValue t && t.TryGetValue<string>(out var said) && said.Length > 0 ? said : null;
                    break;
                }
            }
        }
    }

    // a host's full report: who's in it, and what it says its bots are up to
    private static void KeepHost(Session session, JsonObject node, string censored)
    {
        var people = new Dictionary<string, long>(StringComparer.Ordinal);
        long? own = null;
        var bots = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        if (node["markers"] is JsonArray markers)
        {
            foreach (var marker in markers)
            {
                if (marker is not JsonObject one || one["id"] is not JsonValue idValue || !idValue.TryGetValue<long>(out var id))
                {
                    continue;
                }

                if (one["c"] is JsonValue c && c.TryGetValue<string>(out var kind) && kind == "Main Player")
                {
                    own = id;
                }

                if (one["u"] is JsonValue u && u.TryGetValue<string>(out var person))
                {
                    people[person] = id;
                }

                if (one["pid"] is JsonValue pid && pid.TryGetValue<string>(out var bot) && one["was"] == null)
                {
                    JsonObject? mind = null;
                    foreach (var field in BrainFields)
                    {
                        if (one[field] is { } value)
                        {
                            (mind ??= [])[field] = value.DeepClone();
                        }
                    }

                    if (mind != null)
                    {
                        bots[bot] = mind;
                    }
                }
            }
        }

        var mods = node["brains"] is JsonArray list
            ? list.Select(m => m is JsonValue v && v.TryGetValue<string>(out var s) ? s : null).OfType<string>().ToArray()
            : [];
        session.HostBots = new HostBots(bots, mods);
        session.Host = new HostView(censored, people, own);
    }

    // The page's full report for a player in a raid their host reports: the host's, with the player's own part.
    private string? Compose(Session host, Session player)
    {
        if (host.Host is not { } view || player.OwnFull is not { } ownText || player.Own is not { } ownId)
        {
            return null;
        }

        var node = JsonNode.Parse(view.Full)!.AsObject();
        var own = JsonNode.Parse(ownText)!.AsObject();
        var me = player.Me is { } meText ? JsonNode.Parse(meText) as JsonArray : null;
        var name = player.OwnName ?? PlainName(player);

        var markers = new JsonArray();
        if (node["markers"] is JsonArray theirs)
        {
            foreach (var marker in theirs.ToList())
            {
                if (marker is not JsonObject one)
                {
                    continue;
                }

                theirs.Remove(one);
                var kind = one["c"] is JsonValue c && c.TryGetValue<string>(out var k) ? k : "";
                // the player's own extracts are theirs (below); the headless isn't anybody
                if (kind == "Extract" || (kind == "Main Player" && host.Headless))
                {
                    continue;
                }

                if (kind == "Main Player")
                {
                    one["c"] = "Friendly Player";
                }

                if (one["u"] is JsonValue u && u.TryGetValue<string>(out var person) && person == ownId)
                {
                    one["c"] = "Main Player";
                    if (name != null)
                    {
                        one["t"] = name;
                    }

                    Place(one, me);
                }
                else if (kind == "Corpse" && name != null && one["pid"] is JsonValue pid && pid.TryGetValue<string>(out var dead) && dead == ownId)
                {
                    one["t"] = name;
                }

                markers.Add(one);
            }
        }

        if (own["markers"] is JsonArray mine)
        {
            foreach (var marker in mine.ToList())
            {
                if (marker is JsonObject one && one["c"] is JsonValue c && c.TryGetValue<string>(out var kind) && kind == "Extract"
                    && one["id"] is JsonValue id && id.TryGetValue<long>(out var number))
                {
                    mine.Remove(one);
                    one["id"] = OwnIdsFrom + number;
                    markers.Add(one);
                }
            }
        }

        // the player's report, with the host's raid in it, and where they are now (their last full report's "me" is up to
        // a second old: the map, which follows them, would jump back to it)
        own["markers"] = markers;
        if (me != null)
        {
            own["me"] = me.DeepClone();
        }
        foreach (var field in new[] { "rid", "clk", "ev", "sh", "plane" })
        {
            own.Remove(field);
            if (node[field] is { } value)
            {
                node.Remove(field);
                own[field] = value;
            }
        }

        if (own["ev"] is JsonArray events && name != null)
        {
            foreach (var one in events)
            {
                if (one is JsonObject e)
                {
                    RenameIn(e, ownId, name);
                }
            }
        }

        own["has"] = Both(own["has"], node["has"]);
        own["brains"] = Both(own["brains"], node["brains"]);
        own["fika"] = host.Headless ? "headless" : "host";
        return own.ToJsonString();
    }

    // A host's quick report (where things are now), for a player in its raid: everybody but the player (and the
    // headless's own row). Where the player is comes from their own game, as it comes (OwnFast): taken from the host's
    // reports instead, it would only move when the host's next one came, on the host's clock, and jerk.
    private static string ComposeFast(Session host, Session player, string fast)
    {
        var node = JsonNode.Parse(fast)!.AsObject();
        var view = host.Host;
        long? mine = view != null && player.Own != null && view.People.TryGetValue(player.Own, out var id) ? id : null;
        if (node["m"] is JsonArray rows)
        {
            for (var i = rows.Count - 1; i >= 0; i--)
            {
                if (rows[i] is JsonArray row && row.Count > 0 && row[0] is JsonValue first && first.TryGetValue<long>(out var who)
                    && (mine == who || (host.Headless && view?.Own == who)))
                {
                    rows.RemoveAt(i);
                }
            }
        }

        node.Remove("me");
        return node.ToJsonString();
    }

    // A player's own quick report, while the page is shown their host's raid: only where they are, as the row of
    // their marker in the host's numbering ("own": the page moves only them by it, and keeps its timing by the host's)
    private static string? OwnFast(Session host, Session player)
    {
        var me = player.Me is { } meText ? JsonNode.Parse(meText) as JsonArray : null;
        if (me == null || me.Count < 4)
        {
            return null;
        }

        var node = new JsonObject { ["t"] = "fast", ["own"] = 1, ["me"] = me.DeepClone() };
        if (host.Host is { } view && player.Own != null && view.People.TryGetValue(player.Own, out var id))
        {
            node["m"] = new JsonArray(new JsonArray(id, me[0]?.DeepClone(), me[1]?.DeepClone(), me[2]?.DeepClone(), me[3]?.DeepClone()));
        }

        return node.ToJsonString();
    }

    // a host's report reached the server: on to the players in its raid
    private void ToPlayers(Session host, string kind, string text)
    {
        foreach (var player in _sessions.Values)
        {
            if (player == host || HostOf(player) != host)
            {
                continue;
            }

            if (kind == "full")
            {
                if (Compose(host, player) is { } full)
                {
                    player.LastFull = full;
                    Interlocked.Exchange(ref player.LastFullAt, Now);
                    Publish(player, full);
                }
            }
            else if (kind == "fast")
            {
                Publish(player, ComposeFast(host, player, text));
            }
        }
    }

    // a marker at a place from a report's "me" ([east, north, height, facing, indoors])
    private static void Place(JsonObject marker, JsonArray? me)
    {
        if (me == null || me.Count < 4)
        {
            return;
        }

        marker["p"] = new JsonArray(me[0]?.DeepClone(), me[1]?.DeepClone(), me[2]?.DeepClone());
        marker["r"] = me[3]?.DeepClone();
    }

    // the player's name as plain text (the session keeps it as JSON text)
    private static string? PlainName(Session session)
    {
        try
        {
            return session.Name is { } json ? JsonSerializer.Deserialize<string>(json) : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    // an event of the host's, with the player named as on their account where it's them that died or killed
    private static void RenameIn(JsonObject e, string ownId, string name)
    {
        if (e["p"] is JsonValue p && p.TryGetValue<string>(out var whose) && whose == ownId)
        {
            e["nm"] = name;
        }

        if (e["d"] is JsonObject d && d["k"] is JsonValue k && k.TryGetValue<string>(out var killer) && killer == ownId)
        {
            d["kn"] = name;
        }
    }

    private static string RenameIn(string json, string? ownId, string? name)
    {
        if (ownId == null || name == null || !json.Contains(ownId, StringComparison.Ordinal))
        {
            return json;
        }

        var e = JsonNode.Parse(json)!.AsObject();
        RenameIn(e, ownId, name);
        return e.ToJsonString();
    }

    // two lists of names as one
    private static JsonArray Both(JsonNode? a, JsonNode? b)
    {
        var all = new JsonArray();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var list in new[] { a, b })
        {
            if (list is not JsonArray items)
            {
                continue;
            }

            foreach (var item in items)
            {
                if (item is JsonValue v && v.TryGetValue<string>(out var s) && seen.Add(s))
                {
                    all.Add(s);
                }
            }
        }

        return all;
    }

    // a player's full report without a host that reports: what a headless says its bots are up to, where the
    // player's own game knows nothing
    private void AddHostBots(JsonObject node)
    {
        if (node["markers"] is not JsonArray markers)
        {
            return;
        }

        var hosts = _sessions.Values
            .Where(s => s.IsHost && s.Raid && s.HostBots != null && Fresh(s))
            .Select(s => s.HostBots!).ToList();
        if (hosts.Count == 0)
        {
            return;
        }

        var used = false;
        foreach (var marker in markers)
        {
            if (marker is not JsonObject one || one["pid"] is not JsonValue pid || !pid.TryGetValue<string>(out var id) || one["was"] != null)
            {
                continue;
            }

            foreach (var host in hosts)
            {
                if (!host.Bots.TryGetValue(id, out var mind))
                {
                    continue;
                }

                foreach (var (field, value) in mind)
                {
                    if (value != null)
                    {
                        one[field] = value.DeepClone();
                    }
                }

                used = true;
                break;
            }
        }

        if (used)
        {
            node["brains"] = Both(node["brains"], new JsonArray(hosts.SelectMany(h => h.Mods).Distinct().Select(m => (JsonNode)m).ToArray()));
        }
    }
}
