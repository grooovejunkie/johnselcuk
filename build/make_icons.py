"""Uygulama ve eklenti simgelerini üretir: python3 build/make_icons.py

Tasarım arayüzle aynı dili konuşur: siyah zemin, ASCII köşeli (+) çerçeve,
fosfor yeşili piksel bloklardan bir indirme oku ve altında terminal imleci (_).
"""
from PIL import Image, ImageDraw, ImageFilter
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BG = (10, 11, 10)
GREEN = (77, 255, 136)
DIM = (42, 110, 68)

# 9x9 piksel ızgarası: ok + imleç
ARROW = [
    "...##....",
    "...##....",
    "...##....",
    "...##....",
    "#..##..#.",
    ".#.##.#..",
    "..####...",
    "...##....",
    ".........",
]
ARROW = [r[:8] for r in ARROW]  # 8 sütun


def grid():
    # Elle simetrik çizim (8x9): sap 2 sütun, baş üçgen, alt çizgi imleç.
    return [
        "...##...",
        "...##...",
        "...##...",
        "##.##.##",
        ".######.",
        "..####..",
        "...##...",
        "........",
        "########",
    ]


def icon(size, frame=True):
    s = 512
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.12), fill=BG)

    if frame:
        # ASCII çerçeve: kesik kenarlar ve '+' köşeler
        m, t = 44, 10
        dash, gap = 30, 16
        for x in range(m + 40, s - m - 40, dash + gap):
            d.rectangle([x, m - t // 2, min(x + dash, s - m - 40), m + t // 2], fill=DIM)
            d.rectangle([x, s - m - t // 2, min(x + dash, s - m - 40), s - m + t // 2], fill=DIM)
        for y in range(m + 40, s - m - 40, dash + gap):
            d.rectangle([m - t // 2, y, m + t // 2, min(y + dash, s - m - 40)], fill=DIM)
            d.rectangle([s - m - t // 2, y, s - m + t // 2, min(y + dash, s - m - 40)], fill=DIM)
        for cx, cy in [(m, m), (s - m, m), (m, s - m), (s - m, s - m)]:
            d.rectangle([cx - 22, cy - t // 2, cx + 22, cy + t // 2], fill=GREEN)
            d.rectangle([cx - t // 2, cy - 22, cx + t // 2, cy + 22], fill=GREEN)

    g = grid()
    rows, cols = len(g), len(g[0])
    cell = (300 if frame else 380) // rows
    gap = max(4, cell // 7)
    ox = (s - cols * cell) // 2
    oy = (s - rows * cell) // 2
    blocks = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    bd = ImageDraw.Draw(blocks)
    for r, row in enumerate(g):
        for c, ch in enumerate(row):
            if ch == "#":
                x, y = ox + c * cell, oy + r * cell
                bd.rectangle([x + gap // 2, y + gap // 2, x + cell - gap // 2, y + cell - gap // 2], fill=GREEN)
    glow = blocks.filter(ImageFilter.GaussianBlur(18))
    img = Image.alpha_composite(img, Image.blend(Image.new("RGBA", (s, s), (0, 0, 0, 0)), glow, 0.8))
    img = Image.alpha_composite(img, blocks)

    # CRT tarama çizgileri (yalnızca büyük boyutlarda görünür)
    if size >= 64:
        sl = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        sd = ImageDraw.Draw(sl)
        for y in range(0, s, 8):
            sd.rectangle([0, y, s, y + 2], fill=(0, 0, 0, 70))
        mask = Image.new("L", (s, s), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.12), fill=255)
        img = Image.alpha_composite(img, Image.composite(sl, Image.new("RGBA", (s, s), (0, 0, 0, 0)), mask))
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    icon(512).save(os.path.join(ROOT, "build", "icon.png"))
    icon(256).save(os.path.join(ROOT, "src", "renderer", "icon.png"))
    # Küçük boyutlarda çerçeve okunmaz; sadece ok.
    for n in (16, 32, 48, 128):
        icon(n, frame=n >= 48).save(os.path.join(ROOT, "extension", "icons", f"icon{n}.png"))
    print("ok")
