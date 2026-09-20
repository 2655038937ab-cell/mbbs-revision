// Unified public core: a single import point for the app's shared services.
// Feature modules (js/features/*) import from here instead of reaching into
// the individual files, so new features stay decoupled and easy to add.

export { db } from "../db.js";
export { api } from "../api.js";
export { newCard, schedule, isDue, scheduleMistake, uid } from "../sm2.js";
export { md, mdFull } from "../markdown.js";

// Small UI helpers used by features.
export function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function toast(msg, type = "") {
  const wrap = document.getElementById("toast-wrap");
  if (!wrap) return;
  const t = document.createElement("div");
  t.className = "toast " + type;
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

export function openModal(html) {
  const root = document.getElementById("modal-root");
  if (!root) return;
  root.innerHTML = `<div class="modal-backdrop" id="mb"><div class="modal">${html}</div></div>`;
  const mb = root.querySelector("#mb");
  if (mb) mb.addEventListener("mousedown", (e) => { if (e.target.id === "mb") closeModal(); });
}
export function closeModal() {
  const root = document.getElementById("modal-root");
  if (root) root.innerHTML = "";
}

// Tolerant JSON parser for LLM responses (handles ```json fences + stray text).
export function parseJSON(content) {
  if (typeof content !== "string") return content;
  let s = content.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end > start) s = s.slice(start, end + 1);
  try {
    return JSON.parse(s);
  } catch {
    // Long generations sometimes carry a literal newline or tab INSIDE a JSON
    // string, which is invalid JSON and makes JSON.parse throw. Escape those and
    // retry before giving up — otherwise a whole extraction silently returns
    // "nothing found".
    try { return JSON.parse(escapeControlCharsInStrings(s)); } catch { return null; }
  }
}

// JSON forbids raw control characters inside strings, but models emit them in
// long multi-line answers. Escape them only while inside a string literal, so
// the surrounding structure is untouched.
function escapeControlCharsInStrings(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === "\\") { out += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    if (inString) {
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      if (ch.charCodeAt(0) < 0x20) continue;
    }
    out += ch;
  }
  return out;
}

export function chunkText(items, max = 5500) {
  const chunks = [];
  let cur = "";
  for (const it of items) {
    if (cur && cur.length + it.length > max) { chunks.push(cur); cur = ""; }
    cur += (cur ? "\n\n" : "") + it;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export function fmtDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
