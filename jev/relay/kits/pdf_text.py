# pdf_text.py — a PDF's text, page by page, for kits/py.ts. Prints JSON: {"pages": [...], "error": ""}.
# A scanned paper has no text layer; that comes back as empty pages, and the caller says so.
import json
import sys

try:
    from pypdf import PdfReader

    reader = PdfReader(sys.argv[1])
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 40
    pages = []
    for page in reader.pages[:limit]:
        try:
            pages.append(page.extract_text() or "")
        except Exception:  # one unreadable page should not lose the paper
            pages.append("")
    print(json.dumps({"pages": pages, "error": ""}))
except Exception as error:  # noqa: BLE001
    print(json.dumps({"pages": [], "error": f"{type(error).__name__}: {error}"[:300]}))
