using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using Comfort.Common;
using EFT;
using UnityEngine.SceneManagement;

namespace Satellite.Shared
{
    // Which map a raid is on, as the server keeps it. That's the game's location id ("Interchange"), unless a mod has
    // swapped the location for another version of it: then a version follows a "~" ("Interchange~backport"), so each
    // version has a picture and places of its own.
    //
    // A version is told by the scenes the game has loaded, which every map keeps from its capture. In a raid the plugin
    // sends the location and its scenes, and the server answers with the map whose scenes match (see the server's
    // MapFor), so a map captured once, on any game, is found on another whichever way the version got there: picked in
    // MapVariants, put in place by a backport for good, or back to the game's own once that's uninstalled. Until the
    // server has answered, and for a version no map matches (captured then), the key is a guess from MapVariants
    // (LennoxP90), which lets the player pick a version before the raid; it's asked through its API by reflection, so it
    // needn't be installed. A location a mod adds (a custom map) has an id of its own and needs nothing more.
    internal static class Variant
    {
        // the log of whichever plugin this is compiled into (the web map's or the scanner's); set in its Awake
        internal static BepInEx.Logging.ManualLogSource Log;

        private const string Original = "original";

        private static GameWorld _world;
        private static string _id;
        private static string _key;
        private static string _variantName;
        private static bool _settled;
        private static List<string> _scenes;

        // the server's answer: the map this raid is on; the raid it's for, counted
        private static volatile string _resolved;
        private static volatile int _raid;

        // whether the server has said which map this is
        internal static bool Resolved => _resolved != null;

        // whether MapVariants (if it looks after this location) has said which version it loaded; after a few seconds
        // without a word it's not waited for, since the scenes are what tell the version and it's only a guess
        internal static bool Settled => _settled || UnityEngine.Time.unscaledTime - _since > 5f;
        private static float _since;

        // counts the raids, so an answer about an earlier one is let go
        internal static int Raid => _raid;

        // the location id, as the game has it
        internal static string Base()
        {
            Key();
            return _id;
        }

        // the server has said which map the raid is on
        internal static void Resolve(int raid, string key)
        {
            if (raid == _raid && !string.IsNullOrEmpty(key) && _id != null
                && (key == _id || key.StartsWith(_id + "~", StringComparison.Ordinal)) && key != _resolved)
            {
                _resolved = key;
                Log.LogInfo($"The server has {_id} in this raid as {key}.");
            }
        }

        // the loaded scenes, as the server is asked with: ,"base":id,"hint":guess,"scn":[names]
        internal static void Ask(StringBuilder to)
        {
            Key();
            if (_id == null)
            {
                return;
            }

            to.Append(",\"base\":");
            Json.Text(to, _id);
            to.Append(",\"hint\":");
            Json.Text(to, _key);
            to.Append(",\"scn\":");
            ScenesJson(to);
        }

        private static void ScenesJson(StringBuilder to)
        {
            if (_scenes == null)
            {
                _scenes = SceneNames();
            }

            to.Append('[');
            for (var i = 0; i < _scenes.Count; i++)
            {
                if (i > 0)
                {
                    to.Append(',');
                }

                Json.Text(to, _scenes[i]);
            }

            to.Append(']');
        }

        // MapVariants' API, looked for once
        private static bool _looked;
        private static MethodInfo _isManaged;
        private static MethodInfo _displayName;
        private static PropertyInfo _current;
        private static PropertyInfo _currentLocation;
        private static PropertyInfo _selected;

        // the map's key: as the server matched it, or else the guess
        internal static string Key()
        {
            var world = Singleton<GameWorld>.Instance;
            var id = world?.MainPlayer?.Location;
            // (a Fika headless has no player of its own: the world says where it is)
            if (string.IsNullOrEmpty(id))
            {
                id = world?.LocationId;
            }
            if (string.IsNullOrEmpty(id))
            {
                return id;
            }

            if (!ReferenceEquals(world, _world) || id != _id)
            {
                _world = world;
                _id = id;
                _key = id;
                _variantName = null;
                _settled = false;
                _scenes = null;
                _resolved = null;
                _raid++;
                _since = UnityEngine.Time.unscaledTime;
            }

            if (!_settled)
            {
                Work(id);
            }

            return _resolved ?? _key;
        }

        private static void Work(string id)
        {
            var variant = Asked(id, out var managed, out var known, out var word);
            if (!known)
            {
                // MapVariants hasn't picked yet; asked again on the next report
                return;
            }

            _settled = true;
            if (managed && !string.IsNullOrEmpty(variant))
            {
                _variantName = Named(id, variant);
                var clean = Regex.Replace((word ?? variant).Trim().ToLowerInvariant(), "[^a-z0-9_-]", "");
                if (clean.Length > 24)
                {
                    clean = clean.Substring(0, 24);
                }

                if (clean.Length > 0 && clean != Original)
                {
                    _key = id + "~" + clean;
                }
            }

            _scenes = SceneNames();
            Log.LogInfo($"Location {id}" + (_variantName != null ? $", version \"{_variantName}\" in MapVariants" : "")
                + $"; scenes: {_scenes.Count} ({string.Join(", ", _scenes)}).");
        }

