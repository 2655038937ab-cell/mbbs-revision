#!/usr/bin/env bash
# Formula regression suite — one command, prints PASS/FAIL for every check.
#
#   tests/formula-regression/run.sh              # all checks (local server)
#   tests/formula-regression/run.sh --read-only  # skip the checks that write data
#   tests/formula-regression/run.sh --online     # read-only smoke against production
#
# The suite verifies the formula library <-> course sync that 3805489 introduced:
# per-course counts, the 「补齐」 button only re-running missing batches, src
# re-resolution / 「未归类」, copy-vs-button consistency, grouping following the
# course, and the in-course 「📐 公式」 tab.
#
# Every check that writes real data first calls assertLocal(): the write group
# PUTs a formulas doc or a lesson's subjectId and restores it, verifying the md5
# afterwards. Production must only ever get the read-only smoke.
#
# Env overrides:
#   BASE       server to test          (default http://127.0.0.1:8757; must be local for the write group)
#   DSH_NODE   node binary             (default: the bundled DSH node, else $PATH node)
#   PW_SRC     playwright node_modules (directory holding playwright/ + playwright-core/)
#   PW_CHROME  chromium executable     (default: the cached chrome-headless-shell)
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="${BASE:-http://127.0.0.1:8757}"
NODE_BIN="${DSH_NODE:-/Users/liangweilin/Documents/Codex/2026-08-14/ban/outputs/DeepSeek Harness.app/Contents/Resources/node}"
PW_SRC="${PW_SRC:-/Users/liangweilin/Documents/Codex/2026-08-14/ban/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules}"

MODE=all
for a in "$@"; do
  case "$a" in
    --read-only) MODE=readonly ;;
    --online)    MODE=online ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

if [ "$MODE" = online ]; then
  BASE="${BASE_ONLINE:-https://43-133-79-77.sslip.io}"
  echo "formula regression · ONLINE READ-ONLY smoke · base=$BASE"
  echo
  BASE="$BASE" "$NODE_BIN" "$HERE/online-readonly.mjs"
  status=$?
  echo
  [ $status -eq 0 ] && echo "RESULT: PASS" || echo "RESULT: FAILURES ABOVE"
  exit $status
fi

case "$BASE" in
  http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*) ;;
  *) echo "refusing to run against $BASE: the write checks PUT real records (and restore them)." >&2
     echo "use BASE=http://127.0.0.1:8757, or run with --online for the read-only smoke." >&2
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

FAILED=0
SKIPPED=0
PASSED=0

# A check fails when it exits non-zero or prints one of the explicit failure
# markers; "NO incremental button" is a legitimate skip (nothing to measure).
run_check() {
  local name="$1" file="$2"
  echo "────────── $name ($file) ──────────"
  local out status
  out="$(BASE="$BASE" "$NODE_BIN" "$HERE/$file" 2>&1)"; status=$?
  printf '%s\n' "$out"
  if printf '%s' "$out" | grep -q 'NO incremental button found'; then
    SKIPPED=$((SKIPPED + 1)); echo "── $name: SKIP"; echo
    return
  fi
  if [ $status -ne 0 ] || printf '%s' "$out" | grep -Eq 'FAIL|✗|MISMATCH|PAGEERROR|FATAL|不一致行: [1-9]|不一致: [1-9]|错位 [1-9]|NO  ←'; then
    FAILED=$((FAILED + 1)); echo "── $name: FAIL"
  else
    PASSED=$((PASSED + 1)); echo "── $name: PASS"
  fi
  echo
}

echo "formula regression · base=$BASE · mode=$MODE"
echo

# Read-only checks (safe anywhere, but this runner keeps them local).
run_check "1. per-course counts (课内 == 库页)"        table.mjs
run_check "2. src resolution / 未归类 (independent)"  src-audit.mjs
run_check "3. re-matched 📖 buttons land correctly"   jump.mjs
run_check "4. copy vs buttons"                        buttons.mjs
run_check "5. in-course 📐 公式 tab"                  course-tab.mjs

if [ "$MODE" = all ]; then
  # Write checks: each restores what it touches and verifies the md5.
  run_check "6. 补齐 only runs missing batches"       no-rerun.mjs
  run_check "7. 补齐 after a fresh doc (expect 1)"    no-rerun-fresh.mjs
  run_check "8. orphan formula -> 未归类"             orphan.mjs
  run_check "9. grouping follows the course"          reclassify.mjs
  run_check "10. extract into an empty course"        mock-extract.mjs
fi

echo "════════════════════════════════════════"
echo "PASS $PASSED · FAIL $FAILED · SKIP $SKIPPED"
if [ $FAILED -eq 0 ]; then echo "RESULT: ALL PASS"; else echo "RESULT: FAILURES ABOVE"; fi
exit $((FAILED > 0 ? 1 : 0))
