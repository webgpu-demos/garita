#!/usr/bin/env python3
"""Garita hazard stage "lidar": ground elevation of every building and asset from the USGS 3DEP 1 m bare-earth DEM.

Source   GeoTIFF tiles (10 km squares, NAD83 / UTM zone 19N or 20N, float32 metres) under
         https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1m/Projects/PR_*/TIFF/ . Two collections:
         PR_PuertoRicoUSVI_D24 (flown 2023-12 to 2025-03) and PR_PRVI_{A,C,D,E,F,G,H}_2018 (flown 2018-04 to 2019-04,
         after hurricane María). The bucket is listed on every run; nothing is hard-coded but the prefix.
Statistic  For a point, the MEDIAN of the DEM cells whose centre lies within 2 m of it (11 to 14 one-metre cells).
         These are bare-earth models: the building is already removed and the ground under it interpolated, so the
         footprint is not masked. A value is accepted only when at least half of those cells hold data; otherwise
         the point is "no data" (-32768 / null). Nothing is filled, interpolated across gaps or guessed.
Priority The newest collection that has an accepted value at the point wins (D24, then 2018). Within a collection,
         when several tiles cover the point (6 m tile overlap, overlapping 2018 work units, the two UTM zones) the
         tile with the most valid cells wins. Every tile that contains at least one point is sampled in BOTH
         collections, so the disagreement between them is measured, not assumed.
Datum    The tiles carry no vertical CRS and their sidecar XML only repeats a national boilerplate, so the vertical
         datum is read from USGS's own per-work-unit record (WESM.csv: vert_crs, geoid) and the vendor DEM metadata
         (altdatum, altunits); what was found is written to meta.json, word for word.
Position Building centroids are WGS 84 longitude/latitude (OpenStreetMap); they are projected to UTM on the GRS 80
         ellipsoid as if they were NAD 83 (the two differ by about a metre here, less than a building).

Three steps, so the work can be spread over a job matrix (108 GB of tiles do not fit on one runner at once):
  plan   list the bucket, read every tile header (HTTP range reads), keep the tiles that contain a point, split
         them into shards by size; writes work/plan/{plan.json, points.npz}
  shard  download a tile, sample, delete; writes work/shard/shard_<i>.npz
  merge  combine the shards, write out/data/hazards/lidar/{buildings.bin, assets.json, meta.json, qa.jpg, log.txt}

Needs: numpy; GDAL (python3-gdal) for plan and shard; Pillow for merge.
"""
import argparse
import csv
import datetime
import glob
import io
import json
import math
import os
import re
import struct
import subprocess
import sys
import time
import traceback
import urllib.parse
import urllib.request
import warnings
from concurrent.futures import ThreadPoolExecutor

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

BUCKET = 'https://prd-tnm.s3.amazonaws.com/'
PREFIX = 'StagedProducts/Elevation/1m/Projects/'
WESM = BUCKET + 'StagedProducts/Elevation/metadata/WESM.csv'
RADIUS_M = 2.0          # cells whose centre is within this distance of the point
MIN_SHARE = 0.5         # share of those cells that must hold data
NODATA16 = -32768
THRESHOLDS_M = (0.5, 1.0, 1.5, 2.0, 3.0)
# Places a person can check. lon, lat, and a rough expectation written before the run (not a measurement).
SPOTS = [
    ('Old San Juan, Plaza de Armas', -66.1165, 18.4655, 'on the ridge of the islet, roughly 20 m'),
    ('Cataño, blocks nearest the bay', -66.1132, 18.4433, 'bay shore, about 1 m'),
    ('Loíza, town plaza', -65.8800, 18.4313, 'coastal plain, a few metres'),
    ('Ponce, La Playa', -66.6170, 17.9800, 'harbour barrio, 1 to 3 m'),
    ('Aibonito, town plaza', -66.2660, 18.1400, 'hill town, roughly 600 to 700 m'),
    ('San Juan airport (SJU), apron', -66.0018, 18.4394, 'published field elevation 9 ft = 2.7 m'),
    ('Aguadilla airport (BQN), runway', -67.1294, 18.4949, 'published field elevation 237 ft = 72 m is the highest point of the runway; this is the airport reference point, so somewhat lower'),
    ('Condado, near Ashford Avenue', -66.0720, 18.4570, 'barrier strip beside the lagoon, 1 to 4 m'),
]

os.environ.update({
    'GDAL_DISABLE_READDIR_ON_OPEN': 'EMPTY_DIR', 'CPL_VSIL_CURL_ALLOWED_EXTENSIONS': '.tif', 'GDAL_HTTP_MAX_RETRY': '4',
    'GDAL_HTTP_RETRY_DELAY': '2', 'GDAL_HTTP_TIMEOUT': '60', 'GDAL_CACHEMAX': '512',
})

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


# ---------------------------------------------------------------- geometry
def utm(lon, lat, zone):
    """Longitude/latitude (degrees) to UTM easting/northing on GRS 80 (Krüger series, sub-millimetre)."""
    a, f, k0 = 6378137.0, 1 / 298.257222101, 0.9996
    n = f / (2 - f)
    A = a / (1 + n) * (1 + n ** 2 / 4 + n ** 4 / 64 + n ** 6 / 256)
    al = (n / 2 - 2 * n ** 2 / 3 + 5 * n ** 3 / 16 + 41 * n ** 4 / 180,
          13 * n ** 2 / 48 - 3 * n ** 3 / 5 + 557 * n ** 4 / 1440,
          61 * n ** 3 / 240 - 103 * n ** 4 / 140,
          49561 * n ** 4 / 161280)
    lam = np.radians(np.asarray(lon, dtype=np.float64) - (zone * 6 - 183))
    s = np.sin(np.radians(np.asarray(lat, dtype=np.float64)))
    c = 2 * math.sqrt(n) / (1 + n)
    t = np.sinh(np.arctanh(s) - c * np.arctanh(c * s))
    xi = np.arctan2(t, np.cos(lam))
    eta = np.arctanh(np.sin(lam) / np.sqrt(1 + t * t))
    E, N = eta.copy(), xi.copy()
    for j, aj in enumerate(al, 1):
        E += aj * np.cos(2 * j * xi) * np.sinh(2 * j * eta)
        N += aj * np.sin(2 * j * xi) * np.cosh(2 * j * eta)
    return 500000.0 + k0 * A * E, k0 * A * N


