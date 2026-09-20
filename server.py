#!/usr/bin/env python3
"""MBBS Revision — self-hosted study server.

Serves the frontend, parses uploaded PPTX/PDF files, proxies OpenAI-compatible
LLM calls (DeepSeek for text, Alibaba Bailian/Qwen-VL for vision), and persists
everything in a local SQLite database so multiple devices share one account.

Auth: a single password (set via PASSWORD env var or defaulted) guards every
/api/* endpoint. Sessions use HMAC-signed bearer tokens.

Run:  .venv/bin/python server.py
"""
import base64
import copy
import gzip
import hashlib
import hmac
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

import exporters
import pdf_parser
import ppt_parser
from store import Store

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(ROOT, "static")
# Data directory: defaults to <checkout>/data. Point REVISION_DATA_DIR at another
# directory to run a SECOND instance (different subjects, port and password) from
# the same checkout, each with its own database, keys and login.
DATA_DIR = os.environ.get("REVISION_DATA_DIR") or os.path.join(ROOT, "data")
CONFIG_PATH = os.path.join(DATA_DIR, "config.json")
DB_PATH = os.path.join(DATA_DIR, "data.db")
LEGACY_CONFIG = os.path.join(ROOT, "config.json")
CLASSIFICATION_PATH = os.path.join(DATA_DIR, "classification.json")
PORT = int(os.environ.get("PORT", "8756"))
HOST = os.environ.get("HOST", "0.0.0.0")

# Trial mode (TRIAL_MODE=1): the site opens for browsing without a password, so
# anyone with the URL can read the lessons, cards, quizzes and study settings.
# Everything that COSTS MONEY or CHANGES DATA stays behind the password —
# /api/llm and /api/vision bill the owner's own API key, and a public AI endpoint
# is a public wallet. Reads stay open; writes, exports and model listings do not.
def _env_flag(name):
    return (os.environ.get(name) or "").strip().lower() in ("1", "true", "yes", "on")

TRIAL_MODE = _env_flag("TRIAL_MODE")
# PDF compression presets. The full-page render dominates what gets stored, so
# DPI + JPEG quality are the real knob; cropped figures keep a little more detail.
# "high" means high COMPRESSION (smallest payload), not high quality.
PDF_QUALITY_PRESETS = {
    "high": {"dpi": 60, "quality": 62, "fig_dpi": 110, "fig_quality": 70, "fig_max_px": 1100},
    "medium": {"dpi": 90, "quality": 78, "fig_dpi": 160, "fig_quality": 84, "fig_max_px": 1600},
    "low": {"dpi": 130, "quality": 88, "fig_dpi": 200, "fig_quality": 90, "fig_max_px": 2000},
}

def _env_mb(name, default_mb):
    """Read a size limit (in MB) from the environment; fall back to the default."""
    try:
        v = float(os.environ.get(name) or 0)
    except (TypeError, ValueError):
        v = 0.0
    return int(v * 1024 * 1024) if v > 0 else default_mb * 1024 * 1024


# Uploaded file cap and JSON-body cap. A local instance can raise these (there is
# no cross-border link to cross) so a whole textbook can be sent in one piece;
# a hosted instance should keep the defaults.
MAX_UPLOAD = _env_mb("MAX_UPLOAD_MB", 150)
MAX_BODY = _env_mb("MAX_BODY_MB", 200)
TOKEN_TTL = 30 * 24 * 3600  # 30 days
LOGIN_WINDOW_SEC = 300
LOGIN_MAX_FAILURES = 10

DEFAULT_PASSWORD = "mbbs1234"

# Some OpenAI-compatible gateways (e.g. OpenCode Go) sit behind a WAF that
# rejects bare programmatic requests with HTTP 403 error 1010 unless they at
# least look like a browser. These headers fix that.
DEFAULT_LLM_HEADERS = {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) MBBS-Revision",
    "HTTP-Referer": "https://opencode.ai",
    "X-Title": "MBBS Revision",
}

# ---------------------------------------------------------------------------
# Study profiles
# ---------------------------------------------------------------------------
# What the site is *for*. The generation prompts are built from this instead of
# hard-coded medical wording, so one checkout can serve a medicine programme and
# a science programme at once (each instance picks a preset and may then edit it).
#
# Each subject carries:
#   focus    - the extraction dimensions that replace the old hard-coded medical
#              list ("anatomy, pathology, clinical features, ..."). This is what
#              makes the notes specific to the discipline.
#   keywords - matched (case-insensitively) against a lesson title to bind it to
#              this subject automatically. The LONGEST match wins, so put a more
#              specific subject's keywords first when they overlap.
STUDY_PRESETS = {
    "mbbs": {
        "label": "医学 (MBBS)",
        "site_title": "MBBS Revision",
        "site_sub": "Active Recall · Spaced Repetition",
        "learner": "a medical student",
        "language": "en",
        "subjects": [
            {
                "id": "general",
                "name": "Medicine",
                "keywords": [],
                "focus": "anatomy, physiology, pathology, clinical features and signs, investigations, diagnosis and differential, treatment and management",
                "quiz": "Favour CLINICAL items: a short vignette with findings, then ask for the most likely diagnosis, the next best investigation, the mechanism behind a sign, or the first-line management. Keep the vignette to facts stated in the key points.",
                "notes": "Record mechanisms, the distinguishing features of each condition, and the clinical consequence. Keep drug classes, doses and named investigations with the exact wording and numbers the slides give.",
            },
        ],
    },
    "pku-sciences": {
        "label": "北大理科课程 (PKU Sciences)",
        "site_title": "PKU Revision",
        "site_sub": "北大课程复习 · Active Recall",
        "learner": "an undergraduate science student at Peking University",
        "language": "bilingual",
        "subjects": [
            {
                "id": "physiology-lab",
                "name": "生理学实验",
                "keywords": ["生理学实验", "生理实验"],
                "focus": "experimental design and rationale, preparation and recording techniques, measured variables with units and typical values, data analysis and calculations, sources of error and artefacts, physiological interpretation of the traces",
                "quiz": "Favour EXPERIMENTAL items: given a setup or a recording, ask what it measures, what the expected trace looks like, which variable is held constant, or which conclusion the data actually support. Include error/artefact questions and unit or dimension checks.",
                "notes": "Record the experimental principle, the preparation and apparatus, the variable measured with its unit and typical range, the expected result, and the main sources of error or artefact.",
            },
            {
                "id": "physiology",
                "name": "生理学",
                "keywords": ["生理"],
                "focus": "organ-system mechanisms, regulation and feedback loops, homeostasis, membrane transport and signalling, quantitative relationships and typical values",
                "quiz": "Favour MECHANISM and REGULATION items: trace a cause-effect chain, predict the effect of blocking or stimulating a step, or identify the feedback loop and its rate-limiting factor. Include quantitative items wherever the slides give numbers (membrane potentials, flows, clearances, concentrations).",
                "notes": "For each mechanism, record the chain of steps, what regulates it, and the direction of the effect. Keep typical numerical values with units, and state which compartment or condition they apply to.",
            },
            {
                "id": "quant-mol-bio",
                "name": "定量分子生物学",
                "keywords": ["定量分子"],
                "focus": "quantitative models and the assumptions behind them, rate equations and parameter values, orders of magnitude, measurement methods and their limits, model predictions versus experiment",
                "quiz": "CALCULATION-heavy: give concrete parameter values and ask for a computed rate, concentration, ratio or timescale; or check whether a stated prediction follows from the model; or ask which assumption a result depends on. Avoid vocabulary-recall and definition questions. For each numeric distractor, make it the result of a SPECIFIC mistake (wrong formula, dropped factor, inverted ratio, unit slip) so the explanation can name the error.",
                "notes": "For every equation, state what each symbol means, its units, a typical value, and the assumptions the model makes. Give one worked numeric example wherever the slides supply numbers.",
            },
            {
                "id": "biochemistry",
                "name": "生物化学",
                "keywords": ["生物化学", "生化"],
                "focus": "metabolic pathways and their regulation, enzyme kinetics and catalytic mechanisms, structure-function relationships, energetics and cofactors, inhibitors and experimental perturbations",
                "quiz": "Favour PATHWAY and ENZYME items: order or branch the steps of a pathway, identify its regulated step, predict the effect of an inhibitor or a mutation, name the required cofactor/coenzyme, or compute an energetic or kinetic quantity. Make distractors the results of typical mix-ups (wrong cofactor, wrong direction, wrong compartment, inhibition type confused with another).",
                "notes": "For each pathway, record the sequence of steps, the enzyme and cofactor at each step, the regulated (rate-limiting) step and its regulators, and the energy or redox balance.",
            },
            {
                "id": "ai-seminar",
                "name": "AI初级研讨班",
                "keywords": ["AI", "人工智能", "研讨"],
                "focus": "core concepts and definitions, methods and model architectures, the problem each approach solves, assumptions and limitations, the central claims and evidence of the assigned readings",
                "quiz": "CONCEPTUAL only — do not ask for calculations. Favour discrimination items: contrast two methods or architectures, identify the problem a method was designed to solve, spot the unstated assumption, or judge which claim the evidence actually supports.",
                "notes": "For each method or claim, record the problem it addresses, the core idea, its assumptions, what it does better or worse than the alternatives, and the limitation the reading itself admits.",
            },
            {
                "id": "virology",
                "name": "病毒学前沿",
                "keywords": ["病毒"],
                "focus": "virus structure and classification, replication-cycle steps, host interactions and immune evasion, pathogenesis, antiviral and vaccine targets, current research frontiers",
                "quiz": "Favour STRUCTURE and REPLICATION-CYCLE items: order the steps of the cycle, match a protein or structure to its function, identify the host factor or immune-evasion mechanism, or name the step an antiviral or vaccine targets.",
                "notes": "For each virus or mechanism, record the genome type and structure, the replication-cycle steps in order, the host interactions and evasion strategies, and the antiviral or vaccine target.",
            },
            {
                "id": "phys-chem-cmb",
                "name": "细胞分子生物学中的物理化学",
                "keywords": ["物理化学"],
                "focus": "thermodynamics and free energy, binding equilibria and kinetics, molecular forces and energetics, diffusion and transport, quantitative modelling of cellular processes",
                "quiz": "Favour DERIVATION and CALCULATION items: apply a thermodynamic or kinetic relation to given values, compute a free-energy change, binding fraction or diffusion time, or identify the condition under which an approximation holds. Make each numeric distractor the outcome of a specific error (sign flip, missing RT factor, wrong unit, approximation used outside its range).",
                "notes": "For each relation, record the formula, the assumptions it requires, the units of every term, and a typical order of magnitude. Show one worked numeric application.",
            },
            {
                "id": "general",
                "name": "通用",
                "keywords": [],
                "focus": "core concepts and definitions, mechanisms, key facts and quantities, and the relationships between them",
                "quiz": "",
                "notes": "",
            },
        ],
    },
}


