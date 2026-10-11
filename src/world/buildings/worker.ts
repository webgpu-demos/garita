// Building tile -> one merged mesh. Runs in a Worker: decodes GBL1 (see tiles/bld/index.json), extrudes every
// footprint into walls and a flat roof (its parapet rim is drawn by the shader), and returns typed arrays (transferred).
//
// REAL: footprints, the 13.8 % of heights that OpenStreetMap carries, ground elevation, FEMA flood class.
// PROCEDURAL: every other height (estHeight below, flagged per building), and everything the shader paints.
import earcut from 'earcut';
import { tileLon, tileLat, lonLatToXZ, curveDrop } from '../../core/geo.ts';

export interface MeshJob { id: number; x: number; y: number; buf: ArrayBuffer }
export interface MeshResult {
  id: number; count: number; triangles: number;
  cx: number; cz: number; yRef: number;
  position: Float32Array; normal: Int8Array; fac: Float32Array; bld: Int16Array; edge: Uint16Array; index: Uint32Array;
  sphere: [number, number, number, number];
  // picking: per building
  bbox: Float32Array;        // minx, minz, maxx, maxz (tile-local metres)
  ringStart: Uint32Array;    // count + 1 offsets into ring (in vertices)
  ring: Float32Array;        // x, z pairs, tile-local
  base: Float32Array;        // metres above MSL the walls stand on
  height: Float32Array;      // metres
  ground: Int16Array;        // stored ground elevation, decimetres (-32768 unknown)
  meta: Uint8Array;          // kind | flood << 3 | estimated << 5
}

const SINK = 3, PAD = 0.25, Z = 14;

function hash(a: number, b: number, c: number): number {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const median = (a: number[]) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };

/** PROCEDURAL height (m) for a footprint without one: most houses in Puerto Rico are one or two storey concrete. */
function estHeight(kind: number, area: number, r1: number, r2: number): number {
  if (area < 14) return 2.6 + r1 * 0.5;
  switch (kind) {
    case 0: return (r1 < (area > 220 ? 0.5 : area > 110 ? 0.3 : 0.12) ? 6.0 : 3.2) + r2 * 0.5;
    case 1: return 10 + Math.floor(r1 * 5) * 3;
    case 2: return 5 + r1 * 4;
    case 3: return 7 + r1 * 3;
    case 4: return 6 + r1 * 3;
    case 5: return 8 + r1 * 4;
    default: return area > 600 ? 5 + r1 * 3 : area > 60 ? (r1 < 0.2 ? 6.0 : 3.2) + r2 * 0.5 : 2.8 + r1 * 0.6;
  }
}

