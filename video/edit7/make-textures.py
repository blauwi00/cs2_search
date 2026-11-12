# Развёртки граней 3D-кейса из одного плоского снимка (референс: картинка кейса с Steam, не хранится в репозитории).
# python3 make-textures.py <картинка.png|webp> <папка вывода/tex>
# Углы граней заданы вручную по снимку 360x360 (трёхчетвертной вид: длинная грань слева, торец справа).
import sys, os
from PIL import Image, ImageOps
src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
im = Image.open(src).convert('RGBA'); bg = Image.new('RGBA', im.size, (255, 255, 255, 255)); bg.alpha_composite(im); im = bg.convert('RGB')
def rect(NW, SW, SE, NE, size): return im.transform(size, Image.QUAD, [*NW, *SW, *SE, *NE], Image.BICUBIC)
front = rect((63, 127), (72, 225), (203, 263), (203, 150), (1024, 600))
side = rect((203, 150), (203, 263), (297, 222), (296, 134), (700, 600))
top = rect((150, 100), (66, 121), (203, 150), (296, 134), (1024, 680))
def split(i, cut=0.17): w, h = i.size; c = int(h * cut); return i.crop((0, 0, w, c)), i.crop((0, c, w, h))
fl, fb = split(front); sl, sb = split(side)
for n, i in [('front_lid', fl), ('front_body', fb), ('side_lid', sl), ('side_body', sb), ('top', top)]:
    i.save(f'{out}/{n}.png'); ImageOps.mirror(i).save(f'{out}/{n}_m.png')
