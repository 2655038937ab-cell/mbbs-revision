"""PDF parser using PyMuPDF (fitz).

Extracts, per page:
  - text layer
  - figures: embedded raster images grouped by proximity — nearby images on the
    same page (e.g. a diagram + its legend/labels) are merged into ONE figure,
    cropped from the page render so vector content between them is included
  - a rendered page image (JPEG) as a fallback "page" item
"""
import base64

try:
    import fitz  # PyMuPDF
except ImportError as exc:  # pragma: no cover
    raise ImportError("PyMuPDF is required for PDF support. Run: .venv/bin/pip install pymupdf") from exc


def _sample_stats(pix, max_px=4000):
    """Return (mean, stddev) of pixel brightness, sampled at <= max_px pixels."""
    s = pix.samples
    n = pix.n
    if not s or n < 3:
        return 255.0, 0.0
    step = max(1, (len(s) // n) // max_px)
    total = 0.0
    total_sq = 0.0
    cnt = 0
    for i in range(0, len(s) - n + 1, n * step):
        v = (s[i] + s[i + 1] + s[i + 2]) / 3.0
        total += v
        total_sq += v * v
        cnt += 1
    if not cnt:
        return 255.0, 0.0
    mean = total / cnt
    var = max(0.0, total_sq / cnt - mean * mean)
    return mean, var ** 0.5


def _is_blank(pix):
    """True if the pixmap is uniformly (near-)black or (near-)white (no real content)."""
    mean, std = _sample_stats(pix)
    return std < 6.0 and (mean < 20.0 or mean > 250.0)


def _extract_jpeg(doc, info):
    """Re-encode an embedded image as an RGB JPEG. Returns bytes or None if unusable."""
    ext = info.get("ext") or "png"
    try:
        d = fitz.open(stream=info["image"], filetype=ext)
        if len(d) == 0:
            return None
        pix = d[0].get_pixmap(colorspace=fitz.csRGB, alpha=False)
        d.close()
    except Exception:
        return None
    if pix.width < 60 or pix.height < 60:
        return None
    if _is_blank(pix):
        return None  # e.g. stencil/SMask bitmaps that are not real figures
    return pix.tobytes("jpeg", jpg_quality=88)


def _figures(doc, page, num):
    """Group nearby embedded images into single figures, cropped from the page render."""
    items = []
    seen = set()
    for img in page.get_images(full=True):
        xref = img[0]
        if xref in seen:
            continue
        seen.add(xref)
        try:
            info = doc.extract_image(xref)
        except Exception:
            continue
        w, h = info.get("width", 0), info.get("height", 0)
        if not w or not h or w * h < 20000:
            continue  # tiny icon/logo
        rects = page.get_image_rects(xref)
        if not rects:
            continue  # referenced but not drawn on the page
        rect = max(rects, key=lambda r: r.width * r.height)
        if rect.width >= page.rect.width * 0.9 and rect.height >= page.rect.height * 0.9:
            continue  # whole-slide rasterized page (duplicates the page render)
        items.append({"rect": rect, "info": info})

    if not items:
        return []

    # Proximity clustering: merge rects whose inflated boxes overlap
    # (a figure and its adjacent labels/legend become ONE figure). A slightly
    # larger inflation catches callout label images a little farther out.
    ix = page.rect.width * 0.05
    iy = page.rect.height * 0.05

    def near(a, b):
        return (a.x0 - ix) < b.x1 and (a.x1 + ix) > b.x0 and (a.y0 - iy) < b.y1 and (a.y1 + iy) > b.y0

    clusters = []
    for r in items:
        for cl in clusters:
            if any(near(r["rect"], c["rect"]) for c in cl):
                cl.append(r)
                break
        else:
            clusters.append([r])

    figs = []
    for i, cl in enumerate(clusters):
        u = cl[0]["rect"]
        for it in cl[1:]:
            r = it["rect"]
            u = fitz.Rect(min(u.x0, r.x0), min(u.y0, r.y0), max(u.x1, r.x1), max(u.y1, r.y1))
        if u.width < 20 or u.height < 20:
            continue

        # Padding around the union so callout labels at the figure's edge
        # (e.g. "Axillary a.", "Deep palmar arch") aren't clipped. Labels often
        # sit just outside the embedded-image bbox. ~30pt (~0.4in) leaves room
        # for callout text while still staying close to the figure.
        pad_x = max(30.0, page.rect.width * 0.025)
        pad_y = max(30.0, page.rect.height * 0.025)
        u = fitz.Rect(u.x0 - pad_x, u.y0 - pad_y, u.x1 + pad_x, u.y1 + pad_y)
        u = fitz.Rect(
            min(max(u.x0, page.rect.x0), page.rect.x1),
            min(max(u.y0, page.rect.y0), page.rect.y1),
            min(max(u.x1, page.rect.x0), page.rect.x1),
            min(max(u.y1, page.rect.y0), page.rect.y1),
        )
        if u.width < 20 or u.height < 20:
            continue

        data_url = None
        try:
            # Cap the figure's render resolution: large crops are downsampled so
            # the extracted figure payloads stay small. Use 160 dpi baseline but
            # never produce an image taller/wider than ~1600 px.
            w_pt = u.width or 1
            h_pt = u.height or 1
            scale = min(160 / 72, 1600.0 / max(w_pt, h_pt))
            crop = page.get_pixmap(
                matrix=fitz.Matrix(scale, scale), clip=u, colorspace=fitz.csRGB, alpha=False
            )
        except Exception:
            crop = None
        if crop is not None and crop.width >= 60 and crop.height >= 60 and not _is_blank(crop):
            jpeg = crop.tobytes("jpeg", jpg_quality=84)
            data_url = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode("ascii")
        if data_url is None:
            # Fallback: use the largest embedded image itself (never a black crop).
            for it in sorted(cl, key=lambda it: it["info"].get("width", 0) * it["info"].get("height", 0), reverse=True):
                jpeg = _extract_jpeg(doc, it["info"])
                if jpeg:
                    data_url = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode("ascii")
                    break
        if data_url:
            figs.append(
                {
                    "name": "page%d-group%d.jpg" % (num, i + 1),
                    "mime": "image/jpeg",
                    "dataUrl": data_url,
                    "kind": "figure",
                    "x": (u.x0 / page.rect.width) if page.rect.width else 0,
                    "y": (u.y0 / page.rect.height) if page.rect.height else 0,
                    "w": (u.width / page.rect.width) if page.rect.width else 0,
                    "h": (u.height / page.rect.height) if page.rect.height else 0,
                }
            )
    return figs


def _fix_symbol_font(text):
    """Normalize Wingdings/Symbol PUA characters that PDF text extraction leaves
    as invisible private-use glyphs (e.g. \\uf0ae right-arrow, \\uf0af down-arrow
    meaning "decreased"). Without this, the AI can't see the direction and guesses
    the wrong meaning (e.g. reads "↓ extracellular potassium" as "increased").
    """
    if not text:
        return text
    # Common Wingdings arrows. Mapping is conservative: only well-known ones.
    mapping = {
        "\uf0ad": "←",
        "\uf0ae": "→",
        "\uf0af": "↓",
        "\uf0b0": "↔",
        "\uf0c4": "×",
        "\uf0d8": "✓",
    }
    out = []
    for ch in text:
        out.append(mapping.get(ch, ch))
    return "".join(out)


def parse_pdf(data):
    """Return {'slides': [...], 'count': N}. data = raw PDF bytes."""
    try:
        doc = fitz.open(stream=data, filetype="pdf")
    except Exception as exc:
        raise ValueError("Could not open PDF: %s" % exc)

    slides = []
    for i, page in enumerate(doc):
        num = i + 1
        text = _fix_symbol_font((page.get_text("text") or "").strip())
        # Render the page to a JPEG (display fallback). Keep it readable but
        # much smaller: 90 dpi + jpg quality 78 (the full-page render is by far
        # the largest payload, ~116 MB across the library).
        pix = page.get_pixmap(dpi=90, colorspace=fitz.csRGB, alpha=False)
        jpeg = pix.tobytes("jpeg", jpg_quality=78)
        page_url = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode("ascii")

        images = _figures(doc, page, num)
        # Page render goes LAST as a fallback for display.
        images.append({"name": "page%d.jpg" % num, "mime": "image/jpeg", "dataUrl": page_url, "kind": "page"})

        slides.append(
            {
                "index": num,
                "text": text,
                "notes": "",
                "images": images,
            }
        )
    doc.close()
    return {"slides": slides, "count": len(slides)}
