// The store against recorded payloads from the live services (tests/fixtures). The mappers here are deliberately
// tiny and local: the real ones live in src/feeds and are tested there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openNodeStore } from '../src/ontology/node.ts';
import { SCHEMA_DOC } from '../src/ontology/schema.ts';
import { validateBatch } from '../src/ontology/validate.ts';
import { SAVED_QUERIES } from '../src/ui/saved-queries.ts';
import { assertReadOnly, capabilities, fold, housekeeping, ingest, timed, readCarryOver, writeCarryOver } from '../src/ontology/engine.ts';
import type { IngestBatch, ObjectInput, Ontology } from '../src/ontology/types.ts';

const json = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const ontology: Ontology = json('../src/ontology/ontology.json');
const quakes = json('./fixtures/usgs_quakes_30d.json');
const waterLevel = json('./fixtures/coops_wl_9755371.json');
const zones = json('./fixtures/nws_zones_forecast_pr.json');
const adsb = json('./fixtures/adsb_lol.json');

const FETCHED = quakes.metadata.generated as number;

function quakeObject(f: any): ObjectInput {
  const p = f.properties;
  const others = String(p.ids).split(',').filter((x: string) => x && x !== f.id);
  return {
    type: 'earthquake', key: f.id, name: p.title, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
    status: p.status, severity: p.mag >= 6 ? 4 : p.mag >= 5 ? 3 : p.mag >= 4 ? 2 : p.mag >= 3 ? 1 : 0,
    validFrom: p.time, text: p.place,
    identities: others.map((id: string) => ['usgs:eventid', id] as [string, string]),
    props: { magnitude: { value: p.mag, observedAt: p.updated }, depth_km: f.geometry.coordinates[2], place: p.place, mag_type: p.magType, tsunami: p.tsunami === 1, network: p.net, url: p.url },
  };
}
function quakeBatch(features: any[] = quakes.features, extra: Partial<IngestBatch> = {}): IngestBatch {
  return { source: 'usgs_quakes', fetchedAt: FETCHED, objects: features.map(quakeObject), ...extra };
}
// Census GEOIDs and names of five municipios; coordinates are the town centres.
const MUNICIPIOS: [string, string, number, number][] = [
  ['72097', 'Mayagüez', -67.1397, 18.2011], ['72029', 'Canóvanas', -65.9014, 18.3783], ['72127', 'San Juan', -66.1057, 18.4655],
  ['72083', 'Las Marías', -66.9921, 18.2514], ['72001', 'Adjuntas', -66.7224, 18.1627],
];
function placesBatch(): IngestBatch {
  return {
    source: 'census_tiger', fetchedAt: FETCHED,
    objects: [
      ...MUNICIPIOS.map(([key, name, lon, lat]): ObjectInput => ({ type: 'municipio', key, name, lon, lat })),
      ...zones.features.map((f: any): ObjectInput => ({ type: 'forecast_zone', key: f.properties.id, name: f.properties.name, props: { zone_type: f.properties.type } })),
      { type: 'tide_station', key: waterLevel.metadata.id, name: waterLevel.metadata.name, lon: +waterLevel.metadata.lon, lat: +waterLevel.metadata.lat },
    ],
    links: [
      { src: 'municipio:72127', type: 'part_of', dst: 'forecast_zone:PRZ001' },
      { src: 'municipio:72097', type: 'part_of', dst: 'forecast_zone:PRZ010' },
      { src: `tide_station:${waterLevel.metadata.id}`, type: 'monitors', dst: 'municipio:72127', confidence: 1, note: 'station is in San Juan Bay' },
    ],
  };
}
const open = () => openNodeStore({ ontology, seedVersion: 'test' });

test('schema: tables, documented, ontology mirrored as rows', async () => {
  const s = await open();
  const names = (await s.query<{ name: string }>(`SELECT name FROM sqlite_master WHERE type IN ('table', 'view')`)).map((r) => r.name);
  for (const t of Object.keys(SCHEMA_DOC)) assert.ok(names.includes(t), `missing ${t}`);
  assert.equal((await s.query('SELECT * FROM schema_doc')).length, Object.keys(SCHEMA_DOC).length);
  assert.deepEqual(capabilities(s.db), { fts: true, rtree: true });
  const [{ n }] = await s.query<{ n: number }>('SELECT COUNT(*) AS n FROM object_type');
  assert.equal(n, ontology.objectTypes.length);
  const joined = await s.query(`SELECT d.key, d.unit, t.label_es FROM prop_def d JOIN object_type t ON t.id = d.type WHERE d.type = 'municipio' AND d.is_primary = 1`);
  assert.ok(joined.length >= 3);
  assert.equal((await s.query('SELECT * FROM source')).length, ontology.sources.length);
  const info = await s.ready;
  assert.equal(info.persistent, false);
  assert.equal(info.seedVersion, 'test');
  s.close();
});

