"""Cutroom's AI worker: one long-lived process that keeps SAM 2's image model (and the frame it last embedded) and Kokoro
loaded between requests. Starting a process per outline click reloaded SAM 2 every time (3.7-36 s per click).

  worker.py <idle seconds>    reads one JSON request per line on stdin, answers one JSON line each on stdout:
    {"id": n, "op": "preview", "job": {...}}                -> {"id": n, "result": {...}}   (remove.preview)
    {"id": n, "op": "voice", "text", "voice", "speed", "out"} -> {"id": n, "result": {}}      (Kokoro, a WAV at out)
    any failure                                              -> {"id": n, "error": "..."}
Exits after <idle> seconds without a request (0 = after each answer: a Mac under 16 GB needs that memory back), or when
the server goes (stdin closes). Model output and warnings go to stderr: stdout carries only the answers.
"""
import json
import os
import select
import sys

KOKORO = 'mlx-community/Kokoro-82M-bf16'
out = os.fdopen(os.dup(1), 'w', buffering=1)
os.dup2(2, 1)  # anything a library prints lands in the log, not in an answer
sys.stdout = sys.stderr
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import remove  # noqa: E402

models = {}


def voice(req):
    from mlx_audio.tts.generate import generate_audio
    from mlx_audio.tts.utils import load_model
    if 'kokoro' not in models:
        models['kokoro'] = load_model(model_path=KOKORO)
    base = req['out'][:-4]
    generate_audio(req['text'], model=models['kokoro'], voice=req['voice'], speed=req['speed'], lang_code=req['voice'][0],
                   file_prefix=base, audio_format='wav', join_audio=True, verbose=False)
    if not os.path.exists(req['out']):  # generate_audio prints its errors instead of raising them
        raise RuntimeError('Kokoro made no audio')
    return {}


def main(idle):
    while True:
        if idle and not select.select([sys.stdin], [], [], idle)[0]:
            return
        line = sys.stdin.readline()
        if not line:
            return
        req = json.loads(line)
        try:
            res = {'id': req.get('id'), 'result': remove.preview(req['job']) if req['op'] == 'preview' else voice(req)}
        except Exception as e:  # sent back to the editor
            res = {'id': req.get('id'), 'error': str(e) or type(e).__name__}
        out.write(json.dumps(res) + '\n')
        if not idle:
            return


if __name__ == '__main__':
    main(float(sys.argv[1]) if len(sys.argv) > 1 else 300)
