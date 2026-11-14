"""Direct export checks; no browser or HTTP server. All artifacts stay under tests/out/."""
import base64
import html
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ['CUTROOM_HOME']) / 'export-extra-server' if os.environ.get('CUTROOM_HOME') else ROOT / 'tests' / 'out' / 'export-extra-server'
OUT.mkdir(parents=True, exist_ok=True)


def ff(*args):
    return subprocess.check_output(args, stderr=subprocess.PIPE).decode('utf-8')


def probe(file):
    return json.loads(ff('ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(file)))


def packets(file, i):
    """Subtitle stream i's packets as (start seconds, bytes), straight from the container."""
    j = json.loads(ff('ffprobe', '-v', 'error', '-select_streams', f's:{i}', '-show_packets', '-show_data', '-of', 'json', str(file)))
    return [(float(k['pts_time']), bytes.fromhex(''.join(line.split(':', 1)[1][:41].replace(' ', '') for line in k['data'].strip().split('\n'))))
            for k in j['packets']]


def cue_texts(file, i, codec):
    """The text a player gets: mov_text = 2-byte length + UTF-8 (empty samples are gaps; a word joiner breaks markup-like
    backslash sequences invisibly), WebVTT = entity-escaped payload."""
    if codec == 'mov_text':
        return [t for t in (d[2:2 + int.from_bytes(d[:2], 'big')].decode().replace('\u2060', '') for _, d in packets(file, i)) if t]
    return [html.unescape(d.decode()) for _, d in packets(file, i)]


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

        for fmt, codec in [('mp4', 'mov_text'), ('prores', 'mov_text'), ('webm', 'webvtt'), ('mkv', 'webvtt')]:
            f, st, info = run(format=fmt, subtitles=tracks)
            subs = [x for x in info['streams'] if x['codec_type'] == 'subtitle']
            assert [x['codec_name'] for x in subs] == [codec, codec], subs
            assert [x['tags']['language'] for x in subs] == ['eng', 'spa'], subs
            assert [x['disposition']['default'] for x in subs] == [1, 0], subs
            for i, track in enumerate(tracks):
                txt = ff('ffmpeg', '-v', 'error', '-i', str(f), '-map', f'0:s:{i}', '-f', 'srt', '-')
                assert track['cues'][0]['text'] in txt and '00:00:00,500 --> 00:00:02,250' in txt and '00:00:03,000 --> 00:00:05,125' in txt, txt
            print(f'PASS subtitles {fmt}: {codec}, eng/spa, default 1/0, exact text and milliseconds', flush=True)

        # Markup-like caption text is stored literally in every container (SRT input once turned 'a < b & c > d' into 'a  d').
        tricky = ['Tom & Jerry', '5 < 6 and 7 > 3', 'I <3 you', 'R&amp;D', 'a < b & c > d', '<font color=red>x</font>', 'two\nlines --> here']
        braces = ['{\\an8}x {y}', 'C:\\New \\h', '<b>{bold}</b>']
        special = [{'language': 'eng', 'cues': [{'start': 100 + n * 700, 'end': 700 + n * 700, 'text': t} for n, t in enumerate(tricky[:4] + braces[:1])]},
                   {'language': 'fra', 'cues': [{'start': 100 + n * 700, 'end': 700 + n * 700, 'text': t} for n, t in enumerate(tricky[4:] + braces[1:])]}]
        for fmt, codec in [('mp4', 'mov_text'), ('webm', 'webvtt'), ('mkv', 'webvtt')]:
            f, st, info = run(format=fmt, subtitles=special)
            got = [cue_texts(f, i, codec) for i in range(2)]
            assert got == [[c['text'] for c in t['cues']] for t in special], got
            print(f'PASS literal captions {fmt} ({codec}): &, <, >, entities, braces, backslashes, line breaks', flush=True)
        starts = [round(t, 3) for t, d in packets(f, 0)]  # the MKV's WebVTT keeps millisecond times
        assert starts[:2] == [0.1, 0.8], starts
        for bad in ([None], [{'language': 'eng', 'cues': [{'start': 0, 'end': 1}]}], [{'language': 'eng', 'cues': ['text']}], [{'language': 'eng', 'cues': [{'start': None, 'end': 1, 'text': 'x'}]}]):
            try:
                s.clean_plan({**base, 'subtitles': bad})
                raise AssertionError(f'malformed subtitles accepted: {bad}')
            except ValueError:
                pass
        print('PASS malformed subtitle entries refused in words', flush=True)
        long = s.clean_plan({**base, 'duration': 600, 'targetBytes': 10000000, 'main': []})
        assert s.fit_budget(long)['audio_bps'] <= 64000 and s.fit_budget(long)['video_bps'] >= 80000, s.fit_budget(long)
        print(f"PASS 10 MB for 10 minutes: sound lowered to {s.fit_budget(long)['audio_bps'] // 1000}k instead of refusing", flush=True)

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

        if s.VT:  # the Mac's media engine overshoots its requested bitrate 1.25-2.6x: fitted files must still stay under the target
            for fmt in ('mp4', 'hevc'):
                for tb in (500_000, 1_000_000, 2_000_000):
                    f, st, info = run(format=fmt, quality='fast', targetBytes=tb, subtitles=tracks)
                    assert tb * 0.9 <= st['bytes'] <= tb, st
                    print(f"PASS hardware fit {fmt} {tb // 1000} KB: {st['bytes']} bytes ({st['bytes'] / tb:.3f}), encodes {st['encodeBytes']}, {st['fit']['encoder']}", flush=True)
            for tb in (500_000,):
                f, st, info = run(format='webm', targetBytes=tb, subtitles=tracks)
                assert tb * 0.85 <= st['bytes'] <= tb, st
                print(f"PASS VP9 fit {tb // 1000} KB: {st['bytes']} bytes, encodes {st['encodeBytes']}, {st['fit']['size']}", flush=True)

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
