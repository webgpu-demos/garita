// Your own records (inspections, cases, model outputs...) joined to the buildings of the tiles, for the Your data panel
// (ui/panels/local.tsx). A file is read in this browser and its rows go into this browser's database only, as
// `local_record` objects linked to `structure` objects (ontology.json). Nothing is uploaded.
//
// Each row is matched to a building, in this order:
//   gers   a GERS id column (Overture's stable id, as in tiles/bld/14/{x}/{y}.ids), with a position to find its tile
//   osm    an OpenStreetMap way or relation (w123, way/123, r456), with a position
//   point  the building holding the row's point (or the nearest within 15 m)
// A row with no position cannot be placed on a tile: it is kept, unmatched. Plain functions, tested in Node.
import type { IngestBatch, ObjectInput, LinkInput } from '../ontology/types.ts';
import { tileOf, decodeTile, buildingAt, type TileBuilding } from './bldtile.ts';

export interface LocalRow { row: number; fields: Record<string, string | number | boolean | null>; lon: number | null; lat: number | null; gers: string | null; osm: string | null }
export interface ParsedFile { rows: LocalRow[]; columns: string[]; format: 'csv' | 'geojson'; problems: string[] }

const GERS = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLS = {
  gers: ['gers', 'gers_id', 'overture_id', 'gersid'],
  osm: ['osm', 'osm_id', 'osm_ref', 'osmid'],
  lon: ['lon', 'lng', 'long', 'longitude', 'x'],
  lat: ['lat', 'latitude', 'y'],
};
const pickCol = (cols: string[], names: string[]) => cols.find((c) => names.includes(c.trim().toLowerCase())) ?? null;

/** OSM ref in the tiles' form ("w123", "r456") from w123, way/123, relation/456, https://www.openstreetmap.org/way/123. */
export function normOsm(v: unknown): string | null {
  const s = String(v ?? '').trim().toLowerCase();
  let m = /(?:^|\/)(way|relation)\/(\d+)$/.exec(s);
  if (m) return (m[1] === 'way' ? 'w' : 'r') + m[2];
  m = /^([wr])(\d+)$/.exec(s);
  return m ? m[1] + m[2] : null;
}
const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : Number(String(v ?? '').trim().replace(',', '.')); return String(v ?? '').trim() !== '' && Number.isFinite(n) ? n : null; };

/** RFC 4180 CSV: quoted fields, doubled quotes, CR/LF; the first line is the header. Comma or semicolon. */
export function parseCsv(text: string): string[][] {
  const t = text.replace(/^﻿/, '');
  const first = t.slice(0, t.indexOf('\n') >>> 0);
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = []; let row: string[] = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') q = true;
    else if (c === sep) { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some((x) => x !== '')) rows.push(row); row = []; }
    else f += c;
  }
  row.push(f); if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

function centroidOf(g: any): [number, number] | null {
  if (!g) return null;
  if (g.type === 'Point') return [g.coordinates[0], g.coordinates[1]];
  const ring = g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates[0]?.[0] : g.type === 'MultiPoint' || g.type === 'LineString' ? g.coordinates : null;
  if (!ring?.length) return null;
  let sx = 0, sy = 0; for (const p of ring) { sx += p[0]; sy += p[1]; }
  return [sx / ring.length, sy / ring.length];
}

