# SPDX-License-Identifier: GPL-3.0-or-later
"""Effects-pack expressions for the export where there is no Metal (Windows, Linux): the same job and the same pipes as
tools/fxgpu.swift, vectorised. Raw planar frames (gbrp, or gbrap with alpha) in on stdin, out on stdout; each expression
runs on its own frames [a, b), in order, each one reading what the one before it wrote.
  python fxexpr.py <width> <height> <planes 3|4> <expressions.json> <a,b;a,b;...>
expressions.json: [[er, eg, eb], ...], one per window: geq expressions as server.py's xexpr checked them (only the names
below, numbers and + - * / ( ) , ;). They are parsed here into closures, never eval'd. Semantics as msl_expr (Metal):
; runs left to right, st/ld are 10 locals per channel starting at 0, if/ifnot only work out the branch a pixel takes
(a branch is skipped where no pixel takes it; elsewhere it runs under a mask so its st() writes only those pixels),
r/g/b(x, y) fetch the nearest pixel clamped to the frame, the result is clipped to 0..255 and truncated, float32.
Backends: CUTROOM_FX_BACKEND=cuda (PyTorch on an NVIDIA GPU) | numpy (every core: the frame in row bands, one thread
each; numpy lets go of the GIL inside its loops). Default: cuda when PyTorch sees a GPU, else numpy. The last stderr
line says which ran, how long it took and the peak memory."""
import json, os, re, sys, threading, time

NAMES = {'X', 'Y', 'W', 'H', 'N', 'PI', 'LF', 'if', 'ifnot', 'lt', 'lte', 'gt', 'gte', 'eq', 'between', 'min', 'max', 'abs', 'floor', 'ceil', 'trunc',
         'sqrt', 'exp', 'log', 'sin', 'cos', 'tan', 'atan', 'atan2', 'mod', 'pow', 'clip', 'hypot', 'r', 'g', 'b', 'st', 'ld', 'TO'}  # = server.py XNAMES
PLANE = {'g': 0, 'b': 1, 'r': 2}  # gbrp's plane order
CMP = {'lt': lambda a, b: a < b, 'lte': lambda a, b: a <= b, 'gt': lambda a, b: a > b, 'gte': lambda a, b: a >= b, 'eq': lambda a, b: a == b}


class Numpy:
    name = 'numpy'

    def __init__(self):
        import numpy as np
        np.seterr(all='ignore')  # x / 0, log(0), sqrt(-1): inf / nan as on the GPU, never an exception
        self.np, self.f32 = np, np.float32
        self.fn = {'min': np.minimum, 'max': np.maximum, 'abs': np.abs, 'floor': np.floor, 'ceil': np.ceil, 'trunc': np.trunc, 'sqrt': np.sqrt,
                   'exp': np.exp, 'log': np.log, 'sin': np.sin, 'cos': np.cos, 'tan': np.tan, 'atan': np.arctan, 'atan2': np.arctan2,
                   'pow': np.power, 'hypot': np.hypot}

    def const(self, v):  # numbers are float32 scalars: float32 maths with the arrays (a float64 one would promote them), x / 0 = inf
        return self.f32(v)

    def scalar(self, v):
        return self.np.ndim(v) == 0

    def flt(self, m):
        return m.astype(self.f32) if isinstance(m, self.np.ndarray) else self.f32(bool(m))

    def where(self, m, a, b):
        return (a if m else b) if self.np.ndim(m) == 0 else self.np.where(m, a, b)

    def any(self, m):
        return bool(m.any())

    def all(self, m):
        return bool(m.all())

    def clip(self, x, a, b):
        return self.np.minimum(self.np.maximum(x, a), b)

    def fetch(self, plane, x, y):  # nearest, clamped (nan -> 0, as the GPU's int())
        np = self.np
        xi = np.clip(np.clip(x, 0, plane.shape[1] - 1).astype(np.intp), 0, plane.shape[1] - 1)
        yi = np.clip(np.clip(y, 0, plane.shape[0] - 1).astype(np.intp), 0, plane.shape[0] - 1)
        return plane[yi, xi].astype(self.f32)


