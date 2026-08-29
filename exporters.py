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


def _clean_for_anki(s):
    # Anki fields must not contain tabs/newlines that break the format; replace them.
    return re.sub(r"[\r\n\t]+", " ", str(s or "")).strip()


def build_pdf(lesson, quiz):
    """Return PDF bytes for a lesson's key points + quiz."""
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("TitleX", parent=styles["Title"], fontSize=18, spaceAfter=10)
    h2 = ParagraphStyle("H2", parent=styles["Heading2"], fontSize=13, spaceBefore=12, spaceAfter=6)
    body = ParagraphStyle("Body", parent=styles["BodyText"], fontSize=9.5, leading=13, spaceAfter=4)
    qstyle = ParagraphStyle("Q", parent=styles["BodyText"], fontSize=9.5, leading=13, spaceBefore=8)
    small = ParagraphStyle("Small", parent=styles["BodyText"], fontSize=8.5, leading=11, textColor=colors.HexColor("#555555"))

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4,
                            leftMargin=18*mm, rightMargin=18*mm,
                            topMargin=16*mm, bottomMargin=16*mm,
                            title=lesson.get("title", "Lesson"))
    story = [Paragraph(_esc(lesson.get("title") or "Lesson"), title_style)]

    # ---- Key points ----
    points = lesson.get("points") or []
    if points:
        story.append(Paragraph("Key Points", h2))
        for i, p in enumerate(points, 1):
            title = _esc(p.get("title") or "")
            imp = p.get("importance") or "medium"
            badge = {"high": "🔥 HIGH", "low": "LOW", "medium": "MEDIUM"}.get(imp, "MEDIUM")
            marker = "[%d] %s" % (i, title)
            if imp == "high":
                marker += "  (" + badge + ")"
            story.append(Paragraph(marker, qstyle))
            expl = _esc(p.get("explanation") or "")
            if expl:
                bullets = [l.strip() for l in expl.splitlines() if l.strip()]
                items = [ListItem(Paragraph(_esc(b), body)) for b in bullets]
                story.append(ListFlowable(items, bulletType="bullet", start="•", leftIndent=12))
            if p.get("mnemonic"):
                story.append(Paragraph("<i>🧠 Mnemonic:</i> " + _esc(p.get("mnemonic")), small))
    else:
        story.append(Paragraph("No key points generated yet.", body))

    # ---- Quiz ----
    story.append(Paragraph("Quiz", h2))
    questions = []
    if quiz and isinstance(quiz.get("questions"), list):
        questions = quiz["questions"]
    if questions:
        for i, q in enumerate(questions, 1):
            qtext = _esc(q.get("question") or "")
            story.append(Paragraph("Q%d. %s" % (i, qtext), qstyle))
            opts = q.get("options") or []
            for j, o in enumerate(opts):
                letter = chr(65 + j)
                right = " ✓" if j == q.get("answer") else ""
                story.append(Paragraph("%s) %s%s" % (letter, _esc(o), right), body))
            expl = _esc(q.get("explanation") or "")
            if expl:
                story.append(Paragraph("<font color='#16a34a'><b>Answer:</b></font> %s" % expl, small))
    else:
        story.append(Paragraph("No quiz generated yet.", body))

    doc.build(story)
    return buf.getvalue()


def build_apkg(lesson, cards):
    """Return .apkg bytes from lesson flashcards."""
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
    for c in cards:
        front = _clean_for_anki(c.get("front"))
        back = _clean_for_anki(c.get("back"))
        if not front:
            continue
        try:
            note = genanki.Note(model=model, fields=[front, back])
            deck.add_note(note)
        except Exception:
            continue

    if len(deck.notes) == 0:
        return None

    with tempfile.NamedTemporaryFile(suffix=".apkg", delete=False) as tmp:
        tmpname = tmp.name
    try:
        genanki.Package(deck).write_to_file(tmpname)
        with open(tmpname, "rb") as fh:
            return fh.read()
    finally:
        try:
            os.unlink(tmpname)
        except OSError:
            pass


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
