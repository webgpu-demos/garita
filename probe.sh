#!/usr/bin/env bash
# Are the D24 LAZ files COPC (range-readable)? PDAL via micromamba: a small read of D24 (copc) and of the 2018 EPT.
set -u
date -u
B=https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/LPC/Projects/PR_PuertoRicoUSVI_D24/PR_PuertoRicoUSVI_4_D24/LAZ/
U="${B}USGS_LPC_PR_PuertoRicoUSVI_D24_124000_236000.laz"
curl -sSI -m 60 "$U" | grep -iE "^(HTTP|content-length|last-modified)"
curl -sS -m 60 -r 0-1999 -o /tmp/head.bin "$U"; python3 - <<'PY'
b = open('/tmp/head.bin', 'rb').read()
print('LASF' if b[:4] == b'LASF' else b[:16], 'version', b[24], b[25], 'copc VLR' if b'copc' in b[:2000] else 'no copc in first 2 KB', 'header size', int.from_bytes(b[94:96], 'little'))
PY
# micromamba + pdal
T0=$(date +%s)
curl -Ls https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xj -C /tmp bin/micromamba
export MAMBA_ROOT_PREFIX=/tmp/mamba; /tmp/bin/micromamba create -y -q -n pd -c conda-forge pdal python=3.12 numpy pyproj python-pdal > /dev/null 2>&1
P=/tmp/mamba/envs/pd/bin; echo "pdal install $(( $(date +%s) - T0 )) s"; $P/pdal --version | head -2
# which D24 tile holds Condado: from the vpc bboxes (subprojects 1..6)
$P/python - <<'PY'
import json, urllib.request
lon, lat = -66.0705, 18.4563
for sub in range(1, 7):
    u = f'https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/LPC/Projects/PR_PuertoRicoUSVI_D24/PR_PuertoRicoUSVI_{sub}_D24/PR_PuertoRicoUSVI_{sub}_D24.vpc'
    try: v = json.load(urllib.request.urlopen(u, timeout=120))
    except Exception as e: print(sub, 'no vpc', e); continue
    print(sub, len(v['features']), 'tiles; crs', v['features'][0]['properties'].get('proj:epsg') or v['features'][0]['properties'].get('proj:projjson', {}).get('id'))
    for f in v['features']:
        x0, y0, _, x1, y1, _ = f['bbox']
        if x0 <= lon <= x1 and y0 <= lat <= y1:
            href = f['assets'][list(f['assets'])[0]]['href']
            print('  Condado tile', f['id'], f['properties']['pc:count'], href)
            open('/tmp/tile.txt', 'w').write(u.rsplit('/', 1)[0] + '/' + href.lstrip('./'))
PY
T=$(cat /tmp/tile.txt 2>/dev/null); echo "tile url $T"; curl -sSI -m 60 "$T" | grep -iE "^(HTTP|content-length)"
cat > /tmp/copc.json <<JSON
{"pipeline": [{"type": "readers.copc", "filename": "$T", "resolution": 0.7}, {"type": "filters.stats", "dimensions": "Classification", "enumerate": "Classification"}, {"type": "writers.las", "filename": "/tmp/copc_lo.laz", "compression": "laszip"}]}
JSON
T0=$(date +%s); timeout 400 $P/pdal pipeline /tmp/copc.json --metadata /tmp/copc_meta.json 2>&1 | tail -3; echo "copc read (resolution 0.7 m) $(( $(date +%s) - T0 )) s"; ls -l /tmp/copc_lo.laz 2>&1
$P/python -c "
import json; m=json.load(open('/tmp/copc_meta.json')); st=m['stages']['filters.stats']['statistic'][0]; print('points', st['count'], 'classes', st.get('values'))
r=m['stages']['readers.copc']; print({k: r[k] for k in r if k in ('count','srs','copc_info','minx','maxx','miny','maxy')} if isinstance(r, dict) else r)" 2>&1 | cut -c1-900
$P/python - <<'PY'
import math, json
lon, lat = -66.0705, 18.4563
x = lon * 20037508.34 / 180; y = math.log(math.tan((90 + lat) * math.pi / 360)) / (math.pi / 180) * 20037508.34 / 180
b = f"([{x-500:.1f}, {x+500:.1f}], [{y-500:.1f}, {y+500:.1f}])"
json.dump({"pipeline": [{"type": "readers.ept", "filename": "https://s3-us-west-2.amazonaws.com/usgs-lidar-public/USGS_LPC_PR_PRVI_D_2018/ept.json", "bounds": b, "resolution": 0.7},
  {"type": "filters.stats", "dimensions": "Classification", "enumerate": "Classification"}]}, open('/tmp/ept.json', 'w'))
PY
T0=$(date +%s); timeout 400 $P/pdal pipeline /tmp/ept.json --metadata /tmp/ept_meta.json 2>&1 | tail -3; echo "ept 2018 1 km2 read (resolution 0.7 m) $(( $(date +%s) - T0 )) s"
$P/python -c "
import json; m=json.load(open('/tmp/ept_meta.json')); st=m['stages']['filters.stats']['statistic'][0]; print('points', st['count'], 'classes', st.get('values'))" 2>&1 | cut -c1-600
date -u
