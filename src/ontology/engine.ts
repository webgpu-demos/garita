// The store's logic: schema creation, ingest with identity resolution and provenance, and every read of the
// TwinStore contract, written against a four-method database interface. The browser worker and Node both run
// this file unchanged, which is what makes a seed built in Node behave like a database filled in the browser.
// No DOM and no Node APIs here.
import type {
  ChangeEvent, DbInfo, IngestBatch, IngestResult, LinkRecord, ListOptions, Neighborhood, ObjectInput, ObjectRecord,
  ObjectSummary, ObjectTypeDef, Ontology, PropRecord, PropValue, Series, SourceDef, SourceStatus, TwinStore,
} from './types.ts';
import { CORE_DDL, FTS_DDL, FTS_FALLBACK_DDL, RTREE_DDL, RTREE_FALLBACK_DDL, SCHEMA_DOC, SCHEMA_VERSION, VIEWS_DDL } from './schema.ts';

export interface SqlDb {
  /** Runs a statement for its effect. Without params the string may hold several statements (DDL). */
  exec(sql: string, params?: any[]): void;
  all<T = any>(sql: string, params?: any[], maxRows?: number): T[];
  transaction<T>(fn: () => T): T;
  /** True when the statement cannot write (sqlite3_stmt_readonly). Optional second line of defence for query(). */
  isReadOnly?(sql: string): boolean;
  close?(): void;
}

export const MAX_QUERY_ROWS = 5000;
const DAY = 86400000;

/**
 * Adapts an `oo1.DB` of @sqlite.org/sqlite-wasm to SqlDb. Statements are prepared once and reused: ingest runs the
 * same dozen statements hundreds of thousands of times and preparing dominates otherwise.
 */
