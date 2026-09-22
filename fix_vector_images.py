#!/usr/bin/env python3
"""Replace unrenderable slide images (EMF/WMF/TIFF...) with displayable PNGs.

Why: PowerPoint decks carry vector metafiles that a browser cannot draw. They were
stored with `application/octet-stream`, so the student saw a blank figure, the
payload grew by tens of megabytes, and — worst — the raw bytes were still handed
to the vision model, which described a topic that was never on the slide. That is
how a skeletal-muscle lecture ended up with captions, points, cards and quiz
questions about upper-limb arteries.

This script fixes lessons that were imported before `ppt_parser` learned to
recover the bitmap inside such metafiles:

  * recovers the embedded bitmap as PNG where possible and rewrites the stored
    image in place (dataUrl / mime / name, keeping `convertedFrom` as a trace);
  * drops the image when nothing is recoverable;
  * clears the caption of every touched image, because a caption produced from
    unrenderable bytes is untrustworthy — regenerating the lesson rebuilds it
    from the picture itself;
  * keeps both stores aligned: an image removed from `lessonImages` is removed at
    the same position from the lesson's own `slides[].images[]`.

Dry run by default; writes only with --apply. A database backup and a rollback
JSON are written next to the data directory.

  python3 fix_vector_images.py --data-dir data-pku
  python3 fix_vector_images.py --data-dir data-pku --apply
  python3 fix_vector_images.py --data-dir data-pku --apply --lesson <lesson-id>
"""
import argparse
import base64
import datetime as dt
import json
import os
import shutil
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ppt_parser  # noqa: E402


def sniff(data_url):
    """Real format of the image inside a data URL ('' when it is not an image)."""
    if not isinstance(data_url, str) or not data_url.startswith("data:"):
        return ""
    try:
        raw = base64.b64decode(data_url.split(",", 1)[1])
    except Exception:
        return ""
    return ppt_parser.sniff_image_mime(raw)


