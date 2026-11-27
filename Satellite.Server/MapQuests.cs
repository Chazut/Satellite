using System.Text.Json.Nodes;
using SPTarkov.Server.Core.Models.Eft.Common;
using SPTarkov.Server.Core.Models.Eft.Common.Tables;
using SPTarkov.Server.Core.Models.Enums;
using SPTarkov.Server.Core.Utils.Json;

namespace Satellite.Server;

// The quests of the player whose game a page shows, and where on the maps they send them.
//
// GET api/quests[?session=]:
//   {"sid","quests":[{"id","name","trader","loc"?,"goals":[{"id","text","zones":[zone ids],"items":[tpls],
//     "locs":[locations]}]}],
//    "zones":{"zone id":"name of a quest that sends you there",..},"wish":[tpls on the player's wishlist],
//    "wishG":{tpl: its wishlist group, as the game numbers them: 0 Tasks, 1 Hideout, 2 Barter, 3 Equipment, 4 Other},
//    "names":{tpl: as in api/things},
//    "friends":[{"sid","name","quests":[as above]}]}
// A goal that wants items found in raid has "fir":1, and "n": how many it wants.
// "friends" holds the quests of the other players in the same Fika raid (the raid's host reports, so who's in it is
// known), so a page can show what they're after too.
// "quests" holds the quests the player has started, each with the goals not done yet. "zones" holds every place any
// quest sends you to, so the page can name them all. A zone id is the id of a place in places.json's "zones".
public partial class LiveMapRoute
{
    // the game's location ids, by the name the plugin and the page know them by
    private static readonly Dictionary<string, string> LocationIds = new(StringComparer.OrdinalIgnoreCase)
    {
        ["56f40101d2720b2a4d8b45d6"] = "bigmap",
        ["55f2d3fd4bdc2d5f408b4567"] = "factory4_day",
        ["59fc81d786f774390775787e"] = "factory4_night",
        ["5714dbc024597771384a510d"] = "Interchange",
        ["5b0fc42d86f7744a585f9105"] = "laboratory",
        ["6733700029c367a3d40b02af"] = "Labyrinth",
        ["5704e4dad2720bb55b8b4567"] = "Lighthouse",
        ["5704e5fad2720bc05b8b4567"] = "RezervBase",
        ["653e6760052c01c1c805532f"] = "Sandbox",
        ["65b8d6f5cdde2479cb2a3125"] = "Sandbox_high",
        ["5704e554d2720bac5b8b456e"] = "Shoreline",
        ["5714dc692459777137212e12"] = "TarkovStreets",
        ["5704e3c2d2720bac5b8b4567"] = "Woods"
    };

    // The location a quest is on, by the name the plugin and the page know it by. The game's own are listed above; a
    // location a mod adds is known once it's been captured (its meta.json has the game's id for it, "lid").
    private static string? QuestLocation(string? gameId, Dictionary<string, string> captured)
    {
        if (string.IsNullOrEmpty(gameId))
        {
            return null;
        }

        return LocationIds.TryGetValue(gameId, out var known) ? known : captured.GetValueOrDefault(gameId);
    }

    // the game's id -> location, from every captured map that says
    private Dictionary<string, string> CapturedLocationIds()
    {
        var found = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        lock (_mapsLock)
        {
            foreach (var meta in KnownMaps().Values)
            {
                try
                {
                    if (JsonNode.Parse(meta) is JsonObject about && about["lid"]?.GetValue<string>() is { } gameId
                        && about["base"]?.GetValue<string>() is { } place)
                    {
                        found.TryAdd(gameId, place);
                    }
                }
                catch (Exception ex) when (ex is System.Text.Json.JsonException or InvalidOperationException or FormatException)
                {
                    // a map without names
                }
            }
        }

        return found;
    }

    // what a goal asks for: the items, the places and the locations in it
    private sealed record Goal(List<string> Items, List<string> Zones, List<string> Locations)
    {
        // the items must be found in raid; Count: how many it wants
        public bool FoundInRaid { get; set; }
        public int Count { get; set; }
    }

    private static List<string> Values(ListOrT<string>? target) =>
        target?.List ?? (target?.Item is { } one ? [one] : []);

