// Stage 4a: FEMA National Flood Hazard Layer flood hazard zones for Puerto Rico.
// Source: https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28  where DFIRM_ID LIKE '72%'
// The object ids are listed once (returnIdsOnly, ordered by OBJECTID) and then fetched in pages of ids; a page that
// the server rejects or truncates is split in half and retried, so large geometries get through one at a time.
// Geometry is requested with maxAllowableOffset = 0.00002 deg (about 2 m) so the heaviest polygons stay
// transferable; that is far below the 10 m elevation grid and the size of a building.
// Downloads are appended to work/cache/nfhl/features.partial.jsonl so an interrupted run resumes.
// Also writes data/geo/nfhl_zones.geojson: classes 1-3 only, simplified for display.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { CACHE, log, writeOut, fetchRetry, pool, simplifyGeom, sleep } from './lib.mjs';

const LAYER = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28';
const WHERE = "DFIRM_ID LIKE '72%'";
const FIELDS = 'OBJECTID,FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE,DFIRM_ID';
const OFFSET = 0.00002;
const PAGE = Number(process.env.NFHL_PAGE || 40), CONC = 4;
const BUDGET_MS = Number(process.env.NFHL_BUDGET_MIN || 20) * 60000, T0 = Date.now();
const dir = path.join(CACHE, 'nfhl'); fs.mkdirSync(dir, { recursive: true });
const partial = path.join(dir, 'features.partial.jsonl'), final = path.join(dir, 'features.jsonl'), done = path.join(dir, 'complete.json');

function floodClass(zone, sub) {
  const z = String(zone || '').toUpperCase().trim();
  if (z === 'VE' || z === 'V' || /^V\d/.test(z)) return 3;
  if (z === 'A' || z === 'AE' || z === 'AH' || z === 'AO' || z === 'A99' || z === 'AR' || /^AR\//.test(z) || /^A\d/.test(z)) return 2;
  if (z === 'X' && /0\.2 ?PCT/i.test(String(sub || ''))) return 1;
  return 0;
}
// GET, not POST: since October 2026 the FEMA front end resets POSTed queries from the runner (ECONNRESET), while
// the same query as a GET answers. Pages of ids keep the URL short; POST stays as the fallback for a long one.
async function post(params, timeout = 240000, tries = 3) {
  const qs = new URLSearchParams(params).toString();
  const res = qs.length < 6000
    ? await fetchRetry(`${LAYER}/query?${qs}`, {}, { timeout, tries })
    : await fetchRetry(`${LAYER}/query`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: qs }, { timeout, tries });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { throw new Error('not JSON: ' + text.slice(0, 120)); }
  if (j.error) throw new Error('ArcGIS error ' + JSON.stringify(j.error).slice(0, 200));
  return j;
}

