#!/usr/bin/env python3
"""Clean junk out of the generated quiz banks.

Three kinds of defect, all found by auditing the real 258-lesson MBBS bank (250
quizzes / 20,349 questions) and all already banned by the generator prompt:

1. Stems that ask about the LECTURE instead of the subject — unanswerable unless
   you memorised how the slides were worded:
       Which of the following is a stated learning outcome for parasitic
       infections?
       Which textbook is the primary pathology reference for understanding IBD?
       According to the lecture outcomes, which of the following …?
   plus a few attribution items that slipped through:
       Who discovered X-rays, and when?
       In which year did the WHO declare tuberculosis a global emergency?
2. Options that collapse the question into a guess ("all of the above", "none of
   the above", "A and B are both true"). Where such an option is only a
   distractor it is deleted and the question survives with its answer remapped;
   where it IS the answer the question is deleted, because then nothing in the
   options is the fact under test.
3. The same stem appearing twice inside one quiz (21 such groups in the bank).

The patterns are READ OUT OF static/js/app.js (QUIZ_JUNK_STEM and
QUIZ_BANNED_OPTION) rather than copied here, so the generator's filter and this
cleanup can never drift apart: change them in the app and this script follows.

Usage
    python3 clean_quiz_bank.py                 # dry run, shows what it would change
    python3 clean_quiz_bank.py --apply         # rewrite (writes a backup first)
    python3 clean_quiz_bank.py --data-dir /path/to/data --apply
    python3 clean_quiz_bank.py --list          # print every match in full

Safety
    * dry run by default; nothing is written without --apply
    * a backup JSON of every removed question / removed option is written to
      <data-dir>/quiz-clean-<ts>.json before anything is touched
    * a quiz keeps the questions that survive; its userAnswers / attempts index
      arrays are remapped so stored answers stay aligned with what remains
    * a quiz left with no questions is deleted rather than left empty
    * the server caches list bodies ~6 s, so refresh or restart the instance after
"""

import argparse
import json
import os
import re
import sqlite3
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
APP_JS = os.path.join(HERE, "static", "js", "app.js")


def _strip_js_comments(src):
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"//[^\n]*", "", src)


def load_patterns(path=APP_JS):
    """Rebuild the app's junk-stem and banned-option patterns from its source."""
    try:
        src = _strip_js_comments(open(path, encoding="utf-8").read())
    except OSError as exc:
        sys.exit("cannot read %s: %s" % (path, exc))

    m = re.search(r"const QUIZ_JUNK_STEM = \[(.*?)\];", src, re.S)
    if not m:
        sys.exit("QUIZ_JUNK_STEM not found in %s — its shape changed, update this script" % path)
    # The literals are JavaScript strings; json.loads undoes the \\s / \" escapes.
    literals = re.findall(r'"((?:[^"\\]|\\.)*)"', m.group(1))
    if not literals:
        sys.exit("QUIZ_JUNK_STEM found but no patterns parsed out of it")
    stem = re.compile("|".join(json.loads('"' + lit + '"') for lit in literals), re.I | re.U)

    m2 = re.search(r"const QUIZ_BANNED_OPTION = /(.+?)/([a-z]*);", src, re.S)
    if not m2:
        sys.exit("QUIZ_BANNED_OPTION not found in %s — its shape changed, update this script" % path)
    flags = re.I if "i" in m2.group(2) else 0
    option = re.compile(m2.group(1), flags | re.U)
    return stem, option


def remap(values, keep):
    """Re-index a per-question array (or list of index arrays) onto kept questions."""
    def one(v):
        if isinstance(v, list):
            return [keep[i] for i in v if isinstance(i, int) and i in keep]
        return keep[v] if isinstance(v, int) and v in keep else None
    if isinstance(values, list):
        return [one(v) for i, v in enumerate(values) if i in keep]
    return values


def clean_quiz(rec, stem_pat, opt_pat):
    """Return (new_rec, log) where log describes what was dropped."""
    qs = rec.get("questions") or []
    log = {"junk_stem": [], "banned_answer": [], "banned_option": [], "duplicate": []}
    survivors = []          # (old_index, question) after dropping whole questions
    seen_stems = set()
    for i, q in enumerate(qs):
        q = q or {}
        text = str(q.get("question") or "")
        if stem_pat.search(text):
            log["junk_stem"].append(text)
            continue
        opts = [str(o) for o in (q.get("options") or [])]
        banned = [j for j, o in enumerate(opts) if opt_pat.search(o)]
        if banned:
            if q.get("answer") in banned:
                # The "all/none of the above" IS the answer: nothing in the options
                # states the fact being tested, so the question cannot be repaired.
                log["banned_answer"].append({"question": text, "options": opts})
                continue
            keep_opts = [j for j in range(len(opts)) if j not in banned]
            if len(keep_opts) < 2:
                log["banned_answer"].append({"question": text, "options": opts})
                continue
            new_q = dict(q)
            new_q["options"] = [opts[j] for j in keep_opts]
            new_q["answer"] = keep_opts.index(int(q.get("answer")))
            log["banned_option"].append({"question": text,
                                        "removed": [opts[j] for j in banned]})
            q = new_q
        key = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", " ", str(q.get("question") or "").lower()).strip()
        if key and key in seen_stems:
            log["duplicate"].append(str(q.get("question") or ""))
            continue
        seen_stems.add(key)
        survivors.append((i, q))

    removed = len(qs) - len(survivors)
    if not removed and not log["banned_option"]:
        return rec, None
    keep = {old: new for new, (old, _) in enumerate(survivors)}
    out = dict(rec)
    out["questions"] = [q for _, q in survivors]
    for field in ("userAnswers", "attempts", "quizAttempts"):
        if isinstance(rec.get(field), list) and rec[field]:
            out[field] = remap(rec[field], keep)
    return out, log


