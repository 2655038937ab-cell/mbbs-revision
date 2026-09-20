#!/usr/bin/env python3
"""Merge duplicated knowledge points inside existing lessons.

Why exact-title matching is not enough
--------------------------------------
Two things put the same content into a lesson twice:

  * the generator's coverage pass used to re-send the WHOLE lecture to the
    model instead of only the slides that had produced no point, so the model
    re-emitted every point of the lecture a second time — with a slightly
    longer title ("菲克第一定律" vs "菲克第一定律（Fick's first law）的数学表达式");
  * a lesson was regenerated or merged and the earlier, briefer points stayed.

In both cases the two copies usually sit on the SAME slide and their titles
differ only by extra detail, so the rule set below looks at the title's shape
plus the body's vocabulary rather than at an exact string:

  R1  same normalised title                                -> keep the first
  R2  short title is a PREFIX of the long one              -> keep the long one
  R3  short title is a SUBSTRING of the long one           -> keep the long one
  R4  bodies nearly identical AND titles nearly identical  -> keep the richer one

Guard: titles of the same length that differ in at most two characters are a
contrastive pair (Aα vs Aβ fibres, 谷氨酸 vs 赖氨酸, 细胞 vs 细胞器 level) and are
never merged by R2–R4 — those points are genuinely about different things.

Usage
  python dedupe_points.py --db data-pku/data.db                    # preview
  python dedupe_points.py --db data-pku/data.db --apply            # write
  python dedupe_points.py --db data-pku/data.db --title "第三章"    # one lesson
  python dedupe_points.py --db data-pku/data.db --llm              # + AI 复核
  python dedupe_points.py --db data-pku/data.db --llm --save-plan p.json   # 只出方案
  python dedupe_points.py --db data-pku/data.db --plan p.json --apply      # 按方案写回（不需联网）

  # legacy HTTP mode (needs a running server + login password)
  python dedupe_points.py http://127.0.0.1:8757 <password> [--apply]
"""
import argparse
import collections
import json
import math
import os
import re
import shutil
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

BRACKETED = re.compile(r"[（(【\[][^）)】\]]*[）)】\]]")
LATIN = re.compile(r"[A-Za-z][A-Za-z0-9\-]{2,}")
CJK = re.compile(r"[\u4e00-\u9fff]+")
STOP = {
    "the", "and", "for", "with", "that", "this", "from", "are", "was", "were", "its",
    "their", "which", "into", "such", "can", "not", "but", "has", "have", "been",
    "they", "these", "those", "other", "than", "then", "when", "where", "how", "what",
    "why", "who", "will", "would", "may", "might", "each", "more", "most", "some",
    "same", "only", "also", "used", "using", "use", "one", "two", "three", "all",
    "very", "often", "well", "make", "made", "does", "about", "over", "under",
    "about", "between", "during", "before", "after", "above", "below",
}


# ---------------------------------------------------------------- text helpers
def terms(text):
    """Latin words + CJK bigrams/trigrams — no segmenter needed."""
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
    out = []
    for k in p.get("keyTerms") or []:
        out.append(k if isinstance(k, str) else json.dumps(k, ensure_ascii=False))
    return " ".join(out)


def tags_text(p):
    t = p.get("tags")
    return " ".join(str(x) for x in t) if isinstance(t, list) else str(t or "")


def point_bag(p):
    """Weighted term bag: title and key terms define the topic, the explanation
    supplies supporting vocabulary at a lower weight."""
    bag = collections.Counter()
    for t in terms(p.get("title")):
        bag[t] += 3
    for t in terms(keyterms_text(p)):
        bag[t] += 3
    for t in terms(explanation_text(p.get("explanation")))[:400]:
        bag[t] += 1
    for t in set(terms(tags_text(p))):
        bag[t] += 1
    return bag


