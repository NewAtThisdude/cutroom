"""Multicam sync: line several recordings of the same moment up by their sound.

    python sync.py file0 file1 [file2 ...]   ->  JSON {"offsets": [0, d1, d2, ...], "confidence": [...]}

offset k = (time in file k) - (time in file 0) for the same moment. Onset envelopes (10 ms energy rises) are
GCC-PHAT on the samples (whitened cross-spectrum: one sharp peak even with different mics), refined with a
parabola; onset envelopes cross-correlated as the fallback. Within a sample or two on speech or music.
Reads at most the first 10 minutes of each file, mono 8 kHz."""
import json, subprocess, sys

import numpy as np

SR, HOP, MAXS = 8000, 80, 600


def load(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-i', path, '-t', str(MAXS), '-vn', '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'],
                         capture_output=True, check=True).stdout
    x = np.frombuffer(raw, np.float32)
    if len(x) < SR:
        raise ValueError(f'{path}: under a second of sound')
    return x


def envelope(x):
    n = len(x) // HOP
    e = np.log1p(1000 * (x[:n * HOP].reshape(n, HOP) ** 2).mean(1))
    d = np.maximum(0, np.diff(e, prepend=e[0]))  # energy rises: claps, consonants, beats
    return (d - d.mean()) / (d.std() + 1e-9)


def lag(a, b):  # how many frames later b's events come than a's (and how sure)
    n = 1 << int(np.ceil(np.log2(len(a) + len(b))))
    c = np.fft.irfft(np.fft.rfft(b, n) * np.conj(np.fft.rfft(a, n)), n)
    c = np.concatenate([c[-(len(a) - 1):], c[:len(b)]])  # lags -(len(a)-1) .. len(b)-1
    i = int(np.argmax(c))
    y0, y1, y2 = c[max(i - 1, 0)], c[i], c[min(i + 1, len(c) - 1)]
    den = y0 - 2 * y1 + y2
    frac = 0.5 * (y0 - y2) / den if den else 0.0
    conf = float((y1 - np.median(c)) / (np.std(c) + 1e-9))
    return i - (len(a) - 1) + frac, conf


def phat(a, b):  # GCC-PHAT on the samples: whitened cross-spectrum, one sharp peak at the delay even across different mics
    n = 1 << int(np.ceil(np.log2(len(a) + len(b))))
    X = np.fft.rfft(b, n) * np.conj(np.fft.rfft(a, n))
    c = np.fft.irfft(X / (np.abs(X) + 1e-12), n)
    c = np.concatenate([c[-(len(a) - 1):], c[:len(b)]])
    i = int(np.argmax(c))
    y0, y1, y2 = c[max(i - 1, 0)], c[i], c[min(i + 1, len(c) - 1)]
    den = y0 - 2 * y1 + y2
    frac = 0.5 * (y0 - y2) / den if den else 0.0
    return (i - (len(a) - 1) + frac) / SR, float((y1 - np.median(c)) / (np.std(c) + 1e-12))


def main(paths):
    sig = [load(p) for p in paths]
    env = [envelope(x) for x in sig]
    offs, conf = [0.0], [None]
    for x, e in zip(sig[1:], env[1:]):
        d, cf = phat(sig[0], x)  # the delay from the samples; the onset envelopes only as a fallback when PHAT finds no clear peak
        if cf < 8:
            lg, cf = lag(env[0], e)
            d = float(lg) * HOP / SR
        offs.append(round(float(d), 4))
        conf.append(round(cf, 1))
    print(json.dumps({'offsets': offs, 'confidence': conf}))


if __name__ == '__main__':
    main(sys.argv[1:])