def fix_record(record, lesson, apply_changes):
    """Return (changed, report) for one lessonImages record."""
    report = {"converted": [], "dropped": [], "captionsCleared": 0, "bytesBefore": 0,
              "bytesAfter": 0, "slides": []}
    for si, slide in enumerate(record.get("slides") or []):
        images = slide.get("images") or []
        keep = []
        lesson_images = None
        if lesson is not None:
            lslides = lesson.get("slides") or []
            if si < len(lslides):
                lesson_images = lslides[si].get("images") or []
        for ii, im in enumerate(images):
            du = im.get("dataUrl") if isinstance(im, dict) else None
            mime = sniff(du)
            report["bytesBefore"] += len(du or "")
            if not mime or mime in ppt_parser._RENDERABLE_MIME:
                keep.append(im)
                report["bytesAfter"] += len(du or "")
                continue
            png = ""
            if mime == "image/x-emf":
                try:
                    png = ppt_parser.emf_to_png(base64.b64decode(du.split(",", 1)[1]))
                except Exception:
                    png = ""
            name = (im.get("name") or "image")
            if png:
                new = dict(im)
                new["dataUrl"] = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
                new["mime"] = "image/png"
                new["name"] = name.rsplit(".", 1)[0] + ".png"
                new["convertedFrom"] = name
                keep.append(new)
                report["bytesAfter"] += len(new["dataUrl"])
                report["converted"].append({"slide": si, "index": ii, "name": name,
                                            "pngBytes": len(png), "wasBytes": len(du)})
            else:
                report["dropped"].append({"slide": si, "index": ii, "name": name,
                                          "bytes": len(du)})
            # A caption derived from bytes nobody could render is not evidence.
            if lesson_images is not None and ii < len(lesson_images):
                cap = lesson_images[ii].get("caption")
                if cap:
                    lesson_images[ii]["caption"] = None
                    report["captionsCleared"] += 1
            report["slides"].append(si)
        # An image removed here must disappear from the lesson record too, at the
        # same position, or captions would silently shift onto the wrong picture.
        if lesson_images is not None and len(keep) != len(images):
            kept_positions = set()
            pos = 0
            for im in images:
                if not isinstance(im, dict):
                    continue
                mime = sniff(im.get("dataUrl"))
                if (not mime) or mime in ppt_parser._RENDERABLE_MIME:
                    kept_positions.add(pos)
                pos += 1
            lesson["slides"][si]["images"] = [im for p, im in enumerate(lesson_images)
                                              if p in kept_positions]
        slide["images"] = keep
    changed = bool(report["converted"] or report["dropped"])
    return changed, report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--lesson", default=None, help="only this lesson id")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    db_path = os.path.join(args.data_dir, "data.db")
    if not os.path.exists(db_path):
        print("找不到数据库:", db_path)
        return 1
    db = sqlite3.connect(db_path)
    rows = db.execute("SELECT id, data FROM records WHERE store='lessonImages'").fetchall()
    titles = {i: (json.loads(d).get("title") or "?")
              for i, d in db.execute("SELECT id, data FROM records WHERE store='lessons'")}
    print(f"{'试运行' if not args.apply else '实际写入'} · {len(rows)} 条 lessonImages 记录\n")

    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = os.path.join(args.data_dir, f"data.db.bak-vectors-{stamp}")
    if args.apply:
        # Take the backup BEFORE the first write, not after: a file copied once the
        # changes are committed cannot undo anything.
        db.commit()
        shutil.copy2(db_path, backup)
        print(f"备份已写: {backup}\n")
    changed_ids, rollback, totals = [], [], {"converted": 0, "dropped": 0, "savedMB": 0.0,
                                             "captionsCleared": 0, "lessons": 0}
    for lid, data in rows:
        if args.lesson and lid != args.lesson:
            continue
        try:
            record = json.loads(data)
        except Exception:
            continue
        lesson_row = db.execute("SELECT data FROM records WHERE store='lessons' AND id=?",
                                (lid,)).fetchone()
        lesson = json.loads(lesson_row[0]) if lesson_row else None
        if lesson is not None:
            before_lesson = json.dumps(lesson)
        changed, report = fix_record(record, lesson, args.apply)
        if not changed:
            continue
        totals["lessons"] += 1
        totals["converted"] += len(report["converted"])
        totals["dropped"] += len(report["dropped"])
        totals["captionsCleared"] += report["captionsCleared"]
        saved = (report["bytesBefore"] - report["bytesAfter"]) / 1e6
        totals["savedMB"] += saved
        print(f"· {titles.get(lid, lid)[:40]}")
        print(f"    转换 {len(report['converted'])} 张、丢弃 {len(report['dropped'])} 张"
              f"、清空可疑图注 {report['captionsCleared']} 条，载荷约减 {saved:.1f} MB")
        for c in report["converted"]:
            print(f"      ✓ 第{c['slide']+1}页 {c['name']} → PNG {c['pngBytes']/1e3:.0f} KB"
                  f"（原 {c['wasBytes']/1e6:.2f} MB）")
        for d in report["dropped"]:
            print(f"      ✗ 第{d['slide']+1}页 {d['name']} 无法还原，已移除（原 {d['bytes']/1e6:.2f} MB）")
        changed_ids.append(lid)
        rollback.append({"lessonId": lid, "title": titles.get(lid, ""),
                         "record": json.loads(data),
                         "lesson": json.loads(before_lesson) if lesson is not None else None})
        if args.apply:
            db.execute("UPDATE records SET data=? WHERE store='lessonImages' AND id=?",
                       (json.dumps(record, ensure_ascii=False), lid))
            if lesson is not None:
                db.execute("UPDATE records SET data=? WHERE store='lessons' AND id=?",
                           (json.dumps(lesson, ensure_ascii=False), lid))

    print(f"\n合计：{totals['lessons']} 课，转换 {totals['converted']} 张，丢弃 {totals['dropped']} 张，"
          f"清空图注 {totals['captionsCleared']} 条，载荷减少约 {totals['savedMB']:.1f} MB")
    if not changed_ids:
        print("没有需要处理的图片。")
        return 0
    if not args.apply:
        print("\n（试运行）加 --apply 才写入数据库。")
        return 0

    db.commit()
    db.close()
    rb = os.path.join(args.data_dir, f"vector-images-rollback-{stamp}.json")
    with open(rb, "w", encoding="utf-8") as fh:
        json.dump({"createdAt": stamp, "lessons": rollback}, fh, ensure_ascii=False)
    print(f"\n回滚文件: {rb}\n注意：需重新生成这些课，图注与知识点才会按真实图片重做。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
