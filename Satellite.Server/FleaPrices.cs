using System.Collections.Concurrent;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Satellite.Server;

// What items are worth, as Better Flea prices them when it's on this server (its API, Docs/09-api.md: the same price a
// player's listing is measured against, with drift, the Wipe Cycle and the rest), else as SPT's own flea table has it.
// Asked of Better Flea's own route on this server, 250 kinds of item at a time, away from the request that wanted
// them: until the answer comes, SPT's price stands in. Each kind is priced as one fresh item. Asked again every ten
// minutes, since Better Flea's prices drift.
public partial class LiveMapRoute
{
    private const string FleaBatchRoute = "/betterflea/item-prices";
    private const string FleaOneRoute = "/betterflea/item-price";
    private static readonly TimeSpan FleaAgain = TimeSpan.FromMinutes(10);

    // 0: not looked yet, 1: looking, 2: there (batches), 3: there (one at a time, an older Better Flea), 4: not there
    private int _flea;
    private readonly ConcurrentDictionary<string, double> _fleaPrices = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, byte> _fleaWanted = new(StringComparer.Ordinal);
    private DateTime _fleaAsked = DateTime.MinValue;
    private int _fleaBusy;

    // goes up whenever new prices come in, so what was made with the old ones is made again
    private int _fleaVersion;

    // marks the map's own questions to Better Flea, so SPT's request log leaves them out (QuietRequests)
    public const string QuietHeader = "X-Satellite";

    private static readonly HttpClient Flea = MakeFlea();

    private static HttpClient MakeFlea()
    {
        var client = new HttpClient(new HttpClientHandler
        {
            // this server's own certificate, which is SPT's self-signed one: only ever this server is asked
            ServerCertificateCustomValidationCallback = (_, _, _, _) => true
        })
        {
            Timeout = TimeSpan.FromSeconds(20)
        };
        client.DefaultRequestHeaders.Add(QuietHeader, "1");
        return client;
    }

    // Every item priced at once, the first time anything asks this server for the map (the game connecting, or a
    // page): so the prices are there before a page wants loot or spawn points.
    private int _fleaWarmed;

    private void FleaWarm()
    {
        if (Interlocked.Exchange(ref _fleaWarmed, 1) != 0)
        {
            return;
        }

        try
        {
            foreach (var (id, item) in templates.Items)
            {
                if (item.Type == "Item")
                {
                    _fleaWanted.TryAdd(id.ToString(), 0);
                }
            }
        }
        catch (Exception)
        {
            // priced as they're asked for, then
        }

        _fleaAsked = DateTime.UtcNow;
        FleaAsk();
    }

    // this server, as it can be reached from itself
    private static string FleaHost()
    {
        var ip = Lan.Ip is "0.0.0.0" or "::" or "*" or "+" or "" ? "127.0.0.1" : Lan.Ip;
        return $"https://{(ip.Contains(':') ? "[" + ip + "]" : ip)}:{Lan.Port}";
    }

    // Better Flea's price for a kind of item, when it's been asked for; null: SPT's stands. Asks for it when it's not
    // known yet (or old).
    private double? FleaPrice(string tpl)
    {
        if (_flea == 4)
        {
            return null;
        }

        if (!_fleaPrices.TryGetValue(tpl, out var price) || DateTime.UtcNow - _fleaAsked > FleaAgain)
        {
            _fleaWanted.TryAdd(tpl, 0);
            FleaAsk();
        }

        return price > 0 ? price : null;
    }

