"""Cutroom AI enhance, on this Mac's GPU (PyTorch MPS, half precision): nothing uploaded.

  enhance.py job.json     prints 'progress <0..1>' lines, writes job['out'] (video + the range's sound)

job: op, src, out, t0, dur, fps, w, h (display size), dec (ffmpeg input args), vf (decode filters ending in ','),
     tags (output colour args), and per op:
  interp   factor: RIFE 4.25 (Practical-RIFE, hzwer, MIT) makes factor-1 frames between each pair -> fps x factor, same length
  upscale  scale 2 | 4: Real-ESRGAN general x4v3 (xinntao, BSD-3); x2 = the x4 result averaged 2x2
  relight  light {preset light | subject | background, x, y (0..1 on the frame), color '#rrggbb', strength 0..1}:
           Depth Anything V2 Small (Apache-2.0) per frame -> a light that falls off in 3D and lights the surfaces facing it
  zoom3d   photo (src is an image), dir in | out | left | right | orbit, amount 0..1: Depth Anything V2 Small once on the photo, then a
           parallax render from photo + depth (near things move more than far ones; the gap an edge opens is filled from the
           background behind it, not stretched from the foreground); dur seconds at fps, silent
Frames go through the GPU as BT.709 YUV <-> RGB done here (both ways the same matrix, so colours round-trip exactly);
ffmpeg's own RGB conversion guesses the matrix.
"""
import json
import math
import os
import subprocess
import sys
from pathlib import Path

os.environ.setdefault('PYTORCH_ENABLE_MPS_FALLBACK', '1')
import numpy as np  # noqa: E402
import torch  # noqa: E402
import torch.nn as nn  # noqa: E402
import torch.nn.functional as F  # noqa: E402

V = Path(__file__).resolve().parent / 'vendor' / 'enhance'
DEV = torch.device('cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu')
HALF = torch.float16 if DEV.type in ('mps', 'cuda') else torch.float32
DEPTH = ('depth-anything/Depth-Anything-V2-Small-hf', '5426e4f0f36572d16453bbda7a8389317b1bef99')
YUV2RGB = torch.tensor([[1.0, 0.0, 1.5748], [1.0, -0.187324, -0.468124], [1.0, 1.8556, 0.0]])  # BT.709, limited range
RGB2YUV = torch.linalg.inv(YUV2RGB)


def say(p):
    print(f'progress {min(1.0, max(0.0, p)):.3f}', flush=True)


def frames(job):
    """The range's frames as yuv444p planes (3, h, w) uint8."""
    w, h = job['w'], job['h']
    p = subprocess.Popen(['ffmpeg', '-v', 'error', '-nostdin', *job['dec'], '-ss', f"{job['t0']:.6f}", '-t', f"{job['dur']:.6f}", '-i', job['src'],
                          '-vf', f"{job['vf']}fps={job['fps']},scale={w}:{h},format=yuv444p", '-f', 'rawvideo', '-pix_fmt', 'yuv444p', '-'], stdout=subprocess.PIPE)
    n = w * h * 3
    try:
        while len(buf := p.stdout.read(n)) == n:
            yield np.frombuffer(buf, np.uint8).reshape(3, h, w)
    finally:
        p.stdout.close()
        p.wait()


def encoder(job, W, H, fps):
    opt = {'-colorspace': 'colorspace', '-color_primaries': 'color_primaries', '-color_trc': 'color_trc'}
    kv = [f'{opt[k]}={v}' for k, v in zip(job['tags'][::2], job['tags'][1::2]) if k in opt]  # a raw pipe has no colour labels: set them on the frames
    big = max(W, H) > 4096  # past H.264's size: HEVC
    return subprocess.Popen(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'rawvideo', '-pix_fmt', 'yuv444p', '-s', f'{W}x{H}', '-r', f'{fps:g}', '-i', '-',
                             *([] if job.get('silent') else ['-ss', f"{job['t0']:.6f}", '-t', f"{job['dur']:.6f}", '-i', job['src'], '-map', '0:v', '-map', '1:a:0?']),  # the first sound only: iPhones add an APAC (spatial) track no decoder reads
                             *(['-vf', 'setparams=' + ':'.join(kv)] if kv else []), *job.get('venc_big' if big else 'venc', ['-c:v', 'hevc_videotoolbox' if big else 'h264_videotoolbox', '-q:v', '68']),  # this computer's encoder (server.py venc)
                             *(['-tag:v', 'hvc1'] if big else []), '-pix_fmt', 'yuv420p', *job['tags'],
                             *(['-an'] if job.get('silent') else ['-c:a', 'aac', '-b:a', '192k', '-shortest']), '-movflags', '+faststart', job['out']], stdin=subprocess.PIPE)


