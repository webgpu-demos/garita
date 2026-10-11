#!/usr/bin/env python3
"""
Garita hazard stage `surge`: NOAA NHC National Storm Surge Risk Maps for Puerto Rico.

Source: https://www.nhc.noaa.gov/gis/hazardmaps/PR_SLOSH_MOM_Inundation.zip (five GeoTIFFs, one per hurricane
category, SLOSH MOM high-tide scenario with SLOSH+SWAN wave setup; 8-bit classes in one-foot inundation bins).

What the files are (confirmed by probe `surge-files`, and logged again on every run): EPSG:4269 (NAD83 geographic),
31329 x 10580 cells of 0.00008983 degrees (about 10 m), -67.3256..-64.5113 W, 17.6198..18.5702 N, uint8, classes
1..16 present, no class 0, no class 99 (leveed), NoData = 255. A cell that is not flooded, a cell of open water and a
cell the SLOSH grid does not reach are ALL NoData: the files do not tell them apart.

Outputs (pipeline/hazards/README.md):
  data/hazards/surge/buildings.bin   uint8 x 5 per building (categories 1..5), canonical order
  data/hazards/surge/assets.json     { id: [c1, c2, c3, c4, c5] }
  data/hazards/surge/meta.json, qa.jpg, log.txt
  tiles/surge/c{1..5}/{z}/{x}/{y}.png (zoom 8..13, indexed-colour PNG with transparency), tiles/surge/index.json

Sample values: 1..21 = the raster's own class at the cell that contains the point (nearest cell, no interpolation),
99 = leveed, 0 = the point is inside the raster and the cell is NoData (no inundation mapped), 255 = the point is
outside the raster's extent.

Needs: rasterio, numpy, Pillow.
"""
import argparse
import datetime
import hashlib
import html
import json
import math
import os
import re
import sys
import time
import traceback
import urllib.request
import zipfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import load_buildings, load_assets, write_stage  # noqa: E402

URL = 'https://www.nhc.noaa.gov/gis/hazardmaps/PR_SLOSH_MOM_Inundation.zip'
PAGE = 'https://www.nhc.noaa.gov/nationalsurge/'
VIEWER = 'https://experience.arcgis.com/experience/203f772571cb48b1b8b50fdcc3272e2c'
LEGEND_URL = 'https://tiles.arcgis.com/tiles/C8EMgrsFcRFL6LrL/arcgis/rest/services/Storm_Surge_HazardMaps_Category{n}_v3/MapServer/legend?f=json'
UA = 'garita (github.com/webgpu-demos/garita)'
CITATION = ('Zachry, B. C., W. J. Booth, J. R. Rhome, and T. M. Sharon, 2015: A National View of Storm Surge Risk and '
            'Inundation. Weather, Climate, and Society, 7(2), 109-117. DOI: http://dx.doi.org/10.1175/WCAS-D-14-00049.1')

# The publisher's disclaimer, verbatim from https://www.nhc.noaa.gov/nationalsurge/ ("Data Citation and Disclaimer"),
# line breaks and double spaces of the page collapsed to single spaces, nothing else changed. Each run fetches the
# page and logs whether this text is still what it says.
DISCLAIMER = (
    'The data and maps in this tool illustrate the height of possible storm surge flooding under certain scenarios, '
    'and do not account for erosion, subsidence, sea-level change or future construction. Water levels are based on '
    'storm surge scenarios in the referenced SLOSH MOM tide scenario. The data, maps, and information provided should '
    'only be used as a tool for general education/awareness of the storm surge hazard at a city/community level (not '
    'for a parcel level/grid cell assessment). The SLOSH MOM storm surge risk data used to create these maps are '
    'constrained by the extent of the SLOSH grids and users should be aware that risk due to storm surge flooding '
    'could extend beyond the areas depicted in these maps. This map should not be used to replace the maps used for '
    'hurricane evacuation zones. Hurricane evacuation zones are drawn at a local and state level and consider '
    'additional information and specific criteria for a particular region in addition to the storm surge hazard. '
    'Users are urged to consult local officials for flood risk inside the hatched areas marked as leveed areas in the '
    'map. The data and maps in this tool are provided "as is", without warranty to their performance, merchantable '
    'state, or fitness for any particular purpose. The entire risk associated with the results and performance of '
    'these data is assumed by the user. This tool should be used strictly as a planning reference and storm surge '
    'risk awareness tool and not for navigation, permitting, legal, or regulatory purposes. Any conclusions drawn '
    'from the analysis of this information are not the responsibility of the National Weather Service, National '
    'Hurricane Center, Office for Coastal Management, or its partners.')