    private static Goal GoalOf(QuestCondition condition)
    {
        var goal = new Goal([], [], []);
        switch (condition.ConditionType)
        {
            case "FindItem":
            case "HandoverItem":
                goal.Items.AddRange(Values(condition.Target));
                goal.FoundInRaid = condition.OnlyFoundInRaid == true;
                goal.Count = (int)Math.Max(0, condition.Value ?? 0);
                break;
            case "LeaveItemAtLocation":
            case "PlaceBeacon":
                if (!string.IsNullOrEmpty(condition.ZoneId))
                {
                    goal.Zones.Add(condition.ZoneId);
                }

                break;
            case "CounterCreator":
                foreach (var part in condition.Counter?.Conditions ?? [])
                {
                    switch (part.ConditionType)
                    {
                        case "VisitPlace":
                            goal.Zones.AddRange(Values(part.Target));
                            break;
                        case "InZone":
                            goal.Zones.AddRange(part.Zones ?? []);
                            break;
                        case "Location":
                            goal.Locations.AddRange(Values(part.Target));
                            break;
                    }
                }

                break;
        }

        return goal;
    }

    private JsonObject? _questZones;

    // The keys there are: every kind of item whose kinds above it lead to "Key" (mechanical keys and keycards)
    private const string KeyKind = "543be5e94bdc2df1348b4568";
    private HashSet<string>? _keyTemplates;

    private HashSet<string> KeyTemplates()
    {
        if (_keyTemplates != null)
        {
            return _keyTemplates;
        }

        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (id, item) in templates.Items)
        {
            var at = item;
            for (var up = 0; up < 10 && at != null; up++)
            {
                if (at.Parent.ToString() == KeyKind)
                {
                    keys.Add(id.ToString());
                    break;
                }

                at = templates.Items.TryGetValue(at.Parent, out var parent) ? parent : null;
            }
        }