test('ingest: create, idempotent re-ingest, update', async () => {
  const s = await open();
  const batch = quakeBatch();
  assert.deepEqual(validateBatch(batch, ontology).filter((p) => p.level === 'error'), []);
  const first = await s.ingest(batch);
  assert.equal(first.objects, quakes.features.length);
  assert.equal(first.created, quakes.features.length);
  assert.equal(first.changed, 0);

  const again = await s.ingest(batch);
  assert.equal(again.created, 0);
  assert.equal(again.changed, 0);
  assert.equal((await s.countByType()).earthquake, quakes.features.length);
  assert.equal((await s.query('SELECT * FROM prop_history')).length, 0);

  // USGS revises events: the same event comes back later with another status.
  const f = structuredClone(quakes.features[0]);
  f.properties.status = f.properties.status === 'reviewed' ? 'automatic' : 'reviewed';
  const upd = await s.ingest({ ...quakeBatch([f]), fetchedAt: FETCHED + 60000 });
  assert.deepEqual([upd.created, upd.changed], [0, 1]);
  const o = await s.getObject(`earthquake:${f.id}`);
  assert.equal(o!.status, f.properties.status);
  assert.equal(o!.updatedAt, FETCHED + 60000);
  assert.equal(o!.firstSeen, FETCHED);
  assert.equal(o!.source, 'usgs_quakes');
  assert.equal(o!.props!.magnitude, f.properties.mag);
  assert.equal(o!.props!.tsunami, false);
  assert.equal(o!.validFrom, f.properties.time);

  const runs = await s.query<any>(`SELECT status, objects, created FROM ingest_run WHERE source_id = 'usgs_quakes' ORDER BY id`);
  assert.equal(runs.length, 3);
  assert.deepEqual([runs[0].status, runs[0].created, runs[2].objects], ['ok', quakes.features.length, 1]);

  await assert.rejects(s.ingest({ source: 'no_such_source', fetchedAt: FETCHED, objects: [] }), /unknown source/);
  s.close();
});

test('identity: two sources naming one event by different ids merge into one object', async () => {
  const s = await open();
  const f = quakes.features.find((x: any) => String(x.properties.ids).split(',').filter(Boolean).length > 1);
  const otherId = String(f.properties.ids).split(',').filter((x: string) => x && x !== f.id)[0];
  await s.ingest(quakeBatch([f]));
  // The national network's feed knows the same event only by its own id.
  const r = await s.ingest({
    source: 'garita_derived', fetchedAt: FETCHED + 1000,
    objects: [{ type: 'earthquake', key: otherId, props: { felt_reports: f.properties.felt ?? 0 } }],
    obs: [],
    links: [{ src: `earthquake:${otherId}`, type: 'same_as', dst: `earthquake:${f.id}` }],
  });
  assert.deepEqual([r.created, r.changed], [0, 1]);
  assert.equal((await s.countByType()).earthquake, 1);
  const o = await s.getObject(`earthquake:${otherId}`);
  assert.equal(o!.id, `earthquake:${f.id}`, 'the alias resolves to the canonical object');
  assert.equal(o!.name, f.properties.title, 'a source without a name does not erase the name');
  assert.deepEqual(o!.identities.map((i) => i.key).sort(), [f.id, otherId].sort());
  assert.deepEqual([...new Set(o!.allProps.map((p) => p.source))].sort(), ['garita_derived', 'usgs_quakes']);
  const [link] = await s.getLinks(`earthquake:${f.id}`, { type: 'same_as', direction: 'out' });
  assert.equal(link.src, `earthquake:${f.id}`, 'link endpoints are rewritten to the canonical id');

  // The reverse order: an object first known by an alias only, then by its canonical key plus that alias.
  const g = quakes.features.filter((x: any) => String(x.properties.ids).split(',').filter(Boolean).length > 1)[1];
  const gOther = String(g.properties.ids).split(',').filter((x: string) => x && x !== g.id)[0];
  await s.ingest({ source: 'garita_derived', fetchedAt: FETCHED, objects: [{ type: 'earthquake', key: gOther, name: g.properties.title }] });
  await s.ingest(quakeBatch([g]));
  assert.equal((await s.countByType()).earthquake, 2);
  assert.equal((await s.getObject(`earthquake:${g.id}`))!.id, `earthquake:${gOther}`);
  s.close();
});

