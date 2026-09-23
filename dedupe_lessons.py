#!/usr/bin/env python3
"""Remove duplicated lesson records (same title + page count + source filename).

Cause: uploading the same batch twice (e.g. clicking "开始上传" again while a slow
batch was still parsing). Each duplicate pair carries its own cards / quiz /
mistakes / image payload, so removing a lesson must remove its dependents too.

Usage:
  python dedupe_lessons.py data/data.db            # preview (writes nothing)
  python dedupe_lessons.py data/data.db --apply    # actually delete
  python dedupe_lessons.py data/data.db --apply --keep oldest

Kept record per group (default `richest`): the one with the most knowledge points,
then the most recently updated, then the earliest created.
"""
import os as _os
import sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from db_backup import backup_database  # noqa: E402

import argparse
import json
import os

import sqlite3
import sys
import time
from collections import defaultdict


def lesson_key(rec):
    """Identity of a duplicate group: same title, page count and source file."""
    return (
        (rec.get("title") or "").strip(),
        len(rec.get("slides") or []),
        rec.get("filename") or "",
    )


def describe(rec):
    return "pages=%d points=%d cards=%s created=%s" % (
        len(rec.get("slides") or []),
        len(rec.get("points") or []),
        rec.get("cardCount", "?"),
        time.strftime("%m-%d %H:%M", time.localtime((rec.get("createdAt") or 0) / 1000)),
    )


def pick_keeper(records, strategy):
    if strategy == "oldest":
        return min(records, key=lambda x: x[1].get("createdAt") or 0)
    if strategy == "newest":
        return max(records, key=lambda x: x[1].get("updatedAt") or x[1].get("createdAt") or 0)
    # richest: most points, then most recently updated, then earliest created
    return max(
        records,
        key=lambda x: (
            len(x[1].get("points") or []),
            x[1].get("updatedAt") or x[1].get("createdAt") or 0,
            -(x[1].get("createdAt") or 0),
        ),
    )


def main():
    ap = argparse.ArgumentParser(description="删除重复的课程记录（连同其闪卡/题目/错题/图片）")
    ap.add_argument("db", help="SQLite 数据库路径，如 data/data.db")
    ap.add_argument("--apply", action="store_true", help="真正执行删除（默认只预览）")
    ap.add_argument("--keep", choices=["richest", "oldest", "newest"], default="richest",
                    help="每组保留哪一份（默认 richest：知识点最多的）")
    args = ap.parse_args()

    if not os.path.exists(args.db):
        sys.exit("找不到数据库: %s" % args.db)

    conn = sqlite3.connect(args.db)
    conn.execute("PRAGMA journal_mode=WAL")
    cur = conn.cursor()

    rows = cur.execute("SELECT id, data FROM records WHERE store='lessons'").fetchall()
    groups = defaultdict(list)
    for rid, raw in rows:
        try:
            rec = json.loads(raw)
        except Exception:
            continue
        groups[lesson_key(rec)].append((rid, rec))

    dup_groups = {k: v for k, v in groups.items() if len(v) > 1}
    print("总课程: %d   重复组: %d   多余记录: %d" % (
        len(rows), len(dup_groups), sum(len(v) - 1 for v in dup_groups.values())))
    if not dup_groups:
        print("没有重复，无需处理 ✅")
        return 0

    # 统计依赖数据
    doomed = []
    for key, members in sorted(dup_groups.items(), key=lambda kv: kv[0][0]):
        keeper = pick_keeper(members, args.keep)
        losers = [m for m in members if m[0] != keeper[0]]
        title = key[0][:52] or "(无标题)"
        print("\n%s  ×%d" % (title, len(members)))
        print("   保留 %s  %s" % (keeper[0][:8], describe(keeper[1])))
        for rid, rec in losers:
            print("   删除 %s  %s" % (rid[:8], describe(rec)))
            doomed.append(rid)

    dep = defaultdict(int)
    for rid in doomed:
        for store in ("lessonImages", "cards", "quizzes", "mistakes"):
            n = cur.execute(
                "SELECT COUNT(*) FROM records WHERE store=? AND (id=? OR lesson_id=?)",
                (store, rid, rid)).fetchone()[0]
            dep[store] += n
    print("\n将一并删除的关联数据:")
    for store, n in dep.items():
        print("   %-14s %d 条" % (store, n))

    if not args.apply:
        print("\n（预览模式，未修改任何数据。加 --apply 执行删除。）")
        conn.close()
        return 0

    backup = args.db + ".bak-dedupe-" + time.strftime("%Y%m%d-%H%M%S")
    backup_database(args.db, backup)
    print("\n已备份到: %s" % backup)

    removed = 0
    for rid in doomed:
        for store in ("lessonImages", "cards", "quizzes", "mistakes"):
            cur.execute("DELETE FROM records WHERE store=? AND (id=? OR lesson_id=?)", (store, rid, rid))
        cur.execute("DELETE FROM records WHERE store='lessons' AND id=?", (rid,))
        removed += 1
    conn.commit()
    left = cur.execute("SELECT COUNT(*) FROM records WHERE store='lessons'").fetchone()[0]
    conn.close()
    print("✅ 已删除 %d 条重复课程，剩余 %d 门" % (removed, left))
    print("   刷新网页（⌘⇧R）即可看到清理后的列表。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
