using SPTarkov.Server.Core.Models.Spt.Mod;
using SPTarkov.Server.Web;

namespace Satellite.Server;

public record ModMetadata : IModMetadata, IModBlazorMetadata
{
    public string ModGuid { get; init; } = "com.fums.satellite";
    public string Name { get; init; } = "Satellite";
    public string Author { get; init; } = "Fums";
    public List<string>? Contributors { get; init; }
    public SemanticVersioning.Version Version { get; init; } = new("1.0.0");
    public SemanticVersioning.Range SptVersion { get; init; } = new("~4.1.0");
    public bool HasPrepatcher { get; init; } = false;
    public List<string>? Incompatibilities { get; init; }
    public Dictionary<string, SemanticVersioning.Range>? ModDependencies { get; init; }
    public string? Url { get; init; }
    public bool? IsBundleMod { get; init; } = false;
    public string License { get; init; } = "MIT";

    // Lists the map under Mod Pages in the launcher and on SPT's web page.
    public string? WWWRootUrl { get; init; }
    public string? HomePage { get; init; } = "/satellite";
    public string? HomePageDescription { get; init; } = "The live map of your raid, in your browser.";
}
