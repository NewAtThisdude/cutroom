"""Cutroom object removal (CapCut's "Remove object"), on this Mac: nothing uploaded.

  remove.py job.json      prints 'progress <0..1>' and 'engine <name>' lines, writes job['out'] (video + audio)

job: src, out, t0, dur, fps, w, h (display size), boxes ([x, y, w, h] normalized, one per output frame, tracked),
     pick (frame index of the drawn box), box (the drawn box), engine ('best' | 'fast'),
     dec (ffmpeg input args), vf (decode filters ending in ','), tags (output colour args)

Best (when ai/vendor is installed): SAM 2 traces the object's exact outline from the drawn box through the clip,
and ProPainter fills it (flow-guided propagation, so parallax and moving backgrounds work, plus a transformer for
what no frame shows). Fast (and the fallback): the hole is the tracked box, filled with the background from the
nearest frames that show it, aligned for camera motion (corner flow -> homography); what no frame shows is
synthesized once (exemplar inpainting) and carried through the shot. Both end with a Poisson blend.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np

os.environ.setdefault('PYTORCH_ENABLE_MPS_FALLBACK', '1')  # before torch loads: the rare op the GPU lacks runs on the CPU
VENDOR = Path(__file__).resolve().parent / 'vendor'
SAM2_CK = VENDOR / 'sam2' / 'checkpoints' / 'sam2.1_hiera_small.pt'
PROPAINTER = VENDOR / 'ProPainter' / 'inference_propainter.py'
OFFSETS = [o for d in [*range(1, 11), 12, 15, 19, 24, 30, 38, 48, 60, 75, 95, 120, 150, 190, 240, 300] for o in (d, -d)]


def labels(tags):
    """The source's colour labels as a setparams filter: ffmpeg takes primaries and transfer from the frames, which a raw
    pipe leaves unset, so encoder options alone label only the matrix."""
    opt = {'-colorspace': 'colorspace', '-color_primaries': 'color_primaries', '-color_trc': 'color_trc'}
    kv = [f'{opt[k]}={v}' for k, v in zip(tags[::2], tags[1::2]) if k in opt]
    return ['-vf', 'setparams=' + ':'.join(kv)] if kv else []


def say(p):
    print(f'progress {min(1.0, max(0.0, p)):.3f}', flush=True)


def frames(job, tail, w, h, planes):
    """Decoded frames of the range from an ffmpeg pipe: yuv444p -> (h, w, 3), gray -> (h, w)."""
    cmd = ['ffmpeg', '-v', 'error', '-nostdin', *job['dec'], '-ss', f"{job['t0']:.6f}", '-t', f"{job['dur']:.6f}", '-i', job['src'],
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
    """A[i] maps frame-0 coordinates to frame-i (camera motion from background corners; identity when unsure), the
    share of frames where one homography explains the background, and whether the camera holds still (a tripod shot:
    copies from other frames match exactly; a moving camera changes blur and exposure between frames)."""
    A, prev, fits, moves = [np.eye(3)], None, [], []
    corners = np.array([[0, 0, 1], [grays[0].shape[1], 0, 1], [0, grays[0].shape[0], 1], [grays[0].shape[1], grays[0].shape[0], 1]], float).T if grays else None
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
                        fits.append(inl.sum() / ok.sum() >= 0.95)  # parallax drops this
            c = Hm @ corners
            moves.append(float(np.abs(c[:2] / c[2] - corners[:2]).max()))  # how far the picture moved this frame (px)
            A.append(Hm @ A[-1])
        prev = g
    still = bool(moves) and float(np.median(moves)) < 0.5 and float(np.percentile(moves, 90)) < 1.5
    return A, (sum(fits) / len(fits) if fits else 1.0), still or not moves


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


def sam2_masks(job, n, p0, p1, soft=False):
    """Exact outlines with SAM 2 (Meta, 2.1 small, bf16 on the GPU): the drawn box at the picked frame, followed both
    ways. Long clips go in chunks that share their edge frame, each seeded with its neighbour's mask (bounded memory).
    soft: 0-255 alpha from the model's confidence (anti-aliased edges) instead of on/off."""
    os.environ['TQDM_DISABLE'] = '1'  # SAM 2's progress bars; ours are the 'progress' lines
    import torch
    from sam2.build_sam import build_sam2_video_predictor
    W, H = job['w'], job['h']
    k = min(1.0, 1024 / max(W, H))
    fw, fh = max(2, int(W * k) // 2 * 2), max(2, int(H * k) // 2 * 2)
    dev = torch.device('mps' if torch.backends.mps.is_available() else 'cpu')
    with tempfile.TemporaryDirectory(prefix='cutroom-sam-') as td:
        subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', *job['dec'], '-ss', f"{job['t0']:.6f}", '-t', f"{job['dur']:.6f}", '-i', job['src'],
                        '-vf', f"{job['vf']}fps={job['fps']},scale={fw}:{fh}", '-q:v', '2', '-start_number', '0', f'{td}/%05d.jpg'], check=True)
        files = sorted(f for f in os.listdir(td) if f.endswith('.jpg'))
        n = min(n, len(files))
        C = 240
        chunks = [(a, min(n - 1, a + C)) for a in range(0, max(1, n - 1), C)]
        pred = build_sam2_video_predictor('configs/sam2.1/sam2.1_hiera_s.yaml', str(SAM2_CK), device=dev)
        masks, done = np.zeros((n, fh, fw), np.uint8 if soft else bool), [0]
        pick = int(np.clip(job.get('pick', 0), 0, n - 1))
        x, y, w, h = job['box']

        def run(ci, seed_frame, seed, directions):
            a, b = chunks[ci]
            d = Path(td) / f'c{ci}'
            d.mkdir()
            for i in range(a, b + 1):
                os.link(Path(td) / files[i], d / f'{i - a:05d}.jpg')
            amp = torch.autocast('mps', dtype=torch.bfloat16) if dev.type == 'mps' else torch.autocast('cpu', enabled=False)
            with torch.inference_mode(), amp:
                st = pred.init_state(video_path=str(d), offload_video_to_cpu=True)
                if seed is None and job.get('seed'):  # the outline the user confirmed in the preview: exactly that is followed
                    sm = cv2.resize(cv2.imread(job['seed'], cv2.IMREAD_GRAYSCALE), (fw, fh), interpolation=cv2.INTER_NEAREST)
                    pred.add_new_mask(st, frame_idx=seed_frame - a, obj_id=1, mask=sm > 127)
                elif seed is None:
                    pred.add_new_points_or_box(st, frame_idx=seed_frame - a, obj_id=1, box=np.array([x * fw, y * fh, (x + w) * fw, (y + h) * fh], np.float32))
                else:
                    pred.add_new_mask(st, frame_idx=seed_frame - a, obj_id=1, mask=seed > (127 if soft else 0))
                for rev in directions:
                    for fi, _, lg in pred.propagate_in_video(st, start_frame_idx=seed_frame - a, reverse=rev):
                        z = lg[0, 0].float()
                        masks[a + fi] = (torch.sigmoid(z * 2) * 255).byte().cpu().numpy() if soft else (z > 0).cpu().numpy()
                        done[0] += 1
                        say(p0 + (p1 - p0) * min(1.0, done[0] / n))
                pred.reset_state(st)

        kp = next(ci for ci, (a, b) in enumerate(chunks) if a <= pick <= b)
        run(kp, pick, None, (False, True))
        for ci in range(kp + 1, len(chunks)):
            run(ci, chunks[ci][0], masks[chunks[ci][0]], (False,))
        for ci in range(kp - 1, -1, -1):
            run(ci, chunks[ci][1], masks[chunks[ci][1]], (True,))
    return masks


