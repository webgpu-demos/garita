// Renders one scene of the walkthrough video, frame by frame, from the deployed site (runs on a GitHub runner:
// software GL, live network). Time inside the page is virtual: requestAnimationFrame and performance.now are
// replaced, and each output frame advances the clock by exactly 1/fps, however long the frame took to draw. So the
// waves, the clouds and every camera move play smoothly although the machine draws a frame or two a second.
//
//   node tools/video/director.mjs <spec.json> <scene id> <out dir>
//
// Scene spec (one entry of spec.scenes):
//   { id, url, duration, fps?,
//     camera:  [{ t, cam: [lon, lat, range, heading, pitch], ease? }]     keyframes; omitted = camera stays put
//     actions: [{ t, click: "<playwright selector>" | clickjs: "<fn returning an element>", move?: s }
//               { t, js: "<code using S, W, G>" }
//               { t, type: "text", cps? }
//               { t, scroll: { sel, dy, dur } }
//               { t, key: "Enter" }
//               { t, select: "<selector of a <select>>", value }
//               { t, drag: "<selector of a range input>", to: value, dur }
//               { t, geo: [lon, lat, metres above ground] }               move the pointer over a place in the scene
//               any action may add hold: ms — real time to let tiles and overlays arrive before the next frame]
//     tweens:  [{ from, to, js: "<code using S, W, G and k (0..1)>", ease? }]
//     setup:   ["<code>"]                     run once after loading, before frame 0
//     cursor:  false                          hide the pointer for this scene
//     start:   [x, y]                         where the pointer rests at frame 0 }
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(process.env.NODE_PATH ? process.env.NODE_PATH + '/' : import.meta.url);
const { chromium } = require(process.env.PW_MODULE || 'playwright');

const [specFile, sceneId, outDir] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const scene = spec.scenes.find((s) => s.id === sceneId);
if (!scene) throw new Error(`no scene ${sceneId}`);
const W = spec.width ?? 1920, H = spec.height ?? 1080, FPS = scene.fps ?? spec.fps ?? 30;
const N = Math.round(scene.duration * FPS);
const base = spec.base ?? 'https://webgpu-demos.github.io/garita/';
const url = base + scene.url + (scene.url.includes('?') ? '&' : '?') + `shot=1&video=1&scale=${scene.renderScale ?? spec.renderScale ?? 0.67}`;
fs.mkdirSync(path.join(outDir, 'frames'), { recursive: true });
const log = (...a) => { const l = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(l); fs.appendFileSync(path.join(outDir, 'log.txt'), l + '\n'); };

const browser = await chromium.launch({
  ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-vsync', '--no-sandbox', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error') log('[console]', m.text().slice(0, 240)); });
page.on('pageerror', (e) => log('[pageerror]', String(e).slice(0, 300)));

// ---- virtual time (before any page script) ----
await page.addInitScript(() => {
  let vt = 0; const q = [];
  performance.now = () => vt;
  window.requestAnimationFrame = (cb) => { q.push(cb); return q.length; };
  window.cancelAnimationFrame = () => {};
  window.__vt = {
    step(dt) { vt += dt; const run = q.splice(0); for (const f of run) { try { f(vt); } catch (e) { console.error(e); } } return run.length; },
    get t() { return vt; },
  };
});

