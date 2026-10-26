#!/usr/bin/env bash
# San Juan's height grid (published terrain.bin) with the 1 m lidar DEM applied, as procedural-sanjuan's compiler
# would: returns terrain_lidar.bin and the stats.
set -u
date -u
git clone -q --depth 1 https://github.com/webgpu-demos/procedural-sanjuan psj && cd psj && git log --oneline -1
npm ci --no-audit --no-fund > /dev/null 2>&1
mkdir -p /tmp/sj && for f in manifest.json terrain.bin; do curl -sfL -o /tmp/sj/$f "https://raw.githubusercontent.com/webgpu-demos/procedural-sanjuan/gh-pages/tiles/sanjuan/$f" || echo "no $f"; done; ls -l /tmp/sj
cat > /tmp/lidar_sj.mjs <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import { LIDAR, tilesFor, applyLidar } from './tools/pipeline/lidar.mjs';
import { resolveArea } from './tools/pipeline/config.mjs';
import { makeProjection } from './src/shared/geo.js';
const area = resolveArea(['--area=sanjuan']);
const dir = path.join(area.rawDir, 'dem', 'lidar'); fs.mkdirSync(dir, { recursive: true });
const keys = [];
let token = null;
do {
  const q = new URLSearchParams({ 'list-type': '2', prefix: `${LIDAR.prefix}${LIDAR.projects[0]}/TIFF/` });
  if (token) q.set('continuation-token', token);
  const xml = await (await fetch(`${LIDAR.bucket}?${q}`)).text();
  for (const m of xml.matchAll(/<Key>([^<]+\.tif)<\/Key>/g)) keys.push(m[1]);
  token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (/<NextContinuationToken>([^<]+)</.exec(xml)?.[1] ?? null) : null;
} while (token);
const m = 0.01, b = area.bbox, want = tilesFor(keys, { west: b.west - m, south: b.south - m, east: b.east + m, north: b.north + m });
console.log(`lidar: ${keys.length} listed, ${want.length} under San Juan`);
await Promise.all(want.map(async (t, i) => {
  await new Promise((r) => setTimeout(r, i * 500));
  const res = await fetch(LIDAR.bucket + t.key); const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(path.join(dir, t.name), buf); console.log(`  ${t.name} ${(buf.length / 1e6).toFixed(0)} MB`);
}));
const man = JSON.parse(fs.readFileSync('/tmp/sj/manifest.json')), t = man.terrain;
const data = new Float32Array(fs.readFileSync('/tmp/sj/terrain.bin').buffer.slice(0));
const grid = { x0: t.x0, z0: t.z0, step: t.step, w: t.w, h: t.h, data };
const proj = makeProjection(man.origin.lon, man.origin.lat);
const stats = await applyLidar(grid, dir, proj, console.log);
console.log(JSON.stringify(stats));
fs.writeFileSync(process.env.OUT + '/terrain_lidar.bin', Buffer.from(grid.data.buffer));
fs.writeFileSync(process.env.OUT + '/lidar_stats.json', JSON.stringify({ ...stats, project: LIDAR.projects[0], tiles: want.map((x) => x.name) }));
JS
cp /tmp/lidar_sj.mjs ./lidar_sj.mjs && node --max-old-space-size=8192 lidar_sj.mjs 2>&1 | tail -20
ls -l "$OUT"
date -u
