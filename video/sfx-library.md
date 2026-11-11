# Звуки для роликов

Раньше звуки синтезировал ffmpeg (video/edit4/sfx.sh) — на слух «нейронка». Теперь берём настоящие записи Kenney (CC0, без указания автора):

- Impact Sounds: `impact_punch_heavy_000` → slam, `impact_soft_heavy_001` → thump, `impact_bell_heavy_000` → chime
- Interface Sounds: `tick_001` → tick
- UI Audio: `click3` → pop, `mouseclick1` → click
- whoosh убран (тишина): «взмахи» звучали фальшиво

Источник: репозитории Boyquotes/kenney-impact-sounds-for-godot, Calinou/kenney-interface-sounds, Calinou/kenney-ui-audio (копии наборов Kenney).
Файлы в репозиторий не кладём, только ссылки. Нужны WAV 44,1 кГц стерео, пик выровнен ffmpeg.
