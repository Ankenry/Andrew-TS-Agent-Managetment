"""Generate rounded Chrome Extension icons from src/bigmouse2.png.

Run from the project root:
    python3 scripts/generate-extension-icons.py
"""

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw


PROJECT_ROOT = Path(__file__).resolve().parent.parent
SOURCE = PROJECT_ROOT / "src" / "bigmouse2.png"
OUTPUT_DIR = PROJECT_ROOT / "chrome-extension" / "icons"
SIZES = (16, 32, 48, 128)


def circular_mask(size: int) -> Image.Image:
    """Return an antialiased circular alpha mask with transparent corners."""
    scale = 4
    high_resolution = Image.new("L", (size * scale, size * scale), 0)
    ImageDraw.Draw(high_resolution).ellipse((0, 0, size * scale - 1, size * scale - 1), fill=255)
    return high_resolution.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    if not SOURCE.is_file():
        raise FileNotFoundError(f"Missing source icon: {SOURCE}")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    source = Image.open(SOURCE).convert("RGBA")

    for size in SIZES:
        icon = source.resize((size, size), Image.Resampling.LANCZOS)
        alpha = ImageChops.multiply(icon.getchannel("A"), circular_mask(size))
        icon.putalpha(alpha)
        destination = OUTPUT_DIR / f"bigmouse2-rounded-{size}.png"
        icon.save(destination, "PNG", optimize=True)
        print(destination.relative_to(PROJECT_ROOT))


if __name__ == "__main__":
    main()