DISCLAIMER_ES = (
    '(Traducción no oficial hecha por Garita; rige el texto original en inglés de NOAA.) Los datos y mapas de esta '
    'herramienta ilustran la altura de la posible inundación por marejada ciclónica bajo ciertos escenarios, y no '
    'toman en cuenta la erosión, el hundimiento del terreno, el cambio en el nivel del mar ni la construcción futura. '
    'Los niveles de agua se basan en escenarios de marejada ciclónica del escenario de marea SLOSH MOM referido. Los '
    'datos, mapas e información provistos deben usarse únicamente como herramienta de educación y concienciación '
    'general sobre el peligro de marejada ciclónica a nivel de ciudad o comunidad (no para una evaluación a nivel de '
    'parcela o de celda de la cuadrícula). Los datos de riesgo de marejada ciclónica SLOSH MOM usados para crear '
    'estos mapas están limitados por la extensión de las cuadrículas SLOSH, y el riesgo de inundación por marejada '
    'ciclónica podría extenderse más allá de las áreas representadas en estos mapas. Este mapa no debe usarse para '
    'reemplazar los mapas de zonas de desalojo por huracán. Las zonas de desalojo por huracán se trazan a nivel '
    'local y estatal y consideran información adicional y criterios específicos de cada región además del peligro '
    'de marejada ciclónica. Se exhorta a consultar a los funcionarios locales sobre el riesgo de inundación dentro '
    'de las áreas rayadas marcadas como áreas protegidas por diques en el mapa. Los datos y mapas de esta '
    'herramienta se proveen "tal cual", sin garantía sobre su desempeño, comerciabilidad o idoneidad para algún '
    'propósito particular. Todo el riesgo asociado con los resultados y el desempeño de estos datos lo asume el '
    'usuario. Esta herramienta debe usarse estrictamente como referencia de planificación y de concienciación sobre '
    'el riesgo de marejada ciclónica, y no para navegación, permisos ni fines legales o reglamentarios. Las '
    'conclusiones que se deriven del análisis de esta información no son responsabilidad del Servicio Nacional de '
    'Meteorología, el Centro Nacional de Huracanes, la Oficina para el Manejo Costero ni sus socios.')

# Legend: the NHC viewer's own groups and colours, read from the legend of its tile services (LEGEND_URL; swatch
# images decoded by probe `surge-files` on 2026-10-11: identical for categories 1..5).
GROUPS = [
    # (group index, first class, last class, colour, label en (the viewer's own wording), label es)
    (1, 1, 3, '#005ce6', 'Less than 3 feet above ground', 'Menos de 3 pies sobre el terreno'),
    (2, 4, 6, '#ffff00', 'Greater than 3 feet above ground', 'Más de 3 pies sobre el terreno'),
    (3, 7, 9, '#ffaa00', 'Greater than 6 feet above ground', 'Más de 6 pies sobre el terreno'),
    (4, 10, 21, '#ff0000', 'Greater than 9 feet above ground', 'Más de 9 pies sobre el terreno'),
]
LEVEE = (5, 99, 99, '#ffffff', 'Levee Areas - Consult Local Officials for flood risk',
         'Áreas protegidas por diques: consulte a los funcionarios locales sobre el riesgo de inundación')
NODATA_SRC = 255
OUTSIDE = 255
ZMIN, ZMAX = 8, 13

SPOTS = [
    ('Cataño, ferry terminal waterfront', 18.4437, -66.1163),
    ('Cataño, Juana Matos', 18.4330, -66.1330),
    ('Loíza, Piñones', 18.4440, -65.9300),
    ('Toa Baja, Levittown', 18.4470, -66.1810),
    ('Carolina, Isla Verde', 18.4420, -66.0210),
    ('San Juan, Ocean Park', 18.4530, -66.0500),
    ('Old San Juan, Plaza de Armas (on its hill)', 18.4655, -66.1165),
    ('Lajas, La Parguera', 17.9735, -67.0460),
    ('Ponce, Playa', 17.9810, -66.6190),
    ('Salinas, Playa', 17.9620, -66.2970),
    ('Mayagüez, waterfront', 18.2010, -67.1500),
    ('Fajardo, Puerto Real', 18.3350, -65.6300),
    ('Vieques, Isabel Segunda', 18.1490, -65.4430),
    ('Vieques, Esperanza', 18.0950, -65.4710),
    ('Culebra, Dewey', 18.3030, -65.3010),
    ('Caguas, inland (expected: no inundation)', 18.2340, -66.0350),
    ('Isla de Mona (expected: outside the raster)', 18.0860, -67.8900),
]
BOXES = {  # coverage checks: are the island municipalities mapped at all?
    'Vieques': dict(west=-65.59, east=-65.25, south=18.07, north=18.17),
    'Culebra': dict(west=-65.40, east=-65.20, south=18.26, north=18.36),
}

