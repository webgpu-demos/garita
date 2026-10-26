#!/usr/bin/env python3
"""Garita stage "heights": the height of every building, measured from the USGS 3DEP lidar point clouds.

Source   USGS 3DEP lidar point clouds as Entwine Point Tiles in the AWS Open Data bucket usgs-lidar-public
         (https://registry.opendata.aws/usgs-lidar/): the Puerto Rico collections USGS_LPC_PR_PRVI_*_2018 (flown
         2018-04 to 2019-04, after hurricane Maria), listed on every run; nothing is hard-coded but the prefix.
         Positions in Web Mercator (EPSG:3857), elevations in metres. Classes as delivered: 1 unclassified (roofs,
         trees, everything that is not ground), 2 ground, 7 and 18 noise, 9 water, 17 bridge deck, 20 ignored ground;
         these collections have no class 6 (building), which is read too in case a collection has it. The newer
         collection PR_PuertoRicoUSVI_D24 has no cloud-optimised copy (only per-tile LAZ download lists), so it is
         not used: a building put up after 2019 has no value here.
Method   For each footprint (the outer ring in tiles/bld):
           roof    last returns (return number = number of returns: what is left of a pulse after any canopy) of
                   class 1 or 6 inside the ring and more than INSET_M from it (wall and eave hits left out), more
                   than MIN_H above the ground;
           ground  class 2 points between 1 and NEAR_M outside the ring (out to FAR_M when fewer than MIN_GROUND
                   are found): their median;
           noise   some flight lines leave returns 100 to 300 m up (birds, haze) in class 1: the roof elevations are
                   split wherever GAP_M holds no point; a group above the lowest stays only if it is flat (FLAT_M:
                   a tower over a podium) and more than two points
           height  the 90th percentile of the roof points' elevation minus the ground (the top of the roof with
                   its parapets and tanks, not a stray antenna); the median is kept too (p50: the main roof).
         Accepted only with at least MIN_ROOF roof points and MIN_GROUND ground points, when at least MIN_COVER of
         the last returns inside the inset ring are roof points (a footprint that was bare ground, a ruin or not
         yet built when the lidar was flown has no value; so does one mostly under trees), and the height is
         MIN_H to MAX_H. Otherwise no value. Nothing is filled, interpolated or guessed.
Reads    readers.ept (PDAL), one query per zoom-16 cell (about 600 m) holding building centroids: bounds = the
         rings of its buildings grown by FAR_M, resolution RES_M (the octree depth whose spacing is at most that).
         Every 2018 collection whose conforming bounds meet the query is read and the points pooled.
Output   data/hazards/heights/buildings.bin       uint16 height_dm (p90 roof minus ground, decimetres; 0 = no value)
         data/hazards/heights/buildings_p50.bin   uint16 p50_dm (median roof minus ground; 0 = no value)
         data/hazards/heights/buildings_cover.bin uint8 cover (percent of the inset's last returns that are roof;
                                                  255 = not measured: no points, or the cell was not read)
         in canonical order (common.py; meta.buildings.bld_generated names the building tiles sampled), plus
         meta.json (method, sources, QA against the heights the tiles held), qa.jpg and log.txt.

Three steps, so the work spreads over a job matrix:
  plan   cells, collections, shards: work/plan/{plan.json, plan.npz}
  shard  read and measure one shard's cells: work/shard/shard_<i>.npz
  merge  combine, QA, write out/data/hazards/heights/

Needs: numpy, PDAL with its Python bindings (plan lists the collections without PDAL; shard reads with it),
matplotlib (point in polygon), Pillow (merge).
"""
import argparse
import datetime
import glob
import json
import math
import os
import re
import struct
import sys
import time
import urllib.request

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

EPT_BUCKET = 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/'
COLLECTIONS = r'^USGS_LPC_PR_PRVI_[A-Z]_2018$'   # Puerto Rico; the _VI_ collections are the US Virgin Islands
RES_M = float(os.environ.get('HEIGHTS_RES', '2.0'))   # 2 m: as close to OSM height tags as 1 m (median |d| 0.53 vs 0.52 m over Condado), a third of the reading
INSET_M = 0.5
NEAR_M = 8.0
FAR_M = 25.0
MIN_ROOF = 6
MIN_GROUND = 3
MIN_COVER = 0.5
MIN_H = 2.0
MAX_H = 120.0    # the tallest building in Puerto Rico is about 102 m (Caribbean Sea View); returns higher above the
                 # ground than this are not a roof, and are dropped before anything else
GAP_M = 10.0     # roof elevations further apart than this, with nothing between, are separate groups
FLAT_M = 8.0     # a group above the lowest is a roof only if its p95 - p5 is within this
CELL_Z = 16
R = 6378137.0
T0 = time.time()
LOG = None


def log(*a):
    s = f'[{time.time() - T0:7.1f}s] ' + ' '.join(str(x) for x in a)
    print(s, flush=True)
    if LOG:
        with open(LOG, 'a') as f:
            f.write(s + '\n')


def fetch(url, timeout=60, tries=4):
    err = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            err = e
            time.sleep(2 + 3 * i)
    raise RuntimeError(f'{url}: {err}')


