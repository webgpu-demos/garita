#!/usr/bin/env bash
set -uo pipefail
date -u
UA="garita (github.com/webgpu-demos/garita)"
t() { echo "== $1"; curl -sS -m 60 -A "$UA" -o "$OUT/$2" -w "http %{http_code} time %{time_total} size %{size_download} ip %{remote_ip}\n" "${@:3}" 2>&1 | tail -2; head -c 300 "$OUT/$2" 2>/dev/null; echo; }
t "count GET arcgis/rest" c1.json "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?where=DFIRM_ID+LIKE+%2772%25%27&returnCountOnly=true&f=json"
t "count POST arcgis/rest" c2.json -X POST -d "where=DFIRM_ID LIKE '72%'&returnCountOnly=true&f=json" "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query"
t "count POST browser UA" c3.json -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" -X POST -d "where=DFIRM_ID LIKE '72%'&returnCountOnly=true&f=json" "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query"
t "layer info" c4.json "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28?f=json"
t "gis/nfhl path" c5.json "https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL/MapServer/28/query?where=DFIRM_ID+LIKE+%2772%25%27&returnCountOnly=true&f=json"
t "root" c6.html "https://hazards.fema.gov/"
t "AGOL FEMA NFHL" c7.json "https://services.arcgis.com/2gdL2gxYNFY2TOUb/arcgis/rest/services/FEMA_National_Flood_Hazard_Layer/FeatureServer/0/query?where=DFIRM_ID+LIKE+%2772%25%27&returnCountOnly=true&f=json"
t "Esri living atlas" c8.json "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Flood_Hazard_Reduced_Set_gdb/FeatureServer/0/query?where=DFIRM_ID+LIKE+%2772%25%27&returnCountOnly=true&f=json"
t "Esri living atlas info" c9.json "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Flood_Hazard_Reduced_Set_gdb/FeatureServer/0?f=json"
t "msc state product listing" c10.json "https://msc.fema.gov/portal/advanceSearch"
for i in 1 2 3; do sleep 5; t "retry $i count POST" r$i.json -X POST -d "where=DFIRM_ID LIKE '72%'&returnCountOnly=true&f=json" "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query"; done
# Overture attribution page: the Buildings section
curl -sL https://docs.overturemaps.org/attribution/ | sed 's/<[^>]*>/ /g' | tr -s ' \n' > "$OUT/attr_full.txt"
python3 - <<'PY'
import os,re
t=open(os.environ['OUT']+'/attr_full.txt').read()
for m in re.finditer(r'Open Buildings|Microsoft', t):
    print(m.start(), '...', t[max(0,m.start()-300):m.start()+500].replace('\n',' '))
    print('-----')
i=t.find('Buildings')
print(len(t))
PY
date -u
