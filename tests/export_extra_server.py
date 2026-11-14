"""Direct export checks; no browser or HTTP server. All artifacts stay under tests/out/."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
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
        presets = '--presets' in sys.argv
        W, H, D = (1280, 720, 12) if presets else (640, 360, 6)
        src = Path(scratch) / 'source.mp4'
        ff('ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', f'testsrc2=s={W}x{H}:r=24:d={D},noise=alls={100 if presets else 70}:allf=t:all_seed=17',
           '-f', 'lavfi', '-i', f'sine=f=440:d={D}', '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', '-crf', '8' if presets else '12', '-c:a', 'aac', '-shortest', str(src))
        m = s.import_file(src.name, None, 0, background=False, src=src)
        base = {'w': W, 'h': H, 'fps': 24, 'duration': D, 'bg': '#000000', 'quality': 'best', 'format': 'mp4', 'name': 'extra',
                'main': [{'media': m['id'], 'in': 0, 'out': D, 'frames': D * 24, 'geom': {'x': 0, 'y': 0, 'w': W, 'h': H}}]}
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

        if presets:
            for mb in (10, 50, 25, 100):
                f, st, info = run(targetBytes=mb * 1000000, subtitles=tracks)
                v = next(x for x in info['streams'] if x['codec_type'] == 'video')
                assert mb * 900000 <= st['bytes'] <= mb * 1000000, st
                assert [v['width'], v['height']] == [W, H] and not st['notes'], st
                print(f"PASS preset {mb} MB: {st['bytes']} bytes ({st['bytes'] / mb / 10000:.2f}%), {W}x{H}, {st['encodeBytes']}", flush=True)
            return

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
        f, st, info = run(format='webm', alpha=True, targetBytes=1000000, main=[{**base['main'][0], 'opacity': 0.5}], subtitles=tracks)
        alpha = subprocess.check_output(['ffmpeg', '-v', 'error', '-c:v', 'libvpx-vp9', '-i', str(f), '-frames:v', '1', '-vf', 'alphaextract', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
        assert min(alpha) < 250 and st['bytes'] <= 1000000, st
        print(f"PASS alpha VP9 + soft subs: {st['bytes']} bytes, decoded alpha range {min(alpha)}–{max(alpha)}", flush=True)

        # The same burned layer with/without embedded tracks has exactly the same decoded video.
        png = Path(scratch) / 'layer.png'
        ff('ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=red:s=640x360', '-frames:v', '1', str(png))
        text = {'pngs': [base64.b64encode(png.read_bytes()).decode()], 'frames': [{'i': 0, 'start': 0.5, 'end': 2.25}]}
        burned, _, _ = run(text=text)
        both, _, _ = run(text=text, subtitles=tracks)
        md5 = lambda f: ff('ffmpeg', '-v', 'error', '-i', str(f), '-map', '0:v:0', '-f', 'framemd5', '-')
        assert md5(burned) == md5(both)
        print('PASS burned + soft: all 144 decoded frames identical to burned-only export', flush=True)

        # Long-timeline chunking and the existing loudness measurement still feed the size-controlled final pass.
        keep_chunk, s.CHUNK = s.CHUNK, 1
        try:
            clips = [{**base['main'][0], 'in': a, 'out': a + 3, 'frames': 72} for a in (0, 3)]
            f, st, _ = run(main=clips, targetBytes=1000000, loud=True, lufs=-16, subtitles=tracks)
            assert 900000 <= st['bytes'] <= 1000000, st
            print(f"PASS chunked + measured loudness + subs: {st['bytes']} bytes", flush=True)
        finally:
            s.CHUNK = keep_chunk

        hdr = Path(scratch) / 'hdr.mp4'
        ff('ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=24:d=1', '-pix_fmt', 'yuv420p10le', '-c:v', 'libx265',
           '-preset', 'ultrafast', '-x265-params', 'pools=2:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc', '-color_primaries', 'bt2020', '-colorspace', 'bt2020nc', '-color_trc', 'arib-std-b67', '-tag:v', 'hvc1', str(hdr))
        hm = s.import_file(hdr.name, None, 0, background=False, src=hdr)
        f, st, info = run(duration=1, hdr='hlg', main=[{**base['main'][0], 'media': hm['id'], 'out': 1, 'frames': 24}], targetBytes=300000,
                          subtitles=[{'language': 'eng', 'cues': [{'start': 100, 'end': 900, 'text': 'HDR caption'}]}])
        v = next(x for x in info['streams'] if x['codec_type'] == 'video')
        assert v['pix_fmt'] == 'yuv420p10le' and v['color_transfer'] == 'arib-std-b67' and v['color_primaries'] == 'bt2020' and st['bytes'] <= 300000, (st, v)
        print(f"PASS HDR fit + soft subs: {st['bytes']} bytes, {v['pix_fmt']} {v['color_transfer']} {v['color_primaries']}", flush=True)

        keep_enc, keep_vt = s.ENC.copy(), s.VT
        try:
            for family in ('videotoolbox', 'nvenc', 'qsv', 'amf'):
                s.ENC['h264'], s.VT = 'h264_' + family, family == 'videotoolbox'
                p = s.clean_plan({**base, 'quality': 'fast', 'targetBytes': 1000000})
                budget = s.fit_budget(p)
                cmd = s.ffmpeg_cmd({**p, 'fit_bps': budget['video_bps'], 'fit_audio_bps': budget['audio_bps'], 'fit_size': budget['size']}, scratch, Path(scratch) / 'args.mp4')
                assert cmd[cmd.index('-c:v') + 1] == 'h264_' + family and '-b:v' in cmd and '-q:v' not in cmd and '-pass' not in cmd
                print(f'PASS argument check only: {family} bitrate mode (hardware unavailable in sandbox)', flush=True)
        finally:
            s.ENC, s.VT = keep_enc, keep_vt
        print('PASS export_extra_server', flush=True)


if __name__ == '__main__':
    main()
