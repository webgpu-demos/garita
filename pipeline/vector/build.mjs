// Stages 2-4: OSM buildings (+ machine-detected footprints where OSM has none) + facilities -> ground elevation
// -> FEMA flood class -> building tiles, exposure, QA.
//
// Inputs (made by stage2_osm.sh and nfhl.mjs on the runner):
//   work/osm/buildings.geojsonl, work/osm/facilities.geojsonl   osmium exports of the Geofabrik Puerto Rico extract
//   work/overture/added.jsonl, work/overture/meta.json          stage2b_overture.sh: Overture Maps buildings whose
//                                                               origin is not OpenStreetMap (optional)
//   data/geo/municipios_land.geojson                            land.mjs (optional; keeps additions out of the sea)
//   work/cache/terrarium/14/{x}/{y}.png                         AWS Terrain Tiles (fetched here, cached)
//   work/cache/nfhl/features.jsonl                              FEMA NFHL layer 28 polygons (optional; NO_FLOOD=1 skips)
//   data/geo/municipios.geojson                                 stage 1
// Outputs: tiles/bld/14/{x}/{y}.bin, tiles/bld/index.json, data/osm/facilities.json, data/derived/exposure.json, qa.json
//
// BUILDING TILE FORMAT "GBL1" (little-endian). One file per zoom-14 Web Mercator tile; a building is stored in
// the tile that contains the centroid of its outer ring.
//   bytes 0-3  ASCII "GBL1"
//   uint32     count
//   per building:
//     uint16 nv        vertices of the outer ring (no repeated closing vertex; holes dropped; rings above 64
//                      vertices simplified with Douglas-Peucker until <= 64)
//     uint8  height    half-metres above ground (0 = unknown; 255 = 127.5 m or more)
//     uint8  kind      low 7 bits: 0 house/residential, 1 apartments, 2 commercial, 3 industrial, 4 civic,
//                      5 religious, 6 other. Bit 7 (0x80) set = ADDED: a footprint detected from imagery by a
//                      machine (Overture Maps: Google Open Buildings, Microsoft ML Buildings) that is not in
//                      OpenStreetMap. Readers must mask: kind & 0x7f. In a tile the OSM records come first, in
//                      the order of the extract, then the added ones.
//     int16  ground    ground elevation at the centroid, decimetres above mean sea level (-32768 = unknown)
//     uint8  flood     0 minimal/none, 1 = 0.2 % annual chance, 2 = 1 % annual chance (A zones), 3 = coastal high hazard (V zones)
//     int8   place     0 here. pipeline/hazards/merge.mjs later replaces `ground` with the lidar value and keeps,
//                      in this byte, the half metres to add to it to get the elevation of the terrain the scene
//                      is drawn on (so buildings still stand on that terrain)
//     nv x (uint16 u, uint16 v)
//   Vertex mapping. Let fx, fy be the vertex position in tile units: fx = lonToTileX(lon, 14) - x (0 at the west
//   edge, 1 at the east edge, linear in longitude), fy = latToTileY(lat, 14) - y (0 at the north edge, 1 at the
//   south edge, linear in Web Mercator y). The stored extent is the tile grown by 25 % on every side:
//     u = round((fx + 0.25) / 1.5 * 65535),  v = round((fy + 0.25) / 1.5 * 65535)   (clamped to 0..65535)
//   Decode:  fx = u / 65535 * 1.5 - 0.25,  fy = v / 65535 * 1.5 - 0.25.   One unit is about 5 cm on the ground.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { PNG } from 'pngjs';
import { lonToTileX, latToTileY, terrariumToMetres, M_PER_DEG_LAT, DEG } from '../../src/core/geo.ts';
import { OUT, WORK, CACHE, log, writeOut, fetchRetry, pool, simplifyRing, ringArea, ringCentroid, polygonsOf, flatRings, PolyIndex } from './lib.mjs';

const Z = 14, PAD = 0.25, SPAN = 1 + 2 * PAD;
const NO_FLOOD = process.env.NO_FLOOD === '1';
const SITE = process.env.SITE_DIR || 'site';
const OSM = path.join(WORK, 'osm');
const M_LAT = M_PER_DEG_LAT, mLon = (lat) => 111319.49 * Math.cos(lat * DEG);
const KINDS = ['house', 'apartments', 'commercial', 'industrial', 'civic', 'religious', 'other'];