# Fast lookup of the built-in definition for a subject id. A saved config only
# carries the fields the user edited, so new built-in fields (quiz, notes, ...)
# are back-filled from here instead of being lost on the next load.
# Keyed by (preset id, subject id): two presets may reuse an id ("general")
# with different rules, so a flat map would let one preset's subject leak into
# the other's config.
BUILTIN_SUBJECTS = {
    (_pid, _subj["id"]): _subj
    for _pid, _preset in STUDY_PRESETS.items()
    for _subj in _preset["subjects"]
}


DEFAULT_CONFIG = {
    "secret": "",
    "password_hash": "",
    "goal_minutes": 30,
    "new_cards_per_day": 20,
    "new_points_per_day": 15,
    "drive_folder_id": "",
    "drive_proxy": "",
    "study": {
        "preset": "mbbs",
        "site_title": STUDY_PRESETS["mbbs"]["site_title"],
        "site_sub": STUDY_PRESETS["mbbs"]["site_sub"],
        "learner": STUDY_PRESETS["mbbs"]["learner"],
        "language": STUDY_PRESETS["mbbs"]["language"],
        "auto_subject": True,
        "subjects": STUDY_PRESETS["mbbs"]["subjects"],
    },
    "text": {
        "base_url": "https://api.deepseek.com",
        "model": "deepseek-flash",
        "api_key": "",
    },
    "vision": {
        "base_url": "https://api.deepseek.com",
        "model": "deepseek-flash",
        "api_key": "",
    },
    "vision_active": "deepseek",
    "vision_presets": {
        "bailian": {
            "label": "Qwen (阿里百炼)",
            "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "model": "qwen3.7-plus",
            "api_key": "",
        },
        "deepseek": {
            "label": "DeepSeek 官方 Flash (原生多模态)",
            "base_url": "https://api.deepseek.com",
            "model": "deepseek-flash",
            "api_key": "",
        },
        "opencode": {
            "label": "opencode 代理 V4 Vision (共用 text key)",
            "base_url": "https://opencode.ai/zen/go/v1",
            "model": "deepseek-v4-flash-vision-exp",
            "api_key": "",
            "share_text_key": True,
        },
    },
}


def resolve_vision(cfg):
    """Return the config of the ACTIVE vision provider (backward-compatible).

    Config stores named presets (vision_presets) plus an active id (vision_active).
    cfg['vision'] is kept in sync as the active provider so existing callers
    (call_llm, /api/models?role=vision) keep working untouched.

    Presets flagged ``share_text_key`` (e.g. the opencode proxy) inherit the
    text provider's API key when their own is blank, so text + vision can run
    through one endpoint with a single shared key.
    """
    presets = cfg.get("vision_presets") or {}
    active = cfg.get("vision_active") or "bailian"
    preset = presets.get(active) or cfg.get("vision") or {}
    merged = {**DEFAULT_CONFIG["vision"], **preset}
    if preset.get("share_text_key") and not merged.get("api_key"):
        merged["api_key"] = (cfg.get("text") or {}).get("api_key") or ""
    merged["_id"] = active
    return merged


def default_classification():
    """Default user classification: categories + per-lesson manual overrides."""
    return {"categories": [], "manual": {}}


def load_classification():
    """Return the user classification config (categories + manual overrides)."""
    try:
        with open(CLASSIFICATION_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            cats = data.get("categories") or []
            if isinstance(cats, list):
                data["categories"] = [c for c in cats if isinstance(c, dict)]
            else:
                data["categories"] = []
            manual = data.get("manual") or {}
            data["manual"] = manual if isinstance(manual, dict) else {}
            return data
    except (OSError, ValueError):
        pass
    return default_classification()


def save_classification(data):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = CLASSIFICATION_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, CLASSIFICATION_PATH)

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".map": "application/json",
}


def parse_page_set(spec):
    """Parse "1-20, 30, 40-45" into a set of page numbers (None when empty).

    Accepts full-width commas, whitespace and the CJK range words 至/到; a
    reversed range is normalised. Used to slice a PDF before rendering it, so
    unwanted pages are never rasterised.
    """
    text = str(spec or "").strip()
    if not text:
        return None
    out = set()
    for part in re.split(r"[,，;；\s]+", text):
        if not part:
            continue
        m = re.match(r"^(\d+)\s*[-–—~至到]\s*(\d+)$", part)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            if a > b:
                a, b = b, a
            out.update(range(max(1, a), b + 1))
        elif part.isdigit():
            n = int(part)
            if n >= 1:
                out.add(n)
    return out or None


def pdf_options_from_headers(headers):
    """Resolve the optional PDF parse tuning from request headers."""
    def num(name, default, lo, hi):
        try:
            v = int(headers.get(name) or 0)
        except (TypeError, ValueError):
            return default
        return v if lo <= v <= hi else default
    compress = str(headers.get("X-Pdf-Compress") or "medium").strip().lower()
    preset = dict(PDF_QUALITY_PRESETS.get(compress, PDF_QUALITY_PRESETS["medium"]))
    preset["dpi"] = num("X-Parse-Dpi", preset["dpi"], 40, 300)
    preset["quality"] = num("X-Parse-Quality", preset["quality"], 30, 95)
    return preset


