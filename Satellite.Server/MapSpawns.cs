using System.Text.Json.Nodes;

namespace Satellite.Server;

// Where loot can spawn on a location and what, from the server's own loot tables (the ones it rolls each raid from,
// with whatever a loot mod changed in them at start-up), so the page can show them without a raid.
//
//   /satellite/api/spawns?loc=<map>
//   {"loc", "loose":[[east,north,height,chance,[[tpl,share],..]],..],     each loose loot spawn point: how likely it is
//                                                                          to spawn anything, and of what it spawns, how
//                                                                          likely each item is (shares add up to 1)
//    "boxes":{containerTpl:[[tpl,chance],..]},                             each kind of container: how likely each item
//                                                                          is to be in one (at least one of it)
//    "boxChance":{containerId:chance},                                     how likely each container is to be there
//    "names":{tpl:{..}}}                                                   as for api/places
public partial class LiveMapRoute
{
    // what a loose spawn point lists, at most, and a container kind
    private const int MostAtPoint = 40;
    private const int MostInBox = 60;
    // worth (roubles) that makes an item rare enough to list at a point however unlikely it is there
    private const double RareWorth = 40000;

    private readonly Lock _spawnsLock = new();
    // made once for each location, and kept packed too: it runs to megabytes
    private readonly Dictionary<string, (Answer Answer, int Flea)> _spawns = new(StringComparer.Ordinal);

    // the items of the game's events that aren't on now, as SPT's own loot leaves them out (SeasonalEventService); none
    // when it can't be asked
    private HashSet<string> InactiveEventItems()
    {
        try
        {
            // found by its name: SPT's own service, wherever a version keeps it
            var type = typeof(SPTarkov.Server.Core.Services.Locales.LocaleService).Assembly.GetTypes()
                .FirstOrDefault(t => t.Name == "SeasonalEventService");
            var seasonal = type != null ? services.GetService(type) : null;
            if (seasonal?.GetType().GetMethod("GetInactiveSeasonalEventItems", Type.EmptyTypes)?.Invoke(seasonal, null) is System.Collections.IEnumerable items)
            {
                return new HashSet<string>(items.Cast<object>().Select(t => t.ToString() ?? ""), StringComparer.Ordinal);
            }
        }
        catch (Exception ex)
        {
            logger.Warning($"[Satellite] Couldn't tell which event items are out of season; they're shown with the rest: {ex.Message}");
        }

        return new HashSet<string>(StringComparer.Ordinal);
    }

    private Answer SpawnsFor(string location)
    {
        location = WithoutSnow(location);
        if (!LocationName().IsMatch(location) || LayersOff.Contains("loose"))
        {
            return new Answer("{\"none\":true}", null);
        }

        lock (_spawnsLock)
        {
            // made with the prices as they still are (FleaPrices)
            if (_spawns.TryGetValue(location, out var made) && made.Flea == _fleaVersion)
            {
                return made.Answer;
            }
        }

        string text;
        try
        {
            text = MakeSpawns(location);
        }
        catch (Exception ex)
        {
            logger.Warning($"[Satellite] Couldn't read the loot tables of {location}: {ex.Message}");
            text = new JsonObject { ["loc"] = location, ["none"] = true }.ToJsonString();
        }

        var answer = Packed(text);
        lock (_spawnsLock)
        {
            _spawns[location] = (answer, _fleaVersion);
        }

        return answer;
    }

