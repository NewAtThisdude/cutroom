"""server.py beats() in numpy (the AI venv): 16-bit 8 kHz mono on stdin -> {"bpm", "beats"} JSON on stdout.
The same algorithm and, where the order of a float sum could matter, the same scalar maths (math.log1p, math.log,
statistics.pstdev): only the 43 tempo autocorrelations are numpy dot products, so the grid matches the stdlib loops
(tests/audio_packs.mjs compares both on the same bytes). The dynamic programme runs period // 2 frames per step: no
frame's best previous beat lies within period // 2 of it, so a whole block depends only on scores already made."""
import json
import math
import statistics
import sys
import threading

# read while numpy loads: a pipe holds 64 KB, so the writer would otherwise wait out the import
raw = []
rd = threading.Thread(target=lambda: raw.append(sys.stdin.buffer.read()))
rd.start()
import numpy as np  # noqa: E402
rd.join()
sr, hop = 8000, 128
x = np.frombuffer(raw[0][:len(raw[0]) // 2 * 2], dtype='<i2')
n, fps = len(x) // hop, sr / hop
if n < fps * 4:
    print(json.dumps({'error': 'need at least 4 seconds of audio'}))
    sys.exit()
e = x[:n * hop].astype(np.int64).reshape(n, hop)
env = [math.log1p(v / hop / 1e4) for v in (e * e).sum(1).tolist()]  # int sums, exact; the scalar log1p
on = [0.0] + [max(0.0, b - a) for a, b in zip(env, env[1:])]
sd = statistics.pstdev(on) or 1.0
on = np.array(on) / sd
prior = lambda L: math.exp(-0.5 * math.log2(60 * fps / L / 120) ** 2)
lags = range(int(60 * fps / 180), int(60 * fps / 60) + 1)
ac = [prior(L) * float(np.dot(on[L:], on[:n - L])) for L in lags]
period = lags[ac.index(max(ac))]  # the first maximum, as max(key=) kept
P, h = 2 * period, period // 2
W = P - h  # candidates t - P .. t - h - 1
pen = np.array([100 * math.log(d / period) ** 2 for d in range(P, h, -1)])
score = np.concatenate([np.full(P, -np.inf), on])  # score[P + i] is frame i; -inf before the song never wins
back = np.full(n, -1)
win = np.lib.stride_tricks.sliding_window_view(score, W)  # a view: rows see the scores written below
for b in range(h + 1, n, h):  # frames <= h have no previous beat
    t = np.arange(b, min(b + h, n))
    v = win[t] - pen  # row for frame t starts at score index t, i.e. frame t - P
    k = v.argmax(1)  # the first maximum, as the strict > kept
    score[P + t] = on[t] + v.max(1)
    back[t] = t - P + k
s = max(0, n - period)
t = s + int(score[P + s:].argmax())
grid = []
while t >= 0:
    grid.append(t)
    t = int(back[t])
print(json.dumps({'bpm': round(60 * fps / period, 1), 'beats': [round(i / fps, 3) for i in reversed(grid)]}))
