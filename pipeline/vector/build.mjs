// Stages 2-4: OSM buildings + facilities -> ground elevation -> FEMA flood class -> building tiles, exposure, QA.
//
// Inputs (made by stage2_osm.sh and nfhl.mjs on the runner):
//   work/osm/buildings.geojsonl, work/osm/facilities.geojsonl   osmium exports of the Geofabrik Puerto Rico extract
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
//     uint8  kind      0 house/residential, 1 apartments, 2 commercial, 3 industrial, 4 civic, 5 religious, 6 other
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
const B = { start: [], nv: [], cx: [], cy: [], h: [], kind: [], elev: [], flood: [], muni: [] };
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
  B.elev.push(NaN); B.flood.push(0); B.muni.push(null);
  stats.vertices += n; stats.kept++;
  const bt = String(t.building); stats.by_building_tag[bt] = (stats.by_building_tag[bt] || 0) + 1;
}
const NB = B.cx.length;
log('buildings', JSON.stringify({ ...stats, by_building_tag: undefined }));

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
    buf.writeUInt16LE(nv, o); buf.writeUInt8(B.h[i], o + 2); buf.writeUInt8(B.kind[i], o + 3);
    buf.writeInt16LE(Number.isFinite(e) ? Math.max(-32767, Math.min(32767, Math.round(e * 10))) : -32768, o + 4);
    buf.writeUInt8(B.flood[i], o + 6); buf.writeUInt8(0, o + 7); o += 8;
    for (let k = 0, s = B.start[i] * 2; k < nv; k++, s += 2) {
      const fx = lonToTileX(coords[s], Z) - t.x, fy = latToTileY(coords[s + 1], Z) - t.y;
      if (fx < -PAD || fx > 1 + PAD || fy < -PAD || fy > 1 + PAD) clampedVerts++;
      buf.writeUInt16LE(q(fx), o); buf.writeUInt16LE(q(fy), o + 2); o += 4;
    }
  }
  writeOut(`tiles/bld/${Z}/${t.x}/${t.y}.bin`, buf);
  index.push([t.x, t.y, t.b.length]); bytes += size;
}
index.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const generated = new Date().toISOString();
const pbfHead = readFirst(path.join(CACHE, 'pbf_head.txt')) || '';
const osmSource = { name: 'OpenStreetMap contributors (ODbL 1.0)', extract: 'https://download.geofabrik.de/north-america/us/puerto-rico-latest.osm.pbf', extract_headers: pbfHead.trim().split('\n').filter(Boolean) };
writeOut('tiles/bld/index.json', JSON.stringify({
  zoom: Z, format: 'GBL1', generated, source: osmSource,
  encoding: {
    endian: 'little', header: ['4 bytes ASCII "GBL1"', 'uint32 count'],
    record: ['uint16 nv', 'uint8 height_half_m (0 = unknown)', 'uint8 kind', 'int16 ground_dm (decimetres above mean sea level at the centroid; -32768 = unknown)', 'uint8 flood_class', 'uint8 reserved', 'nv x (uint16 u, uint16 v)'],
    kinds: KINDS, flood_classes: ['minimal / none / not attached', '0.2 % annual chance', '1 % annual chance (A zones)', 'coastal high hazard (V zones)'],
    pad: PAD,
    uv: 'fx = lonToTileX(lon, 14) - x; fy = latToTileY(lat, 14) - y (0..1 across the tile: fx east, linear in longitude; fy south, linear in Web Mercator y). u = round((fx + 0.25) / 1.5 * 65535); v = round((fy + 0.25) / 1.5 * 65535). Decode: fx = u / 65535 * 1.5 - 0.25; fy = v / 65535 * 1.5 - 0.25.',
    ring: 'outer ring only, closing vertex not repeated, winding as in OSM (not normalised); rings above 64 vertices simplified (Douglas-Peucker)',
    assignment: 'a building is stored once, in the tile containing the centroid of its outer ring',
  },
  flood_attached: floodAttached, total: NB, bytes, tiles: index,
}));
log('tiles written', index.length, 'bytes', bytes, 'vertices clamped', clampedVerts);

