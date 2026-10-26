#!/usr/bin/env bash
# Where do the D24 LAZ files actually live, are they COPC, and which 2018 EPT holds Condado (boundsConforming)?
# Then a 1 km² read at 0.5 m from whichever works, with timing and class counts.
set -u
date -u
S=https://prd-tnm.s3.amazonaws.com
P6=StagedProducts/Elevation/LPC/Projects/PR_PuertoRicoUSVI_D24/PR_PuertoRicoUSVI_6_D24/
echo "== list $P6"
curl -sS -m 60 "$S/?list-type=2&prefix=$P6&delimiter=/&max-keys=20" | python3 -c "
import sys,re; t=sys.stdin.read(); print(re.findall(r'<Prefix>([^<]+)</Prefix>', t)[:20]); print(re.findall(r'<Key>([^<]+)</Key>', t)[:10]); print(t[:300] if 'Error' in t else '')"
for sub in LAZ/ laz/ COPC/ las/; do
  echo "== list $P6$sub"
  curl -sS -m 60 "$S/?list-type=2&prefix=$P6$sub&max-keys=5" | python3 -c "
import sys,re; t=sys.stdin.read(); print(re.findall(r'<Key>([^<]+)</Key>', t)[:5], re.findall(r'<Size>([^<]+)</Size>', t)[:5], re.findall(r'<KeyCount>([^<]+)</KeyCount>', t))"
done
echo "== search for the Condado tile name anywhere under the project"
curl -sS -m 120 "$S/?list-type=2&prefix=StagedProducts/Elevation/LPC/Projects/PR_PuertoRicoUSVI_D24/&max-keys=1000" | python3 -c "
import sys,re; t=sys.stdin.read(); ks=re.findall(r'<Key>([^<]+)</Key>', t); print(len(ks), 'keys'); [print(k) for k in ks if '238000_268000' in k or k.endswith('.vpc') or k.count('/')<=6][:40]"
# micromamba + pdal
T0=$(date +%s)
curl -Ls https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xj -C /tmp bin/micromamba
export MAMBA_ROOT_PREFIX=/tmp/mamba; /tmp/bin/micromamba create -y -q -n pd -c conda-forge pdal python=3.12 numpy pyproj python-pdal > /dev/null 2>&1
P=/tmp/mamba/envs/pd/bin; echo "pdal install $(( $(date +%s) - T0 )) s"
echo "== 2018 EPT conforming bounds vs Condado"
$P/python - <<'PY'
import json, math, urllib.request
lon, lat = -66.0705, 18.4563
x = lon * 20037508.34 / 180; y = math.log(math.tan((90 + lat) * math.pi / 360)) / (math.pi / 180) * 20037508.34 / 180
print('condado 3857', round(x), round(y))
hit = None
for n in 'A C D E F G H'.split():
    u = f'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/USGS_LPC_PR_PRVI_{n}_2018/ept.json'
    try: e = json.load(urllib.request.urlopen(u, timeout=60))
    except Exception as ex: print(n, ex); continue
    b = e.get('boundsConforming')
    inside = b and b[0] <= x <= b[3] and b[1] <= y <= b[4]
    print(n, 'conforming', b, 'points', e['points'], 'IN' if inside else '')
    if inside and not hit: hit = n
open('/tmp/hit.txt', 'w').write(hit or '')
for d in ('PuertoRico_2015_LAS_2018', 'PuertoRico_2016_LAS_2017'):
    u = f'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/USGS_LPC_PR_{d}/ept.json'
    try: e = json.load(urllib.request.urlopen(u, timeout=60)); print(d, e.get('boundsConforming'), e['points'])
    except Exception as ex: print(d, ex)
b = f"([{x-500:.1f}, {x+500:.1f}], [{y-500:.1f}, {y+500:.1f}])"
for res, name in ((0.5, 'r05'), (1.0, 'r10')):
    json.dump({"pipeline": [{"type": "readers.ept", "filename": f"https://s3-us-west-2.amazonaws.com/usgs-lidar-public/USGS_LPC_PR_PRVI_{hit}_2018/ept.json", "bounds": b, "resolution": res, "threads": 8},
      {"type": "filters.stats", "dimensions": "Classification,ReturnNumber,Z", "enumerate": "Classification,ReturnNumber"}]}, open(f'/tmp/ept_{name}.json', 'w'))
PY
cat /tmp/hit.txt; echo
for r in r10 r05; do
  T0=$(date +%s); timeout 500 $P/pdal pipeline /tmp/ept_$r.json --metadata /tmp/ept_meta_$r.json 2>&1 | tail -3; echo "ept $r 1 km2 $(( $(date +%s) - T0 )) s"
  $P/python -c "
import json; m=json.load(open('/tmp/ept_meta_$r.json'));
st=m['stages']['filters.stats']['statistic']; [print(s['name'], s['count'], s.get('values') or (round(s['minimum'],1), round(s['maximum'],1))) for s in st]" 2>&1 | cut -c1-500
done
date -u
