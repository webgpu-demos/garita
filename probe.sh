set -x
U=https://webgpu-demos.github.io/garita/
curl -sI ${U}media/garita-intro-20261012-1080.mp4 | grep -iE "^HTTP|content-type|content-length|accept-ranges|cache-control"
curl -s -o /dev/null -w "range: %{http_code} %{size_download}\n" -H "Range: bytes=1000-1999" ${U}media/garita-intro-20261012-720.mp4
curl -sI ${U}media/garita-intro-20261012-poster.jpg | grep -iE "^HTTP|content-type"
which google-chrome; google-chrome --version
mkdir -p /tmp/pw && cd /tmp/pw && npm install --no-audit --no-fund playwright-core@1.56.0 >/dev/null 2>&1
cd "$GITHUB_WORKSPACE"
NODE_PATH=/tmp/pw/node_modules timeout 900 node tools/intro-test.mjs "$U" "$OUT/shots" --chrome