def sha256(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


_CONFIG_LOCK = threading.Lock()
_CONFIG = None


def load_config():
    """Return the shared config, loading from disk only once (thread-safe)."""
    global _CONFIG
    with _CONFIG_LOCK:
        if _CONFIG is None:
            _CONFIG = _load_config_uncached()
        return _CONFIG


def _load_config_uncached():
    os.makedirs(DATA_DIR, exist_ok=True)
    cfg = None
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
                cfg = json.load(fh)
        except Exception:
            cfg = None

    merged = json.loads(json.dumps(DEFAULT_CONFIG))
    if cfg:
        for key in ("text", "vision"):
            merged[key] = {**DEFAULT_CONFIG[key], **(cfg.get(key) or {})}
        # Preserve named vision presets + active pointer (added for the
        # Bailian <-> DeepSeek vision switcher). If the file only has the legacy
        # single `vision` object, seed the bailian preset from it so key is kept.
        presets = cfg.get("vision_presets") or {}
        # Always union in the built-in presets so newly added providers (e.g.
        # 'opencode') appear even on configs that predate them.
        merged["vision_presets"] = {
            pid: {**DEFAULT_CONFIG["vision"], **(p or {})}
            for pid, p in {**DEFAULT_CONFIG.get("vision_presets", {}), **presets}.items()
        }
        if not cfg.get("vision_presets") and (cfg.get("vision") or {}).get("api_key"):
            # Legacy single-vision config: keep the existing key on the bailian preset.
            merged["vision_presets"]["bailian"] = {
                **DEFAULT_CONFIG["vision"], **{k: v for k, v in (cfg.get("vision") or {}).items() if v}
            }
        if cfg.get("vision_active"):
            merged["vision_active"] = cfg["vision_active"]
        # Keep cfg['vision'] in sync with the ACTIVE preset (resolving shared key).
        active = merged.get("vision_active") or "bailian"
        merged["vision"] = resolve_vision(merged)
        merged["secret"] = cfg.get("secret") or merged["secret"]
        merged["password_hash"] = cfg.get("password_hash") or merged["password_hash"]
        try:
            merged["goal_minutes"] = int(cfg.get("goal_minutes") or 30)
        except (TypeError, ValueError):
            merged["goal_minutes"] = 30
        try:
            merged["new_cards_per_day"] = int(cfg.get("new_cards_per_day") or 20)
        except (TypeError, ValueError):
            merged["new_cards_per_day"] = 20
        try:
            merged["new_points_per_day"] = int(cfg.get("new_points_per_day") or 15)
        except (TypeError, ValueError):
            merged["new_points_per_day"] = 15
        merged["drive_folder_id"] = cfg.get("drive_folder_id", "") or ""
        merged["drive_proxy"] = cfg.get("drive_proxy", "") or ""
        # Study profile: keep the built-in shape as the fallback, then layer the
        # saved section on top. `subjects` replaces the preset wholesale when the
        # file carries a non-empty list, so an edited subject set survives.
        saved_study = cfg.get("study") or {}
        study = {**DEFAULT_CONFIG["study"], **{k: v for k, v in saved_study.items() if k != "subjects"}}
        if isinstance(saved_study.get("subjects"), list) and saved_study["subjects"]:
            merged_subjects = []
            for subj in saved_study["subjects"]:
                if not (isinstance(subj, dict) and subj.get("id")):
                    continue
                # Built-in definition first, saved values on top: a config saved
                # before a field existed still picks up its new default.
                builtin = BUILTIN_SUBJECTS.get((study.get("preset") or "", subj["id"]), {})
                merged_subjects.append({**builtin, **subj})
            if merged_subjects:
                study["subjects"] = merged_subjects
        if not study["subjects"]:
            study["subjects"] = DEFAULT_CONFIG["study"]["subjects"]
        merged["study"] = study
    else:
        # Migrate legacy root config.json (API keys) if present
        if os.path.exists(LEGACY_CONFIG):
            try:
                with open(LEGACY_CONFIG, "r", encoding="utf-8") as fh:
                    legacy = json.load(fh)
                for key in ("text", "vision"):
                    merged[key] = {**DEFAULT_CONFIG[key], **(legacy.get(key) or {})}
            except Exception:
                pass

    changed = False
    if not merged["secret"]:
        merged["secret"] = base64.urlsafe_b64encode(os.urandom(32)).decode("ascii")
        changed = True
    if not merged["password_hash"]:
        if os.environ.get("PASSWORD"):
            merged["password_hash"] = sha256(os.environ["PASSWORD"])
        else:
            merged["password_hash"] = sha256(DEFAULT_PASSWORD)
            print("*** WARNING: using default password '%s' — change it in Settings. ***" % DEFAULT_PASSWORD)
        changed = True

    # Allow API keys to be injected via environment variables (for cloud deploy
    # like Render) so we never ship a key-bearing config.json. Prefer env over file.
    env_key_map = {
        "TEXT_API_KEY": ("text", "api_key"),
        "VISION_API_KEY": ("vision", "api_key"),
        "OPENCODE_API_KEY": None,  # handled below
    }
    for env_name, loc in env_key_map.items():
        v = os.environ.get(env_name)
        if v and loc:
            merged[loc[0]][loc[1]] = v
            if merged["text"].get("base_url", "").rstrip("/").endswith("opencode.ai") and merged["vision"].get("base_url", "").rstrip("/").endswith("opencode.ai"):
                # share the injected text key with vision if they share the proxy
                if env_name == "TEXT_API_KEY":
                    merged["vision"]["api_key"] = v
            changed = True
    # A single key that applies to both supported providers on the opencode proxy.
    if os.environ.get("OPENCODE_API_KEY") and env_key_map["OPENCODE_API_KEY"] is None:
        merged["text"]["api_key"] = os.environ["OPENCODE_API_KEY"]
        merged["vision"]["api_key"] = os.environ["OPENCODE_API_KEY"]
        changed = True

    if changed or cfg is None:
        _write_config(merged)
    return merged


def _write_config(cfg):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, ensure_ascii=False, indent=2)
        fh.flush()
        os.fsync(fh.fileno())
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, CONFIG_PATH)
    try:
        os.chmod(CONFIG_PATH, 0o600)
    except OSError:
        pass


def save_config(cfg):
    global _CONFIG
    with _CONFIG_LOCK:
        _write_config(cfg)
        _CONFIG = cfg


def effective_password_hash(cfg):
    env_pw = os.environ.get("PASSWORD")
    if env_pw:
        return sha256(env_pw)
    return cfg.get("password_hash") or sha256(DEFAULT_PASSWORD)


def passwords_equal(a, b):
    """Constant-time digest comparison (both inputs are hex digests)."""
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


# In-memory brute-force backoff: keyed by client IP. Small, per-process, and
# enough to slow down online password guessing.
_LOGIN_FAIL_LOCK = threading.Lock()
_LOGIN_FAILURES = {}


def login_blocked(client_ip, now=None):
    now = now or time.time()
    with _LOGIN_FAIL_LOCK:
        fails, first = _LOGIN_FAILURES.get(client_ip, (0, now))
        if now - first >= LOGIN_WINDOW_SEC:
            _LOGIN_FAILURES.pop(client_ip, None)
            return 0
        if fails >= LOGIN_MAX_FAILURES:
            return max(1, LOGIN_WINDOW_SEC - int(now - first))
        return 0


def login_record_failure(client_ip, now=None):
    now = now or time.time()
    with _LOGIN_FAIL_LOCK:
        fails, first = _LOGIN_FAILURES.get(client_ip, (0, now))
        if now - first >= LOGIN_WINDOW_SEC:
            fails, first = 0, now
        _LOGIN_FAILURES[client_ip] = (fails + 1, first)


def login_clear(client_ip):
    with _LOGIN_FAIL_LOCK:
        _LOGIN_FAILURES.pop(client_ip, None)


def mask_key(key):
    if not key:
        return ""
    return ("*" * max(0, len(key) - 4)) + key[-4:] if len(key) > 4 else "****"


def slim_lesson(rec, lite=False):
    """Drop the fields that only the per-lesson views read.

    Measured on the real 258-lesson library, these are 39% of the list payload:
    figure captions (3.7 MB), figure crop geometry (3.4 MB), point key terms
    (1.4 MB), supplements and the topic outline. Every one of them is rendered only
    inside a lesson — and opening a lesson fetches /api/store/lessons/<id>, which is
    untouched — so the list can shed them.

    Deliberately KEPT, because list-level views read them: point explanations and
    slide text (full-text search), mnemonic and tags (search), point titles and
    categories (knowledge tree, mastery), and each image's kind/name (the page image
    is found by kind === 'page').

    `lite=True` goes one step further and drops the two fields that only the search,
    review and formula-library views read: the point explanations and the slide text.
    Those three views ask for the full list themselves, so the everyday payload —
    dashboard, lesson list, knowledge tree, progress, badges — carries neither. On
    the real library that is 3.8 MB of gzipped JSON down to 1.1 MB, which matters a
    great deal when the instance is stuck on a slow public link.
    """
    if not isinstance(rec, dict):
        return rec
    out = dict(rec)
    out.pop("outline", None)
    slides = []
    for s in rec.get("slides") or []:
        if not isinstance(s, dict):
            slides.append(s)
            continue
        s2 = dict(s)
        s2.pop("notes", None)
        if lite:
            s2.pop("text", None)
        imgs = []
        for im in s.get("images") or []:
            if not isinstance(im, dict):
                imgs.append(im)
                continue
            # Crop geometry and captions belong to the points/slides tabs.
            imgs.append({k: v for k, v in im.items() if k not in ("caption", "x", "y", "w", "h")})
        s2["images"] = imgs
        slides.append(s2)
    out["slides"] = slides
    points = []
    for p in rec.get("points") or []:
        if not isinstance(p, dict):
            points.append(p)
            continue
        skip = {"keyTerms", "supplement"} | ({"explanation"} if lite else set())
        points.append({k: v for k, v in p.items() if k not in skip})
    out["points"] = points
    return out


# Card fields the list-level views actually read: the scheduler needs the timing
# state, the mastery maths needs interval/reps, and the queue needs the lesson.
# front/back are the card's content and are read only by the review screen, the
# full-text search and the flashcards tab (which fetches per lesson).
CARD_LITE_FIELDS = ("id", "lessonId", "ease", "interval", "reps", "lapses", "due",
                    "createdAt", "newDoneAt", "lastReviewed")


def slim_card(rec, lite=False):
    """Keep only the scheduling fields of a card for list-level views (1.4 MB -> 0.3 MB)."""
    if not lite or not isinstance(rec, dict):
        return rec
    return {k: rec[k] for k in CARD_LITE_FIELDS if k in rec}


def slim_quiz(rec):
    """Reduce a quiz record to what list-level views ask of it.

    The dashboard, the lessons list, the knowledge tree and the progress page all
    only rank quizzes by score and count their questions, yet every question — stem,
    four options and an explanation — travelled with every page load: 18.6 MB of the
    258-lesson library. The question bank itself is fetched per lesson by the Quiz
    tab, and the backup export uses ?full=1, so both keep the real thing.
    """
    if not isinstance(rec, dict):
        return rec
    return {
        "id": rec.get("id"),
        "lessonId": rec.get("lessonId"),
        "createdAt": rec.get("createdAt"),
        "score": rec.get("score"),
        "completed": rec.get("completed"),
        "lastTaken": rec.get("lastTaken"),
        "questionCount": len(rec.get("questions") or []),
    }


