"""Minimal DOCX reader — standard library only.

A Word exam paper is a ZIP of XML, and the app only needs its body text in reading
order, so this walks ``word/document.xml`` directly rather than pulling in python-docx,
which the runtime image does not have (and every extra dependency is one more thing
that can fail to install on a server).

What it produces is the same shape the PDF and PPTX parsers return — ``{"slides": [...],
"count": N}`` — so everything downstream (the lesson record, the page images, the vision
OCR of pages without text) works unchanged. Paragraphs and tables come out in document
order, and explicit page breaks (plus Word's own ``lastRenderedPageBreak`` markers) split
the document into the "pages" the rest of the app is built around.

Embedded images are deliberately NOT imported: matching a drawing to its position needs
the relationship table, and a Word paper whose figures matter is better exported to PDF
first, where the page render carries them. The upload sheet says exactly that.
"""
import io
import zipfile
from xml.etree import ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _runs_text(node):
    """Concatenate the text of a paragraph/cell, honouring tabs and line breaks."""
    parts = []
    for child in node.iter():
        tag = child.tag
        if tag == W + "t":
            parts.append(child.text or "")
        elif tag == W + "tab":
            parts.append("\t")
        elif tag == W + "br":
            parts.append("\n")
    return "".join(parts)


def _has_page_break(node):
    for el in node.iter():
        if el.tag == W + "br" and el.get(W + "type") == "page":
            return True
        if el.tag == W + "lastRenderedPageBreak":
            return True
    return False


def _table_text(tbl):
    lines = []
    for row in tbl.findall(W + "tr"):
        cells = [_runs_text(c).strip().replace("\n", " ") for c in row.findall(W + "tc")]
        if any(cells):
            lines.append(" | ".join(cells))
    return "\n".join(lines)


def parse_docx(raw):
    """Return {"slides": [...], "count": N, "title": str} for a .docx file."""
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            names = set(z.namelist())
            if "word/document.xml" not in names:
                raise ValueError("这不是一个 Word 文档（缺少 word/document.xml）")
            xml = z.read("word/document.xml")
    except zipfile.BadZipFile as exc:
        raise ValueError("无法读取这个 .docx 文件：%s" % exc) from exc

    root = ET.fromstring(xml)
    body = root.find(W + "body")
    if body is None:
        raise ValueError("Word 文档内容为空")

    pages = []
    current = []

    def flush():
        text = "\n".join(x for x in current if x.strip()).strip()
        if text:
            pages.append(text)
        current.clear()

    for el in list(body):
        if el.tag == W + "p":
            if _has_page_break(el):
                flush()
            current.append(_runs_text(el))
        elif el.tag == W + "tbl":
            if _has_page_break(el):
                flush()
            current.append(_table_text(el))
        # other body elements (bookmarks, sectPr, …) carry no text
    flush()

    if not pages:
        raise ValueError("这个 Word 文档里没有可读的文字")

    slides = []
    for i, text in enumerate(pages):
        slides.append({"index": i + 1, "text": text, "notes": "", "images": []})
    title = pages[0].strip().splitlines()[0][:60] if pages else "Word 文档"
    return {"slides": slides, "count": len(slides), "title": title}
