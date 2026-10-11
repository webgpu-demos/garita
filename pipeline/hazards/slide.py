#!/usr/bin/env python3
"""Hazard stage `slide`: the USGS map of susceptibility to landslides triggered by intense rainfall, Puerto Rico
(Hughes and Schulz, 2020, USGS Open-File Report 2020-1022), sampled at every building and asset and baked into
overlay tiles. Runs on a GitHub runner (.github/workflows/slide.yml); see pipeline/hazards/README.md for the contract.

    python3 pipeline/hazards/slide.py --site site --out out --work work

Source: the GIS layer of the map, USGS data release https://doi.org/10.5066/P990ZP4C (ScienceBase item
61087009d34ef8d70565c154). The GeoTIFF is not in the item's `files` list (only the metadata xml is); it sits in the
item's raster facet and comes with the public "Download Attached Files" zip. One band, int8, 35756 x 13008 cells of
5 m, WGS 84 / UTM zone 19N (EPSG:32619), nodata -128, values 1..5 = Low, Moderate, High, Very High, Extremely High.

What is made
  data/hazards/slide/buildings.bin  uint8 per building, canonical order: the class of the cell the centroid falls in
                                    (nearest cell, no interpolation); 0 = no data
  data/hazards/slide/assets.json    { "<type>:<key>": class }
  data/hazards/slide/buildings_max25m.bin, assets_max25m.json
                                    an extra of ours, labelled as such: the highest class within 25 m of the point
  data/hazards/slide/meta.json      source, method, classes, the publisher's use limits (verbatim), QA
  data/hazards/slide/qa.jpg         the map over the island, with the spot-check places
  data/hazards/slide/log.txt        this run's log
  tiles/slide/{z}/{x}/{y}.png       overlay, zoom 8..13, 256 px, indexed colour with transparency
  tiles/slide/index.json            tile list, legend, note, use limits

Tile reduction: the raster is resampled once, nearest neighbour, onto the Web Mercator pixel grid of zoom 15 (about
4.5 m on the ground, so every 5 m cell is kept). A tile pixel at zoom z covers 4^(15-z) of those cells (16 at zoom
13, 16,384 at zoom 8) and takes the MAJORITY class of the cells that have data (ties go to the higher class); it is
transparent when fewer than half of its cells have data. Majority, not highest: the classes are area percentiles
(40/30/20/9/1 % of the island), and "highest" would paint most of the interior Extremely High at island scale,
which the map does not say. The price is that bands narrower than a tile pixel thin out below zoom 13; the values
at buildings and assets never go through the tiles, they are read from the 5 m cells.
"""
import argparse, datetime, io, json, math, os, re, sys, time, traceback, urllib.request, zipfile
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common  # noqa: E402

ITEM = '61087009d34ef8d70565c154'
ZIP_URL = f'https://www.sciencebase.gov/catalog/file/get/{ITEM}'
ITEM_URL = f'https://www.sciencebase.gov/catalog/item/{ITEM}'
DOI_DATA = 'https://doi.org/10.5066/P990ZP4C'
DOI_REPORT = 'https://doi.org/10.3133/ofr20201022'
CITATION = ('Hughes, K.S., and Schulz, W.H., 2020, Map depicting susceptibility to landslides triggered by intense '
            'rainfall, Puerto Rico: U.S. Geological Survey Open-File Report 2020–1022, 91 p., 1 plate, scale '
            '1:150,000, https://doi.org/10.3133/ofr20201022.')
CITATION_DATA = ('Hughes, K.S., and Schulz, W.H., 2021, Geographic Information System Layer of a Map Depicting '
                 'Susceptibility to Landslides Triggered by Intense Rainfall, Puerto Rico: U.S. Geological Survey data '
                 'release, https://doi.org/10.5066/P990ZP4C.')

# Class names: English from the raster's own attribute table (rainLSsuc) and metadata; Spanish as printed in the
# EXPLICACIÓN of the Spanish edition of the plate (ofr20201022_sheet_esp.pdf). Area shares from the data release abstract.
CLASSES = {
    1: {'en': 'Low', 'es': 'Baja', 'share': 'about 40 percent of the island (the remainder)'},
    2: {'en': 'Moderate', 'es': 'Moderada', 'share': 'about 30 percent of the island'},
    3: {'en': 'High', 'es': 'Alta', 'share': 'about 20 percent of the island'},
    4: {'en': 'Very High', 'es': 'Muy Alta', 'share': 'about 9 percent of the island'},
    5: {'en': 'Extremely High', 'es': 'Extremadamente Alta', 'share': 'about 1 percent of the island'},
}
# Colours: the publisher's own. They are the fills of the five legend boxes in the EXPLANATION of the report's plate
# (ofr20201022_sheet.pdf and the Spanish edition, read from the PDF's vector drawing, identical in both): grey, pale
# yellow, light orange, red, and blue for Extremely High. Index 0 is transparent (no data).
COLOURS = {1: '#aeadae', 2: '#fbf7bc', 3: '#ffd580', 4: '#f3807f', 5: '#85a4d6'}
COLOUR_SOURCE = ('The publisher\'s own: the fills of the five legend boxes in the EXPLANATION of the plate of USGS Open-File '
                 'Report 2020-1022 (ofr20201022_sheet.pdf, same in the Spanish edition), read from the PDF\'s vector drawing. '
                 'Note that Extremely High is blue on the published map, not a darker red. The data release itself carries no '
                 'colour table (the GeoTIFF has none; the SLD beside it is a generic two-colour gradient).')