test('properties: sources disagree, prop_best picks the newest, a user value wins, history is kept', async () => {
  const s = await open();
  const f = quakes.features.find((x: any) => Number(x.properties.mag.toFixed(1)) !== x.properties.mag);
  const id = `earthquake:${f.id}`;
  const rounded = Number(f.properties.mag.toFixed(1)); // the magnitude as printed in the event title
  await s.ingest(quakeBatch([f]));
  await s.ingest({ source: 'garita_derived', fetchedAt: FETCHED, observedAt: f.properties.updated + 1000, objects: [{ type: 'earthquake', key: f.id, props: { magnitude: rounded } }] });

  let o = (await s.getObject(id))!;
  const mags = o.allProps.filter((p) => p.key === 'magnitude');
  assert.equal(mags.length, 2);
  assert.deepEqual(mags.map((p) => p.source), ['garita_derived', 'usgs_quakes'], 'newest first within a key');
  assert.equal(mags[0].unit ?? null, ontology.objectTypes.find((t) => t.id === 'earthquake')!.properties.find((p) => p.id === 'magnitude')!.unit ?? null);
  assert.equal(o.props!.magnitude, rounded);
  let best = await s.query<any>(`SELECT value, source_id FROM prop_best WHERE object_id = ? AND key = 'magnitude'`, [id]);
  assert.deepEqual(best, [{ value: rounded, source_id: 'garita_derived' }]);

  // The original source revises its own value: the old one goes to history, and being newer it becomes best.
  const revised = structuredClone(f);
  revised.properties.mag = rounded;
  revised.properties.updated = f.properties.updated + 5000;
  const r = await s.ingest({ ...quakeBatch([revised]), fetchedAt: FETCHED + 5000 });
  assert.equal(r.changed, 1);
  const hist = await s.query<any>(`SELECT value, source_id, observed_at, replaced_at FROM prop_history WHERE object_id = ?`, [id]);
  assert.deepEqual(hist, [{ value: f.properties.mag, source_id: 'usgs_quakes', observed_at: f.properties.updated, replaced_at: FETCHED + 5000 }]);
  best = await s.query<any>(`SELECT source_id FROM prop_best WHERE object_id = ? AND key = 'magnitude'`, [id]);
  assert.equal(best[0].source_id, 'usgs_quakes');

  // A stale reading arriving late does not overwrite the newer one.
  await s.ingest({ ...quakeBatch([f]), fetchedAt: FETCHED + 6000 });
  assert.equal((await s.query<any>(`SELECT value FROM prop WHERE object_id = ? AND key = 'magnitude' AND source_id = 'usgs_quakes'`, [id]))[0].value, rounded);

  // annotate(): source 'user', audit row, and the user value outranks newer machine values.
  const events: any[] = [];
  const off = s.onChange((e) => events.push(e));
  await s.annotate(id, 'status_text', 'felt in Mayagüez', 'phone report');
  await s.annotate(id, 'magnitude', f.properties.mag);
  off();
  assert.deepEqual(events.map((e) => [e.source, e.types]), [['user', ['earthquake']], ['user', ['earthquake']]]);
  o = (await s.getObject(id))!;
  assert.equal(o.props!.magnitude, f.properties.mag);
  assert.equal(o.props!.status_text, 'felt in Mayagüez');
  assert.equal(o.allProps.find((p) => p.key === 'status_text')!.source, 'user');
  const log = await s.actionLog();
  assert.equal(log.length, 2);
  assert.deepEqual([log[1].action, log[1].objectId, log[1].payload.key, log[1].payload.value, log[1].payload.note], ['annotate', id, 'status_text', 'felt in Mayagüez', 'phone report']);
  await assert.rejects(s.annotate('earthquake:does-not-exist', 'magnitude', 1), /no object/);
  s.close();
});

