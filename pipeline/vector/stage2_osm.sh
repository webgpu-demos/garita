#!/usr/bin/env bash
# Stage 2: download Geofabrik's Puerto Rico extract once (cached) and cut it with osmium into three
# GeoJSON-sequence files: buildings (areas), facilities (points, lines, areas) and coastline (lines).
set -euo pipefail
WORK="${WORK_DIR:-work}"; CACHE="$WORK/cache"; OSM="$WORK/osm"
UA="garita (github.com/webgpu-demos/garita)"
URL="https://download.geofabrik.de/north-america/us/puerto-rico-latest.osm.pbf"
mkdir -p "$CACHE" "$OSM"
PBF="$CACHE/puerto-rico-latest.osm.pbf"
if [ ! -s "$PBF" ]; then
  curl -fL --retry 5 --retry-delay 5 -A "$UA" -o "$PBF.tmp" "$URL" && mv "$PBF.tmp" "$PBF"
  curl -fsIL -A "$UA" "$URL" | tr -d '\r' | grep -i -E '^(last-modified|content-length|etag)' > "$CACHE/pbf_head.txt" || true
fi
ls -l "$PBF"; cat "$CACHE/pbf_head.txt" 2>/dev/null || true
command -v osmium >/dev/null || { sudo apt-get update -qq && sudo apt-get install -y -qq osmium-tool >/dev/null; }
osmium --version | head -1
osmium fileinfo "$PBF" | tee "$OSM/fileinfo.txt" | head -30
# the date of the data itself (the extract's replication timestamp), for index.json
grep -m1 -o 'osmosis_replication_timestamp=.*' "$OSM/fileinfo.txt" | cut -d= -f2 > "$OSM/pbf_timestamp.txt" || true

cat > "$OSM/areas.json" <<'JSON'
{ "attributes": { "type": "@type", "id": "@id" }, "linear_tags": false, "area_tags": true }
JSON
cat > "$OSM/all.json" <<'JSON'
{ "attributes": { "type": "@type", "id": "@id" }, "linear_tags": true, "area_tags": true }
JSON
cat > "$OSM/lines.json" <<'JSON'
{ "attributes": { "type": "@type", "id": "@id" }, "linear_tags": true, "area_tags": false }
JSON
EXPORT="--overwrite -f geojsonseq -x print_record_separator=false --add-unique-id=type_id"

osmium tags-filter --overwrite -o "$OSM/buildings.osm.pbf" "$PBF" wr/building
osmium export $EXPORT -c "$OSM/areas.json" --geometry-types=polygon -o "$OSM/buildings.geojsonl" "$OSM/buildings.osm.pbf" 2> "$OSM/buildings.err" || { tail -5 "$OSM/buildings.err"; exit 1; }

osmium tags-filter --overwrite -o "$OSM/facilities.osm.pbf" "$PBF" \
  nwr/amenity=hospital,clinic,doctors,school,college,university,fire_station,police,ferry_terminal \
  nwr/power=plant,substation nwr/man_made=water_works,wastewater_plant nwr/aeroway=aerodrome \
  nwr/harbour=yes nwr/landuse=port nwr/industrial=port
osmium export $EXPORT -c "$OSM/all.json" -o "$OSM/facilities.geojsonl" "$OSM/facilities.osm.pbf" 2> "$OSM/facilities.err" || { tail -5 "$OSM/facilities.err"; exit 1; }

osmium tags-filter --overwrite -o "$OSM/coast.osm.pbf" "$PBF" w/natural=coastline
osmium export $EXPORT -c "$OSM/lines.json" --geometry-types=linestring -o "$OSM/coast.geojsonl" "$OSM/coast.osm.pbf" 2> "$OSM/coast.err" || { tail -5 "$OSM/coast.err"; exit 1; }

wc -l "$OSM"/*.geojsonl; ls -l "$OSM"
head -c 600 "$OSM/buildings.geojsonl"; echo
grep -m1 '"MultiPolygon"' "$OSM/buildings.geojsonl" | head -c 400 || true; echo
head -c 400 "$OSM/facilities.geojsonl"; echo
