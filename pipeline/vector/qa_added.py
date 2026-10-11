#!/usr/bin/env python3
"""QA of the added (machine-detected) footprints, read back from the tiles build.mjs wrote, not from its memory.

1. Sample check: 2,000 added records drawn at random (fixed seed) and, for comparison, all of them. A failure is
   an added footprint that (a) intersects an OpenStreetMap footprint of the tiles with a shared area above
   0.5 m2, (b) has its centroid inside an OSM footprint or contains an OSM centroid, (c) has its centroid outside
   the land-clipped municipios (in the sea), or (d) intersects another added footprint. Geometry by shapely/GEOS,
   so it does not share code with the test in build.mjs. Ground elevation at or below 0 m is counted as a hint.
2. Picture: OSM and added footprints over the municipio with the largest added share and over San Juan, each as
   an overview and a 1.5 km close-up of the place with most additions.
Writes data/derived/bld_added_qa.jpg and data/derived/bld_added_check.json, and puts the check into qa.json.
"""
import json, math, os, struct, sys, time
import numpy as np
import shapely
from shapely.geometry import shape
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.collections import PolyCollection

OUT = os.environ.get('OUT_DIR', 'out')
Z, PAD = 14, 0.25
t0 = time.time()
def log(*a): print(time.strftime('%H:%M:%S', time.gmtime()), 'qa_added', *a, flush=True)

idx = json.load(open(f'{OUT}/tiles/bld/index.json'))
qa_path = f'{OUT}/data/derived/qa.json'
qa = json.load(open(qa_path))
if not idx.get('added'):
    log('no added footprints in this build; nothing to check'); sys.exit(0)

# ---- decode every tile ----
tx, ty, nvs, kinds, grounds, parts = [], [], [], [], [], []
for x, y, n in idx['tiles']:
    buf = open(f'{OUT}/tiles/bld/{Z}/{x}/{y}.bin', 'rb').read()
    assert buf[:4] == b'GBL1' and struct.unpack_from('<I', buf, 4)[0] == n
    o = 8
    for _ in range(n):
        nv, h, kind, ground, flood, place = struct.unpack_from('<HBBhBb', buf, o)
        a = np.frombuffer(buf, '<u2', nv * 2, o + 8).reshape(nv, 2)
        parts.append(a); parts.append(a[:1])            # closed ring
        tx.append(x); ty.append(y); nvs.append(nv + 1); kinds.append(kind); grounds.append(ground)
        o += 8 + nv * 4
    assert o == len(buf)
nvs = np.array(nvs); kinds = np.array(kinds, np.uint8); grounds = np.array(grounds, np.int16)
uv = np.concatenate(parts).astype(np.float64); del parts
fx = uv[:, 0] / 65535 * (1 + 2 * PAD) - PAD + np.repeat(np.array(tx, np.float64), nvs)
fy = uv[:, 1] / 65535 * (1 + 2 * PAD) - PAD + np.repeat(np.array(ty, np.float64), nvs)
lon = fx / 2 ** Z * 360 - 180
lat = np.degrees(np.arctan(np.sinh(math.pi * (1 - 2 * fy / 2 ** Z))))
off = np.concatenate([[0], np.cumsum(nvs)])
N = len(nvs)
added = (kinds & 0x80) != 0
log('decoded', N, 'records;', int(added.sum()), 'added;', int((~added).sum()), 'OSM;', f'{time.time() - t0:.0f}s')
assert N == idx['total'] and int(added.sum()) == idx['added'] and int((~added).sum()) == idx['osm']
assert set(np.unique(kinds & 0x7f)) <= set(range(7))
# in every tile the OSM records come first
tile_id = np.repeat(np.arange(len(idx['tiles'])), [t[2] for t in idx['tiles']])
order_ok = bool(np.all(np.diff(added.astype(np.int8))[np.diff(tile_id) == 0] >= 0))

polys = shapely.from_ragged_array(shapely.GeometryType.POLYGON, np.column_stack([lon, lat]), (off, np.arange(N + 1)))
cen = shapely.centroid(polys); cx, cy = shapely.get_x(cen), shapely.get_y(cen)
osm_i = np.flatnonzero(~added); add_i = np.flatnonzero(added)
KX, KY = 111319.49 * math.cos(math.radians(18.22)), 110574.0   # metres per degree, good enough for areas here
tree = shapely.STRtree(polys[osm_i])
land = [shape(f['geometry']) for f in json.load(open(f'{OUT}/data/geo/municipios_land.geojson'))['features']] if os.path.exists(f'{OUT}/data/geo/municipios_land.geojson') else None
ltree = shapely.STRtree(land) if land else None
atree = shapely.STRtree(polys[add_i])

