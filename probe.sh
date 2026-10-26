#!/usr/bin/env bash
# USA Structures Puerto Rico bulk file + join quality against Overture's OSM footprints.
set -u
date -u
P='https://fema-femadata.s3.amazonaws.com/?list-type=2&prefix=Partners/ORNL/USA_Structures/Puerto%20Rico/'
curl -sS -m 60 "$P" | tr '<' '\n' | grep -E '^(Key|Size|LastModified)>' | head -20
KEY="Partners/ORNL/USA_Structures/Puerto Rico/PR_Structures_20260913.zip"
echo "KEY=$KEY"
URL="https://fema-femadata.s3.amazonaws.com/$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$KEY")"
T0=$(date +%s); curl -sS -m 600 -o /tmp/us.zip "$URL"; echo "zip s: $(( $(date +%s) - T0 )) $(stat -c %s /tmp/us.zip)"
mkdir -p /tmp/us && cd /tmp/us && unzip -q -o /tmp/us.zip && find /tmp/us -maxdepth 3 | head -20
SRC=$(find /tmp/us -maxdepth 3 \( -name '*.gdb' -o -name '*.shp' -o -name '*.gpkg' \) | head -1); echo "SRC=$SRC"
python3 -m pip install -q "overturemaps>=1.0.2" "duckdb>=1.1" 2>&1 | tail -1
overturemaps download --bbox="-67.95,17.85,-65.2,18.55" -f geoparquet --type=building -o /tmp/b.parquet >/dev/null 2>&1
SRC="$SRC" python3 - <<'PY'
import duckdb, time
c = duckdb.connect(); c.execute("install spatial; load spatial;")
q = lambda s: c.execute(s).fetchall()
import os
src = os.environ['SRC']
print(q(f"select * from ST_Read_Meta('{src}')")[:1])
t = time.time()
c.execute(f"create table us0 as select * from ST_Read('{src}')")
print('read s', round(time.time() - t, 1), q("describe us0"))
gcol = [r[0] for r in q("describe us0") if r[1].upper().startswith('GEOMETRY')][0]
# to WGS 84 when the file is projected (USA Structures ships in Web Mercator or WGS 84 depending on the release)
crs = q(f"select layers[1].geometry_fields[1].crs.auth_name, layers[1].geometry_fields[1].crs.auth_code from ST_Read_Meta('{src}')")
print('crs', crs)
code = f"{crs[0][0]}:{crs[0][1]}" if crs and crs[0][0] else 'EPSG:4326'
geom = f"ST_Transform({gcol}, '{code}', 'OGC:CRS84')" if code not in ('EPSG:4326',) else gcol
c.execute(f"create table us as select BUILD_ID, HEIGHT, OCC_CLS, PRIM_OCC, SQMETERS, {geom} as geom from us0")
print('bbox', q("select min(ST_XMin(geom)), max(ST_XMax(geom)), min(ST_YMin(geom)), max(ST_YMax(geom)) from us"))
print('us rows, heights', q("select count(*), count(HEIGHT), count(*) filter (where HEIGHT > 0), median(HEIGHT), quantile_cont(HEIGHT, 0.95), max(HEIGHT) from us"))
print('occ', q("select OCC_CLS, count(*) from us group by 1 order by 2 desc"))
c.execute("""create table osm as select id, sources[1].record_id as rid, height, num_floors, ST_Centroid(geometry) as c, geometry
             from '/tmp/b.parquet' where sources[1].dataset = 'OpenStreetMap'""")
c.execute("""create table ml as select id, sources[1].dataset as ds, height, ST_Centroid(geometry) as c from '/tmp/b.parquet' where sources[1].dataset <> 'OpenStreetMap'""")
t = time.time()
c.execute("create table j as select o.id, o.height as oh, o.num_floors as nf, u.HEIGHT as uh, u.OCC_CLS as occ from osm o join us u on ST_Contains(u.geom, o.c)")
print('join s', round(time.time() - t, 1))
print('osm matched to a USA Structures footprint', q("select count(distinct id) from j"), 'of', q("select count(*) from osm"))
print('osm without height, matched with uh>0', q("select count(distinct id) from j where oh is null and uh > 0"), 'osm without height total', q("select count(*) from osm where height is null"))
print('agreement where both (n, median |d|, p90 |d|, median d)', q("select count(*), median(abs(oh-uh)), quantile_cont(abs(oh-uh),0.9), median(uh-oh) from j where oh > 0 and uh > 0"))
print('many osm in one fema footprint (fema footprints holding >1 osm centroid)', q("select count(*) from (select uh from j group by all having count(*) > 1)"))
t = time.time()
c.execute("create table jm as select m.id, m.ds, u.HEIGHT as uh from ml m join us u on ST_Contains(u.geom, m.c)")
print('ml join s', round(time.time() - t, 1), q("select ds, count(distinct id), count(distinct id) filter (where uh > 0) from jm group by 1"), q("select ds, count(*) from ml group by 1"))
PY
date -u
