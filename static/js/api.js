// Backend API client with bearer-token auth.

let _token = localStorage.getItem("mbbs_token") || "";

export function getToken() {
  return _token;
}
export function setToken(t) {
  _token = t || "";
  if (t) localStorage.setItem("mbbs_token", t);
  else localStorage.removeItem("mbbs_token");
}

// Fetch that attaches the auth token and clears it on 401.
export async function authedFetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (_token) headers["Authorization"] = "Bearer " + _token;
  const resp = await fetch(url, { ...opts, headers });
  if (resp.status === 401) setToken("");
  return resp;
}

async function json(resp) {
  const data = await resp.json().catch(() => ({ error: "Bad response" }));
  if (!resp.ok && !data.error) data.error = "HTTP " + resp.status;
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry transient LLM failures (rate-limit 429 / server 5xx / network / timeout)
// with exponential backoff, at most `retries` additional attempts.
async function withRetry(fn, retries = 2) {
  let attempt = 0;
  for (;;) {
    let data;
    try {
      data = await fn();
    } catch (e) {
      data = { error: String((e && e.message) || e) };
    }
    const msg = (data && data.error) || "";
    const transient =
      !data || data.timeout === true ||
      /429|too many|rate.?limit/i.test(msg) ||
      /5\d\d|server error|gateway|timed? ?out|ECONNRESET|network|fetch failed/i.test(msg);
    if (!transient || attempt >= retries) return data;
    attempt++;
    // 2s, 4s backoff (+ small jitter) so a burst of 429s doesn't pile up.
    await sleep(2000 * attempt + Math.random() * 500);
  }
}

export const api = {
  setToken,

  async login(password) {
    return json(await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }));
  },
  async checkAuth() {
    const r = await authedFetch("/api/auth/me");
    return r.ok;
  },
  async changePassword(old_password, new_password) {
    return json(await authedFetch("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ old_password, new_password }),
    }));
  },
  async health() {
    return json(await fetch("/api/health"));
  },
  async getConfig() {
    return json(await authedFetch("/api/config"));
  },
  async getModels(role) {
    return json(await authedFetch("/api/models?role=" + encodeURIComponent(role)));
  },
  async saveConfig(cfg) {
    return json(await authedFetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    }));
  },
  async getClassification() {
    return json(await authedFetch("/api/classification"));
  },
  async saveClassification(data) {
    return json(await authedFetch("/api/classification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }));
  },
  async parseFile(file) {
    const resp = await authedFetch("/api/parse", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Filename": encodeURIComponent(file.name),
      },
      body: file,
    });
    return json(resp);
  },
  async llm(messages, opts = {}) {
    const ctx = (typeof window !== "undefined" && window.__llmCtx) || {};
    return withRetry(async () => {
      const resp = await authedFetch("/api/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages,
          model: opts.model || undefined,
          max_tokens: opts.max_tokens || 4000,
          temperature: opts.temperature ?? 0.2,
          json_mode: opts.json_mode ?? false,
          reasoning_effort: opts.reasoning_effort ?? "low",
          slot: opts.slot || ctx.slot || "",
          lessonId: opts.lessonId || ctx.lessonId || "",
          lessonTitle: opts.lessonTitle || ctx.lessonTitle || "",
        }),
      });
      return json(resp);
    });
  },
  async vision(imageDataUrl, prompt, opts = {}) {
    const ctx = (typeof window !== "undefined" && window.__llmCtx) || {};
    return withRetry(async () => {
      const resp = await authedFetch("/api/vision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: imageDataUrl,
          prompt,
          max_tokens: opts.max_tokens || 800,
          slot: opts.slot || ctx.slot || "",
          lessonId: opts.lessonId || ctx.lessonId || "",
          lessonTitle: opts.lessonTitle || ctx.lessonTitle || "",
        }),
      });
      return json(resp);
    });
  },
  async exportFile(lessonId, type) {
    const resp = await authedFetch(`/api/export/lesson/${encodeURIComponent(lessonId)}?type=${encodeURIComponent(type)}`);
    if (!resp.ok) {
      let msg = "HTTP " + resp.status;
      try { msg = (await resp.json()).error || msg; } catch { /* ignore */ }
      return { ok: false, error: msg };
    }
    const blob = await resp.blob();
    const cd = resp.headers.get("Content-Disposition") || "";
    const m = cd.match(/filename="?([^";]+)"?/i);
    return { ok: true, blob, filename: m ? m[1] : ("lesson." + type) };
  },
  async exportDrive(lessonId) {
    return json(await authedFetch(`/api/export/lesson/${encodeURIComponent(lessonId)}/drive`, { method: "POST" }));
  },
  async uploadPdf(lessonId, blob, filename) {
    // Frontend-generated PDF (same style as the site) uploaded via the server
    // so Google service-account credentials never reach the browser.
    const resp = await authedFetch("/api/export/upload-pdf", {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
        "X-Filename": encodeURIComponent(filename || "lesson.pdf"),
      },
      body: blob,
    });
    return json(resp);
  },
};
