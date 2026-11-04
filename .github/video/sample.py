# Один образец голоса (номер N из voices.json) → out/N.mp3
import asyncio, json, os, subprocess, sys, time, urllib.request, urllib.error
cfg = json.load(open('.github/video/voices.json', encoding='utf-8'))
v = next(x for x in cfg['voices'] if x['n'] == int(sys.argv[1]))
os.makedirs('out', exist_ok=True)
dst = f"out/{v['n']:02d}.mp3"
if v['engine'] == 'eleven':
    # ElevenLabs: ключ — в секретах GitHub (ELEVENLABS_API_KEY). Модель multilingual v2 говорит по-русски без акцента.
    key = os.environ.get('ELEVENLABS_API_KEY')
    if not key:
        print('FAILED: нет секрета ELEVENLABS_API_KEY'); sys.exit(0)
    body = json.dumps({'text': cfg['text'], 'model_id': 'eleven_multilingual_v2',
                       'voice_settings': {'stability': 0.45, 'similarity_boost': 0.8, 'style': 0.25, 'use_speaker_boost': True}}).encode()
    req = urllib.request.Request(f"https://api.elevenlabs.io/v1/text-to-speech/{v['voice']}?output_format=mp3_44100_128", data=body,
                                 headers={'xi-api-key': key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r, open(dst, 'wb') as f: f.write(r.read())
    except urllib.error.HTTPError as e:
        print('FAILED', e.code, e.read()[:300])
elif v['engine'] == 'edge':
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
