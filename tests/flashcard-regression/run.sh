#!/usr/bin/env bash
# Flashcard regression — one command, prints PASS/FAIL for every check.
#
#   tests/flashcard-regression/run.sh
#
# Covers the three flashcard reports:
#   1. flipping showed BOTH faces at once (tab and 今日学习)
#   2. the SM-2 repeat interval looked inert in the 闪卡 tab
#   3. the deck order moved between visits, so "第 7 张" was a different card
#      after grading (store.py INSERT OR REPLACE gives the row a new rowid and
#      the list endpoint has no ORDER BY -> the graded card jumps to the end)
#
# The suite grades one real card and re-PUTs one card with its exact content to
# reproduce the server reorder; both are snapshotted first and restored
# afterwards with an md5 comparison (printed as RESTORED ✓ / MISMATCH ✗).
# It refuses a non-local BASE.
#
# Env overrides:
#   BASE       server to test          (default http://127.0.0.1:8757, must be local)
#   FC_LESSON  lesson id to browse     (default: the 89-card 生物化学 第一章)
#   DSH_NODE   node binary             (default: the bundled DSH node, else $PATH node)
#   PW_SRC     playwright node_modules (directory holding playwright/ + playwright-core/)
#   PW_CHROME  chromium executable     (default: the cached chrome-headless-shell)
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="${BASE:-http://127.0.0.1:8757}"
NODE_BIN="${DSH_NODE:-/Users/liangweilin/Documents/Codex/2026-08-14/ban/outputs/DeepSeek Harness.app/Contents/Resources/node}"
PW_SRC="${PW_SRC:-/Users/liangweilin/Documents/Codex/2026-08-14/ban/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules}"

case "$BASE" in
  http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*) ;;
  *) echo "refusing to run against $BASE: this suite grades a real card and re-PUTs one." >&2
     echo "point BASE at http://127.0.0.1:8757 (there is no online variant)." >&2
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

echo "flashcard regression · base=$BASE"
echo
out="$(BASE="$BASE" "$NODE_BIN" "$HERE/suite.mjs" 2>&1)"; status=$?
printf '%s\n' "$out"

PASSED=$(printf '%s' "$out" | grep -c '  PASS:')
FAILED=$(printf '%s' "$out" | grep -c '  FAIL:')
echo
echo "════════════════════════════════════════"
echo "PASS $PASSED · FAIL $FAILED"
if [ "$FAILED" -eq 0 ] && [ $status -eq 0 ]; then echo "RESULT: ALL PASS"; exit 0; fi
echo "RESULT: FAILURES ABOVE"; exit 1