/** A CSV or GeoJSON file -> rows with what they say about where they are. */
export function parseFile(name: string, text: string): ParsedFile {
  const problems: string[] = [];
  const trimmed = text.trimStart();
  if (/\.(geo)?json$/i.test(name) || trimmed.startsWith('{')) {
    const j = JSON.parse(text);
    const feats: any[] = j.type === 'FeatureCollection' ? j.features : j.type === 'Feature' ? [j] : [];
    if (!feats.length) problems.push('no features in the GeoJSON');
    const columns = [...new Set(feats.flatMap((f) => Object.keys(f.properties ?? {})))];
    const cg = pickCol(columns, COLS.gers), co = pickCol(columns, COLS.osm);
    const rows = feats.map((f, i): LocalRow => {
      const p = f.properties ?? {}, c = centroidOf(f.geometry);
      const gers = cg && GERS.test(String(p[cg])) ? String(p[cg]).toLowerCase() : f.id && GERS.test(String(f.id)) ? String(f.id).toLowerCase() : null;
      return { row: i + 1, fields: flat(p), lon: c ? c[0] : null, lat: c ? c[1] : null, gers, osm: co ? normOsm(p[co]) : null };
    });
    return { rows, columns, format: 'geojson', problems };
  }
  const t = parseCsv(text);
  if (t.length < 2) return { rows: [], columns: t[0] ?? [], format: 'csv', problems: ['no rows under the header'] };
  const columns = t[0].map((c) => c.trim());
  const ix = (names: string[]) => { const c = pickCol(columns, names); return c ? columns.indexOf(c) : -1; };
  const ig = ix(COLS.gers), io = ix(COLS.osm), ilon = ix(COLS.lon), ilat = ix(COLS.lat);
  if (ig < 0 && io < 0 && (ilon < 0 || ilat < 0)) problems.push('no gers, osm or longitude/latitude column: rows cannot be matched to buildings');
  const rows = t.slice(1).map((r, i): LocalRow => {
    const fields: LocalRow['fields'] = {};
    columns.forEach((c, k) => { const v = (r[k] ?? '').trim(); fields[c] = v === '' ? null : num(v) ?? v; });
    const g = ig >= 0 ? (r[ig] ?? '').trim() : '';
    return { row: i + 1, fields, lon: ilon >= 0 ? num(r[ilon]) : null, lat: ilat >= 0 ? num(r[ilat]) : null, gers: GERS.test(g) ? g.toLowerCase() : null, osm: io >= 0 ? normOsm(r[io]) : null };
  });
  return { rows, columns, format: 'csv', problems };
}
function flat(p: Record<string, any>): LocalRow['fields'] {
  const o: LocalRow['fields'] = {};
  for (const [k, v] of Object.entries(p)) o[k] = v == null ? null : typeof v === 'object' ? JSON.stringify(v) : v;
  return o;
}

export type TileLoader = (x: number, y: number) => Promise<TileBuilding[] | null>;
export interface JoinResult {
  batch: IngestBatch;
  counts: { rows: number; gers: number; osm: number; point: number; unmatched: number; noPosition: number; structures: number; tiles: number };
}

const slug = (s: string) => s.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'file';
const SUMMARY_SKIP = new Set([...COLS.gers, ...COLS.osm, ...COLS.lon, ...COLS.lat]);
function summarize(fields: LocalRow['fields']): string {
  return Object.entries(fields).filter(([k, v]) => v != null && v !== '' && !SUMMARY_SKIP.has(k.toLowerCase())).slice(0, 4).map(([k, v]) => `${k}: ${v}`).join(' · ').slice(0, 200);
}

// A row's own name: the first of these columns it has (case-insensitive)
const NAME_COLS = ['name', 'nombre', 'case_id', 'caso', 'id_caso', 'case', 'record_id', 'label', 'id', 'address', 'direccion', 'dirección'];
function nameOf(fields: LocalRow['fields']): string | null {
  const keys = Object.keys(fields);
  for (const n of NAME_COLS) { const k = keys.find((c) => c.trim().toLowerCase() === n); if (k && fields[k] != null && fields[k] !== '') return String(fields[k]); }
  return null;
}