class Cuda(Numpy):
    name = 'cuda'

    def __init__(self):
        import torch
        if not torch.cuda.is_available():
            raise RuntimeError('PyTorch sees no CUDA GPU')
        t, self.t, self.dev, self.f32 = torch, torch, torch.device('cuda'), torch.float32
        self.fn = {'min': t.minimum, 'max': t.maximum, 'abs': t.abs, 'floor': t.floor, 'ceil': t.ceil, 'trunc': t.trunc, 'sqrt': t.sqrt,
                   'exp': t.exp, 'log': t.log, 'sin': t.sin, 'cos': t.cos, 'tan': t.tan, 'atan': t.atan, 'atan2': t.atan2,
                   'pow': t.pow, 'hypot': t.hypot}

    def const(self, v):  # every value a tensor on the GPU (0-d for a number): one kind of value, every function takes it
        return self.t.tensor(float(v), dtype=self.f32, device=self.dev)

    def scalar(self, v):
        return v.dim() == 0

    def flt(self, m):
        return m.to(self.f32)

    def where(self, m, a, b):
        return (a if bool(m) else b) if m.dim() == 0 else self.t.where(m, a, b)

    def clip(self, x, a, b):
        return self.t.minimum(self.t.maximum(x, a), b)

    def fetch(self, plane, x, y):
        xi = x.clamp(0, plane.shape[1] - 1).long().clamp(0, plane.shape[1] - 1)
        yi = y.clamp(0, plane.shape[0] - 1).long().clamp(0, plane.shape[0] - 1)
        return plane[yi, xi].to(self.f32)


class Ctx:  # one channel of one band of one frame: where the pixels are, the frame number, the lets, the branch mask
    __slots__ = ('X', 'Y', 'LF', 'L', 'mask', 'src')


