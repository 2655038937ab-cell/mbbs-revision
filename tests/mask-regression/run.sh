#!/usr/bin/env bash
# Mask regression suite — one command, prints PASS/FAIL for every case.
#
#   tests/mask-regression/run.sh
#
# What it does: creates a throwaway lesson on a LOCAL server, drives the real page
# with a real mouse (Playwright, serviceWorkers blocked, mouse.move/down/move/up —
# a programmatic Range+addRange does NOT fire mouseup, so the floating "✍️ 遮住选中"
# button would never appear), checks all 24 masking cases, then deletes the lesson.
#
# It refuses to run against anything that is not localhost: the fixture is a real
# write, and the online instance must only ever get a read-only smoke test.
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

case "$BASE" in
  http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*) ;;
  *) echo "refusing to run against $BASE: this suite creates and deletes a fixture lesson." >&2
     echo "set BASE to a local server (see README.md for the read-only online smoke)." >&2
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

echo "mask regression · base=$BASE"
echo
BASE="$BASE" "$NODE_BIN" "$HERE/suite.mjs"
status=$?
echo
if [ $status -eq 0 ]; then echo "RESULT: ALL PASS"; else echo "RESULT: FAILURES ABOVE"; fi
exit $status