        // the version MapVariants says is loaded, if it looks after this location. word: the version's own name for the
        // map's key, when MapVariants (1.2 on) says whose it is; "backport" is every mod's backport, "manimal" is Manimal's
        private static string Asked(string id, out bool managed, out bool known, out string word)
        {
            managed = false;
            known = true;
            word = null;
            try
            {
                Look();
                if (_isManaged == null || !(bool)_isManaged.Invoke(null, new object[] { id }))
                {
                    return null;
                }

                managed = true;
                var variant = _current?.GetValue(null, null) as string;
                var location = _currentLocation?.GetValue(null, null) as string;
                if (string.IsNullOrEmpty(variant)
                    || (!string.IsNullOrEmpty(location) && !string.Equals(location, id, StringComparison.OrdinalIgnoreCase)))
                {
                    known = false;
                    return null;
                }

                word = Word(_selected?.GetValue(null, null) as string);
                return variant;
            }
            catch (Exception e)
            {
                Log.LogWarning($"Couldn't ask MapVariants which version of {id} this is: {e.Message}");
                managed = false;
                return null;
            }
        }

        // "owner:variant" from MapVariants' SelectedId: the plugin that registered the version, and that mod's own word
        // for it ("com.manimal.interchange:manimal"); the game's own map is "spt:shipped"
        private static string Word(string selected)
        {
            var colon = selected?.LastIndexOf(':') ?? -1;
            if (colon <= 0 || colon == selected.Length - 1)
            {
                return null;
            }

            return selected == "spt:shipped" ? Original : selected.Substring(colon + 1);
        }

        private static string Named(string id, string variant)
        {
            try
            {
                var name = _displayName?.Invoke(null, new object[] { id, variant }) as string;
                return string.IsNullOrEmpty(name) || string.Equals(name, id, StringComparison.OrdinalIgnoreCase) ? variant : name;
            }
            catch (Exception)
            {
                return variant;
            }
        }

        private static void Look()
        {
            if (_looked)
            {
                return;
            }

            _looked = true;
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type maps;
                try
                {
                    maps = assembly.GetType("MapVariants.Client.Api.Maps", false);
                }
                catch (Exception)
                {
                    continue;
                }

                if (maps == null)
                {
                    continue;
                }

                const BindingFlags flags = BindingFlags.Public | BindingFlags.Static;
                _isManaged = maps.GetMethod("IsManaged", flags, null, new[] { typeof(string) }, null);
                _displayName = maps.GetMethod("DisplayName", flags, null, new[] { typeof(string), typeof(string) }, null);
                _current = maps.GetProperty("CurrentVariant", flags);
                _currentLocation = maps.GetProperty("CurrentLocationId", flags);
                // 1.2 on; before that the key is CurrentVariant's word
                _selected = maps.GetProperty("SelectedId", flags);
                Log.LogInfo("MapVariants found: each version of a map it switches is kept apart.");
                return;
            }
        }

        // The scenes the game has loaded, sorted: what tells one version of a map from another.
        private static List<string> SceneNames()
        {
            var names = new List<string>();
            try
            {
                for (var i = 0; i < SceneManager.sceneCount; i++)
                {
                    var scene = SceneManager.GetSceneAt(i);
                    if (scene.IsValid() && scene.isLoaded && !string.IsNullOrEmpty(scene.name) && !names.Contains(scene.name))
                    {
                        names.Add(scene.name);
                    }
                }
            }
            catch (Exception)
            {
                // none known
            }

            names.Sort(StringComparer.Ordinal);
            return names;
        }

        // what the page names the map by, for the capture's meta.json:
        // ,"base":location id,"lid":the game's id of the location,"name":its name,"vname":the version's name,
        // "scenes":[the scenes loaded],"season":the season shown (Summer, Winter, AutumnLate...)
        internal static void About(StringBuilder to)
        {
            Key();
            if (string.IsNullOrEmpty(_id))
            {
                return;
            }

            to.Append(",\"base\":");
            Json.Text(to, _id);
            try
            {
                var game = Singleton<AbstractGame>.Instance;
                var location = game?.GetType().GetProperty("Location", BindingFlags.Public | BindingFlags.Instance)?.GetValue(game, null)
                    as JsonType.LocationSettings.Location;
                if (location != null)
                {
                    if (!string.IsNullOrEmpty(location._Id))
                    {
                        to.Append(",\"lid\":");
                        Json.Text(to, location._Id);
                    }

                    var name = location.LocalizedName;
                    if (!string.IsNullOrEmpty(name) && !name.EndsWith(" Name", StringComparison.Ordinal))
                    {
                        to.Append(",\"name\":");
                        Json.Text(to, name);
                    }
                }
            }
            catch (Exception)
            {
                // a name is nice to have; the id does
            }

            if (_variantName != null)
            {
                to.Append(",\"vname\":");
                Json.Text(to, _variantName);
            }

            to.Append(",\"scenes\":");
            ScenesJson(to);
            if (Season() is { } season)
            {
                to.Append(",\"season\":");
                Json.Text(to, season);
            }
        }

        // The season the game shows, which SPT picks by the date: in winter the ground is all under snow, late in autumn
        // and early in spring there are patches of it, and so is a picture taken then. A map captured in one of those is
        // taken again in the first raid that isn't (a map of the season of its own is captured apart: SeasonSuffix).
        internal static string Season()
        {
            try
            {
                var controller = Seasons.Controller;
                return controller != null ? controller.Season.ToString() : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        internal static bool Snowy(string season)
        {
            return SeasonSuffix(season) != null;
        }

        // the map a season with snow has of its own, after the map's key: "@snow" in winter (all under snow),
        // "@lateautumn" and "@earlyspring" (patches of it); null for a season without
        internal static string SeasonSuffix(string season)
        {
            switch (season)
            {
                case "Winter": return "@snow";
                case "AutumnLate": return "@lateautumn";
                case "SpringEarly": return "@earlyspring";
                default: return null;
            }
        }
    }
}