def merc(lon, lat):
    """WGS 84 longitude/latitude to Web Mercator metres (EPSG:3857)."""
    lon = np.asarray(lon, dtype=np.float64)
    lat = np.asarray(lat, dtype=np.float64)
    return R * np.radians(lon), R * np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))


def scale_at(lat):
    """Web Mercator metres per true metre at a latitude."""
    return 1.0 / math.cos(math.radians(lat))


def lon_to_tx(lon, z):
    return (lon + 180.0) / 360.0 * (1 << z)


def lat_to_ty(lat, z):
    s = np.sin(np.radians(lat))
    return (0.5 - np.log((1 + s) / (1 - s)) / (4 * np.pi)) * (1 << z)


# ---------------------------------------------------------------- building tiles
def tile_offsets(site):
    idx = json.load(open(os.path.join(site, 'tiles/bld/index.json')))
    counts = np.array([c for _, _, c in idx['tiles']], dtype=np.int64)
    off = np.concatenate([[0], np.cumsum(counts)])
    assert off[-1] == idx['total'], (off[-1], idx['total'])
    return idx, off


def read_tile(site, x, y):
    """The records of one tile: (rings as [(lon array, lat array)], height byte array, added flags, ids lines or None)."""
    b = open(os.path.join(site, f'tiles/bld/{common.Z}/{x}/{y}.bin'), 'rb').read()
    assert b[:4] == b'GBL1', (x, y)
    n = struct.unpack_from('<I', b, 4)[0]
    o, rings, hb, added = 8, [], np.zeros(n, dtype=np.uint8), np.zeros(n, dtype=bool)
    for k in range(n):
        nv = struct.unpack_from('<H', b, o)[0]
        hb[k] = b[o + 2]
        added[k] = (b[o + 3] & 0x80) != 0
        uv = np.frombuffer(b, dtype='<u2', count=2 * nv, offset=o + 8).astype(np.float64)
        fx, fy = uv[0::2] / 65535 * 1.5 - 0.25, uv[1::2] / 65535 * 1.5 - 0.25
        rings.append((common.tile_lon(0) + (x + fx) / common.N * 360.0, np.degrees(np.arctan(np.sinh(np.pi * (1.0 - 2.0 * (y + fy) / common.N))))))
        o += 8 + 4 * nv
    ids_file = os.path.join(site, f'tiles/bld/{common.Z}/{x}/{y}.ids')
    ids = open(ids_file).read().split('\n')[:n] if os.path.exists(ids_file) else None
    return rings, hb, added, ids


# ---------------------------------------------------------------- collections
def list_collections():
    prefixes, token = [], None
    for _ in range(20):
        q = 'list-type=2&delimiter=/&prefix=USGS_LPC_PR' + (f'&continuation-token={urllib.request.quote(token)}' if token else '')
        t = fetch(EPT_BUCKET + '?' + q).decode()
        prefixes += re.findall(r'<Prefix>([^<]+)/</Prefix>', t)
        m = re.search(r'<NextContinuationToken>([^<]+)</NextContinuationToken>', t)
        if not m:
            break
        token = m.group(1)
    out = []
    for p in sorted(set(prefixes)):
        if not re.match(COLLECTIONS, p):
            continue
        url = f'{EPT_BUCKET}{p}/ept.json'
        e = json.loads(fetch(url))
        srs = e.get('srs', {})
        # where the collection really has points: the bounds of its source files (ept-sources/list.json); the
        # collections' own bounds are boxes that overlap a lot, and every collection read costs a query
        try:
            src = json.loads(fetch(f'{EPT_BUCKET}{p}/ept-sources/list.json', timeout=120))
            tiles = [s['bounds'][:2] + s['bounds'][3:5] for s in src if s.get('bounds') and (s.get('points') or 0) > 0]
        except Exception as ex:  # noqa: BLE001
            log(f'{p}: no source list ({ex}); its bounds stand for it')
            tiles = None
        out.append({'name': p, 'url': url, 'bounds': e.get('boundsConforming') or e['bounds'], 'points': e.get('points'),
                    'srs': f"{srs.get('authority', '')}:{srs.get('horizontal', '')}", 'vertical': srs.get('vertical'),
                    'classes_in_schema': any(d.get('name') == 'Classification' for d in e.get('schema', [])),
                    'source_files': len(tiles) if tiles is not None else None, '_tiles': tiles})
    return out


def meets(c, x0, y0, x1, y1):
    """Does collection c have a source file meeting the box (Web Mercator)?"""
    b = c['bounds']
    if not (b[0] <= x1 and b[3] >= x0 and b[1] <= y1 and b[4] >= y0):
        return False
    if c.get('_tiles') is None:
        return True
    t = c['_np'] if '_np' in c else c.setdefault('_np', np.array(c['_tiles'], dtype=np.float64).reshape(-1, 4))
    return bool(np.any((t[:, 0] <= x1) & (t[:, 2] >= x0) & (t[:, 1] <= y1) & (t[:, 3] >= y0)))