export function wrapSqlite(sqlite3: any, db: any): SqlDb {
  const cache = new Map<string, any>();
  let depth = 0;
  // Parameters are bound through the raw wasm exports. The library's own bind() allocates and frees a C string
  // per text value and converts every argument; at four million values per seed load that was most of the time.
  // All text of one execution is encoded into a single scratch buffer that stays untouched until the statement
  // is reset, which is what lets SQLite read it in place (SQLITE_STATIC).
  const ex = sqlite3.wasm.exports;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let scratch = 0, scratchSize = 0;
  const bind = (s: any, params: any[]) => {
    let need = 0;
    for (let i = 0; i < params.length; i++) { const v = params[i]; if (typeof v === 'string') need += v.length * 3; }
    if (need > scratchSize) {
      if (scratch) ex.sqlite3_free(scratch);
      scratchSize = Math.max(need, 1 << 16);
      scratch = ex.sqlite3_malloc(scratchSize);
      if (!scratch) { scratchSize = 0; s.bind(params); return; }
    }
    const heap: Uint8Array = sqlite3.wasm.heap8u();
    const p = s.pointer;
    let off = scratch;
    let rc = 0;
    for (let i = 0; i < params.length && rc === 0; i++) {
      const v = params[i];
      if (v == null) rc = ex.sqlite3_bind_null(p, i + 1);
      else if (typeof v === 'number') rc = Number.isInteger(v) && v >= -2147483648 && v <= 2147483647 ? ex.sqlite3_bind_int(p, i + 1, v) : ex.sqlite3_bind_double(p, i + 1, v);
      else if (typeof v === 'string') {
        const n = encoder.encodeInto(v, heap.subarray(off, scratch + scratchSize)).written;
        rc = ex.sqlite3_bind_text(p, i + 1, off, n, 0);
        off += n;
      } else if (typeof v === 'boolean') rc = ex.sqlite3_bind_int(p, i + 1, v ? 1 : 0);
      else rc = -1;
    }
    // Anything unusual (a blob, a bigint, too many parameters) goes through the library, which also reports errors properly.
    if (rc !== 0) { s.clearBindings(); s.bind(params); }
  };
  const stmt = (sql: string) => {
    let s = cache.get(sql);
    if (!s) {
      // Ad hoc console queries would grow the cache without bound.
      if (cache.size >= 300) { for (const old of cache.values()) old.finalize(); cache.clear(); }
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  return {
    exec(sql, params) {
      if (!params) { db.exec(sql); return; }
      const s = stmt(sql);
      try { if (params.length) bind(s, params); s.step(); } finally { s.reset(true); }
    },
    all(sql, params, maxRows = Infinity) {
      const s = stmt(sql);
      const out: any[] = [];
      try {
        if (params && params.length) bind(s, params);
        // Rows are read through the raw exports for the same reason parameters are bound that way. Integers come
        // back as doubles, exact up to 2^53, which covers every id, count and timestamp the twin stores.
        const names: string[] = s.getColumnNames();
        const width = names.length;
        const p = s.pointer;
        while (out.length < maxRows && s.step()) {
          const row: any = {};
          for (let i = 0; i < width; i++) {
            const type = ex.sqlite3_column_type(p, i);
            if (type === 1 || type === 2) row[names[i]] = ex.sqlite3_column_double(p, i);
            else if (type === 3) {
              const ptr = ex.sqlite3_column_text(p, i);
              const n = ex.sqlite3_column_bytes(p, i);
              // The view is taken after the calls above: they may allocate, and growing the memory detaches old views.
              row[names[i]] = n ? decoder.decode(sqlite3.wasm.heap8u().subarray(ptr, ptr + n)) : '';
            } else if (type === 5) row[names[i]] = null;
            else row[names[i]] = s.get(i);
          }
          out.push(row);
        }
      } finally { s.reset(true); }
      return out;
    },
    transaction(fn) {
      if (depth > 0) return fn();
      db.exec('BEGIN');
      depth++;
      try { const r = fn(); db.exec('COMMIT'); return r; }
      catch (e) { try { db.exec('ROLLBACK'); } catch { /* the failed statement may already have rolled back */ } throw e; }
      finally { depth--; }
    },
    isReadOnly(sql) {
      const s = db.prepare(sql);
      try { return !!sqlite3.capi.sqlite3_stmt_readonly(s.pointer); } finally { s.finalize(); }
    },
    close() { for (const s of cache.values()) s.finalize(); cache.clear(); if (scratch) { ex.sqlite3_free(scratch); scratch = 0; scratchSize = 0; } db.close(); },
  };
}

// ---------- ontology lookups ----------
interface Ctx {
  types: Map<string, ObjectTypeDef>;
  sources: Map<string, SourceDef>;
  primary: Map<string, string[]>;
  units: Map<string, Map<string, string | undefined>>;
  typeText: Map<string, string>;
}
const ctxCache = new WeakMap<Ontology, Ctx>();
function ctx(o: Ontology): Ctx {
  let c = ctxCache.get(o);
  if (!c) {
    c = {
      types: new Map(o.objectTypes.map((t) => [t.id, t])),
      sources: new Map(o.sources.map((s) => [s.id, s])),
      primary: new Map(o.objectTypes.map((t) => [t.id, t.properties.filter((p) => p.primary).map((p) => p.id)])),
      units: new Map(o.objectTypes.map((t) => [t.id, new Map(t.properties.map((p) => [p.id, p.unit]))])),
      typeText: new Map(o.objectTypes.map((t) => [t.id, fold(`${t.id.replace(/_/g, ' ')} ${t.label.en} ${t.label.es}`)])),
    };
    ctxCache.set(o, c);
  }
  return c;
}

/** Lower-case without diacritics, so "Mayaguez" finds "Mayagüez" with or without FTS5. */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const capsCache = new WeakMap<SqlDb, { fts: boolean; rtree: boolean }>();
export function capabilities(db: SqlDb): { fts: boolean; rtree: boolean } {
  let c = capsCache.get(db);
  if (!c) {
    const rows = db.all<{ name: string; sql: string }>(`SELECT name, sql FROM sqlite_master WHERE name IN ('object_fts', 'object_rtree')`);
    const sqlOf = (n: string) => rows.find((r) => r.name === n)?.sql ?? '';
    c = { fts: /fts5/i.test(sqlOf('object_fts')), rtree: /rtree/i.test(sqlOf('object_rtree')) };
    capsCache.set(db, c);
  }
  return c;
}

// ---------- schema ----------
export function createSchema(db: SqlDb): void {
  db.exec(CORE_DDL);
  try { db.exec(FTS_DDL); } catch { db.exec(FTS_FALLBACK_DDL); }
  try { db.exec(RTREE_DDL); } catch { db.exec(RTREE_FALLBACK_DDL); }
  capsCache.delete(db);
  setMeta(db, 'schema_version', String(SCHEMA_VERSION));
  upgradeInPlace(db);
}

/**
 * Additions that an existing database (a visitor's persisted file, an older seed) can take without being rebuilt:
 * new views, a new nullable column, the table descriptions. Guarded by a signature so a warm start writes nothing.
 */
export function upgradeInPlace(db: SqlDb): void {
  const sig = `${SCHEMA_VERSION}:${VIEWS_DDL.length}:${JSON.stringify(SCHEMA_DOC).length}`;
  if (getMeta(db, 'schema_additions') === sig) return;
  db.exec(VIEWS_DDL);
  if (!db.all<{ name: string }>('PRAGMA table_info(ingest_run)').some((c) => c.name === 'data_at')) db.exec('ALTER TABLE ingest_run ADD COLUMN data_at INTEGER');
  db.transaction(() => {
    for (const [name, description] of Object.entries(SCHEMA_DOC)) db.exec('INSERT OR REPLACE INTO schema_doc (name, description) VALUES (?, ?)', [name, description]);
    setMeta(db, 'schema_additions', sig);
  });
}
export function setMeta(db: SqlDb, key: string, value: string): void {
  db.exec('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, value]);
}
export function getMeta(db: SqlDb, key: string): string | null {
  try { return db.all<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key])[0]?.value ?? null; } catch { return null; }
}

/** Mirrors ontology.json into tables so SQL users can join labels, units and source metadata. Idempotent. */
export function loadOntology(db: SqlDb, ontology: Ontology): void {
  // Version plus size: the ontology is edited without a version bump during development.
  const sig = `${ontology.version}:${JSON.stringify(ontology).length}`;
  if (getMeta(db, 'ontology_sig') === sig) return;
  db.transaction(() => {
    setMeta(db, 'ontology_sig', sig);
    for (const t of ['source', 'object_type', 'prop_def', 'metric_def', 'link_type']) db.exec(`DELETE FROM ${t}`);
    for (const s of ontology.sources) {
      db.exec('INSERT INTO source (id, name, org, url, license, kind, cadence_s, note) VALUES (?,?,?,?,?,?,?,?)',
        [s.id, s.name, s.org ?? null, s.url ?? null, s.license ?? null, s.kind, s.cadence_s ?? null, s.note ?? null]);
    }
    for (const t of ontology.objectTypes) {
      db.exec('INSERT INTO object_type (id, kind, label_en, label_es, plural_en, plural_es, key_scheme, icon, color, grp, ephemeral) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [t.id, t.kind, t.label.en, t.label.es, t.plural.en, t.plural.es, t.keyScheme, t.icon, t.color, t.group, t.ephemeral ? 1 : 0]);
      t.properties.forEach((p, i) => db.exec('INSERT INTO prop_def (type, key, label_en, label_es, vtype, unit, format, is_primary, ord) VALUES (?,?,?,?,?,?,?,?,?)',
        [t.id, p.id, p.label.en, p.label.es, p.type, p.unit ?? null, p.format ?? null, p.primary ? 1 : 0, i]));
      for (const m of t.metrics ?? []) db.exec('INSERT INTO metric_def (type, metric, label_en, label_es, unit) VALUES (?,?,?,?,?)', [t.id, m.id, m.label.en, m.label.es, m.unit]);
    }
    for (const l of ontology.linkTypes) {
      db.exec('INSERT INTO link_type (id, label_en, label_es, inverse_en, inverse_es, from_types, to_types) VALUES (?,?,?,?,?,?,?)',
        [l.id, l.label.en, l.label.es, l.inverse.en, l.inverse.es, JSON.stringify(l.from), JSON.stringify(l.to)]);
    }
    setMeta(db, 'ontology_version', ontology.version);
  });
}

// ---------- values ----------
type Enc = { value: number | string | null; vtype: string };
function encode(v: any): Enc {
  if (v == null) return { value: null, vtype: 'null' };
  if (typeof v === 'boolean') return { value: v ? 1 : 0, vtype: 'boolean' };
  if (typeof v === 'number') return Number.isFinite(v) ? { value: v, vtype: 'number' } : { value: null, vtype: 'null' };
  if (typeof v === 'string') return { value: v, vtype: 'string' };
  return { value: JSON.stringify(v), vtype: 'json' };
}
function decode(value: any, vtype: string): PropValue {
  if (value == null) return null;
  if (vtype === 'boolean') return !!value;
  return typeof value === 'bigint' ? Number(value) : value;
}

function geometryBounds(g: any): [number, number, number, number] | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const walk = (c: any) => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      if (c[0] < w) w = c[0]; if (c[0] > e) e = c[0]; if (c[1] < s) s = c[1]; if (c[1] > n) n = c[1];
    } else for (const x of c) walk(x);
  };
  if (g?.type === 'GeometryCollection') for (const x of g.geometries ?? []) walk(x.coordinates); else walk(g?.coordinates);
  return Number.isFinite(w) && Number.isFinite(s) ? [w, s, e, n] : null;
}

/** One INSERT carrying many rows: a round trip into wasm per row is the cost that matters in bulk loads. */
function bulkInsert(db: SqlDb, head: string, width: number, rows: any[][], chunk = 40): void {
  const tuple = `(${new Array(width).fill('?').join(',')})`;
  for (let i = 0; i < rows.length; i += chunk) {
    const n = Math.min(chunk, rows.length - i);
    const params: any[] = [];
    for (let j = i; j < i + n; j++) for (const v of rows[j]) params.push(v);
    db.exec(`${head} VALUES ${new Array(n).fill(tuple).join(',')}`, params);
  }
}

const OBJ_COLS = 'o.rid, o.id, o.type, o.key, o.name, o.lon, o.lat, o.status, o.severity, o.valid_from, o.valid_to, o.first_seen, o.updated_at, o.source_id, o.expired';
const SQL_FIND = `SELECT ${OBJ_COLS}, o.geometry FROM identity i JOIN object o ON o.id = i.object_id WHERE i.scheme = ? AND i.key = ? AND i.type = ?`;
const SQL_BY_ID = `SELECT ${OBJ_COLS}, o.geometry FROM object o WHERE o.id = ?`;

/** Types a batch touches, for the ChangeEvent. */
export function batchTypes(batch: IngestBatch): string[] {
  const s = new Set<string>(batch.replaceTypes ?? []);
  for (const o of batch.objects ?? []) s.add(o.type);
  for (const l of batch.links ?? []) { s.add(l.src.split(':')[0]); s.add(l.dst.split(':')[0]); }
  for (const ob of batch.obs ?? []) s.add(ob.object.split(':')[0]);
  return [...s];
}