# Low is drawn, in the publisher's grey, but at 40 % opacity: it covers 40 % of the island and would hide the basemap,
# yet leaving it out would make "mapped as Low" look the same as "not mapped" (Vieques, Culebra, the sea).
ALPHAS = {1: 102, 2: 255, 3: 255, 4: 255, 5: 255}

ZB = 15            # zoom of the base grid the raster is resampled to
ZMAX, ZMIN = 13, 8
SIZE_LIMIT = 15.0e6

# Places for the spot checks: (name, lon, lat, what one expects). Coordinates are town centres / well known points.
SPOTS = [
    ('San Juan, Hato Rey (coastal plain)', -66.0580, 18.4215, 'low'),
    ('Carolina, SJU airport runway (coastal plain)', -66.0018, 18.4394, 'low'),
    ('Ponce, Plaza Las Delicias (southern plain)', -66.6141, 18.0111, 'low'),
    ('Lajas valley', -67.0600, 18.0300, 'low'),
    ('Utuado, pueblo (valley floor in the mountains)', -66.7005, 18.2655, 'low at the point, high around'),
    ('Naranjito, pueblo', -66.2449, 18.3008, 'high around'),
    ('Jayuya, pueblo', -66.5916, 18.2186, 'high around'),
    ('Maricao, pueblo', -66.9799, 18.1808, 'high around'),
    ('Cerro de Punta (highest point)', -66.5919, 18.1722, 'high'),
    ('El Yunque peak', -65.7925, 18.3106, 'high'),
    ('Vieques, Isabel Segunda (not on the map)', -65.4430, 18.1490, 'no data'),
    ('Culebra, Dewey (not on the map)', -65.3010, 18.3030, 'no data'),
]

T0 = time.time()
LOG = None


def log(*a):
    s = '[%6.1fs] ' % (time.time() - T0) + ' '.join(str(x) for x in a)
    print(s, flush=True)
    if LOG:
        with open(LOG, 'a') as f:
            f.write(s + '\n')


def fetch(url, dest, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'garita-pipeline (github.com/webgpu-demos/garita)'})
            with urllib.request.urlopen(req, timeout=300) as r, open(dest, 'wb') as f:
                ctype = r.headers.get('content-type', '')
                while True:
                    b = r.read(1 << 20)
                    if not b:
                        break
                    f.write(b)
            log(f'fetched {url} -> {os.path.getsize(dest)} bytes, content-type {ctype}')
            return ctype
        except Exception as e:  # noqa: BLE001
            log(f'fetch attempt {i + 1} failed: {e!r}')
            time.sleep(10 * (i + 1))
    raise RuntimeError('could not download ' + url)


def lon_to_x(lon, z):
    return (lon + 180.0) / 360.0 * 2 ** z