test('replaceTypes: absent objects expire, hidden by default, and revive when reported again', async () => {
  const s = await open();
  const all = quakes.features.slice(0, 10);
  await s.ingest(quakeBatch(all, { replaceTypes: ['earthquake'] }));
  await s.ingest(placesBatch());
  const events: any[] = [];
  s.onChange((e) => events.push(e));
  const r = await s.ingest({ ...quakeBatch(all.slice(0, 7), { replaceTypes: ['earthquake'] }), fetchedAt: FETCHED + 1000 });
  assert.equal(r.expired, 3);
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].source, events[0].types, events[0].result.expired], ['usgs_quakes', ['earthquake'], 3]);
  assert.equal((await s.listObjects('earthquake')).length, 7);
  assert.equal((await s.listObjects('earthquake', { includeExpired: true })).length, 10);
  assert.equal((await s.listObjects('municipio')).length, MUNICIPIOS.length, 'other sources and types are untouched');
  const gone = (await s.getObject(`earthquake:${all[9].id}`))!;
  assert.equal(gone.status, 'expired');
  assert.ok(gone.validTo! > 0);
  assert.equal((await s.search(all[9].properties.title)).filter((o) => o.id === gone.id).length, 0);
  assert.equal((await s.countByType()).earthquake, 7);

  const back = await s.ingest({ ...quakeBatch(all, { replaceTypes: ['earthquake'] }), fetchedAt: FETCHED + 2000 });
  assert.deepEqual([back.expired, back.created, back.changed], [0, 0, 3]);
  const revived = (await s.getObject(`earthquake:${all[9].id}`))!;
  assert.equal(revived.status, all[9].properties.status);
  assert.equal(revived.validTo, null);
  assert.equal((await s.listObjects('earthquake')).length, 10);
  s.close();
});

test('links: both directions with joined names, and a neighbourhood two hops out', async () => {
  const s = await open();
  await s.ingest(placesBatch());
  const station = `tide_station:${waterLevel.metadata.id}`;
  const out = await s.getLinks(station, { direction: 'out' });
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].type, out[0].dst, out[0].dstName, out[0].dstType, out[0].srcName, out[0].source, out[0].note],
    ['monitors', 'municipio:72127', 'San Juan', 'municipio', waterLevel.metadata.name, 'census_tiger', 'station is in San Juan Bay']);
  assert.equal((await s.getLinks(station, { direction: 'in' })).length, 0);
  const both = await s.getLinks('municipio:72127');
  assert.deepEqual(both.map((l) => `${l.src}>${l.type}>${l.dst}`).sort(), ['municipio:72127>part_of>forecast_zone:PRZ001', `${station}>monitors>municipio:72127`]);
  assert.equal((await s.getLinks('municipio:72127', { type: 'part_of' })).length, 1);
  assert.equal((await s.getLinks('municipio:72127', { direction: 'in' }))[0].srcType, 'tide_station');

  const one = await s.neighborhood(station, { depth: 1 });
  assert.deepEqual(one.nodes.map((n) => n.id).sort(), ['municipio:72127', station].sort());
  const two = await s.neighborhood(station, { depth: 2 });
  assert.equal(two.nodes[0].id, station);
  assert.deepEqual(two.nodes.map((n) => n.id).sort(), ['forecast_zone:PRZ001', 'municipio:72127', station].sort());
  assert.equal(two.links.length, 2);
  assert.equal(two.nodes.find((n) => n.id === 'forecast_zone:PRZ001')!.props!.zone_type, 'public');
  const onlyMonitors = await s.neighborhood(station, { depth: 2, linkTypes: ['monitors'] });
  assert.equal(onlyMonitors.nodes.length, 2);
  s.close();
});

test('search: accent-insensitive, prefix, by key, by type', async () => {
  const s = await open();
  await s.ingest(placesBatch());
  await s.ingest(quakeBatch());
  assert.equal(fold('Mayagüez Canóvanas'), 'mayaguez canovanas');
  assert.equal((await s.search('Mayaguez', { types: ['municipio'] }))[0].name, 'Mayagüez');
  assert.equal((await s.search('Mayaguez'))[0].name, 'Mayagüez', 'the exact name ranks above longer matches');
  assert.equal((await s.search('Canovanas'))[0].name, 'Canóvanas');
  assert.equal((await s.search('CANÓVANAS'))[0].id, 'municipio:72029');
  assert.equal((await s.search('canov'))[0].id, 'municipio:72029');
  assert.equal((await s.search('las marias', { types: ['municipio'] }))[0].id, 'municipio:72083');
  assert.equal((await s.search('72127'))[0].id, 'municipio:72127');
  assert.ok((await s.search('san juan')).some((o) => o.type === 'tide_station'));
  const q0 = quakes.features[0];
  assert.ok((await s.search(q0.id)).some((o) => o.id === `earthquake:${q0.id}`));
  const hits = await s.search('earthquake', { limit: 5 });
  assert.equal(hits.length, 5);
  assert.ok(hits.every((o) => o.type === 'earthquake' && typeof o.props!.magnitude === 'number'));
  assert.deepEqual(await s.search('   '), []);
  assert.deepEqual(await s.search('"; DROP TABLE object; --'), []);
  s.close();
});

