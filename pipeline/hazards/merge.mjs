// Folds the three hazard stages into what the app reads. Runs in the sandbox on a checkout of gh-pages (no network):
//   node pipeline/hazards/merge.mjs <site>
// Reads   tiles/bld/**, data/hazards/{lidar,surge,slide}/**, data/geo/municipios.geojson, data/derived/exposure.json
// Writes  tiles/bld/14/**.bin      ground elevation of every building replaced by the lidar value (the format and the
//                                  order of buildings do not change, so the stages' buildings.bin still line up);
//                                  the last byte of each record keeps the offset to the terrain the scene draws
//         tiles/bld/index.json     says where the ground elevation now comes from
//         data/derived/exposure.json   per municipio: elevation histogram from lidar, surge and landslide counts
// Everything in exposure.json is recomputed here from the tiles and the stage files, so its parts agree with each
// other: building totals, FEMA classes, kinds, elevation, surge, landslide.
import fs from 'node:fs';
import path from 'node:path';
import { PolyIndex, flatRings } from '../vector/lib.mjs';

const site = path.resolve(process.argv[2] || 'site');
const J = (p) => JSON.parse(fs.readFileSync(path.join(site, p), 'utf8'));
const Z = 14, N = 1 << Z;
const tileLon = (tx) => (tx / N) * 360 - 180;
const tileLat = (ty) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / N))) * 180) / Math.PI;

const idx = J('tiles/bld/index.json');
const total = idx.total;
const meta = { lidar: J('data/hazards/lidar/meta.json'), surge: J('data/hazards/surge/meta.json'), slide: J('data/hazards/slide/meta.json') };
for (const [k, m] of Object.entries(meta)) if (m.buildings.bld_generated !== idx.generated) throw new Error(`${k} was sampled against building tiles of ${m.buildings.bld_generated}, tiles are ${idx.generated}`);
const bin = (p, Type, per) => { const b = fs.readFileSync(path.join(site, p)); const a = new Type(b.buffer, b.byteOffset, b.byteLength / Type.BYTES_PER_ELEMENT); if (a.length !== total * per) throw new Error(`${p}: ${a.length} values, expected ${total * per}`); return a; };
const lidar = bin('data/hazards/lidar/buildings.bin', Int16Array, 1);
const surge = bin('data/hazards/surge/buildings.bin', Uint8Array, 5);
const slide = bin('data/hazards/slide/buildings.bin', Uint8Array, 1);
const slide25 = bin('data/hazards/slide/buildings_max25m.bin', Uint8Array, 1);

const munis = J('data/geo/municipios.geojson').features;
const muniIdx = new PolyIndex({ band: 0.002, cell: 0.05 });
for (const f of munis) muniIdx.add(flatRings(f.geometry), f.properties.GEOID);

const BINS = 100;   // 0.1 m: the lidar value is stored to the decimetre, so bin i holds exactly the buildings at i/10 m
const LEVELS = [0.5, 1, 1.5, 2, 3, 5];
const mk = (name) => ({
  name, buildings: 0, buildings_osm: 0, buildings_added: 0, elev_hist: new Array(BINS).fill(0), below_0: 0, above_10: 0, elev_unknown: 0,
  zone_counts: { 0: 0, 1: 0, 2: 0, 3: 0 }, by_kind: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }, with_height: 0, buildings_sfha: 0,
  at_or_below: Object.fromEntries(LEVELS.map((l) => [String(l), 0])),
  surge: Object.fromEntries([1, 2, 3, 4, 5].map((c) => ['c' + c, { any: 0, gt3ft: 0, gt6ft: 0, gt9ft: 0 }])), surge_outside: 0,
  slide: { at_building: [0, 0, 0, 0, 0, 0], within_25m: [0, 0, 0, 0, 0, 0], high_or_above: 0, high_or_above_25m: 0 },
});
const island = mk('Puerto Rico'), byMuni = {};
// The same island totals over OpenStreetMap footprints alone, so every headline can be given with and without the
// machine-detected footprints added from Overture (bit 7 of the kind byte).
const islandOsm = mk('Puerto Rico, OpenStreetMap footprints only');
for (const f of munis) byMuni[f.properties.GEOID] = mk(f.properties.NAME);
let noMuni = 0, i = 0, changed = 0, sumAbs = 0, nDiff = 0, clamped = 0;
const merged = !!idx.ground;   // these tiles already went through this script

