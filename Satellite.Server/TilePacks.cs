using System.Collections.Concurrent;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http;

namespace Satellite.Server;

// A map's tiles, as they're sent to the page: from maps/<location>/<v>/tiles.pack when there is one (how the release
// zips ship them, so there are a few dozen files to unzip, not thousands), else from the loose .jpg files (how a
// capture sends them, one by one; PackLoose joins them into the pack once the capture is complete).
//
// tiles.pack, little-endian:
//   "SATTILE1"                                    8 bytes
//   count                                         int32
//   count times: name length (byte), name (ASCII, as "0_1_f1_s.jpg"), offset from the file's start (int64), length (int32)
//   the tiles' bytes, one after another: JPEG as captured, WebP in the release zips (tools/webp_tiles.py)
public partial class LiveMapRoute
{
    private const string PackName = "tiles.pack";
    private const string PackMagic = "SATTILE1";
    private const int MostInPack = 100_000;

    private sealed record PackIndex(long Length, DateTime Written, Dictionary<string, (long Offset, int Length)> Tiles);

    // read once for each pack, again when the file changes (an update put over it)
    private static readonly ConcurrentDictionary<string, PackIndex> Packs = new(StringComparer.OrdinalIgnoreCase);
    private static readonly ConcurrentDictionary<string, byte> BadPacks = new(StringComparer.OrdinalIgnoreCase);

    [GeneratedRegex("^[0-9]{1,2}_[0-9]{1,2}(_f[0-9]{1,2})?(_s)?\\.jpg$")]
    private static partial Regex TileName();

    // map/<location>/<v>/<x>_<y>.jpg: a tile. Its address changes with every capture, so a browser may keep it.
    private async Task SendTile(HttpContext context, string relative, CancellationToken cancellationToken)
    {
        var parts = Uri.UnescapeDataString(relative).Split('/');
        byte[]? bytes = null;
        if (parts.Length == 3 && LocationName().IsMatch(parts[0]) && VersionName().IsMatch(parts[1]) && TileName().IsMatch(parts[2]))
        {
            var folder = Path.Combine(MapsFolder, parts[0], parts[1]);
            var pack = Path.Combine(folder, PackName);
            if (File.Exists(pack))
            {
                bytes = await FromPack(pack, parts[2], cancellationToken);
            }

            var loose = Path.Combine(folder, parts[2]);
            if (bytes == null && File.Exists(loose))
            {
                bytes = await File.ReadAllBytesAsync(loose, cancellationToken);
            }
        }

        if (bytes == null)
        {
            context.Response.StatusCode = 404;
            return;
        }

        // a tile is named .jpg whatever it is: the release maps' are WebP (tools/webp_tiles.py), a capture's JPEG
        context.Response.ContentType = IsWebP(bytes) ? "image/webp" : "image/jpeg";
        context.Response.Headers.XContentTypeOptions = "nosniff";
        context.Response.Headers.CacheControl = "public, max-age=31536000, immutable";
        await context.Response.Body.WriteAsync(bytes, cancellationToken);
    }

    // "RIFF", its length, "WEBP"
    private static bool IsWebP(byte[] bytes) =>
        bytes.Length >= 12 && bytes.AsSpan(0, 4).SequenceEqual("RIFF"u8) && bytes.AsSpan(8, 4).SequenceEqual("WEBP"u8);

    // a tile's bytes from a pack; null: not in it (or the pack can't be read, and the loose file is tried)
    private async Task<byte[]?> FromPack(string pack, string name, CancellationToken cancellationToken)
    {
        try
        {
            var info = new FileInfo(pack);
            if (!Packs.TryGetValue(pack, out var index) || index.Length != info.Length || index.Written != info.LastWriteTimeUtc)
            {
                index = ReadIndex(pack, info);
                Packs[pack] = index;
            }

            if (!index.Tiles.TryGetValue(name, out var at))
            {
                return null;
            }

            // a handle of its own for each tile: tiles are asked for many at once
            using var handle = File.OpenHandle(pack, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete, FileOptions.Asynchronous);
            var bytes = new byte[at.Length];
            var done = 0;
            while (done < bytes.Length)
            {
                var read = await RandomAccess.ReadAsync(handle, bytes.AsMemory(done), at.Offset + done, cancellationToken);
                if (read == 0)
                {
                    return null;
                }

                done += read;
            }

            return bytes;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidDataException)
        {
            // once for each pack, not for each tile
            if (BadPacks.TryAdd(pack, 0))
            {
                logger.Warning($"[Satellite] Couldn't read {pack}: {ex.Message}");
            }

            return null;
        }
    }