def sample_window(a, nodata, xf, yf, res, radius=RADIUS_M, min_share=MIN_SHARE):
    """a: 2-D float array (rows north to south). xf, yf: fractional column and row of each point in a.
    Returns (median of the valid cells whose centre is within radius, number of valid cells, number of cells in
    the disc, value of the cell the point falls in). The median is NaN when fewer than min_share of the disc's
    cells hold data (cells outside the array count as holding none)."""
    K = int(math.ceil(radius / res))
    c = np.floor(xf).astype(np.int64)
    r = np.floor(yf).astype(np.int64)
    fx, fy = xf - c, yf - r
    H, W = a.shape
    n = len(c)
    vals = np.full((n, (2 * K + 1) ** 2), np.nan, dtype=np.float32)
    ncell = np.zeros(n, dtype=np.int16)
    nd = None if nodata is None else np.float32(nodata)
    j = 0
    for dy in range(-K, K + 1):
        for dx in range(-K, K + 1):
            m = np.hypot(dx + 0.5 - fx, dy + 0.5 - fy) * res <= radius
            ncell += m
            rr, cc = r + dy, c + dx
            inb = np.nonzero(m & (rr >= 0) & (rr < H) & (cc >= 0) & (cc < W))[0]
            v = a[rr[inb], cc[inb]].astype(np.float32)
            ok = np.isfinite(v) & (v > -1e4) & (v < 1e4)      # elevations on Earth; also rejects any odd no-data code
            if nd is not None and np.isfinite(nd):
                ok &= v != nd
            vals[inb, j] = np.where(ok, v, np.nan)
            j += 1
    nv = np.sum(~np.isnan(vals), axis=1).astype(np.int16)
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        med = np.nanmedian(vals, axis=1).astype(np.float32)
    med[(nv == 0) | (nv < np.ceil(min_share * ncell))] = np.nan
    ctr = vals[:, ((2 * K + 1) ** 2) // 2]
    return med, nv, ncell, ctr


def in_tile(t, pts):
    """Fractional column/row of every point in tile t, and the indices of those inside its extent."""
    E, N = pts[t['zone']]
    gt = t['gt']
    x = (E - gt[0]) / gt[1]
    y = (N - gt[3]) / gt[5]
    idx = np.nonzero((x >= 0) & (x < t['w']) & (y >= 0) & (y < t['h']))[0]
    return x, y, idx


# ---------------------------------------------------------------- points
def load_old_ground(site):
    """The ground elevation stored in the building tiles today (int16 decimetres, -32768 unknown), canonical order."""
    idx = json.load(open(os.path.join(site, 'tiles/bld/index.json')))
    out = np.empty(idx['total'], dtype=np.int16)
    k = 0
    for x, y, count in idx['tiles']:
        b = open(os.path.join(site, f'tiles/bld/{common.Z}/{x}/{y}.bin'), 'rb').read()
        n = struct.unpack_from('<I', b, 4)[0]
        o = 8
        for _ in range(n):
            nv = struct.unpack_from('<H', b, o)[0]
            out[k] = struct.unpack_from('<h', b, o + 4)[0]
            k += 1
            o += 8 + 4 * nv
    assert k == idx['total']
    return out


def project_points(lon, lat, zones):
    return {int(z): utm(lon, lat, int(z)) for z in zones}


# ---------------------------------------------------------------- bucket
def s3_list(prefix, delimiter=None):
    keys, prefixes, token = [], [], None
    for _ in range(50):
        q = {'list-type': '2', 'prefix': prefix, 'max-keys': '1000'}
        if delimiter:
            q['delimiter'] = delimiter
        if token:
            q['continuation-token'] = token
        xml = fetch(BUCKET + '?' + urllib.parse.urlencode(q)).decode()
        for m in re.finditer(r'<Contents><Key>([^<]+)</Key><LastModified>([^<]+)</LastModified>.*?<Size>(\d+)</Size>', xml, flags=re.S):
            keys.append((m.group(1), int(m.group(3)), m.group(2)))
        prefixes += re.findall(r'<CommonPrefixes><Prefix>([^<]+)</Prefix>', xml)
        m = re.search(r'<NextContinuationToken>([^<]+)</NextContinuationToken>', xml)
        if not m:
            break
        token = m.group(1)
    return keys, prefixes


def collection_year(project):
    m = re.search(r'_D(\d\d)$', project)
    if m:
        return 2000 + int(m.group(1))
    m = re.search(r'_((?:19|20)\d\d)$', project)
    return int(m.group(1)) if m else 0


def read_header(t):
    from osgeo import gdal
    err = None
    for i in range(4):
        try:
            ds = gdal.Open('/vsicurl/' + t['url'])
            b = ds.GetRasterBand(1)
            s = ds.GetSpatialRef()
            gt = ds.GetGeoTransform()
            t.update(w=ds.RasterXSize, h=ds.RasterYSize, gt=list(gt), nodata=b.GetNoDataValue(), zone=int(s.GetUTMZone()),
                     crs=s.GetName(), epsg=s.GetAuthorityCode(None), compound=bool(s.IsCompound()),
                     vert_cs=s.GetAttrValue('VERT_CS'), unit_type=b.GetUnitType(), linear_unit=s.GetLinearUnitsName(),
                     dtype=gdal.GetDataTypeName(b.DataType), layout=ds.GetMetadataItem('LAYOUT', 'IMAGE_STRUCTURE'))
            ds = None
            return t
        except Exception as e:  # noqa: BLE001
            err = e
            time.sleep(1 + 2 * i)
    t['error'] = f'header: {err}'
    return t


def datum_evidence(projects):
    """What USGS itself records about the vertical reference of these work units. Best effort; every failure is
    written down instead of being papered over."""
    ev = {'wesm_url': WESM, 'workunits': [], 'vendor_dem_metadata': [], 'errors': []}
    try:
        rows = list(csv.DictReader(io.StringIO(fetch(WESM, timeout=120).decode('utf-8', 'replace'))))
    except Exception as e:  # noqa: BLE001
        ev['errors'].append(f'WESM.csv: {e}')
        return ev
    seen = set()
    for r in rows:
        if r.get('workunit') in projects or r.get('project') in projects:
            ev['workunits'].append({k: r.get(k) for k in ('workunit', 'project', 'collect_start', 'collect_end', 'ql', 'spec', 'horiz_crs', 'vert_crs', 'geoid', 'onemeter_category', 'onemeter_reason', 'metadata_link')})
            link = (r.get('metadata_link') or '').strip()
            m = re.search(r'prefix=([^&]+)', link) or re.search(r'amazonaws\.com/(.+)$', link)
            if not m or m.group(1) in seen:
                continue
            seen.add(m.group(1))
            try:
                keys, _ = s3_list(urllib.parse.unquote(m.group(1)).rstrip('/') + '/reports/vendor_provided_xml/')
                for k, _, _ in keys:
                    if re.search(r'DEM', k, re.I) and k.lower().endswith('.xml'):
                        x = fetch(BUCKET + urllib.parse.quote(k)).decode('utf-8', 'replace')
                        g = lambda tag: [s.strip() for s in re.findall(rf'<{tag}>(.*?)</{tag}>', x, flags=re.S)]  # noqa: E731
                        num = lambda tag: next((float(v) for v in g(tag) if re.fullmatch(r'-?[\d.]+', v)), None)  # noqa: E731
                        ev['vendor_dem_metadata'].append({'workunit': r.get('workunit'), 'file': BUCKET + k, 'title': g('title')[:1], 'altdatum': g('altdatum'), 'altunits': g('altunits'), 'altres': g('altres'),
                                                          'bbox_wsen': [num('westbc'), num('southbc'), num('eastbc'), num('northbc')]})
            except Exception as e:  # noqa: BLE001
                ev['errors'].append(f"{r.get('workunit')}: {e}")
    return ev


# ---------------------------------------------------------------- plan
def cmd_plan(a):
    from osgeo import gdal, osr
    gdal.UseExceptions()
    os.makedirs(a.work + '/plan', exist_ok=True)
    plan = {'ok': False, 'only': a.only, 'shards': a.shards, 'tiles': [], 'run': os.environ.get('GITHUB_RUN_ID'), 'sha': os.environ.get('GITHUB_SHA')}
    try:
        lon, lat, stamp = common.load_buildings(a.site)
        old = load_old_ground(a.site)
        assets = common.load_assets(a.site)
        nb = len(lon)
        lon = np.concatenate([lon, [x[1] for x in assets], [s[1] for s in SPOTS]])
        lat = np.concatenate([lat, [x[2] for x in assets], [s[2] for s in SPOTS]])
        log(f'points: {nb} buildings ({stamp}), {len(assets)} assets, {len(SPOTS)} spots; old ground known for {int((old != NODATA16).sum())}')
        np.savez_compressed(a.work + '/plan/points.npz', lon=lon, lat=lat, old=old)
        json.dump({'ids': [x[0] for x in assets]}, open(a.work + '/plan/assets.json', 'w'))
        plan.update(nb=nb, na=len(assets), ns=len(SPOTS), bld_stamp=stamp)

        _, prefixes = s3_list(PREFIX + 'PR_', '/')
        projects = sorted(p[len(PREFIX):].rstrip('/') for p in prefixes if p.endswith('/'))
        log('projects in the bucket:', projects)
        tiles = []
        for p in projects:
            keys, _ = s3_list(PREFIX + p + '/TIFF/')
            ks = [k for k in keys if k[0].lower().endswith('.tif')]
            log(f'  {p}: {len(ks)} tiles, {sum(k[1] for k in ks) / 1e9:.1f} GB')
            for k, size, mod in ks:
                tiles.append({'key': k, 'url': BUCKET + k, 'name': os.path.basename(k), 'size': size, 'modified': mod, 'project': p, 'year': collection_year(p)})
        plan['listed'] = {'tiles': len(tiles), 'bytes': sum(t['size'] for t in tiles), 'projects': projects}
        if a.only:
            tiles = [t for t in tiles if re.search(a.only, t['key'])]
            log(f'TEST RUN: only tiles matching /{a.only}/ -> {len(tiles)}')
        with ThreadPoolExecutor(24) as ex:
            tiles = list(ex.map(read_header, tiles))
        bad = [t for t in tiles if 'error' in t]
        for t in bad:
            log('HEADER FAILED', t['name'], t['error'])
        tiles = [t for t in tiles if 'error' not in t]
        log(f'headers read: {len(tiles)}, failed {len(bad)}; zones {sorted({t["zone"] for t in tiles})}; crs {sorted({t["crs"] for t in tiles})}; '
            f'nodata {sorted({str(t["nodata"]) for t in tiles})}; vertical CRS in the GeoTIFF {sorted({str(t["vert_cs"]) for t in tiles})}; '
            f'unit type {sorted({repr(t["unit_type"]) for t in tiles})}; sizes {sorted({(t["w"], t["h"]) for t in tiles})}; pixel {sorted({(t["gt"][1], t["gt"][5]) for t in tiles})}')
        for t in tiles:
            assert t['gt'][2] == 0 and t['gt'][4] == 0 and t['gt'][5] < 0, ('not north-up', t['name'])
        zones = sorted({t['zone'] for t in tiles})
        pts = project_points(lon, lat, zones)
        # the hand-written projection against PROJ (WGS 84 -> the tiles' CRS), on a sample
        for z in zones:
            t = next(t for t in tiles if t['zone'] == z)
            src = osr.SpatialReference(); src.ImportFromEPSG(4326); src.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
            dst = osr.SpatialReference(); dst.ImportFromEPSG(int(t['epsg'])); dst.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
            ct = osr.CoordinateTransformation(src, dst)
            ii = np.linspace(0, len(lon) - 1, 2000).astype(int)
            ref = np.array(ct.TransformPoints([(float(lon[i]), float(lat[i])) for i in ii]))[:, :2]
            d = np.hypot(pts[z][0][ii] - ref[:, 0], pts[z][1][ii] - ref[:, 1])
            log(f'projection check zone {z} (EPSG:{t["epsg"]}): max difference to PROJ {d.max():.4f} m over {len(ii)} points')
            plan.setdefault('projection_check_m', {})[str(z)] = round(float(d.max()), 4)
            assert d.max() < 0.05, 'projection differs from PROJ'
        covered = np.zeros(len(lon), dtype=bool)
        for t in tiles:
            _, _, idx = in_tile(t, pts)
            t['npts'] = int(len(idx))
            covered[idx] = True
        use = [t for t in tiles if t['npts'] > 0]
        log(f'tiles holding at least one point: {len(use)} of {len(tiles)}, {sum(t["size"] for t in use) / 1e9:.1f} GB; '
            f'points inside no tile at all: {int((~covered[:nb]).sum())} buildings, {int((~covered[nb:nb + len(assets)]).sum())} assets')
        years = sorted({t['year'] for t in use}, reverse=True)
        load = [0] * a.shards
        for i, t in enumerate(sorted(use, key=lambda t: -t['size'])):
            t['rank'] = years.index(t['year'])
            t['shard'] = load.index(min(load))
            load[t['shard']] += t['size'] + 20e6
        use.sort(key=lambda t: (t['rank'], t['key']))
        for i, t in enumerate(use):
            t['i'] = i
        log('shard load (GB):', [round(x / 1e9, 1) for x in load])
        plan.update(tiles=use, years=years, header_failed=[t['name'] for t in bad], uncovered_buildings=int((~covered[:nb]).sum()),
                    datum_evidence=datum_evidence(set(t['project'] for t in use)), ok=True)
        ev = plan['datum_evidence']
        log('vertical reference per USGS WESM:', sorted({(w['workunit'], w['vert_crs'], w['geoid']) for w in ev['workunits']}))
        log('vendor DEM metadata:', [(v['workunit'], v['altdatum'], v['altunits']) for v in ev['vendor_dem_metadata']], 'errors:', ev['errors'])
        # one sidecar XML per project: what the tile's own metadata says, and the publisher's use limits
        side = {}
        for p in sorted({t['project'] for t in use}):
            t = next(t for t in use if t['project'] == p)
            try:
                x = fetch(t['url'].replace('/TIFF/', '/metadata/')[:-4] + '.xml').decode('utf-8', 'replace')
                g = lambda tag: [re.sub(r'\s+', ' ', s).strip() for s in re.findall(rf'<{tag}>(.*?)</{tag}>', x, flags=re.S)]  # noqa: E731
                ab = ' '.join(g('abstract'))
                side[p] = {'file': t['name'][:-4] + '.xml', 'pubdate': g('pubdate')[:1], 'begdate': g('begdate')[:1], 'enddate': g('enddate')[:1], 'altdatum': g('altdatum'),
                           'vertical_sentences': [s.strip() + '.' for s in ab.split('.') if re.search(r'vertical|elevation values', s, re.I)],
                           'useconst': g('useconst')[:1], 'accconst': g('accconst')[:1]}
            except Exception as e:  # noqa: BLE001
                side[p] = {'error': str(e)}
        plan['sidecar'] = side
    except Exception:  # noqa: BLE001
        plan['error'] = traceback.format_exc()
        log('PLAN FAILED\n' + plan['error'])
    plan['seconds'] = round(time.time() - T0, 1)
    json.dump(plan, open(a.work + '/plan/plan.json', 'w'))
    log('plan written, ok =', plan['ok'])


# ---------------------------------------------------------------- shard
def do_tile(t, pts, tmp):
    from osgeo import gdal
    st = {'i': t['i'], 'name': t['name'], 'ok': False}
    path = os.path.join(tmp, t['name'])
    try:
        t1 = time.time()
        p = subprocess.run(['curl', '-sS', '--fail', '--retry', '5', '--retry-delay', '3', '--retry-all-errors', '-m', '1200', '-o', path, t['url']], capture_output=True, text=True)
        if p.returncode != 0 or os.path.getsize(path) != t['size']:
            raise RuntimeError(f'download rc={p.returncode} size={os.path.getsize(path) if os.path.exists(path) else None} expected {t["size"]}: {p.stderr[-300:]}')
        st['dl_s'] = round(time.time() - t1, 1)
        t1 = time.time()
        ds = gdal.Open(path)
        b = ds.GetRasterBand(1)
        gt = ds.GetGeoTransform()
        assert (ds.RasterXSize, ds.RasterYSize) == (t['w'], t['h']) and max(abs(g - h) for g, h in zip(gt, t['gt'])) < 1e-6, 'header changed since the plan'
        x, y, idx = in_tile(t, pts)
        K = int(math.ceil(RADIUS_M / gt[1])) + 1
        c0, c1 = max(0, int(x[idx].min()) - K), min(t['w'], int(x[idx].max()) + K + 1)
        r0, r1 = max(0, int(y[idx].min()) - K), min(t['h'], int(y[idx].max()) + K + 1)
        arr = b.ReadAsArray(c0, r0, c1 - c0, r1 - r0)
        nd = b.GetNoDataValue()
        ds = None
        med, nv, nc, ctr = sample_window(arr, nd, x[idx] - c0, y[idx] - r0, gt[1])
        del arr
        keep = nv > 0
        st.update(ok=True, read_s=round(time.time() - t1, 1), npts=int(len(idx)), with_cells=int(keep.sum()), accepted=int(np.isfinite(med).sum()), nodata=nd)
        return st, (idx[keep].astype(np.int32), np.full(int(keep.sum()), t['i'], np.int16), med[keep], nv[keep].astype(np.uint8), nc[keep].astype(np.uint8), ctr[keep])
    except Exception as e:  # noqa: BLE001
        st['error'] = f'{type(e).__name__}: {e}'
        return st, None
    finally:
        if os.path.exists(path):
            os.remove(path)


def cmd_shard(a):
    os.makedirs(a.work + '/shard', exist_ok=True)
    status = {'shard': a.shard, 'ok': False, 'tiles': []}
    parts = []
    try:
        from osgeo import gdal
        gdal.UseExceptions()
        plan = json.load(open(a.work + '/plan/plan.json'))
        assert plan['ok'], 'the plan failed'
        z = np.load(a.work + '/plan/points.npz')
        tiles = [t for t in plan['tiles'] if t['shard'] == a.shard]
        pts = project_points(z['lon'], z['lat'], sorted({t['zone'] for t in tiles}))
        tmp = a.work + '/tmp'
        os.makedirs(tmp, exist_ok=True)
        log(f'shard {a.shard}: {len(tiles)} tiles, {sum(t["size"] for t in tiles) / 1e9:.1f} GB, {sum(t["npts"] for t in tiles)} point lookups')
        with ThreadPoolExecutor(a.threads) as ex:
            for st, part in ex.map(lambda t: do_tile(t, pts, tmp), sorted(tiles, key=lambda t: -t['size'])):
                status['tiles'].append(st)
                if part is not None:
                    parts.append(part)
                    log(f'  {st["name"]}: {st["npts"]} points, {st["accepted"]} accepted, {st["npts"] - st["with_cells"]} without any cell; download {st["dl_s"]} s, read+sample {st["read_s"]} s')
                else:
                    log(f'  TILE FAILED {st["name"]}: {st.get("error")}')
        status['ok'] = all(s['ok'] for s in status['tiles'])
    except Exception:  # noqa: BLE001
        status['error'] = traceback.format_exc()
        log(f'SHARD {a.shard} FAILED\n' + status['error'])
    cat = lambda k, dt: np.concatenate([p[k] for p in parts]).astype(dt) if parts else np.zeros(0, dt)  # noqa: E731
    np.savez_compressed(f'{a.work}/shard/shard_{a.shard}.npz', idx=cat(0, np.int32), tile=cat(1, np.int16), val=cat(2, np.float32), nv=cat(3, np.uint8), nc=cat(4, np.uint8), ctr=cat(5, np.float32))
    status['seconds'] = round(time.time() - T0, 1)
    json.dump(status, open(f'{a.work}/shard/status_{a.shard}.json', 'w'))
    log(f'shard {a.shard} done in {status["seconds"]} s, ok = {status["ok"]}')


# ---------------------------------------------------------------- merge
def pct(x, q):
    return round(float(np.percentile(x, q)), 3) if len(x) else None


def dist_stats(d):
    """Summary of a vector of differences in metres."""
    if len(d) == 0:
        return {'n': 0}
    ad = np.abs(d)
    return {'n': int(len(d)), 'median': pct(d, 50), 'p05': pct(d, 5), 'p95': pct(d, 95), 'mean': round(float(d.mean()), 3),
            'median_abs': pct(ad, 50), 'share_within_0.25m': round(float((ad <= 0.25).mean()), 4), 'share_within_0.5m': round(float((ad <= 0.5).mean()), 4),
            'share_within_1m': round(float((ad <= 1.0).mean()), 4), 'share_beyond_3m': round(float((ad > 3.0).mean()), 4)}


CLASSES = [(0.5, (215, 25, 28)), (1.0, (244, 109, 67)), (2.0, (253, 174, 97)), (3.0, (254, 224, 139)), (5.0, (166, 217, 106)), (20.0, (90, 160, 200)), (1e9, (120, 130, 145))]
DIFFS = [(-2.0, (33, 60, 160)), (-1.0, (70, 120, 210)), (-0.25, (150, 190, 235)), (0.25, (110, 115, 120)), (1.0, (250, 190, 130)), (2.0, (240, 120, 50)), (1e9, (200, 30, 30))]
MAGENTA = (255, 0, 255)


def classify(v, table):
    out = np.zeros((len(v), 3), dtype=np.uint8)
    prev = -1e9
    for hi, col in table:
        out[(v > prev) & (v <= hi)] = col
        prev = hi
    return out


def panel(lon, lat, colors, order, box, W, H, dot=1):
    img = np.zeros((H, W, 3), dtype=np.uint8)
    img[:] = (14, 18, 24)
    px = ((lon - box[0]) / (box[2] - box[0]) * W).astype(np.int64)
    py = ((box[3] - lat) / (box[3] - box[1]) * H).astype(np.int64)
    ok = (px >= 0) & (px < W - dot) & (py >= 0) & (py < H - dot)
    o = order[ok[order]]
    for dy in range(dot):
        for dx in range(dot):
            img[py[o] + dy, px[o] + dx] = colors[o]
    return img


def make_qa(path, lon, lat, new_m, old_m, lines):
    from PIL import Image, ImageDraw, ImageFont
    try:
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 15)
        small = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 12)
    except Exception:  # noqa: BLE001
        font = small = ImageFont.load_default()
    has = np.isfinite(new_m)
    col = classify(np.where(has, new_m, 0), CLASSES)
    col[~has] = MAGENTA
    # high ground first, low ground over it, no-data on top so it cannot hide
    order = np.argsort(np.where(has, -new_m, 1e9), kind='stable')
    W = 1800
    isl = (-67.98, 17.86, -65.2, 18.54)
    H1 = int(W * (isl[3] - isl[1]) / ((isl[2] - isl[0]) * math.cos(math.radians(18.2))))
    sj = (-66.17, 18.40, -65.97, 18.48)
    W2 = W // 2 - 5
    H2 = int(W2 * (sj[3] - sj[1]) / ((sj[2] - sj[0]) * math.cos(math.radians(18.44))))
    top = panel(lon, lat, col, order, isl, W, H1)
    left = panel(lon, lat, col, order, sj, W2, H2, dot=2)
    both = has & np.isfinite(old_m)
    d = np.where(both, new_m - old_m, 0)
    dcol = classify(d, DIFFS)
    dcol[~both] = (40, 44, 50)
    dorder = np.argsort(np.where(both, np.abs(d), -1), kind='stable')
    right = panel(lon, lat, dcol, dorder, sj, W2, H2, dot=2)
    pad, text_h = 30, 150
    im = Image.new('RGB', (W, pad + H1 + pad + H2 + text_h), (14, 18, 24))
    im.paste(Image.fromarray(top), (0, pad))
    im.paste(Image.fromarray(left), (0, pad + H1 + pad))
    im.paste(Image.fromarray(right), (W2 + 10, pad + H1 + pad))
    dr = ImageDraw.Draw(im)
    dr.text((8, 6), 'Ground elevation at every building, USGS 3DEP 1 m lidar DEM (median within 2 m of the centroid). Magenta = no lidar value.', fill=(235, 235, 235), font=font)
    dr.text((8, pad + H1 + 6), 'San Juan: new lidar value', fill=(235, 235, 235), font=font)
    dr.text((W2 + 18, pad + H1 + 6), 'San Juan: lidar minus the old 10 m value', fill=(235, 235, 235), font=font)
    y = pad + H1 + pad + H2 + 8
    x = 8
    prev = None
    for hi, c in CLASSES:
        lab = f'≤ {hi:g} m' if prev is None else (f'{prev:g}–{hi:g} m' if hi < 1e8 else f'> {prev:g} m')
        dr.rectangle((x, y, x + 14, y + 14), fill=c); dr.text((x + 19, y - 1), lab, fill=(220, 220, 220), font=small)
        x += 95
        prev = hi
    dr.rectangle((x, y, x + 14, y + 14), fill=MAGENTA); dr.text((x + 19, y - 1), 'no data', fill=(220, 220, 220), font=small)
    x = W2 + 18
    prev = None
    for hi, c in DIFFS:
        lab = f'< {hi:g}' if prev is None else (f'{prev:g}..{hi:g}' if hi < 1e8 else f'> {prev:g} m')
        dr.rectangle((x, y, x + 14, y + 14), fill=c); dr.text((x + 19, y - 1), lab, fill=(220, 220, 220), font=small)
        x += 100
        prev = hi
    for i, s in enumerate(lines):
        dr.text((8, y + 26 + i * 19), s, fill=(225, 225, 225), font=font)
    im.save(path, quality=86)


