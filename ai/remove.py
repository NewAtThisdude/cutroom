"""Cutroom object removal (CapCut's "Remove object"), on this Mac with OpenCV + numpy: no model, nothing uploaded.

  remove.py job.json      prints 'progress <0..1>' lines, writes job['out'] (the range's video + audio)

job: src, out, t0, dur, fps, w, h (display size), boxes ([x, y, w, h] normalized, one per output frame),
     dec (ffmpeg input args), vf (decode filters ending in ','), tags (output colour args)

Every frame's hole (the tracked box, padded) is filled with the background from the nearest frames that show it,
aligned for camera motion (corner flow -> homography). What no frame ever shows (a static object in a locked-off
shot) is synthesized once from the surrounding texture (exemplar inpainting) and carried through the shot with the
same alignment, so it does not flicker. Poisson blending hides exposure differences at the edge.
Limits: strong parallax or an object over moving texture (water, crowds) leaves soft or ghosted patches.
"""
import json
import subprocess
import sys

import cv2
import numpy as np

OFFSETS = [o for d in [*range(1, 11), 12, 15, 19, 24, 30, 38, 48, 60, 75, 95, 120, 150, 190, 240, 300] for o in (d, -d)]


def say(p):
    print(f'progress {min(1.0, max(0.0, p)):.3f}', flush=True)


def frames(job, tail, w, h, planes):
    """Decoded frames of the range from an ffmpeg pipe: yuv444p -> (h, w, 3), gray -> (h, w)."""
    cmd = ['ffmpeg', '-v', 'error', *job['dec'], '-ss', f"{job['t0']:.6f}", '-t', f"{job['dur']:.6f}", '-i', job['src'],
           '-vf', f"{job['vf']}fps={job['fps']},{tail}", '-f', 'rawvideo', '-pix_fmt', 'gray' if planes == 1 else 'yuv444p', '-']
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    n = w * h * planes
    try:
        while len(buf := proc.stdout.read(n)) == n:
            a = np.frombuffer(buf, np.uint8)
            yield a.reshape(h, w) if planes == 1 else a.reshape(3, h, w).transpose(1, 2, 0)
    finally:
        proc.stdout.close()
        proc.wait()


def rects(job, n):
    """Per frame: the object's box in display pixels, padded for edges and motion blur."""
    W, H, out = job['w'], job['h'], []
    for i in range(n):
        x, y, w, h = job['boxes'][min(i, len(job['boxes']) - 1)]
        pad = 0.08 * max(w * W, h * H) + 6
        out.append((max(0, x * W - pad), max(0, y * H - pad), min(W, (x + w) * W + pad), min(H, (y + h) * H + pad)))
    return out


def motion(grays, holes):
    """A[i] maps frame-0 coordinates to frame-i (camera motion from background corners; identity when unsure)."""
    A, prev = [np.eye(3)], None
    for i, g in enumerate(grays):
        if prev is not None:
            Hm = np.eye(3)
            p0 = cv2.goodFeaturesToTrack(prev, 400, 0.01, 8, mask=np.where(holes[i - 1], 0, 255).astype(np.uint8))
            if p0 is not None and len(p0) >= 12:
                p1, ok, _ = cv2.calcOpticalFlowPyrLK(prev, g, p0, None, winSize=(21, 21), maxLevel=3)
                ok = ok.ravel() == 1
                if ok.sum() >= 12:
                    H, inl = cv2.findHomography(p0[ok], p1[ok], cv2.RANSAC, 2.0)
                    if H is not None and inl.sum() >= 10 and abs(np.linalg.det(H[:2, :2]) - 1) < 0.3 and np.abs(H[2, :2]).max() < 2e-3:
                        Hm = H
            A.append(Hm @ A[-1])
        prev = g
    return A