def cos(bag_a, bag_b):
    if not bag_a or not bag_b:
        return 0.0
    common = set(bag_a) & set(bag_b)
    num = sum(bag_a[t] * bag_b[t] for t in common)
    da = math.sqrt(sum(v * v for v in bag_a.values()))
    db = math.sqrt(sum(v * v for v in bag_b.values()))
    return num / (da * db) if da and db else 0.0


def norm_title(s):
    """Lower-cased title with bracketed glosses, LaTeX and punctuation removed:
    "菲克第一定律（Fick's first law）的数学表达式" -> "菲克第一定律的数学表达式"."""
    t = BRACKETED.sub("", str(s or "").lower())
    t = re.sub(r"\$[^$]*\$", "", t)          # inline LaTeX
    t = re.sub(r"[^\w\u4e00-\u9fff]+", "", t)
    return t


CONNECT = re.compile(r"[的与和及或者是了]")


def loose_title(s):
    """Title without the filler connectives, for prefix/substring tests:
    "Hodgkin和Katz的海水取代实验" and "Hodgkin和Katz海水取代实验：氯化胆碱…" line up."""
    return CONNECT.sub("", s)


def edit_within(a, b, k=2):
    """True when a and b are within k edits — i.e. the same title with one or two
    characters swapped. Those are contrastive labels (Aα/Aβ fibres, 谷氨酸/赖氨酸,
    细胞 vs 细胞器 level), never duplicates."""
    if abs(len(a) - len(b)) > k:
        return False
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1] <= k


def near_identical_titles(a, b):
    return bool(a) and edit_within(a, b, 2)


def body_richness(p):
    return (
        len(explanation_text(p.get("explanation"))),
        len(p.get("keyTerms") or []),
        len(str(p.get("title") or "")),
    )


def slide_num(p):
    """Slide number as an int, or None. Older lessons store ranges ("45-46")."""
    raw = (p or {}).get("slide")
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        m = re.match(r"\s*(\d+)", str(raw))
        return int(m.group(1)) if m else None


def keep_text(p):
    """Everything the surviving point will still show, as one normalised string."""
    parts = [str(p.get("title") or ""), explanation_text(p.get("explanation")), keyterms_text(p)]
    return re.sub(r"[^\w\u4e00-\u9fff]+", "", " ".join(parts).lower())


def coverage(drop, keep, include_body=False):
    """Share of the dropped point's own terms that the surviving point already
    states — the safety check on every merge.

    Probes are the dropped point's title and key terms, plus (optionally) the
    words of its explanation. Body words matter for merges decided by title
    shape alone: "Superior mesenteric artery (SMA) supply" and "Left colic,
    sigmoid and superior rectal arteries supply to colon" share the words
    artery/supply, yet they describe two different arterial territories, so the
    merge is only safe if the keeper's text mentions jejunum/ileum/cecum.
    """
    probes = set(terms(drop.get("title"))) | set(terms(keyterms_text(drop)))
    if include_body:
        probes |= set(terms(explanation_text(drop.get("explanation"))))
    if not probes:
        return 1.0
    hay = keep_text(keep)
    return sum(1 for t in probes if t in hay) / len(probes)


# ------------------------------------------------------------------- the rules
COV_MIN = 0.60          # share of the dropped point's terms the keeper must already state


