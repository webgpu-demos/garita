#!/usr/bin/env bash
# Renders the walkthrough's footage on GitHub runners (one job per scene; see .github/workflows/video.yml).
#   tools/video.sh <name> <spec.json> [scene ids…]
# With scene ids, only those scenes are rendered. Waits for every requested scene and copies each result to
# /tmp/claude-0/video/<name>/<scene id>/ (<id>.mp4, log.txt, sheet.jpg, still-*.jpg). A scene takes 20-90 minutes.
set -euo pipefail
NAME="$1"; SPEC="$(realpath "$2")"; shift 2
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WT="/home/claude/video-wt-$NAME"; OUT="/tmp/claude-0/video/$NAME"
REPO="https://github.com/webgpu-demos/garita"
retry() { for i in 1 2 3 4 5 6; do "$@" && return 0; sleep 15; done; return 1; }
if [ ! -d "$WT/.git" ]; then retry git clone -q --depth 1 --no-tags "$REPO" "$WT"; fi
cd "$WT"
retry git fetch -q --depth 1 origin main
git checkout -q -B "video/$NAME" FETCH_HEAD
mkdir -p tools/video .github/workflows
cp "$ROOT/tools/video/director.mjs" tools/video/director.mjs
cp "$ROOT/.github/workflows/video.yml" .github/workflows/video.yml
cp "$SPEC" video.spec.json
if [ $# -gt 0 ]; then echo "$*" > video.only; IDS="$*"; else rm -f video.only; IDS="$(node -e "console.log(require('./video.spec.json').scenes.map(s=>s.id).join(' '))")"; fi
STAMP="$(date -u +%FT%TZ)"; echo "$STAMP" > video.stamp
git add -A && git commit -q -m "video $NAME $STAMP"
declare -A BEFORE
for id in $IDS; do BEFORE[$id]="$(git ls-remote origin "refs/heads/video-out/$NAME-$id" 2>/dev/null | cut -f1 || true)"; done
retry git push -q -f origin "HEAD:refs/heads/video/$NAME"
echo "video: requested $NAME ($IDS) at $STAMP"
left="$IDS"
for i in $(seq 1 1400); do
  sleep 20
  still=""
  for id in $left; do
    NOW="$(git ls-remote origin "refs/heads/video-out/$NAME-$id" 2>/dev/null | cut -f1 || true)"
    if [ -n "$NOW" ] && [ "$NOW" != "${BEFORE[$id]}" ]; then
      rm -rf "$OUT/$id"; mkdir -p "$OUT/$id"
      retry git fetch -q --depth 1 origin "refs/heads/video-out/$NAME-$id"
      git archive FETCH_HEAD | tar -x -C "$OUT/$id"
      echo "video: $id done -> $OUT/$id ($(tail -n 3 "$OUT/$id/log.txt" | tr '\n' ' '))"
    else still="$still $id"; fi
  done
  left="$still"
  [ -z "${left// }" ] && { echo "video: all done -> $OUT"; exit 0; }
done
echo "video: timed out waiting for:$left" >&2; exit 1