def to_rgb(f):  # uint8 yuv444 planes -> (1, 3, h, w) RGB 0..1 on the GPU
    t = torch.from_numpy(f.copy()).to(DEV).float()
    t = torch.cat([(t[:1] - 16) / 219, (t[1:] - 128) / 224])
    return torch.einsum('ij,jhw->ihw', YUV2RGB.to(DEV), t).clamp(0, 1)[None]


def to_yuv(x):  # (1, 3, h, w) RGB 0..1 -> uint8 yuv444 bytes
    t = torch.einsum('ij,jhw->ihw', RGB2YUV.to(DEV), x[0].float().clamp(0, 1))
    t = torch.cat([t[:1] * 219 + 16, t[1:] * 224 + 128]).round().clamp(0, 255).to(torch.uint8)
    return t.cpu().numpy().tobytes()


def ready(net):
    return net.train(False).requires_grad_(False).to(DEV, HALF)


def interp(job):
    sys.path.insert(0, str(V))
    from rife.IFNet_HDv3_v4_25 import IFNet
    w, h, k = job['w'], job['h'], int(job['factor'])
    scale = 0.5 if w * h > 2304 * 1296 else 1.0  # flow at half size past 1080p (vs-rife's advice for 4K)
    net = IFNet(scale)
    sd = {a.replace('module.', ''): v for a, v in torch.load(V / 'flownet_v4.25.pkl', map_location='cpu').items()}
    if net.load_state_dict(sd, strict=False).missing_keys:  # (its training-only teacher / caltime weights are left out)
        sys.exit('the RIFE weights do not fit the model')
    net = ready(net)
    m = int(max(64, 64 / scale))
    pw, ph = -(-w // m) * m, -(-h // m) * m
    div = torch.tensor([(pw - 1) / 2, (ph - 1) / 2], device=DEV)
    grid = torch.cat([torch.linspace(-1, 1, pw, device=DEV).view(1, 1, 1, pw).expand(k - 1, 1, ph, pw),
                      torch.linspace(-1, 1, ph, device=DEV).view(1, 1, ph, 1).expand(k - 1, 1, ph, pw)], 1)
    ts = torch.tensor([i / k for i in range(1, k)], device=DEV, dtype=HALF).view(-1, 1, 1, 1).expand(k - 1, 1, ph, pw)
    B = 1 if job.get('one') else k - 1  # in-between frames made at once; one at a time on 8-16 GB (server.py AI_BUDGET): 4x of 1080p ran out of 4 GB
    E = lambda x: x.expand(B, -1, -1, -1)
    small = lambda x: F.avg_pool2d(x[:, :, :h, :w].float().mean(1, keepdim=True), 8)
    n, i, prev, f = max(1, round(job['dur'] * job['fps'])), 0, None, None
    enc = encoder(job, w, h, job['fps'] * k)
    with torch.inference_mode():
        for f in frames(job):
            img = F.pad(to_rgb(f), (0, pw - w, 0, ph - h)).to(HALF)
            feat = net.encode(img)
            if prev is not None:
                if (small(prev[0]) - small(img)).abs().mean() > 0.12:  # a cut: nothing made up across it, the earlier frame holds
                    mids = prev[0].expand(k - 1, -1, -1, -1)
                else:
                    mids = torch.cat([net(E(prev[0]), E(img), ts[j:j + B], div, grid[:B], E(prev[1]), E(feat)) for j in range(0, k - 1, B)])
                for j in range(k - 1):
                    enc.stdin.write(to_yuv(mids[j:j + 1, :, :h, :w]))
            enc.stdin.write(f.tobytes())  # the real frames pass through untouched
            prev, i = (img, feat), i + 1
            if i % 4 == 0:
                say(i / n)
        for _ in range(k - 1 if f is not None else 0):  # the last frame holds, so the copy is as long as the range
            enc.stdin.write(f.tobytes())
    enc.stdin.close()
    if enc.wait():
        sys.exit('encoding the interpolated frames failed')


class SRVGGNetCompact(nn.Module):  # Real-ESRGAN's compact model (realesrgan/archs/srvgg_arch.py, BSD-3)
    def __init__(self, feat=64, convs=32, up=4):
        super().__init__()
        body = [nn.Conv2d(3, feat, 3, 1, 1), nn.PReLU(feat)]
        for _ in range(convs):
            body += [nn.Conv2d(feat, feat, 3, 1, 1), nn.PReLU(feat)]
        self.body = nn.Sequential(*body, nn.Conv2d(feat, 3 * up * up, 3, 1, 1))
        self.up = nn.PixelShuffle(up)

    def forward(self, x):
        return self.up(self.body(x)) + F.interpolate(x, scale_factor=4, mode='nearest')


def esrgan(denoise=0.0):
    """realesr-general-x4v3 mixed with its -wdn twin by Real-ESRGAN's 'denoise strength' (1 = all x4v3, 0 = all wdn). 0 kept the most:
    on iPhone frames 2x 37.1 dB at 0, 36.0 at 0.5 (their demo's default), 34.8 at 1 (lanczos 40.5: a GAN invents texture)."""
    a = torch.load(V / 'realesr-general-x4v3.pth', map_location='cpu')['params']
    b = torch.load(V / 'realesr-general-wdn-x4v3.pth', map_location='cpu')['params']
    net = SRVGGNetCompact()
    net.load_state_dict({k: denoise * a[k] + (1 - denoise) * b[k] for k in a})
    return ready(net)


def sr(net, x, tile=480, pad=24):
    """x (1, 3, h, w) -> (1, 3, 4h, 4w), in tiles (bounded memory at any size) that overlap by more than the model's reach."""
    _, _, h, w = x.shape
    out = torch.empty(1, 3, h * 4, w * 4, device=DEV, dtype=HALF)
    for y0 in range(0, h, tile):
        for x0 in range(0, w, tile):
            y1, x1 = min(h, y0 + tile), min(w, x0 + tile)
            a, b, c, d = max(0, y0 - pad), max(0, x0 - pad), min(h, y1 + pad), min(w, x1 + pad)
            o = net(x[:, :, a:c, b:d].to(HALF))
            out[:, :, y0 * 4:y1 * 4, x0 * 4:x1 * 4] = o[:, :, (y0 - a) * 4:(y1 - a) * 4, (x0 - b) * 4:(x1 - b) * 4]
    return out


def upscale(job):
    s, w, h = int(job['scale']), job['w'], job['h']
    net, n, i = esrgan(float(job.get('denoise', 0))), max(1, round(job['dur'] * job['fps'])), 0
    W, H = (w * s) // 2 * 2, (h * s) // 2 * 2
    enc = encoder(job, W, H, job['fps'])
    with torch.inference_mode():
        for f in frames(job):
            o = sr(net, to_rgb(f), int(job.get('tile', 480))).float()  # tile: server.py's AI_BUDGET (smaller on 8 GB)
            if s == 2:
                o = F.avg_pool2d(o, 2)
            enc.stdin.write(to_yuv(o[:, :, :H, :W]))
            i += 1
            say(i / n)
    enc.stdin.close()
    if enc.wait():
        sys.exit('encoding the upscaled frames failed')


IMNET = torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1), torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1)


