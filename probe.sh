#!/usr/bin/env bash
# Inventory sources: Overture OSM record ids (for GERS mapping), FEMA USA Structures for PR, USGS 1 m DEM tile names.
set -u
date -u
python3 -m pip install -q "overturemaps>=1.0.2" "duckdb>=1.1" 2>&1 | tail -1
echo "== Overture"
T0=$(date +%s)
overturemaps download --bbox="-67.95,17.85,-65.2,18.55" -f geoparquet --type=building -o /tmp/b.parquet >/dev/null 2>/tmp/ovt.err || tail -3 /tmp/ovt.err
echo "download s: $(( $(date +%s) - T0 ))"; ls -l /tmp/b.parquet
python3 - <<'PY'
import duckdb, json
c = duckdb.connect()
q = lambda s: c.execute(s).fetchall()
print('id sample', q("select id, sources[1].dataset, sources[1].record_id from '/tmp/b.parquet' using sample 8 rows"))
osm = "sources[1].dataset = 'OpenStreetMap'"
print('osm rows', q(f"select count(*), count(distinct sources[1].record_id) from '/tmp/b.parquet' where {osm}"))
print('record_id shapes', q(f"select regexp_replace(sources[1].record_id, '[0-9]+', 'N', 'g') as s, count(*) from '/tmp/b.parquet' where {osm} group by 1 order by 2 desc limit 10"))
print('id length', q("select length(id), count(*) from '/tmp/b.parquet' group by 1"))
print('osm with height', q(f"select count(height), count(num_floors) from '/tmp/b.parquet' where {osm}"))
PY
echo "== USA Structures (FEMA ArcGIS view used by procedural-sanjuan)"
S='https://services2.arcgis.com/FiaPA4ga0iQKduv3/ArcGIS/rest/services/USA_Structures_View/FeatureServer/0'
curl -sS -m 60 "$S?f=json" | python3 -c "import json,sys; d=json.load(sys.stdin); print('maxRecordCount', d.get('maxRecordCount')); print('fields', [(f['name'], f['type']) for f in d.get('fields',[])])"
ENV='geometry=-67.95,17.85,-65.2,18.55&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects'
echo "count PR bbox:"; curl -sS -m 120 "$S/query?where=1%3D1&$ENV&returnCountOnly=true&f=json"; echo
echo "count STATE=PR:"; curl -sS -m 120 "$S/query?where=STATE%3D%27PR%27&returnCountOnly=true&f=json"; echo
echo "height stats PR:"; curl -sS -m 180 "$S/query?where=STATE%3D%27PR%27&outStatistics=%5B%7B%22statisticType%22%3A%22count%22%2C%22onStatisticField%22%3A%22HEIGHT%22%2C%22outStatisticFieldName%22%3A%22n%22%7D%2C%7B%22statisticType%22%3A%22avg%22%2C%22onStatisticField%22%3A%22HEIGHT%22%2C%22outStatisticFieldName%22%3A%22a%22%7D%2C%7B%22statisticType%22%3A%22max%22%2C%22onStatisticField%22%3A%22HEIGHT%22%2C%22outStatisticFieldName%22%3A%22m%22%7D%5D&f=json"; echo
echo "sample:"; curl -sS -m 60 "$S/query?where=STATE%3D%27PR%27&outFields=*&resultRecordCount=3&returnGeometry=false&f=json" | head -c 2500; echo
T0=$(date +%s); curl -sS -m 180 -o /tmp/page.json "$S/query?where=STATE%3D%27PR%27&outFields=BUILD_ID,HEIGHT,OCC_CLS,PRIM_OCC,SQMETERS&resultOffset=0&resultRecordCount=2000&returnGeometry=true&outSR=4326&geometryPrecision=6&f=geojson"
echo "one page s: $(( $(date +%s) - T0 )) bytes $(stat -c %s /tmp/page.json)"
echo "== FEMA bulk (S3)"
curl -sS -m 60 "https://fema-femadata.s3.amazonaws.com/?list-type=2&prefix=Partners/ORNL/USA_Structures/&delimiter=/" | tr '<' '\n' | grep -E '^(Prefix|Key|Size)>' | head -80
echo "== USGS 1 m DEM D24 tile names"
curl -sS -m 60 "https://prd-tnm.s3.amazonaws.com/?list-type=2&prefix=StagedProducts/Elevation/1m/Projects/PR_PuertoRicoUSVI_D24/TIFF/&max-keys=1000" | tr '<' '\n' | grep -E '^Key>' | sed 's/Key>//' | head -200
date -u
