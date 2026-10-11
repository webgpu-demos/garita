// Derived seed batches, computed from files already published on the site (no network):
//   50  OSM facilities as objects                         (source: osm)
//   51  lidar elevation, flood zone, surge, landslide class, coast distance of facilities (source: garita_derived)
//   52  building exposure per municipio                    (source: garita_derived)
//   53  the same for shelters and housing; sensor -> municipio; nearest-sensor links
// Run: node pipeline/derive.mjs <siteDir>
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { haversineKm } from '../src/core/geo.ts';

const site = process.argv[2] || '/home/claude/site';
const J = (p) => JSON.parse(readFileSync(join(site, p), 'utf8'));
const now = Date.now();
const out = (name, batch) => { writeFileSync(join(site, 'data/seed', name), JSON.stringify(batch)); const b = [].concat(batch); console.log(name, b.map((x) => `${x.source}: ${x.objects?.length ?? 0} objects, ${x.links?.length ?? 0} links`).join(' | ')); };

// ---------- municipios ----------
const muni = J('data/geo/municipios.geojson').features;
const muniName = new Map(muni.map((f) => [f.properties.GEOID, f.properties.NAME]));
const ringHas = (ring, x, y) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
const polyHas = (poly, x, y) => ringHas(poly[0], x, y) && !poly.slice(1).some((h) => ringHas(h, x, y));
const geomHas = (g, x, y) => g.type === 'Polygon' ? polyHas(g.coordinates, x, y) : g.coordinates.some((p) => polyHas(p, x, y));
const bboxOf = (g) => { let w = 1e9, s = 1e9, e = -1e9, n = -1e9; const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates; for (const p of polys) for (const [x, y] of p[0]) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; } return [w, s, e, n]; };
const muniIdx = muni.map((f) => ({ id: f.properties.GEOID, g: f.geometry, b: bboxOf(f.geometry) }));
const muniAt = (lon, lat) => { for (const m of muniIdx) if (lon >= m.b[0] && lon <= m.b[2] && lat >= m.b[1] && lat <= m.b[3] && geomHas(m.g, lon, lat)) return m.id; return null; };

// ---------- flood zones (grid index over polygon bboxes) ----------
const nfhl = J('data/geo/nfhl_zones.geojson').features.map((f) => ({ p: f.properties, g: f.geometry, b: bboxOf(f.geometry) }));
const CELL = 0.02, grid = new Map();
nfhl.forEach((z, i) => { for (let gx = Math.floor(z.b[0] / CELL); gx <= Math.floor(z.b[2] / CELL); gx++) for (let gy = Math.floor(z.b[1] / CELL); gy <= Math.floor(z.b[3] / CELL); gy++) { const k = gx + ',' + gy; (grid.get(k) ?? grid.set(k, []).get(k)).push(i); } });
const zoneKeys = Object.keys(nfhl[0].p); console.log('nfhl props', zoneKeys, nfhl.length);
const classOf = (p) => p.class ?? p.flood_class ?? p.cls ?? 0;
const zoneAt = (lon, lat) => { let best = null; for (const i of grid.get(Math.floor(lon / CELL) + ',' + Math.floor(lat / CELL)) ?? []) { const z = nfhl[i]; if (lon >= z.b[0] && lon <= z.b[2] && lat >= z.b[1] && lat <= z.b[3] && geomHas(z.g, lon, lat) && (!best || classOf(z.p) > classOf(best.p))) best = z; } return best ? { zone: best.p.FLD_ZONE ?? best.p.zone ?? '', cls: classOf(best.p) } : { zone: 'X', cls: 0 }; };

