#!/usr/bin/env python3
"""Move knowledge points off agenda pages onto the slide that actually teaches them.

Why this exists
---------------
A lecture usually opens with an outline slide that LISTS every topic of the hour
("Cell and tissue culture / Optical-Electron Microscopy / Fractionation / ...").
When that slide goes into the note-extraction batch, the model treats the list as
content and expands each bullet into a full knowledge point — using its own
knowledge, since the slide carries no detail. Every one of those points is then
tagged with the OUTLINE's page number.

Two things break as a result:
  * those slides are taught on pages 33-87, but the points sit on page 9, so the
    "按讲义顺序" (lecture order) view, which simply sorts by page, shows a whole
    block of the lecture a tenth of the way in and then repeats it later;
  * the pages that genuinely carry the topic as a figure with almost no text
    (e.g. "Centrifugation: Theory") are referenced by nobody, so they look like
    they have gone missing.

The fix is a re-attribution, not new generation: for each point parked on an
outline page, find the page whose text + figure captions best cover that point's
own terms, and move it there. Nothing is generated, nothing is deleted, and the
figure captions needed for the match already exist.

Detection of an "outline page" is deliberately data-driven: a page that hosts far
more points than any page can plausibly teach is a list, not a lesson.

Usage
  python reattribute_slides.py data-pku/data.db --title "Lecture 1.2"           # preview
  python reattribute_slides.py data-pku/data.db --title "Lecture 1.2" --apply   # write
"""
import os as _os
import sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from db_backup import backup_database  # noqa: E402

import argparse
import collections
import json
import math
import re

import sqlite3
import time
from datetime import datetime

# ----------------------------------------------------------------------------
# tokenising: Latin words plus CJK n-grams, so no segmenter is needed and a term
# like 共聚焦显微镜 still matches 共聚焦 in a caption.
# ----------------------------------------------------------------------------
LATIN = re.compile(r"[A-Za-z][A-Za-z0-9\-]{2,}")
CJK = re.compile(r"[\u4e00-\u9fff]+")
STOP = {
    "the", "and", "for", "with", "that", "this", "from", "are", "was", "were", "its",
    "their", "which", "into", "such", "can", "not", "but", "has", "have", "been",
    "they", "these", "those", "other", "than", "then", "when", "where", "how", "what",
    "why", "who", "will", "would", "may", "might", "each", "more", "most", "some",
    "same", "only", "also", "used", "using", "use", "one", "two", "three", "all",
    "very", "often", "well", "make", "made", "does", "about", "over", "under",
}


def terms(text):
    out = []
    s = str(text or "")
    for w in LATIN.findall(s):
        w = w.lower()
        if w not in STOP and len(w) >= 3:
            out.append(w)
            if "-" in w:
                out.extend(p for p in w.split("-") if len(p) >= 3 and p not in STOP)
    for run in CJK.findall(s):
        for n in (2, 3):
            for i in range(len(run) - n + 1):
                out.append(run[i:i + n])
    return out


def explanation_text(e):
    if isinstance(e, str):
        return e
    if isinstance(e, list):
        parts = []
        for x in e:
            if isinstance(x, dict):
                parts.append(" ".join(str(v) for v in x.values() if isinstance(v, (str, int, float))))
            else:
                parts.append(str(x))
        return " ".join(parts)
    if isinstance(e, dict):
        return " ".join(str(v) for v in e.values() if isinstance(v, (str, int, float)))
    return ""


def keyterms_text(p):
    kt = p.get("keyTerms") or []
    out = []
    for k in kt:
        out.append(k if isinstance(k, str) else json.dumps(k, ensure_ascii=False))
    return " ".join(out)


def page_haystack(slide):
    """Text a page actually carries: its own text plus every figure caption the
    vision pass wrote for it (that is what makes figure-only pages matchable)."""
    parts = [slide.get("text") or "", slide.get("notes") or ""]
    for im in (slide.get("images") or []):
        cap = im.get("caption")
        if isinstance(cap, dict):
            parts.append(str(cap.get("caption") or ""))
            parts.append(str(cap.get("takeaway") or ""))
            parts.append(str(cap.get("type") or ""))
        elif isinstance(cap, str):
            parts.append(cap)
        parts.append(str(im.get("name") or ""))
    return " ".join(parts)


