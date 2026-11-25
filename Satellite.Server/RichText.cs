using System.Text.RegularExpressions;

namespace Satellite.Server;

// Some mods dress the game's item names in the game's rich text: "<b><color=#ff8000>M4A1 (44/36)</color></b>". The
// game draws that; a page would show the tags. Only the tags the game knows are taken out (a name can hold a "<" of
// its own), and only from Satellite's own copy of the texts.
internal static partial class RichText
{
    [GeneratedRegex(@"</?(?:b|i|u|s|size|colou?r|alpha|mark|sup|sub|font|material|noparse|sprite|nobr|lowercase|uppercase|smallcaps|style|link|cspace|mspace|voffset|indent|line-height|pos|rotate|margin|gradient|width)(?:\s*=\s*(?:""[^""<>]*""|'[^'<>]*'|[^<>\s]*)|\s+[^<>]*)?>|<#[0-9a-fA-F]{3,8}>",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Tags();

    // the text without its tags (as it was if it has none)
    public static string Plain(string text) =>
        string.IsNullOrEmpty(text) || text.IndexOf('<') < 0 ? text : Tags().Replace(text, "").Trim();

    [GeneratedRegex(@"<colou?r\s*=\s*[""']?(#[0-9a-f]{3,8}|[a-z]+)[""']?\s*>|<(#[0-9a-f]{3,8})>", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ColourTag();

    // the colour names the game's rich text knows, which a page knows by the same names
    private static readonly HashSet<string> Named = new(StringComparer.OrdinalIgnoreCase)
    {
        "aqua", "black", "blue", "brown", "cyan", "darkblue", "fuchsia", "green", "grey", "lightblue", "lime", "magenta",
        "maroon", "navy", "olive", "orange", "purple", "red", "silver", "teal", "white", "yellow"
    };

    // The colour the text's first colour tag gives it ("#ff8000", "orange"), for the page to show it in (lower case);
    // null: none, or one a page couldn't show
    public static string? Colour(string text)
    {
        if (string.IsNullOrEmpty(text) || text.IndexOf('<') < 0 || ColourTag().Match(text) is not { Success: true } found)
        {
            return null;
        }

        var colour = (found.Groups[1].Success ? found.Groups[1].Value : found.Groups[2].Value).ToLowerInvariant();
        return colour[0] == '#' ? colour.Length is 4 or 5 or 7 or 9 ? colour : null : Named.Contains(colour) ? colour : null;
    }
}
