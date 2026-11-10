"""Cutroom face and body retouch (CapCut's Retouch: smooth skin, eyes, teeth, makeup, face shape, body), on this Mac.

  retouch.py job.json      prints 'progress <0..1>' lines, writes job['out'] (video + sound, or a PNG for one frame)

job: src, out, t0, dur, fps, w, h (display size), dec (ffmpeg input args), vf (decode filters ending in ','), tags (output
     colour args), mat ('709' | '601'), p (the sliders, P0), lm (landmark lines from tools/retouch: one per frame, every
     face and body), still (one frame at t0 -> PNG of at most job['max'] px), detect (tools/retouch, for a still with no lm yet)

Landmarks are followed per face across frames, gaps filled, and smoothed forwards and backwards with a One-Euro filter
(steady on a still head, no lag on a moving one). Colour work (skin, eyes, teeth, lips, blush) happens in RGB inside
masks drawn from the landmarks; only the changed pixels' YUV moves. The shape work is one backward warp per face: the
contour points' moves spread by normalized Gaussians, pinned at the eyes, nose and mouth, plus radial scaling for the
eyes and nose. The body: a sideways squeeze toward the body's axis below the shoulders, and the rows below the hips stretched.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np

P0 = {'smooth': 0, 'bright': 0, 'eyes': 0, 'teeth': 0, 'slim': 0, 'width': 0, 'cheek': 0, 'jaw': 0, 'chin': 0, 'nose': 0,
      'lips': 0, 'lipc': '#b8283f', 'blush': 0, 'blushc': '#f2647a', 'body': 0, 'legs': 0}
REGIONS = ['contour', 'leye', 'reye', 'lbrow', 'rbrow', 'nose', 'crest', 'median', 'olips', 'ilips', 'lpupil', 'rpupil']
JOINTS = ['neck_1_joint', 'left_shoulder_1_joint', 'right_shoulder_1_joint', 'root', 'left_upLeg_joint', 'right_upLeg_joint',
          'left_leg_joint', 'right_leg_joint', 'left_foot_joint', 'right_foot_joint']
MATS = {'709': (0.2126, 0.0722), '601': (0.299, 0.114)}


def say(p):
    print(f'progress {min(1.0, max(0.0, p)):.3f}', flush=True)


def ss(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


# ---- colour: limited-range YCbCr <-> RGB 0..1, the matrix the file is labelled with ----
def yuv2rgb(yuv, mat):
    kr, kb = MATS[mat]
    kg = 1 - kr - kb
    y = (yuv[..., 0].astype(np.float32) - 16) / 219
    cb = (yuv[..., 1].astype(np.float32) - 128) / 224
    cr = (yuv[..., 2].astype(np.float32) - 128) / 224
    r = y + 2 * (1 - kr) * cr
    b = y + 2 * (1 - kb) * cb
    g = (y - kr * r - kb * b) / kg
    return np.stack([r, g, b], -1)


def rgb2yuv_delta(d, mat):
    """The YCbCr change (8-bit levels) for an RGB change: linear, so an unchanged pixel keeps its exact value."""
    kr, kb = MATS[mat]
    kg = 1 - kr - kb
    y = kr * d[..., 0] + kg * d[..., 1] + kb * d[..., 2]
    return np.stack([219 * y, 224 * (d[..., 2] - y) / (2 * (1 - kb)), 224 * (d[..., 0] - y) / (2 * (1 - kr))], -1)


def luma(rgb, mat):
    kr, kb = MATS[mat]
    return kr * rgb[..., 0] + (1 - kr - kb) * rgb[..., 1] + kb * rgb[..., 2]


def hexrgb(h):
    h = str(h).lstrip('#')
    try:
        return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)], np.float32)
    except ValueError:
        return np.array([0.75, 0.2, 0.3], np.float32)


def guided(I, r, eps):
    """He et al.'s guided filter, the image guiding itself: flattens texture whose variance is under eps, keeps edges."""
    box = lambda x: cv2.boxFilter(x, -1, (2 * r + 1, 2 * r + 1))
    m = box(I)
    v = box(I * I) - m * m
    a = v / (v + eps)
    return box(a) * I + box(m - a * m)


