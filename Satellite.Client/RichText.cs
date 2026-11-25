using System.Text.RegularExpressions;

namespace Satellite.Client
{
    // Some mods dress the game's item names in the game's rich text: "<b><color=#ff8000>M4A1 (44/36)</color></b>". The
    // game draws that; a page would show the tags. Only the tags the game knows are taken out (a name can hold a "<" of
    // its own), and only from what Satellite sends: the game's own texts stay as they are.
    internal static class RichText
    {
        private static readonly Regex Tags = new Regex(
            @"</?(?:b|i|u|s|size|colou?r|alpha|mark|sup|sub|font|material|noparse|sprite|nobr|lowercase|uppercase|smallcaps|style|link|cspace|mspace|voffset|indent|line-height|pos|rotate|margin|gradient|width)(?:\s*=\s*(?:""[^""<>]*""|'[^'<>]*'|[^<>\s]*)|\s+[^<>]*)?>|<#[0-9a-fA-F]{3,8}>",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

        // the text without its tags (as it was if it has none)
        public static string Plain(string text) =>
            string.IsNullOrEmpty(text) || text.IndexOf('<') < 0 ? text : Tags.Replace(text, "").Trim();
    }
}