// ---------- ingest ----------
export function ingest(db: SqlDb, ontology: Ontology, batch: IngestBatch, now: number = Date.now()): IngestResult {
  const started = Date.now();
  const cx = ctx(ontology);
  if (!cx.sources.has(batch.source)) throw new Error(`ingest: unknown source "${batch.source}" (add it to ontology.json)`);
  if (!Number.isFinite(batch.fetchedAt)) throw new Error('ingest: batch.fetchedAt is not a number');
  const src = batch.source;
  const at = batch.fetchedAt;
  const observed = batch.observedAt ?? at;
  const res: IngestResult = { source: src, objects: 0, created: 0, changed: 0, links: 0, obs: 0, expired: 0, ms: 0 };
  let skipped = 0;
  // Newest observation time in the batch, for the lineage panel. Forecast points lie in the future and do not count.
  let dataAt = -Infinity;
  // A key in the type's own scheme is the object's id; only other ids need the identity table.
  const findOne = (scheme: string, key: string, def: ObjectTypeDef): any => {
    if (scheme === def.keyScheme) { const r = db.all<any>(SQL_BY_ID, [`${def.id}:${key}`])[0]; if (r) return r; }
    return db.all<any>(SQL_FIND, [scheme, key, def.id])[0];
  };
  // canonical id as written in the batch -> id of the object it resolved to (differs after an identity merge)
  const resolved = new Map<string, string>();
  const touched = new Set<string>();

  const resolve = (id: string): string => {
    const hit = resolved.get(id);
    if (hit) return hit;
    let out = id;
    if (!db.all('SELECT 1 AS x FROM object WHERE id = ?', [id]).length) {
      const cut = id.indexOf(':');
      const def = cut > 0 ? cx.types.get(id.slice(0, cut)) : undefined;
      if (def) out = db.all<{ object_id: string }>('SELECT object_id FROM identity WHERE scheme = ? AND key = ? AND type = ?', [def.keyScheme, id.slice(cut + 1), def.id])[0]?.object_id ?? id;
    }
    resolved.set(id, out);
    return out;
  };

  // New rows are buffered and written many per statement, and existing rows are looked up a chunk at a time:
  // each statement is a round trip into wasm, and a seed load is hundreds of thousands of rows.
  const objs = batch.objects ?? [];
  let nextRid = 0;
  const bObj: any[][] = [], bFts: any[][] = [], bTree: any[][] = [], bIdent: any[][] = [], bProp: any[][] = [];
  let bump: number[] = [];
  const flush = () => {
    if (bObj.length) { bulkInsert(db, 'INSERT INTO object (rid, id, type, key, name, lon, lat, status, severity, valid_from, valid_to, first_seen, updated_at, source_id, geometry, expired)', 16, bObj); bObj.length = 0; }
    if (bFts.length) { bulkInsert(db, 'INSERT INTO object_fts (rowid, name, type, text)', 4, bFts); bFts.length = 0; }
    if (bTree.length) { bulkInsert(db, 'INSERT INTO object_rtree (id, min_lon, max_lon, min_lat, max_lat)', 5, bTree); bTree.length = 0; }
    if (bIdent.length) { bulkInsert(db, 'INSERT OR IGNORE INTO identity (scheme, key, type, object_id)', 4, bIdent); bIdent.length = 0; }
    if (bProp.length) { bulkInsert(db, 'INSERT INTO prop (object_id, key, value, vtype, unit, source_id, observed_at, confidence)', 8, bProp); bProp.length = 0; }
    if (bump.length) { db.exec('UPDATE object SET updated_at = ? WHERE rid IN (SELECT value FROM json_each(?))', [at, JSON.stringify(bump)]); bump = []; }
  };

  const upsertObject = (o: ObjectInput, known: Map<string, any>, knownProps: Map<string, Map<string, any>>, inChunk: Set<string>) => {
    const def = cx.types.get(o.type);
    if (!def || o.key == null || o.key === '') { skipped++; return; }
    const key = String(o.key);
    const canonical = `${o.type}:${key}`;
    res.objects++;

    // The chunk's lookups were made before the chunk's writes. An object met a second time within the chunk
    // (a duplicate, or an alias of one already handled) is read again after flushing.
    let ex = known.get(canonical);
    let fresh = false;
    if (inChunk.has(canonical) || (ex && inChunk.has(ex.id))) {
      flush();
      fresh = true;
      ex = findOne(def.keyScheme, key, def);
    }
    let viaAlias = false;
    if (!ex && o.identities?.length) {
      flush();
      for (const [scheme, k] of o.identities) {
        ex = findOne(scheme, String(k), def);
        if (ex) { viaAlias = true; fresh = true; break; }
      }
    }
    const bounds = o.geometry ? geometryBounds(o.geometry) : null;
    const geomText = o.geometry ? JSON.stringify(o.geometry) : null;
    const searchText = () => fold([key, ...(o.identities ?? []).map((i) => i[1]), o.text ?? ''].join(' '));
    let id: string;
    let created = false;
    let changed = false;

    if (!ex) {
      created = true;
      id = canonical;
      const rid = nextRid++;
      const name = o.name ?? key;
      const lon = o.lon ?? (bounds ? (bounds[0] + bounds[2]) / 2 : null);
      const lat = o.lat ?? (bounds ? (bounds[1] + bounds[3]) / 2 : null);
      bObj.push([rid, id, o.type, key, name, lon, lat, o.status ?? null, o.severity ?? null, o.validFrom ?? null, o.validTo ?? null, at, at, src, geomText, 0]);
      bFts.push([rid, fold(name), cx.typeText.get(o.type), searchText()]);
      const b = bounds ?? (lon != null && lat != null ? [lon, lat, lon, lat] : null);
      if (b) bTree.push([rid, b[0], b[2], b[1], b[3]]);
      res.created++;
    } else {
      id = ex.id;
      const rid: number = ex.rid;
      const revived = ex.expired === 1;
      const name = o.name ?? ex.name;
      const lon = o.lon !== undefined ? o.lon : (ex.lon ?? (bounds ? (bounds[0] + bounds[2]) / 2 : null));
      const lat = o.lat !== undefined ? o.lat : (ex.lat ?? (bounds ? (bounds[1] + bounds[3]) / 2 : null));
      // Expiry overwrote status and valid_to, so a revived object takes them from the batch or starts clean.
      const status = o.status !== undefined ? o.status : (revived ? null : ex.status);
      const severity = o.severity !== undefined ? o.severity : ex.severity;
      const validFrom = o.validFrom !== undefined ? o.validFrom : ex.valid_from;
      const validTo = o.validTo !== undefined ? o.validTo : (revived ? null : ex.valid_to);
      const geom = o.geometry !== undefined ? geomText : ex.geometry;
      const moved = lon !== ex.lon || lat !== ex.lat || geom !== ex.geometry;
      changed = revived || name !== ex.name || moved || status !== ex.status || severity !== ex.severity || validFrom !== ex.valid_from || validTo !== ex.valid_to;
      if (changed) {
        db.exec('UPDATE object SET name = ?, lon = ?, lat = ?, status = ?, severity = ?, valid_from = ?, valid_to = ?, geometry = ?, expired = 0, updated_at = ? WHERE rid = ?',
          [name, lon, lat, status, severity, validFrom, validTo, geom, Math.max(at, ex.updated_at), rid]);
      } else if (ex.updated_at < at) bump.push(rid);
      if (name !== ex.name || o.text !== undefined) {
        const old = db.all<{ name: string; text: string }>('SELECT name, text FROM object_fts WHERE rowid = ?', [rid])[0];
        const text = o.text !== undefined ? searchText() : (old?.text ?? fold(ex.key));
        if (!old || old.name !== fold(name) || old.text !== text) {
          if (old) db.exec('DELETE FROM object_fts WHERE rowid = ?', [rid]);
          db.exec('INSERT INTO object_fts (rowid, name, type, text) VALUES (?,?,?,?)', [rid, fold(name), cx.typeText.get(o.type), text]);
        }
      }
      if (moved) {
        const gb = o.geometry !== undefined ? bounds : (ex.geometry ? geometryBounds(JSON.parse(ex.geometry)) : null);
        const b = gb ?? (lon != null && lat != null ? [lon, lat, lon, lat] : null);
        db.exec('DELETE FROM object_rtree WHERE id = ?', [rid]);
        if (b) db.exec('INSERT INTO object_rtree (id, min_lon, max_lon, min_lat, max_lat) VALUES (?,?,?,?,?)', [rid, b[0], b[2], b[1], b[3]]);
      }
      if (viaAlias) bIdent.push([def.keyScheme, key, o.type, id]);
    }
    for (const [scheme, k] of o.identities ?? []) if (scheme !== def.keyScheme || `${o.type}:${k}` !== id) bIdent.push([scheme, String(k), o.type, id]);
    resolved.set(canonical, id);
    touched.add(id);
    inChunk.add(canonical);
    inChunk.add(id);

    if (o.props) {
      const units = cx.units.get(o.type);
      let have: Map<string, any> | undefined;
      if (!created) {
        if (fresh) {
          have = new Map();
          for (const r of db.all<any>('SELECT key, value, vtype, observed_at FROM prop WHERE object_id = ? AND source_id = ?', [id, src])) have.set(r.key, r);
        } else have = knownProps.get(id);
      }
      let added = false;
      for (const k in o.props) {
        const raw: any = o.props[k];
        if (raw === undefined) continue;
        const wrapped = raw !== null && typeof raw === 'object' && 'value' in raw;
        const enc = encode(wrapped ? raw.value : raw);
        const unit = (wrapped ? raw.unit : undefined) ?? units?.get(k) ?? null;
        const obsAt = (wrapped ? raw.observedAt : undefined) ?? observed;
        if (obsAt > dataAt && obsAt <= at) dataAt = obsAt;
        const conf = (wrapped ? raw.confidence : undefined) ?? null;
        const old = have?.get(k);
        if (!old) { bProp.push([id, k, enc.value, enc.vtype, unit, src, obsAt, conf]); added = true; continue; }
        // A late-arriving older reading must not replace what a newer one already said.
        if (obsAt < old.observed_at) continue;
        const same = old.value === enc.value && old.vtype === enc.vtype;
        if (same && obsAt === old.observed_at) continue;
        if (!same) {
          db.exec('INSERT INTO prop_history (object_id, key, source_id, value, vtype, unit, observed_at, replaced_at) SELECT object_id, key, source_id, value, vtype, unit, observed_at, ? FROM prop WHERE object_id = ? AND key = ? AND source_id = ?', [at, id, k, src]);
          changed = true;
        }
        db.exec('UPDATE prop SET value = ?, vtype = ?, unit = ?, observed_at = ?, confidence = ? WHERE object_id = ? AND key = ? AND source_id = ?', [enc.value, enc.vtype, unit, obsAt, conf, id, k, src]);
      }
      if (added && !created) changed = true;
    }
    if (changed && !created) res.changed++;
  };

  // CROSS JOIN pins the join order: start from the chunk's keys, never from a scan of the big table.
  const SQL_FIND_MANY = `SELECT i.key AS ikey, ${OBJ_COLS}, o.geometry FROM json_each(?3) j CROSS JOIN identity i ON i.scheme = ?1 AND i.key = j.value AND i.type = ?2 CROSS JOIN object o ON o.id = i.object_id`;
  const upsertObjects = () => {
    if (!objs.length) return;
    nextRid = db.all<{ n: number }>('SELECT COALESCE(MAX(rid), 0) + 1 AS n FROM object')[0].n;
    const CHUNK = 400;
    for (let c0 = 0; c0 < objs.length; c0 += CHUNK) {
      const chunk = objs.slice(c0, c0 + CHUNK);
      const keysByType = new Map<string, string[]>();
      let anyProps = false;
      for (const o of chunk) {
        if (!cx.types.has(o.type) || o.key == null) continue;
        let keys = keysByType.get(o.type);
        if (!keys) keysByType.set(o.type, keys = []);
        keys.push(String(o.key));
        if (o.props) anyProps = true;
      }
      const known = new Map<string, any>();
      const canonicalIds: string[] = [];
      for (const [type, keys] of keysByType) for (const k of keys) canonicalIds.push(`${type}:${k}`);
      for (const r of db.all<any>(`SELECT ${OBJ_COLS}, o.geometry FROM json_each(?1) j CROSS JOIN object o ON o.id = j.value`, [JSON.stringify(canonicalIds)])) known.set(r.id, r);
      for (const [type, keys] of keysByType) {
        for (const r of db.all<any>(SQL_FIND_MANY, [cx.types.get(type)!.keyScheme, type, JSON.stringify(keys)])) if (!known.has(`${type}:${r.ikey}`)) known.set(`${type}:${r.ikey}`, r);
      }
      const knownProps = new Map<string, Map<string, any>>();
      if (known.size && anyProps) {
        const ids = [...new Set([...known.values()].map((r) => r.id))];
        for (const p of db.all<any>('SELECT p.object_id, p.key, p.value, p.vtype, p.observed_at FROM json_each(?2) j CROSS JOIN prop p ON p.object_id = j.value WHERE p.source_id = ?1', [src, JSON.stringify(ids)])) {
          let m = knownProps.get(p.object_id);
          if (!m) knownProps.set(p.object_id, m = new Map());
          m.set(p.key, p);
        }
      }
      const inChunk = new Set<string>();
      for (const o of chunk) upsertObject(o, known, knownProps, inChunk);
      flush();
    }
  };

  db.transaction(() => {
    upsertObjects();

    for (const l of batch.links ?? []) {
      db.exec('INSERT INTO link (src, type, dst, source_id, observed_at, confidence, note) VALUES (?,?,?,?,?,?,?) ON CONFLICT (src, type, dst, source_id) DO UPDATE SET observed_at = excluded.observed_at, confidence = excluded.confidence, note = excluded.note',
        [resolve(l.src), l.type, resolve(l.dst), src, observed, l.confidence ?? null, l.note ?? null]);
      res.links++;
    }

    if (batch.obs?.length) {
      const rows: any[][] = [];
      for (const ob of batch.obs) {
        if (!Number.isFinite(ob.t) || !Number.isFinite(ob.value)) continue;
        rows.push([resolve(ob.object), ob.metric, ob.t, ob.value]);
        if (ob.t > dataAt && ob.t <= at) dataAt = ob.t;
      }
      bulkInsert(db, 'INSERT OR REPLACE INTO obs (object_id, metric, t, value)', 4, rows, 100);
      res.obs = rows.length;
    }

    for (const type of batch.replaceTypes ?? []) {
      for (const r of db.all<{ id: string }>('SELECT id FROM object WHERE source_id = ? AND type = ? AND expired = 0', [src, type])) {
        if (touched.has(r.id)) continue;
        db.exec(`UPDATE object SET expired = 1, status = 'expired', valid_to = ?, updated_at = ? WHERE id = ?`, [now, at, r.id]);
        res.expired++;
      }
    }

    res.ms = Date.now() - started;
    const note = [batch.note, skipped ? `skipped ${skipped} objects with an unknown type or empty key` : null].filter(Boolean).join('; ') || null;
    db.exec('INSERT INTO ingest_run (source_id, started_at, finished_at, status, objects, created, changed, links, obs, expired, bytes, note, data_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [src, at, Math.max(now, at), 'ok', res.objects, res.created, res.changed, res.links, res.obs, res.expired, batch.bytes ?? 0, note, Number.isFinite(dataAt) ? dataAt : null]);
  });
  res.ms = Date.now() - started;
  return res;
}

export function reportRun(db: SqlDb, source: string, status: 'ok' | 'error', note?: string, bytes?: number, now: number = Date.now()): void {
  db.exec('INSERT INTO ingest_run (source_id, started_at, finished_at, status, bytes, note) VALUES (?,?,?,?,?,?)', [source, now, now, status, bytes ?? 0, note ?? null]);
}

// ---------- reads ----------
function toSummary(r: any): ObjectSummary {
  return { id: r.id, type: r.type, key: r.key, name: r.name, lon: r.lon, lat: r.lat, status: r.status, severity: r.severity, updatedAt: r.updated_at, validFrom: r.valid_from, validTo: r.valid_to };
}

function attachProps(db: SqlDb, cx: Ctx, rows: ObjectSummary[], keys?: string[]): void {
  if (!rows.length) return;
  const want = keys ?? [...new Set(rows.flatMap((r) => cx.primary.get(r.type) ?? []))];
  if (!want.length) return;
  const byId = new Map<string, ObjectSummary>();
  for (const r of rows) { r.props = {}; byId.set(r.id, r); }
  const found = db.all<any>(
    'SELECT object_id, key, value, vtype FROM prop_best WHERE object_id IN (SELECT value FROM json_each(?)) AND key IN (SELECT value FROM json_each(?))',
    [JSON.stringify([...byId.keys()]), JSON.stringify(want)]);
  for (const p of found) byId.get(p.object_id)!.props![p.key] = decode(p.value, p.vtype);
}

/** Follows an alias left by an identity merge, so `stream_gauge:<other id>` still finds the object. */
function resolveId(db: SqlDb, cx: Ctx, id: string): string {
  if (db.all('SELECT 1 AS x FROM object WHERE id = ?', [id]).length) return id;
  const cut = id.indexOf(':');
  const def = cut > 0 ? cx.types.get(id.slice(0, cut)) : undefined;
  if (!def) return id;
  return db.all<{ object_id: string }>('SELECT object_id FROM identity WHERE scheme = ? AND key = ? AND type = ?', [def.keyScheme, id.slice(cut + 1), def.id])[0]?.object_id ?? id;
}

export function getObject(db: SqlDb, ontology: Ontology, id: string): ObjectRecord | null {
  const cx = ctx(ontology);
  const oid = resolveId(db, cx, id);
  const r = db.all<any>(`SELECT ${OBJ_COLS}, o.geometry FROM object o WHERE o.id = ?`, [oid])[0];
  if (!r) return null;
  const allProps: PropRecord[] = db.all<any>('SELECT key, value, vtype, unit, source_id, observed_at, confidence FROM prop WHERE object_id = ? ORDER BY key, observed_at DESC', [oid])
    .map((p) => ({ key: p.key, value: decode(p.value, p.vtype), unit: p.unit, source: p.source_id, observedAt: p.observed_at, confidence: p.confidence }));
  const identities = db.all<{ scheme: string; key: string }>('SELECT scheme, key FROM identity WHERE object_id = ?', [oid]);
  const scheme = cx.types.get(r.type)?.keyScheme;
  if (scheme && !identities.some((i) => i.scheme === scheme && i.key === r.key)) identities.push({ scheme, key: r.key });
  identities.sort((a, b) => (a.scheme + '\u0000' + a.key < b.scheme + '\u0000' + b.key ? -1 : 1));
  const props: Record<string, PropValue> = {};
  for (const p of db.all<any>('SELECT key, value, vtype FROM prop_best WHERE object_id = ?', [oid])) props[p.key] = decode(p.value, p.vtype);
  return {
    ...toSummary(r), props,
    source: r.source_id, firstSeen: r.first_seen, validFrom: r.valid_from, validTo: r.valid_to,
    geometry: r.geometry ? JSON.parse(r.geometry) : null,
    allProps,
    identities,
    metrics: db.all<{ metric: string }>('SELECT DISTINCT metric FROM obs WHERE object_id = ?', [oid]).map((m) => m.metric),
  };
}

const LINK_SELECT = `SELECT l.src, l.type, l.dst, l.source_id, l.observed_at, l.confidence, l.note,
  a.name AS src_name, a.type AS src_type, b.name AS dst_name, b.type AS dst_type
  FROM link l LEFT JOIN object a ON a.id = l.src LEFT JOIN object b ON b.id = l.dst`;
function toLink(r: any): LinkRecord {
  return {
    src: r.src, dst: r.dst, type: r.type, source: r.source_id, observedAt: r.observed_at, confidence: r.confidence, note: r.note,
    srcName: r.src_name ?? undefined, srcType: r.src_type ?? r.src.split(':')[0], dstName: r.dst_name ?? undefined, dstType: r.dst_type ?? r.dst.split(':')[0],
  };
}

export function getLinks(db: SqlDb, ontology: Ontology, id: string, opts: { type?: string; direction?: 'out' | 'in' | 'both'; limit?: number } = {}): LinkRecord[] {
  const oid = resolveId(db, ctx(ontology), id);
  const dir = opts.direction ?? 'both';
  const limit = opts.limit ?? 500;
  const out: LinkRecord[] = [];
  // The far end is hidden once expired (an alert that ended no longer "affects" the municipio it pointed at).
  const run = (near: 'src' | 'dst', far: 'a' | 'b') => {
    const params: any[] = [oid];
    let sql = `${LINK_SELECT} WHERE l.${near} = ? AND COALESCE(${far}.expired, 0) = 0`;
    if (opts.type) { sql += ' AND l.type = ?'; params.push(opts.type); }
    sql += ' ORDER BY l.type, l.observed_at DESC LIMIT ?';
    params.push(limit - out.length);
    for (const r of db.all<any>(sql, params)) out.push(toLink(r));
  };
  if (dir !== 'in') run('src', 'b');
  if (dir !== 'out' && out.length < limit) run('dst', 'a');
  return out;
}

const COLUMN: Record<string, string> = {
  id: 'o.id', key: 'o.key', type: 'o.type', name: 'o.name', status: 'o.status', severity: 'o.severity', lon: 'o.lon', lat: 'o.lat',
  updatedAt: 'o.updated_at', firstSeen: 'o.first_seen', validFrom: 'o.valid_from', validTo: 'o.valid_to', source: 'o.source_id',
};
const OPS: Record<string, string> = { '=': '=', '!=': '!=', '>': '>', '>=': '>=', '<': '<', '<=': '<=', like: 'LIKE' };

export function listObjects(db: SqlDb, ontology: Ontology, type: string | string[], opts: ListOptions = {}): ObjectSummary[] {
  const cx = ctx(ontology);
  const types = Array.isArray(type) ? type : [type];
  const where: string[] = [];
  const params: any[] = [];
  let orderExpr = 'o.name';
  let desc = false;
  let selectParams: any[] = [];
  if (opts.orderBy) {
    desc = opts.orderBy.startsWith('-');
    const k = desc ? opts.orderBy.slice(1) : opts.orderBy;
    if (COLUMN[k]) orderExpr = COLUMN[k];
    else { orderExpr = '(SELECT b.value FROM prop_best b WHERE b.object_id = o.id AND b.key = ?)'; selectParams = [k]; }
  }
  if (!types.includes('*')) { where.push(`o.type IN (${types.map(() => '?').join(',')})`); params.push(...types); }
  if (!opts.includeExpired) where.push('o.expired = 0');
  if (opts.status != null) {
    const st = Array.isArray(opts.status) ? opts.status : [opts.status];
    where.push(`o.status IN (${st.map(() => '?').join(',')})`); params.push(...st);
  }
  if (opts.bbox) {
    const [w, s, e, n] = opts.bbox;
    where.push('o.rid IN (SELECT id FROM object_rtree WHERE max_lon >= ? AND min_lon <= ? AND max_lat >= ? AND min_lat <= ?)');
    params.push(w, e, s, n);
  }
  for (const [k, cond] of Object.entries(opts.where ?? {})) {
    const [opRaw, valRaw] = Array.isArray(cond) ? cond : ['=', cond];
    const op = OPS[opRaw];
    if (!op) throw new Error(`listObjects: unsupported operator "${opRaw}"`);
    const val = typeof valRaw === 'boolean' ? (valRaw ? 1 : 0) : valRaw;
    // Unary plus keeps the planner on prop's primary key whatever indexes an analyst may have added on value.
    const lhs = COLUMN[k] ?? '+b.value';
    const test = val === null ? (op === '!=' ? `${lhs} IS NOT NULL` : `${lhs} IS NULL`) : `${lhs} ${op} ?`;
    if (COLUMN[k]) where.push(test);
    else { where.push(`EXISTS (SELECT 1 FROM prop_best b WHERE b.object_id = o.id AND b.key = ? AND ${test})`); params.push(k); }
    if (val !== null) params.push(val);
  }
  const sql = `SELECT ${OBJ_COLS}, ${orderExpr} AS ord FROM object o ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ord IS NULL, ord ${desc ? 'DESC' : 'ASC'}, o.name LIMIT ?`;
  const rows = db.all<any>(sql, [...selectParams, ...params, opts.limit ?? 1000]).map(toSummary);
  attachProps(db, cx, rows, opts.props);
  return rows;
}

export function search(db: SqlDb, ontology: Ontology, text: string, opts: { types?: string[]; limit?: number; includeExpired?: boolean } = {}): ObjectSummary[] {
  const cx = ctx(ontology);
  const folded = fold(text).trim();
  const tokens = folded.match(/[\p{L}\p{N}]+/gu);
  if (!tokens) return [];
  const limit = opts.limit ?? 20;
  const filter: string[] = [];
  const fparams: any[] = [];
  if (!opts.includeExpired) filter.push('o.expired = 0');
  if (opts.types?.length) { filter.push(`o.type IN (${opts.types.map(() => '?').join(',')})`); fparams.push(...opts.types); }
  const and = filter.length ? ' AND ' + filter.join(' AND ') : '';
  let rows: any[];
  if (capabilities(db).fts) {
    // Every token is a prefix so results appear while typing; an exact name match outranks the relevance score.
    const match = tokens.map((t) => `"${t}"*`).join(' ');
    rows = db.all<any>(
      `SELECT ${OBJ_COLS} FROM object_fts JOIN object o ON o.rid = object_fts.rowid WHERE object_fts MATCH ?${and}
       ORDER BY (object_fts.name = ?) DESC, bm25(object_fts, 10.0, 1.0, 2.0), o.severity DESC, o.name LIMIT ?`,
      [match, ...fparams, folded, limit]);
  } else {
    const likes = tokens.map(() => '(f.name LIKE ? OR f.type LIKE ? OR f.text LIKE ?)').join(' AND ');
    const lparams = tokens.flatMap((t) => [`%${t}%`, `%${t}%`, `%${t}%`]);
    rows = db.all<any>(
      `SELECT ${OBJ_COLS} FROM object_fts f JOIN object o ON o.rid = f.rowid WHERE ${likes}${and}
       ORDER BY (f.name = ?) DESC, (f.name LIKE ?) DESC, o.severity DESC, o.name LIMIT ?`,
      [...lparams, ...fparams, folded, `${tokens[0]}%`, limit]);
  }
  const out = rows.map(toSummary);
  attachProps(db, cx, out);
  return out;
}

export function series(db: SqlDb, ontology: Ontology, objectId: string, metric: string, opts: { since?: number; until?: number; maxPoints?: number } = {}): Series {
  const oid = resolveId(db, ctx(ontology), objectId);
  const rows = db.all<{ t: number; value: number }>('SELECT t, value FROM obs WHERE object_id = ? AND metric = ? AND t >= ? AND t <= ? ORDER BY t',
    [oid, metric, opts.since ?? -8.64e15, opts.until ?? 8.64e15]);
  const max = opts.maxPoints;
  if (!max || rows.length <= max) return { t: rows.map((r) => r.t), v: rows.map((r) => r.value) };
  // Keep the lowest and highest reading of each bucket: a flood crest must survive being drawn at 200 points.
  const buckets = Math.max(1, Math.floor(max / 2));
  const t: number[] = [];
  const v: number[] = [];
  for (let b = 0; b < buckets; b++) {
    const i0 = Math.floor((b * rows.length) / buckets), i1 = Math.floor(((b + 1) * rows.length) / buckets);
    if (i1 <= i0) continue;
    let lo = i0, hi = i0;
    for (let i = i0 + 1; i < i1; i++) { if (rows[i].value < rows[lo].value) lo = i; if (rows[i].value > rows[hi].value) hi = i; }
    for (const i of lo === hi ? [lo] : lo < hi ? [lo, hi] : [hi, lo]) { t.push(rows[i].t); v.push(rows[i].value); }
  }
  return { t, v };
}

export function neighborhood(db: SqlDb, ontology: Ontology, id: string, opts: { depth?: number; limit?: number; linkTypes?: string[] } = {}): Neighborhood {
  const cx = ctx(ontology);
  const root = resolveId(db, cx, id);
  const depth = opts.depth ?? 1;
  const limit = opts.limit ?? 200;
  const seen = new Set<string>([root]);
  const links = new Map<string, LinkRecord>();
  let frontier = [root];
  const typeFilter = opts.linkTypes?.length ? ` AND l.type IN (${opts.linkTypes.map(() => '?').join(',')})` : '';
  for (let d = 0; d < depth && frontier.length && seen.size < limit; d++) {
    const ids = JSON.stringify(frontier);
    const rows = db.all<any>(
      `${LINK_SELECT} WHERE (l.src IN (SELECT value FROM json_each(?)) OR l.dst IN (SELECT value FROM json_each(?)))${typeFilter}
       AND COALESCE(a.expired, 0) = 0 AND COALESCE(b.expired, 0) = 0`,
      [ids, ids, ...(opts.linkTypes ?? [])]);
    const next: string[] = [];
    for (const r of rows) {
      for (const end of [r.src, r.dst]) {
        if (seen.has(end) || seen.size >= limit) continue;
        seen.add(end); next.push(end);
      }
      if (seen.has(r.src) && seen.has(r.dst)) links.set(`${r.src}|${r.type}|${r.dst}|${r.source_id}`, toLink(r));
    }
    frontier = next;
  }
  const nodes = db.all<any>(`SELECT ${OBJ_COLS} FROM object o WHERE o.id IN (SELECT value FROM json_each(?))`, [JSON.stringify([...seen])]).map(toSummary);
  // The root first, so a graph view can pin it without searching.
  nodes.sort((a, b) => (a.id === root ? -1 : b.id === root ? 1 : 0));
  attachProps(db, cx, nodes);
  const present = new Set(nodes.map((n) => n.id));
  return { nodes, links: [...links.values()].filter((l) => present.has(l.src) && present.has(l.dst)) };
}

export function countByType(db: SqlDb): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of db.all<{ type: string; n: number }>('SELECT type, COUNT(*) AS n FROM object WHERE expired = 0 GROUP BY type ORDER BY type')) out[r.type] = r.n;
  return out;
}

