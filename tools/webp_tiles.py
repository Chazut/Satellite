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
"""
import argparse
import io
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
    args = parser.parse_args()
    try:
        import PIL  # noqa: F401
    except ImportError:
        sys.exit('Pillow is needed: pip install pillow')
    failed = False
    with ProcessPoolExecutor(args.workers) as pool:
        for pack in packs(args.paths, args.wait):
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
