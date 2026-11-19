# Живые цены Steam ($ и ₴) и картинки 1024 px для ролика «инвентарь» → work/. Запуск: python3 vfetch.py
import json, subprocess, urllib.parse, re, time, os
NAMES = ["AK-47 | Redline (Field-Tested)", "AWP | Asiimov (Field-Tested)", "Desert Eagle | Printstream (Field-Tested)",
         "USP-S | Kill Confirmed (Field-Tested)", "M4A1-S | Printstream (Field-Tested)", "★ Gut Knife | Doppler (Factory New)"]
W = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'work'); os.makedirs(W + '/img', exist_ok=True)
get = lambda url: subprocess.run(['curl', '-sS', '-m', '30', url], capture_output=True, text=True).stdout
if not os.environ.get('ONLY_TINTS'):
  usd, uah = open(W + '/prices_usd.tsv', 'w'), open(W + '/prices.tsv', 'w')
  for n in NAMES:
      for cur, f in ((1, usd), (18, uah)):
          r = get('https://steamcommunity.com/market/priceoverview/?' + urllib.parse.urlencode({'appid': 730, 'currency': cur, 'market_hash_name': n}))
          if not json.loads(r).get('success'): raise SystemExit('Steam не дал цену: ' + n)
          f.write(n + '\t' + r.strip() + '\n'); time.sleep(3)
      res = json.loads(get('https://steamcommunity.com/market/search/render/?' + urllib.parse.urlencode({'query': n, 'appid': 730, 'norender': 1, 'count': 10})))['results']
      hit = [x for x in res if x['hash_name'] == n]
      if not hit: raise SystemExit('нет картинки: ' + n)
      subprocess.run(['curl', '-sS', '-m', '30', '-o', W + '/img/' + re.sub(r'[^A-Za-z0-9]', '_', n) + '.png',
                      'https://community.fastly.steamstatic.com/economy/image/' + hit[0]['asset_description']['icon_url'] + '/1024fx768f'])
      print('ok', n); time.sleep(3)

# Цвет света для каждого скина: средний насыщенный цвет картинки (в браузере из file:// холст это не даёт).
from PIL import Image
tints = {}
for n in NAMES:
    f = re.sub(r'[^A-Za-z0-9]', '_', n) + '.png'
    im = Image.open(W + '/img/' + f).convert('RGBA').resize((64, 48))
    r = g = b = w = 0
    for (R, G, B, A) in im.getdata():
        if A < 200: continue
        s = (max(R, G, B) - min(R, G, B)) ** 2; r += R * s; g += G * s; b += B * s; w += s
    tints['img/' + f] = [round(r / w), round(g / w), round(b / w)] if w else [65, 224, 138]
json.dump(tints, open(W + '/tints.json', 'w'))

# Обрезать прозрачные поля, чтобы скин занимал всю картинку (крупнее в кадре).
for n in NAMES:
    f = W + '/img/' + re.sub(r'[^A-Za-z0-9]', '_', n) + '.png'
    im = Image.open(f).convert('RGBA'); bb = im.getchannel('A').point(lambda a: 255 if a > 8 else 0).getbbox()
    if bb and bb != (0, 0) + im.size: im.crop(bb).save(f)