def depth_model():
    from transformers import DepthAnythingForDepthEstimation
    return ready(DepthAnythingForDepthEstimation.from_pretrained(DEPTH[0], revision=DEPTH[1], local_files_only=True))  # setup.sh fetched it


def depth(model, x):
    """Relative nearness of x (1, 3, h, w) at the model's size (short side 518, multiples of 14), bigger = nearer."""
    _, _, h, w = x.shape
    s = 518 / min(h, w)
    z = F.interpolate(x, (max(14, round(h * s / 14) * 14), max(14, round(w * s / 14) * 14)), mode='bilinear', antialias=True, align_corners=False)
    z = (z - IMNET[0].to(DEV)) / IMNET[1].to(DEV)
    return model(pixel_values=z.to(HALF)).predicted_depth.float()[:, None]


def hexrgb(c):
    c = str(c or '#ffffff').lstrip('#')
    return [int(c[i:i + 2], 16) / 255 for i in (0, 2, 4)] if len(c) == 6 else [1.0, 1.0, 1.0]


def box(x, r):  # mean over a (2r+1)^2 window, edges repeated
    return F.avg_pool2d(F.pad(x, (r, r, r, r), mode='replicate'), 2 * r + 1, 1)


def blur(x, r):  # ~Gaussian: three box passes
    return box(box(box(x, r), r), r)


def luma(x):
    return (0.2126 * x[:, :1] + 0.7152 * x[:, 1:2] + 0.0722 * x[:, 2:]).float()