function readFirst(...ps) { for (const p of ps) if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8'); return null; }
async function* lines(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (let l of rl) { if (l.charCodeAt(0) === 0x1e) l = l.slice(1); if (l.length > 2) yield l; }
}
function osmRef(f) {
  const p = f.properties || {};
  const t = p['@type'], id = p['@id'];
  if ((t === 'node' || t === 'way' || t === 'relation') && id !== undefined) return `${t}/${id}`;
  const s = String(f.id ?? '');
  const n = Number(s.slice(1));
  if (s[0] === 'n') return `node/${n}`;
  if (s[0] === 'w') return `way/${n}`;
  if (s[0] === 'r') return `relation/${n}`;
  if (s[0] === 'a') return n % 2 === 0 ? `way/${n / 2}` : `relation/${(n - 1) / 2}`;
  return s || null;
}
function parseHeight(t) {
  const h = t.height ?? t['building:height'];
  if (h !== undefined) {
    const m = String(h).replace(',', '.').match(/-?\d+(\.\d+)?/);
    if (m) { let v = parseFloat(m[0]); if (/ft|feet|'/.test(String(h))) v *= 0.3048; if (v > 0 && v < 400) return { h: v, real: 1 }; }
  }
  const lv = t['building:levels'];
  if (lv !== undefined) { const v = parseFloat(String(lv).replace(',', '.')); if (v > 0 && v < 100) return { h: v * 3.2 + 1, real: 2 }; }
  return { h: null, real: 0 };
}
const K_HOUSE = new Set(['house', 'residential', 'detached', 'semidetached_house', 'terrace', 'bungalow', 'cabin', 'hut', 'static_caravan', 'farm', 'houseboat']);
const K_APT = new Set(['apartments', 'dormitory']);
const K_COM = new Set(['commercial', 'retail', 'office', 'hotel', 'supermarket', 'kiosk', 'shop', 'restaurant', 'bank']);
const K_IND = new Set(['industrial', 'warehouse', 'manufacture', 'factory', 'hangar', 'storage_tank']);
const K_CIV = new Set(['school', 'hospital', 'public', 'government', 'university', 'college', 'fire_station', 'police', 'civic', 'kindergarten', 'clinic', 'townhall', 'library', 'courthouse', 'community_centre', 'prison']);
const K_REL = new Set(['church', 'chapel', 'cathedral', 'religious', 'mosque', 'temple', 'synagogue', 'monastery', 'shrine']);
const A_CIV = new Set(['school', 'hospital', 'university', 'college', 'fire_station', 'police', 'townhall', 'courthouse', 'clinic', 'library', 'community_centre', 'kindergarten', 'public_building']);
function kindOf(t, areaM2) {
  const b = String(t.building).toLowerCase();
  if (K_REL.has(b) || t.amenity === 'place_of_worship') return 5;
  if (K_CIV.has(b) || A_CIV.has(t.amenity)) return 4;
  if (K_APT.has(b)) return 1;
  if (K_HOUSE.has(b)) return 0;
  if (K_COM.has(b) || (b === 'yes' && (t.shop || t.office || t.tourism === 'hotel'))) return 2;
  if (K_IND.has(b)) return 3;
  if (b === 'yes') return areaM2 < 400 ? 0 : 6; // "yes-small": untyped footprints under 400 m2 are counted as houses
  return 6;
}

// ---- municipios ----
const muniText = readFirst(path.join(OUT, 'data/geo/municipios.geojson'), path.join(SITE, 'data/geo/municipios.geojson'));
if (!muniText) throw new Error('municipios.geojson missing (run stage 1)');
const munis = JSON.parse(muniText).features;
const muniIdx = new PolyIndex({ band: 0.002, cell: 0.05 });
const muniName = {};
for (const f of munis) { muniIdx.add(flatRings(f.geometry), f.properties.GEOID); muniName[f.properties.GEOID] = f.properties.NAME; }
log('municipios', munis.length);

// ---- buildings ----
let cap = 1 << 24, coords = new Float64Array(cap), nc = 0; // lon, lat pairs
// ref: the OSM object ("w123", "r456"; null for an addition); gers: Overture's stable feature id (GERS), for an OSM
// building the id of its Overture twin, for an addition its own; null where there is none. Written beside each tile
// (tiles/bld/14/{x}/{y}.ids), in record order: the keys other data (inspections, parcels, the street view) join on.
// hsrc: where the height comes from: 'osm' (height tag), 'levels' (building:levels x 3.2 m + 1 m), 'ovt' (the
// detection's own source, via Overture), 'usas' (FEMA USA Structures, stage 2c), '' (none: the client estimates one).
const B = { start: [], nv: [], cx: [], cy: [], h: [], kind: [], elev: [], flood: [], muni: [], added: [], ref: [], gers: [], hsrc: [] };
const shortRef = (r) => { const m = /^(way|relation)\/(\d+)$/.exec(r || ''); return m ? (m[1] === 'way' ? 'w' : 'r') + m[2] : null; };
const stats = { features: 0, kept: 0, degenerate: 0, multi: 0, simplified: 0, height_tag: 0, height_levels: 0, height_none: 0, vertices: 0, by_building_tag: {} };
for await (const l of lines(path.join(OSM, 'buildings.geojsonl'))) {
  let f; try { f = JSON.parse(l); } catch { continue; }
  stats.features++;
  const t = f.properties || {};
  if (t.building === undefined || t.building === 'no') continue;
  const polys = polygonsOf(f.geometry);
  if (!polys.length) continue;
  let ring = null, best = 0;
  for (const p of polys) { const a = Math.abs(ringArea(p[0])); if (a > best) { best = a; ring = p[0]; } }
  if (polys.length > 1) stats.multi++;
  if (!ring || ring.length < 4) { stats.degenerate++; continue; }
  const [cx, cy] = ringCentroid(ring);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) { stats.degenerate++; continue; }
  const areaM2 = best * M_LAT * mLon(cy);
  if (areaM2 < 2) { stats.degenerate++; continue; }
  if (ring.length - 1 > 64) {
    stats.simplified++;
    for (let tol = 2e-6; ring.length - 1 > 64 && tol < 1e-3; tol *= 1.6) { const s = simplifyRing(ring, tol); if (!s) break; ring = s; }
    if (ring.length - 1 > 64) { stats.degenerate++; continue; }
  }
  const n = ring.length - 1;
  if (nc + n * 2 > cap) { cap *= 2; const c2 = new Float64Array(cap); c2.set(coords.subarray(0, nc)); coords = c2; }
  B.start.push(nc / 2); B.nv.push(n);
  for (let i = 0; i < n; i++) { coords[nc++] = ring[i][0]; coords[nc++] = ring[i][1]; }
  const { h, real } = parseHeight(t);
  if (real === 1) stats.height_tag++; else if (real === 2) stats.height_levels++; else stats.height_none++;
  B.cx.push(cx); B.cy.push(cy);
  B.h.push(h === null ? 0 : Math.max(1, Math.min(255, Math.round(h * 2))));
  B.kind.push(kindOf(t, areaM2));
  B.elev.push(NaN); B.flood.push(0); B.muni.push(null); B.added.push(0);
  B.ref.push(shortRef(osmRef(f))); B.gers.push(null); B.hsrc.push(real === 1 ? 'osm' : real === 2 ? 'levels' : '');
  stats.vertices += n; stats.kept++;
  const bt = String(t.building); stats.by_building_tag[bt] = (stats.by_building_tag[bt] || 0) + 1;
}
const NB_OSM = B.cx.length;
log('buildings', JSON.stringify({ ...stats, by_building_tag: undefined }));
// ---- GERS ids of our OSM buildings, from their Overture twins (stage 2b: work/overture/osm_gers.csv) ----
const idStats = { osm: NB_OSM, osm_with_ref: 0, osm_with_gers: 0, mapping_rows: 0, added_with_gers: 0 };
{
  const f = path.join(WORK, 'overture', 'osm_gers.csv');
  if (fs.existsSync(f)) {
    const byRef = new Map();
    for await (const l of lines(f)) { const c = l.indexOf(','); if (c > 0) { byRef.set(l.slice(0, c), l.slice(c + 1).trim()); idStats.mapping_rows++; } }
    for (let i = 0; i < NB_OSM; i++) { if (B.ref[i]) { idStats.osm_with_ref++; const g = byRef.get(B.ref[i]); if (g) { B.gers[i] = g; idStats.osm_with_gers++; } } }
  } else for (let i = 0; i < NB_OSM; i++) if (B.ref[i]) idStats.osm_with_ref++;
  log('ids', JSON.stringify(idStats));
}

// ---- additions: machine-detected footprints (Overture Maps) where our OSM extract has no building ----
// OpenStreetMap is the base and is never changed. A candidate (an Overture building with no OpenStreetMap source)
// is added only if it passes, in this order:
//  1. OVERLAP with our own OSM extract (Overture conflated against an older OSM snapshot). Dropped if its centroid
//     is inside the outer ring of an OSM building, or an OSM building's centroid is inside it, or the two outlines
//     intersect at all (an edge of one crosses an edge of the other, or a vertex of one is inside the other).
//     Any geometric overlap, however small, drops the candidate: in doubt, OpenStreetMap wins. Outer rings only,
//     so a detection inside the courtyard of an OSM building is dropped too. The same test runs against the
//     additions already accepted, so two detections of one roof cannot both get in.
//     Candidates arrive in order of preference (Microsoft first, then Google by falling confidence).
//  2. PLAUSIBILITY. Dropped if tiny (under ADD.min_area_m2 = 25 m2: smaller than 95 % of the buildings mapped
//     in OpenStreetMap here; what the detectors find below that is mostly sheds, carports, tanks and vehicles
//     beside houses that are already mapped), if the source gives a confidence below ADD.min_confidence (Google
//     Open Buildings publishes 0.65 to 1; its lowest band, 0.65 to 0.70, is left out; Microsoft ML Buildings
//     mostly carries none and is kept), if larger than ADD.large_area_m2 without a confidence of at least
//     ADD.large_min_confidence, or if narrow: the short side of its smallest enclosing rectangle is under
//     ADD.min_width_m (shipping containers, trailers, lorries and buses are 2.4 to 2.6 m wide and the detectors
//     outline them one by one: the container yards of the port of San Juan were the densest "additions" of the
//     capital before this test). qa.json added.sensitivity says what other thresholds would have let in.
//  3. LAND. Dropped if its centroid is not inside a land-clipped municipio (in the sea, or outside Puerto Rico).
//  4. ATTACHED. Dropped if it is small (under ADD.near_max_area_m2) and its outline comes within ADD.near_m metres
//     of an OSM footprint: that is inside the misregistration between the imagery the detectors saw and the
//     imagery OSM was traced from, so it is as likely the edge, the annex or the carport of the mapped building
//     as a building of its own. In doubt, dropped. ADD_NEAR_M=0 switches the rule off.
// Kind follows the building=yes rule (house under 400 m2, otherwise other) with bit 7 set in the tile; height only
// if the source carries one (none does in Puerto Rico as of release 2026-09-23.1), otherwise 0 = unknown.
const ADD = { min_area_m2: Number(process.env.ADD_MIN_AREA || 25), min_confidence: Number(process.env.ADD_MIN_CONF || 0.7), large_area_m2: Number(process.env.ADD_LARGE_AREA || 5000), large_min_confidence: 0.8,
  min_width_m: Number(process.env.ADD_MIN_WIDTH ?? 4), near_m: Number(process.env.ADD_NEAR_M ?? 1.5), near_max_area_m2: Number(process.env.ADD_NEAR_MAX_AREA || 60) };
const addStats = { candidates: 0, candidates_by_dataset: {}, degenerate: 0,
  dropped_overlap: { centroid_inside_osm: 0, osm_centroid_inside: 0, outlines_intersect_osm: 0, overlaps_accepted_addition: 0 },
  dropped_implausible: { tiny: 0, low_confidence: 0, large_without_confidence: 0, narrow: 0 }, dropped_not_on_land: 0, dropped_attached_to_osm: 0, distance_to_osm_hist: {}, width_hist: {},
  added: 0, added_by_dataset: {}, added_with_height: 0, added_confidence_hist: {}, dropped_low_confidence_by_dataset: {}, land_test: false,
  not_overlapping_area_hist: {}, sensitivity: {} };
const AREA_BINS = [15, 20, 25, 30, 40, 60, 100, 200, 400, 1000, 5000];
const areaBin = (a) => { for (const b of AREA_BINS) if (a < b) return '<' + b; return '>=5000'; };
const ovtDir = path.join(WORK, 'overture');
const ovtMeta = fs.existsSync(path.join(ovtDir, 'meta.json')) ? JSON.parse(fs.readFileSync(path.join(ovtDir, 'meta.json'), 'utf8')) : null;
const DS = []; // dataset names, index kept per added building
B.ds = [];
if (ovtMeta && fs.existsSync(path.join(ovtDir, 'added.jsonl')) && process.env.NO_ADDED !== '1') {
  const landText = readFirst(path.join(OUT, 'data/geo/municipios_land.geojson'), path.join(SITE, 'data/geo/municipios_land.geojson'));
  let landIdx = null;
  if (landText) { landIdx = new PolyIndex({ band: 0.0005, cell: 0.02 }); for (const f of JSON.parse(landText).features) landIdx.add(flatRings(f.geometry), 1); addStats.land_test = true; }
  // grid of building bounding boxes (0.0005 deg, about 55 m): OSM first, accepted additions as they come
  const C = 0.0005, grid = new Map(), bb = { x0: [], y0: [], x1: [], y1: [] };
  const gkey = (gx, gy) => gx * 1048576 + gy;
  const insert = (i) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0, s = B.start[i] * 2; k < B.nv[i]; k++, s += 2) { const x = coords[s], y = coords[s + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    bb.x0[i] = x0; bb.y0[i] = y0; bb.x1[i] = x1; bb.y1[i] = y1;
    for (let gx = Math.floor((x0 + 180) / C); gx <= Math.floor((x1 + 180) / C); gx++) for (let gy = Math.floor((y0 + 90) / C); gy <= Math.floor((y1 + 90) / C); gy++) {
      const k = gkey(gx, gy); const a = grid.get(k); if (a) a.push(i); else grid.set(k, [i]);
    }
  };
  for (let i = 0; i < NB_OSM; i++) insert(i);
  log('overlap grid', grid.size, 'cells for', NB_OSM, 'OSM buildings');
  const inStored = (i, x, y) => { // even-odd, stored outer ring of building i
    let c = false; const s = B.start[i] * 2, n = B.nv[i];
    for (let k = 0, j = n - 1; k < n; j = k++) { const xk = coords[s + 2 * k], yk = coords[s + 2 * k + 1], xj = coords[s + 2 * j], yj = coords[s + 2 * j + 1]; if ((yk > y) !== (yj > y) && x < (xj - xk) * (y - yk) / (yj - yk) + xk) c = !c; }
    return c;
  };
  const inRing = (r, n, x, y) => { let c = false; for (let k = 0, j = n - 1; k < n; j = k++) { const xk = r[k][0], yk = r[k][1], xj = r[j][0], yj = r[j][1]; if ((yk > y) !== (yj > y) && x < (xj - xk) * (y - yk) / (yj - yk) + xk) c = !c; } return c; };
  const orient = (ax, ay, bx, by, px, py) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const cross = (ax, ay, bx, by, px, py, qx, qy) => { const d1 = orient(px, py, qx, qy, ax, ay), d2 = orient(px, py, qx, qy, bx, by), d3 = orient(ax, ay, bx, by, px, py), d4 = orient(ax, ay, bx, by, qx, qy); return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)); };
  /** Why candidate ring r (n vertices, centroid cx, cy, bbox) overlaps a stored building, or null. */
  const overlap = (r, n, cx, cy, x0, y0, x1, y1) => {
    const seen = new Set(); let why = null;
    for (let gx = Math.floor((x0 + 180) / C); gx <= Math.floor((x1 + 180) / C); gx++) for (let gy = Math.floor((y0 + 90) / C); gy <= Math.floor((y1 + 90) / C); gy++) {
      const a = grid.get(gkey(gx, gy)); if (!a) continue;
      for (const i of a) {
        if (seen.has(i)) continue; seen.add(i);
        if (bb.x0[i] > x1 || bb.x1[i] < x0 || bb.y0[i] > y1 || bb.y1[i] < y0) continue;
        const osm = i < NB_OSM;
        if (inStored(i, cx, cy)) return osm ? 'centroid_inside_osm' : 'overlaps_accepted_addition';
        if (inRing(r, n, B.cx[i], B.cy[i])) { if (osm) return 'osm_centroid_inside'; why = 'overlaps_accepted_addition'; continue; }
        let hit = false; const s = B.start[i] * 2, m = B.nv[i];
        for (let k = 0; k < n && !hit; k++) if (inStored(i, r[k][0], r[k][1])) hit = true;
        for (let k = 0; k < m && !hit; k++) if (inRing(r, n, coords[s + 2 * k], coords[s + 2 * k + 1])) hit = true;
        for (let k = 0, j = n - 1; k < n && !hit; j = k++) for (let p = 0, q = m - 1; p < m; q = p++) if (cross(r[j][0], r[j][1], r[k][0], r[k][1], coords[s + 2 * q], coords[s + 2 * q + 1], coords[s + 2 * p], coords[s + 2 * p + 1])) { hit = true; break; }
        if (hit) { if (osm) why = why === 'overlaps_accepted_addition' || !why ? 'outlines_intersect_osm' : why; else if (!why) why = 'overlaps_accepted_addition'; }
      }
    }
    return why;
  };
  /** Distance in metres from candidate ring r to the nearest OSM outline, looking no further than `lim` (returns lim if none). */
  const distOsm = (r, n, x0, y0, x1, y1, lat, lim) => {
    const kx = mLon(lat), ky = M_LAT, px = lim / kx, py = lim / ky; let best = lim * lim; const seen = new Set();
    const ps = (ax, ay, bx, by, qx, qy) => { // squared distance point q to segment a-b, metres
      const dx = (bx - ax) * kx, dy = (by - ay) * ky, ex = (qx - ax) * kx, ey = (qy - ay) * ky, l2 = dx * dx + dy * dy;
      let t = l2 ? (ex * dx + ey * dy) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t; const fx = ex - t * dx, fy = ey - t * dy; return fx * fx + fy * fy;
    };
    for (let gx = Math.floor((x0 - px + 180) / C); gx <= Math.floor((x1 + px + 180) / C); gx++) for (let gy = Math.floor((y0 - py + 90) / C); gy <= Math.floor((y1 + py + 90) / C); gy++) {
      const a = grid.get(gkey(gx, gy)); if (!a) continue;
      for (const i of a) {
        if (i >= NB_OSM || seen.has(i)) continue; seen.add(i);
        if (bb.x0[i] > x1 + px || bb.x1[i] < x0 - px || bb.y0[i] > y1 + py || bb.y1[i] < y0 - py) continue;
        const s = B.start[i] * 2, m = B.nv[i];
        for (let k = 0, j = n - 1; k < n; j = k++) for (let p = 0, q = m - 1; p < m; q = p++) {
          const d = Math.min(ps(r[j][0], r[j][1], r[k][0], r[k][1], coords[s + 2 * p], coords[s + 2 * p + 1]), ps(coords[s + 2 * q], coords[s + 2 * q + 1], coords[s + 2 * p], coords[s + 2 * p + 1], r[k][0], r[k][1]));
          if (d < best) best = d;
        }
      }
    }
    return Math.sqrt(best);
  };
  /** Short side, in metres, of the smallest rectangle enclosing ring r (one side along an edge of the ring). */
  const minWidth = (r, n, lat) => {
    const kx = mLon(lat), ky = M_LAT; let bestA = Infinity, w = 0;
    for (let k = 0, j = n - 1; k < n; j = k++) {
      let ux = (r[k][0] - r[j][0]) * kx, uy = (r[k][1] - r[j][1]) * ky; const l = Math.hypot(ux, uy); if (l < 0.3) continue; ux /= l; uy /= l;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (let q = 0; q < n; q++) { const x = r[q][0] * kx, y = r[q][1] * ky, a = x * ux + y * uy, b = -x * uy + y * ux; if (a < a0) a0 = a; if (a > a1) a1 = a; if (b < b0) b0 = b; if (b > b1) b1 = b; }
      const A = (a1 - a0) * (b1 - b0); if (A < bestA) { bestA = A; w = Math.min(a1 - a0, b1 - b0); }
    }
    return w;
  };
  const WIDTH_BINS = [2, 3, 3.5, 4, 5, 6, 8], widthBin = (d) => { for (const b of WIDTH_BINS) if (d < b) return '<' + b; return '>=8'; };
  const DIST_BINS = [0.5, 1, 1.5, 2, 3, 5], distBin = (d) => { for (const b of DIST_BINS) if (d < b) return '<' + b; return '>=5'; };
  const t0 = Date.now();
  for await (const l of lines(path.join(ovtDir, 'added.jsonl'))) {
    let f; try { f = JSON.parse(l); } catch { continue; }
    addStats.candidates++; addStats.candidates_by_dataset[f.ds] = (addStats.candidates_by_dataset[f.ds] || 0) + 1;
    const polys = polygonsOf(typeof f.g === 'string' ? JSON.parse(f.g) : f.g);
    let ring = null, best = 0;
    for (const p of polys) { const a = Math.abs(ringArea(p[0])); if (a > best) { best = a; ring = p[0]; } }
    if (!ring || ring.length < 4) { addStats.degenerate++; continue; }
    const [cx, cy] = ringCentroid(ring);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) { addStats.degenerate++; continue; }
    const areaM2 = best * M_LAT * mLon(cy);
    if (areaM2 < 2) { addStats.degenerate++; continue; }
    if (ring.length - 1 > 64) {
      for (let tol = 2e-6; ring.length - 1 > 64 && tol < 1e-3; tol *= 1.6) { const s = simplifyRing(ring, tol); if (!s) break; ring = s; }
      if (ring.length - 1 > 64) { addStats.degenerate++; continue; }
    }
    const n = ring.length - 1;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < n; k++) { const x = ring[k][0], y = ring[k][1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const why = overlap(ring, n, cx, cy, x0, y0, x1, y1);
    if (why) { addStats.dropped_overlap[why]++; continue; }
    const conf = typeof f.conf === 'number' ? f.conf : null;
    { // what other thresholds would let in (candidates clear of OSM and of the additions accepted in this run)
      const h = addStats.not_overlapping_area_hist[f.ds] || (addStats.not_overlapping_area_hist[f.ds] = {}); const ab = areaBin(areaM2); h[ab] = (h[ab] || 0) + 1;
      for (const a of [15, 20, 25, 30, 40]) for (const c of [0.65, 0.7, 0.75, 0.8]) if (areaM2 >= a && (conf === null || conf >= c)) { const k = `area>=${a},conf>=${c}`; addStats.sensitivity[k] = (addStats.sensitivity[k] || 0) + 1; }
    }
    if (areaM2 < ADD.min_area_m2) { addStats.dropped_implausible.tiny++; continue; }
    if (conf !== null && conf < ADD.min_confidence) { addStats.dropped_implausible.low_confidence++; addStats.dropped_low_confidence_by_dataset[f.ds] = (addStats.dropped_low_confidence_by_dataset[f.ds] || 0) + 1; continue; }
    if (areaM2 > ADD.large_area_m2 && !(conf !== null && conf >= ADD.large_min_confidence)) { addStats.dropped_implausible.large_without_confidence++; continue; }
    { const w = minWidth(ring, n, cy), wb = widthBin(w); addStats.width_hist[wb] = (addStats.width_hist[wb] || 0) + 1;
      if (ADD.min_width_m > 0 && w < ADD.min_width_m) { addStats.dropped_implausible.narrow++; continue; } }
    if (landIdx && landIdx.first(cx, cy) === null) { addStats.dropped_not_on_land++; continue; }
    { // how close to a mapped building (for every candidate that got this far), then the ATTACHED rule
      const d = distOsm(ring, n, x0, y0, x1, y1, cy, 5);
      const ac = areaM2 < 40 ? 'area<40' : areaM2 < 60 ? 'area<60' : areaM2 < 100 ? 'area<100' : 'area>=100';
      const h = addStats.distance_to_osm_hist[ac] || (addStats.distance_to_osm_hist[ac] = {}); const db = distBin(d); h[db] = (h[db] || 0) + 1;
      if (ADD.near_m > 0 && areaM2 < ADD.near_max_area_m2 && d < ADD.near_m) { addStats.dropped_attached_to_osm++; continue; }
    }
    if (nc + n * 2 > cap) { cap *= 2; const c2 = new Float64Array(cap); c2.set(coords.subarray(0, nc)); coords = c2; }
    const i = B.cx.length;
    B.start.push(nc / 2); B.nv.push(n);
    for (let k = 0; k < n; k++) { coords[nc++] = ring[k][0]; coords[nc++] = ring[k][1]; }
    const h = typeof f.h === 'number' && f.h > 0 && f.h < 400 ? f.h : null; // the source's own height only; no height from floors
    if (h !== null) addStats.added_with_height++;
    B.cx.push(cx); B.cy.push(cy);
    B.h.push(h === null ? 0 : Math.max(1, Math.min(255, Math.round(h * 2))));
    B.kind.push(areaM2 < 400 ? 0 : 6); // the building=yes rule
    B.elev.push(NaN); B.flood.push(0); B.muni.push(null); B.added.push(1);
    B.ref.push(null); B.gers.push(typeof f.id === 'string' && f.id ? f.id : null); if (B.gers[i]) idStats.added_with_gers++;
    B.hsrc.push(h !== null ? 'ovt' : '');
    let d = DS.indexOf(f.ds); if (d < 0) d = DS.push(f.ds) - 1; B.ds[i] = d;
    insert(i);
    stats.vertices += n; addStats.added++; addStats.added_by_dataset[f.ds] = (addStats.added_by_dataset[f.ds] || 0) + 1;
    const cb = conf === null ? 'none' : (Math.floor(conf * 20) / 20).toFixed(2); addStats.added_confidence_hist[cb] = (addStats.added_confidence_hist[cb] || 0) + 1;
  }
  log('additions', JSON.stringify(addStats), ((Date.now() - t0) / 1000).toFixed(1) + 's');
} else log('additions: no Overture candidates (stage 2b not run, or NO_ADDED=1): OSM only');
const NB = B.cx.length, NB_ADDED = NB - NB_OSM;

