#!/usr/bin/env bash
# D24 virtual point cloud (where are the points?), and a small PDAL read of the 2018 EPT over Condado: classes, density.
set -u
date -u
B=https://prd-tnm.s3.amazonaws.com/
P=StagedProducts/Elevation/LPC/Projects/PR_PuertoRicoUSVI_D24/PR_PuertoRicoUSVI_4_D24/
K=$(curl -sS -m 60 "$B?list-type=2&prefix=$P" | grep -o '<Key>[^<]*\.vpc</Key>' | sed 's/<[^>]*>//g' | head -1); echo "vpc $K"
curl -sS -m 120 -o /tmp/v.vpc "$B$K"; ls -l /tmp/v.vpc; head -c 1500 /tmp/v.vpc; echo
python3 - <<'PY'
import json
v = json.load(open('/tmp/v.vpc'))
feats = v.get('features', [])
print('features', len(feats))
if feats:
    f = feats[0]; print(json.dumps({k: f[k] for k in f if k != 'geometry'}, indent=0)[:1500])
    hrefs = [a.get('href') for f in feats for a in f.get('assets', {}).values()]
    print('hrefs sample', hrefs[:3])
PY
X=$(curl -sS -m 60 "$B?list-type=2&prefix=$P&max-keys=5" | grep -o '<Key>[^<]*\.xml</Key>' | sed 's/<[^>]*>//g' | head -1); echo "xml $X"
curl -sS -m 60 "$B$X" | grep -iE "laz|copc|href|onlink|http" | head -10
echo "== PDAL"
T0=$(date +%s); (sudo apt-get update -qq && sudo apt-get install -y -qq pdal) > /dev/null 2>&1; echo "apt $(( $(date +%s) - T0 )) s"; pdal --version | head -2
# Condado, 300 m square, EPSG:3857: lon -66.0705 lat 18.4563
python3 - <<'PY'
import math, json
lon, lat = -66.0705, 18.4563
x = lon * 20037508.34 / 180; y = math.log(math.tan((90 + lat) * math.pi / 360)) / (math.pi / 180) * 20037508.34 / 180
b = f"([{x-150:.1f}, {x+150:.1f}], [{y-150:.1f}, {y+150:.1f}])"
for wu in ['USGS_LPC_PR_PRVI_D_2018', 'USGS_LPC_PR_PRVI_A_2018', 'USGS_LPC_PR_PuertoRico_2015_LAS_2018']:
    json.dump({"pipeline": [{"type": "readers.ept", "filename": f"https://s3-us-west-2.amazonaws.com/usgs-lidar-public/{wu}/ept.json", "bounds": b}, {"type": "writers.las", "filename": f"/tmp/{wu}.laz", "compression": "laszip"}]}, open(f'/tmp/{wu}.json', 'w'))
print(b)
PY
python3 -m pip install -q "laspy[lazrs]" numpy 2>&1 | tail -1
for wu in USGS_LPC_PR_PRVI_D_2018 USGS_LPC_PR_PRVI_A_2018 USGS_LPC_PR_PuertoRico_2015_LAS_2018; do
  T0=$(date +%s); timeout 300 pdal pipeline /tmp/$wu.json 2>&1 | tail -2; echo "$wu read $(( $(date +%s) - T0 )) s"
  [ -s /tmp/$wu.laz ] && python3 - "$wu" <<'PY'
import laspy, numpy as np, collections, sys
f = laspy.read(f'/tmp/{sys.argv[1]}.laz')
print('points', len(f.x), 'density /m2', round(len(f.x) / 90000, 1), 'classes', sorted(collections.Counter(np.asarray(f.classification).tolist()).items()), 'z', float(np.min(f.z)), float(np.max(f.z)))
PY
done
date -u
