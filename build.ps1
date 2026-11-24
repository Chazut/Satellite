# Builds Satellite (the server mod and the game plugin), makes the release zips in dist\, and copies the mod
# into your SPT folder.
#   .\build.ps1 -SPTPath D:\SPT
#   .\build.ps1 -SPTPath D:\SPT -NoInstall      (build and zip only)
#   .\build.ps1 -SPTPath D:\SPT -NoMaps         (only the zip without maps: quicker, for trying a change)
#   .\build.ps1 -SPTPath D:\SPT -Recording      (with raid recording: the server's Recorder, the History tab and
#                                               replays. Without it, none of that is built or on the page: it isn't
#                                               in public releases yet)
#   .\build.ps1 -Addons Factory-Classic,Laboratory-Halloween2026
#                                               (only those add-on zips, by the name in the zip's; nothing else is
#                                               built, zipped or installed, so the other zips stay as released)
#   .\build.ps1 -SPTPath D:\SPT -SkipAddons bigmap~backport
#                                               (add-on maps in the SPT folder that aren't released: no zip, and
#                                               not in addons.json)
#   .\build.ps1 -Addons Customs-Classic -AddonVersion 1.0.0
#                                               (the add-on zips under a version of their own: a new add-on's first
#                                               release is 1.0.0 whatever the mod's version is)
# A build for release makes two zips of the mod: Satellite-<version>.zip, with every one of the game's own maps, and
# Satellite-<version>-NoMaps.zip, the same without the maps folder, for updating over a slow or capped line.
# The maps come from the SPT folder's Satellite\maps. A build with maps stops if one of the game's own is missing.
# Each map a mod adds goes in a zip of its own (Satellite-Addon-<map>-<version>.zip), so a player takes only the
# ones for the mods they have: a version of a map ("Interchange~backport") or a map that isn't the game's
# ("Terminal"). An add-on zip holds only SPT_Runtime\user\mods\Satellite\maps\<map>. Factory's day and night maps of
# one version go in one zip ("factory4_day~classic" and "factory4_night~classic": Satellite-Addon-Factory-Classic).
# The plugin is built against the game's own DLLs, so it needs your SPT folder. Instead of -SPTPath you can put the folder's path in a file called spt-path.txt next to this
# script, or in the SPT_PATH environment variable.
param(
    [string] $SPTPath = '',
    [switch] $NoInstall,
    [switch] $NoMaps,
    [switch] $Recording,
    [string[]] $Addons = @(),
    [string] $AddonVersion = '',
    [string[]] $SkipAddons = @()
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$name = 'Satellite'
if (-not $SPTPath) { $SPTPath = $env:SPT_PATH }
$pathFile = Join-Path $root 'spt-path.txt'
if (-not $SPTPath -and (Test-Path -LiteralPath $pathFile)) { $SPTPath = (Get-Content -LiteralPath $pathFile -TotalCount 1).Trim() }
if (-not $SPTPath -or -not (Test-Path (Join-Path $SPTPath 'EscapeFromTarkov_Data'))) {
    throw 'Point the script at your SPT folder (the one with EscapeFromTarkov_Data in it): -SPTPath D:\SPT, or put the path in spt-path.txt.'
}

$serverProject = Join-Path $root "$name.Server\$name.Server.csproj"
$clientProject = Join-Path $root "$name.Client\$name.Client.csproj"

$version = ([xml](Get-Content -LiteralPath $serverProject)).Project.PropertyGroup.Version | Where-Object { $_ } | Select-Object -First 1
$metadataVersion = Select-String -LiteralPath (Join-Path $root "$name.Server\ModMetadata.cs") -Pattern 'Version Version \{ get; init; \} = new\("(.+)"\)' | ForEach-Object { $_.Matches[0].Groups[1].Value }
$pluginVersion = Select-String -LiteralPath (Join-Path $root "$name.Client\Plugin.cs") -Pattern 'const string Version = "(.+)"' | ForEach-Object { $_.Matches[0].Groups[1].Value }
if ($metadataVersion -ne $version -or $pluginVersion -ne $version) {
    throw "Version mismatch: $name.Server.csproj $version, ModMetadata.cs $metadataVersion, Plugin.cs $pluginVersion."
}

$addonsOnly = $Addons.Count -gt 0
if ($addonsOnly -and $NoMaps) { throw '-Addons makes add-on zips, which are maps: leave out -NoMaps.' }
if ($AddonVersion -and $AddonVersion -notmatch '^\d+\.\d+\.\d+$') { throw "-AddonVersion takes a version like 1.0.0, not '$AddonVersion'." }
$addonVersion = if ($AddonVersion) { $AddonVersion } else { $version }

# the SDK may be installed per-user, so it may not be on PATH
$userDotnet = Join-Path $env:LOCALAPPDATA 'Microsoft\dotnet\dotnet.exe'
$dotnet = if (Test-Path $userDotnet) { $userDotnet } else { 'dotnet' }

# Python with Pillow makes the release maps' tiles WebP (tools/webp_tiles.py): checked before anything is built
$python = $null
if (-not $NoMaps) {
    $python = (Get-Command python.exe -All -ErrorAction SilentlyContinue | Where-Object { $_.Source -notmatch 'WindowsApps' } | Select-Object -First 1).Source
    if (-not $python) { throw 'Python is needed to make the maps'' tiles WebP: install it from python.org, then pip install pillow (or build with -NoMaps).' }
    & $python -c 'import PIL' 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Pillow is needed to make the maps' tiles WebP: $python -m pip install pillow (or build with -NoMaps)." }
}

$dist = Join-Path $root 'dist'
if (-not $addonsOnly) {
    & $dotnet build $serverProject -c Release --nologo "-p:Recording=$(if ($Recording) { 'true' } else { 'false' })"
    if ($LASTEXITCODE -ne 0) { throw 'Server build failed.' }
    $serverDll = Join-Path $root "$name.Server\bin\Release\$name.Server.dll"

    # the plugin compiles against the game's own DLLs, from the SPT folder
    & $dotnet build $clientProject -c Release --nologo "-p:SPTPath=$SPTPath"
    if ($LASTEXITCODE -ne 0) { throw 'Plugin build failed.' }
    $clientDll = Join-Path $root "$name.Client\bin\Release\$name.Client.dll"

    # the map scanner: for making the maps, never published, so it's installed here but kept out of dist\ and the zip
    # (it isn't in the public repo, so a build without it skips this)
    $scannerProject = Join-Path $root "$name.Scanner\$name.Scanner.csproj"
    $scannerDll = $null
    if (Test-Path -LiteralPath $scannerProject) {
        & $dotnet build $scannerProject -c Release --nologo "-p:SPTPath=$SPTPath"
        if ($LASTEXITCODE -ne 0) { throw 'Scanner build failed.' }
        $scannerDll = Join-Path $root "$name.Scanner\bin\Release\$name.Scanner.dll"
    }

    # folder and zip laid out like the SPT folder, so the zip can be extracted straight over it
    $stage = Join-Path $dist "$name-$version"
    $mod = Join-Path $stage "SPT_Runtime\user\mods\$name"
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    New-Item -ItemType Directory -Force $mod | Out-Null
    Copy-Item -LiteralPath $serverDll -Destination $mod
    Copy-Item -LiteralPath (Join-Path $root 'web') -Destination $mod -Recurse
    if (-not $Recording) {
        # the page without raid recording (see RECORDING in livemap.js)
        $page = Join-Path $mod 'web\livemap.js'
        $text = [IO.File]::ReadAllText($page)
        $flag = '  const RECORDING = true;'
        if (-not $text.Contains($flag)) { throw "livemap.js has no '$flag' to turn recording off with." }
        [IO.File]::WriteAllText($page, $text.Replace($flag, '  const RECORDING = false;'), (New-Object System.Text.UTF8Encoding $false))
    }
    Copy-Item -LiteralPath (Join-Path $root 'README.md') -Destination $mod
    # config.jsonc isn't packed: the server writes the default the first time it starts, so an update never overwrites
    # the owner's own
    Copy-Item -LiteralPath (Join-Path $root 'LICENSE.md') -Destination $mod
    Copy-Item -LiteralPath (Join-Path $root 'LICENSE-MAPS.md') -Destination $mod
    $plugin = Join-Path $stage "BepInEx\plugins\$name"
    New-Item -ItemType Directory -Force $plugin | Out-Null
    Copy-Item -LiteralPath $clientDll -Destination $plugin
}

Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
# a folder laid out like the SPT folder, zipped; pictures are packed already, so they're stored as they are
function Pack([string] $from, [string] $zip) {
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip }
    $archive = [System.IO.Compression.ZipFile]::Open($zip, 'Create')
    try {
        Get-ChildItem -LiteralPath $from -Recurse -File | ForEach-Object {
            $entry = $_.FullName.Substring($from.Length + 1).Replace('\', '/')
            $level = if ($_.Extension -in '.webp', '.png', '.jpg') { 'NoCompression' } else { 'Optimal' }
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $entry, $level) | Out-Null
        }
    }
    finally {
        $archive.Dispose()
    }
    Write-Host "Packed $zip"
}