def guided_up(p, I, Ih, r=4, eps=4e-4):
    """Fast guided filter (He & Sun 2015): p (1, C, h, w) made at the depth map's size follows the edges of the full-size
    picture Ih (its luma; I = Ih at h x w). Plain upscaling put a bright rim on the wall around every head."""
    mI, mp = box(I, r), box(p, r)
    A = (box(I * p, r) - mI * mp) / (box(I * I, r) - mI * mI + eps)
    A, b = box(A, r), box(mp - A * mI, r)
    up = lambda t: F.interpolate(t, Ih.shape[-2:], mode='bilinear', align_corners=False)
    return up(A) * Ih + up(b)


class Relight:
    """The light from depth, at the depth map's size, then made to follow the picture's edges (guided_up). Nearness is
    normalized per frame by its 2nd / 98th percentiles, smoothed over time (the range jumps when something enters); the
    gain map then holds where the picture holds (each spot mixed with the last frame's as much as it did not change),
    so a still shot does not shimmer with the model's frame-to-frame noise, and what moves follows at once."""

    def __init__(self, light, model=None):
        self.L, self.model, self.lo, self.hi, self.g, self.y = light, model or depth_model(), None, None, None, None

    def gain(self, x):
        raw = depth(self.model, x)
        q = torch.quantile(F.avg_pool2d(raw, 4).flatten(), torch.tensor([0.02, 0.98], device=DEV))
        first = self.lo is None
        self.lo = q[0] if first else self.lo + 0.15 * (q[0] - self.lo)
        self.hi = q[1] if first else self.hi + 0.15 * (q[1] - self.hi)
        d = ((raw - self.lo) / (self.hi - self.lo).clamp(min=1e-6)).clamp(0, 1)
        L = self.L
        s, col = float(L.get('strength', 0.6)), torch.tensor(hexrgb(L.get('color')), device=DEV).view(1, 3, 1, 1)
        near = ((d - 0.35) / 0.35).clamp(0, 1)
        near = near * near * (3 - 2 * near)  # smoothstep: the subject (the near half) vs the background
        if L.get('preset') == 'subject':
            return 1 + s * 0.9 * near * col
        if L.get('preset') == 'background':
            return 1 - s * 0.75 * (1 - near) * (2 - col)  # a coloured darkening keeps more of that colour
        # a point light just in front of the nearest surface (z -0.1; z: 0 = the nearest surface .. 1 = the farthest) at (x, y) on the frame:
        # that close, what is beside it and what faces it catch it (further out it only tinted everything)
        _, _, dh, dw = d.shape
        asp = dw / dh
        gy, gx = torch.meshgrid(torch.linspace(0, 1, dh, device=DEV), torch.linspace(0, 1, dw, device=DEV), indexing='ij')
        z, zs = 1 - d[0, 0], 1 - blur(d, 3)[0, 0]  # surfaces' directions from the smoothed depth (the model's fine noise out)
        zx = F.pad(zs[None, :, 2:] - zs[None, :, :-2], (1, 1), mode='replicate')[0] / 2 * dw / asp  # depth change per frame height
        zy = F.pad(zs[None, None, 2:] - zs[None, None, :-2], (0, 0, 1, 1), mode='replicate')[0, 0] / 2 * dh
        nrm = torch.stack([zx, zy, -torch.ones_like(z)])  # facing the camera = (0, 0, -1); a wall going away to the right faces right
        nrm = nrm / nrm.norm(dim=0, keepdim=True)
        lv = torch.stack([(float(L.get('x', 0.25)) - gx) * asp, float(L.get('y', 0.3)) - gy, -0.1 - z])
        dist = lv.norm(dim=0, keepdim=True)
        lam = (nrm * lv / dist).sum(0, keepdim=True).clamp(min=0)
        return 1 + s * 3.0 * (lam / (1 + (dist / 0.35) ** 2))[None] * col  # falls off fast: the near subject catches it, the wall much less

    def apply(self, x):
        Ih = luma(x)
        g = self.gain(x)
        y = F.interpolate(Ih, g.shape[-2:], mode='bilinear', antialias=True, align_corners=False)
        if self.g is not None:  # each spot keeps the last frame's light as much as the picture there held still (6 levels of change = all new)
            a = (blur((y - self.y).abs(), 2) * 255 / 6).clamp(0.08, 1)
            g = self.g + a * (g - self.g)
        self.g, self.y = g, y
        return (x.float() ** 2.2 * guided_up(g, y, Ih)).clamp(0, 1) ** (1 / 2.2)  # light adds in linear light


