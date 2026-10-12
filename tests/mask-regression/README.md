# Mask regression suite (手动遮字)

One command:

```bash
tests/mask-regression/run.sh
```

It prints `PASS`/`FAIL` for each case and exits non-zero if anything failed. Run it
before touching any masking code (`static/js/app.js` `applyManualMasks` /
`selectionMaskIndex` / `refreshManualMasks`, `static/css/style.css` `.kp-manual-mask`,
`mark.hl`).

## What it covers

24 cases over the five paths that can break a manual mask:

| | |
|---|---|
| A | creating masks: 3 identical words in one paragraph (mask #1/#2/#3 separately), **deleting the first one and checking the remaining `n=1` still lands on the right occurrence**, selections across `**bold**`/`*italic*/`` `code` ``, across `.katex`, across two `<li>`, punctuation/EN/digits, empty and whitespace-only selections, a multi-line paragraph |
| B | display: block look, click-to-reveal/click-to-hide, `👁 一键显示 (N)` present after a reload + reveals everything + reload hides again, `🖍 高亮术语` keeps the term **readable**, `🔎 回忆` still blanks and the highlight toggle does not un-blank it |
| C | deleting: `×` on one of several identical masks removes only that one; `🗑 清除手动遮字` clears all and both buttons disappear (no stray `·` separator) |
| D | persistence: every lesson PUT is 200 (never 409), request body < 1 MB (also for a lesson carrying 6 MB of page images), mask survives a reload, `points` count and total `explanation` length unchanged |
| E | no interference: 🖍 ↔ manual masks, the 今日学习 card (mask applies, revealing there does not reveal it on the lesson page), 🌐 EN view carries no masks and comes back clean, Feynman/search/PDF export produce no JS errors |
| F | data edges: legacy `["片段"]` masks still work as `n=0` and get upgraded to `{t,n}` on the next save; masks whose text no longer exists are skipped without error, get a `⚠ N 处遮字已失效` hint and a one-click cleanup; mixed/out-of-order `n` values still land on the right occurrences |

## How it works

* Playwright Chromium, `serviceWorkers: "block"` so the shell cache cannot serve
  stale JS.
* Selections are made with a **real mouse** (`mouse.move → down → move → up`). A
  programmatic `Range` + `addRange` does not fire `mouseup`, so the floating
  `✍️ 遮住选中` button never appears — a programmatic selection would silently test
  nothing.
* Drag coordinates come from `getBoundingClientRect()` of the first/last character,
  after scrolling the point into view (the mouse cannot reach below the fold).
* Occurrence indices are counted in the point's **full** text, with masked spans
  contributing their original characters (`data-text`) — the same rule the app's own
  `maskSourceParts` uses.
* The desk pet (`#pet`, a fixed 132 px box in the bottom-right corner, `z-index: 60`)
  is hidden for the run: it swallows clicks aimed at right-edge buttons of a card at
  the bottom of the viewport. That overlap is an app-level issue, not a masking one.
* The suite creates its own throwaway lesson (`zz-mask-audit-*`, `feynmanDue = 1` so
  it heads the 今日学习 queue), deletes it at the end, and deletes any leftover
  `zz-*` throwaway at the start. It **refuses to run** against a non-local `BASE`
  because the fixture is a real write.

## Requirements

* A local server on `http://127.0.0.1:8757` (`BASE=` to override; must stay local).
* Node (defaults to the bundled DSH node; `DSH_NODE=` to override).
* Playwright's `playwright` + `playwright-core` packages (`PW_SRC=` to override) and
  a cached Chromium (`PW_CHROME=` to override).

```bash
# from the repo root, with the local instance already running:
BASE=http://127.0.0.1:8757 tests/mask-regression/run.sh
```

## Online

Never run this suite against production. For the online instance, use a read-only
smoke: load a lesson that already has masks, confirm the blocks and the
`👁 一键显示` / `🗑 清除手动遮字` buttons render and that a click on a block reveals
it, then reload and confirm it is hidden again.