test('listObjects: bbox, where filters, orderBy on a property, flattened props', async () => {
  const s = await open();
  await s.ingest(quakeBatch());
  await s.ingest(placesBatch());
  const fs = quakes.features as any[];
  const bbox: [number, number, number, number] = [-67.3, 17.8, -66.5, 18.6];
  const inBox = fs.filter((f) => f.geometry.coordinates[0] >= bbox[0] && f.geometry.coordinates[0] <= bbox[2] && f.geometry.coordinates[1] >= bbox[1] && f.geometry.coordinates[1] <= bbox[3]);
  assert.ok(inBox.length > 0 && inBox.length < fs.length);
  const got = await s.listObjects('earthquake', { bbox });
  assert.deepEqual(got.map((o) => o.key).sort(), inBox.map((f) => f.id).sort());
  assert.deepEqual((await s.listObjects(['earthquake', 'municipio'], { bbox })).filter((o) => o.type === 'municipio').map((o) => o.name).sort(), ['Adjuntas', 'Las Marías', 'Mayagüez']);

  const strong = fs.filter((f) => f.properties.mag > 3).sort((a, b) => b.properties.mag - a.properties.mag);
  const list = await s.listObjects('earthquake', { where: { magnitude: ['>', 3] }, orderBy: '-magnitude', limit: 500 });
  assert.equal(list.length, strong.length);
  assert.deepEqual(list.map((o) => o.props!.magnitude), strong.map((f) => f.properties.mag));
  assert.ok('depth_km' in list[0].props! && 'place' in list[0].props!, 'primary properties are flattened by default');

  const asc = await s.listObjects('earthquake', { orderBy: 'magnitude', limit: 3, props: ['magnitude', 'network'] });
  assert.equal(asc[0].props!.magnitude, Math.min(...fs.map((f) => f.properties.mag)));
  assert.deepEqual(Object.keys(asc[0].props!).sort(), ['magnitude', 'network']);

  const net = fs.filter((f) => f.properties.net === 'us');
  assert.equal((await s.listObjects('earthquake', { where: { network: 'us' } })).length, net.length);
  assert.equal((await s.listObjects('earthquake', { where: { network: ['!=', 'us'], tsunami: false, place: ['like', '%Puerto Rico%'] } })).length,
    fs.filter((f) => f.properties.net !== 'us' && f.properties.tsunami !== 1 && /Puerto Rico/i.test(f.properties.place)).length);
  const reviewed = fs.filter((f) => f.properties.status === 'reviewed').length;
  assert.equal((await s.listObjects('earthquake', { status: 'reviewed' })).length, reviewed);
  assert.equal((await s.listObjects('earthquake', { where: { status: 'reviewed', severity: ['>=', 1] } })).length, fs.filter((f) => f.properties.status === 'reviewed' && f.properties.mag >= 3).length);
  const byName = await s.listObjects('municipio');
  assert.deepEqual(byName.map((o) => o.name), ['Adjuntas', 'Canóvanas', 'Las Marías', 'Mayagüez', 'San Juan']);
  assert.equal((await s.listObjects('earthquake', { orderBy: '-updatedAt', limit: 2 })).length, 2);
  s.close();
});

test('series: range and min/max-preserving downsampling', async () => {
  const s = await open();
  await s.ingest(placesBatch());
  const id = `tide_station:${waterLevel.metadata.id}`;
  const pts = waterLevel.data.filter((d: any) => d.v !== '').map((d: any) => ({ object: id, metric: 'water_level_m', t: Date.parse(d.t.replace(' ', 'T') + ':00Z'), value: +d.v }));
  const r = await s.ingest({ source: 'coops', fetchedAt: FETCHED, obs: pts });
  assert.equal(r.obs, pts.length);
  await s.ingest({ source: 'coops', fetchedAt: FETCHED, obs: pts.slice(-10) });
  const full = await s.series(id, 'water_level_m');
  assert.equal(full.t.length, pts.length, 're-sent readings replace, not duplicate');
  assert.deepEqual([full.t[0], full.v[0]], [pts[0].t, pts[0].value]);
  assert.ok(full.t.every((t, i) => i === 0 || t > full.t[i - 1]));

  const small = await s.series(id, 'water_level_m', { maxPoints: 100 });
  assert.ok(small.t.length <= 100 && small.t.length >= 50, `got ${small.t.length}`);
  assert.equal(Math.max(...small.v), Math.max(...full.v), 'the highest water survives');
  assert.equal(Math.min(...small.v), Math.min(...full.v));
  assert.ok(small.t.every((t, i) => i === 0 || t > small.t[i - 1]));

  const mid = pts[Math.floor(pts.length / 2)].t;
  const tail = await s.series(id, 'water_level_m', { since: mid });
  assert.equal(tail.t.length, pts.filter((p: any) => p.t >= mid).length);
  assert.deepEqual((await s.series(id, 'predicted_m')).t, []);
  assert.deepEqual((await s.getObject(id))!.metrics, ['water_level_m']);
  assert.equal((await s.ready).obs, 0, 'ready reports the state at open');
  s.close();
});