# ---- landmarks over time ----
def flat(face):
    pts = face['pts']
    if any(k not in pts for k in REGIONS):
        return None
    return np.array([v for k in REGIONS for v in pts[k]], np.float64)


def split(v):
    out, i = {}, 0
    for k, n in SIZES.items():
        out[k] = v[i:i + 2 * n].reshape(n, 2)
        i += 2 * n
    return out


SIZES = {}


def one_euro(X, speed, fps, mincut=0.6, beta=1.5, dcut=1.0):
    """X (n, D) one segment; speed (n,) in face widths per second. Forwards and backwards, averaged: no lag either way."""
    def run(X, sp):
        Y, s = np.empty_like(X), sp[0]
        Y[0] = X[0]
        ad = 1 / (1 + fps / (2 * np.pi * dcut))
        for i in range(1, len(X)):
            s = s + ad * (sp[i] - s)
            fc = mincut + beta * s
            a = 1 / (1 + fps / (2 * np.pi * fc))
            Y[i] = Y[i - 1] + a * (X[i] - Y[i - 1])
        return Y
    return (run(X, speed) + run(X[::-1], speed[::-1])[::-1]) / 2


def tracks(lines, T, fps, faces=True, smooth=True):
    """Face (or body) tracks resampled to the frame times T: list of (vals (n, D) with NaN where absent, presence (n,))."""
    tr = []  # each: {'t': [], 'v': [], 'box': last box}
    for d in lines:
        obs = []
        if faces:
            for f in d['faces']:
                v = flat(f)
                if v is not None:
                    if not SIZES:
                        SIZES.update({k: len(f['pts'][k]) // 2 for k in REGIONS})
                    if len(v) == 2 * sum(SIZES.values()):
                        obs.append((v, f['box']))
        else:  # the biggest person only: shoulders and hips needed, legs optional
            best = None
            for b in d['bodies']:
                if all(k in b and b[k][2] > 0.2 for k in JOINTS[:3]) and ('root' in b or 'left_upLeg_joint' in b):
                    v = np.array([c for k in JOINTS for c in (b[k][:2] if k in b and b[k][2] > 0.2 else (np.nan, np.nan))])
                    sw = abs(v[2] - v[4])
                    if best is None or sw > best[2]:
                        best = (v, [min(v[2], v[4]), v[1], sw, 0.1], sw)
            if best:
                obs.append(best[:2])
        for v, box in obs:
            cx, cy, bw = box[0] + box[2] / 2, box[1] + box[3] / 2, max(box[2], 0.02)
            near = [k for k in tr if d['t'] - k['t'][-1] < 0.5 and k['t'][-1] < d['t'] and abs(k['box'][0] - cx) < 0.6 * bw and abs(k['box'][1] - cy) < 0.6 * bw]
            k = min(near, key=lambda k: abs(k['box'][0] - cx) + abs(k['box'][1] - cy)) if near else None
            if k is None:
                k = {'t': [], 'v': []}
                tr.append(k)
            k['t'].append(d['t'])
            k['v'].append(v)
            k['box'] = (cx, cy, bw)
    out = []
    t_lo, t_hi = (lines[0]['t'], lines[-1]['t']) if lines else (0, 0)
    for k in tr:
        ts, V = np.array(k['t']), np.array(k['v'])
        if len(ts) < (1 if len(T) == 1 else 3):
            continue
        n, D = len(T), V.shape[1]
        vals = np.full((n, D), np.nan)
        idx = np.searchsorted(ts, T)
        gap = np.minimum(np.abs(T - ts[np.clip(idx - 1, 0, len(ts) - 1)]), np.abs(T - ts[np.clip(idx, 0, len(ts) - 1)]))
        inside = (T >= ts[0] - 0.6 / fps) & (T <= ts[-1] + 0.6 / fps) & (gap < 0.3)
        for j in range(D):
            ok = ~np.isnan(V[:, j])
            if ok.sum() >= 1:
                vals[inside, j] = np.interp(T[inside], ts[ok], V[ok, j])
        if not inside.any():
            continue
        # presence: fades in / out over 0.15 s where a face appears or goes inside the range (not at the range's ends)
        pres = inside.astype(np.float64)
        ramp = max(1, round(0.15 * fps))
        i0, i1 = np.flatnonzero(inside)[[0, -1]]
        if ts[0] > t_lo + 1e-3:
            pres[i0:i0 + ramp] *= np.linspace(1 / ramp, 1, min(ramp, n - i0))[:len(pres[i0:i0 + ramp])]
        if ts[-1] < t_hi - 1e-3:
            seg = pres[max(0, i1 - ramp + 1):i1 + 1]
            seg *= np.linspace(1, 1 / ramp, ramp)[-len(seg):]
        if smooth and len(T) > 1:  # smooth each run of frames the face is in (job 'raw': not, for tests to compare)
            cols = ~np.isnan(vals).any(0)
            runs = np.flatnonzero(np.diff(np.r_[0, inside.astype(int), 0]))
            for a, b in zip(runs[::2], runs[1::2]):
                X = vals[a:b][:, cols]
                if faces:
                    c = X.reshape(len(X), -1, 2)
                    size = np.maximum(np.ptp(c[:, :, 0], 1), 1e-3)
                else:
                    c = X.reshape(len(X), -1, 2)
                    size = np.maximum(np.abs(X[:, 2] - X[:, 4]), 1e-3)
                mc = c.mean(1)
                sp = np.r_[0, np.linalg.norm(np.diff(mc, axis=0), axis=1)] * fps / size
                vals[a:b, np.flatnonzero(cols)] = one_euro(X, sp, fps)
        out.append((vals, pres))
    return out


# ---- one face ----
def scaled(P, k):
    c = P.mean(0)
    return c + (P - c) * k


def poly(mask, P, val=1.0):
    cv2.fillPoly(mask, [np.round(P * 4).astype(np.int32)], val, cv2.LINE_AA, shift=2)


def face_pass(yuv, F, a, p, mat):
    """Colour then shape for one face, inside its box (pixels), with presence a (0..1)."""
    H, W = yuv.shape[:2]
    C = F['contour']
    bc = (F['lbrow'].mean(0) + F['rbrow'].mean(0)) / 2
    chin = C[len(C) // 2]
    L = np.linalg.norm(bc - chin)
    fw = np.linalg.norm(C[0] - C[-1])
    if L < 8 or fw < 8:
        return yuv
    u = (bc - chin) / L  # up the face
    r = C[0] - C[-1]
    r = r - u * (r @ u)
    r /= np.linalg.norm(r) + 1e-9
    # forehead: the lower contour mirrored above the brows, flattened -> a dome
    rel = C - bc
    down = -(rel @ u)
    dome = bc + np.outer(rel @ r, r) + np.outer(np.maximum(down, 0) * 0.5, u)
    face = np.vstack([C, dome[::-1]])
    allp = np.vstack([face] + list(F.values()))
    mg = 0.9 * fw
    x0, y0 = max(0, int(allp[:, 0].min() - mg)), max(0, int(allp[:, 1].min() - mg))
    x1, y1 = min(W, int(allp[:, 0].max() + mg) + 1), min(H, int(allp[:, 1].max() + mg) + 1)
    if x1 - x0 < 8 or y1 - y0 < 8:
        return yuv
    o = np.array([x0, y0], np.float64)
    G = {k: v - o for k, v in F.items()}
    face, bc, chin = face - o, bc - o, chin - o
    roi = yuv[y0:y1, x0:x1]
    h, w = roi.shape[:2]
    col = any(p[k] > 0 for k in ('smooth', 'bright', 'teeth', 'lips', 'blush'))
    if col:
        rgb = yuv2rgb(roi, mat)
        new = rgb.copy()
        if p['smooth'] > 0:
            m = np.zeros((h, w), np.float32)
            poly(m, face)
            for k, s in (('leye', 1.9), ('reye', 1.9), ('lbrow', 1.35), ('rbrow', 1.35), ('olips', 1.15)):
                poly(m, scaled(G[k], s), 0.0)
            m = cv2.GaussianBlur(m, (0, 0), max(0.5, 0.03 * fw))
            gf = guided(new, max(2, round(0.022 * fw)), 0.0018)
            new += (gf - new) * (0.85 * p['smooth'] * a * m)[..., None]
        if p['bright'] > 0:
            m = np.zeros((h, w), np.float32)
            for k in ('leye', 'reye'):
                poly(m, scaled(G[k], 1.25))
            m = cv2.GaussianBlur(m, (0, 0), max(0.5, 0.012 * fw))
            y = luma(new, mat)
            k = (0.2 * p['bright'] * a * m * (0.35 + 0.65 * ss(0.25, 0.6, y)))[..., None]  # mostly the whites
            new = 1 - (1 - new) * (1 - k)
        if p['teeth'] > 0:
            m = np.zeros((h, w), np.float32)
            poly(m, G['ilips'])
            m = cv2.GaussianBlur(m, (0, 0), max(0.5, 0.006 * fw))
            y = luma(new, mat)
            wt = m * ss(0.2, 0.5, y) * p['teeth'] * a
            new = y[..., None] + (new - y[..., None]) * (1 - 0.8 * wt)[..., None]  # yellow -> neutral
            new = 1 - (1 - new) * (1 - 0.35 * wt)[..., None]  # and lighter
        if p['lips'] > 0 or p['blush'] > 0:
            def tint(m, c, k):  # the colour's hue and saturation at the pixel's own lightness, a little deeper
                nonlocal new
                y = luma(new, mat)[..., None]
                lc = max(luma(c[None], mat)[0], 0.05)
                tc = y * 0.92 + (c - lc) * np.clip(y / lc, 0.25, 1.2)  # darker pixels take less colour
                new += (tc - new) * (k * m)[..., None]
            if p['lips'] > 0:
                m = np.zeros((h, w), np.float32)
                poly(m, G['olips'])
                poly(m, scaled(G['ilips'], 1.1), 0.0)
                tint(cv2.GaussianBlur(m, (0, 0), max(0.5, 0.008 * fw)), hexrgb(p['lipc']), 0.55 * p['lips'] * a)
            if p['blush'] > 0:
                m = np.zeros((h, w), np.float32)
                nose = G['nose'].mean(0)
                for side in (G['contour'][: len(C) // 2], G['contour'][len(C) // 2 + 1:]):
                    tip = G['nose'][np.argmin(G['nose'] @ u)]
                    q = side[np.argmin(np.abs((side - tip) @ u))]  # the contour at the nose tip's height
                    cc = q + (nose - q) * 0.38
                    cv2.circle(m, tuple(np.round(cc).astype(int)), max(1, int(0.13 * fw)), 1.0, -1)
                tint(cv2.GaussianBlur(m, (0, 0), max(0.5, 0.09 * fw)), hexrgb(p['blushc']), 0.3 * p['blush'] * a)
        d = rgb2yuv_delta(np.clip(new, -0.07, 1.07) - rgb, mat)
        roi = np.clip(np.round(roi + d), 0, 255).astype(np.uint8)
    shape = any(p[k] for k in ('eyes', 'slim', 'width', 'cheek', 'jaw', 'chin', 'nose'))
    if shape:
        Cc = G['contour']
        step = max(2, int(fw / 64))
        gx, gy = np.meshgrid(np.arange(0, w + step, step, dtype=np.float64), np.arange(0, h + step, step, dtype=np.float64))
        q = np.stack([gx, gy], -1)[..., None, :]
        D = np.zeros(gx.shape + (2,))
        g = lambda x, m, s: np.exp(-((x - m) / s) ** 2 / 2)
        # face shape: a sideways squeeze (or stretch) toward the line through the chin, its strength by height on the face,
        # flat out to the contour and easing off over 1.5x the face's half width beyond it (smooth: it can't fold)
        cax, clat = ((bc - Cc) @ u) / L, (Cc - chin) @ r  # height: 0 at the brows .. 1 at the chin; sideways from the chin
        if any(p[k] for k in ('slim', 'width', 'cheek', 'jaw')):
            Q = q[..., 0, :]
            ax, lat = ((bc - Q) @ u) / L, (Q - chin) @ r
            half = np.full(ax.shape, 0.5 * fw)
            for sd in (1, -1):  # the contour's half width at each height, per side
                m = clat * sd > 0
                if m.sum() >= 2:
                    o_ = np.argsort(cax[m])
                    hw = np.interp(ax, cax[m][o_], np.abs(clat[m])[o_])
                    half = np.where(lat * sd > 0, np.maximum(hw, 0.08 * fw), half)
            k = (-0.45 * (1 - np.exp(-2.7 * p['slim'])) * ss(0.1, 0.55, ax) + 0.2 * p['width'] * ss(-0.3, 0.1, ax)
                 + 0.2 * p['cheek'] * g(ax, 0.35, 0.15) + 0.3 * p['jaw'] * g(ax, 0.75, 0.13))
            k = np.clip(k, -0.45, 0.45) * (1 - ss(1.0, 1.55, ax)) * ss(-0.45, -0.1, ax) * a
            uu = np.abs(lat) / (2.5 * half)
            D += (k * lat * (1 - ss(0.4, 1.0, uu)))[..., None] * r
        if p['chin']:  # the chin's points down (longer) or up, the mouth held
            near = np.abs(cax - 1) < 0.12
            cp = Cc[near] if near.any() else chin[None]
            disp = np.tile(-0.12 * p['chin'] * a * L * u, (len(cp), 1))
            anchors = np.vstack([G['olips'], G['nose']])
            cen = np.vstack([cp + disp, anchors])
            dd = np.vstack([disp, np.zeros_like(anchors)])
            sg = np.r_[np.full(len(cp), 0.22 * fw), np.full(len(anchors), 0.08 * fw)]
            wgt = np.exp(-((q - cen) ** 2).sum(-1) / (2 * sg ** 2))
            D += (wgt[..., None] * dd).sum(-2) / np.maximum(1, wgt.sum(-1))[..., None]
        D = cv2.GaussianBlur(D.astype(np.float32), (0, 0), 0.06 * fw / step)  # no kinks where the contour bends
        for e, kk in (('leye', 0.22 * p['eyes']), ('reye', 0.22 * p['eyes']), ('nose', 0.2 * p['nose'])):  # radial: + bigger
            if kk:
                ce, P_ = G[e].mean(0), G[e]
                R = (1.0 if e != 'nose' else 1.3) * max(np.ptp(P_ @ r), 2)
                rho = np.linalg.norm(q[..., 0, :] - ce, axis=-1)
                f = kk * a * np.clip(1 - (rho / R) ** 2, 0, 1) ** 2
                D += (q[..., 0, :] - ce) * f[..., None]
        win = np.minimum(ss(0, 0.08, np.minimum(gx, w - gx) / w), ss(0, 0.08, np.minimum(gy, h - gy) / h))
        D *= win[..., None]
        X, Y = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
        Df = [cv2.remap(D[..., i].astype(np.float32), X / step, Y / step, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE) for i in (0, 1)]
        roi = cv2.remap(np.ascontiguousarray(roi), X - Df[0], Y - Df[1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    if col or shape:
        yuv = yuv.copy()
        yuv[y0:y1, x0:x1] = roi
    return yuv


def body_pass(yuv, B, a, p):
    H, W = yuv.shape[:2]
    J = {k: B[2 * i:2 * i + 2] for i, k in enumerate(JOINTS)}
    ok = lambda k: not np.isnan(J[k]).any()
    sh = (J['left_shoulder_1_joint'] + J['right_shoulder_1_joint']) / 2
    hips = [J[k] for k in ('left_upLeg_joint', 'right_upLeg_joint') if ok(k)]
    hip = np.mean(hips, 0) if hips else J['root'] if ok('root') else None
    if hip is None or hip[1] - sh[1] < 4:
        return yuv
    sw = max(4, abs(J['left_shoulder_1_joint'][0] - J['right_shoulder_1_joint'][0]) / 2)
    torso = hip[1] - sh[1]
    axis = [J['neck_1_joint'] if ok('neck_1_joint') else sh, hip]
    for pair in (('left_leg_joint', 'right_leg_joint'), ('left_foot_joint', 'right_foot_joint')):
        if ok(pair[0]) and ok(pair[1]):
            axis.append((J[pair[0]] + J[pair[1]]) / 2)
    axis = np.array(sorted(axis, key=lambda v: v[1]))
    knee = axis[2][1] if len(axis) > 2 else hip[1] + torso
    foot = axis[-1][1] if len(axis) > 3 else knee + torso
    step = 4
    gx, gy = np.meshgrid(np.arange(0, W + step, step, dtype=np.float64), np.arange(0, H + step, step, dtype=np.float64))
    # legs longer: rows below the hips taken from higher up (stretched); the frame's bottom goes out of the picture
    ys = np.arange(H + step + 1, dtype=np.float64)
    s = 1 / (1 + 0.22 * p['legs'] * a * ss(hip[1] - 0.04 * H, hip[1] + 0.04 * H, ys))
    srcy = np.r_[0, np.cumsum(s)[:-1]]
    my = np.interp(gy, ys, srcy)
    mx = gx.copy()
    if p['body']:
        v = ss(sh[1], sh[1] + 0.35 * torso, my) * (1 - ss(knee, foot, my))
        b = gx - np.interp(my, axis[:, 1], axis[:, 0])
        Wz = 2.4 * sw
        uu = np.clip(b / Wz, -1, 1)
        mx = gx + 0.3 * p['body'] * a * v * b * (1 - uu * uu) ** 2
    if np.abs(mx - gx).max() < 0.01 and np.abs(my - gy).max() < 0.01:
        return yuv
    X, Y = np.meshgrid(np.arange(W, dtype=np.float32), np.arange(H, dtype=np.float32))
    MX = cv2.remap(mx.astype(np.float32), X / step, Y / step, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    MY = cv2.remap(my.astype(np.float32), X / step, Y / step, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    return cv2.remap(np.ascontiguousarray(yuv), MX, MY, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)


def render(yuv, i, ft, bt, p, mat):
    H, W = yuv.shape[:2]
    for vals, pres in ft:
        if pres[i] > 0 and not np.isnan(vals[i]).any():
            F = {k: v * [W, H] for k, v in split(vals[i]).items()}
            yuv = face_pass(yuv, F, pres[i], p, mat)
    if p['body'] or p['legs']:
        for vals, pres in bt[:1]:
            if pres[i] > 0 and not np.isnan(vals[i][:8]).all():
                yuv = body_pass(yuv, vals[i] * np.tile([W, H], len(JOINTS)), pres[i], p)
    return yuv


def frames(job, n=None):
    W, H = job['w'], job['h']
    cmd = ['ffmpeg', '-v', 'error', '-nostdin', *job['dec'], '-ss', f"{job['t0']:.6f}", *(['-t', f"{job['dur']:.6f}"] if not job.get('still') else []),
           '-i', job['src'], '-vf', f"{job['vf']}{'' if job.get('still') else 'fps=' + str(job['fps']) + ','}format=yuv444p",
           *(['-frames:v', '1'] if job.get('still') else []), '-f', 'rawvideo', '-pix_fmt', 'yuv444p', '-']
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    sz = W * H * 3
    try:
        while len(buf := proc.stdout.read(sz)) == sz:
            yield np.frombuffer(buf, np.uint8).reshape(3, H, W).transpose(1, 2, 0)
    finally:
        proc.stdout.close()
        proc.wait()


def labels(tags):
    opt = {'-colorspace': 'colorspace', '-color_primaries': 'color_primaries', '-color_trc': 'color_trc'}
    kv = [f'{opt[k]}={v}' for k, v in zip(tags[::2], tags[1::2]) if k in opt]
    return ['-vf', 'setparams=' + ':'.join(kv)] if kv else []


def main(path):
    job = json.loads(Path(path).read_text())
    p = {**P0, **job.get('p', {})}
    for k, v in p.items():
        if not isinstance(v, str):
            p[k] = float(np.clip(float(v), 0 if k in ('smooth', 'bright', 'teeth', 'lips', 'blush', 'slim', 'body', 'legs') else -1, 1))
    mat, fps = job.get('mat', '709'), float(job['fps'])
    if job.get('still'):
        fr = next(frames(job), None)
        if fr is None:
            sys.exit('could not read that frame')
        lm = Path(job['lm'])
        if not lm.exists():  # find the faces on this frame (cached by the server per frame)
            with tempfile.TemporaryDirectory(prefix='cutroom-') as td:
                png = Path(td) / 'f.png'
                cv2.imwrite(str(png), cv2.cvtColor(np.clip(yuv2rgb(fr, mat) * 255 + 0.5, 0, 255).astype(np.uint8), cv2.COLOR_RGB2BGR))
                r = subprocess.run([job['detect'], str(png)], capture_output=True, text=True)
                if r.returncode:
                    sys.exit('finding the face failed: ' + r.stderr.strip()[-200:])
                lm.write_text(r.stdout)
        lines = [json.loads(x) for x in lm.read_text().splitlines() if x.strip()]
        T = np.array([0.0])
        for x in lines:
            x['t'] = 0.0
        ft, bt = tracks(lines, T, fps), tracks(lines, T, fps, faces=False)
        out = render(fr, 0, ft, bt, p, mat)
        rgb = np.clip(yuv2rgb(out, mat) * 255 + 0.5, 0, 255).astype(np.uint8)
        k = min(1.0, job.get('max', 1920) / max(rgb.shape[:2]))
        if k < 1:
            rgb = cv2.resize(rgb, (round(rgb.shape[1] * k), round(rgb.shape[0] * k)), interpolation=cv2.INTER_AREA)
        cv2.imwrite(job['out'], cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
        print(json.dumps({'faces': len(ft), 'bodies': len(bt)}), flush=True)
        return
    lines = [json.loads(x) for x in Path(job['lm']).read_text().splitlines() if x.strip()]
    n = max(1, round(job['dur'] * fps))
    T = job['t0'] + np.arange(n) / fps
    ft, bt = tracks(lines, T, fps, smooth=not job.get('raw')), tracks(lines, T, fps, faces=False, smooth=not job.get('raw'))
    hit = sum(1 for d in lines if d['faces'] or d['bodies'])
    print(json.dumps({'faces': len(ft), 'bodies': len(bt), 'found': hit, 'frames': len(lines)}), flush=True)
    W, H = job['w'], job['h']
    enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'rawvideo', '-pix_fmt', 'yuv444p', '-s', f'{W}x{H}', '-r', f'{fps}', '-i', '-',
                            '-ss', f"{job['t0']:.6f}", '-t', f"{job['dur']:.6f}", '-i', job['src'], '-map', '0:v', '-map', '1:a:0?',  # (an iPhone's 2nd track is spatial audio: no decoder)
                            *labels(job['tags']), '-c:v', 'h264_videotoolbox', '-q:v', '85', '-pix_fmt', 'yuv420p', *job['tags'],
                            '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', job['out']], stdin=subprocess.PIPE)
    i = -1
    for i, fr in enumerate(frames(job)):
        out = render(fr, min(i, n - 1), ft, bt, p, mat) if i < n else fr
        enc.stdin.write(np.ascontiguousarray(out.transpose(2, 0, 1)).tobytes())
        if i % 10 == 0:
            say((i + 1) / n)
    enc.stdin.close()
    if enc.wait() or i < 0:
        sys.exit('encoding the retouched clip failed')
    say(1)


if __name__ == '__main__':
    main(sys.argv[1])
