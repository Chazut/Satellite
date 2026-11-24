"""The tiles of captured maps as WebP: about half the size of the scanner's JPEGs, and as good to look at.

    python webp_tiles.py <folder or tiles.pack> [...] [--quality 80] [--workers N] [--wait SECONDS]

Every tiles.pack in the folders given (and under them) has its JPEG tiles made WebP. The tiles keep their names
(0_1_f1_s.jpg); the server sends each with the type its bytes are (Satellite.Server/TilePacks.cs). Tiles that are WebP
already are kept as they are, so it can be run over the same folder again and again: a pack with nothing to do is only
read, not written. A pack is written beside itself first, read back and every tile decoded, and only then takes the
pack's name; the server reads the new one from then on.

Run by build.ps1 on the copy of the maps that goes into the release zips, and by the scanner when a capture or a run
of captures ends. The server packs a capture's tiles a few seconds after it's complete: --wait waits that long at most
for a capture folder that has its tiles loose still. Needs Pillow (pip install pillow).

    python webp_tiles.py <folder> --most-px-per-metre 12 [--shrink-quality 70]

Shrinks a map for a release, about three quarters off with nothing a player sees lost. Only build.ps1 runs it, and
only on the copy that goes into a zip, never on the scans themselves:
  - a tile sharper than the cap is made smaller to fit it (a 64 m tile of 1024 pixels, 16 a metre, becomes 768);
  - a floor's tile (0_1_f2.jpg) has everything outside the map's buildings, and a few metres round them, made one
    flat colour. The page only ever shows a floor through the shape of its building (livemap.js, the floor masks), so
    that part is never seen, but it was half or more of every floor tile's bytes.
The map's meta.json then says "shrunk" (and its new "px"), so a second run leaves it as it is.
"""
import argparse
import io
import json
import os
import re
import struct
import sys
import time
from concurrent.futures import ProcessPoolExecutor

MAGIC = b'SATTILE1'
MOST = 100_000
TILE = re.compile(r'^[0-9]{1,2}_[0-9]{1,2}(_f[0-9]{1,2})?(_s)?\.jpg$')


def is_webp(data):
    return len(data) >= 12 and data[:4] == b'RIFF' and data[8:12] == b'WEBP'


def read_pack(path):
    with open(path, 'rb') as f:
        if f.read(8) != MAGIC:
            raise ValueError('not a tile pack')
        count, = struct.unpack('<i', f.read(4))
        if not 0 <= count <= MOST:
            raise ValueError('bad tile count')
        index = []
        for _ in range(count):
            name = f.read(f.read(1)[0]).decode('ascii')
            offset, length = struct.unpack('<qi', f.read(12))
            index.append((name, offset, length))
        tiles = []
        for name, offset, length in index:
            f.seek(offset)
            data = f.read(length)
            if len(data) != length:
                raise ValueError(f'{name} cut short')
            tiles.append((name, data))
    return tiles


def write_pack(path, tiles):
    names = [n.encode('ascii') for n, _ in tiles]
    offset = 8 + 4 + sum(1 + len(n) + 8 + 4 for n in names)
    with open(path, 'wb') as f:
        f.write(MAGIC)
        f.write(struct.pack('<i', len(tiles)))
        for name, (_, data) in zip(names, tiles):
            f.write(bytes([len(name)]) + name + struct.pack('<qi', offset, len(data)))
            offset += len(data)
        for _, data in tiles:
            f.write(data)


TILE_PARTS = re.compile(r'^([0-9]{1,2})_([0-9]{1,2})(_f[0-9]{1,2})?(_s)?\.jpg$')
# metres kept round every building when a floor's tile is blanked: the page lays tiles a little over each other, and a
# building's outline can sit a little past its squares
MARGIN = 3


def unrun(runs, count):
    """meta.json's runs ([value, how many, ..]) as one byte a square: 1 where the value isn't 0."""
    out = bytearray(count)
    at = 0
    for i in range(0, len(runs) - 1, 2):
        value, run = runs[i], max(0, int(runs[i + 1]))
        if value:
            out[at:at + run] = b'\x01' * max(0, min(run, count - at))
        at += run
    return out


