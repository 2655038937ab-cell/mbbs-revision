#!/usr/bin/env python3
"""Give formula-library entries their chapter back.

A formula records the knowledge point it was extracted from (`src`), and the library
groups entries by that point's lesson — the chapter. The model echoes the point
title, and the client used to look it up byte-for-byte, so a title that came back
with an added gloss, full-width brackets or a stray space lost its link: those
formulas then show up in the library with no chapter at all. The client now matches
on a normalised title, which prevents new losses; this repairs the ones already
stored, by matching each source-less formula against the knowledge points of the
lessons in its own subject.

Only writes with --apply (dry run by default), backs up first, and only attaches a
source when the match is unambiguous: at least MIN_HITS shared content terms, and
strictly ahead of the runner-up lesson. Everything else is reported and left alone.

  python3 reattribute_formulas.py --data-dir data-pku
  python3 reattribute_formulas.py --data-dir data-pku --apply
"""
import argparse
import datetime as dt
import json
import os
import re
import shutil
import sqlite3
import sys

MIN_HITS = 3          # shared content terms before a match is considered
MIN_MARGIN = 1        # how far ahead of the runner-up the winner must be
STOP = {
    "the", "and", "for", "with", "from", "that", "this", "公式", "方程", "关系", "定义",
    "计算", "应用", "条件", "单位", "的量", "相关", "之间", "以及", "一个", "可以", "不同",
}


def content_terms(text):
    """Comparable content terms from a title / explanation / formula body."""
    s = str(text or "")
    s = re.sub(r"\$[^$]*\$", " ", s)                 # LaTeX bodies carry no words
    s = re.sub(r"[^\w\u4e00-\u9fff]+", " ", s)
    out = set()
    for tok in s.split():
        tok = tok.lower()
        if len(tok) < 2 or tok in STOP or tok.isdigit():
            continue
        out.add(tok)
    # Chinese has no spaces: add character bigrams so "量子释放与微终板电位" can match
    for run in re.findall(r"[\u4e00-\u9fff]{2,}", s):
        for i in range(len(run) - 1):
            out.add(run[i:i + 2])
    return out


def subject_lessons(lessons, subjects, auto):
    """lesson id -> subject id, the same way the client decides it."""
    def by_id(sid):
        return next((s for s in subjects if s.get("id") == sid), None)

    out = {}
    for lid, lo in lessons.items():
        sid = lo.get("subjectId")
        if sid and by_id(sid):
            out[lid] = sid
            continue
        title = (lo.get("title") or "").lower()
        best, best_len = None, 0
        if auto and title:
            for s in subjects:
                for k in (s.get("keywords") or []):
                    k = str(k).strip().lower()
                    if k and k in title and len(k) > best_len:
                        best, best_len = s["id"], len(k)
        out[lid] = best or "general"
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    db_path = os.path.join(args.data_dir, "data.db")
    cfg_path = os.path.join(args.data_dir, "config.json")
    subjects, auto = [], True
    if os.path.exists(cfg_path):
        cfg = json.load(open(cfg_path, encoding="utf-8"))
        subjects = (cfg.get("study") or {}).get("subjects") or []
        auto = bool((cfg.get("study") or {}).get("auto_subject", True))

    db = sqlite3.connect(db_path)
    lessons = {}
    for lid, d in db.execute("SELECT id, data FROM records WHERE store='lessons'"):
        lessons[lid] = json.loads(d)
    subj_of = subject_lessons(lessons, subjects, auto)
    docs = list(db.execute("SELECT id, data FROM records WHERE store='formulas'"))
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = os.path.join(args.data_dir, f"data.db.bak-formulas-{stamp}")
    if args.apply:
        shutil.copy2(db_path, backup)
        print(f"备份已写: {backup}\n")

    total_fixed = total_left = 0
    for doc_id, data in docs:
        doc = json.loads(data)
        sid = doc.get("subjectId") or doc_id
        cand = []            # (lessonId, idx, pointTitle, terms)
        for lid, lo in lessons.items():
            if subj_of.get(lid) != sid:
                continue
            for idx, p in enumerate(lo.get("points") or []):
                t = (p.get("title") or "").strip()
                terms = content_terms(t) | content_terms(json.dumps(p.get("explanation"), ensure_ascii=False))
                if t:
                    cand.append((lid, idx, t, terms))
        orphans = [f for f in (doc.get("formulas") or []) if not ((f.get("src") or {}).get("lessonId"))]
        if not orphans or not cand:
            continue
        print(f"=== {doc.get('subjectName') or sid}：{len(orphans)} 条无来源，候选知识点 {len(cand)} 个 ===")
        changed = False
        for f in orphans:
            ft = content_terms(f.get("name")) | content_terms(f.get("usage")) | content_terms(f.get("symbols"))
            scores = {}
            best_point = {}
            for lid, idx, t, terms in cand:
                ov = len(ft & terms)
                if ov < MIN_HITS:
                    continue
                if ov > scores.get(lid, 0):
                    scores[lid] = ov
                    best_point[lid] = (idx, t)
            if not scores:
                total_left += 1
                print(f"  · 未匹配：{f.get('name','')[:44]}")
                continue
            ranked = sorted(scores.items(), key=lambda x: -x[1])
            best_lid, best_score = ranked[0]
            runner = ranked[1][1] if len(ranked) > 1 else 0
            if best_score - runner < MIN_MARGIN:
                total_left += 1
                print(f"  · 归属不明确（{best_score} vs {runner}）：{f.get('name','')[:44]}")
                continue
            idx, t = best_point[best_lid]
            title = lessons[best_lid].get("title") or ""
            print(f"  ✓ {f.get('name','')[:40]:42s} → 「{title[:22]}」/ {t[:26]}（命中 {best_score}）")
            f["src"] = {"lessonId": best_lid, "idx": idx, "title": t}
            changed = True
            total_fixed += 1
        if changed and args.apply:
            db.execute("UPDATE records SET data=? WHERE store='formulas' AND id=?",
                       (json.dumps(doc, ensure_ascii=False), doc_id))
    if args.apply:
        db.commit()
    print(f"\n{'已补回' if args.apply else '（试运行）可补回'} {total_fixed} 条，仍有 {total_left} 条无法确定")
    if not args.apply:
        print("加 --apply 才写入。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
