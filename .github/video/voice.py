# Озвучка сценария ролика (edge-tts) + тайминги слов для субтитров + картинки кейсов из открытого каталога.
import asyncio, json, os, urllib.request
import edge_tts

S = json.load(open('.github/video/script.json', encoding='utf-8'))
os.makedirs('out', exist_ok=True)

async def one(seg):
    words = []
    kw = {}
    # Без WordBoundary: с ним сервис часто отвечает «No audio». Тайминги — по предложениям (SentenceBoundary).
    comm = edge_tts.Communicate(seg['text'], S['voice'], rate=S['rate'])
    with open(f"out/{seg['id']}.mp3", 'wb') as f:
        async for ch in comm.stream():
            if ch['type'] == 'audio':
                f.write(ch['data'])
            elif ch['type'] in ('WordBoundary', 'SentenceBoundary'):
                words.append({'type': ch['type'], 'text': ch['text'], 'start': ch['offset'] / 1e7, 'dur': ch['duration'] / 1e7})
    return {'id': seg['id'], 'text': seg['text'], 'words': words}

async def retry(seg):
    last = None
    for i in range(5):
        try:
            r = await one(seg)
            if os.path.getsize(f"out/{seg['id']}.mp3") > 1000:
                return r
            last = 'empty audio'
        except Exception as e:
            last = e
        print('retry', seg['id'], i, last)
        await asyncio.sleep(3 + i * 3)
    raise RuntimeError(f"{seg['id']}: {last}")

async def main():
    # Один запрос на весь текст (несколько подряд edge-tts иногда обрывает), сцены — по словам каждого сегмента.
    full = {'id': 'all', 'text': ' '.join(x['text'] for x in S['segments'])}
    r = await retry(full)
    words = r['words']
    print('boundaries', len(words), sorted(set(w['type'] for w in r['words'])))
    json.dump({'engine': 'edge', 'single': 'all.mp3', 'segments': [{'id': x['id'], 'text': x['text'], 'nwords': len(x['text'].split())} for x in S['segments']], 'words': words},
              open('out/timing.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

def piper():
    # Запасной вариант: открытый голос Piper (без таймингов слов — их оценит монтаж по длине текста).
    import subprocess
    base = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/ru/ru_RU/dmitri/medium/'
    for f in ['ru_RU-dmitri-medium.onnx', 'ru_RU-dmitri-medium.onnx.json']:
        urllib.request.urlretrieve(base + f, f)
    res = []
    for seg in S['segments']:
        subprocess.run(['piper', '-m', 'ru_RU-dmitri-medium.onnx', '-f', f"out/{seg['id']}.wav"], input=seg['text'].encode(), check=True)
        res.append({'id': seg['id'], 'text': seg['text'], 'words': []})
    json.dump({'engine': 'piper', 'segments': res}, open('out/timing.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

def eleven():
    # ElevenLabs с таймингами каждого символа → точные тайминги слов для субтитров.
    import base64, urllib.error
    full = ' '.join(x['text'] for x in S['segments'])
    body = json.dumps({'text': full, 'model_id': 'eleven_multilingual_v2',
                       'voice_settings': {'stability': 0.45, 'similarity_boost': 0.8, 'style': 0.25, 'use_speaker_boost': True}}).encode()
    req = urllib.request.Request(f"https://api.elevenlabs.io/v1/text-to-speech/{S['voice']}/with-timestamps?output_format=mp3_44100_128", data=body,
                                 headers={'xi-api-key': os.environ['ELEVENLABS_API_KEY'], 'Content-Type': 'application/json'})
    r = json.load(urllib.request.urlopen(req, timeout=120))
    open('out/all.mp3', 'wb').write(base64.b64decode(r['audio_base64']))
    al = r['alignment']; words = []; cur = None
    for ch, a, b in zip(al['characters'], al['character_start_times_seconds'], al['character_end_times_seconds']):
        if ch.isspace():
            if cur: words.append(cur); cur = None
            continue
        if cur is None: cur = {'type': 'WordBoundary', 'text': '', 'start': a, 'dur': 0}
        cur['text'] += ch; cur['dur'] = b - cur['start']
    if cur: words.append(cur)
    for w in words: w['text'] = w['text'].strip('.,!?…:;«»"')
    json.dump({'engine': 'eleven', 'single': 'all.mp3', 'segments': [{'id': x['id'], 'text': x['text'], 'nwords': len(x['text'].split())} for x in S['segments']], 'words': words},
              open('out/timing.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

import edge_tts as _e
print('edge-tts', getattr(_e, '__version__', '?'))
try:
    if S.get('engine') == 'eleven':
        eleven()
    else:
        asyncio.run(main())
except Exception as e:
    print('edge-tts failed:', e)
    for f in os.listdir('out'):
        if f.endswith('.mp3'): os.remove(os.path.join('out', f))
    piper()

# Картинки кейсов (Steam CDN) из каталога ByMykel/CSGO-API.
try:
    crates = json.load(urllib.request.urlopen('https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/crates.json'))
    by = {c.get('name'): c.get('image') for c in crates}
    for i, n in enumerate(S['images']):
        u = by.get(n)
        if u:
            urllib.request.urlretrieve(u, f'out/img{i}.png')
            print('img', n, u)
except Exception as e:
    print('images failed', e)