    private string MakeSpawns(string location)
    {
        // a version a mod swapped in ("Interchange~backport") has the location's own tables
        var id = location.Split('~')[0];
        var table = locationTable.GetDictionary();
        var found = table.FirstOrDefault(pair => string.Equals(pair.Key, id, StringComparison.OrdinalIgnoreCase)
            || string.Equals(pair.Key.Replace("_", ""), id.Replace("_", ""), StringComparison.OrdinalIgnoreCase)).Value;
        if (found == null)
        {
            return new JsonObject { ["loc"] = location, ["none"] = true }.ToJsonString();
        }

        var named = new HashSet<string>(StringComparer.Ordinal);
        var loose = new JsonArray();
        // an item searched for even when it's unlikely at a point: a key, a valuable, an intel item, or worth a lot
        var rare = new Dictionary<string, bool>(StringComparer.Ordinal);
        bool Rare(string tpl)
        {
            if (!rare.TryGetValue(tpl, out var yes))
            {
                var entry = NameOf(tpl);
                var kind = entry["g"]?.GetValue<string>();
                yes = kind is "keys" or "valuables" or "info" or "special" || (entry["p"]?.GetValue<double>() ?? 0) >= RareWorth;
                rare[tpl] = yes;
            }

            return yes;
        }
        // the items of the game's events that aren't on now (Halloween's pumpkins in November): SPT takes them out of a
        // point before it spawns anything there, and a point left with nothing spawns nothing
        var offSeason = InactiveEventItems();
        var looseLoot = found.LooseLoot?.Value;
        // each point drawn as it is, its number (a weight, 1: always), whether it's forced, its id and its place, to work
        // its chance out after (the server goes by both: see below)
        var drawn = new List<(JsonArray Entry, double Weight, bool Forced, string Id, string Place)>();
        if (looseLoot != null)
        {
            // forced: the map's forced points, and the points marked to spawn always (the server takes both out of the draw)
            var points = (looseLoot.Spawnpoints ?? []).Select(s => (s.Template, s.ItemDistribution, Chance: s.Probability ?? 0d,
                    Forced: s.Template?.IsAlwaysSpawn == true, s.LocationId))
                .Concat((looseLoot.SpawnpointsForced ?? []).Select(s => (s.Template, s.ItemDistribution, Chance: s.Probability ?? 1d, Forced: true, s.LocationId)));
            foreach (var (template, distribution, chance, isForced, place) in points)
            {
                if (template?.Position == null || template.Items == null)
                {
                    continue;
                }

                // each item the point can spawn is one of its template's items, by its id; the distribution weighs them
                var tplOf = new Dictionary<string, string>(StringComparer.Ordinal);
                foreach (var item in template.Items)
                {
                    // (the distribution names each item by its "composedKey"; older tables by its id)
                    tplOf[item.Id.ToString()] = item.Template.ToString();
                    if (!string.IsNullOrEmpty(item.ComposedKey))
                    {
                        tplOf[item.ComposedKey] = item.Template.ToString();
                    }
                }

                var shares = new Dictionary<string, double>(StringComparer.Ordinal);
                var weights = (distribution ?? []).Select(d => (Key: d.ComposedKey?.Key ?? "", Weight: Convert.ToDouble(d.RelativeProbability)))
                    .Where(d => d.Weight > 0 && tplOf.ContainsKey(d.Key)).ToList();
                var total = weights.Sum(d => d.Weight);
                foreach (var (key, weight) in weights)
                {
                    var tpl = tplOf[key];
                    shares[tpl] = shares.GetValueOrDefault(tpl) + weight / total;
                }

                // a point with no distribution (one that always spawns its one thing): its root item
                if (shares.Count == 0)
                {
                    var root = template.Items.FirstOrDefault(i => i.ParentId == null || i.ParentId.ToString() == "");
                    if (root == null)
                    {
                        continue;
                    }

                    shares[root.Template.ToString()] = 1;
                }

                // an event's items out of season: gone from the point, the rest weighed among themselves
                if (offSeason.Count > 0 && shares.Keys.Any(offSeason.Contains))
                {
                    var inSeason = shares.Where(s => !offSeason.Contains(s.Key)).ToList();
                    var sum = inSeason.Sum(s => s.Value);
                    if (sum <= 0)
                    {
                        // nothing left to spawn here: still drawn by the server, so it's counted below, but not shown
                        drawn.Add((new JsonArray(0, 0, 0, 0.0, new JsonArray()), Math.Max(0, chance), isForced, template.Id ?? "", place ?? template.Id ?? ""));
                        continue;
                    }

                    shares = inSeason.ToDictionary(s => s.Key, s => s.Value / sum, StringComparer.Ordinal);
                }

                var list = new JsonArray();
                // the likeliest, and every rare one however unlikely (so a search finds a key where it can be)
                var ranked = shares.OrderByDescending(s => s.Value).ToList();
                foreach (var (tpl, share) in ranked.Take(MostAtPoint).Concat(ranked.Skip(MostAtPoint).Where(s => Rare(s.Key))))
                {
                    named.Add(tpl);
                    list.Add(new JsonArray(tpl, Math.Round(share, 4)));
                }

                var at = template.Position.Value;
                var entry = new JsonArray(Math.Round(Convert.ToDouble(at.X), 2), Math.Round(Convert.ToDouble(at.Z), 2),
                    Math.Round(Convert.ToDouble(at.Y), 2), 0.0, list);
                loose.Add(entry);
                drawn.Add((entry, Math.Max(0, chance), isForced, template.Id ?? "", place ?? template.Id ?? ""));
            }

            // How the server fills a raid: so many points (its count, times the map's loose loot multiplier), the ones
            // at 1 first, the rest drawn by their numbers without one twice. A point's chance of being among them, drawn
            // so: 1 - e^(-weight x t), with t such that the chances add up to the points drawn.
            var multiplier = LooseMultiplier(id);

            var wanted = multiplier * Convert.ToDouble(looseLoot.SpawnpointCount?.Mean ?? 0);
            var sure = drawn.Count(d => !d.Forced && d.Weight >= 1);
            var others = drawn.Where(d => !d.Forced && d.Weight < 1 && d.Weight > 0).ToList();
            var left = wanted - sure;
            double t = 0;
            if (left >= others.Count)
            {
                t = double.PositiveInfinity;
            }
            else if (left > 0)
            {
                double low = 0, high = 1;
                while (others.Sum(d => 1 - Math.Exp(-d.Weight * high)) < left && high < 1e9)
                {
                    high *= 2;
                }

                for (var i = 0; i < 60; i++)
                {
                    var mid = (low + high) / 2;
                    if (others.Sum(d => 1 - Math.Exp(-d.Weight * mid)) < left) low = mid;
                    else high = mid;
                }

                t = (low + high) / 2;
            }

            foreach (var (entry, weight, forced, _, _) in drawn)
            {
                entry[3] = forced || weight >= 1 ? 1 : 0;
            }

            // The drawn ones. The server draws by a point's id and takes the first point with that id: a later point with
            // the same id never spawns, and the first is drawn by all their numbers together (as Manimal's Labs Boiler
            // has two LEDX points under one id). Then it keeps one point a place: those at one place share its chance,
            // by their numbers.
            var byId = new Dictionary<string, double>(StringComparer.Ordinal);
            var firsts = new List<(JsonArray Entry, string Id, string Place)>();
            foreach (var d in others)
            {
                if (!byId.ContainsKey(d.Id))
                {
                    byId[d.Id] = 0;
                    firsts.Add((d.Entry, d.Id, d.Place));
                }

                byId[d.Id] += d.Weight;
            }

            foreach (var place in firsts.GroupBy(f => f.Place, StringComparer.Ordinal))
            {
                var total = place.Sum(f => byId[f.Id]);
                var there = double.IsPositiveInfinity(t) ? 1 : 1 - Math.Exp(-total * t);
                foreach (var f in place)
                {
                    f.Entry[3] = Math.Round(there * byId[f.Id] / total, 4);
                }
            }

            // Forced ones the server places once for each id: a quest item listed at several places is put at one of
            // them, drawn by their numbers
            foreach (var group in drawn.Where(d => d.Forced).GroupBy(d => d.Id, StringComparer.Ordinal))
            {
                var list = group.ToList();
                if (list.Count < 2)
                {
                    continue;
                }

                var sum = list.Sum(d => d.Weight);
                foreach (var d in list)
                {
                    d.Entry[3] = Math.Round(sum > 0 ? d.Weight / sum : 1.0 / list.Count, 4);
                }
            }
        }

        // each kind of container: how many things go in one, and of what; so how likely each is to be in it at all
        var boxes = new JsonObject();
        var staticLoot = found.StaticLoot?.Value;
        if (staticLoot != null)
        {
            foreach (var (container, details) in staticLoot)
            {
                var counts = (details.ItemCountDistribution ?? []).Select(c => (Count: Convert.ToDouble(c.Count), Weight: Convert.ToDouble(c.RelativeProbability)))
                    .Where(c => c.Weight > 0).ToList();
                var countTotal = counts.Sum(c => c.Weight);
                var items = (details.ItemDistribution ?? []).Select(i => (Tpl: i.Tpl.ToString(), Weight: Convert.ToDouble(i.RelativeProbability)))
                    .Where(i => i.Weight > 0 && !offSeason.Contains(i.Tpl)).ToList();
                var itemTotal = items.Sum(i => i.Weight);
                if (countTotal <= 0 || itemTotal <= 0)
                {
                    continue;
                }

                var list = new JsonArray();
                foreach (var (tpl, weight) in items.GroupBy(i => i.Tpl).Select(g => (g.Key, g.Sum(i => i.Weight)))
                             .OrderByDescending(i => i.Item2).Take(MostInBox))
                {
                    // at least one of it among the draws, over how many draws there are
                    var share = weight / itemTotal;
                    var atLeastOne = counts.Sum(c => c.Weight / countTotal * (1 - Math.Pow(1 - share, c.Count)));
                    named.Add(tpl);
                    list.Add(new JsonArray(tpl, Math.Round(atLeastOne, 4)));
                }

                boxes[container.ToString()] = list;
            }
        }

        var boxChance = new JsonObject();
        var containers = found.StaticContainers?.Value;
        foreach (var container in containers?.StaticContainers ?? [])
        {
            var boxId = container.Template?.Id;
            if (!string.IsNullOrEmpty(boxId))
            {
                boxChance[boxId] = Math.Round(Math.Clamp(Convert.ToDouble(container.Probability), 0, 1), 3);
            }
        }

        return new JsonObject
        {
            ["loc"] = location, ["loose"] = loose, ["boxes"] = boxes, ["boxChance"] = boxChance, ["names"] = Names(named)
        }.ToJsonString();
    }