test('query(): read-only guard and row cap', async () => {
  const s = await open();
  await s.ingest(quakeBatch());
  assert.equal((await s.query<any>('SELECT COUNT(*) AS n FROM object WHERE type = ?', ['earthquake']))[0].n, quakes.features.length);
  assert.ok((await s.query(`WITH big AS (SELECT object_id FROM prop_best WHERE key = 'magnitude' AND value > 3) SELECT o.name FROM object o JOIN big ON big.object_id = o.id;`)).length > 0);
  assert.ok((await s.query('PRAGMA table_info(object)')).some((c: any) => c.name === 'updated_at'));
  assert.ok((await s.query('EXPLAIN QUERY PLAN SELECT * FROM object WHERE id = ?', ['x'])).length > 0);
  assert.ok((await s.query(`SELECT replace(name, ';', ',') AS n, 'update x set; delete from' AS s FROM object LIMIT 1`)).length === 1, 'keywords inside literals are fine');
  for (const bad of [
    'DELETE FROM object', 'UPDATE object SET name = 1', `INSERT INTO meta VALUES ('a', 'b')`, 'DROP TABLE object', 'CREATE TABLE x (a)',
    'SELECT 1; DELETE FROM object', 'SELECT 1; SELECT 2', 'PRAGMA journal_mode = DELETE', 'PRAGMA writable_schema = 1', 'VACUUM', `ATTACH 'x' AS y`,
    'WITH d AS (SELECT 1) DELETE FROM object', 'WITH d AS (SELECT 1) INSERT INTO meta SELECT 1, 2', '  -- hi\n DELETE FROM object', '/* x */ REPLACE INTO meta VALUES (1, 2)', '',
  ]) {
    await assert.rejects(s.query(bad), /query:/, bad);
  }
  assert.throws(() => assertReadOnly('BEGIN'));
  // an apostrophe in a comment is not a string, and '--' inside a string is not a comment
  assert.doesNotThrow(() => assertReadOnly("-- FEMA's records, the shelter's point\nSELECT '--' AS a, 'it''s' AS b"));
  assert.throws(() => assertReadOnly("-- it's\nDELETE FROM object"));
  for (const q of SAVED_QUERIES) assert.doesNotThrow(() => assertReadOnly(q.sql), q.id);
  assert.equal((await s.countByType()).earthquake, quakes.features.length, 'nothing was written');
  const many = await s.query('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 20000) SELECT x FROM c');
  assert.equal(many.length, 5000);
  s.close();
});

test('lineage: sources() reports last run, failures and counts', async () => {
  const s = await open();
  await s.ingest(quakeBatch(undefined, { bytes: 191074 }));
  await s.reportRun('nws_alerts', 'error', 'HTTP 503', 0);
  const src = await s.sources();
  assert.equal(src.length, ontology.sources.length);
  const q = src.find((x) => x.source.id === 'usgs_quakes')!;
  assert.equal(q.objectCount, quakes.features.length);
  assert.deepEqual([q.lastRun!.objects, q.lastRun!.bytes], [quakes.features.length, 191074]);
  assert.ok(['ok', 'stale'].includes(q.lastRun!.status));
  const a = src.find((x) => x.source.id === 'nws_alerts')!;
  assert.deepEqual([a.lastRun!.status, a.lastRun!.note, a.objectCount], ['error', 'HTTP 503', 0]);
  assert.equal(src.find((x) => x.source.id === 'osm')!.lastRun, undefined);
  s.close();
});

