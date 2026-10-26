// DEV ONLY. An in-memory TwinStore (just enough of the interface for the UI) loaded from the recorded payloads in
// tests/fixtures: real values captured from the real endpoints, nothing made up. The production build never imports
// this file; the real store is src/ontology/client.ts.
import ontologyJson from '../ontology/ontology.json';
import type {
  TwinStore, Ontology, ObjectRecord, ObjectSummary, PropRecord, LinkRecord, Series, IngestBatch, IngestResult, ListOptions,
  ChangeEvent, SourceStatus, PropValue, DbInfo, Neighborhood,
} from '../ontology/types';
import quakes from '../../tests/fixtures/usgs_quakes_30d.json';
import alerts from '../../tests/fixtures/nws_alerts_all_recent.json';
import luma from '../../tests/fixtures/luma_regions.json';
import nwps from '../../tests/fixtures/nwps_gauges.json';
import wl from '../../tests/fixtures/coops_wl_9755371.json';
import pred from '../../tests/fixtures/coops_pred_9755371.json';
import obsTJSJ from '../../tests/fixtures/nws_obs_TJSJ.json';
import nhc from '../../tests/fixtures/nhc_current.json';
import counties from '../../tests/fixtures/nws_zones_county_pr.json';
import recordedAtTxt from '../../tests/fixtures/recorded_at.txt?raw';

const ontology = ontologyJson as unknown as Ontology;
export const RECORDED_AT = Date.parse(recordedAtTxt.trim()) || Date.now();

interface Obj { rec: Omit<ObjectRecord, 'allProps' | 'props'>; props: Map<string, PropRecord[]>; text: string }

