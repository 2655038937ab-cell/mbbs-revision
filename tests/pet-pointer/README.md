# Desk-pet pointer regression (桌宠挡按钮)

One command:

```bash
tests/pet-pointer/run.sh            # after the fix — everything must pass
tests/pet-pointer/run.sh --before   # pre-fix CSS injected in-page — the failures ARE the bug
```

It prints `PASS`/`FAIL` per check and exits non-zero on any failure. In
`--before` mode it exits 0 only when the bug is actually reproduced (i.e. some
checks fail), so the reproduction cannot rot silently.

Run it after touching `#pet` / `#pet-timer` / `#pet img` / `#pet-pomo-btn`
pointer-events, the pet drag handlers or `initPet()` in `static/js/app.js`.

## The bug it pins down

The pet is a `position: fixed` 132px box in the bottom-right corner with the
study timer (`#pet-timer`) floating above it, and both used to take pointer
events over their whole rectangle. A card button underneath — a knowledge
point's `🖍 高亮术语` / `🗑 清除手动遮字`, or any right-edge control at the bottom
of the viewport — could not be clicked while the pet covered it; Playwright kept
reporting `"<div id=\"pet-timer\"> subtree intercepts pointer events"`.

The fix: `#pet` and `#pet-timer` are `pointer-events: none`, and only the pieces
that are actually interactive take events back — `#pet img` (the drag handle) and
`#pet-pomo-btn`. Hover moved from `#pet:hover img` to `#pet img:hover`, because a
container that takes no events can never be `:hover`.

## What it covers

| | |
|---|---|
| A | a probe button placed over the timer panel's dead space (the `📚 …m / …m` text band) receives a real click |
| A2 | the timer's own `🎯` button still owns its pixels (a probe there stays blocked — correct) |
| A3 | the artwork box stays the drag handle (blocked by design; informational) |
| B | a **real** app button (`🖍 高亮术语`) is dragged under the pet: `elementFromPoint` must return the button, and a **raw** `mouse.move/down/up` at those coordinates must change its label (`🖍 高亮术语` → `↩ 取消高亮`) |
| C | pet regressions: real-mouse drag moves the pet and persists `mbbs_pet_pos`, double-click changes the artwork, `🎯` opens the pomodoro modal, hide/restore works, no page errors |

## How `--before` works

`--before` injects `#pet{pointer-events:auto!important} #pet-timer{pointer-events:auto!important}`
into the live page with `addStyleTag` — the repo is never modified, and the same
script measures both states. Recorded pair:

| | `--before` (pre-fix CSS) | after |
|---|---|---|
| A probe over the timer text | `elementFromPoint → #pet-today-val`, click BLOCKED, 0 clicks | `→ #probe-timer-dead`, click ok, 1 click |
| B real `🖍` button under the pet | `elementFromPoint → #pet-today-val` (inside `#pet`); raw click left the label unchanged | `→ button.btn`; raw click changed the label to `↩ 取消高亮` |

## How it works

* Playwright with `serviceWorkers: "block"` so the shell cache cannot serve stale CSS/JS.
* The pet is dragged onto a real button with the **real mouse**
  (`mouse.move → down → move → up`), then hit-tested with `elementFromPoint` and
  clicked with a raw `mouse.down/up` — no Playwright actionability retries, so
  "the click landed on the pet" cannot be papered over.
* Only client-side controls are clicked: the `🖍 高亮术语` toggle. It never clicks
  `🌐 EN` (that would call the translation API and write the lesson).

## Local-only constraint

The check drives a real page with a real mouse and moves the pet around; there is
no online variant. `assertLocal()` and `run.sh` both refuse a `BASE` that is not
`http://127.0.0.1:*`, `localhost` or `[::1]`.

```bash
# from the repo root, with the local instance already running:
tests/pet-pointer/run.sh
tests/pet-pointer/run.sh --before     # reproduction, for contrast
```

## Requirements

* A local server on `http://127.0.0.1:8757` (`BASE=` to override; must stay local).
* Node (defaults to the bundled DSH node; `DSH_NODE=` to override).
* Playwright's `playwright` + `playwright-core` packages (`PW_SRC=` to override);
  `run.sh` symlinks them into `tests/pet-pointer/node_modules` because ESM
  resolves bare specifiers from the importing file's directory.
* A browser: the cached `chrome-headless-shell` is auto-detected, or set
  `PW_CHROME=/path/to/chrome`; without either, an installed Chrome is used.