def pair_verdict(a, b, bag_a, bag_b):
    """Return (drop, keep, reason) for two points, or None if they are distinct."""
    ta, tb = str(a.get("title") or ""), str(b.get("title") or "")
    na, nb = norm_title(ta), norm_title(tb)
    if not na or not nb:
        return None
    sa, sb = slide_num(a), slide_num(b)
    if sa is not None and sb is not None and abs(sa - sb) > 2:
        return None                      # far apart in the lecture: not a copy

    if na == nb:
        return (b, a, "标题归一化后相同")

    sim = cos(bag_a, bag_b)
    contrastive = near_identical_titles(na, nb)
    short, long_ = (a, b) if len(na) <= len(nb) else (b, a)
    ns, nl = (na, nb) if len(na) <= len(nb) else (nb, na)
    ls, ll = loose_title(ns), loose_title(nl)

    if not contrastive:
        # "基强度" ⊂ "基强度与时值…"; "Hodgkin和Katz的海水取代实验" ⊂ the same title
        # spelled without 的. The short title adds nothing the long one lacks.
        if len(ls) >= 2 and ll.startswith(ls) and len(ls) / len(ll) >= 0.35 and sim >= 0.50:
            return _safe(short, long_, f"标题是对方的前缀（内容相似度 {sim:.2f}）")
        if len(ls) >= 3 and ls in ll and sim >= 0.60:
            return _safe(short, long_, f"标题被对方包含（内容相似度 {sim:.2f}）")
        # Same wording, one or two characters of extra detail ("…的调节" vs
        # "…的调节机制"): keep the copy whose title covers both, if it also
        # states what the other one says. The bar is high on purpose — the
        # parallel "细胞器/细胞/组织层次的分析框架" points differ by one word and
        # sit at ~0.70, and those are three separate topics.
        contain = len(set(ns) & set(nl)) / len(set(ns)) if ns else 0.0
        if sim >= 0.80 and contain >= 0.85:
            return _safe(short, long_, f"标题与内容几乎重合（相似度 {sim:.2f}）")

    return None


def _safe(drop, keep, why):
    """Same guard the AI merges go through: never delete a point whose own terms
    the surviving one does not state (谷氨酸与赖氨酸… must not fold into 谷氨酸…,
    SMA territory must not fold into the IMA territory)."""
    if drop is keep or coverage(drop, keep, include_body=True) < COV_MIN:
        return None
    return (drop, keep, why)


def dedupe_points(points):
    """Return (kept, drops) where drops maps the dropped point -> (kept point, reason)."""
    items = [p for p in (points or []) if isinstance(p, dict) and str(p.get("title") or "").strip()]
    bags = [point_bag(p) for p in items]
    dropped = {}
    for i in range(len(items)):
        if id(items[i]) in dropped:
            continue
        for j in range(i + 1, len(items)):
            if id(items[j]) in dropped:
                continue
            v = pair_verdict(items[i], items[j], bags[i], bags[j])
            if v:
                drop, keep, why = v
                dropped[id(drop)] = (keep, why)
    return [p for p in items if id(p) not in dropped], dropped


# ------------------------------------------------- AI review of the close calls
# The title-shape rules above are deliberately precise; what they cannot decide
# is a pair whose titles are worded differently but describe the same thing
# ("刺激的定义与电刺激的优势" vs "刺激（stimulation）的定义：能引发机体反应的内外
# 环境变化"). Those pairs are handed to the same model the app uses, in batches,
# and only the pairs it calls identical are merged. Candidates are pre-filtered
# by vocabulary overlap so the "call" stays cheap.
CAND_FLOOR = 0.40       # term-bag cosine needed to be worth asking about
LLM_BATCH = 20          # pairs per API call

JUDGE_SYS = (
    "You are curating the key points of a university lecture. A student deleted one of the two entries "
    "of a pair to remove a duplicate, and must not lose any fact by doing so.\n"
    "Call a pair DUPLICATE only when one entry is fully covered by the other: same knowledge point, "
    "re-worded, renamed, or the shorter one being a summary of the fuller one. Every fact in the entry "
    "that would be deleted must already be in the entry that survives.\n"
    "Call a pair DIFFERENT whenever the two entries each carry something the other does not — a topic "
    "split into complementary parts, a general point plus one specific detail of it, a named entity on "
    "its own, a second property/mechanism/example, a different slide's sub-topic, or anything merely "
    "related or adjacent. Contrastive siblings are always DIFFERENT: Aα / Aβ / Aγ / Aδ / B / C fibres, "
    "谷氨酸 vs 赖氨酸, 顺式 vs 反式, 细胞 vs 细胞器 vs 组织 level, TRPV1 vs TRPM8, α₁ vs β₂ receptors, "
    "different named drugs, structures, experiments or diseases. When in doubt, answer DIFFERENT."
)