# an add-on's name in its zip's: "Interchange~backport" is Interchange-Backport
function Label([string] $loc) {
    ($loc -split '~' | ForEach-Object { $_.Substring(0, 1).ToUpper() + $_.Substring(1) }) -join '-'
}

# the zip an add-on map goes in: its own, but Factory's day and night maps of one version share one ("Factory-Classic"),
# and a version of Customs goes by the map's name, not its location id ("bigmap~classic": "Customs-Classic")
function AddonZip([string] $loc) {
    if ($loc -match '^factory4_(day|night)(~.+)$') { return "$name-Addon-$(Label ('factory' + $Matches[2]))" }
    if ($loc -match '^bigmap(~.+)$') { return "$name-Addon-$(Label ('customs' + $Matches[1]))" }
    # (Tutorial-Backport's location: by what it is, not its id)
    if ($loc -ceq 'Sandbox_start') { return "$name-Addon-Tutorial" }
    "$name-Addon-$(Label $loc)"
}

# A map's tiles in one file, maps/<location>/<v>/tiles.pack, in place of its thousands of .jpg files, so the zip
# unzips quickly (the server reads either; see Satellite.Server/TilePacks.cs for the layout). Done to the copy in
# dist\ only. A capture's tiles are packed by the server once it's complete, so a map packed already is left as it is
# (no loose tiles to pack); one with loose tiles (captured before that) is packed here. Each pack is read back and
# checked against the tiles it was made from before they're deleted.
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.IO;
using System.Linq;
using System.Text;
public static class SatelliteTiles {
    public static int Pack(string folder) {
        var files = Directory.GetFiles(folder, "*.jpg").OrderBy(f => Path.GetFileName(f), StringComparer.Ordinal).ToArray();
        // packed by the server already: the pack is what's served, so any tile left beside it is dropped from the copy
        if (File.Exists(Path.Combine(folder, "tiles.pack"))) {
            foreach (var f in files) File.Delete(f);
            return 0;
        }
        if (files.Length == 0) return 0;
        var names = files.Select(f => Encoding.ASCII.GetBytes(Path.GetFileName(f))).ToArray();
        long offset = 8 + 4;
        foreach (var n in names) {
            if (n.Length > 255) throw new Exception("tile name too long: " + Encoding.ASCII.GetString(n));
            offset += 1 + n.Length + 8 + 4;
        }
        var pack = Path.Combine(folder, "tiles.pack");
        using (var w = new BinaryWriter(File.Create(pack))) {
            w.Write(Encoding.ASCII.GetBytes("SATTILE1"));
            w.Write(files.Length);
            for (var i = 0; i < files.Length; i++) {
                var length = new FileInfo(files[i]).Length;
                w.Write((byte)names[i].Length); w.Write(names[i]); w.Write(offset); w.Write((int)length);
                offset += length;
            }
            foreach (var f in files) w.Write(File.ReadAllBytes(f));
        }
        // read it back as the server does: every tile there, byte for byte
        using (var r = new BinaryReader(File.OpenRead(pack))) {
            if (Encoding.ASCII.GetString(r.ReadBytes(8)) != "SATTILE1" || r.ReadInt32() != files.Length) throw new Exception("bad pack header: " + pack);
            for (var i = 0; i < files.Length; i++) {
                var name = Encoding.ASCII.GetString(r.ReadBytes(r.ReadByte()));
                var at = r.ReadInt64(); var length = r.ReadInt32();
                if (name != Path.GetFileName(files[i])) throw new Exception("pack index out of order: " + pack);
                var back = r.BaseStream.Position;
                r.BaseStream.Position = at;
                var bytes = r.ReadBytes(length);
                r.BaseStream.Position = back;
                if (!bytes.SequenceEqual(File.ReadAllBytes(files[i]))) throw new Exception("tile differs in pack: " + files[i]);
            }
        }
        foreach (var f in files) File.Delete(f);
        return files.Length;
    }
}
'@
# the most pixels a metre a shrunk map keeps (see tools/webp_tiles.py): 12 looks the same as the 16 captured
$shrinkPxPerMetre = 12
function PackTiles([string] $mapsDir, [switch] $Shrink) {
    foreach ($map in Get-ChildItem -LiteralPath $mapsDir -Directory) {
        $versions = @(Get-ChildItem -LiteralPath $map.FullName -Directory)
        if ($versions.Count -ne 1) { throw "$($map.Name) has $($versions.Count) capture folders; it should have one." }
        [SatelliteTiles]::Pack($versions[0].FullName) | Out-Null
    }
    # then the tiles WebP, half the size of the JPEGs captured (tools/webp_tiles.py; a pack that's WebP already is
    # only read). A release is never made with JPEG tiles: no Python or Pillow stops the build. With -Shrink (the
    # game's own maps and the backports), this copy is also made smaller first: sharp enough, and each floor's tiles
    # blank outside the buildings, which the page never shows. The scans in the SPT folder stay as they are.
    if ($Shrink) {
        & $python (Join-Path $root 'tools\webp_tiles.py') $mapsDir --most-px-per-metre $shrinkPxPerMetre
    } else {
        & $python (Join-Path $root 'tools\webp_tiles.py') $mapsDir
    }
    if ($LASTEXITCODE -ne 0) { throw "Couldn't make the tiles in $mapsDir WebP." }
}

