# Formula regression suite (公式库 ↔ 课程同步)

One command:

```bash
tests/formula-regression/run.sh
```

It prints `PASS`/`FAIL` for every check and exits non-zero if anything failed.
Run it after touching the formula code in `static/js/app.js`
(`resolveFormulaSrc` / `formulasForLesson` / `buildFormulaIndex` /
`formulaBatchPlan` / `formulaCard` / `renderLessonFormulasTab`, the `?view=formulas`
library renderer) or the subject plumbing in `subjectForLesson`.

The suite verifies the behaviour that commit `3805489` ("Integrate the formula
library into each course; fix the sync between library and courses") introduced —
and that its author never left evidence for.

## What it covers

| # | check | what it asserts |
|---|---|---|
| 1 | `table.mjs` | every course: **课内公式数 == 库页该课公式数** (course tab card count vs the library's per-chapter `formula-chapter-count` sum), one row per course |
| 2 | `src-audit.mjs` | **independent** recomputation of the src tiers (exact-at-index → exact title → normalised → containment) vs the DOM: total cards, 📖 source buttons, buttons flagged `已按标题重新定位`, and the `📎 未归类` bucket must all agree. Unresolved formulas must be *shown* in 未归类 (with 原属 course), never dropped or pointed somewhere unrelated |
| 3 | `jump.mjs` | the "不能张冠李戴" half of #2: click N re-matched 📖 buttons and assert the course page really opens the point named on the button (`.kp-subtitle` text == button label) |
| 4 | `buttons.mjs` | every `点「X」` in a warning/subtitle has a real button `X` in that group (catches the old "↻ 升级重提取 does not exist" and "never-extracted group called a failed batch" wording) |
| 5 | `course-tab.mjs` | the course page has a `📐 公式 (N)` tab whose card count equals N, and a course with 0 formulas gets the `✨ 提取公式` entry plus an explanation |
| 6 | `no-rerun.mjs` | clicking 「＋ 补齐 N 批」 sends **exactly N** `POST /api/llm` requests (every request is intercepted and answered with an empty payload; every formulas write is short-circuited). Baseline before the fix: 14 requests for "14 批" |
| 7 | `no-rerun-fresh.mjs` | bump the subject doc's `generatedAt` (so all covered courses look freshly extracted) → the button becomes 「＋ 补齐 1 批（1 门课）」 and sends **exactly 1** request. Doc restored + md5 checked |
| 8 | `orphan.mjs` | inject a formula whose `src.lessonId` points at a deleted course → it renders in `__unfiled__` headed `📎 未归类` with an 原属 chip, no page errors; doc restored + md5 checked |
| 9 | `reclassify.mjs` | change a course's `subjectId` → its chapter appears **only** under the new subject and disappears from the old one (physiology 159→109 cards, biochemistry 39→89 in the recorded run); lesson restored + md5 checked |
| 10 | `mock-extract.mjs` | run a real extraction into an empty course with a canned `/api/llm` reply (zero token cost): the course tab and the library both show it with the same count, then the created doc is deleted and the whole formulas store md5 is verified |

## How it works

* Playwright with `serviceWorkers: "block"`, so the shell cache cannot serve stale JS.
* The checks are deliberately **independent** of the app's internals where it
  matters: check 1 counts DOM nodes in both views, check 2 recomputes the src
  tiers from the raw API payloads (lessons `?lite=1` + formulas) and then compares
  against the rendered DOM.
* Big lesson payloads are fetched with `curl` (`execFileSync`), not `fetch`:
  Node 24's undici intermittently asserts (`assert(!this.paused)`) when this
  server closes a large response.
* The write checks (#6–#10) snapshot the record they touch, restore it verbatim
  afterwards and compare the md5 with the same serialisation they started from —
  `RESTORED ✓` / `MISMATCH ✗` is printed either way.
* `#7` and `#10` intercept `POST /api/llm`, so the suite never spends tokens.

## Local-only constraint

Checks #6–#10 write real records. Each of those scripts calls `assertLocal()` and
refuses to start when `BASE` is not `http://127.0.0.1:*`, `localhost` or `[::1]`;
`run.sh` refuses the whole run for the same reason.

```bash
# from the repo root, with the local instance already running:
tests/formula-regression/run.sh

# read-only checks only (no data is written):
tests/formula-regression/run.sh --read-only
```

## Online

Production must only ever get the read-only smoke:

```bash
tests/formula-regression/run.sh --online          # BASE_ONLINE= to override the host
```

That runs `online-readonly.mjs`: it loads `?view=formulas`, reports the group and
card counts, the `未归类` bucket size, the 📖 button counts and any page errors,
and asserts nothing. It never clicks a write path. (The online data set is larger
than the local one — 311 formulas / 73 unfiled in the recorded run vs 241 / 43
locally — so only the *rules* are comparable, not the absolute numbers.)

## Requirements

* A local server on `http://127.0.0.1:8757` (`BASE=` to override; must stay local
  for the write checks).
* Node (defaults to the bundled DSH node; `DSH_NODE=` to override).
* Playwright's `playwright` + `playwright-core` packages (`PW_SRC=` to override);
  `run.sh` symlinks them into `tests/formula-regression/node_modules` because ESM
  resolves bare specifiers from the importing file's directory.
* A browser: the cached `chrome-headless-shell` is auto-detected, or set
  `PW_CHROME=/path/to/chrome`; without either, an installed Chrome is used.
