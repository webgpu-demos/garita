// Main-thread side of the store: a TwinStore whose every method is a message to the worker (worker.ts).
import type { ChangeEvent, DbInfo, Ontology, TwinStore } from './types.ts';
import type { InitMessage, StoreDetail } from './worker.ts';

export interface CreateStoreOptions {
  ontology: Ontology;
  /** The seed database (data/twin.db). Relative URLs resolve against the page. Missing file = start empty. */
  seedUrl?: string;
  /** Names the persisted file; a new value replaces the visitor's database with the new seed. Default: ontology.version. */
  seedVersion?: string;
  /** Override for the location of sqlite3.wasm (the bundler normally places it next to the worker). */
  wasmUrl?: string;
  /**
   * Called while the database opens, for a loading screen. Stages in order: 'sqlite', 'storage', 'seed' (with the
   * downloaded fraction 0..1, first visit only), 'import', 'open', 'ready'.
   */
  onProgress?: (stage: string, fraction?: number) => void;
}
export interface WorkerStore extends TwinStore {
  /** How the database was opened: VFS in use, where the data came from, notes on any fallback. */
  detail: Promise<StoreDetail>;
  terminate(): void;
}
export type { StoreDetail };

export function createStore(opts: CreateStoreOptions): WorkerStore {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const listeners = new Set<(e: ChangeEvent) => void>();
  let seq = 0;
  let opened!: (v: { info: DbInfo; detail: StoreDetail }) => void;
  let failed!: (e: Error) => void;
  const open = new Promise<{ info: DbInfo; detail: StoreDetail }>((res, rej) => { opened = res; failed = rej; });
  // Callers that never look at `ready` must not produce an unhandled rejection; their calls reject instead.
  open.catch(() => {});

  worker.onmessage = (ev: MessageEvent) => {
    const m = ev.data;
    if (m.type === 'result') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error != null) p.reject(new Error(m.error)); else p.resolve(m.result);
    } else if (m.type === 'change') {
      for (const cb of [...listeners]) { try { cb(m.event); } catch (e) { console.error('store onChange listener failed', e); } }
    } else if (m.type === 'progress') { try { opts.onProgress?.(m.stage, m.fraction); } catch (e) { console.error('store onProgress failed', e); } }
    else if (m.type === 'ready') { try { opts.onProgress?.('ready', 1); } catch { /* the app's own display problem */ } opened({ info: m.info, detail: m.detail }); }
    else if (m.type === 'failed') failed(new Error(`store failed to open: ${m.error}`));
  };
  worker.onerror = (e) => {
    const err = new Error(`store worker error: ${e.message || 'could not load the worker'}`);
    failed(err);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  const abs = (u?: string) => (u ? new URL(u, location.href).href : undefined);
  const init: InitMessage = { type: 'init', ontology: opts.ontology, seedUrl: abs(opts.seedUrl), seedVersion: opts.seedVersion, wasmUrl: abs(opts.wasmUrl) };
  worker.postMessage(init);

  const call = (method: string) => (...args: any[]): Promise<any> => open.then(() => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ type: 'call', id, method, args });
  }));

  return {
    ontology: opts.ontology,
    ready: open.then((o) => o.info),
    detail: open.then((o) => o.detail),
    query: call('query'), getObject: call('getObject'), getLinks: call('getLinks'), listObjects: call('listObjects'), search: call('search'),
    series: call('series'), neighborhood: call('neighborhood'), countByType: call('countByType'), sources: call('sources'), ingest: call('ingest'),
    reportRun: call('reportRun'), annotate: call('annotate'), actionLog: call('actionLog'), forgetSource: call('forgetSource'),
    onChange(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    terminate() { worker.terminate(); listeners.clear(); },
  };
}