def check(sel):
    """sel: indices into add_i. Returns failure counts."""
    g = polys[add_i[sel]]
    a, b = tree.query(g, predicate='intersects')
    ia = np.zeros(len(a))
    if len(a):
        with np.errstate(all='ignore'):
            inter = shapely.intersection(shapely.make_valid(g[a]), shapely.make_valid(polys[osm_i[b]]))
        ia = shapely.area(inter) * KX * KY
    over = np.unique(a[ia > 0.5])
    touch = np.unique(a)
    a2, b2 = tree.query(cen[add_i[sel]], predicate='within')
    a3, b3 = tree.query(g, predicate='contains_properly'); keep = np.zeros(len(a3), bool)
    if len(a3): keep = shapely.contains(g[a3], cen[osm_i[b3]])
    a4, b4 = tree.query(g, predicate='intersects')
    cin = np.zeros(len(a4), bool)
    if len(a4): cin = shapely.contains(shapely.make_valid(g[a4]), cen[osm_i[b4]])
    sea = None
    if ltree is not None:
        a5, _ = ltree.query(cen[add_i[sel]], predicate='within'); on = np.zeros(len(sel), bool); on[a5] = True; sea = int((~on).sum())
    a6, b6 = atree.query(g, predicate='intersects'); other = np.asarray(sel)[a6] != b6
    ia6 = np.zeros(len(a6))
    if other.any():
        with np.errstate(all='ignore'):
            ia6[other] = shapely.area(shapely.intersection(shapely.make_valid(g[a6[other]]), shapely.make_valid(polys[add_i[b6[other]]]))) * KX * KY
    gr = grounds[add_i[sel]]
    fail = set(over.tolist()) | set(np.unique(a2).tolist()) | set(np.unique(a4[cin]).tolist()) | set(np.unique(a6[ia6 > 0.5]).tolist())
    if sea is not None: fail |= set(np.flatnonzero(~on).tolist())
    return {
        'checked': int(len(sel)),
        'intersects_osm_over_0p5_m2': int(len(over)), 'touches_osm_at_all': int(len(touch)), 'largest_shared_area_m2': round(float(ia.max()), 2) if len(ia) else 0.0,
        'centroid_inside_osm': int(len(np.unique(a2))), 'contains_osm_centroid': int(len(np.unique(a4[cin]))),
        'centroid_not_on_land': sea, 'intersects_other_added_over_0p5_m2': int(len(np.unique(a6[ia6 > 0.5]))),
        'failures_any': int(len(fail)),
        'hint_ground_at_or_below_0m': int(((gr <= 0) & (gr != -32768)).sum()), 'hint_ground_unknown': int((gr == -32768).sum()),
    }
rng = np.random.default_rng(20261011)
sample = np.sort(rng.choice(len(add_i), size=min(2000, len(add_i)), replace=False))
res = {'method': __doc__.split('2. Picture')[0].strip(), 'seed': 20261011, 'osm_first_in_every_tile': order_ok,
       'sample_2000': check(sample), 'all_added': check(np.arange(len(add_i)))}
log('check', json.dumps({k: res[k] for k in ('osm_first_in_every_tile', 'sample_2000', 'all_added')}))

