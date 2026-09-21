#!/usr/bin/env python3
"""Re-classify slide "page furniture" (school logos, letterhead/footer strips) so it
never shows up as a study figure.

Why the existing rule missed them
---------------------------------
Classification only looked INSIDE one lecture: an image had to appear on half of that
lecture's slides (the top-right hint never fires, because the stored images carry no
x/y/w/h). A crest that the lecturer puts on every title page is therefore only on two
or three slides per lecture — and the same crest, the same bytes, sits in fifty
lectures. Measured in the real library:

    crest            411x246,  11 KB, 1342 instances across 51 lectures -> caught
    crest variant    411x246,  11 KB,   87 instances across  8 lectures -> MISSED
    letterhead strip 1167x292, 44 KB,  166 instances across 67 lectures -> MISSED

So the decisive signal is cross-lecture repetition, and the size/shape separates
furniture from real figures: crests are small, letterheads are very wide and short,
diagrams are large and nearer square.

Rules (any one flags the image as kind=logo)
  A. the same image is on >= 50% of this lecture's slides               (unchanged)
  B. ... on >= 30% of them AND it is small (<=64 KB) or a strip (aspect >= 2.5)
  C. ... on >= 30% of them AND sits top-right                            (unchanged)
  D. the same bytes appear in >= 3 lectures AND (small/strip OR >= 2 slides here)

Deliberately NOT flagged: a large, near-square diagram reused in several lectures —
rule D requires the furniture shape or a local repeat, so shared real figures stay.

Usage
    python3 strip_template_images.py                       # dry run (default data dir)
    python3 strip_template_images.py --data-dir ./data-pku  # another instance
    python3 strip_template_images.py --apply               # rewrite (writes a changelog)
    python3 strip_template_images.py --list                # print every change

Safety
  * dry run by default; nothing is written without --apply
  * a changelog JSON with every changed image is written to
    <data-dir>/template-images-<ts>.json — the old kind is in there, so a revert is a
    one-line-per-image flip
  * only figure/None -> logo is ever written; kind=page is never touched
  * the cross-lecture index (<data-dir>/image-index.json) is rebuilt so the running
    server recognises these images on the next upload too
"""

import argparse
import base64
import collections
import hashlib
import json
import os
import sqlite3
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

LOGO_MAX_BYTES = 64 * 1024
LOGO_MIN_ASPECT = 2.5
LOGO_MIN_LESSONS = 3


def image_metrics(data_url):
    """(decoded bytes, width/height) read from the image header itself."""
    try:
        raw = base64.b64decode(data_url.split(",", 1)[-1])
    except Exception:                                            # noqa: BLE001
        return 0, 1.0
    n = len(raw)
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        w = raw[16] << 24 | raw[17] << 16 | raw[18] << 8 | raw[19]
        h = raw[20] << 24 | raw[21] << 16 | raw[22] << 8 | raw[23]
        return n, w / max(1, h)
    if raw[:2] == b"\xff\xd8":
        i = 2
        while i < n - 9:
            if raw[i] != 0xFF:
                i += 1
                continue
            m = raw[i + 1]
            if m in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                hh = (raw[i + 5] << 8) | raw[i + 6]
                ww = (raw[i + 7] << 8) | raw[i + 8]
                return n, ww / max(1, hh)
            if m in (0xD8, 0xD9) or 0xD0 <= m <= 0xD7:
                i += 2
                continue
            i += 2 + ((raw[i + 2] << 8) | raw[i + 3])
    return n, 1.0


