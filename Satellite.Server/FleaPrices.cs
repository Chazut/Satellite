using System.Collections.Concurrent;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using SPTarkov.Server.Core.Models.Common;
using SPTarkov.Server.Core.Servers.Http;

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

    // Handbook prices only, for a game played without the flea market: every item is worth what the handbook says,
    // whatever the flea (SPT's or Better Flea's) has. Set from the page (Loot > Filters > Prices), for every page on
    // this server, and kept as the file "handbook-prices" in Satellite's folder, so a restart keeps it.
    private string HandbookFile => Path.Combine(Folder, "handbook-prices");
    private bool? _handbookOnly;
    private bool HandbookOnly() => _handbookOnly ??= File.Exists(HandbookFile);

    // GET api/prices: {"handbook"}; POST ?handbook=1 prices by the handbook from now on, ?handbook=0 by the flea again
    private string Pricing(HttpContext context, bool post)
    {
        if (post)
        {
            var handbook = context.Request.Query["handbook"] == "1";
            try
            {
                if (handbook)
                {
                    File.WriteAllText(HandbookFile, "");
                }
                else if (File.Exists(HandbookFile))
                {
                    File.Delete(HandbookFile);
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                logger.Warning($"[Satellite] Couldn't keep the price setting (only until the server restarts): {ex.Message}");
            }

            _handbookOnly = handbook;
            // what was priced the other way is made again
            Interlocked.Increment(ref _fleaVersion);
        }

        return new JsonObject { ["handbook"] = HandbookOnly() }.ToJsonString();
    }

    private static readonly HttpClient Flea = new(new HttpClientHandler
    {
        // this server's own certificate, which is SPT's self-signed one: only ever this server is asked
        ServerCertificateCustomValidationCallback = (_, _, _, _) => true
    })
    {
        Timeout = TimeSpan.FromSeconds(20)
    };

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
            var one = await FleaPost(FleaOneRoute, "[]");
            if (!one.Ok || JsonNode.Parse(one.Text)?["Price"] is null)
            {
                return 4;
            }

            return (await FleaPost(FleaBatchRoute, "[]")).Ok ? 2 : 3;
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

    private async Task<List<double>> FleaBatch(List<string> tpls)
    {
        var body = new JsonArray(tpls.Select(t => (JsonNode)FreshItem(t)).ToArray());
        var answer = await FleaPost(FleaBatchRoute, body.ToJsonString());
        if (!answer.Ok)
        {
            throw new HttpRequestException("Better Flea didn't price them");
        }

        var prices = JsonNode.Parse(answer.Text)?["Prices"] as JsonArray ?? [];
        return prices.Select(p => p is JsonValue v && v.TryGetValue<double>(out var d) ? d : 0).ToList();
    }

    private async Task<List<double>> FleaOneByOne(List<string> tpls)
    {
        var prices = new List<double>();
        foreach (var tpl in tpls)
        {
            var answer = await FleaPost(FleaOneRoute, FreshItem(tpl).ToJsonString());
            if (!answer.Ok)
            {
                throw new HttpRequestException("Better Flea didn't price it");
            }

            prices.Add(JsonNode.Parse(answer.Text)?["Price"] is JsonValue v && v.TryGetValue<double>(out var d) ? d : 0);
        }

        return prices;
    }

    // Better Flea's route asked here in the server, handed the question as SPT itself hands it a request: nothing
    // goes over the network, so SPT has no request line to write (every ten minutes, a few dozen of them). Over HTTP
    // to this server only when that can't be done. Better Flea is asked as any caller asks it; nothing of it changes.
    // Its route is looked for once (as SPT looks: the first listener that takes the address) and kept.
    private readonly ConcurrentDictionary<string, IHttpListener?> _fleaListeners = new(StringComparer.Ordinal);

    private static DefaultHttpContext FleaContext(string route, byte[] bytes)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Post;
        context.Request.Path = route;
        context.Request.ContentType = "application/json";
        context.Request.Body = new MemoryStream(bytes);
        context.Request.ContentLength = bytes.Length;
        return context;
    }

    private async Task<(bool Ok, string Text)> FleaPost(string route, string body)
    {
        try
        {
            var bytes = Encoding.UTF8.GetBytes(body);
            var context = FleaContext(route, bytes);
            var listener = _fleaListeners.GetOrAdd(route, _ =>
                (services.GetService(typeof(IEnumerable<IHttpListener>)) as IEnumerable<IHttpListener>)
                ?.FirstOrDefault(l => l is not LiveMapRoute && l.CanHandle(FleaContext(route, []))));
            if (listener == null)
            {
                // no such route on this server: no Better Flea (or one too old)
                return (false, "");
            }

            using var output = new MemoryStream();
            context.Response.Body = output;
            await listener.HandleAsync(MongoId.Empty(), context, CancellationToken.None);
            return (context.Response.StatusCode is >= 200 and < 300, Encoding.UTF8.GetString(output.ToArray()));
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            // asked over HTTP instead
        }

        using var answer = await Flea.PostAsync(FleaHost() + route, Json(body));
        return (answer.IsSuccessStatusCode, await answer.Content.ReadAsStringAsync());
    }
}