        return _keyTemplates = keys;
    }

    // The player's keys, for the page to mark the locks they open: {"key template": 1 with them (worn, carried, in the
    // secure container), 2 in their stash}. In a raid, what they have with them is as their own game says (carried),
    // since the profile here has only what they went in with.
    private JsonObject KeysOf(BotBaseInventory? inventory, HashSet<string>? carried)
    {
        var keys = KeyTemplates();
        var mine = new JsonObject();
        if (inventory?.Items is { } items)
        {
            var byId = new Dictionary<string, Item>(StringComparer.Ordinal);
            foreach (var item in items)
            {
                byId[item.Id.ToString()] = item;
            }

            var worn = inventory.Equipment?.ToString();
            var stash = inventory.Stash?.ToString();
            foreach (var item in items)
            {
                var tpl = item.Template.ToString();
                if (!keys.Contains(tpl))
                {
                    continue;
                }

                // what it's in, up to the player's equipment or their stash
                string? root = null;
                var at = item;
                for (var up = 0; up < 24 && at?.ParentId is { } parent; up++)
                {
                    if (parent == worn || parent == stash)
                    {
                        root = parent;
                        break;
                    }

                    at = byId.GetValueOrDefault(parent);
                }

                if (root == worn && carried == null)
                {
                    mine[tpl] = 1;
                }
                else if (root == stash && mine[tpl] == null)
                {
                    mine[tpl] = 2;
                }
            }
        }

        foreach (var tpl in carried ?? [])
        {
            if (keys.Contains(tpl))
            {
                mine[tpl] = 1;
            }
        }

        return mine;
    }

    // the PMC profile a session plays, as the server has it
    private PmcData? ProfileOf(string sessionId)
    {
        try
        {
            foreach (var (profileId, profile) in saveServer.GetProfiles())
            {
                if (profileId.ToString() == sessionId)
                {
                    return profile?.CharacterData?.PmcData;
                }
            }
        }
        catch (Exception ex)
        {
            logger.Debug($"[Satellite] No profile for {sessionId}: {ex.Message}");
        }

        return null;
    }

    // The other players in the same Fika raid as a session: the ones its host reports (the host too, when a player
    // hosts). None when the raid's host doesn't report, as who's in it isn't known then.
    private List<Session> RaidFriends(Session session)
    {
        var friends = new List<Session>();
        if (!session.Raid || session.Headless)
        {
            return friends;
        }

        var host = session.IsHost ? session : HostOf(session);
        if (host == null)
        {
            return friends;
        }

        foreach (var other in _sessions.Values)
        {
            if (other != session && !other.Headless && other.Raid && Fresh(other)
                && (other == host || HostOf(other) == host))
            {
                friends.Add(other);
            }
        }

        return friends;
    }

    // a session's started quests, each with the goals not done yet (see the top of this file)
    private JsonArray StartedQuests(Session session, List<QuestStatus>? statuses, Dictionary<string, string> captured,
        HashSet<string> named, Func<string, string> text)
    {
        var list = new JsonArray();
        foreach (var status in statuses ?? [])
        {
            if (status.Status != QuestStatusEnum.Started || !templates.Quests.TryGetValue(status.QId, out var quest))
            {
                continue;
            }

            // done as the profile here has it, and in a raid as the player's game has it (a goal done in a raid
            // is known here only once the raid is over; after it, the profile alone says, kept or not)
            var done = new HashSet<string>(status.CompletedConditions ?? []);
            if (session.Raid)
            {
                done.UnionWith(session.QuestsDone);
            }

            var goals = new JsonArray();
            foreach (var condition in quest.Conditions?.AvailableForFinish ?? [])
            {
                var id = condition.Id.ToString();
                if (done.Contains(id))
                {
                    continue;
                }

                var goal = GoalOf(condition);
                named.UnionWith(goal.Items);
                var entry = new JsonObject
                {
                    ["id"] = id,
                    ["text"] = text(id),
                    ["items"] = new JsonArray(goal.Items.Distinct().Select(i => (JsonNode?)i).ToArray()),
                    ["zones"] = new JsonArray(goal.Zones.Distinct().Select(z => (JsonNode?)z).ToArray()),
                    ["locs"] = new JsonArray(goal.Locations.Distinct().Select(l => (JsonNode?)l).ToArray())
                };
                if (goal.FoundInRaid)
                {
                    entry["fir"] = 1;
                }

                if (goal.Count > 0)
                {
                    entry["n"] = goal.Count;
                }

                goals.Add(entry);
            }

            var started = new JsonObject
            {
                ["id"] = quest.Id.ToString(),
                ["name"] = text(quest.Id + " name") is { Length: > 0 } name ? name : quest.QuestName ?? quest.Id.ToString(),
                ["trader"] = text(quest.TraderId + " Nickname"),
                ["goals"] = goals
            };
            if (QuestLocation(quest.Location, captured) is { } loc)
            {
                started["loc"] = loc;
            }

            list.Add(started);
        }

        return list;
    }

    private string QuestsFor(string? wanted)
    {
        var session = Pick(wanted);
        if (session == null)
        {
            return "{\"none\":true}";
        }

        var pmc = ProfileOf(session.Id);
        var wish = new List<string>();
        var wishGroups = new JsonObject();
        // the items on the player's wishlist (the game keeps a group for each; any group counts)
        if (pmc?.WishList is { } wished)
        {
            wish.AddRange(wished.Keys.Select(tpl => tpl.ToString()));
            foreach (var (tpl, group) in wished)
            {
                wishGroups[tpl.ToString()] = (int)group;
            }
        }

        var captured = CapturedLocationIds();
        var named = new HashSet<string>();
        JsonArray list;
        var friends = new JsonArray();
        lock (_namesLock)
        {
            var locale = Locale();
            string Text(string key) => locale.GetValueOrDefault(key) ?? "";

            list = StartedQuests(session, pmc?.Quests, captured, named, Text);
            foreach (var friend in RaidFriends(session))
            {
                var quests = StartedQuests(friend, ProfileOf(friend.Id)?.Quests, captured, named, Text);
                if (quests.Count > 0)
                {
                    friends.Add(new JsonObject
                    {
                        ["sid"] = friend.Id,
                        ["name"] = friend.Name is { } name ? JsonNode.Parse(name) : "",
                        ["quests"] = quests
                    });
                }
            }

            // every place any quest sends you to, by the first quest's name
            if (_questZones == null)
            {
                _questZones = new JsonObject();
                foreach (var (questId, quest) in templates.Quests)
                {
                    foreach (var condition in quest.Conditions?.AvailableForFinish ?? [])
                    {
                        foreach (var zone in GoalOf(condition).Zones)
                        {
                            if (!_questZones.ContainsKey(zone))
                            {
                                _questZones[zone] = Text(questId + " name") is { Length: > 0 } name ? name : quest.QuestName ?? "";
                            }
                        }
                    }
                }
            }
        }

        return new JsonObject
        {
            ["sid"] = session.Id,
            ["quests"] = list,
            ["zones"] = _questZones.DeepClone(),
            ["wish"] = new JsonArray(wish.Distinct().Select(w => (JsonNode?)w).ToArray()),
            ["keys"] = KeysOf(pmc?.Inventory, session.Raid ? session.KeysCarried : null),
            ["wishG"] = wishGroups,
            ["friends"] = friends,
            ["names"] = Names(named, session.Id)
        }.ToJsonString();
    }
}
