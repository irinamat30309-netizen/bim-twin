#!/usr/bin/env python3
"""sheet.py out.png in1.png in2.png … — склеивает картинки вертикально (для обзора вкладок)."""
import sys
from PIL import Image
out, ins = sys.argv[1], sys.argv[2:]
ims = [Image.open(p).convert('RGB') for p in ins]
w = max(i.width for i in ims); h = sum(i.height for i in ims) + 4 * (len(ims) - 1)
sheet = Image.new('RGB', (w, h), (255, 0, 255))
y = 0
for im in ims:
    sheet.paste(im, (0, y)); y += im.height + 4
sheet.save(out)
print(out, sheet.size)
