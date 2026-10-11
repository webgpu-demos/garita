#!/usr/bin/env bash
# Copies out/ into the gh-pages checkout (site/) and pushes one commit. Only touches the paths this pipeline owns.
# usage: publish.sh "<commit message>" [--replace-tiles]
#   PUBLISH_PREFIX  path prefix on gh-pages, with its trailing slash ("staging/" while a rebuild is being checked;
#                   empty = the live paths the site reads). Everything this script writes goes under it.
#   PUBLISH_TILES   1 = everything (tiles too). Anything else = development run: only data/derived (log, qa.json,
#                   exposure.json, QA pictures) and tiles/bld/index.json. A tile publication adds about 50 MB to
#                   the history of gh-pages, so it is asked for explicitly (see vector.yml).
set -uo pipefail
MSG="${1:-vector pipeline}"; REPLACE="${2:-}"
OUT="${OUT_DIR:-out}"; SITE="${SITE_DIR:-site}"
PREFIX="${PUBLISH_PREFIX:-}"; TILES="${PUBLISH_TILES:-1}"
[ -d "$OUT" ] || { echo "nothing to publish"; exit 0; }
[ -f "$OUT/vector_log.txt" ] && mkdir -p "$OUT/data/derived" && cp "$OUT/vector_log.txt" "$OUT/data/derived/vector_log.txt"
DIRS="data/derived"; [ "$TILES" = "1" ] && DIRS="data/geo data/osm data/derived"
for d in $DIRS; do
  if [ -d "$OUT/$d" ]; then mkdir -p "$SITE/$PREFIX$d" && cp -r "$OUT/$d/." "$SITE/$PREFIX$d/"; fi
done
if [ -d "$OUT/tiles/bld" ]; then
  if [ "$TILES" = "1" ]; then
    [ "$REPLACE" = "--replace-tiles" ] && rm -rf "$SITE/${PREFIX}tiles/bld"
    mkdir -p "$SITE/${PREFIX}tiles/bld" && cp -r "$OUT/tiles/bld/." "$SITE/${PREFIX}tiles/bld/"
    rm -f "$SITE/${PREFIX}data/derived/bld_index.json"   # the development copy would only go stale
  elif [ -f "$OUT/tiles/bld/index.json" ]; then
    # development run: the index only, beside the QA files (never where a client would look for tiles)
    cp "$OUT/tiles/bld/index.json" "$SITE/${PREFIX}data/derived/bld_index.json"
  fi
fi
cd "$SITE"
git config user.name "garita-pipeline"; git config user.email "actions@users.noreply.github.com"
for d in data/geo data/osm data/derived tiles/bld; do
  if [ -e "$PREFIX$d" ]; then git add --sparse -A -- "$PREFIX$d" 2>/dev/null || git add -A -- "$PREFIX$d" || true; fi
done
if git diff --cached --quiet; then echo "no changes to publish"; exit 0; fi
git commit -q -m "$MSG"
for i in 1 2 3 4 5 6 7 8; do
  if git fetch -q origin gh-pages && git rebase -q origin/gh-pages && git push -q origin HEAD:gh-pages; then echo "published: $MSG"; exit 0; fi
  git rebase --abort 2>/dev/null || true
  echo "push attempt $i failed; retrying"; sleep $((5 + RANDOM % 10))
done
echo "publish failed"; exit 1