for (const [x, y, count] of idx.tiles) {
  const file = path.join(site, `tiles/bld/${Z}/${x}/${y}.bin`);
  const b = fs.readFileSync(file), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.toString('latin1', 0, 4) !== 'GBL1' || dv.getUint32(4, true) !== count) throw new Error(`bad tile ${x}/${y}`);
  let o = 8;
  for (let k = 0; k < count; k++, i++) {
    const nv = dv.getUint16(o, true), height = dv.getUint8(o + 2), kindByte = dv.getUint8(o + 3), kind = Math.min(6, kindByte & 0x7f), added = (kindByte & 0x80) !== 0, stored = dv.getInt16(o + 4, true), flood = dv.getUint8(o + 6);
    // The scene stands each building on the terrain it draws, which is the 10 m model the tiles were first built
    // with. That elevation is kept as an offset from the lidar value (int8, half metres) in the record's last byte.
    // (On a re-run the tile already holds lidar + offset: the terrain value is rebuilt from them.)
    const old = stored === -32768 ? -32768 : merged ? stored + dv.getInt8(o + 7) * 5 : stored;
    // area centroid of the stored ring, as in common.py
    let a = 0, cx = 0, cy = 0, sx = 0, sy = 0;
    for (let v = 0; v < nv; v++) {
      const x0 = dv.getUint16(o + 8 + 4 * v, true), y0 = dv.getUint16(o + 10 + 4 * v, true), w = (v + 1) % nv;
      const x1 = dv.getUint16(o + 8 + 4 * w, true), y1 = dv.getUint16(o + 10 + 4 * w, true), c = x0 * y1 - x1 * y0;
      a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c; sx += x0; sy += y0;
    }
    const u = Math.abs(a) > 1e-9 ? cx / (3 * a) : sx / nv, vv = Math.abs(a) > 1e-9 ? cy / (3 * a) : sy / nv;
    const lon = tileLon(x + (u / 65535) * 1.5 - 0.25), lat = tileLat(y + (vv / 65535) * 1.5 - 0.25);
    const dm = lidar[i];                                   // decimetres, -32768 = no lidar value
    if (dm !== stored) changed++;
    if (dm !== -32768) { dv.setInt16(o + 4, dm, true); dv.setInt8(o + 7, old === -32768 ? 0 : Math.max(-127, Math.min(127, Math.round((old - dm) / 5)))); if (old !== -32768 && Math.abs(old - dm) > 635) clamped++; }
    else { dv.setInt16(o + 4, -32768, true); dv.setInt8(o + 7, 0); }
    if (dm !== -32768 && old !== -32768) { sumAbs += Math.abs(dm - old) / 10; nDiff++; }
    const g = muniIdx.first(lon, lat);
    if (!g) noMuni++;
    const into = g ? [island, byMuni[g]] : [island];
    if (!added) into.push(islandOsm);
    for (const r of into) {
      r.buildings++; if (added) r.buildings_added++; else r.buildings_osm++; r.zone_counts[flood]++; r.by_kind[kind]++; if (height) r.with_height++; if (flood >= 2) r.buildings_sfha++;
      if (dm === -32768) r.elev_unknown++;
      else {
        for (const L of LEVELS) if (dm <= L * 10) r.at_or_below[String(L)]++;
        if (dm < 0) r.below_0++; else if (dm >= BINS) r.above_10++; else r.elev_hist[dm]++;
      }
      let out = false;
      for (let c = 0; c < 5; c++) {
        const cls = surge[i * 5 + c];
        if (cls === 255) { out = true; continue; }
        if (cls >= 1 && cls <= 21) { const s = r.surge['c' + (c + 1)]; s.any++; if (cls >= 4) s.gt3ft++; if (cls >= 7) s.gt6ft++; if (cls >= 10) s.gt9ft++; }
      }
      if (out) r.surge_outside++;
      const sc = slide[i] <= 5 ? slide[i] : 0, s25 = slide25[i] <= 5 ? slide25[i] : 0;
      r.slide.at_building[sc]++; r.slide.within_25m[s25]++;
      if (sc >= 3) r.slide.high_or_above++; if (s25 >= 3) r.slide.high_or_above_25m++;
    }
    o += 8 + 4 * nv;
  }
  fs.writeFileSync(file, b);
}
if (i !== total) throw new Error(`walked ${i} buildings, index says ${total}`);

