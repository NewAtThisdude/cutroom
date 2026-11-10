"""Voice characters that move the pitch and the formants apart (WORLD vocoder, pyworld): elf, giant, monster, alien.

  python -I voicefx.py <character> <in.pcm> <out.pcm>

in: raw 16-bit 48 kHz stereo (Cutroom's preview PCM); out: raw float32 48 kHz stereo, the input's length (server.py
sets its level). The voice is analysed at 24 kHz in mono (a character's detail is below 12 kHz, and it halves the time),
re-synthesised with its pitch times `f0` and its spectral envelope stretched by `formant` (> 1 = a smaller head, < 1 =
a bigger one), and written in both channels. WORLD's frames are centred on their times, so the result is not delayed.
"""
import sys, types
import numpy as np
# pyworld 0.3.5's __init__ only asks pkg_resources (setuptools, not in the venv) for its own version number
sys.modules.setdefault('pkg_resources', types.SimpleNamespace(get_distribution=lambda name: types.SimpleNamespace(version='0.3.5')))
import pyworld as pw
from scipy.signal import resample_poly

CHARS = {  # f0 ratio, formant ratio, vibrato (Hz, depth as a ratio), growl (tanh drive), ring modulation Hz (0 = off)
    'elf': (1.65, 1.2, (0, 0), 0, 0),
    'giant': (0.6, 0.8, (0, 0), 0, 0),
    'monster': (0.5, 0.72, (0, 0), 3.0, 0),
    'alien': (1.25, 1.12, (7.0, 0.12), 0, 38),
}
SR, FP = 24000, 5.0  # analysis rate, frame period (ms)


def character(x, name):
    f0r, fr, (vf, vd), growl, ring = CHARS[name]
    x = np.ascontiguousarray(x, dtype=np.float64)
    f0, t = pw.dio(x, SR, frame_period=FP)
    f0 = pw.stonemask(x, f0, t, SR)
    sp = pw.cheaptrick(x, f0, t, SR)
    ap = pw.d4c(x, f0, t, SR)
    f0 = f0 * f0r * (1 + vd * np.sin(2 * np.pi * vf * t) if vd else 1)
    bins = np.arange(sp.shape[1], dtype=np.float64)
    src = np.clip(bins / fr, 0, sp.shape[1] - 1)  # new envelope at bin k = the old one at k / fr
    lo = src.astype(int)
    hi = np.minimum(lo + 1, sp.shape[1] - 1)
    w = src - lo
    sp = sp[:, lo] * (1 - w) + sp[:, hi] * w
    y = pw.synthesize(f0, np.ascontiguousarray(sp), ap, SR, FP)[:len(x)]
    y = np.pad(y, (0, len(x) - len(y)))
    if growl:
        y = np.tanh(growl * y / (np.abs(y).max() + 1e-9)) * np.abs(y).max()
    if ring:
        y = 0.5 * y + 0.5 * y * np.sin(2 * np.pi * ring * np.arange(len(y)) / SR)
    return y


def main(name, src, dst):
    a = np.fromfile(src, dtype='<i2').reshape(-1, 2).astype(np.float64) / 32768
    n = len(a)
    mono = resample_poly(a.mean(axis=1), 1, 2)
    y = resample_poly(character(mono, name), 2, 1)[:n]
    y = np.pad(y, (0, n - len(y)))
    np.repeat(y.astype('<f4')[:, None], 2, axis=1).tofile(dst)


if __name__ == '__main__':
    if len(sys.argv) != 4 or sys.argv[1] not in CHARS:
        sys.exit(f'usage: voicefx.py {"|".join(CHARS)} in.pcm out.pcm')
    main(*sys.argv[1:])