def main():
    ap = argparse.ArgumentParser(description="Flag logos/letterheads out of the figure set.")
    ap.add_argument("--data-dir", default=os.path.join(HERE, "data"))
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    db = os.path.join(args.data_dir, "data.db")
    if not os.path.isfile(db):
        sys.exit("no data.db in %s" % args.data_dir)

    con = sqlite3.connect(db)
    con.row_factory = sqlite3.Row
    records = [(r["id"], json.loads(r["data"]))
               for r in con.execute("SELECT id, data FROM records WHERE store='lessonImages'")]
    print("数据目录: %s" % args.data_dir)
    print("图片记录: %d 门课" % len(records))

    # ---- pass 1: hash every image, count slides-per-lecture and lectures-per-hash
    per_lesson_counts = {}      # lesson id -> {hash: slides}
    lessons_of = collections.defaultdict(set)
    sample_url = {}
    instances = 0
    for lid, rec in records:
        counts = collections.Counter()
        for sl in rec.get("slides") or []:
            seen = set()
            for im in sl.get("images") or []:
                if not isinstance(im, dict) or im.get("kind") == "page" or not im.get("dataUrl"):
                    continue
                h = hashlib.sha1(im["dataUrl"].encode("utf-8")).hexdigest()
                instances += 1
                if h in seen:
                    continue
                seen.add(h)
                counts[h] += 1
                lessons_of[h].add(lid)
                sample_url.setdefault(h, im["dataUrl"])
        per_lesson_counts[lid] = counts

    # ---- pass 2: decode only the candidates (cheap: a few hundred of 20k+)
    candidates = {h for h, n in lessons_of.items() if len(n) >= LOGO_MIN_LESSONS}
    metrics = {h: image_metrics(sample_url[h]) for h in candidates}
    print("图片实例 %d 个；跨 ≥%d 门课重复的候选 %d 张"
          % (instances, LOGO_MIN_LESSONS, len(candidates)))

    # ---- pass 3: apply the rules
    changes, reasons = [], collections.Counter()
    seen_change = set()
    for lid, rec in records:
        n_slides = len(rec.get("slides") or [])
        if n_slides < 2:
            continue
        repeat_threshold = max(3, int(n_slides * 0.3))
        heavy_threshold = max(3, int(n_slides * 0.5))
        counts = per_lesson_counts[lid]
        for si, sl in enumerate(rec.get("slides") or []):
            for im in sl.get("images") or []:
                if not isinstance(im, dict) or im.get("kind") == "page" or not im.get("dataUrl"):
                    continue
                if im.get("kind") == "logo":
                    continue
                h = hashlib.sha1(im["dataUrl"].encode("utf-8")).hexdigest()
                repeats = counts.get(h, 0)
                nbytes, aspect = metrics.get(h, image_metrics(im["dataUrl"]))
                small_or_strip = (0 < nbytes <= LOGO_MAX_BYTES) or aspect >= LOGO_MIN_ASPECT
                why = None
                if repeats >= heavy_threshold:
                    why = "A 本课 ≥50% 页出现"
                elif repeats >= repeat_threshold and small_or_strip:
                    why = "B 本课 ≥30% 页 + 小图/横条"
                elif len(lessons_of[h]) >= LOGO_MIN_LESSONS and (small_or_strip or repeats >= 2):
                    why = "D 跨 %d 门课重复 + 小图/横条" % len(lessons_of[h])
                if not why:
                    continue
                key = (lid, si, im.get("name"))
                if key in seen_change:
                    continue
                seen_change.add(key)
                im["kind"] = "logo"
                changes.append({"lessonId": lid, "slide": si, "name": im.get("name"),
                                "hash": h[:12], "bytes": nbytes, "aspect": round(aspect, 2),
                                "lectures": len(lessons_of[h]), "slidesHere": repeats, "why": why})
                reasons[why.split()[0]] += 1

    print("将标记为 logo 的图片: %d 个实例" % len(changes))
    for k in sorted(reasons):
        print("   规则 %s: %d 个" % (k, reasons[k]))
    if not changes:
        print("无需改动 ✓")
        return
    if args.list:
        for ch in changes[:400]:
            print("  [%s] %s  %d KB  %sx  %d 门课  第 %d 页  %s"
                  % (ch["why"], ch["hash"], ch["bytes"] // 1024, ch["aspect"], ch["lectures"], ch["slide"], ch["name"]))
    else:
        print("\n样例:")
        for ch in changes[:8]:
            print("  %-28s %5dKB 宽高比%4.2f  %2d 门课重复  第 %d 页"
                  % (ch["hash"], ch["bytes"] // 1024, ch["aspect"], ch["lectures"], ch["slide"]))

    if not args.apply:
        print("\n【干跑】未写入。确认后加 --apply 执行。")
        return

    stamp = time.strftime("%Y%m%d-%H%M%S")
    log = os.path.join(args.data_dir, "template-images-%s.json" % stamp)
    with open(log, "w", encoding="utf-8") as fh:
        json.dump({"changedAt": int(time.time() * 1000), "dataDir": args.data_dir,
                   "changes": changes}, fh, ensure_ascii=False, indent=1)
    print("\n变更记录: %s（%d 条，含原 kind，可逐条还原）" % (log, len(changes)))

    touched = {c["lessonId"] for c in changes}
    for lid, rec in records:
        if lid in touched:
            con.execute("UPDATE records SET data=? WHERE store='lessonImages' AND id=?",
                        (json.dumps(rec, ensure_ascii=False, separators=(",", ":")), lid))
    con.commit()

    # Rebuild the server's cross-lecture index so future uploads are recognised too.
    idx_path = os.path.join(args.data_dir, "image-index.json")
    try:
        with open(idx_path, "w", encoding="utf-8") as fh:
            json.dump({h: len(v) for h, v in lessons_of.items()}, fh)
        print("跨课索引已重建: %s（%d 张图）" % (idx_path, len(lessons_of)))
    except OSError as exc:
        print("索引写入失败（不影响本次改动）: %s" % exc)
    print("已更新 %d 门课" % len(touched))
    con.close()
    print("完成。刷新页面即可看到（服务端列表缓存约 6 秒，重启实例立即生效）。")


if __name__ == "__main__":
    main()
