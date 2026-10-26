// Buildings: every OpenStreetMap footprint in Puerto Rico (1.5 million), plus the footprints a machine detected on
// imagery where OpenStreetMap has none (Overture Maps: Google Open Buildings, Microsoft ML Buildings; flagged in
// the tile, drawn the same, named as detections in the tooltip), streamed as zoom-14 tiles around the
// orbit target when the camera is low, meshed in a Worker into one geometry per tile, drawn with one material.
//
// REAL (from the tiles): footprints, the heights OpenStreetMap carries (13.8 %), ground elevation at the centroid,
// FEMA flood class; the roof albedo is the aerial photo itself (the imagery the terrain drapes: zoom 16 near the
// target, zoom 15 beyond), lifted to the roof. PROCEDURAL: all other heights (flagged; the tooltip says
// "estimated"), wall colours, windows, lit rooms, the parapet rim, and roofs where the photo has no data. The sea-level tint is a bathtub screen: ground elevation against the scenario level.
import * as THREE from 'three';
import { effect } from '@preact/signals';
import * as S from '../../core/state';
import { dataUrl, UPSTREAM } from '../../core/config';
import { curveDrop, lonToTileX, latToTileY, xzToLonLat, lonLatToXZ, tileLon, tileLat, AST_OFFSET_H } from '../../core/geo.ts';
import type { LayerFactory, PickEvent } from '../layers';
import type { Frame } from '../types';
import { createBuildingMaterial, createSharedUniforms, type TileUniforms } from './material';
import type { MeshJob, MeshResult } from './worker';

const Z = 14, MAX_RANGE = 14000, FADE_S = 0.45, MAX_FETCH = /[?&]video=1/.test(globalThis.location?.search ?? '') ? 8 : 4, SINK = 3, SHADOW_TILES = 2.2;

interface Tile {
  key: string; x: number; y: number; id: number;
  state: 'queued' | 'loading' | 'ready' | 'failed';
  used: number; d: number; born: number; fading: boolean;
  mesh: THREE.Mesh | null; pick: MeshResult | null; count: number; tris: number; yRef: number;
  material: THREE.MeshStandardMaterial | null; uni: TileUniforms | null;
  // roof photo: zoom loaded (0 = none), loading flag, when it arrived, when to try again after a failure
  tex: THREE.Texture | null; photoZ: number; photoBusy: boolean; photoBorn: number; photoRetry: number; texBytes: number;
}