# ---- picture ----
munis = {f['properties']['GEOID']: f for f in json.load(open(f'{OUT}/data/geo/municipios.geojson'))['features']}
rank = qa['added']['by_municipio']
big = [r for r in rank if r['buildings_added'] >= 2000] or rank
top = max(big, key=lambda r: r['added_share'])
sj = next(r for r in rank if r['geoid'] == '72127')
OSM_C, ADD_C = '#59636e', '#e8590c'
fig, axes = plt.subplots(2, 2, figsize=(16, 15), dpi=150)
verts_of = lambda ids: [np.column_stack([lon[off[i]:off[i + 1]], lat[off[i]:off[i + 1]]]) for i in ids]
picture = []
for row, r in enumerate([top, sj]):
    g = shape(munis[r['geoid']]['geometry']); x0, y0, x1, y1 = g.bounds
    inb = np.flatnonzero((cx >= x0) & (cx <= x1) & (cy >= y0) & (cy <= y1))
    inm = inb[shapely.contains_xy(g, cx[inb], cy[inb])]
    mo, ma = inm[~added[inm]], inm[added[inm]]
    # close-up: the 0.015 degree window (about 1.6 km) with most additions
    W = 0.015
    if len(ma):
        H, xe, ye = np.histogram2d(cx[ma], cy[ma], bins=[max(1, int((x1 - x0) / (W / 2))), max(1, int((y1 - y0) / (W / 2)))], range=[[x0, x1], [y0, y1]])
        k = np.unravel_index(np.argmax(H), H.shape); wx, wy = (xe[k[0]] + xe[k[0] + 1]) / 2, (ye[k[1]] + ye[k[1] + 1]) / 2
    else: wx, wy = (x0 + x1) / 2, (y0 + y1) / 2
    win = (wx - W / 2, wy - W / 2, wx + W / 2, wy + W / 2)
    for col in (0, 1):
        ax = axes[row][col]
        bx = (x0, y0, x1, y1) if col == 0 else win
        so = mo[(cx[mo] >= bx[0]) & (cx[mo] <= bx[2]) & (cy[mo] >= bx[1]) & (cy[mo] <= bx[3])] if col else mo
        sa = ma[(cx[ma] >= bx[0]) & (cx[ma] <= bx[2]) & (cy[ma] >= bx[1]) & (cy[ma] <= bx[3])] if col else ma
        lw = 0.0 if col == 0 else 0.4
        ax.add_collection(PolyCollection(verts_of(so), facecolors=OSM_C, edgecolors=OSM_C, linewidths=0.25 if col == 0 else lw))
        ax.add_collection(PolyCollection(verts_of(sa), facecolors=ADD_C, edgecolors=ADD_C, linewidths=0.25 if col == 0 else lw))
        for poly in (g.geoms if g.geom_type == 'MultiPolygon' else [g]):
            ax.plot(*poly.exterior.xy, color='#111', lw=0.8)
        if col == 0: ax.plot([win[0], win[2], win[2], win[0], win[0]], [win[1], win[1], win[3], win[3], win[1]], color='#1c7ed6', lw=1.4)
        ax.set_xlim(bx[0], bx[2]); ax.set_ylim(bx[1], bx[3]); ax.set_aspect(1 / math.cos(math.radians((bx[1] + bx[3]) / 2)))
        ax.tick_params(labelsize=7); ax.set_facecolor('#f4f1ea')
        if col == 0:
            ax.set_title(f"{r['name']}: {r['buildings_osm']:,} OpenStreetMap (grey) + {r['buildings_added']:,} added, machine-detected (orange) = {100 * r['added_share']:.1f} % added", fontsize=10)
        else:
            ax.set_title(f"{r['name']}, close-up of the blue box (the 1.6 km window with most additions): {len(so):,} OSM, {len(sa):,} added", fontsize=10)
    picture.append({'geoid': r['geoid'], 'name': r['name'], 'buildings_osm': r['buildings_osm'], 'buildings_added': r['buildings_added'], 'added_share': r['added_share'], 'closeup_centre': [round(wx, 5), round(wy, 5)]})
src = idx['added_source']
fig.suptitle(f"Garita building footprints: OpenStreetMap (grey) and footprints added from Overture Maps {src['release']} (orange: "
             + ', '.join(d['dataset'] for d in src['datasets']) + f"; machine detections, not in OSM). Island: {idx['osm']:,} OSM + {idx['added']:,} added.", fontsize=11)
fig.tight_layout(rect=(0, 0, 1, 0.975))
os.makedirs(f'{OUT}/data/derived', exist_ok=True)
fig.savefig(f'{OUT}/data/derived/bld_added_qa.jpg', pil_kwargs={'quality': 82})
res['picture'] = {'file': 'data/derived/bld_added_qa.jpg', 'panels': picture}
json.dump(res, open(f'{OUT}/data/derived/bld_added_check.json', 'w'), indent=1)
qa['added']['check'] = res
json.dump(qa, open(qa_path, 'w'), indent=1)
log('picture and check written', f'{time.time() - t0:.0f}s')
