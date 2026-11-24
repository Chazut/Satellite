using System;
using System.Collections;
using System.Collections.Generic;
using System.Text;
using Comfort.Common;
using EFT;
using EFT.Interactive;
using EFT.InventoryLogic;
using Satellite.Shared;
using UnityEngine;

namespace Satellite.Client
{
    // What lies about in this raid: the loose items, what's in each container (and on each body), and which doors
    // are open. Only while a page is looking, every few seconds, and only sent when something changed. Items go by
    // their template id; the server adds names and prices. (Where the containers and doors stand comes with the map:
    // the map scanner sends it, into places.json.) Places are [east, north, height] in metres, the game's x, z and y.
    internal static class Things
    {
        internal const string LootRoute = "/satellite/api/things";
        private const string MoreRoute = "/satellite/api/more";
        private const float MoreAgain = 30f;
        private const int MoreTries = 3;

        // the scene is all there by then
        private const float Settle = 12f;
        private const float LootGap = 4f;

        private static GameWorld _world;
        private static float _startedAt = -1f;
        private static bool _looked;
        private static bool _looking;
        private static readonly List<LootableContainer> Boxes = new List<LootableContainer>();
        private static readonly List<WorldInteractiveObject> Locked = new List<WorldInteractiveObject>();
        private static float _nextLoot;
        private static int _lootPrint;
        private static volatile bool _sending;
        // the loot report, written and sent from buffers that are kept: see Outbox
        private static readonly StringBuilder Report = new StringBuilder(256 * 1024);
        private static readonly Outbox Out = new Outbox();
        // the loot that's a mounted gun (asked of each piece of loot once, not every time)
        private static readonly Dictionary<int, bool> Mounted = new Dictionary<int, bool>();
        // Where this raid's containers and quest places stand, sent once a raid (see LookAround): the map scanner's
        // places.json has only what was there when it scanned, so a cache that spawns by chance, or a quest place a
        // mod adds, isn't in it. Null once sent.
        private static byte[] _more;
        private static volatile bool _moreSending;
        private static float _moreNext;
        private static volatile int _moreTries;
        // what looking at the loot costs the game, for the plugin's line in the log
        internal static double Spent, Worst;
        internal static int Looks;
        private static readonly System.Diagnostics.Stopwatch Clock = new System.Diagnostics.Stopwatch();

        // what the server's config.jsonc keeps off the page: "loose", "contents", "locks", "spawns", "carried"
        private static volatile HashSet<string> _off = new HashSet<string>();

        internal static void ServerOff(HashSet<string> off)
        {
            _off = off ?? new HashSet<string>();
        }

        private static bool On(string layer)
        {
            return !_off.Contains(layer);
        }

        // Called every frame from the plugin. watched: a page is open. Never in the game's way: if it fails, it says so
        // once and rests until the next raid.
        internal static void Tick(Plugin plugin, bool watched)
        {
            try
            {
                Look(plugin, watched);
            }
            catch (Exception e)
            {
                if (_broken != _world)
                {
                    Plugin.Log.LogError($"Couldn't read the loot and places: {e}");
                }

                _broken = _world;
                _sending = false;
            }
        }

        private static GameWorld _broken;

        private static void Look(Plugin plugin, bool watched)
        {
            var world = Singleton<GameWorld>.Instance;
            if (world != null && world == _broken)
            {
                return;
            }

            if (!World.InRaid() || world == null)
            {
                _world = null;
                return;
            }

            if (world != _world)
            {
                _world = world;
                _startedAt = -1f;
                _looked = false;
                _looking = false;
                _lootPrint = 0;
                Boxes.Clear();
                Locked.Clear();
                Mounted.Clear();
                _more = null;
                _moreNext = 0f;
                _moreTries = 0;
            }

            // nothing is sent until the server has said which map (which version of the location) this is, so the
            // places of one version never land on another's
            if (!World.Started() || !Variant.Resolved)
            {
                return;
            }

            if (_startedAt < 0f)
            {
                _startedAt = Time.unscaledTime;
            }

            // (only once a page is open: searching the scene is a hitch on a big location, and a raid nobody watches
            // is to cost nothing)
            if (watched && !_looked && !_looking && Time.unscaledTime - _startedAt > Settle)
            {
                _looking = true;
                plugin.StartCoroutine(LookAround(world));
            }

            if (_more != null && !_moreSending && Time.unscaledTime >= _moreNext)
            {
                SendMore(plugin);
            }

            if (_looked && watched && !_sending && Time.unscaledTime >= _nextLoot)
            {
                _nextLoot = Time.unscaledTime + LootGap;
                Clock.Restart();
                SendLoot(plugin, world);
                var ms = Clock.Elapsed.TotalMilliseconds;
                Spent += ms;
                Worst = Math.Max(Worst, ms);
                Looks++;
            }
        }