export const createBuildings: LayerFactory = async (ctx) => {
  const { world } = ctx;
  const group = new THREE.Group();
  group.name = 'buildings';
  world.scene.add(group);
  const uniforms = createSharedUniforms();
  const maxAniso = Math.min(4, world.renderer.capabilities.getMaxAnisotropy());

  // which aerial photo tiles are mirrored on our own origin (the rest come from the upstream service)
  let imgIndex: Map<number, Set<number>> | null = null;
  fetch(dataUrl('tiles/index.json')).then((r) => (r.ok && !(r.headers.get('content-type') || '').startsWith('text/html') ? r.json() : null)).then((j) => {
    if (j && j.img) { const m = new Map<number, Set<number>>(); for (const z in j.img) m.set(+z, new Set((j.img[z] as [number, number][]).map(([x, y]) => x * 65536 + y))); imgIndex = m; }
  }).catch(() => {});
  const imgUrl = (z: number, x: number, y: number) => (imgIndex?.get(z)?.has(x * 65536 + y) ? dataUrl(`tiles/img/${z}/${x}/${y}.jpg`) : UPSTREAM.img(z, x, y));
  // at most 6 photo requests in flight
  let imgActive = 0;
  const imgQueue: (() => void)[] = [];
  const loadImage = (url: string) => new Promise<ImageBitmap | null>((res) => {
    const run = () => {
      imgActive++;
      fetch(url, { mode: 'cors' }).then((r) => (r.ok ? r.blob() : null)).then((b) => (b ? createImageBitmap(b) : null)).catch(() => null)
        .then((bm) => { imgActive--; imgQueue.shift()?.(); res(bm); });
    };
    if (imgActive < 6) run(); else imgQueue.push(run);
  });

  // which tiles exist (so the sea and the forest never cost a 404)
  const have = new Set<string>();
  let addedBy = '';   // who detected the added footprints, from the tile index: "Google, Microsoft via Overture Maps"
  try {
    const idx = await fetch(dataUrl('tiles/bld/index.json')).then((r) => (r.ok ? r.json() : null));
    for (const t of (idx?.tiles ?? []) as [number, number, number][]) have.add(t[0] + '/' + t[1]);
    const fam = [...new Set(((idx?.added_source?.datasets ?? []) as { family?: string; added?: number }[]).filter((d) => d.family && d.added).map((d) => d.family as string))];
    if (fam.length) addedBy = fam.join(', ');
  } catch (e) { console.warn('[garita/buildings] no building index', e); }

  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const tiles = new Map<string, Tile>();
  const byId = new Map<number, Tile>();
  const wanted: Tile[] = [], ready: Tile[] = [];
  let nextId = 1, loading = 0, stamp = 0, disposed = false, lastScan = -1, now = 0;
  let nBuildings = 0, nTris = 0, nReady = 0, photoTiles = 0, texBytes = 0, nPhotos = 0;

  const dropTile = (t: Tile) => {
    if (t.mesh) { group.remove(t.mesh); t.mesh.geometry.dispose(); nBuildings -= t.count; nTris -= t.tris; nReady--; }
    if (t.tex) { t.tex.dispose(); texBytes -= t.texBytes; nPhotos--; t.tex = null; }
    t.material?.dispose();
    t.mesh = null; t.pick = null; t.material = null; t.uni = null;
    tiles.delete(t.key); byId.delete(t.id);
  };

  worker.onmessage = (e: MessageEvent<MeshResult | { id: number; error: string }>) => {
    const r = e.data, t = byId.get(r.id);
    loading--;
    if (!t || disposed) return;
    if ('error' in r) { t.state = 'failed'; console.warn('[garita/buildings] meshing failed', t.key, r.error); return; }
    t.state = 'ready'; t.count = r.count; t.tris = r.triangles; t.yRef = r.yRef; t.pick = r;
    if (!r.count) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(r.position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(r.normal, 3, true));
    g.setAttribute('aFac', new THREE.BufferAttribute(r.fac, 4));
    g.setAttribute('aBld', new THREE.BufferAttribute(r.bld, 3));
    g.setAttribute('aEdge', new THREE.BufferAttribute(r.edge, 3));
    g.setIndex(new THREE.BufferAttribute(r.index, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(r.sphere[0], r.sphere[1], r.sphere[2]), r.sphere[3]);
    const { material, uniforms: uni } = createBuildingMaterial(uniforms);
    // roof photo lookup: tile-local metres -> 0..1 across the tile (u east, v south; the canvas is drawn north up)
    const xW = lonLatToXZ(tileLon(t.x, Z), 0)[0] - r.cx, xE = lonLatToXZ(tileLon(t.x + 1, Z), 0)[0] - r.cx;
    const zN = lonLatToXZ(0, tileLat(t.y, Z))[1] - r.cz, zS = lonLatToXZ(0, tileLat(t.y + 1, Z))[1] - r.cz;
    uni.uBPhotoXf.value.set(1 / (xE - xW), 1 / (zS - zN), -xW / (xE - xW), -zN / (zS - zN));
    const m = new THREE.Mesh(g, material);
    m.matrixAutoUpdate = false;
    m.position.set(r.cx, 0, r.cz); m.updateMatrix();
    m.receiveShadow = true; m.castShadow = false;      // casts once it has risen (the depth pass does not know the fade)
    t.mesh = m; t.material = material; t.uni = uni; t.born = now; t.fading = true;
    group.add(m);
    nBuildings += t.count; nTris += t.tris; nReady++;
  };

  const startLoad = (t: Tile) => {
    t.state = 'loading'; loading++;
    fetch(dataUrl(`tiles/bld/${Z}/${t.x}/${t.y}.bin`))
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
      .then((buf) => {
        if (disposed || tiles.get(t.key) !== t) { loading--; return; }
        const job: MeshJob = { id: t.id, x: t.x, y: t.y, buf };
        worker.postMessage(job, [buf]);
      })
      .catch((err) => { loading--; t.state = 'failed'; if (!disposed) console.warn('[garita/buildings] tile failed', t.key, String(err)); });
  };

  /** Roof photo for a tile: the aerial imagery of its extent at zoom z (15: 2 x 2 tiles, 16: 4 x 4), drawn into one texture. */
  const startPhoto = (t: Tile, z: number) => {
    t.photoBusy = true; photoTiles++;
    const n = 1 << (z - Z), px = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = n * px;
    const c2 = canvas.getContext('2d')!;
    c2.fillStyle = '#000'; c2.fillRect(0, 0, n * px, n * px);        // black = no data (the shader falls back)
    let got = 0;
    const jobs: Promise<void>[] = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++)
      jobs.push(loadImage(imgUrl(z, t.x * n + i, t.y * n + j)).then((bm) => { if (bm) { c2.drawImage(bm, i * px, j * px, px, px); bm.close(); got++; } }));
    Promise.all(jobs).then(() => {
      t.photoBusy = false; photoTiles--;
      if (disposed || tiles.get(t.key) !== t || !t.uni || !got) { canvas.width = canvas.height = 0; t.photoRetry = now + 30; return; }
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = false; tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter; tex.anisotropy = maxAniso;
      tex.onUpdate = () => { canvas.width = canvas.height = 0; };     // uploaded: drop the CPU copy
      if (t.tex) { t.tex.dispose(); texBytes -= t.texBytes; nPhotos--; } else t.photoBorn = now;
      t.tex = tex; t.uni.tBPhoto.value = tex; t.photoZ = z;
      t.texBytes = Math.round(n * px * n * px * 4 * 4 / 3); texBytes += t.texBytes; nPhotos++;
    });
  };

  const byDist = (a: Tile, b: Tile) => a.d - b.d;
  const byUsed = (a: Tile, b: Tile) => a.used - b.used || b.d - a.d;
  /** Decide which tiles are wanted around the orbit target, start loads (nearest first), evict the least recently used. */
  const scan = (range: number) => {
    const low = S.quality.value === 'low';
    const maxTiles = low ? 20 : 44;
    let radius = THREE.MathUtils.clamp(range * 1.15 + 1200, 2600, 8600);
    if (low) radius *= 0.5;
    const tg = world.controls.target;
    const [lon, lat] = xzToLonLat(tg.x, tg.z);
    const tx = lonToTileX(lon, Z), ty = latToTileY(lat, Z), rT = radius / 2320;
    stamp++;
    wanted.length = 0;
    for (let y = Math.floor(ty - rT); y <= Math.floor(ty + rT); y++) for (let x = Math.floor(tx - rT); x <= Math.floor(tx + rT); x++) {
      const key = x + '/' + y;
      if (!have.has(key)) continue;
      const dx = Math.max(x - tx, 0, tx - x - 1), dy = Math.max(y - ty, 0, ty - y - 1);
      if (dx * dx + dy * dy > rT * rT) continue;
      let t = tiles.get(key);
      if (!t) { t = { key, x, y, id: nextId++, state: 'queued', used: 0, d: 0, born: 0, fading: false, mesh: null, pick: null, count: 0, tris: 0, yRef: 0, material: null, uni: null, tex: null, photoZ: 0, photoBusy: false, photoBorn: 0, photoRetry: 0, texBytes: 0 }; tiles.set(key, t); byId.set(t.id, t); }
      t.d = Math.hypot(x + 0.5 - tx, y + 0.5 - ty);
      wanted.push(t);
    }
    wanted.sort(byDist);
    if (wanted.length > maxTiles) wanted.length = maxTiles;
    // only tiles within about 5 km of the target go through the sun shadow pass (and none while it is still rising:
    // the depth pass does not know the fade)
    for (const t of wanted) { t.used = stamp; if (t.mesh && !t.fading) t.mesh.castShadow = t.d < SHADOW_TILES; }
    for (const t of wanted) { if (loading >= MAX_FETCH) break; if (t.state === 'queued') startLoad(t); }
    // roof photos after the geometry, nearest first: zoom 16 within about 3 km of the target, zoom 15 beyond
    // (one tile at a time while the terrain is still fetching its own tiles from the same imagery host)
    const photoSlots = world.terrain.stats().pending > 10 ? 1 : 2;
    for (const t of wanted) {
      if (photoTiles >= photoSlots) break;
      if (!t.mesh || t.photoBusy || now < t.photoRetry) continue;
      const z = !low && t.d < 1.35 ? 16 : 15;
      if (t.photoZ < z) startPhoto(t, z);
      else if (t.photoZ === 16 && t.d > 3.2 && texBytes > 150e6) startPhoto(t, 15);   // far again and memory is tight: back to zoom 15
    }
    // evict: queued tiles no longer wanted go at once; meshes beyond the budget go oldest first
    ready.length = 0;
    for (const t of tiles.values()) {
      if (t.used === stamp) continue;
      if (t.state === 'queued' || t.state === 'failed') dropTile(t); else if (t.state === 'ready') ready.push(t);
    }
    if (tiles.size > maxTiles) { ready.sort(byUsed); for (const t of ready) { if (tiles.size <= maxTiles) break; dropTile(t); } }
  };

  // ---- hover: ray against the prisms near where the ray meets the ground
  const KIND = { en: ['house', 'apartments', 'commercial', 'industrial', 'civic', 'religious', ''], es: ['casa', 'apartamentos', 'comercial', 'industrial', 'cívico', 'religioso', ''] };
  const FLOOD = { en: ['', 'FEMA 0.2 % annual-chance zone', 'FEMA 1 % annual-chance zone', 'FEMA coastal high-hazard zone'], es: ['', 'zona FEMA de 0.2 % anual', 'zona FEMA de 1 % anual', 'zona costera de alto riesgo FEMA'] };
  const inRing = (p: MeshResult, i: number, x: number, z: number) => {
    let inside = false;
    const a = p.ringStart[i], b = p.ringStart[i + 1], r = p.ring;
    for (let k = a, j = b - 1; k < b; j = k++) {
      const xk = r[k * 2], zk = r[k * 2 + 1], xj = r[j * 2], zj = r[j * 2 + 1];
      if ((zk > z) !== (zj > z) && x < (xj - xk) * (z - zk) / (zj - zk) + xk) inside = !inside;
    }
    return inside;
  };
  /** The building the ray meets first (its roof from above, else a wall), or null. */
  const hitTest = (e: PickEvent): { t: Tile; i: number } | null => {
    if (!group.visible) return null;
    const g = e.ground();
    if (!g) return null;
    const o = e.origin, d = e.dir;
    const tG = g.distanceTo(o), tA = Math.max(0, tG - 700);
    const ax = o.x + d.x * tA, az = o.z + d.z * tA;
    const sx0 = Math.min(ax, g.x) - 2, sx1 = Math.max(ax, g.x) + 2, sz0 = Math.min(az, g.z) - 2, sz1 = Math.max(az, g.z) + 2;
    let best = tG + 4, bt: Tile | null = null, bi = -1;
    for (const t of tiles.values()) {
      const p = t.pick;
      if (!p || !t.mesh || !p.count) continue;
      const lx0 = sx0 - p.cx, lx1 = sx1 - p.cx, lz0 = sz0 - p.cz, lz1 = sz1 - p.cz;
      if (lx1 < -2400 || lx0 > 2400 || lz1 < -2400 || lz0 > 2400) continue;
      const ox = o.x - p.cx, oz = o.z - p.cz, bb = p.bbox, drop = curveDrop(g.x, g.z);
      for (let i = 0; i < p.count; i++) {
        if (bb[i * 4] > lx1 || bb[i * 4 + 2] < lx0 || bb[i * 4 + 1] > lz1 || bb[i * 4 + 3] < lz0) continue;
        const yTop = p.base[i] + p.height[i] - drop, yLow = p.base[i] - SINK - drop;
        if (d.y < -1e-6) {
          const tt = (yTop - o.y) / d.y;
          if (tt > 0 && tt < best && inRing(p, i, ox + d.x * tt, oz + d.z * tt)) { best = tt; bt = t; bi = i; }
        }
        const a = p.ringStart[i], b = p.ringStart[i + 1], r = p.ring;
        for (let k = a, j = b - 1; k < b; j = k++) {
          const x1 = r[j * 2], z1 = r[j * 2 + 1], ex = r[k * 2] - x1, ez = r[k * 2 + 1] - z1;
          const den = d.x * ez - d.z * ex;
          if (Math.abs(den) < 1e-9) continue;
          const tt = ((x1 - ox) * ez - (z1 - oz) * ex) / den, s = ((x1 - ox) * d.z - (z1 - oz) * d.x) / den;
          if (tt <= 0 || tt >= best || s < 0 || s > 1) continue;
          const y = o.y + d.y * tt;
          if (y >= yLow && y <= yTop) { best = tt; bt = t; bi = i; }
        }
      }
    }
    return bt && bi >= 0 ? { t: bt, i: bi } : null;
  };
  /** What the tile says about record `bi`: kind, detection, height and where it came from, ground, flood zone. */
  const describe = (bt: Tile, bi: number): string => {
    const p = bt.pick!, m = p.meta[bi], es = S.lang.value === 'es';
    const kind = (es ? KIND.es : KIND.en)[m & 7], flood = (es ? FLOOD.es : FLOOD.en)[(m >> 3) & 3], est = (m & 32) !== 0, added = (m & 64) !== 0;
    const parts = [(es ? 'Edificio' : 'Building') + (kind ? ` (${kind})` : '')];
    // An added footprint is a machine detection, never presented as a mapped building; its kind is a guess from its area.
    if (added) {
      parts.push(es
        ? `huella detectada por máquina en imágenes${addedBy ? ` (${addedBy}, vía Overture Maps)` : ''}; no está en OpenStreetMap`
        : `footprint detected from imagery by machine${addedBy ? ` (${addedBy}, via Overture Maps)` : ''}; not in OpenStreetMap`);
    }
    const hSrc = added ? 'Overture Maps' : 'OpenStreetMap';
    parts.push(`${p.height[bi].toFixed(1)} m ` + (est ? (es ? '(altura estimada)' : '(height estimated)') : (es ? `(altura de ${hSrc})` : `(height from ${hSrc})`)));
    if (p.ground[bi] !== -32768) {
      const gm = p.ground[bi] / 10, sea = world.seaLevel;
      parts.push((es ? 'terreno ' : 'ground ') + gm.toFixed(1) + ' m' + (sea > 0.05 && gm <= sea
        ? (es ? `: en o bajo el nivel del escenario de +${sea.toFixed(1)} m` : `: at or below the +${sea.toFixed(1)} m scenario level`) : ''));
    }
    if (flood) parts.push(flood);
    return parts.join(' · ');
  };
  const hover = (e: PickEvent): boolean => {
    const h = hitTest(e);
    if (!h) return false;
    const text = describe(h.t, h.i);
    if (S.hoverText.value !== text) S.hoverText.value = text;
    if (S.hoveredId.value) S.hoveredId.value = null;
    return true;
  };
  const offHover = ctx.onHover(10, hover);

  // ---- pinning: a click on a building, or ?pick=lon,lat, opens the building card (ui/building.tsx) and outlines it
  const outline = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffb547, depthTest: false, transparent: true, opacity: 0.95 }));
  outline.renderOrder = 50; outline.frustumCulled = false; outline.visible = false;
  world.scene.add(outline);
  const ringOf = (p: MeshResult, i: number): [number, number][] => {
    const out: [number, number][] = [];
    for (let k = p.ringStart[i]; k < p.ringStart[i + 1]; k++) out.push([p.ring[k * 2] + p.cx, p.ring[k * 2 + 1] + p.cz]);
    return out;
  };
  const pin = (t: Tile, i: number) => {
    const p = t.pick!, ring = ringOf(p, i);
    let sx = 0, sz = 0;
    for (const [x, z] of ring) { sx += x; sz += z; }
    const [lon, lat] = xzToLonLat(sx / ring.length, sz / ring.length);
    S.pinnedBuilding.value = { lon, lat, text: describe(t, i), tile: t.key, index: i };
    // roof and ground rings, joined at the corners, drawn over everything so it reads through other buildings
    const pos: number[] = [];
    const drop = curveDrop(sx / ring.length, sz / ring.length), yTop = p.base[i] + p.height[i] - drop + 0.3, yLow = p.base[i] - drop;
    for (let k = 0; k < ring.length; k++) {
      const [x1, z1] = ring[k], [x2, z2] = ring[(k + 1) % ring.length];
      pos.push(x1, yTop, z1, x2, yTop, z2, x1, yLow, z1, x2, yLow, z2, x1, yLow, z1, x1, yTop, z1);
    }
    outline.geometry.dispose();
    outline.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    outline.visible = true;
  };
  const offPick = ctx.onPick(10, (e) => {
    const h = hitTest(e);
    if (!h) { if (S.pinnedBuilding.peek()) S.pinnedBuilding.value = null; return false; }
    pin(h.t, h.i);
    return true;
  });
  const offPinned = effect(() => { if (!S.pinnedBuilding.value) outline.visible = false; });
  /** ?pick: once the tile under the point is in, the footprint holding the point (else the nearest within 15 m). */
  const resolvePick = () => {
    const want = S.pendingPick.peek();
    if (!want) return;
    if (Date.now() - want.at > 120000) { S.pendingPick.value = null; return; }   // (never loaded: give up quietly)
    const key = Math.floor(lonToTileX(want.lon, Z)) + '/' + Math.floor(latToTileY(want.lat, Z));
    if (!have.has(key)) { S.pendingPick.value = null; return; }                  // no buildings there
    const t = tiles.get(key);
    if (!t || t.state !== 'ready' || !t.pick) return;
    S.pendingPick.value = null;
    const p = t.pick, [wx, wz] = lonLatToXZ(want.lon, want.lat), x = wx - p.cx, z = wz - p.cz;
    let best = -1, bestD = 15;
    for (let i = 0; i < p.count; i++) {
      const bb = p.bbox;
      const dx = Math.max(bb[i * 4] - x, 0, x - bb[i * 4 + 2]), dz = Math.max(bb[i * 4 + 1] - z, 0, z - bb[i * 4 + 3]);
      if (dx === 0 && dz === 0 && inRing(p, i, x, z)) { best = i; break; }
      const d = Math.hypot(dx, dz);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) pin(t, best);
  };

  const update = (f: Frame) => {
    now = f.now;
    const range = S.cameraView.value.range;
    const on = S.layerOn.value.buildings !== false && range < MAX_RANGE;
    if (group.visible !== on) group.visible = on;
    if (!on) return;
    // uniforms from the world and the app state
    uniforms.uBNight.value = world.night;
    uniforms.uBSea.value = world.seaLevel;
    uniforms.uBNfhl.value = S.overlay.value === 'nfhl' ? 1 : 0;
    // share of rooms lit by the scene clock (AST): evening full, thinning after 22 h, least before dawn
    const hr = (((S.sceneTime.value / 3600000 + AST_OFFSET_H) % 24) + 24) % 24;
    const late = hr >= 18 ? Math.max(0, hr - 21.5) : hr + 2.5;       // hours past 21:30
    uniforms.uBLit.value = hr > 6.5 && hr < 17 ? 0.25 : THREE.MathUtils.clamp(0.36 - late * 0.06, 0.07, 0.36) + (hr > 5 && hr <= 6.5 ? 0.1 : 0);
    if (S.overlay.value === 'nightlights') uniforms.uBLit.value = 0;   // observed night lights on the map: no modelled window lights over them

    if (f.index % 8 === 0 || lastScan < 0) { lastScan = f.index; scan(range); resolvePick(); }
    for (const t of tiles.values()) {
      if (!t.fading || !t.mesh) continue;
      let s = (now - t.born) / FADE_S;
      if (s >= 1) { s = 1; t.fading = false; t.mesh.castShadow = t.d < SHADOW_TILES; }
      t.uni!.uBFade.value = s * s * (3 - 2 * s);
    }
    if (nPhotos) for (const t of tiles.values()) {
      const u = t.uni;
      if (u && t.tex && u.uBPhotoOn.value < 1) u.uBPhotoOn.value = Math.min(1, (now - t.photoBorn) / 0.6);
    }
  };

  const layer = {
    update,
    debug: () => ({ tiles: nReady, buildings: nBuildings, triangles: nTris, pending: loading + [...tiles.values()].filter((t) => t.state === 'queued').length, photos: nPhotos, photoPending: photoTiles, textureMB: +(texBytes / 1048576).toFixed(1) }),
    dispose() {
      disposed = true; offHover(); offPick(); offPinned(); worker.terminate();
      for (const t of [...tiles.values()]) dropTile(t);
      world.scene.remove(group); world.scene.remove(outline); outline.geometry.dispose();
    },
  };
  return layer;
};