def building_mask(floors):
    """Where any building of the map is, one pixel a metre and grown by MARGIN, from its floor squares and, on maps
    that have them, its buildings' outlines; with the east and north of its top-left corner. None if it has neither."""
    from PIL import Image, ImageDraw, ImageFilter
    cell, wide, tall = floors.get('cell'), floors.get('wide'), floors.get('tall')
    if not (cell and wide and tall) or not isinstance(floors.get('grid'), list) or wide * tall > 5e7:
        return None
    width, height = int(round(wide * cell)), int(round(tall * cell))
    squares = unrun(floors['grid'], wide * tall)
    # the squares go row by row from the south-west: turned over, the image's top row is the north
    mask = Image.frombytes('L', (wide, tall), bytes(255 if s else 0 for s in squares)).transpose(Image.FLIP_TOP_BOTTOM)
    mask = mask.resize((width, height), Image.NEAREST)
    left, top = floors['min'][0], floors['min'][1] + height
    draw = ImageDraw.Draw(mask)
    for building in floors.get('buildings') or []:
        loops = list(building.get('l') or [])
        for part in building.get('parts') or []:
            loops += part.get('l') or []
        for loop in loops:
            points = [(loop[i] - left, top - loop[i + 1]) for i in range(0, len(loop) - 1, 2)]
            if len(points) >= 3:
                draw.polygon(points, fill=255)
    return mask.filter(ImageFilter.MaxFilter(MARGIN * 2 + 1)), left, top


def shrink_tile(job):
    data, px, cut, quality = job
    from PIL import Image
    with Image.open(io.BytesIO(data)) as image:
        image = image.convert('RGB')
        if cut is not None:
            keep = Image.frombytes('L', cut[0], cut[1]).resize(image.size, Image.BILINEAR).point(lambda v: 255 if v >= 128 else 0)
            flat = Image.new('RGB', image.size, image.resize((1, 1), Image.BOX).getpixel((0, 0)))
            image = Image.composite(image, flat, keep)
        if px and image.width > px:
            image = image.resize((px, px), Image.LANCZOS)
        out = io.BytesIO()
        image.save(out, format='WEBP', quality=quality, method=6)
    return out.getvalue()


def shrink(pack, most_px_per_metre, quality, pool):
    """One map's pack made smaller for a release (see the top). Returns tiles changed, bytes before, bytes after."""
    meta_path = os.path.join(os.path.dirname(os.path.dirname(pack)), 'meta.json')
    with open(meta_path, encoding='utf-8') as f:
        meta = json.load(f)
    if meta.get('shrunk'):
        return 0, 0, 0
    tile_m = float(meta['tile'])
    # whole steps of 64 pixels, never sharper than it was
    px = min(int(meta.get('px') or 1024), max(64, int(round(most_px_per_metre * tile_m / 64)) * 64))
    found = building_mask(meta['floors']) if isinstance(meta.get('floors'), dict) else None
    tiles = read_pack(pack)
    jobs, todo = [], []
    for i, (name, data) in enumerate(tiles):
        parts = TILE_PARTS.match(name)
        if not parts:
            continue
        floor, small = parts.group(3), parts.group(4)
        cut = None
        if floor and found is not None:
            mask, left, top = found
            col, row = int(parts.group(1)), int(parts.group(2))
            x0 = meta['min'][0] + col * tile_m - left
            y0 = top - (meta['min'][1] + (row + 1) * tile_m)
            piece = mask.crop((round(x0), round(y0), round(x0 + tile_m), round(y0 + tile_m)))
            cut = (piece.size, piece.tobytes())
        want = None if small else px
        if cut is None and not (want and want < int(meta.get('px') or 1024)):
            continue
        todo.append(i)
        jobs.append((data, want, cut, quality))
    if not todo:
        return 0, 0, 0
    before = sum(len(d) for _, d in tiles)
    for i, data in zip(todo, pool.map(shrink_tile, jobs, chunksize=4)):
        tiles[i] = (tiles[i][0], data)
    partial = pack + '.part'
    write_pack(partial, tiles)
    from PIL import Image
    back = read_pack(partial)
    if [n for n, _ in back] != [n for n, _ in tiles] or any(a != b for (_, a), (_, b) in zip(back, tiles)):
        os.remove(partial)
        raise ValueError('the new pack differs from what was written')
    for name, data in back:
        with Image.open(io.BytesIO(data)) as image:
            image.load()
    os.replace(partial, pack)
    meta['px'] = px
    meta['shrunk'] = most_px_per_metre
    with open(meta_path, 'w', encoding='utf-8', newline='') as f:
        json.dump(meta, f, separators=(',', ':'))
    return len(todo), before, sum(len(d) for _, d in tiles)