def cmd_merge(a):
    d = os.path.join(a.out, 'data/hazards/lidar')
    os.makedirs(d, exist_ok=True)
    plan = json.load(open(a.work + '/plan/plan.json'))
    if not plan.get('ok'):
        raise RuntimeError('the plan step failed; nothing to merge')
    z = np.load(a.work + '/plan/points.npz')
    lon, lat, old = z['lon'], z['lat'], z['old']
    ids = json.load(open(a.work + '/plan/assets.json'))['ids']
    nb, na, ns = plan['nb'], plan['na'], plan['ns']
    tiles = plan['tiles']
    npt = len(lon)
    stat, recs = {}, []
    for s in range(plan['shards']):
        f = f'{a.work}/shard/status_{s}.json'
        if os.path.exists(f) and os.path.exists(f'{a.work}/shard/shard_{s}.npz'):
            stat[s] = json.load(open(f))
            recs.append(dict(np.load(f'{a.work}/shard/shard_{s}.npz')))
    missing_shards = [s for s in range(plan['shards']) if s not in stat and any(t['shard'] == s for t in tiles)]
    tstat = {st['i']: st for s in stat.values() for st in s['tiles']}
    failed = [t['name'] for t in tiles if not tstat.get(t['i'], {}).get('ok')]
    complete = not missing_shards and not failed and not plan.get('header_failed')
    log(f'merge: {len(stat)} shard results, missing shards {missing_shards}, tiles sampled {len(tiles) - len(failed)} of {len(tiles)}, failed {failed[:20]}')
    cat = lambda k: np.concatenate([r[k] for r in recs]) if recs else np.zeros(0)  # noqa: E731
    idx, tile, val, nv, ctr = cat('idx').astype(np.int64), cat('tile').astype(np.int64), cat('val'), cat('nv'), cat('ctr')
    rank_of = np.array([t['rank'] for t in tiles], dtype=np.int64)
    nrank = len(plan['years'])
    best = np.full((nrank, npt), np.nan, dtype=np.float32)
    best_tile = np.full((nrank, npt), -1, dtype=np.int64)
    best_ctr = np.full((nrank, npt), np.nan, dtype=np.float32)
    partial = np.zeros(npt, dtype=bool)                     # some cells nearby, but under half of the disc
    partial[idx[~np.isfinite(val)]] = True
    for g in range(nrank):
        m = np.nonzero((rank_of[tile] == g) & np.isfinite(val))[0]
        m = m[np.lexsort((-tile[m], nv[m]))]              # last write wins: most valid cells, then first tile by name
        best[g, idx[m]] = val[m]
        best_tile[g, idx[m]] = tile[m]
        best_ctr[g, idx[m]] = ctr[m]
    final = np.full(npt, np.nan, dtype=np.float32)
    src = np.full(npt, -1, dtype=np.int64)
    fctr = np.full(npt, np.nan, dtype=np.float32)
    for g in range(nrank):
        take = np.isnan(final) & np.isfinite(best[g])
        final[take] = best[g, take]
        src[take] = best_tile[g, take]
        fctr[take] = best_ctr[g, take]
    fb = final[:nb]
    has = np.isfinite(fb)
    dm = np.full(nb, NODATA16, dtype=np.int16)
    dm[has] = np.clip(np.round(fb[has].astype(np.float64) * 10), -32767, 32767).astype(np.int16)
    assets = {ids[i]: (round(float(final[nb + i]), 2) if np.isfinite(final[nb + i]) else None) for i in range(na)}

    proj_of = np.array([t['project'] for t in tiles] + ['none'])
    year_of = np.array([t['year'] for t in tiles] + [0])
    def counts(sl):  # noqa: E306
        p, c = np.unique(proj_of[src[sl]], return_counts=True)
        y, cy = np.unique(year_of[src[sl]], return_counts=True)
        return {'by_project': {str(k): int(v) for k, v in zip(p, c)}, 'by_collection_year': {('none' if k == 0 else str(k)): int(v) for k, v in zip(y, cy)}}
    cb, ca = counts(slice(0, nb)), counts(slice(nb, nb + na))
    new_m = np.where(has, dm / 10.0, np.nan)
    old_ok = old != NODATA16
    old_m = np.where(old_ok, old / 10.0, np.nan)
    both = has & old_ok
    qa = {
        'buildings': nb, 'buildings_with_value': int(has.sum()), 'buildings_no_data': int((~has).sum()), 'share_with_value': round(float(has.mean()), 5),
        'buildings_no_data_but_some_cells_nearby': int((partial[:nb] & ~has).sum()), 'buildings_inside_no_tile': plan.get('uncovered_buildings'),
        'assets': na, 'assets_with_value': int(sum(v is not None for v in assets.values())),
        'new_elevation_m': {'min': pct(new_m[has], 0), 'p01': pct(new_m[has], 1), 'median': pct(new_m[has], 50), 'p99': pct(new_m[has], 99), 'max': pct(new_m[has], 100), 'below_zero': int((dm[has] < 0).sum())},
        'new_minus_old_m': dict(dist_stats((new_m - old_m)[both]), note='old = the ground field of tiles/bld today (10 m elevation model, decimetres)'),
        'at_or_below': {f'{th:g}m': {'old': int((old[old_ok] <= round(th * 10)).sum()), 'new': int((dm[has] <= round(th * 10)).sum()),
                                     'old_where_both': int((old[both] <= round(th * 10)).sum()), 'new_where_both': int((dm[both] <= round(th * 10)).sum())} for th in THRESHOLDS_M},
        'old_values_known': int(old_ok.sum()), 'compared': int(both.sum()),
        'no_data_buildings': [{'index': int(i), 'lon': round(float(lon[i]), 5), 'lat': round(float(lat[i]), 5)} for i in np.nonzero(~has)[0][:200]],
        'lowest_buildings': [{'index': int(i), 'lon': round(float(lon[i]), 5), 'lat': round(float(lat[i]), 5), 'lidar_m': float(dm[i]) / 10} for i in np.argsort(np.where(has, dm, 32767))[:10]],
        'median_minus_centre_cell_m': dist_stats((fb - fctr[:nb])[has & np.isfinite(fctr[:nb])]),
    }
    if nrank > 1:
        b2 = np.isfinite(best[0, :nb]) & np.isfinite(best[1, :nb])
        qa['collections_compared'] = dict(dist_stats((best[0, :nb] - best[1, :nb])[b2].astype(np.float64)), note=f'{plan["years"][0]} minus {plan["years"][1]} at buildings where both have a value',
                                          only_newest=int((np.isfinite(best[0, :nb]) & ~np.isfinite(best[1, :nb])).sum()), only_older=int((~np.isfinite(best[0, :nb]) & np.isfinite(best[1, :nb])).sum()))
    # spots: the value at the place itself, and the buildings within 150 m of it
    blon, blat = lon[:nb], lat[:nb]
    spots = []
    for k, (name, slon, slat, expect) in enumerate(SPOTS):
        i = nb + na + k
        near = np.nonzero(np.hypot((blon - slon) * 111320 * math.cos(math.radians(slat)), (blat - slat) * 110600) <= 150)[0]
        n_new, n_old = new_m[near][has[near]], old_m[near][old_ok[near]]
        spots.append({'place': name, 'lon': slon, 'lat': slat, 'expect': expect, 'lidar_m': round(float(final[i]), 2) if np.isfinite(final[i]) else None,
                      'project': str(proj_of[src[i]]), 'by_collection_m': {str(plan['years'][g]): (round(float(best[g, i]), 2) if np.isfinite(best[g, i]) else None) for g in range(nrank)},
                      'buildings_within_150m': int(len(near)), 'their_median_lidar_m': pct(n_new, 50), 'their_median_old_m': pct(n_old, 50)})
        log('spot', json.dumps(spots[-1], ensure_ascii=False))
    qa['spots'] = spots

    ev = plan.get('datum_evidence', {})
    vert = sorted({str(w.get('vert_crs')) for w in ev.get('workunits', [])})
    alt = sorted({s for v in ev.get('vendor_dem_metadata', []) for s in v.get('altdatum', [])})
    altu = sorted({s for v in ev.get('vendor_dem_metadata', []) for s in v.get('altunits', [])})
    confirmed = bool(vert) and set(vert) <= {'6641', '6642'} and '6641' in vert
    # Work units whose own metadata names the Virgin Islands datum: do their extents reach any building?
    vi = []
    for v in ev.get('vendor_dem_metadata', []):
        if any('Virgin' in s for s in v.get('altdatum', [])):
            w, so, e, n = v.get('bbox_wsen') or [None] * 4
            reach = None if None in (w, so, e, n) else int(((lon[:nb] >= w) & (lon[:nb] <= e) & (lat[:nb] >= so) & (lat[:nb] <= n)).sum())
            vi.append({'workunit': v.get('workunit'), 'file': v['file'].split('/')[-1], 'bbox_wsen': v.get('bbox_wsen'), 'buildings_inside_bbox': reach})
    datum = {
        'vertical': 'Puerto Rico Vertical Datum of 2002 (PRVD02), EPSG:6641' if confirmed else 'NOT CONFIRMED (see evidence)',
        'units': 'metres', 'horizontal': sorted({f'{t["crs"]} (EPSG:{t["epsg"]})' for t in tiles}), 'confirmed': confirmed,
        'how_confirmed': 'USGS WESM.csv (the 3DEP work-unit register) gives vert_crs for every work unit behind these tiles; the vendor DEM metadata gives altdatum/altunits. '
                         'The GeoTIFFs themselves carry no vertical CRS and no unit tag, and their sidecar XML only carries the national boilerplate quoted below, which names NAVD88 (a datum that does not exist in Puerto Rico).',
        'geotiff_vertical_crs': sorted({str(t['vert_cs']) for t in tiles}), 'geotiff_unit_type': sorted({repr(t['unit_type']) for t in tiles}), 'geotiff_horizontal_unit': sorted({str(t['linear_unit']) for t in tiles}),
        'wesm_vert_crs': vert, 'wesm_geoid': sorted({str(w.get('geoid')) for w in ev.get('workunits', [])}), 'vendor_altdatum': alt, 'vendor_altunits': altu,
        'caveat': ('These projects also cover the U.S. Virgin Islands, whose part is referenced to the Virgin Islands Vertical Datum of 2009 (WESM vert_crs 6642 and/or vendor metadata; see virgin_islands_parts, which lists '
                   'each such part with its bounding box and the number of Garita buildings inside it). '
                   + ('No building lies inside any of those boxes, so every value here comes from a PRVD02 work unit.' if vi and all(v['buildings_inside_bbox'] == 0 for v in vi) else
                      'Neither the register nor the tiles say which tile came from which work unit, so a building inside such a box cannot be proven to be PRVD02 from the metadata alone.'))
                  if ('6642' in vert or vi) else None,
        'virgin_islands_parts': vi,
        'evidence': ev, 'sidecar_xml': plan.get('sidecar'),
    }
    used = sorted({t['project'] for t in tiles})
    use0 = next((s.get('useconst', [None])[0] for s in (plan.get('sidecar') or {}).values() if s.get('useconst')), None)
    meta = {
        'complete': complete, 'partial_test_run_only_tiles_matching': plan.get('only') or None,
        'source': {
            'name': 'USGS 3D Elevation Program (3DEP) 1 meter Digital Elevation Model, bare earth, from lidar',
            'publisher': 'U.S. Geological Survey', 'urls': [BUCKET + PREFIX + p + '/TIFF/' for p in used], 'catalogue': 'https://apps.nationalmap.gov/downloader/ (dataset "Digital Elevation Model (DEM) 1 meter")',
            'collections': [{'year': y, 'projects': sorted({t['project'] for t in tiles if t['year'] == y}), 'tiles_sampled': sum(1 for t in tiles if t['year'] == y and t['name'] not in failed),
                             'bytes': sum(t['size'] for t in tiles if t['year'] == y), 'files_last_modified': max(t['modified'] for t in tiles if t['year'] == y),
                             'flown': sorted({(w.get('collect_start'), w.get('collect_end')) for w in ev.get('workunits', []) if collection_year(w.get('project') or '') == y or collection_year(w.get('workunit') or '') == y})} for y in plan['years']],
            'licence': 'Public domain (U.S. Government work; "All 3DEP products are public domain")',
            'citation': 'U.S. Geological Survey, 3D Elevation Program 1-Meter Resolution Digital Elevation Model, accessed ' + datetime.date.today().isoformat() + ' at https://www.usgs.gov/the-national-map-data-delivery',
        },
        'method': (f'For each building centroid and asset, the median of the 1 m DEM cells whose centre lies within {RADIUS_M:g} m of the point (11 to 14 cells); accepted only when at least '
                   f'{int(MIN_SHARE * 100)} % of those cells hold data, otherwise no data (-32768 in buildings.bin, null in assets.json). The DEMs are bare earth (buildings and vegetation removed, ground under buildings interpolated by the producer, '
                   'water bodies hydro-flattened), so the value is the ground at the building, not its roof or floor. The newest collection with a value wins (' + ', then '.join(str(y) for y in plan['years']) + '); '
                   'within a collection the tile with the most valid cells. Points are WGS 84 longitude/latitude projected to NAD83 / UTM 19N or 20N on GRS 80 without a datum shift (about 1 m). '
                   'Values are metres above ' + ('PRVD02' if confirmed else 'the DEM vertical datum') + '; buildings.bin stores them rounded to decimetres as int16, assets.json in metres with two decimals. Nothing is filled or interpolated across gaps.'),
        'datum': datum, 'units': {'buildings.bin': 'decimetres (int16), -32768 = no lidar value', 'assets.json': 'metres, two decimals, or null'}, 'nodata': NODATA16,
        'counts': {'buildings': cb, 'assets': ca},
        'tiles': {'listed_in_bucket': plan['listed'], 'holding_points': len(tiles), 'sampled': len(tiles) - len(failed), 'failed': failed, 'header_failed': plan.get('header_failed'), 'missing_shards': missing_shards,
                  'bytes_downloaded': sum(t['size'] for t in tiles if t['name'] not in failed)},
        'disclaimer': use0, 'qa': qa, 'generated': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'run': {'id': os.environ.get('GITHUB_RUN_ID'), 'sha': os.environ.get('GITHUB_SHA'), 'plan_seconds': plan.get('seconds'), 'shard_seconds': {str(s): v.get('seconds') for s, v in stat.items()}},
    }
    common.write_stage(a.out, 'lidar', dm, '<i2', assets, meta, plan['bld_stamp'])
    log('qa', json.dumps({k: v for k, v in qa.items() if k != 'spots'}))
    log('counts', json.dumps(cb))
    nm = qa['new_minus_old_m']
    lines = [f'{qa["buildings_with_value"]:,} of {nb:,} buildings have a lidar value ({100 * qa["share_with_value"]:.2f} %); ' + ', '.join(f'{k}: {v:,}' for k, v in cb['by_collection_year'].items()),
             f'lidar minus old 10 m value: median {nm.get("median")} m, 5th..95th percentile {nm.get("p05")}..{nm.get("p95")} m, within 1 m: {100 * (nm.get("share_within_1m") or 0):.1f} %',
             'buildings at or below  ' + '   '.join(f'{k}: old {v["old"]:,} / new {v["new"]:,}' for k, v in qa['at_or_below'].items()),
             ('datum ' + datum['vertical'] + ', metres') + ('' if complete else '   INCOMPLETE RUN') + (f'   TEST RUN /{plan["only"]}/' if plan.get('only') else ''),
             'generated ' + meta['generated'] + ', run ' + str(os.environ.get('GITHUB_RUN_ID'))]
    try:
        make_qa(os.path.join(d, 'qa.jpg'), blon, blat, new_m, old_m, lines)
    except Exception:  # noqa: BLE001
        log('QA PICTURE FAILED\n' + traceback.format_exc())
    log(f'merge done: complete = {complete}')
    return complete


