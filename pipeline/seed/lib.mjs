// Shared helpers for the seed pipeline: polite fetching, ArcGIS/OpenFEMA paging, name normalisation.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const UA = 'garita (github.com/webgpu-demos/garita)';
const FIX = process.env.SEED_FIXTURES || '';
let fixIndex = null;
function fixtureFor(url) {
  if (!fixIndex) {
    fixIndex = new Map();
    for (const line of readFileSync(join(FIX, 'status.tsv'), 'utf8').split('\n')) { const c = line.split('\t'); if (c[4]) fixIndex.set(c[4], c[0]); }
  }
  const f = fixIndex.get(url);
  if (!f || !existsSync(join(FIX, f))) throw new Error(`no fixture for ${url}`);
  return readFileSync(join(FIX, f));
}

const hostBusy = new Map();
async function slot(host) {
  for (;;) { const n = hostBusy.get(host) || 0; if (n < 5) { hostBusy.set(host, n + 1); return; } await new Promise((r) => setTimeout(r, 40)); }
}
export const stats = { requests: 0, bytes: 0 };
export async function fetchBuf(url, opts = {}) {
  if (FIX) return fixtureFor(url);
  const host = new URL(url).host;
  const tries = opts.tries ?? 4;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    await slot(host);
    try {
      const res = await fetch(url, { method: opts.method || 'GET', body: opts.body, headers: { 'User-Agent': UA, Accept: opts.accept || 'application/json, */*', ...(opts.headers || {}) }, signal: AbortSignal.timeout(opts.timeout ?? 90000) });
      if (!res.ok) { const e = new Error(`HTTP ${res.status} ${url}`); e.status = res.status; throw e; }
      const buf = Buffer.from(await res.arrayBuffer());
      stats.requests++; stats.bytes += buf.length;
      return buf;
    } catch (e) {
      lastErr = e;
      if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 408) break;
      await new Promise((r) => setTimeout(r, 1500 * 2 ** i));
    } finally { hostBusy.set(host, (hostBusy.get(host) || 1) - 1); }
  }
  throw lastErr;
}
export const fetchText = async (url, opts) => (await fetchBuf(url, opts)).toString('utf8');
export const fetchJson = async (url, opts) => JSON.parse(await fetchText(url, opts));

export async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { for (;;) { const k = i++; if (k >= items.length) return; out[k] = await fn(items[k], k); } }));
  return out;
}

/** All features of an ArcGIS layer, paged. Returns { fields, rows: [{...attributes, __x, __y}] }. */
export async function arcgisAll(layerUrl, { where = '1=1', outFields = '*', geometry = false, page = 1000, log = () => {} } = {}) {
  const meta = await fetchJson(`${layerUrl}?f=json`);
  if (meta.error) throw new Error(`ArcGIS ${layerUrl}: ${JSON.stringify(meta.error)}`);
  const fields = (meta.fields || []).map((f) => f.name);
  const oid = meta.objectIdField || (meta.fields || []).find((f) => f.type === 'esriFieldTypeOID')?.name || 'OBJECTID';
  const size = Math.min(page, meta.maxRecordCount || page);
  const rows = [];
  for (let off = 0; ; off += size) {
    const q = new URLSearchParams({ where, outFields, returnGeometry: String(geometry), outSR: '4326', orderByFields: oid, resultOffset: String(off), resultRecordCount: String(size), f: 'json' });
    const r = await fetchJson(`${layerUrl}/query?${q}`);
    if (r.error) throw new Error(`ArcGIS query ${layerUrl} where ${where}: ${JSON.stringify(r.error)}`);
    for (const f of r.features || []) rows.push({ ...f.attributes, __x: f.geometry?.x ?? null, __y: f.geometry?.y ?? null });
    if (!(r.features || []).length || (!r.exceededTransferLimit && (r.features || []).length < size)) break;
    if (off > 500000) break;
  }
  log(`${meta.name}: ${rows.length} rows; fields: ${fields.join(',')}`);
  return { name: meta.name, fields, rows, meta };
}
/** Tries where clauses in order until one is accepted by the layer. */
export async function arcgisFirst(layerUrl, wheres, opts = {}) {
  let err;
  for (const where of wheres) { try { const r = await arcgisAll(layerUrl, { ...opts, where }); r.where = where; return r; } catch (e) { err = e; opts.log?.(`where "${where}" failed: ${e.message}`.slice(0, 300)); } }
  throw err;
}

export async function openfemaAll(entity, filter, { select, log = () => {}, version = 'v2' } = {}) {
  const rows = []; const top = 10000;
  for (let skip = 0; ; skip += top) {
    const url = `https://www.fema.gov/api/open/${version}/${entity}?$filter=${encodeURIComponent(filter)}${select ? `&$select=${select}` : ''}&$top=${top}&$skip=${skip}`;
    const j = await fetchJson(url, { timeout: 180000 });
    const part = j[entity] || [];
    rows.push(...part);
    log(`${entity} skip ${skip}: ${part.length}`);
    if (part.length < top) break;
  }
  return rows;
}

export const strip = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
/** "Bayamon (Municipio)" / "Bayamón Municipio" / "BAYAMON" -> "bayamon" */
export const normMuni = (s) => strip(s).toLowerCase().replace(/\(.*?\)/g, ' ').replace(/\bmunicipio\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
export const slug = (s) => strip(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
export const pick = (o, names) => { for (const n of names) if (o[n] != null && o[n] !== '') return o[n]; const keys = Object.keys(o); for (const n of names) { const k = keys.find((x) => x.toLowerCase() === n.toLowerCase()); if (k && o[k] != null && o[k] !== '') return o[k]; } return null; };
export const round = (v, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
export const clean = (props) => { const o = {}; for (const [k, v] of Object.entries(props)) if (v != null && v !== '' && !(typeof v === 'number' && !Number.isFinite(v))) o[k] = v; return o; };
export const FT = 0.3048;
export function haversineKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.sqrt(a));
}