        // ---- the containers and locks ---------------------------------------------------------------------------

        // The containers and the things a key opens, found once a raid: what's in the one and whether the other is still
        // locked is what the loot report says. (Where each stands comes with the map, from the map scanner.)
        private static IEnumerator LookAround(GameWorld world)
        {
            foreach (var box in UnityEngine.Object.FindObjectsOfType<LootableContainer>())
            {
                if (box != null && !string.IsNullOrEmpty(box.Id))
                {
                    Boxes.Add(box);
                }
            }

            yield return null;
            if (Singleton<GameWorld>.Instance != world)
            {
                yield break;
            }

            foreach (var thing in UnityEngine.Object.FindObjectsOfType<WorldInteractiveObject>())
            {
                if (thing != null && !string.IsNullOrEmpty(thing.KeyId) && !(thing is LootableContainer))
                {
                    Locked.Add(thing);
                }
            }

            _looked = true;
            _looking = false;

            yield return null;
            if (Singleton<GameWorld>.Instance != world)
            {
                yield break;
            }

            _more = More(world);
        }

        // {"loc":..,"boxes":[{"id","tpl","p","key"?}],"zones":[{"id","p"}]}: every container this raid has and every
        // place a quest can send you, as the map scanner writes them into places.json (the server keeps only the
        // ones that aren't in it). Made once a raid, from the containers already found and one search for the places.
        private static byte[] More(GameWorld world)
        {
            var to = new StringBuilder(32 * 1024);
            to.Append("{\"loc\":");
            World.Text(to, World.Location());
            to.Append(",\"boxes\":[");
            var count = 0;
            foreach (var box in Boxes)
            {
                if (box == null || !box.isActiveAndEnabled)
                {
                    continue;
                }

                Comma(to, count++);
                to.Append("{\"id\":");
                World.Text(to, box.Id);
                to.Append(",\"tpl\":");
                World.Text(to, box.Template ?? "");
                to.Append(",\"p\":");
                At(to, box.transform.position);
                if (!string.IsNullOrEmpty(box.KeyId))
                {
                    to.Append(",\"key\":");
                    World.Text(to, box.KeyId);
                }

                to.Append('}');
            }

            // the middle of each trigger's area, as the scanner takes it
            to.Append("],\"zones\":[");
            count = 0;
            foreach (var trigger in UnityEngine.Object.FindObjectsOfType<TriggerWithId>())
            {
                if (trigger == null || string.IsNullOrEmpty(trigger.Id))
                {
                    continue;
                }

                var area = trigger.GetComponent<Collider>();
                Comma(to, count++);
                to.Append("{\"id\":");
                World.Text(to, trigger.Id);
                to.Append(",\"p\":");
                At(to, area != null ? area.bounds.center : trigger.transform.position);
                to.Append('}');
            }

            to.Append("]}");
            return Encoding.UTF8.GetBytes(to.ToString());
        }

        // [east, north, height]
        private static void At(StringBuilder to, Vector3 at)
        {
            to.Append('[');
            World.Number(to, at.x);
            to.Append(',');
            World.Number(to, at.z);
            to.Append(',');
            World.Number(to, at.y);
            to.Append(']');
        }

        // sent once; again in a while, a few times at most, only when the server couldn't be reached (an answer, even a
        // refusal from a server without the route, ends it). A new world throws it away.
        private static void SendMore(Plugin plugin)
        {
            var bytes = _more;
            _moreSending = true;
            _moreNext = Time.unscaledTime + MoreAgain;
            _moreTries++;
            plugin.Post(MoreRoute, bytes, (ok, answer) =>
            {
                if ((ok || answer != null || _moreTries >= MoreTries) && ReferenceEquals(_more, bytes))
                {
                    _more = null;
                }

                _moreSending = false;
            });
        }

        // ---- what lies about in this raid -------------------------------------------------------------------------

