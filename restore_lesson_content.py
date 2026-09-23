#!/usr/bin/env python3
"""Restore lesson content that a list-only record overwrote.

The lessons list is slimmed server-side (no figure captions, no outline, no notes,
no point keyTerms/supplements, and with ?lite=1 no point explanations and no slide
text). Two folder actions in the lessons list saved such a slim record straight
back, which replaced the full lesson. This tool puts the missing content back from
a database that still has it — normally the machine that produced the lesson.

Two modes, both dry-run unless --apply is given:

  # 1) on a good database: write a content map (title-indexed, field-level)
  python3 restore_lesson_content.py --export --data-dir data-pku --out /tmp/map.json

  # 2) on the damaged database: fill in only what is missing
  python3 restore_lesson_content.py --restore --data-dir data-pku --map /tmp/map.json --apply

Restoring is additive: a field that already has a value is never overwritten, so
edits made after the damage survive. Lessons are matched by title, points by title
(with the slide number as a tie-breaker), slides by index, images by name.
"""
import os as _os
import sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from db_backup import backup_database  # noqa: E402

import argparse
import datetime as dt
import json
import os

import sqlite3
import sys


def read_lessons(db_path):
    db = sqlite3.connect(db_path)
    out = {}
    for lid, data in db.execute("SELECT id, data FROM records WHERE store='lessons'"):
        try:
            out[lid] = json.loads(data)
        except Exception:
            continue
    return out


def build_map(lessons):
    """Title-indexed content map: only the fields the slimming drops."""
    m = {}
    for lesson in lessons.values():
        pts = {}
        for p in lesson.get("points") or []:
            t = (p.get("title") or "").strip()
            if not t:
                continue
            pts[f"{t}\u0000{p.get('slide')}"] = {
                k: p[k] for k in ("explanation", "supplement", "keyTerms", "category",
                                 "importance", "tags", "mnemonic")
                if p.get(k)
            }
        slides = {}
        for s in lesson.get("slides") or []:
            slides[str(s.get("index"))] = {
                "text": s.get("text") or "",
                "notes": s.get("notes") or "",
                "images": [{"name": im.get("name"), "caption": im.get("caption")}
                           for im in (s.get("images") or []) if isinstance(im, dict)],
            }
        m[(lesson.get("title") or "").strip()] = {
            "points": pts, "slides": slides, "outline": lesson.get("outline"),
        }
    return m


def restore_lesson(lesson, ref):
    """Fill missing fields from `ref`. Returns a list of human-readable changes."""
    changes = []
    if ref.get("outline") and not lesson.get("outline"):
        lesson["outline"] = ref["outline"]
        changes.append("outline")
    ref_slides = ref.get("slides") or {}
    for s in lesson.get("slides") or []:
        r = ref_slides.get(str(s.get("index")))
        if not r:
            continue
        if not (s.get("text") or "").strip() and (r.get("text") or "").strip():
            s["text"] = r["text"]
            changes.append(f"slide {s.get('index')} 文字")
        if not (s.get("notes") or "").strip() and (r.get("notes") or "").strip():
            s["notes"] = r["notes"]
        # An empty caption object is a placeholder, not content: restoring it would
        # change nothing and make every run report the same "missing" caption.
        caps = {i.get("name"): i.get("caption") for i in r.get("images") or []}
        for im in s.get("images") or []:
            if not isinstance(im, dict):
                continue
            if not ((im.get("caption") or {}).get("caption") or "").strip():
                cap = caps.get(im.get("name"))
                if cap and ((cap.get("caption") or "") + (cap.get("takeaway") or "")).strip():
                    im["caption"] = cap
                    changes.append(f"slide {s.get('index')} 图注")
    for p in lesson.get("points") or []:
        t = (p.get("title") or "").strip()
        if not t:
            continue
        r = ref["points"].get(f"{t}\u0000{p.get('slide')}") or ref["points"].get(f"{t}\u0000None")
        if not r:
            # slide numbers may differ; fall back to the title alone
            r = next((v for k, v in ref["points"].items() if k.split("\u0000")[0] == t), None)
        if not r:
            continue
        for k, v in r.items():
            if not p.get(k):
                p[k] = v
                changes.append(f"「{t[:18]}」{k}")
    return changes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--export", action="store_true")
    ap.add_argument("--restore", action="store_true")
    ap.add_argument("--out", help="content map to write (--export)")
    ap.add_argument("--map", help="content map to read (--restore)")
    ap.add_argument("--lesson", help="only this lesson title substring")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    db_path = os.path.join(args.data_dir, "data.db")

    if args.export:
        lessons = read_lessons(db_path)
        m = build_map(lessons)
        out = args.out or os.path.join(args.data_dir, "lesson-content-map.json")
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(m, fh, ensure_ascii=False)
        n = sum(len(v["points"]) for v in m.values())
        print(f"已导出 {len(m)} 课 / {n} 个知识点的内容地图 → {out}")
        return 0

    if not args.restore or not args.map:
        print("用法：--export --out X.json  或  --restore --map X.json [--apply]")
        return 1
    with open(args.map, encoding="utf-8") as fh:
        ref = json.load(fh)
    db = sqlite3.connect(db_path)
    rows = list(db.execute("SELECT id, data FROM records WHERE store='lessons'"))
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = os.path.join(args.data_dir, f"data.db.bak-restore-{stamp}")
    if args.apply:
        backup_database(db_path, backup)
        print(f"备份已写: {backup}\n")
    touched = 0
    for lid, data in rows:
        lesson = json.loads(data)
        title = (lesson.get("title") or "").strip()
        if args.lesson and args.lesson not in title:
            continue
        r = ref.get(title)
        if not r:
            continue
        changes = restore_lesson(lesson, r)
        if not changes:
            continue
        touched += 1
        kinds = {}
        for c in changes:
            key = ("点-正文" if c.endswith(("explanation", "supplement", "keyTerms"))
                   else "页-文字" if "文字" in c else "图注" if "图注" in c else "其他")
            kinds[key] = kinds.get(key, 0) + 1
        print(f"· {title[:44]}：补回 {len(changes)} 项  " + "、".join(f"{k} {v}" for k, v in kinds.items()))
        for c in changes[:4]:
            print("     示例:", c)
        if args.apply:
            db.execute("UPDATE records SET data=? WHERE store='lessons' AND id=?",
                       (json.dumps(lesson, ensure_ascii=False), lid))
    if args.apply:
        db.commit()
    print(f"\n{'已修复' if args.apply else '（试运行）将修复'} {touched} 课")
    if not args.apply:
        print("加 --apply 才写入。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