def point_terms(p):
    """Weighted term bag for a point: title and key terms define the topic, the
    explanation supplies supporting vocabulary at a lower weight."""
    bag = collections.Counter()
    for t in terms(p.get("title")): bag[t] += 3
    for t in terms(keyterms_text(p)): bag[t] += 3
    for t in terms(explanation_text(p.get("explanation")))[:400]: bag[t] += 1
    for t in terms(" ".join(p.get("tags") or []) if isinstance(p.get("tags"), list) else p.get("tags")): bag[t] += 1
    return bag


def analyse(lesson, hub_min=4, min_frac=0.30):
    slides = lesson.get("slides") or []
    points = lesson.get("points") or []
    # page -> term set
    pages = {}
    for s in slides:
        idx = s.get("index")
        if idx is None:
            continue
        pages[int(idx)] = set(terms(page_haystack(s)))
    if not pages:
        return [], {}, {}

    n_pages = len(pages)
    df = collections.Counter()
    for ts in pages.values():
        for t in ts:
            df[t] += 1
    idf = {t: math.log(1.0 + n_pages / (1.0 + c)) for t, c in df.items()}

    hosts = collections.Counter()
    for p in points:
        if p.get("slide") is not None:
            hosts[int(p["slide"])] += 1

    # What makes a page an outline: it carries a bulleted list of the hour's topics.
    # Counting the points alone would also convict a page of exam questions — page 87
    # of the real Lecture 1.2 hosts six, one per question, and those belong where
    # they are. The bullet list is what separates "list of topics" from "content".
    def is_outline(idx):
        if hosts.get(idx, 0) < hub_min:
            return False
        for s in slides:
            if s.get("index") == idx:
                return (s.get("text") or "").count("•") >= 3
        return False

    outline_pages = {i for i in hosts if is_outline(i)}

    # Slide decks repeat themselves: the real Lecture 1.2 carries the identical
    # "Part List" recap on pages 9, 31 and 85. A repeated slide is a recap, never a
    # topic's home, so it is refused as a TARGET. This has to be judged by the page's
    # own text rather than by how many points it hosts: once the pile on page 9 has
    # been moved off it, the host count alone would stop calling it an agenda page
    # and the next pass would happily move points back onto it.
    by_text = collections.defaultdict(list)
    for idx, ts in pages.items():
        for s in slides:
            if s.get("index") == idx:
                by_text[re.sub(r"\s+", "", s.get("text") or "")].append(idx)
                break
    repeated_pages = {i for ids in by_text.values() if len(ids) > 1 for i in ids}

    rows = []
    for i, p in enumerate(points):
        cur = int(p["slide"]) if p.get("slide") is not None else None
        bag = point_terms(p)
        if not bag:
            continue
        norm = sum(w * idf.get(t, 0.0) for t, w in bag.items())
        if norm <= 0:
            continue
        best, best_frac, best_terms = None, 0.0, []
        for idx, ts in pages.items():
            hit = [(t, w) for t, w in bag.items() if t in ts]
            if not hit:
                continue
            got = sum(w * idf.get(t, 0.0) for t, w in hit)
            frac = got / norm
            if frac > best_frac:
                best, best_frac = idx, frac
                best_terms = sorted(hit, key=lambda tw: -tw[1] * idf.get(tw[0], 0.0))[:6]
        # How well the page the point is ON covers the point's own terms. A point
        # the current page genuinely covers is left alone even if some other page
        # scores higher: the recap slides repeat the same "Part List" wording, and
        # their overview bullets really are what those pages are about.
        cur_frac = 0.0
        if cur is not None and cur in pages:
            hit = [(t, w) for t, w in bag.items() if t in pages[cur]]
            if hit:
                cur_frac = sum(w * idf.get(t, 0.0) for t, w in hit) / norm
        rows.append({
            "i": i, "title": p.get("title") or "", "cur": cur,
            "best": best, "frac": round(best_frac, 3), "cur_frac": round(cur_frac, 3),
            "cur_hosts": hosts.get(cur, 0), "best_hosts": hosts.get(best, 0) if best else 0,
            "best_repeat": best in repeated_pages,
            "terms": [t for t, _ in best_terms],
            "is_hub": cur in outline_pages,
        })
    return rows, hosts, pages, outline_pages


