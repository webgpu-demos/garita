#!/usr/bin/env bash
# procedural-sanjuan main: compile Condado and Hato Rey with the 1 m lidar terrain and Garita's live ids and heights;
# packs the compiled areas.
set -u
date -u
git clone -q --depth 1 https://github.com/webgpu-demos/procedural-sanjuan psj && cd psj && git log --oneline -1
npm ci --no-audit --no-fund > /dev/null 2>&1; npm test 2>&1 | tail -2
for a in condado hatorey; do
  node --max-old-space-size=4096 tools/pipeline/fetch.mjs --area=$a > /tmp/fetch_$a.txt 2>&1; echo "fetch $a exit $?"; grep -iE "garita|lidar" /tmp/fetch_$a.txt | tail -3
  node --max-old-space-size=6144 tools/pipeline/compile.mjs --area=$a > "$OUT/compile_$a.txt" 2>&1; echo "compile $a exit $?"; grep -iE "garita|gers|heights from|lidar:|buildings:" "$OUT/compile_$a.txt"
  (cd public/tiles && tar czf "$OUT/tiles_$a.tgz" $a); ls -l "$OUT/tiles_$a.tgz"
done
date -u
