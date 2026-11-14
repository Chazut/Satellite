using System;
using System.Collections.Generic;
using System.Text;
using UnityEngine;

namespace Satellite.Client
{
    // Things that happen in a raid, each said once, beside the report of where everybody is (which only says how the
    // raid is now). Every one has the raid it belongs to, its number in that raid, when on the raid's clock it
    // happened, its kind and whose it is: {"n":12,"t":83400,"k":"comet.squad","p":"<profile id>","nm":"<name>","d":{...}}.
    // They ride the next full report (",\"rid\":\"...\",\"clk\":83950,\"ev\":[...]") and the server keeps the raid's
    // latest for a page opened later. Nothing is kept here while nobody is looking.
    internal static class Events
    {
        private const int Most = 200;

        private static readonly List<string> Waiting = new List<string>();
        private static readonly StringBuilder One = new StringBuilder(256);
        private static string _raid = "";
        private static float _began;
        private static long _number;
        private static bool _in;

        // the raid these belong to: a new id each raid, empty out of one
        internal static string Raid => _raid;

        // told at every report whether the game is in a raid: a raid's id and clock start when it's first seen in one
        internal static void Tick(bool raid)
        {
            if (raid == _in)
            {
                return;
            }

            _in = raid;
            Waiting.Clear();
            _number = 0;
            _raid = raid ? Guid.NewGuid().ToString("N") : "";
            _began = Time.realtimeSinceStartup;
            Brains.Forget();
        }

        // milliseconds on the raid's clock at a moment of the game's own (Time.realtimeSinceStartup)
        private static long Clock(float realtime)
        {
            return Math.Max(0L, (long)((realtime - _began) * 1000f));
        }

        // detail writes the event's own part, a JSON object
        internal static void Add(string kind, string profileId, string name, float realtime, Action<StringBuilder> detail)
        {
            if (!_in || detail == null)
            {
                return;
            }

            One.Length = 0;
            One.Append("{\"n\":").Append(++_number).Append(",\"t\":").Append(Clock(realtime)).Append(",\"k\":");
            World.Text(One, kind);
            if (!string.IsNullOrEmpty(profileId))
            {
                One.Append(",\"p\":");
                World.Text(One, profileId);
            }

            if (!string.IsNullOrEmpty(name))
            {
                One.Append(",\"nm\":");
                World.Text(One, name);
            }

            One.Append(",\"d\":");
            detail(One);
            One.Append('}');
            if (Waiting.Count >= Most)
            {
                Waiting.RemoveAt(0);
            }

            Waiting.Add(One.ToString());
        }

        // into a full report: the raid, its clock now, and what happened since the last one
        internal static void Take(StringBuilder to)
        {
            if (!_in)
            {
                return;
            }

            to.Append(",\"rid\":");
            World.Text(to, _raid);
            to.Append(",\"clk\":").Append(Clock(Time.realtimeSinceStartup));
            if (Waiting.Count == 0)
            {
                return;
            }

            to.Append(",\"ev\":[");
            for (var i = 0; i < Waiting.Count; i++)
            {
                if (i > 0)
                {
                    to.Append(',');
                }

                to.Append(Waiting[i]);
            }

            to.Append(']');
            Waiting.Clear();
        }
    }
}