def plan(rows, min_frac=0.40, ratio=1.6, hub_min=5):
    """Three conditions, all of which the real Lecture 1.2 needs:

    1. the point sits on an OUTLINE page — a bulleted list of the hour's topics that
       the model expanded into detailed points. A point on an ordinary content page
       is never touched, which is what keeps exam-question pages and paper-figure
       pages out of the plan;
    2. the target page is NOT another outline page — this lecture repeats the same
       agenda slide verbatim on pages 9, 31 and 85, so without this the plan just
       shuffles points between three copies of one list;
    3. the target covers the point's terms at least `ratio` times better than the
       page it is on, and at least `min_frac` in absolute terms. A recap page that
       genuinely lists "Cell and tissue culture" keeps that point, even though an
       identical copy of the same list scores a hair higher.

    Nothing is generated and nothing is deleted; the tool repairs attribution and
    leaves every other point untouched."""
    moves = []
    for r in rows:
        if not r["is_hub"] or r["best"] is None or r["best"] == r["cur"]:
            continue
        if r["best_repeat"]:                    # target is a repeated recap/agenda slide
            continue
        if r["frac"] < min_frac:
            continue
        if r["cur_frac"] > 0 and r["frac"] < r["cur_frac"] * ratio:
            continue
        moves.append(r)
    return moves


def load_lessons(db_path):
    conn = sqlite3.connect(db_path)
    out = []
    for rid, raw in conn.execute("SELECT id, data FROM records WHERE store='lessons'"):
        out.append((rid, json.loads(raw)))
    conn.close()
    return out


def main():
    ap = argparse.ArgumentParser(description="把挤在大纲页上的知识点搬回真正讲它的那一页")
    ap.add_argument("db")
    ap.add_argument("--lesson", help="只处理这一门课（lesson id）")
    ap.add_argument("--title", help="按标题子串筛选课程")
    ap.add_argument("--hub-min", type=int, default=5, help="报告用：一页挂多少个点算大纲页（默认 5）")
    ap.add_argument("--ratio", type=float, default=1.6, help="新页覆盖度至少是当前页的多少倍才搬（默认 1.6）")
    ap.add_argument("--min-frac", type=float, default=0.40, help="内容覆盖度阈值（默认 0.30）")
    ap.add_argument("--apply", action="store_true", help="真正写入（默认只预览）")
    ap.add_argument("--all", action="store_true", help="预览所有课程的问题")
    args = ap.parse_args()

    lessons = load_lessons(args.db)
    targets = []
    for rid, l in lessons:
        if args.lesson and rid != args.lesson:
            continue
        if args.title and args.title not in (l.get("title") or ""):
            continue
        if not args.lesson and not args.title and not args.all:
            continue
        targets.append((rid, l))
    if not targets:
        print("没有匹配的课程。用 --lesson / --title / --all 指定。")
        return

    total_moves = 0
    for rid, l in targets:
        rows, hosts, pages, outline_pages = analyse(l)
        moves = plan(rows, args.min_frac, args.ratio, args.hub_min)
        hubs = sorted([(pg, hosts[pg]) for pg in outline_pages], key=lambda x: -x[1])
        print(f"\n{'='*86}\n★ {l.get('title')}  (id={rid})")
        print(f"  页数={len(pages)}  知识点={len(rows)}  大纲页={hubs}")
        nohost = [pg for pg in sorted(pages) if pg not in hosts]
        print(f"  无人引用的页={nohost}")
        print(f"  → 建议搬回的知识点：{len(moves)} 个")
        for r in moves:
            host_note = f"（第{r['cur']}页现在挂着{r['cur_hosts']}个点）" if r["is_hub"] else ""
            print(f"\n    · {r['title'][:74]}")
            print(f"        第 {r['cur']} 页(覆盖{r['cur_frac']}) → 第 {r['best']} 页(覆盖{r['frac']})  命中词={','.join(r['terms'])} {host_note}")
        total_moves += len(moves)

        if args.apply and moves:
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            bak = f"{args.db}.bak-slidefix-{stamp}"
            backup_database(args.db, bak)
            print(f"\n  已备份 → {bak}")
            for r in moves:
                l["points"][r["i"]]["slide"] = r["best"]
            l["updatedAt"] = int(time.time() * 1000)
            conn = sqlite3.connect(args.db, timeout=15)
            conn.execute("UPDATE records SET data=? WHERE store='lessons' AND id=?",
                         (json.dumps(l, ensure_ascii=False, separators=(",", ":")), rid))
            conn.commit()
            conn.close()
            print(f"  已写入 {len(moves)} 处改动")

    print(f"\n总计建议改动 {total_moves} 处" + ("（已写入）" if args.apply else "（预览模式，加 --apply 执行）"))


if __name__ == "__main__":
    main()