export function sources(db: SqlDb, ontology: Ontology, now: number = Date.now()): SourceStatus[] {
  const last = new Map<string, any>();
  for (const r of db.all<any>('SELECT * FROM ingest_run WHERE id IN (SELECT MAX(id) FROM ingest_run GROUP BY source_id)')) last.set(r.source_id, r);
  const counts = new Map<string, number>();
  for (const r of db.all<any>('SELECT source_id, COUNT(*) AS n FROM object WHERE expired = 0 GROUP BY source_id')) counts.set(r.source_id, r.n);
  const dataAt = new Map<string, number>();
  for (const r of db.all<any>('SELECT source_id, MAX(observed_at) AS t FROM prop GROUP BY source_id')) dataAt.set(r.source_id, r.t);
  // obs rows carry no source, so their newest time is taken from the runs that wrote them.
  for (const r of db.all<any>('SELECT source_id, MAX(data_at) AS t FROM ingest_run WHERE data_at IS NOT NULL GROUP BY source_id')) dataAt.set(r.source_id, Math.max(r.t, dataAt.get(r.source_id) ?? -Infinity));
  const runs = new Map<string, any[]>();
  for (const r of db.all<any>('SELECT * FROM (SELECT r.*, ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY id DESC) AS rn FROM ingest_run r) WHERE rn <= 5 ORDER BY id DESC')) {
    let list = runs.get(r.source_id);
    if (!list) runs.set(r.source_id, list = []);
    list.push({ startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, objects: r.objects, obs: r.obs, bytes: r.bytes, note: r.note ?? undefined });
  }
  return ontology.sources.map((source) => {
    const r = last.get(source.id);
    const st: SourceStatus = { source, objectCount: counts.get(source.id) ?? 0, dataAt: dataAt.get(source.id) ?? null, runs: runs.get(source.id) ?? [] };
    if (r) {
      // A feed that last succeeded long ago is not "ok": three missed cycles reads as stale.
      const stale = r.status === 'ok' && source.cadence_s != null && now - r.finished_at > 3 * source.cadence_s * 1000;
      st.lastRun = { startedAt: r.started_at, finishedAt: r.finished_at, status: stale ? 'stale' : r.status, objects: r.objects, obs: r.obs, bytes: r.bytes, note: r.note ?? undefined };
    }
    return st;
  });
}

