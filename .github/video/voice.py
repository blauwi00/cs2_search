# Озвучка сценария ролика (edge-tts) + тайминги слов для субтитров + картинки кейсов из открытого каталога.
import asyncio, json, os, urllib.request
import edge_tts

S = json.load(open('.github/video/script.json', encoding='utf-8'))
os.makedirs('out', exist_ok=True)

async def one(seg):
    words = []
    kw = {}
    try:
        comm = edge_tts.Communicate(seg['text'], S['voice'], rate=S['rate'], boundary='WordBoundary')
    except TypeError:
        comm = edge_tts.Communicate(seg['text'], S['voice'], rate=S['rate'])
    with open(f"out/{seg['id']}.mp3", 'wb') as f:
        async for ch in comm.stream():
            if ch['type'] == 'audio':
                f.write(ch['data'])
            elif ch['type'] in ('WordBoundary', 'SentenceBoundary'):
                words.append({'type': ch['type'], 'text': ch['text'], 'start': ch['offset'] / 1e7, 'dur': ch['duration'] / 1e7})
    return {'id': seg['id'], 'text': seg['text'], 'words': words}

async def main():
    res = [await one(s) for s in S['segments']]
    json.dump(res, open('out/timing.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

asyncio.run(main())

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
