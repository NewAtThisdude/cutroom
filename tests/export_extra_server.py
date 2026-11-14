"""Direct export checks; no browser or HTTP server. All artifacts stay under tests/out/."""
import ast
import base64
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'tests' / 'out' / 'export-extra-server'
OUT.mkdir(parents=True, exist_ok=True)


def ff(*args):
    return subprocess.check_output(args, stderr=subprocess.PIPE).decode('utf-8')


def probe(file):
    return json.loads(ff('ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(file)))


def main():
    with tempfile.TemporaryDirectory(dir=OUT) as scratch:
        os.environ['CUTROOM_HOME'] = scratch
        os.environ['CUTROOM_PORT'] = '4899'
        spec = importlib.util.spec_from_file_location('cutroom_export_test', ROOT / 'server.py')
        s = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(s)
        for d in (s.MEDIA, s.PROJ, s.EXPORTS, s.CACHE):
            d.mkdir(parents=True, exist_ok=True)
        src = Path(scratch) / 'source.mp4'
        ff('ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=24:d=6,noise=alls=70:allf=t:all_seed=17',
           '-f', 'lavfi', '-i', 'sine=f=440:d=6', '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', '-crf', '12', '-c:a', 'aac', '-shortest', str(src))
        m = s.import_file(src.name, None, 0, background=False, src=src)
        base = {'w': 640, 'h': 360, 'fps': 24, 'duration': 6, 'bg': '#000000', 'quality': 'best', 'format': 'mp4', 'name': 'extra',
                'main': [{'media': m['id'], 'in': 0, 'out': 6, 'frames': 144, 'geom': {'x': 0, 'y': 0, 'w': 640, 'h': 360}}]}
        tracks = [{'language': lang, 'cues': [{'start': 500, 'end': 2250, 'text': text}, {'start': 3000, 'end': 5125, 'text': 'Second line'}]}
                  for lang, text in [('eng', 'Hello from Cutroom'), ('spa', 'Hola desde Cutroom')]]

        def run(**kw):
            p = s.clean_plan({**base, **kw})
            s.JOBS['extra'] = {'state': 'running'}
            s.export('extra', p)
            st = s.JOBS['extra']
            assert st['state'] == 'done', st
            file = s.EXPORTS / st['file']
            assert st['bytes'] == file.stat().st_size
            return file, st, probe(file)

        for fmt, codec in [('mp4', 'mov_text'), ('prores', 'mov_text'), ('webm', 'webvtt'), ('mkv', 'subrip')]:
            f, st, info = run(format=fmt, subtitles=tracks)
            subs = [x for x in info['streams'] if x['codec_type'] == 'subtitle']
            assert [x['codec_name'] for x in subs] == [codec, codec], subs
            assert [x['tags']['language'] for x in subs] == ['eng', 'spa'], subs
            assert [x['disposition']['default'] for x in subs] == [1, 0], subs
            for i, track in enumerate(tracks):
                txt = ff('ffmpeg', '-v', 'error', '-i', str(f), '-map', f'0:s:{i}', '-f', 'srt', '-')
                assert track['cues'][0]['text'] in txt and '00:00:00,500 --> 00:00:02,250' in txt and '00:00:03,000 --> 00:00:05,125' in txt, txt
            print(f'PASS subtitles {fmt}: {codec}, eng/spa, default 1/0, exact text and milliseconds', flush=True)

        for fmt in ('mp4', 'hevc', 'webm', 'mkv', 'av1', 'av1webm'):
            f, st, info = run(format=fmt, targetBytes=1_000_000, subtitles=tracks)
            v = next(x for x in info['streams'] if x['codec_type'] == 'video')
            assert 900000 <= st['bytes'] <= 1000000, st
            assert [v['width'], v['height']] == [640, 360] and not any('Resolution lowered' in n for n in st['notes']), st
            print(f"PASS fit {fmt}: {st['bytes']} / 1000000 bytes, {v['width']}x{v['height']}, {st['fit']}", flush=True)

        f, st, info = run(targetBytes=250000)
        v = next(x for x in info['streams'] if x['codec_type'] == 'video')
        assert st['bytes'] <= 250000 and v['height'] < 360 and any('Resolution lowered' in n for n in st['notes']), st
        print(f"PASS lowered: {st['bytes']} / 250000 bytes, {v['width']}x{v['height']}, {st['notes']}", flush=True)
        try:
            s.clean_plan({**base, 'duration': 7200, 'targetBytes': 10000000, 'main': []})
            raise AssertionError('impossible fit accepted')
        except ValueError as e:
            assert 'cannot fit' in str(e) and 'shorten' in str(e)
            print('PASS impossible: ' + str(e), flush=True)
        for fmt in ('gif', 'm4a', 'mp3'):
            f, st, info = run(format=fmt, targetBytes=300000)
            assert st['bytes'] <= 300000, st
            print(f"PASS fit {fmt}: {st['bytes']} / 300000 bytes, {st.get('notes')}", flush=True)
        print('PASS export_extra_server', flush=True)


if __name__ == '__main__':
    main()