def compile_expr(s, B):
    """One geq expression -> fn(ctx) -> its value (an array, or a scalar where it doesn't depend on the pixel)."""
    toks, i = re.findall(r'[A-Za-z_]\w*|\d+\.?\d*|\.\d+|\S', s), 0
    for t in toks:
        if not (t in NAMES or t[0].isdigit() or t[0] == '.' and len(t) > 1 or t in '+-*/(),;'):
            raise ValueError(f'bad expression token {t!r}')

    def peek():
        return toks[i] if i < len(toks) else ''

    def eat(t=None):
        nonlocal i
        if t is not None and peek() != t:
            raise ValueError(f'expected {t!r} in an effect expression')
        if i >= len(toks):
            raise ValueError('an effect expression ends too early')
        i += 1
        return toks[i - 1]

    def seq():
        parts = [add()]
        while peek() == ';':
            eat()
            parts.append(add())
        if len(parts) == 1:
            return parts[0]

        def run(c):
            for p in parts[:-1]:
                p(c)
            return parts[-1](c)
        return run

    def binop(op, a, b):
        return {'+': lambda c: a(c) + b(c), '-': lambda c: a(c) - b(c), '*': lambda c: a(c) * b(c), '/': lambda c: a(c) / b(c)}[op]

    def add():
        v = mul()
        while peek() in ('+', '-'):
            v = binop(eat(), v, mul())
        return v

    def mul():
        v = unary()
        while peek() in ('*', '/'):
            v = binop(eat(), v, unary())
        return v

    def unary():
        if peek() in ('-', '+'):
            neg, a = eat() == '-', unary()
            return (lambda c: -a(c)) if neg else a
        return prim()

    def prim():
        t = eat()
        if t == '(':
            v = seq()
            eat(')')
            return v
        if t[0].isdigit() or t[0] == '.':
            k = B.const(float(t))
            return lambda c: k
        if peek() != '(':
            if t in ('X', 'Y'):
                return (lambda c: c.X) if t == 'X' else (lambda c: c.Y)
            if t in ('N', 'LF'):
                return lambda c: c.LF
            k = {'W': B.W, 'H': B.H, 'PI': B.const(3.141592653589793), 'TO': B.const(1.0)}.get(t)
            if k is None:
                raise ValueError(f'{t} is a function')
            return lambda c: k
        eat('(')
        args = [seq()]
        while peek() == ',':
            eat()
            args.append(seq())
        eat(')')
        if t in ('st', 'ld'):
            if len(args) != (2 if t == 'st' else 1):
                raise ValueError(f'{t}() takes {2 if t == "st" else 1} arguments')
            try:
                k = int(float(args[0](None)))  # a number (anything that reads the pixel fails here)
            except Exception:
                raise ValueError(f'{t}(): the index must be a number') from None
            if not 0 <= k <= 9:
                raise ValueError('st/ld index out of range')
            if t == 'ld':
                return lambda c: c.L[k]
            v = args[1]

            def st(c):
                x = v(c)
                c.L[k] = x if c.mask is None else B.where(c.mask, x, c.L[k])
                return x
            return st
        if t in ('if', 'ifnot'):
            if len(args) not in (2, 3):
                raise ValueError(f'{t}() takes 2 or 3 arguments')
            cond, yes, no = args[0], args[1], args[2] if len(args) > 2 else (lambda c, z=B.const(0.0): z)
            if t == 'ifnot':
                yes, no = no, yes

            def branch(c):
                m = cond(c)
                if B.scalar(m):
                    return yes(c) if bool(m != 0) else no(c)
                m = m != 0  # (nan counts as true, as in ffmpeg and on the GPU)
                if B.all(m):
                    return yes(c)
                if not B.any(m):
                    return no(c)
                old = c.mask
                c.mask = m if old is None else old & m
                a = yes(c)
                c.mask = ~m if old is None else old & ~m
                b = no(c)
                c.mask = old
                return B.where(m, a, b)
            return branch
        if t in CMP:
            f, (a, b) = CMP[t], args
            return lambda c: B.flt(f(a(c), b(c)))
        if t == 'between':
            x, a, b = args

            def between(c):
                v = x(c)
                return B.flt((v >= a(c)) & (v <= b(c)))
            return between
        if t == 'clip':
            x, a, b = args
            return lambda c: B.clip(x(c), a(c), b(c))
        if t == 'mod':  # x - y floor(x / y), put back in [0, y) where float32 division landed a whole y off (msl xmod)
            a, b = args

            def mod(c):
                x, y = a(c), b(c)
                m = x - y * B.fn['floor'](x / y)
                return B.where(m >= y, m - y, B.where(m < 0, m + y, m))
            return mod
        if t in PLANE:
            p, (x, y) = PLANE[t], args
            return lambda c: B.fetch(c.src[p], x(c), y(c))
        if t in B.fn:
            f = B.fn[t]
            if len(args) == 1:
                a = args[0]
                return lambda c: f(a(c))
            a, b = args
            return lambda c: f(a(c), b(c))
        raise ValueError(f'{t} is not a function')

    v = seq()
    if i != len(toks):
        raise ValueError('trailing tokens in an effect expression')
    return v


def backend():
    want = os.environ.get('CUTROOM_FX_BACKEND', '').strip().lower()
    if want in ('', 'auto', 'cuda'):
        try:
            return Cuda()
        except Exception as e:  # no PyTorch, or no GPU: numpy, unless the GPU was asked for
            if want == 'cuda':
                sys.exit(f'fxexpr: cuda unavailable: {e}')
    return Numpy()


