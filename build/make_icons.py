"""Uygulama ve eklenti simgelerini üretir: python3 build/make_icons.py"""
from PIL import Image, ImageDraw
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def icon(size, badge=None):
    s = size * 4  # süper örnekleme: kenarlar yumuşak olsun
    grad = Image.new("RGB", (s, s))
    a, b = (124, 92, 255), (34, 211, 238)
    px = grad.load()
    for y in range(s):
        for x in range(s):
            t = (x + y) / (2 * s)
            px[x, y] = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.24), fill=255)
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)
    w = s * 0.11
    cx = s / 2
    d.rounded_rectangle([cx - w / 2, s * 0.2, cx + w / 2, s * 0.58], radius=w / 2, fill="white")
    d.polygon([(s * 0.27, s * 0.47), (s * 0.73, s * 0.47), (cx, s * 0.72)], fill="white")
    d.rounded_rectangle([s * 0.25, s * 0.77, s * 0.75, s * 0.77 + w * 0.8], radius=w * 0.4, fill="white")
    return img.resize((size, size), Image.LANCZOS)


icon(512).save(os.path.join(ROOT, "build", "icon.png"))
icon(256).save(os.path.join(ROOT, "src", "renderer", "icon.png"))
for n in (16, 32, 48, 128):
    icon(n).save(os.path.join(ROOT, "extension", "icons", f"icon{n}.png"))
print("ok")