def synthesize(img, hole):
    """Exemplar inpainting (Criminisi, Perez & Toyama 2004): fill from the edge inward, the most confident /
    strongest-structure point first, each time copying the best-matching fully known patch (masked matchTemplate).
    Works on BGR (matching in YUV under-weights colour and picks wrong-coloured patches); 9-13 px patches: smaller
    ones lose edges in noise, bigger ones paste visible chunks."""
    img, hole = img.copy(), hole.copy()
    Hh, Ww = hole.shape
    ys, xs = np.nonzero(hole)
    size = max(np.ptp(ys), np.ptp(xs)) + 1
    p = int(np.clip(size // 24, 4, 6))
    k = 2 * p + 1
    if Hh < k + 2 or Ww < k + 2:
        return cv2.inpaint(img, hole.astype(np.uint8), 3, cv2.INPAINT_TELEA)
    R = int(max(4 * k, 0.75 * size))
    work = cv2.inpaint(img, hole.astype(np.uint8), 3, cv2.INPAINT_TELEA)  # rough fill: lets the structure term see edges
    conf = (~hole).astype(np.float32)
    ones = np.ones((3, 3), np.uint8)
    while hole.any():
        ys, xs = np.nonzero(hole)  # priorities only around what is left
        a0, b0 = max(0, ys.min() - k), max(0, xs.min() - k)
        a1, b1 = min(Hh, ys.max() + k + 1), min(Ww, xs.max() + k + 1)
        hb = hole[a0:a1, b0:b1]
        front = hb & (cv2.dilate((~hb).astype(np.uint8), ones) > 0)
        fy, fx = np.nonzero(front)
        C = cv2.boxFilter(conf[a0:a1, b0:b1], -1, (k, k))[fy, fx]
        g, hm = work[a0:a1, b0:b1, 0].astype(np.float32), hb.astype(np.float32)
        gx, gy = cv2.Sobel(g, cv2.CV_32F, 1, 0)[fy, fx], cv2.Sobel(g, cv2.CV_32F, 0, 1)[fy, fx]
        nx, ny = cv2.Sobel(hm, cv2.CV_32F, 1, 0)[fy, fx], cv2.Sobel(hm, cv2.CV_32F, 0, 1)[fy, fx]
        D = np.abs(gx * ny - gy * nx) / (np.hypot(nx, ny) + 1e-6) / 255.0  # isophote across the front normal
        i = int(np.argmax(C * (D + 0.05)))
        y0, x0 = min(max(a0 + fy[i] - p, 0), Hh - k), min(max(b0 + fx[i] - p, 0), Ww - k)
        th = hole[y0:y0 + k, x0:x0 + k].copy()
        for r in (R, max(Hh, Ww)):  # nearby first, then anywhere
            sy0, sx0, sy1, sx1 = max(0, y0 - r), max(0, x0 - r), min(Hh, y0 + k + r), min(Ww, x0 + k + r)
            res = cv2.matchTemplate(img[sy0:sy1, sx0:sx1], img[y0:y0 + k, x0:x0 + k], cv2.TM_SQDIFF, mask=(~th).astype(np.uint8))
            bad = cv2.boxFilter(hole[sy0:sy1, sx0:sx1].astype(np.float32), -1, (k, k), anchor=(0, 0), normalize=False,
                                borderType=cv2.BORDER_CONSTANT)[:res.shape[0], :res.shape[1]] > 0  # sources must be fully known
            res[bad] = np.inf
            j = int(np.argmin(res))
            if np.isfinite(res.flat[j]):
                break
        else:  # nothing known to copy from: smooth fill the rest
            return cv2.inpaint(img, hole.astype(np.uint8), 3, cv2.INPAINT_TELEA)
        my, mx = divmod(j, res.shape[1])
        src = img[sy0 + my:sy0 + my + k, sx0 + mx:sx0 + mx + k].copy()
        img[y0:y0 + k, x0:x0 + k][th] = src[th]
        work[y0:y0 + k, x0:x0 + k][th] = src[th]
        conf[y0:y0 + k, x0:x0 + k][th] = C[i]
        hole[y0:y0 + k, x0:x0 + k][th] = False
    return img


def main(path):
    job = json.load(open(path))
    W, H, fps = job['w'], job['h'], job['fps']
    n = max(1, len(job['boxes']))
    rs = rects(job, n)
    # crop: every box plus context; scaled down only when the clip would not fit in ~1.5 GB
    x0, y0 = min(r[0] for r in rs), min(r[1] for r in rs)
    x1, y1 = max(r[2] for r in rs), max(r[3] for r in rs)
    big = max(max(r[2] - r[0], r[3] - r[1]) for r in rs)
    m = max(96, 1.5 * big)  # context: texture to synthesize from, and room for camera moves to reveal the background
    x0, y0 = int(max(0, x0 - m)) // 2 * 2, int(max(0, y0 - m)) // 2 * 2
    x1, y1 = min(W, int(x1 + m + 1)), min(H, int(y1 + m + 1))
    cw, ch = (x1 - x0) // 2 * 2, (y1 - y0) // 2 * 2
    s = min(1.0, (1.5e9 / (n * cw * ch * 3)) ** 0.5)
    sw, sh = max(2, int(cw * s) // 2 * 2), max(2, int(ch * s) // 2 * 2)
    sx, sy = sw / cw, sh / ch

    # 1. camera motion on small grey frames of the whole picture
    gw = min(W, 640) // 2 * 2
    gh = max(2, round(H * gw / W / 2) * 2)
    kx, ky = W / gw, H / gh
    small = []
    for (a, b, c, d) in rs:
        hm = np.zeros((gh, gw), bool)
        hm[int(b / ky):int(np.ceil(d / ky)), int(a / kx):int(np.ceil(c / kx))] = True
        small.append(hm)
    grays = list(frames(job, f'scale={gw}:{gh},format=gray', gw, gh, 1))
    n = min(n, len(grays))
    A = motion(grays[:n], small)
    say(0.15)
    M = np.array([[sx * kx, 0, -sx * x0], [0, sy * ky, -sy * y0], [0, 0, 1]])  # small-frame -> crop coordinates
    Mi, Ai = np.linalg.inv(M), [np.linalg.inv(a) for a in A]

    def warp_to(s_, t):  # crop coords of frame s -> crop coords of frame t
        return M @ A[t] @ Ai[s_] @ Mi

    # 2. the crops and holes
    tail = f'crop={cw}:{ch}:{x0}:{y0}' + (f',scale={sw}:{sh}:flags=area' if (sw, sh) != (cw, ch) else '') + ',format=yuv444p'
    F = np.stack([f for f, _ in zip(frames(job, tail, sw, sh, 3), range(n))])
    n = len(F)
    holes = np.zeros((n, sh, sw), bool)
    for i, (a, b, c, d) in enumerate(rs[:n]):
        holes[i, max(0, int((b - y0) * sy)):int(np.ceil((d - y0) * sy)), max(0, int((a - x0) * sx)):int(np.ceil((c - x0) * sx))] = True
    blocked = np.stack([cv2.dilate(h.astype(np.uint8) * 255, np.ones((3, 3), np.uint8)) for h in holes])  # never copy the object's edge
    say(0.25)

    # 3. fill each hole from the nearest frames that show that background (aligned)
    filled, left = F.copy(), np.zeros_like(holes)
    for t in range(n):
        if not holes[t].any():
            continue
        ys, xs = np.nonzero(holes[t])
        bx0, by0, bx1, by1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
        Tb = np.array([[1, 0, -bx0], [0, 1, -by0], [0, 0, 1]], float)
        sub, out = holes[t, by0:by1, bx0:bx1].copy(), filled[t, by0:by1, bx0:bx1]
        for o in OFFSETS:
            s_ = t + o
            if not 0 <= s_ < n:
                continue
            Hw = Tb @ warp_to(s_, t)
            wm = cv2.warpPerspective(blocked[s_], Hw, (bx1 - bx0, by1 - by0), flags=cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT, borderValue=255)
            take = sub & (wm == 0)
            if take.any():
                wf = cv2.warpPerspective(F[s_], Hw, (bx1 - bx0, by1 - by0), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
                out[take] = wf[take]
                sub &= ~take
                if not sub.any():
                    break
        left[t, by0:by1, bx0:bx1] = sub
        say(0.25 + 0.45 * (t + 1) / n)

    # 4. what no frame shows: synthesize it once on the frame missing the most, carry it through the shot
    rem = left.reshape(n, -1).sum(1)
    if rem.any():
        r = int(rem.argmax())
        ys, xs = np.nonzero(left[r])
        g = 2 * (int(max(np.ptp(ys), np.ptp(xs))) + 40)
        wy0, wx0, wy1, wx1 = max(0, ys.min() - g), max(0, xs.min() - g), min(sh, ys.max() + 1 + g), min(sw, xs.max() + 1 + g)
        ref = filled[r].copy()
        lw = left[r, wy0:wy1, wx0:wx1]
        syn = synthesize(cv2.cvtColor(filled[r, wy0:wy1, wx0:wx1], cv2.COLOR_YUV2BGR), lw)
        ref[wy0:wy1, wx0:wx1][lw] = cv2.cvtColor(syn, cv2.COLOR_BGR2YUV)[lw]
        ones = np.full((sh, sw), 255, np.uint8)
        for t in np.nonzero(rem)[0]:
            Hw = warp_to(r, t)
            wf = cv2.warpPerspective(ref, Hw, (sw, sh), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            ok = cv2.warpPerspective(ones, Hw, (sw, sh), flags=cv2.INTER_NEAREST, borderValue=0) > 0
            take = left[t] & ok
            filled[t][take] = wf[take]
            if (rest := left[t] & ~ok).any():
                filled[t] = cv2.inpaint(filled[t], rest.astype(np.uint8), 5, cv2.INPAINT_TELEA)
    say(0.8)

    # 5. Poisson blend into each frame, then write the full frames back out
    k5 = np.ones((5, 5), np.uint8)
    alpha = np.zeros((n, sh, sw), np.uint8)
    for t in range(n):
        if holes[t].any():
            mm = cv2.dilate(holes[t].astype(np.uint8) * 255, k5)
            bx, by, bw, bh = cv2.boundingRect(mm)
            filled[t] = cv2.seamlessClone(filled[t], F[t], mm.copy(), (bx + bw // 2, by + bh // 2), cv2.NORMAL_CLONE)  # it overwrites its mask
            alpha[t] = mm
    del F
    enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'yuv444p', '-s', f'{W}x{H}', '-r', f'{fps}', '-i', '-',
                            '-ss', f"{job['t0']:.6f}", '-t', f"{job['dur']:.6f}", '-i', job['src'], '-map', '0:v', '-map', '1:a?',
                            '-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-pix_fmt', 'yuv420p', *job['tags'],
                            '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', job['out']], stdin=subprocess.PIPE)
    for t, fr in enumerate(frames(job, 'format=yuv444p', W, H, 3)):
        fr = fr.copy()
        if t < n and alpha[t].any():
            patch, a = filled[t], alpha[t]
            if (sw, sh) != (cw, ch):  # worked at a reduced scale: blend the upscaled fill in softly
                patch = cv2.resize(patch, (cw, ch), interpolation=cv2.INTER_CUBIC)
                a = cv2.GaussianBlur(cv2.resize(a, (cw, ch), interpolation=cv2.INTER_LINEAR), (0, 0), 2)
            reg = fr[y0:y0 + ch, x0:x0 + cw]
            w8 = (a.astype(np.float32) / 255)[..., None]
            reg[:] = (reg * (1 - w8) + patch * w8 + 0.5).astype(np.uint8)
        enc.stdin.write(np.ascontiguousarray(fr.transpose(2, 0, 1)).tobytes())
        if t % 15 == 0:
            say(0.8 + 0.2 * min(1, (t + 1) / n))
    enc.stdin.close()
    if enc.wait():
        sys.exit('encoding the cleaned clip failed')
    say(1)


if __name__ == '__main__':
    main(sys.argv[1])