function build(job: MeshJob): MeshResult {
  const dv = new DataView(job.buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  const n = magic === 'GBL1' ? dv.getUint32(4, true) : 0;
  const [cx, cz] = lonLatToXZ(tileLon(job.x + 0.5, Z), tileLat(job.y + 0.5, Z));

  // pass 1: offsets, sizes, medians of the known ground elevations (whole tile and an 8 x 8 grid)
  const off = new Uint32Array(n);
  const G = 8, cells: number[][] = Array.from({ length: G * G }, () => []), all: number[] = [];
  let o = 8, V = 0, I = 0, RV = 0, kept = 0;
  for (let i = 0; i < n; i++) {
    off[i] = o;
    const nv = dv.getUint16(o, true), gd = dv.getInt16(o + 4, true);
    if (nv >= 3) {
      V += nv * 4 + (nv - 2) * 3; I += nv * 6 + (nv - 2) * 3; RV += nv; kept++;
      if (gd !== -32768) {
        // (placement elevation: the lidar value plus the stored offset to the terrain the scene draws; see below)
        const pd = gd + dv.getInt8(o + 7) * 5;
        const u = dv.getUint16(o + 8, true), v = dv.getUint16(o + 10, true);
        cells[Math.min(G - 1, (u * G) >> 16) + G * Math.min(G - 1, (v * G) >> 16)].push(pd); all.push(pd);
      }
    }
    o += 8 + nv * 4;
  }
  const tileMed = all.length ? median(all) : 0;
  const cellMed = cells.map((c) => (c.length ? median(c) : tileMed));

  const position = new Float32Array(V * 3), normal = new Int8Array(V * 3), fac = new Float32Array(V * 4), bld = new Int16Array(V * 3), edge = new Uint16Array(V * 3).fill(65535), index = new Uint32Array(I);
  const bbox = new Float32Array(kept * 4), ringStart = new Uint32Array(kept + 1), ring = new Float32Array(RV * 2);
  const base = new Float32Array(kept), height = new Float32Array(kept), ground = new Int16Array(kept), meta = new Uint8Array(kept);
  let vi = 0, ii = 0, bi = 0, ri = 0;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  const refs: number[] = [];
  const rx: number[] = [], rz: number[] = [], flat: number[] = [];

  const vtx = (x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, seed: number, bayW: number, hdm: number, gdm: number, code: number) => {
    position[vi * 3] = x; position[vi * 3 + 1] = y; position[vi * 3 + 2] = z;
    normal[vi * 3] = nx; normal[vi * 3 + 1] = ny; normal[vi * 3 + 2] = nz;
    fac[vi * 4] = u; fac[vi * 4 + 1] = v; fac[vi * 4 + 2] = seed; fac[vi * 4 + 3] = bayW;
    bld[vi * 3] = hdm; bld[vi * 3 + 1] = gdm; bld[vi * 3 + 2] = code;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    return vi++;
  };

  for (let i = 0; i < n; i++) {
    o = off[i];
    const nv = dv.getUint16(o, true);
    if (nv < 3) continue;
    const hh = dv.getUint8(o + 2), kind = Math.min(6, dv.getUint8(o + 3)), gd = dv.getInt16(o + 4, true), flood = Math.min(3, dv.getUint8(o + 6));
    rx.length = rz.length = nv;
    let mx = 0, mz = 0, bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity, su = 0, sv = 0;
    for (let k = 0; k < nv; k++) {
      const u = dv.getUint16(o + 8 + k * 4, true), v = dv.getUint16(o + 10 + k * 4, true);
      su += u; sv += v;
      const fx = u / 65535 * (1 + 2 * PAD) - PAD, fy = v / 65535 * (1 + 2 * PAD) - PAD;
      const [wx, wz] = lonLatToXZ(tileLon(job.x + fx, Z), tileLat(job.y + fy, Z));
      const lx = wx - cx, lz = wz - cz;
      rx[k] = lx; rz[k] = lz; mx += lx; mz += lz;
      if (lx < bx0) bx0 = lx; if (lx > bx1) bx1 = lx; if (lz < bz0) bz0 = lz; if (lz > bz1) bz1 = lz;
    }
    mx /= nv; mz /= nv;
    let area = 0;
    for (let k = 0; k < nv; k++) { const j = (k + 1) % nv; area += rx[k] * rz[j] - rx[j] * rz[k]; }
    area /= 2;
    if (area < 0) { rx.reverse(); rz.reverse(); area = -area; }   // counter-clockwise in (x, z): outward normal of an edge (dx, dz) is (dz, -dx)

    const u0 = dv.getUint16(o + 8, true), v0 = dv.getUint16(o + 10, true);
    const seed = hash(u0 + job.x * 7919, v0 + job.y * 104729, nv), r1 = hash(v0, u0 + job.y, nv + 17), r2 = hash(nv + 3, v0 + job.x, u0);
    const estimated = hh === 0;
    const H = estimated ? estHeight(kind, area, r1, r2) : Math.max(2.4, hh * 0.5);
    const gCell = Math.min(G - 1, ((su / nv) * G) >> 16) + G * Math.min(G - 1, ((sv / nv) * G) >> 16);
    // `gd` is the lidar ground elevation (what the flood screen and the tooltip use). The building stands on the
    // terrain the scene draws, a coarser model that can differ by metres on a slope: the tile keeps that
    // difference in half metres in the record's last byte (0 in tiles built before the lidar merge).
    const b = (gd !== -32768 ? gd + dv.getInt8(o + 7) * 5 : cellMed[gCell]) * 0.1;
    const drop = curveDrop(cx + mx, cz + mz);
    const yb = b - drop, yTop = yb + H, yLow = yb - SINK;
    // what the shader paints it as: 0 house 1 apartments 2 commercial 3 industrial 4 civic / religious 5 glass tower
    let look = kind === 6 ? (area < 450 ? 0 : 2) : kind >= 4 ? 4 : kind;
    if (look === 0 && H > 12.5) look = 1;
    if ((look === 2 && H > 28 && seed < 0.7) || (look === 1 && H > 55 && seed < 0.3)) look = 5;
    const hdm = Math.round(H * 10), gdm = gd !== -32768 ? Math.max(-32000, Math.min(32000, gd)) : 32767;
    const codeW = look + 32 * flood, codeR = look + 8 + 32 * flood;

    // walls
    for (let k = 0; k < nv; k++) {
      const j = (k + 1) % nv, ax = rx[k], az = rz[k], qx = rx[j], qz = rz[j];
      const dx = qx - ax, dz = qz - az, len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      const nx = Math.round(dz / len * 127), nz = Math.round(-dx / len * 127);
      const bays = len >= 2.6 ? Math.max(1, Math.floor(len / 3.2 + 0.35)) : 0, bayW = bays ? len / bays : 0;
      const A = vtx(ax, yLow, az, nx, 0, nz, 0, -SINK, seed, bayW, hdm, gdm, codeW);
      const B = vtx(qx, yLow, qz, nx, 0, nz, bays, -SINK, seed, bayW, hdm, gdm, codeW);
      const C = vtx(qx, yTop, qz, nx, 0, nz, bays, H, seed, bayW, hdm, gdm, codeW);
      const D = vtx(ax, yTop, az, nx, 0, nz, 0, H, seed, bayW, hdm, gdm, codeW);
      index[ii++] = A; index[ii++] = C; index[ii++] = B; index[ii++] = A; index[ii++] = D; index[ii++] = C;
    }
    // roof: one vertex per triangle corner, each carrying its distance (dm) to the footprint edges of its own
    // triangle (65535 = that edge is a diagonal), so the shader can draw a rim along the real outline
    flat.length = nv * 2;
    for (let k = 0; k < nv; k++) { flat[k * 2] = rx[k]; flat[k * 2 + 1] = rz[k]; }
    const tris = earcut(flat);
    const adj = (i: number, j: number) => { const d = Math.abs(i - j); return d === 1 || d === nv - 1; };
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t]; let p = tris[t + 1], q = tris[t + 2];
      // face up: ((p - a) x (q - a)).y > 0
      const cr = (rz[p] - rz[a]) * (rx[q] - rx[a]) - (rx[p] - rx[a]) * (rz[q] - rz[a]);
      if (cr < 0) { const sw = p; p = q; q = sw; }
      const area2 = Math.abs(cr);
      const e0 = adj(p, q), e1 = adj(q, a), e2 = adj(a, p);
      const dm = (len: number) => Math.min(65000, Math.round(area2 / Math.max(len, 0.01) * 10));
      const va = vtx(rx[a], yTop, rz[a], 0, 127, 0, 0, H, seed, 0, hdm, gdm, codeR);
      const vp = vtx(rx[p], yTop, rz[p], 0, 127, 0, 0, H, seed, 0, hdm, gdm, codeR);
      const vq = vtx(rx[q], yTop, rz[q], 0, 127, 0, 0, H, seed, 0, hdm, gdm, codeR);
      if (e0) { edge[va * 3] = dm(Math.hypot(rx[q] - rx[p], rz[q] - rz[p])); edge[vp * 3] = 0; edge[vq * 3] = 0; }
      if (e1) { edge[vp * 3 + 1] = dm(Math.hypot(rx[a] - rx[q], rz[a] - rz[q])); edge[va * 3 + 1] = 0; edge[vq * 3 + 1] = 0; }
      if (e2) { edge[vq * 3 + 2] = dm(Math.hypot(rx[p] - rx[a], rz[p] - rz[a])); edge[va * 3 + 2] = 0; edge[vp * 3 + 2] = 0; }
      index[ii++] = va; index[ii++] = vp; index[ii++] = vq;
    }

    // picking record
    bbox[bi * 4] = bx0; bbox[bi * 4 + 1] = bz0; bbox[bi * 4 + 2] = bx1; bbox[bi * 4 + 3] = bz1;
    ringStart[bi] = ri;
    for (let k = 0; k < nv; k++) { ring[ri * 2] = rx[k]; ring[ri * 2 + 1] = rz[k]; ri++; }
    base[bi] = b; height[bi] = H; ground[bi] = gd; meta[bi] = kind | (flood << 3) | (estimated ? 32 : 0);
    if ((bi & 7) === 0) refs.push(yb);
    bi++;
  }
  ringStart[bi] = ri;
  const sx = (x0 + x1) / 2, sy = (y0 + y1) / 2, sz = (z0 + z1) / 2;
  const sphere: [number, number, number, number] = kept ? [sx, sy, sz, Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2 + 1] : [0, 0, 0, 1];
  return {
    id: job.id, count: bi, triangles: ii / 3, cx, cz, yRef: refs.length ? median(refs) : 0,
    position: position.subarray(0, vi * 3), normal: normal.subarray(0, vi * 3), fac: fac.subarray(0, vi * 4), bld: bld.subarray(0, vi * 3), edge: edge.subarray(0, vi * 3), index: index.subarray(0, ii),
    sphere, bbox, ringStart, ring, base, height, ground, meta,
  };
}

self.onmessage = (e: MessageEvent<MeshJob>) => {
  let r: MeshResult | { id: number; error: string };
  try { r = build(e.data); } catch (err) { r = { id: e.data.id, error: String(err) }; }
  const t: Transferable[] = [];
  if ('position' in r) {
    const seen = new Set<ArrayBufferLike>();
    for (const a of [r.position, r.normal, r.fac, r.bld, r.edge, r.index, r.bbox, r.ringStart, r.ring, r.base, r.height, r.ground, r.meta]) if (!seen.has(a.buffer)) { seen.add(a.buffer); t.push(a.buffer as ArrayBuffer); }
  }
  (self as unknown as Worker).postMessage(r, t);
};