def load_llm_config(db_path):
    """Same text model + key the app itself uses (data-pku/config.json)."""
    cfg = {}
    path = os.path.join(os.path.dirname(os.path.abspath(db_path)), "config.json")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as fh:
            cfg = (json.load(fh) or {}).get("text") or {}
    return {
        "base_url": cfg.get("base_url") or os.environ.get("REVISION_LLM_BASE_URL") or "https://api.deepseek.com",
        "model": cfg.get("model") or os.environ.get("REVISION_LLM_MODEL") or "deepseek-chat",
        "api_key": cfg.get("api_key") or os.environ.get("DEEPSEEK_API_KEY") or "",
    }


def call_llm(cfg, messages, max_tokens=2000, json_mode=True):
    if not cfg.get("api_key"):
        return {"error": "没有 API key：config.json 的 text.api_key 为空"}
    payload = {
        "model": cfg["model"],
        "messages": messages,
        "temperature": 0,
        "max_tokens": max_tokens,
        "stream": False,
    }
    if "api.deepseek.com" in (cfg.get("base_url") or "").lower():
        payload["thinking"] = {"type": "disabled"}
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    req = urllib.request.Request(
        cfg["base_url"].rstrip("/") + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + cfg["api_key"]},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        return {"content": body["choices"][0]["message"]["content"],
                "usage": (body.get("usage") or {}).get("total_tokens") or 0}
    except urllib.error.HTTPError as exc:
        try:
            err = json.loads(exc.read().decode("utf-8"))
            msg = (err.get("error") or {}).get("message") or str(err)
        except Exception:
            msg = str(exc)
        return {"error": "HTTP %s: %s" % (exc.code, msg)}
    except Exception as exc:                                     # noqa: BLE001
        return {"error": str(exc)}


def candidate_pairs(points, bags, floor=CAND_FLOOR, max_gap=0):
    """Pairs close enough in the lecture and in vocabulary to be worth judging.

    max_gap=0 keeps the AI review to points filed on the SAME slide: the two
    rounds a lesson accumulates always cover the same page, and widening it to
    neighbouring pages is what made the model pair up merely-related points
    ("易化扩散与转运体" with "通道介导的易化扩散速率极快").
    """
    out = []
    for i in range(len(points)):
        for j in range(i + 1, len(points)):
            si, sj = slide_num(points[i]), slide_num(points[j])
            if si is not None and sj is not None and abs(si - sj) > max_gap:
                continue
            score = cos(bags[i], bags[j])
            if score >= floor:
                out.append((score, i, j))
    out.sort(reverse=True)
    return out


def snippet(p, chars=320):
    body = explanation_text(p.get("explanation")).replace("\n", " ")
    body = re.sub(r"\s+", " ", body).strip()
    return body[:chars]


