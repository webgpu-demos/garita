// The contract between the store (ontology/), the feeds (feeds/), the pipeline (pipeline/), the UI (ui/) and the
// 3D world (world/). Everything the twin knows is an Object, a Link between two objects, a Property of an object
// with its provenance, or an Observation (a number at a time). Types of objects and links are data
// (ontology.json), not code.

export type Lang = 'en' | 'es';
export type L10n = { en: string; es: string };

// ---------- ontology definition (ontology.json) ----------
export type ObjectKind = 'place' | 'asset' | 'sensor' | 'event' | 'track' | 'record' | 'org';
export type PropType = 'number' | 'string' | 'boolean' | 'date' | 'url' | 'enum' | 'json';

export interface PropertyDef {
  id: string;                 // snake_case, unique within the object type
  label: L10n;
  type: PropType;
  unit?: string;              // SI or plain ('m', 'm3/s', 'people', 'USD', '%', 'kt', 'hPa', 'degC')
  format?: 'int' | 'fixed1' | 'fixed2' | 'usd' | 'pct' | 'date' | 'datetime';
  /** Shown in the object header and in tables by default. */
  primary?: boolean;
}
export interface MetricDef {
  id: string;                 // time-series metric id, e.g. 'stage_m', 'water_level_m', 'customers_out'
  label: L10n;
  unit: string;
}
export interface ObjectTypeDef {
  id: string;                 // snake_case, e.g. 'municipio', 'stream_gauge', 'weather_alert'
  kind: ObjectKind;
  label: L10n;
  plural: L10n;
  /** Canonical identity scheme: object ids are `${id}:${key}` where key is the id in this scheme. */
  keyScheme: string;          // 'census:geoid', 'usgs:site_no', 'noaa:coops', 'nws:alert', 'usgs:eventid', 'osm', 'hud:id', ...
  icon: string;               // name of a glyph in ui/icons.ts
  color: string;              // hex; marker and chip colour
  properties: PropertyDef[];
  metrics?: MetricDef[];
  /** Layer group in the layer rail: 'hazards' | 'water' | 'housing' | 'infrastructure' | 'boundaries' | 'atmosphere' | 'tracks' | 'records'. */
  group: string;
  /** Live objects of this type disappear when their source stops reporting them (alerts, aircraft). */
  ephemeral?: boolean;
}
export interface LinkTypeDef {
  id: string;                 // e.g. 'located_in', 'affects', 'monitors', 'serves', 'declared_for', 'near', 'same_as'
  label: L10n;                // reads src -> dst: "Shelter X [is located in] Municipio Y"
  inverse: L10n;              // reads dst -> src: "Municipio Y [contains] Shelter X"
  from: string[];             // object type ids ('*' = any)
  to: string[];
}
export interface SourceDef {
  id: string;                 // e.g. 'nws_alerts', 'usgs_nwis', 'osm', 'census_acs5_2023', 'hud_public_housing'
  name: string;
  org: string;
  url: string;                // human landing page
  license: string;
  kind: 'baked' | 'live' | 'relay' | 'derived' | 'user';
  /** Expected refresh interval in seconds for live and relay sources. */
  cadence_s?: number;
  note?: string;
}
export interface Ontology {
  version: string;
  objectTypes: ObjectTypeDef[];
  linkTypes: LinkTypeDef[];
  sources: SourceDef[];
}

// ---------- records ----------
export type PropValue = number | string | boolean | null;

/** One value of one property, from one source, with when it was observed. Several sources may disagree. */
export interface PropRecord {
  key: string;
  value: PropValue;
  unit?: string | null;
  source: string;             // SourceDef.id
  observedAt: number;         // epoch ms: when the source says this was true / measured
  confidence?: number | null; // 0..1; null = as reported
}
export interface ObjectSummary {
  id: string;                 // `${type}:${key}`
  type: string;
  key: string;
  name: string;
  lon: number | null;
  lat: number | null;
  status?: string | null;     // free short state: 'active', 'expired', 'unconfirmed', 'minor_flood', ...
  severity?: number | null;   // 0 none .. 4 extreme; drives colour and sorting of events and sensors
  updatedAt: number;          // last time any source touched it
  validFrom?: number | null;  // for events: start; for records: date
  validTo?: number | null;
  /** A few primary properties, flattened (best value per key), for tables and tooltips. */
  props?: Record<string, PropValue>;
}
export interface ObjectRecord extends ObjectSummary {
  source: string;             // source that created it
  firstSeen: number;
  validFrom?: number | null;  // for events: start; for records: date
  validTo?: number | null;
  /** GeoJSON geometry (Polygon/MultiPolygon/LineString) when the object is not a point; may be simplified. */
  geometry?: any | null;
  allProps: PropRecord[];     // every property from every source, newest first within a key
  identities: { scheme: string; key: string }[];
  metrics: string[];          // metric ids that have observations
}
export interface LinkRecord {
  src: string; dst: string; type: string;
  source: string; observedAt: number; confidence?: number | null; note?: string | null;
  /** Joined for display. */
  srcName?: string; srcType?: string; dstName?: string; dstType?: string;
}
export interface Series { t: number[]; v: number[] }

