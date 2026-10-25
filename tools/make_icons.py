"""Draw the AUX-SAR home-screen icons: an expanding square search around a datum.

Run from the AUX-SAR folder:  python tools/make_icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent


def make_icon(size, path):
    img = Image.new("RGBA", (size, size), (10, 25, 41, 255))
    d = ImageDraw.Draw(img)
    c = size / 2
    s = size * 0.075  # one track space
    w = max(2, size // 32)

    # Expanding square: legs 1S,1S,2S,2S,3S,3S,4S starting north, turning right.
    x, y = c, c
    pts = [(x, y)]
    dirs = [(0, -1), (1, 0), (0, 1), (-1, 0)]
    for i in range(1, 8):
        dx, dy = dirs[(i - 1) % 4]
        L = ((i + 1) // 2) * s
        x, y = x + dx * L, y + dy * L
        pts.append((x, y))
    d.line(pts, fill=(255, 159, 28, 255), width=w, joint="curve")

    # Datum marker
    r = size * 0.045
    d.ellipse([c - r, c - r, c + r, c + r], fill=(46, 196, 182, 255))

    # Life ring around the edge
    R = size * 0.44
    d.ellipse([c - R, c - R, c + R, c + R], outline=(234, 242, 251, 255), width=max(2, size // 40))

    img.save(path)


(ROOT / "icons").mkdir(exist_ok=True)
make_icon(192, ROOT / "icons" / "icon-192.png")
make_icon(512, ROOT / "icons" / "icon-512.png")
print("done")