def lat_to_y(lat, z):
    s = math.sin(math.radians(lat))
    return (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * 2 ** z


def hex_rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def use_limits(xml):
    """The publisher's own words, cut out of the FGDC metadata, not retyped: the section 'USE AND LIMITATIONS OF THE
    LANDSLIDE SUSCEPTIBILITY MAP' of the abstract, the access and use constraints, and the distribution liability."""
    def tag(t):
        m = re.search(r'<%s>(.*?)</%s>' % (t, t), xml, re.S)
        if not m:
            return None
        s = m.group(1)
        for a, b in (('&amp;', '&'), ('&lt;', '<'), ('&gt;', '>'), ('&quot;', '"'), ('&apos;', "'")):
            s = s.replace(a, b)
        return s.strip()
    ab = tag('abstract') or ''
    m = re.search(r'USE AND LIMITATIONS OF THE LANDSLIDE SUSCEPTIBILITY MAP\s*(.*?)\s*REFERENCES CITED', ab, re.S)
    if not m:
        raise RuntimeError('the use-and-limitations section was not found in the metadata abstract')
    paras = [re.sub(r'[ \t]*\n[ \t]*', ' ', p).strip() for p in re.split(r'\n\s*\n', m.group(1)) if p.strip()]
    return {'use_and_limitations': paras, 'access_constraints': tag('accconst'), 'use_constraints': tag('useconst'),
            'distribution_liability': tag('distliab'),
            'shares_sentence': (re.search(r'The Extremely High classification occurs over.*?respectively\.', ab, re.S) or [None])[0]}


def sample(a, tf, crs, lon, lat):
    """Class of the cell each lon/lat point falls in; 0 outside the raster or where the cell has no data."""
    from rasterio.warp import transform as wt
    out = np.zeros(len(lon), np.uint8)
    inside = np.zeros(len(lon), bool)
    h, w = a.shape
    for i in range(0, len(lon), 250000):
        xs, ys = wt('EPSG:4326', crs, list(map(float, lon[i:i + 250000])), list(map(float, lat[i:i + 250000])))
        xs, ys = np.asarray(xs), np.asarray(ys)
        col = np.floor((xs - tf.c) / tf.a).astype(np.int64)
        row = np.floor((ys - tf.f) / tf.e).astype(np.int64)
        ok = (col >= 0) & (col < w) & (row >= 0) & (row < h)
        v = np.zeros(len(xs), np.uint8)
        v[ok] = a[row[ok], col[ok]]
        out[i:i + 250000] = v
        inside[i:i + 250000] = ok
    return out, inside


def highest_near(a, tf, crs, lon, lat, own, cells):
    """Highest class among the cells whose centre lies within `cells` cells of the point's own cell. Only for points
    that have data themselves (0 stays 0); cells without data are ignored."""
    from rasterio.warp import transform as wt
    h, w = a.shape
    out = np.zeros(len(lon), np.uint8)
    offs = [(dx, dy) for dy in range(-cells, cells + 1) for dx in range(-cells, cells + 1) if dx * dx + dy * dy <= cells * cells]
    for i in range(0, len(lon), 250000):
        xs, ys = wt('EPSG:4326', crs, list(map(float, lon[i:i + 250000])), list(map(float, lat[i:i + 250000])))
        col = np.floor((np.asarray(xs) - tf.c) / tf.a).astype(np.int64)
        row = np.floor((np.asarray(ys) - tf.f) / tf.e).astype(np.int64)
        m = np.zeros(len(col), np.uint8)
        for dx, dy in offs:
            r, c = row + dy, col + dx
            ok = (r >= 0) & (r < h) & (c >= 0) & (c < w)
            v = a[np.clip(r, 0, h - 1), np.clip(c, 0, w - 1)]
            v[~ok] = 0
            np.maximum(m, v, out=m)
        out[i:i + 250000] = m
    out[np.asarray(own) == 0] = 0
    return out


def counts(v):
    c = np.bincount(np.asarray(v, np.uint8), minlength=6)[:6]
    return {str(k): int(c[k]) for k in range(6)}


def halve(cnt, tx0, ty0):
    """One zoom level up: pad to an even tile origin and an even tile count, then sum 2 x 2 pixels."""
    _, h, w = cnt.shape
    pl = 256 if tx0 % 2 else 0
    pt = 256 if ty0 % 2 else 0
    pr = 256 if ((w + pl) // 256) % 2 else 0
    pb = 256 if ((h + pt) // 256) % 2 else 0
    if pl or pt or pr or pb:
        cnt = np.pad(cnt, ((0, 0), (pt, pb), (pl, pr)))
    cnt = cnt.astype(np.uint16, copy=False)
    cnt = cnt[:, 0::2, 0::2] + cnt[:, 0::2, 1::2] + cnt[:, 1::2, 0::2] + cnt[:, 1::2, 1::2]
    return cnt, (tx0 - (1 if pl else 0)) // 2, (ty0 - (1 if pt else 0)) // 2


def classify(cnt, z):
    """Majority class per pixel (ties to the higher class); 0 where fewer than half of the cells have data."""
    n = 4 ** (ZB - z)
    valid = cnt.sum(axis=0, dtype=np.uint32)
    cls = (5 - np.argmax(cnt[::-1], axis=0)).astype(np.uint8)
    cls[valid * 2 < n] = 0
    return cls


def write_tiles(cls, z, tx0, ty0, d, palette, trns, lut):
    from PIL import Image
    idx = lut[cls]
    n = size = 0
    tiles = []
    for j in range(cls.shape[0] // 256):
        for i in range(cls.shape[1] // 256):
            sub = idx[j * 256:(j + 1) * 256, i * 256:(i + 1) * 256]
            if not sub.any():
                continue
            im = Image.fromarray(np.ascontiguousarray(sub))
            im.putpalette(palette)
            f = os.path.join(d, str(z), str(tx0 + i), f'{ty0 + j}.png')
            os.makedirs(os.path.dirname(f), exist_ok=True)
            im.save(f, 'PNG', optimize=True, transparency=trns, bits=4)
            n += 1; size += os.path.getsize(f)
            tiles.append([z, tx0 + i, ty0 + j])
    return tiles, size


def qa_picture(cls, z, tx0, ty0, spots, path, blon, blat, bcls, title):
    """The majority-class mosaic of one zoom (all five classes drawn, white = no data), the spot-check places, and
    below it the buildings alone, coloured by their sampled class, as a check that points and raster line up."""
    from PIL import Image, ImageDraw, ImageFont
    rows = np.where(cls.any(axis=1))[0]; cols = np.where(cls.any(axis=0))[0]
    r0, r1, c0, c1 = max(rows[0] - 20, 0), min(rows[-1] + 20, cls.shape[0]), max(cols[0] - 20, 0), min(cols[-1] + 20, cls.shape[1])
    lut = np.array([(255, 255, 255)] + [hex_rgb(COLOURS[k]) for k in range(1, 6)], np.uint8)
    top = lut[cls[r0:r1, c0:c1]]
    hh, ww = top.shape[:2]
    # buildings panel on the same grid
    px = (lon_to_x(blon, z) - tx0) * 256 - c0
    s = np.sin(np.radians(blat))
    py = ((0.5 - np.log((1 + s) / (1 - s)) / (4 * math.pi)) * 2 ** z - ty0) * 256 - r0
    bot = np.full((hh, ww, 3), 34, np.uint8)
    ok = (px >= 0) & (px < ww) & (py >= 0) & (py < hh)
    blut = np.array([(255, 0, 255)] + [hex_rgb(COLOURS[k]) for k in range(1, 6)], np.uint8)
    for k in (1, 2, 3, 4, 5, 0):  # no-data buildings drawn last, in magenta, so they can be seen
        m = ok & (bcls == k)
        bot[py[m].astype(int), px[m].astype(int)] = blut[k]
    try:
        font = ImageFont.load_default(size=15); small = ImageFont.load_default(size=12)
    except TypeError:
        font = small = ImageFont.load_default()
    head = 30
    canvas = Image.new('RGB', (ww, 2 * hh + 3 * head), (255, 255, 255))
    canvas.paste(Image.fromarray(top), (0, head)); canvas.paste(Image.fromarray(bot), (0, 2 * head + hh))
    dr = ImageDraw.Draw(canvas)
    dr.text((8, 6), title, fill=(0, 0, 0), font=font)
    dr.text((8, head + hh + 6), 'Buildings coloured by the class sampled at their centroid (magenta = no data)', fill=(0, 0, 0), font=font)
    x = 8
    for k in range(1, 6):
        dr.rectangle([x, 2 * hh + 2 * head + 8, x + 16, 2 * hh + 2 * head + 22], fill=hex_rgb(COLOURS[k]), outline=(0, 0, 0))
        dr.text((x + 22, 2 * hh + 2 * head + 7), f"{k} {CLASSES[k]['en']}", fill=(0, 0, 0), font=small)
        x += 150
    dr.rectangle([x, 2 * hh + 2 * head + 8, x + 16, 2 * hh + 2 * head + 22], fill=(255, 255, 255), outline=(0, 0, 0))
    dr.text((x + 22, 2 * hh + 2 * head + 7), 'no data', fill=(0, 0, 0), font=small)
    for name, lon, lat, _exp, val in spots:
        sx = (lon_to_x(lon, z) - tx0) * 256 - c0; sy = (lat_to_y(lat, z) - ty0) * 256 - r0 + head
        if 0 <= sx < ww and head <= sy < head + hh:
            dr.ellipse([sx - 4, sy - 4, sx + 4, sy + 4], outline=(0, 0, 0), width=2)
            dr.text((sx + 6, sy - 7), f"{name.split(',')[0].split(' (')[0]}: {val}", fill=(0, 0, 0), font=small, stroke_width=2, stroke_fill=(255, 255, 255))
    for q in (85, 75, 65):
        canvas.save(path, 'JPEG', quality=q, optimize=True)
        if os.path.getsize(path) < 900e3:
            break
    log(f'qa.jpg {canvas.size} -> {os.path.getsize(path) / 1e3:.0f} kB')


def main():
    global LOG
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', required=True); ap.add_argument('--out', required=True); ap.add_argument('--work', required=True)
    a_ = ap.parse_args()
    out, work, site = os.path.abspath(a_.out), os.path.abspath(a_.work), os.path.abspath(a_.site)
    dd = os.path.join(out, 'data/hazards/slide'); td = os.path.join(out, 'tiles/slide')
    os.makedirs(dd, exist_ok=True); os.makedirs(work, exist_ok=True)
    LOG = os.path.join(dd, 'log.txt')
    open(LOG, 'w').close()
    generated = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    log('slide stage start', generated, 'commit', os.environ.get('GITHUB_SHA', '?')[:7], 'run', os.environ.get('GITHUB_RUN_ID', '?'))
    import rasterio
    from rasterio.warp import reproject, Resampling, transform_bounds
    from rasterio.transform import Affine
    import PIL
    log('rasterio', rasterio.__version__, 'gdal', rasterio.__gdal_version__, 'numpy', np.__version__, 'pillow', PIL.__version__)

    # 1. the raster
    zf = os.path.join(work, 'slide.zip')
    ctype = fetch(ZIP_URL, zf)
    if 'zip' not in ctype or not zipfile.is_zipfile(zf):
        raise RuntimeError(f'{ZIP_URL} did not return a zip (content-type {ctype}); the raster may now need a ScienceBase account')
    with zipfile.ZipFile(zf) as z:
        names = z.namelist()
        log('zip holds:', ', '.join(f'{i.filename} ({i.file_size})' for i in z.infolist()))
        tif = [n for n in names if n.lower().endswith('.tif')]
        xml = [n for n in names if n.lower().endswith('.xml') and '.aux.' not in n.lower()]
        if len(tif) != 1 or not xml:
            raise RuntimeError(f'expected one .tif and the metadata xml in the zip, found {names}')
        z.extractall(work)
        meta_xml = z.read(xml[0]).decode('utf-8', 'replace')
    limits = use_limits(meta_xml)
    log('use limits: %d paragraphs, %d characters' % (len(limits['use_and_limitations']), sum(map(len, limits['use_and_limitations']))))
    ds = rasterio.open(os.path.join(work, tif[0]))
    log('raster', tif[0], 'size', ds.width, 'x', ds.height, 'dtype', ds.dtypes[0], 'nodata', ds.nodata, 'res', ds.res, 'crs', ds.crs.to_string(), 'bounds', tuple(ds.bounds))
    if ds.crs.to_epsg() != 32619 or abs(ds.res[0] - 5) > 1e-6 or abs(ds.res[1] - 5) > 1e-6:
        raise RuntimeError('the raster is not the 5 m, EPSG:32619 grid this stage was written for')
    raw = ds.read(1)
    vals, cn = np.unique(raw, return_counts=True)
    hist = {int(v): int(c) for v, c in zip(vals, cn)}
    log('raster values:', hist)
    unexpected = {v: c for v, c in hist.items() if not (1 <= v <= 5) and v != ds.nodata}
    if unexpected:
        log('WARNING values outside 1..5 that are not the nodata value, treated as no data:', unexpected)
    a = np.where((raw >= 1) & (raw <= 5), raw, 0).astype(np.uint8)
    del raw
    cells = np.bincount(a.ravel(), minlength=6)[:6]
    cells_valid = int(cells[1:].sum())
    raster_share = {str(k): round(100.0 * int(cells[k]) / cells_valid, 2) for k in range(1, 6)}
    log('share of mapped cells per class (%):', raster_share, '| mapped area %.0f km2' % (cells_valid * 25 / 1e6))
    w84 = transform_bounds(ds.crs, 'EPSG:4326', *ds.bounds, densify_pts=41)
    log('raster bounds lon/lat', [round(v, 5) for v in w84])

    # 2. the points
    t = time.time()
    lon, lat, stamp = common.load_buildings(site)
    assets = common.load_assets(site)
    log(f'{len(lon)} buildings ({stamp}), {len(assets)} assets, loaded in {time.time() - t:.0f}s')
    bcls, bin_ = sample(a, ds.transform, ds.crs, lon, lat)
    acls, ain = sample(a, ds.transform, ds.crs, np.array([p[1] for p in assets]), np.array([p[2] for p in assets]))
    bc = counts(bcls); ac = counts(acls)
    nb = len(bcls)
    log('buildings per class', bc, '| assets per class', ac)
    nd = bcls == 0
    b_nd = {'total': int(nd.sum()), 'outside_raster_extent': int((nd & ~bin_).sum()), 'inside_extent_cell_without_data': int((nd & bin_).sum()),
            'east_of_65.58W (Vieques, Culebra and the eastern cays, which the map does not cover)': int((nd & (lon > -65.58)).sum()),
            'west_of_67.28W (Mona, Desecheo)': int((nd & (lon < -67.28)).sum())}
    and_ = acls == 0
    a_nd = {'total': int(and_.sum()), 'outside_raster_extent': int((and_ & ~ain).sum()), 'inside_extent_cell_without_data': int((and_ & ain).sum())}
    log('buildings without data', b_nd, '| assets without data', a_nd)
    # an extra, ours: the highest class within 25 m, because a building's own cell is often a graded pad that reads Low
    NEAR = 5
    bnear = highest_near(a, ds.transform, ds.crs, lon, lat, bcls, NEAR)
    anear = highest_near(a, ds.transform, ds.crs, np.array([p[1] for p in assets]), np.array([p[2] for p in assets]), acls, NEAR)
    bnc, anc = counts(bnear), counts(anear)
    log(f'highest class within {NEAR * 5} m: buildings', bnc, '| assets', anc)
    by_type = {}
    for (i, _lo, _la), c in zip(assets, acls):
        by_type.setdefault(i.split(':')[0], [0] * 6)[int(c)] += 1

    # spot checks: the cell at the point, and the mix of classes within 1 km of it
    spots, spot_meta = [], []
    slon = np.array([s[1] for s in SPOTS]); slat = np.array([s[2] for s in SPOTS])
    sv, _ = sample(a, ds.transform, ds.crs, slon, slat)
    from rasterio.warp import transform as wt
    sx, sy = wt('EPSG:4326', ds.crs, list(slon), list(slat))
    yy, xx = np.mgrid[-200:201, -200:201]
    disc = (xx * xx + yy * yy) <= 200 * 200
    for (name, lo, la, exp), v, x, y in zip(SPOTS, sv, sx, sy):
        col = int(math.floor((x - ds.transform.c) / 5)); row = int(math.floor((ds.transform.f - y) / 5))
        within = None
        if 200 <= col < ds.width - 200 and 200 <= row < ds.height - 200:
            win = a[row - 200:row + 201, col - 200:col + 201][disc]
            k = np.bincount(win, minlength=6)[:6]
            if k[1:].sum():
                within = {'cells_with_data_pct': round(100.0 * k[1:].sum() / win.size, 1),
                          'pct_by_class': {str(c): round(100.0 * k[c] / k[1:].sum(), 1) for c in range(1, 6)},
                          'pct_high_or_above': round(100.0 * k[3:].sum() / k[1:].sum(), 1)}
        m = {'place': name, 'lon': lo, 'lat': la, 'class_at_point': int(v), 'name_at_point': CLASSES[int(v)]['en'] if v else 'no data',
             'within_1_km': within, 'expected': exp}
        spot_meta.append(m); spots.append((name, lo, la, exp, int(v)))
        log('spot', json.dumps(m))

    # 3. tiles
    t = time.time()
    world = 2 * math.pi * 6378137.0
    px = world / (256 * 2 ** ZB)
    f = 2 ** (ZB - ZMAX)               # base pixels per zoom-13 pixel, per axis
    tx0 = int(math.floor(lon_to_x(w84[0], ZMAX))); tx1 = int(math.floor(lon_to_x(w84[2], ZMAX)))
    ty0 = int(math.floor(lat_to_y(w84[3], ZMAX))); ty1 = int(math.floor(lat_to_y(w84[1], ZMAX)))
    W, H = (tx1 - tx0 + 1) * 256 * f, (ty1 - ty0 + 1) * 256 * f
    dst_tf = Affine(px, 0, -world / 2 + tx0 * 256 * f * px, 0, -px, world / 2 - ty0 * 256 * f * px)
    base = np.zeros((H, W), np.uint8)
    reproject(a, base, src_transform=ds.transform, src_crs=ds.crs, src_nodata=0, dst_transform=dst_tf, dst_crs='EPSG:3857',
              dst_nodata=0, resampling=Resampling.nearest, num_threads=4)
    bcells = np.bincount(base.ravel(), minlength=6)[:6]
    log(f'base grid z{ZB}: {W} x {H} px ({px:.3f} m mercator), z{ZMAX} tiles x {tx0}..{tx1} y {ty0}..{ty1}, warped in {time.time() - t:.0f}s; '
        f'class shares on the base grid (%):', {str(k): round(100.0 * int(bcells[k]) / int(bcells[1:].sum()), 2) for k in range(1, 6)})
    cnt = np.empty((5, H // f, W // f), np.uint8)
    for k in range(1, 6):
        cnt[k - 1] = (base == k).reshape(H // f, f, W // f, f).sum(axis=(1, 3), dtype=np.uint8)
    del base
    rgb = [hex_rgb(COLOURS[k]) for k in range(1, 6)]
    palette = [0, 0, 0] + [v for k in range(1, 6) for v in rgb[k - 1]]
    trns = bytes([0] + [ALPHAS[k] for k in range(1, 6)])
    lut = np.arange(6, dtype=np.uint8)
    tiles, per_zoom, qa_done = [], {}, False
    z, cx0, cy0 = ZMAX, tx0, ty0
    while True:
        cls = classify(cnt, z)
        tl, size = write_tiles(cls, z, cx0, cy0, td, palette, trns, lut)
        k = np.bincount(cls.ravel(), minlength=6)[:6]
        share = {str(c): round(100.0 * int(k[c]) / max(int(k[1:].sum()), 1), 2) for c in range(1, 6)}
        per_zoom[z] = {'tiles': len(tl), 'bytes': size, 'pct_of_mapped_pixels_by_class': share}
        log(f'z{z}: {len(tl)} tiles, {size / 1e6:.2f} MB, class shares after majority (%): {share}')
        tiles += tl
        if z == 11:
            qa_picture(cls, z, cx0, cy0, spots, os.path.join(dd, 'qa.jpg'), lon, lat, bcls,
                       f'USGS OFR 2020-1022 landslide susceptibility, majority class per zoom-{z} pixel (all five classes; white = no data), spot checks: class at the point')
        if z == ZMIN:
            break
        cnt, cx0, cy0 = halve(cnt, cx0, cy0)
        z -= 1
    total = sum(v['bytes'] for v in per_zoom.values())
    maxzoom, dropped = ZMAX, None
    if total > SIZE_LIMIT:
        import shutil
        shutil.rmtree(os.path.join(td, str(ZMAX)))
        dropped = f'zoom {ZMAX} was baked ({per_zoom[ZMAX]["tiles"]} tiles, {per_zoom[ZMAX]["bytes"] / 1e6:.1f} MB) but left out to keep the set under {SIZE_LIMIT / 1e6:.0f} MB'
        log('WARNING', dropped)
        tiles = [t_ for t_ in tiles if t_[0] != ZMAX]
        total -= per_zoom[ZMAX]['bytes']; maxzoom = ZMAX - 1
    tiles.sort()
    log(f'tiles: {len(tiles)} files, {total / 1e6:.2f} MB, zoom {ZMIN}..{maxzoom}')

    # 4. the words
    en_limits = '\n\n'.join(limits['use_and_limitations'])
    disclaimer_en = en_limits + '\n\n' + (limits['distribution_liability'] or '')
    reduction = ('Each tile pixel shows the majority class of the 5 m cells it covers (16 cells at zoom 13, about 16,000 at zoom 8; ties go '
                 'to the higher class) and is transparent where fewer than half of them have data.')
    note = {
        'en': ('Relative susceptibility to landslides during or soon after intense rainfall, from the USGS 5 m map (Open-File Report 2020-1022). '
               'Five classes by share of the island: Low (about 40%), Moderate (30%), High (20%), Very High (9%), Extremely High (1%). '
               'Colours are those of the published map (Extremely High is blue); Low is drawn as a faint grey. ' + reduction + ' The map covers the main '
               'island only: Vieques, Culebra, Mona and the smaller islands have no data, which is not the same as low susceptibility. It shows where '
               'landslides are likely to start, not how far they travel downslope.'),
        'es': ('Susceptibilidad relativa a deslizamientos durante o poco después de lluvia intensa, del mapa del USGS de 5 m (Open-File Report 2020-1022). '
               'Cinco clases según la porción de la isla: Baja (cerca de 40%), Moderada (30%), Alta (20%), Muy Alta (9%), Extremadamente Alta (1%). '
               'Los colores son los del mapa publicado (Extremadamente Alta es azul); Baja se dibuja en gris tenue. Cada píxel muestra la clase mayoritaria de las '
               'celdas de 5 m que cubre (16 celdas en zoom 13, unas 16,000 en zoom 8; los empates van a la clase más alta) y es transparente donde menos de la mitad '
               'tienen datos. El mapa cubre solo la isla grande: Vieques, Culebra, Mona y las islas menores no tienen datos, lo que no equivale a susceptibilidad '
               'baja. Muestra dónde es probable que se inicien los deslizamientos, no hasta dónde llegan cuesta abajo.'),
    }
    legend = [{'color': COLOURS[k], 'value': k, 'alpha': round(ALPHAS[k] / 255, 2), 'label': {'en': CLASSES[k]['en'], 'es': CLASSES[k]['es']}} for k in range(5, 0, -1)]
    es_paras = [p_.strip() for p_ in open(os.path.join(HERE, 'slide_limits_es.txt'), encoding='utf-8').read().split('\n\n') if p_.strip()]
    disclaimer_es = '\n\n'.join(es_paras)
    es_source = ('Spanish edition of the plate of USGS Open-File Report 2020-1022 (https://pubs.usgs.gov/of/2020/1022/ofr20201022_sheet_esp.pdf), section '
                 '"USO Y LIMITACIONES DEL MAPA DE SUSCEPTIBILIDAD A DESLIZAMIENTOS DE TIERRA", the publisher\'s own Spanish text, extracted from the PDF with only '
                 'the line breaks removed (pipeline/hazards/slide_limits_es.txt). It is the plate\'s wording, so it is close to, but not a sentence-for-sentence '
                 'match of, the English taken from the data release metadata.')
    source = {
        'name': 'Geographic Information System Layer of a Map Depicting Susceptibility to Landslides Triggered by Intense Rainfall, Puerto Rico (USGS data release), the GIS layer of USGS Open-File Report 2020-1022',
        'publisher': 'U.S. Geological Survey', 'urls': [DOI_DATA, ITEM_URL, ZIP_URL, DOI_REPORT, 'https://pubs.usgs.gov/of/2020/1022/'],
        'file': tif[0], 'version': 'data release published 2021-08-17; report published 2020', 'retrieved': generated,
        'licence': 'U.S. Government work in the public domain. Metadata: access constraints "%s"; use constraints "%s".' % (limits['access_constraints'], limits['use_constraints']),
        'citation': CITATION, 'citation_data': CITATION_DATA,
        'raster': {'crs': 'EPSG:32619 (WGS 84 / UTM zone 19N)', 'cell_size_m': 5, 'width': ds.width, 'height': ds.height, 'dtype': ds.dtypes[0], 'nodata': ds.nodata,
                   'bounds_utm': [round(v, 3) for v in ds.bounds], 'bounds_lonlat': [round(v, 5) for v in w84], 'cells_by_value': hist},
    }
    method = ('Each building (area centroid of its footprint) and each asset (its stored point) is converted from longitude/latitude (WGS 84) to the raster\'s '
              'own grid, WGS 84 / UTM zone 19N, and given the value of the 5 m cell it falls in: nearest cell, no interpolation, no buffer, no smoothing. '
              'Values are the publisher\'s classes 1..5; 0 means no data (the point is outside the raster or its cell is empty: the sea, and every island '
              'other than the main one). The class is a relative ranking of where landslides start; it says nothing about where they run out. '
              'Overlay tiles: the raster is resampled once by nearest neighbour to the Web Mercator pixel grid of zoom 15 (about 4.5 m on the ground); '
              + reduction + ' Majority rather than highest class, because the classes are area percentiles and "highest" would overstate them at island scale; '
              'bands narrower than a tile pixel therefore thin out at low zoom. The values at points never pass through the tiles.')
    classes = {'0': {'en': 'No data', 'es': 'Sin datos', 'meaning': 'Outside the map (sea, Vieques, Culebra, Mona and the smaller islands) or an empty cell. Not a susceptibility.'}}
    for k in range(1, 6):
        classes[str(k)] = {'en': CLASSES[k]['en'], 'es': CLASSES[k]['es'], 'color': COLOURS[k],
                           'meaning': f"Relative susceptibility to landslides triggered by intense rainfall: {CLASSES[k]['en']}; {CLASSES[k]['share']}. Measured share of mapped cells: {raster_share[str(k)]}%."}
    classes_note = ('Class names are the raster attribute rainLSsuc as published; Spanish names are those printed in the legend of the Spanish edition of the plate. '
                    'The classes rank relative susceptibility by share of the island\'s area'
                    + (': "' + limits['shares_sentence'] + '" (data release abstract).' if limits['shares_sentence'] else '.'))
    qa = {
        'buildings_total': nb, 'buildings_by_class': bc,
        'buildings_pct_by_class': {k: round(100.0 * v / nb, 2) for k, v in bc.items()},
        'buildings_pct_high_or_above': round(100.0 * (bc['3'] + bc['4'] + bc['5']) / nb, 2),
        'buildings_no_data': b_nd,
        'assets_total': len(assets), 'assets_by_class': ac, 'assets_no_data': a_nd,
        'assets_by_type_and_class': {k: {str(i): v[i] for i in range(6)} for k, v in sorted(by_type.items())},
        'highest_class_within_25_m': {'buildings_by_class': bnc, 'buildings_pct_by_class': {k: round(100.0 * v / nb, 2) for k, v in bnc.items()},
                                      'buildings_pct_high_or_above': round(100.0 * (bnc['3'] + bnc['4'] + bnc['5']) / nb, 2), 'assets_by_class': anc},
        'raster_pct_of_mapped_cells_by_class': raster_share, 'raster_mapped_km2': round(cells_valid * 25 / 1e6, 1),
        'spots': spot_meta,
        'tiles': {'count': len(tiles), 'bytes': total, 'zoom': [ZMIN, maxzoom], 'per_zoom': {str(k): v for k, v in sorted(per_zoom.items())}, 'dropped': dropped,
                  'format': 'PNG, 4-bit indexed colour with a transparency table', 'alpha_by_class': {str(k): round(ALPHAS[k] / 255, 2) for k in range(1, 6)}},
        'seconds': round(time.time() - T0),
    }
    meta = {'source': source, 'method': method, 'classes': classes, 'classes_note': classes_note, 'colours': COLOUR_SOURCE,
            'disclaimer': {'en': disclaimer_en, 'source': 'FGDC metadata of the data release (landslide_susceptibility_raster.xml): abstract section "USE AND LIMITATIONS OF THE LANDSLIDE SUSCEPTIBILITY MAP" and the distribution liability statement, verbatim',
                           'paragraphs': limits['use_and_limitations'], 'distribution_liability': limits['distribution_liability'],
                           'es': disclaimer_es, 'es_source': es_source, 'es_paragraphs': es_paras},
            'qa': qa, 'generated': generated, 'commit': os.environ.get('GITHUB_SHA', '?')[:7], 'run': os.environ.get('GITHUB_RUN_ID', '?')}
    meta['extras'] = {
        'buildings_max25m.bin': 'uint8 per building, canonical order. NOT a published value: the highest class among the 5 m cells whose centre is within 25 m (5 cells) '
                                'of the building\'s own cell; 0 where the building itself has no data. Offered because a building\'s own cell is often a graded pad that '
                                'reads Low while the slope cut beside it does not; the 25 m radius is our choice, not the publisher\'s. buildings.bin remains the class at the point.',
        'assets_max25m.json': 'the same for assets: { "<type>:<key>": class }',
        'slide_limits_es.txt': 'not published; in the repository (pipeline/hazards/), the Spanish use limits as extracted from the Spanish plate'}
    d = common.write_stage(out, 'slide', bcls, 'u1', {i: int(c) for (i, _lo, _la), c in zip(assets, acls)}, meta, stamp)
    bnear.tofile(os.path.join(d, 'buildings_max25m.bin'))
    with open(os.path.join(d, 'assets_max25m.json'), 'w') as fjson:
        json.dump({i: int(c) for (i, _lo, _la), c in zip(assets, anear)}, fjson, separators=(',', ':'))
    index = {'stage': 'slide', 'minZoom': ZMIN, 'maxZoom': maxzoom, 'tileSize': 256, 'tiles': tiles,
             'title': {'en': 'Landslide susceptibility (intense rainfall)', 'es': 'Susceptibilidad a deslizamientos (lluvia intensa)'},
             'unit': 'class', 'legend': legend, 'legendSource': COLOUR_SOURCE, 'note': note,
             'disclaimer': {'en': disclaimer_en, 'es': disclaimer_es},
             'source': 'U.S. Geological Survey, Open-File Report 2020-1022 and its GIS layer (' + DOI_DATA + ')', 'citation': CITATION,
             'reduction': 'majority class of the 5 m cells under each tile pixel, ties to the higher class; transparent where fewer than half have data',
             'bounds': [round(v, 5) for v in w84], 'generated': generated}
    with open(os.path.join(td, 'index.json'), 'w') as fjson:
        json.dump(index, fjson, separators=(',', ':'), ensure_ascii=False)
    log('done:', json.dumps({k: qa[k] for k in ('buildings_by_class', 'buildings_pct_by_class', 'assets_by_class')}))


if __name__ == '__main__':
    try:
        main()
    except Exception:  # noqa: BLE001
        log('FAILED\n' + traceback.format_exc())
        sys.exit(1)
