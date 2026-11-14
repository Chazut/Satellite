using System;
using System.Globalization;
using System.Text;
using Newtonsoft.Json;

namespace Satellite.Shared
{
    // JSON written by hand into a StringBuilder: the reports are made several times a second, so no objects in between.
    // Shared by the web map plugin and the map scanner (each compiles this file in).
    internal static class Json
    {
        internal static void Number(StringBuilder to, float value)
        {
            if (float.IsNaN(value) || float.IsInfinity(value))
            {
                to.Append('0');
                return;
            }

            to.Append(Math.Round(value, 2).ToString(CultureInfo.InvariantCulture));
        }

        internal static void Text(StringBuilder to, string value)
        {
            to.Append(JsonConvert.ToString(value ?? ""));
        }
    }
}