def propainter(F, holes, p0, p1):
    """ProPainter (Zhou et al., ICCV 2023) on the crop, at most 720 px: optical flow (RAFT) carries the real background
    in from other frames, even with parallax; a transformer fills what no frame shows, consistently over time.
    Half precision (the same fill as full: 0.1/255 apart) in 40-frame batches, under the GPU memory cap set in AI_ENV
    (server.py): stock settings took 30 GB on a head-sized hole and swapped the Mac. Still too big: again, smaller."""
    n, sh, sw = holes.shape
    with tempfile.TemporaryDirectory(prefix='cutroom-pp-') as td:
        vd, md = Path(td) / 'clip', Path(td) / 'mask'
        vd.mkdir()
        md.mkdir()
        for i in range(n):
            cv2.imwrite(str(vd / f'{i:05d}.png'), cv2.cvtColor(F[i], cv2.COLOR_YUV2BGR))
            cv2.imwrite(str(md / f'{i:05d}.png'), holes[i].astype(np.uint8) * 255)
        small = os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES') < 15 * 2 ** 30  # an 8 GB Mac starts where a 36 GB one falls back to
        for px, batch in ((512, 20), (384, 12)) if small else ((720, 40), (512, 20)):
            k = min(1.0, px / max(sw, sh))
            pw, ph = max(8, int(sw * k) // 8 * 8), max(8, int(sh * k) // 8 * 8)
            proc = subprocess.Popen([sys.executable, '-E', '-s', str(PROPAINTER), '--video', str(vd), '--mask', str(md), '--output', str(Path(td) / 'out'),
                                     '--save_frames', '--width', str(pw), '--height', str(ph), '--mask_dilation', '2', '--fp16', '--subvideo_length', str(batch)],
                                    cwd=PROPAINTER.parent, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, errors='replace',
                                    env={**{k: v for k, v in os.environ.items() if k != 'TQDM_DISABLE'}, 'PYTORCH_ENABLE_MPS_FALLBACK': '1'})
            tail = ''
            while chunk := proc.stderr.read(256):  # tqdm "7/16 [" -> progress
                tail = (tail + chunk)[-2000:]
                if hit := re.findall(r'(\d+)/(\d+) \[', tail):
                    say(p0 + (p1 - p0) * int(hit[-1][0]) / max(1, int(hit[-1][1])))
            if not proc.wait():
                break
            if 'out of memory' not in tail or batch == (12 if small else 20):
                raise RuntimeError('ProPainter failed: ' + tail[-400:])
            print(f'ProPainter: out of GPU memory at {pw}x{ph}, again at 512 px', flush=True)
        filled = F.copy()
        for i in range(n):
            f = cv2.imread(str(Path(td) / 'out' / 'clip' / 'frames' / f'{i:04d}.png'))
            f = cv2.cvtColor(cv2.resize(f, (sw, sh), interpolation=cv2.INTER_CUBIC), cv2.COLOR_BGR2YUV)
            filled[i][holes[i]] = f[holes[i]]
    return filled


def classical(job, F, holes, rs, geo, p0, p1, synth=True):
    """The fast engine: background from the nearest frames that show it (camera-aligned), exemplar fill for the rest.
    Returns the fill, what no frame showed, and how exact the aligned copy is (1.0 = still camera, one homography fits)."""
    W, H = job['w'], job['h']
    n, sh, sw = holes.shape
    x0, y0, sx, sy = geo
    gw = min(W, 640) // 2 * 2
    gh = max(2, round(H * gw / W / 2) * 2)
    kx, ky = W / gw, H / gh
    small = []
    for r in rs:
        hm = np.zeros((gh, gw), bool)
        if r:
            a, b, c, d = r
            hm[int(b / ky):int(np.ceil(d / ky)), int(a / kx):int(np.ceil(c / kx))] = True
        small.append(hm)
    grays = list(frames(job, f'scale={gw}:{gh},format=gray', gw, gh, 1))[:n]
    A, fit, still = motion(grays, small[:len(grays)])
    A += [A[-1]] * (n - len(A))
    M = np.array([[sx * kx, 0, -sx * x0], [0, sy * ky, -sy * y0], [0, 0, 1]])  # small-frame -> crop coordinates
    Mi, Ai = np.linalg.inv(M), [np.linalg.inv(a) for a in A]

    def warp_to(s_, t):  # crop coords of frame s -> crop coords of frame t
        return M @ A[t] @ Ai[s_] @ Mi

    blocked = np.stack([cv2.dilate(h.astype(np.uint8) * 255, np.ones((3, 3), np.uint8)) for h in holes])  # never copy the object's edge
    filled, left = F.copy(), np.zeros_like(holes)
    for t in range(n):  # fill each hole from the nearest frames that show that background (aligned)
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
        say(p0 + (p1 - p0) * 0.8 * (t + 1) / n)
    rem = left.reshape(n, -1).sum(1)
    if synth and rem.any():  # what no frame shows: synthesize it once on the frame missing the most, carry it through the shot
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
    return filled, left, fit if still else 0.0


def cutout(job, n):
    """Any subject on its own (CapCut's cutout is people-first; this is whatever was boxed): SAM 2's soft outline as
    the alpha of a VP9 WebM, with the range's sound."""
    W, H, fps = job['w'], job['h'], job['fps']
    if not SAM2_CK.exists():
        sys.exit('cutting out needs SAM 2 (run ai/setup.sh)')
    alpha = sam2_masks(job, n, 0.0, 0.7, soft=True)
    if alpha[int(np.clip(job.get('pick', 0), 0, len(alpha) - 1))].max() < 128:
        sys.exit('nothing found in that box: draw it around the subject')
    print('engine sam2', flush=True)
    enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'rawvideo', '-pix_fmt', 'yuva444p', '-s', f'{W}x{H}', '-r', f'{fps}', '-i', '-',
                            '-ss', f"{job['t0']:.6f}", '-t', f"{job['dur']:.6f}", '-i', job['src'], '-map', '0:v', '-map', '1:a:0?',  # the first sound only: iPhones add an APAC (spatial) track no decoder reads
                            *labels(job['tags']), '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '28', '-deadline', 'realtime', '-cpu-used', '8',
                            '-row-mt', '1', *job['tags'], '-c:a', 'libopus', '-b:a', '128k', '-shortest', job['out']], stdin=subprocess.PIPE)
    for t, fr in enumerate(frames(job, 'format=yuv444p', W, H, 3)):
        a = cv2.resize(alpha[min(t, len(alpha) - 1)], (W, H), interpolation=cv2.INTER_LINEAR)  # smooth upscaled edge
        enc.stdin.write(np.ascontiguousarray(fr.transpose(2, 0, 1)).tobytes() + a.tobytes())
        if t % 15 == 0:
            say(0.7 + 0.3 * min(1, (t + 1) / len(alpha)))
    enc.stdin.close()
    if enc.wait():
        sys.exit('encoding the cutout failed')
    say(1)


