"""Render Ray's app icon: the sidebar's dot-matrix pulse mark on a dark plate.

Usage (from the repo root):
    python scripts/make_icon.py            # writes src-tauri/icons/*
Requires Pillow. Large sizes draw the full 7x7 plate (unlit dots faintly
visible, soft phosphor glow); 32 px drops the unlit dots; 16/24 px switch to a
5x5 pulse so the shape stays legible in the tray and taskbar.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "src-tauri" / "icons"

TILE_TOP = (31, 31, 34)
TILE_BOTTOM = (17, 17, 19)
DOT = (242, 242, 240)
SS = 8  # supersampling factor
# size -> (dots per side, pitch px, dot px) for pixel-snapped small icons.
PIXEL_GRID = {16: (5, 3, 2), 24: (5, 4, 3), 30: (7, 4, 3), 32: (7, 4, 3), 44: (7, 5, 4)}


def heights(n: int) -> list[int]:
    return [1, 3, 5, 7, 5, 3, 1] if n == 7 else [1, 3, 5, 3, 1]


def render(size: int) -> Image.Image:
    n = 7 if size >= 32 else 5
    plate = size >= 48
    glow = size >= 128
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))

    # Rounded tile with a gentle top-to-bottom gradient, like the bar's plate.
    margin = round(big * (0.03 if size >= 48 else 0.0))
    radius = round((big - 2 * margin) * 0.225)
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (margin, margin, big - margin - 1, big - margin - 1), radius, fill=255
    )
    gradient = Image.new("RGBA", (big, big))
    gd = ImageDraw.Draw(gradient)
    for y in range(big):
        t = y / max(1, big - 1)
        color = tuple(round(a + (b - a) * t) for a, b in zip(TILE_TOP, TILE_BOTTOM))
        gd.line([(0, y), (big, y)], fill=color + (255,))
    img.paste(gradient, (0, 0), mask)

    # Dot grid: the mark spans ~58% of the tile. Small sizes snap every dot
    # to whole pixels (integer pitch and gap) so the tray icon stays crisp.
    snapped = PIXEL_GRID.get(size)
    if snapped:
        n, pitch_px, dot_px = snapped
        extent = n * pitch_px - (pitch_px - dot_px)
        start = (size - extent) // 2
        pitch = pitch_px * SS
        radius_dot = dot_px * SS / 2
        origin = start * SS + radius_dot
        span = n * pitch
    else:
        span = (big - 2 * margin) * 0.58
        pitch = span / n
        radius_dot = pitch * 0.40
        origin = (big - span) / 2 + pitch / 2
    centre = n // 2
    lit_layer = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    ld = ImageDraw.Draw(lit_layer)
    off_layer = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    od = ImageDraw.Draw(off_layer)
    for c, h in enumerate(heights(n)):
        top = centre - h // 2
        for r in range(n):
            x = origin + c * pitch
            y = origin + r * pitch
            box = (x - radius_dot, y - radius_dot, x + radius_dot, y + radius_dot)
            if top <= r < top + h:
                alpha = round(255 * (1 - 0.09 * abs(c - centre)))
                ld.ellipse(box, fill=DOT + (alpha,))
            elif plate:
                od.ellipse(box, fill=DOT + (24,))

    img.alpha_composite(off_layer)
    if glow:
        halo = lit_layer.filter(ImageFilter.GaussianBlur(pitch * 0.55))
        halo.putalpha(halo.getchannel("A").point(lambda a: round(a * 0.35)))
        img.alpha_composite(halo)
    img.alpha_composite(lit_layer)
    # Keep everything inside the tile.
    clipped = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    clipped.paste(img, (0, 0), mask)
    return clipped.resize((size, size), Image.LANCZOS)


def main() -> None:
    ICONS.mkdir(parents=True, exist_ok=True)
    pngs = {
        "32x32.png": 32,
        "64x64.png": 64,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "icon.png": 512,
        "Square30x30Logo.png": 30,
        "Square44x44Logo.png": 44,
        "Square71x71Logo.png": 71,
        "Square89x89Logo.png": 89,
        "Square107x107Logo.png": 107,
        "Square142x142Logo.png": 142,
        "Square150x150Logo.png": 150,
        "Square284x284Logo.png": 284,
        "Square310x310Logo.png": 310,
        "StoreLogo.png": 50,
    }
    for name, size in pngs.items():
        render(size).save(ICONS / name)

    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [render(s) for s in ico_sizes]
    frames[-1].save(
        ICONS / "icon.ico",
        format="ICO",
        sizes=[(s, s) for s in ico_sizes],
        append_images=frames[:-1],
    )
    render(1024).save(ICONS / "icon.icns", format="ICNS")
    print("wrote", len(pngs) + 2, "icon files to", ICONS)


if __name__ == "__main__":
    main()
