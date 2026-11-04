# Один образец голоса (номер N из voices.json) → out/N.mp3
import asyncio, json, os, subprocess, sys, time, urllib.request
cfg = json.load(open('.github/video/voices.json', encoding='utf-8'))
v = next(x for x in cfg['voices'] if x['n'] == int(sys.argv[1]))
os.makedirs('out', exist_ok=True)
dst = f"out/{v['n']:02d}.mp3"
if v['engine'] == 'edge':
    import edge_tts
    async def go():
        c = edge_tts.Communicate(cfg['text'], v['voice'], rate=v['rate'], pitch=v['pitch'])
        await c.save(dst)
    for i in range(6):
        try:
            asyncio.run(go())
            if os.path.getsize(dst) > 2000: break
        except Exception as e:
            print('retry', i, e)
        time.sleep(5 + i * 5)
else:
    lang, name = v['voice'].split('-')[0], v['voice']
    loc = lang.split('_')[0]
    spk = name.split('-')[1]
    base = f'https://huggingface.co/rhasspy/piper-voices/resolve/main/{loc}/{lang}/{spk}/medium/'
    for f in [f'{name}.onnx', f'{name}.onnx.json']: urllib.request.urlretrieve(base + f, f)
    subprocess.run(['piper', '-m', f'{name}.onnx', '-f', 'tmp.wav'], input=cfg['text'].encode(), check=True)
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', 'tmp.wav', '-b:a', '128k', dst], check=True)
print('ok' if os.path.exists(dst) and os.path.getsize(dst) > 2000 else 'FAILED', v['name'])
