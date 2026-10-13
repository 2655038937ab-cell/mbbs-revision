# Flashcard regression suite (闪卡)

The 闪卡 tab also shows progress (已看 X / 共 Y, a bar, 🆕 没看过 / 🌱 学习中 / 🔁 今天到期 /
🌳 已成熟, a collapsible card checklist and the 只看没看过的 / 今天到期 / 全部
filters). 口径与进度页一致：看过 = `reps >= 1`，成熟 = `interval >= 21`；
今天到期 = `due <= now`（独立的排程标记，新卡天然到期，所以与「没看过」重叠）。

One command:

```bash
tests/flashcard-regression/run.sh
```

It prints `PASS`/`FAIL` per check and exits non-zero on any failure. Run it after
touching `renderCardsTab` / `flipReviewCard` / `schedule` / `previewIntervals` /
`fcPosKey` (the tab, the review card, the SM-2 scheduler, the saved position).

## What it covers

| | |
|---|---|
| A | **flip toggles, one face at a time** — click the card 4 times: question → answer → question → answer, exactly one visible face each time (it used to stay on the answer, and the 今日学习 card rendered the question *and* the answer together) |
| B | 今日学习 review card: flip shows the **answer only** (`elementFromPoint`-style face count = 1, no `.r-q`), clicking again returns to the question; only cards that are **due** are queued (1 项待复习 with one due + one future card, 2 项 with both due) |
| C | the deck order is **stable**: two entries return the first 10 card ids identically, and the order equals `createdAt`+`id` |
| D | **position memory by card id**: go to card 7, make the *server* reorder that card (`INSERT OR REPLACE` moves it to the end of the row order — PUTing its exact content reproduces it), re-enter → still card 7, same id |
| E | boundaries: an out-of-range `{i:9999,id:gone}` clamps to a real card; a legacy plain-number value is still honoured and upgraded with the id |
| F | SM-2 write path: grading "说得清楚" in the tab writes `interval`/`due`/`reps`/`ease` (0→1, reps 0→1, due in the future) |
| H | the four buttons' intervals equal an **independently recomputed** SM-2 table for a new / learning / mature card, and are strictly monotonic (Again < Hard < Good < Easy) with Good growing past Hard for non-new cards |
| I | **"完全忘了"** writes `interval 0`, `reps 0`, `due ≈ now` (the `<10m` on the button) and the card is re-queued by 今日学习 **8 queue positions later** (7 cards in between, `REQUEUE_GAP = 8`) |
| K | **进度数字 == 独立复算**: on a synthetic deck (2 new / 2 learning / 2 mature, 5 due) the page's 已看 / 没看过 / 学习中 / 今天到期 / 已成熟 all equal the recomputed counts, the bar is 已看/总数 (±1%), the checklist has one row per card, 「只看没看过的」 narrows to the new count and 「跳到第一张没看过的」 lands on the first `reps=0` card |
| J | the flashcard tab says out loud that an Again card comes back in 今日学习 (with a 🎯 entry point) and does **not** return within the browse view's next 10 cards |

## Why the position/or order checks exist

`store.py` stores records with `INSERT OR REPLACE` and the list endpoint has no
`ORDER BY`, so a graded card gets a new rowid and jumps to the **end** of the row
order. The tab used to render the server order, so "第 7 张" was a different card
after every grade, and the saved position (an index) pointed at nothing stable.

Two fixes are pinned here: the tab sorts the deck client-side (`createdAt`, then
`id`), and the saved position is `{ i, id }` — the id is looked up first, the
index is only the fallback.

## How it works

* Playwright with `serviceWorkers: "block"`.
* The 今日学习 queue is exercised with **route-intercepted** synthetic cards
  (`zz-*`), a neutered mistakes list and lessons whose points are never due, so
  the queue contains exactly the cards under test. Card PUTs are short-circuited
  in the handler, so those runs write nothing at all.
* The two checks that need real data (F, J) snapshot the card, grade it, restore
  it with a PUT and compare the md5 (`RESTORED ✓` / `MISMATCH ✗`).

## Local-only constraint

Checks F and J write a real card (and restore it). `assertLocal()` and `run.sh`
both refuse a `BASE` that is not `http://127.0.0.1:*`, `localhost` or `[::1]`;
there is no online variant of this suite.

```bash
# from the repo root, with the local instance already running:
tests/flashcard-regression/run.sh
FC_LESSON=<lessonId> tests/flashcard-regression/run.sh   # browse another course
```

## Requirements

* A local server on `http://127.0.0.1:8757` (`BASE=` to override; must stay local).
* Node (defaults to the bundled DSH node; `DSH_NODE=` to override).
* Playwright's `playwright` + `playwright-core` packages (`PW_SRC=` to override);
  `run.sh` symlinks them into `tests/flashcard-regression/node_modules` because
  ESM resolves bare specifiers from the importing file's directory.
* A browser: the cached `chrome-headless-shell` is auto-detected, or set
  `PW_CHROME=/path/to/chrome`; without either, an installed Chrome is used.
