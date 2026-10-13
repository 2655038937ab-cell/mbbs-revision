#!/usr/bin/env bash
# Desk-pet pointer regression — one command, prints PASS/FAIL for every check.
#
#   tests/pet-pointer/run.sh            # after the fix: everything must pass
#   tests/pet-pointer/run.sh --before   # pre-fix CSS injected in-page: the checks
#                                       # that fail ARE the reproduced bug
#
# What it checks: the pet (#pet, a fixed 132px box bottom-right, with the study
# timer floating above it) must only take pointer events on the pieces that are
# actually interactive. Everything behind it — a card's right-edge button at the
# bottom of the viewport — must stay clickable, while the pet itself keeps
# dragging, double-click-to-change-art, its 🎯 timer button and hide/restore.
#
# The check drags the pet around a real page but writes no server data (it only
# touches client-side buttons: the 🖍 highlight toggle, never 🌐 EN, which would
# call the translation API). It still refuses a non-local BASE.
#
# Env overrides:
#   BASE       server to test          (default http://127.0.0.1:8757, must be local)
#   DSH_NODE   node binary             (default: the bundled DSH node, else $PATH node)
#   PW_SRC     playwright node_modules (directory holding playwright/ + playwright-core/)
#   PW_CHROME  chromium executable     (default: the cached chrome-headless-shell)
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="${BASE:-http://127.0.0.1:8757}"
NODE_BIN="${DSH_NODE:-/Users/liangweilin/Documents/Codex/2026-08-14/ban/outputs/DeepSeek Harness.app/Contents/Resources/node}"
PW_SRC="${PW_SRC:-/Users/liangweilin/Documents/Codex/2026-08-14/ban/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules}"
MODE=after
for a in "$@"; do
  case "$a" in
    --before) MODE=before ;;
    --after)  MODE=after ;;
    *) echo "unknown option: $a (use --before or --after)" >&2; exit 2 ;;
  esac
done

case "$BASE" in
  http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*) ;;
  *) echo "refusing to run against $BASE: this check drives a real page with a real mouse." >&2
     echo "point BASE at http://127.0.0.1:8757 (there is no online variant of this check)." >&2
     exit 2 ;;
esac

[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node || true)"
if [ -z "${NODE_BIN:-}" ] || [ ! -x "$NODE_BIN" ]; then
  echo "no node binary found; set DSH_NODE=/path/to/node" >&2; exit 2
fi

if ! curl -sf -o /dev/null "$BASE/api/health"; then
  echo "no server at $BASE — start the local instance first (see README.md)" >&2
  exit 2
fi

if [ ! -d "$PW_SRC/playwright" ]; then
  echo "playwright not found at $PW_SRC; set PW_SRC to a node_modules dir holding playwright/" >&2
  exit 2
fi

# ESM resolves bare specifiers from the importing file's directory, and NODE_PATH
# does not apply to `import` — so the package has to sit next to the scripts.
mkdir -p "$HERE/node_modules"
for d in "$PW_SRC"/*; do
  [ -e "$d" ] || continue
  ln -sfn "$d" "$HERE/node_modules/$(basename "$d")"
done

if [ -z "${PW_CHROME:-}" ]; then
  for c in "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-*/chrome-headless-shell \
           "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux*/chrome-headless-shell; do
    [ -x "$c" ] && PW_CHROME="$c" && break
  done
fi
export PW_CHROME

echo "pet pointer regression · base=$BASE · mode=$MODE"
echo
out="$(BASE="$BASE" "$NODE_BIN" "$HERE/pet-pointer.mjs" "--$MODE" 2>&1)"; status=$?
printf '%s\n' "$out"

PASSED=$(printf '%s' "$out" | grep -c '  PASS:')
FAILED=$(printf '%s' "$out" | grep -c '  FAIL:')
echo
echo "════════════════════════════════════════"
echo "PASS $PASSED · FAIL $FAILED"
if [ "$MODE" = before ]; then
  # In --before mode the failures are the point: the pre-fix CSS must be caught.
  if [ "$FAILED" -gt 0 ]; then echo "RESULT: bug reproduced (expected in --before mode)"; else echo "RESULT: NOT REPRODUCED — the pre-fix CSS was not caught ✗"; exit 1; fi
  exit 0
fi
if [ "$FAILED" -eq 0 ] && [ $status -eq 0 ]; then echo "RESULT: ALL PASS"; exit 0; fi
echo "RESULT: FAILURES ABOVE"; exit 1
