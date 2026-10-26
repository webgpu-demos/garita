// Boot shared by the site (main.ts) and by per-part test pages: scene first (something to look at), then the
// store, then layers, UI and feeds.
import * as THREE from 'three';
import * as S from './core/state';
import { effect } from '@preact/signals';
import { dataUrl, flag, params } from './core/config';
import { parsePick, parseGers } from './core/streetview';
import { createEngine } from './world/engine';
import { createTerrain } from './world/terrain/index';
import { createControls } from './world/controls';
import { createPost } from './world/post/index';
import { createStore } from './ontology/index.ts';
import type { Ontology, TwinStore } from './ontology/types';
import ontologyJson from './ontology/ontology.json';
import { startFeeds } from './feeds/index';
import type { Layer, LayerContext, LayerFactory, PickEvent, Picker } from './world/layers';

export interface BootOptions {
  layers?: LayerFactory[];
  /** Mounts the UI; left out by scene-only test pages. */
  ui?: (root: HTMLElement, deps: { store: TwinStore }) => unknown;
}

export function bootApp(opts: BootOptions = {}) {
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const bootEl = document.getElementById('boot');
  const stageEl = document.getElementById('boot-stage');
  const stage = (s: string) => { S.bootStage.value = s; if (stageEl) stageEl.textContent = s; };
  const ontology = ontologyJson as unknown as Ontology;

  // URL flags: ?fixtures=1 ?q=low|medium|high ?t=<ISO> ?sea=<m> ?lang=es ?ui=0 ?nofeeds=1 ?cam=lon,lat,range,heading,pitch
  //            ?pick=lon,lat (pin the building there)
  S.fixturesMode.value = flag('fixtures');
  // ?select=<type>:<key> opens an object (a deep link); it flies there unless ?cam= fixes the view
  const sel = params.get('select');
  if (sel) S.select(sel, { fly: !params.get('cam') });
  const q = params.get('q');
  if (q === 'low' || q === 'medium' || q === 'high') S.quality.value = q;
  const t = params.get('t');
  if (t && !Number.isNaN(Date.parse(t))) { S.clockMode.value = 'manual'; S.sceneTime.value = Date.parse(t); }
  if (params.has('sea')) S.scenario.value = { ...S.scenario.value, seaLevelM: +params.get('sea')!, label: 'manual' };
  if (params.get('lang') === 'es') S.lang.value = 'es';
  // ?shot=1&scale=0.3: automated screenshots under software GL. Low resolution while tiles stream, patience instead
  // of the 40 s cap, and the sky's tables computed without waiting for idle time.
  const shot = flag('shot');
  if (params.has('scale') && Number.isFinite(+params.get('scale')!)) S.renderScale.value = Math.min(1, Math.max(0.1, +params.get('scale')!));
  const ov = params.get('overlay');
  if (ov) S.overlay.value = ov as S.OverlayId;

  const g: any = ((globalThis as any).__garita = { ready: false, state: S });

  // ?pump=1 drives frames from a MessageChannel instead of requestAnimationFrame, so the scene keeps rendering in a
  // hidden or background tab. For automated screenshots only: it spins a core.
  if (flag('pump')) {
    const ch = new MessageChannel(); let queue: FrameRequestCallback[] = [], last = 0, armed = false;
    ch.port1.onmessage = () => {
      const now = performance.now();
      if (now - last < 15.5) { ch.port2.postMessage(0); return; }
      last = now; armed = false;
      const run = queue; queue = [];
      for (const f of run) { try { f(now); } catch (e) { console.error(e); } }
    };
    (globalThis as any).requestAnimationFrame = (f: FrameRequestCallback) => { queue.push(f); if (!armed) { armed = true; ch.port2.postMessage(0); } return 1; };
  }

  // ---- scene ----
  stage('Raising the island');
  const engine = createEngine(canvas, { terrain: createTerrain, controls: createControls, post: createPost });
  const world = engine.world;
  g.world = world; g.engine = engine;
  const layers: Layer[] = [];
  g.debug = () => ({ stats: S.stats.value, view: S.cameraView.value, terrain: world.terrain.stats(), post: (world.post as any).debug?.(), store: g.dbInfo, feeds: g.feeds?.status.value, layers: layers.map((l: any) => l.debug?.() ?? null) });
  const cam = params.get('cam')?.split(',').map(Number);
  const camOk = !!cam && cam.length >= 2 && cam.every(Number.isFinite);
  if (camOk) S.flyTo.value = { lon: cam![0], lat: cam![1], range: cam![2], heading: cam![3], pitch: cam![4], seconds: 0 };
  // ?pick=lon,lat (the street view's "this building in Garita"): look down on the point and pin the building there
  const pick = parsePick(params.get('pick'));
  if (pick) {
    S.pendingPick.value = { ...pick, at: Date.now(), gers: parseGers(params.get('bld')) };
    if (!camOk) S.flyTo.value = { lon: pick.lon, lat: pick.lat, range: 650, heading: 0, pitch: 55, seconds: 0 };
  }
  engine.start();

  // The curtain lifts as soon as the island's coarse tiles are drawn; detail streams in afterwards.
  // `ready` (used by automated screenshots) waits until the view has nothing left to load.
  let settled = 0;
  const off = engine.onFrame((f) => {
    const s = world.terrain.stats();
    if (!S.booted.value && s.tiles >= 6 && f.now > 1.0) { S.booted.value = true; bootEl?.classList.add('gone'); }
    settled = s.pending === 0 && s.tiles > 0 ? settled + 1 : 0;
    if ((settled > (shot ? 4 : 10) && f.index > (shot ? 8 : 20)) || f.now > (shot ? 420 : 40)) { off(); g.ready = true; S.booted.value = true; bootEl?.classList.add('gone'); }
  });
  // A hidden tab gets no frames; do not leave the curtain down forever when it comes back.
  setTimeout(() => { S.booted.value = true; bootEl?.classList.add('gone'); }, 45000);

  // ---- picking and hover: one dispatcher, layers register handlers ----
  const pickers: { p: number; fn: Picker }[] = [], hovers: { p: number; fn: Picker }[] = [];
  const reg = (list: typeof pickers) => (p: number, fn: Picker) => { const e = { p, fn }; list.push(e); list.sort((a, b) => b.p - a.p); return () => { const i = list.indexOf(e); if (i >= 0) list.splice(i, 1); }; };
  const raycaster = new THREE.Raycaster();
  const makeEvent = (ev: PointerEvent | MouseEvent): PickEvent => {
    const r = canvas.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    const ndc = new THREE.Vector2((x / r.width) * 2 - 1, -(y / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, world.camera);
    const origin = raycaster.ray.origin.clone(), dir = raycaster.ray.direction.clone();
    let hit: THREE.Vector3 | null | undefined;
    return { x, y, ndc, origin, dir, shift: ev.shiftKey, ground: () => (hit === undefined ? (hit = world.terrain.raycast(origin, dir)) : hit) };
  };
  let down: { x: number; y: number; t: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || e.button !== 0) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), held = performance.now() - down.t;
    down = null;
    if (moved > 5 || held > 600) return;
    const pe = makeEvent(e);
    for (const h of pickers) { try { if (h.fn(pe)) return; } catch (err) { console.error('[garita] picker failed', err); } }
    S.select(null);
  });
  let lastHover = 0;
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    S.pointerPx.value = { x: e.clientX - r.left, y: e.clientY - r.top };
    const now = performance.now();
    if (now - lastHover < 90 || e.buttons) return;
    lastHover = now;
    const pe = makeEvent(e);
    let over = false;
    for (const h of hovers) { try { if (h.fn(pe)) { over = true; break; } } catch (err) { console.error('[garita] hover handler failed', err); } }
    if (!over) { if (S.hoveredId.value) S.hoveredId.value = null; if (S.hoverText.value) S.hoverText.value = null; }
    canvas.style.cursor = over ? 'pointer' : '';
  });
  canvas.addEventListener('pointerleave', () => { S.pointerPx.value = null; S.hoveredId.value = null; S.hoverText.value = null; });

  // ---- store, layers, UI, feeds ----
  (async () => {
    stage('Opening the database');
    const manifest = await fetch(dataUrl('data/manifest.json'), { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const store = createStore({ ontology, seedUrl: dataUrl('data/twin.db'), seedVersion: manifest?.seedVersion ?? ontology.version });
    S.store.value = store;
    g.store = store;
    if (opts.ui && params.get('ui') !== '0') opts.ui(document.getElementById('ui')!, { store });
    try {
      g.dbInfo = await store.ready;
    } catch (e) {
      console.error('[garita] the store failed to open', e);
      stage('Database unavailable');
      return;
    }
    const ctx: LayerContext = { world, engine, store, onPick: reg(pickers), onHover: reg(hovers) };
    for (const make of opts.layers ?? []) {
      try {
        const layer = await make(ctx);
        layers.push(layer);
        if (layer.update) engine.onFrame((f) => layer.update!(f));
      } catch (e) { console.error('[garita] a scene layer failed to start', e); }
    }
    if (!flag('nofeeds')) g.feeds = startFeeds(store, { fixtures: S.fixturesMode.value });

    // "Fly to this object": resolve its position through the store.
    effect(() => {
      const id = S.pendingFlyToObject.value;
      if (!id) return;
      S.pendingFlyToObject.value = null;
      store.getObject(id).then((o) => {
        if (!o || o.lon == null || o.lat == null) return;
        const range = ({ municipio: 38000, barrio: 9000, tract: 6000, power_region: 90000, forecast_zone: 70000, tropical_cyclone: 600000, earthquake: 60000, weather_alert: 80000 } as Record<string, number>)[o.type] ?? 3500;
        S.flyTo.value = { lon: o.lon, lat: o.lat, range, pitch: 48 };
      });
    });
  })();
  return { engine, world };
}
