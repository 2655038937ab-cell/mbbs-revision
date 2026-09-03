#!/usr/bin/env python3
"""Migrate lesson images out of the `lessons` records into a dedicated
`lessonImages` store, so reading the lessons list no longer pulls megabytes of
base64 image data.

For each lesson:
  - every slide's image dataUrl is copied into a `lessonImages` record
    (keyed by lesson id, one record per lesson holding all slide images),
  - the lesson record's image dataUrl fields are set to null.

The lesson record keeps the image metadata (name/mime/kind/coords) so the
structure is intact; only the heavy base64 payload moves.

Run against a COPY first:  python migrate_images.py data/data.db
Safe to re-run (idempotent): existing lessonImages are replaced.
"""
import json
import sqlite3
import sys


def migrate(path):
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=WAL")
    rows = conn.execute("SELECT data FROM records WHERE store='lessons'").fetchall()
    done = 0
    for (raw,) in rows:
        rec = json.loads(raw)
        lid = rec.get("id")
        if not lid:
            continue
        slides = rec.get("slides") or []
        # Save image payloads (per slide) into the lessonImages record.
        img_record = {"id": lid, "lessonId": lid, "slides": []}
        changed = False
        for slide in slides:
            imgs = slide.get("images") or []
            saved = []
            for im in imgs:
                if isinstance(im, dict) and im.get("dataUrl"):
                    saved.append({"dataUrl": im["dataUrl"], "name": im.get("name"), "mime": im.get("mime"), "kind": im.get("kind")})
                    im["dataUrl"] = None
                    changed = True
                else:
                    saved.append({"dataUrl": None, "name": im.get("name"), "mime": im.get("mime"), "kind": im.get("kind")})
            img_record["slides"].append({"images": saved})
        if changed:
            conn.execute(
                "INSERT OR REPLACE INTO records (store,id,lesson_id,data) VALUES (?,?,?,?)",
                ("lessonImages", lid, lid, json.dumps(img_record, ensure_ascii=False)),
            )
            conn.execute(
                "INSERT OR REPLACE INTO records (store,id,lesson_id,data) VALUES (?,?,?,?)",
                ("lessons", lid, lid, json.dumps(rec, ensure_ascii=False)),
            )
            done += 1
    conn.commit()
    # show sizes
    def dbsize():
        r = conn.execute(
            "SELECT COALESCE(SUM(LENGTH(data)),0) FROM records WHERE store='lessons'"
        ).fetchone()[0]
        return r / 1e6
    print("lessons migrated:", done)
    print("'lessons' store total chars now: %.1f MB" % dbsize())
    big = conn.execute(
        "SELECT COALESCE(SUM(LENGTH(data)),0) FROM records WHERE store='lessonImages'"
    ).fetchone()[0]
    print("'lessonImages' store total chars: %.1f MB" % (big / 1e6))
    conn.close()


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "data/data.db"
    migrate(path)
