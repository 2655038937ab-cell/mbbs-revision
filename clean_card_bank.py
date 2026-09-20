#!/usr/bin/env python3
"""Clean junk out of the generated flashcard decks.

Audit of the real 258-lesson MBBS deck (13,080 cards) found:

1. Cards that test the lecture instead of the subject — unanswerable without
   memorising how the slides were worded:
       What are the learning outcomes for gout and osteoporosis drug therapy?
       What are the learning outcomes of the lecture on illness cognition?
2. Attribution cards — names and dates rather than content:
       Who won the Nobel Prize in Physiology or Medicine 1996 and for what?
       Who defined the role of the lymphocyte in immunity, and in what year?
3. Exact duplicates inside one lesson: the same front AND the same back stored
   twice (137 groups), so the same card is reviewed twice with two schedules.
   The copy with review history is kept, otherwise the oldest.

The patterns come from static/js/app.js (QUIZ_JUNK_STEM) via clean_quiz_bank, so
the generator, the quiz cleaner and this script always agree.

NOT removed, only reported:
  * the same front with a DIFFERENT back (179 groups). Those answers are usually
    complementary rather than contradictory, and dropping one silently loses
    content — regenerate that lesson's cards instead if it bothers you.
  * backs over 600 characters, picture-dependent fronts, slide references.

Usage
    python3 clean_card_bank.py                 # dry run
    python3 clean_card_bank.py --apply         # rewrite (backup written first)
    python3 clean_card_bank.py --data-dir ./data-pku --apply
    python3 clean_card_bank.py --list          # print every match

The server caches list bodies for ~6 s, so refresh a page after applying.
"""

import argparse
import collections
import json
import os
import re
import sqlite3
import sys
import time

from clean_quiz_bank import load_patterns

HERE = os.path.dirname(os.path.abspath(__file__))
SLIDE_REF = re.compile(r"\b(this|the|above|following)\s+(slide|figure|image|diagram|table)\b"
                       r"|\bslide\s+\d+\b|如上图|下图|上图|幻灯片", re.I)


def norm(s):
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", " ", (s or "").lower()).strip()


def pick_keeper(group):
    """Which copy of a duplicated card to keep: the one with review history."""
    def rank(c):
        reviewed = 1 if c.get("lastReviewed") else 0
        return (reviewed, int(c.get("reps") or 0), -int(c.get("createdAt") or 0))
    return sorted(group, key=rank, reverse=True)[0]


def main():
    ap = argparse.ArgumentParser(description="Clean junk and duplicates out of the card decks.")
    ap.add_argument("--data-dir", default=os.path.join(HERE, "data"))
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    db = os.path.join(args.data_dir, "data.db")
    if not os.path.isfile(db):
        sys.exit("no data.db in %s" % args.data_dir)
    junk, _banned_option = load_patterns()

    con = sqlite3.connect(db)
    con.row_factory = sqlite3.Row
    rows = [(r["id"], json.loads(r["data"]))
            for r in con.execute("SELECT id, data FROM records WHERE store='cards'")]
    print("数据目录: %s" % args.data_dir)
    print("卡片: %d 张 / %d 门课程" % (
        len(rows), len({c.get("lessonId") for _, c in rows if c.get("lessonId")})))

    doomed = {}          # record id -> reason
    for rid, c in rows:
        if junk.search(c.get("front") or ""):
            doomed[rid] = "junk_stem"

    by_key = collections.defaultdict(list)
    for rid, c in rows:
        if rid in doomed:
            continue
        by_key[(c.get("lessonId"), norm(c.get("front")), norm(c.get("back")))].append((rid, c))
    dup_groups = 0
    for key, group in by_key.items():
        if len(group) < 2:
            continue
        dup_groups += 1
        keep = pick_keeper([c for _, c in group])
        for rid, c in group:
            if c is not keep:
                doomed[rid] = "duplicate"

    # Report-only findings
    same_front = collections.defaultdict(set)
    for rid, c in rows:
        if rid in doomed:
            continue
        same_front[(c.get("lessonId"), norm(c.get("front")))].add(norm(c.get("back")))
    differing = sum(1 for v in same_front.values() if len(v) > 1)
    long_back = [c for rid, c in rows if rid not in doomed and len(c.get("back") or "") > 600]
    slide_ref = [c for rid, c in rows if rid not in doomed
                 and SLIDE_REF.search((c.get("front") or "") + " " + (c.get("back") or ""))]

    reasons = collections.Counter(doomed.values())
    print("待删: %d 张（讲自己/归因 %d，完全重复 %d，去重覆盖 %d 组）"
          % (len(doomed), reasons["junk_stem"], reasons["duplicate"], dup_groups))
    for rid, c in [(r, c) for r, c in rows if r in doomed][:8]:
        print("   - [%s] %s" % (doomed[rid], (c.get("front") or "")[:120]))
    if args.list:
        print("\n完整清单:")
        for rid, c in rows:
            if rid in doomed:
                print("--- [%s] %s" % (doomed[rid], c.get("front")))
    print()
    print("仅报告、不删除：")
    print("  · 同一问题不同答案 %d 组（内容互补，删掉会丢信息）" % differing)
    print("  · 背面超过 600 字符 %d 张（背不下来，建议重新生成该课）" % len(long_back))
    print("  · 提到幻灯片/图 %d 张（其中问“图里画了什么”的才真的无法回答）" % len(slide_ref))
    if not doomed:
        print("\n无需改动 ✓")
        return

    if not args.apply:
        print("\n【干跑】未写入任何改动。确认无误后加 --apply 执行。")
        return

    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = os.path.join(args.data_dir, "cards-clean-%s.json" % stamp)
    with open(backup, "w", encoding="utf-8") as fh:
        json.dump({"cleanedAt": int(time.time() * 1000), "dataDir": args.data_dir,
                   "removed": [{"reason": doomed[rid], "card": c} for rid, c in rows if rid in doomed]},
                  fh, ensure_ascii=False, indent=1)
    print("\n备份已写入: %s（%d 张，可整条还原）" % (backup, len(doomed)))
    for rid in doomed:
        con.execute("DELETE FROM records WHERE store='cards' AND id=?", (rid,))
    con.commit()
    left = con.execute("SELECT COUNT(*) c FROM records WHERE store='cards'").fetchone()["c"]
    print("已删除 %d 张，现有 %d 张" % (len(doomed), left))
    con.close()
    print("完成。刷新页面即可看到（服务端列表缓存约 6 秒）。")


if __name__ == "__main__":
    main()
