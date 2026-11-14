"""Cutroom AI music, on this Mac: MusicGen (Meta, small; weights CC-BY-NC 4.0, so personal use) from a text prompt.

  music.py job.json      prints 'progress <0..1>' lines, writes job['out'] (WAV, 32 kHz mono)

job: prompt, dur (seconds, 4..60), seed (optional), out. MusicGen makes up to 30 s at a time; longer pieces continue
from the last 10 s of what came before, so they stay one piece of music rather than loops stitched together.
"""
import json
import os
import sys
import wave
from pathlib import Path

os.environ.setdefault('PYTORCH_ENABLE_MPS_FALLBACK', '1')  # before torch loads: the rare op the GPU lacks runs on the CPU
os.environ['TQDM_DISABLE'] = '1'
import numpy as np
import torch
from transformers import AutoProcessor, LogitsProcessor, MusicgenForConditionalGeneration

MODEL, SR, FPS = 'facebook/musicgen-small', 32000, 50  # 50 audio tokens per second
FP16 = Path(__file__).resolve().parent / 'vendor' / 'musicgen-small-fp16'


def say(p):
    print(f'progress {min(1.0, max(0.0, p)):.3f}', flush=True)


class Progress(LogitsProcessor):  # called once per generated step: progress for the UI
    def __init__(self, total, p0, p1):
        self.n, self.total, self.p0, self.p1 = 0, max(1, total), p0, p1

    def __call__(self, input_ids, scores):
        self.n += 1
        if self.n % 25 == 0:
            say(self.p0 + (self.p1 - self.p0) * self.n / self.total)
        return scores


def load(dev):
    """MusicGen in half precision, loaded straight onto the GPU from a half-precision copy (FP16, made once from the hub's
    float32 file): 2.4 GB peak for 8 s of music instead of 4.2-4.5 (reading the 2.4 GB float32 file and casting it took the
    rest), so it fits the ~4 GB an 8 GB Mac has for AI."""
    if dev.type not in ('mps', 'cuda'):
        return MusicgenForConditionalGeneration.from_pretrained(MODEL)
    if not (FP16 / 'model.safetensors').exists():
        tmp = FP16.with_name(FP16.name + '.tmp')
        MusicgenForConditionalGeneration.from_pretrained(MODEL, torch_dtype=torch.float16).save_pretrained(tmp)
        tmp.replace(FP16)
    return MusicgenForConditionalGeneration.from_pretrained(FP16, torch_dtype=torch.float16, device_map=dev.type)


def main(path):
    job = json.load(open(path))
    dur = float(min(60.0, max(4.0, job['dur'])))
    if job.get('seed') is not None:
        torch.manual_seed(int(job['seed']))
    dev = torch.device('cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu')
    proc = AutoProcessor.from_pretrained(MODEL)
    model = load(dev)
    say(0.05)
    out, keep, plan, made = np.zeros(0, np.float32), 10.0, [], 0.0  # continuation: the last 10 s condition the next part
    while made < dur - 0.01:  # 30 s, then 20 s more per continuation
        step = min(30.0 if not plan else 20.0, dur - made)
        plan.append(step)
        made += step
    done = 0.0
    for i, step in enumerate(plan):
        p0, p1 = 0.05 + 0.9 * done / dur, 0.05 + 0.9 * (done + step) / dur
        if i == 0:
            inputs = proc(text=[job['prompt']], padding=True, return_tensors='pt').to(dev)
            n = int(step * FPS) + 3
        else:  # condition on the tail of what we have
            inputs = proc(audio=out[-int(keep * SR):], sampling_rate=SR, text=[job['prompt']], padding=True, return_tensors='pt').to(dev)
            n = int((keep + step) * FPS) + 3
        with torch.inference_mode():
            wav = model.generate(**inputs, do_sample=True, guidance_scale=3.0, max_new_tokens=n, logits_processor=[Progress(n, p0, p1)])
        a = wav[0, 0].float().cpu().numpy()
        if i == 0:
            out = a[:int(step * SR)]
        else:  # the generated audio repeats the prompt first: keep only what is new, crossfaded for a few ms
            new = a[int(keep * SR):int((keep + step) * SR)].copy()
            fade = min(len(new), len(out), int(0.05 * SR))
            if fade:
                w = np.linspace(0, 1, fade, dtype=np.float32)
                new[:fade] = new[:fade] * w + out[-fade:] * (1 - w)
            out = np.concatenate([out, new])
        done += step
    out = out[:int(dur * SR)]
    if not np.isfinite(out).all() or float(np.abs(out).max()) < 1e-4:
        raise RuntimeError('the music model made no sound (numeric overflow): try again')
    n_in, n_out = min(len(out), int(0.03 * SR)), min(len(out), int(min(2.0, dur / 4) * SR))  # soft start, a real ending
    out[:n_in] *= np.linspace(0, 1, n_in, dtype=np.float32)
    out[-n_out:] *= np.linspace(1, 0, n_out, dtype=np.float32) ** 1.5
    out *= 0.89 / max(1e-6, float(np.abs(out).max()))  # peak at -1 dBFS
    with wave.open(job['out'], 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(out, -1, 1) * 32767).astype('<i2').tobytes())
    say(1.0)


if __name__ == '__main__':
    main(sys.argv[1])
