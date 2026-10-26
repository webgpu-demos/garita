#!/usr/bin/env bash
# Garita branch building-ids: the vector build without NFHL (dev run, nothing published): ids, USA Structures heights.
set -u
date -u
git clone -q --depth 1 --branch building-ids https://github.com/webgpu-demos/garita g && cd g
(cd pipeline/vector && npm install --no-audit --no-fund > /dev/null 2>&1); echo "deps $(date -u +%T)"
export WORK_DIR=$PWD/work OUT_DIR=$PWD/vout SITE_DIR=$PWD/site
mkdir -p "$WORK_DIR/cache" "$OUT_DIR" "$SITE_DIR/data/geo"
for f in municipios.geojson municipios_land.geojson; do curl -fsSL -o "$SITE_DIR/data/geo/$f" "https://raw.githubusercontent.com/webgpu-demos/garita/gh-pages/data/geo/$f"; done
ls -l "$SITE_DIR/data/geo"
bash pipeline/vector/stage2_osm.sh > "$OUT/stage2.txt" 2>&1; echo "stage2 $? $(date -u +%T)"
bash pipeline/vector/stage2b_overture.sh > "$OUT/stage2b.txt" 2>&1; echo "stage2b $? $(date -u +%T)"; tail -3 "$OUT/stage2b.txt" | cut -c1-300; wc -l work/overture/osm_gers.csv; head -2 work/overture/osm_gers.csv
bash pipeline/vector/stage2c_structures.sh > "$OUT/stage2c.txt" 2>&1; echo "stage2c $? $(date -u +%T)"; tail -4 "$OUT/stage2c.txt" | cut -c1-400
NO_FLOOD=1 node --max-old-space-size=12000 pipeline/vector/build.mjs > "$OUT/build.txt" 2>&1; echo "build $? $(date -u +%T)"
grep -E "^.{0,12}(ids|heights|buildings|elevation|tiles written)" "$OUT/build.txt" | cut -c1-700
cp "$OUT_DIR/data/derived/qa.json" "$OUT/qa.json" 2>/dev/null; cp "$OUT_DIR/tiles/bld/index.json" "$OUT/bld_index.json" 2>/dev/null
python3 -c "import json; q=json.load(open('$OUT/qa.json')); print(json.dumps({'ids': q.get('ids'), 'heights': q.get('heights'), 'total': q['buildings']['total']}, indent=1))"
# San Juan's tiles (x 5180-5189 at z14), bins and ids, for checking the client
tar czf "$OUT/sj_tiles.tgz" -C "$OUT_DIR" tiles/bld/14/5184 tiles/bld/14/5185 tiles/bld/index.json; ls -l "$OUT/sj_tiles.tgz"
f=$(ls "$OUT_DIR"/tiles/bld/14/5185/*.ids | head -1); echo "$f"; head -5 "$f"
# height sources in San Juan's tiles
cat "$OUT_DIR"/tiles/bld/14/518*/*.ids | awk -F, '{n[$3]++; t++} END {for (k in n) printf "%-8s %d (%.1f%%)\n", (k==""?"none":k), n[k], 100*n[k]/t}'
date -u
echo "GERS in San Juan's tiles:"; cat "$OUT_DIR"/tiles/bld/14/518*/*.ids | awk -F, '{t++; if ($1 != "") g++} END {printf "%d of %d (%.1f%%)\n", g, t, 100*g/t}'
grep -m3 "additions" "$OUT/build.txt" | cut -c1-400
