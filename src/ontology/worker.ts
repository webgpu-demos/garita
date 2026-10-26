// The store's home in the browser: SQLite (wasm) in a module Worker, persisted in OPFS through the
// `opfs-sahpool` VFS, which needs no COOP/COEP headers (GitHub Pages cannot send them). Every call is forwarded
// to the same engine object Node uses. This file must not import src/core/config.ts: a worker has no page
// `location`, so the client sends absolute URLs.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { housekeeping, looksLikeSqlite, makeStore, openMemoryDb, prepareDb, readCarryOver, timed, wrapSqlite, writeCarryOver } from './engine.ts';
import type { CarryOver, EngineStore } from './engine.ts';
import { SCHEMA_VERSION } from './schema.ts';
import type { Ontology } from './types.ts';

export interface InitMessage { type: 'init'; ontology: Ontology; seedUrl?: string; seedVersion?: string; wasmUrl?: string }
export interface StoreDetail {
  /** 'opfs-sahpool' when the database survives a reload, 'memory' otherwise. */
  vfs: 'opfs-sahpool' | 'memory';
  /** How this session's database came to be. */
  origin: 'existing' | 'seed' | 'empty';
  file: string;
  sqlite: string;
  carriedOver: { actions: number; userProps: number; obs: number } | null;
  /** Milliseconds spent in each step of opening; a step that did not run is absent. */
  timings: { sqliteMs: number; lockMs?: number; vfsMs?: number; seedFetchMs?: number; importMs?: number; openMs?: number; prepareMs?: number; totalMs: number };
  notes: string[];
}

const METHODS = new Set(['query', 'getObject', 'getLinks', 'listObjects', 'search', 'series', 'neighborhood', 'countByType', 'sources', 'ingest', 'reportRun', 'annotate', 'actionLog', 'forgetSource']);
// A step of the persistent path that neither finishes nor fails must not keep the app on its loading screen.
const OPFS_STEP_TIMEOUT_MS = 6000;
const LOCK_NAME = 'garita-db';
const post = (m: any) => (self as any).postMessage(m);
const progress = (stage: string, fraction?: number) => post({ type: 'progress', stage, fraction });
let store: EngineStore | null = null;

/**
 * One tab at a time owns the persistent database: the access handles of `opfs-sahpool` are exclusive, and every
 * page of the origin (the site and its dev/<name>/ test pages) shares the same OPFS. The lock is held until this
 * worker dies, so another tab learns at once that it should open in memory, and gets its turn after a reload.
 */
function holdDbLock(): Promise<boolean> {
  const locks: any = (self as any).navigator?.locks;
  // Without the Locks API the pool is tried directly; a second tab then fails on the access handles instead.
  if (!locks?.request) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    locks.request(LOCK_NAME, { ifAvailable: true }, (lock: unknown) => {
      resolve(!!lock);
      return lock ? new Promise(() => { /* never settles: released when the worker goes away */ }) : undefined;
    }).catch(() => resolve(true));
  });
}

async function fetchSeed(url: string | undefined, notes: string[]): Promise<Uint8Array | null> {
  if (!url) return null;
  try {
    progress('seed', 0);
    const res = await fetch(url);
    if (!res.ok) { notes.push(`seed ${res.status} at ${url}`); return null; }
    let bytes: Uint8Array;
    const total = Number(res.headers.get('content-length')) || 0;
    if (res.body && total) {
      // Read in pieces so the page can show how far the download is. Content-Length counts compressed bytes when
      // the host compresses, so it is a guide for the fraction only, never a size to trust.
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); got += value.byteLength;
        progress('seed', Math.min(1, got / total));
      }
      bytes = new Uint8Array(got);
      let off = 0;
      for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }
    } else bytes = new Uint8Array(await res.arrayBuffer());
    progress('seed', 1);
    // A dev server or a static host may answer a missing file with an HTML page and status 200.
    if (!looksLikeSqlite(bytes)) { notes.push(`seed at ${url} is not a SQLite file`); return null; }
    return bytes;
  } catch (e) {
    notes.push(`seed fetch failed: ${(e as Error).message}`);
    return null;
  }
}

const schemaOf = (raw: any): string | null => { try { return raw.selectValue(`SELECT value FROM meta WHERE key = 'schema_version'`) ?? null; } catch { return null; } };

