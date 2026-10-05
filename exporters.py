"""Server-side export helpers: PDF, Anki .apkg, Google Drive upload."""
import io
import os
import re
import tempfile

# reportlab
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, ListFlowable, ListItem

# genanki
import genanki

# Google Drive
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload

PDFMIME = "application/pdf"


def _esc(s):
    return str(s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ---------------------------------------------------------------------------
# Fonts
# ---------------------------------------------------------------------------
# Lesson text is mostly Simplified Chinese with Greek letters and math symbols
# mixed in. reportlab's built-in Type-1 fonts are WinAnsi-only, so CJK came out
# as placeholder glyphs (pymupdf extraction showed "III" for every character):
# the PDF was unreadable even after the HTTP layer stopped failing. PyMuPDF is
# already a dependency (pdf_parser) and bundles Droid Sans Fallback, a 3.5 MB
# TTF covering CJK + Greek + the symbols we emit, so we embed it as a real
# (subsetted) font — no new dependency and no font binary added to the repo.
_FONT_NAME = None


def _pdf_font_name():
    """Register and return the font family used for exported PDFs."""
    global _FONT_NAME
    if _FONT_NAME:
        return _FONT_NAME
    try:
        import pymupdf  # already required by pdf_parser; import lazily on purpose
        # TTFont accepts a file-like object, so nothing touches the filesystem.
        pdfmetrics.registerFont(TTFont("MBBS-CJK", io.BytesIO(pymupdf.Font("cjk").buffer)))
        family = "MBBS-CJK"
    except Exception:
        # Fall back to reportlab's built-in CJK CID font (not embedded, but
        # renders correctly in viewers that substitute a system CJK font).
        try:
            from reportlab.pdfbase.cidfonts import UnicodeCIDFont
            pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
            family = "STSong-Light"
        except Exception:
            family = "Helvetica"
    try:
        # Map bold/italic onto the same face so <b>/<i> in the markup below
        # degrade to regular weight instead of raising "family not found".
        pdfmetrics.registerFontFamily(family, normal=family, bold=family,
                                      italic=family, boldItalic=family)
    except Exception:
        pass
    _FONT_NAME = family
    return family


# ---------------------------------------------------------------------------
# Math ($...$ LaTeX) -> reportlab inline markup
# ---------------------------------------------------------------------------
# The LLM prompts produce fields that naturally contain LaTeX, e.g.
# "膜电容约为 $1\ \mu F/cm^2$" or "$\frac{dn}{dt}=\alpha(1-n)-\beta n$". Those
# were written to the PDF verbatim, so readers saw the raw $ source. reportlab
# cannot lay out real math, but it does support <super>/<sub>/<i> plus Unicode,
# so a small, dependency-free LaTeX-subset converter renders the common cases as
# typeset text instead.
_GREEK = {
    "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ε",
    "varepsilon": "ε", "zeta": "ζ", "eta": "η", "theta": "θ", "vartheta": "θ",
    "iota": "ι", "kappa": "κ", "lambda": "λ", "mu": "μ", "nu": "ν", "xi": "ξ",
    "pi": "π", "varpi": "π", "rho": "ρ", "varrho": "ρ", "sigma": "σ",
    "varsigma": "ς", "tau": "τ", "upsilon": "υ", "phi": "φ", "varphi": "φ",
    "chi": "χ", "psi": "ψ", "omega": "ω",
    "Gamma": "Γ", "Delta": "Δ", "Theta": "Θ", "Lambda": "Λ", "Xi": "Ξ",
    "Pi": "Π", "Sigma": "Σ", "Upsilon": "Υ", "Phi": "Φ", "Psi": "Ψ",
    "Omega": "Ω",
}

_SYMBOLS = {
    "times": "×", "cdot": "·", "ast": "*", "pm": "±", "mp": "∓",
    "leq": "≤", "le": "≤", "geq": "≥", "ge": "≥", "neq": "≠", "ne": "≠",
    "approx": "≈", "equiv": "≡", "sim": "∼", "propto": "∝", "ll": "≪",
    "gg": "≫", "to": "→", "rightarrow": "→", "leftarrow": "←",
    "leftrightarrow": "↔", "Rightarrow": "⇒", "Leftarrow": "⇐",
    "Leftrightarrow": "⇔", "longrightarrow": "⟶", "mapsto": "↦",
    "infty": "∞", "int": "∫", "oint": "∮", "sum": "∑", "prod": "∏",
    "partial": "∂", "nabla": "∇", "in": "∈", "notin": "∉", "ni": "∋",
    "subset": "⊂", "supset": "⊃", "subseteq": "⊆", "supseteq": "⊇",
    "cup": "∪", "cap": "∩", "emptyset": "∅", "forall": "∀", "exists": "∃",
    "angle": "∠", "perp": "⊥", "parallel": "∥", "ldots": "…", "cdots": "⋯",
    "dots": "…", "prime": "′", "degree": "°", "circ": "∘", "micro": "μ",
    "lt": "&lt;", "gt": "&gt;", "mid": "|", "vert": "|", "Vert": "‖",
    "langle": "⟨", "rangle": "⟩", "lceil": "⌈", "rceil": "⌉",
    "lfloor": "⌊", "rfloor": "⌋", "hbar": "ℏ", "ell": "ℓ", "Re": "ℜ",
    "Im": "ℑ", "aleph": "ℵ", "therefore": "∴", "because": "∵",
}

# Commands that carry no glyph of their own (spacing / sizing / style hints).
_MATH_SKIP = {
    "left", "right", "big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl",
    "Bigr", "displaystyle", "textstyle", "scriptstyle", "limits", "nolimits",
    "rm", "bf", "it", "sf", "tt", "cal", "mathbb", "mathnormal", "mathord",
    "mathbin", "mathrel", "mathop", "mathpunct", "thinspace", "enspace",
    "quad", "qquad", "negthinspace", "middle",
    # Equation numbering / labels carry no visible glyph in this export.
    "tag", "label", "nonumber", "notag", "mathring", "ensuremath",
}

_MATH_WRAP = {"text", "mathrm", "mathbf", "mathit", "mathsf", "mathtt",
              "operatorname", "mbox", "textrm", "textbf", "textit"}

# \command{x} forms whose argument is rendered but whose command adds no glyph.
_MATH_UNWRAP = {"overline", "underline", "vec", "hat", "bar", "dot", "ddot",
                "tilde", "widehat", "widetilde", "sqrt"}

_MATH_SFAMILY = {"sqrt": "√"}


def _skip_ws(s, i):
    while i < len(s) and s[i] in " \t\r\n":
        i += 1
    return i


def _take_group(s, i):
    """Return (content, next_index) for one argument at/after index i.

    Accepts either a {braced group} or a single token, like LaTeX does."""
    i = _skip_ws(s, i)
    if i >= len(s):
        return "", i
    if s[i] == "{":
        depth = 0
        j = i
        while j < len(s):
            if s[j] == "{":
                depth += 1
            elif s[j] == "}":
                depth -= 1
                if depth == 0:
                    return s[i + 1:j], j + 1
            j += 1
        return s[i + 1:], len(s)
    return s[i], i + 1


def _render_math(s):
    """Convert an (already XML-escaped) LaTeX fragment to reportlab markup."""
    out = []
    i, n = 0, len(s)
    while i < n:
        ch = s[i]
        if ch == "\\":
            cmd = re.match(r"\\([A-Za-z]+)", s[i:])
            if cmd:
                name = cmd.group(1)
                i += cmd.end()
                if name in _GREEK:
                    out.append(_GREEK[name])
                elif name in _SYMBOLS:
                    out.append(_SYMBOLS[name])
                elif name in ("frac", "dfrac", "tfrac", "cfrac"):
                    num, i = _take_group(s, i)
                    den, i = _take_group(s, i)
                    out.append("(%s)/(%s)" % (_render_math(num), _render_math(den)))
                elif name in _MATH_SFAMILY:
                    arg, i = _take_group(s, i)
                    out.append("%s(%s)" % (_MATH_SFAMILY[name], _render_math(arg)))
                elif name in _MATH_WRAP or name in _MATH_UNWRAP:
                    arg, i = _take_group(s, i)
                    out.append(_render_math(arg))
                elif name in _MATH_SKIP:
                    out.append(" ")
                else:
                    # Unknown command: keep the name rather than dropping the
                    # symbol entirely, so nothing silently disappears.
                    out.append(name)
                continue
            if i + 1 < n:
                nxt = s[i + 1]
                if nxt in "{}%$&#_":
                    out.append(nxt)
                elif nxt == " ":
                    out.append(" ")
                elif nxt == "\\":
                    out.append(" ")
                i += 2
                continue
            i += 1
            continue
        if ch in "^_":
            tag = "super" if ch == "^" else "sub"
            i += 1
            arg, i = _take_group(s, i)
            out.append("<%s>%s</%s>" % (tag, _render_math(arg), tag))
            continue
        if ch == "{":
            arg, i = _take_group(s, i)
            out.append(_render_math(arg))
            continue
        if ch == "}":
            i += 1
            continue
        out.append(ch)
        i += 1
    return re.sub(r"[ \t\r\n]+", " ", "".join(out)).strip()


# \[...\] and \(...\) (LaTeX display/inline), $$...$$ (display) or $...$ (inline).
# Only paired delimiters are treated as math, so a lone currency "$5" is left
# alone.
_MATH_RE = re.compile(r"\\\[(.+?)\\\]|\\\((.+?)\\\)|\$\$(.+?)\$\$|\$(.+?)\$")

# A run of CJK inside $...$ with no LaTeX command means the delimiters were
# prose punctuation (e.g. "价格 $5 与 $x$ 混合"), not a formula. Spans that do
# carry a command are real math even when they contain CJK, as in
# $\text{格局} = \sum_i \log |\Omega_i|$. Display math ($$...$$) is explicit
# and always converted.
_CJK_RE = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")


def _rich(s):
    """XML-escape a field and typeset any $...$ LaTeX inside it."""
    text = _esc(s)

    def repl(m):
        # Groups: 1 = \[...\], 2 = \(...\), 3 = $$...$$, 4 = $...$
        if m.group(1) is not None:      # display math, always convert
            return _render_math(m.group(1))
        if m.group(3) is not None:      # display math, always convert
            return _render_math(m.group(3))
        tex = m.group(2) if m.group(2) is not None else m.group(4)
        if tex is not None and "\\" not in tex and _CJK_RE.search(tex):
            return m.group(0)  # prose/currency, not math: keep as written
        return _render_math(tex or "")

    return _MATH_RE.sub(repl, text)


def _clean_for_anki(s):
    # Anki fields must not contain tabs/newlines that break the format; replace them.
    return re.sub(r"[\r\n\t]+", " ", str(s or "")).strip()


def build_pdf(lesson, quiz):
    """Return PDF bytes for a lesson's key points + quiz."""
    font = _pdf_font_name()
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("TitleX", parent=styles["Title"], fontName=font, fontSize=18, spaceAfter=10)
    h2 = ParagraphStyle("H2", parent=styles["Heading2"], fontName=font, fontSize=13, spaceBefore=12, spaceAfter=6)
    body = ParagraphStyle("Body", parent=styles["BodyText"], fontName=font, fontSize=9.5, leading=13, spaceAfter=4)
    qstyle = ParagraphStyle("Q", parent=styles["BodyText"], fontName=font, fontSize=9.5, leading=13, spaceBefore=8)
    small = ParagraphStyle("Small", parent=styles["BodyText"], fontName=font, fontSize=8.5, leading=11, textColor=colors.HexColor("#555555"))

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4,
                            leftMargin=18*mm, rightMargin=18*mm,
                            topMargin=16*mm, bottomMargin=16*mm,
                            title=lesson.get("title", "Lesson"))
    story = [Paragraph(_rich(lesson.get("title") or "Lesson"), title_style)]

    # ---- Key points ----
    points = lesson.get("points") or []
    if points:
        story.append(Paragraph("Key Points", h2))
        for i, p in enumerate(points, 1):
            title = _rich(p.get("title") or "")
            imp = p.get("importance") or "medium"
            badge = {"high": "HIGH", "low": "LOW", "medium": "MEDIUM"}.get(imp, "MEDIUM")
            marker = "[%d] %s" % (i, title)
            if imp == "high":
                marker += "  (" + badge + ")"
            story.append(Paragraph(marker, qstyle))
            expl = _rich(p.get("explanation") or "")
            if expl:
                bullets = [l.strip() for l in expl.splitlines() if l.strip()]
                items = [ListItem(Paragraph(b, body)) for b in bullets]
                # Bullet glyphs come from Helvetica: the CJK face has no U+2022.
                story.append(ListFlowable(items, bulletType="bullet", start="•",
                                          leftIndent=12, bulletFontName="Helvetica"))
            if p.get("mnemonic"):
                story.append(Paragraph("<i>Mnemonic:</i> " + _rich(p.get("mnemonic")), small))
    else:
        story.append(Paragraph("No key points generated yet.", body))

    # ---- Quiz ----
    story.append(Paragraph("Quiz", h2))
    questions = []
    if quiz and isinstance(quiz.get("questions"), list):
        questions = quiz["questions"]
    if questions:
        for i, q in enumerate(questions, 1):
            qtext = _rich(q.get("question") or "")
            story.append(Paragraph("Q%d. %s" % (i, qtext), qstyle))
            opts = q.get("options") or []
            for j, o in enumerate(opts):
                letter = chr(65 + j)
                right = " ✓" if j == q.get("answer") else ""
                story.append(Paragraph("%s) %s%s" % (letter, _rich(o), right), body))
            expl = _rich(q.get("explanation") or "")
            if expl:
                story.append(Paragraph("<font color='#16a34a'><b>Answer:</b></font> %s" % expl, small))
    else:
        story.append(Paragraph("No quiz generated yet.", body))

    doc.build(story)
    return buf.getvalue()


