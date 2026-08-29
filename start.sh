#!/usr/bin/env bash
# Launch the MBBS Revision study app.
set -e
cd "$(dirname "$0")"

# Create venv if missing
if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
fi

# Install PyMuPDF (PDF support) on first run
.venv/bin/python -c "import fitz" 2>/dev/null || .venv/bin/pip install --quiet pymupdf

# The venv may contain arm64-only wheels (e.g. Pillow) while this shell runs
# under Rosetta (x86_64). Detect that and re-exec as native arm64 so the
# server actually starts. (Apple Silicon only; no-op elsewhere.)
if [ "$(uname -m)" = "x86_64" ] && /usr/bin/arch -arm64 /usr/bin/true 2>/dev/null; then
  if arch -arm64 .venv/bin/python -c "import server" 2>/dev/null; then
    exec arch -arm64 .venv/bin/python server.py
  fi
fi

exec .venv/bin/python server.py