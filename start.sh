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

exec .venv/bin/python server.py
