"""PDF parser using PyMuPDF (fitz).

Extracts, per page:
  - text layer
  - a rendered page image (JPEG) so the page can be displayed
    and fed to a vision model for figure/diagram understanding.
"""
import base64
import io

try:
    import fitz  # PyMuPDF
except ImportError as exc:  # pragma: no cover
    raise ImportError("PyMuPDF is required for PDF support. Run: .venv/bin/pip install pymupdf") from exc


def parse_pdf(data):
    """Return {'slides': [...], 'count': N}. data = raw PDF bytes."""
    try:
        doc = fitz.open(stream=data, filetype="pdf")
    except Exception as exc:
        raise ValueError("Could not open PDF: %s" % exc)

    slides = []
    for i, page in enumerate(doc):
        num = i + 1
        text = (page.get_text("text") or "").strip()
        # Render the page to a JPEG for display + vision analysis.
        pix = page.get_pixmap(dpi=110, colorspace=fitz.csRGB, alpha=False)
        jpeg = pix.tobytes("jpeg", jpg_quality=85)
        data_url = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode("ascii")
        slides.append(
            {
                "index": num,
                "text": text,
                "notes": "",
                "images": [
                    {"name": "page%d.jpg" % num, "mime": "image/jpeg", "dataUrl": data_url, "kind": "page"}
                ],
            }
        )
    doc.close()
    return {"slides": slides, "count": len(slides)}
