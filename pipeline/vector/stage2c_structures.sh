#!/usr/bin/env bash
# Stage 2c: FEMA / ORNL USA Structures for Puerto Rico, for the heights our footprints lack. build.mjs gives a building
# with no height of its own (no OSM height or building:levels, no height from the detection's source) the HEIGHT of
# the USA Structures footprint its centroid stands in, when that footprint has one.
#
# USA Structures is public domain (FEMA, Oak Ridge National Laboratory); its heights come from lidar where FEMA had
# lidar for the delivery. Releases on FEMA's bucket (fema-femadata, Partners/ORNL/USA_Structures/Puerto Rico/) as
# measured on 2026-10-26: Deliverable20230630PR and Deliverable20250606PR both hold 1,194,236 structures, 234,162 of
# them with a height (110,536 of 133,038 inside the municipio of San Juan's box); PR_Structures_20260913 holds
# 1,247,633 structures but heights for only 153,080 (72,226 of 137,402 in San Juan). The default is the 2025 release:
# the most heights, and the release the FEMA ArcGIS view serves (the one procedural-sanjuan reads), so the two
# twins show the same height for the same building. Against OSM's own height tags, where both exist (101,251
# buildings, 2026 release): median difference 0.49 m, 90th percentile 1.93 m, USA Structures 0.33 m lower at the median.
#   USA_STRUCTURES_RELEASE  another release (the zip's name without .zip)
# Writes work/structures/heights.jsonl (one footprint with a height per line: {"id", "h", "occ", "g"}) and
# work/structures/meta.json.
set -euo pipefail
WORK="${WORK_DIR:-work}"; CACHE="$WORK/cache/structures"; OUTD="$WORK/structures"
REL="${USA_STRUCTURES_RELEASE:-Deliverable20250606PR}"
URL="https://fema-femadata.s3.amazonaws.com/Partners/ORNL/USA_Structures/Puerto%20Rico/$REL.zip"
mkdir -p "$CACHE" "$OUTD"
if [ ! -s "$CACHE/$REL.zip" ]; then
  find "$CACHE" -maxdepth 1 -name '*.zip' -delete   # older releases
  T0=$(date +%s)
  curl -fsSL --retry 4 --retry-delay 5 -o "$CACHE/$REL.zip.tmp" "$URL" && mv "$CACHE/$REL.zip.tmp" "$CACHE/$REL.zip"
  echo "USA Structures $REL downloaded in $(( $(date +%s) - T0 )) s"
fi
ls -l "$CACHE/$REL.zip"
rm -rf "$CACHE/unzipped" && mkdir -p "$CACHE/unzipped" && unzip -q -o -d "$CACHE/unzipped" "$CACHE/$REL.zip"
GDB="$(find "$CACHE/unzipped" -maxdepth 3 -name '*.gdb' | head -1)"
[ -n "$GDB" ] || { echo "USA Structures: no file geodatabase in $REL.zip"; exit 1; }
python3 -m pip install -q "duckdb>=1.1" 2>&1 | tail -2
REL="$REL" URL="$URL" GDB="$GDB" OUTD="$OUTD" python3 - <<'PY'
import duckdb, json, os, datetime
rel, gdb, outd = os.environ['REL'], os.environ['GDB'], os.environ['OUTD']
c = duckdb.connect(); c.execute("install spatial; load spatial;")
q = lambda s: c.execute(s).fetchall()
c.execute(f"create table s as select * from ST_Read('{gdb}')")
g = [r[0] for r in q("describe s") if r[1].upper().startswith('GEOMETRY')][0]
rows, with_h = q("select count(*), count(*) filter (where HEIGHT > 0) from s")[0]
lon0, lon1, lat0, lat1 = q(f"select min(ST_XMin({g})), max(ST_XMax({g})), min(ST_YMin({g})), max(ST_YMax({g})) from s")[0]
# the files are in WGS 84 longitude/latitude (checked: the bounding box above); refuse anything else
assert -68.5 < lon0 < lon1 < -65 and 17.5 < lat0 < lat1 < 18.7, ('not lon/lat degrees', lon0, lon1, lat0, lat1)
c.execute(f"""copy (select BUILD_ID as id, round(HEIGHT, 2) as h, OCC_CLS as occ, ST_AsGeoJSON({g})::JSON as g
                    from s where HEIGHT > 0 and HEIGHT < 400 order by BUILD_ID)
              to '{outd}/heights.jsonl' (format json)""")
meta = {
  'name': 'FEMA / ORNL USA Structures (public domain)', 'release': rel, 'url': os.environ['URL'],
  'structures': rows, 'with_height': with_h, 'fetched': datetime.datetime.utcnow().isoformat(timespec='seconds') + 'Z',
  'by_occupancy': [dict(occ=r[0], structures=r[1], with_height=r[2]) for r in q("select OCC_CLS, count(*), count(*) filter (where HEIGHT > 0) from s group by 1 order by 2 desc")],
}
json.dump(meta, open(f'{outd}/meta.json', 'w'), indent=1)
print('USA Structures', json.dumps(meta))
PY
wc -l "$OUTD/heights.jsonl"; head -c 400 "$OUTD/heights.jsonl"; echo
