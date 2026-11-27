using SPTarkov.Server.Core.Models.Common;
using SPTarkov.Server.Core.Models.Eft.Common.Tables;
using SPTarkov.Server.Core.Models.Spt.Tables;

namespace Satellite.Server;

// "Most it sells for" (Loot > Filters > Prices, the default): what an item is worth to the player whose game it
// is, as Price Index's "Most" has it. The flea's price while they can sell it there and it pays more than any trader;
// the best trader's otherwise: below the flea's unlock level (the game's ragfair minUserLevel), and for an item the
// game won't let onto the flea. A trader counts when the player has it unlocked and it buys that kind of item; it
// pays the handbook price less its buy coefficient at the player's loyalty level with it (Fence too, as in the game).
public partial class LiveMapRoute
{
    // what a player can sell to, as of their profile: whether the flea's open to them, and each trader's coefficient
    private sealed record Seller(bool Flea, (TraderBase Trader, double Coefficient)[] Traders, string Print);

    // each session's last Seller print: when one changes (a level up past the flea's, a trader unlocked or a loyalty
    // level gained), what was priced the old way is made again
    private readonly Dictionary<string, string> _sellerPrints = new(StringComparer.Ordinal);

    // (under _namesLock)
    private Seller SellerOf(string? sid)
    {
        var who = sid ?? Pick(null)?.Id;
        var pmc = who != null ? ProfileOf(who) : null;
        var fleaFrom = (services.GetService(typeof(GlobalTable)) as GlobalTable)?.Configuration?.RagFair?.MinUserLevel ?? 15;
        var flea = pmc?.Info?.Level is { } level ? level >= fleaFrom : true;
        var traders = new List<(TraderBase, double)>();
        if (services.GetService(typeof(TradersTable)) is TradersTable table)
        {
            foreach (var (id, trader) in table)
            {
                if (trader?.Base is not { ItemsBuy: not null, LoyaltyLevels: { Count: > 0 } levels } trade)
                {
                    continue;
                }

                // a profile not known: the traders every new one has
                var info = pmc?.TradersInfo?.GetValueOrDefault(id);
                if (pmc != null ? info is not { Unlocked: true } || info.Disabled == true : trade.UnlockedByDefault != true)
                {
                    continue;
                }

                var at = Math.Clamp((info?.LoyaltyLevel ?? 1) - 1, 0, levels.Count - 1);
                traders.Add((trade, levels[at].BuyPriceCoefficient ?? 100));
            }
        }

        var print = (flea ? "f" : "-") + string.Concat(traders.Select(t => "|" + t.Item1.Id + ":" + t.Item2));
        if (who != null && (!_sellerPrints.TryGetValue(who, out var was) || was != print))
        {
            if (was != null)
            {
                Interlocked.Increment(ref _fleaVersion);
            }

            _sellerPrints[who] = print;
        }

        return new Seller(flea, traders.ToArray(), print);
    }

    // the most a trader the player can sell to pays for a kind of item, in roubles (0: none of them buys it)
    private double TraderPrice(string tpl, Seller seller)
    {
        if (!MongoId.IsValidMongoId(tpl))
        {
            return 0;
        }

        _handbook ??= (templates.Handbook?.Items ?? []).GroupBy(i => i.Id.ToString()).ToDictionary(g => g.Key, g => g.First().Price ?? 0);
        var handbook = _handbook.GetValueOrDefault(tpl);
        if (handbook <= 0)
        {
            return 0;
        }

        // the item and the kinds it's of, up to the root
        var kinds = new List<MongoId>();
        var at = new MongoId(tpl);
        for (var i = 0; i < 16 && templates.Items.TryGetValue(at, out var item); i++)
        {
            kinds.Add(at);
            var parent = item.Parent;
            if (!MongoId.IsValidMongoId(parent.ToString()) || parent == at)
            {
                break;
            }

            at = parent;
        }

        double best = 0;
        foreach (var (trader, coefficient) in seller.Traders)
        {
            if (!Buys(trader.ItemsBuy, kinds) || Buys(trader.ItemsBuyProhibited, kinds))
            {
                continue;
            }

            best = Math.Max(best, handbook * (100 - coefficient) / 100);
        }

        return best;
    }

    private static bool Buys(ItemBuyData? list, List<MongoId> kinds) =>
        list != null && kinds.Count > 0 && (list.IdList?.Contains(kinds[0]) == true || kinds.Any(k => list.Category?.Contains(k) == true));

    // whether the game lets a kind of item onto the flea
    private bool FleaSells(string tpl) =>
        MongoId.IsValidMongoId(tpl) && templates.Items.TryGetValue(new MongoId(tpl), out var item) && item.Properties?.CanSellOnRagfair == true;
}