def judge_duplicates(cfg, lesson_title, points, pairs, verbose=True):
    """Ask the model which candidate pairs are the same knowledge point.
    Returns (same_pairs, used_tokens, errors)."""
    same, tokens, errors = set(), 0, []
    for start in range(0, len(pairs), LLM_BATCH):
        batch = pairs[start:start + LLM_BATCH]
        lines = []
        for n, (score, i, j) in enumerate(batch, 1):
            lines.append(
                f"[{n}] slide {points[i].get('slide')} | {points[i].get('title')}\n"
                f"    {snippet(points[i])}\n"
                f"[{n}] slide {points[j].get('slide')} | {points[j].get('title')}\n"
                f"    {snippet(points[j])}"
            )
        prompt = (
            f'Lecture: "{lesson_title}"\n\n'
            "Below are numbered pairs of key points from this lecture, with the full explanation of each. "
            "For every pair decide whether deleting one of the two would lose information. List the numbers "
            "of the pairs where the two entries are the SAME knowledge point (safe to delete one).\n\n"
            + "\n\n".join(lines)
            + '\n\nReturn JSON: {"duplicates":[1,4,...]}'
        )
        r = call_llm(cfg, [{"role": "system", "content": JUDGE_SYS}, {"role": "user", "content": prompt}])
        if r.get("error"):
            errors.append(r["error"])
            if verbose:
                print(f"      ! AI 复核失败（第 {start // LLM_BATCH + 1} 批）：{r['error']}")
            continue
        tokens += r.get("usage") or 0
        try:
            parsed = json.loads(re.search(r"\{.*\}", r["content"], re.S).group(0))
        except Exception:                                        # noqa: BLE001
            errors.append("返回内容无法解析")
            continue
        for n in (parsed.get("duplicates") or []):
            try:
                n = int(n)
            except (TypeError, ValueError):
                continue
            if 1 <= n <= len(batch):
                same.add((batch[n - 1][1], batch[n - 1][2]))
    return same, tokens, errors


def merge_confirmed(kept, same, drops):
    """Turn the confirmed pairs into actual merges, best match first.

    Pairs are taken greedily and never overlap, so a broad point cannot swallow
    three neighbours through a chain of half-matches (静息膜电位的测量 × 静息膜电位与
    离子平衡电位的关系 × 静息膜电位下Na⁺、K⁺均未处于平衡状态).

    The model's verdict is only accepted when one entry really does cover the
    other: at least COV_MIN of the shorter entry's own terms (title + key terms)
    must appear in the fuller entry's text. That is what keeps a merge from
    silently deleting a fact the surviving point never mentioned.
    """
    used = set()
    skipped = 0
    for i, j in sorted(same, key=lambda p: -cos(point_bag(kept[p[0]]), point_bag(kept[p[1]]))):
        if i in used or j in used:
            continue
        a, b = kept[i], kept[j]
        # Try both directions and keep whichever copy really contains the other.
        ab, ba = coverage(a, b), coverage(b, a)
        if max(ab, ba) < COV_MIN:
            skipped += 1
            continue
        drop, keep = (a, b) if (ab, body_richness(a)) >= (ba, body_richness(b)) else (b, a)
        if coverage(drop, keep) < COV_MIN:
            drop, keep = keep, drop
        drops[id(drop)] = (keep, f"AI 判定与「{str(keep.get('title'))[:30]}」是同一条")
        used.add(i)
        used.add(j)
    return [p for p in kept if id(p) not in drops], skipped


def merge_into(keep, drop):
    """Fold the dropped point's extras into the surviving one so nothing is lost."""
    for key in ("keyTerms", "tags"):
        merged = list(keep.get(key) or [])
        seen = {json.dumps(x, ensure_ascii=False) if not isinstance(x, str) else x for x in merged}
        for x in (drop.get(key) or []):
            k = x if isinstance(x, str) else json.dumps(x, ensure_ascii=False)
            if k not in seen:
                merged.append(x)
                seen.add(k)
        if merged:
            keep[key] = merged
    for key in ("mnemonic", "supplement", "en"):
        if not keep.get(key) and drop.get(key):
            keep[key] = drop[key]
    if len(drop.get("figures") or []) and isinstance(keep.get("figures"), list):
        keep["figures"] = list(keep["figures"]) + list(drop["figures"])
    if drop.get("importance") == "high" and keep.get("importance") != "high":
        keep["importance"] = "high"
    return keep


def terminal_index(points, drops, keep_id):
    """Follow the drop -> keep chain to the point that actually survives."""
    seen = set()
    while keep_id in drops and keep_id not in seen:
        seen.add(keep_id)
        keep_id = id(drops[keep_id][0])
    for idx, p in enumerate(points):
        if id(p) == keep_id:
            return idx
    return None


