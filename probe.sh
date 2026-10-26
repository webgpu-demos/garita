#!/usr/bin/env bash
# procedural-sanjuan fix-heights-and-areas: compile Condado and Hato Rey with Garita's re-folded tiles (from git, not the CDN)
set -u
date -u
git clone -q --filter=blob:none --no-checkout --single-branch -b gh-pages https://github.com/webgpu-demos/garita /tmp/garita && (cd /tmp/garita && git sparse-checkout set tiles/bld && git checkout -q && git log --oneline -1)
git clone -q --depth 1 -b fix-heights-and-areas https://github.com/webgpu-demos/procedural-sanjuan psj && cd psj && git log --oneline -1
npm ci --no-audit --no-fund > /dev/null 2>&1; npm test 2>&1 | tail -2
for a in condado hatorey; do
  node --max-old-space-size=4096 tools/pipeline/fetch.mjs --area=$a --garita=/tmp/garita > /tmp/fetch_$a.txt 2>&1; echo "fetch $a exit $?"; grep -iE "garita|lidar" /tmp/fetch_$a.txt | tail -3
  node --max-old-space-size=6144 tools/pipeline/compile.mjs --area=$a > "$OUT/compile_$a.txt" 2>&1; echo "compile $a exit $?"; grep -iE "garita|gers|heights from|lidar:|buildings:|usage codes" "$OUT/compile_$a.txt"
  (cd public/tiles && tar czf "$OUT/tiles_$a.tgz" $a); ls -l "$OUT/tiles_$a.tgz"
  (cd data/raw/$a && tar czf "$OUT/raw_$a.tgz" osm_poi.json 2>/dev/null)
done
date -u