def _match_card_figure(lesson, card):
    """Pick a figure relevant to a flashcard, mirroring the card's concept onto a
    knowledge point -> its slide -> a non-logo/non-page image. Returns
    (image_bytes, filename) or None."""
    import base64, re
    def words(s):
        return set(re.findall(r"[a-z0-9]{3,}", (s or "").lower()))
    text = words(card.get("front")) | words(card.get("back"))
    if not text:
        return None
    best, best_score = None, 0
    for p in (lesson.get("points") or []):
        score = len(text & words(p.get("title")))
        if score > best_score:
            best, best_score = p, score
    if not best or best_score < 2:
        return None
    slide_idx = str(best.get("slide"))
    slide = next((s for s in (lesson.get("slides") or []) if str(s.get("index")) == slide_idx), None)
    if not slide:
        return None
    im = next((i for i in slide.get("images") or [] if isinstance(i, dict) and i.get("dataUrl") and i.get("kind") not in ("page", "logo")), None)
    if not im:
        return None
    try:
        raw = base64.b64decode(im["dataUrl"].split(",", 1)[1])
    except Exception:
        return None
    mime = im.get("mime") or "image/jpeg"
    ext = mime.split("/")[-1].split("+")[0].replace("jpeg", "jpg")
    fname = "fig_%s_%s.%s" % (slide_idx, (best.get("title") or "fig").replace(" ", "_")[:24].replace("/", ""), ext)
    return raw, fname


