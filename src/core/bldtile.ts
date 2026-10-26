// A building tile read without the scene: tiles/bld/14/{x}/{y}.bin (GBL1, format in pipeline/vector/build.mjs and
// tiles/bld/index.json) and the ids file beside it. For joining your own records to buildings (ui/panels/local.tsx)
// and for finding the building at a point. Plain functions over bytes and text; tested in Node.
import { tileLon, tileLat, lonToTileX, latToTileY } from './geo.ts';

export const BLD_Z = 14;
const PAD = 0.25, SPAN = 1 + 2 * PAD;

export interface TileBuilding {
  index: number;
  ring: [number, number][];   // lon, lat; outer ring, not closed
  lon: number; lat: number;   // centroid of the ring's vertices
  height: number;             // metres; 0 = unknown
  ground: number | null;      // metres above mean sea level at the centroid
  added: boolean;             // a machine detection (not in OpenStreetMap)
  gers: string | null; osm: string | null; heightSource: string | null;
}

/** The tile (x, y) at zoom 14 holding a point. */
export function tileOf(lon: number, lat: number): { x: number; y: number; key: string } {
  const x = Math.floor(lonToTileX(lon, BLD_Z)), y = Math.floor(latToTileY(lat, BLD_Z));
  return { x, y, key: `${x}/${y}` };
}

/** Decodes a GBL1 tile; `ids` is the text of its ids file (or null when the tile has none). */
export function decodeTile(buf: ArrayBuffer, x: number, y: number, ids: string | null): TileBuilding[] {
  const dv = new DataView(buf);
  if (dv.byteLength < 8 || String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'GBL1') throw new Error('not a GBL1 tile');
  const n = dv.getUint32(4, true), lines = ids ? ids.split('\n') : [];
  const out: TileBuilding[] = [];
  let o = 8;
  for (let i = 0; i < n; i++) {
    const nv = dv.getUint16(o, true), h = dv.getUint8(o + 2), kb = dv.getUint8(o + 3), gd = dv.getInt16(o + 4, true);
    o += 8;
    const ring: [number, number][] = [];
    let sx = 0, sy = 0;
    for (let k = 0; k < nv; k++, o += 4) {
      const fx = dv.getUint16(o, true) / 65535 * SPAN - PAD, fy = dv.getUint16(o + 2, true) / 65535 * SPAN - PAD;
      const lon = tileLon(x + fx, BLD_Z), lat = tileLat(y + fy, BLD_Z);
      ring.push([lon, lat]); sx += lon; sy += lat;
    }
    const [gers, osm, hs] = (lines[i] ?? '').split(',');
    out.push({ index: i, ring, lon: sx / Math.max(1, nv), lat: sy / Math.max(1, nv), height: h / 2, ground: gd === -32768 ? null : gd / 10, added: (kb & 0x80) !== 0,
      gers: gers || null, osm: osm || null, heightSource: hs || null });
  }
  return out;
}

export function inRing(ring: [number, number][], lon: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The building holding the point, else the nearest centroid within `maxM` metres; null when none. */
export function buildingAt(list: TileBuilding[], lon: number, lat: number, maxM = 15): TileBuilding | null {
  let best: TileBuilding | null = null, bestD = maxM;
  const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110574;
  for (const b of list) {
    if (inRing(b.ring, lon, lat)) return b;
    const d = Math.hypot((b.lon - lon) * kx, (b.lat - lat) * ky);
    if (d < bestD) { bestD = d; best = b; }
  }
  return best;
}
