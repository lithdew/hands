import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
folder = Path(sys.argv[1])
entries = json.loads((folder / "frames.json").read_text(encoding="utf-8"))
cols = 2
tile_w, tile_h = 640, 400
sheet = Image.new("RGB", (cols * tile_w, ((len(entries) + cols - 1) // cols) * tile_h), "#0b1422")
draw = ImageDraw.Draw(sheet)
font = ImageFont.load_default()
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
    draw.text((x + 12, y + 368), f"{i + 1:02d}  {str(entry['title'])[:70]}", fill="#f1f5fa", font=font)
sheet.save(folder / "contact-sheet.png")
