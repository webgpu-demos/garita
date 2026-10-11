// Terrain: a quadtree of Web Mercator tiles (elevation + aerial photo) refined by screen-space error.
// Tiles are fetched and decoded in workers (tileWorker.ts); this file selects, draws, caches and answers height queries.
import * as THREE from 'three';
import * as S from '../../core/state';
import { dataUrl, flag, params, UPSTREAM } from '../../core/config';
import {
  ORIGIN, M_PER_DEG_LAT, M_PER_DEG_LON, R_EARTH, ROOT_Z, ROOT_X0, ROOT_X1, ROOT_Y0, ROOT_Y1,
  tileBounds, lonLatToXZ, curveDrop, lonToTileX, latToTileY,
} from '../../core/geo.ts';
import type { Frame, OverlaySource, TerrainApi, World } from '../types';
import type { TileJob, TileResult, DemSrc } from './tileWorker';
import { makeTileMaterial, type TileUniforms } from './material';

const NEW = 0, QUEUED = 1, LOADING = 2, READY = 3, FAILED = 4;
const HN = 129;
const MAX_GEOM_Z = 15;
const RETRY_MS = 60000;
const MAX_FETCH = 6;                 // photos in flight; also bounds requests per host
export const ABYSSAL_NAME = 'abyssal-plain';
export const ABYSSAL_DEPTH = -4000;

class Tile {
  z: number; x: number; y: number;
  parent: Tile | null;
  children: Tile[] | null = null;
  state = NEW;
  box = new THREE.Box3();
  minH = -8500; maxH = 1400;
  x0 = 0; x1 = 0; z0 = 0; z1 = 0;
  texel = 0;                       // ground metres per elevation texel
  mesh: THREE.Mesh | null = null;
  mat: THREE.MeshStandardMaterial | null = null;
  u: TileUniforms | null = null;
  photo: THREE.Texture | null = null; ovKey = ''; fails = 0;
  norm: THREE.DataTexture | null = null;
  hts: Int16Array | null = null;
  lastUsed = 0; prio = 0; failedAt = 0; split = false; noPhoto = false;
  jobId = 0; cost = 0; worker = -1; ovGen = -1; dead = false; degradedAt = 0; retries = 0; imgZ = 0;
  constructor(z: number, x: number, y: number, parent: Tile | null) {
    this.z = z; this.x = x; this.y = y; this.parent = parent;
    const b = tileBounds(z, x, y);
    const a = lonLatToXZ(b.west, b.north), c = lonLatToXZ(b.east, b.south);
    this.x0 = a[0]; this.z0 = a[1]; this.x1 = c[0]; this.z1 = c[1];
    this.texel = (this.x1 - this.x0) / 256;
    if (parent) { this.minH = parent.minH; this.maxH = parent.maxH; }
    this.setBox();
  }
  setBox() {
    const nx = Math.min(Math.max(0, this.x0), this.x1), nz = Math.min(Math.max(0, this.z0), this.z1);
    const fx = Math.max(Math.abs(this.x0), Math.abs(this.x1)), fz = Math.max(Math.abs(this.z0), Math.abs(this.z1));
    this.box.min.set(this.x0, this.minH - curveDrop(fx, fz), this.z0);
    this.box.max.set(this.x1, this.maxH - curveDrop(nx, nz), this.z1);
  }
}

interface Shared { index: THREE.BufferAttribute; uv: THREE.BufferAttribute }
function makeShared(N: number): Shared {
  const V = N + 3, uv = new Float32Array(V * V * 2), idx = new Uint16Array((V - 1) * (V - 1) * 6);
  for (let j = 0, k = 0; j < V; j++) for (let i = 0; i < V; i++, k += 2) {
    uv[k] = Math.min(N, Math.max(0, i - 1)) / N; uv[k + 1] = Math.min(N, Math.max(0, j - 1)) / N;
  }
  for (let j = 0, k = 0; j < V - 1; j++) for (let i = 0; i < V - 1; i++) {
    const a = j * V + i, b = a + 1, c = a + V, d = c + 1;
    idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
  }
  return { index: new THREE.BufferAttribute(idx, 1), uv: new THREE.BufferAttribute(uv, 2) };
}