# the game's own locations; any other map (a version of one, after a "~", or a map a mod adds) is an add-on
$gameMaps = 'bigmap', 'factory4_day', 'factory4_night', 'Interchange', 'laboratory', 'Labyrinth', 'Lighthouse',
    'RezervBase', 'Sandbox', 'Sandbox_high', 'Shoreline', 'TarkovStreets', 'Woods'
$addonFolders = @()
$snowMaps = @()
$mapsFrom = Join-Path $SPTPath "SPT_Runtime\user\mods\$name\maps"
if (-not $NoMaps) {
    if (-not (Test-Path -LiteralPath $mapsFrom)) { throw "No maps in $mapsFrom. Scan them first, or build with -NoMaps." }
    # a release always has every one of the game's own maps: stop before anything is packed if one is missing
    $lacking = @($gameMaps | Where-Object { -not (Test-Path -LiteralPath (Join-Path $mapsFrom "$_\meta.json")) })
    if ($lacking.Count) { throw "No map of $($lacking -join ', ') in $mapsFrom. Scan them first, or build with -NoMaps." }
    $addonFolders = @(Get-ChildItem -LiteralPath $mapsFrom -Directory | Where-Object { $gameMaps -cnotcontains $_.Name -and -not $_.Name.Contains('@') -and $SkipAddons -notcontains $_.Name })
    # the maps of a season with snow on the ground ("<map>@snow", "<map>@lateautumn", "<map>@earlyspring"): each
    # season's in one add-on, and not in addons.json (without one, the page shows the map itself, so there's nothing
    # to tell a player they're missing)
    $snowMaps = @(Get-ChildItem -LiteralPath $mapsFrom -Directory | Where-Object { $_.Name.Contains('@') -and $SkipAddons -notcontains $_.Name })

    # addons.json: what tells each add-on in a raid (its scenes) and the zip it comes in, so the server can say which
    # add-on a player is missing. Kept next to this script, so a build with -NoMaps still has it.
    $catalog = foreach ($map in $addonFolders) {
        $meta = Get-Content -LiteralPath (Join-Path $map.FullName 'meta.json') -Raw | ConvertFrom-Json
        if (-not $meta.scenes) { Write-Warning "$($map.Name) was captured without its scenes: a raid on it can't be told."; continue }
        $entry = [ordered]@{ loc = $map.Name; base = $meta.base; name = $meta.name }
        if ($meta.vname) { $entry.vname = $meta.vname }
        $entry.zip = AddonZip $map.Name
        $entry.scenes = @($meta.scenes)
        [pscustomobject]$entry
    }
    $json = ConvertTo-Json -InputObject ([ordered]@{ addons = @($catalog) }) -Depth 4
    [IO.File]::WriteAllText((Join-Path $root 'addons.json'), $json + "`n", (New-Object Text.UTF8Encoding $false))
}
if (-not $addonsOnly -and (Test-Path -LiteralPath (Join-Path $root 'addons.json'))) { Copy-Item -LiteralPath (Join-Path $root 'addons.json') -Destination $mod }

