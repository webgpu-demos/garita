// The scene's main loop. Owns the renderer, the camera and the clock; delegates to terrain, post and controls.
import * as THREE from 'three';
import { effect } from '@preact/signals';
import * as S from '../core/state';
import { xzToLonLat, curveDrop } from '../core/geo.ts';
import type { Frame, World } from './types';
import type { ControlsApi, PostApi, TerrainApi } from './types';
import { createPlaceholderControls, createPlaceholderPost, createPlaceholderTerrain } from './placeholder';

export interface Engine { world: World; start(): void; stop(): void; onFrame(cb: (f: Frame) => void): () => void }

/** Each part can be swapped; anything left out uses its placeholder. Order of creation: terrain, controls, post. */
export interface EngineParts {
  terrain?: (world: World) => TerrainApi;
  controls?: (world: World) => ControlsApi;
  post?: (world: World) => PostApi;
}

export function createEngine(canvas: HTMLCanvasElement, parts: EngineParts = {}): Engine {
  // The composer does its own anti-aliasing and tone mapping; the canvas buffer stays plain.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', alpha: false, stencil: false });
  renderer.setClearColor(0x050f15, 1);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 100, 3e6);
  const world = { renderer, scene, camera, canvas, sunDir: new THREE.Vector3(0, 1, 0), moonDir: new THREE.Vector3(0, -1, 0), night: 0, seaLevel: 0 } as World;
  world.terrain = (parts.terrain ?? createPlaceholderTerrain)(world);
  world.controls = (parts.controls ?? createPlaceholderControls)(world);
  world.post = (parts.post ?? createPlaceholderPost)(world);

  const maxDpr = () => ({ low: 1, medium: 1.5, high: 2 }[S.quality.value]);
  const resize = () => {
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
    const dpr = Math.min(devicePixelRatio || 1, maxDpr()) * S.renderScale.value;
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    world.post.resize(w, h, dpr);
  };
  addEventListener('resize', resize);
  const disposers = [effect(() => { S.quality.value; S.renderScale.value; resize(); })];

  // state -> scene
  disposers.push(effect(() => { const v = S.flyTo.value; if (v) { world.controls.flyTo(v); S.flyTo.value = null; } }));
  disposers.push(effect(() => { const s = S.scenario.value, w = S.weather.value; world.seaLevel = s.seaLevelM + (s.followTide ? w.tideM : 0); world.post.setSeaLevel(world.seaLevel); }));

  const frameCbs = new Set<(f: Frame) => void>();
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2(2, 2);
  canvas.addEventListener('pointermove', (e) => { const r = canvas.getBoundingClientRect(); pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); });
  canvas.addEventListener('pointerleave', () => pointer.set(2, 2));

  let raf = 0, last = performance.now(), index = 0, t0 = last, fpsAcc = 0, fpsN = 0, lastSceneTime = NaN;
  const tick = (ms: number) => {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(0.1, Math.max(0.001, (ms - last) / 1000));
    last = ms;
    // scene clock
    if (S.clockMode.value === 'live') S.sceneTime.value = Date.now();
    else if (S.playbackRate.value) S.sceneTime.value += dt * 1000 * S.playbackRate.value;
    const time = S.sceneTime.value;
    const frame: Frame = { dt, now: (ms - t0) / 1000, time, index: index++ };
    if (!(Math.abs(time - lastSceneTime) < 20000)) { world.post.setTime(time); lastSceneTime = time; }

    world.controls.update(frame);
    // Near and far follow the camera's height above the curved ground so depth precision goes where it is needed.
    const camH = Math.max(2, camera.position.y + curveDrop(camera.position.x, camera.position.z) - (world.terrain.heightAt(camera.position.x, camera.position.z) ?? 0));
    const near = THREE.MathUtils.clamp(camH * 0.05, 1, 20000);
    const far = Math.max(60000, Math.sqrt(2 * 6371008.8 * Math.max(camH, 50)) * 1.6 + 400000);
    if (Math.abs(camera.near - near) / near > 0.05 || Math.abs(camera.far - far) / far > 0.05) { camera.near = near; camera.far = far; camera.updateProjectionMatrix(); }
    camera.updateMatrixWorld();

    world.terrain.update(frame);
    for (const cb of frameCbs) cb(frame);
    // (frame-by-frame recording advances the scene without drawing while tiles arrive: tools/video/director.mjs)
    if (!(globalThis as any).__garitaSkipDraw) world.post.render(frame);

    // scene -> state, a few times a second
    fpsAcc += dt; fpsN++;
    if (fpsAcc > 0.5) {
      const t = world.terrain.stats();
      S.stats.value = { fps: Math.round(fpsN / fpsAcc), tiles: t.tiles, pending: t.pending, drawCalls: renderer.info.render.calls, tris: renderer.info.render.triangles };
      fpsAcc = 0; fpsN = 0;
      S.cameraView.value = world.controls.view();
      if (pointer.x <= 1) {
        raycaster.setFromCamera(pointer, camera);
        const hit = world.terrain.raycast(raycaster.ray.origin, raycaster.ray.direction);
        if (hit) { const [lon, lat] = xzToLonLat(hit.x, hit.z); S.cursorGeo.value = { lon, lat, elev: world.terrain.heightAt(hit.x, hit.z) ?? 0 }; } else S.cursorGeo.value = null;
      }
    }
  };
  resize();
  return {
    world,
    start() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); } },
    stop() { cancelAnimationFrame(raf); raf = 0; },
    onFrame(cb) { frameCbs.add(cb); return () => frameCbs.delete(cb); },
  };
}
