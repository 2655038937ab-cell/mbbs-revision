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
import struct
import zipfile
import zlib
from xml.etree import ElementTree as ET

# Namespaces used inside PPTX OOXML
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"



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


def _slide_size(zf):
    """Return (width_emu, height_emu) of the slide master, or (914400, 685800) default."""
    for path in ("ppt/presentation.xml", "ppt/slideMasters/slideMaster1.xml"):
        if path in zf.namelist():
            try:
                root = ET.fromstring(zf.read(path))
            except ET.ParseError:
                continue
            sz = root.find("{%s}sldSz" % P_NS)
            if sz is not None:
                try:
                    return int(sz.attrib.get("cx", 914400)), int(sz.attrib.get("cy", 685800))
                except ValueError:
                    pass
    return 914400, 685800


def _parse_pic_boxes(slide_xml, slide_w, slide_h):
    """Map rId -> normalized bounding box for every picture on the slide.

    Returns {rId: {"x","y","w","h"}} with coordinates as fractions (0-1) of the
    slide, so the server can tell whether a repeated image sits in a corner
    (e.g. a school logo top-right).
    """
    boxes = {}
    if not slide_xml:
        return boxes
    try:
        root = ET.fromstring(slide_xml)
    except ET.ParseError:
        return boxes
    for pic in root.iter("{%s}pic" % P_NS):
        blip = pic.find(".//{%s}blip" % A_NS)
        if blip is None:
            continue
        rid = blip.attrib.get("{%s}embed" % R_NS)
        if not rid:
            continue
        xfrm = pic.find(".//{%s}xfrm" % A_NS)
        if xfrm is None:
            continue
        off = xfrm.find("{%s}off" % A_NS)
        ext = xfrm.find("{%s}ext" % A_NS)
        if off is None or ext is None:
            continue
        try:
            x = int(off.attrib.get("x", 0)) / float(slide_w)
            y = int(off.attrib.get("y", 0)) / float(slide_h)
            w = int(ext.attrib.get("cx", 0)) / float(slide_w)
            h = int(ext.attrib.get("cy", 0)) / float(slide_h)
        except (ValueError, ZeroDivisionError):
            continue
        if w <= 0 or h <= 0:
            continue
        boxes[rid] = {"x": x, "y": y, "w": w, "h": h}
    return boxes


def _slide_images(zf, num, slide_xml=None, slide_w=914400, slide_h=685800, skipped=None):
    images = []
    if skipped is None:
        skipped = []
    boxes = _parse_pic_boxes(slide_xml, slide_w, slide_h)
    for rid, target in _read_rels(zf, num):
        entry = _resolve_media(zf, target)
        if not entry:
            continue
        try:
            raw = zf.read(entry)
        except Exception:
            continue
        name = posixpath.basename(entry)
        # Trust the bytes, not the extension: a mislabelled file otherwise ships
        # with a MIME type no browser can display.
        mime = sniff_image_mime(raw)
        if mime == "image/x-emf":
            # Vector metafile: keep the picture by recovering its embedded bitmap.
            # Shipping the raw bytes instead would show the student a blank figure
            # while any AI reading them invents a topic that was never on the slide.
            png = emf_to_png(raw)
            if not png:
                skipped.append(name)
                continue
            raw, mime = png, "image/png"
            name = name.rsplit(".", 1)[0] + ".png"
        elif mime not in _RENDERABLE_MIME:
            # Nothing a browser can draw (TIFF, unknown container, ...).
            skipped.append(name)
            continue
        data_url = "data:%s;base64,%s" % (mime, base64.b64encode(raw).decode("ascii"))
        im = {"name": name, "mime": mime, "dataUrl": data_url}
        if rid in boxes:
            im.update(boxes[rid])
        images.append(im)
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
    skipped = []
    slide_w, slide_h = _slide_size(zf)
    for sf in slide_files:
        num = int(re.search(r"slide(\d+)\.xml$", sf).group(1))
        slide_xml = zf.read(sf)
        text = _extract_text(slide_xml)
        images = _slide_images(zf, num, slide_xml, slide_w, slide_h, skipped)
        notes = _slide_notes(zf, num)
        slides.append({"index": num, "text": text, "images": images, "notes": notes})
    # `skipped` names media that could not be turned into anything displayable;
    # the caller surfaces the count so the student knows a figure was left out.
    return {"slides": slides, "count": len(slides), "skippedImages": skipped}


def is_pptx(data):
    return data[:4] == b"PK\x03\x04"

