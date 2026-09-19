"""Faithful pixel crop of an inspected preview screenshot for pitch evidence.

Usage: python evidence_crop.py SOURCE.png DEST.png LEFT TOP WIDTH HEIGHT
The crop copies pixels unchanged; nothing is resized, redrawn or annotated.
"""
import sys
from pathlib import Path
from PIL import Image

source, dest = Path(sys.argv[1]), Path(sys.argv[2])
left, top, width, height = (int(value) for value in sys.argv[3:7])
if width <= 0 or height <= 0 or left < 0 or top < 0:
    raise SystemExit("Crop box must be positive and inside the image")
with Image.open(source) as image:
    if left + width > image.width or top + height > image.height:
        raise SystemExit(f"Crop box exceeds the {image.width}x{image.height} source")
    image.crop((left, top, left + width, top + height)).save(dest, format="PNG", optimize=False)