    // The map's loose loot multiplier (configs/location.json, "looseLootMultiplier"): the server's own copy when it
    // hands it out, else the file; 1 when neither has one
    private double LooseMultiplier(string id)
    {
        try
        {
            if (services.GetService(typeof(SPTarkov.Server.Core.Models.Spt.Config.LocationConfig)) is SPTarkov.Server.Core.Models.Spt.Config.LocationConfig config)
            {
                foreach (var (name, times) in config.LooseLootMultiplier)
                {
                    if (string.Equals(name, id, StringComparison.OrdinalIgnoreCase))
                    {
                        return Convert.ToDouble(times);
                    }
                }
            }

            var file = Path.Combine(AppContext.BaseDirectory, "SPT_Data", "configs", "location.json");
            if (!File.Exists(file))
            {
                file = Path.Combine(Directory.GetCurrentDirectory(), "SPT_Data", "configs", "location.json");
            }

            if (File.Exists(file) && JsonNode.Parse(File.ReadAllText(file))?["looseLootMultiplier"] is JsonObject list)
            {
                foreach (var (name, times) in list)
                {
                    if (string.Equals(name, id, StringComparison.OrdinalIgnoreCase) && times != null)
                    {
                        return times.GetValue<double>();
                    }
                }
            }
        }
        catch (Exception ex)
        {
            logger.Warning($"[Satellite] Couldn't read the loose loot multiplier of {id}: {ex.Message}");
        }

        return 1;
    }

