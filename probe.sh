#!/usr/bin/env bash
# D24 point-cloud tiles (prd-tnm LPC): count, sizes, one San Juan tile's density and classes; 2018 EPT metadata.
set -u
date -u
B=https://prd-tnm.s3.amazonaws.com/
python3 - <<'PY'
import urllib.request, re, json, collections
B = 'https://prd-tnm.s3.amazonaws.com/'
tot = collections.Counter(); size = collections.Counter(); sample = {}
for sub in range(1, 7):
    pre = f'StagedProducts/Elevation/LPC/Projects/PR_PuertoRicoUSVI_D24/PR_PuertoRicoUSVI_{sub}_D24/'
    tok = None
    while True:
        u = B + '?list-type=2&prefix=' + urllib.parse.quote(pre) + ('&continuation-token=' + urllib.parse.quote(tok) if tok else '')
        x = urllib.request.urlopen(u, timeout=120).read().decode()
        for k, s in re.findall(r'<Key>([^<]+)</Key>.*?<Size>(\d+)</Size>', x, re.S):
            ext = k.rsplit('.', 1)[-1].lower(); tot[(sub, ext)] += 1; size[(sub, ext)] += int(s)
            if ext == 'laz': sample.setdefault(sub, []).append(k)
        m = re.search(r'<NextContinuationToken>([^<]+)', x)
        if not m: break
        tok = m.group(1)
for (sub, ext), n in sorted(tot.items()): print(sub, ext, n, round(size[(sub, ext)] / 1e9, 1), 'GB')
for sub, ks in sample.items(): print(sub, ks[:2], ks[-1:])
json.dump({str(k): v for k, v in sample.items()}, open('/tmp/laz_keys.json', 'w'))
PY
# a tile over San Juan: names carry the grid; find one containing (805781, 2042973) in UTM 19N
python3 - <<'PY'
import json, re
d = json.load(open('/tmp/laz_keys.json'))
keys = [k for v in d.values() for k in v]
print(len(keys), 'laz keys'); print([k.split('/')[-1] for k in keys[:5]])
cand = [k for k in keys if re.search(r'19(PH|ph)?_?\D*8050|x80|805', k)]
print('candidates', [c.split('/')[-1] for c in cand[:10]])
open('/tmp/pick.txt', 'w').write((cand or keys)[0])
PY
python3 -m pip install -q "laspy[lazrs]" numpy 2>&1 | tail -1
K=$(cat /tmp/pick.txt); echo "tile $K"
T0=$(date +%s); curl -sS -m 600 -o /tmp/t.laz "$B$K"; echo "download $(( $(date +%s) - T0 )) s $(stat -c %s /tmp/t.laz)"
python3 - <<'PY'
import laspy, numpy as np, collections
f = laspy.read('/tmp/t.laz')
h = f.header
print('points', h.point_count, 'scale', h.scales, 'offset', h.offsets, 'mins', h.mins, 'maxs', h.maxs)
print('crs', h.parse_crs())
area = (h.maxs[0] - h.mins[0]) * (h.maxs[1] - h.mins[1]); print('density pts/m2', round(h.point_count / area, 1))
c = np.asarray(f.classification); print('classes', sorted(collections.Counter(c.tolist()).items()))
print('returns', sorted(collections.Counter(np.asarray(f.return_number).tolist()).items())[:5])
PY
for ept in USGS_LPC_PR_PRVI_A_2018 USGS_LPC_PR_PRVI_D_2018; do
  echo "== ept $ept"; curl -sS -m 60 "https://s3-us-west-2.amazonaws.com/usgs-lidar-public/$ept/ept.json" | python3 -c "import json,sys; d=json.load(sys.stdin); print({k: d[k] for k in ('bounds','points','span','dataType')}, [s['name'] for s in d['schema']], d['srs'].get('horizontal'), d['srs'].get('vertical'))"
done
date -u
