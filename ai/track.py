"""Motion tracking with position, scale and rotation (CapCut's "Tracking", better): corners inside the box picked on one
frame are followed both ways with pyramidal Lucas-Kanade (forward-backward checked), and every frame's similarity
transform (move + scale + turn) is solved from the corners' positions on the PICKED frame (RANSAC, then least squares on
the inliers), so it doesn't drift by adding up frame-to-frame steps. Corners that get lost are replaced from inside the
moved box, mapped back to the picked frame through the inverse transform.
  track.py <video> <t0> <t1> <t> <fps> <x> <y> <w> <h> [dec args as JSON] [vf]
  box = normalized, top-left origin, display orientation, on the frame at t (t0 <= t <= t1)
prints one JSON line per frame {"t","cx","cy","x","y","w","h","s","r","c"} (centre, box around the turned box, scale and
clockwise degrees relative to the picked frame, confidence), then {"lost": [before, after]} (lost
before the range's start / end), progress as {"p"}."""
import json
import math
import re
import subprocess
import sys

import cv2
import numpy as np


def decode(src, t0, t1, fps, dec, vf, side):
    probe = subprocess.run(['ffmpeg', '-hide_banner', '-nostdin', *dec, '-ss', f'{t0:.6f}', '-i', src, '-frames:v', '1', '-vf', f'{vf}showinfo', '-f', 'null', '-'],
                           capture_output=True, text=True).stderr
    w0, h0 = (int(v) for v in re.search(r' s:(\d+)x(\d+)', probe).groups())
    k = min(1.0, side / max(w0, h0))
    W, H = max(16, round(w0 * k / 2) * 2), max(16, round(h0 * k / 2) * 2)
    proc = subprocess.Popen(['ffmpeg', '-v', 'error', '-nostdin', *dec, '-ss', f'{t0:.6f}', '-t', f'{t1 - t0 + 0.5 / fps:.6f}', '-i', src,
                             '-vf', f'{vf}fps={fps},scale={W}:{H}:flags=area', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], stdout=subprocess.PIPE)
    F, n = [], W * H
    while len(buf := proc.stdout.read(n)) == n:
        F.append(np.frombuffer(buf, np.uint8).reshape(H, W))
    proc.wait()
    return F, W, H


def corners(img, poly, near=None):
    """Good corners inside the polygon (a little inside its edge: a drawn box takes some background with it)."""
    c = poly.mean(0)
    inner = (c + (poly - c) * 0.88).astype(np.int32)
    m = np.zeros(img.shape, np.uint8)
    cv2.fillConvexPoly(m, inner, 255)
    if near is not None:  # not on top of the corners already followed
        for p in near:
            cv2.circle(m, (int(p[0]), int(p[1])), 4, 0, -1)
    side = math.sqrt(max(1.0, cv2.contourArea(inner.astype(np.float32))))
    p = cv2.goodFeaturesToTrack(img, 400, 0.005, max(2.0, side / 30), mask=m, blockSize=5)
    return np.zeros((0, 2), np.float32) if p is None else p.reshape(-1, 2).astype(np.float32)


def follow(F, poly):
    """Transforms (2x3, picked frame -> each frame) along F (F[0] = the picked frame) until the target is lost."""
    ref = corners(F[0], poly)
    if len(ref) < 8:
        raise RuntimeError('too little detail in that box to follow: draw it around something with texture or edges')
    n0, cur, A = len(ref), ref.copy(), np.float32([[1, 0, 0], [0, 1, 0]])
    out, lk = [(A, 1.0)], dict(winSize=(21, 21), maxLevel=4, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))
    for i in range(1, len(F)):
        nxt, s1, _ = cv2.calcOpticalFlowPyrLK(F[i - 1], F[i], cur, None, **lk)
        back, s2, _ = cv2.calcOpticalFlowPyrLK(F[i], F[i - 1], nxt, None, **lk)
        ok = (s1.ravel() == 1) & (s2.ravel() == 1) & (np.linalg.norm(back - cur, axis=1) < 0.8)
        ref, cur = ref[ok], nxt[ok]
        if len(ref) < 6:
            break
        B, inl = cv2.estimateAffinePartial2D(ref, cur, method=cv2.RANSAC, ransacReprojThreshold=1.5, maxIters=4000, confidence=0.999, refineIters=20)
        if B is None or inl.sum() < 6:
            break
        inl = inl.ravel() == 1
        ref, cur, A = ref[inl], cur[inl], B.astype(np.float32)
        s = math.hypot(A[0, 0], A[1, 0])
        if not 0.05 < s < 20:
            break
        out.append((A, len(ref) / n0))
        if len(ref) < 0.6 * n0:  # top up from inside the moved box
            q = cv2.transform(poly[None].astype(np.float32), A)[0]
            new = corners(F[i], q, cur)
            if len(new):
                inv = cv2.invertAffineTransform(A)
                ref = np.vstack([ref, cv2.transform(new[None], inv)[0]])
                cur = np.vstack([cur, new])
    return out


def main(src, t0, t1, t, fps, x, y, w, h, dec='[]', vf=''):
    t0, t1, t, fps = float(t0), float(t1), float(t), float(fps)
    F, W, H = decode(src, t0, t1, fps, json.loads(dec), vf, 960 if (t1 - t0) * fps < 900 else 640)  # ponytail: long ranges track at 640 px (memory)
    if not F:
        raise RuntimeError('could not read the clip')
    k = min(len(F) - 1, max(0, round((t - t0) * fps)))
    bx, by, bw, bh = float(x) * W, float(y) * H, float(w) * W, float(h) * H
    poly = np.float32([[bx, by], [bx + bw, by], [bx + bw, by + bh], [bx, by + bh]])
    c0 = poly.mean(0)
    fwd = follow(F[k:], poly)
    print(json.dumps({'p': 0.5}), flush=True)
    bwd = follow(F[k::-1], poly)
    rows = [(k - i, a) for i, a in reversed(list(enumerate(bwd)))][:-1] + [(k + i, a) for i, a in enumerate(fwd)]
    last = None
    for j, (A, conf) in rows:
        q = cv2.transform(poly[None], A)[0]
        cx, cy = A @ np.float32([c0[0], c0[1], 1])
        r = math.degrees(math.atan2(A[1, 0], A[0, 0]))
        if last is not None:  # no jump at +-180: a target turning past it keeps turning
            r += 360 * round((last - r) / 360)
        last = r
        x0, y0 = q.min(0)
        x1, y1 = q.max(0)
        print(json.dumps({'t': round(t0 + j / fps, 5), 'cx': round(float(cx) / W, 5), 'cy': round(float(cy) / H, 5), 'x': round(float(x0) / W, 5), 'y': round(float(y0) / H, 5),
                          'w': round(float(x1 - x0) / W, 5), 'h': round(float(y1 - y0) / H, 5), 's': round(math.hypot(A[0, 0], A[1, 0]), 5), 'r': round(r, 3), 'c': round(conf, 3)}))
    print(json.dumps({'lost': [len(bwd) < k + 1, len(fwd) < len(F) - k]}), flush=True)


if __name__ == '__main__':
    try:
        main(*sys.argv[1:])
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
