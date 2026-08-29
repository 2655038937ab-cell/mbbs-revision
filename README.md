# MBBS Revision — Active-Recall Study App

A private, self-hosted study companion for medical lectures. Upload a **PowerPoint (.pptx)**
or **PDF**, and it will:

1. **Parse** the file (slide/page text + figures + speaker notes).
2. **Distill key points** with AI (DeepSeek `deepseek-v4-pro`).
3. **Generate** active-recall flashcards and single-best-answer MCQ quizzes.
4. **Caption figures & diagrams** with a vision model (DeepSeek `deepseek-v4-flash-vision-exp` via the opencode proxy).
5. **Schedule reviews** with spaced  SM-2 for flashcards plus Feynman re-test intervals for key points, merged into one daily study queue with per-day new-card/new-point limits.
6. **Track mistakes** in a mistake notebook that re-tests you until mastered.
7. **Log study time & progress** (streaks, per-lesson mastery).

Everything is stored **on the server (SQLite)** and guarded by a **password**, so any
device you log in from sees the same lessons, cards, mistakes and progress.

## Run it (locally)

Prerequisites: **Python 3.9+** and **git** (or download the repo as a ZIP and extract it).

```bash
# 1. clone (or you downloaded the ZIP and opened the folder)
git clone <your-repo-url> mbbs-revision
cd mbbs-revision

# 2. run — it creates a local venv, installs PyMuPDF, and starts the server
./start.sh
```

Then open **http://127.0.0.1:8756** and log in. The default password is `mbbs1234` — change it immediately in **Settings → Account**.

> To set a password from the start: `PASSWORD='your-password' ./start.sh`
>
> On Linux/macOS make `start.sh` executable first: `chmod +x start.sh`

## First-time setup

After logging in, open **Settings** and paste your API key(s). This app talks to the
models through the **opencode** proxy (`opencode.ai/zen/go/v1`), so one opencode
API key covers both text and vision:

| Purpose | Provider | Base URL | Model |
|---|---|---|---|
| Text (notes/cards/quiz) | opencode 代理 | `https://opencode.ai/zen/go/v1` | `deepseek-v4-flash` |
| Vision (figures / OCR) | opencode 代理 | `https://opencode.ai/zen/go/v1` | `deepseek-v4-flash-vision-exp` |

- **Where to get the key**: create an account on **https://opencode.ai** and copy its
  API key. In the site's **Settings → Text model**, paste that key into the **API key**
  field. The Vision model reuses the same key (they share it), so you don't need a second one.

Keys are saved to `data/config.json` on the server, shared across your devices.

## Deploy to the internet (use from another computer)

See **[DEPLOY.md](DEPLOY.md)** — Railway, Docker on a VPS, or Render.
You'll set a `PASSWORD` env var and mount the `data/` directory as persistent storage.

## Requirements

- Python 3.9+
- PyMuPDF (auto-installed into a local `.venv` on first run; `requirements.txt` for Docker)

## File layout

- `server.py` — HTTP server: static files + auth + SQLite REST API + parse + AI proxy.
- `store.py` — SQLite record store (server-side persistence).
- `ppt_parser.py` — pure-stdlib PPTX parser (text, images, notes).
- `pdf_parser.py` — PDF parser (PyMuPDF): text + rendered page images.
- `static/` — the single-page frontend (vanilla JS, no build step).
- `data/` — `config.json` (keys + password) and `data.db` (all your data). **Back this up.**
- `Dockerfile`, `DEPLOY.md` — cloud deployment.

## Notes

- Old binary **.ppt** files aren't supported — open in PowerPoint/Keynote and "Save As .pptx".
- **Scanned / image-only PDFs** are auto-detected: pages with no text layer are read by the
  vision model (OCR) during "Generate study set", so they still produce notes and questions.
- PDFs with a real text layer use the embedded text directly (faster, no extra AI calls).
