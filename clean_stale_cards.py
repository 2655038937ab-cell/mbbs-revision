#!/usr/bin/env python3
"""Remove flashcards (and old quiz banks) left behind when a lesson was regenerated.

The problem this exists for
---------------------------
Generating a study set APPENDS cards instead of replacing them, so re-generating a
lesson — or re-uploading it with different content — leaves the previous batch in
place. A student then opens the lesson and sees two lectures mixed together:

    生理学 第三节课  (the deck is upper-limb vessels)
      points  27 条   上肢动脉 / 掌浅弓 / 腋淋巴结 …
      cards   114 张  72 张上肢血管 + 42 张骨骼肌（肌小节、横桥、三联体…）
      quizzes 2 套    26 题的那套有 14 道骨骼肌题，30 题的那套全是血管题

Cards have no "latest" concept — the Flashcards tab shows every card of the lesson —
so the stale batch is visible and looks like the app made things up. (Quizzes are
less affected: the app reads the newest bank, so only the count is wrong.)

How a card is judged stale
--------------------------
It has to look like a different subject AND share almost no vocabulary with the
lesson's own knowledge points. Both conditions are required, so a card that merely
rephrases a point is kept. Extra muscle/electrophysiology terms can be added with
--extra-regex when another subject shows up.

Usage
    python3 clean_stale_cards.py --data-dir ./data-pku            # dry run
    python3 clean_stale_cards.py --data-dir ./data-pku --apply
    python3 clean_stale_cards.py --data-dir /srv/mbbs-data --min-overlap 0.2 --apply

Safety
    * dry run by default
    * every removed card and the removed quiz bank go to
      <data-dir>/stale-cards-<ts>.json, so they can be restored verbatim
    * the newest quiz bank of a lesson is never deleted
"""

import argparse
import json
import os
import re
import sqlite3
import sys
import time

# Terms that belong to a different subject than the lesson being examined. Kept
# narrow on purpose: "肌" alone would match 胸小肌/肱二头肌 in a vessel lesson.
MUSCLE = re.compile(
    r"肌小节|横桥|三联体|肌丝滑行|T-?tubule|横管|肌质网|钙火花|肌球蛋白|肌动蛋白|"
    r"原肌球蛋白|肌钙蛋白|ryanodine|sarcoplasmic|长度-张力|张力-速度|强直收缩|不应期",
    re.I,
)


def tokens(text):
    return {w for w in re.sub(r"[^\w\u4e00-\u9fff]+", " ", (text or "").lower()).split() if len(w) > 2}


def lesson_text(lesson):
    parts = []
    for p in lesson.get("points") or []:
        ex = p.get("explanation")
        parts.append(str(p.get("title") or ""))
        parts.append(ex if isinstance(ex, str) else "")
    return " ".join(parts)


def main():
    ap = argparse.ArgumentParser(description="Drop flashcards left over from an earlier generation.")
    ap.add_argument("--data-dir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))
    ap.add_argument("--lesson", help="只处理标题包含该子串的课程")
    ap.add_argument("--min-overlap", type=float, default=0.25,
                    help="与本科知识点的词交集低于此值才视为残留（默认 0.25）")
    ap.add_argument("--extra-regex", help="额外的“别的学科”特征词（正则）")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    db = os.path.join(args.data_dir, "data.db")
    if not os.path.isfile(db):
        sys.exit("no data.db in %s" % args.data_dir)
    foreign = MUSCLE
    if args.extra_regex:
        foreign = re.compile(MUSCLE.pattern + "|" + args.extra_regex, re.I)

    con = sqlite3.connect(db)
    con.row_factory = sqlite3.Row
    lessons = {r["id"]: json.loads(r["data"]) for r in con.execute("SELECT id, data FROM records WHERE store='lessons'")}
    cards = {}
    for r in con.execute("SELECT id, lesson_id, data FROM records WHERE store='cards'"):
        cards.setdefault(r["lesson_id"], []).append((r["id"], json.loads(r["data"])))
    quizzes = {}
    for r in con.execute("SELECT id, lesson_id, data FROM records WHERE store='quizzes'"):
        quizzes.setdefault(r["lesson_id"], []).append((r["id"], json.loads(r["data"])))

    print("数据目录: %s" % args.data_dir)
    print("课程 %d 门 / 闪卡 %d 张 / 题库 %d 套"
          % (len(lessons), sum(len(v) for v in cards.values()), sum(len(v) for v in quizzes.values())))

    removals = []
    total = 0
    for lid, lesson in lessons.items():
        title = lesson.get("title") or lid
        if args.lesson and args.lesson.lower() not in title.lower():
            continue
        hay = tokens(lesson_text(lesson))
        if not hay:
            continue
        stale = []
        for cid, card in cards.get(lid, []):
            text = (card.get("front") or "") + " " + (card.get("back") or "")
            body = tokens(text)
            overlap = len(body & hay) / max(1, len(body))
            if foreign.search(text) and overlap < args.min_overlap:
                stale.append((cid, card, round(overlap, 3)))
        old_quizzes = sorted(quizzes.get(lid, []), key=lambda q: q[1].get("createdAt") or 0)
        drop_quiz = old_quizzes[:-1] if len(old_quizzes) > 1 else []
        if not stale and not drop_quiz:
            continue
        print("\n★ %s" % title)
        print("   闪卡 %d 张 → 删 %d 张残留（与本科知识点词交集 <%.0f%%）"
              % (len(cards.get(lid, [])), len(stale), args.min_overlap * 100))
        for cid, card, ov in stale[:4]:
            print("      · %s (交集 %.2f)" % ((card.get("front") or "")[:56], ov))
        if drop_quiz:
            print("   题库 %d 套 → 保留最新，删 %d 套旧记录（%s）"
                  % (len(old_quizzes), len(drop_quiz),
                     ", ".join("%d 题" % len(q.get("questions") or []) for _, q in drop_quiz)))
        total += len(stale) + len(drop_quiz)
        removals.append({"lessonId": lid, "title": title,
                         "cards": [c for _, c, _ in stale],
                         "quizzes": [q for _, q in drop_quiz]})

    if not removals:
        print("\n没有发现残留 ✓")
        return
    print("\n合计将删除: %d 项" % total)
    if not args.apply:
        print("【干跑】未写入。确认后加 --apply 执行。")
        return

    stamp = time.strftime("%Y%m%d-%H%M%S")
    out = os.path.join(args.data_dir, "stale-cards-%s.json" % stamp)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump({"cleanedAt": int(time.time() * 1000), "removed": removals}, fh, ensure_ascii=False, indent=1)
    print("回滚记录: %s" % out)

    with con:
        for item in removals:
            for card in item["cards"]:
                con.execute("DELETE FROM records WHERE store='cards' AND id=?", (card.get("id"),))
            for quiz in item["quizzes"]:
                con.execute("DELETE FROM records WHERE store='quizzes' AND id=?", (quiz.get("id"),))
    left_cards = con.execute("SELECT COUNT(*) FROM records WHERE store='cards'").fetchone()[0]
    left_quizzes = con.execute("SELECT COUNT(*) FROM records WHERE store='quizzes'").fetchone()[0]
    print("已写入。现有闪卡 %d 张 / 题库 %d 套" % (left_cards, left_quizzes))
    con.close()
    print("完成。刷新页面即可看到。")


if __name__ == "__main__":
    main()
