# Builds Satellite (the server mod and the game plugin), makes the release zips in dist\, and copies the mod
# into your SPT folder.
#   .\build.ps1 -SPTPath D:\SPT
#   .\build.ps1 -SPTPath D:\SPT -NoInstall      (build and zip only)
#   .\build.ps1 -SPTPath D:\SPT -NoMaps         (only the zip without maps: quicker, for trying a change)
# A build for release makes two zips of the mod: Satellite-<version>.zip, with every one of the game's own maps, and
# Satellite-<version>-NoMaps.zip, the same without the maps folder, for updating over a slow or capped line.
# The maps come from the SPT folder's Satellite\maps. A build with maps stops if one of the game's own is missing.
# Each map a mod adds goes in a zip of its own (Satellite-Addon-<map>-<version>.zip), so a player takes only the
# ones for the mods they have: a version of a map ("Interchange~backport") or a map that isn't the game's
# ("Terminal"). An add-on zip holds only SPT_Runtime\user\mods\Satellite\maps\<map>.
# The plugin is built against the game's own DLLs, so it needs your SPT folder. Instead of -SPTPath you can put the folder's path in a file called spt-path.txt next to this
# script, or in the SPT_PATH environment variable.
param(
    [string] $SPTPath = '',
    [switch] $NoInstall,
    [switch] $NoMaps
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

# the SDK may be installed per-user, so it may not be on PATH
$userDotnet = Join-Path $env:LOCALAPPDATA 'Microsoft\dotnet\dotnet.exe'
$dotnet = if (Test-Path $userDotnet) { $userDotnet } else { 'dotnet' }

& $dotnet build $serverProject -c Release --nologo
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
$dist = Join-Path $root 'dist'
$stage = Join-Path $dist "$name-$version"
$mod = Join-Path $stage "SPT_Runtime\user\mods\$name"
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force $mod | Out-Null
Copy-Item -LiteralPath $serverDll -Destination $mod
Copy-Item -LiteralPath (Join-Path $root 'web') -Destination $mod -Recurse
Copy-Item -LiteralPath (Join-Path $root 'README.md') -Destination $mod
# config.jsonc isn't packed: the server writes the default the first time it starts, so an update never overwrites
# the owner's own
Copy-Item -LiteralPath (Join-Path $root 'LICENSE.md') -Destination $mod
Copy-Item -LiteralPath (Join-Path $root 'LICENSE-MAPS.md') -Destination $mod
$plugin = Join-Path $stage "BepInEx\plugins\$name"
New-Item -ItemType Directory -Force $plugin | Out-Null
Copy-Item -LiteralPath $clientDll -Destination $plugin

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

# A map's tiles in one file, maps/<location>/<v>/tiles.pack, in place of its thousands of .jpg files, so the zip
# unzips quickly (the server reads either; see Satellite.Server/TilePacks.cs for the layout). Only ever done to the
# copy in dist\, never to the SPT folder's maps, which captures write to and builds read from. Each pack is read back
# and checked against the tiles it was made from before they're deleted.
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.IO;
using System.Linq;
using System.Text;
public static class SatelliteTiles {
    public static int Pack(string folder) {
        var files = Directory.GetFiles(folder, "*.jpg").OrderBy(f => Path.GetFileName(f), StringComparer.Ordinal).ToArray();
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
function PackTiles([string] $mapsDir) {
    foreach ($map in Get-ChildItem -LiteralPath $mapsDir -Directory) {
        $versions = @(Get-ChildItem -LiteralPath $map.FullName -Directory)
        if ($versions.Count -ne 1) { throw "$($map.Name) has $($versions.Count) capture folders; it should have one." }
        [SatelliteTiles]::Pack($versions[0].FullName) | Out-Null
    }
}

# the game's own locations; any other map (a version of one, after a "~", or a map a mod adds) is an add-on
$gameMaps = 'bigmap', 'factory4_day', 'factory4_night', 'Interchange', 'laboratory', 'Labyrinth', 'Lighthouse',
    'RezervBase', 'Sandbox', 'Sandbox_high', 'Shoreline', 'TarkovStreets', 'Woods'
$addons = @()
$snowMaps = @()
$mapsFrom = Join-Path $SPTPath "SPT_Runtime\user\mods\$name\maps"
if (-not $NoMaps) {
    if (-not (Test-Path -LiteralPath $mapsFrom)) { throw "No maps in $mapsFrom. Scan them first, or build with -NoMaps." }
    # a release always has every one of the game's own maps: stop before anything is packed if one is missing
    $lacking = @($gameMaps | Where-Object { -not (Test-Path -LiteralPath (Join-Path $mapsFrom "$_\meta.json")) })
    if ($lacking.Count) { throw "No map of $($lacking -join ', ') in $mapsFrom. Scan them first, or build with -NoMaps." }
    $addons = @(Get-ChildItem -LiteralPath $mapsFrom -Directory | Where-Object { $gameMaps -cnotcontains $_.Name -and -not $_.Name.EndsWith('@snow') })
    # the maps with snow on the ground ("<map>@snow"): all in one add-on, and not in addons.json (without one, the
    # page shows the map without snow, so there's nothing to tell a player they're missing)
    $snowMaps = @(Get-ChildItem -LiteralPath $mapsFrom -Directory | Where-Object { $_.Name.EndsWith('@snow') })

    # addons.json: what tells each add-on in a raid (its scenes) and the zip it comes in, so the server can say which
    # add-on a player is missing. Kept next to this script, so a build with -NoMaps still has it.
    $catalog = foreach ($map in $addons) {
        $meta = Get-Content -LiteralPath (Join-Path $map.FullName 'meta.json') -Raw | ConvertFrom-Json
        if (-not $meta.scenes) { Write-Warning "$($map.Name) was captured without its scenes: a raid on it can't be told."; continue }
        $entry = [ordered]@{ loc = $map.Name; base = $meta.base; name = $meta.name }
        if ($meta.vname) { $entry.vname = $meta.vname }
        $entry.zip = "$name-Addon-$(Label $map.Name)"
        $entry.scenes = @($meta.scenes)
        [pscustomobject]$entry
    }
    $json = ConvertTo-Json -InputObject ([ordered]@{ addons = @($catalog) }) -Depth 4
    [IO.File]::WriteAllText((Join-Path $root 'addons.json'), $json + "`n", (New-Object Text.UTF8Encoding $false))
}
if (Test-Path -LiteralPath (Join-Path $root 'addons.json')) { Copy-Item -LiteralPath (Join-Path $root 'addons.json') -Destination $mod }

# the mod without its maps first, then the same with the game's own maps added
Pack $stage (Join-Path $dist "$name-$version-NoMaps.zip")
if (-not $NoMaps) {
    $mapsTo = Join-Path $mod 'maps'
    New-Item -ItemType Directory -Force $mapsTo | Out-Null
    foreach ($game in $gameMaps) { Copy-Item -LiteralPath (Join-Path $mapsFrom $game) -Destination $mapsTo -Recurse }
    PackTiles $mapsTo
    Pack $stage (Join-Path $dist "$name-$version.zip")
}

# each add-on: only its map's folder, where the mod keeps its maps, its tiles packed like the game's own maps'
foreach ($map in $addons) {
    $label = Label $map.Name
    $addonStage = Join-Path $dist "$name-Addon-$label-$version"
    if (Test-Path -LiteralPath $addonStage) { Remove-Item -LiteralPath $addonStage -Recurse -Force }
    $addonMaps = Join-Path $addonStage "SPT_Runtime\user\mods\$name\maps"
    New-Item -ItemType Directory -Force $addonMaps | Out-Null
    Copy-Item -LiteralPath $map.FullName -Destination $addonMaps -Recurse
    PackTiles $addonMaps
    Pack $addonStage (Join-Path $dist "$name-Addon-$label-$version.zip")
}

# the snow add-on: every snow map in one zip
if ($snowMaps.Count) {
    $snowStage = Join-Path $dist "$name-Addon-Snow-$version"
    if (Test-Path -LiteralPath $snowStage) { Remove-Item -LiteralPath $snowStage -Recurse -Force }
    $snowTo = Join-Path $snowStage "SPT_Runtime\user\mods\$name\maps"
    New-Item -ItemType Directory -Force $snowTo | Out-Null
    foreach ($map in $snowMaps) { Copy-Item -LiteralPath $map.FullName -Destination $snowTo -Recurse }
    PackTiles $snowTo
    Pack $snowStage (Join-Path $dist "$name-Addon-Snow-$version.zip")
}

if (-not $NoInstall) {
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
        try { Copy-Item -LiteralPath $scannerDll -Destination $scannerDest -Force -ErrorAction Stop; Write-Host "Installed the map scanner to $scannerDest" }
        catch { Write-Warning "Couldn't copy the map scanner into $scannerDest. Close the game and build again. ($($_.Exception.Message))" }
    }
}