test('export, reopen from bytes, housekeeping and version carry-over', async () => {
  const s = await open();
  const now = Date.now();
  await s.ingest(placesBatch());
  const id = `tide_station:${waterLevel.metadata.id}`;
  await s.ingest({ source: 'coops', fetchedAt: now, obs: [
    { object: id, metric: 'water_level_m', t: now - 20 * 86400000, value: 0.1 }, { object: id, metric: 'water_level_m', t: now - 10 * 86400000, value: 0.2 },
    { object: id, metric: 'water_level_m', t: now - 3600000, value: 0.3 },
  ] });
  // An ephemeral object (an aircraft from the recorded ADS-B payload) that its source stopped reporting three days ago.
  const ac = adsb.ac.find((a: any) => a.hex && a.lat != null && a.lon != null);
  const acId = `aircraft:${ac.hex}`;
  const then = now - 3 * 86400000;
  ingest(s.db, ontology, { source: 'adsb', fetchedAt: then, objects: [{ type: 'aircraft', key: ac.hex, name: String(ac.flight ?? ac.hex).trim(), lon: ac.lon, lat: ac.lat, props: { callsign: String(ac.flight ?? '').trim() } }] }, then);
  assert.equal(ingest(s.db, ontology, { source: 'adsb', fetchedAt: then, objects: [], replaceTypes: ['aircraft'] }, then).expired, 1);
  await s.annotate('municipio:72127', 'shelters', 12, 'count from the field');
  s.execRaw('VACUUM; ANALYZE;');
  const bytes = s.exportBytes();
  assert.ok(bytes.byteLength > 50000);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 15)), 'SQLite format 3');

  const again = await openNodeStore({ ontology, bytes });
  assert.equal((await again.ready).objects, (await s.query<any>('SELECT COUNT(*) AS n FROM object'))[0].n);
  assert.equal((await again.search('Mayaguez'))[0].name, 'Mayagüez', 'FTS rows survive VACUUM and export');
  assert.equal((await again.listObjects('municipio', { bbox: [-67.3, 18.1, -67.0, 18.3] }))[0].name, 'Mayagüez', 'R*Tree rows too');
  assert.equal((await again.getObject('municipio:72127'))!.props!.shelters, 12);

  const hk = housekeeping(again.db, ontology, now);
  assert.deepEqual(hk, { obs: 1, objects: 1 });
  assert.equal(await again.getObject(acId), null);
  assert.equal((await again.query('SELECT * FROM prop WHERE object_id = ?', [acId])).length, 0);
  assert.equal((await again.series(id, 'water_level_m')).t.length, 2);

  // A new seed version: the audit log, user values and the last week of observations move over.
  const next = await openNodeStore({ ontology, seedVersion: 'next' });
  await next.ingest(placesBatch());
  writeCarryOver(next.db, readCarryOver(again.db, now));
  assert.equal((await next.actionLog()).length, 1);
  assert.equal((await next.getObject('municipio:72127'))!.props!.shelters, 12);
  assert.equal((await next.series(id, 'water_level_m')).t.length, 1);
  for (const st of [s, again, next]) st.close();
});

test('summaries carry event times; requested props are flattened in one pass', async () => {
  const s = await open();
  await s.ingest(quakeBatch());
  const f = quakes.features[0];
  const [hit] = await s.listObjects('earthquake', { where: { key: f.id }, props: ['magnitude', 'network', 'felt_reports'] });
  assert.equal(hit.validFrom, f.properties.time);
  assert.equal(hit.validTo, null);
  assert.deepEqual(hit.props, { magnitude: f.properties.mag, network: f.properties.net }, 'only requested keys that have a value');
  const found = (await s.search(f.id)).find((o) => o.key === f.id)!;
  assert.equal(found.validFrom, f.properties.time);
  const newest = await s.listObjects('earthquake', { orderBy: '-validFrom', limit: 1 });
  assert.equal(newest[0].validFrom, Math.max(...quakes.features.map((x: any) => x.properties.time)));
  s.close();
});

test('views for the SQL console: object_props and link_named, still read-only', async () => {
  const s = await open();
  await s.ingest(quakeBatch());
  await s.ingest(placesBatch());
  const strongest = [...quakes.features].sort((a: any, b: any) => b.properties.mag - a.properties.mag)[0];
  const top = await s.query<any>(`SELECT object_id, type, name, key, value, unit, source_id, observed_at FROM object_props WHERE key = 'magnitude' ORDER BY value DESC LIMIT 1`);
  assert.deepEqual([top[0].type, top[0].value, top[0].source_id, top[0].observed_at], ['earthquake', strongest.properties.mag, 'usgs_quakes', strongest.properties.updated]);
  assert.equal((await s.query<any>(`SELECT COUNT(*) AS n FROM object_props WHERE type = 'earthquake' AND key = 'magnitude'`))[0].n, quakes.features.length);
  const named = await s.query<any>(`SELECT * FROM link_named WHERE type = 'monitors'`);
  assert.deepEqual(named.map((l) => [l.src_name, l.src_type, l.type, l.dst, l.dst_name, l.dst_type, l.source_id, l.confidence]),
    [[waterLevel.metadata.name, 'tide_station', 'monitors', 'municipio:72127', 'San Juan', 'municipio', 'census_tiger', 1]]);
  const doc = await s.query<any>(`SELECT name FROM schema_doc WHERE name IN ('object_props', 'link_named', 'prop_best')`);
  assert.equal(doc.length, 3);
  for (const bad of ['DELETE FROM object_props', 'DROP VIEW link_named', `UPDATE link_named SET src_name = 'x'`, 'CREATE VIEW v AS SELECT 1']) await assert.rejects(s.query(bad), /query:/, bad);
  s.close();
});

