import json
import sys
import unicodedata
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
folder = Path(sys.argv[1])
entries = json.loads((folder / "frames.json").read_text(encoding="utf-8"))
cols = 2
tile_w, tile_h = 640, 400
sheet = Image.new("RGB", (cols * tile_w, ((len(entries) + cols - 1) // cols) * tile_h), "#0b1422")
draw = ImageDraw.Draw(sheet)
font = None
for candidate in ("segoeui.ttf", "arial.ttf", "DejaVuSans.ttf"):
    try:
        font = ImageFont.truetype(candidate, 20)
        break
    except OSError:
        continue
for i, entry in enumerate(entries):
    img = Image.open(folder / entry["path"]).convert("RGB")
    img.thumbnail((640, 360))
    x, y = (i % cols) * tile_w, (i // cols) * tile_h
    sheet.paste(img, (x, y))
    label = str(entry["title"])
    if font is None:
        # Pillow's portable annotation font does not cover the movie's Unicode
        # glyphs. Keep labels ASCII; the actual rendered frame stays untouched.
        label = label.translate(str.maketrans({"→": " -> ", "←": " <- ", "↔": " <-> ", "⇒": " => ", "—": " - ", "–": "-", "−": "-", "·": " / ", "×": "x"}))
        label = unicodedata.normalize("NFKD", label).encode("ascii", "replace").decode("ascii")
    draw.text((x + 12, y + 368), f"{i + 1:02d}  {label[:70]}", fill="#f1f5fa", font=font or ImageFont.load_default())
sheet.save(folder / "contact-sheet.png")
