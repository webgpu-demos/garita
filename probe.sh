#!/usr/bin/env bash
# procedural-sanjuan tools/synth/experiment/smoke.sh on the synthetic frames the syn1 probe exported (branch
# probe-out/syn1 of this repository): prepare.py and run.py end to end, one epoch, CPU.
set -u
date -u
git clone -q --depth 1 --branch synthetic https://github.com/webgpu-demos/procedural-sanjuan psj
git fetch -q --depth 1 origin probe-out/syn1 && mkdir -p /tmp/syn1 && git archive FETCH_HEAD syn | tar -x -C /tmp/syn1 && ls /tmp/syn1/syn
T0=$(date +%s)
pip install -q --index-url https://download.pytorch.org/whl/cpu torch torchvision 2>&1 | tail -2
pip install -q ultralytics 2>&1 | tail -2
python3 -c "import torch, ultralytics; print('torch', torch.__version__, 'ultralytics', ultralytics.__version__)"
echo "install $(( $(date +%s) - T0 )) s"
cd /tmp && timeout 720 bash "$GITHUB_WORKSPACE/psj/tools/synth/experiment/smoke.sh" /tmp/syn1/syn /tmp/smoke 2>&1 | grep -vE "^\s*[0-9]+/[0-9]+ |it/s|━" | tail -60
cp /tmp/smoke/exp/results.csv /tmp/smoke/exp/summary.md /tmp/smoke/exp/experiment.json "$OUT/" 2>/dev/null; ls "$OUT"
date -u