    // A finished capture's loose tiles joined into the folder's tiles.pack, as the release zips have them, and then
    // deleted. Written beside it first and read back tile for tile before it takes the pack's name (SendTile prefers a
    // pack as soon as there is one). False, and the loose tiles kept (they're served as they are), when it went wrong.
    private bool PackLoose(string folder)
    {
        var files = Directory.GetFiles(folder, "*.jpg")
            .Where(f => TileName().IsMatch(Path.GetFileName(f)))
            .OrderBy(f => Path.GetFileName(f), StringComparer.Ordinal)
            .ToArray();
        if (files.Length == 0 || files.Length > MostInPack)
        {
            return false;
        }

        var pack = Path.Combine(folder, PackName);
        var partial = pack + ".part";
        try
        {
            var names = files.Select(f => Encoding.ASCII.GetBytes(Path.GetFileName(f))).ToArray();
            var lengths = new int[files.Length];
            long offset = PackMagic.Length + 4;
            foreach (var name in names)
            {
                offset += 1 + name.Length + 8 + 4;
            }

            using (var writer = new BinaryWriter(new FileStream(partial, FileMode.Create, FileAccess.Write, FileShare.None)))
            {
                writer.Write(Encoding.ASCII.GetBytes(PackMagic));
                writer.Write(files.Length);
                for (var i = 0; i < files.Length; i++)
                {
                    lengths[i] = checked((int)new FileInfo(files[i]).Length);
                    writer.Write((byte)names[i].Length);
                    writer.Write(names[i]);
                    writer.Write(offset);
                    writer.Write(lengths[i]);
                    offset += lengths[i];
                }

                foreach (var file in files)
                {
                    writer.Write(File.ReadAllBytes(file));
                }
            }

            // read back as SendTile reads it: every tile there, byte for byte
            var index = ReadIndex(partial, new FileInfo(partial));
            using (var stream = new FileStream(partial, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                for (var i = 0; i < files.Length; i++)
                {
                    var name = Path.GetFileName(files[i]);
                    if (!index.Tiles.TryGetValue(name, out var at) || at.Length != lengths[i])
                    {
                        throw new InvalidDataException($"{name} missing from the pack");
                    }

                    var bytes = new byte[at.Length];
                    stream.Position = at.Offset;
                    stream.ReadExactly(bytes);
                    if (!bytes.AsSpan().SequenceEqual(File.ReadAllBytes(files[i])))
                    {
                        throw new InvalidDataException($"{name} differs in the pack");
                    }
                }
            }

            File.Move(partial, pack, true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidDataException or OverflowException)
        {
            logger.Warning($"[Satellite] Couldn't pack the tiles in {folder}; they're kept as they are: {ex.Message}");
            try
            {
                File.Delete(partial);
            }
            catch (Exception deleteEx) when (deleteEx is IOException or UnauthorizedAccessException)
            {
                // left; the next capture writes over it
            }

            return false;
        }

        foreach (var file in files)
        {
            try
            {
                File.Delete(file);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // the pack is served before it all the same
            }
        }

        return true;
    }

    private static PackIndex ReadIndex(string pack, FileInfo info)
    {
        using var stream = new FileStream(pack, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
        using var reader = new BinaryReader(stream, Encoding.ASCII);
        if (Encoding.ASCII.GetString(reader.ReadBytes(PackMagic.Length)) != PackMagic)
        {
            throw new InvalidDataException("not a tile pack");
        }

        var count = reader.ReadInt32();
        if (count is < 0 or > MostInPack)
        {
            throw new InvalidDataException("bad tile count");
        }

        var tiles = new Dictionary<string, (long, int)>(count, StringComparer.Ordinal);
        for (var i = 0; i < count; i++)
        {
            var name = Encoding.ASCII.GetString(reader.ReadBytes(reader.ReadByte()));
            var offset = reader.ReadInt64();
            var length = reader.ReadInt32();
            if (offset < 0 || length <= 0 || offset + length > stream.Length)
            {
                throw new InvalidDataException("tile out of range");
            }

            tiles[name] = (offset, length);
        }

        return new PackIndex(info.Length, info.LastWriteTimeUtc, tiles);
    }
}
