#!/usr/bin/env bash
# The live sites after the deploy: key files, and Garita's building card for a building with a measured height.
set -u
G=https://webgpu-demos.github.io/garita; P=https://webgpu-demos.github.io/procedural-sanjuan
for u in "$G/" "$G/data/manifest.json" "$G/tiles/bld/14/5184/7339.ids" "$G/data/hazards/heights/meta.json" "$P/" "$P/tiles/sanjuan/t_-1_-1.ids" "$P/tiles/condado/manifest.json"; do
  printf '%s %s\n' "$(curl -s -o /dev/null -w '%{http_code}' "$u")" "$u"; done
curl -s "$G/" | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'; curl -s "$P/" | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
curl -s "$G/data/manifest.json"; curl -s "$G/tiles/bld/14/5184/7339.ids" | head -2
curl -s "$P/tiles/condado/manifest.json" | python3 -c "import json,sys; m=json.load(sys.stdin); print('condado', m['compiled'], sum(1 for t in m['tiles'] if t.get('ids')), m['attribution'][-2:])"
mkdir -p /tmp/pp && cd /tmp/pp && npm init -y > /dev/null && npm i -s puppeteer-core@24 > /dev/null 2>&1
cat > check.mjs <<'JS'
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1200,700'], defaultViewport: { width: 1200, height: 700 } });
const p = await b.newPage(); const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
await p.goto(process.argv[2], { waitUntil: 'load', timeout: 300000 });
await p.waitForFunction(() => globalThis.__garita?.ready, { timeout: 300000, polling: 2000 });
const r = await p.evaluate(async () => {
  const S = globalThis.__garita.state;
  for (let i = 0; i < 120 && !(S.pinnedBuilding.value && document.querySelector('.bcard')); i++) await new Promise((r) => setTimeout(r, 1000));
  await new Promise((r) => setTimeout(r, 2000));
  const c = document.querySelector('.bcard');
  return { pinned: S.pinnedBuilding.value && { gers: S.pinnedBuilding.value.gers, osm: S.pinnedBuilding.value.osm, text: S.pinnedBuilding.value.text }, card: c?.innerText.slice(0, 300), links: [...(c?.querySelectorAll('a') ?? [])].map((a) => a.href) };
});
console.log(JSON.stringify(r, null, 1)); console.log('page errors', errs.slice(0, 5));
await p.screenshot({ path: process.argv[3] }); await b.close();
JS
timeout 600 node check.mjs "$G/?pick=-66.068777,18.456080&bld=2aa6f1c9-a84b-4411-8dd1-715660462ff7&cam=-66.068777,18.456080,500,0,55&lang=en" "$OUT/garita_card.png" 2>&1 | tail -30
