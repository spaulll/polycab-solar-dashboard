#!/usr/bin/env python3
"""Generate favicon assets (SVG, PNG, ICO) for the Solar Dashboard."""
import io
import os
from urllib.parse import unquote

import cairosvg
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ICONS = os.path.join(HERE, "icons")

DATA_URI = (
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E"
    "%3Crect width='32' height='32' rx='6' fill='%2315171a'/%3E%3Cg stroke='%23e2a24a' "
    "stroke-width='1.4' stroke-linecap='round'%3E%3Cline x1='16' y1='6' x2='16' y2='8.5'/%3E"
    "%3Cline x1='16' y1='23.5' x2='16' y2='26'/%3E%3Cline x1='6' y1='16' x2='8.5' y2='16'/%3E"
    "%3Cline x1='23.5' y1='16' x2='26' y2='16'/%3E%3Cline x1='9.5' y1='9.5' x2='11.2' y2='11.2'/%3E"
    "%3Cline x1='20.8' y1='20.8' x2='22.5' y2='22.5'/%3E%3Cline x1='22.5' y1='9.5' x2='20.8' y2='11.2'/%3E"
    "%3Cline x1='11.2' y1='20.8' x2='9.5' y2='22.5'/%3E%3C/g%3E%3Ccircle cx='16' cy='16' r='5.5' "
    "fill='%23e2a24a'/%3E%3C/svg%3E"
)

os.makedirs(ICONS, exist_ok=True)

svg = unquote(DATA_URI.split(",", 1)[1])
svg_path = os.path.join(ICONS, "icon.svg")
with open(svg_path, "w") as f:
    f.write(svg)
print(f"wrote {svg_path}")

png_sizes = [16, 32, 180, 192, 512]
pngs = {}
for size in png_sizes:
    out = os.path.join(ICONS, f"icon-{size}.png") if size >= 180 else None
    data = cairosvg.svg2png(bytestring=svg.encode(), output_width=size, output_height=size)
    img = Image.open(io.BytesIO(data))
    if out:
        img.save(out)
        print(f"wrote {out}")
    else:
        pngs[size] = img

ico_sizes = [16, 32, 48]
ico_imgs = []
for size in ico_sizes:
    data = cairosvg.svg2png(bytestring=svg.encode(), output_width=size, output_height=size)
    ico_imgs.append(Image.open(io.BytesIO(data)))
ico_path = os.path.join(HERE, "favicon.ico")
ico_imgs[0].save(ico_path, format="ICO", sizes=[(i.width, i.height) for i in ico_imgs], append_images=ico_imgs[1:])
print(f"wrote {ico_path}")