def lighten_lesson(rec):
    """Return a lesson record without base64 image payloads.

    List pages (dashboard, review queue, search, navigation) only need
    points/slide text/titles. Sending the embedded page/figure images there
    is what made /api/store/lessons return ~40 MB on every navigation.
    """
    if not isinstance(rec, dict) or rec.get("kind") not in ("pdf", "pptx"):
        return rec
    # After the image offload the records carry no base64 payloads, so the
    # (expensive) deepcopy below would be pure waste on a 3.6 MB lesson list.
    # Only deepcopy when we actually need to null out an image dataUrl.
    if not any(
        (im.get("dataUrl") for s in rec.get("slides") or [] for im in s.get("images") or [] if isinstance(im, dict))
    ) and not any(
        (f.get("dataUrl") for p in rec.get("points") or [] for f in (p or {}).get("figures") or [] if isinstance(f, dict))
    ):
        return rec
    out = copy.deepcopy(rec)
    for slide in out.get("slides") or []:
        for img in slide.get("images") or []:
            if isinstance(img, dict):
                img["dataUrl"] = None
    # Manually inserted point figures must not ride along on list responses either.
    for p in out.get("points") or []:
        for fig in (p or {}).get("figures") or []:
            if isinstance(fig, dict):
                fig["dataUrl"] = None
    return out


def _is_top_right(im):
    """True if the image is a small box in the top-right corner.

    Coordinates are normalized fractions (0-1) already computed by the parsers.
    School logos typically sit in the top-right, are fairly small, and repeat
    on every page.
    """
    for k in ("x", "y", "w", "h"):
        if im.get(k) is None:
            return False
    cx = im["x"] + im["w"] / 2.0
    cy = im["y"] + im["h"] / 2.0
    return cx >= 0.62 and cy <= 0.32 and im["w"] <= 0.30 and im["h"] <= 0.30


def _mark_logos(parsed):
    """Flag repeated "page furniture" images (school logos, watermarks,
    footers) so they are never shown as study figures.

    Two signals:
      * the same image content appears on many slides (fingerprint), and
      * the image sits in the top-right corner (typical school logo).
    A repeated top-right image is almost certainly a logo. A repeated image
    that appears on >50% of slides is also flagged (top-left logos, footer
    watermarks, etc.), even if it isn't in the top-right corner.
    """
    if not isinstance(parsed, dict):
        return parsed
    slides = parsed.get("slides") or []
    n = len(slides)
    if n < 2:
        return parsed
    repeat_threshold = max(3, int(n * 0.3))
    heavy_threshold = max(3, int(n * 0.5))
    counts = {}
    for s in slides:
        seen = set()
        for im in s.get("images") or []:
            if not isinstance(im, dict) or im.get("kind") == "page" or not im.get("dataUrl"):
                continue
            h = hashlib.sha1(im["dataUrl"].encode("utf-8")).hexdigest()
            if h in seen:
                continue
            seen.add(h)
            counts[h] = counts.get(h, 0) + 1
    for s in slides:
        for im in s.get("images") or []:
            if not isinstance(im, dict) or im.get("kind") == "page" or not im.get("dataUrl"):
                continue
            h = hashlib.sha1(im["dataUrl"].encode("utf-8")).hexdigest()
            repeats = counts.get(h, 0)
            if repeats >= heavy_threshold or (repeats >= repeat_threshold and _is_top_right(im)):
                im["kind"] = "logo"
    return parsed


def merge_lesson_images(existing, incoming):
    """Restore image payloads on PUT when the client saved a light lesson.

    Review grading updates a whole lesson record but the queue was built from
    the light list endpoint, so incoming slides have dataUrl=None. Fill those
    fields back in from the stored record instead of overwriting them.
    """
    if not isinstance(existing, dict) or not isinstance(incoming, dict):
        return incoming
    old_slides = existing.get("slides") or []
    for i, slide in enumerate(incoming.get("slides") or []):
        old_slide = old_slides[i] if i < len(old_slides) else None
        old_images = (old_slide or {}).get("images") or []
        for j, img in enumerate(slide.get("images") or []):
            if isinstance(img, dict) and not img.get("dataUrl") and j < len(old_images):
                old_data = (old_images[j] or {}).get("dataUrl")
                if old_data:
                    img["dataUrl"] = old_data
    return incoming


def _has_image_payload(lesson):
    """True if any slide image OR manually inserted point figure carries a dataUrl."""
    for slide in (lesson or {}).get("slides") or []:
        for im in slide.get("images") or []:
            if isinstance(im, dict) and im.get("dataUrl"):
                return True
    for p in (lesson or {}).get("points") or []:
        for fig in (p or {}).get("figures") or []:
            if isinstance(fig, dict) and fig.get("dataUrl"):
                return True
    return False


def _strip_lesson_images(lesson):
    """Move a lesson's base64 image payloads into the 'lessonImages' store and
    null the dataUrl fields on the lesson record itself.

    Called when a lesson is saved/imported ALREADY carrying image payloads
    (a full lesson from parsing or a full edit). Keeps the 'lessons' store
    light so listing it no longer reads megabytes of base64.

    Covers both the auto-extracted slide images and the figures a user inserts by
    hand onto a knowledge point. Point figures are keyed by their own id (not by
    index), so editing points later cannot mis-associate a stored payload.
    """
    if not _has_image_payload(lesson):
        return lesson  # already-light update; leave lessonsImages untouched
    lid = lesson.get("id") or ""
    prev = get_store().get("lessonImages", lid)
    prev = prev if isinstance(prev, dict) else {}
    img_record = {"id": lid, "lessonId": lid, "slides": [], "pointFigures": dict(prev.get("pointFigures") or {})}
    prev_slides = prev.get("slides") or []
    for i, slide in enumerate(lesson.get("slides") or []):
        saved = []
        prev_imgs = (prev_slides[i].get("images") if i < len(prev_slides) and isinstance(prev_slides[i], dict) else None) or []
        for j, im in enumerate(slide.get("images") or []):
            if isinstance(im, dict):
                # Keep an already-stored payload when this update arrived without one,
                # so a partial edit can never wipe the images saved earlier.
                keep = im.get("dataUrl") or (prev_imgs[j].get("dataUrl") if j < len(prev_imgs) and isinstance(prev_imgs[j], dict) else None)
                saved.append({
                    "dataUrl": keep,
                    "name": im.get("name"),
                    "mime": im.get("mime"),
                    "kind": im.get("kind"),
                })
                im["dataUrl"] = None
            else:
                saved.append({"dataUrl": None})
        img_record["slides"].append({"images": saved})
    for p in lesson.get("points") or []:
        for fig in (p or {}).get("figures") or []:
            if not isinstance(fig, dict):
                continue
            fid = fig.get("id")
            if fig.get("dataUrl"):
                if fid:
                    img_record["pointFigures"][fid] = fig["dataUrl"]
                    fig["dataUrl"] = None
            elif fid and img_record["pointFigures"].get(fid):
                fig["dataUrl"] = None   # payload already offloaded; leave the store alone
    if not img_record["pointFigures"]:
        img_record.pop("pointFigures", None)
    get_store().put("lessonImages", img_record)
    return lesson


def _attach_lesson_images(lesson):
    """Re-fill a light lesson record's dataUrl fields from 'lessonImages'.

    Used when returning a SINGLE lesson (detail view) so the client gets the
    full images without the list endpoint paying the cost.
    """
    if not isinstance(lesson, dict):
        return lesson
    lid = lesson.get("id") or ""
    if not lid:
        return lesson
    img = get_store().get("lessonImages", lid)
    if not isinstance(img, dict):
        return lesson
    saved_slides = img.get("slides") or []
    for i, slide in enumerate(lesson.get("slides") or []):
        saved = saved_slides[i].get("images") if i < len(saved_slides) else None
        for j, im in enumerate(slide.get("images") or []):
            if isinstance(im, dict) and not im.get("dataUrl") and saved and j < len(saved):
                src = saved[j].get("dataUrl")
                if src:
                    im["dataUrl"] = src
    # Manually inserted point figures, matched by their own id.
    figs = img.get("pointFigures") or {}
    if figs:
        for p in lesson.get("points") or []:
            for fig in (p or {}).get("figures") or []:
                if isinstance(fig, dict) and not fig.get("dataUrl"):
                    src = figs.get(fig.get("id"))
                    if src:
                        fig["dataUrl"] = src
    return lesson


def _keep_stored_questions(existing, incoming):
    """Never let a stale tab replace an existing quiz's questions.

    The app writes questions to the store ONLY when it creates a new quiz record
    (generation, or "重新生成题目" — which makes a fresh record and deletes the old
    one). Every other write to an existing quiz is progress: userAnswers, score,
    attempts, lastTaken. So when the stored bank and the incoming one differ, the
    stored one is the authored/repaired copy and the incoming one is a tab that was
    open before a repair. Without this, a tab mid-attempt writes its stale bank back
    on the next answer — which is how a repaired question kept reappearing.

    Progress fields still come from the client; only the questions are held.
    """
    if not isinstance(existing, dict) or not isinstance(incoming, dict):
        return incoming
    stored = existing.get("questions")
    if not isinstance(stored, list) or not stored:
        return incoming
    if incoming.get("questions") == stored:
        return incoming
    out = dict(incoming)
    out["questions"] = stored
    return out


