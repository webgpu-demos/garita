#!/usr/bin/env bash
# Publishes the intro video to the site: media/garita-intro-<version>-{1080,720}.mp4 and -poster.jpg on gh-pages.
# The files are not in the main branch (40 MB of binary); tools/deploy.sh leaves media/ alone.
#   tools/publish-intro.sh <version> <1080.mp4> <720.mp4> <poster.jpg>
# <version> must match VERSION in src/ui/intro.ts. Make the files from the walkthrough's master cut
# (tools/video/assemble.py): 1080p two-pass H.264 at 1.6 Mb/s, 720p at 1 Mb/s, AAC 96 kb/s, +faststart.
set -euo pipefail
VER="$1"; F1080="$(realpath "$2")"; F720="$(realpath "$3")"; POSTER="$(realpath "$4")"
DEPLOY_DIR="${DEPLOY_DIR:-/home/claude/deploy-root}"
REPO_URL="https://github.com/webgpu-demos/garita"
if [ ! -d "$DEPLOY_DIR/.git" ]; then
  git clone -q --depth 1 --branch gh-pages --no-tags --filter=blob:none --sparse "$REPO_URL" "$DEPLOY_DIR"
  git -C "$DEPLOY_DIR" sparse-checkout set --no-cone '/*' '!/tiles/' '!/data/' '!/fixtures/'
fi
cd "$DEPLOY_DIR"
for attempt in 1 2 3 4 5; do
  git fetch -q --depth 1 origin gh-pages && git reset -q --hard origin/gh-pages || { sleep 12; continue; }
  mkdir -p media
  cp "$F1080" "media/garita-intro-$VER-1080.mp4"; cp "$F720" "media/garita-intro-$VER-720.mp4"; cp "$POSTER" "media/garita-intro-$VER-poster.jpg"
  git add media
  if git diff --cached --quiet; then echo "publish-intro: nothing changed"; exit 0; fi
  git commit -q -m "Intro video $VER

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UFDnHPw7W7Xe92VesEaMZd"
  if git push -q origin HEAD:gh-pages; then echo "publish-intro: pushed media/garita-intro-$VER-*"; exit 0; fi
  sleep 15
done
echo "publish-intro: push failed" >&2; exit 1
