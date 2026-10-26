#!/usr/bin/env bash
# procedural-sanjuan: the raw inputs of Condado and Hato Rey (OSM buildings, FEMA structures), packed; OSM history of a few ways
set -u
date -u
git clone -q --depth 1 https://github.com/webgpu-demos/procedural-sanjuan psj && cd psj && git log --oneline -1
npm ci --no-audit --no-fund > /dev/null 2>&1
for a in condado hatorey; do
  timeout 600 node --max-old-space-size=4096 tools/pipeline/fetch.mjs --area=$a --no-lidar --no-garita > /tmp/fetch_$a.txt 2>&1; echo "fetch $a exit $?"; tail -3 /tmp/fetch_$a.txt
  ls -la data/raw/$a | head -30
  (cd data/raw/$a && tar czf "$OUT/raw_$a.tgz" osm_buildings.json fema_structures.json 2>/dev/null); ls -l "$OUT/raw_$a.tgz"
  python3 - "$a" <<'P'
import json, sys, collections
d = json.load(open(f'data/raw/{sys.argv[1]}/fema_structures.json'))
f = d['features']; print('fema', len(f), 'sample', f[0]['properties'] if f else None)
print(collections.Counter(x['properties'].get('OCC_CLS') for x in f).most_common(10))
print(collections.Counter(x['properties'].get('PRIM_OCC') for x in f).most_common(15))
P
done
for w in 275267363 279474364 279483342 381416330 944487477 61108930 301866453; do
  echo "== way $w"; curl -s -A 'procedural-sanjuan-probe' "https://api.openstreetmap.org/api/0.6/way/$w/history" | grep -oE '<way [^>]*version="[0-9]+"[^>]*timestamp="[^"]*"|<tag k="[^"]*" v="[^"]*"' | sed -E 's/<way .*version="([0-9]+)".*timestamp="([^"]*)".*/v\1 \2/; s/<tag k="([^"]*)" v="([^"]*)"/  \1=\2/' | tail -40
done
date -u
