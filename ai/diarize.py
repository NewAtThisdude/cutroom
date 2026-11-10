"""Cutroom speaker labels: who says each caption, on this Mac.
Each caption's own sound (a span of the preview's raw PCM copy: s16 48 kHz stereo) -> a WavLM x-vector (microsoft/wavlm-base-plus-sv,
via transformers) -> average-linkage clustering on cosine similarity (to n speakers, or until no two groups are alike enough)
-> two rounds of nearest-centroid reassignment. Speakers are numbered in the order they first speak.
The count is decided on the raw voices; who is who on the voices minus their mean (centred), which split two alike Kokoro
voices that raw cosine could not. The app sends one segment per sentence: 3-word captions were too little voice (62 %).
  python diarize.py job.json  ->  stdout {"labels": [0, 1, 0, -1 ...], "speakers": n, "merges": [last merge similarities]}
job: {"model": dir, "segs": [[pcm_path, s, e] | null ...], "speakers": 0 (auto) | n}"""
import json
import sys

import numpy as np
import torch
from scipy.signal import resample_poly
from transformers import AutoFeatureExtractor, WavLMForXVector

# auto count: groups this alike (mean cosine, raw) are one speaker. Kokoro fixtures, sentence segments: one voice 0.95-0.96
# within; two voices merged last at 0.39 (female + male), 0.76 (two male), 0.87 (af_heart + af_bella: counted as one).
# ponytail: tuned on TTS voices only; real recordings vary more within a speaker, so pick the count by hand if it splits one
SAME = 0.80
MIN_S = 0.8  # a caption shorter than this is heard with the sound around it, up to this long


def clusters(E, n):
    """Average linkage on cosine similarity: n > 0 merges down to n groups; n = 0 stops when no pair reaches SAME."""
    k = len(E)
    S = E @ E.T
    np.fill_diagonal(S, -np.inf)
    size, alive, lab = np.ones(k), np.ones(k, bool), np.arange(k)
    while alive.sum() > max(1, n):
        i, j = np.unravel_index(np.argmax(S), S.shape)
        MERGES.append(round(float(S[i, j]), 3))
        if not n and S[i, j] < SAME:
            break
        S[i] = S[:, i] = (size[i] * S[i] + size[j] * S[j]) / (size[i] + size[j])  # Lance-Williams for the average
        S[i, i] = -np.inf
        S[j] = S[:, j] = -np.inf
        size[i] += size[j]
        alive[j] = False
        lab[lab == j] = i
    return lab


def main():
    job = json.load(open(sys.argv[1]))
    torch.set_num_threads(4)
    fe = AutoFeatureExtractor.from_pretrained(job['model'])
    model = WavLMForXVector.from_pretrained(job['model'])
    model.train(False)
    pcms, embs, idx = {}, [], []
    for i, seg in enumerate(job['segs']):
        if not seg:
            continue
        f, s, e = seg
        if f not in pcms:
            pcms[f] = np.memmap(f, dtype='<i2', mode='r').reshape(-1, 2)
        a = pcms[f]
        if e - s < MIN_S:
            mid = (s + e) / 2
            s, e = max(0.0, mid - MIN_S / 2), mid + MIN_S / 2
        x = a[int(s * 48000):int(e * 48000)].astype(np.float32).mean(1) / 32768
        if len(x) < 4800:  # under 0.1 s: nothing to hear
            continue
        x = resample_poly(x, 1, 3)  # 16 kHz
        with torch.no_grad():
            v = model(**fe(x, sampling_rate=16000, return_tensors='pt')).embeddings[0].numpy()
        embs.append(v / (np.linalg.norm(v) + 1e-9))
        idx.append(i)
    labels = [-1] * len(job['segs'])
    if not embs:
        print(json.dumps({'labels': labels, 'speakers': 0}))
        return
    E = np.stack(embs)
    lab = clusters(E, int(job.get('speakers') or 0))  # how many: on the raw voices (auto stops at SAME)
    k = len(set(lab))
    if k > 1:  # who: on the voices minus what they all share (two alike voices were 0.87-0.96 alike before, ~85 % right)
        E = E - E.mean(0)
        E /= np.linalg.norm(E, axis=1, keepdims=True) + 1e-9
        lab = clusters(E, k)
    for _ in range(2):  # each caption to the closest speaker's average voice
        ids = sorted(set(lab))
        C = np.stack([E[lab == g].mean(0) for g in ids])
        C /= np.linalg.norm(C, axis=1, keepdims=True)
        lab = np.array(ids)[np.argmax(E @ C.T, 1)]
    order = {}
    for g in lab:
        order.setdefault(int(g), len(order))
    for i, g in zip(idx, lab):
        labels[i] = order[int(g)]
    print(json.dumps({'labels': labels, 'speakers': len(order), 'merges': MERGES[-8:]}))


MERGES = []
if __name__ == '__main__':
    main()
