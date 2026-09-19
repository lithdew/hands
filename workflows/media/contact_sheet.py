import json
import sys
import unicodedata
from pathlib import Path
from PIL import Image, ImageDraw
folder = Path(sys.argv[1])
entries = json.loads((folder / "frames.json").read_text(encoding="utf-8"))
cols = 2
tile_w, tile_h = 640, 395
sheet = Image.new("RGB", (cols * tile_w, ((len(entries) + cols - 1) // cols) * tile_h), "#0b1422")
draw = ImageDraw.Draw(sheet)
for i, entry in enumerate(entries):
    img = Image.open(folder / entry["path"]).convert("RGB")
    img.thumbnail((640, 360))
    x, y = (i % cols) * tile_w, (i // cols) * tile_h
    sheet.paste(img, (x, y))
    # Pillow's portable annotation font does not cover the movie's Unicode
    # glyphs. Keep labels ASCII; the actual rendered frame stays untouched.
    label = str(entry["title"]).translate(str.maketrans({"→": " -> ", "←": " <- ", "↔": " <-> ", "⇒": " => ", "—": " - ", "–": "-", "−": "-", "·": " / ", "×": "x"}))
    label = unicodedata.normalize("NFKD", label).encode("ascii", "replace").decode("ascii")
    draw.text((x + 12, y + 370), label[:90], fill="#f1f5fa")
sheet.save(folder / "contact-sheet.png")