// ---- heights from FEMA USA Structures (stage 2c) for the buildings that have none of their own ----
// A building with no height takes the HEIGHT of the USA Structures footprint its centroid stands in (only footprints
// with a height are read). OSM's own height and floors, and a detection source's height, are never replaced.
const heightStats = { source: null, footprints: 0, filled_osm: 0, filled_added: 0, before: 0, after: 0 };
for (let i = 0; i < NB; i++) if (B.h[i]) heightStats.before++;
{
  const dir = path.join(WORK, 'structures'), f = path.join(dir, 'heights.jsonl');
  if (fs.existsSync(f) && process.env.NO_STRUCTURES !== '1') {
    heightStats.source = fs.existsSync(path.join(dir, 'meta.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) : null;
    if (heightStats.source) delete heightStats.source.by_occupancy;
    const idx = new PolyIndex();
    for await (const l of lines(f)) {
      let r; try { r = JSON.parse(l); } catch { continue; }
      const polys = polygonsOf(typeof r.g === 'string' ? JSON.parse(r.g) : r.g);
      for (const p of polys) idx.add([p[0]], r.h);
      heightStats.footprints++;
    }
    for (let i = 0; i < NB; i++) {
      if (B.h[i]) continue;
      const h = idx.first(B.cx[i], B.cy[i]);
      if (!(h > 0)) continue;
      B.h[i] = Math.max(1, Math.min(255, Math.round(h * 2))); B.hsrc[i] = 'usas';
      if (i < NB_OSM) heightStats.filled_osm++; else heightStats.filled_added++;
    }
  }
  for (let i = 0; i < NB; i++) if (B.h[i]) heightStats.after++;
  log('heights', JSON.stringify(heightStats));
}

// ---- facilities ----
const KEEP_TAGS = ['operator', 'operator:type', 'beds', 'emergency', 'healthcare', 'healthcare:speciality', 'isced:level', 'plant:source', 'plant:output:electricity', 'plant:method', 'generator:source', 'voltage', 'substation', 'iata', 'icao', 'faa', 'aerodrome:type', 'phone', 'website', 'wikidata', 'capacity', 'ref', 'alt_name', 'name:en', 'name:es', 'short_name', 'ferry', 'military'];
function facilityType(t) {
  const name = t.name || t['name:es'] || t['name:en'] || t.official_name || null;
  const a = t.amenity;
  if (a === 'hospital') return name ? ['hospital', name] : null;
  if (a === 'clinic' || a === 'doctors') return name ? ['clinic', name] : null;
  if (a === 'school' || a === 'college' || a === 'university') return name ? ['school', name] : null;
  if (a === 'fire_station') return name ? ['fire_station', name] : null;
  if (a === 'police') return name ? ['police_station', name] : null;
  if (t.power === 'plant') return name || t['plant:source'] || t['plant:output:electricity'] || t.operator ? ['power_plant', name] : null;
  if (t.power === 'substation') return name || t.voltage ? ['substation', name] : null;
  if (t.man_made === 'water_works' || t.man_made === 'wastewater_plant') return name || t.operator ? ['water_plant', name] : null;
  if (t.aeroway === 'aerodrome') return name ? ['airport', name] : null;
  if (a === 'ferry_terminal' || t.harbour === 'yes' || t.landuse === 'port' || t.industrial === 'port') return name ? ['seaport', name] : null;
  return null;
}
const facByRef = new Map(); let facOutside = 0;
const PR_BOX = { west: -68.0, east: -65.15, south: 17.6, north: 18.6 };
const GRANK = { Point: 0, LineString: 1, MultiLineString: 1, Polygon: 2, MultiPolygon: 2 };
if (fs.existsSync(path.join(OSM, 'facilities.geojsonl'))) for await (const l of lines(path.join(OSM, 'facilities.geojsonl'))) {
  let f; try { f = JSON.parse(l); } catch { continue; }
  const t = f.properties || {}, g = f.geometry;
  if (!g) continue;
  const ft = facilityType(t); if (!ft) continue;
  const ref = osmRef(f); if (!ref) continue;
  const rank = GRANK[g.type] ?? -1; if (rank < 0) continue;
  const prev = facByRef.get(ref); if (prev && prev.rank >= rank) continue;
  let lon, lat;
  if (g.type === 'Point') [lon, lat] = g.coordinates;
  else if (rank === 2) { let ring = null, best = -1; for (const p of polygonsOf(g)) { const a = Math.abs(ringArea(p[0])); if (a > best) { best = a; ring = p[0]; } } [lon, lat] = ringCentroid(ring); }
  else { const pts = g.type === 'LineString' ? g.coordinates : g.coordinates.flat(); let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (const p of pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); } lon = (x0 + x1) / 2; lat = (y0 + y1) / 2; }
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
  // The extract carries a few objects far outside Puerto Rico (members of ferry routes to Santo Domingo, for example).
  if (lon < PR_BOX.west || lon > PR_BOX.east || lat < PR_BOX.south || lat > PR_BOX.north) { facOutside++; continue; }
  const tags = {};
  for (const k of KEEP_TAGS) if (t[k] !== undefined) tags[k] = t[k];
  for (const k of Object.keys(t)) if (k.startsWith('addr:')) tags[k] = t[k];
  for (const k of ['amenity', 'power', 'man_made', 'aeroway', 'landuse', 'industrial', 'harbour']) if (t[k] !== undefined) tags[k] = t[k];
  facByRef.set(ref, { rank, rec: { type: ft[0], osm: ref, name: ft[1], lon: +lon.toFixed(6), lat: +lat.toFixed(6), tags, municipio: null, elev_m: null, flood_zone: null, flood_class: null, flood_subtype: null, sfha: null, coast_dist_m: null } });
}
const facilities = [...facByRef.values()].map((v) => v.rec).sort((a, b) => (a.type + a.osm < b.type + b.osm ? -1 : 1));
const facCounts = {}; for (const f of facilities) facCounts[f.type] = (facCounts[f.type] || 0) + 1;
log('facilities', facilities.length, JSON.stringify(facCounts));

// ---- group by zoom-14 tile ----
const tiles = new Map(); // key -> { x, y, b: [building indices], f: [facility indices] }
const tileOf = (lon, lat) => { const x = Math.floor(lonToTileX(lon, Z)), y = Math.floor(latToTileY(lat, Z)); const k = x * 65536 + y; let t = tiles.get(k); if (!t) tiles.set(k, t = { x, y, b: [], f: [] }); return t; };
for (let i = 0; i < NB; i++) tileOf(B.cx[i], B.cy[i]).b.push(i);
facilities.forEach((f, i) => tileOf(f.lon, f.lat).f.push(i));
const tileList = [...tiles.values()];
log('zoom-14 tiles with buildings or facilities', tileList.length);

// ---- stage 3: ground elevation (Terrarium z14, bilinear at the centroid) ----
const elevStats = { tiles: tileList.length, fetched: 0, cached: 0, failed: 0 };
async function terrarium(x, y) {
  const p = path.join(CACHE, 'terrarium', String(Z), String(x), `${y}.png`);
  let buf = null;
  if (fs.existsSync(p) && fs.statSync(p).size > 0) { buf = fs.readFileSync(p); elevStats.cached++; }
  else {
    try {
      const res = await fetchRetry(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${x}/${y}.png`, {}, { timeout: 60000, tries: Number(process.env.TERRARIUM_TRIES || 4) });
      buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); elevStats.fetched++;
    } catch (e) { elevStats.failed++; if (elevStats.failed <= 5) log('terrarium failed', x, y, String(e.message || e).slice(0, 120)); return null; }
  }
  try { return PNG.sync.read(buf); } catch (e) { elevStats.failed++; return null; }
}
function sample(png, fx, fy) {
  const W = png.width, H = png.height, d = png.data;
  let px = fx * W - 0.5, py = fy * H - 0.5;
  px = Math.max(0, Math.min(W - 1, px)); py = Math.max(0, Math.min(H - 1, py));
  const x0 = Math.floor(px), y0 = Math.floor(py), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1), tx = px - x0, ty = py - y0;
  const at = (x, y) => { const o = (y * W + x) * 4; return terrariumToMetres(d[o], d[o + 1], d[o + 2]); };
  return (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
}
let doneTiles = 0;
await pool(tileList, 6, async (t) => {
  const png = await terrarium(t.x, t.y);
  if (++doneTiles % 400 === 0) log('elevation tiles', doneTiles, '/', tileList.length);
  if (!png) return;
  for (const i of t.b) B.elev[i] = sample(png, lonToTileX(B.cx[i], Z) - t.x, latToTileY(B.cy[i], Z) - t.y);
  for (const i of t.f) { const f = facilities[i]; f.elev_m = +sample(png, lonToTileX(f.lon, Z) - t.x, latToTileY(f.lat, Z) - t.y).toFixed(2); }
});
log('elevation', JSON.stringify(elevStats));

// ---- stage 4: FEMA flood class ----
// class: 3 = coastal high hazard (V, VE); 2 = 1 % annual chance (A, AE, AH, AO, A99, AR); 1 = 0.2 % annual chance
// (X with subtype containing "0.2 PCT"); 0 = everything else.
export function floodClass(zone, sub) {
  const z = String(zone || '').toUpperCase().trim();
  if (z === 'VE' || z === 'V' || /^V\d/.test(z)) return 3;
  if (z === 'A' || z === 'AE' || z === 'AH' || z === 'AO' || z === 'A99' || z === 'AR' || /^AR\//.test(z) || /^A\d/.test(z)) return 2;
  if (z === 'X' && /0\.2 ?PCT/i.test(String(sub || ''))) return 1;
  return 0;
}
const nfhlFile = path.join(CACHE, 'nfhl', 'features.jsonl');
const nfhlDone = path.join(CACHE, 'nfhl', 'complete.json');
let floodAttached = false; const nfhlStats = { polygons: 0, by_class: { 0: 0, 1: 0, 2: 0, 3: 0 }, by_zone: {} };
if (!NO_FLOOD && fs.existsSync(nfhlFile) && fs.existsSync(nfhlDone)) {
  const hazIdx = new PolyIndex({ band: 0.0005, cell: 0.02 }), restIdx = new PolyIndex({ band: 0.0005, cell: 0.02 });
  for await (const l of lines(nfhlFile)) {
    const f = JSON.parse(l), p = f.properties || {};
    const c = floodClass(p.FLD_ZONE, p.ZONE_SUBTY);
    nfhlStats.polygons++; nfhlStats.by_class[c]++;
    const zk = `${p.FLD_ZONE}${p.ZONE_SUBTY ? ' | ' + p.ZONE_SUBTY : ''}`; nfhlStats.by_zone[zk] = (nfhlStats.by_zone[zk] || 0) + 1;
    const rings = flatRings(f.geometry); if (!rings.length) continue;
    (c > 0 ? hazIdx : restIdx).add(rings, { c, zone: p.FLD_ZONE, sub: p.ZONE_SUBTY || null, sfha: p.SFHA_TF, bfe: p.STATIC_BFE });
  }
  log('NFHL polygons', JSON.stringify(nfhlStats.by_class));
  const t0 = Date.now();
  for (let i = 0; i < NB; i++) { let c = 0; hazIdx.query(B.cx[i], B.cy[i], (v) => { if (v.c > c) c = v.c; }); B.flood[i] = c; }
  log('flood class for', NB, 'buildings in', ((Date.now() - t0) / 1000).toFixed(1), 's');
  for (const f of facilities) {
    let best = null; hazIdx.query(f.lon, f.lat, (v) => { if (!best || v.c > best.c) best = v; });
    if (!best) restIdx.query(f.lon, f.lat, (v) => { if (!best) best = v; });
    // flood_zone is FEMA's FLD_ZONE string (ontology property flood_zone); "none" where no NFHL polygon covers the point.
    f.flood_zone = best ? best.zone : 'none'; f.flood_class = best ? best.c : 0; f.flood_subtype = best ? best.sub : null; f.sfha = best ? best.sfha === 'T' : false;
  }
  floodAttached = true;
}

// ---- distance to the coast for facilities (OSM coastline) ----
try {
  const cf = path.join(OSM, 'coast.geojsonl');
  if (fs.existsSync(cf) && facilities.length) {
    const seg = []; // x1, y1, x2, y2 in metres (local equirectangular about 18.22 N)
    const KX = mLon(18.22), KY = M_LAT;
    for await (const l of lines(cf)) { const g = JSON.parse(l).geometry; if (!g) continue; for (const ls of g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []) for (let i = 1; i < ls.length; i++) seg.push(ls[i - 1][0] * KX, ls[i - 1][1] * KY, ls[i][0] * KX, ls[i][1] * KY); }
    const S = Float64Array.from(seg), ns = S.length / 4;
    for (const f of facilities) {
      const px = f.lon * KX, py = f.lat * KY; let best = Infinity;
      for (let k = 0; k < ns; k++) { const o = k * 4, ax = S[o], ay = S[o + 1], dx = S[o + 2] - ax, dy = S[o + 3] - ay, l2 = dx * dx + dy * dy; let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t; const ex = px - ax - t * dx, ey = py - ay - t * dy, d = ex * ex + ey * ey; if (d < best) best = d; }
      f.coast_dist_m = Number.isFinite(best) ? Math.round(Math.sqrt(best)) : null;
    }
    log('coast distance for', facilities.length, 'facilities against', ns, 'coastline segments');
  }
} catch (e) { log('coast distance skipped:', String(e.message || e).slice(0, 160)); }

// ---- municipio of every building and facility ----
for (let i = 0; i < NB; i++) B.muni[i] = muniIdx.first(B.cx[i], B.cy[i]);
for (const f of facilities) f.municipio = muniIdx.first(f.lon, f.lat);

// ---- building tiles ----
const q = (v) => Math.max(0, Math.min(65535, Math.round((v + PAD) / SPAN * 65535)));
const index = []; let bytes = 0, clampedVerts = 0;
for (const t of tileList) {
  if (!t.b.length) continue;
  let size = 8; for (const i of t.b) size += 8 + B.nv[i] * 4;
  const buf = Buffer.alloc(size); buf.write('GBL1', 0, 'ascii'); buf.writeUInt32LE(t.b.length, 4);
  let o = 8;
  for (const i of t.b) {
    const nv = B.nv[i], e = B.elev[i];
    buf.writeUInt16LE(nv, o); buf.writeUInt8(B.h[i], o + 2); buf.writeUInt8(B.kind[i] | (B.added[i] ? 0x80 : 0), o + 3);
    buf.writeInt16LE(Number.isFinite(e) ? Math.max(-32767, Math.min(32767, Math.round(e * 10))) : -32768, o + 4);
    buf.writeUInt8(B.flood[i], o + 6); buf.writeUInt8(0, o + 7); o += 8;
    for (let k = 0, s = B.start[i] * 2; k < nv; k++, s += 2) {
      const fx = lonToTileX(coords[s], Z) - t.x, fy = latToTileY(coords[s + 1], Z) - t.y;
      if (fx < -PAD || fx > 1 + PAD || fy < -PAD || fy > 1 + PAD) clampedVerts++;
      buf.writeUInt16LE(q(fx), o); buf.writeUInt16LE(q(fy), o + 2); o += 4;
    }
  }
  writeOut(`tiles/bld/${Z}/${t.x}/${t.y}.bin`, buf);
  writeOut(`tiles/bld/${Z}/${t.x}/${t.y}.ids`, t.b.map((i) => `${B.gers[i] ?? ''},${B.ref[i] ?? ''},${B.hsrc[i]}`).join('\n') + '\n');
  index.push([t.x, t.y, t.b.length]); bytes += size;
}
index.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const generated = new Date().toISOString();
const pbfHead = readFirst(path.join(CACHE, 'pbf_head.txt')) || '';
const osmSource = { name: 'OpenStreetMap contributors (ODbL 1.0)', extract: 'https://download.geofabrik.de/north-america/us/puerto-rico-latest.osm.pbf', extract_headers: pbfHead.trim().split('\n').filter(Boolean), extract_timestamp: (readFirst(path.join(OSM, 'pbf_timestamp.txt')) || '').trim() || null };
// The second source. Licence and attribution per origin dataset: LICENCES below, from Overture's attribution page
// (https://docs.overturemaps.org/attribution/) and the `license` field Overture carries per feature.
const LICENCES = {
  // wording of https://docs.overturemaps.org/attribution/ (Buildings; licence for the theme: ODbL), read 2026-10-11
  'Google Open Buildings': { family: 'Google', licence: 'CC BY 4.0', attribution: 'Google Open Buildings. Available under CC BY 4.0. Via Overture Maps Foundation.' },
  'Microsoft ML Buildings': { family: 'Microsoft', licence: 'ODbL 1.0', attribution: 'Global ML Building Footprints. Licensed by Microsoft under the Open Database License. Via Overture Maps Foundation.' },
};
const RULE = `OpenStreetMap is the base: every building of our own OSM extract is kept unchanged. An Overture building is added only if none of its sources is OpenStreetMap and (1) it does not overlap our OSM extract or an addition already accepted: dropped if its centroid is inside an OSM footprint, an OSM centroid is inside it, or the outlines intersect at all (outer rings); (2) it is plausible: at least ${ADD.min_area_m2} m2, confidence at least ${ADD.min_confidence} where the source gives one, not above ${ADD.large_area_m2} m2 unless its confidence is at least ${ADD.large_min_confidence}, and at least ${ADD.min_width_m} m wide (short side of its smallest enclosing rectangle; containers, trailers and vehicles are narrower); (3) its centroid is on land inside a municipio; (4) it is not a small footprint (under ${ADD.near_max_area_m2} m2) whose outline comes within ${ADD.near_m} m of an OSM footprint (taken as part of the mapped building). Tests run in that order and a candidate is counted under the first one it fails. Added records have bit 7 (0x80) of kind set; kind is house under 400 m2, otherwise other; height is the source's own or 0.`;
const addedSource = ovtMeta && {
  name: 'Overture Maps Foundation, buildings theme: features whose origin is not OpenStreetMap (footprints detected from imagery by machine learning)',
  release: ovtMeta.release, url: ovtMeta.file, bbox: ovtMeta.bbox, licence: 'ODbL 1.0 (Overture: "License for theme: ODbL"); per origin dataset below', attribution: '© OpenStreetMap contributors, Overture Maps Foundation', attribution_page: 'https://docs.overturemaps.org/attribution/',
  nature: 'Machine detections, not surveyed and not reviewed by a person. Not in OpenStreetMap at the date of our extract.',
  datasets: (ovtMeta.datasets || []).filter((d) => d.dataset !== 'OpenStreetMap').map((d) => ({ dataset: d.dataset, family: LICENCES[d.dataset]?.family ?? d.dataset, licence: LICENCES[d.dataset]?.licence ?? d.license_in_data ?? 'see Overture attribution page', licence_field_in_data: d.license_in_data ?? null, attribution: LICENCES[d.dataset]?.attribution ?? `${d.dataset}, via Overture Maps Foundation`,
    version: d.version_max ?? null, observed: d.update_time_max ?? null, candidates: addStats.candidates_by_dataset[d.dataset] || 0, added: addStats.added_by_dataset[d.dataset] || 0, confidence: d.with_confidence ? { features_with_value: d.with_confidence, min: d.confidence_min, max: d.confidence_max } : null, with_height: d.with_height })),
  overture_osm_snapshot: (ovtMeta.datasets || []).find((d) => d.dataset === 'OpenStreetMap')?.version_max ?? null,
  rule: RULE, thresholds: ADD,
  counts: { candidates: addStats.candidates, added: NB_ADDED, added_by_dataset: addStats.added_by_dataset, dropped_overlap: addStats.dropped_overlap, dropped_implausible: addStats.dropped_implausible, dropped_not_on_land: addStats.dropped_not_on_land, dropped_attached_to_osm: addStats.dropped_attached_to_osm, degenerate: addStats.degenerate },
};
writeOut('tiles/bld/index.json', JSON.stringify({
  zoom: Z, format: 'GBL1', generated, source: osmSource, added_source: addedSource || null,
  encoding: {
    endian: 'little', header: ['4 bytes ASCII "GBL1"', 'uint32 count'],
    record: ['uint16 nv', 'uint8 height_half_m (0 = unknown)', 'uint8 kind (low 7 bits; bit 7 = added: detected from imagery, not in OpenStreetMap)', 'int16 ground_dm (decimetres above mean sea level at the centroid; -32768 = unknown)', 'uint8 flood_class', 'uint8 reserved', 'nv x (uint16 u, uint16 v)'],
    kinds: KINDS, flood_classes: ['minimal / none / not attached', '0.2 % annual chance', '1 % annual chance (A zones)', 'coastal high hazard (V zones)'],
    pad: PAD,
    uv: 'fx = lonToTileX(lon, 14) - x; fy = latToTileY(lat, 14) - y (0..1 across the tile: fx east, linear in longitude; fy south, linear in Web Mercator y). u = round((fx + 0.25) / 1.5 * 65535); v = round((fy + 0.25) / 1.5 * 65535). Decode: fx = u / 65535 * 1.5 - 0.25; fy = v / 65535 * 1.5 - 0.25.',
    ring: 'outer ring only, closing vertex not repeated, winding as in OSM (not normalised); rings above 64 vertices simplified (Douglas-Peucker)',
    assignment: 'a building is stored once, in the tile containing the centroid of its outer ring',
    added_flag: 'kind & 0x80: the footprint comes from added_source (a machine detection), not from OpenStreetMap; kind & 0x7f is the kind. In each tile the OpenStreetMap records come first, then the added ones.',
    ids: 'tiles/bld/14/{x}/{y}.ids beside each tile: one text line per record, in record order, "<gers>,<osm>,<height source>". gers: the Overture Maps GERS id (a stable feature id; for an OSM building the id of the Overture feature carrying it, for an addition its own), empty where there is none. osm: "w<id>" or "r<id>" for the OpenStreetMap way or relation, empty for an addition. height source: osm (height tag), levels (building:levels x 3.2 m + 1 m), ovt (the detection source, via Overture), usas (FEMA USA Structures), empty (none: height_half_m is 0).',
  },
  ids: { ...idStats, overture_release: ovtMeta?.release ?? null }, heights: heightStats,
  flood_attached: floodAttached, total: NB, osm: NB_OSM, added: NB_ADDED, bytes, tiles: index,
}));
log('tiles written', index.length, 'bytes', bytes, 'vertices clamped', clampedVerts);

// ---- exposure ----
const mk = () => ({ name: null, buildings: 0, buildings_osm: 0, buildings_added: 0, elev_hist: new Array(40).fill(0), below_0: 0, above_10: 0, elev_unknown: 0, zone_counts: { 0: 0, 1: 0, 2: 0, 3: 0 }, by_kind: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }, with_height: 0, buildings_sfha: 0, at_or_below: { '0.5': 0, '1': 0, '1.5': 0, '2': 0, '3': 0, '5': 0 } });
const LEVELS = [0.5, 1, 1.5, 2, 3, 5];
const island = mk(); island.name = 'Puerto Rico'; const byMuni = {};
for (const f of munis) { byMuni[f.properties.GEOID] = mk(); byMuni[f.properties.GEOID].name = f.properties.NAME; }
let noMuni = 0;
for (let i = 0; i < NB; i++) {
  const g = B.muni[i]; if (!g) noMuni++;
  for (const r of g ? [island, byMuni[g]] : [island]) {
    r.buildings++; if (B.added[i]) r.buildings_added++; else r.buildings_osm++; r.zone_counts[B.flood[i]]++; r.by_kind[B.kind[i]]++; if (B.h[i]) r.with_height++; if (B.flood[i] >= 2) r.buildings_sfha++;
    const e = B.elev[i];
    if (Number.isFinite(e)) for (const L of LEVELS) if (e <= L + 1e-6) r.at_or_below[L]++;
    if (!Number.isFinite(e)) r.elev_unknown++; else if (e < 0) r.below_0++; else if (e >= 10) r.above_10++; else r.elev_hist[Math.floor(e * 4)]++;
  }
}
// Integer-metre plateaus: parts of the Terrain Tiles source are quantised to whole metres (see method).
const plateau = {}; let plateauN = 0, low15 = 0;
for (let i = 0; i < NB; i++) { const e = B.elev[i]; if (!Number.isFinite(e) || e < 0.5 || e > 15.5) continue; low15++; const r = Math.round(e); if (Math.abs(e - r) < 0.005) { plateau[r] = (plateau[r] || 0) + 1; plateauN++; } }
const below = (r, m) => r.below_0 + r.elev_hist.slice(0, m * 4).reduce((a, b) => a + b, 0);
const method = [
  'Buildings: every way or multipolygon relation tagged building=* in the Geofabrik Puerto Rico extract of OpenStreetMap; one record per OSM object, outer ring only.',
  addedSource ? `ADDED footprints (buildings_added; buildings = buildings_osm + buildings_added): machine detections from imagery carried by Overture Maps release ${addedSource.release} (${addedSource.datasets.map((d) => d.dataset).join(', ')}), not surveyed, not in OpenStreetMap. ${RULE} They count in every number here exactly like OSM buildings; their kind is a guess from area alone.` : 'No machine-detected footprints were added in this build (buildings_added = 0).',
  'Ground elevation: bilinear sample of the AWS Terrain Tiles Terrarium zoom-14 tile (USGS 3DEP 1/3 arc-second, about 10 m, on land) at the centroid of the outer ring; samples are clamped at the tile edge. It is the ground at one point, not the floor height.',
  floodAttached ? 'Flood class: FEMA National Flood Hazard Layer flood hazard zones (NFHL MapServer layer 28, DFIRM_ID LIKE \'72%\'), point-in-polygon at the building centroid; highest class wins where polygons overlap. 3 = V/VE, 2 = A/AE/AH/AO/A99/AR, 1 = X with 0.2 PCT subtype, 0 = anything else or no polygon.' : 'Flood class: NOT ATTACHED YET in this build (zone_counts are all class 0).',
  'at_or_below: inclusive counts of buildings with ground elevation <= 0.5, 1, 1.5, 2, 3 and 5 m (buildings below 0 included). Use these for "at or below +X m": the histogram bins are half-open, so summing bins 0..3 gives "< 1.0 m" and leaves out the buildings sitting on the exact 1.0 m terrace. buildings_sfha = classes 2 + 3.',
  'elev_hist: counts of buildings by ground elevation in 0.25 m bins from 0 to 10 m, bin i = [i*0.25, (i+1)*0.25); below_0 and above_10 hold the rest; elev_unknown where no elevation tile was available.',
  'CAVEAT on the elevation source: in the low coastal plains (San Juan metro, Ponce and others) the Terrain Tiles surface has flat terraces at whole metres (most at exactly 3.0, 7.0, 10.0 and 13.0 m), so it is not lidar-grade there and counts near those levels are lumpy; qa.json elevation.integer_plateaus gives the numbers. Treat "at or below 1 m / 2 m" as an order of magnitude until a lidar DEM replaces it.',
  '"At or below X m" from these bins is a bathtub screen: it is not a hydrodynamic model and does not test hydrological connection to the sea.',
  'OpenStreetMap completeness varies by municipio; counts are of mapped footprints (plus the added machine detections), not of housing units or parcels.',
  'Kinds: 0 house/residential (including building=yes under 400 m2), 1 apartments, 2 commercial, 3 industrial, 4 civic, 5 religious, 6 other (including building=yes of 400 m2 or more).',
].join(' ');
writeOut('data/derived/exposure.json', JSON.stringify({
  generated, flood_attached: floodAttached, method,
  sources: { buildings: osmSource, buildings_added: addedSource || null, elevation: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/14/{x}/{y}.png (AWS Terrain Tiles; USGS 3DEP on land)', flood: 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28', municipios: 'Census TIGERweb tigerWMS_Current layer 82' },
  bins: { size_m: 0.25, from_m: 0, to_m: 10, count: 40 }, kinds: KINDS,
  island, municipios: byMuni, buildings_outside_municipios: noMuni,
}));

// ---- facilities ----
writeOut('data/osm/facilities.json', JSON.stringify({
  generated, source: osmSource, flood_attached: floodAttached,
  note: 'One record per OSM object. lon/lat is the node, or the centroid of the largest outer ring for areas. elev_m: Terrarium zoom-14 ground elevation at that point. flood_zone: FEMA NFHL FLD_ZONE at that point ("none" where no polygon; null until attached), flood_class: 0 minimal/none, 1 = 0.2 % annual chance, 2 = 1 % annual chance (A zones), 3 = coastal high hazard (V zones); flood_subtype: ZONE_SUBTY; sfha: SFHA_TF as boolean. coast_dist_m: distance to the nearest OpenStreetMap coastline segment, metres (local equirectangular). municipio: Census county GEOID.',
  counts: facCounts, total: facilities.length, facilities,
}));

// ---- QA ----
const addRank = Object.entries(byMuni).map(([g, r]) => ({ geoid: g, name: r.name, buildings: r.buildings, buildings_osm: r.buildings_osm, buildings_added: r.buildings_added, added_share: r.buildings ? +(r.buildings_added / r.buildings).toFixed(4) : null })).sort((a, b) => b.added_share - a.added_share);
const rank = Object.entries(byMuni).map(([g, r]) => ({ geoid: g, name: r.name, buildings: r.buildings, zone2: r.zone_counts[2], zone3: r.zone_counts[3], sfha: r.zone_counts[2] + r.zone_counts[3] }));
const pick = (g) => { const r = byMuni[g]; return r && { geoid: g, name: r.name, buildings: r.buildings, zone_counts: r.zone_counts, sfha: r.zone_counts[2] + r.zone_counts[3], sfha_share: r.buildings ? +((r.zone_counts[2] + r.zone_counts[3]) / r.buildings).toFixed(4) : null, lt_1m: below(r, 1), at_or_below_1m: r.at_or_below['1'], at_or_below_2m: r.at_or_below['2'], at_or_below_3m: r.at_or_below['3'] }; };
const topTags = Object.entries(stats.by_building_tag).sort((a, b) => b[1] - a[1]).slice(0, 25);
writeOut('data/derived/qa.json', JSON.stringify({
  generated, flood_attached: floodAttached,
  ids: { ...idStats, overture_release: ovtMeta?.release ?? null },
  heights: heightStats,
  buildings: { total: NB, buildings_osm: NB_OSM, buildings_added: NB_ADDED, osm_features_read: stats.features, dropped_degenerate: stats.degenerate, multipolygon: stats.multi, rings_simplified_over_64: stats.simplified, vertices: stats.vertices,
    height_from_height_tag: stats.height_tag, height_from_levels: stats.height_levels, height_unknown: stats.height_none, share_with_height: +((stats.height_tag + stats.height_levels) / Math.max(1, NB)).toFixed(4),
    by_kind: island.by_kind, top_building_tags: topTags, outside_municipios: noMuni },
  added: addedSource ? {
    source: { name: addedSource.name, release: addedSource.release, datasets: addedSource.datasets, overture_osm_snapshot: addedSource.overture_osm_snapshot }, rule: RULE, thresholds: ADD,
    island: { buildings: island.buildings, buildings_osm: island.buildings_osm, buildings_added: island.buildings_added, added_share: +(island.buildings_added / Math.max(1, island.buildings)).toFixed(4) },
    candidates: addStats.candidates, candidates_by_dataset: addStats.candidates_by_dataset, degenerate: addStats.degenerate,
    dropped_overlap: addStats.dropped_overlap, dropped_overlap_total: Object.values(addStats.dropped_overlap).reduce((a, b) => a + b, 0),
    dropped_implausible: addStats.dropped_implausible, dropped_implausible_total: Object.values(addStats.dropped_implausible).reduce((a, b) => a + b, 0), dropped_low_confidence_by_dataset: addStats.dropped_low_confidence_by_dataset,
    dropped_not_on_land: addStats.dropped_not_on_land, land_test_applied: addStats.land_test,
    dropped_attached_to_osm: addStats.dropped_attached_to_osm,
    width_hist_m: { note: 'Candidates that passed the overlap, area, confidence and size tests, by the short side of their smallest enclosing rectangle (m). Those under min_width_m are dropped as narrow.', counts: addStats.width_hist },
    distance_to_osm_hist: { note: 'Candidates that passed tests 1 to 3, by footprint area (m2) and distance from their outline to the nearest OSM outline (m, looked for up to 5 m). Rule 4 drops the cells with area under near_max_area_m2 and distance under near_m.', counts: addStats.distance_to_osm_hist },
    not_overlapping_area_hist_m2: addStats.not_overlapping_area_hist,
    sensitivity: { note: 'Approximate count of additions other thresholds would give: candidates clear of OSM and of the additions accepted in this run, by minimum area (m2) and minimum confidence (candidates without a confidence always pass it). Before the land test.', counts: addStats.sensitivity },
    added: NB_ADDED, added_by_dataset: addStats.added_by_dataset, added_with_height: addStats.added_with_height, added_confidence_hist: addStats.added_confidence_hist,
    added_by_kind: (() => { const k = { 0: 0, 6: 0 }; for (let i = NB_OSM; i < NB; i++) k[B.kind[i]]++; return k; })(), added_outside_municipios: (() => { let n = 0; for (let i = NB_OSM; i < NB; i++) if (!B.muni[i]) n++; return n; })(),
    top10_added_share: addRank.slice(0, 10), bottom10_added_share: addRank.slice(-10).reverse(), by_municipio: addRank,
  } : null,
  tiles: { count: index.length, bytes, vertices_clamped: clampedVerts, max_per_tile: index.reduce((m, t) => Math.max(m, t[2]), 0) },
  elevation: { ...elevStats, unknown: island.elev_unknown, below_0: island.below_0, lt_1m: below(island, 1), lt_2m: below(island, 2), lt_3m: below(island, 3), at_or_below: island.at_or_below, above_10: island.above_10,
    note: 'lt_X = strictly below X m (histogram bins); at_or_below = inclusive. They differ a lot at 1, 3 m because of the whole-metre terraces in the elevation source.',
    integer_plateaus: { note: 'buildings whose sampled ground elevation is a whole metre to within 5 mm, by metre, among buildings between 0.5 and 15.5 m', by_metre: plateau, total: plateauN, buildings_0p5_to_15p5m: low15, share: +(plateauN / Math.max(1, low15)).toFixed(4) } },
  flood: { nfhl: nfhlStats, island_zone_counts: island.zone_counts,
    top5_zone2: [...rank].sort((a, b) => b.zone2 - a.zone2).slice(0, 5), top5_sfha: [...rank].sort((a, b) => b.sfha - a.sfha).slice(0, 5),
    reference: { note: 'An earlier study by the same owner (OSM building tiles, same FEMA layer) found 6,862 of 33,461 buildings in the 1 % zones in Toa Baja and 3,806 of 9,915 in Catano.', toa_baja: { in_1pct: 6862, buildings: 33461 }, catano: { in_1pct: 3806, buildings: 9915 } },
    toa_baja: pick('72137'), catano: pick('72033'), san_juan: pick('72127') },
  facilities: { total: facilities.length, counts: facCounts, without_municipio: facilities.filter((f) => !f.municipio).length, dropped_outside_puerto_rico: facOutside,
    in_sfha: facilities.filter((f) => f.flood_class >= 2).length, in_sfha_by_type: facilities.reduce((m, f) => { if (f.flood_class >= 2) m[f.type] = (m[f.type] || 0) + 1; return m; }, {}) },
  top5_buildings: [...rank].sort((a, b) => b.buildings - a.buildings).slice(0, 5), bottom5_buildings: [...rank].sort((a, b) => a.buildings - b.buildings).slice(0, 5),
}, null, 1));
log('done', JSON.stringify({ buildings: NB, osm: NB_OSM, added: NB_ADDED, tiles: index.length, bytes, facilities: facilities.length, floodAttached, lt_1m: below(island, 1), at_or_below: island.at_or_below, zone_counts: island.zone_counts }));