// ---- exposure ----
const mk = () => ({ name: null, buildings: 0, elev_hist: new Array(40).fill(0), below_0: 0, above_10: 0, elev_unknown: 0, zone_counts: { 0: 0, 1: 0, 2: 0, 3: 0 }, by_kind: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }, with_height: 0, buildings_sfha: 0, at_or_below: { '0.5': 0, '1': 0, '1.5': 0, '2': 0, '3': 0, '5': 0 } });
const LEVELS = [0.5, 1, 1.5, 2, 3, 5];
const island = mk(); island.name = 'Puerto Rico'; const byMuni = {};
for (const f of munis) { byMuni[f.properties.GEOID] = mk(); byMuni[f.properties.GEOID].name = f.properties.NAME; }
let noMuni = 0;
for (let i = 0; i < NB; i++) {
  const g = B.muni[i]; if (!g) noMuni++;
  for (const r of g ? [island, byMuni[g]] : [island]) {
    r.buildings++; r.zone_counts[B.flood[i]]++; r.by_kind[B.kind[i]]++; if (B.h[i]) r.with_height++; if (B.flood[i] >= 2) r.buildings_sfha++;
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
  'Ground elevation: bilinear sample of the AWS Terrain Tiles Terrarium zoom-14 tile (USGS 3DEP 1/3 arc-second, about 10 m, on land) at the centroid of the outer ring; samples are clamped at the tile edge. It is the ground at one point, not the floor height.',
  floodAttached ? 'Flood class: FEMA National Flood Hazard Layer flood hazard zones (NFHL MapServer layer 28, DFIRM_ID LIKE \'72%\'), point-in-polygon at the building centroid; highest class wins where polygons overlap. 3 = V/VE, 2 = A/AE/AH/AO/A99/AR, 1 = X with 0.2 PCT subtype, 0 = anything else or no polygon.' : 'Flood class: NOT ATTACHED YET in this build (zone_counts are all class 0).',
  'at_or_below: inclusive counts of buildings with ground elevation <= 0.5, 1, 1.5, 2, 3 and 5 m (buildings below 0 included). Use these for "at or below +X m": the histogram bins are half-open, so summing bins 0..3 gives "< 1.0 m" and leaves out the buildings sitting on the exact 1.0 m terrace. buildings_sfha = classes 2 + 3.',
  'elev_hist: counts of buildings by ground elevation in 0.25 m bins from 0 to 10 m, bin i = [i*0.25, (i+1)*0.25); below_0 and above_10 hold the rest; elev_unknown where no elevation tile was available.',
  'CAVEAT on the elevation source: in the low coastal plains (San Juan metro, Ponce and others) the Terrain Tiles surface has flat terraces at whole metres (most at exactly 3.0, 7.0, 10.0 and 13.0 m), so it is not lidar-grade there and counts near those levels are lumpy; qa.json elevation.integer_plateaus gives the numbers. Treat "at or below 1 m / 2 m" as an order of magnitude until a lidar DEM replaces it.',
  '"At or below X m" from these bins is a bathtub screen: it is not a hydrodynamic model and does not test hydrological connection to the sea.',
  'OpenStreetMap completeness varies by municipio; counts are of mapped footprints, not of housing units or parcels.',
  'Kinds: 0 house/residential (including building=yes under 400 m2), 1 apartments, 2 commercial, 3 industrial, 4 civic, 5 religious, 6 other (including building=yes of 400 m2 or more).',
].join(' ');
writeOut('data/derived/exposure.json', JSON.stringify({
  generated, flood_attached: floodAttached, method,
  sources: { buildings: osmSource, elevation: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/14/{x}/{y}.png (AWS Terrain Tiles; USGS 3DEP on land)', flood: 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28', municipios: 'Census TIGERweb tigerWMS_Current layer 82' },
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
const rank = Object.entries(byMuni).map(([g, r]) => ({ geoid: g, name: r.name, buildings: r.buildings, zone2: r.zone_counts[2], zone3: r.zone_counts[3], sfha: r.zone_counts[2] + r.zone_counts[3] }));
const pick = (g) => { const r = byMuni[g]; return r && { geoid: g, name: r.name, buildings: r.buildings, zone_counts: r.zone_counts, sfha: r.zone_counts[2] + r.zone_counts[3], sfha_share: r.buildings ? +((r.zone_counts[2] + r.zone_counts[3]) / r.buildings).toFixed(4) : null, lt_1m: below(r, 1), at_or_below_1m: r.at_or_below['1'], at_or_below_2m: r.at_or_below['2'], at_or_below_3m: r.at_or_below['3'] }; };
const topTags = Object.entries(stats.by_building_tag).sort((a, b) => b[1] - a[1]).slice(0, 25);
writeOut('data/derived/qa.json', JSON.stringify({
  generated, flood_attached: floodAttached,
  buildings: { total: NB, osm_features_read: stats.features, dropped_degenerate: stats.degenerate, multipolygon: stats.multi, rings_simplified_over_64: stats.simplified, vertices: stats.vertices,
    height_from_height_tag: stats.height_tag, height_from_levels: stats.height_levels, height_unknown: stats.height_none, share_with_height: +((stats.height_tag + stats.height_levels) / Math.max(1, NB)).toFixed(4),
    by_kind: island.by_kind, top_building_tags: topTags, outside_municipios: noMuni },
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
log('done', JSON.stringify({ buildings: NB, tiles: index.length, bytes, facilities: facilities.length, floodAttached, lt_1m: below(island, 1), at_or_below: island.at_or_below, zone_counts: island.zone_counts }));