T0 = time.time()
LOG = None


def log(*a):
    s = f'[{time.time() - T0:6.1f}s] ' + ' '.join(str(x) for x in a)
    print(s, flush=True)
    if LOG:
        with open(LOG, 'a') as f:
            f.write(s + '\n')


def fetch(url, timeout=120):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), dict(r.headers)


def norm(s):
    return re.sub(r'\s+', ' ', s).strip()


def hex_rgb(h):
    return int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16)


def merc_px(lon, lat, z):
    """Global Web Mercator pixel coordinates (256 px tiles) at zoom z."""
    n = 256.0 * 2 ** z
    x = (np.asarray(lon) + 180.0) / 360.0 * n
    s = np.sin(np.radians(np.asarray(lat)))
    y = (0.5 - np.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return x, y


def class_lut():
    """class -> legend group (0 = nothing to draw)."""
    lut = np.zeros(256, np.uint8)
    for g, a, b, *_ in GROUPS + [LEVEE]:
        lut[a:b + 1] = g
    return lut


def counts(v):
    """QA numbers for one category's sample values (a uint8 array)."""
    v = np.asarray(v)
    wet = (v >= 1) & (v <= 21)
    return {
        'inundated': int(wet.sum()),
        'above_3ft': int((wet & (v >= 4)).sum()),
        'above_6ft': int((wet & (v >= 7)).sum()),
        'above_9ft': int((wet & (v >= 10)).sum()),
        'leveed': int((v == 99).sum()),
        'no_inundation_mapped': int((v == 0).sum()),
        'outside_raster': int((v == OUTSIDE).sum()),
        'by_class': {str(int(k)): int(n) for k, n in zip(*np.unique(v, return_counts=True))},
    }


def main():
    global LOG
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--work', required=True)
    args = ap.parse_args()
    ddir = os.path.join(args.out, 'data/hazards/surge')
    tdir = os.path.join(args.out, 'tiles/surge')
    os.makedirs(ddir, exist_ok=True)
    os.makedirs(args.work, exist_ok=True)
    LOG = os.path.join(ddir, 'log.txt')
    open(LOG, 'w').write(f'surge stage, {datetime.datetime.utcnow().isoformat()}Z, commit {os.environ.get("GITHUB_SHA", "?")[:7]}, run {os.environ.get("GITHUB_RUN_ID", "?")}\n')

    import rasterio
    from PIL import Image, ImageDraw
    log('rasterio', rasterio.__version__, 'gdal', rasterio.__gdal_version__, 'numpy', np.__version__)

    # ------------------------------------------------------------ source
    blob, hdr = fetch(URL)
    sha = hashlib.sha256(blob).hexdigest()
    last_mod = hdr.get('Last-Modified') or hdr.get('last-modified')
    log('downloaded', URL, len(blob), 'bytes, sha256', sha, 'last-modified', last_mod)
    zp = os.path.join(args.work, 'pr.zip')
    open(zp, 'wb').write(blob)
    xdir = os.path.join(args.work, 'x')
    with zipfile.ZipFile(zp) as z:
        names = z.namelist()
        z.extractall(xdir)
    log('zip members:', len(names))
    tifs = {}
    for n in names:
        m = re.search(r'Category([1-5])_MOM_Inundation_HighTide\.tif$', n)
        if m:
            tifs[int(m.group(1))] = os.path.join(xdir, n)
    assert sorted(tifs) == [1, 2, 3, 4, 5], sorted(tifs)

    # the use constraints written in the files' own metadata (2018 wording), kept next to the page's disclaimer
    meta_useconst = None
    try:
        x = open(tifs[1] + '.xml', encoding='utf-8', errors='replace').read()
        m = re.search(r'<useconst>(.*?)</useconst>', x, flags=re.S) or re.search(r'<useLimit>(.*?)</useLimit>', x, flags=re.S)
        if m:
            meta_useconst = norm(html.unescape(re.sub(r'<[^>]+>', ' ', html.unescape(m.group(1)))))
        log('metadata use constraints:', (meta_useconst or 'NOT FOUND')[:160], '...')
    except Exception as e:
        log('metadata xml not read:', e)

    # is the disclaimer constant still what the publisher's page says?
    disclaimer_check = 'not checked'
    try:
        page, _ = fetch(PAGE, 60)
        ptxt = norm(html.unescape(re.sub(r'<[^>]+>', ' ', page.decode('utf-8', 'replace'))))
        disclaimer_check = 'identical to the page on this run' if DISCLAIMER in ptxt else 'DIFFERS from the page on this run'
    except Exception as e:
        disclaimer_check = f'page not reachable on this run ({e})'
    log('disclaimer vs', PAGE, ':', disclaimer_check)

    # are the legend colours still the viewer's?
    legend_check = 'not checked'
    try:
        import base64, io
        j = json.loads(fetch(LEGEND_URL.format(n=3), 60)[0])
        got = []
        for e in j['layers'][0]['legend']:
            im = Image.open(io.BytesIO(base64.b64decode(e['imageData']))).convert('RGBA')
            c = max((c for c in im.getcolors(4096) if c[1][3] > 0), key=lambda c: c[0])[1]
            got.append((e['label'], '#%02x%02x%02x' % c[:3]))
        log('viewer legend now:', got)
        want = [(g[4], g[3]) for g in GROUPS]
        legend_check = 'identical to the viewer legend on this run' if got[:4] == want else f'DIFFERS from the viewer legend on this run: {got}'
    except Exception as e:
        legend_check = f'viewer legend not reachable on this run ({e})'
    log('legend:', legend_check)

    # ------------------------------------------------------------ points
    lon, lat, stamp = load_buildings(args.site)
    assets = load_assets(args.site)
    alon = np.array([a[1] for a in assets])
    alat = np.array([a[2] for a in assets])
    NB, NA = len(lon), len(assets)
    log(NB, 'buildings (', stamp, ')', NA, 'assets')
    bld = np.full((NB, 5), OUTSIDE, np.uint8)
    ast = np.full((NA, 5), OUTSIDE, np.uint8)

    # ------------------------------------------------------------ rasters
    lut = class_lut()
    raster = None
    present = {}
    tiles = {}
    tile_bytes = {}
    spots = {n: {'lat': la, 'lon': lo, 'at_point': [], 'deepest_within_100m': []} for n, la, lo in SPOTS}
    boxes = {k: {'wet_cells': [], 'buildings_inundated': []} for k in BOXES}
    qa_grids = {}
    levee_seen = False
    palette = [0, 0, 0]
    for g in GROUPS + [LEVEE]:
        palette += list(hex_rgb(g[3]))
    alpha = bytes([0, 255, 255, 255, 255, 255])

    for cat in range(1, 6):
        with rasterio.open(tifs[cat]) as d:
            a = d.read(1)
            t = d.transform
            info = dict(crs=str(d.crs), width=d.width, height=d.height, cell_deg=[t.a, -t.e], origin=[t.c, t.f],
                        bounds=[d.bounds.left, d.bounds.bottom, d.bounds.right, d.bounds.top], dtype=d.dtypes[0],
                        nodata=d.nodata, compression=str(d.compression).split('.')[-1])
        assert info['crs'] == 'EPSG:4269' and t.b == 0 and t.d == 0 and info['nodata'] == NODATA_SRC and a.dtype == np.uint8, info
        if raster is None:
            raster = info
            log('raster:', json.dumps(info))
        else:
            assert info == raster, ('the five rasters do not share one grid', info, raster)
        vals, cnt = np.unique(a, return_counts=True)
        present[f'c{cat}'] = {str(int(v)): int(c) for v, c in zip(vals, cnt)}
        log(f'c{cat} values present:', present[f'c{cat}'])
        unexpected = [int(v) for v in vals if not (1 <= v <= 21 or v in (99, NODATA_SRC))]
        assert not unexpected, f'values outside the documented classes: {unexpected}'
        levee_seen = levee_seen or bool((vals == 99).any())
        H, W = a.shape
        x0, y0, dx, dy = t.c, t.f, t.a, -t.e

        def sample(lo, la):
            """The class of the cell that contains each point; 0 where that cell is NoData; 255 outside the raster.
            NAD83 and WGS84 are taken as equal here (they differ by about a metre; a cell is about 10 m)."""
            col = np.floor((np.asarray(lo) - x0) / dx).astype(np.int64)
            row = np.floor((y0 - np.asarray(la)) / dy).astype(np.int64)
            ok = (col >= 0) & (col < W) & (row >= 0) & (row < H)
            out = np.full(col.shape, OUTSIDE, np.uint8)
            v = a[row[ok], col[ok]]
            out[ok] = np.where(v == NODATA_SRC, 0, v)
            return out, row, col, ok

        bld[:, cat - 1] = sample(lon, lat)[0]
        ast[:, cat - 1] = sample(alon, alat)[0]
        for n, la, lo in SPOTS:
            v, row, col, ok = sample([lo], [la])
            spots[n]['at_point'].append(int(v[0]))
            if ok[0]:
                w = a[max(0, row[0] - 10):row[0] + 11, max(0, col[0] - 10):col[0] + 11]
                w = w[(w != NODATA_SRC) & (w != 99)]
                spots[n]['deepest_within_100m'].append(int(w.max()) if w.size else 0)
            else:
                spots[n]['deepest_within_100m'].append(OUTSIDE)
        for k, b in BOXES.items():
            c0, c1 = int((b['west'] - x0) / dx), int((b['east'] - x0) / dx)
            r0, r1 = int((y0 - b['north']) / dy), int((y0 - b['south']) / dy)
            boxes[k]['wet_cells'].append(int((a[r0:r1, c0:c1] != NODATA_SRC).sum()))
            inb = (lon >= b['west']) & (lon <= b['east']) & (lat >= b['south']) & (lat <= b['north'])
            boxes[k]['buildings'] = int(inb.sum())
            v = bld[inb, cat - 1]
            boxes[k]['buildings_inundated'].append(int(((v >= 1) & (v <= 21)).sum()))

        # -------------------------------------------------------- tiles
        # Zoom 13 grid aligned to zoom 8 tiles (32 x 32 zoom-13 tiles each). Every source cell that has a class is
        # put into the zoom-13 pixel that contains its centre; a pixel keeps the DEEPEST class of its cells (a zoom-13
        # pixel is about 19 m in Mercator, a cell about 10 m, so a pixel holds about four cells). Each lower zoom is the
        # 2 x 2 maximum of the zoom above, so a pixel always shows the deepest class found anywhere inside it.
        bx, by = merc_px([raster['bounds'][0], raster['bounds'][2]], [raster['bounds'][3], raster['bounds'][1]], ZMAX)
        blk = 256 * 2 ** (ZMAX - ZMIN)
        X0, X1 = int(bx[0] // blk) * blk, (int(bx[1] // blk) + 1) * blk
        Y0, Y1 = int(by[0] // blk) * blk, (int(by[1] // blk) + 1) * blk
        GW, GH = X1 - X0, Y1 - Y0
        rows, cols = np.nonzero(a != NODATA_SRC)
        cx, _ = merc_px(x0 + (np.arange(W) + 0.5) * dx, 0.0, ZMAX)
        _, cy = merc_px(0.0, y0 - (np.arange(H) + 0.5) * dy, ZMAX)
        px = np.floor(cx).astype(np.int64) - X0
        py = np.floor(cy).astype(np.int64) - Y0
        G = np.zeros(GW * GH, np.uint8)
        np.maximum.at(G, py[rows] * GW + px[cols], lut[a[rows, cols]])
        G = G.reshape(GH, GW)
        del rows, cols
        log(f'c{cat}: zoom {ZMAX} grid {GW} x {GH}, {int((G > 0).sum())} pixels with a class')
        tiles[f'c{cat}'] = []
        nbytes = 0
        for z in range(ZMAX, ZMIN - 1, -1):
            if z < ZMAX:
                h, w = G.shape
                G = G.reshape(h // 2, 2, w // 2, 2).max(axis=(1, 3))
            if cat == 3 and z in (13, 11):
                qa_grids[z] = (G, X0 >> (ZMAX - z), Y0 >> (ZMAX - z))
            h, w = G.shape
            tx0, ty0 = (X0 >> (ZMAX - z)) // 256, (Y0 >> (ZMAX - z)) // 256
            has = G.reshape(h // 256, 256, w // 256, 256).max(axis=(1, 3)) > 0
            for j, i in zip(*np.nonzero(has)):
                tile = np.ascontiguousarray(G[j * 256:(j + 1) * 256, i * 256:(i + 1) * 256])
                p = os.path.join(tdir, f'c{cat}', str(z), str(tx0 + i))
                os.makedirs(p, exist_ok=True)
                im = Image.frombytes('P', (256, 256), tile.tobytes())
                im.putpalette(palette)
                f = os.path.join(p, f'{ty0 + j}.png')
                im.save(f, optimize=True, transparency=alpha)
                nbytes += os.path.getsize(f)
                tiles[f'c{cat}'].append([z, int(tx0 + i), int(ty0 + j)])
        tiles[f'c{cat}'].sort()
        tile_bytes[f'c{cat}'] = nbytes
        log(f'c{cat}: {len(tiles[f"c{cat}"])} tiles, {nbytes / 1e6:.2f} MB')
        del a, G

    # ------------------------------------------------------------ QA numbers
    qa = {'buildings': {}, 'assets': {}}
    for cat in range(1, 6):
        qa['buildings'][f'c{cat}'] = counts(bld[:, cat - 1])
        qa['assets'][f'c{cat}'] = counts(ast[:, cat - 1])
        log(f'c{cat} buildings', {k: v for k, v in qa['buildings'][f'c{cat}'].items() if k != 'by_class'})
        log(f'c{cat} assets   ', {k: v for k, v in qa['assets'][f'c{cat}'].items() if k != 'by_class'})
    out_b = bld[:, 0] == OUTSIDE
    qa['outside_raster'] = {'buildings': int(out_b.sum()), 'assets': int((ast[:, 0] == OUTSIDE).sum()),
                            'assets_ids': [assets[i][0] for i in np.nonzero(ast[:, 0] == OUTSIDE)[0][:40]]}
    if out_b.any():
        qa['outside_raster']['buildings_bbox'] = [float(lon[out_b].min()), float(lat[out_b].min()), float(lon[out_b].max()), float(lat[out_b].max())]
    w = np.where(bld == OUTSIDE, 0, np.where(bld == 99, 0, bld)).astype(np.int16)
    qa['not_monotonic_buildings'] = int((np.diff(w, axis=1) < 0).any(axis=1).sum())
    qa['spots'] = spots
    qa['island_municipalities'] = boxes
    qa['spots_note'] = ('values per category [c1..c5]; at_point = the sample exactly as a building there would get it; '
                        'deepest_within_100m = the deepest class in the 21 x 21 cells around it (0 = none), given '
                        'because a named place is not a single cell')
    log('outside raster:', qa['outside_raster'])
    log('buildings whose class goes DOWN with a higher category:', qa['not_monotonic_buildings'])
    for n, s in spots.items():
        log('spot', n, 'at point', s['at_point'], 'deepest within 100 m', s['deepest_within_100m'])
    for k, b in boxes.items():
        log('coverage', k, b)

    # ------------------------------------------------------------ index.json
    generated = datetime.datetime.utcnow().replace(microsecond=0).isoformat() + 'Z'
    legend = [{'color': g[3], 'label': {'en': g[4], 'es': g[5]}, 'classes': [g[1], g[2]]} for g in GROUPS]
    if levee_seen:
        legend.append({'color': LEVEE[3], 'label': {'en': LEVEE[4], 'es': LEVEE[5]}, 'classes': [99, 99]})
    total_tiles = sum(len(v) for v in tiles.values())
    total_bytes = sum(tile_bytes.values())
    note_en = ('Near worst-case storm surge flooding above ground for a hurricane of the chosen category at high tide '
               '(NOAA NHC SLOSH maximum of maximums with wave setup, 2018). No single storm floods all of the area '
               'shown. Colours are the NHC viewer\'s four depth groups; the files hold one-foot classes. Each map pixel '
               'shows the deepest class of the roughly 10 m source cells inside it, so flooded areas look larger when '
               'zoomed out. Where nothing is drawn the source has no value: it does not distinguish dry ground from '
               'open water or from places its model grid does not reach.')
    note_es = ('Inundación por marejada ciclónica sobre el terreno en el caso cercano al peor posible para un huracán '
               'de la categoría elegida con marea alta (NOAA NHC, máximo de máximos de SLOSH con sobreelevación por '
               'oleaje, 2018). Ninguna tormenta individual inunda toda el área mostrada. Los colores son los cuatro '
               'grupos de profundidad del visor del NHC; los archivos contienen clases de un pie. Cada píxel del mapa '
               'muestra la clase más profunda de las celdas de origen (de unos 10 m) que contiene, por lo que las '
               'áreas inundadas se ven más grandes al alejar el mapa. Donde no se dibuja nada la fuente no tiene '
               'valor: no distingue el terreno seco del agua abierta ni de los lugares que su modelo no cubre.')
    index = {
        'stage': 'surge', 'minZoom': ZMIN, 'maxZoom': ZMAX, 'tileSize': 256,
        'sets': [{'id': f'c{c}', 'label': {'en': f'Category {c}', 'es': f'Categoría {c}'}} for c in range(1, 6)],
        'tiles': tiles,
        'title': {'en': 'Storm surge flooding by hurricane category (NOAA NHC)', 'es': 'Inundación por marejada ciclónica según la categoría del huracán (NOAA NHC)'},
        'unit': 'ft above ground',
        'legend': legend,
        'legendSource': f'NHC Storm Surge Risk Maps viewer ({VIEWER}), legend of its tile services ({LEGEND_URL.format(n="{1..5}")}); {legend_check}',
        'note': {'en': note_en, 'es': note_es},
        'disclaimer': {'en': DISCLAIMER, 'es': DISCLAIMER_ES},
        'source': f'NOAA National Hurricane Center, National Storm Surge Risk Maps, Puerto Rico (SLOSH MOM inundation, high tide scenario), files dated 2018-11; {URL} ; {PAGE}',
        'citation': CITATION,
        'format': 'indexed-colour PNG, 256 px, palette index 0 fully transparent, the others opaque (decodes to RGBA)',
        'reduction': 'deepest class of the source cells inside a pixel, at every zoom',
        'tileCount': total_tiles, 'tileBytes': total_bytes,
        'generated': generated,
    }
    json.dump(index, open(os.path.join(tdir, 'index.json'), 'w'), separators=(',', ':'), ensure_ascii=False)
    log('tiles total:', total_tiles, f'{total_bytes / 1e6:.2f} MB')
    assert total_bytes < 15e6, 'tiles over 15 MB'

    # ------------------------------------------------------------ qa.jpg (category 3: island, and San Juan metro)
    try:
        cols_rgb = np.array([(0, 0, 0)] + [hex_rgb(g[3]) for g in GROUPS + [LEVEE]], np.uint8)

        def panel(z, west, east, south, north):
            G, gx0, gy0 = qa_grids[z]
            (xa, xb), (ya, yb) = merc_px([west, east], [north, south], z)
            xa, xb, ya, yb = int(xa), int(xb), int(ya), int(yb)
            w, h = xb - xa, yb - ya
            bx_, by_ = merc_px(lon, lat, z)
            dens = np.zeros((h, w), np.float32)
            ix, iy = np.floor(bx_).astype(np.int64) - xa, np.floor(by_).astype(np.int64) - ya
            ok = (ix >= 0) & (ix < w) & (iy >= 0) & (iy < h)
            np.add.at(dens, (iy[ok], ix[ok]), 1)
            grey = (22 + 150 * np.clip(dens / (4.0 if z <= 11 else 1.0), 0, 1) ** 0.5).astype(np.uint8)
            rgb = np.stack([grey, grey, (grey * 1.08).clip(0, 255).astype(np.uint8)], -1)
            sub = np.zeros((h, w), np.uint8)
            sx0, sy0 = xa - gx0, ya - gy0
            ys0, ys1, xs0, xs1 = max(0, sy0), min(G.shape[0], sy0 + h), max(0, sx0), min(G.shape[1], sx0 + w)
            sub[ys0 - sy0:ys1 - sy0, xs0 - sx0:xs1 - sx0] = G[ys0:ys1, xs0:xs1]
            m = sub > 0
            rgb[m] = cols_rgb[sub[m]]
            return Image.fromarray(rgb)

        isl = panel(11, -67.30, -65.20, 17.86, 18.54)
        sj = panel(13, -66.22, -65.90, 18.385, 18.49)
        Wd = max(isl.width, sj.width)
        canvas = Image.new('RGB', (Wd, isl.height + sj.height + 70), (12, 12, 16))
        canvas.paste(isl, (0, 30))
        canvas.paste(sj, (0, isl.height + 60))
        dr = ImageDraw.Draw(canvas)
        try:
            from PIL import ImageFont
            font = ImageFont.load_default(size=17)
        except Exception:
            font = None
        dr.text((8, 8), f'NOAA NHC storm surge risk map, Puerto Rico, CATEGORY 3, high tide (SLOSH MOM, 2018). Grey = Garita buildings. Deepest class per pixel. {generated}', fill=(235, 235, 235), font=font)
        dr.text((8, isl.height + 40), 'San Juan metro (Toa Baja to Loíza), zoom 13 pixels', fill=(235, 235, 235), font=font)
        lx = sj.width + 20
        if lx + 300 < Wd:
            for i, g in enumerate(GROUPS):
                yy = isl.height + 80 + i * 26
                dr.rectangle([lx, yy, lx + 22, yy + 16], fill=hex_rgb(g[3]))
                dr.text((lx + 30, yy + 3), g[4], fill=(235, 235, 235), font=font)
            c3 = qa['buildings']['c3']
            for i, s in enumerate([f"buildings inundated, cat 3: {c3['inundated']:,}", f"  above 3 ft: {c3['above_3ft']:,}", f"  above 6 ft: {c3['above_6ft']:,}", f"  above 9 ft: {c3['above_9ft']:,}",
                                   f"outside the raster: {qa['outside_raster']['buildings']:,}", 'no colour = no value in the source', '(dry, open water, or beyond the SLOSH grid)']):
                dr.text((lx, isl.height + 200 + i * 18), s, fill=(235, 235, 235), font=font)
        canvas.save(os.path.join(ddir, 'qa.jpg'), quality=86)
        log('qa.jpg', canvas.size, os.path.getsize(os.path.join(ddir, 'qa.jpg')), 'bytes')
    except Exception:
        log('qa.jpg FAILED:\n' + traceback.format_exc())
        raise

    # ------------------------------------------------------------ data outputs
    classes = {'0': 'the point is inside the raster and its cell is NoData in the source: no inundation is mapped there for this category. The source does not distinguish dry ground from open water or from ground its SLOSH grid does not reach, so this is "nothing mapped", not a statement that the place is safe.'}
    for c in range(1, 21):
        classes[str(c)] = ('Less than 1 foot above ground' if c == 1 else f'{c - 1} to {c} feet above ground')
    classes['21'] = 'Greater than 20 feet above ground'
    classes['99'] = 'Levee Areas (the publisher: consult local officials for flood risk); none in the Puerto Rico files'
    classes['255'] = 'the point is outside the raster\'s extent: no information'
    meta = {
        'source': {
            'name': 'NOAA National Hurricane Center (NHC) Storm Surge Unit, National Storm Surge Risk Maps: Puerto Rico SLOSH MOM inundation, high tide scenario, categories 1 to 5',
            'urls': [URL, PAGE, VIEWER],
            'version': 'PR_SLOSH_MOM_Inundation_11_2018 (the page lists Puerto Rico as "Updated 11/30/2018"; the national product is at version 4, which did not reprocess Puerto Rico)',
            'date': '2018-11-12 (metadata publication date); zip last modified ' + str(last_mod),
            'sha256': sha, 'bytes': len(blob),
            'licence': 'U.S. Government work (NOAA / National Weather Service), public domain; provided "as is" under the disclaimer below',
            'citation': CITATION,
        },
        'raster': dict(raster, values_present=present, note='five GeoTIFFs on one grid; NoData (255) covers dry ground, open water and everything the SLOSH grid does not reach alike; classes 0 and 99 do not occur'),
        'method': ('Each of the five category rasters (EPSG:4269 NAD83 geographic, cells of 0.0000898315 degrees, about 10 m; '
                   'elevation model resampled by the publisher to about 9 m) is read whole. For every building centroid and '
                   'every asset the value of the one cell that contains the point is taken (nearest cell; classes are never '
                   'interpolated or smoothed). Point coordinates are WGS84 and are used as NAD83 without a datum shift (about '
                   '1 m, a tenth of a cell). Values: 1..21 are the publisher\'s one-foot bins of inundation above ground, in '
                   'feet (class n = n-1 to n ft, 21 = more than 20 ft); 0 means the cell is NoData; 255 means the point lies '
                   'outside the raster. Water level is the SLOSH maximum of maximums (MOM) for the category at high tide '
                   'with SLOSH+SWAN wave setup, minus ground elevation; it is a near worst-case composite, not one storm. '
                   'Overlay tiles: each class cell is placed in the zoom-13 Web Mercator pixel that contains its centre and '
                   'the pixel keeps the deepest class; every lower zoom is the 2 x 2 maximum of the zoom above; pixels are '
                   'then coloured by the NHC viewer\'s four depth groups (classes 1-3, 4-6, 7-9, 10 and above). '
                   'QA counts: "inundated" = class 1..21; "above 3 ft" = class 4 or more (the 3 to 4 ft bin and deeper), '
                   '"above 6 ft" = class 7 or more, "above 9 ft" = class 10 or more.'),
        'classes': classes,
        'disclaimer': DISCLAIMER,
        'disclaimer_source': f'{PAGE} , section "Data Citation and Disclaimer", verbatim (whitespace collapsed); {disclaimer_check}',
        'disclaimer_es': DISCLAIMER_ES,
        'metadata_use_constraints': meta_useconst,
        'metadata_use_constraints_source': 'the <useconst> element of PR_Category1_MOM_Inundation_HighTide.tif.xml inside the zip, verbatim (whitespace collapsed)',
        'legend': {'groups': legend, 'source': index['legendSource']},
        'tiles': {'index': 'tiles/surge/index.json', 'count': total_tiles, 'bytes': total_bytes, 'per_set': {k: {'count': len(v), 'bytes': tile_bytes[k]} for k, v in tiles.items()}},
        'qa': qa,
        'generated': generated,
    }
    write_stage(args.out, 'surge', bld, 'u1', {a[0]: [int(v) for v in ast[i]] for i, a in enumerate(assets)}, meta, stamp)
    log('written', ddir, os.listdir(ddir))
    log('done')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        log('FAILED:\n' + traceback.format_exc())
        sys.exit(1)
