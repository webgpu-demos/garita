#!/usr/bin/env bash
set -u; date -u
git clone -q --filter=blob:none --no-checkout --single-branch -b gh-pages https://github.com/webgpu-demos/procedural-sanjuan /tmp/site && cd /tmp/site && git sparse-checkout set --no-cone '/*.html' '/assets/' '/audio/' '/models/' '/textures/' '/ortho/hatorey/' '/tiles/areas.json' '/tiles/hatorey/' && git checkout -q 5d961f7 && du -sh /tmp/site && (python3 -m http.server 8080 > /dev/null 2>&1 &) && sleep 2
mkdir -p /tmp/t && cd /tmp/t && npm init -y > /dev/null && npm i -s puppeteer-core@24 > /dev/null 2>&1
cat > tour.mjs <<'JS'
// node tour.mjs <url> <outPrefix> <views.json> [w] [h]
// views: [{ name, cam: [x, z, dist, azDeg, elDeg], hour?, eval? }] — one load, then each view in turn.

import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const [url, out, viewsFile, w = '1280', h = '720'] = process.argv.slice(2);
const views = JSON.parse(fs.readFileSync(viewsFile, 'utf8'));
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader', `--window-size=${w},${h}`], defaultViewport: { width: +w, height: +h }, headless: true, protocolTimeout: 900000 });
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: 'load', timeout: 300000 });
await page.waitForFunction(() => window.__app && document.getElementById('loader')?.classList.contains('done'), { timeout: 600000, polling: 2000 });
console.log('loaded');
for (const v of views) {
  const r = await page.evaluate(async (v) => {
    const a = window.__app, T = window.__THREE_VEC;
    if (v.hour != null) { a.clockTime.live = false; a.clockTime.hour = v.hour; }
    if (v.cam) {
      const [x, z, d, az, el] = v.cam, g = a.streamer.ground(x, z), azr = az * Math.PI / 180, elr = el * Math.PI / 180;
      a.controls.target.set(x, g, z);
      a.camera.position.set(x + d * Math.cos(elr) * Math.sin(azr), g + d * Math.sin(elr), z + d * Math.cos(elr) * Math.cos(azr));
      a.camera.lookAt(a.controls.target); a.controls.update();
    }
    const t0 = performance.now(); let quiet = 0;
    while (performance.now() - t0 < 240000) { await new Promise((r) => requestAnimationFrame(r)); quiet = a.streamer.pending === 0 ? quiet + 1 : 0; if (quiet > 30) break; }
    let extra = null;
    if (v.eval) extra = await (0, eval)(v.eval);
    return { waited: Math.round(performance.now() - t0), loaded: a.streamer.stats.loaded, extra };
  }, v);
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: `${out}_${v.name}.png` });
  console.log(v.name, JSON.stringify(r).slice(0, 600));
}
console.log(logs.filter((l) => !/DevTools|GPU stall|swiftshader|WebGL-0x|ERR_TUNNEL|Clock: This module/i.test(l)).slice(0, 30).join('\n'));
await browser.close();
JS
cat > views.json <<'JS'
[{"name":"golden","cam":[201,-44,300,330,25]},
 {"name":"expressway","cam":[-116,177,200,60,18]},
 {"name":"golden_low","cam":[201,-44,120,150,10]}]
JS
timeout 840 node tour.mjs 'http://localhost:8080/?area=hatorey&xp=0' "$OUT/old_hato" views.json 1280 720 2>&1 | tail -40
date -u
