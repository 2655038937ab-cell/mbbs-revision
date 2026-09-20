#!/usr/bin/env python3
"""Split a large PDF (e.g. a textbook) into upload-sized parts.

Why this exists: the study app parses a whole file in one request and the upload
endpoint caps a request at 150 MB, so a big textbook can't be sent as-is — and
splitting it afterwards is impossible because it never gets in. Split it on your
own machine first, then upload the parts (the upload page can also merge several
of them back into one course).

Examples
--------
  # one part per 100 pages
  .venv/bin/python split_pdf.py textbook.pdf --every 100

  # explicit ranges
  .venv/bin/python split_pdf.py textbook.pdf --ranges "1-150,151-300,301-450"

  # one part per chapter, taken from the PDF's own bookmarks
  .venv/bin/python split_pdf.py textbook.pdf --by-outline

  # also shrink each part (scan-heavy books gain the most)
  .venv/bin/python split_pdf.py textbook.pdf --every 100 --compress high

  # just show what would be produced, write nothing
  .venv/bin/python split_pdf.py textbook.pdf --every 100 --dry-run

Parts are written to "<bookname>_parts/" unless -o is given.
"""
import argparse
import os
import re
import sys

try:
    import fitz  # PyMuPDF
except ImportError:
    sys.exit("PyMuPDF is required. Run: .venv/bin/pip install pymupdf")

# Lossy presets: re-render every page as a JPEG. "high" = high compression.
LOSSY_PRESETS = {
    "high": {"dpi": 100, "quality": 60},
    "medium": {"dpi": 150, "quality": 72},
    "low": {"dpi": 200, "quality": 82},
}

DEFAULT_MAX_MB = 140.0  # leave headroom under the server's 150 MB request cap


def parse_ranges(spec, total):
    """'1-150, 151-300' -> [(1,150),(151,300)]; also accepts 至/到 and full-width commas."""
    out = []
    for part in re.split(r"[,，;；]+", str(spec or "")):
        part = part.strip()
        if not part:
            continue
        m = re.match(r"^(\d+)\s*[-–—~至到]\s*(\d+)$", part)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
        elif part.isdigit():
            a = b = int(part)
        else:
            raise ValueError("无法识别的范围: %r" % part)
        if a > b:
            a, b = b, a
        if a < 1 or b > total:
            raise ValueError("范围 %d-%d 超出总页数 %d" % (a, b, total))
        out.append((a, b))
    return out


def by_every(total, every):
    return [(i + 1, min(i + every, total)) for i in range(0, total, every)]


def by_outline(doc, level):
    """Build ranges from the PDF's own bookmarks (chapters)."""
    toc = doc.get_toc(simple=True) or []
    picks = [(t[1], t[2]) for t in toc if len(t) >= 3 and t[0] <= level and isinstance(t[2], int) and t[2] > 0]
    if not picks:
        return [], 0
    total = len(doc)
    ranges = []
    skipped = 0
    for i, (title, start) in enumerate(picks):
        end = (picks[i + 1][1] - 1) if i + 1 < len(picks) else total
        if end < start:  # same-page bookmarks
            skipped += 1
            continue
        ranges.append((title, start, end))
    return ranges, skipped


def safe_name(s, fallback="part"):
    s = re.sub(r'[\\/:*?"<>|\r\n\t]+', "_", str(s or "")).strip(" ._")
    s = re.sub(r"\s+", " ", s)
    return (s[:70] or fallback)


def lossy_rebuild(part, mode):
    """Re-render each page as a JPEG inside a fresh PDF (lossy, much smaller)."""
    p = LOSSY_PRESETS[mode]
    out = fitz.open()
    for page in part:
        pix = page.get_pixmap(dpi=p["dpi"], colorspace=fitz.csRGB, alpha=False)
        jpg = pix.tobytes("jpeg", jpg_quality=p["quality"])
        np = out.new_page(width=page.rect.width, height=page.rect.height)
        np.insert_image(page.rect, stream=jpg)
    data = out.tobytes(garbage=4, deflate=True)
    out.close()
    return data


def build_part(doc, a, b, compress):
    part = fitz.open()
    part.insert_pdf(doc, from_page=a - 1, to_page=b - 1)
    try:
        if compress in LOSSY_PRESETS:
            return lossy_rebuild(part, compress)
        # Lossless structural cleanup: dedupe objects, strip junk, deflate streams.
        return part.tobytes(garbage=4, deflate=True, clean=True)
    finally:
        part.close()


