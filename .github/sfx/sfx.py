"""Звуки для роликов: 1) Openverse — поиск и скачивание (только CC0), 2) PANNs — «уши»: что реально звучит в файле,
3) отбор: оставляем файлы, где PANNs слышит то, что искали (или хотя бы не речь/музыку), нормализуем громкость.
Запуск: python sfx.py request.json out/   (нужны: requests, panns-inference, librosa, ffmpeg)"""
import json, os, subprocess, sys, time, re
import requests

req = json.load(open(sys.argv[1]))
out = sys.argv[2]
os.makedirs(f'{out}/raw', exist_ok=True)
UA = {'User-Agent': 'cenolov-video-bot/1.0 (github actions)'}

def search(q, n, max_dur):
    url = 'https://api.openverse.org/v1/audio/'
    params = {'q': q, 'license': 'cc0', 'page_size': 20, 'mature': 'false'}  # без ключа API — не больше 20 и 1 запрос/с
    for attempt in range(3):
        time.sleep(1.2)
        r = requests.get(url, params=params, headers=UA, timeout=30)
        if r.status_code == 429: time.sleep(10); continue
        r.raise_for_status(); break
    res = []
    for x in r.json().get('results', []):
        d = (x.get('duration') or 0) / 1000
        if not x.get('url') or (d and d > max_dur * 3): continue  # длинные режем до max_dur, но совсем длинные (музыка) не берём
        res.append(x)
        if len(res) >= n * 3: break
    return res

# Классы AudioSet, которые подходят каждому тегу (для проверки «ушами»).
WANT = {
  'whoosh': r'whoosh|swoosh|swish|wind|air', 'swoosh': r'whoosh|swoosh|swish|wind', 'pop': r'pop|click|tick|plop|bubble|drip',
  'click': r'click|tick|tap|clicking|typing|mouse', 'ding': r'bell|ding|chime|tuning fork|jingle|glockenspiel|ding-dong',
  'coin': r'coin|cash register|jingle|clink|chink|clang', 'notify': r'bell|chime|ding|beep|alarm|ringtone|jingle|glockenspiel',
  'riser': r'whoosh|sweep|swoosh|synthesizer|electronic|sound effect|noise|rumble', 'impact': r'thump|thud|bang|boom|slam|hit|impact|smash|knock|bass drum',
  'typing': r'typing|keyboard|typewriter|click',
}
BAD = r'^(speech|male speech|female speech|music|singing|narration)'

from panns_inference import AudioTagging, labels
import librosa
import numpy as np
at = AudioTagging(checkpoint_path=None, device='cpu')

def hear(path):
    y, _ = librosa.load(path, sr=32000, mono=True)
    if len(y) < 3200: y = np.pad(y, (0, 3200 - len(y)))
    clip, _ = at.inference(y[None, :])
    p = clip[0]
    top = np.argsort(p)[::-1][:5]
    return [(labels[i], float(p[i])) for i in top]

index = []
for q in req['queries']:
    tag, n = q['tag'], q['n']
    got = 0
    try: hits = search(q['q'], n, req.get('maxDur', 4))
    except Exception as e: print('Openverse ошибка', q, e); continue
    for x in hits:
        if got >= n: break
        name = re.sub(r'[^a-z0-9]+', '-', f"{tag}-{x['id'][:8]}".lower())
        raw = f"{out}/raw/{name}"
        try:
            b = requests.get(x['url'], headers=UA, timeout=60)
            if b.status_code != 200 or len(b.content) < 2000: continue
            open(raw, 'wb').write(b.content)
            wav = f'{out}/{name}.wav'
            # обрезка тишины, моно→стерео 44.1 кГц, громкость −16 LUFS, не длиннее maxDur
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', raw, '-af',
                f"silenceremove=start_periods=1:start_threshold=-50dB,atrim=0:{req.get('maxDur', 4)},afade=t=out:st={max(0.05, req.get('maxDur', 4) - 0.15)}:d=0.15,loudnorm=I=-16:TP=-1.5",
                '-ar', '44100', '-ac', '2', wav], check=True)
            heard = hear(wav)
            ok = any(re.search(WANT.get(tag, tag), l.lower()) and pr > 0.05 for l, pr in heard)
            speechy = re.search(BAD, heard[0][0].lower()) and heard[0][1] > 0.3
            dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav], capture_output=True, text=True).stdout or 0)
            entry = {'file': f'{name}.wav', 'tag': tag, 'query': q['q'], 'title': x.get('title'), 'creator': x.get('creator'), 'license': x.get('license'),
                     'license_url': x.get('license_url'), 'source': x.get('foreign_landing_url'), 'provider': x.get('provider'), 'duration': round(dur, 2),
                     'heard': [[l, round(p, 3)] for l, p in heard], 'match': bool(ok), 'speech_or_music': bool(speechy)}
            if speechy or dur < 0.08:
                os.remove(wav); print('отброшен (речь/музыка/пусто):', name, heard[:2]); continue
            index.append(entry); got += 1
            print(('✅' if ok else '〰️'), name, dur, 's', heard[:3])
        except Exception as e:
            print('пропуск', x.get('id'), e)
    print(f'== {tag}: {got}/{n}')

index.sort(key=lambda e: (e['tag'], not e['match']))
json.dump({'generated': time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime()), 'sounds': index}, open(f'{out}/index.json', 'w'), ensure_ascii=False, indent=1)
with open(f'{out}/LICENSES.md', 'w') as f:
    f.write('# Звуки (Openverse, CC0 — общественное достояние)\n\n')
    for e in index: f.write(f"- `{e['file']}` — «{e['title']}» ({e['creator']}), {e['license']} — {e['source']}\n")
import shutil; shutil.rmtree(f'{out}/raw', ignore_errors=True)
print('Готово:', len(index), 'звуков')
