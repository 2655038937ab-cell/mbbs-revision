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
  async saveConfig(cfg) {
    return json(await authedFetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
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
    const resp = await authedFetch("/api/llm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        max_tokens: opts.max_tokens || 4000,
        temperature: opts.temperature ?? 0.2,
        json_mode: opts.json_mode ?? false,
      }),
    });
    return json(resp);
  },
  async vision(imageDataUrl, prompt, opts = {}) {
    const resp = await authedFetch("/api/vision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: imageDataUrl,
        prompt,
        max_tokens: opts.max_tokens || 800,
      }),
    });
    return json(resp);
  },
};