def build_apkg(lesson, cards):
    """Return .apkg bytes from lesson flashcards, embedding a relevant figure on
    each card (so the deck shows the associated diagram/image)."""
    deck_id = abs(hash(lesson.get("id") or "deck")) % (2**31 - 1)
    model_id = abs(hash(lesson.get("id") or "model")) % (2**31 - 1) + 1

    deck = genanki.Deck(deck_id, _clean_for_anki(lesson.get("title") or "Lesson"))
    model = genanki.Model(
        model_id,
        "MBBS Basic",
        fields=[
            {"name": "Front"},
            {"name": "Back"},
        ],
        templates=[
            {
                "name": "Card 1",
                "qfmt": "{{Front}}",
                "afmt": '{{FrontSide}}<hr id="answer">{{Back}}',
            },
        ],
    )
    media_paths = []
    media_tmpdir = tempfile.mkdtemp(prefix="mbbs_anki_")
    seen = set()
    for c in cards:
        front = _clean_for_anki(c.get("front"))
        back = _clean_for_anki(c.get("back"))
        if not front:
            continue
        fig = _match_card_figure(lesson, c)
        if fig:
            raw, fname = fig
            if fname not in seen:
                seen.add(fname)
                p = os.path.join(media_tmpdir, fname)
                with open(p, "wb") as fh:
                    fh.write(raw)
                media_paths.append(p)
            # Reference the image in Anki HTML (media file bundled in the .apkg).
            front = front + '<br><img src="%s">' % fname
        try:
            note = genanki.Note(model=model, fields=[front, back])
            deck.add_note(note)
        except Exception:
            continue

    if len(deck.notes) == 0:
        import shutil as _sh
        _sh.rmtree(media_tmpdir, ignore_errors=True)
        return None

    with tempfile.NamedTemporaryFile(suffix=".apkg", delete=False) as tmp:
        tmpname = tmp.name
    try:
        pkg = genanki.Package(deck)
        if media_paths:
            pkg.media_files = media_paths
        pkg.write_to_file(tmpname)
        with open(tmpname, "rb") as fh:
            return fh.read()
    finally:
        try:
            os.unlink(tmpname)
        except OSError:
            pass
        import shutil as _sh
        _sh.rmtree(media_tmpdir, ignore_errors=True)