/** Matches the rows to buildings (loading each tile once) and writes the batch for the store. */
export async function joinRows(fileName: string, parsed: ParsedFile, load: TileLoader, now = Date.now()): Promise<JoinResult> {
  const counts = { rows: parsed.rows.length, gers: 0, osm: 0, point: 0, unmatched: 0, noPosition: 0, structures: 0, tiles: 0 };
  const tiles = new Map<string, Promise<TileBuilding[] | null>>();
  const tileFor = (lon: number, lat: number) => {
    const t = tileOf(lon, lat);
    if (!tiles.has(t.key)) { tiles.set(t.key, load(t.x, t.y).catch(() => null)); counts.tiles++; }
    return tiles.get(t.key)!;
  };
  const file = slug(fileName);
  const structures = new Map<string, { b: TileBuilding; n: number }>();
  const objects: ObjectInput[] = [], links: LinkInput[] = [];
  for (const r of parsed.rows) {
    let b: TileBuilding | null = null, by = 'none';
    if (r.lon != null && r.lat != null && Math.abs(r.lon) <= 180 && Math.abs(r.lat) <= 90) {
      const list = await tileFor(r.lon, r.lat);
      if (list) {
        if (r.gers) { b = list.find((x) => x.gers === r.gers) ?? null; if (b) by = 'gers'; }
        if (!b && r.osm) { b = list.find((x) => x.osm === r.osm) ?? null; if (b) by = 'osm'; }
        if (!b) { b = buildingAt(list, r.lon, r.lat); if (b) by = 'point'; }
      }
    } else counts.noPosition++;
    const key = `${file}-${r.row}`;
    if (b) {
      counts[by as 'gers' | 'osm' | 'point']++;
      const sk = b.gers ?? `osm-${b.osm ?? 'none'}-${b.lon.toFixed(6)}-${b.lat.toFixed(6)}`;
      const s = structures.get(sk); if (s) s.n++; else structures.set(sk, { b, n: 1 });
      links.push({ src: `local_record:${key}`, type: 'describes', dst: `structure:${sk}` });
    } else counts.unmatched++;
    objects.push({
      type: 'local_record', key, name: String(nameOf(r.fields) ?? `${fileName} #${r.row}`).slice(0, 120),
      // a matched record is found through its building; an unmatched one keeps its own point, if it has one
      lon: b ? null : r.lon, lat: b ? null : r.lat,
      props: { file: fileName, row: r.row, matched_by: by, summary: summarize(r.fields), fields: JSON.stringify(r.fields) },
      text: Object.values(r.fields).filter((v) => typeof v === 'string').join(' ').slice(0, 500),
    });
  }
  for (const [sk, { b, n }] of structures) {
    objects.push({
      type: 'structure', key: sk, name: b.osm ? `${b.osm[0] === 'r' ? 'Relation' : 'Way'} ${b.osm.slice(1)}` : `GERS ${(b.gers ?? '').slice(0, 8)}`, lon: b.lon, lat: b.lat,
      identities: [...(b.gers ? [['overture:gers', b.gers] as [string, string]] : []), ...(b.osm ? [['osm', (b.osm[0] === 'r' ? 'relation/' : 'way/') + b.osm.slice(1)] as [string, string]] : [])],
      props: {
        records: n, ...(b.height > 0 ? { height_m: b.height } : {}), ...(b.heightSource ? { height_source: b.heightSource } : {}),
        ...(b.ground != null ? { ground_elev_m: b.ground } : {}), ...(b.gers ? { gers_id: b.gers } : {}),
        ...(b.osm ? { osm_url: `https://www.openstreetmap.org/${b.osm[0] === 'r' ? 'relation' : 'way'}/${b.osm.slice(1)}` } : {}),
      },
    });
  }
  counts.structures = structures.size;
  return { batch: { source: 'local_file', fetchedAt: now, observedAt: now, objects, links, note: `${fileName}: ${counts.rows} rows` }, counts };
}

/** A tile loader over fetch: the tile and its ids file (tiles built before ids existed load without them). */
export function fetchTileLoader(url: (path: string) => string): TileLoader {
  return async (x, y) => {
    const r = await fetch(url(`tiles/bld/14/${x}/${y}.bin`));
    if (!r.ok || (r.headers.get('content-type') || '').startsWith('text/html')) return null;
    const buf = await r.arrayBuffer();
    const ir = await fetch(url(`tiles/bld/14/${x}/${y}.ids`)).catch(() => null);
    const ids = ir && ir.ok && !(ir.headers.get('content-type') || '').startsWith('text/html') ? await ir.text() : null;
    return decodeTile(buf, x, y, ids);
  };
}