def drops_from_plan(points, entries):
    """Rebuild the {id(drop): (keep, reason)} map saved by --save-plan."""
    out = {}
    for e in entries:
        i, j = e.get("drop"), e.get("keep")
        if not isinstance(i, int) or not isinstance(j, int):
            continue
        if 0 <= i < len(points) and 0 <= j < len(points):
            out[id(points[i])] = (points[j], e.get("why") or "已确认重复")
    return out


# ------------------------------------------------------------------- backends
class DbBackend:
    """Read/write lessons straight from a store SQLite file."""

    def __init__(self, path):
        self.path = path
        self.conn = sqlite3.connect(path, timeout=15)

    def lessons(self):
        return self.conn.execute("SELECT id, data FROM records WHERE store='lessons'").fetchall()

    def save(self, lesson):
        self.conn.execute(
            "UPDATE records SET data=? WHERE store='lessons' AND id=?",
            (json.dumps(lesson, ensure_ascii=False, separators=(",", ":")), lesson["id"]),
        )
        self.conn.commit()

    def backup(self, tag):
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        bak = f"{self.path}.bak-{tag}-{stamp}"
        shutil.copy2(self.path, bak)
        return bak

    def close(self):
        self.conn.close()


class HttpBackend:
    """Legacy mode: read/write through the running server's API."""

    def __init__(self, base, password):
        import urllib.parse
        import urllib.request

        self._parse = urllib.parse
        self._request_lib = urllib.request
        self.base = base.rstrip("/")
        self.token = self._call("/api/auth/login", method="POST", payload={"password": password}).get("token")
        if not self.token:
            sys.exit("登录失败")

    def _call(self, path, method="GET", payload=None):
        headers = {}
        if getattr(self, "token", None):
            headers["Authorization"] = "Bearer " + self.token
        data = None
        if payload is not None:
            data = json.dumps(payload).encode()
            headers["Content-Type"] = "application/json"
        req = self._request_lib.Request(self.base + path, data=data, headers=headers, method=method)
        with self._request_lib.urlopen(req, timeout=300) as resp:
            body = resp.read().decode("utf-8", "replace")
        return json.loads(body) if body else {}

    def lessons(self):
        out = []
        for meta in self._call("/api/store/lessons").get("items", []):
            item = self._call("/api/store/lessons/" + self._parse.quote(meta["id"])).get("item")
            if item:
                out.append((item["id"], json.dumps(item, ensure_ascii=False)))
        return out

    def save(self, lesson):
        # Images live in their own store; strip the re-attached payloads so the
        # PUT body stays small and a stored payload is never nulled out.
        for sl in (lesson.get("slides") or []):
            for im in (sl.get("images") or []):
                if isinstance(im, dict):
                    im["dataUrl"] = None
        self._call("/api/store/lessons/" + self._parse.quote(lesson["id"]),
                   method="PUT", payload=lesson)

    def backup(self, tag):
        return None

    def close(self):
        pass