// ---------- hazards sampled on the runner (pipeline/hazards): lidar ground elevation, storm surge, landslide ----------
const lidarAt = J('data/hazards/lidar/assets.json'), surgeAt = J('data/hazards/surge/assets.json'), slideAt = J('data/hazards/slide/assets.json'), slide25At = J('data/hazards/slide/assets_max25m.json');
const SLIDE = [null, 'Low / Baja', 'Moderate / Moderada', 'High / Alta', 'Very high / Muy alta', 'Extremely high / Extremadamente alta'];
const ftBin = (c) => (c >= 21 ? 'over 20 ft' : `${c - 1}-${c} ft`);
/** Ground elevation from the 1 m lidar DEM (metres, PRVD02), or null where the lidar has no value at the point. */
const groundAt = (id) => (typeof lidarAt[id] === 'number' ? Math.round(lidarAt[id] * 10) / 10 : null);
/** Surge and landslide values at a point. Surge: only what the map shows; "nothing mapped" is left out, not written as safe. */
const hazardProps = (id) => {
  const p = {}, s = surgeAt[id];
  if (Array.isArray(s) && !s.includes(255)) {
    const first = s.findIndex((c) => c >= 1 && c <= 21);
    if (first >= 0) { p.surge_category = first + 1; p.surge_by_category = s.map((c, i) => `Cat ${i + 1}: ${c >= 1 && c <= 21 ? ftBin(c) : 'none mapped'}`).join('; '); }
  }
  if (SLIDE[slideAt[id]]) p.slide_class = SLIDE[slideAt[id]];
  if (SLIDE[slide25At[id]]) p.slide_class_25m = SLIDE[slide25At[id]];
  return p;
};

// ---------- 50 / 51: OSM facilities ----------
const fac = J('data/osm/facilities.json');
const num = (s) => { const m = /-?\d+(\.\d+)?/.exec(String(s ?? '')); return m ? +m[0] : null; };
const facObjs = [], facLinks = [], facDerived = [];
for (const f of fac.facilities) {
  if (!f.name && !['substation', 'power_plant'].includes(f.type)) continue;
  const t = f.tags ?? {}, props = {};
  const addr = [t['addr:housenumber'], t['addr:street'], t['addr:city'], t['addr:postcode']].filter(Boolean).join(' ');
  if (t.operator) props.operator = String(t.operator);
  if (addr) props.address = addr;
  if (f.municipio && muniName.has(f.municipio)) props.municipio_name = muniName.get(f.municipio);
  props.osm_url = `https://www.openstreetmap.org/${f.osm}`;
  if (f.type === 'hospital') { if (num(t.beds) != null) props.beds = num(t.beds); if (t.emergency) props.emergency = String(t.emergency); }
  if (f.type === 'school') { const lvl = t['isced:level'] ?? (t.amenity === 'university' ? 'university' : t.amenity === 'college' ? 'college' : null); if (lvl) props.level = String(lvl); }
  if (f.type === 'power_plant') { if (t['plant:source']) props.fuel = String(t['plant:source']); const mw = /([\d.]+)\s*(MW|kW|GW)/i.exec(t['plant:output:electricity'] ?? ''); if (mw) props.capacity_mw = Math.round(+mw[1] * ({ mw: 1, kw: 0.001, gw: 1000 })[mw[2].toLowerCase()] * 100) / 100; }
  if (f.type === 'substation') { const v = num(String(t.voltage ?? '').split(';')[0]); if (v) props.voltage_kv = Math.round(v / 1000); }
  if (f.type === 'water_plant') props.plant_type = t.man_made === 'wastewater_plant' ? 'wastewater' : 'water works';
  if (f.type === 'airport') { if (t.iata) props.iata = String(t.iata); if (t.icao) props.icao = String(t.icao); }
  // (OpenStreetMap has no name for most substations and many plants: say so in the name rather than make one up)
  const name = f.name || (f.type === 'substation' ? `Unnamed substation${props.voltage_kv ? ', ' + props.voltage_kv + ' kV' : ''}` : `Unnamed power plant${props.fuel ? ', ' + props.fuel : ''}`);
  facObjs.push({ type: f.type, key: f.osm, name, lon: f.lon, lat: f.lat, identities: [['osm', f.osm]], props, text: [t['name:en'], t['name:es'], addr, props.municipio_name].filter(Boolean).join(' ') });
  if (f.municipio) facLinks.push({ src: `${f.type}:${f.osm}`, type: 'located_in', dst: `municipio:${f.municipio}` });
  const d = hazardProps(`${f.type}:${f.osm}`), ge = groundAt(`${f.type}:${f.osm}`);
  if (ge != null) d.ground_elev_m = ge;
  if (f.flood_zone) d.flood_zone = String(f.flood_zone);
  if (f.coast_dist_m != null) d.coast_dist_m = f.coast_dist_m;
  if (Object.keys(d).length) facDerived.push({ type: f.type, key: f.osm, props: d });
}
out('50-osm-facilities.batch.json', { source: 'osm', fetchedAt: now, objects: facObjs, links: facLinks, note: 'Facilities from the Geofabrik Puerto Rico extract of OpenStreetMap; areas are placed at their centroid. Only named ones are kept, except substations and power plants, which are kept without a name and labelled "Unnamed".' });
out('51-facility-exposure.batch.json', { source: 'garita_derived', fetchedAt: now, objects: facDerived, note: 'Ground elevation: USGS 3DEP 1 m lidar DEM, median of the cells within 2 m of the point, metres above PRVD02. Flood zone: FEMA NFHL zone containing the point. Storm surge: NOAA NHC storm surge risk map class at the point, by hurricane category (awareness only; the publisher says not for parcel-level assessment). Landslide: USGS OFR 2020-1022 susceptibility class at the point and the highest within 25 m. Distance to the OSM coastline. Screening values for one point per facility.' });