const R = Math.PI / 180;
function km(lat1: number, lon1: number, lat2: number, lon2: number) {
  const a = Math.sin(((lat2 - lat1) * R) / 2) ** 2 + Math.cos(lat1 * R) * Math.cos(lat2 * R) * Math.sin(((lon2 - lon1) * R) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

export function createMockStore(): TwinStore & { replaySevereAlerts(): Promise<void> } {
  const objects = new Map<string, Obj>();
  const links: LinkRecord[] = [];
  const obs = new Map<string, { t: number; v: number }[]>();
  const runs = new Map<string, SourceStatus['lastRun']>();
  const log: { t: number; action: string; objectId: string | null; payload: any }[] = [];
  const listeners = new Set<(e: ChangeEvent) => void>();
  const typeDef = (id: string) => ontology.objectTypes.find((x) => x.id === id);

  const bestProps = (o: Obj, keys?: string[]): Record<string, PropValue> => {
    const out: Record<string, PropValue> = {};
    const want = keys ?? typeDef(o.rec.type)?.properties.filter((p) => p.primary).map((p) => p.id) ?? [];
    for (const k of want) { const r = o.props.get(k)?.find((p) => p.source !== 'user'); if (r) out[k] = r.value; }
    return out;
  };
  const summary = (o: Obj, keys?: string[]): ObjectSummary => {
    const { id, type, key, name, lon, lat, status, severity, updatedAt } = o.rec;
    return { id, type, key, name, lon, lat, status, severity, updatedAt, props: bestProps(o, keys) };
  };
  const isExpired = (o: Obj, now: number) => o.rec.status === 'expired' || (!!typeDef(o.rec.type)?.ephemeral && o.rec.validTo != null && o.rec.validTo < now);

  async function ingest(batch: IngestBatch): Promise<IngestResult> {
    const t0 = performance.now();
    const at = batch.observedAt ?? batch.fetchedAt;
    let created = 0, changed = 0;
    const types = new Set<string>();
    for (const inp of batch.objects ?? []) {
      const id = `${inp.type}:${inp.key}`;
      types.add(inp.type);
      let o = objects.get(id);
      if (!o) {
        created++;
        o = { rec: { id, type: inp.type, key: inp.key, name: inp.name ?? inp.key, lon: inp.lon ?? null, lat: inp.lat ?? null, status: inp.status ?? null, severity: inp.severity ?? null,
          updatedAt: at, source: batch.source, firstSeen: at, validFrom: inp.validFrom ?? null, validTo: inp.validTo ?? null, geometry: inp.geometry ?? null, identities: [], metrics: [] }, props: new Map(), text: '' };
        objects.set(id, o);
      } else {
        changed++;
        if (inp.name) o.rec.name = inp.name;
        if (inp.lon != null) o.rec.lon = inp.lon;
        if (inp.lat != null) o.rec.lat = inp.lat;
        if (inp.status !== undefined) o.rec.status = inp.status;
        if (inp.severity !== undefined) o.rec.severity = inp.severity;
        if (inp.validFrom !== undefined) o.rec.validFrom = inp.validFrom;
        if (inp.validTo !== undefined) o.rec.validTo = inp.validTo;
        o.rec.updatedAt = Math.max(o.rec.updatedAt, at);
      }
      for (const [scheme, key] of inp.identities ?? []) if (!o.rec.identities.some((x) => x.scheme === scheme && x.key === key)) o.rec.identities.push({ scheme, key });
      for (const [k, raw] of Object.entries(inp.props ?? {})) {
        const p = raw != null && typeof raw === 'object' ? raw : { value: raw as PropValue };
        if (p.value == null) continue;
        const list = o.props.get(k) ?? [];
        const rec: PropRecord = { key: k, value: p.value, unit: (p as any).unit ?? null, source: batch.source, observedAt: (p as any).observedAt ?? at, confidence: (p as any).confidence ?? null };
        const i = list.findIndex((x) => x.source === batch.source);
        if (i >= 0) list[i] = rec; else list.push(rec);
        list.sort((a, b) => b.observedAt - a.observedAt);
        o.props.set(k, list);
      }
      o.text = [o.rec.name, o.rec.id, inp.text ?? o.text, ...o.rec.identities.map((x) => x.key)].join(' ').toLowerCase();
    }
    for (const l of batch.links ?? []) {
      if (links.some((x) => x.src === l.src && x.dst === l.dst && x.type === l.type)) continue;
      links.push({ src: l.src, dst: l.dst, type: l.type, source: batch.source, observedAt: at, confidence: l.confidence ?? null, note: l.note ?? null });
    }
    for (const x of batch.obs ?? []) {
      const k = `${x.object}|${x.metric}`;
      let s = obs.get(k); if (!s) obs.set(k, (s = []));
      s.push({ t: x.t, v: x.value });
      const o = objects.get(x.object); if (o && !o.rec.metrics.includes(x.metric)) o.rec.metrics.push(x.metric);
    }
    for (const s of obs.values()) s.sort((a, b) => a.t - b.t);
    const result: IngestResult = { source: batch.source, objects: batch.objects?.length ?? 0, created, changed, links: batch.links?.length ?? 0, obs: batch.obs?.length ?? 0, expired: 0, ms: performance.now() - t0 };
    runs.set(batch.source, { startedAt: batch.fetchedAt, finishedAt: batch.fetchedAt, status: 'ok', objects: result.objects, obs: result.obs, bytes: batch.bytes ?? 0, note: batch.note });
    const ev: ChangeEvent = { source: batch.source, types: [...types], at: Date.now(), result };
    queueMicrotask(() => listeners.forEach((cb) => cb(ev)));
    return result;
  }

  const cmp = (a: PropValue | undefined, op: string, b: PropValue) => {
    if (a == null) return false;
    switch (op) {
      case '=': return a === b; case '!=': return a !== b;
      case '>': return a > (b as any); case '>=': return a >= (b as any); case '<': return a < (b as any); case '<=': return a <= (b as any);
      case 'like': return String(a).toLowerCase().includes(String(b).toLowerCase().replace(/%/g, ''));
    }
    return false;
  };

  const store: TwinStore & { replaySevereAlerts(): Promise<void> } = {
    ontology,
    ready: Promise.resolve({ persistent: false, seedVersion: 'dev-fixtures', objects: 0, links: 0, obs: 0, openedMs: 0 } as DbInfo),
    async query() { return []; },
    async getObject(id) {
      const o = objects.get(id); if (!o) return null;
      const allProps = [...o.props.values()].flat();
      return { ...o.rec, props: bestProps(o), allProps };
    },
    async getLinks(id, opts = {}) {
      const dir = opts.direction ?? 'both';
      return links.filter((l) => (!opts.type || l.type === opts.type) && ((dir !== 'in' && l.src === id) || (dir !== 'out' && l.dst === id))).slice(0, opts.limit ?? 500)
        .map((l) => ({ ...l, srcName: objects.get(l.src)?.rec.name, srcType: l.src.split(':')[0], dstName: objects.get(l.dst)?.rec.name, dstType: l.dst.split(':')[0] }));
    },
    async listObjects(type, opts: ListOptions = {}) {
      const types = Array.isArray(type) ? type : [type];
      const now = Date.now();
      let rows = [...objects.values()].filter((o) => types.includes(o.rec.type));
      if (!opts.includeExpired) rows = rows.filter((o) => !isExpired(o, now));
      if (opts.status) { const st = Array.isArray(opts.status) ? opts.status : [opts.status]; rows = rows.filter((o) => st.includes(o.rec.status ?? '')); }
      if (opts.bbox) { const [w, s, e, n] = opts.bbox; rows = rows.filter((o) => o.rec.lon != null && o.rec.lat != null && o.rec.lon >= w && o.rec.lon <= e && o.rec.lat >= s && o.rec.lat <= n); }
      for (const [k, cond] of Object.entries(opts.where ?? {})) {
        const [op, val] = Array.isArray(cond) ? cond : ['=', cond];
        rows = rows.filter((o) => cmp(k === 'status' ? o.rec.status : k === 'severity' ? o.rec.severity : o.props.get(k)?.[0]?.value, op, val as PropValue));
      }
      const ob = opts.orderBy ?? 'name'; const desc = ob.startsWith('-'); const key = desc ? ob.slice(1) : ob;
      const val = (o: Obj): any => (key in o.rec ? (o.rec as any)[key] : o.props.get(key)?.[0]?.value);
      rows.sort((a, b) => { const x = val(a), y = val(b); return (x == null ? 1 : y == null ? -1 : typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * (desc ? -1 : 1); });
      return rows.slice(0, opts.limit ?? 1000).map((o) => summary(o, opts.props));
    },
    async search(text, opts = {}) {
      const words = text.toLowerCase().split(/\s+/).filter(Boolean);
      const now = Date.now();
      return [...objects.values()].filter((o) => (!opts.types || opts.types.includes(o.rec.type)) && words.every((w) => o.text.includes(w)))
        .sort((a, b) => Number(isExpired(a, now)) - Number(isExpired(b, now)) || Number(!a.rec.name.toLowerCase().startsWith(words[0])) - Number(!b.rec.name.toLowerCase().startsWith(words[0])) || b.rec.updatedAt - a.rec.updatedAt)
        .slice(0, opts.limit ?? 20).map((o) => summary(o));
    },
    async series(objectId, metric, opts = {}): Promise<Series> {
      let s = obs.get(`${objectId}|${metric}`) ?? [];
      if (opts.since != null) s = s.filter((p) => p.t >= opts.since!);
      if (opts.until != null) s = s.filter((p) => p.t <= opts.until!);
      const step = opts.maxPoints && s.length > opts.maxPoints ? Math.ceil(s.length / opts.maxPoints) : 1;
      if (step > 1) s = s.filter((_, i) => i % step === 0 || i === s.length - 1);
      return { t: s.map((p) => p.t), v: s.map((p) => p.v) };
    },
    async neighborhood(id): Promise<Neighborhood> {
      const ls = await store.getLinks(id);
      const ids = new Set([id, ...ls.map((l) => l.src), ...ls.map((l) => l.dst)]);
      return { nodes: [...ids].map((i) => objects.get(i)).filter(Boolean).map((o) => summary(o!)), links: ls };
    },
    async countByType() {
      const out: Record<string, number> = {}; const now = Date.now();
      for (const o of objects.values()) if (!isExpired(o, now)) out[o.rec.type] = (out[o.rec.type] ?? 0) + 1;
      return out;
    },
    async sources() {
      const n: Record<string, number> = {};
      for (const o of objects.values()) n[o.rec.source] = (n[o.rec.source] ?? 0) + 1;
      return ontology.sources.map((source) => ({ source, lastRun: runs.get(source.id), objectCount: n[source.id] ?? 0 }));
    },
    ingest,
    async reportRun(source, status, note, bytes) { runs.set(source, { startedAt: Date.now(), finishedAt: Date.now(), status, objects: 0, obs: 0, bytes: bytes ?? 0, note }); listeners.forEach((cb) => cb({ source, types: [], at: Date.now() })); },
    async annotate(objectId, key, value, note) {
      const o = objects.get(objectId); if (!o) throw new Error('no such object ' + objectId);
      const list = o.props.get(key) ?? [];
      list.unshift({ key, value, source: 'user', observedAt: Date.now(), confidence: null, unit: null });
      o.props.set(key, list);
      log.unshift({ t: Date.now(), action: 'annotate', objectId, payload: { key, value, note } });
      const ev: ChangeEvent = { source: 'user', types: [o.rec.type], at: Date.now() };
      queueMicrotask(() => listeners.forEach((cb) => cb(ev)));
    },
    async actionLog(limit = 100) { return log.slice(0, limit); },
    async forgetSource(source) {
      let n = 0; const types = new Set<string>();
      for (const [id, o] of objects) if (o.rec.source === source) { objects.delete(id); types.add(o.rec.type); n++; }
      const ev: ChangeEvent = { source, types: [...types], at: Date.now() };
      queueMicrotask(() => listeners.forEach((cb) => cb(ev)));
      return { objects: n, props: 0, links: 0 };
    },
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    /** Dev check for toasts: re-issues the recorded Flash Flood Warnings as active, clearly labelled as a replay. */
    async replaySevereAlerts() {
      const now = Date.now();
      const sev = (alerts as any).features.filter((f: any) => f.properties.severity === 'Severe').slice(0, 2);
      await ingest({ source: 'nws_alerts', fetchedAt: now, objects: sev.map((f: any) => ({ type: 'weather_alert', key: 'replay-' + f.properties.id.slice(-12), name: `REPLAY · ${f.properties.event}`, status: 'active', severity: 3,
        validFrom: now, validTo: now + 30 * 60e3, props: { event: f.properties.event, severity_text: 'Severe', area_desc: f.properties.areaDesc, expires: new Date(now + 30 * 60e3).toISOString() } })) });
    },
  };

  // ---------- load the recorded payloads ----------
  const at = RECORDED_AT;
  const num = (v: any) => (v == null || v === '' || +v === -999 || !Number.isFinite(+v) ? null : +v);
  const SEV: Record<string, number> = { Minor: 1, Moderate: 2, Severe: 3, Extreme: 4 };
  const FLOOD: Record<string, number> = { action: 1, minor: 2, moderate: 3, major: 4 };

  ingest({ source: 'nws_alerts', fetchedAt: at, note: 'dev fixture: county list from api.weather.gov/zones',
    objects: (counties as any).features.map((f: any) => ({ type: 'municipio', key: '72' + f.properties.id.slice(3), name: f.properties.name, identities: [['nws:zone', f.properties.id]] })) });
  const quakeSev = (m: number) => (m >= 6 ? 4 : m >= 5 ? 3 : m >= 4 ? 2 : m >= 3 ? 1 : 0);
  ingest({ source: 'usgs_quakes', fetchedAt: at,
    objects: (quakes as any).features.map((f: any) => { const p = f.properties, c = f.geometry.coordinates; return { type: 'earthquake', key: f.id, name: p.title, lon: c[0], lat: c[1], status: p.status, severity: quakeSev(p.mag), validFrom: p.time,
      props: { magnitude: p.mag, depth_km: c[2], place: p.place, mag_type: p.magType, felt_reports: p.felt, tsunami: !!p.tsunami, network: p.net, status_text: p.status, url: p.url }, text: p.place }; }) });
  const alertObjs: any[] = [], alertLinks: any[] = [];
  for (const f of (alerts as any).features) {
    const p = f.properties; const key = p.id.replace('urn:oid:', '');
    const exp = Date.parse(p.ends ?? p.expires);
    alertObjs.push({ type: 'weather_alert', key, name: p.event, status: exp < Date.now() ? 'expired' : 'active', severity: SEV[p.severity] ?? 0, validFrom: Date.parse(p.onset ?? p.sent), validTo: exp,
      props: { event: p.event, severity_text: p.severity, urgency: p.urgency, certainty: p.certainty, headline: p.headline, description: p.description, instruction: p.instruction, area_desc: p.areaDesc, sender: p.senderName, onset: p.onset, expires: p.ends ?? p.expires }, text: `${p.areaDesc} ${p.headline ?? ''}` });
    for (const ugc of p.geocode?.UGC ?? []) if (/^PRC\d{3}$/.test(ugc)) alertLinks.push({ src: `weather_alert:${key}`, type: 'affects', dst: `municipio:72${ugc.slice(3)}` });
  }
  ingest({ source: 'nws_alerts', fetchedAt: at, objects: alertObjs, links: alertLinks });
  ingest({ source: 'luma', fetchedAt: at, note: (luma as any).timestamp ? `LUMA timestamp ${(luma as any).timestamp}` : undefined,
    objects: (luma as any).regions.map((r: any) => ({ type: 'power_region', key: r.name.toLowerCase().replace(/\s+/g, '_'), name: r.name, severity: r.percentageClientsWithoutService >= 2 ? 2 : 0,
      props: { customers: r.totalClients, customers_out: r.totalClientsWithoutService, pct_out: r.percentageClientsWithoutService, customers_planned: r.totalClientsAffectedByPlannedOutage, customers_load_shed: r.totalClientsAffectedByLoadShed } })) });
  ingest({ source: 'nwps', fetchedAt: at,
    objects: (nwps as any).gauges.map((g: any) => { const o = g.status.observed; const st = num(o.primary), q = num(o.secondary); const t = Date.parse(o.validTime); const isLake = /^HP/.test(g.pedts?.observed ?? '');
      return { type: 'stream_gauge', key: g.lid, name: g.name, lon: g.longitude, lat: g.latitude, status: o.floodCategory, severity: FLOOD[o.floodCategory] ?? 0, identities: [['nws:lid', g.lid]],
        props: { stage_m: st != null && !isLake ? { value: +(st * 0.3048).toFixed(3), observedAt: t } : null, discharge_m3s: q != null ? { value: +(q * 28.3168).toFixed(3), observedAt: t } : null, flood_category: o.floodCategory, forecast_category: g.status.forecast?.floodCategory, nws_lid: g.lid } as any }; }) });
  const gmt = (s: string) => Date.parse(s.replace(' ', 'T') + ':00Z');
  const wlRows = ((wl as any).data as any[]).filter((d) => d.v !== '').map((d) => ({ t: gmt(d.t), v: +d.v }));
  const prRows = ((pred as any).predictions as any[]).map((d) => ({ t: gmt(d.t), v: +d.v }));
  const lastWl = wlRows[wlRows.length - 1];
  const predAt = lastWl && prRows.find((p) => p.t === lastWl.t);
  const meta = (wl as any).metadata;
  ingest({ source: 'coops', fetchedAt: at,
    objects: [{ type: 'tide_station', key: meta.id, name: meta.name, lon: +meta.lon, lat: +meta.lat, status: 'active',
      props: { water_level_m: lastWl ? { value: lastWl.v, observedAt: lastWl.t } : null, predicted_m: predAt ? { value: predAt.v, observedAt: predAt.t } : null } as any }],
    obs: [...wlRows.map((r) => ({ object: `tide_station:${meta.id}`, metric: 'water_level_m', t: r.t, value: r.v })), ...prRows.filter((r) => !lastWl || r.t <= lastWl.t).map((r) => ({ object: `tide_station:${meta.id}`, metric: 'predicted_m', t: r.t, value: r.v }))] });
  const op = (obsTJSJ as any).properties; const ot = Date.parse(op.timestamp);
  ingest({ source: 'nws_obs', fetchedAt: at, observedAt: ot,
    objects: [{ type: 'weather_station', key: op.stationId, name: op.stationName, lon: (obsTJSJ as any).geometry.coordinates[0], lat: (obsTJSJ as any).geometry.coordinates[1], status: 'active',
      props: { temp_c: num(op.temperature?.value), wind_ms: num(op.windSpeed?.value) != null ? +(op.windSpeed.value / 3.6).toFixed(2) : null, wind_dir_deg: num(op.windDirection?.value), gust_ms: num(op.windGust?.value) != null ? +(op.windGust.value / 3.6).toFixed(2) : null,
        pressure_hpa: num(op.barometricPressure?.value) != null ? op.barometricPressure.value / 100 : null, humidity_pct: num(op.relativeHumidity?.value) != null ? Math.round(op.relativeHumidity.value) : null, conditions: op.textDescription, visibility_km: num(op.visibility?.value) != null ? op.visibility.value / 1000 : null } }] });
  const storms = (nhc as any).activeStorms ?? [];
  const CLS: Record<string, number> = { TD: 1, STD: 1, TS: 2, STS: 2, HU: 3, MH: 4 };
  ingest({ source: 'nhc', fetchedAt: at,
    objects: storms.map((s: any) => ({ type: 'tropical_cyclone', key: s.id, name: `${s.classification === 'HU' ? 'Hurricane' : s.classification === 'TS' ? 'Tropical Storm' : s.classification} ${s.name}`, lon: s.longitudeNumeric, lat: s.latitudeNumeric, status: 'active', severity: CLS[s.classification] ?? 1,
      props: { classification: s.classification, intensity_kt: num(s.intensity), pressure_hpa: num(s.pressure), movement_dir_deg: num(s.movementDir), movement_kt: num(s.movementSpeed), last_update: s.lastUpdate, advisory_url: s.publicAdvisory?.url } })) });
  ingest({ source: 'garita_derived', fetchedAt: at,
    objects: [
      ...storms.map((s: any) => ({ type: 'tropical_cyclone', key: s.id, props: { distance_to_pr_km: Math.round(km(18.22, -66.45, s.latitudeNumeric, s.longitudeNumeric)) } })),
      ...(lastWl && predAt ? [{ type: 'tide_station', key: meta.id, props: { residual_m: { value: +(lastWl.v - predAt.v).toFixed(3), observedAt: lastWl.t } } as any }] : []),
    ] });
  return store;
}

/** Wind at San Juan from the recorded METAR, for S.weather in the dev page. */
export function recordedWind(): { windMs: number; windDirDeg: number; observedAt: number } | null {
  const p = (obsTJSJ as any).properties;
  if (p?.windSpeed?.value == null || p?.windDirection?.value == null) return null;
  return { windMs: p.windSpeed.value / 3.6, windDirDeg: p.windDirection.value, observedAt: Date.parse(p.timestamp) };
}
