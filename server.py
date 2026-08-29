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
DATA_DIR = os.path.join(ROOT, "data")
CONFIG_PATH = os.path.join(DATA_DIR, "config.json")
DB_PATH = os.path.join(DATA_DIR, "data.db")
LEGACY_CONFIG = os.path.join(ROOT, "config.json")
CLASSIFICATION_PATH = os.path.join(DATA_DIR, "classification.json")
PORT = int(os.environ.get("PORT", "8756"))
HOST = os.environ.get("HOST", "0.0.0.0")
MAX_UPLOAD = 150 * 1024 * 1024  # 150 MB
MAX_BODY = 200 * 1024 * 1024  # JSON API bodies (store records, etc.)
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

DEFAULT_CONFIG = {
    "secret": "",
    "password_hash": "",
    "goal_minutes": 30,
    "new_cards_per_day": 20,
    "new_points_per_day": 15,
    "drive_folder_id": "",
    "drive_proxy": "",
    "text": {
        "base_url": "https://api.deepseek.com",
        "model": "deepseek-v4-pro",
        "api_key": "",
    },
    "vision": {
        "base_url": "https://opencode.ai/zen/go/v1",
        "model": "deepseek-v4-flash-vision-exp",
        "api_key": "",
    },
    "vision_active": "opencode",
    "vision_presets": {
        "bailian": {
            "label": "Qwen (阿里百炼)",
            "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "model": "qwen3.7-plus",
            "api_key": "",
        },
        "deepseek": {
            "label": "DeepSeek 官方 V4 Vision",
            "base_url": "https://api.deepseek.com",
            "model": "deepseek-v4-flash-vision-exp",
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


def lighten_lesson(rec):
    """Return a lesson record without base64 image payloads.

    List pages (dashboard, review queue, search, navigation) only need
    points/slide text/titles. Sending the embedded page/figure images there
    is what made /api/store/lessons return ~40 MB on every navigation.
    """
    if not isinstance(rec, dict) or rec.get("kind") not in ("pdf", "pptx"):
        return rec
    out = copy.deepcopy(rec)
    for slide in out.get("slides") or []:
        for img in slide.get("images") or []:
            if isinstance(img, dict):
                img["dataUrl"] = None
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


def call_llm(cfg, messages, max_tokens=4000, temperature=0.2, json_mode=False, reasoning_effort=None):
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
    if reasoning_effort:
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

    def _authed(self):
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            self._send_json({"error": "unauthorized"}, 401)
            return False
        cfg = load_config()
        if not verify_token(cfg["secret"], auth[7:]):
            self._send_json({"error": "unauthorized"}, 401)
            return False
        return True

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
            self._send_json({"ok": True, "pdf_support": True})
            return

        if path == "/api/auth/me":
            if self._authed():
                self._send_json({"ok": True})
            return

        if path == "/api/classification":
            if not self._authed():
                return
            self._send_json(load_classification())
            return

        if path == "/api/config":
            if not self._authed():
                return
            cfg = load_config()
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
                    "has_drive_service": os.path.exists(os.path.join(DATA_DIR, "google-service-account.json")),
                    "has_text_key": bool(cfg["text"]["api_key"]),
                    "has_vision_key": bool((cfg["vision"] or {}).get("api_key")),
                    "vision_active_has_key": bool(active_cfg.get("api_key")),
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
            if not self._authed():
                return
            parts = [unquote(p) for p in path[len("/api/store/"):].split("/") if p]
            store = get_store()
            if len(parts) == 1:
                lesson_id = query.get("lessonId", [None])[0]
                full = query.get("full", ["0"])[0] == "1"
                items = store.all(parts[0], lesson_id=lesson_id)
                if parts[0] == "lessons" and not full:
                    items = [lighten_lesson(rec) for rec in items]
                self._send_json({"items": items})
            elif len(parts) == 2:
                rec = store.get(parts[0], parts[1])
                if rec is None:
                    self._send_json({"item": None, "notFound": True})
                else:
                    if parts[0] == "lessons" and query.get("light", ["0"])[0] == "1":
                        rec = lighten_lesson(rec)
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
            save_config(cfg)
            self._send_json({"ok": True, "has_text_key": bool(cfg["text"]["api_key"]), "has_vision_key": bool(cfg["vision"]["api_key"]), "goal_minutes": cfg.get("goal_minutes", 30), "new_cards_per_day": cfg.get("new_cards_per_day", 20), "new_points_per_day": cfg.get("new_points_per_day", 15), "drive_folder_id": cfg.get("drive_folder_id", "") or "", "drive_proxy": cfg.get("drive_proxy", "") or ""})
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
                self._send_json({"error": "File too large (max 150 MB)"}, 413)
                return
            filename = self.headers.get("X-Filename", "file")
            try:
                if raw[:5] == b"%PDF-":
                    result = pdf_parser.parse_pdf(raw)
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
            result = call_llm(
                cfg,
                messages,
                max_tokens=min(int(body.get("max_tokens", 4000)), 16000),
                temperature=float(body.get("temperature", 0.2)),
                json_mode=bool(body.get("json_mode", False)) and not is_glm,
                reasoning_effort=(None if is_glm else (body.get("reasoning_effort") or "low")),
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
                max_tokens=int(body.get("max_tokens", 800)),
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
                st.put("lessons", lesson)
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
                    quiz.setdefault("id", _uid())
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
                    existing = get_store().get(parts[0], body["id"])
                    if existing:
                        body = merge_lesson_images(existing, body)
                get_store().put(parts[0], body)
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
                self._send_json({"ok": True})
            elif len(parts) == 2:
                store.delete(parts[0], parts[1])
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
