#!/usr/bin/env python3
"""Cuts the walkthrough: rendered scenes + narration clips + captions + title and end cards -> one mp4.

  python3 tools/video/assemble.py <footage dir> <audio dir> <out.mp4> [--spec docs/video/shots.json]

<footage dir>/<scene id>/<scene id>.mp4 come from tools/video.sh; <audio dir>/01.mp3 .. 10.mp3 are the narration
clips in script order (docs/video/script.md). Captions are timed from the pauses in each clip (ffmpeg silencedetect):
the text is spread over the speech at a constant rate, and chunk boundaries snap to the nearest pause."""
import json, os, re, subprocess, sys

args = [a for a in sys.argv[1:] if not a.startswith('--')]
FOOT, AUDIO, OUT = args[:3]
SPEC = sys.argv[sys.argv.index('--spec') + 1] if '--spec' in sys.argv else 'docs/video/shots.json'
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
WORK = os.path.join(os.path.dirname(os.path.abspath(OUT)), 'assemble-work')
os.makedirs(WORK, exist_ok=True)
GAP, XF = 1.0, 0.4        # silence between clips; crossfade between scenes

spec = json.load(open(os.path.join(ROOT, SPEC) if not os.path.isabs(SPEC) else SPEC))
scenes = spec['scenes']

def dur(path):
    return float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]).decode())

def silences(path):
    err = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', path, '-af', 'silencedetect=noise=-38dB:d=0.12', '-f', 'null', '-'],
                         capture_output=True, text=True).stderr
    st = [float(x) for x in re.findall(r'silence_start: ([0-9.]+)', err)]
    en = [float(x) for x in re.findall(r'silence_end: ([0-9.]+)', err)]
    return list(zip(st, en))

# ---- narration text per clip ----
script = open(os.path.join(ROOT, 'docs/video/script.md')).read()
paras = {}
for m in re.finditer(r'^(\d\d) · [^\n]+\n(.+?)(?=\n\n|\Z)', script, re.S | re.M):
    paras[m.group(1)] = ' '.join(m.group(2).split())

# ---- clip timeline ----
clips = sorted({s['clip'] for s in scenes})
cdur = {c: dur(os.path.join(AUDIO, f'{c}.mp3')) for c in clips}
A = {}
t = scenes[0]['pre']
for c in clips:
    A[c] = t
    t += cdur[c] + GAP
# scene starts (absolute): a scene that starts part-way into a clip (clipFrom) shows clip time clipFrom at its `pre`
T = []
for s in scenes:
    T.append(round(A[s['clip']] + s.get('clipFrom', 0) - s['pre'], 3))
END = T[-1] + scenes[-1]['duration']
print('clip starts', {c: round(A[c], 2) for c in clips}, 'end', round(END, 2))