def make_token(secret, ttl=TOKEN_TTL):
    exp = int(time.time()) + ttl
    payload = str(exp).encode("ascii")
    sig = hmac.new(secret.encode("ascii"), payload, hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(payload).decode("ascii") + "." + sig


def verify_token(secret, token):
    try:
        b64, sig = token.split(".", 1)
        payload = base64.urlsafe_b64decode(b64.encode("ascii"))
        exp = int(payload)
        expected = hmac.new(secret.encode("ascii"), payload, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return False
        return exp > time.time()
    except Exception:
        return False


def call_llm(cfg, messages, max_tokens=4000, temperature=0.2, json_mode=False, reasoning_effort=None, thinking=None):
    if not cfg.get("api_key"):
        return {"error": "API key is not set. Add it in Settings."}
    url = cfg["base_url"].rstrip("/") + "/chat/completions"
    payload = {
        "model": cfg["model"],
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }
    # Default: disable the hidden "thinking"/reasoning pass on DeepSeek's
    # official API. Reasoning tokens are billed at full output price and can be
    # 40-90% of every completion, so turning thinking off roughly halves the
    # cost per generated lesson with no measurable quality loss on extraction /
    # flashcard / MCQ tasks. Other providers (opencode proxy, Bailian/Qwen)
    # don't speak the `thinking` field, so leave them untouched. Callers can
    # still opt back in via thinking="enabled".
    if thinking is None:
        if "api.deepseek.com" in (cfg.get("base_url") or "").lower():
            thinking = "disabled"
    if thinking in ("enabled", "disabled"):
        payload["thinking"] = {"type": thinking}
    if reasoning_effort and thinking != "disabled":
        payload["reasoning_effort"] = reasoning_effort
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    headers = dict(DEFAULT_LLM_HEADERS)
    headers["Authorization"] = "Bearer " + cfg["api_key"]
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        result = {"content": body["choices"][0]["message"]["content"]}
        # Attach token usage so the frontend can show how much the call cost.
        usage = body.get("usage")
        if isinstance(usage, dict):
            result["usage"] = {
                "prompt_tokens": usage.get("prompt_tokens") or 0,
                "completion_tokens": usage.get("completion_tokens") or 0,
                "total_tokens": usage.get("total_tokens") or 0,
                # Some reasoning models report a separate reasoning budget.
                "completion_tokens_details": usage.get("completion_tokens_details"),
            }
        return result
    except urllib.error.HTTPError as exc:
        try:
            err = json.loads(exc.read().decode("utf-8"))
            msg = (err.get("error") or {}).get("message") or err.get("message") or str(err)
        except Exception:
            msg = str(exc)
        return {"error": "HTTP %s: %s" % (exc.code, msg)}
    except Exception as exc:
        return {"error": str(exc)}


# Singleton store
_STORE = None


def get_store():
    global _STORE
    if _STORE is None:
        _STORE = Store(DB_PATH)
    return _STORE


# ---- In-memory response cache for list/detail store reads ----
# The dashboard + lessons list fire several big reads on every page load.
# Caching the computed dict by (store, params) means the expensive DB read +
# (for lessons) lighten/attach processing only happens once per TTL window.
# Invalidated on any write to that store. Stale-safe: TTL is short.
_CACHE_TTL = 6  # seconds
# (The list-response cache now lives in _ENCODED_CACHE, keyed the same way.)
# Second level: the encoded (gzipped) body plus its ETag, so a repeated or
# concurrent request for the same list costs no json.dumps and no gzip. Those two
# are CPU-bound and hold the GIL, which is what made unrelated asset requests wait
# seconds behind a 26 MB store response on a 2-core instance.
_ENCODED_CACHE = {}
_STORE_CACHE_LOCK = threading.Lock()


def _cache_key(store, params):
    # "lite" MUST be part of the key: the light and full bodies of one store are
    # different payloads, and sharing a key would serve whichever was built first.
    return store + "|" + "|".join(str(params[k] if params.get(k) is not None else "")
                                  for k in ("lessonId", "full", "light", "lite"))


def _encoded_cache_get(store, params):
    with _STORE_CACHE_LOCK:
        v = _ENCODED_CACHE.get(_cache_key(store, params))
        if v and v[0] > time.time():
            return v[1], v[2], v[3]
        if v:
            _ENCODED_CACHE.pop(_cache_key(store, params), None)
        return None, None, None


def _encoded_cache_set(store, params, etag, body, is_gzip):
    with _STORE_CACHE_LOCK:
        _ENCODED_CACHE[_cache_key(store, params)] = (time.time() + _CACHE_TTL, etag, body, is_gzip)


def _cache_invalidate(store):
    """Drop every cached list body for a store. Called on any write to it, so a
    client that just saved something never gets served the previous body."""
    with _STORE_CACHE_LOCK:
        prefix = store + "|"
        for k in [k for k in _ENCODED_CACHE if k.startswith(prefix)]:
            _ENCODED_CACHE.pop(k, None)


def _uid():
    import uuid as _uuid
    return str(_uuid.uuid4())


def record_token_use(slot, lesson_id, lesson_title, model, usage):
    """Persist one AI call's token usage so the frontend can show a per-course
    token report. Non-fatal on failure (token stats are best-effort)."""
    if not isinstance(usage, dict):
        return
    total = int(usage.get("total_tokens") or 0)
    if total <= 0:
        return
    try:
        get_store().put("tokenLog", {
            "id": _uid(),
            "ts": int(time.time() * 1000),
            "slot": str(slot or ""),
            "lessonId": str(lesson_id or ""),
            "lessonTitle": str(lesson_title or ""),
            "model": str(model or ""),
            "prompt_tokens": int(usage.get("prompt_tokens") or 0),
            "completion_tokens": int(usage.get("completion_tokens") or 0),
            "total_tokens": total,
            "completion_tokens_details": usage.get("completion_tokens_details"),
        })
    except Exception:
        pass


def _export_lesson_data(lesson):
    """Collect cards + best quiz for a lesson (server-side, for export)."""
    store = get_store()
    lesson_id = lesson.get("id")
    cards = store.all("cards", lesson_id=lesson_id) if lesson_id else []
    quizzes = store.all("quizzes", lesson_id=lesson_id) if lesson_id else []
    quiz = None
    for q in quizzes:
        if q and isinstance(q.get("questions"), list) and (quiz is None or (q.get("score") or -1) > (quiz.get("score") or -1)):
            quiz = q
    return cards, quiz


def _export_filename(lesson, ext):
    title = re.sub(r"[^\w\-]+", "_", (lesson.get("title") or "lesson")).strip("_") or "lesson"
    return "%s.%s" % (title[:60], ext)


class Handler(BaseHTTPRequestHandler):
    server_version = "MBBSRevision/1.1"

    # ---------- helpers ----------
    def _gzip_ok(self):
        return "gzip" in (self.headers.get("Accept-Encoding") or "").lower()

    def _send_store_bytes(self, etag, body, is_gzip):
        """Send one cached store body, or a 304 when the client already has it."""
        cache_headers = "private, max-age=0, must-revalidate"
        inm = self.headers.get("If-None-Match") or ""
        if etag and etag in [t.strip() for t in inm.split(",")]:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", cache_headers)
            self.end_headers()
            return
        use_gzip = self._gzip_ok() and is_gzip
        if not use_gzip and is_gzip:
            body = gzip.decompress(body)  # client cannot take gzip; rare
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", cache_headers)
        self.send_header("ETag", etag)
        if use_gzip:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_store_json(self, store, params, obj):
        """Encode a whole-store list once, cache the bytes, then send them.

        Two costs dominate a page load here, and neither is the SQL query: shipping
        the JSON (megabytes — the 258-lesson library is 24 MB, 5.5 MB gzipped), and
        rebuilding it on every request (json.dumps plus gzip are CPU-bound and hold
        the GIL, which is what stalled unrelated asset requests for seconds behind a
        big store response on a 2-core box).

        The ETag turns a second visit into a 304 with no body at all — this data
        changes only when the owner edits it, and any write invalidates the cache.
        The encoded-body cache means only the first caller after an edit pays for
        the encoding.
        """
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        etag = '"%d-%s"' % (len(raw), hashlib.sha256(raw).hexdigest()[:24])
        if len(raw) > 512:
            body, is_gzip = gzip.compress(raw), True
        else:
            body, is_gzip = raw, False
        _encoded_cache_set(store, params, etag, body, is_gzip)
        self._send_store_bytes(etag, body, is_gzip)

    def _send_json(self, obj, status=200):
        # If _read_body already rejected an oversized body, don't write a
        # second response to the same connection.
        if getattr(self, "_body_rejected", False):
            return
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        if self._gzip_ok() and len(raw) > 512:
            raw = gzip.compress(raw)
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length < 0:
            return b""
        if length > MAX_BODY:
            self._body_rejected = True
            self._send_json({"error": "Request body too large"}, 413)
            return None
        return self.rfile.read(length)

    def _json_body(self):
        raw = self._read_body()
        if raw is None:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return None

    def _token_ok(self):
        """Whether the request carries a valid session token. Sends nothing."""
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return False
        return verify_token(load_config()["secret"], auth[7:])

    def _authed(self):
        """Require a valid token, answering 401 otherwise. Costs money / changes data."""
        if self._token_ok():
            return True
        self._send_json({"error": "unauthorized"}, 401)
        return False

    def _read_ok(self):
        """Require a valid token — except in trial mode, where reading is public."""
        if TRIAL_MODE:
            return True
        return self._authed()

    def _authed_header_ok(self):
        """Token check without the 401, for endpoints that answer differently when
        the owner is signed in (e.g. /api/config in trial mode)."""
        return self._token_ok()

    def _serve_static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        rel = path.lstrip("/")
        full = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not full.startswith(os.path.normpath(STATIC_DIR)) or not os.path.isfile(full):
            self._send_json({"error": "Not found"}, 404)
            return
        ext = os.path.splitext(full)[1].lower()
        ctype = MIME.get(ext, "application/octet-stream")
        with open(full, "rb") as fh:
            content = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        # gzip only compressible text types; raster images gain nothing.
        compressible = ctype.startswith("text/") or ctype in ("application/javascript", "application/json", "image/svg+xml")
        if compressible and self._gzip_ok() and len(content) > 512:
            content = gzip.compress(content)
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    # ---------- GET ----------
    def do_GET(self):
        path = urlparse(self.path).path
        query = parse_qs(urlparse(self.path).query)

        if path == "/api/health":
            self._send_json({"ok": True, "pdf_support": True, "max_upload_mb": MAX_UPLOAD // 1048576})
            return

        if path == "/api/auth/me":
            # In trial mode anyone counts as signed in — this response is what stops
            # the client from showing a login screen. Writes and AI calls stay behind
            # the real password (see _read_ok / _authed). Checked in this order so a
            # failed token never emits a 401 that the trial answer would then follow
            # with a second response on the same connection.
            if TRIAL_MODE:
                self._send_json({"ok": True, "trial": True, "owner": self._token_ok()})
                return
            if self._authed():
                self._send_json({"ok": True, "trial": False})
            return

        if path == "/api/classification":
            if not self._read_ok():
                return
            self._send_json(load_classification())
            return

        if path == "/api/config":
            if not self._read_ok():
                return
            cfg = load_config()
            if TRIAL_MODE and not self._authed_header_ok():
                # Trial visitors get what the interface needs to render (branding,
                # subjects, daily goals) and nothing about the owner's keys: not the
                # values, not the endpoints, not whether a slot is configured.
                study = cfg.get("study") or DEFAULT_CONFIG["study"]
                self._send_json({
                    "trial": True,
                    "goal_minutes": cfg.get("goal_minutes", 30),
                    "new_cards_per_day": cfg.get("new_cards_per_day", 20),
                    "new_points_per_day": cfg.get("new_points_per_day", 15),
                    "study": study,
                    "study_presets": {pid: {"label": p["label"]} for pid, p in STUDY_PRESETS.items()},
                    "has_text_key": False,
                    "has_vision_key": False,
                    "has_drive_service": False,
                    "vision_active_has_key": False,
                })
                return
            text_key = (cfg.get("text") or {}).get("api_key") or ""
            presets = {}
            for pid, p in (cfg.get("vision_presets") or {}).items():
                eff_key = p.get("api_key") or ""
                if p.get("share_text_key") and not eff_key:
                    eff_key = text_key
                presets[pid] = {**p, "api_key": mask_key(eff_key), "_has_key": bool(eff_key)}
            active_cfg = resolve_vision(cfg)
            self._send_json(
                {
                    "text": {**cfg["text"], "api_key": mask_key(cfg["text"]["api_key"])},
                    "vision": {**cfg["vision"], "api_key": mask_key(active_cfg.get("api_key") or "")},
                    "vision_active": cfg.get("vision_active") or "bailian",
                    "vision_presets": presets,
                    "goal_minutes": cfg.get("goal_minutes", 30),
                    "new_cards_per_day": cfg.get("new_cards_per_day", 20),
                    "new_points_per_day": cfg.get("new_points_per_day", 15),
                    "drive_folder_id": cfg.get("drive_folder_id", "") or "",
                    "drive_proxy": cfg.get("drive_proxy", "") or "",
                    "study": cfg.get("study") or DEFAULT_CONFIG["study"],
                    "study_presets": {pid: {"label": p["label"]} for pid, p in STUDY_PRESETS.items()},
                    "has_drive_service": os.path.exists(os.path.join(DATA_DIR, "google-service-account.json")),
                    "has_text_key": bool(cfg["text"]["api_key"]),
                    "has_vision_key": bool((cfg["vision"] or {}).get("api_key")),
                    "vision_active_has_key": bool(active_cfg.get("api_key")),
                    # Trial mode is reported even to the owner: the client uses it to
                    # show the read-only banner and to explain why AI is refused.
                    "trial": TRIAL_MODE,
                    "trial_owner": TRIAL_MODE and self._token_ok(),
                }
            )
            return

        if path == "/api/models":
            if not self._authed():
                return
            role = query.get("role", ["text"])[0]
            cfg = load_config()
            prov = resolve_vision(cfg) if role == "vision" else (cfg.get(role) or {})
            url = prov.get("base_url", "").rstrip("/") + "/models"
            headers = dict(DEFAULT_LLM_HEADERS)
            headers["Authorization"] = "Bearer " + prov.get("api_key", "")
            req = urllib.request.Request(url, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    body = json.loads(resp.read().decode("utf-8"))
                models = [m.get("id") for m in body.get("data", []) if isinstance(m, dict) and m.get("id")]
                self._send_json({"models": sorted(set(models))})
            except Exception as exc:
                self._send_json({"models": [], "error": str(exc)})
            return

        if path.startswith("/api/store/"):
            # Reads are the one thing trial mode opens: lessons, cards, quizzes,
            # mistakes, study logs, together with /api/classification above. The
            # POST / PUT / DELETE handlers for this same prefix stay strict.
            if not self._read_ok():
                return
            parts = [unquote(p) for p in path[len("/api/store/"):].split("/") if p]
            store = get_store()
            if len(parts) == 1:
                lesson_id = query.get("lessonId", [None])[0]
                full = query.get("full", ["0"])[0] == "1"
                lite = query.get("lite", ["0"])[0] == "1"
                params = {"lessonId": lesson_id, "full": "1" if full else "0", "light": "0",
                          "lite": "1" if lite else "0"}
                # The encoded body IS the cache for a list: it already carries the
                # ETag, and serving it directly skips the query, the slim pass, the
                # json.dumps and the gzip. (An earlier object-level cache answered
                # here without an ETag, which silently cost every repeat visit the
                # 304 it should have received.)
                etag, body, is_gzip = _encoded_cache_get(parts[0], params)
                if etag is not None:
                    self._send_store_bytes(etag, body, is_gzip)
                    return
                items = store.all(parts[0], lesson_id=lesson_id)
                if parts[0] == "lessons" and not full:
                    items = [lighten_lesson(rec) for rec in items]
                # A whole-store list goes to the browser on every page load, and on a
                # small instance that transfer — not the query — is what makes the app
                # feel broken: 258 lessons of notes are 23 MB of JSON, 6 MB gzipped.
                # The fields dropped here are read only by the per-lesson views, which
                # fetch their own copy through /api/store/lessons/<id>. ?full=1 (the
                # backup export) and ?lessonId= (the lesson detail) keep everything.
                if lesson_id is None and not full:
                    if parts[0] == "lessons":
                        items = [slim_lesson(rec, lite) for rec in items]
                    elif parts[0] == "cards":
                        items = [slim_card(rec, lite) for rec in items]
                    elif parts[0] == "quizzes":
                        items = [slim_quiz(rec) for rec in items]
                self._send_store_json(parts[0], params, {"items": items})
            elif len(parts) == 2:
                rec = store.get(parts[0], parts[1])
                if rec is None:
                    self._send_json({"item": None, "notFound": True})
                else:
                    if parts[0] == "lessons":
                        # Detail view re-attaches image payloads on demand; the
                        # list endpoint stays light (no base64).
                        if query.get("light", ["0"])[0] == "1":
                            rec = lighten_lesson(rec)
                        else:
                            rec = _attach_lesson_images(rec)
                    self._send_json({"item": rec})
            else:
                self._send_json({"error": "bad request"}, 400)
            return

        if path.startswith("/api/export/lesson/"):
            if not self._authed():
                return
            lesson_id = unquote(path[len("/api/export/lesson/"):].split("/")[0])
            export_type = query.get("type", [""])[0]
            store = get_store()
            lesson = store.get("lessons", lesson_id)
            if not lesson:
                self._send_json({"error": "Lesson not found"}, 404)
                return
            cards, quiz = _export_lesson_data(lesson)
            if export_type == "pdf":
                data = exporters.build_pdf(lesson, quiz)
                ctype = exporters.PDFMIME
                ext = "pdf"
                disposition = "inline"
            elif export_type == "apkg":
                # Re-attach image payloads so the Anki deck can embed the
                # relevant figure on each flashcard.
                lesson = _attach_lesson_images(lesson)
                data = exporters.build_apkg(lesson, cards)
                if data is None:
                    self._send_json({"error": "No flashcards to export."}, 400)
                    return
                ctype = "application/octet-stream"
                ext = "apkg"
                disposition = "attachment"
            else:
                if not export_type:
                    self._send_json({"error": "Missing type parameter (pdf|apkg)"}, 400)
                else:
                    self._send_json({"error": "Unknown export type: %s" % export_type}, 400)
                return
            filename = _export_filename(lesson, ext)
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Disposition", '%s; filename="%s"' % (disposition, filename))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        self._serve_static(path)

    # ---------- POST ----------
    def do_POST(self):
        path = urlparse(self.path).path

        if path == "/api/auth/login":
            body = self._json_body()
            password = (body or {}).get("password", "")
            cfg = load_config()
            client_ip = self.client_address[0] if isinstance(self.client_address, tuple) else "unknown"
            if body is None:
                self._send_json({"error": "Bad request."}, 400)
                return
            block = login_blocked(client_ip)
            if block:
                self._send_json({"error": "Too many attempts. Try again later.", "retry_after": block}, 429)
                return
            if not passwords_equal(sha256(password), effective_password_hash(cfg)):
                login_record_failure(client_ip)
                self._send_json({"error": "Incorrect password."}, 401)
                return
            login_clear(client_ip)
            self._send_json({"token": make_token(cfg["secret"])})
            return

        if path == "/api/auth/change-password":
            if not self._authed():
                return
            body = self._json_body() or {}
            old, new = body.get("old_password", ""), body.get("new_password", "")
            if not new or len(new) < 8:
                self._send_json({"error": "New password must be at least 8 characters."}, 400)
                return
            cfg = load_config()
            if not passwords_equal(sha256(old), effective_password_hash(cfg)):
                self._send_json({"error": "Current password is incorrect."}, 401)
                return
            cfg["password_hash"] = sha256(new)
            # Rotate the session secret so previously issued tokens (e.g. a
            # stolen/lost logged-in session) stop working immediately.
            cfg["secret"] = base64.urlsafe_b64encode(os.urandom(32)).decode("ascii")
            save_config(cfg)
            self._send_json({"ok": True, "token": make_token(cfg["secret"])})
            return

        # everything below requires auth
        if path == "/api/classification":
            if not self._authed():
                return
            body = self._json_body() or {}
            cats = []
            for c in (body.get("categories") or []):
                if not isinstance(c, dict):
                    continue
                entry = {
                    "id": str(c.get("id") or "").strip(),
                    "name": str(c.get("name") or "").strip(),
                    "pattern": str(c.get("pattern") or "").strip(),
                }
                if entry["id"] and entry["name"]:
                    cats.append(entry)
            manual = body.get("manual") or {}
            data = {
                "categories": cats,
                "manual": {str(k): str(v).strip() for k, v in manual.items() if v},
            }
            save_classification(data)
            self._send_json({"ok": True, "categories": data["categories"], "manual": data["manual"]})
            return

        if path == "/api/config":
            if not self._authed():
                return
            body = self._json_body() or {}
            cfg = load_config()
            for key in ("text", "vision"):
                incoming = body.get(key) or {}
                if incoming.get("base_url"):
                    base_url = incoming["base_url"].strip()
                    if not (base_url.startswith("https://") or base_url.startswith("http://")):
                        self._send_json({"error": "base_url must start with https:// or http://"}, 400)
                        return
                    cfg[key]["base_url"] = base_url
                if incoming.get("model"):
                    cfg[key]["model"] = incoming["model"]
                if incoming.get("api_key") and "*" not in incoming["api_key"]:
                    cfg[key]["api_key"] = incoming["api_key"].strip()
            # Vision provider switching (Bailian <-> DeepSeek); each preset keeps
            # its own base_url/model/api_key so the user can flip between them.
            if body.get("vision_active"):
                new_active = str(body["vision_active"])
                presets = cfg.setdefault("vision_presets", {})
                if new_active not in presets:
                    presets[new_active] = {**DEFAULT_CONFIG["vision"]}
                cfg["vision_active"] = new_active
            # If a vision payload came in, write it to the ACTIVE preset and keep
            # cfg['vision'] in sync (the active provider).
            incoming = body.get("vision") or {}
            active = cfg.get("vision_active") or "bailian"
            presets = cfg.setdefault("vision_presets", {})
            if active not in presets:
                presets[active] = {**DEFAULT_CONFIG["vision"]}
            preset = presets[active]
            if incoming.get("base_url"):
                preset["base_url"] = incoming["base_url"].strip()
            if incoming.get("model"):
                preset["model"] = incoming["model"]
            if incoming.get("api_key") and "*" not in incoming["api_key"]:
                preset["api_key"] = incoming["api_key"].strip()
            cfg["vision"] = resolve_vision(cfg)
            if body.get("goal_minutes") is not None:
                try:
                    cfg["goal_minutes"] = max(1, min(int(body["goal_minutes"]), 600))
                except (TypeError, ValueError):
                    pass
            if body.get("new_cards_per_day") is not None:
                try:
                    cfg["new_cards_per_day"] = max(1, min(int(body["new_cards_per_day"]), 200))
                except (TypeError, ValueError):
                    pass
            if body.get("new_points_per_day") is not None:
                try:
                    cfg["new_points_per_day"] = max(1, min(int(body["new_points_per_day"]), 200))
                except (TypeError, ValueError):
                    pass
            if body.get("drive_folder_id") is not None:
                cfg["drive_folder_id"] = (body.get("drive_folder_id") or "").strip()
            if body.get("drive_proxy") is not None:
                cfg["drive_proxy"] = (body.get("drive_proxy") or "").strip()
            # Study profile: a preset id swaps in that whole profile; individual
            # string fields override on top; `subjects` replaces the list.
            if body.get("study_preset"):
                preset = STUDY_PRESETS.get(str(body["study_preset"]))
                if preset:
                    cfg["study"] = {
                        "preset": str(body["study_preset"]),
                        "site_title": preset["site_title"],
                        "site_sub": preset["site_sub"],
                        "learner": preset["learner"],
                        "language": preset["language"],
                        "auto_subject": cfg.get("study", {}).get("auto_subject", True),
                        "subjects": json.loads(json.dumps(preset["subjects"])),
                    }
            incoming_study = body.get("study")
            if isinstance(incoming_study, dict):
                study = cfg.setdefault("study", json.loads(json.dumps(DEFAULT_CONFIG["study"])))
                for key in ("site_title", "site_sub", "learner", "language"):
                    if incoming_study.get(key) is not None:
                        study[key] = str(incoming_study[key]).strip()
                if incoming_study.get("language") not in (None, "", "en", "zh", "bilingual"):
                    study["language"] = "en"
                if incoming_study.get("auto_subject") is not None:
                    study["auto_subject"] = bool(incoming_study["auto_subject"])
                subs = incoming_study.get("subjects")
                if isinstance(subs, list) and subs:
                    clean = []
                    for s in subs:
                        if not isinstance(s, dict) or not s.get("id"):
                            continue
                        clean.append({
                            "id": str(s["id"]).strip(),
                            "name": str(s.get("name") or s["id"]).strip(),
                            "keywords": [str(k) for k in (s.get("keywords") or []) if str(k).strip()],
                            "focus": str(s.get("focus") or "").strip(),
                            # Subject-specific generation rules: how to write the
                            # notes, and how to shape the questions.
                            "quiz": str(s.get("quiz") or "").strip(),
                            "notes": str(s.get("notes") or "").strip(),
                        })
                    if clean:
                        study["subjects"] = clean
            save_config(cfg)
            self._send_json({"ok": True, "has_text_key": bool(cfg["text"]["api_key"]), "has_vision_key": bool(cfg["vision"]["api_key"]), "goal_minutes": cfg.get("goal_minutes", 30), "new_cards_per_day": cfg.get("new_cards_per_day", 20), "new_points_per_day": cfg.get("new_points_per_day", 15), "drive_folder_id": cfg.get("drive_folder_id", "") or "", "drive_proxy": cfg.get("drive_proxy", "") or "", "study": cfg.get("study") or DEFAULT_CONFIG["study"]})
            return

        if path == "/api/parse":
            if not self._authed():
                return
            raw = self._read_body()
            if raw is None:
                return  # _read_body already sent 413
            if not raw:
                self._send_json({"error": "Empty file"}, 400)
                return
            if len(raw) > MAX_UPLOAD:
                self._send_json({"error": "File too large (max %d MB). 超大文件请先用 split_pdf.py 拆分再上传。" % (MAX_UPLOAD // 1048576)}, 413)
                return
            filename = self.headers.get("X-Filename", "file")
            # Optional PDF tuning: page slice + compression preset (ignored for
            # pptx, whose images are already-compressed embedded assets).
            pdf_opts = pdf_options_from_headers(self.headers)
            pdf_opts["pages"] = parse_page_set(self.headers.get("X-Page-Range"))
            try:
                if raw[:5] == b"%PDF-":
                    result = pdf_parser.parse_pdf(raw, **pdf_opts)
                    kind = "pdf"
                elif raw[:4] == b"PK\x03\x04":
                    result = ppt_parser.parse_pptx(raw)
                    kind = "pptx"
                else:
                    self._send_json({"error": "Unsupported file. Please upload a .pptx or .pdf (if it's an old .ppt, save it as .pptx first)."}, 400)
                    return
            except ValueError as exc:
                self._send_json({"error": str(exc)}, 400)
                return
            except ImportError as exc:
                self._send_json({"error": str(exc)}, 500)
                return
            result["kind"] = kind
            result["filename"] = filename
            result = _mark_logos(result)
            self._send_json(result)
            return

        if path == "/api/llm":
            if not self._authed():
                return
            body = self._json_body() or {}
            messages = body.get("messages", [])
            if not messages:
                self._send_json({"error": "No messages"}, 400)
                return
            cfg = load_config()["text"]
            # Allow cross-checking with a different model on the same base_url
            # (e.g. generation uses deepseek, fact-check uses glm-5.1). Whitelist
            # prevents arbitrary model abuse.
            requested_model = body.get("model")
            is_glm = bool(requested_model and requested_model in ("glm-5.1", "glm-5.2"))
            if is_glm:
                cfg = copy.copy(cfg)
                cfg["model"] = requested_model
            # glm on this gateway doesn't accept reasoning_effort / response_format
            # (they make it return empty content), so send plain text JSON instead.
            # thinking: callers may opt back into the model's reasoning pass for
            # the few steps that genuinely benefit (e.g. building the lecture's
            # topic outline). Unset -> call_llm's cost-saving default.
            thinking = body.get("thinking")
            result = call_llm(
                cfg,
                messages,
                max_tokens=min(int(body.get("max_tokens", 4000)), 16000),
                temperature=float(body.get("temperature", 0.2)),
                json_mode=bool(body.get("json_mode", False)) and not is_glm,
                reasoning_effort=(None if is_glm else (body.get("reasoning_effort") or "low")),
                thinking=(thinking if thinking in ("enabled", "disabled") else None),
            )
            if not result.get("error"):
                record_token_use(body.get("slot"), body.get("lessonId"), body.get("lessonTitle"), cfg.get("model"), result.get("usage"))
            self._send_json(result)
            return

        if path == "/api/vision":
            if not self._authed():
                return
            body = self._json_body() or {}
            image_url = body.get("image")
            prompt = body.get("prompt", "Describe this image.")
            if not image_url:
                self._send_json({"error": "No image provided"}, 400)
                return
            if len(image_url) > 10 * 1024 * 1024:
                self._send_json({"error": "Image too large for the vision model (max ~7.5 MB)."}, 400)
                return
            messages = [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": image_url}},
                    ],
                }
            ]
            vcfg = resolve_vision(load_config())
            # DeepSeek (official or via opencode proxy) is a reasoning model that
            # burns tokens on reasoning_content and returns empty content unless
            # reasoning_effort is low. Bailian/Qwen doesn't need it. Apply as a
            # base default; frontend can override via body.reasoning_effort.
            base_url = vcfg.get("base_url", "")
            re = body.get("reasoning_effort")
            if re is None and "dashscope" not in base_url:
                re = "low"
            result = call_llm(
                vcfg, messages,
                max_tokens=int(body.get("max_tokens", 3000)),
                temperature=0.2,
                reasoning_effort=re,
            )
            if not result.get("error"):
                record_token_use(body.get("slot"), body.get("lessonId"), body.get("lessonTitle"), vcfg.get("model"), result.get("usage"))
            self._send_json(result)
            return

        if path.startswith("/api/export/lesson/") and path.endswith("/drive"):
            if not self._authed():
                return
            # strip leading "/api/export/lesson/" and trailing "/drive"
            inner = path[len("/api/export/lesson/"):]
            lesson_id = unquote(inner[:-len("/drive")])
            store = get_store()
            lesson = store.get("lessons", lesson_id)
            if not lesson:
                self._send_json({"error": "Lesson not found"}, 404)
                return
            cards, quiz = _export_lesson_data(lesson)
            try:
                pdf_bytes = exporters.build_pdf(lesson, quiz)
            except Exception as exc:
                self._send_json({"error": "PDF generation failed: %s" % str(exc)}, 500)
                return
            cfg = load_config()
            cred_path = os.path.join(DATA_DIR, "google-service-account.json")
            folder_id = cfg.get("drive_folder_id") or None
            proxy = cfg.get("drive_proxy") or None
            result = exporters.upload_to_drive(
                pdf_bytes, _export_filename(lesson, "pdf"), cred_path, folder_id, proxy
            )
            self._send_json(result, status=200 if result.get("ok") else 400)
            return

        if path == "/api/export/upload-pdf":
            if not self._authed():
                return
            raw = self._read_body()
            if raw is None:
                return
            if not raw:
                self._send_json({"error": "Empty PDF"}, 400)
                return
            filename = unquote(self.headers.get("X-Filename", "") or "export.pdf")
            filename = os.path.basename(filename) or "export.pdf"
            # Keep a local copy alongside the Drive upload (optional, best-effort).
            try:
                os.makedirs(os.path.join(DATA_DIR, "exports"), exist_ok=True)
                with open(os.path.join(DATA_DIR, "exports", filename), "wb") as fh:
                    fh.write(raw)
            except Exception:
                pass
            cfg = load_config()
            cred_path = os.path.join(DATA_DIR, "google-service-account.json")
            folder_id = cfg.get("drive_folder_id") or None
            proxy = cfg.get("drive_proxy") or None
            result = exporters.upload_to_drive(raw, filename, cred_path, folder_id, proxy)
            self._send_json(result, status=200 if result.get("ok") else 400)
            return

        if path == "/api/import":
            if not self._authed():
                return
            body = self._json_body()
            st = get_store()
            lessons_list = body.get("lessons") or ([body.get("lesson")] if body.get("lesson") else None)
            if not lessons_list:
                self._send_json({"error": "Bad import payload."}, 400)
                return
            imported = []
            for lesson in lessons_list:
                if not isinstance(lesson, dict):
                    continue
                orig_id = lesson.get("id")
                lid = orig_id or _uid()
                # If a lesson with this id already exists, reuse a NEW id so the
                # import never clobbers an existing lesson (relink children).
                if st.get("lessons", lid):
                    lid = _uid()
                lesson["id"] = lid
                lesson = _strip_lesson_images(lesson)
                st.put("lessons", lesson)
                _cache_invalidate("lessons")
                _cache_invalidate("cards")
                for card in (body.get("cards") or []):
                    if card.get("lessonId") not in (orig_id, lid):
                        continue
                    card["lessonId"] = lid
                    card.setdefault("id", _uid())
                    st.put("cards", card)
                for quiz in (body.get("quizzes") or []):
                    if quiz.get("lessonId") not in (orig_id, lid):
                        continue
                    quiz["lessonId"] = lid
                    # Always a fresh id: the lessons were just re-keyed above, and
                    # reusing an existing quiz id would now collide with the
                    # stored-questions rule in _keep_stored_questions.
                    quiz["id"] = _uid()
                    st.put("quizzes", quiz)
                imported.append(lid)
            self._send_json({"ok": True, "imported": len(imported)})

        if path.startswith("/api/store/"):
            if not self._authed():
                return
            parts = [unquote(p) for p in path[len("/api/store/"):].split("/") if p]
            if len(parts) == 2 and parts[1] == "bulk":
                body = self._json_body() or {}
                get_store().bulk_put(parts[0], body.get("items", []))
                _cache_invalidate(parts[0])
                self._send_json({"ok": True})
                return
            self._send_json({"error": "bad request"}, 400)
            return

        self._send_json({"error": "Not found"}, 404)

    # ---------- PUT ----------
    def do_PUT(self):
        path = urlparse(self.path).path
        if path.startswith("/api/store/"):
            if not self._authed():
                return
            parts = [unquote(p) for p in path[len("/api/store/"):].split("/") if p]
            if len(parts) == 2:
                body = self._json_body()
                if not body or "id" not in body:
                    self._send_json({"error": "Record must include an id"}, 400)
                    return
                if parts[0] == "lessons":
                    # Store lesson images in the separate lessonImages store so
                    # list reads stay light; a light (grading) update leaves
                    # existing images untouched.
                    body = _strip_lesson_images(body)
                elif parts[0] == "quizzes":
                    # A tab holds the question bank in memory for the whole
                    # attempt and writes the record back after every answer, so a
                    # tab opened before a server-side repair would restore the
                    # questions we just fixed. See _keep_stored_questions.
                    body = _keep_stored_questions(get_store().get("quizzes", body.get("id")), body)
                get_store().put(parts[0], body)
                _cache_invalidate(parts[0])
                self._send_json({"ok": True})
                return
            self._send_json({"error": "bad request"}, 400)
            return
        self._send_json({"error": "Not found"}, 404)

    # ---------- DELETE ----------
    def do_DELETE(self):
        path = urlparse(self.path).path
        if path.startswith("/api/store/"):
            if not self._authed():
                return
            parts = [unquote(p) for p in path[len("/api/store/"):].split("/") if p]
            store = get_store()
            if len(parts) == 1:
                store.clear(parts[0])
                _cache_invalidate(parts[0])
                self._send_json({"ok": True})
            elif len(parts) == 2:
                store.delete(parts[0], parts[1])
                _cache_invalidate(parts[0])
                self._send_json({"ok": True})
            else:
                self._send_json({"error": "bad request"}, 400)
            return
        self._send_json({"error": "Not found"}, 404)

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))


class ThreadedServer(ThreadingHTTPServer):
    """ThreadingHTTP server with a large enough accept backlog.

    The browser fires ~8-10 parallel requests on load; the default backlog of 5
    drops (resets) the excess connections, causing intermittent failures.
    """
    daemon_threads = True
    request_queue_size = 128

    def handle_error(self, request, client_address):
        # A client closing mid-response is normal (tab closed / navigation) —
        # don't spam the log with a full traceback for it.
        if isinstance(sys.exc_info()[1], (ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    cfg = load_config()  # ensures config.json + secret + password exist
    get_store()  # creates the SQLite DB
    server = ThreadedServer((HOST, PORT), Handler)
    print("MBBS Revision server running at http://%s:%d" % (HOST, PORT))
    if not os.environ.get("PASSWORD"):
        print("Password: '%s' (change it in Settings after logging in)" % DEFAULT_PASSWORD)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