// ---------- 52: building exposure per municipio ----------
const exp = J('data/derived/exposure.json');
const expObjs = Object.entries(exp.municipios).map(([geoid, m]) => ({ type: 'municipio', key: geoid, props: {
  buildings: m.buildings, buildings_sfha: m.buildings_sfha, buildings_le_1m: m.at_or_below['1'], buildings_le_2m: m.at_or_below['2'], buildings_le_3m: m.at_or_below['3'],
  // bin i = buildings whose lidar ground elevation rounds to i/10 m: "at or below X" = below_0 + bins 0..10X, inclusive
  elev_hist: JSON.stringify({ bin_m: exp.bins.size_m, inclusive: true, from_m: 0, below_0: m.below_0, bins: m.elev_hist, above_10: m.above_10, unknown: m.elev_unknown, at_or_below: m.at_or_below }),
  zone_counts: JSON.stringify(m.zone_counts),
  buildings_surge_cat1: m.surge.c1.any, buildings_surge_cat2: m.surge.c2.any, buildings_surge_cat3: m.surge.c3.any, buildings_surge_cat4: m.surge.c4.any, buildings_surge_cat5: m.surge.c5.any,
  surge_counts: JSON.stringify({ ...m.surge, outside_map: m.surge_outside }),
  buildings_slide_high: m.slide.high_or_above, buildings_slide_high_25m: m.slide.high_or_above_25m,
  slide_counts: JSON.stringify(m.slide),
} }));
out('52-building-exposure.batch.json', { source: 'garita_derived', fetchedAt: now, objects: expObjs, note: 'Buildings (OpenStreetMap footprints) per municipio. Ground elevation: USGS 3DEP 1 m lidar DEM at each building (median within 2 m of the centroid), metres above PRVD02, counted in 0.1 m steps; a bathtub screen. Flood zone: FEMA NFHL at the centroid. Storm surge: buildings in a cell with mapped inundation on the NOAA NHC storm surge risk map, by hurricane category (municipio-level screening; the publisher says not for parcel-level assessment). Landslide: buildings by USGS OFR 2020-1022 susceptibility class at the centroid, and by the highest class within 25 m. Full method in data/derived/exposure.json.' });

