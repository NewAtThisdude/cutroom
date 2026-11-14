"""Ground truth for Remove object on fox-walk (tests/fixtures.mjs aiFootage): its clean plate is the same shot without the fox.
  fox_truth.py mask <fox.mp4> <plate.mp4> <t> <mask.png>   -> JSON: how much of the true fox (and of its legs) the outline covers
  fox_truth.py fill <plate.mp4> <cleaned.mp4>              -> JSON: worst 8 px block (levels off the clean plate) per frame
Run with the AI venv's python (numpy, OpenCV)."""
import json
import subprocess
import sys

import cv2
import numpy as np

def gray(f, t=None, n=1):
    raw = subprocess.run(['ffmpeg', '-v', 'error', *(['-ss', str(t)] if t is not None else []), '-i', f, '-frames:v', str(n), '-vf', 'format=gray',
                          '-f', 'rawvideo', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, 720, 1280).astype(np.int16)


def main(mode, *a):
    if mode == 'mask':
        fox_mp4, plate, t, png = a[0], a[1], float(a[2]), a[3]
        fox = np.abs(gray(fox_mp4, t)[0] - gray(plate, t)[0]) > 30
        fox = cv2.morphologyEx(fox.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)) > 0
        m = cv2.resize(cv2.imread(png, cv2.IMREAD_GRAYSCALE), (1280, 720), interpolation=cv2.INTER_NEAREST) > 127
        legs = fox.copy()
        legs[:590] = False  # the dark legs, which the old pick left behind
        return {'fox': round(float((m & fox).sum() / fox.sum()), 4), 'legs': round(float((m & legs).sum() / max(1, legs.sum())), 4),
                'extra_px': int((m & ~fox).sum())}
    ref, out = gray(a[0], n=120), gray(a[1], n=120)
    n = min(len(ref), len(out))
    worst = np.abs(out[:n] - ref[:n]).reshape(n, 90, 8, 160, 8).mean(axis=(2, 4)).max(axis=(1, 2))
    return {'frames': n, 'worst': [round(float(x), 1) for x in worst], 'over20': int((worst > 20).sum()), 'over40': int((worst > 40).sum())}


if __name__ == '__main__':
    print(json.dumps(main(*sys.argv[1:])))
