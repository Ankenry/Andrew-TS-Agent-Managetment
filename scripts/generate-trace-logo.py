#!/usr/bin/env python3
"""Build the tracing web logo/favicon (web/trace/logo-*.png) from Asset/white_Bigmouse.jpeg.

Usage: python3 scripts/generate-trace-logo.py [source image]
The artwork is cropped to its content, centred on a white disc and exported with a transparent corner mask.
"""
import sys
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SOURCE = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "Asset" / "white_Bigmouse.jpeg"
OUT = ROOT / "web" / "trace"
SIZES = (32, 128, 256)
MARGIN = 0.11  # free space around the artwork, as a share of the final side
SCALE = 4      # supersampling for smooth edges

image = Image.open(SOURCE).convert("L")
# The JPEG background is light grey (~248): push near-white to pure white so the disc is clean.
image = image.point(lambda value: 255 if value >= 236 else int(value * 255 / 236))
bbox = ImageChops.invert(image).point(lambda value: 255 if value > 60 else 0).getbbox()
art = image.crop(bbox)

for size in SIZES:
    side = size * SCALE
    inner = round(side * (1 - 2 * MARGIN))
    ratio = min(inner / art.width, inner / art.height)
    scaled = art.resize((max(1, round(art.width * ratio)), max(1, round(art.height * ratio))), Image.LANCZOS)
    canvas = Image.new("L", (side, side), 255)
    canvas.paste(scaled, ((side - scaled.width) // 2, (side - scaled.height) // 2))
    mask = Image.new("L", (side, side), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, side - 1, side - 1), fill=255)
    logo = Image.merge("RGBA", (canvas, canvas, canvas, mask)).resize((size, size), Image.LANCZOS)
    target = OUT / f"logo-{size}.png"
    logo.save(target, optimize=True)
    print(f"{target.relative_to(ROOT)} {size}x{size} {target.stat().st_size} bytes")
