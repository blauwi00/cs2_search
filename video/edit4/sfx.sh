#!/bin/sh
# Синтезированные звуки для ролика «7 дней» (ffmpeg): сердцебиение, тик, звонок, удар замка, щелчок. Запуск из папки assets/sfx проекта.
ffmpeg -y -f lavfi -i "aevalsrc='sin(2*PI*52*t)*exp(-t*16)*0.95':d=0.4:s=44100" -ar 44100 thump.wav
ffmpeg -y -f lavfi -i "aevalsrc='random(0)*exp(-t*260)*0.9':d=0.06:s=44100" -af "highpass=f=1800" -ar 44100 tick.wav
ffmpeg -y -f lavfi -i "aevalsrc='(sin(2*PI*988*t)+0.7*sin(2*PI*1318*t))*exp(-t*4.5)*0.45':d=1.1:s=44100" -ar 44100 chime.wav
ffmpeg -y -f lavfi -i "aevalsrc='(sin(2*PI*68*t)*exp(-t*12)*0.95+random(0)*exp(-t*70)*0.5)':d=0.5:s=44100" -ar 44100 slam.wav
ffmpeg -y -f lavfi -i "aevalsrc='random(0)*exp(-t*110)*0.8+sin(2*PI*240*t)*exp(-t*40)*0.5':d=0.15:s=44100" -af "highpass=f=400" -ar 44100 click.wav