def build_http(proxy=None, timeout=90):
    """Build an httplib2 Http that optionally uses an HTTP(S) proxy (e.g. http://127.0.0.1:7890)."""
    import httplib2
    proxy_info = None
    if proxy:
        raw = proxy if "://" in proxy else "http://" + proxy
        from urllib.parse import urlparse
        p = urlparse(raw)
        proxy_info = httplib2.ProxyInfo(
            httplib2.socks.PROXY_TYPE_HTTP,
            p.hostname or "127.0.0.1",
            p.port or 7890,
        )
    return httplib2.Http(proxy_info=proxy_info, timeout=timeout)


def upload_to_drive(pdf_bytes, filename, credentials_path, folder_id=None, proxy=None):
    """Upload PDF bytes to Google Drive using a service account. Returns dict."""
    if not credentials_path or not os.path.exists(credentials_path):
        return {"error": "Google service account not configured (data/google-service-account.json missing)."}
    credentials = service_account.Credentials.from_service_account_file(
        credentials_path, scopes=["https://www.googleapis.com/auth/drive.file"]
    )
    # google-api-python-client/httplib2 doesn't accept a custom proxy at the
    # same time as credentials, so route through the HTTPS_PROXY env var that
    # both httplib2 and requests (token refresh) read automatically.
    env_restore = {}
    if proxy:
        for k in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
            if k in os.environ:
                env_restore[k] = os.environ[k]
            os.environ[k] = proxy
    try:
        service = build("drive", "v3", credentials=credentials)
        body = {"name": filename, "mimeType": PDFMIME}
        if folder_id:
            body["parents"] = [folder_id]
        # Service accounts have no personal storage quota; they must upload to a
        # Shared Drive, which requires supportsAllDrives=True.
        media = MediaIoBaseUpload(io.BytesIO(pdf_bytes), mimetype=PDFMIME, resumable=True)
        res = (
            service.files()
            .create(body=body, media_body=media, fields="id,name,webViewLink", supportsAllDrives=True)
            .execute()
        )
        return {"ok": True, "file_id": res.get("id"), "link": res.get("webViewLink"), "name": res.get("name")}
    except Exception as exc:
        return {"error": str(exc)}
    finally:
        for k, v in env_restore.items():
            os.environ[k] = v
        if proxy:
            for k in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
                if k not in env_restore:
                    os.environ.pop(k, None)