def to_webp(job):
    data, quality = job
    from PIL import Image
    with Image.open(io.BytesIO(data)) as image:
        image = image.convert('RGB')
        out = io.BytesIO()
        image.save(out, format='WEBP', quality=quality, method=4)
    return out.getvalue()


def convert(pack, quality, pool):
    tiles = read_pack(pack)
    todo = [i for i, (_, data) in enumerate(tiles) if not is_webp(data)]
    if not todo:
        return 0, 0, 0
    before = sum(len(d) for _, d in tiles)
    made = list(pool.map(to_webp, [(tiles[i][1], quality) for i in todo], chunksize=8))
    for i, data in zip(todo, made):
        tiles[i] = (tiles[i][0], data)
    partial = pack + '.part'
    write_pack(partial, tiles)
    # read back as the server reads it: every tile there, in order, and each one a picture that opens
    from PIL import Image
    back = read_pack(partial)
    if [n for n, _ in back] != [n for n, _ in tiles] or any(a != b for (_, a), (_, b) in zip(back, tiles)):
        os.remove(partial)
        raise ValueError('the new pack differs from what was written')
    for name, data in back:
        with Image.open(io.BytesIO(data)) as image:
            image.load()
    os.replace(partial, pack)
    return len(todo), before, sum(len(d) for _, d in tiles)


def packs(paths, wait):
    found, loose = [], []
    for path in paths:
        if os.path.isfile(path):
            found.append(path)
            continue
        for folder, _, files in os.walk(path):
            if 'tiles.pack' in files:
                found.append(os.path.join(folder, 'tiles.pack'))
            elif any(TILE.match(f) for f in files):
                loose.append(folder)
    # a capture just finished: its pack, once the server has made it
    until = time.monotonic() + wait
    while loose and time.monotonic() < until:
        time.sleep(2)
        made = [f for f in loose if os.path.isfile(os.path.join(f, 'tiles.pack'))]
        found += [os.path.join(f, 'tiles.pack') for f in made]
        loose = [f for f in loose if f not in made]
    for folder in loose:
        print(f'{folder} has its tiles loose still (not packed by the server); left as they are')
    return sorted(set(found))


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('paths', nargs='+')
    parser.add_argument('--quality', type=int, default=80)
    parser.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 2) - 1))
    parser.add_argument('--wait', type=float, default=0)
    parser.add_argument('--most-px-per-metre', type=float, default=0)
    parser.add_argument('--shrink-quality', type=int, default=70)
    args = parser.parse_args()
    try:
        import PIL  # noqa: F401
    except ImportError:
        sys.exit('Pillow is needed: pip install pillow')
    failed = False
    with ProcessPoolExecutor(args.workers) as pool:
        for pack in packs(args.paths, args.wait):
            if args.most_px_per_metre > 0:
                try:
                    count, before, after = shrink(pack, args.most_px_per_metre, args.shrink_quality, pool)
                except (OSError, ValueError, KeyError) as error:
                    print(f'Couldn\'t shrink the tiles in {pack}: {error}', file=sys.stderr)
                    failed = True
                    continue
                if count:
                    print(f'{pack}: {count} tiles shrunk, {before / 1e6:.1f} MB to {after / 1e6:.1f} MB')
            try:
                count, before, after = convert(pack, args.quality, pool)
            except (OSError, ValueError) as error:
                print(f'Couldn\'t make the tiles in {pack} WebP: {error}', file=sys.stderr)
                failed = True
                continue
            if count:
                print(f'{pack}: {count} tiles, {before / 1e6:.1f} MB to {after / 1e6:.1f} MB')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