def main():
    a = sys.argv
    if a[1:] == ['--probe']:  # server.py: which backend this Python has (numpy missing: an ImportError, exit 1)
        return print(backend().name)
    if len(a) != 6 or a[3] not in ('3', '4'):
        sys.exit('usage: fxexpr.py W H planes expressions.json a,b;a,b | --probe')
    W, H, P = int(a[1]), int(a[2]), int(a[3])
    wins = [tuple(int(v) for v in w.split(',')) for w in a[5].split(';')]
    exprs = json.load(open(a[4], encoding='utf-8'))
    B = backend()
    import numpy as np
    B.np = np
    B.W, B.H = B.const(W), B.const(H)
    fns = [[compile_expr(e[c], B) for c in (1, 2, 0)] for e in exprs]  # planes g, b, r
    if len(fns) != len(wins):
        sys.exit('fxexpr: one expression set per window')
    n, t0, frame = W * H * P, time.time(), 0
    inp, out = sys.stdin.buffer, sys.stdout.buffer
    buf = bytearray(n)
    view = memoryview(buf)
    threads = max(1, min(32, os.cpu_count() or 1))
    rows = max(1, min(H, 262144 // max(W, 1)))  # bands of ~256 K pixels (1 MB a float32 array: the lets stay in cache)
    bands = [(y, min(H, y + rows)) for y in range(0, H, rows)]
    pool = None
    if B.name == 'numpy' and threads > 1:
        from concurrent.futures import ThreadPoolExecutor
        pool = ThreadPoolExecutor(threads)
    Xn = np.arange(W, dtype=np.float32)[None, :]

    def band(fx, src, dst, lf, y0, y1):
        c = Ctx()
        c.X, c.Y, c.LF, c.src = Xn, np.arange(y0, y1, dtype=np.float32)[:, None], np.float32(lf), src
        for pl in range(3):
            c.L, c.mask = [np.float32(0)] * 10, None
            dst[pl, y0:y1] = np.clip(fx[pl](c), 0, 255)  # (the float -> uint8 store truncates)

    def read():
        got = 0
        while got < n:
            r = inp.readinto(view[got:])
            if not r:
                return False
            got += r
        return True

    if B.name == 'cuda':
        t = B.t
        Xc = t.arange(W, dtype=t.float32, device=B.dev)[None, :]
        Yc = t.arange(H, dtype=t.float32, device=B.dev)[:, None]
        host = t.empty(n, dtype=t.uint8).pin_memory()
    try:
        while read():
            on = [k for k, (wa, wb) in enumerate(wins) if wa <= frame < wb]
            if on and B.name == 'cuda':
                host.numpy()[:] = np.frombuffer(buf, np.uint8)
                cur = host.to(B.dev, non_blocking=True).view(P, H, W)
                for k in on:
                    c = Ctx()
                    c.X, c.Y, c.LF, c.src = Xc, Yc, B.const(frame - wins[k][0]), cur
                    nxt = cur.clone()
                    for pl in range(3):
                        c.L, c.mask = [B.const(0.0)] * 10, None
                        v = fns[k][pl](c)
                        nxt[pl] = B.clip(v, B.const(0.0), B.const(255.0)).expand(H, W).to(t.uint8)
                    cur = nxt
                host.copy_(cur.reshape(-1))
                out.write(host.numpy().tobytes())
            elif on:
                cur = np.frombuffer(buf, np.uint8).reshape(P, H, W).copy()
                for k in on:
                    nxt = cur.copy() if P == 4 else np.empty_like(cur)
                    jobs = [(fns[k], cur, nxt, frame - wins[k][0], y0, y1) for y0, y1 in bands]
                    if pool:
                        list(pool.map(lambda j: band(*j), jobs))
                    else:
                        for j in jobs:
                            band(*j)
                    cur = nxt
                out.write(cur.tobytes())
            else:
                out.write(buf)
            frame += 1
        out.flush()
    except BrokenPipeError:  # the reader went away (it had all it needed)
        sys.stderr.close()
        return
    peak = ''
    try:
        if os.name == 'nt':
            import ctypes
            from ctypes import wintypes

            class PMC(ctypes.Structure):
                _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD)] + [(f, ctypes.c_size_t) for f in (
                    'PeakWorkingSetSize', 'WorkingSetSize', 'QuotaPeakPagedPoolUsage', 'QuotaPagedPoolUsage', 'QuotaPeakNonPagedPoolUsage',
                    'QuotaNonPagedPoolUsage', 'PagefileUsage', 'PeakPagefileUsage')]
            m = PMC()
            m.cb = ctypes.sizeof(m)
            ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.windll.kernel32.GetCurrentProcess(), ctypes.byref(m), m.cb)
            peak = f' peak {m.PeakWorkingSetSize >> 20} MB'
        else:
            import resource
            r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            peak = f" peak {r >> (20 if sys.platform == 'darwin' else 10)} MB"
        if B.name == 'cuda':
            peak += f', GPU {B.t.cuda.max_memory_allocated() >> 20} MB'
    except Exception:
        pass
    print(f'fxexpr: {B.name}{f" x{threads}" if pool else ""}, {frame} frames {W}x{H} in {time.time() - t0:.1f} s,{peak}', file=sys.stderr, flush=True)


if __name__ == '__main__':
    main()
