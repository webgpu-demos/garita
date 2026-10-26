// Your own records (src/core/localdata.ts, src/core/bldtile.ts): parsing, the tile decoder, the join and Forget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCsv, parseFile, normOsm, joinRows } from '../src/core/localdata.ts';
import { decodeTile, buildingAt, tileOf, BLD_Z } from '../src/core/bldtile.ts';
import { lonToTileX, latToTileY } from '../src/core/geo.ts';
import { validateBatch } from '../src/ontology/validate.ts';
import { openNodeStore } from '../src/ontology/node.ts';
import type { Ontology } from '../src/ontology/types.ts';

const ontology: Ontology = JSON.parse(readFileSync(new URL('../src/ontology/ontology.json', import.meta.url), 'utf8'));

// A GBL1 tile with two square buildings, written the way pipeline/vector/build.mjs writes them.
function square(lon: number, lat: number, half: number): [number, number][] { return [[lon - half, lat - half], [lon + half, lat - half], [lon + half, lat + half], [lon - half, lat + half]]; }
function tileBytes(x: number, y: number, rings: [number, number][][], heights: number[]): ArrayBuffer {
  const q = (v: number) => Math.max(0, Math.min(65535, Math.round((v + 0.25) / 1.5 * 65535)));
  let size = 8; for (const r of rings) size += 8 + r.length * 4;
  const dv = new DataView(new ArrayBuffer(size));
  'GBL1'.split('').forEach((c, i) => dv.setUint8(i, c.charCodeAt(0))); dv.setUint32(4, rings.length, true);
  let o = 8;
  rings.forEach((r, i) => {
    dv.setUint16(o, r.length, true); dv.setUint8(o + 2, heights[i] * 2); dv.setUint8(o + 3, i === 1 ? 0x80 : 0); dv.setInt16(o + 4, 32, true); dv.setUint8(o + 6, 0); dv.setInt8(o + 7, 0); o += 8;
    for (const [lon, lat] of r) { dv.setUint16(o, q(lonToTileX(lon, BLD_Z) - x), true); dv.setUint16(o + 2, q(latToTileY(lat, BLD_Z) - y), true); o += 4; }
  });
  return dv.buffer;
}
const A = { lon: -66.0705, lat: 18.4563 }, Bp = { lon: -66.0700, lat: 18.4560 };
const T = tileOf(A.lon, A.lat);
const GA = '3c7e1178-1189-4241-9eb6-9ca1225b8876', GB = '26ec82e9-7c00-4f29-9f61-3fe0b9feac3f';
const BUF = tileBytes(T.x, T.y, [square(A.lon, A.lat, 0.0001), square(Bp.lon, Bp.lat, 0.00008)], [23.5, 0]);
const IDS = `${GA},w275267363,levels\n${GB},,\n`;

test('the tile decoder reads GBL1 and its ids', () => {
  const list = decodeTile(BUF, T.x, T.y, IDS);
  assert.equal(list.length, 2);
  assert.ok(Math.abs(list[0].lon - A.lon) < 1e-5 && Math.abs(list[0].lat - A.lat) < 1e-5);
  assert.deepEqual([list[0].height, list[0].ground, list[0].added, list[0].gers, list[0].osm, list[0].heightSource], [23.5, 3.2, false, GA, 'w275267363', 'levels']);
  assert.deepEqual([list[1].added, list[1].osm, list[1].heightSource], [true, null, null]);
  assert.equal(buildingAt(list, A.lon, A.lat)?.index, 0, 'inside');
  assert.equal(buildingAt(list, Bp.lon + 0.0001, Bp.lat)?.index, 1, 'nearest within 15 m');
  assert.equal(buildingAt(list, A.lon + 0.01, A.lat), null, 'nothing near');
  assert.equal(decodeTile(BUF, T.x, T.y, null)[0].gers, null, 'a tile without an ids file');
});