/** Rejects anything that could write. The statement-level check in the adapter backs this up where available. */
export function assertReadOnly(sql: string): string {
  // Literals and comments are blanked first so a ';' or a keyword inside a string does not trip the checks. One pass,
  // left to right: an apostrophe inside a comment ("-- FEMA's records") is not the start of a string, and "--" inside
  // a string is not a comment.
  const bare = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"/g, (m) => (m[0] === "'" ? "''" : m[0] === '"' ? '""' : ' ')).trim();
  const body = bare.replace(/;\s*$/, '');
  if (!body) throw new Error('query: empty statement');
  if (body.includes(';')) throw new Error('query: only a single statement is allowed');
  const head = body.match(/^[a-z]+/i)?.[0].toLowerCase();
  if (head === 'pragma') {
    if (!/^pragma\s+(?:\w+\.)?(table_info|table_xinfo|table_list|index_list|index_info)\b/i.test(body) || body.includes('=')) throw new Error('query: only PRAGMA table_info / table_list are allowed');
  } else if (head !== 'select' && head !== 'with' && head !== 'explain' && head !== 'values') {
    throw new Error('query: read-only console. Only SELECT, WITH, EXPLAIN and PRAGMA table_info are allowed');
  }
  if (/\b(insert\s+(into|or)|replace\s+into|update\s+[\w".]+\s+set|delete\s+from|drop\s+(table|index|view|trigger)|create\s+|alter\s+table|attach\s+|detach\s+|vacuum|reindex)\b/i.test(body) && !/^explain\b/i.test(body)) {
    throw new Error('query: read-only console. Statements that write are rejected');
  }
  return sql.trim().replace(/;\s*$/, '');
}

export function query<T = Record<string, any>>(db: SqlDb, sql: string, params?: any[]): T[] {
  const clean = assertReadOnly(sql);
  if (db.isReadOnly && !db.isReadOnly(clean)) throw new Error('query: read-only console. Statements that write are rejected');
  return db.all<T>(clean, params, MAX_QUERY_ROWS);
}

export function annotate(db: SqlDb, ontology: Ontology, objectId: string, key: string, value: PropValue, note?: string, now: number = Date.now()): string {
  const cx = ctx(ontology);
  const oid = resolveId(db, cx, objectId);
  const obj = db.all<{ type: string }>('SELECT type FROM object WHERE id = ?', [oid])[0];
  if (!obj) throw new Error(`annotate: no object "${objectId}"`);
  const enc = encode(value);
  db.transaction(() => {
    // The writeback source must exist as a row for prop_best to rank it, even if ontology.json omitted it.
    db.exec(`INSERT OR IGNORE INTO source (id, name, org, url, license, kind) VALUES ('user', 'User annotation', 'Garita user', '', '', 'user')`);
    const old = db.all<any>(`SELECT value, vtype FROM prop WHERE object_id = ? AND key = ? AND source_id = 'user'`, [oid, key])[0];
    if (old) db.exec(`INSERT INTO prop_history (object_id, key, source_id, value, vtype, unit, observed_at, replaced_at) SELECT object_id, key, source_id, value, vtype, unit, observed_at, ? FROM prop WHERE object_id = ? AND key = ? AND source_id = 'user'`, [now, oid, key]);
    db.exec(`INSERT OR REPLACE INTO prop (object_id, key, value, vtype, unit, source_id, observed_at, confidence) VALUES (?,?,?,?,?, 'user', ?, NULL)`,
      [oid, key, enc.value, enc.vtype, cx.units.get(obj.type)?.get(key) ?? null, now]);
    db.exec('UPDATE object SET updated_at = MAX(updated_at, ?) WHERE id = ?', [now, oid]);
    db.exec('INSERT INTO action_log (t, action, object_id, payload) VALUES (?,?,?,?)',
      [now, 'annotate', oid, JSON.stringify({ key, value, previous: old ? decode(old.value, old.vtype) : null, note: note ?? null })]);
  });
  return obj.type;
}

export function actionLog(db: SqlDb, limit = 100): { t: number; action: string; objectId: string | null; payload: any }[] {
  return db.all<any>('SELECT t, action, object_id, payload FROM action_log ORDER BY id DESC LIMIT ?', [limit])
    .map((r) => ({ t: r.t, action: r.action, objectId: r.object_id, payload: r.payload ? JSON.parse(r.payload) : null }));
}

export function dbInfo(db: SqlDb, extra: { persistent: boolean; seedVersion: string; openedMs: number }): DbInfo {
  const n = (sql: string) => db.all<{ n: number }>(sql)[0].n;
  return { ...extra, objects: n('SELECT COUNT(*) AS n FROM object'), links: n('SELECT COUNT(*) AS n FROM link'), obs: n('SELECT COUNT(*) AS n FROM obs') };
}

// ---------- upkeep ----------
/** Run on every open: bounds the growth of a database that lives for months in a browser profile. */
export function housekeeping(db: SqlDb, ontology: Ontology, now: number = Date.now()): { obs: number; objects: number } {
  const ephemeral = ontology.objectTypes.filter((t) => t.ephemeral).map((t) => t.id);
  return db.transaction(() => {
    const obsBefore = db.all<{ n: number }>('SELECT COUNT(*) AS n FROM obs WHERE t < ?', [now - 14 * DAY])[0].n;
    if (obsBefore) db.exec('DELETE FROM obs WHERE t < ?', [now - 14 * DAY]);
    const dead = ephemeral.length
      ? db.all<{ rid: number; id: string }>(`SELECT rid, id FROM object WHERE expired = 1 AND COALESCE(valid_to, updated_at) < ? AND type IN (SELECT value FROM json_each(?))`, [now - 2 * DAY, JSON.stringify(ephemeral)])
      : [];
    for (const d of dead) {
      for (const t of ['prop', 'prop_history', 'identity', 'obs']) db.exec(`DELETE FROM ${t} WHERE object_id = ?`, [d.id]);
      db.exec('DELETE FROM link WHERE src = ? OR dst = ?', [d.id, d.id]);
      db.exec('DELETE FROM object_fts WHERE rowid = ?', [d.rid]);
      db.exec('DELETE FROM object_rtree WHERE id = ?', [d.rid]);
      db.exec('DELETE FROM object WHERE rid = ?', [d.rid]);
    }
    // Lineage of a feed polled every few minutes would otherwise grow for ever; the newest runs of each source stay.
    db.exec('DELETE FROM ingest_run WHERE finished_at < ? AND id NOT IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY id DESC) AS rn FROM ingest_run) WHERE rn <= 5)', [now - 14 * DAY]);
    return { obs: obsBefore, objects: dead.length };
  });
}

export interface CarryOver { actions: any[]; userProps: any[]; obs: any[] }
/** What a visitor would miss if a new seed version simply replaced their database. */
export function readCarryOver(db: SqlDb, now: number = Date.now()): CarryOver {
  return {
    actions: db.all('SELECT t, action, object_id, payload FROM action_log ORDER BY id'),
    userProps: db.all(`SELECT p.object_id, p.key, p.value, p.vtype, p.unit, p.source_id, p.observed_at, p.confidence FROM prop p JOIN source s ON s.id = p.source_id WHERE s.kind = 'user'`),
    obs: db.all('SELECT object_id, metric, t, value FROM obs WHERE t >= ?', [now - 7 * DAY]),
  };
}
export function writeCarryOver(db: SqlDb, c: CarryOver): void {
  db.transaction(() => {
    bulkInsert(db, 'INSERT INTO action_log (t, action, object_id, payload)', 4, c.actions.map((a) => [a.t, a.action, a.object_id, a.payload]));
    bulkInsert(db, 'INSERT OR REPLACE INTO prop (object_id, key, value, vtype, unit, source_id, observed_at, confidence)', 8,
      c.userProps.map((p) => [p.object_id, p.key, p.value, p.vtype, p.unit, p.source_id, p.observed_at, p.confidence]));
    bulkInsert(db, 'INSERT OR IGNORE INTO obs (object_id, metric, t, value)', 4, c.obs.map((o) => [o.object_id, o.metric, o.t, o.value]), 100);
  });
}

// ---------- TwinStore over a synchronous engine ----------
export interface EngineStore extends TwinStore {
  readonly db: SqlDb;
  close(): void;
}

/**
 * The TwinStore contract on top of the functions above. Node uses it directly; the browser worker dispatches
 * RPC calls onto the same object, so the two cannot drift apart.
 */
export function makeStore(db: SqlDb, ontology: Ontology, info: { persistent: boolean; seedVersion: string; openedMs: number }): EngineStore {
  const listeners = new Set<(e: ChangeEvent) => void>();
  const emit = (e: ChangeEvent) => { for (const cb of [...listeners]) { try { cb(e); } catch (err) { console.error('store onChange listener failed', err); } } };
  // Promise-returning even though the engine is synchronous: callers are written against the worker-backed store.
  const run = <T>(fn: () => T): Promise<T> => { try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); } };
  return {
    db,
    ontology,
    ready: run(() => dbInfo(db, info)),
    query: (sql, params) => run(() => query(db, sql, params)),
    getObject: (id) => run(() => getObject(db, ontology, id)),
    getLinks: (id, opts) => run(() => getLinks(db, ontology, id, opts)),
    listObjects: (type, opts) => run(() => listObjects(db, ontology, type, opts)),
    search: (text, opts) => run(() => search(db, ontology, text, opts)),
    series: (id, metric, opts) => run(() => series(db, ontology, id, metric, opts)),
    neighborhood: (id, opts) => run(() => neighborhood(db, ontology, id, opts)),
    countByType: () => run(() => countByType(db)),
    sources: () => run(() => sources(db, ontology)),
    ingest: (batch) => run(() => {
      const result = ingest(db, ontology, batch);
      emit({ source: batch.source, types: batchTypes(batch), at: Date.now(), result });
      return result;
    }),
    reportRun: (source, status, note, bytes) => run(() => reportRun(db, source, status, note, bytes)),
    annotate: (objectId, key, value, note) => run(() => {
      const type = annotate(db, ontology, objectId, key, value, note);
      emit({ source: 'user', types: [type], at: Date.now() });
    }),
    actionLog: (limit) => run(() => actionLog(db, limit)),
    onChange(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    close() { listeners.clear(); db.close?.(); },
  };
}

/**
 * An in-memory database, optionally loaded from the bytes of a database file (a seed). Used by Node and by the
 * browser when OPFS is unavailable.
 */
export function openMemoryDb(sqlite3: any, bytes?: Uint8Array): any {
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  if (bytes && bytes.byteLength) {
    const p = sqlite3.wasm.allocFromTypedArray(bytes);
    // FREEONCLOSE hands the buffer to SQLite; RESIZEABLE lets the database grow past the seed's size.
    const rc = sqlite3.capi.sqlite3_deserialize(db.pointer, 'main', p, bytes.byteLength, bytes.byteLength,
      sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
    db.checkRc(rc);
  }
  return db;
}

/** True when the bytes start like a database file. A static host answers a missing seed with an HTML page. */
export function looksLikeSqlite(bytes: Uint8Array): boolean {
  const magic = 'SQLite format 3\u0000';
  if (bytes.byteLength < 100) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic.charCodeAt(i)) return false;
  return true;
}

/** Creates the schema if the database is empty or of another schema version, then refreshes the ontology tables. */
export function prepareDb(db: SqlDb, ontology: Ontology, seedVersion: string): void {
  if (getMeta(db, 'schema_version') !== String(SCHEMA_VERSION)) createSchema(db);
  else upgradeInPlace(db);
  loadOntology(db, ontology);
  if (getMeta(db, 'seed_version') == null) setMeta(db, 'seed_version', seedVersion);
}

/**
 * Bounds a step that may neither finish nor fail (a storage call in a browser that never answers), so the caller
 * can fall back instead of waiting for ever. The step itself is not cancelled.
 */
export function timed<T>(what: string, p: Promise<T> | T, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
    // Some steps answer synchronously (importDb with a byte array in this build of the library).
    Promise.resolve(p).then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}