async function init(msg: InitMessage): Promise<void> {
  const t0 = performance.now();
  const notes: string[] = [];
  progress('sqlite');
  const sqlite3: any = await (sqlite3InitModule as any)({
    print: () => {}, printErr: (m: string) => notes.push(String(m)),
    ...(msg.wasmUrl ? { locateFile: () => msg.wasmUrl } : {}),
  });
  const seedVersion = msg.seedVersion ?? msg.ontology.version;
  const file = `/twin-${seedVersion.replace(/[^\w.-]/g, '_')}.db`;
  const timings: StoreDetail['timings'] = { sqliteMs: Math.round(performance.now() - t0), totalMs: 0 };
  const detail: StoreDetail = { vfs: 'memory', origin: 'empty', file, sqlite: sqlite3.version.libVersion, carriedOver: null, timings, notes };
  const lap = async <T>(key: keyof StoreDetail['timings'], p: Promise<T> | (() => T)): Promise<T> => {
    const t = performance.now();
    try { return await (typeof p === 'function' ? p() : p); } finally { timings[key] = Math.round(performance.now() - t); }
  };
  let raw: any = null;
  let carry: CarryOver | null = null;
  let seed: Uint8Array | null | undefined;      // undefined = not fetched yet
  const getSeed = async () => (seed !== undefined ? seed : (seed = await lap('seedFetchMs', fetchSeed(msg.seedUrl, notes))));

  let pool: any = null;
  const owner = await lap('lockMs', holdDbLock());
  if (!owner) notes.push('another tab holds the persistent database: this tab works on an in-memory copy and its changes are not kept');
  else {
    progress('storage');
    try {
      pool = await lap('vfsMs', timed('installOpfsSAHPoolVfs', sqlite3.installOpfsSAHPoolVfs({ name: 'opfs-sahpool', directory: '.garita-db', initialCapacity: 8 }), OPFS_STEP_TIMEOUT_MS));
    } catch (e) {
      // Typical causes: no OPFS (private window, old browser), or the files are held by a page that predates the lock.
      notes.push(`opfs-sahpool unavailable: ${(e as Error).message}`);
    }
  }
  if (pool) {
    try {
      const names: string[] = pool.getFileNames();
      if (names.includes(file)) {
        raw = new pool.OpfsSAHPoolDb(file);
        const found = schemaOf(raw);
        if (found === String(SCHEMA_VERSION)) detail.origin = 'existing';
        else {
          // Not migrated on purpose: everything but the user's own input can be fetched again.
          notes.push(`stored database has schema ${found}, this build needs ${SCHEMA_VERSION}: replaced from the seed`);
          raw.close(); raw = null; pool.unlink(file);
        }
      } else {
        const old = names.filter((n) => /^\/twin-.*\.db$/.test(n)).sort();
        if (old.length) {
          try {
            const prev = wrapSqlite(sqlite3, new pool.OpfsSAHPoolDb(old[old.length - 1]));
            try { carry = readCarryOver(prev); } finally { prev.close?.(); }
          } catch (e) { notes.push(`carry-over from ${old[old.length - 1]} skipped: ${(e as Error).message}`); }
        }
        // Journals of the old files go too; this VFS has a fixed number of slots.
        for (const n of names) if (n !== file && /^\/twin-/.test(n)) pool.unlink(n);
      }
      if (!raw) {
        const bytes = await getSeed();
        if (bytes) {
          progress('import');
          await lap('importMs', () => timed('importDb', pool.importDb(file, bytes), OPFS_STEP_TIMEOUT_MS));
          detail.origin = 'seed';
        }
        raw = new pool.OpfsSAHPoolDb(file);
        if (bytes && schemaOf(raw) !== String(SCHEMA_VERSION)) {
          notes.push(`seed has schema ${schemaOf(raw)}, this build needs ${SCHEMA_VERSION}: starting empty`);
          raw.close(); raw = null; pool.unlink(file);
          raw = new pool.OpfsSAHPoolDb(file);
          detail.origin = 'empty';
        }
      }
      detail.vfs = 'opfs-sahpool';
    } catch (e) {
      notes.push(`opfs-sahpool open failed: ${(e as Error).message}`);
      try { raw?.close(); } catch { /* already closed */ }
      raw = null;
    }
  }
  if (!raw) {
    const bytes = await getSeed();
    progress('import');
    raw = openMemoryDb(sqlite3, bytes ?? undefined);
    detail.origin = bytes ? 'seed' : 'empty';
    if (bytes && schemaOf(raw) !== String(SCHEMA_VERSION)) { notes.push(`seed has schema ${schemaOf(raw)}: starting empty`); raw.close(); raw = openMemoryDb(sqlite3); detail.origin = 'empty'; }
  }

  progress('open');
  const db = wrapSqlite(sqlite3, raw);
  await lap('prepareMs', () => {
    db.exec('PRAGMA temp_store = MEMORY; PRAGMA cache_size = -32000;');
    prepareDb(db, msg.ontology, seedVersion);
    if (carry) {
      try {
        writeCarryOver(db, carry);
        detail.carriedOver = { actions: carry.actions.length, userProps: carry.userProps.length, obs: carry.obs.length };
      } catch (e) { notes.push(`carry-over not applied: ${(e as Error).message}`); }
    }
  });

  timings.totalMs = Math.round(performance.now() - t0);
  store = makeStore(db, msg.ontology, { persistent: detail.vfs === 'opfs-sahpool', seedVersion, openedMs: timings.totalMs });
  store.onChange((event) => post({ type: 'change', event }));
  post({ type: 'ready', info: await store.ready, detail });
  // Trimming old observations and long-expired objects can take a while on a database that has lived for months;
  // nothing waits for it, so it runs once the app is up.
  setTimeout(() => { try { housekeeping(db, msg.ontology); } catch (e) { console.warn('store housekeeping failed', e); } }, 4000);
}

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  if (m?.type === 'init') {
    init(m).catch((e) => post({ type: 'failed', error: String((e as Error)?.message ?? e) }));
    return;
  }
  if (m?.type !== 'call') return;
  if (!store || !METHODS.has(m.method)) { post({ type: 'result', id: m.id, error: !store ? 'store is not open' : `unknown method ${m.method}` }); return; }
  (store as any)[m.method](...(m.args ?? [])).then(
    (result: any) => post({ type: 'result', id: m.id, result }),
    (e: any) => post({ type: 'result', id: m.id, error: String(e?.message ?? e) }),
  );
};
