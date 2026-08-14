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
import hashlib
import hmac
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

import pdf_parser
import ppt_parser
from store import Store

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(ROOT, "static")
DATA_DIR = os.path.join(ROOT, "data")
CONFIG_PATH = os.path.join(DATA_DIR, "config.json")
DB_PATH = os.path.join(DATA_DIR, "data.db")
LEGACY_CONFIG = os.path.join(ROOT, "config.json")
PORT = int(os.environ.get("PORT", "8756"))
HOST = os.environ.get("HOST", "127.0.0.1")
MAX_UPLOAD = 150 * 1024 * 1024  # 150 MB
TOKEN_TTL = 30 * 24 * 3600  # 30 days

DEFAULT_PASSWORD = "mbbs1234"

DEFAULT_CONFIG = {
    "secret": "",
    "password_hash": "",
    "goal_minutes": 30,
    "text": {
        "base_url": "https://api.deepseek.com",
        "model": "deepseek-v4-pro",
        "api_key": "",
    },
    "vision": {
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "model": "qwen-vl-max",
        "api_key": "",
    },
}

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
        merged["secret"] = cfg.get("secret") or merged["secret"]
        merged["password_hash"] = cfg.get("password_hash") or merged["password_hash"]
        try:
            merged["goal_minutes"] = int(cfg.get("goal_minutes") or 30)
        except (TypeError, ValueError):
            merged["goal_minutes"] = 30
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

    if changed or cfg is None:
        _write_config(merged)
    return merged


def _write_config(cfg):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, CONFIG_PATH)


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


def mask_key(key):
    if not key:
        return ""
    return ("*" * max(0, len(key) - 4)) + key[-4:] if len(key) > 4 else "****"


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


def call_llm(cfg, messages, max_tokens=4000, temperature=0.2, json_mode=False):
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
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + cfg["api_key"],
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        return {"content": body["choices"][0]["message"]["content"]}
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


class Handler(BaseHTTPRequestHandler):
    server_version = "MBBSRevision/1.1"

    # ---------- helpers ----------
    def _send_json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return b""
        return self.rfile.read(length)

    def _json_body(self):
        try:
            return json.loads(self._read_body().decode("utf-8"))
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

        if path == "/api/config":
            if not self._authed():
                return
            cfg = load_config()
            self._send_json(
                {
                    "text": {**cfg["text"], "api_key": mask_key(cfg["text"]["api_key"])},
                    "vision": {**cfg["vision"], "api_key": mask_key(cfg["vision"]["api_key"])},
                    "goal_minutes": cfg.get("goal_minutes", 30),
                    "has_text_key": bool(cfg["text"]["api_key"]),
                    "has_vision_key": bool(cfg["vision"]["api_key"]),
                }
            )
            return

        if path.startswith("/api/store/"):
            if not self._authed():
                return
            parts = [unquote(p) for p in path[len("/api/store/"):].split("/") if p]
            store = get_store()
            if len(parts) == 1:
                lesson_id = query.get("lessonId", [None])[0]
                self._send_json({"items": store.all(parts[0], lesson_id=lesson_id)})
            elif len(parts) == 2:
                rec = store.get(parts[0], parts[1])
                if rec is None:
                    self._send_json({"item": None, "notFound": True})
                else:
                    self._send_json({"item": rec})
            else:
                self._send_json({"error": "bad request"}, 400)
            return

        self._serve_static(path)

    # ---------- POST ----------
    def do_POST(self):
        path = urlparse(self.path).path

        if path == "/api/auth/login":
            body = self._json_body()
            password = (body or {}).get("password", "")
            cfg = load_config()
            if sha256(password) != effective_password_hash(cfg):
                self._send_json({"error": "Incorrect password."}, 401)
                return
            self._send_json({"token": make_token(cfg["secret"])})
            return

        if path == "/api/auth/change-password":
            if not self._authed():
                return
            body = self._json_body() or {}
            old, new = body.get("old_password", ""), body.get("new_password", "")
            if not new or len(new) < 4:
                self._send_json({"error": "New password must be at least 4 characters."}, 400)
                return
            cfg = load_config()
            if sha256(old) != effective_password_hash(cfg):
                self._send_json({"error": "Current password is incorrect."}, 401)
                return
            cfg["password_hash"] = sha256(new)
            save_config(cfg)
            self._send_json({"ok": True, "token": make_token(cfg["secret"])})
            return

        # everything below requires auth
        if path == "/api/config":
            if not self._authed():
                return
            body = self._json_body() or {}
            cfg = load_config()
            for key in ("text", "vision"):
                incoming = body.get(key) or {}
                if incoming.get("base_url"):
                    cfg[key]["base_url"] = incoming["base_url"]
                if incoming.get("model"):
                    cfg[key]["model"] = incoming["model"]
                if incoming.get("api_key") and "*" not in incoming["api_key"]:
                    cfg[key]["api_key"] = incoming["api_key"].strip()
            if body.get("goal_minutes") is not None:
                try:
                    cfg["goal_minutes"] = max(1, min(int(body["goal_minutes"]), 600))
                except (TypeError, ValueError):
                    pass
            save_config(cfg)
            self._send_json({"ok": True, "has_text_key": bool(cfg["text"]["api_key"]), "has_vision_key": bool(cfg["vision"]["api_key"]), "goal_minutes": cfg.get("goal_minutes", 30)})
            return

        if path == "/api/parse":
            if not self._authed():
                return
            raw = self._read_body()
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
            result = call_llm(
                load_config()["text"],
                messages,
                max_tokens=int(body.get("max_tokens", 4000)),
                temperature=float(body.get("temperature", 0.2)),
                json_mode=bool(body.get("json_mode", False)),
            )
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
            result = call_llm(load_config()["vision"], messages, max_tokens=int(body.get("max_tokens", 800)), temperature=0.2)
            self._send_json(result)
            return

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