/** A curved dark plain far beyond the tiles so every pixel under the horizon has depth for the ocean pass. */
function makeAbyssal(): THREE.Mesh {
  const a = lonLatToXZ(tileBounds(ROOT_Z, ROOT_X0, ROOT_Y0).west, tileBounds(ROOT_Z, ROOT_X0, ROOT_Y0).north);
  const c = lonLatToXZ(tileBounds(ROOT_Z, ROOT_X1, ROOT_Y1).east, tileBounds(ROOT_Z, ROOT_X1, ROOT_Y1).south);
  const inset = 3000, x0 = a[0] + inset, z0 = a[1] + inset, x1 = c[0] - inset, z1 = c[1] - inset;
  const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2, SEG = 40, M = SEG * 4, RINGS = 44, RMAX = 2.5e6;
  const pos = new Float32Array(M * RINGS * 3), idx = new Uint32Array(M * (RINGS - 1) * 6);
  for (let m = 0; m < M; m++) {
    const side = (m / SEG) | 0, f = (m % SEG) / SEG;
    const px = side === 0 ? x0 + (x1 - x0) * f : side === 1 ? x1 : side === 2 ? x1 - (x1 - x0) * f : x0;
    const pz = side === 0 ? z0 : side === 1 ? z0 + (z1 - z0) * f : side === 2 ? z1 : z1 - (z1 - z0) * f;
    const ang = Math.atan2(pz - mz, px - mx), ox = Math.cos(ang) * RMAX, oz = Math.sin(ang) * RMAX;
    for (let r = 0; r < RINGS; r++) {
      const t = Math.pow(r / (RINGS - 1), 2.6);
      const wx = px + (ox - px) * t, wz = pz + (oz - pz) * t;
      // The inner ring hides under the tiles (below the deepest trench), then the plain rises to its level.
      const h = r === 0 ? -9500 : ABYSSAL_DEPTH;
      const k = (r * M + m) * 3;
      pos[k] = wx; pos[k + 1] = h - curveDrop(wx, wz); pos[k + 2] = wz;
    }
  }
  for (let r = 0, k = 0; r < RINGS - 1; r++) for (let m = 0; m < M; m++) {
    const p = r * M + m, q = r * M + (m + 1) % M, p2 = p + M, q2 = q + M;
    idx[k++] = p; idx[k++] = q; idx[k++] = p2; idx[k++] = q; idx[k++] = q2; idx[k++] = p2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: 1, metalness: 0, side: THREE.DoubleSide }));
  mesh.name = ABYSSAL_NAME;
  mesh.frustumCulled = false;
  return mesh;
}