// ---------- ingest ----------
export interface ObjectInput {
  type: string;
  key: string;
  name?: string;
  lon?: number | null;
  lat?: number | null;
  status?: string | null;
  severity?: number | null;
  validFrom?: number | null;
  validTo?: number | null;
  geometry?: any | null;
  /** Other ids this object is known by: [['osm','way/123'], ['nws:zone','PRZ001']]. Used to merge across sources. */
  identities?: [scheme: string, key: string][];
  /** Property values observed in this batch. `observedAt` defaults to the batch's observedAt. */
  props?: Record<string, PropValue | { value: PropValue; unit?: string; observedAt?: number; confidence?: number }>;
  /** Free text added to the search index (description, address). */
  text?: string;
}
export interface LinkInput { src: string; type: string; dst: string; confidence?: number; note?: string }
export interface ObsInput { object: string; metric: string; t: number; value: number }
export interface IngestBatch {
  source: string;             // SourceDef.id
  fetchedAt: number;          // epoch ms, when we fetched
  observedAt?: number;        // epoch ms, when the source says the data is from (defaults to fetchedAt)
  bytes?: number;
  objects?: ObjectInput[];
  links?: LinkInput[];
  obs?: ObsInput[];
  /** For ephemeral types: objects of these types from this source that are NOT in `objects` are marked expired. */
  replaceTypes?: string[];
  note?: string;
}
export interface IngestResult { source: string; objects: number; created: number; changed: number; links: number; obs: number; expired: number; ms: number }

// ---------- store API (ontology/client.ts implements this over a worker) ----------
export interface ListOptions {
  /** [west, south, east, north] */
  bbox?: [number, number, number, number];
  /** Property filters on best values: { population: ['>', 50000], status: 'active' } */
  where?: Record<string, PropValue | [op: '=' | '!=' | '>' | '>=' | '<' | '<=' | 'like', value: PropValue]>;
  status?: string | string[];
  includeExpired?: boolean;   // default false
  orderBy?: string;           // 'name' | 'updatedAt' | 'severity' | a property key; prefix '-' for descending
  limit?: number;             // default 1000
  /** Property keys to flatten into ObjectSummary.props (default: the type's primary properties). */
  props?: string[];
}
export interface Neighborhood { nodes: ObjectSummary[]; links: LinkRecord[] }
export interface ChangeEvent { source: string; types: string[]; at: number; result?: IngestResult }
export interface SourceStatus {
  source: SourceDef;
  lastRun?: { startedAt: number; finishedAt: number; status: 'ok' | 'error' | 'stale'; objects: number; obs: number; bytes: number; note?: string };
  objectCount: number;
  /** Newest observation time among this source's property values and observations (epoch ms): how fresh its data is. */
  dataAt?: number | null;
  /** The last five runs, newest first. */
  runs?: { startedAt: number; finishedAt: number; status: 'ok' | 'error'; objects: number; obs: number; bytes: number; note?: string }[];
}
export interface DbInfo { persistent: boolean; seedVersion: string; objects: number; links: number; obs: number; openedMs: number }

export interface TwinStore {
  readonly ontology: Ontology;
  ready: Promise<DbInfo>;
  /** Read-only SQL for the console and ad hoc panels. Rejects anything that is not a SELECT / WITH / EXPLAIN / PRAGMA table_info. */
  query<T = Record<string, any>>(sql: string, params?: any[]): Promise<T[]>;
  getObject(id: string): Promise<ObjectRecord | null>;
  getLinks(id: string, opts?: { type?: string; direction?: 'out' | 'in' | 'both'; limit?: number }): Promise<LinkRecord[]>;
  listObjects(type: string | string[], opts?: ListOptions): Promise<ObjectSummary[]>;
  search(text: string, opts?: { types?: string[]; limit?: number }): Promise<ObjectSummary[]>;
  series(objectId: string, metric: string, opts?: { since?: number; until?: number; maxPoints?: number }): Promise<Series>;
  neighborhood(id: string, opts?: { depth?: number; limit?: number; linkTypes?: string[] }): Promise<Neighborhood>;
  countByType(): Promise<Record<string, number>>;
  sources(): Promise<SourceStatus[]>;
  /** Write path used by feeds and by user actions. */
  ingest(batch: IngestBatch): Promise<IngestResult>;
  /** Records a failed or empty fetch so the lineage panel can show it. */
  reportRun(source: string, status: 'ok' | 'error', note?: string, bytes?: number): Promise<void>;
  /** User writeback: sets a property with source 'user' and writes the audit log. */
  annotate(objectId: string, key: string, value: PropValue, note?: string): Promise<void>;
  actionLog(limit?: number): Promise<{ t: number; action: string; objectId: string | null; payload: any }[]>;
  /** Removes everything one source wrote: the objects it created (with all their values, links and history) and its
   *  values and links on other objects. Used to forget the visitor's own files ('local_file'). */
  forgetSource(source: string): Promise<{ objects: number; props: number; links: number }>;
  onChange(cb: (e: ChangeEvent) => void): () => void;
}
