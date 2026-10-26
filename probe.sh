#!/usr/bin/env bash
# procedural-sanjuan, branch synthetic: compile Condado, serve it, export synthetic drone frames with labels
# (tools/synth/export.mjs, the runner's Chrome, no GPU), pack the dataset.
set -u
date -u
git clone -q --depth 1 --branch synthetic https://github.com/webgpu-demos/procedural-sanjuan psj && cd psj
npm ci --no-audit --no-fund > /dev/null 2>&1; echo "npm ci $(date -u +%T)"
npm test 2>&1 | tail -4
node tools/assets/fetch_textures.mjs > /tmp/tex.txt 2>&1; echo "textures exit $? $(du -sh public/textures | cut -f1)"
node --max-old-space-size=4096 tools/pipeline/fetch.mjs --area=condado --no-garita > /tmp/fetch.txt 2>&1; echo "fetch exit $?"
node --max-old-space-size=6144 tools/pipeline/compile.mjs --area=condado > /tmp/compile.txt 2>&1; echo "compile exit $? $(date -u +%T)"
(npx vite --port 5173 > /tmp/vite.txt 2>&1 &) ; sleep 6
CH=$(command -v google-chrome || command -v chromium || command -v chromium-browser); echo "chrome $CH $($CH --version 2>/dev/null)"
nproc; free -g | head -2
timeout 780 node tools/synth/export.mjs --url=http://localhost:5173/ --area=condado --frames=${FRAMES:-14} --size=640x480 --damage=0.5 --alt=45,90 --out="$OUT/syn" --chrome="$CH" --timeout=300 2>&1 | tail -30
echo "export $(date -u +%T)"
ls "$OUT/syn" "$OUT/syn/images/train" | head; du -sh "$OUT/syn"
cat "$OUT/syn/run.json" 2>/dev/null | head -c 600
date -u
