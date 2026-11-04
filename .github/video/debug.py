import asyncio, edge_tts
TESTS = ["Один и тот же кейс на разных сайтах стоит по-разному, и разница бывает очень заметной.",
 "Один и тот же кейс", "на разных сайтах стоит по-разному", "и разница бывает очень заметной.", "по-разному", "кейс",
 "Бот Ценолов каждые десять минут сравнивает цены на девяти площадках и сам учитывает все комиссии.",
 "Он подскажет, где купить дешевле, где продать дороже и сколько получишь на руки.",
 "А ещё пришлёт уведомление, когда цена станет выгодной.", "Бесплатно, прямо в Телеграме. Ссылка в профиле."]
async def t(x, b):
    try:
        kw = {'boundary': 'WordBoundary'} if b else {}
        c = edge_tts.Communicate(x, 'ru-RU-DmitryNeural', rate='+8%', **kw)
        n = 0
        async for ch in c.stream():
            if ch['type'] == 'audio': n += len(ch['data'])
        return n
    except Exception as e:
        return str(e)[:40]
async def main():
    for x in TESTS:
        print('DBG', await t(x, True), await t(x, False), x)
asyncio.run(main())
