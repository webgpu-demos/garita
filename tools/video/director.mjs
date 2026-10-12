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
//               { t, key: "Enter" }]
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
const url = base + scene.url + (scene.url.includes('?') ? '&' : '?') + `shot=1&scale=${scene.renderScale ?? spec.renderScale ?? 0.67}`;
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

const stepPage = (dt) => page.evaluate((d) => window.__vt.step(d), dt);
const stats = () => page.evaluate(() => {
  const g = window.__garita, s = g?.state, t = g?.world?.terrain?.stats?.() ?? { tiles: 0, pending: 1 };
  return { booted: !!s?.booted?.value, ready: !!g?.ready, tiles: t.tiles, pending: t.pending, maxZoom: t.maxZoom };
});
/** Draw frames without moving time until nothing is waiting to load (or the budget runs out). */
async function settle(budgetMs, needQuiet = 3) {
  const t0 = Date.now(); let quiet = 0, n = 0;
  while (Date.now() - t0 < budgetMs) {
    await stepPage(0); n++;
    const s = await stats();
    quiet = s.pending === 0 && s.tiles > 0 ? quiet + 1 : 0;
    if (quiet >= needQuiet) break;
    await new Promise((r) => setTimeout(r, 40));
  }
  return { ms: Date.now() - t0, frames: n };
}

log('scene', scene.id, url, `${N} frames at ${FPS} fps`);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
// boot: let virtual time run (the curtain, the store, the first tiles), then wait for the view to settle
{
  const t0 = Date.now(); let i = 0;
  while (Date.now() - t0 < 240000) {
    await stepPage(33); i++;
    if (i % 10 === 0) { const s = await stats(); if (s.booted && s.tiles > 0 && s.pending === 0 && i > 90) break; }
    await new Promise((r) => setTimeout(r, 15));
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
log('settled', JSON.stringify(await settle(90000, 6)));

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
  if (a.click) { const box = await page.locator(a.click).first().boundingBox({ timeout: 5000 }).catch(() => null); return box && [box.x + box.width / 2, box.y + box.height / 2]; }
  if (a.clickjs) {
    const h = await page.evaluateHandle(({ code }) => { const g = window.__garita; return new Function('S', 'W', 'G', code)(g.state, g.world, g); }, { code: a.clickjs });
    const el = h.asElement(); const box = el && (await el.boundingBox()); return box && [box.x + box.width / 2, box.y + box.height / 2];
  }
  if (a.point) return a.point;
  return null;
}
// pointer moves start `move` seconds before each click; targets are looked up when the move starts
const pending = actions.filter((a) => a.click || a.clickjs || a.point);
let typing = null, scrolls = [];
const t0 = Date.now();
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
      if ((a.click || a.clickjs) && a.to) { await page.mouse.click(a.to[0], a.to[1]); lastClick = t; pointer = a.to; }
      else if (a.point && a.to) { await page.mouse.move(a.to[0], a.to[1]); pointer = a.to; }
      if (a.js) await run(a.js);
      if (a.type) typing = { text: a.type, i: 0, next: t, dt: 1 / (a.cps ?? 14) };
      if (a.key) await page.keyboard.press(a.key);
      if (a.scroll) scrolls.push({ ...a.scroll, from: t, start: null, done: 0 });
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
  const rk = (t - lastClick) / 0.45;
  await page.evaluate(({ x, y, r }) => window.__cursor?.set(x, y, r), { x: p[0], y: p[1], r: rk });
  await setCam(camAt(t));
  // one frame of virtual time, then let the tiles it asked for arrive
  await stepPage(1000 / FPS);
  const st = await settle(scene.settleMs ?? spec.settleMs ?? 2500, 1);
  await page.screenshot({ path: path.join(outDir, 'frames', String(f).padStart(5, '0') + '.jpg'), type: 'jpeg', quality: 92 });
  if (f % 30 === 0) log(`frame ${f}/${N}`, `${Math.round((Date.now() - t0) / 1000)} s`, `settle ${st.ms} ms`, JSON.stringify(await stats()));
}
log('done', N, 'frames in', Math.round((Date.now() - t0) / 1000), 's');
await browser.close();