SAM_IMG = {}  # SAM 2's image model and the frame it last embedded: in the long-lived ai/worker.py a refine click costs only the decoder (~10 ms)


def preview(job):
    """The outline Best would take, on the one frame the box was drawn on (SAM 2's image model): shown to the user before
    the whole clip is processed. Writes grey mask PNGs (255 = the object), one per candidate, smallest first."""
    import torch
    W, H = job['w'], job['h']
    k = min(1.0, 1024 / max(W, H))
    fw, fh = max(2, int(W * k) // 2 * 2), max(2, int(H * k) // 2 * 2)
    dev = torch.device('mps' if torch.backends.mps.is_available() else 'cpu')
    amp = torch.autocast('mps', dtype=torch.bfloat16) if dev.type == 'mps' else torch.autocast('cpu', enabled=False)
    if 'pred' not in SAM_IMG:
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor
        SAM_IMG['pred'] = SAM2ImagePredictor(build_sam2('configs/sam2.1/sam2.1_hiera_s.yaml', str(SAM2_CK), device=dev))
    pred, key = SAM_IMG['pred'], json.dumps([job['src'], round(job['t'], 4), job['dec'], job['vf'], fw, fh])
    if SAM_IMG.get('key') != key:
        SAM_IMG.pop('key', None)
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', *job['dec'], '-ss', f"{job['t']:.6f}", '-i', job['src'], '-frames:v', '1',
                              '-vf', f"{job['vf']}scale={fw}:{fh}", '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True, check=True).stdout
        if len(raw) < fw * fh * 3:
            raise RuntimeError('could not read that frame')
        with torch.inference_mode(), amp:
            pred.set_image(np.frombuffer(raw[:fw * fh * 3], np.uint8).reshape(fh, fw, 3))
        SAM_IMG['key'] = key
    x, y, w, h = job['box']
    bx = np.array([x * fw, y * fh, (x + w) * fw, (y + h) * fh], np.float32)
    pts = job.get('points') or []  # [x, y, 1 = keep this spot / 0 = leave it out], normalized
    for px_, py_, keep in pts:  # a spot clicked outside the box is part of the object: the box grows past it (SAM 2 keeps to its box)
        if keep and not (bx[0] <= px_ * fw <= bx[2] and bx[1] <= py_ * fh <= bx[3]):
            mx, my = 0.25 * (bx[2] - bx[0]), 0.25 * (bx[3] - bx[1])
            bx = np.array([min(bx[0], px_ * fw - mx), min(bx[1], py_ * fh - my), max(bx[2], px_ * fw + mx), max(bx[3], py_ * fh + my)], np.float32).clip(0, [fw, fh, fw, fh])
    # two prompts on the same embedding: the box (with any clicked spots), and the box plus a 'keep' point at its centre. A loose box
    # (2 % margin round the walking fox) alone gave a block of book spines its best fit; the centre point gave the whole fox
    prompts = [pts] + ([] if any(not q[2] for q in pts) else [pts + [[(bx[0] + bx[2]) / 2 / fw, (bx[1] + bx[3]) / 2 / fh, 1]]])
    raw = []
    with torch.inference_mode(), amp:
        for ps in prompts:
            kw = {'point_coords': np.array([[p[0] * fw, p[1] * fh] for p in ps], np.float32), 'point_labels': np.array([int(p[2]) for p in ps], np.int32)} if ps else {}
            masks, scores, _ = pred.predict(box=bx, multimask_output=True, **kw)
            raw += [(np.asarray(m) > 0, float(sc)) for m, sc in zip(masks, scores)]
    # a box is ambiguous between parts and wholes (hair / head / head and neck): every candidate is kept, smallest first. The pick
    # weighs SAM's own score with how the mask sits in the box (fills it without spilling out, in one piece) and marks down masks
    # that fill the box out to its edges (a box-shaped block of background). Neither alone: SAM's score picked hair + beard over
    # the face on the 11-07 head test, box cover picked the book spines. With clicked spots: one that takes them all in (and
    # leaves the ⌥-clicked ones out)
    x0, y0, x1, y1 = (int(round(v)) for v in bx)
    x0, y0 = max(0, x0), max(0, y0)
    rb = max(2, round(0.04 * min(x1 - x0, y1 - y0)))
    ring = np.zeros((fh, fw), bool)
    ring[y0:y1, x0:x1] = True
    ring[y0 + rb:y1 - rb, x0 + rb:x1 - rb] = False
    cands = []
    for m, sc in raw:
        if not m.any():
            continue
        same = next((c for c in cands if (c['m'] & m).sum() > 0.97 * (c['m'] | m).sum()), None)
        if same:  # both prompts found it
            same['sc'] = max(same['sc'], sc)
            continue
        inside = m[y0:y1, x0:x1].sum()
        cover, spill = inside / max(1, (y1 - y0) * (x1 - x0)), 1 - inside / m.sum()
        edge = (m & ring).sum() / max(1, ring.sum())
        pieces = cv2.connectedComponents(m.astype(np.uint8))[0] - 1
        obeys = all(m[min(fh - 1, int(q[1] * fh)), min(fw - 1, int(q[0] * fw))] == bool(q[2]) for q in pts)
        cands.append({'m': m, 'sc': sc, 'obeys': obeys, 'spill': spill, 'fit': cover - spill - 0.5 * max(0.0, edge - 0.5) - 0.002 * pieces})
    if not cands:
        raise RuntimeError('nothing found in that box')
    best = max(cands, key=lambda c: (c['obeys'], c['sc'] + 0.5 * c['fit']))
    if job.get('purpose') == 'remove':  # removing: every outline SAM 2 is sure of, together. Extra background is filled exactly from
        # other frames; a part left out (the fox's dark legs, in a candidate that missed them) stays in the video
        sure = [c for c in cands if c['obeys'] and c['sc'] >= 0.7 and c['spill'] < 0.5]
        if len(sure) > 1:
            u = np.logical_or.reduce([c['m'] for c in sure])
            same = next((c for c in sure if c['m'].sum() == u.sum()), None)  # one of them already holds all the others
            if not same:
                same = {'m': u, 'sc': max(c['sc'] for c in sure)}
                cands.append(same)
            best = same
    cands.sort(key=lambda c: c['m'].sum())
    base = job['out'][:-4]
    for i, c in enumerate(cands):
        cv2.imwrite(f'{base}{i}.png', c['m'].astype(np.uint8) * 255)
    return {'areas': [round(float(c['m'].mean()), 5) for c in cands], 'scores': [round(c['sc'], 3) for c in cands],
            'pick': next(i for i, c in enumerate(cands) if c is best), 'unsure': max(c['sc'] for c in cands) < 0.7}  # low: 'not sure what you boxed: click on it'


def main(path):
    job = json.load(open(path))
    if job.get('mode') == 'preview':  # one-off; the editor asks the long-lived ai/worker.py instead
        return print(json.dumps(preview(job)))
    W, H, fps = job['w'], job['h'], job['fps']
    n = max(1, len(job['boxes']))
    if job.get('mode') == 'cutout':
        return cutout(job, n)
    if job.get('mode') == 'mask':  # the subject's outline as a clip mask: SAM 2's soft masks as PNGs, white with that alpha
        if not SAM2_CK.exists():
            sys.exit('an AI mask needs SAM 2 (run ai/setup.sh)')
        alpha = sam2_masks(job, n, 0.0, 0.95, soft=True)
        if alpha[int(np.clip(job.get('pick', 0), 0, len(alpha) - 1))].max() < 128:
            sys.exit('nothing found in that box: draw it around the subject')
        print('engine sam2', flush=True)
        os.makedirs(job['out'], exist_ok=True)
        white = np.full(alpha.shape[1:], 255, np.uint8)
        for i, a in enumerate(alpha):
            cv2.imwrite(os.path.join(job['out'], f'{i:05d}.png'), np.dstack([white, white, white, a]))
        return say(1)
    best = job.get('engine', 'best') == 'best'
    masks = None
    if best and SAM2_CK.exists() and job.get('box'):
        masks = sam2_masks(job, n, 0.0, 0.3)
        if masks[int(np.clip(job.get('pick', 0), 0, len(masks) - 1))].sum() < 16:
            masks = None  # SAM 2 found nothing in the box: fall back to the tracked box
    if masks is not None:  # exact outline, grown a little for soft edges and motion blur
        n = len(masks)
        # grown to cover motion blur, contact shadows and stray hairs: SAM 2's edge misses scale with the object (a head's
        # wisps poked 3-10 px past a 1.2 %-of-frame grow, and ProPainter smeared them over the wall: 6 % of its size took them)
        sizes = [max(np.ptp(np.nonzero(m)[0]), np.ptp(np.nonzero(m)[1])) for m in masks if m.any()]
        ms, grow = masks.shape[2] / W, max(4, round(0.012 * max(masks.shape[1:])), round(0.06 * float(np.median(sizes or [0]))))
        masks = np.stack([cv2.dilate(m.astype(np.uint8), np.ones((2 * grow + 1, 2 * grow + 1), np.uint8)) > 0 for m in masks])
        rs = []
        for m in masks:
            ys, xs = np.nonzero(m)
            rs.append((xs.min() / ms, ys.min() / ms, (xs.max() + 1) / ms, (ys.max() + 1) / ms) if len(xs) else None)
    else:
        rs = rects(job, n)
    on = [r for r in rs if r]
    if not on:
        sys.exit('nothing to remove: the object is not in this clip')
    # crop: every hole plus context; scaled down only when the clip would not fit in ~1.5 GB
    x0, y0 = min(r[0] for r in on), min(r[1] for r in on)
    x1, y1 = max(r[2] for r in on), max(r[3] for r in on)
    big = max(max(r[2] - r[0], r[3] - r[1]) for r in on)
    m = max(96, 1.5 * big)  # context: texture to fill from, and room for camera moves to reveal the background
    x0, y0 = int(max(0, x0 - m)) // 2 * 2, int(max(0, y0 - m)) // 2 * 2
    x1, y1 = min(W, int(x1 + m + 1)), min(H, int(y1 + m + 1))
    cw, ch = (x1 - x0) // 2 * 2, (y1 - y0) // 2 * 2
    s = min(1.0, (1.5e9 / (n * cw * ch * 3)) ** 0.5)
    sw, sh = max(2, int(cw * s) // 2 * 2), max(2, int(ch * s) // 2 * 2)
    sx, sy = sw / cw, sh / ch
    tail = f'crop={cw}:{ch}:{x0}:{y0}' + (f',scale={sw}:{sh}:flags=area' if (sw, sh) != (cw, ch) else '') + ',format=yuv444p'
    F = np.stack([f for f, _ in zip(frames(job, tail, sw, sh, 3), range(n))])
    n = len(F)
    holes = np.zeros((n, sh, sw), bool)
    for i in range(n):
        if masks is not None:  # the outline, cut to the crop at the working scale
            if rs[i]:
                mc = masks[i][int(y0 * ms):int((y0 + ch) * ms), int(x0 * ms):int((x0 + cw) * ms)].astype(np.uint8)
                holes[i] = cv2.resize(mc, (sw, sh), interpolation=cv2.INTER_LINEAR) > 0
        elif rs[i]:
            a, b, c, d = rs[i]
            holes[i, max(0, int((b - y0) * sy)):int(np.ceil((d - y0) * sy)), max(0, int((a - x0) * sx)):int(np.ceil((c - x0) * sx))] = True
    say(0.35)
    pp = best and PROPAINTER.exists() and (PROPAINTER.parent / 'weights' / 'ProPainter.pth').exists()
    filled, left, fit = classical(job, F, holes, rs[:n], (x0, y0, sx, sy), 0.35, 0.45 if pp else 0.85, synth=not pp)
    tag = 'sam2+' if masks is not None else ''
    def span(hs):  # ProPainter only over the frames that have something to fill, plus flow context either side
        on = np.flatnonzero(hs.reshape(len(hs), -1).any(1))
        return (max(0, int(on[0]) - 12), min(len(hs), int(on[-1]) + 13)) if len(on) else (0, 0)
    if pp and fit < 0.9:  # moving camera or parallax: aligned copies show seams and ghosts, ProPainter's flow doesn't
        print(f'engine {tag}propainter fit={fit:.2f}', flush=True)
        a, b = span(holes)
        filled = F.copy()
        filled[a:b] = propainter(F[a:b], holes[a:b], 0.45, 0.85)
    elif pp and left.any():  # exact aligned fill where other frames show the background; ProPainter only for the rest
        print(f'engine {tag}aligned+propainter fit={fit:.2f}', flush=True)
        a, b = span(left)
        filled[a:b] = propainter(filled[a:b], left[a:b], 0.45, 0.85)
    else:
        print(f'engine {tag}aligned fit={fit:.2f}', flush=True)
    say(0.85)

    # Poisson blend into each frame, then write the full frames back out
    k5 = np.ones((5, 5), np.uint8)
    alpha = np.zeros((n, sh, sw), np.uint8)
    for t in range(n):
        if holes[t].any():
            mm = cv2.dilate(holes[t].astype(np.uint8) * 255, k5)
            bx, by, bw, bh = cv2.boundingRect(mm)
            filled[t] = cv2.seamlessClone(filled[t], F[t], mm.copy(), (bx + bw // 2, by + bh // 2), cv2.NORMAL_CLONE)  # it overwrites its mask
            alpha[t] = mm
    del F
    enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'rawvideo', '-pix_fmt', 'yuv444p', '-s', f'{W}x{H}', '-r', f'{fps}', '-i', '-',
                            '-ss', f"{job['t0']:.6f}", '-t', f"{job['dur']:.6f}", '-i', job['src'], '-map', '0:v', '-map', '1:a:0?',  # the first sound only: iPhones add an APAC (spatial) track no decoder reads
                            *labels(job['tags']), '-c:v', 'h264_videotoolbox', '-q:v', '68', '-pix_fmt', 'yuv420p', *job['tags'],  # Apple's hardware encoder (~47 dB): the CPU stays free
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
            say(0.85 + 0.15 * min(1, (t + 1) / n))
    enc.stdin.close()
    if enc.wait():
        sys.exit('encoding the cleaned clip failed')
    say(1)


if __name__ == '__main__':
    main(sys.argv[1])