    private void FleaAsk()
    {
        if (Interlocked.CompareExchange(ref _fleaBusy, 1, 0) != 0)
        {
            return;
        }

        _ = Task.Run(async () =>
        {
            try
            {
                if (_flea == 0)
                {
                    _flea = 1;
                    _flea = await FleaLook();
                    logger.Info(_flea == 4
                        ? "[Satellite] No Better Flea on this server: items are worth what SPT's flea prices say."
                        : "[Satellite] Better Flea found: items are worth what it prices them at.");
                }

                if (_flea == 4)
                {
                    _fleaWanted.Clear();
                    return;
                }

                // everything known is asked again once it's old
                if (DateTime.UtcNow - _fleaAsked > FleaAgain)
                {
                    foreach (var tpl in _fleaPrices.Keys)
                    {
                        _fleaWanted.TryAdd(tpl, 0);
                    }

                    _fleaAsked = DateTime.UtcNow;
                }

                var changed = false;
                while (!_fleaWanted.IsEmpty)
                {
                    var batch = _fleaWanted.Keys.Take(_flea == 2 ? 250 : 20).ToList();
                    foreach (var tpl in batch)
                    {
                        _fleaWanted.TryRemove(tpl, out _);
                    }

                    var prices = _flea == 2 ? await FleaBatch(batch) : await FleaOneByOne(batch);
                    for (var i = 0; i < batch.Count && i < prices.Count; i++)
                    {
                        if (!_fleaPrices.TryGetValue(batch[i], out var was) || Math.Abs(was - prices[i]) >= 1)
                        {
                            changed = true;
                        }

                        _fleaPrices[batch[i]] = prices[i];
                    }
                }

                if (changed)
                {
                    Interlocked.Increment(ref _fleaVersion);
                }
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException or InvalidOperationException)
            {
                // SPT's prices stand; asked again the next time
                _fleaWanted.Clear();
                logger.Warning($"[Satellite] Couldn't get Better Flea's prices, so SPT's are used for now: {ex.Message}");
            }
            finally
            {
                Interlocked.Exchange(ref _fleaBusy, 0);
            }
        });
    }

    // is Better Flea there, and new enough to price many at a time? [] to the one-item route answers {"Price":0}
    private async Task<int> FleaLook()
    {
        try
        {
            using var one = await Flea.PostAsync(FleaHost() + FleaOneRoute, Json("[]"));
            if (!one.IsSuccessStatusCode || JsonNode.Parse(await one.Content.ReadAsStringAsync())?["Price"] is null)
            {
                return 4;
            }

            using var many = await Flea.PostAsync(FleaHost() + FleaBatchRoute, Json("[]"));
            return many.IsSuccessStatusCode ? 2 : 3;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            return 4;
        }
    }

    private static StringContent Json(string text) => new(text, Encoding.UTF8, "application/json");

    // one fresh item of each kind: [{"_id": a new id, "_tpl": the kind}]
    private static JsonArray FreshItem(string tpl) =>
        [new JsonObject { ["_id"] = Guid.NewGuid().ToString("N")[..24], ["_tpl"] = tpl }];

    private static async Task<List<double>> FleaBatch(List<string> tpls)
    {
        var body = new JsonArray(tpls.Select(t => (JsonNode)FreshItem(t)).ToArray());
        using var answer = await Flea.PostAsync(FleaHost() + FleaBatchRoute, Json(body.ToJsonString()));
        answer.EnsureSuccessStatusCode();
        var prices = JsonNode.Parse(await answer.Content.ReadAsStringAsync())?["Prices"] as JsonArray ?? [];
        return prices.Select(p => p is JsonValue v && v.TryGetValue<double>(out var d) ? d : 0).ToList();
    }

    private static async Task<List<double>> FleaOneByOne(List<string> tpls)
    {
        var prices = new List<double>();
        foreach (var tpl in tpls)
        {
            using var answer = await Flea.PostAsync(FleaHost() + FleaOneRoute, Json(FreshItem(tpl).ToJsonString()));
            answer.EnsureSuccessStatusCode();
            prices.Add(JsonNode.Parse(await answer.Content.ReadAsStringAsync())?["Price"] is JsonValue v && v.TryGetValue<double>(out var d) ? d : 0);
        }

        return prices;
    }
}
