using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http;
using SPTarkov.Server.Core.Models.Common;

namespace Satellite.Server;

// What's on a location besides the people, as the game plugin reads it.
//
// Places (maps/<location>/places.json): where every container, lock, spawn point, quest place and extract stands. The
// plugin looks them up in every raid; the file is only written again when they changed (a map mod moved something).
// It is meant to be read by other tools as well, so its shape is written down here:
//   {"loc":"TarkovStreets","v":1,"seen":<unix seconds>,"coords":"[east, north, height]...",
//    "boxes":[{"id","tpl","p":[e,n,h],"key"?}],                 containers (tpl: the container's template id)
//    "locks":[{"id","kind","key","p"}],                          doors, trunks... (key: the key's template id)
//    "spawns":[{"p","cat","sides","zone","infil"?}],             cat: Player, Bot, Boss...; sides: Usec, Bear, Savage...
//    "zones":[{"id","p"}],                                       places quests send you
//    "exits":[{"name","text","scav","p"}],                       every extract (text: its name in English)
//    "stops":[{"id","p"}],"route":[[[e,n],..],..]}               the BTR's stops, and its road as lines
//
// Loot (kept in memory for each game, while it's in a raid): {"loc","loose":[[id,tpl,e,n,h,count,quest]],
// "inside":{"box id":[[tpl,count],..]},"open":["lock id",..]}.
//
// Both are sent to the page with "names": {tpl: {"n": name, "s": short name, "p": price in roubles, "q": 1 if a
// quest item, "k": 1 if a key}} for every item they name.
public partial class LiveMapRoute
{
    private const int PlacesFormat = 1;

    // the config's switch for each layer, and the layer as the plugin names it
    private static readonly (string Key, string Layer)[] LayerSwitches =
    [
        ("looseLoot", "loose"), ("containerContents", "contents"), ("locks", "locks"), ("spawnPoints", "spawns"),
        ("botDetails", "brains"), ("botLoot", "carried")
    ];

    private string[]? _layersOff;

    private string[] LayersOff => _layersOff ??= ReadLayersOff();

    private JsonArray LayersOffList() => new(LayersOff.Select(k => (JsonNode?)JsonValue.Create(k)).ToArray());