# ---------------------------------------------------------------- plan
def cmd_plan(a):
    global LOG
    os.makedirs(os.path.join(a.work, 'plan'), exist_ok=True)
    LOG = os.path.join(a.work, 'plan', 'log_plan.txt')
    open(LOG, 'w').close()
    idx, off = tile_offsets(a.site)
    lon, lat, stamp = common.load_buildings(a.site)
    log('buildings', len(lon), 'of', stamp)
    keep = np.ones(len(lon), dtype=bool)
    if a.only:
        rx = re.compile(a.only)
        for t, (x, y, _) in enumerate(idx['tiles']):
            if not rx.search(f'{x}/{y}'):
                keep[off[t]:off[t + 1]] = False
        log(f'only tiles matching {a.only!r}:', int(keep.sum()), 'buildings')
    cx = np.floor(lon_to_tx(lon, CELL_Z)).astype(np.int64)
    cy = np.floor(lat_to_ty(lat, CELL_Z)).astype(np.int64)
    key = cx * (1 << 20) + cy
    sel = np.nonzero(keep)[0]
    order = sel[np.argsort(key[sel], kind='stable')]
    ukeys, start = np.unique(key[order], return_index=True)
    ptr = np.concatenate([start, [len(order)]]).astype(np.int64)
    cols = list_collections()
    for c in cols:
        log('collection', c['name'], c['srs'], 'points', c['points'], 'bounds', [round(v) for v in c['bounds']])
    cells = []
    for i, k in enumerate(ukeys):
        x, y = int(k >> 20), int(k & ((1 << 20) - 1))
        lon0, lon1 = x / (1 << CELL_Z) * 360 - 180, (x + 1) / (1 << CELL_Z) * 360 - 180
        lat1 = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / (1 << CELL_Z)))))
        lat0 = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / (1 << CELL_Z)))))
        (mx0, mx1), (my0, my1) = merc([lon0, lon1], [lat0, lat1])
        g = 300 * scale_at(lat0)     # a ring reaching out of the cell, and the ground search, stay within this
        ds = [j for j, c in enumerate(cols) if meets(c, mx0 - g, my0 - g, mx1 + g, my1 + g)]
        cells.append({'x': x, 'y': y, 'n': int(ptr[i + 1] - ptr[i]), 'ds': ds})
    # shards: cells in Morton order (neighbours together), cut into runs of about equal work
    def morton(x, y):
        z = 0
        for b in range(20):
            z |= ((x >> b) & 1) << (2 * b) | ((y >> b) & 1) << (2 * b + 1)
        return z
    mo = sorted(range(len(cells)), key=lambda i: morton(cells[i]['x'], cells[i]['y']))
    w = np.array([1.0 + cells[i]['n'] / 400.0 for i in mo])
    cum = np.cumsum(w)
    for r, i in enumerate(mo):
        cells[i]['shard'] = int(min(a.shards - 1, math.floor((cum[r] - w[r] / 2) / cum[-1] * a.shards)))
    no_ds = sum(1 for c in cells if not c['ds'])
    for c in cols:
        c.pop('_tiles', None); c.pop('_np', None)
    log('collections per cell:', np.bincount([len(c['ds']) for c in cells]).tolist())
    log('cells', len(cells), 'without a collection', no_ds, 'buildings in cells', int(ptr[-1]))
    for s in range(a.shards):
        m = [c for c in cells if c['shard'] == s]
        log(f'  shard {s:2d}: {len(m)} cells, {sum(c["n"] for c in m)} buildings')
    json.dump({'generated': stamp, 'total': int(idx['total']), 'only': a.only or None, 'res_m': RES_M, 'cell_zoom': CELL_Z, 'shards': a.shards,
               'collections': cols, 'cells': cells}, open(os.path.join(a.work, 'plan', 'plan.json'), 'w'))
    np.savez_compressed(os.path.join(a.work, 'plan', 'plan.npz'), order=order.astype(np.int32), ptr=ptr)
    log('plan written')


# ---------------------------------------------------------------- measuring
def seg_dist(px, py, rx, ry):
    """Distance from each point to the closed ring (rx, ry: vertices, not closed)."""
    ax, ay = rx, ry
    bx, by = np.roll(rx, -1), np.roll(ry, -1)
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    L[L == 0] = 1e-12
    t = np.clip(((px[:, None] - ax) * dx + (py[:, None] - ay) * dy) / L, 0.0, 1.0)
    qx, qy = ax + t * dx - px[:, None], ay + t * dy - py[:, None]
    return np.sqrt(np.min(qx * qx + qy * qy, axis=1))


