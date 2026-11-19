# Звук ролика «инвентарь» (20 с, 125 BPM): бит, «хлыст» на склейках, щелчки карточек и касаний, подъём на итоге, звон цели.
# Всё синтезом (numpy), без чужих записей. Запуск: python3 vaudio.py out.wav (звук inv) или python3 vaudio.py <ролик>.audio.json out.wav
# В json: cuts, wordClicks, cardClicks, taps, riser, drop, ding, pops, chimes, finClicks (секунды). Чего нет — берётся как у inv.
import sys, wave, json, numpy as np
C = {'cuts': [1.5, 3.9, 6.0, 8.0, 11.5, 14.5, 17.5], 'wordClicks': [0, 2.7, 12.5], 'cardClicks': [8.0 + k * 0.48 + 0.28 for k in range(6)],
     'taps': [3.26, 6.39, 16.2], 'riser': 11.6, 'drop': 12.35, 'ding': 16.3, 'pops': [], 'chimes': [], 'finClicks': [17.8, 18.1, 18.4]}
if len(sys.argv) > 2: C.update(json.load(open(sys.argv[1]))); sys.argv = [sys.argv[0], sys.argv[2]]
SR, DUR, BEAT = 44100, 20.0, 0.48
N = int(SR * DUR); t = np.arange(N) / SR; out = np.zeros(N)
rng = np.random.default_rng(7)
def add(at, sig, gain=1.0):
    i = int(at * SR); j = min(N, i + len(sig))
    if 0 <= i < N: out[i:j] += sig[: j - i] * gain
def env(d, a=0.003, r=None):
    n = int(SR * d); x = np.arange(n) / SR; e = np.minimum(1, x / a)
    return e * np.exp(-x / (r or d / 4))
def kick():
    d = 0.35; x = np.arange(int(SR * d)) / SR; f = 48 + 110 * np.exp(-x * 30)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-x * 7.5)
def hat(): return rng.standard_normal(int(SR * 0.05)) * env(0.05, 0.001, 0.012)
def click(f=2400): d = 0.04; x = np.arange(int(SR * d)) / SR; return np.sin(2 * np.pi * f * x) * np.exp(-x * 120)
def whoosh(d=0.32):
    n = int(SR * d); x = np.arange(n) / SR; w = rng.standard_normal(n)
    k = np.exp(-((x - d * 0.75) / (d * 0.3)) ** 2)   # нарастает к склейке
    sm = np.convolve(w, np.ones(12) / 12, 'same'); return (w - sm) * k * 0.6 + sm * k * 0.9
def impact(): d = 0.6; x = np.arange(int(SR * d)) / SR; return (np.sin(2 * np.pi * 42 * x) * 0.9 + rng.standard_normal(len(x)) * 0.15 * np.exp(-x * 25)) * np.exp(-x * 5)
def riser(d):
    x = np.arange(int(SR * d)) / SR; f = 300 + 900 * (x / d) ** 2
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * (x / d) ** 1.5 * 0.35
def ding(f=1318.5): d = 1.2; x = np.arange(int(SR * d)) / SR; return (np.sin(2 * np.pi * f * x) + 0.4 * np.sin(2 * np.pi * f * 2.01 * x)) * np.exp(-x * 3.5) * 0.5
def drop(): d = 0.5; x = np.arange(int(SR * d)) / SR; f = 520 * np.exp(-x * 4); return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-x * 5) * 0.5
# бит: бочка на долю, хэт на слабую долю, саб под бочкой; в финале затихает
b = 0.0
while b < DUR - 0.3:
    g = 1.0 if b < 19.0 else 0.4
    add(b, kick(), 0.9 * g); add(b + BEAT / 2, hat(), 0.25 * g); b += BEAT
bass_notes = [55, 55, 65.4, 49]  # A1 A1 C2 G1 — по такту
for i, b in enumerate(np.arange(0, 19.2, BEAT * 4)):
    f = bass_notes[i % 4]; d = BEAT * 4; x = np.arange(int(SR * d)) / SR
    add(b, np.sin(2 * np.pi * f * x) * np.minimum(1, x / 0.02) * np.exp(-x * 0.6) * 0.28)
def pop(): d = 0.2; x = np.arange(int(SR * d)) / SR; w = rng.standard_normal(len(x)); return w * (x / d) ** 2 * 0.5
def chime():
    o = np.zeros(int(SR * 1.4))
    for i, f in enumerate([1318.5, 1568.0, 2093.0]):
        d = ding(f); j = int(SR * 0.09 * i); o[j:j + len(d)] += d[: len(o) - j] * 0.8
    return o
for c in C['cuts']:
    add(c - 0.3, whoosh(), 0.55); add(c, impact(), 0.5)
for w in C['wordClicks']: add(w, click(1800), 0.35)          # смена слова без склейки
for k, c in enumerate(C['cardClicks']): add(c, click(2600 + k * 120), 0.5)   # карточки
for c in C['taps']: add(c, click(3200), 0.45)                # касания в приложении
for c in C['pops']: add(c - 0.2, pop(), 0.6); add(c, click(3200), 0.55)   # крупная кнопка вылетает
if C['riser'] is not None: add(C['riser'], riser(0.7), 1.0)
if C['drop'] is not None: add(C['drop'], drop(), 1.0)
if C['ding'] is not None: add(C['ding'], ding(), 1.0)
for c in C['chimes']: add(c, chime(), 0.9)
for c in C['finClicks']: add(c, click(2200), 0.45)
out *= np.minimum(1, (DUR - t) / 0.4)
out = out / np.max(np.abs(out)) * 0.89
with wave.open(sys.argv[1], 'w') as f:
    f.setnchannels(1); f.setsampwidth(2); f.setframerate(SR); f.writeframes((out * 32767).astype('<i2').tobytes())
print('ok', sys.argv[1])