def relight(job):
    w, h = job['w'], job['h']
    R, n, i = Relight(job['light']), max(1, round(job['dur'] * job['fps'])), 0
    enc = encoder(job, w, h, job['fps'])
    with torch.inference_mode():
        for f in frames(job):
            enc.stdin.write(to_yuv(R.apply(to_rgb(f))))
            i += 1
            if i % 3 == 0:
                say(i / n)
    enc.stdin.close()
    if enc.wait():
        sys.exit('encoding the relit frames failed')


def photo(job):
    """The photo at the render size as RGB 0..1 (1, 3, h, w) on the GPU (ffmpeg turns EXIF rotation and decodes JPEG / PNG)."""
    w, h = job['w'], job['h']
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-i', job['src'], '-vf', f'scale={w}:{h}:flags=lanczos,format=rgb24', '-frames:v', '1',
                          '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True, check=True).stdout
    if len(raw) != w * h * 3:
        sys.exit('could not read that photo')
    return torch.from_numpy(np.frombuffer(raw, np.uint8).reshape(h, w, 3).copy()).to(DEV).permute(2, 0, 1)[None].float() / 255


def photo_depth(x):
    """Nearness 0 (far) .. 1 (near) of the photo at its own size: the model's map stretched to its 2nd..98th percentile, then made to
    follow the photo's edges (guided_up)."""
    with torch.inference_mode():
        raw = depth(depth_model(), x)
        q = torch.quantile(F.avg_pool2d(raw, 4).flatten(), torch.tensor([0.02, 0.98], device=DEV))
        d = ((raw - q[0]) / (q[1] - q[0]).clamp(min=1e-6)).clamp(0, 1)
        Ih = luma(x)
        y = F.interpolate(Ih, d.shape[-2:], mode='bilinear', antialias=True, align_corners=False)
        return guided_up(d, y, Ih).clamp(0, 1)


def camera(kind, amt, u):
    """The camera at u (0..1 through the clip): nearness L (0 far .. 1 near) -> (zoom, dx, dy), offsets in frame widths. Near things zoom and
    slide more than far ones; the base zoom grows with the slide, so the frame's edges are never reached."""
    e = u * u * (3 - 2 * u)
    if kind in ('in', 'out'):
        k = e if kind == 'in' else 1 - e
        return lambda L: (1 + k * amt * 0.22 * (0.35 + L), 0.0, 0.0)
    if kind == 'orbit':
        a, s = 2 * math.pi * u, math.sin(math.pi * u)
        return lambda L: (1 + 0.1 * amt * s, amt * 0.05 * (L - 0.5) * math.sin(a), amt * 0.05 * (L - 0.5) * (1 - math.cos(a)) / 2)
    sg = 1 if kind == 'right' else -1
    return lambda L: (1 + 0.09 * amt * e, sg * amt * 0.06 * (L - 0.5) * e, 0.0)


