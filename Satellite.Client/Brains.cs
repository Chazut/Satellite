using System;
using System.Collections.Generic;
using System.Reflection;
using EFT;
using UnityEngine;

namespace Satellite.Client
{
    // What a bot is like and what it's up to, asked of the mods that decide it: SAIN (its personality), ORBIT (whether
    // it's parked as a "ghost" far from every player, and what it's heading for) and the game's own brain (the layer
    // deciding for it right now, which BigBrain lets SAIN and ORBIT add theirs to) and COMET (the move it has the bot
    // making in a fight). None of the mods is needed: each is found by name once, and what isn't there is left out.
    internal static class Brains
    {
        private static bool _looked;
        private static MethodInfo _personality;
        private static MethodInfo _dormant;
        private static MethodInfo _objective;
        private static FieldInfo _category;
        private static FieldInfo _status;
        // where ORBIT has the bot heading
        private static FieldInfo _headingX;
        private static FieldInfo _headingY;
        private static FieldInfo _headingZ;
        // Pit FireTeam: whether a bot is one of the player's own team
        private static Func<string, bool> _teammate;
        // the same three, to call without the wrapping a call by name needs (it's asked of every bot, every second)
        private static Func<BotOwner, string> _personalityOf;
        private static Func<string, bool> _dormantIs;
        private static Func<string, object> _objectiveOf;
        // COMET's three: the move it has a bot making, as part of a squad's crossfire, and once the fight is over
        private static Func<string, string> _tactic;
        private static Func<string, string> _crossfire;
        private static Func<string, string> _after;
        private static string[] _mods = new string[0];

        private static T Direct<T>(MethodInfo method) where T : class
        {
            try
            {
                return method != null ? Delegate.CreateDelegate(typeof(T), method, false) as T : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static void Look()
        {
            if (_looked)
            {
                return;
            }

            _looked = true;
            try
            {
                foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
                {
                    var name = assembly.GetName().Name;
                    if (string.Equals(name, "SAIN", StringComparison.OrdinalIgnoreCase))
                    {
                        _personality = assembly.GetType("SAIN.Interop.SAINExternal")
                            ?.GetMethod("GetPersonality", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(BotOwner) }, null);
                    }
                    else if (string.Equals(name, "ORBIT", StringComparison.OrdinalIgnoreCase))
                    {
                        var telemetry = assembly.GetType("Orbit.Api.OrbitTelemetry");
                        _dormant = telemetry?.GetMethod("IsBotDormant", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(string) }, null);
                        _objective = telemetry?.GetMethod("GetBotObjective", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(string) }, null);
                        var objective = assembly.GetType("Orbit.Api.OrbitBotObjective");
                        _category = objective?.GetField("Category");
                        _status = objective?.GetField("Status");
                        _headingX = objective?.GetField("ObjectiveX");
                        _headingY = objective?.GetField("ObjectiveY");
                        _headingZ = objective?.GetField("ObjectiveZ");
                    }
                    else if (string.Equals(name, "pitFireTeam", StringComparison.OrdinalIgnoreCase))
                    {
                        _teammate = Direct<Func<string, bool>>(assembly.GetType("pitTeam.Modules.BossPlayers")
                            ?.GetMethod("IsFollowerProfileId", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(string) }, null));
                    }
                    else if (string.Equals(name, "COMET", StringComparison.OrdinalIgnoreCase))
                    {
                        var decisions = assembly.GetType("Comet.Api.Decisions");
                        _tactic = Direct<Func<string, string>>(Said(decisions, "GetCurrentDecision"));
                        _crossfire = Direct<Func<string, string>>(Said(decisions, "GetCrossfireDecision"));
                        _after = Direct<Func<string, string>>(Said(decisions, "GetPostCombatDecision"));
                        Listen(decisions);
                    }
                }
            }
            catch (Exception)
            {
                // neither, then
            }

            _personalityOf = Direct<Func<BotOwner, string>>(_personality);
            _dormantIs = Direct<Func<string, bool>>(_dormant);
            _objectiveOf = Direct<Func<string, object>>(_objective);
            var mods = new System.Collections.Generic.List<string>();
            if (_personality != null)
            {
                mods.Add("SAIN");
            }

            if (_dormant != null)
            {
                mods.Add("ORBIT");
            }

            if (_tactic != null)
            {
                mods.Add("COMET");
            }

            if (Objectives.Questing)
            {
                mods.Add("QuestingBots");
            }