def main():
    global LOG
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['plan', 'shard', 'merge'])
    ap.add_argument('--site', default='site')
    ap.add_argument('--work', default='work')
    ap.add_argument('--out', default='out')
    ap.add_argument('--shards', type=int, default=12)
    ap.add_argument('--shard', type=int, default=0)
    ap.add_argument('--threads', type=int, default=3)
    ap.add_argument('--only', default='')
    a = ap.parse_args()
    os.makedirs(a.work, exist_ok=True)
    LOG = os.path.join(a.work, {'plan': 'plan/log_plan.txt', 'shard': f'shard/log_shard_{a.shard:02d}.txt', 'merge': 'log_merge.txt'}[a.cmd])
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    log(f'lidar {a.cmd} run {os.environ.get("GITHUB_RUN_ID")} sha {os.environ.get("GITHUB_SHA")}')
    if a.cmd == 'plan':
        cmd_plan(a)          # never raises: the failure is in plan.json and in the log
    elif a.cmd == 'shard':
        cmd_shard(a)         # never raises: see status_<i>.json
    else:
        try:
            ok = cmd_merge(a)
        except Exception:  # noqa: BLE001
            log('MERGE FAILED\n' + traceback.format_exc())
            sys.exit(1)
        sys.exit(0 if ok else 2)


if __name__ == '__main__':
    main()