class Grid:
    """Points binned on a square grid (cell `size`, in the points' units), to find those near a box quickly."""

    def __init__(self, X, Y, size):
        self.x0, self.y0, self.size = X.min(), Y.min(), size
        ix = ((X - self.x0) / size).astype(np.int64)
        iy = ((Y - self.y0) / size).astype(np.int64)
        self.W = int(ix.max()) + 1
        k = iy * self.W + ix
        self.order = np.argsort(k, kind='stable')
        self.keys = k[self.order]

    def near(self, x0, y0, x1, y1):
        i0, i1 = max(0, int((x0 - self.x0) // self.size)), min(self.W - 1, int((x1 - self.x0) // self.size))
        j0, j1 = max(0, int((y0 - self.y0) // self.size)), int((y1 - self.y0) // self.size)
        if i1 < i0 or j1 < j0:
            return np.zeros(0, dtype=np.int64)
        parts = []
        for j in range(j0, j1 + 1):
            lo = np.searchsorted(self.keys, j * self.W + i0, 'left')
            hi = np.searchsorted(self.keys, j * self.W + i1, 'right')
            if hi > lo:
                parts.append(self.order[lo:hi])
        return np.concatenate(parts) if parts else np.zeros(0, dtype=np.int64)


def measure(ring_xy, k, P, grid):
    """One building. ring_xy: (rx, ry) in Web Mercator; k: Mercator metres per metre here; P: the points. Returns
    (height p90, p50, cover, roof points, ground points, ground) with NaN where there is no value."""
    from matplotlib.path import Path
    rx, ry = ring_xy
    nan = (np.nan, np.nan, np.nan, 0, 0, np.nan)
    if len(rx) < 3:
        return nan
    path = Path(np.column_stack([rx, ry]))
    x0, x1, y0, y1 = rx.min(), rx.max(), ry.min(), ry.max()
    for reach in (NEAR_M, FAR_M):
        m = reach * k
        cand = grid.near(x0 - m, y0 - m, x1 + m, y1 + m)
        if len(cand) == 0:
            continue
        X, Y, Z, C = P['X'][cand], P['Y'][cand], P['Z'][cand], P['Classification'][cand]
        inside = path.contains_points(np.column_stack([X, Y]))
        gsel = np.nonzero(~inside & (C == 2))[0]
        if len(gsel) >= MIN_GROUND:
            d = seg_dist(X[gsel], Y[gsel], rx, ry) / k
            gz = Z[gsel][(d >= 1.0) & (d <= reach)]
            if len(gz) >= MIN_GROUND:
                break
    else:
        return nan
    ground = float(np.median(gz))
    isel = np.nonzero(inside)[0]
    if len(isel) == 0:
        return (np.nan, np.nan, np.nan, 0, len(gz), ground)
    rn, nr = P['ReturnNumber'][cand][isel], P['NumberOfReturns'][cand][isel]
    last = (rn >= nr) & (rn > 0)          # (return number 0 is invalid; some flight lines have it)
    di = seg_dist(X[isel], Y[isel], rx, ry) / k
    inset = last & (di > INSET_M)
    sky = inset.copy()
    sky[sky] = Z[isel][inset] > ground + MAX_H
    inset &= ~sky
    zi, ci = Z[isel][inset], C[isel][inset]
    roof = ((ci == 1) | (ci == 6)) & (zi > ground + MIN_H)
    # Noise left in class 1: in some flight lines returns from 100 to 300 m above the ground (birds, haze) are not
    # flagged as noise. Split the roof elevations wherever GAP_M is empty: the lowest group is the roof; a group
    # above is kept only if it is flat (a tower over a podium: p95 - p5 within FLAT_M) and not a few stray points.
    if roof.any():
        zs = np.sort(zi[roof])
        cut = np.nonzero(np.diff(zs) > GAP_M)[0]
        for lo, hi in zip(np.concatenate([[0], cut + 1])[1:], np.concatenate([cut + 1, [len(zs)]])[1:]):
            g = zs[lo:hi]
            if len(g) < 3 or np.percentile(g, 95) - np.percentile(g, 5) > FLAT_M:
                drop = (zi >= g[0]) & (zi <= g[-1])
                roof &= ~drop
                inset[np.nonzero(inset)[0][drop]] = False  # (not counted for cover either)
                zi, ci, roof = zi[~drop], ci[~drop], roof[~drop]
    n_inset = int(inset.sum())
    if n_inset == 0:
        return (np.nan, np.nan, np.nan, 0, len(gz), ground)
    nroof = int(roof.sum())
    cover = nroof / n_inset
    if nroof < MIN_ROOF or cover < MIN_COVER:
        return (np.nan, np.nan, cover, nroof, len(gz), ground)
    h90 = float(np.percentile(zi[roof], 90)) - ground
    h50 = float(np.percentile(zi[roof], 50)) - ground
    if not (MIN_H <= h90 <= MAX_H):
        return (np.nan, np.nan, cover, nroof, len(gz), ground)
    return (h90, h50, cover, nroof, len(gz), ground)


def read_cell(cols, ds, bounds):
    import pdal
    readers = [{'type': 'readers.ept', 'filename': cols[j]['url'], 'bounds': bounds, 'resolution': RES_M, 'threads': 4, 'tag': f'r{j}'} for j in ds]
    stages = readers + ([{'type': 'filters.merge', 'inputs': [r['tag'] for r in readers]}] if len(readers) > 1 else [])
    stages.append({'type': 'filters.range', 'limits': 'Classification[1:2],Classification[6:6]'})
    p = pdal.Pipeline(json.dumps({'pipeline': stages}))
    p.execute()
    arrs = [x for x in p.arrays if len(x)]
    if not arrs:
        return None
    a = np.concatenate(arrs) if len(arrs) > 1 else arrs[0]
    return np.ascontiguousarray(a[['X', 'Y', 'Z', 'Classification', 'ReturnNumber', 'NumberOfReturns']])


def timed_read(cols, ds, bounds, tries=3):
    """read_cell in a worker process, tried again on a network or tile error; (points, seconds)."""
    t = time.time()
    for k in range(tries):
        try:
            return read_cell(cols, ds, bounds), time.time() - t
        except Exception:  # noqa: BLE001
            if k == tries - 1:
                raise
            time.sleep(3 + 5 * k)


def cmd_shard(a):
    """One shard's cells. Points are read in worker processes (a crash in PDAL takes one worker, not the shard),
    measured here, and the results saved every minute: a run that dies is started again and goes on from there."""
    global LOG
    os.makedirs(os.path.join(a.work, 'shard'), exist_ok=True)
    LOG = os.path.join(a.work, 'shard', f'log_shard_{a.shard:02d}.txt')
    plan = json.load(open(os.path.join(a.work, 'plan', 'plan.json')))
    pz = np.load(os.path.join(a.work, 'plan', 'plan.npz'))
    order, ptr = pz['order'], pz['ptr']
    idx, off = tile_offsets(a.site)
    if idx['generated'] != plan['generated']:
        log(f'building tiles are of {idx["generated"]}, the plan of {plan["generated"]}: stopping')
        return 0
    cols = plan['collections']
    mine = [i for i, c in enumerate(plan['cells']) if c['shard'] == a.shard]
    deadline = a.deadline or (time.time() + a.budget)
    out_file = os.path.join(a.work, 'shard', f'shard_{a.shard:02d}.npz')
    st_file = os.path.join(a.work, 'shard', f'status_{a.shard:02d}.json')
    out_i, out = [], []
    status = {'cells': len(mine), 'done': 0, 'empty': 0, 'failed': 0, 'skipped_for_time': 0, 'points': 0, 'read_s': 0.0, 'measure_s': 0.0, 'readers': a.readers, 'restarts': 0}
    finished = set()
    if os.path.exists(out_file) and os.path.exists(st_file):  # a run before this one died: go on from where it saved
        z = np.load(out_file)
        out_i, out = list(z['i']), [tuple(r) for r in z['v']]
        prev = json.load(open(st_file))
        finished = set(prev.get('finished_cells', []))
        for k in ('done', 'empty', 'failed', 'points', 'read_s', 'measure_s'):
            status[k] = prev.get(k, 0)
        status['restarts'] = prev.get('restarts', 0) + 1
        log(f'resuming: {len(finished)} cells already done, {len(out_i)} buildings')
    log(f'shard {a.shard}: {len(mine)} cells, {sum(plan["cells"][i]["n"] for i in mine)} buildings; resolution {RES_M} m; {int(deadline - time.time())} s left')
    tiles = {}

    def ring(i):
        t = int(np.searchsorted(off, i, 'right') - 1)
        if t not in tiles:
            x, y, _ = idx['tiles'][t]
            tiles[t] = read_tile(a.site, x, y)[0]
        return tiles[t][i - off[t]]

    def save(final=False):
        arr = np.array(out, dtype=np.float64).reshape(-1, 6)
        np.savez_compressed(out_file + '.tmp.npz', i=np.array(out_i, dtype=np.int32), v=arr.astype(np.float32))
        os.replace(out_file + '.tmp.npz', out_file)
        status['measured'] = int(np.isfinite(arr[:, 0]).sum()) if len(arr) else 0
        status['buildings'] = len(out_i)
        status['finished_cells'] = sorted(finished)
        status['complete'] = final
        json.dump(status, open(st_file, 'w'))

    def prep(ci):
        """The rings of a cell's buildings in Web Mercator, and the box to read."""
        b_idx = order[ptr[ci]:ptr[ci + 1]]
        rings = [merc(*ring(int(i))) for i in b_idx]
        k = scale_at(float(np.mean([ring(int(i))[1].mean() for i in b_idx[:20]])))
        m = (FAR_M + 2) * k
        box = (min(r[0].min() for r in rings) - m, min(r[1].min() for r in rings) - m, max(r[0].max() for r in rings) + m, max(r[1].max() for r in rings) + m)
        return b_idx, rings, k, box

    import multiprocessing as mp
    from collections import deque
    from concurrent.futures import ProcessPoolExecutor
    from concurrent.futures.process import BrokenProcessPool
    todo, pending, n_seen, last_save = deque(c for c in mine if c not in finished), deque(), len(finished), time.time()
    broken = False
    with ProcessPoolExecutor(a.readers, mp_context=mp.get_context('fork')) as ex:
        def submit():
            while todo:
                ci = todo.popleft()
                if not plan['cells'][ci]['ds']:
                    status['empty'] += 1
                    finished.add(ci)
                    continue
                try:
                    job = prep(ci)
                except Exception as e:  # noqa: BLE001
                    status['failed'] += 1
                    finished.add(ci)
                    log(f'  cell {ci} rings failed: {e}')
                    continue
                X0, Y0, X1, Y1 = job[3]
                pending.append((ci, job, ex.submit(timed_read, cols, plan['cells'][ci]['ds'], f'([{X0:.2f}, {X1:.2f}], [{Y0:.2f}, {Y1:.2f}])')))
                return
        for _ in range(a.readers + 1):
            submit()
        while pending:
            if time.time() > deadline:
                status['skipped_for_time'] = len(pending) + len(todo)
                for _, _, f in pending:
                    f.cancel()
                log(f'time is up: {status["skipped_for_time"]} cells left unread')
                break
            ci, (b_idx, rings, k, box), fut = pending.popleft()
            c = plan['cells'][ci]
            n_seen += 1
            try:
                P, rs = fut.result()
            except BrokenProcessPool:
                log(f'  a reader died at cell {c["x"]}/{c["y"]}: saving, to go on in a new run')
                broken = True
                break
            except Exception as e:  # noqa: BLE001
                status['failed'] += 1
                finished.add(ci)
                log(f'  cell {c["x"]}/{c["y"]} failed: {str(e)[:300]}')
                submit()
                continue
            submit()
            status['read_s'] += rs
            if P is None:
                status['empty'] += 1
                finished.add(ci)
                continue
            t2 = time.time()
            status['points'] += len(P)
            grid = Grid(P['X'], P['Y'], 4.0 * k)
            for i, rxy in zip(b_idx, rings):
                out_i.append(int(i))
                out.append(measure(rxy, k, P, grid))
            status['measure_s'] += time.time() - t2
            status['done'] += 1
            finished.add(ci)
            if n_seen % 50 == 1:
                area = (box[2] - box[0]) * (box[3] - box[1]) / k / k
                log(f'  cell {n_seen}/{len(mine)} {c["x"]}/{c["y"]}: {len(b_idx)} buildings, {len(c["ds"])} collections, {len(P)} points ({len(P) / area:.1f}/m2), read {rs:.1f} s, measure {time.time() - t2:.1f} s')
            if time.time() - last_save > 60:
                save()
                last_save = time.time()
        if broken:
            for _, _, f in pending:
                f.cancel()
    save(final=not broken)
    log(('shard stopped (a reader died); ' if broken else 'shard done ') + json.dumps({k: (round(v, 1) if isinstance(v, float) else v) for k, v in status.items() if k != 'finished_cells'}))
    return 3 if broken else 0


# ---------------------------------------------------------------- merge
def pct(x, q):
    return round(float(np.percentile(x, q)), 2) if len(x) else None


def compare(new, ref):
    d = new - ref
    if len(d) == 0:
        return {'n': 0}
    ad, rel = np.abs(d), np.abs(d) / np.maximum(ref, 1.0)
    return {'n': int(len(d)), 'median_diff_m': pct(d, 50), 'p05': pct(d, 5), 'p95': pct(d, 95), 'median_abs_m': pct(ad, 50),
            'share_within_2m': round(float((ad <= 2).mean()), 3), 'share_within_3m': round(float((ad <= 3).mean()), 3),
            'share_within_20pct': round(float((rel <= 0.2).mean()), 3)}


COLORS = [(4, (90, 110, 140)), (8, (80, 170, 200)), (15, (120, 200, 120)), (30, (240, 210, 90)), (60, (245, 140, 60)), (1e9, (230, 50, 50))]


def make_qa(path, lon, lat, h, lines):
    from PIL import Image, ImageDraw, ImageFont
    try:
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 15)
    except Exception:  # noqa: BLE001
        font = ImageFont.load_default()
    has = np.isfinite(h)
    col = np.zeros((len(h), 3), dtype=np.uint8)
    col[:] = (60, 60, 66)
    prev = 0
    for hi, c in COLORS:
        col[has & (h > prev) & (h <= hi)] = c
        prev = hi
    order = np.argsort(np.where(has, h, -1), kind='stable')   # tall ones drawn last
    def panel(box, W, dot):
        H = int(W * (box[3] - box[1]) / ((box[2] - box[0]) * math.cos(math.radians((box[1] + box[3]) / 2))))
        img = np.zeros((H, W, 3), dtype=np.uint8)
        img[:] = (14, 18, 24)
        px = ((lon - box[0]) / (box[2] - box[0]) * W).astype(np.int64)
        py = ((box[3] - lat) / (box[3] - box[1]) * H).astype(np.int64)
        ok = (px >= 0) & (px < W - dot) & (py >= 0) & (py < H - dot)
        o = order[ok[order]]
        for dy in range(dot):
            for dx in range(dot):
                img[py[o] + dy, px[o] + dx] = col[o]
        return img
    if has.any():
        lo_, la_ = lon[has], lat[has]
        isl = (float(lo_.min()) - 0.01, float(la_.min()) - 0.01, float(lo_.max()) + 0.01, float(la_.max()) + 0.01)
    else:
        isl = (-67.98, 17.86, -65.2, 18.54)
    top = panel(isl, 1600, 1 if isl[2] - isl[0] > 0.5 else 3)
    sj = panel((-66.13, 18.40, -66.02, 18.475), 1600, 2)
    im = Image.new('RGB', (1600, 34 + top.shape[0] + 30 + sj.shape[0] + 40 + 20 * len(lines)), (14, 18, 24))
    dr = ImageDraw.Draw(im)
    dr.text((8, 8), 'Building height from the USGS 3DEP 2018 lidar point cloud (p90 of roof last returns above the ground beside). Grey = no value.', fill=(235, 235, 235), font=font)
    im.paste(Image.fromarray(top), (0, 34))
    y = 34 + top.shape[0] + 6
    dr.text((8, y), 'San Juan', fill=(235, 235, 235), font=font)
    im.paste(Image.fromarray(sj), (0, y + 24))
    y += 24 + sj.shape[0] + 8
    x, prev = 8, 0
    for hi, c in COLORS:
        dr.rectangle((x, y, x + 14, y + 14), fill=c)
        dr.text((x + 19, y - 1), f'{prev}–{hi:g} m' if hi < 1e8 else f'> {prev} m', fill=(220, 220, 220), font=font)
        x += 120
        prev = hi
    for i, s in enumerate(lines):
        dr.text((8, y + 24 + i * 20), s, fill=(225, 225, 225), font=font)
    im.save(path, quality=86)


def cmd_merge(a):
    global LOG
    LOG = os.path.join(a.work, 'log_merge.txt')
    open(LOG, 'w').close()
    plan = json.load(open(os.path.join(a.work, 'plan', 'plan.json')))
    total = plan['total']
    v = np.full((total, 6), np.nan, dtype=np.float32)
    v[:, 3:5] = 0
    seen = np.zeros(total, dtype=bool)
    statuses = []
    for f in sorted(f for f in glob.glob(os.path.join(a.work, 'shard', 'shard_*.npz')) if not f.endswith('.tmp.npz')):
        z = np.load(f)
        v[z['i']] = z['v']
        seen[z['i']] = True
    for f in sorted(glob.glob(os.path.join(a.work, 'shard', 'status_*.json'))):
        st = json.load(open(f))
        st.pop('finished_cells', None)
        statuses.append(st)
    shards_in = len(statuses)
    planned = sum(c['n'] for c in plan['cells'])
    complete = shards_in == plan['shards'] and all(s['failed'] == 0 and s['skipped_for_time'] == 0 and s.get('complete', True) for s in statuses) and not plan['only']
    h = v[:, 0]
    has = np.isfinite(h)
    log(f'buildings {total}, in the plan {planned}, read {int(seen.sum())}, measured {int(has.sum())}; shards in {shards_in}/{plan["shards"]}; complete {complete}')
    # what the tiles held, for comparison: the height byte and, where the tiles have ids files, its source
    idx, off = tile_offsets(a.site)
    if idx['generated'] != plan['generated']:
        raise SystemExit(f'site tiles are of {idx["generated"]}, the plan of {plan["generated"]}')
    old = np.zeros(total, dtype=np.float32)
    src = np.full(total, '', dtype=object)
    lon = np.zeros(total)
    lat = np.zeros(total)
    added = np.zeros(total, dtype=bool)
    for t, (x, y, _) in enumerate(idx['tiles']):
        rings, hb, add, ids = read_tile(a.site, x, y)
        sl = slice(off[t], off[t + 1])
        old[sl] = hb / 2.0
        added[sl] = add
        if ids:
            src[sl] = [(l.split(',') + ['', '', ''])[2] for l in ids]
        lon[sl] = [r[0].mean() for r in rings]
        lat[sl] = [r[1].mean() for r in rings]
    inplan = np.zeros(total, dtype=bool)
    pz = np.load(os.path.join(a.work, 'plan', 'plan.npz'))
    inplan[pz['order']] = True
    qa = {
        'buildings': total, 'in_plan': int(inplan.sum()), 'read': int(seen.sum()), 'measured': int(has.sum()),
        'share_measured_of_read': round(float(has[seen].mean()), 4) if seen.any() else None,
        'share_measured_osm': round(float(has[seen & ~added].mean()), 4) if (seen & ~added).any() else None,
        'share_measured_added': round(float(has[seen & added].mean()), 4) if (seen & added).any() else None,
        'no_value_reasons': {
            'no_ground_or_no_points': int((seen & ~has & (v[:, 4] < MIN_GROUND)).sum()),
            'too_few_roof_points': int((seen & ~has & (v[:, 4] >= MIN_GROUND) & (v[:, 3] < MIN_ROOF)).sum()),
            'cover_below_min': int((seen & ~has & (v[:, 3] >= MIN_ROOF) & (v[:, 2] < MIN_COVER)).sum()),
        },
        'height_m': {'p10': pct(h[has], 10), 'p50': pct(h[has], 50), 'p90': pct(h[has], 90), 'p99': pct(h[has], 99), 'max': pct(h[has], 100)},
        'p90_minus_p50_m': {'p50': pct((h - v[:, 1])[has], 50), 'p90': pct((h - v[:, 1])[has], 90)},
        'against_tile_height': {},
    }
    both = has & (old > 0)
    qa['against_tile_height']['all_with_a_height'] = compare(h[both], old[both])
    for s in sorted(set(src[both]) - {''}):
        m = both & (src == s)
        qa['against_tile_height'][s] = compare(h[m], old[m])
    tall = np.argsort(np.where(has, -h, 0))[:15]
    qa['tallest'] = [{'i': int(i), 'lon': round(float(lon[i]), 6), 'lat': round(float(lat[i]), 6), 'height_m': round(float(h[i]), 1), 'p50_m': round(float(v[i, 1]), 1),
                      'tile_height_m': float(old[i]) or None, 'tile_source': src[i] or None} for i in tall if has[i]]
    log(json.dumps(qa, indent=1))
    out_d = os.path.join(a.out, 'data/hazards/heights')
    os.makedirs(out_d, exist_ok=True)
    dm = lambda x: np.where(np.isfinite(x), np.clip(np.round(x * 10), 1, 65535), 0).astype('<u2')  # noqa: E731
    dm(v[:, 1]).tofile(os.path.join(out_d, 'buildings_p50.bin'))
    np.where(np.isfinite(v[:, 2]), np.clip(np.round(v[:, 2] * 100), 0, 100), 255).astype(np.uint8).tofile(os.path.join(out_d, 'buildings_cover.bin'))
    cols = plan['collections']
    meta = {
        'complete': bool(complete),
        'partial_test_run_only_tiles_matching': plan['only'],
        'source': {'name': 'USGS 3D Elevation Program (3DEP) lidar point clouds, Entwine Point Tiles on AWS Open Data (usgs-lidar-public)', 'publisher': 'U.S. Geological Survey',
                   'licence': 'Public domain (U.S. Government work)', 'urls': [c['url'] for c in cols], 'collections': cols,
                   'registry': 'https://registry.opendata.aws/usgs-lidar/', 'flown': '2018-04 to 2019-04 (USGS project PR_PRVI 2018, after hurricane Maria)'},
        'method': ('For each building footprint (outer ring): roof = last returns (return number equal to the number of returns) of class 1 (unclassified) or 6 (building) '
                   f'inside the ring and more than {INSET_M} m from it, more than {MIN_H} m above the ground; ground = the median of class 2 (ground) points 1 to {NEAR_M} m outside '
                   f'the ring (1 to {FAR_M} m when fewer than {MIN_GROUND} are found). Height = 90th percentile of the roof elevations minus the ground; p50 = their median. '
                   f'No value unless there are at least {MIN_ROOF} roof points and {MIN_GROUND} ground points, at least {int(MIN_COVER * 100)} % of the last returns inside the inset ring '
                   f'are roof points, and the height is {MIN_H} to {MAX_H} m. Points read with PDAL readers.ept at resolution {RES_M} m, one query per zoom-{CELL_Z} cell; every 2018 '
                   'collection whose bounds meet the cell is pooled. Heights are differences within one point cloud, so its vertical datum cancels out.'),
        'records': {'buildings.bin': 'uint16 height_dm, p90 roof minus ground, decimetres; 0 = no value',
                    'buildings_p50.bin': 'uint16 p50_dm, median roof minus ground, decimetres; 0 = no value',
                    'buildings_cover.bin': 'uint8 percent of the last returns inside the inset ring that are roof points; 255 = not measured (no points, no ground, or the cell was not read)'},
        'limits': 'The lidar is of 2018-2019: a building built, raised or demolished since then is wrong or has no value. Footprints mostly under trees get no value. A footprint that covers more than one building gets the taller part (p90).',
        'shards': statuses, 'qa': qa,
        'generated': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    }
    common.write_stage(a.out, 'heights', dm(h), '<u2', {}, meta, plan['generated'])
    lines = [f'{int(has.sum()):,} of {total:,} buildings measured ({100 * has.mean():.1f} %); of those read: {100 * qa["share_measured_of_read"]:.1f} %' if seen.any() else 'nothing read',
             'against the tile heights: ' + ', '.join(f'{k} n={c["n"]} median |d| {c.get("median_abs_m")} m' for k, c in qa['against_tile_height'].items() if c.get('n'))]
    make_qa(os.path.join(out_d, 'qa.jpg'), lon, lat, np.where(has, h, np.nan), lines)
    log('written', out_d, 'complete' if complete else 'INCOMPLETE')
    return 0 if complete else 2


def main():
    p = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    sp = p.add_subparsers(dest='cmd', required=True)
    q = sp.add_parser('plan'); q.add_argument('--site', required=True); q.add_argument('--work', required=True); q.add_argument('--shards', type=int, default=20); q.add_argument('--only', default='')
    q = sp.add_parser('shard'); q.add_argument('--site', required=True); q.add_argument('--work', required=True); q.add_argument('--shard', type=int, required=True); q.add_argument('--budget', type=float, default=3000)
    q.add_argument('--deadline', type=float, default=0, help='unix time to stop reading at (overrides --budget; a resumed run keeps the first one)'); q.add_argument('--readers', type=int, default=3)
    q = sp.add_parser('merge'); q.add_argument('--site', required=True); q.add_argument('--work', required=True); q.add_argument('--out', required=True)
    a = p.parse_args()
    if a.cmd == 'plan':
        cmd_plan(a)
    elif a.cmd == 'shard':
        sys.exit(cmd_shard(a))
    else:
        sys.exit(cmd_merge(a))


if __name__ == '__main__':
    main()