test('sources(): dataAt and the last five runs', async () => {
  const s = await open();
  await s.ingest(placesBatch());
  const id = `tide_station:${waterLevel.metadata.id}`;
  const newestQuakeUpdate = Math.max(...quakes.features.map((x: any) => x.properties.updated));
  await s.ingest(quakeBatch());
  for (let i = 1; i <= 6; i++) await s.ingest({ source: 'coops', fetchedAt: FETCHED + i * 360000, obs: [
    { object: id, metric: 'water_level_m', t: FETCHED + i * 360000 - 1000, value: 0.1 * i },
    // A prediction for tomorrow is not evidence of fresh data.
    { object: id, metric: 'predicted_m', t: FETCHED + 86400000, value: 0.2 },
  ] });
  await s.reportRun('coops', 'error', 'HTTP 502');
  const src = await s.sources();
  const coops = src.find((x) => x.source.id === 'coops')!;
  assert.equal(coops.dataAt, FETCHED + 6 * 360000 - 1000);
  assert.equal(coops.runs!.length, 5);
  assert.deepEqual([coops.runs![0].status, coops.runs![0].note, coops.runs![1].status, coops.runs![1].obs], ['error', 'HTTP 502', 'ok', 2]);
  assert.ok(coops.runs!.every((r, i) => i === 0 || r.finishedAt <= coops.runs![i - 1].finishedAt || coops.runs![i - 1].status === 'error'));
  const q = src.find((x) => x.source.id === 'usgs_quakes')!;
  assert.equal(q.dataAt, Math.max(newestQuakeUpdate, FETCHED), 'newest property observation');
  assert.equal(q.runs!.length, 1);
  const untouched = src.find((x) => x.source.id === 'osm')!;
  assert.deepEqual([untouched.dataAt, untouched.runs], [null, []]);
  s.close();
});

test('compact storage: canonical ids are not repeated in identity; an older database is upgraded in place', async () => {
  const s = await open();
  await s.ingest(quakeBatch());
  const aliases = quakes.features.reduce((n: number, f: any) => n + String(f.properties.ids).split(',').filter((x: string) => x && x !== f.id).length, 0);
  assert.equal((await s.query<any>('SELECT COUNT(*) AS n FROM identity'))[0].n, aliases);
  assert.equal((await s.query<any>('SELECT COUNT(*) AS n FROM prop_history'))[0].n, 0, 'first inserts leave no history');
  const o = (await s.getObject(`earthquake:${quakes.features[0].id}`))!;
  assert.ok(o.identities.some((i) => i.scheme === 'usgs:eventid' && i.key === quakes.features[0].id));

  // A file written before the views and ingest_run.data_at existed, with the canonical identity rows it used to hold.
  s.execRaw(`DROP VIEW object_props; DROP VIEW link_named; ALTER TABLE ingest_run DROP COLUMN data_at; DELETE FROM meta WHERE key IN ('schema_additions', 'ontology_sig');
    INSERT OR IGNORE INTO identity (scheme, key, type, object_id) SELECT 'usgs:eventid', key, type, id FROM object;`);
  const old = await openNodeStore({ ontology, bytes: s.exportBytes() });
  assert.equal((await old.query<any>(`SELECT COUNT(*) AS n FROM object_props WHERE key = 'magnitude'`))[0].n, quakes.features.length);
  const again = await old.ingest({ ...quakeBatch(), fetchedAt: FETCHED + 1000 });
  assert.deepEqual([again.created, again.changed], [0, 0]);
  assert.equal((await old.sources()).find((x) => x.source.id === 'usgs_quakes')!.runs!.length, 2);
  assert.equal((await old.getObject(`earthquake:${quakes.features[0].id}`))!.identities.filter((i) => i.key === quakes.features[0].id).length, 1);
  for (const st of [s, old]) st.close();
});

test('timed(): a step that never answers is given up on, a quick or synchronous one passes through', async () => {
  const t0 = Date.now();
  await assert.rejects(timed('installOpfsSAHPoolVfs', new Promise(() => {}), 150), /installOpfsSAHPoolVfs did not finish within 150 ms/);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(await timed('importDb', 42, 150), 42);
  assert.equal(await timed('open', Promise.resolve('ok'), 150), 'ok');
  await assert.rejects(timed('open', Promise.reject(new Error('no OPFS')), 150), /no OPFS/);
});
