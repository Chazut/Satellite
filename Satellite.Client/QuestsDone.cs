using System;
using System.Text;
using Comfort.Common;
using EFT;
using EFT.Quests;

namespace Satellite.Client
{
    // The goals of the player's started quests (and ones ready to hand in) that are done, as their own game has them: ",\"qd\":[goal id,..]" in a
    // full report. A goal done in a raid is known to the game at once but to the server's profile only once the raid
    // is over, so the server takes these too and the page drops the goal's markers straight away (see QuestsFor).
    internal static class QuestsDone
    {
        private static readonly StringBuilder List = new StringBuilder(1024);

        internal static void Take(StringBuilder to)
        {
            List.Length = 0;
            try
            {
                var quests = Singleton<GameWorld>.Instance?.MainPlayer?.Profile?.QuestsData;
                if (quests == null)
                {
                    return;
                }

                foreach (var quest in quests)
                {
                    // (a quest whose last goal is done in the raid is ready to hand in at once, while the server's profile
                    // has it started until the raid is over: its goals are said done too, or they'd all come back)
                    if (quest == null || (quest.Status != EQuestStatus.Started && quest.Status != EQuestStatus.AvailableForFinish)
                        || quest.CompletedConditions == null)
                    {
                        continue;
                    }

                    foreach (var id in quest.CompletedConditions)
                    {
                        List.Append(List.Length == 0 ? "" : ",");
                        World.Text(List, id.ToString());
                    }
                }
            }
            catch (Exception)
            {
                // none said this time; a half-made list is never sent
                return;
            }

            to.Append(",\"qd\":[").Append(List).Append(']');
        }
    }

    // The keys the player has with them in the raid (worn, carried, in the secure container): ",\"kh\":[template,..]"
    // in a full report, so a lock whose key they picked up shows as theirs before the raid is over. Looked through a
    // few seconds apart, not for every report.
    internal static class KeysCarried
    {
        private const float Gap = 3f;
        private static float _lookedAt = -100f;
        private static string _list;
        private static readonly StringBuilder Made = new StringBuilder(512);
        private static readonly System.Collections.Generic.HashSet<string> Seen = new System.Collections.Generic.HashSet<string>();

        internal static void Forget()
        {
            _lookedAt = -100f;
            _list = null;
        }

        internal static void Take(StringBuilder to)
        {
            var now = UnityEngine.Time.unscaledTime;
            if (now - _lookedAt >= Gap)
            {
                _lookedAt = now;
                _list = Look();
            }

            if (_list != null)
            {
                to.Append(",\"kh\":[").Append(_list).Append(']');
            }
        }

        private static string Look()
        {
            try
            {
                var worn = Singleton<GameWorld>.Instance?.MainPlayer?.Inventory?.Equipment;
                if (worn == null)
                {
                    return null;
                }

                Made.Length = 0;
                Seen.Clear();
                Walk(worn, 0);
                return Made.ToString();
            }
            catch (Exception)
            {
                return null;
            }
        }

        // everything in what's worn, slots and grids (a key tool, the secure container, a bag in a bag)
        private static void Walk(EFT.InventoryLogic.CompoundItem holder, int depth)
        {
            if (holder == null || depth > 6)
            {
                return;
            }

            if (holder.Slots != null)
            {
                foreach (var slot in holder.Slots)
                {
                    One(slot != null ? slot.ContainedItem : null, depth);
                }
            }

            if (holder.Grids != null)
            {
                foreach (var grid in holder.Grids)
                {
                    foreach (var item in grid.Items)
                    {
                        One(item, depth);
                    }
                }
            }
        }

        private static void One(EFT.InventoryLogic.Item item, int depth)
        {
            if (item == null)
            {
                return;
            }

            if (item.GetItemComponent<EFT.InventoryLogic.KeyComponent>() != null && Seen.Add(item.TemplateId.ToString()))
            {
                Made.Append(Made.Length == 0 ? "" : ",");
                World.Text(Made, item.TemplateId.ToString());
            }

            if (item is EFT.InventoryLogic.CompoundItem inside)
            {
                Walk(inside, depth + 1);
            }
        }
    }
}