export function createTerrain(world: World): TerrainApi {
  const { camera, renderer } = world;
  const group = new THREE.Group();
  group.name = 'terrain';
  const abyssal = makeAbyssal();
  group.add(abyssal);
  world.scene.add(group);

  const wire = flag('wire'), lodTint = flag('lod');
  const maxAniso = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); white.needsUpdate = true;
  const clear = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1); clear.needsUpdate = true;
  const flatNorm = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1); flatNorm.needsUpdate = true;
  const LIGHT_GAIN = +(params.get('lights') ?? 2.2);
  const globalU = { uOvOpacity: { value: 0 }, uRelief: { value: 0.62 }, uLod: { value: lodTint ? 1 : 0 }, uNight: { value: 0 }, uTintMode: { value: 0 }, uLightGain: { value: LIGHT_GAIN }, uOvEmit: { value: 0 }, uOvAbove: { value: 0 }, tDensity: { value: null as unknown as THREE.Texture } };
  // Building density for the night lights: buildings per zoom-14 tile over the root area, from tiles/bld/index.json.
  const DZ = 14 - ROOT_Z, DW = (ROOT_X1 - ROOT_X0 + 1) << DZ, DH = (ROOT_Y1 - ROOT_Y0 + 1) << DZ;
  const density = new THREE.DataTexture(new Uint8Array(DW * DH).fill(70), DW, DH, THREE.RedFormat);
  density.minFilter = density.magFilter = THREE.LinearFilter; density.needsUpdate = true;
  globalU.tDensity.value = density;
  fetch(dataUrl('tiles/bld/index.json')).then((r) => (r.ok && !(r.headers.get('content-type') || '').startsWith('text/html') ? r.json() : null)).then((j) => {
    if (!j || !Array.isArray(j.tiles) || (j.zoom ?? 14) !== 14) return;
    const raw = new Float32Array(DW * DH);
    for (const [x, y, n] of j.tiles as [number, number, number][]) {
      const i = x - (ROOT_X0 << DZ), k = y - (ROOT_Y0 << DZ);
      if (i >= 0 && k >= 0 && i < DW && k < DH) raw[k * DW + i] = n;
    }
    // A light 3x3 blur so a town does not end at a tile edge; value = count / 5000 (the island averages about 1,000
    // buildings per zoom-14 tile, the metro area 4,000 and up).
    const d = density.image.data as Uint8Array;
    let cur = raw;
    for (let pass = 0; pass < 2; pass++) {
      const nx = new Float32Array(DW * DH);
      for (let k = 0; k < DH; k++) for (let i = 0; i < DW; i++) {
        let s = 0, w = 0;
        for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
          const ii = i + di, kk = k + dk; if (ii < 0 || kk < 0 || ii >= DW || kk >= DH) continue;
          const ww = di || dk ? (di && dk ? 0.5 : 1) : 2; s += cur[kk * DW + ii] * ww; w += ww;
        }
        nx[k * DW + i] = s / w;
      }
      cur = nx;
    }
    for (let i = 0; i < DW * DH; i++) d[i] = Math.round(255 * Math.min(1, cur[i] / 5000));
    density.needsUpdate = true;
  }).catch(() => {});
  const shared = new Map<number, Shared>();
  const sharedFor = (N: number) => { let s = shared.get(N); if (!s) shared.set(N, s = makeShared(N)); return s; };

  // ---- what exists on our own origin ----
  let index: { dem: Map<number, Set<number>>; img: Map<number, Set<number>> } | null = null;
  let indexDone = false;
  const pack = (x: number, y: number) => x * 65536 + y;
  fetch(dataUrl('tiles/index.json')).then((r) => (r.ok && !(r.headers.get('content-type') || '').startsWith('text/html') ? r.json() : null)).then((j) => {
    if (j && j.dem && j.img) {
      const conv = (o: Record<string, [number, number][]>) => { const m = new Map<number, Set<number>>(); for (const z in o) m.set(+z, new Set(o[z].map(([x, y]) => pack(x, y)))); return m; };
      index = { dem: conv(j.dem), img: conv(j.img) };
    }
  }).catch(() => {}).finally(() => { indexDone = true; });
  // Bathymetry layer (optional): Terrarium tiles of the seabed, used where the elevation holds the sea at about 0 m.
  let bathyIdx: Map<number, Set<number>> | null = null, bathyDone = false, bathyMin = 99, bathyMax = 0;
  fetch(dataUrl('tiles/bathy/index.json')).then((r) => (r.ok && !(r.headers.get('content-type') || '').startsWith('text/html') ? r.json() : null)).then((j) => {
    if (j && j.tiles) {
      const m = new Map<number, Set<number>>();
      for (const z in j.tiles) { m.set(+z, new Set((j.tiles[z] as [number, number][]).map(([x, y]) => pack(x, y)))); bathyMin = Math.min(bathyMin, +z); bathyMax = Math.max(bathyMax, +z); }
      if (m.size) bathyIdx = m;
    }
  }).catch(() => {}).finally(() => { bathyDone = true; });
  const bathyUrl = (z: number, x: number, y: number) => dataUrl(`tiles/bathy/${z}/${x}/${y}.png`);
  const has = (kind: 'dem' | 'img', z: number, x: number, y: number) => (index ? !!index[kind].get(z)?.has(pack(x, y)) : z <= 10);
  const hostDown = { dem: 0, img: 0 }, hostFails = { dem: 0, img: 0 };
  /** Retry delays: 2 s, 4 s, 8 s ... capped at a minute. */
  const backoff = (n: number) => Math.min(RETRY_MS, 2000 * 2 ** Math.min(n, 5));
  const bad = new Map<string, number>();     // url -> when it may be tried again
  const usable = (u: string, now: number) => { const t = bad.get(u); return t === undefined || now > t; };
  const demUrl = (z: number, x: number, y: number) => dataUrl(`tiles/dem/${z}/${x}/${y}.png`);
  const imgUrl = (z: number, x: number, y: number) => dataUrl(`tiles/img/${z}/${x}/${y}.jpg`);

  function plan(t: Tile, now: number): TileJob | null {
    const { z, x, y } = t;
    const dem: DemSrc[] = [];
    if (has('dem', z, x, y)) { if (usable(demUrl(z, x, y), now)) dem.push({ url: demUrl(z, x, y), z, x, y }); }
    else if (z > 10 && z <= UPSTREAM.demMaxZoom && now > hostDown.dem && usable(UPSTREAM.dem(z, x, y), now)) dem.push({ url: UPSTREAM.dem(z, x, y), z, x, y });
    for (let az = z - 1; az >= ROOT_Z; az--) {
      const d = z - az, ax = x >> d, ay = y >> d;
      if (has('dem', az, ax, ay)) { dem.push({ url: demUrl(az, ax, ay), z: az, x: ax, y: ay }); break; }
    }
    const one = (iz: number, ix: number, iy: number): string | null => {
      const u = has('img', iz, ix, iy) ? imgUrl(iz, ix, iy) : iz > 10 && iz <= UPSTREAM.imgMaxZoom && now > hostDown.img ? UPSTREAM.img(iz, ix, iy) : null;
      return u && usable(u, now) ? u : null;
    };
    const img: string[][] = [];
    let crop: DemSrc | null = null;
    if (!t.noPhoto) {
      // Four z+1 photos in one 512 px texture keep the picture sharp at half the tile count.
      const q = [one(z + 1, 2 * x, 2 * y), one(z + 1, 2 * x + 1, 2 * y), one(z + 1, 2 * x, 2 * y + 1), one(z + 1, 2 * x + 1, 2 * y + 1)];
      if (q.every(Boolean)) img.push(q as string[]);
      const s = one(z, x, y);
      if (s) img.push([s]);
      for (let az = z - 1; az >= ROOT_Z && !crop; az--) {
        const d = z - az, ax = x >> d, ay = y >> d;
        if (has('img', az, ax, ay)) crop = { url: imgUrl(az, ax, ay), z: az, x: ax, y: ay };
      }
      // A tile is worth making only if it adds a sharper photo or finer relief.
      if (!img.length && !(dem.length && dem[0].z === z && crop) && z > ROOT_Z) return null;
    }
    if (!dem.length && z > ROOT_Z) return null;
    // Topo-bathy (CUDEM) at this tile or its deepest ancestor; tiles that are pure land are not in the index.
    let cudem: DemSrc | null = null;
    if (bathyIdx) for (let bz = Math.min(z, bathyMax); bz >= bathyMin && !cudem; bz--) {
      const d = z - bz, bx = x >> d, by = y >> d;
      if (bathyIdx.get(bz)?.has(pack(bx, by)) && usable(bathyUrl(bz, bx, by), now)) cudem = { url: bathyUrl(bz, bx, by), z: bz, x: bx, y: by };
    }
    // One zoom above the layer's coarsest tiles (the open-sea tiles stop at zoom 11): its four children, averaged, so
    // the seabed is the same surface on both sides of the zoom boundary.
    let cudemKids: (DemSrc | null)[] | null = null;
    if (bathyIdx && !cudem && z === bathyMin - 1) {
      const set = bathyIdx.get(bathyMin)!;
      const kids = [0, 1, 2, 3].map((i) => {
        const kx = 2 * x + (i & 1), ky = 2 * y + (i >> 1);
        return set.has(pack(kx, ky)) && usable(bathyUrl(z + 1, kx, ky), now) ? { url: bathyUrl(z + 1, kx, ky), z: z + 1, x: kx, y: ky } : null;
      });
      if (kids.some(Boolean)) cudemKids = kids;
    }
    // Coarse stand-in where there is none: only zoom 10 and below carry bathymetry (zooms 11+ hold the sea at exactly 0 m).
    const bathy: DemSrc[] = [];
    if (z >= 11) for (let az = 10; az >= ROOT_Z; az--) {
      const d = z - az, ax = x >> d, ay = y >> d;
      if (has('dem', az, ax, ay)) { bathy.push({ url: demUrl(az, ax, ay), z: az, x: ax, y: ay }); break; }
    }
    return { type: 'tile', id: 0, z, x, y, grid: z >= 14 ? 128 : 64, dem, img, crop, cudem, cudemKids, bathy, root: z === ROOT_Z };
  }

  // ---- workers ----
  const nWorkers = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 2));
  const workers: Worker[] = [];
  const load: number[] = [];
  const jobs = new Map<number, Tile>();
  let nextJob = 1, fetching = 0, readyCount = 0;
  for (let i = 0; i < nWorkers; i++) {
    const w = new Worker(new URL('./tileWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev) => onResult(i, ev.data as TileResult);
    workers.push(w); load.push(0);
  }

  function onResult(wi: number, r: TileResult & { type?: string }) {
    if (r.type) return;
    const t = jobs.get(r.id);
    const now = performance.now();
    for (const f of r.failed) {
      // 'net|': the host could not be reached, back off the whole host; 'http|': that one tile does not exist.
      const u = f.slice(f.indexOf('|') + 1);
      // 'http|': the server answered that the tile does not exist (USGS answers 400 outside its footprint): ask again in three minutes.
      if (f.startsWith('http|')) { if (bad.size > 6000) bad.clear(); bad.set(u, now + 180000); }
      else if (u.includes('amazonaws')) hostDown.dem = now + backoff(hostFails.dem++); else if (u.includes('nationalmap')) hostDown.img = now + backoff(hostFails.img++);
      else bad.set(u, now + 8000);
    }
    for (const u of r.okUrls) { if (u.includes('amazonaws')) { hostDown.dem = 0; hostFails.dem = 0; } else if (u.includes('nationalmap')) { hostDown.img = 0; hostFails.img = 0; } }
    if (!t) return;
    jobs.delete(r.id);
    load[wi]--; fetching -= t.cost; t.jobId = 0;
    if (r.aborted || t.dead) { if (t.state === LOADING) t.state = NEW; return; }
    if (!r.ok) { if (t.state === READY) t.degradedAt = now; else { t.state = FAILED; t.failedAt = now; t.fails++; } return; }
    // Uploads are spread over frames (see update) so a burst of finished tiles does not stall one frame.
    built.push({ t, r });
  }
  const built: { t: Tile; r: TileResult }[] = [];
  function flushBuilt(max: number) {
    for (let n = 0; n < max && built.length; n++) {
      const { t, r } = built.shift()!;
      if (t.dead) continue;
      if (t.state === READY) { freeGpu(t); readyCount--; }     // a degraded tile reloaded in place
      t.degradedAt = r.degraded ? performance.now() : 0;
      build(t, r);
    }
  }

  function build(t: Tile, r: TileResult) {
    const N = t.z >= 14 ? 128 : 64, sh = sharedFor(N);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(r.pos!, 3));
    geo.setAttribute('uv', sh.uv);
    geo.setIndex(sh.index);
    t.norm = new THREE.DataTexture(r.norm!, 256, 256, THREE.RGBAFormat);
    t.norm.generateMipmaps = true; t.norm.minFilter = THREE.LinearMipmapLinearFilter; t.norm.magFilter = THREE.LinearFilter;
    t.norm.anisotropy = Math.min(4, maxAniso); t.norm.needsUpdate = true;
    if (r.photo) {
      const p = new THREE.DataTexture(r.photo, r.photoW!, r.photoW!, THREE.RGBAFormat);
      p.colorSpace = THREE.SRGBColorSpace; p.flipY = false; p.premultiplyAlpha = false;
      p.onUpdate = () => { (p.image as any).data = null; };     // the pixels live on the GPU from here on
      p.generateMipmaps = true; p.minFilter = THREE.LinearMipmapLinearFilter; p.magFilter = THREE.LinearFilter;
      p.anisotropy = maxAniso; p.needsUpdate = true;
      t.photo = p;
    }
    const { material, uniforms } = makeTileMaterial(globalU, t.photo ?? white, t.norm, clear, !!t.photo, t.z);
    material.wireframe = wire;
    { const n = 2 ** (t.z - ROOT_Z), sx = 1 / (n * (ROOT_X1 - ROOT_X0 + 1)), sy = 1 / (n * (ROOT_Y1 - ROOT_Y0 + 1)); uniforms.uDenXf.value.set(sx, sy, (t.x - ROOT_X0 * n) * sx, (t.y - ROOT_Y0 * n) * sy); }
    t.mat = material; t.u = uniforms;
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(r.cx!, r.cy!, r.cz!);
    mesh.frustumCulled = false; mesh.visible = false; mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    mesh.receiveShadow = t.z >= 13;      // the sun shadow map only exists close to the ground
    mesh.name = `tile ${t.z}/${t.x}/${t.y}`;
    group.add(mesh);
    t.mesh = mesh; t.hts = r.hts!;
    t.minH = r.minH!; t.maxH = r.maxH!; t.imgZ = r.imgZ || 0;
    t.setBox();
    t.state = READY; readyCount++;
  }

  function freeGpu(t: Tile) {
    if (t.mesh) { group.remove(t.mesh); t.mesh.geometry.dispose(); t.mesh = null; }
    t.mat?.dispose(); t.mat = null; t.u = null;
    if (t.photo) { t.photo.dispose(); t.photo = null; }
    releaseOverlay(t);
    t.norm?.dispose(); t.norm = null; t.hts = null; t.ovGen = -1;
  }
  function disposeTile(t: Tile) {
    if (t.jobId) { workers[t.worker].postMessage({ type: 'abort', id: t.jobId }); }
    freeGpu(t);
    if (t.state === READY) readyCount--;
    t.state = NEW; t.dead = true;
  }

  // ---- quadtree ----
  const roots: Tile[] = [];
  for (let y = ROOT_Y0; y <= ROOT_Y1; y++) for (let x = ROOT_X0; x <= ROOT_X1; x++) roots.push(new Tile(ROOT_Z, x, y, null));
  const NRX = ROOT_X1 - ROOT_X0 + 1;
  const frustum = new THREE.Frustum(), pv = new THREE.Matrix4(), camPos = new THREE.Vector3();
  const drawn: Tile[] = [], queue: Tile[] = [];
  let frameNo = 0, sseK = 1, thr = 2.3, nowMs = 0, deepest = 0, loadingCount = 0;

  function request(t: Tile, prio: number) {
    t.prio = prio; t.lastUsed = frameNo;
    if (t.state === NEW || (t.state === FAILED && nowMs - t.failedAt > backoff(t.fails))) t.state = QUEUED;
    if (t.state === QUEUED) queue.push(t);
  }

  function visit(t: Tile) {
    t.lastUsed = frameNo;
    if (t.state !== READY) { request(t, 1e9); return; }
    if (!frustum.intersectsBox(t.box)) return;
    const d = Math.max(1, t.box.distanceToPoint(camPos));
    const sse = t.texel * sseK / d;
    // Loaded with something missing (a failed photo or elevation): try again in place, a few times, a minute apart.
    if (t.degradedAt && nowMs - t.degradedAt > backoff(t.retries + 1) && !t.jobId && t.retries < 8) { t.retries++; t.degradedAt = nowMs; t.prio = sse; queue.push(t); }
    const maxZ = t.maxH < -40 ? 11 : MAX_GEOM_Z;      // open sea needs no street-scale seabed
    // Upstream has no photo at z 9-10 in places: a shallow tile left with a cropped ancestor photo splits early
    // so its children can pick up the z 11 pictures.
    const poor = t.z <= 10 && t.photo && t.imgZ < t.z ? 0.3 : 1;
    if (t.z < maxZ && sse > thr * poor * (t.split ? 0.8 : 1)) {
      if (!t.children) {
        t.children = [];
        for (let i = 0; i < 4; i++) { const c = new Tile(t.z + 1, t.x * 2 + (i & 1), t.y * 2 + (i >> 1), t); c.noPhoto = t.maxH < -40; t.children.push(c); }
      }
      let ready = true;
      const ch = t.children;
      for (let i = 0; i < 4; i++) { const c = ch[i]; if (c.state !== READY) { ready = false; request(c, sse); } else c.lastUsed = frameNo; }
      if (ready) { t.split = true; for (let i = 0; i < 4; i++) visit(ch[i]); return; }
    }
    t.split = false;
    t.mesh!.visible = true;
    drawn.push(t);
    if (t.z > deepest) deepest = t.z;
    if (overlay && t.ovGen !== ovGen) attachOverlay(t);
  }

  const byPrio = (a: Tile, b: Tile) => b.prio - a.prio;
  function dispatch() {
    if (!queue.length) return;
    queue.sort(byPrio);
    for (let i = 0; i < queue.length; i++) {
      const t = queue[i];
      const job = plan(t, nowMs);
      if (!job) { if (t.state !== READY) { t.state = FAILED; t.failedAt = nowMs; t.fails = Math.max(t.fails, 5); } continue; }     // nothing to fetch for it right now: look again in a minute
      const cost = Math.max(1, job.img.length ? job.img[0].length : 0);
      if (fetching > 0 && fetching + cost > MAX_FETCH) break;
      let wi = 0; for (let k = 1; k < workers.length; k++) if (load[k] < load[wi]) wi = k;
      job.id = nextJob++;
      t.jobId = job.id; t.cost = cost; t.worker = wi; if (t.state !== READY) t.state = LOADING;
      jobs.set(job.id, t); load[wi]++; fetching += cost;
      workers[wi].postMessage(job);
    }
  }

  const evictable: Tile[] = [];
  const groupAge = (p: Tile) => Math.max(p.children![0].lastUsed, p.children![1].lastUsed, p.children![2].lastUsed, p.children![3].lastUsed);
  function collect(t: Tile) {
    if (!t.children) return;
    let leaves = true;
    for (const c of t.children) { if (c.children) { leaves = false; collect(c); } }
    if (leaves && groupAge(t) < frameNo - 90) evictable.push(t);
  }
  function housekeeping() {
    // stale requests: nobody has asked for the tile for a while
    loadingCount = 0;
    for (const t of jobs.values()) {
      if (t.lastUsed < frameNo - 45 && t.z > ROOT_Z) workers[t.worker].postMessage({ type: 'abort', id: t.jobId }); else loadingCount++;
    }
    const cap = { low: 220, medium: 350, high: 520 }[S.quality.value];
    evictable.length = 0;
    for (const r of roots) collect(r);
    if (readyCount > cap) evictable.sort((a, b) => groupAge(a) - groupAge(b));
    for (const p of evictable) {
      // Unused groups are always dropped from the tree when they hold nothing; loaded ones only over the cap.
      const loaded = p.children!.some((c) => c.state === READY || c.state === LOADING);
      if (loaded && readyCount <= cap) continue;
      for (const c of p.children!) disposeTile(c);
      p.children = null; p.split = false;
    }
  }

  // ---- overlay ----
  let overlay: OverlaySource | null = null, ovGen = 0;
  interface OvEntry { tex: THREE.Texture | null; done: boolean; waiters: Tile[]; refs: number; gen: number }
  const ovCache = new Map<string, OvEntry>();
  function dropOv(key: string, e: OvEntry) {
    if (e.tex) { (e.tex.image as ImageBitmap)?.close?.(); e.tex.dispose(); e.tex = null; }
    e.gen = -1; e.waiters.length = 0;
    if (ovCache.get(key) === e) ovCache.delete(key);
  }
  /** Overlay tiles live as long as a terrain tile uses them. */
  function releaseOverlay(t: Tile) {
    if (!t.ovKey) return;
    const e = ovCache.get(t.ovKey);
    if (e) { const i = e.waiters.indexOf(t); if (i >= 0) e.waiters.splice(i, 1); if (--e.refs <= 0) dropOv(t.ovKey, e); }
    t.ovKey = '';
  }
  function attachOverlay(t: Tile) {
    releaseOverlay(t);
    t.ovGen = ovGen;
    const src = overlay!, u = t.u!;
    u.tOverlay.value = clear;
    if (t.z < src.minZoom) return;
    const d = Math.max(0, t.z - src.maxZoom), oz = t.z - d, ox = t.x >> d, oy = t.y >> d, s = 1 / 2 ** d;
    u.uOvXf.value.set(s, s, (t.x - ox * 2 ** d) * s, (t.y - oy * 2 ** d) * s);
    const url = src.draw ? '' : src.url(oz, ox, oy);
    if (!src.draw && !url) return;
    const key = `${oz}/${ox}/${oy}`, gen = ovGen;
    let e = ovCache.get(key);
    if (!e) {
      ovCache.set(key, e = { tex: null, done: false, waiters: [], refs: 0, gen });
      const ent = e;
      const got: Promise<TexImageSource | null> = src.draw
        ? Promise.resolve().then(() => src.draw!(oz, ox, oy))
        : fetch(url!, { mode: 'cors' }).then((r) => (r.ok ? r.blob() : Promise.reject(r.status))).then((b) => createImageBitmap(b, { premultiplyAlpha: 'none' }));
      got.then((img) => {
        if (!img) return;
        if (ent.gen !== gen || gen !== ovGen) { (img as ImageBitmap).close?.(); return; }
        const tex = new THREE.Texture(img as any);
        tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = false; tex.premultiplyAlpha = false; tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter; tex.anisotropy = Math.min(4, maxAniso); tex.needsUpdate = true;
        ent.tex = tex;
        for (const w of ent.waiters) if (w.u && w.ovGen === gen) w.u.tOverlay.value = tex;
      }).catch(() => {}).finally(() => { ent.done = true; ent.waiters.length = 0; });
    }
    e.refs++; t.ovKey = key;
    if (e.tex) u.tOverlay.value = e.tex; else if (!e.done) e.waiters.push(t);
  }
  // ---- the same overlay on the abyssal plain (radar and satellite reach far beyond the tiles) ----
  // One mosaic of low-zoom overlay tiles, looked up by longitude / Mercator latitude in the plain's shader.
  const abU = { tOv: { value: clear as THREE.Texture }, uOvBox: { value: new THREE.Vector4(0, 0, 1, 1) }, uOvOn: { value: 0 } };
  const abMat = abyssal.material as THREE.MeshStandardMaterial;
  abMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, abU, { uOvOpacity: globalU.uOvOpacity, uOvAbove: globalU.uOvAbove });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWxz;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n  vWxz = (modelMatrix * vec4(transformed, 1.0)).xz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D tOv; uniform vec4 uOvBox; uniform float uOvOn; uniform float uOvOpacity; uniform float uOvAbove; varying vec2 vWxz; float gOvCov;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        gOvCov = 0.0;
        if (uOvOn > 0.5) {
          float lon = ${ORIGIN.lon.toFixed(4)} + vWxz.x / ${M_PER_DEG_LON.toFixed(2)}, lat = radians(${ORIGIN.lat.toFixed(4)} - vWxz.y / ${M_PER_DEG_LAT.toFixed(2)});
          vec2 ouv = (vec2((lon + 180.0) / 360.0, 0.5 - log(tan(0.78539816 + lat * 0.5)) / 6.28318531) - uOvBox.xy) * uOvBox.zw;
          if (ouv.x > 0.0 && ouv.x < 1.0 && ouv.y > 0.0 && ouv.y < 1.0) {
            vec4 ov = texture2D(tOv, ouv);
            gOvCov = ov.a * uOvOpacity;
            diffuseColor.rgb = mix(diffuseColor.rgb, ov.rgb, gOvCov);
          }
        }`)
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n  gl_FragColor.a = 1.0 - gOvCov * uOvAbove;');
  };
  let abGen = 0, abTex: THREE.Texture | null = null;
  function loadAbyssalOverlay(src: OverlaySource | null) {
    const gen = ++abGen;
    abU.uOvOn.value = 0; abU.tOv.value = clear; abTex?.dispose(); abTex = null;
    if (!src || !src.aboveWater || typeof document === 'undefined') return;
    const zA = Math.max(src.minZoom, Math.min(src.maxZoom, 6)), n = 2 ** zA;
    const x0 = Math.floor(lonToTileX(-76, zA)), x1 = Math.floor(lonToTileX(-58, zA)), y0 = Math.floor(latToTileY(26, zA)), y1 = Math.floor(latToTileY(11, zA));
    const nx = x1 - x0 + 1, ny = y1 - y0 + 1, ts = 256;
    if (nx * ny > 40) return;
    const cv = document.createElement('canvas'); cv.width = nx * ts; cv.height = ny * ts;
    const g = cv.getContext('2d')!;
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = false; tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;
    abTex = tex; abU.tOv.value = tex; abU.uOvBox.value.set(x0 / n, y0 / n, n / nx, n / ny); abU.uOvOn.value = 1;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const url = src.draw ? '' : src.url(zA, x, y);
      if (!src.draw && !url) continue;
      const got: Promise<TexImageSource | null> = src.draw
        ? Promise.resolve().then(() => src.draw!(zA, x, y))
        : fetch(url!, { mode: 'cors' }).then((r) => (r.ok ? r.blob() : Promise.reject(r.status))).then((b) => createImageBitmap(b));
      got.then((img) => {
        if (!img) return;
        if (gen === abGen) { g.drawImage(img as CanvasImageSource, (x - x0) * ts, (y - y0) * ts, ts, ts); tex.needsUpdate = true; }
        if (!src.draw) (img as ImageBitmap).close?.();
      }).catch(() => {});
    }
  }
  function eachTile(t: Tile, f: (t: Tile) => void) { f(t); if (t.children) for (const c of t.children) eachTile(c, f); }

  // ---- queries ----
  function heightAt(x: number, z: number): number | null {
    const lon = ORIGIN.lon + x / M_PER_DEG_LON, lat = ORIGIN.lat - z / M_PER_DEG_LAT;
    let fx = lonToTileX(lon, ROOT_Z), fy = latToTileY(lat, ROOT_Z);
    const rx = Math.floor(fx), ry = Math.floor(fy);
    if (rx < ROOT_X0 || rx > ROOT_X1 || ry < ROOT_Y0 || ry > ROOT_Y1) return null;
    let t = roots[(ry - ROOT_Y0) * NRX + (rx - ROOT_X0)];
    if (!t.hts) return 0;
    fx -= rx; fy -= ry;
    while (t.children) {
      const cx = fx >= 0.5 ? 1 : 0, cy = fy >= 0.5 ? 1 : 0, c = t.children[cy * 2 + cx];
      if (!c.hts) break;
      fx = fx * 2 - cx; fy = fy * 2 - cy; t = c;
    }
    const h = t.hts!, gx = fx * (HN - 1), gy = fy * (HN - 1);
    const i = Math.min(HN - 2, gx | 0), j = Math.min(HN - 2, gy | 0), u = gx - i, v = gy - j, k = j * HN + i;
    return ((h[k] * (1 - u) + h[k + 1] * u) * (1 - v) + (h[k + HN] * (1 - u) + h[k + HN + 1] * u) * v) * 0.5;
  }
  const ground = (x: number, z: number) => (heightAt(x, z) ?? ABYSSAL_DEPTH) - (x * x + z * z) / (2 * R_EARTH);
  function raycast(o: THREE.Vector3, dir: THREE.Vector3, maxDist = 4e6): THREE.Vector3 | null {
    let t = 0, tPrev = 0;
    for (let i = 0; i < 300 && t <= maxDist; i++) {
      const x = o.x + dir.x * t, y = o.y + dir.y * t, z = o.z + dir.z * t;
      const gap = y - ground(x, z);
      if (gap <= 0) {
        if (i === 0) return new THREE.Vector3(x, y, z);
        let a = tPrev, b = t;
        for (let k = 0; k < 14; k++) {
          const m = (a + b) / 2, mx = o.x + dir.x * m, mz = o.z + dir.z * m;
          if (o.y + dir.y * m - ground(mx, mz) > 0) a = m; else b = m;
        }
        return new THREE.Vector3(o.x + dir.x * b, o.y + dir.y * b, o.z + dir.z * b);
      }
      // Above every summit and still climbing relative to the curved ground: no hit.
      if (gap > 12000 && dir.y * R_EARTH + (x * dir.x + z * dir.z) > 0 && i > 4) { if (y + (x * x + z * z) / (2 * R_EARTH) > 1500) return null; }
      tPrev = t;
      t += Math.max(8, t * 0.004, gap * 0.45);
    }
    return null;
  }

  const api: TerrainApi = {
    group,
    update(frame: Frame) {
      frameNo++; nowMs = performance.now();
      camPos.setFromMatrixPosition(camera.matrixWorld);
      pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(pv);
      // Detail follows the size the page is displayed at, not the size it is being drawn at this moment: automated
      // screenshots load at a fraction of the resolution (S.renderScale) and must still fetch full-resolution tiles.
      sseK = renderer.domElement.height / Math.max(0.1, S.renderScale.value) / (2 * Math.tan(camera.fov * Math.PI / 360));
      thr = S.quality.value === 'low' ? 3.4 : S.quality.value === 'high' ? 1.7 : 2.3;
      for (let i = 0; i < drawn.length; i++) drawn[i].mesh && (drawn[i].mesh!.visible = false);
      drawn.length = 0; queue.length = 0; deepest = 0;
      globalU.uNight.value = world.night;
      // (observed night lights on the map: our modelled town lights would be read as part of the image)
      globalU.uLightGain.value = S.overlay.value === 'nightlights' ? 0 : LIGHT_GAIN;
      globalU.uOvEmit.value = S.overlay.value === 'nightlights' ? 0.34 * world.night : 0;
      flushBuilt(frame.dt > 0.03 ? 2 : 4);
      if (indexDone && bathyDone) { for (let i = 0; i < roots.length; i++) visit(roots[i]); dispatch(); }
      if (frameNo % 20 === 0) housekeeping();
    },
    heightAt, raycast,
    setTint(mode) { globalU.uTintMode.value = mode === 'elevation' ? 1 : 0; },
    setOverlay(source, opacity) {
      globalU.uOvOpacity.value = source ? opacity : 0;
      globalU.uOvAbove.value = source?.aboveWater ? 1 : 0;
      if (source === overlay || (source && overlay && source.id === overlay.id && source.url === overlay.url && source.draw === overlay.draw)) return;
      overlay = source; ovGen++;
      for (const [k, e] of [...ovCache]) dropOv(k, e);
      ovCache.clear();
      for (const r of roots) eachTile(r, (t) => { t.ovKey = ''; if (t.u) t.u.tOverlay.value = clear; });
      loadAbyssalOverlay(source);
    },
    stats: () => ({ tiles: drawn.length, pending: queue.length + jobs.size + built.length, maxZoom: deepest }),
    dispose() {
      for (const w of workers) w.terminate();
      for (const r of roots) eachTile(r, disposeTile);
      for (const [k, e] of [...ovCache]) dropOv(k, e);
      for (const s of shared.values()) { /* attributes are freed with their geometries */ void s; }
      abyssal.geometry.dispose(); (abyssal.material as THREE.Material).dispose();
      white.dispose(); clear.dispose(); flatNorm.dispose(); density.dispose(); abTex?.dispose();
      world.scene.remove(group);
    },
  };
  // For the test page: run the worker decode path on a known PNG.
  (api as any).decodeTest = (url: string) => new Promise((res) => {
    const id = nextJob++, w = workers[0];
    const on = (ev: MessageEvent) => { if (ev.data.type === 'decodeTest' && ev.data.id === id) { w.removeEventListener('message', on); res(ev.data); } };
    w.addEventListener('message', on);
    w.postMessage({ type: 'decodeTest', id, url });
  });
  (api as any).abyssal = abyssal;
  return api;
}