# ---------------------------------------------------------------- EMF / WMF
# PowerPoint decks frequently carry vector metafiles (EMF/WMF): pasted anatomy
# or logo artwork. Browsers cannot render them, so shipping the raw bytes gives
# the student a blank figure, wastes megabytes of payload — and if the raw bytes
# are handed to a vision model anyway, a figure nobody can see still steers the
# generated points/cards/quiz. Most such metafiles are a single embedded bitmap
# (EMR_STRETCHDIBITS), so recover that bitmap as a PNG; when there is nothing
# recoverable, drop the image instead of shipping something invisible.

_RENDERABLE_MIME = {
    "image/jpeg", "image/png", "image/gif", "image/bmp", "image/webp", "image/svg+xml",
}


def sniff_image_mime(raw):
    """True format of an image blob, ignoring a possibly wrong file extension."""
    if not raw:
        return ""
    if raw[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if raw[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if raw[:2] == b"BM":
        return "image/bmp"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    if raw[:4] in (b"\x01\x00\x00\x00", b"\xd7\xcd\xc6\x9a"):
        return "image/x-emf"
    if raw[:5] == b"<?xml" or b"<svg" in raw[:400]:
        return "image/svg+xml"
    return ""


def _png_chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def _write_png(width, height, rows):
    raw = b"".join(b"\x00" + r for r in rows)
    return (b"\x89PNG\r\n\x1a\n"
            + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + _png_chunk(b"IDAT", zlib.compress(raw, 6))
            + _png_chunk(b"IEND", b""))


def _find_dib(bits):
    """Locate one plausible BITMAPINFOHEADER + its pixel data inside `bits`.

    Returns (header_dict, pixel_bytes) for the largest bitmap found. Scanning
    works for every EMF record that carries a DIB (STRETCHDIBITS / BITBLT /
    STRETCHBLT) without relying on per-record offsets.
    """
    best = None
    # Jump candidate to candidate with bytes.find (C speed) instead of testing every
    # offset in Python: a single metafile can carry megabytes of bitmap, and EMF
    # structures are DWORD-aligned, so a header can only start on a 4-byte boundary.
    needle = struct.pack("<I", 40)
    limit = len(bits) - 40
    off = bits.find(needle)
    while 0 <= off <= limit:
        nxt = bits.find(needle, off + 4)      # advance first: every branch must progress
        if off % 4 == 0:
            w, h = struct.unpack_from("<ii", bits, off + 4)
            planes, bpp = struct.unpack_from("<HH", bits, off + 12)
            comp = struct.unpack_from("<I", bits, off + 16)[0]
            if (planes == 1 and bpp in (8, 24, 32) and comp in (0, 3)
                    and 16 <= w <= 8000 and 16 <= abs(h) <= 8000):
                palette = (1 << bpp) * 4 if bpp == 8 else 0
                start = off + 40 + palette
                stride = ((w * bpp // 8) + 3) // 4 * 4
                need = stride * abs(h)
                if start + need <= len(bits) and (best is None or need > best[2]):
                    best = (off, (w, h, bpp, comp, start, palette), need)
        off = nxt
    if not best:
        return None, b""
    _, meta, _ = best
    w, h, bpp, comp, start, palette = meta
    stride = ((w * bpp // 8) + 3) // 4 * 4
    return {"w": w, "h": abs(h), "bpp": bpp, "comp": comp,
            "palette": best[0] + 40 if palette else 0, "stride": stride}, bits[start:start + stride * abs(h)]


def emf_to_png(raw, max_width=1400):
    """Recover the bitmap inside an EMF/WMF as PNG bytes, or b'' if impossible."""
    header, pixels = _find_dib(raw)
    if not header or not pixels:
        return b""
    w, h, bpp, stride = header["w"], header["h"], header["bpp"], header["stride"]
    pal = b""
    if palette_off := header.get("palette"):
        pal = raw[palette_off:palette_off + 256 * 4]
    step = max(1, (w + max_width - 1) // max_width)
    rows = []
    for y in range(h - 1, -1, -step):                        # DIB rows are bottom-up
        base = y * stride
        row = bytearray()
        for x in range(0, w, step):
            o = base + x * bpp // 8
            if o + bpp // 8 > len(pixels):
                row += b"\x00\x00\x00"
                continue
            if bpp == 24:
                b, g, r = pixels[o], pixels[o + 1], pixels[o + 2]
            elif bpp == 32:
                b, g, r = pixels[o], pixels[o + 1], pixels[o + 2]
            else:
                i = pixels[o] * 4
                b, g, r = pal[i:i + 3] if len(pal) >= i + 3 else (0, 0, 0)
            row += bytes((r, g, b))
        rows.append(bytes(row))
    return _write_png((w + step - 1) // step, len(rows), rows)