# ----------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="合并课程里重复的知识点（保留更完整的那条）")
    ap.add_argument("base", nargs="?", help="站点地址（HTTP 模式），如 http://127.0.0.1:8757")
    ap.add_argument("password", nargs="?", help="登录密码（HTTP 模式）")
    ap.add_argument("--db", help="直接读写 data.db（本地模式，自动备份）")
    ap.add_argument("--lesson", help="只处理某一门课（lesson id）")
    ap.add_argument("--title", help="只处理标题包含该子串的课程")
    ap.add_argument("--apply", action="store_true", help="真正写入（默认只预览）")
    ap.add_argument("--show", type=int, default=6, help="每门课最多列出几组（默认 6）")
    ap.add_argument("--llm", action="store_true", help="用配置文件里的模型复核标题不同的近似对")
    ap.add_argument("--save-plan", help="把合并方案写到 JSON，先不写库")
    ap.add_argument("--plan", help="读取 --save-plan 生成的方案（不再联网）")
    args = ap.parse_args()

    if args.db:
        backend = DbBackend(args.db)
    elif args.base and args.password:
        backend = HttpBackend(args.base, args.password)
    else:
        ap.error("请用 --db <data.db> 指定本地库，或给出 <站点地址> <密码>")

    plan = json.load(open(args.plan, encoding="utf-8")) if args.plan else {}
    plan_out = {}

    llm_cfg = load_llm_config(args.db) if (args.llm and args.db) else None
    if args.llm and not (llm_cfg or {}).get("api_key"):
        sys.exit("--llm 需要 config.json 里的 text.api_key（或环境变量 DEEPSEEK_API_KEY）")

    total_drop, touched, total_points = 0, 0, 0
    ai_tokens = 0
    backup = None
    for rid, raw in backend.lessons():
        lesson = json.loads(raw) if isinstance(raw, str) else raw
        if args.lesson and rid != args.lesson:
            continue
        if args.title and args.title not in (lesson.get("title") or ""):
            continue
        points = lesson.get("points") or []
        if len(points) < 2:
            continue
        if args.plan:
            entries = plan.get(rid) or []
            drops = drops_from_plan(points, entries)
            kept = [p for i, p in enumerate(points) if i not in {e["drop"] for e in entries}]
        else:
            kept, drops = dedupe_points(points)
        if llm_cfg and not args.plan:
            bags = [point_bag(p) for p in kept]
            pairs = candidate_pairs(kept, bags)
            print(f"  · {len(pairs)} 组候选交 AI 复核…")
            same, tokens, _ = judge_duplicates(llm_cfg, lesson.get("title") or "", kept, pairs)
            ai_tokens += tokens
            if same:
                kept, skipped = merge_confirmed(kept, same, drops)
                if skipped:
                    print(f"      （AI 判同一但内容各有独有细节，保留不合并 {skipped} 组）")
        if args.save_plan:
            # Record the resolved plan (drop index -> terminal keeper index).
            here = []
            for idx, p in enumerate(points):
                if id(p) in drops:
                    keep, why = drops[id(p)]
                    here.append({"drop": idx, "keep": terminal_index(points, drops, id(keep)), "why": why})
            if here:
                plan_out[rid] = here
        total_points += len(points)
        if not drops:
            print(f"  ✓ {(lesson.get('title') or '')[:46]:48s} {len(points)} 个，无重复")
            continue
        touched += 1
        total_drop += len(drops)
        print(f"\n★ {(lesson.get('title') or '')[:60]}  {len(points)} → {len(kept)}  （合并 {len(drops)} 条）")
        shown = 0
        for p in points:
            if id(p) in drops and shown < args.show:
                keep, why = drops[id(p)]
                print(f"    · {str(p.get('title'))[:46]:48s} → 并入「{str(keep.get('title'))[:40]}」")
                print(f"        {why}")
                shown += 1
        if len(drops) > shown:
            print(f"    …还有 {len(drops) - shown} 条同类重复")
        if args.apply:
            if backup is None:          # one backup, taken before the first write
                backup = backend.backup("pointdedupe")
                if backup:
                    print(f"\n  已备份 → {backup}")
            for p in points:
                if id(p) in drops:
                    merge_into(drops[id(p)][0], p)
            lesson["points"] = kept
            lesson["updatedAt"] = int(time.time() * 1000)
            backend.save(lesson)

    backend.close()

    if args.save_plan:
        with open(args.save_plan, "w", encoding="utf-8") as fh:
            json.dump(plan_out, fh, ensure_ascii=False, indent=1)
        print(f"\n方案已写入 {args.save_plan}")

    print(f"\n共 {total_points} 个知识点，{touched} 门课受影响，合并 {total_drop} 条"
          + ("（已写入）" if args.apply else "（预览模式，加 --apply 执行）"))
    if ai_tokens:
        print(f"AI 复核消耗 {ai_tokens} tokens")
    if backup:
        print(f"备份 → {backup}")


if __name__ == "__main__":
    main()