class Parallax:
    """The photo seen from a moving camera. For each output pixel the nearest surface that lands on it is found by marching down through
    depth levels (a level L is hit when the photo's depth where it comes from, at that level's camera, is at least L; refined between levels),
    and the colour comes from there. Where that finds a foreground edge the camera has slid off its background (no real surface at that
    depth), the colour is the background plate instead: each place's colour from the farthest point within reach of the slide, so the gap
    fills with what was behind the edge, not a smear of the edge."""

    def __init__(self, x, d, kind, amt, n=48):
        self.x, self.d, self.kind, self.amt, self.n = x, d, kind, amt, n
        _, _, self.h, self.w = x.shape
        ys, xs = torch.meshgrid(torch.linspace(-1, 1, self.h, device=DEV), torch.linspace(-1, 1, self.w, device=DEV), indexing='ij')
        self.g = torch.stack([xs, ys], -1)[None]
        f = 4  # the plate at a quarter size: it only fills small gaps, and soft is right for them
        small = lambda t: F.interpolate(t, (max(8, self.h // f), max(8, self.w // f)), mode='area')
        xs_, ds = small(x), small(d)
        r = max(2, round(0.07 * self.w / f * max(self.amt, 0.3)))
        idx = F.max_pool2d(F.pad(-ds, (r, r, r, r), value=-2.0), 2 * r + 1, 1, return_indices=True)[1]  # the farthest point within reach of each place
        sh, sw = ds.shape[-2:]
        pw = sw + 2 * r  # indices are into the padded map
        iy, ix = (idx[0, 0] // pw - r).clamp(0, sh - 1), (idx[0, 0] % pw - r).clamp(0, sw - 1)
        up = lambda t: F.interpolate(t, (self.h, self.w), mode='bilinear', align_corners=False)
        self.plate, self.dmin = up(xs_[0][:, iy, ix][None]), up(ds[0, 0][iy, ix][None, None])

    def q(self, cam, L):
        """Where each output place comes from, for a surface at nearness L (a number, or a map (1, 1, h, w)). The camera's zoom and
        slide are linear in L, so a map of levels is read off its two ends."""
        (z0, x0, y0), (z1, x1, y1) = cam(0.0), cam(1.0)
        if not torch.is_tensor(L):
            L = torch.full((1, 1, self.h, self.w), float(L), device=DEV)
        z, dx, dy = (a + (b - a) * L[0, 0][None, ..., None] for a, b in ((z0, z1), (x0, x1), (y0, y1)))
        return self.g / z + torch.cat([2 * dx, 2 * dy * self.w / self.h], -1)

    def sample(self, t, g):
        return F.grid_sample(t, g, mode='bilinear', padding_mode='border', align_corners=True)

    def frame(self, u):
        cam, n = camera(self.kind, self.amt, u), self.n
        Ls, done, fp = torch.zeros(1, 1, self.h, self.w, device=DEV), torch.zeros(1, 1, self.h, self.w, device=DEV, dtype=torch.bool), None
        for i in range(n + 1):  # from the nearest level down: the first one the photo reaches is the surface this pixel shows
            L = 1 - i / n
            f = self.sample(self.d, self.q(cam, L)) - L
            hit = (~done) & (f >= 0)
            frac = (f / (f - fp).clamp(max=-1e-6)).clamp(0, 1) / n if i else 0.0  # between this level and the one above: where the depth crosses
            Ls = torch.where(hit, L + frac, Ls)
            done, fp = done | hit, f
        Ls = Ls.clamp(0, 1)
        q = self.q(cam, Ls)
        col = self.sample(self.x, q)
        # a gap: the photo at that source is much nearer than the level this pixel was given (the camera slid a near edge off its background)
        wgt = ((self.sample(self.d, q) - Ls - 0.03) / 0.08).clamp(0, 1)
        wgt = F.avg_pool2d(F.pad(wgt, (1, 1, 1, 1), mode='replicate'), 3, 1)  # a soft edge to the gap
        return col + wgt * (self.sample(self.plate, self.q(cam, self.dmin)) - col)


def zoom3d(job):
    w, h = job['w'], job['h']
    x = photo(job)
    P = Parallax(x, photo_depth(x), job['dir'], float(job['amount']))
    n = max(2, round(job['dur'] * job['fps']))
    enc = encoder(job, w, h, job['fps'])
    with torch.inference_mode():
        for i in range(n):
            enc.stdin.write(to_yuv(P.frame(i / (n - 1))))
            say(0.1 + 0.88 * (i + 1) / n)
    enc.stdin.close()
    if enc.wait():
        sys.exit('encoding the 3D zoom failed')


MODEL = {}


def preview(job):
    """One frame at job['t'] relit, as a PNG at job['out'] at most 960 px wide (the editor's 'Preview frame', through
    ai/worker.py: the depth model stays loaded between clicks). The same maths as the first frame of relight()."""
    w = min(960, job['w']) // 2 * 2
    h = round(job['h'] * w / job['w']) // 2 * 2
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', *job['dec'], '-ss', f"{job['t']:.6f}", '-i', job['src'], '-frames:v', '1',
                          '-vf', f"{job['vf']}scale={w}:{h},format=yuv444p", '-f', 'rawvideo', '-pix_fmt', 'yuv444p', '-'], capture_output=True, check=True).stdout
    if len(raw) != w * h * 3:
        raise RuntimeError('could not read that frame')
    if 'depth' not in MODEL:
        MODEL['depth'] = depth_model()
    with torch.inference_mode():
        x = Relight(job['light'], MODEL['depth']).apply(to_rgb(np.frombuffer(raw, np.uint8).reshape(3, h, w)))
    import cv2
    rgb = (x[0].permute(1, 2, 0).clamp(0, 1) * 255).round().to(torch.uint8).cpu().numpy()
    cv2.imwrite(job['out'], rgb[..., ::-1])
    return {'w': w, 'h': h}


if __name__ == '__main__':
    j = json.loads(Path(sys.argv[1]).read_text())
    {'interp': interp, 'upscale': upscale, 'relight': relight, 'zoom3d': zoom3d}[j['op']](j)
    say(1)