def describe(log):
    parts = []
    for key, label in (("junk_stem", "废题"), ("banned_answer", "选项作废"),
                       ("banned_option", "删选项"), ("duplicate", "重复")):
        n = len(log[key])
        if n:
            parts.append("%s %d" % (label, n))
    return "、".join(parts)


def main():
    ap = argparse.ArgumentParser(description="Clean junk questions out of the quiz banks.")
    ap.add_argument("--data-dir", default=os.path.join(HERE, "data"),
                    help="instance data directory holding data.db (default: ./data)")
    ap.add_argument("--apply", action="store_true", help="write the changes (default: dry run)")
    ap.add_argument("--list", action="store_true", help="print every match in full")
    args = ap.parse_args()

    db = os.path.join(args.data_dir, "data.db")
    if not os.path.isfile(db):
        sys.exit("no data.db in %s" % args.data_dir)
    stem_pat, opt_pat = load_patterns()

    con = sqlite3.connect(db)
    con.row_factory = sqlite3.Row
    rows = list(con.execute("SELECT id, data FROM records WHERE store='quizzes'"))
    total_q = 0
    plan, totals = [], {"junk_stem": 0, "banned_answer": 0, "banned_option": 0, "duplicate": 0}
    emptied = 0
    for r in rows:
        try:
            rec = json.loads(r["data"])
        except (TypeError, ValueError):
            continue
        total_q += len(rec.get("questions") or [])
        new, log = clean_quiz(rec, stem_pat, opt_pat)
        if not log:
            continue
        plan.append((r["id"], new, log))
        for k in totals:
            totals[k] += len(log[k])
        if not new["questions"]:
            emptied += 1
    dropped = totals["junk_stem"] + totals["banned_answer"] + totals["duplicate"]

    print("数据目录: %s" % args.data_dir)
    print("题库: %d 套 / %d 题" % (len(rows), total_q))
    print("待删题: %d（废题 %d、『以上都对』作答案 %d、同套重复 %d）" % (
        dropped, totals["junk_stem"], totals["banned_answer"], totals["duplicate"]))
    print("待删选项: %d 个（所属题目保留，答案序号重排）" % totals["banned_option"])
    print("涉及套数: %d%s" % (len(plan), "，其中 %d 套会被清空并删除" % emptied if emptied else ""))
    if not plan:
        print("无需改动 ✓")
        return

    for _, _, log in plan:
        print("  · " + describe(log))
    print()
    for key in ("junk_stem", "banned_answer", "duplicate"):
        for item in [x for _, _, lg in plan for x in lg[key]][:6]:
            text = item if isinstance(item, str) else item.get("question", "")
            print("  -", str(text)[:140].replace("\n", " "))
    for item in [x for _, _, lg in plan for x in lg["banned_option"]][:4]:
        print("  - 删选项 %s ← %s" % (json.dumps(item["removed"], ensure_ascii=False),
                                    item["question"][:90]))
    if args.list:
        print("\n完整清单:")
        for _, _, log in plan:
            for key in ("junk_stem", "banned_answer", "duplicate"):
                for item in log[key]:
                    text = item if isinstance(item, str) else item.get("question", "")
                    print("---", str(text)[:600])

    if not args.apply:
        print("\n【干跑】未写入任何改动。确认无误后加 --apply 执行。")
        return

    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = os.path.join(args.data_dir, "quiz-clean-%s.json" % stamp)
    with open(backup, "w", encoding="utf-8") as fh:
        json.dump({"cleanedAt": int(time.time() * 1000), "dataDir": args.data_dir,
                   "perQuiz": [{"id": qid, **log} for qid, _, log in plan]},
                  fh, ensure_ascii=False, indent=1)
    print("\n备份已写入: %s" % backup)

    for qid, new, _ in plan:
        if not new["questions"]:
            con.execute("DELETE FROM records WHERE store='quizzes' AND id=?", (qid,))
        else:
            con.execute("UPDATE records SET data=? WHERE store='quizzes' AND id=?",
                        (json.dumps(new, ensure_ascii=False), qid))
    con.commit()
    left = con.execute("SELECT COUNT(*) c FROM records WHERE store='quizzes'").fetchone()["c"]
    print("已写入：%d 套更新，%d 套删除；现有 %d 套" % (len(plan) - emptied, emptied, left))
    con.close()
    print("完成。服务端列表缓存约 6 秒，刷新页面即可看到；重启实例可立即生效。")


if __name__ == "__main__":
    main()