if (!(fs.existsSync(done) && fs.existsSync(final))) {
  const have = new Set();
  if (fs.existsSync(partial)) {
    const rl = readline.createInterface({ input: fs.createReadStream(partial), crlfDelay: Infinity });
    const good = [];
    for await (const l of rl) { try { const f = JSON.parse(l); const id = f.properties.OBJECTID; if (!have.has(id)) { have.add(id); good.push(l); } } catch { /* torn last line */ } }
    fs.writeFileSync(partial, good.length ? good.join('\n') + '\n' : '');
    log('NFHL resume: already have', have.size);
  }
  const count = (await post({ where: WHERE, returnCountOnly: 'true', f: 'json' })).count;
  const idsJ = await post({ where: WHERE, returnIdsOnly: 'true', orderByFields: 'OBJECTID', f: 'json' });
  const ids = (idsJ.objectIds || []).slice().sort((a, b) => a - b);
  log('NFHL count', count, 'ids', ids.length, 'oid field', idsJ.objectIdFieldName);
  const todo = ids.filter((id) => !have.has(id));
  const queue = []; for (let i = 0; i < todo.length; i += PAGE) queue.push(todo.slice(i, i + PAGE));
  const failed = []; let reqs = 0, outOfTime = false;
  const out = fs.openSync(partial, 'a');
  async function worker() {
    while (queue.length) {
      if (Date.now() - T0 > BUDGET_MS) { outOfTime = true; return; }
      const chunk = queue.shift();
      try {
        reqs++;
        const j = await post({ objectIds: chunk.join(','), outFields: FIELDS, outSR: '4326', returnGeometry: 'true', maxAllowableOffset: String(OFFSET), geometryPrecision: '6', f: 'geojson' }, 240000, chunk.length === 1 ? 3 : 2);
        const got = new Set(); let buf = '';
        for (const f of j.features || []) {
          const id = f.properties?.OBJECTID ?? f.id; if (id === undefined || have.has(id)) continue;
          f.properties.OBJECTID = id; have.add(id); got.add(id);
          buf += JSON.stringify({ type: 'Feature', properties: f.properties, geometry: f.geometry }) + '\n';
        }
        if (buf) fs.writeSync(out, buf);
        const missing = chunk.filter((id) => !got.has(id) && !have.has(id));
        if (missing.length) {
          if (!got.size && chunk.length === 1) failed.push(chunk[0]);
          else if (!got.size) { const h = Math.ceil(missing.length / 2); queue.push(missing.slice(0, h), missing.slice(h)); }
          else queue.push(missing);
        }
      } catch (e) {
        if (chunk.length === 1) { failed.push(chunk[0]); log('NFHL failed id', chunk[0], String(e.message || e).slice(0, 140)); }
        else { const h = Math.ceil(chunk.length / 2); queue.push(chunk.slice(0, h), chunk.slice(h)); if (reqs < 40 || reqs % 20 === 0) log('NFHL split', chunk.length, String(e.message || e).slice(0, 100)); await sleep(1500); }
      }
      if (reqs % 10 === 0) log('NFHL progress', have.size, '/', ids.length, 'requests', reqs, 'queue', queue.length, ((Date.now() - T0) / 1000).toFixed(0) + 's');
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  fs.closeSync(out);
  log('NFHL downloaded', have.size, '/', ids.length, 'failed', failed.length, 'requests', reqs, outOfTime ? '(time budget reached: will resume next run)' : '');
  if (!outOfTime && have.size + failed.length >= ids.length && failed.length <= ids.length * 0.01) {
    fs.copyFileSync(partial, final);
    fs.writeFileSync(done, JSON.stringify({ fetched: new Date().toISOString(), layer: LAYER, where: WHERE, server_count: count, ids: ids.length, features: have.size, failed_ids: failed, maxAllowableOffset_deg: OFFSET }));
  } else { log('NFHL incomplete; flood zones stay unattached this run'); process.exit(0); }
}

// ---- display file ----
const meta = JSON.parse(fs.readFileSync(done, 'utf8'));
const feats = []; const byClass = { 0: 0, 1: 0, 2: 0, 3: 0 };
{
  const rl = readline.createInterface({ input: fs.createReadStream(final), crlfDelay: Infinity });
  for await (const l of rl) { if (l.length < 3) continue; const f = JSON.parse(l); const c = floodClass(f.properties.FLD_ZONE, f.properties.ZONE_SUBTY); byClass[c]++; if (c > 0 && f.geometry) feats.push({ c, p: f.properties, g: f.geometry }); }
}
feats.sort((a, b) => a.c - b.c);
const MAX = 6_000_000; let tol = 0.00005, text, kept;
for (;;) {
  const fs2 = [];
  for (const f of feats) { const g = simplifyGeom(f.g, tol, 5, tol * tol); if (g) fs2.push({ type: 'Feature', properties: { class: f.c, FLD_ZONE: f.p.FLD_ZONE, SFHA_TF: f.p.SFHA_TF }, geometry: g }); }
  kept = fs2.length;
  text = JSON.stringify({ type: 'FeatureCollection', garita: { source: `${LAYER} (FEMA NFHL, S_FLD_HAZ_AR)`, where: WHERE, fetched: meta.fetched, server_count: meta.server_count, downloaded: meta.features, failed_ids: meta.failed_ids, classes: { 3: 'coastal high hazard (V, VE)', 2: '1 % annual chance (A, AE, AH, AO, A99, AR)', 1: '0.2 % annual chance (X, 0.2 PCT subtypes)' }, omitted: 'class 0 polygons (minimal hazard, open water, area not included) are not in this file', source_polygons_by_class: byClass, simplify_tolerance_deg: tol, simplify_tolerance_m: Math.round(tol * 110000), coord_decimals: 5, features: kept }, features: fs2 });
  log('nfhl_zones tolerance', tol.toFixed(6), 'features', kept, 'bytes', Buffer.byteLength(text));
  if (Buffer.byteLength(text) <= MAX || tol > 0.002) break;
  tol *= 1.5;
}
writeOut('data/geo/nfhl_zones.geojson', text);
log('NFHL display file', kept, 'features', Buffer.byteLength(text), 'bytes; polygons by class', JSON.stringify(byClass));