# the mod without its maps first, then the same with the game's own maps added
if (-not $addonsOnly) { Pack $stage (Join-Path $dist "$name-$version-NoMaps.zip") }
if (-not $NoMaps -and -not $addonsOnly) {
    $mapsTo = Join-Path $mod 'maps'
    New-Item -ItemType Directory -Force $mapsTo | Out-Null
    foreach ($game in $gameMaps) { Copy-Item -LiteralPath (Join-Path $mapsFrom $game) -Destination $mapsTo -Recurse }
    PackTiles $mapsTo -Shrink
    Pack $stage (Join-Path $dist "$name-$version.zip")
}

# each add-on: only its maps' folders, where the mod keeps its maps, their tiles packed like the game's own maps'
$groups = @($addonFolders | Group-Object { AddonZip $_.Name })
if ($addonsOnly) {
    $wanted = @($Addons | ForEach-Object { "$name-Addon-$_" })
    $unknown = @($wanted | Where-Object { $groups.Name -notcontains $_ })
    if ($unknown.Count) { throw "No add-on $($unknown -join ', '). There are: $(($groups.Name | ForEach-Object { $_.Substring("$name-Addon-".Length) }) -join ', ')." }
    $groups = @($groups | Where-Object { $wanted -contains $_.Name })
}
foreach ($group in $groups) {
    $addonStage = Join-Path $dist "$($group.Name)-$addonVersion"
    if (Test-Path -LiteralPath $addonStage) { Remove-Item -LiteralPath $addonStage -Recurse -Force }
    $addonMaps = Join-Path $addonStage "SPT_Runtime\user\mods\$name\maps"
    New-Item -ItemType Directory -Force $addonMaps | Out-Null
    foreach ($map in $group.Group) { Copy-Item -LiteralPath $map.FullName -Destination $addonMaps -Recurse }
    # the backports are shrunk like the game's own maps; the other add-ons (classic, events, a mod's own map) aren't
    $backport = @($group.Group | Where-Object { $_.Name -like '*~backport' }).Count -eq $group.Group.Count
    PackTiles $addonMaps -Shrink:$backport
    Pack $addonStage (Join-Path $dist "$($group.Name)-$addonVersion.zip")
}

