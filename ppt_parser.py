"""Pure-stdlib PPTX (.pptx) parser.

Extracts, per slide:
  - visible text (title + body + tables), in reading order
  - embedded images (as base64 data URLs)
  - speaker notes

No third-party dependencies (uses zipfile + xml.etree only).
"""
import base64
import io
import posixpath
import re
import zipfile
from xml.etree import ElementTree as ET

# Namespaces used inside PPTX OOXML
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

IMAGE_MIME = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "bmp": "image/bmp",
    "webp": "image/webp",
    "svg": "image/svg+xml",
    "tiff": "image/tiff",
    "tif": "image/tiff",
}


def _natural_key(name):
    m = re.search(r"slide(\d+)\.xml$", name)
    return int(m.group(1)) if m else 0


def _extract_text(xml_bytes):
    """Extract visible text from any OOXML fragment (slide / notes / etc)."""
    if not xml_bytes:
        return ""
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return ""
    lines = []
    for p in root.iter("{%s}p" % A_NS):
        parts = [t.text or "" for t in p.iter("{%s}t" % A_NS)]
        line = "".join(parts).strip()
        if line:
            lines.append(line)
    return "\n".join(lines)


def _read_rels(zf, num):
    path = "ppt/slides/_rels/slide%d.xml.rels" % num
    if path not in zf.namelist():
        return []
    try:
        root = ET.fromstring(zf.read(path))
    except ET.ParseError:
        return []
    rels = []
    for rel in root:
        rid = rel.attrib.get("Id", "")
        rtype = rel.attrib.get("Type", "")
        target = rel.attrib.get("Target", "")
        if "image" in rtype.lower() and target:
            rels.append((rid, target))
    # order by the numeric part of the rId so images appear in insertion order
    def _rid_num(item):
        m = re.search(r"(\d+)", item[0])
        return int(m.group(1)) if m else 0

    return sorted(rels, key=_rid_num)


def _resolve_media(zf, target):
    """Resolve a rel target like '../media/image1.png' to a zip entry."""
    base = "ppt/slides"
    norm = posixpath.normpath(posixpath.join(base, target))
    if norm in zf.namelist():
        return norm
    # fallback: try the raw target under ppt/
    alt = posixpath.normpath(posixpath.join("ppt", target))
    if alt in zf.namelist():
        return alt
    return None


def _slide_images(zf, num):
    images = []
    for _rid, target in _read_rels(zf, num):
        entry = _resolve_media(zf, target)
        if not entry:
            continue
        ext = entry.rsplit(".", 1)[-1].lower() if "." in entry else ""
        mime = IMAGE_MIME.get(ext, "application/octet-stream")
        try:
            raw = zf.read(entry)
        except Exception:
            continue
        data_url = "data:%s;base64,%s" % (mime, base64.b64encode(raw).decode("ascii"))
        images.append({"name": posixpath.basename(entry), "mime": mime, "dataUrl": data_url})
    return images


def _slide_notes(zf, num):
    path = "ppt/notesSlides/notesSlide%d.xml" % num
    if path not in zf.namelist():
        return ""
    return _extract_text(zf.read(path))


def parse_pptx(data):
    """Return {'slides': [...], 'count': N}. data = raw file bytes."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ValueError("Not a valid .pptx file (expected a ZIP-based PPTX).")

    slide_files = sorted(
        [n for n in zf.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)],
        key=_natural_key,
    )
    if not slide_files:
        raise ValueError("No slides found — is this a real .pptx file?")

    slides = []
    for sf in slide_files:
        num = int(re.search(r"slide(\d+)\.xml$", sf).group(1))
        text = _extract_text(zf.read(sf))
        images = _slide_images(zf, num)
        notes = _slide_notes(zf, num)
        slides.append({"index": num, "text": text, "images": images, "notes": notes})
    return {"slides": slides, "count": len(slides)}


def is_pptx(data):
    return data[:4] == b"PK\x03\x04"