# ---- captions (ASS) ----
def ts(x):
    x = max(0, x); h = int(x // 3600); m = int(x % 3600 // 60); s = x % 60
    return f'{h}:{m:02d}:{s:05.2f}'

def chunks(text, maxc=74):
    out = []
    for sent in re.split(r'(?<=[.!?:])\s+', text):          # a sentence ends at punctuation and a space (not 1.7)
        sent = sent.strip()
        if not sent: continue
        while len(sent) > maxc:
            cut = max((m.end() for m in re.finditer(r'[,;] ', sent[:maxc + 1])), default=0)
            if cut < 20:
                cut = sent.rfind(' ', 0, maxc) + 1
            out.append(sent[:cut].strip()); sent = sent[cut:].strip()
        out.append(sent)
    return out

SAY = [('one point seven million', '1.7 million'), ('one and a half million', '1.5 million'), ('twenty-six thousand', '26,000'),
       ('thirty historical storms', '30 historical storms'), ('one-metre', '1-metre'), ('webgpu-demos dot github dot io, slash garita', 'webgpu-demos.github.io/garita')]
for k in paras:
    for a_, b_ in SAY: paras[k] = paras[k].replace(a_, b_)
events = []
for c in clips:
    path = os.path.join(AUDIO, f'{c}.mp3')
    D, sil = cdur[c], silences(path)
    # speech intervals
    speech, last = [], 0.0
    for a, b in sil:
        if a > last + 0.05: speech.append((last, a))
        last = b
    if D > last + 0.05: speech.append((last, D))
    total = sum(b - a for a, b in speech)
    def time_at(frac):           # fraction of the speech -> clip time
        want, acc = frac * total, 0.0
        for a, b in speech:
            if acc + (b - a) >= want: return a + (want - acc)
            acc += b - a
        return D
    parts = chunks(paras[c])
    n = sum(len(p) for p in parts)
    pos, bounds = 0, []
    for p in parts:
        bounds.append((pos / n, (pos + len(p)) / n)); pos += len(p)
    mids = [(a + b) / 2 for a, b in sil]
    def snap(x):
        best = min(mids, key=lambda m: abs(m - x), default=x)
        return best if abs(best - x) < 0.6 else x
    for i, (p, (f0, f1)) in enumerate(zip(parts, bounds)):
        t0 = speech[0][0] if i == 0 else snap(time_at(f0))
        t1 = D if i == len(parts) - 1 else snap(time_at(f1))
        events.append((A[c] + t0, A[c] + t1, p))

W, H = spec['width'], spec['height']
s01, s10 = T[0], T[-1]
url_at = A['10'] + 13.0
ass = [f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Inter SemiBold,40,&H00FFFFFF,&H00FFFFFF,&H90000000,&H90000000,0,0,0,0,100,100,0,0,4,10,0,2,300,300,58,1
Style: Src,Inter Medium,25,&H00F2F2F2,&H00FFFFFF,&H70141010,&H70141010,0,0,0,0,100,100,0.5,0,4,9,0,8,80,80,0,1
Style: Title,Inter Display SemiBold,132,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,26,0,1,0,3,5,80,80,0,1
Style: Sub,Inter,44,&H00E8E8E8,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,1,0,1,0,2,5,80,80,0,1
Style: Url,Inter SemiBold,64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,1,0,1,0,3,5,80,80,0,1
Style: Fine,Inter,34,&H00D8D8D8,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,2,5,80,80,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"""]
# title card over the opening, before the narration starts and as it introduces the name
ass.append(f'Dialogue: 1,{ts(0.25)},{ts(5.6)},Title,,0,0,0,,{{\\fad(700,700)\\pos({W/2},{H/2 - 40})}}GARITA')
ass.append(f'Dialogue: 1,{ts(0.6)},{ts(5.6)},Sub,,0,0,0,,{{\\fad(700,700)\\pos({W/2},{H/2 + 70})}}A live digital twin of Puerto Rico')
# end card
ass.append(f'Dialogue: 1,{ts(url_at)},{ts(END)},Url,,0,0,0,,{{\\fad(600,0)\\pos({W/2},{H/2 - 30})}}webgpu-demos.github.io/garita')
ass.append(f'Dialogue: 1,{ts(url_at + 0.5)},{ts(END)},Fine,,0,0,0,,{{\\fad(600,0)\\pos({W/2},{H/2 + 46})}}Free · public data · a demonstrator, not an official tool')
# data sources of each scene, small, over the sea at the top of the map area
for i, s in enumerate(scenes):
    if not s.get('sources'): continue
    t0 = T[i] + 0.5
    t1 = (T[i + 1] if i + 1 < len(scenes) else END) - 0.2
    x = 795 if 'ui=0' not in s['url'] else W / 2
    y = 124 if 'ui=0' not in s['url'] else 56
    ass.append(f'Dialogue: 1,{ts(t0)},{ts(t1)},Src,,0,0,0,,{{\\fad(400,300)\\an8\\pos({x},{y})}}{s["sources"]}')
for t0, t1, p in events:
    ass.append(f'Dialogue: 0,{ts(t0)},{ts(t1 - 0.02)},Cap,,0,0,0,,{p}')
cap = os.path.join(WORK, 'captions.ass')
open(cap, 'w').write('\n'.join(ass) + '\n')
srt = os.path.join(os.path.dirname(os.path.abspath(OUT)), os.path.splitext(os.path.basename(OUT))[0] + '.srt')
with open(srt, 'w') as f:
    def st(x):
        return f'{int(x // 3600):02d}:{int(x % 3600 // 60):02d}:{int(x % 60):02d},{int(round(x % 1 * 1000)) % 1000:03d}'
    for i, (t0, t1, p) in enumerate(events, 1):
        f.write(f'{i}\n{st(t0)} --> {st(t1)}\n{p}\n\n')

# ---- ffmpeg graph ----
inputs, fil = [], []
for i, s in enumerate(scenes):
    inputs += ['-i', os.path.join(FOOT, s['id'], f"{s['id']}.mp4")]
    L = (T[i + 1] + XF - T[i]) if i + 1 < len(scenes) else s['duration']
    have = dur(os.path.join(FOOT, s['id'], f"{s['id']}.mp4"))
    if have + 1e-3 < L:
        print(f"warning: {s['id']} has {have:.2f} s of footage, needs {L:.2f} s: holding its last frame")
    fil.append(f"[{i}:v]tpad=stop_mode=clone:stop_duration={max(0, L - have) + 0.1:.2f},trim=duration={L:.3f},setpts=PTS-STARTPTS,fps=30,format=yuv420p,settb=AVTB[v{i}]")
prev = 'v0'
for i in range(1, len(scenes)):
    fil.append(f'[{prev}][v{i}]xfade=transition=fade:duration={XF}:offset={T[i]:.3f}[x{i}]')
    prev = f'x{i}'
fil.append(f"[{prev}]fade=t=in:st=0:d=0.8,fade=t=out:st={END - 1.2:.2f}:d=1.2,subtitles='{cap}':fontsdir=/usr/share/fonts/opentype/inter[vout]")
k = len(scenes)
amix = []
for j, c in enumerate(clips):
    inputs += ['-i', os.path.join(AUDIO, f'{c}.mp3')]
    ms = int(round(A[c] * 1000))
    fil.append(f'[{k + j}:a]aresample=48000,adelay={ms}|{ms},apad[a{j}]')
    amix.append(f'[a{j}]')
fil.append(f"{''.join(amix)}amix=inputs={len(clips)}:normalize=0:duration=longest,atrim=duration={END:.3f},loudnorm=I=-16:TP=-1.5:LRA=11[aout]")
graph = os.path.join(WORK, 'graph.txt')
open(graph, 'w').write(';\n'.join(fil))
cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *inputs, '-filter_complex_script', graph, '-map', '[vout]', '-map', '[aout]',
       '-c:v', 'libx264', '-preset', os.environ.get('PRESET', 'slow'), '-crf', '19', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
       '-movflags', '+faststart', '-t', f'{END:.3f}', OUT]
print(' '.join(cmd[:8]), '…')
subprocess.run(cmd, check=True)
print('wrote', OUT, round(dur(OUT), 2), 's;', srt)