test('CSV and GeoJSON rows say where they are', () => {
  assert.deepEqual(parseCsv('a;b\n"x;1";2\r\n\n3;"q""uote"\n'), [['a', 'b'], ['x;1', '2'], ['3', 'q"uote']]);
  assert.equal(normOsm('way/123'), 'w123'); assert.equal(normOsm('https://www.openstreetmap.org/relation/9'), 'r9'); assert.equal(normOsm('W7'), 'w7'); assert.equal(normOsm('123'), null);
  const csv = parseFile('insp.csv', `case_id,GERS,lat,lon,status\nC-1,${GA.toUpperCase()},${A.lat},${A.lon},major\nC-2,,${Bp.lat},${Bp.lon},minor\nC-3,,,,none\n`);
  assert.equal(csv.rows.length, 3);
  assert.deepEqual([csv.rows[0].gers, csv.rows[0].lon, csv.rows[1].gers, csv.rows[2].lat], [GA, A.lon, null, null]);
  const gj = parseFile('d.geojson', JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { osm_id: 'way/275267363', damage: 'roof' }, geometry: { type: 'Polygon', coordinates: [[...square(A.lon, A.lat, 0.00005), square(A.lon, A.lat, 0.00005)[0]]] } }] }));
  assert.equal(gj.format, 'geojson'); assert.equal(gj.rows[0].osm, 'w275267363'); assert.ok(Math.abs(gj.rows[0].lon! - A.lon) < 2e-5);
  assert.ok(parseFile('x.csv', 'a,b\n1,2\n').problems.length, 'no way to place the rows is reported');
});

test('rows join by GERS id, then OSM id, then point; the batch is valid', async () => {
  const csv = parseFile('Inspecciones mayo.csv', `case_id,gers,osm,lat,lon,status\nC-1,${GA},,${A.lat + 0.001},${A.lon},major\nC-2,,w275267363,${A.lat},${A.lon + 0.0002},minor\nC-3,,,${Bp.lat},${Bp.lon},roof tarp\nC-4,,,18.0,-66.6,far\nC-5,,,,,nowhere\n`);
  let loads = 0;
  const { batch, counts } = await joinRows('Inspecciones mayo.csv', csv, async (x, y) => { loads++; return x === T.x && y === T.y ? decodeTile(BUF, x, y, IDS) : []; });
  // C-1: its id, although its point is 110 m off; C-2: its OSM id; C-3: the building at its point; C-4: no building
  // in its tile; C-5: no position at all
  assert.deepEqual({ ...counts, tiles: 0 }, { rows: 5, gers: 1, osm: 1, point: 1, unmatched: 2, noPosition: 1, structures: 2, tiles: 0 });
  assert.equal(loads, 2, 'each tile loaded once');
  assert.deepEqual(validateBatch(batch, ontology).filter((p) => p.level === 'error'), []);
});

test('GERS beats a far point when the tile is the same; Forget removes everything the file wrote', async () => {
  const csv = parseFile('f.csv', `gers,lat,lon,status\n${GA},${Bp.lat},${Bp.lon},major\n`);
  const { batch, counts } = await joinRows('f.csv', csv, async (x, y) => decodeTile(BUF, x, y, IDS));
  assert.equal(counts.gers, 1, 'matched by id although the point is on the other building');
  const store = await openNodeStore({ ontology });
  await store.ingest(batch);
  const s = await store.getObject(`structure:${GA}`);
  assert.equal(s?.props?.records ?? s?.allProps.find((p) => p.key === 'records')?.value, 1);
  assert.equal((await store.getLinks(`structure:${GA}`, { direction: 'in' })).length, 1);
  const r = await store.forgetSource('local_file');
  assert.deepEqual([r.objects, await store.getObject(`structure:${GA}`), (await store.query("SELECT COUNT(*) AS n FROM prop WHERE source_id = 'local_file'"))[0].n], [2, null, 0]);
});
