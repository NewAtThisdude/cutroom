"""Ground truth for tests/tracking.mjs. Run with the AI venv's python (numpy, OpenCV).
  track_truth.py synth <out.mp4>                -> a textured patch that moves, grows 1 -> 2 and turns 0 -> 45 degrees over a
                                                   background with detail of its own; JSON: size, fps, per-frame truth [cx, cy, scale, deg] (px)
  track_truth.py blur <export> <synth.json>     -> per frame: is the patch's inside blurred in the export (fine detail gone),
                                                   and is the ring around it still sharp
  track_truth.py faces <export> <src> <faces.json> -> the same for each face Vision found on the source (faces.json = its 'all' lines)
  track_truth.py alpha <cutout.webm>            -> per frame the centre of the cutout's alpha (normalized), or null
  track_truth.py fox <home>                     -> per frame the centre of the fox in fox-walk.mp4 (its clean plate = talk-with-music.mp4)"""
import json
import math
import subprocess
import sys
from fractions import Fraction

import cv2
import numpy as np

W, H, FPS, N, P = 1280, 720, 30, 120, 160


def synth(out):
    rng = np.random.default_rng(7)
    bg = cv2.GaussianBlur(rng.integers(0, 255, (H, W, 3), dtype=np.uint8), (0, 0), 9)
    bg = cv2.normalize(bg, None, 60, 190, cv2.NORM_MINMAX)
    patch = cv2.GaussianBlur(rng.integers(0, 255, (P, P, 3), dtype=np.uint8), (0, 0), 2.2)
    patch = cv2.normalize(patch, None, 0, 255, cv2.NORM_MINMAX)
    cv2.rectangle(patch, (0, 0), (P - 1, P - 1), (255, 255, 255), 3)
    enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                            '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', out], stdin=subprocess.PIPE)
    truth = []
    for i in range(N):
        u = i / (N - 1)
        cx, cy, s, a = 380 + 520 * u, 380 - 60 * math.sin(math.pi * u), 1 + u, 45 * u
        M = cv2.getRotationMatrix2D((P / 2, P / 2), -a, s)  # OpenCV's angle is counter-clockwise: -a turns it clockwise on screen
        M[:, 2] += (cx - P / 2, cy - P / 2)
        f = bg.copy()
        cv2.warpAffine(patch, M, (W, H), dst=f, borderMode=cv2.BORDER_TRANSPARENT, flags=cv2.INTER_LINEAR)
        enc.stdin.write(f.tobytes())
        truth.append([round(cx, 3), round(cy, 3), round(s, 5), round(a, 4)])
    enc.stdin.close()
    enc.wait()
    return {'w': W, 'h': H, 'fps': FPS, 'frames': N, 'truth': truth, 'box': [380 - P / 2, 380 - P / 2, P, P]}


def probe(f):
    s = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', f],
                                  capture_output=True, text=True).stdout)['streams'][0]
    return s['width'], s['height'], float(Fraction(s['r_frame_rate']))


def gray(f, w, h, n=100000):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', f, '-frames:v', str(n), '-vf', f'scale={w}:{h}:flags=area,format=gray', '-f', 'rawvideo', '-'],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w).astype(np.float32)


def detail(img):
    return img - cv2.GaussianBlur(img, (0, 0), 2.5)


def corr(a, b, m):
    """Correlation of two pictures' fine detail inside mask m: ~1 = the same detail, ~0 = blurred / mosaic away."""
    a, b = detail(a)[m], detail(b)[m]
    a, b = a - a.mean(), b - b.mean()
    return float((a * b).sum() / math.sqrt(max(1e-9, (a * a).sum() * (b * b).sum())))


def poly_mask(pts, shape):
    m = np.zeros(shape, np.uint8)
    cv2.fillConvexPoly(m, np.round(pts).astype(np.int32), 1)
    return m > 0


def blur(export, sj):
    T = json.load(open(sj))
    src, exp = gray(sj.replace('.json', '.mp4'), W, H), gray(export, W, H)
    out = []
    for i, (cx, cy, s, a) in enumerate(T['truth'][:min(len(src), len(exp))]):
        r = math.radians(a)
        sq = lambda k: np.float32([[cx + k * s * P / 2 * (x * math.cos(r) - y * math.sin(r)), cy + k * s * P / 2 * (x * math.sin(r) + y * math.cos(r))]
                                   for x, y in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
        inner, ring = poly_mask(sq(0.8), (H, W)), poly_mask(sq(2.4), (H, W)) & ~poly_mask(sq(2.0), (H, W))  # ring: past the padded, turned box's corners
        out.append([round(corr(exp[i], src[i], inner), 3), round(corr(exp[i], src[i], ring), 3)])
    return {'frames': len(out), 'inside': [q[0] for q in out], 'ring': [q[1] for q in out], 'on': sum(q[0] < 0.3 for q in out) / max(1, len(out))}


def faces(export, srcf, fj):
    rows = [json.loads(line) for line in open(fj) if line.strip()]
    w, h, fps = probe(srcf)
    src, exp = gray(srcf, w, h), gray(export, w, h)
    res = []
    for r in rows:
        i = round(r['t'] * fps)
        if i >= min(len(src), len(exp)):
            continue
        for x, y, bw, bh in r['f']:
            x0, y0, x1, y1 = (x + 0.2 * bw) * w, (y + 0.2 * bh) * h, (x + 0.8 * bw) * w, (y + 0.8 * bh) * h  # the middle of the face
            res.append(round(corr(exp[i], src[i], poly_mask(np.float32([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]), (h, w))), 3))
    return {'faces': len(res), 'inside': res, 'on': sum(q < 0.3 for q in res) / max(1, len(res))}


def alpha(f):
    w, h, _ = probe(f)
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-c:v', 'libvpx-vp9', '-i', f, '-vf', 'alphaextract,format=gray', '-f', 'rawvideo', '-'], capture_output=True, check=True).stdout
    out = []
    for a in np.frombuffer(raw, np.uint8).reshape(-1, h, w):
        ys, xs = np.nonzero(a > 128)
        out.append([round(float(xs.mean()) / w, 4), round(float(ys.mean()) / h, 4)] if len(xs) > 30 else None)
    return {'centres': out}


def fox(home):
    a, b = gray(f'{home}/media/87cf24520932.mp4', 1280, 720), gray(f'{home}/media/d83ef70ebbad.mp4', 1280, 720)
    out = []
    for x, y in zip(a, b):
        m = cv2.morphologyEx((np.abs(x - y) > 30).astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        ys, xs = np.nonzero(m)
        out.append([round(float(xs.mean()) / 1280, 4), round(float(ys.mean()) / 720, 4)] if len(xs) > 30 else None)
    return {'centres': out}


if __name__ == '__main__':
    print(json.dumps({'synth': synth, 'blur': blur, 'faces': faces, 'alpha': alpha, 'fox': fox}[sys.argv[1]](*sys.argv[2:])))