// A step either draws (one output frame) or only advances the scene: terrain and layers request and upload tiles,
// the post-processing pass that costs seconds under software GL is skipped.
const stepPage = (dt, draw = true) => page.evaluate(({ d, draw }) => { window.__garitaSkipDraw = !draw; try { return window.__vt.step(d); } finally { window.__garitaSkipDraw = false; } }, { d: dt, draw });
const stats = () => page.evaluate(() => {
  const g = window.__garita, s = g?.state, t = g?.world?.terrain?.stats?.() ?? { tiles: 0, pending: 1 };
  let layers = 0;
  try { for (const l of g.debug?.().layers ?? []) if (l && typeof l.pending === 'number') layers += l.pending; } catch { /* not booted */ }
  return { booted: !!s?.booted?.value, ready: !!g?.ready, tiles: t.tiles, pending: t.pending + layers, terrain: t.pending, layers, maxZoom: t.maxZoom };
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Advance the scene without drawing or moving time until nothing is waiting to load (or the budget runs out). */
async function settle(budgetMs, minMs = 0) {
  const t0 = Date.now(); let n = 0, s;
  for (;;) {
    await stepPage(0, false); n++;
    s = await stats();
    const el = Date.now() - t0;
    if ((s.pending === 0 && s.tiles > 0 && el >= minMs) || el > budgetMs) break;
    await sleep(60);
  }
  return { ms: Date.now() - t0, steps: n, pending: s.pending };
}

log('scene', scene.id, url, `${N} frames at ${FPS} fps`);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
// boot: let virtual time run (the curtain, the store, the first tiles), drawing now and then (the sky's tables are
// computed on draw), then wait for the view to settle
{
  const t0 = Date.now(); let i = 0;
  while (Date.now() - t0 < 300000) {
    await stepPage(33, i % 6 === 0); i++;
    if (i % 10 === 0) { const s = await stats(); if (s.booted && s.tiles > 0 && s.pending === 0 && i > 120) break; }
    await sleep(20);
  }
  log('booted after', Math.round((Date.now() - t0) / 1000), 's,', i, 'steps', JSON.stringify(await stats()));
}
const run = (code, extra = {}) => page.evaluate(({ code, extra }) => {
  const g = window.__garita;
  return new Function('S', 'W', 'G', 'k', code)(g.state, g.world, g, extra.k);
}, { code, extra });
for (const code of scene.setup ?? []) await run(code);
// camera at its first keyframe before settling
const ease = (k, e = 'inOut') => (e === 'linear' ? k : e === 'in' ? k * k * k : e === 'out' ? 1 - Math.pow(1 - k, 3) : k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
function camAt(t) {
  const kf = scene.camera; if (!kf?.length) return null;
  if (t <= kf[0].t) return kf[0].cam;
  for (let i = 1; i < kf.length; i++) {
    if (t <= kf[i].t) {
      const a = kf[i - 1].cam, b = kf[i].cam, k = ease((t - kf[i - 1].t) / (kf[i].t - kf[i - 1].t), kf[i].ease);
      let dh = b[3] - a[3]; if (dh > 180) dh -= 360; if (dh < -180) dh += 360;
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, Math.exp(Math.log(a[2]) + (Math.log(b[2]) - Math.log(a[2])) * k), a[3] + dh * k, a[4] + (b[4] - a[4]) * k];
    }
  }
  return kf[kf.length - 1].cam;
}
const setCam = (c) => c && page.evaluate((c) => window.__garita.world.controls.flyTo({ lon: c[0], lat: c[1], range: c[2], heading: c[3], pitch: c[4], seconds: 0 }), c);
await setCam(camAt(0));
for (let i = 0; i < 4; i++) { await stepPage(0, true); log('settle', JSON.stringify(await settle(60000))); }

// ---- the pointer: drawn into the page so it is in the screenshot ----
const showCursor = scene.cursor !== false;
await page.evaluate((show) => {
  const d = document.createElement('div');
  d.id = '__cursor';
  d.style.cssText = `position:fixed;left:0;top:0;width:28px;height:28px;z-index:2147483647;pointer-events:none;display:${show ? 'block' : 'none'};`;
  d.innerHTML = '<div id="__ripple" style="position:absolute;left:0;top:0;width:0;height:0;border-radius:50%;border:2px solid rgba(255,140,90,0.9);transform:translate(-50%,-50%);opacity:0"></div>'
    + '<svg width="28" height="28" viewBox="0 0 28 28" style="position:absolute;left:-3px;top:-2px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.55))"><path d="M4 2 L4 22 L9.5 17 L13 25 L16.5 23.5 L13 15.8 L20.5 15.8 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  document.body.appendChild(d);
  window.__cursor = { set(x, y, r) { d.style.transform = `translate(${x}px, ${y}px)`; const rp = document.getElementById('__ripple'); if (r > 0 && r < 1) { rp.style.width = rp.style.height = `${10 + 40 * r}px`; rp.style.opacity = String(1 - r); } else rp.style.opacity = '0'; } };
}, showCursor);

// ---- timeline ----
const actions = (scene.actions ?? []).map((a, i) => ({ ...a, i, done: false })).sort((a, b) => a.t - b.t);
const moves = [];   // pointer movements { t0, t1, from, to }
let pointer = scene.start ?? [W * 0.62, H * 0.55], lastClick = -10;
async function target(a) {
  if (a.click || a.select) { const box = await page.locator(a.click ?? a.select).first().boundingBox({ timeout: 5000 }).catch(() => null); return box && [box.x + box.width / 2, box.y + box.height / 2]; }
  if (a.clickjs) {
    const h = await page.evaluateHandle(({ code }) => { const g = window.__garita; return new Function('S', 'W', 'G', code)(g.state, g.world, g); }, { code: a.clickjs });
    const el = h.asElement(); const box = el && (await el.boundingBox()); return box && [box.x + box.width / 2, box.y + box.height / 2];
  }
  if (a.drag) {
    // a range input: from the thumb at its current value to the thumb at `to`
    const r = await page.locator(a.drag).first().evaluate((el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, min: +el.min || 0, max: +el.max || 100, v: +el.value }; }).catch(() => null);
    if (!r) return null;
    const at = (v) => [r.x + 8 + ((v - r.min) / (r.max - r.min)) * (r.w - 16), r.y + r.h / 2];
    a.dragTo = at(a.to); return at(r.v);
  }
  if (a.geo) {
    return page.evaluate(([lon, lat, h]) => {
      const W = window.__garita.world, M_LON = 105773.6, M_LAT = 110682.9;
      const x = (lon + 66.45) * M_LON, z = -(lat - 18.22) * M_LAT;
      const y = (W.terrain.heightAt(x, z) ?? 0) - (x * x + z * z) / (2 * 6371008.8) + (h ?? 0);
      const v = W.camera.position.clone().set(x, y, z).project(W.camera);
      const r = W.canvas.getBoundingClientRect();
      return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height];
    }, a.geo);
  }
  if (a.point) return a.point;
  return null;
}
// pointer moves start `move` seconds before each click; targets are looked up when the move starts
const pending = actions.filter((a) => a.click || a.clickjs || a.point || a.geo || a.drag || a.select);
let typing = null, scrolls = [], drag = null, mouseAt = null, holdMs = 0;
const t0 = Date.now();
process.on('unhandledRejection', (e) => { log('unhandled', String(e?.stack ?? e).slice(0, 600)); process.exit(2); });
process.on('uncaughtException', (e) => { log('uncaught', String(e?.stack ?? e).slice(0, 600)); process.exit(2); });
for (let f = 0; f < N; f++) {
  const t = f / FPS;
  // pointer moves due to start
  for (const a of pending) {
    const mv = a.move ?? 0.8;
    if (!a.moving && t >= a.t - mv) { a.moving = true; const to = await target(a); if (to) moves.push({ t0: a.t - mv, t1: a.t, from: pointer, to }); else log('target not found for action at', a.t, a.click ?? a.clickjs?.slice(0, 60)); a.to = to; }
  }
  // actions due
  for (const a of actions) {
    if (a.done || t < a.t) continue;
    a.done = true;
    try {
      if ((a.click || a.clickjs) && a.to) { await page.mouse.click(a.to[0], a.to[1]); lastClick = t; pointer = a.to; mouseAt = a.to; }
      else if (a.select && a.to) { await page.selectOption(a.select, a.value); lastClick = t; pointer = a.to; }
      else if (a.drag && a.to) { await page.mouse.move(a.to[0], a.to[1]); await page.mouse.down(); lastClick = t; drag = { from: a.to, to: a.dragTo, t0: t, dur: a.dur ?? 2 }; }
      else if ((a.point || a.geo) && a.to) { await page.mouse.move(a.to[0], a.to[1]); pointer = a.to; mouseAt = a.to; }
      if (a.js) await run(a.js);
      if (a.type) typing = { text: a.type, i: 0, next: t, dt: 1 / (a.cps ?? 14) };
      if (a.key) await page.keyboard.press(a.key);
      if (a.scroll) scrolls.push({ ...a.scroll, from: t, start: null, done: 0 });
      if (a.hold) holdMs = Math.max(holdMs, a.hold);
    } catch (e) { log('action failed at', a.t, String(e).slice(0, 200)); }
  }
  if (typing && t >= typing.next) { await page.keyboard.type(typing.text[typing.i]); typing.i++; typing.next = t + typing.dt; if (typing.i >= typing.text.length) typing = null; }
  for (const s of scrolls) {
    const k = Math.min(1, (t - s.from) / (s.dur ?? 1.2));
    const want = Math.round(s.dy * ease(k));
    if (want !== s.done) { await page.evaluate(({ sel, d }) => { const el = document.querySelector(sel); if (el) el.scrollTop += d; }, { sel: s.sel, d: want - s.done }); s.done = want; }
  }
  scrolls = scrolls.filter((s) => t - s.from < (s.dur ?? 1.2) + 0.1);
  for (const tw of scene.tweens ?? []) if (t >= tw.from && t <= tw.to + 1e-6) await run(tw.js, { k: ease(Math.min(1, (t - tw.from) / (tw.to - tw.from)), tw.ease ?? 'inOut') });
  // pointer position
  let p = pointer;
  for (const m of moves) if (t >= m.t0 && t <= m.t1) { const k = ease((t - m.t0) / (m.t1 - m.t0)); p = [m.from[0] + (m.to[0] - m.from[0]) * k, m.from[1] + (m.to[1] - m.from[1]) * k]; }
  for (const m of moves) if (t > m.t1) pointer = m.to;
  if (drag) {
    const k = ease(Math.min(1, (t - drag.t0) / drag.dur));
    p = [drag.from[0] + (drag.to[0] - drag.from[0]) * k, drag.from[1] + (drag.to[1] - drag.from[1]) * k];
    await page.mouse.move(p[0], p[1]); mouseAt = p;
    if (k >= 1) { await page.mouse.up(); pointer = p; drag = null; }
  } else if (showCursor && (!mouseAt || Math.hypot(p[0] - mouseAt[0], p[1] - mouseAt[1]) > 0.5)) {
    // the real pointer follows the drawn one, so hover states and hover cards appear as they would
    await page.mouse.move(p[0], p[1]); mouseAt = p;
  }
  const rk = (t - lastClick) / 0.45;
  await page.evaluate(({ x, y, r }) => window.__cursor?.set(x, y, r), { x: p[0], y: p[1], r: rk });
  await setCam(camAt(t));
  // one frame of virtual time without drawing, let the tiles it asked for arrive, then draw it once
  await stepPage(1000 / FPS, false);
  const st = await settle(scene.settleMs ?? spec.settleMs ?? 20000, holdMs); holdMs = 0;
  await stepPage(0, true);
  await page.screenshot({ path: path.join(outDir, 'frames', String(f).padStart(5, '0') + '.jpg'), type: 'jpeg', quality: 92, timeout: 180000 });
  if (f % 30 === 0) log(`frame ${f}/${N}`, `${Math.round((Date.now() - t0) / 1000)} s`, `settle ${st.ms} ms ${st.steps} steps`, JSON.stringify(await stats()));
}
log('done', N, 'frames in', Math.round((Date.now() - t0) / 1000), 's');
await browser.close();
