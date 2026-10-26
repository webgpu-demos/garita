#!/usr/bin/env bash
# USA Structures heights in Puerto Rico: coverage per release, in San Juan, in the ArcGIS view; join with Overture OSM.
set -u
date -u
python3 -m pip install -q "overturemaps>=1.0.2" "duckdb>=1.1" 2>&1 | tail -1
B='https://fema-femadata.s3.amazonaws.com/Partners/ORNL/USA_Structures/Puerto%20Rico'
for z in PR_Structures_20260913 Deliverable20250606PR Deliverable20230630PR; do
  curl -sS -m 600 -o /tmp/$z.zip "$B/$z.zip"; mkdir -p /tmp/$z && (cd /tmp/$z && unzip -q -o /tmp/$z.zip); echo "$z $(stat -c %s /tmp/$z.zip)"
done
overturemaps download --bbox="-67.95,17.85,-65.2,18.55" -f geoparquet --type=building -o /tmp/b.parquet >/dev/null 2>&1
python3 - <<'PY'
import duckdb, glob, time, json, urllib.request, urllib.parse
c = duckdb.connect(); c.execute("install spatial; load spatial;")
q = lambda s: c.execute(s).fetchall()
SJ = (-66.129, 18.296, -65.991, 18.476)
for z in ['PR_Structures_20260913', 'Deliverable20250606PR', 'Deliverable20230630PR']:
    gdb = glob.glob(f'/tmp/{z}/**/*.gdb', recursive=True)[0]
    t = time.time()
    c.execute(f"create or replace table r0 as select * from ST_Read('{gdb}')")
    gcol = [r[0] for r in q("describe r0") if r[1].upper().startswith('GEOMETRY')][0]
    c.execute(f"create or replace table r as select BUILD_ID, HEIGHT, OCC_CLS, ST_SetCRS(ST_Centroid({gcol}), 'OGC:CRS84') as c, ST_SetCRS({gcol}, 'OGC:CRS84') as g from r0")
    print('  bbox', q("select min(ST_X(c)), max(ST_X(c)), min(ST_Y(c)), max(ST_Y(c)) from r"))
    print(z, 'read', round(time.time()-t,1), 's')
    print('  all: n, with height>0, median, p95', q("select count(*), count(*) filter (where HEIGHT > 0), median(HEIGHT) filter (where HEIGHT>0), quantile_cont(HEIGHT, 0.95) filter (where HEIGHT>0) from r"))
    print('  san juan bbox:', q(f"select count(*), count(*) filter (where HEIGHT > 0) from r where ST_X(c) between {SJ[0]} and {SJ[2]} and ST_Y(c) between {SJ[1]} and {SJ[3]}"))
    print('  height>0 by occ', q("select OCC_CLS, count(*), count(*) filter (where HEIGHT>0) from r group by 1 order by 2 desc limit 6"))
    if z == 'PR_Structures_20260913':
        c.execute("create table us as select * from r")
# the ArcGIS view procedural-sanjuan reads
S = 'https://services2.arcgis.com/FiaPA4ga0iQKduv3/ArcGIS/rest/services/USA_Structures_View/FeatureServer/0/query'
def get(params):
    u = S + '?' + urllib.parse.urlencode(params)
    return json.load(urllib.request.urlopen(u, timeout=120))
env = dict(geometry='-67.95,17.85,-65.2,18.55', geometryType='esriGeometryEnvelope', inSR=4326, spatialRel='esriSpatialRelIntersects', f='json')
envsj = dict(env, geometry=','.join(map(str, SJ)))
try:
    print('view PR: count', get(dict(env, where='1=1', returnCountOnly='true')), 'with height', get(dict(env, where='HEIGHT > 0', returnCountOnly='true')))
    print('view SJ: count', get(dict(envsj, where='1=1', returnCountOnly='true')), 'with height', get(dict(envsj, where='HEIGHT > 0', returnCountOnly='true')))
    print('view sample', json.dumps(get(dict(envsj, where='HEIGHT > 0', outFields='BUILD_ID,HEIGHT,OCC_CLS,SOURCE,IMAGE_DATE,VAL_METHOD,H_ADJ_ELEV', returnGeometry='false', resultRecordCount=3)).get('features'))[:800])
    print('view fields', [f['name'] for f in json.load(urllib.request.urlopen(S.replace('/query', '?f=json'), timeout=60))['fields']])
except Exception as e:
    print('view error', e)
# join quality: Overture OSM footprints (centroid) in USA Structures 2026 footprints
c.execute("create table osm as select id, height as oh, ST_Centroid(geometry) as c from '/tmp/b.parquet' where sources[1].dataset = 'OpenStreetMap'")
t = time.time()
c.execute("create table j as select o.id, o.oh, u.HEIGHT as uh from osm o join us u on ST_Contains(u.g, o.c)")
print('join s', round(time.time() - t, 1))
print('osm in a USA Structures footprint', q("select count(distinct id) from j"), 'of', q("select count(*) from osm"))
print('osm without height that gain one', q("select count(distinct id) from j where oh is null and uh > 0"), 'of osm without height', q("select count(*) from osm where oh is null"))
print('agreement where both: n, median |d|, p90 |d|, median (fema - osm)', q("select count(*), median(abs(oh-uh)), quantile_cont(abs(oh-uh),0.9), median(uh-oh) from j where oh > 0 and uh > 0"))
PY
date -u