            if (Objectives.Phobos)
            {
                mods.Add("Phobos");
            }

            _mods = mods.ToArray();
            Plugin.Log.LogInfo("Bot details: SAIN " + (_personality != null ? "found" : "not found")
                + ", ORBIT " + (_dormant != null ? "found" : "not found")
                + ", COMET " + (_tactic != null ? "found" + (_listener != null ? " (listening for its squads)" : " (no squad feed in this version)") : "not found"));
        }

        private static MethodInfo Said(Type decisions, string name)
        {
            return decisions?.GetMethod(name, BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(string) }, null);
        }

        // the mods found here that say something about a bot ("SAIN", "ORBIT", "COMET"): the page names only these
        internal static string[] Mods()
        {
            Look();
            return _mods;
        }

        // the move COMET has the bot making ("Push", "Hold", "CrossfireMoving", "PostCombatHealing"): null when
        // COMET isn't deciding for it (or always, without COMET)
        internal static string Tactic(string profileId)
        {
            Look();
            if (_tactic == null || string.IsNullOrEmpty(profileId))
            {
                return null;
            }

            try
            {
                var said = _crossfire != null ? _crossfire(profileId) : null;
                if (string.IsNullOrEmpty(said) && _after != null)
                {
                    said = _after(profileId);
                }

                if (string.IsNullOrEmpty(said))
                {
                    said = _tactic(profileId);
                }

                if (string.IsNullOrEmpty(said))
                {
                    return null;
                }

                said = said.StartsWith("COMET:", StringComparison.Ordinal) ? said.Substring(6) : said;
                return said.Length > 0 ? said : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        // ---- what a squad is doing together (COMET) ---------------------------------------------------------------
        // COMET says each decision it makes as a line of JSON to whoever listens (Comet.Api.Decisions.Published, on
        // the game's own thread, a few a second for each bot in a fight). Only the six about a squad acting together
        // are kept: S01 crossfire angles, S02 a second way in, S03 support and flank, S04 covering a teammate who is
        // busy, S05 answering a teammate's death, S06 the squad going in together. Each has a "crossfire" part: how
        // far along it is, whether COMET has the bot doing it yet ("applied") or only means to, the plan its squad
        // shares, who it's against and where the bot is sent.

        internal sealed class Squad
        {
            public string Feature;
            public string State;
            public string Role;
            public string Sub;
            public string Plan;
            public string Contact;
            public string Mate;
            public string Key;
            public bool Applied;
            public bool Fire;
            public bool Ended;
            public bool HasGoal;
            public float X;
            public float Y;
            public float Z;
            public float At;
        }

        private const int MostHeard = 256;
        private const int MostLength = 32768;
        private static readonly System.Collections.Generic.Queue<string> Heard = new System.Collections.Generic.Queue<string>();
        private static readonly System.Collections.Generic.Dictionary<string, Squad> Squads = new System.Collections.Generic.Dictionary<string, Squad>();
        private static Action<string> _listener;
        private static bool _saidUnread;
        private static bool _saidHeard;

        private static void Listen(Type decisions)
        {
            try
            {
                var schema = decisions?.GetField("SchemaVersion", BindingFlags.Public | BindingFlags.Static);
                var published = decisions?.GetEvent("Published", BindingFlags.Public | BindingFlags.Static);
                if (schema == null || published == null || !(schema.GetRawConstantValue() is int version) || version != 1)
                {
                    return;
                }

                _listener = Hear;
                published.AddEventHandler(null, _listener);
            }
            catch (Exception)
            {
                // an older COMET, or a newer one that says it another way: each bot's own move is still read
                _listener = null;
            }
        }

        // COMET allows each listener a millisecond: the line is only looked at and put by, and read when a report
        // is made (Sort). Its "feature" is among the first things in it.
        private static void Hear(string json)
        {
            if (World.BrainsOff || json == null || json.Length > MostLength)
            {
                return;
            }

            var at = json.IndexOf("\"feature\":", 0, Math.Min(json.Length, 400), StringComparison.Ordinal);
            if (at < 0)
            {
                return;
            }

            at += 10;
            while (at < json.Length && json[at] == ' ')
            {
                at++;
            }

            if (at + 3 >= json.Length || json[at] != '"' || json[at + 1] != 'S' || json[at + 2] != '0')
            {
                return;
            }

            lock (Heard)
            {
                if (Heard.Count >= MostHeard)
                {
                    Heard.Dequeue();
                }

                Heard.Enqueue(json);
            }

            // once a game: so the log shows that COMET does say what its squads do, when the map shows nothing of it
            if (!_saidHeard)
            {
                _saidHeard = true;
                Plugin.Log.LogInfo("COMET's first squad decision heard.");
            }
        }

        // a new raid: nothing said in the last one stands
        internal static void Forget()
        {
            lock (Heard)
            {
                Heard.Clear();
            }

            Squads.Clear();
        }

        // Reads what COMET has said since the last report. Called before the markers of a full report are written.
        internal static void Sort()
        {
            while (true)
            {
                string json;
                lock (Heard)
                {
                    if (Heard.Count == 0)
                    {
                        return;
                    }

                    json = Heard.Dequeue();
                }

                try
                {
                    Read(json);
                }
                catch (Exception e)
                {
                    if (!_saidUnread)
                    {
                        _saidUnread = true;
                        Plugin.Log.LogWarning("Couldn't read what COMET said about a squad (said once): " + e.Message);
                    }
                }
            }
        }

        private static string Word(Newtonsoft.Json.Linq.JToken from, string name)
        {
            var value = from != null && from.Type == Newtonsoft.Json.Linq.JTokenType.Object ? from[name] : null;
            return value != null && value.Type == Newtonsoft.Json.Linq.JTokenType.String ? (string)value : "";
        }

        private static bool Flag(Newtonsoft.Json.Linq.JToken from, string name)
        {
            var value = from != null && from.Type == Newtonsoft.Json.Linq.JTokenType.Object ? from[name] : null;
            return value != null && value.Type == Newtonsoft.Json.Linq.JTokenType.Boolean && (bool)value;
        }

        private static bool Amount(Newtonsoft.Json.Linq.JToken from, string name, out float amount)
        {
            amount = 0f;
            var value = from != null && from.Type == Newtonsoft.Json.Linq.JTokenType.Object ? from[name] : null;
            if (value == null || (value.Type != Newtonsoft.Json.Linq.JTokenType.Float && value.Type != Newtonsoft.Json.Linq.JTokenType.Integer))
            {
                return false;
            }

            amount = (float)value;
            return !float.IsNaN(amount) && !float.IsInfinity(amount);
        }

        private static Newtonsoft.Json.Linq.JToken Part(Newtonsoft.Json.Linq.JToken from, string name)
        {
            var value = from[name];
            return value != null && value.Type == Newtonsoft.Json.Linq.JTokenType.Object ? value : null;
        }

        private static void Read(string json)
        {
            Newtonsoft.Json.Linq.JObject said;
            using (var text = new System.IO.StringReader(json))
            using (var reader = new Newtonsoft.Json.JsonTextReader(text) { DateParseHandling = Newtonsoft.Json.DateParseHandling.None, MaxDepth = 64 })
            {
                said = Newtonsoft.Json.Linq.JObject.Load(reader);
            }

            var profileId = Word(said, "profileId");
            var feature = Word(said, "feature");
            var crossfire = Part(said, "crossfire");
            if (profileId.Length == 0 || feature.Length != 3 || crossfire == null || !Amount(said, "realtime", out var when))
            {
                return;
            }

            var storm = Part(crossfire, "storm");
            var trade = Part(crossfire, "trade");
            var cover = Part(crossfire, "coverMate");
            var maneuver = Part(crossfire, "maneuver");
            var entrance = Part(crossfire, "entrance");
            var squad = new Squad
            {
                Feature = feature,
                State = Word(crossfire, "state"),
                Applied = Flag(crossfire, "applied"),
                Contact = Word(crossfire, "contact"),
                At = when,
                Role = maneuver != null ? Word(maneuver, "role") : trade != null ? Word(trade, "choice") : "",
                Sub = storm != null ? Word(storm, "status") : trade != null ? Word(trade, "status") : cover != null ? Word(cover, "status")
                    : maneuver != null ? Word(maneuver, "state") : entrance != null ? Word(entrance, "state") : "",
                Plan = maneuver != null ? Word(maneuver, "plan") : storm != null ? Word(storm, "plan") : "",
                Mate = cover != null ? Word(cover, "mateName") : trade != null ? Word(trade, "mateName")
                    : maneuver != null ? Word(maneuver, "supportName") : Word(crossfire, "supportName"),
                Fire = maneuver != null && Word(maneuver, "fireState") == "observed suppression fire",
            };
            squad.Ended = squad.State == "ended" || (maneuver != null && Word(maneuver, "state") == "ended")
                || (storm != null && Word(storm, "state") == "ended");
            if (Amount(crossfire, "goalX", out var x) && Amount(crossfire, "goalY", out var y) && Amount(crossfire, "goalZ", out var z))
            {
                squad.HasGoal = true;
                squad.X = x;
                squad.Y = y;
                squad.Z = z;
            }

            squad.Key = feature + "|" + squad.State + "|" + squad.Applied + "|" + squad.Role + "|" + squad.Sub + "|" + squad.Plan + "|" + squad.Fire;
            Squads.TryGetValue(profileId, out var before);
            Squads[profileId] = squad;
            // an event only when it changed, and not for what was said long ago while nobody was looking
            if ((before == null || before.Key != squad.Key) && UnityEngine.Time.realtimeSinceStartup - when < 10f)
            {
                var session = Word(said, "session");
                Events.Add("comet.squad", profileId, Word(said, "name"), when, to => Write(to, squad, session));
            }
        }

        // what the bot's squad has it doing now: null when COMET has said nothing lately, or that it's over
        internal static Squad SquadOf(string profileId)
        {
            if (_listener == null || string.IsNullOrEmpty(profileId) || !Squads.TryGetValue(profileId, out var squad) || squad.Ended)
            {
                return null;
            }

            // said again every half second while the bot is doing it, and once at each change otherwise
            if (UnityEngine.Time.realtimeSinceStartup - squad.At < 2.5f)
            {
                return squad;
            }

            try
            {
                return squad.Applied && _crossfire != null && !string.IsNullOrEmpty(_crossfire(profileId)) ? squad : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        // {"f":"S03","s":"moving","a":1,"r":"flank","u":"active","p":"<plan>","c":"<profile id it's against>",
        //  "m":"<teammate's name>","x":1,"g":[east,north,height]}: "a" COMET has the bot doing it, "x" it's laying
        // down fire, "g" where it's sent; session: COMET's own name for the raid, said with an event only
        internal static void Write(System.Text.StringBuilder to, Squad squad, string session)
        {
            to.Append("{\"f\":");
            World.Text(to, squad.Feature);
            to.Append(",\"s\":");
            World.Text(to, squad.State);
            if (squad.Applied)
            {
                to.Append(",\"a\":1");
            }

            if (!string.IsNullOrEmpty(squad.Role))
            {
                to.Append(",\"r\":");
                World.Text(to, squad.Role);
            }

            if (!string.IsNullOrEmpty(squad.Sub))
            {
                to.Append(",\"u\":");
                World.Text(to, squad.Sub);
            }

            if (!string.IsNullOrEmpty(squad.Plan))
            {
                to.Append(",\"p\":");
                World.Text(to, squad.Plan);
            }

            if (!string.IsNullOrEmpty(squad.Contact))
            {
                to.Append(",\"c\":");
                World.Text(to, squad.Contact);
            }

            if (!string.IsNullOrEmpty(squad.Mate))
            {
                to.Append(",\"m\":");
                World.Text(to, squad.Mate);
            }

            if (squad.Fire)
            {
                to.Append(",\"x\":1");
            }

            if (squad.HasGoal)
            {
                to.Append(",\"g\":[");
                World.Number(to, squad.X);
                to.Append(',');
                World.Number(to, squad.Z);
                to.Append(',');
                World.Number(to, squad.Y);
                to.Append(']');
            }

            if (!string.IsNullOrEmpty(session))
            {
                to.Append(",\"cs\":");
                World.Text(to, session);
            }

            to.Append('}');
        }

        // "Chad", "Rat"...: null until SAIN has made its mind up about this bot (or always, without SAIN)
        internal static string Personality(BotOwner bot)
        {
            Look();
            if (_personality == null || bot == null)
            {
                return null;
            }

            try
            {
                var said = _personalityOf != null ? _personalityOf(bot) : _personality.Invoke(null, new object[] { bot }) as string;
                return string.IsNullOrEmpty(said) ? null : said;
            }
            catch (Exception)
            {
                return null;
            }
        }

        // parked by ORBIT: far from every player, its body and brain switched off, moved along its way as a "ghost"
        internal static bool Ghost(string profileId)
        {
            Look();
            if (_dormant == null || string.IsNullOrEmpty(profileId))
            {
                return false;
            }

            try
            {
                return _dormantIs != null ? _dormantIs(profileId) : (bool)_dormant.Invoke(null, new object[] { profileId });
            }
            catch (Exception)
            {
                return false;
            }
        }

        // what ORBIT has it heading for ("Loot", "AirdropLoot", a rush plan's step), and how far along it is
        internal static string Objective(string profileId)
        {
            Look();
            if (_objective == null || _category == null || string.IsNullOrEmpty(profileId))
            {
                return null;
            }

            try
            {
                var objective = _objectiveOf != null ? _objectiveOf(profileId) : _objective.Invoke(null, new object[] { profileId });
                if (objective == null)
                {
                    return null;
                }

                var category = _category.GetValue(objective) as string;
                var status = _status != null ? _status.GetValue(objective) as string : null;
                if (string.IsNullOrEmpty(category))
                {
                    return null;
                }

                return string.IsNullOrEmpty(status) ? category : category + " (" + status + ")";
            }
            catch (Exception)
            {
                return null;
            }
        }

        // where ORBIT has the bot heading (the place its objective is at): false when it has none, or without ORBIT
        internal static bool Heading(string profileId, out float x, out float y, out float z)
        {
            x = y = z = 0f;
            Look();
            if (_objective == null || _headingX == null || _headingY == null || _headingZ == null || string.IsNullOrEmpty(profileId))
            {
                return false;
            }

            try
            {
                var objective = _objectiveOf != null ? _objectiveOf(profileId) : _objective.Invoke(null, new object[] { profileId });
                if (objective == null)
                {
                    return false;
                }

                x = Convert.ToSingle(_headingX.GetValue(objective));
                y = Convert.ToSingle(_headingY.GetValue(objective));
                z = Convert.ToSingle(_headingZ.GetValue(objective));
                return (x != 0f || y != 0f || z != 0f) && !float.IsNaN(x) && !float.IsNaN(y) && !float.IsNaN(z);
            }
            catch (Exception)
            {
                return false;
            }
        }

        // one of the player's own team of bots (Pit FireTeam): always false without that mod
        internal static bool Teammate(string profileId)
        {
            Look();
            if (_teammate == null || string.IsNullOrEmpty(profileId))
            {
                return false;
            }

            try
            {
                return _teammate(profileId);
            }
            catch (Exception)
            {
                return false;
            }
        }

        // What the bot has decided to do this moment, finer than its layer: SAIN's own decision when SAIN has one
        // ("SAIN:Search", "SAIN:ThrowGrenade", "SAIN:FirstAid"), else the game's ("simplePatrol", "heal",
        // "throwGrenadeFromPlace"). A raid's behaviour chart is drawn from these.
        private static bool _sainLooked;
        private static Type _sainBot;
        private static readonly Dictionary<string, Component> SainBots = new Dictionary<string, Component>();
        private static readonly string[] SainDecisions = { "CurrentSelfDecision", "CurrentCombatDecision", "CurrentSquadDecision" };

        internal static void ForgetDecisions()
        {
            SainBots.Clear();
        }

        internal static string Decision(Player player, BotOwner bot)
        {
            try
            {
                if (!_sainLooked)
                {
                    _sainLooked = true;
                    _sainBot = Types.Find("SAIN.Components.BotComponent");
                }

                if (_sainBot != null && player != null && !string.IsNullOrEmpty(player.ProfileId))
                {
                    if (!SainBots.TryGetValue(player.ProfileId, out var sain) || sain == null)
                    {
                        sain = player.gameObject.GetComponent(_sainBot);
                        SainBots[player.ProfileId] = sain;
                    }

                    var decision = sain != null ? Hooks.Get(sain, "Decision") : null;
                    if (decision != null)
                    {
                        foreach (var name in SainDecisions)
                        {
                            var said = Convert.ToString(Hooks.Get(decision, name));
                            if (!string.IsNullOrEmpty(said) && said != "None" && said != "0")
                            {
                                return "SAIN:" + said;
                            }
                        }
                    }
                }

                var last = bot != null && bot.Brain != null ? Hooks.Get(bot.Brain, "LastDecision") : null;
                return last != null ? last.ToString() : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        // the brain layer deciding for the bot now: "SAIN : Combat Layer", "OrbitBrainLayer", or one of the game's own
        internal static string Layer(BotOwner bot)
        {
            try
            {
                return bot != null && bot.Brain != null ? bot.Brain.ActiveLayerName() : null;
            }
            catch (Exception)
            {
                return null;
            }
        }
    }
}