    private string[] ReadLayersOff()
    {
        var off = new List<string>();
        var file = ConfigFile();
        try
        {
            if (File.Exists(file))
            {
                var options = new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true };
                var layers = JsonNode.Parse(File.ReadAllText(file), null, options)?["layers"];
                foreach (var (key, layer) in LayerSwitches)
                {
                    if (layers?[key] is JsonValue value && value.TryGetValue<bool>(out var on) && !on)
                    {
                        off.Add(layer);
                    }
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException)
        {
            logger.Warning($"[Satellite] Couldn't read the layers in config.jsonc, so all of them may be shown: {ex.Message}");
        }

        if (off.Count > 0)
        {
            logger.Info($"[Satellite] config.jsonc keeps these layers off the page: {string.Join(", ", off)}.");
        }

        return off.ToArray();
    }

    // ---- places ---------------------------------------------------------------------------------------------------

    private readonly Dictionary<string, string> _places = new(StringComparer.Ordinal);

    // POST api/places: the places on the location the game is in. Saved when they differ from what's kept.
    private async Task SavePlaces(MongoId sessionId, HttpContext context, CancellationToken cancellationToken)
    {
        if (GameSession(sessionId) == null)
        {
            context.Response.StatusCode = 403;
            return;
        }

        var sent = JsonNode.Parse(await ReadBody(context, cancellationToken)) as JsonObject;
        var location = sent?["loc"] is JsonValue loc && loc.TryGetValue<string>(out var name) ? name : "";
        if (sent == null || !LocationName().IsMatch(location))
        {
            context.Response.StatusCode = 400;
            return;
        }

        // only what has the shape it should, in the order it's described in
        var kept = new JsonObject { ["loc"] = location, ["v"] = PlacesFormat };
        var lists = new JsonObject();
        foreach (var list in PlaceLists)
        {
            lists[list] = list == "route" ? Lines(sent[list]) : Plain(sent[list], 20_000);
        }

        var print = lists.ToJsonString();
        var folder = Path.Combine(MapsFolder, location);
        var file = Path.Combine(folder, "places.json");
        var same = false;
        lock (_mapsLock)
        {
            if (File.Exists(file))
            {
                try
                {
                    var old = JsonNode.Parse(File.ReadAllText(file)) as JsonObject;
                    var oldLists = new JsonObject();
                    foreach (var list in PlaceLists)
                    {
                        oldLists[list] = old?[list]?.DeepClone();
                    }

                    // nothing moved
                    same = oldLists.ToJsonString() == print;
                }
                catch (JsonException)
                {
                    // a broken file is written again
                }
            }

            if (!same)
            {
                Write(kept, lists, folder, file, location);
            }
        }

        if (!same)
        {
            logger.Info($"[Satellite] Saved the places on {location}.");
        }

        await SendJson(context, same ? "{\"saved\":false}" : "{\"saved\":true}", cancellationToken);
    }

    // writes places.json (under _mapsLock)
    private void Write(JsonObject kept, JsonObject lists, string folder, string file, string location)
    {
        kept["seen"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        kept["coords"] = "[east, north, height] in metres: the game's own x, z and y";
        foreach (var (key, value) in lists.ToList())
        {
            lists.Remove(key);
            kept[key] = value;
        }

        Directory.CreateDirectory(folder);
        var text = kept.ToJsonString();
        File.WriteAllText(file, text);
        _places[location] = text;
    }

    private static readonly string[] PlaceLists = ["boxes", "locks", "spawns", "zones", "exits", "stops", "route"];

    // Lines of points: [[[east,north],..],..] (the BTR's road). Anything else comes back empty.
    private static JsonArray Lines(JsonNode? lines)
    {
        var kept = new JsonArray();
        if (lines is not JsonArray all)
        {
            return kept;
        }

        foreach (var line in all)
        {
            if (kept.Count >= 500 || line is not JsonArray points || points.Count < 2 || points.Count > 5000)
            {
                continue;
            }

            var clean = new JsonArray();
            foreach (var point in points)
            {
                if (point is JsonArray pair && pair.Count == 2 && pair.All(n => n is JsonValue v && v.TryGetValue<double>(out var d) && double.IsFinite(d)))
                {
                    clean.Add(new JsonArray(pair[0]!.GetValue<double>(), pair[1]!.GetValue<double>()));
                }
            }

            if (clean.Count >= 2)
            {
                kept.Add(clean);
            }
        }

        return kept;
    }

    // A list of flat objects: strings, numbers, true or false, and lists of up to three numbers. Anything else in
    // them is dropped; a list that isn't one comes back empty.
    private static JsonArray Plain(JsonNode? list, int most)
    {
        var kept = new JsonArray();
        if (list is not JsonArray items)
        {
            return kept;
        }

        foreach (var item in items)
        {
            if (kept.Count >= most || item is not JsonObject thing)
            {
                continue;
            }

            var clean = new JsonObject();
            foreach (var (key, value) in thing)
            {
                if (key.Length > 16)
                {
                    continue;
                }

                switch (value)
                {
                    case JsonValue v when v.TryGetValue<string>(out var text) && text.Length <= 200:
                        clean[key] = text;
                        break;
                    case JsonValue v when v.TryGetValue<double>(out var number) && double.IsFinite(number):
                        clean[key] = number;
                        break;
                    case JsonValue v when v.TryGetValue<bool>(out var flag):
                        clean[key] = flag;
                        break;
                    case JsonArray numbers when numbers.Count is > 0 and <= 3
                        && numbers.All(n => n is JsonValue nv && nv.TryGetValue<double>(out var d) && double.IsFinite(d)):
                        clean[key] = new JsonArray(numbers.Select(n => (JsonNode?)JsonValue.Create(n!.GetValue<double>())).ToArray());
                        break;
                }
            }

            kept.Add(clean);
        }

        return kept;
    }

    // GET api/places?loc=: a location's places, without the layers config.jsonc keeps off, with the names of the
    // containers and keys in them; {"loc":..,"none":true} when there are none yet
    private Answer PlacesFor(string location)
    {
        location = WithoutSnow(location);
        if (!LocationName().IsMatch(location))
        {
            return new Answer("{\"none\":true}", null);
        }

        string? text;
        lock (_mapsLock)
        {
            // made already, of the places as they still are
            if (_places.TryGetValue(location, out text) && _placesSent.TryGetValue(location, out var sent) && ReferenceEquals(sent.From, text)
                && _placesFlea.GetValueOrDefault(location) == _fleaVersion)
            {
                return sent.Sent;
            }

            if (!_places.TryGetValue(location, out text))
            {
                var file = Path.Combine(MapsFolder, location, "places.json");
                text = File.Exists(file) ? File.ReadAllText(file) : null;
                if (text != null)
                {
                    _places[location] = text;
                }
            }
        }

        if (text == null || JsonNode.Parse(text) is not JsonObject places)
        {
            return new Answer(new JsonObject { ["loc"] = location, ["none"] = true }.ToJsonString(), null);
        }

        var off = LayersOff;
        if (off.Contains("locks"))
        {
            places["locks"] = new JsonArray();
        }

        if (off.Contains("spawns"))
        {
            places["spawns"] = new JsonArray();
        }
        else
        {
            places["bosses"] = Bosses(location);
        }

        // the extracts are a kind of marker: config.jsonc's markers.extracts keeps these off too
        if (Off.Contains("Extract"))
        {
            places["exits"] = new JsonArray();
        }

        var named = new HashSet<string>();
        foreach (var list in new[] { "boxes", "locks" })
        {
            foreach (var thing in places[list] as JsonArray ?? [])
            {
                foreach (var key in new[] { "tpl", "key" })
                {
                    if (thing?[key] is JsonValue v && v.TryGetValue<string>(out var tpl))
                    {
                        named.Add(tpl);
                    }
                }
            }
        }

        places["names"] = Names(named);
        var answer = Packed(places.ToJsonString());
        lock (_mapsLock)
        {
            _placesSent[location] = (text, answer);
            _placesFlea[location] = _fleaVersion;
        }

        return answer;
    }

    // a location's places as a page is answered, and the places.json text it was made of
    private readonly Dictionary<string, (string From, Answer Sent)> _placesSent = new(StringComparer.Ordinal);

    // the prices each was made with (FleaPrices): made again when Better Flea's change
    private readonly Dictionary<string, int> _placesFlea = new(StringComparer.Ordinal);

    // ---- loot -----------------------------------------------------------------------------------------------------

    // POST api/things: what lies about in the game's raid now. Kept, and the pages told it changed.
    private async Task SaveThings(MongoId sessionId, HttpContext context, CancellationToken cancellationToken)
    {
        var id = GameSession(sessionId);
        if (id == null)
        {
            context.Response.StatusCode = 403;
            return;
        }

        if (!ThingsTaken(id, await ReadBody(context, cancellationToken)))
        {
            context.Response.StatusCode = 400;
            return;
        }

        await SendJson(context, "{\"saved\":true}", cancellationToken);
    }

    // What lies about in a raid, taken in (by POST, or over the plugin's link): false when it isn't that
    private bool ThingsTaken(string id, byte[] body)
    {
        var sent = JsonNode.Parse(body) as JsonObject;
        var location = sent?["loc"] is JsonValue loc && loc.TryGetValue<string>(out var name) ? name : "";
        if (sent == null || !LocationName().IsMatch(location) || sent["loose"] is not JsonArray
            || sent["inside"] is not JsonObject || sent["open"] is not JsonArray)
        {
            return false;
        }

        var off = LayersOff;
        if (off.Contains("loose"))
        {
            sent["loose"] = new JsonArray();
        }

        if (off.Contains("contents"))
        {
            sent["inside"] = new JsonObject();
        }

        if (off.Contains("locks"))
        {
            sent["open"] = new JsonArray();
        }

        if (off.Contains("carried"))
        {
            sent.Remove("carried");
        }

        var session = _sessions.GetOrAdd(id, key => new Session(key));
        session.Things = sent.ToJsonString();
        var count = Interlocked.Increment(ref session.ThingsSent);
        Publish(session, "{\"t\":\"things\",\"v\":" + count + ",\"loc\":" + JsonSerializer.Serialize(location) + "}");
        return true;
    }

    // GET api/things[?session=]: what lies about in that game's raid (the game heard from last), with names
    private Answer ThingsFor(string? wanted)
    {
        var session = Pick(wanted);
        if (session?.Things is not { } text)
        {
            return new Answer("{\"none\":true}", null);
        }

        // made already for this report: every page watching asks at once when it changes
        if (session.ThingsMade is { } made && ReferenceEquals(made.From, text))
        {
            return made.Sent;
        }

        if (JsonNode.Parse(text) is not JsonObject things)
        {
            return new Answer("{\"none\":true}", null);
        }

        var named = new HashSet<string>();
        foreach (var row in things["loose"] as JsonArray ?? [])
        {
            if (row is JsonArray r && r.Count > 1 && r[1] is JsonValue v && v.TryGetValue<string>(out var tpl))
            {
                named.Add(tpl);
            }
        }

        var held = (things["inside"] as JsonObject ?? []).Concat(things["carried"] as JsonObject ?? []);
        foreach (var (_, items) in held)
        {
            foreach (var row in items as JsonArray ?? [])
            {
                if (row is JsonArray r && r.Count > 0 && r[0] is JsonValue v && v.TryGetValue<string>(out var tpl))
                {
                    named.Add(tpl);
                }
            }
        }

        things["sid"] = session.Id;
        things["v"] = session.ThingsSent;
        things["names"] = Names(named);
        // packed quickly rather than small: it's made again every few seconds of a raid
        var answer = Packed(things.ToJsonString(), System.IO.Compression.CompressionLevel.Fastest);
        session.ThingsMade = new ThingsAnswer(text, answer);
        return answer;
    }

    // ---- names and prices -------------------------------------------------------------------------------------------

    private const string KeyNode = "543be5e94bdc2df1348b4568";

    private readonly Lock _namesLock = new();
    private Dictionary<string, string>? _locale;
    private Dictionary<string, double>? _handbook;
    private readonly Dictionary<string, JsonObject> _names = new(StringComparer.Ordinal);

    private JsonObject Names(IEnumerable<string> ids)
    {
        var all = new JsonObject();
        lock (_namesLock)
        {
            foreach (var id in ids)
            {
                if (!_names.TryGetValue(id, out var entry))
                {
                    _names[id] = entry = NameOf(id);
                }

                var copy = entry.DeepClone();
                // Better Flea's price, once it's been asked for (FleaPrices), over SPT's
                if (copy is JsonObject named && FleaPrice(id) is { } flea)
                {
                    named["p"] = Math.Round(flea);
                }

                all[id] = copy;
            }
        }

        return all;
    }

    // the English texts of items, quests and the rest (under _namesLock)
    private Dictionary<string, string> Locale()
    {
        if (_locale == null)
        {
            // SPT writes "<id> Name", some mods "<id> name": both are looked up the same
            _locale = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            try
            {
                foreach (var (key, value) in locales.GetLocaleDb("en") ?? [])
                {
                    _locale[key] = value;
                }
            }
            catch (Exception ex)
            {
                logger.Warning($"[Satellite] Couldn't read the item names: {ex.Message}");
            }
        }

        return _locale;
    }

    // what sort of container a template is, by the game's own name for it, for the page to draw it by
    private static readonly (Regex Name, string Sort)[] ContainerSorts =
    [
        (new Regex("^Safe", RegexOptions.IgnoreCase), "safe"),
        (new Regex("^CashRegister", RegexOptions.IgnoreCase), "register"),
        (new Regex("^Drawer", RegexOptions.IgnoreCase), "drawer"),
        (new Regex("^(SportBag|suitcase)", RegexOptions.IgnoreCase), "bag"),
        (new Regex("^Jacket", RegexOptions.IgnoreCase), "jacket"),
        (new Regex("^(ToolBox|tools)", RegexOptions.IgnoreCase), "tools"),
        (new Regex("^PCblock", RegexOptions.IgnoreCase), "pc"),
        (new Regex("^GrenadeBox", RegexOptions.IgnoreCase), "grenade"),
        (new Regex("^(terraWBox|AmmoBox|WeaponBox)", RegexOptions.IgnoreCase), "weapon"),
        (new Regex("^(MedBag|MedBox|meds)", RegexOptions.IgnoreCase), "med"),
        (new Regex("^Food", RegexOptions.IgnoreCase), "food"),
        (new Regex("(cache|stash)", RegexOptions.IgnoreCase), "cache"),
        (new Regex("(Dead|body|corpse)", RegexOptions.IgnoreCase), "body"),
        (new Regex("^WeaponCrate", RegexOptions.IgnoreCase), "crate")
    ];

    // The kind of loot an item is, for the page's "Kinds of loot" switches: by the handbook's category it's under, the
    // top one (Weapons, Ammo, Keys...), or under "Barter items" the one below (Valuables, Electronics...). null for an
    // item the handbook doesn't list. (under _namesLock)
    private Dictionary<string, string>? _kinds;

    private static readonly Dictionary<string, string> TopKinds = new(StringComparer.Ordinal)
    {
        ["5b47574386f77428ca22b33f"] = "gear", ["5b47574386f77428ca22b342"] = "keys", ["5b47574386f77428ca22b346"] = "ammo",
        ["5b47574386f77428ca22b345"] = "special", ["5b619f1a86f77450a702a6f3"] = "other", ["5b5f71a686f77447ed5636ab"] = "mods",
        ["5b47574386f77428ca22b341"] = "info", ["5b47574386f77428ca22b340"] = "food", ["5b47574386f77428ca22b343"] = "info",
        ["5b5f78b786f77447ed5636af"] = "money", ["5b5f78dc86f77409407a7f8e"] = "weapons", ["5b47574386f77428ca22b344"] = "meds"
    };

    private const string BarterNode = "5b47574386f77428ca22b33e";

    private string? KindOf(string id)
    {
        if (_kinds == null)
        {
            _kinds = new Dictionary<string, string>(StringComparer.Ordinal);
            try
            {
                var locale = Locale();
                var parent = new Dictionary<string, string>(StringComparer.Ordinal);
                foreach (var category in templates.Handbook?.Categories ?? [])
                {
                    parent[category.Id.ToString()] = category.ParentId?.ToString() ?? "";
                }

                string Kind(string category)
                {
                    // the chain up from the item's category, top first
                    var chain = new List<string>();
                    for (var at = category; !string.IsNullOrEmpty(at) && chain.Count < 12; at = parent.GetValueOrDefault(at) ?? "")
                    {
                        chain.Insert(0, at);
                    }

                    if (chain.Count == 0)
                    {
                        return "other";
                    }

                    if (chain[0] != BarterNode)
                    {
                        return TopKinds.GetValueOrDefault(chain[0]) ?? "other";
                    }

                    var below = chain.Count > 1 ? locale.GetValueOrDefault(chain[1]) ?? "" : "";
                    return below switch
                    {
                        "Valuables" => "valuables",
                        "Electronics" or "Energy elements" => "electronics",
                        "Medical supplies" => "meds",
                        "Tools" or "Building materials" => "tools",
                        _ => "household"
                    };
                }

                foreach (var item in templates.Handbook?.Items ?? [])
                {
                    _kinds[item.Id.ToString()] = Kind(item.ParentId.ToString());
                }
            }
            catch (Exception ex)
            {
                logger.Warning($"[Satellite] Couldn't sort the items into kinds: {ex.Message}");
            }
        }

        return _kinds.TryGetValue(id, out var kind) ? kind : null;
    }

    private JsonObject NameOf(string id)
    {
        var locale = Locale();
        var entry = new JsonObject
        {
            ["n"] = locale.GetValueOrDefault(id + " Name") ?? id,
            ["s"] = locale.GetValueOrDefault(id + " ShortName") ?? ""
        };
        if (!MongoId.IsValidMongoId(id))
        {
            return entry;
        }

        var mongo = new MongoId(id);
        var price = templates.Prices != null && templates.Prices.TryGetValue(mongo, out var p) ? p : 0;
        if (price <= 0)
        {
            _handbook ??= (templates.Handbook?.Items ?? []).GroupBy(i => i.Id.ToString()).ToDictionary(g => g.Key, g => g.First().Price ?? 0);
            price = _handbook.GetValueOrDefault(id);
        }

        entry["p"] = Math.Round(price);
        if (KindOf(id) is { } kind)
        {
            entry["g"] = kind;
        }

        if (templates.Items.TryGetValue(mongo, out var item))
        {
            if (item.Properties?.QuestItem == true)
            {
                entry["q"] = 1;
            }

            var sort = ContainerSorts.FirstOrDefault(s => s.Name.IsMatch(item.Name ?? "")).Sort;
            if (sort != null && templates.Items.GetValueOrDefault(item.Parent)?.Name == "LootContainer")
            {
                entry["c"] = sort;
            }

            for (var (at, steps) = (item, 0); at != null && steps < 20; at = templates.Items.GetValueOrDefault(at.Parent), steps++)
            {
                if (at.Id.ToString() == KeyNode)
                {
                    entry["k"] = 1;
                    break;
                }
            }
        }

        return entry;
    }
}
