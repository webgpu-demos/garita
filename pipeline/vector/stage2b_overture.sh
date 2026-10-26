#!/usr/bin/env bash
# Stage 2b: Overture Maps buildings for Puerto Rico (downloaded once per release, cached), cut down to the
# footprints whose origin is NOT OpenStreetMap: machine detections from imagery (Google Open Buildings,
# Microsoft ML Buildings). build.mjs adds those that do not overlap a building of our own OSM extract.
#
# Overture conflates OpenStreetMap with the machine-detected sets and records each feature's origin in `sources`
# (dataset, licence, version, confidence). Public and keyless: GeoParquet in s3://overturemaps-us-west-2/release/.
# The `overturemaps` command picks the files through Overture's STAC catalogue, so the bounding box of the island
# comes down in seconds (about 300 MB, 2.16 million rows in release 2026-09-23.1).
#   OVERTURE_RELEASE  pin a release (default: the newest listed in the bucket)
# Writes work/overture/added.jsonl (one candidate per line), work/overture/osm_gers.csv (the GERS id of each
# OpenStreetMap building Overture carries) and work/overture/meta.json (release, counts, licences).
set -euo pipefail
WORK="${WORK_DIR:-work}"; CACHE="$WORK/cache/overture"; OVT="$WORK/overture"
BBOX="-67.95,17.85,-65.2,18.55"
mkdir -p "$CACHE" "$OVT"
python3 -m pip install -q "overturemaps>=1.0.2" "duckdb>=1.3" 2>&1 | tail -2
LIST="https://overturemaps-us-west-2.s3.amazonaws.com/?list-type=2&prefix=release/&delimiter=/"
REL="${OVERTURE_RELEASE:-}"
if [ -z "$REL" ]; then
  REL="$(curl -fsS --retry 4 "$LIST" | tr '<' '\n' | sed -n 's#^Prefix>release/\([0-9][^/]*\)/$#\1#p' | sort | tail -1 || true)"
fi
# No listing (network trouble): fall back to the newest release already in the cache.
if [ -z "$REL" ]; then REL="$(ls "$CACHE" 2>/dev/null | sed -n 's/^pr_buildings_\(.*\)\.parquet$/\1/p' | sort | tail -1)"; fi
[ -n "$REL" ] || { echo "Overture: no release found"; exit 1; }
PQ="$CACHE/pr_buildings_$REL.parquet"
if [ ! -s "$PQ" ]; then
  find "$CACHE" -name 'pr_buildings_*.parquet*' -delete   # older releases
  T0=$(date +%s)
  overturemaps download --bbox="$BBOX" -f geoparquet --type=building -r "$REL" -o "$PQ.tmp" > /dev/null 2> "$OVT/download.err" || { tail -5 "$OVT/download.err"; exit 1; }
  mv "$PQ.tmp" "$PQ"; rm -f "$PQ.tmp.state" "$CACHE"/*.state
  echo "Overture $REL buildings downloaded in $(( $(date +%s) - T0 )) s"
fi
ls -l "$PQ"
REL="$REL" PQ="$PQ" OVT="$OVT" BBOX="$BBOX" python3 - <<'PY'
import duckdb, json, os
rel, pq, ovt = os.environ['REL'], os.environ['PQ'], os.environ['OVT']
c = duckdb.connect(); c.execute("install spatial; load spatial;")
q = lambda s: c.execute(s).fetchall()
# (the lambda syntax DuckDB 1.3+ reads; the old "x -> x.dataset" arrow is refused by current releases)
is_osm = "list_contains(list_transform(sources, lambda x: x.dataset), 'OpenStreetMap')"
by = q(f"""select sources[1].dataset, any_value(sources[1].license), min(sources[1].version), max(sources[1].version),
                  min(sources[1].update_time), max(sources[1].update_time), count(*), count(sources[1].confidence),
                  min(sources[1].confidence), max(sources[1].confidence), count(height), count(num_floors)
           from '{pq}' group by 1 order by 7 desc""")
meta = {
  'release': rel, 'bbox': [float(v) for v in os.environ['BBOX'].split(',')], 'rows': q(f"select count(*) from '{pq}'")[0][0],
  'file': f"s3://overturemaps-us-west-2/release/{rel}/theme=buildings/type=building/",
  'datasets': [dict(dataset=r[0], license_in_data=r[1], version_min=r[2], version_max=r[3], update_time_min=r[4], update_time_max=r[5],
                    features=r[6], with_confidence=r[7], confidence_min=r[8], confidence_max=r[9], with_height=r[10], with_floors=r[11]) for r in by],
  'multi_source_features': q(f"select count(*) from '{pq}' where len(sources) > 1")[0][0],
  'osm_origin': q(f"select count(*) from '{pq}' where {is_osm}")[0][0],
}
# One line per candidate: every feature without an OpenStreetMap source. The order is the order of preference
# where two detections cover the same roof (build.mjs keeps the first): Microsoft ML Buildings first (the newer
# set, version 2026-08, with regularised outlines), then Google Open Buildings (2023-05) by falling confidence.
c.execute(f"""copy (select id, sources[1].dataset as ds, sources[1].confidence as conf, height as h, num_floors as floors,
                           ST_AsGeoJSON(geometry)::JSON as g
                    from '{pq}' where not {is_osm}
                    order by (sources[1].dataset = 'Microsoft ML Buildings') desc, sources[1].confidence desc nulls first, bbox.xmin, bbox.ymin, id)
              to '{ovt}/added.jsonl' (format json)""")
meta['candidates'] = q(f"select count(*) from '{pq}' where not {is_osm}")[0][0]
# OpenStreetMap's own buildings as Overture carries them: each one's GERS id (Overture's stable feature id), keyed by
# the OSM object ("w123", "r456"; Overture's record_id without its "@version"). build.mjs gives every OSM record of
# ours the id of its Overture twin where there is one (Overture's OSM snapshot is weeks older than our extract, so the
# newest buildings have none). One line per building: osm,gers.
c.execute(f"""copy (select regexp_replace(sources[1].record_id, '@.*$', '') as osm, id as gers
                    from '{pq}' where sources[1].dataset = 'OpenStreetMap' and sources[1].record_id is not null)
              to '{ovt}/osm_gers.csv' (header false)""")
meta['osm_gers'] = q(f"select count(*) from '{pq}' where sources[1].dataset = 'OpenStreetMap' and sources[1].record_id is not null")[0][0]
json.dump(meta, open(f'{ovt}/meta.json', 'w'), indent=1)
print('Overture', json.dumps(meta))
PY
wc -l "$OVT/added.jsonl"; ls -l "$OVT"; head -c 500 "$OVT/added.jsonl"; echo
