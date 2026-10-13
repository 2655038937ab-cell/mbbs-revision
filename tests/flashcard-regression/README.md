# Flashcard regression suite (闪卡)

The 闪卡 tab also shows progress (已做 X / 共 Y, a bar, 🆕 没做过 / 🌱 学习中 / 🔁 今天到期 /
🌳 已成熟, a collapsible card checklist and the 只看没做过的 / 今天到期 / 全部
filters). 口径与进度页一致：做过 = `reps >= 1`，成熟 = `interval >= 21`；
今天到期 = `due <= now`（独立的排程标记，新卡天然到期，所以与「没做过」重叠）。

**顺序（用户口径）**：① 已做且到期的卡排最前，按到期时间——**最近到期的在前**、越久的越后；
② 没做过的卡跟在后面，按**讲义顺序**（课程 → 知识点/幻灯片，见 `cardPointIndex()` / `resolveCardSrc()`）；
③ 已做但还没到期的排最后，同样按讲义顺序。卡片的讲义位置在生成时由 `resolveCardSrc()` 写进
`src = { idx, slide, title }`（生成按 12 个知识点一批，模型回一个 `point` 字段指名来源，再在该批内匹配）；
老卡用同一套规则严格匹配（标题命中或若干术语），匹配不到的保持首次打开时的顺序
（记在 `mbbs_fc_order:<lessonId>`，服务端 INSERT OR REPLACE 造成的行序漂移不会打乱牌组）。
实测：合成牌组 [due oldest, due newest, due middle, unseen idx5, unseen idx1, seen-not-due]
渲染为 due newest → due middle → due oldest → unseen idx1 → unseen idx5 → seen-not-due。

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