        // {"loc":..,"loose":[[id,tpl,east,north,height,count,quest],..],"inside":{"box id":[[tpl,count],..],..},
        //  "bodies":[[id,east,north,height,name,side,kp,profile],..],"open":["door id",..]}: quest is 1 for a quest
        //  item; kp is 1 for a body a person playing killed (not a bot); profile is whose body it is (the corpse
        //  marker has it too); inside
        //  only lists containers (and bodies) with something in them; open lists the locks that aren't locked any more
        private static void SendLoot(Plugin plugin, GameWorld world)
        {
            var to = Report;
            to.Length = 0;
            to.Append("{\"loc\":");
            World.Text(to, World.Location());
            to.Append(",\"loose\":[");
            var count = 0;
            if (On("loose"))
            {
                foreach (var loot in world.LootItems.GetValuesEnumerator())
                {
                    // not the bodies, nor the mounted guns (the game keeps both as loot)
                    if (loot == null || loot is Corpse || loot.Item == null || string.IsNullOrEmpty(loot.TemplateId))
                    {
                        continue;
                    }

                    var which = loot.GetInstanceID();
                    if (!Mounted.TryGetValue(which, out var mounted))
                    {
                        Mounted[which] = mounted = loot.GetComponent<StationaryWeapon>() != null;
                    }

                    if (mounted)
                    {
                        continue;
                    }

                    var at = loot.transform.position;
                    Comma(to, count++);
                    to.Append('[');
                    World.Text(to, loot.ItemId ?? "");
                    to.Append(',');
                    World.Text(to, loot.TemplateId);
                    to.Append(',');
                    World.Number(to, at.x);
                    to.Append(',');
                    World.Number(to, at.z);
                    to.Append(',');
                    World.Number(to, at.y);
                    to.Append(',');
                    World.Whole(to, Math.Max(1, loot.Item.StackObjectsCount));
                    to.Append(',').Append(loot.Item.QuestItem ? '1' : '0');
                    to.Append(']');
                }
            }

            to.Append("],\"inside\":{");
            var filled = 0;
            if (On("contents"))
            {
                // the location's containers, and the crates of the airdrops
                foreach (var box in Boxes)
                {
                    Inside(to, box, ref filled);
                }

                foreach (var box in World.Crates())
                {
                    Inside(to, box, ref filled);
                }
            }

            // the bodies, each its own container: what it wears and carries (not what's in its secure container, nor
            // the parts of its guns, which come with the gun)
            if (On("contents"))
            {
                foreach (var loot in world.LootItems.GetValuesEnumerator())
                {
                    var body = loot as Corpse;
                    var root = body != null ? body.Item as CompoundItem : null;
                    if (root == null || string.IsNullOrEmpty(body.ItemId))
                    {
                        continue;
                    }

                    Carried.Clear();
                    CarriedSlot.Clear();
                    Carry(root, 0);
                    if (Carried.Count == 0)
                    {
                        continue;
                    }

                    Comma(to, filled++);
                    World.Text(to, body.ItemId);
                    to.Append(":[");
                    for (var i = 0; i < Carried.Count; i++)
                    {
                        if (i > 0)
                        {
                            to.Append(',');
                        }

                        to.Append('[');
                        World.Text(to, Carried[i].StringTemplateId);
                        to.Append(',');
                        World.Whole(to, Math.Max(1, Carried[i].StackObjectsCount));
                        // the slot it's worn in ("Headwear", "Backpack"); nothing for what lies in a pocket or a bag
                        if (CarriedSlot[i] != null)
                        {
                            to.Append(',');
                            World.Text(to, CarriedSlot[i]);
                        }
                        to.Append(']');
                    }

                    to.Append(']');
                }
            }

            to.Append("},\"bodies\":[");
            var bodies = 0;
            if (On("contents"))
            {
                foreach (var loot in world.LootItems.GetValuesEnumerator())
                {
                    var body = loot as Corpse;
                    if (body == null || string.IsNullOrEmpty(body.ItemId))
                    {
                        continue;
                    }

                    var at = body.transform.position;
                    Comma(to, bodies++);
                    to.Append('[');
                    World.Text(to, body.ItemId);
                    to.Append(',');
                    World.Number(to, at.x);
                    to.Append(',');
                    World.Number(to, at.z);
                    to.Append(',');
                    World.Number(to, at.y);
                    to.Append(',');
                    World.Text(to, body.PlayerProfileID != null && World.Names.TryGetValue(body.PlayerProfileID, out var name) ? name : "");
                    to.Append(',');
                    World.Text(to, body.Side.ToString());
                    to.Append(',').Append(body.PlayerProfileID != null && World.KilledByPlayers.Contains(body.PlayerProfileID) ? '1' : '0');
                    to.Append(',');
                    World.Text(to, body.PlayerProfileID ?? "");
                    // what it was alive ("Scav", "Boss"), where that's known
                    to.Append(',');
                    World.Text(to, body.PlayerProfileID != null && World.Kinds.TryGetValue(body.PlayerProfileID, out var was) ? was : "");
                    to.Append(']');
                }
            }

            to.Append("],\"open\":[");
            var opened = 0;
            if (On("locks"))
            {
                foreach (var thing in Locked)
                {
                    if (thing != null && thing.DoorState != EDoorState.Locked)
                    {
                        Comma(to, opened++);
                        World.Text(to, thing.Id ?? "");
                    }
                }
            }

            // the containers this raid has: a location doesn't put every one of its containers in every raid
            to.Append("],\"have\":[");
            var have = 0;
            foreach (var box in Boxes)
            {
                if (box != null && box.isActiveAndEnabled)
                {
                    Comma(to, have++);
                    World.Text(to, box.Id);
                }
            }

            // what each living bot wears and carries, by its profile id (its marker's "pid"): as a body's, without the
            // secure container
            to.Append("],\"carried\":{");
            var carrying = 0;
            if (On("carried"))
            {
                foreach (var player in world.AllAlivePlayersList)
                {
                    CompoundItem worn = null;
                    try
                    {
                        if (player != null && World.IsBot(player) && !string.IsNullOrEmpty(player.ProfileId) && player.Inventory != null)
                        {
                            worn = player.Inventory.Equipment;
                        }
                    }
                    catch (Exception)
                    {
                        // this one is left out
                    }

                    if (worn == null)
                    {
                        continue;
                    }

                    Carried.Clear();
                    CarriedSlot.Clear();
                    Carry(worn, 0);
                    if (Carried.Count == 0)
                    {
                        continue;
                    }

                    Comma(to, carrying++);
                    World.Text(to, player.ProfileId);
                    to.Append(":[");
                    for (var i = 0; i < Carried.Count; i++)
                    {
                        if (i > 0)
                        {
                            to.Append(',');
                        }

                        to.Append('[');
                        World.Text(to, Carried[i].StringTemplateId);
                        to.Append(',');
                        World.Whole(to, Math.Max(1, Carried[i].StackObjectsCount));
                        // the slot it's worn in ("Headwear", "Backpack"); nothing for what lies in a pocket or a bag
                        if (CarriedSlot[i] != null)
                        {
                            to.Append(',');
                            World.Text(to, CarriedSlot[i]);
                        }
                        to.Append(']');
                    }

                    to.Append(']');
                }
            }

            to.Append("}}");
            // nothing changed since it was last sent (nearly always): nothing is made of it and nothing sent
            var size = Out.Take(to);
            var print = Out.Print();
            if (print == _lootPrint)
            {
                return;
            }

            _sending = true;
            plugin.Post(LootRoute, Out.Bytes, size, (ok, answer) =>
            {
                // sent again next time if it didn't arrive
                _lootPrint = ok ? print : 0;
                _sending = false;
            });
        }