// ---------- 53: seeded assets and sensors ----------
const seeded = [];
for (const f of readdirSync(join(site, 'data/seed')).filter((n) => /^[0-4]\d-.*\.batch\.json$/.test(n))) for (const b of [].concat(J('data/seed/' + f))) for (const o of b.objects ?? []) if (o.lon != null && o.lat != null) seeded.push(o);
const assets = seeded.filter((o) => ['shelter', 'public_housing', 'assisted_housing'].includes(o.type));
const sensors = seeded.filter((o) => ['stream_gauge', 'reservoir', 'tide_station', 'weather_station', 'buoy'].includes(o.type));
const dObjs = [], dLinks = [];
// A HUD record whose address is only a city and ZIP code is geocoded to the ZIP code's centre, which can be in the
// sea: its point is not the property. Nothing is derived from such a point, nor from one that is off land or below
// sea level; the record says why.
const pv = (v) => (v && typeof v === 'object' ? v.value : v);
let approx = 0;
for (const a of assets) {
  const id = `${a.type}:${a.key}`, props = {}, e = groundAt(id), z = zoneAt(a.lon, a.lat);
  const housing = a.type !== 'shelter', zipOnly = housing && /^[^,\d]*,\s*\d{5}(-\d{4})?$/.test(String(pv(a.props?.address) ?? ''));
  const offLand = housing && (!muniAt(a.lon, a.lat) || (e != null && e <= 0));
  if (zipOnly || offLand) {
    approx++;
    props.location_basis = zipOnly ? 'Approximate: the address is a city and ZIP code only, so the point is the ZIP code area, not the property. Flood zone, ground elevation, storm surge and landslide class are not derived.' : 'Doubtful: the point is in water, or the lidar puts the ground there at or below zero. Flood zone, ground elevation, storm surge and landslide class are not derived.';
    dObjs.push({ type: a.type, key: a.key, props });
    continue;
  }
  if (e != null) props.ground_elev_m = e;
  Object.assign(props, hazardProps(id));
  props.flood_zone = z.zone || 'X';
  dObjs.push({ type: a.type, key: a.key, props });
}
console.log('housing records with an approximate or doubtful point (nothing derived):', approx);
const gauges = sensors.filter((s) => s.type === 'stream_gauge'), tides = sensors.filter((s) => s.type === 'tide_station');
const nearest = (list, o) => { let best = null, bd = 1e9; for (const s of list) { const d = haversineKm(o.lon, o.lat, s.lon, s.lat); if (d < bd) { bd = d; best = s; } } return best ? [best, bd] : null; };
for (const a of [...assets, ...facObjs.filter((f) => f.type === 'hospital')]) {
  for (const [list, max] of [[gauges, 15], [tides, 40]]) { const n = nearest(list, a); if (n && n[1] <= max) dLinks.push({ src: `${a.type}:${a.key}`, type: 'nearest', dst: `${n[0].type}:${n[0].key}`, note: `${n[1].toFixed(1)} km`, confidence: 1 }); }
}
for (const s of sensors) { const m = muniAt(s.lon, s.lat); if (m) dLinks.push({ src: `${s.type}:${s.key}`, type: 'located_in', dst: `municipio:${m}` }); }
for (const a of assets) { const m = muniAt(a.lon, a.lat); if (m) dLinks.push({ src: `${a.type}:${a.key}`, type: 'located_in', dst: `municipio:${m}` }); }
out('53-asset-exposure.batch.json', { source: 'garita_derived', fetchedAt: now, objects: dObjs, links: dLinks, note: 'Flood zone: FEMA NFHL zone containing the point. Ground elevation: USGS 3DEP 1 m lidar DEM, median of the cells within 2 m of the point, metres above PRVD02. Storm surge: NOAA NHC storm surge risk map class at the point, by hurricane category (awareness only; the publisher says not for parcel-level assessment). Landslide: USGS OFR 2020-1022 susceptibility class at the point and the highest within 25 m. Nearest stream gauge within 15 km and tide station within 40 km, straight-line. Sensor and asset municipio by point-in-polygon on Census boundaries.' });