# the season add-ons: each season's maps in one zip (Snow, LateAutumn, EarlySpring)
$seasonZips = [ordered]@{ '@snow' = 'Snow'; '@lateautumn' = 'LateAutumn'; '@earlyspring' = 'EarlySpring' }
foreach ($season in $seasonZips.Keys) {
    $seasonMaps = @($snowMaps | Where-Object { $_.Name.EndsWith($season) })
    if (-not $seasonMaps.Count -or $addonsOnly) { continue }
    $label = $seasonZips[$season]
    $snowStage = Join-Path $dist "$name-Addon-$label-$version"
    if (Test-Path -LiteralPath $snowStage) { Remove-Item -LiteralPath $snowStage -Recurse -Force }
    $snowTo = Join-Path $snowStage "SPT_Runtime\user\mods\$name\maps"
    New-Item -ItemType Directory -Force $snowTo | Out-Null
    foreach ($map in $seasonMaps) { Copy-Item -LiteralPath $map.FullName -Destination $snowTo -Recurse }
    PackTiles $snowTo
    Pack $snowStage (Join-Path $dist "$name-Addon-$label-$version.zip")
}

if (-not $NoInstall -and -not $addonsOnly) {
    if (-not (Test-Path (Join-Path $SPTPath 'SPT_Runtime\SPT.Server.dll'))) {
        throw "$SPTPath doesn't look like an SPT folder (no SPT_Runtime\SPT.Server.dll)."
    }
    $dest = Join-Path $SPTPath "SPT_Runtime\user\mods\$name"
    New-Item -ItemType Directory -Force $dest | Out-Null

    # a running server locks the DLL, so an unchanged one is left alone
    $installedDll = Join-Path $dest "$name.Server.dll"
    $sameDll = (Test-Path $installedDll) -and (Get-FileHash $installedDll).Hash -eq (Get-FileHash $serverDll).Hash
    # the maps came from there, so they're not copied back
    Get-ChildItem -LiteralPath $mod |
        Where-Object { $_.Name -ne 'maps' } |
        Where-Object { -not ($sameDll -and $_.Name -eq "$name.Server.dll") } |
        ForEach-Object {
            $file = $_
            try { Copy-Item -LiteralPath $file.FullName -Destination $dest -Recurse -Force -ErrorAction Stop }
            catch { throw "Couldn't copy $($file.Name) into $dest. Stop the SPT server and build again. ($($_.Exception.Message))" }
        }
    Write-Host "Installed the server mod to $dest$(if ($sameDll) { ' (server DLL unchanged)' })"

    # a running game locks the plugin
    $pluginDest = Join-Path $SPTPath "BepInEx\plugins\$name"
    New-Item -ItemType Directory -Force $pluginDest | Out-Null
    try { Copy-Item -LiteralPath $clientDll -Destination $pluginDest -Force -ErrorAction Stop; Write-Host "Installed the plugin to $pluginDest" }
    catch { Write-Warning "Couldn't copy the plugin into $pluginDest. Close the game and build again. ($($_.Exception.Message))" }

    if ($scannerDll) {
        $scannerDest = Join-Path $SPTPath "BepInEx\plugins\$name.Scanner"
        New-Item -ItemType Directory -Force $scannerDest | Out-Null
        # with the tool that works the buildings' outlines out after each capture (it needs Node.js)
        Copy-Item -LiteralPath (Join-Path $root 'tools\outlines.js') -Destination $scannerDest -Force
        # and the one that makes each map's tiles WebP once it's captured (it needs Python with Pillow)
        Copy-Item -LiteralPath (Join-Path $root 'tools\webp_tiles.py') -Destination $scannerDest -Force
        try { Copy-Item -LiteralPath $scannerDll -Destination $scannerDest -Force -ErrorAction Stop; Write-Host "Installed the map scanner to $scannerDest" }
        catch { Write-Warning "Couldn't copy the map scanner into $scannerDest. Close the game and build again. ($($_.Exception.Message))" }
    }
}