        // what's in one container, if anything: "box id":[[tpl,count],..]
        private static void Inside(StringBuilder to, LootableContainer box, ref int filled)
        {
            var root = box != null && box.ItemOwner != null ? box.ItemOwner.RootItem as CompoundItem : null;
            if (root == null || root.Grids == null)
            {
                return;
            }

            var first = true;
            foreach (var grid in root.Grids)
            {
                foreach (var item in grid.Items)
                {
                    if (first)
                    {
                        Comma(to, filled++);
                        World.Text(to, box.Id);
                        to.Append(":[");
                    }
                    else
                    {
                        to.Append(',');
                    }

                    first = false;
                    to.Append('[');
                    World.Text(to, item.StringTemplateId);
                    to.Append(',');
                    World.Whole(to, Math.Max(1, item.StackObjectsCount));
                    to.Append(']');
                }
            }

            if (!first)
            {
                to.Append(']');
            }
        }

        private static readonly List<Item> Carried = new List<Item>();
        // for each of those, the slot it's worn in; null for what lies in a pocket, a rig or a bag
        private static readonly List<string> CarriedSlot = new List<string>();

        // What a body (or a bag on it) holds: whatever is worn in its slots, and what lies in its pockets, rig and bags,
        // a few bags deep. Not the secure container, which can't be looted.
        private static void Carry(CompoundItem holder, int depth)
        {
            if (depth > 3 || Carried.Count > 200)
            {
                return;
            }

            if (depth == 0 && holder.Slots != null)
            {
                foreach (var slot in holder.Slots)
                {
                    var worn = slot != null ? slot.ContainedItem : null;
                    if (worn == null || slot.ID == "SecuredContainer")
                    {
                        continue;
                    }

                    // pockets are a slot of their own; what's in them counts, not the pockets
                    if (slot.ID != "Pockets")
                    {
                        Carried.Add(worn);
                        CarriedSlot.Add(slot.ID);
                    }

                    if (worn is CompoundItem bag)
                    {
                        Carry(bag, depth + 1);
                    }
                }

                return;
            }

            if (holder.Grids == null)
            {
                return;
            }

            foreach (var grid in holder.Grids)
            {
                foreach (var item in grid.Items)
                {
                    Carried.Add(item);
                    CarriedSlot.Add(null);
                    if (item is CompoundItem inner && inner.Grids != null && inner.Grids.Length > 0)
                    {
                        Carry(inner, depth + 1);
                    }
                }
            }
        }

        // ---- writing --------------------------------------------------------------------------------------------

        private static void Comma(StringBuilder to, int before)
        {
            if (before > 0)
            {
                to.Append(',');
            }
        }
    }
}
