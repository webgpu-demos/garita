#!/usr/bin/env bash
# What are the high "roof" points at the outliers of the heights run? A 60 m box around three of them.
set -u
curl -Ls https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xj -C /tmp bin/micromamba
export MAMBA_ROOT_PREFIX=/tmp/mamba; /tmp/bin/micromamba create -y -q -n pd -c conda-forge python=3.12 pdal python-pdal numpy > /dev/null 2>&1
/tmp/mamba/envs/pd/bin/python - <<'PY' 2>&1 | grep -v "PDAL Error"
import json, math, numpy as np, pdal, urllib.request
R = 6378137.0
def merc(lon, lat): return R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
cols = ['A', 'C', 'D', 'E', 'F', 'G', 'H']
for lon, lat, name in [(-66.136794, 18.141055, 'i1147559 Cayey'), (-65.659211, 18.324046, 'i1709211 Fajardo'), (-66.350837, 18.17656, 'i808280 p50 244'), (-66.231066, 18.24656, 'i935742')]:
    x, y = merc(lon, lat); k = 1 / math.cos(math.radians(lat)); m = 30 * k
    for c in cols:
        u = f'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/USGS_LPC_PR_PRVI_{c}_2018/ept.json'
        p = pdal.Pipeline(json.dumps({'pipeline': [{'type': 'readers.ept', 'filename': u, 'bounds': f'([{x-m}, {x+m}], [{y-m}, {y+m}])', 'resolution': 2.0}]}))
        try: p.execute()
        except Exception as e: continue
        if not p.arrays or not len(p.arrays[0]): continue
        a = p.arrays[0]
        g = a[a['Classification'] == 2]['Z']; gz = np.median(g) if len(g) else np.nan
        print(f'== {name} collection {c}: {len(a)} points, classes {np.unique(a["Classification"], return_counts=True)}, ground median {gz:.1f}')
        hi = a[a['Z'] > gz + 50]
        print('   above ground+50:', len(hi), 'classes', np.unique(hi['Classification'], return_counts=True), 'z pct', np.percentile(hi['Z'] - gz, [5, 50, 95]).round(1) if len(hi) else '', 'returns', np.unique(hi['ReturnNumber'], return_counts=True) if len(hi) else '', 'of', np.unique(hi['NumberOfReturns'], return_counts=True) if len(hi) else '')
        c1 = a[(a['Classification'] == 1) & (a['ReturnNumber'] == a['NumberOfReturns'])]
        h, e = np.histogram(c1['Z'] - gz, bins=[-5, 0, 2, 5, 10, 20, 50, 100, 200, 300, 1000])
        print('   class 1 last returns, height histogram', dict(zip([int(v) for v in e[:-1]], h.tolist())))
        if len(hi): print('   high points xy spread m', round((hi['X'].std()) / k, 1), round(hi['Y'].std() / k, 1), 'GpsTime spread s', round(float(hi['GpsTime'].max() - hi['GpsTime'].min()), 2), 'PointSourceId', np.unique(hi['PointSourceId']))
PY
