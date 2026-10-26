#!/usr/bin/env bash
set -u; date -u; mkdir -p /tmp/t && cd /tmp/t && npm init -y > /dev/null && npm i -s puppeteer-core@24 > /dev/null 2>&1
cat > tour.mjs <<'JS'
// node tour.mjs <url> <outPrefix> <views.json> [w] [h]
// views: [{ name, cam?: [x, z, dist, azDeg, elDeg], hour?, click?: "button text", keys?: ["2", ...], hold?: {key, ms},
//           wait?: ms, eval?: "js", noquiet?: true }] — one load, then each step in turn, a screenshot after each.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const [url, out, viewsFile, w = '1280', h = '720'] = process.argv.slice(2);
const views = JSON.parse(fs.readFileSync(viewsFile, 'utf8'));
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader', `--window-size=${w},${h}`, '--autoplay-policy=no-user-gesture-required'], defaultViewport: { width: +w, height: +h }, headless: true, protocolTimeout: 900000 });
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('response', (r) => { if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url()}`); });
page.on('requestfailed', (r) => logs.push(`[failed] ${r.url()} ${r.failure()?.errorText}`));
const t0 = Date.now();
await page.goto(url, { waitUntil: 'load', timeout: 300000 });
await page.waitForFunction(() => window.__app && document.getElementById('loader')?.classList.contains('done'), { timeout: 600000, polling: 2000 });
console.log('loaded', Math.round((Date.now() - t0) / 1000), 's');
const quiet = () => page.evaluate(async () => {
  const a = window.__app, t = performance.now(); let q = 0;
  while (performance.now() - t < 180000) { await new Promise((r) => requestAnimationFrame(r)); q = a.streamer.pending === 0 ? q + 1 : 0; if (q > 30) break; }
  return Math.round(performance.now() - t);
});
for (const v of views) {
  try {
    if (v.click) {
      const ok = await page.evaluate((txt) => { const b = [...document.querySelectorAll('button, a, [role=button]')].find((e) => e.offsetParent && e.textContent.trim().includes(txt)); if (b) { b.click(); return b.textContent.trim().slice(0, 60); } return null; }, v.click);
      console.log(`  click "${v.click}": ${ok}`);
    }
    for (const k of v.keys ?? []) { await page.keyboard.press(k); await new Promise((r) => setTimeout(r, 300)); }
    if (v.hold) { await page.keyboard.down(v.hold.key); await new Promise((r) => setTimeout(r, v.hold.ms)); await page.keyboard.up(v.hold.key); }
    const r = await page.evaluate(async (v) => {
      const a = window.__app;
      if (v.hour != null) { a.clockTime.live = false; a.clockTime.hour = v.hour; }
      if (v.cam) {
        const [x, z, d, az, el] = v.cam, g = a.streamer.ground(x, z), azr = az * Math.PI / 180, elr = el * Math.PI / 180;
        a.controls.target.set(x, g, z);
        a.camera.position.set(x + d * Math.cos(elr) * Math.sin(azr), g + d * Math.sin(elr), z + d * Math.cos(elr) * Math.cos(azr));
        a.camera.lookAt(a.controls.target); a.controls.update();
      }
      return v.eval ? await (0, eval)(v.eval) : null;
    }, v);
    if (v.wait) await new Promise((r) => setTimeout(r, v.wait));
    const waited = v.noquiet ? 0 : await quiet();
    await new Promise((r) => setTimeout(r, 1500));
    await page.screenshot({ path: `${out}_${v.name}.png` });
    const st = await page.evaluate(() => ({ mode: window.__app.mode, loaded: window.__app.streamer.stats.loaded, cam: window.__app.camera.position.toArray().map((x) => Math.round(x)), hud: document.getElementById('hud')?.innerText.split('\n').slice(0, 4).join(' | ') }));
    console.log(v.name, JSON.stringify({ waited, r, ...st }).slice(0, 700));
  } catch (e) { console.log(v.name, 'FAILED', e.message.slice(0, 200)); }
}
console.log([...new Set(logs.filter((l) => !/DevTools|GPU stall|swiftshader|WebGL-0x|Clock: This module|Automatic fallback/i.test(l)))].slice(0, 40).join('\n'));
await browser.close();
JS
cat > views.json <<'JS'
[{"name":"title","noquiet":true},
 {"name":"explore","click":"Explorar libremente","wait":8000},
 {"name":"walk","keys":["2"],"wait":5000},
 {"name":"walk_fwd","hold":{"key":"w","ms":3000},"wait":1000},
 {"name":"drive","keys":["4"],"wait":5000},
 {"name":"drive_fwd","hold":{"key":"w","ms":4000},"wait":1000},
 {"name":"fly","keys":["5"],"wait":5000},
 {"name":"fly_fwd","hold":{"key":"w","ms":3000},"wait":1000}]
JS
timeout 960 node tour.mjs 'https://webgpu-demos.github.io/procedural-sanjuan/' "$OUT/live_sjex" views.json 1280 720 2>&1 | tail -40
date -u