const old = J('data/derived/exposure.json');
const drift = Object.entries(byMuni).filter(([g, r]) => old.municipios[g] && old.municipios[g].buildings !== r.buildings).map(([g, r]) => `${r.name} ${old.municipios[g].buildings}->${r.buildings}`);
const L = meta.lidar, S = meta.surge, D = meta.slide;
const method = [
  'Buildings: every way or multipolygon relation tagged building=* in the Geofabrik Puerto Rico extract of OpenStreetMap (buildings_osm), one record per OSM object, outer ring only; plus footprints detected from imagery by machine (buildings_added: Google Open Buildings and Microsoft ML Buildings, taken from Overture Maps) where they overlap no OpenStreetMap building and pass size, shape and confidence tests (' + (idx.added_source ? JSON.stringify(idx.added_source.rule ?? idx.added_source.combining ?? '').slice(0, 600) : 'see tiles/bld/index.json') + '). Added footprints are detections, not surveyed buildings, and many are outbuildings. Every count below is over both kinds; island_osm_only repeats the island totals over OpenStreetMap footprints alone. Each building is counted in the municipio that contains the centroid of its footprint.',
  `Ground elevation: ${L.method} Datum: ${typeof L.datum === 'string' ? L.datum : L.datum?.name ?? JSON.stringify(L.datum).slice(0, 200)}. Stored to the decimetre. It is the ground at the building, not its floor.`,
  'elev_hist: buildings by ground elevation, bin i = the buildings whose elevation rounds to i/10 m, for 0.0 to 9.9 m; below_0 and above_10 hold the rest; elev_unknown where the lidar has no value. "At or below X m" = below_0 + bins 0..10X (inclusive); at_or_below gives it for 0.5, 1, 1.5, 2, 3 and 5 m. It is a bathtub screen: no hydrodynamic model, no test of connection to the sea, and it counts the few buildings the lidar puts below zero (pits, quarries, depressions) at every level.',
  "Flood class: FEMA National Flood Hazard Layer flood hazard zones (NFHL MapServer layer 28, DFIRM_ID LIKE '72%'), point-in-polygon at the building centroid; highest class wins where polygons overlap. 3 = V/VE, 2 = A/AE/AH/AO/A99/AR, 1 = X with 0.2 PCT subtype, 0 = anything else or no polygon. buildings_sfha = classes 2 + 3.",
  `surge: ${S.method} Per category: any = buildings in a cell with any mapped inundation, gt3ft / gt6ft / gt9ft = more than 3, 6, 9 feet above ground. surge_outside = buildings beyond the raster. The publisher limits these maps to awareness at a city or community level, not parcel-level assessment: use the counts as municipio-level screening.`,
  `slide: ${D.method} at_building = buildings by class at the centroid cell (index 0 = no data, 1..5 = Low to Extremely High); within_25m = by the highest class within 25 m of the centroid; high_or_above = classes 3 to 5.`,
  'OpenStreetMap completeness varies by municipio; counts are of mapped footprints, not of housing units or parcels. Kinds: 0 house/residential (including building=yes under 400 m2), 1 apartments, 2 commercial, 3 industrial, 4 civic, 5 religious, 6 other (including building=yes of 400 m2 or more).',
].join(' ');
const out = {
  generated: new Date().toISOString(), flood_attached: true, method,
  sources: { ...old.sources, ...(idx.added_source ? { buildings_added: idx.added_source } : {}), elevation: { name: L.source.name, urls: L.source.urls, datum: L.datum, generated: L.generated }, surge: { name: S.source.name, urls: S.source.urls, version: S.source.version }, landslide: { name: D.source.name, urls: D.source.urls, citation: D.source.citation } },
  bins: { size_m: 0.1, from_m: 0, to_m: 10, count: BINS, rule: 'bin i = buildings whose elevation rounds to i/10 m' }, kinds: old.kinds,
  disclaimers: { surge: S.disclaimer, landslide: D.disclaimer, elevation: L.disclaimer },
  island, island_osm_only: islandOsm, municipios: byMuni, buildings_outside_municipios: noMuni,
};
fs.writeFileSync(path.join(site, 'data/derived/exposure.json'), JSON.stringify(out));
idx.ground = { source: L.source.name, statistic: 'median of the 1 m cells within 2 m of the centroid', datum: L.datum, no_value: -32768, merged: out.generated, stage: 'data/hazards/lidar' };
idx.encoding.record = idx.encoding.record.map((r) => (r.startsWith('int16 ground_dm') ? 'int16 ground_dm (ground elevation at the centroid from the 1 m lidar DEM, decimetres above the datum in "ground"; -32768 = no lidar value)'
  : r.startsWith('uint8 reserved') || r.startsWith('int8 place') ? 'int8 place_half_m (half metres to add to ground_dm to get the elevation of the 10 m terrain the scene is drawn on; used only to stand the building on that terrain)' : r));
fs.writeFileSync(path.join(site, 'tiles/bld/index.json'), JSON.stringify(idx));

console.log(JSON.stringify({
  buildings: total, osm: island.buildings_osm, added: island.buildings_added, ground_values_changed: changed, placement_offsets_clamped: clamped, mean_abs_change_m: +(sumAbs / nDiff).toFixed(2), outside_municipios: noMuni, municipio_totals_that_moved: drift,
  at_or_below: { before: old.island.at_or_below, after: island.at_or_below, osm_only: islandOsm.at_or_below }, below_0: island.below_0, unknown: island.elev_unknown,
  sfha: { before: old.island.buildings_sfha, after: island.buildings_sfha },
  surge_osm_only_c3: islandOsm.surge.c3, slide_osm_only: islandOsm.slide.high_or_above,
  surge: island.surge, surge_outside: island.surge_outside, slide: island.slide,
}, null, 1));
