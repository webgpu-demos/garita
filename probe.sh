#!/usr/bin/env bash
# procedural-sanjuan, branch lidar-terrain: fetch and compile Condado with and without the 1 m lidar; compare the terrain.
set -u
date -u
git clone -q --depth 1 --branch lidar-terrain https://github.com/webgpu-demos/procedural-sanjuan psj && cd psj
npm ci --no-audit --no-fund > /dev/null 2>&1; echo "npm ci done $(date -u +%T)"
node --max-old-space-size=4096 tools/pipeline/fetch.mjs --area=condado > "$OUT/fetch.txt" 2>&1; echo "fetch exit $? $(date -u +%T)"; tail -15 "$OUT/fetch.txt"
ls -l data/raw/condado/dem/lidar 2>&1
node tools/tests/lidar.test.mjs
mv data/raw/condado/dem/lidar /tmp/lidar_off
node --max-old-space-size=6144 tools/pipeline/compile.mjs --area=condado > "$OUT/compile_terrarium.txt" 2>&1; echo "compile (terrain tiles) exit $?"
cp public/tiles/condado/terrain.bin /tmp/t_before.bin; cp public/tiles/condado/manifest.json "$OUT/manifest_before.json"
mv /tmp/lidar_off data/raw/condado/dem/lidar
node --max-old-space-size=6144 tools/pipeline/compile.mjs --area=condado > "$OUT/compile_lidar.txt" 2>&1; echo "compile (lidar) exit $? $(date -u +%T)"
cp public/tiles/condado/terrain.bin /tmp/t_after.bin; cp public/tiles/condado/manifest.json "$OUT/manifest_after.json"
grep -E "terrain|lidar" "$OUT/compile_terrarium.txt" | head -5; echo; grep -E "terrain|lidar" "$OUT/compile_lidar.txt" | head -8
echo "(tests ran in the first run)"
cat > tools/shade_tmp.mjs <<'JS'
import fs from 'node:fs';
import { PNG } from 'pngjs';
const [man, a, b, out] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(man, 'utf8')).terrain, w = m.w, h = m.h, step = m.step;
const A = new Float32Array(fs.readFileSync(a).buffer.slice(0)), B = new Float32Array(fs.readFileSync(b).buffer.slice(0));
const shade = (d, x, y) => {
  const at = (i, j) => d[Math.min(h - 1, Math.max(0, j)) * w + Math.min(w - 1, Math.max(0, i))];
  const dx = (at(x + 1, y) - at(x - 1, y)) / (2 * step) * 3, dz = (at(x, y + 1) - at(x, y - 1)) / (2 * step) * 3; // (x3 vertical exaggeration)
  const nx = -dx, ny = 1, nz = -dz, l = Math.hypot(nx, ny, nz), L = [-0.5, 0.7, -0.5], ll = Math.hypot(...L);
  return Math.max(0, (nx * L[0] + ny * L[1] + nz * L[2]) / (l * ll));
};
const png = new PNG({ width: w * 3 + 8, height: h });
png.data.fill(255);
let sum = 0, n = 0, big = 0; const hist = {};
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const k = y * w + x, put = (ox, r, g, bl) => { const p = (y * png.width + x + ox) * 4; png.data[p] = r; png.data[p + 1] = g; png.data[p + 2] = bl; png.data[p + 3] = 255; };
  const sea = A[k] < 0.25;
  const s1 = shade(A, x, y), s2 = shade(B, x, y);
  put(0, ...(sea ? [60, 90, 130] : [s1 * 255, s1 * 255, s1 * 240]));
  put(w + 4, ...(B[k] < 0.25 ? [60, 90, 130] : [s2 * 255, s2 * 255, s2 * 240]));
  const d = B[k] - A[k];
  if (!sea) { sum += Math.abs(d); n++; if (Math.abs(d) > 2) big++; const bkt = Math.max(-5, Math.min(5, Math.round(d))); hist[bkt] = (hist[bkt] || 0) + 1; }
  const t = Math.min(1, Math.abs(d) / 3);
  put(2 * w + 8, ...(d > 0 ? [255, 255 * (1 - t), 255 * (1 - t)] : [255 * (1 - t), 255 * (1 - t), 255]));
}
fs.writeFileSync(out, PNG.sync.write(png));
// a north-south line through the middle: the heights every 25 m
const mid = Math.floor(w / 2), prof = [];
for (let y = 0; y < h; y += Math.round(25 / step)) prof.push([+(m.z0 + y * step).toFixed(0), +A[y * w + mid].toFixed(2), +B[y * w + mid].toFixed(2)]);
console.log(JSON.stringify({ w, h, step, landCells: n, meanAbsDiff: +(sum / n).toFixed(2), over2m: big, hist, profileZ_before_after: prof }));
JS
node tools/shade_tmp.mjs public/tiles/condado/manifest.json /tmp/t_before.bin /tmp/t_after.bin "$OUT/hillshade_before_after_diff.png"
date -u