def write_part(doc, a, b, label, outdir, compress, max_bytes, dry_run, index, total_parts):
    data = build_part(doc, a, b, compress)
    size = len(data)
    # If a part still exceeds the cap, split it further rather than fail later.
    if max_bytes and size > max_bytes and b > a:
        mid = (a + b) // 2
        return (write_part(doc, a, mid, label, outdir, compress, max_bytes, dry_run, index, total_parts)
                + write_part(doc, mid + 1, b, label, outdir, compress, max_bytes, dry_run, index, total_parts))
    name = "%s_p%03d-%03d.pdf" % (safe_name(label), a, b)
    path = os.path.join(outdir, name)
    if not dry_run:
        os.makedirs(outdir, exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(data)
    return [(path, a, b, size)]


def build_ranges(doc, total, base, mode, every=None, spec=None, level=1):
    """Return [(label, first, last)] for the chosen split mode."""
    if mode == "every":
        if every < 1:
            raise ValueError("每份页数必须 >= 1")
        return [("%s" % base, a, b) for a, b in by_every(total, every)], ""
    if mode == "ranges":
        return [("%s" % base, a, b) for a, b in parse_ranges(spec, total)], ""
    chaps, skipped = by_outline(doc, level)
    if not chaps:
        raise ValueError("这个 PDF 没有可用的书签（目录），请改用按页数拆分")
    return chaps, ("(跳过 %d 个同页书签)" % skipped if skipped else "")


def run_split(pdf, ranges, outdir, compress, max_mb, dry_run=False):
    """Write the parts and report. Returns the list of (path, first, last, bytes)."""
    doc = fitz.open(pdf)
    max_bytes = int(max_mb * 1048576) if max_mb else 0
    results = []
    for i, (label, a, b) in enumerate(ranges, 1):
        results += write_part(doc, a, b, label, outdir, compress, max_bytes, dry_run, i, len(ranges))
    doc.close()
    total_bytes = sum(r[3] for r in results)
    for path, a, b, size in results:
        print("  %-46s p.%-9s %7.1f MB" % (os.path.basename(path), "%d-%d" % (a, b), size / 1048576))
    print("-" * 64)
    print("%d 份%s，合计 %.1f MB" % (len(results), "（预览，未写入）" if dry_run else "", total_bytes / 1048576))
    if not dry_run:
        over = [r for r in results if max_bytes and r[3] > max_bytes]
        if over:
            print("⚠️  仍有 %d 份超过上限，建议每份页数再少一些，或改用压缩" % len(over))
        # Lossy compression re-renders pages as images: great for scans, but it
        # INFLATES a text/vector PDF. Say so instead of leaving a bigger file.
        try:
            src = os.path.getsize(pdf)
        except OSError:
            src = 0
        if compress in LOSSY_PRESETS and src and total_bytes > src * 1.05:
            print("⚠️  压缩后反而变大了（源 %.1f MB → %.1f MB）。" % (src / 1048576, total_bytes / 1048576))
            print("   这个 PDF 是文字/矢量型的，重渲染成图片不划算——请改用「不压缩」重新生成。")
        print("   上传地址：本地 PKU 站 http://127.0.0.1:8757 （上传页可勾选「合并成一门课」）")
    return results


# --------------------------------------------------------------------------
# Interactive mode (no command-line arguments): asks everything, so nothing has
# to be memorised. Dragging a file into the terminal works — the path arrives
# escaped or quoted and is cleaned up below.
# --------------------------------------------------------------------------
def _clean_path(raw):
    s = str(raw or "").strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "'\"":
        s = s[1:-1]
    else:
        s = s.replace("\\ ", " ").replace("\\'", "'").replace('\\"', '"')
    return os.path.expanduser(s.strip())


def _ask(prompt, options, default=1):
    print()
    for i, (_, label) in enumerate(options, 1):
        print("  %d) %s" % (i, label))
    while True:
        raw = input("%s [%d]: " % (prompt, default)).strip()
        if not raw:
            return options[default - 1][0]
        if raw.isdigit() and 1 <= int(raw) <= len(options):
            return options[int(raw) - 1][0]
        print("  请输入 1-%d" % len(options))


def interactive():
    print()
    print("=" * 62)
    print("  PDF 拆分工具 —— 把大教科书拆成能上传的小份")
    print("=" * 62)
    while True:
        pdf = _clean_path(input("\n把 PDF 文件拖到这里（或直接输入路径），然后按回车：\n> "))
        if not pdf:
            print("没有输入，已退出。")
            return 0
        if os.path.isfile(pdf) and pdf.lower().endswith(".pdf"):
            break
        print("✗ 找不到这个 PDF：%s\n  提示：直接把文件从访达拖进这个窗口即可。" % pdf)

    doc = fitz.open(pdf)
    total, size_mb = len(doc), os.path.getsize(pdf) / 1048576
    base = os.path.splitext(os.path.basename(pdf))[0]
    chaps, _ = by_outline(doc, 1)
    print("\n已读取：%s" % os.path.basename(pdf))
    print("  页数 %d · 大小 %.1f MB" % (total, size_mb))
    print("  章节书签：%s" % ("检测到 %d 章" % len(chaps) if chaps else "无（将按页数拆）"))

    mode_opts = []
    if chaps:
        mode_opts.append(("outline", "按章节拆 —— 推荐，共 %d 章" % len(chaps)))
    mode_opts += [("every:50", "每 50 页一份"), ("every:100", "每 100 页一份"), ("ranges", "自己指定页码范围")]
    mode = _ask("怎么拆？", mode_opts)

    spec = None
    every = None
    if mode == "ranges":
        print()
        spec = input("输入页码范围（例如 1-150,151-300）：\n> ").strip()
    elif mode.startswith("every:"):
        every = int(mode.split(":")[1])

    compress = _ask("要压缩吗？", [
        ("none", "不压缩 —— 文字型/矢量 PDF 请选这个（压缩反而会变大）"),
        ("high", "高压缩 —— 扫描版教材选这个，约省 2/3"),
        ("medium", "中等压缩 —— 扫描版，图片更清楚些"),
        ("low", "轻度压缩 —— 扫描版，最清晰"),
    ])

    outdir = os.path.join(os.path.dirname(os.path.abspath(pdf)), base + "_parts")
    print()
    print("输出目录：%s" % outdir)
    try:
        ranges, note = build_ranges(doc, total, base, "every" if every else ("ranges" if spec else "outline"),
                                    every=every, spec=spec, level=1)
    except ValueError as exc:
        doc.close()
        print("✗ %s" % exc)
        return 1
    if note:
        print(note)
    doc.close()

    print("\n将要生成：")
    for i, (label, a, b) in enumerate(ranges[:12], 1):
        print("  %2d. %s  p.%d-%d" % (i, label, a, b))
    if len(ranges) > 12:
        print("  ... 共 %d 份" % len(ranges))

    if input("\n开始拆分？[Y/n]: ").strip().lower() in ("n", "no"):
        print("已取消。")
        return 0

    print()
    run_split(pdf, ranges, outdir, compress, DEFAULT_MAX_MB)
    print("\n✅ 完成！文件在：%s" % outdir)
    print("   下一步：打开 http://127.0.0.1:8757 → Lessons → ＋ Upload lesson")
    return 0


def main():
    if len(sys.argv) == 1:
        return interactive()

    ap = argparse.ArgumentParser(description="把大 PDF 拆成适合上传的小份（可选压缩）")
    ap.add_argument("pdf", help="源 PDF 文件")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--every", type=int, metavar="N", help="每 N 页拆一份")
    g.add_argument("--ranges", metavar="SPEC", help='自定义范围，如 "1-150,151-300"')
    g.add_argument("--by-outline", action="store_true", help="按 PDF 书签（章节）拆分")
    ap.add_argument("--level", type=int, default=1, help="按书签拆分时的层级（默认 1）")
    ap.add_argument("-o", "--out", metavar="DIR", help="输出目录（默认 <文件名>_parts/）")
    ap.add_argument("--compress", choices=["none", "lossless"] + list(LOSSY_PRESETS),
                    default="none", help="压缩方式：none=不压缩（矢量/文字 PDF 用这个），lossless=无损清理，high/medium/low=重渲染降质量（仅扫描版有益）")
    ap.add_argument("--max-mb", type=float, default=DEFAULT_MAX_MB,
                    help="单份上限（MB），超过会自动再拆小（默认 %(default)s）")
    ap.add_argument("--dry-run", action="store_true", help="只预览，不写文件")
    args = ap.parse_args()

    if not os.path.exists(args.pdf):
        sys.exit("找不到文件: %s" % args.pdf)

    doc = fitz.open(args.pdf)
    total = len(doc)
    base = os.path.splitext(os.path.basename(args.pdf))[0]
    outdir = args.out or (base + "_parts")
    print("源文件: %s" % args.pdf)
    print("总页数: %d   大小: %.1f MB" % (total, os.path.getsize(args.pdf) / 1048576))
    if args.compress != "none":
        print("压缩:   %s" % args.compress)
    print("输出到: %s" % outdir)
    print("-" * 64)

    mode = "every" if args.every is not None else ("ranges" if args.ranges else "outline")
    try:
        ranges, note = build_ranges(doc, total, base, mode,
                                    every=args.every, spec=args.ranges, level=args.level)
    except ValueError as exc:
        doc.close()
        sys.exit(str(exc))
    doc.close()
    if note:
        print(note)
    run_split(args.pdf, ranges, outdir, args.compress, args.max_mb, args.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