    // Who can spawn at a location's boss spawn zones, from the location's own boss waves (as a mod left them):
    // [[role, chance 0..1, [zone, ..]], ..], one entry per role and zone list, the likeliest kept. The page names the
    // roles it knows and lists, at a boss spawn point, those whose zones take it in.
    private JsonArray Bosses(string location)
    {
        var bosses = new JsonArray();
        try
        {
            var id = location.Split('~')[0];
            var found = locationTable.GetDictionary().FirstOrDefault(pair => string.Equals(pair.Key, id, StringComparison.OrdinalIgnoreCase)
                || string.Equals(pair.Key.Replace("_", ""), id.Replace("_", ""), StringComparison.OrdinalIgnoreCase)).Value;
            var best = new Dictionary<string, (string Role, double Chance, string[] Zones)>(StringComparer.Ordinal);
            foreach (var wave in found?.Base?.BossLocationSpawn ?? [])
            {
                var chance = (wave.BossChance ?? 0) / 100;
                if (string.IsNullOrEmpty(wave.BossName) || string.IsNullOrEmpty(wave.BossZone) || chance <= 0)
                {
                    continue;
                }

                var zones = wave.BossZone.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                var key = wave.BossName + "|" + string.Join(",", zones);
                if (!best.TryGetValue(key, out var had) || had.Chance < chance)
                {
                    best[key] = (wave.BossName, Math.Min(1, chance), zones);
                }
            }

            foreach (var (role, chance, zones) in best.Values)
            {
                bosses.Add(new JsonArray(role, Math.Round(chance, 3), new JsonArray(zones.Select(z => (JsonNode?)z).ToArray())));
            }
        }
        catch (Exception ex)
        {
            logger.Warning($"[Satellite] Couldn't read the boss waves of {location}: {ex.Message}");
        }

        return bosses;
    }
}
