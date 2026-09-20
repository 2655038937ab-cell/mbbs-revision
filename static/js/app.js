import { db } from "./db.js";
import { api } from "./api.js";
import { newCard, schedule, isDue, schedulePoint, isPointDue, scheduleMistake, uid } from "./sm2.js";
import { md, mdFull, mdInline } from "./markdown.js";

const $ = (sel, root = document) => root.querySelector(sel);

/* ---------------- generic helpers ---------------- */

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function toast(msg, type = "") {
  const wrap = $("#toast-wrap");
  const t = document.createElement("div");
  t.className = "toast " + type;
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

/* Grading a flashcard (or any study item) is a server WRITE, and a trial visitor has
 * read-only access. Without this the PUT came back 401, the promise rejected
 * unhandled and the card simply stayed where it was: on the public trial site the
 * flashcards looked broken. Block the call and say why — the same way the AI buttons
 * already explain themselves (see TRIAL_AI_MESSAGE in api.js). */
const TRIAL_WRITE_MSG = "试用版仅可浏览：评分不会保存（登录后即可记录进度）";
function blockTrialWrite() {
  if (!api.isTrialMode()) return false;
  toast(TRIAL_WRITE_MSG, "warn");
  return true;
}

function parseJSON(content) {
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

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function dayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function fmtDuration(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return sec + "s";
  const m = Math.floor(sec / 60);
  if (m < 60) return m + "m";
  return Math.floor(m / 60) + "h " + (m % 60) + "m";
}

function intervalLabel(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return "<10m";
  if (n < 1) return "<1d";
  // Round before formatting: a value derived from timestamp subtraction can be
  // 2.999999988425926 rather than 3, which must never reach the UI.
  const d = Math.round(n);
  if (d >= 365) return Math.round(d / 365) + "y";
  if (d >= 30) return Math.round(d / 30) + "mo";
  return d + "d";
}

function shortDay(d) {
  return d.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightTerms(text, terms) {
  if (!text || !terms?.length) return text;
  // Drop mask-worthless single words (function, system, types…) but keep
  // multi-word phrases (e.g. "deep palmar arch") which are usually real terms.
  const candidates = [];
  for (const t of terms) {
    const s = String(t || "").trim();
    if (!s) continue;
    const words = s.split(/\s+/).filter(Boolean);
    const single = words.length === 1 ? words[0].toLowerCase() : "";
    if (words.length <= 1 && (!single || NO_CLOZE.has(single) || STOP.has(single))) continue;
    candidates.push(s);
  }
  // Build variants so a term is masked even if the text spells it differently:
  // plural form, hyphen/space between words, optional trailing period.
  const variants = new Set();
  for (const t of candidates) {
    const esc = escapeRegExp(t);
    variants.add(esc);
    variants.add(esc.replace(/ /g, "[\\s-]+"));                // hyphen/space between words
    variants.add(esc + "\\.?");                                 // abbr. trailing period
    verbs(t, variants);                                          // plural forms
  }
  const uniq = [...variants].sort((a, b) => b.length - a.length);
  const pattern = uniq
    .map((esc) => {
      const start = /^\w/.test(esc) ? "\\b" : "";
      const endB = /\w$/.test(esc) ? "\\b" : "";
      return start + esc + endB;
    })
    .join("|");
  try {
    // Never highlight inside a formula: wrapping a term in ==...== would inject
    // markdown into the LaTeX source (e.g. "$==K_d==$") and corrupt it. Formulas
    // are parked behind placeholders while the replacement runs.
    const parked = [];
    const guarded = String(text).replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g, (m) => {
      parked.push(m);
      return "\u0000HL" + (parked.length - 1) + "\u0000";
    });
    const done = guarded.replace(new RegExp(pattern, "gi"), (m) => `==${m}==`);
    return done.replace(/\u0000HL(\d+)\u0000/g, (m, i) => parked[Number(i)] ?? m);
  } catch { return text; }

  // Build plural / inflected variants of the last word of a phrase.
  function verbs(t, set) {
    const last = /([A-Za-z]+)$/.exec(t);
    if (!last) return;
    const w = last[1];
    const head = t.slice(0, t.length - w.length);
    const lw = w.toLowerCase();
    if (/y$/.test(w) && lw.length > 1) set.add(head + w.replace(/y$/i, "(y|ies)"));
    else if (/(s|x|ch|sh)$/i.test(w)) set.add(head + w.replace(/(s|ch|sh)$/i, "$1(es)"));
    else set.add(head + w + "(s|es)");
  }
}

const STOP = new Set(["the", "a", "an", "of", "and", "or", "to", "in", "for", "on", "with", "as", "is", "are", "by", "at", "from", "into", "vs", "versus", "their", "its", "his", "her", "which", "that", "this", "these", "those", "be", "was", "were", "not", "no", "than", "then"]);

// Words that carry little recall value — masking them just adds noise. These are
// generic nouns/verbs/adjectives common in lecture notes ("function", "system",
// "mechanism", "types", "clinical features") that aren't worth cloze-testing.
const NO_CLOZE = new Set([
  "the", "a", "an", "of", "and", "or", "to", "in", "for", "on", "with", "as", "is",
  "are", "by", "at", "from", "into", "that", "this", "these", "those", "be", "was",
  "were", "not", "no", "than", "then", "also", "its", "their", "his", "her", "which",
  "example", "examples", "e.g", "eg", "i.e", "ie", "via", "per", "due", "can", "may",
  "used", "use", "using", "shows", "shown", "show", "seen", "see", "called", "known",
  "following", "below", "above", "both", "most", "some", "many", "often", "usually",
  "normal", "common", "important", "main", "major", "other", "such", "each", "two",
  "one", "three", "first", "second", "part", "parts", "types", "type", "categories",
  "category", "forms", "form", "features", "feature", "symptoms", "signs", "findings",
  "function", "functions", "functional", "mechanism", "mechanisms", "process",
  "processes", "system", "systems", "structure", "structures", "pathway", "pathways",
  "clinical", "relevance", "significance", "important", "role", "roles", "effect",
  "effects", "causes", "cause", "association", "associated", "related", "relationship",
  "key", "basic", "general", "introduction", "overview", "summary", "conclusion",
  "definition", "definitions", "describe", "describes", "described", "consist",
  "consists", "comprises", "include", "includes", "including", "involves", "involve",
  "result", "results", "results in", "leads to", "lead to", "occurs", "occur",
  "present", "presents", "located", "location", "course", "runs", "passes",
  "supply", "supplies", "supplied", "drain", "drains", "drained", "blood", "flow",
  "arterial", "venous", "superficial", "deep", "upper", "lower", "left", "right",
  "medial", "lateral", "anterior", "posterior", "proximal", "distal", "superior",
  "inferior", "internal", "external", "common", "main", "large", "small", "short",
  "long", "greater", "lesser", "right", "left", "side", "muscle", "muscles",
  "nerve", "nerves", "artery", "arteries", "vein", "veins", "bone", "bones",
  "joint", "joints", "ligament", "ligaments", "tendon", "tendons", "tissue",
  "tissues", "cell", "cells", "organ", "organs", "surface", "layer", "layers",
  "fascia", "region", "regions", "space", "spaces", "wall", "walls", "body",
  "human", "med", "medical", "differs", "differs", "produce", "produces",
  "table", "figure", "fig", "diagram", "diagrams", "arrow", "arrows", "focus",
]);

// Fallback keywords for points generated before the keyTerms field existed:
// derive significant words from the title (the concept being recalled).
function titleWords(title) {
  if (!title) return [];
  const seen = new Set();
  String(title).split(/[^A-Za-z0-9'\-]+/).forEach((w) => {
    if (w.length >= 3 && !STOP.has(w.toLowerCase()) && !NO_CLOZE.has(w.toLowerCase())) seen.add(w);
  });
  return [...seen];
}

// Hide/reveal a single cloze term (a <mark class="hl"> element).
function setCloze(mark, hidden) {
  if (hidden) {
    if (mark.dataset.full == null) mark.dataset.full = mark.textContent;
    const n = Math.max(4, Math.min(18, mark.dataset.full.length));
    mark.textContent = "_".repeat(n);
    mark.classList.add("cloze-hidden");
  } else {
    if (mark.dataset.full != null) mark.textContent = mark.dataset.full;
    mark.classList.remove("cloze-hidden");
  }
}

// ---- Active-recall cloze: hide every term in a point, reveal them one at a
//      time (Space), and self-rate "记住 / 没记住". Missed terms are saved to
//      p.weakTerms so weak spots show up on the point and in review.
let recallState = null;

function recallKeyboard(e) {
  if (!recallState || !recallState.active) return;
  if (e.key === " " || e.key === "Enter") { e.preventDefault(); revealNextRecall(); }
  else if (e.key === "1") { e.preventDefault(); rateRecall("1"); }
  else if (e.key === "2") { e.preventDefault(); rateRecall("0"); }
}

function startPointRecall(card) {
  if (!card) return;
  const all = [...card.querySelectorAll("mark.hl")];
  // Clean slate before hiding: finishRecall deliberately leaves the marks revealed
  // (green/red) to show the outcome, and only exitRecall clears those classes. A
  // second run therefore started with stale cloze-revealed on every mark — which
  // painted the fresh blanks green rather than grey — and with cloze-wrong on the
  // terms missed last time, so the first revealed term already looked failed.
  all.forEach((m) => { m.classList.remove("cloze-revealed", "cloze-wrong"); setCloze(m, false); });
  all.forEach((m) => setCloze(m, true));
  if (!all.length) { toast("该知识点没有可回忆的术语。", "error"); return; }
  recallState = { card, marks: all, i: 0, weak: [], active: true, done: false };
  document.addEventListener("keydown", recallKeyboard);
  card.classList.add("recalling");
  const btn = card.querySelector(".recall-btn");
  if (btn) { btn.dataset.state = "active"; btn.textContent = "⏹ 退出回忆"; }
  const body = card.querySelector(".kp-body");
  if (body) {
    const tip = document.createElement("div");
    tip.className = "recall-tip";
    tip.innerHTML = `<div style="margin:8px 0 4px;font-size:13px;color:var(--text-2)">🧠 回忆：先想这个术语 → 按 <b>空格</b>(或点它) 揭晓 → 评 <b>记住</b> / <b>没记住</b>（1/2）</div>`;
    body.prepend(tip);
  }
  revealNextRecall();
}

function revealNextRecall() {
  if (!recallState || !recallState.active) return;
  const st = recallState;
  while (st.i < st.marks.length && !st.marks[st.i].classList.contains("cloze-hidden")) st.i++;
  if (st.i >= st.marks.length) { finishRecall(); return; }
  const m = st.marks[st.i];
  setCloze(m, false);
  m.classList.add("cloze-revealed");
  st.i++;
  const card = st.card;
  let bar = card.querySelector(".recall-rate");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "recall-rate";
    bar.innerHTML = `<div style="display:flex;gap:8px;margin-top:8px;align-items:center">
      <span class="sub">记住这个术语了吗？</span>
      <button class="btn btn-sm btn-accent" data-got="1">✅ 记住</button>
      <button class="btn btn-sm btn-ghost" data-got="0">❌ 没记住</button>
    </div>`;
    card.querySelector(".kp-body").appendChild(bar);
  }
}

function rateRecall(got) {
  if (!recallState || !recallState.active) return;
  const st = recallState;
  const revealed = st.marks[st.i - 1];
  if (revealed && got === "0") {
    const word = (revealed.dataset.full || revealed.textContent || "").trim();
    if (word && !st.weak.includes(word)) st.weak.push(word);
    revealed.classList.add("cloze-wrong");
  } else if (revealed) {
    revealed.classList.remove("cloze-wrong");
  }
  revealNextRecall();
}

async function finishRecall() {
  if (!recallState) return;
  const st = recallState;
  st.active = false;
  st.done = true;
  document.removeEventListener("keydown", recallKeyboard);
  const card = st.card;
  const btn = card.querySelector(".recall-btn");
  if (btn) { btn.dataset.state = "idle"; btn.textContent = "🔎 回忆"; }
  card.classList.remove("recalling");
  const tip = card.querySelector(".recall-tip");
  if (tip) tip.remove();
  const bar = card.querySelector(".recall-rate");
  if (bar) bar.remove();
  const total = st.marks.length;
  const weakCount = st.weak.length;
  if (weakCount) {
    const idx = parseInt(card.dataset.idx, 10);
    if (Number.isFinite(idx)) {
      const lesson = fullLessonCache.get(currentLessonId);
      const p = lesson?.points?.[idx];
      if (p) {
        p.weakTerms = st.weak;
        lesson.updatedAt = Date.now();
        await db.put("lessons", lesson);
        let badge = card.querySelector(".pill-weak");
        if (!badge) {
          badge = document.createElement("span");
          badge.className = "pill pill-amber pill-weak";
          card.querySelector(".kp-subhead").appendChild(badge);
        }
        badge.textContent = `⚠ 弱项 ${weakCount}`;
        badge.title = "回忆时没记住的术语";
        toast(`回忆完成：${weakCount} 个术语没记住（已记录为弱项）`, "warn");
      }
    }
  } else {
    toast(`回忆完成：全部 ${total} 个术语记住了 🎉`, "success");
  }
  recallState = null;
}

// Exit an active recall without finishing: restore terms, clear the UI.
function exitRecall() {
  if (!recallState) return;
  const st = recallState;
  st.active = false;
  document.removeEventListener("keydown", recallKeyboard);
  const card = st.card;
  card.querySelectorAll("mark.hl").forEach((m) => setCloze(m, false));
  card.classList.remove("recalling", "cloze-wrong");
  card.querySelectorAll(".cloze-wrong").forEach((m) => m.classList.remove("cloze-wrong"));
  card.querySelectorAll(".cloze-revealed").forEach((m) => m.classList.remove("cloze-revealed"));
  const btn = card.querySelector(".recall-btn");
  if (btn) { btn.dataset.state = "idle"; btn.textContent = "🔎 回忆"; }
  const tip = card.querySelector(".recall-tip"); if (tip) tip.remove();
  const bar = card.querySelector(".recall-rate"); if (bar) bar.remove();
  recallState = null;
}

function openModal(html) {
  $("#modal-root").innerHTML = `<div class="modal-backdrop" id="mb"><div class="modal">${html}</div></div>`;
  $("#mb").addEventListener("mousedown", (e) => {
    if (e.target.id === "mb") closeModal();
  });
}
function closeModal() { $("#modal-root").innerHTML = ""; }

function confirmGenerate(message, fn) {
  openModal(`
    <h2>确认生成</h2>
    <p>${message}</p>
    <div style="display:flex;gap:10px;margin-top:18px;justify-content:flex-end">
      <button class="btn btn-ghost" id="cf-cancel">取消</button>
      <button class="btn btn-accent" id="cf-ok">确认生成</button>
    </div>`);
  $("#cf-cancel").addEventListener("click", closeModal);
  $("#cf-ok").addEventListener("click", () => { closeModal(); fn(); });
}

/* ---------------- Background generation tasks ---------------- */
let genTasks = [];
let genSeq = 0;

function genPanelRoot() {
  let root = document.getElementById("gen-panel");
  if (!root) { root = document.createElement("div"); root.id = "gen-panel"; document.body.appendChild(root); }
  return root;
}

function removeGenTask(id) {
  genTasks = genTasks.filter((t) => t.id !== id);
  renderGenTasks();
}

function taskCardHTML(t) {
  const pct = Math.round(t.progress * 100);
  if (t.minimized) {
    return `<div class="card" data-task="${t.id}" style="padding:10px 14px;cursor:pointer;display:flex;gap:8px;align-items:center;box-shadow:0 6px 20px rgba(0,0,0,.18)"><span style="font-size:15px">${t.status === "done" ? "✅" : t.status === "cancelled" ? "⛔" : "✨"}</span><span style="font-size:13px;font-weight:600">${escapeHtml(t.title)} · ${pct}%</span></div>`;
  }
  const steps = t.steps.map((s) => `<span style="margin-right:8px;white-space:nowrap">${s.icon} ${escapeHtml(s.label)}</span>`).join("");
  return `
    <div class="card" data-task="${t.id}" style="box-shadow:0 10px 40px rgba(0,0,0,.2)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:8px">
        <b style="font-size:13.5px">${t.status === "done" ? "✅" : t.status === "cancelled" ? "⛔" : "✨"} ${escapeHtml(t.title)}</b>
        <div style="display:flex;gap:6px;align-items:center">
          ${t.status === "running" ? `<button class="gen-cancel" style="border:1px solid var(--red);color:var(--red);background:none;border-radius:6px;cursor:pointer;font-size:11px;padding:2px 8px">取消</button>` : ""}
          ${t.status !== "running" ? `<button class="gen-close" style="border:0;background:none;cursor:pointer;color:var(--text-3);font-size:15px" title="关闭">×</button>` : ""}
          <button class="gen-min" style="border:0;background:none;cursor:pointer;color:var(--text-3);font-size:15px" title="最小化">—</button>
        </div>
      </div>
      <div class="progress-bar" style="height:8px;margin-bottom:6px"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="sub" style="font-size:12px;margin-bottom:4px">${t.status === "done" ? `<b>✅ ${escapeHtml(t.msg)}</b>` : t.status === "cancelled" ? `<b>⛔ 已取消</b>` : t.status === "error" ? `<b>⚠️ ${escapeHtml(t.msg)}</b>` : (t.cancelled ? `<b>⛔ 正在取消…</b>` : escapeHtml(t.msg || "准备中…"))}</div>
      ${t.tokens ? `<div class="sub" style="font-size:11px;color:var(--text-2)">🔢 ${t.tokens.toLocaleString()} tokens 已用</div>` : ""}
      ${t.status === "running" ? `<div class="sub" style="font-size:11px;color:var(--text-3);overflow:hidden">${steps}</div>` : ""}
      ${t.status === "done" && t.doneAction ? `<button class="btn btn-primary btn-sm gen-view-btn" style="margin-top:6px">${escapeHtml(t.doneLabel || "查看")}</button>` : ""}
    </div>`;
}

let _genRafPending = false;
function renderGenTasks() {
  // Throttle to at most once per animation frame: during generation the panel is
  // updated very often (progress / msg / tokens), and rebuilding it every time
  // freezes the UI while the user tries to navigate.
  if (_genRafPending) return;
  _genRafPending = true;
  requestAnimationFrame(() => {
    _genRafPending = false;
    _renderGenTasksNow();
  });
}
function _renderGenTasksNow() {
  const root = genPanelRoot();
  const active = genTasks.filter((t) => t.status !== "removed");
  if (!active.length) { root.style.display = "none"; return; }
  root.style.display = "flex";
  root.style.cssText = "position:fixed;bottom:20px;right:20px;width:360px;z-index:90;display:flex;flex-direction:column;gap:10px;max-height:70vh;overflow:auto;";
  root.innerHTML = active.map(taskCardHTML).join("");
  active.forEach((t) => {
    const card = root.querySelector(`[data-task="${t.id}"]`);
    if (!card) return;
    const cancel = card.querySelector(".gen-cancel");
    if (cancel) cancel.addEventListener("click", () => { t.cancelled = true; renderGenTasks(); });
    const min = card.querySelector(".gen-min");
    if (min) min.addEventListener("click", () => { t.minimized = true; renderGenTasks(); });
    const close = card.querySelector(".gen-close");
    if (close) close.addEventListener("click", () => removeGenTask(t.id));
    const viewBtn = card.querySelector(".gen-view-btn");
    if (viewBtn) viewBtn.addEventListener("click", () => { const a = t.doneAction; removeGenTask(t.id); if (a) a(); });
    if (t.minimized) card.addEventListener("click", () => { t.minimized = false; renderGenTasks(); });
  });
}

function progressPanel(title) {
  const task = { id: ++genSeq, title, status: "running", steps: [], progress: 0, msg: "", cancelled: false, minimized: false, doneAction: null, doneLabel: "", tokens: 0 };
  genTasks.push(task);
  renderGenTasks();
  return {
    addStep(label) { task.steps.push({ label, icon: "⏳" }); renderGenTasks(); },
    setStep(i, state) {
      const map = { pending: "⏳", running: "🔄", done: "✅", error: "⚠️" };
      if (task.steps[i]) task.steps[i].icon = map[state] || "⏳";
      renderGenTasks();
    },
    setProgress(p) { task.progress = Math.min(1, Math.max(0, p)); renderGenTasks(); },
    msg(m) { task.msg = m; renderGenTasks(); },
    addTokens(total) { const n = Number(total) || 0; if (n > 0) { task.tokens += n; renderGenTasks(); } },
    done(summary, label, action) {
      task.status = "done"; task.progress = 1; task.msg = summary; task.doneLabel = label; task.doneAction = action;
      renderGenTasks();
      setTimeout(() => removeGenTask(task.id), 20000);
    },
    fail(m) { task.status = "error"; task.msg = m; renderGenTasks(); setTimeout(() => removeGenTask(task.id), 8000); },
    cancelled() { task.status = "cancelled"; renderGenTasks(); setTimeout(() => removeGenTask(task.id), 6000); },
    cancelMark() { task.cancelled = true; },
    isCancelled() { return task.cancelled; },
    close() { removeGenTask(task.id); },
  };
}

/* ---------------- app state ---------------- */
let currentView = "dashboard";
let currentLessonId = null;
let currentTab = "points";
let immersiveOn = false;
let lessonOrder = []; // ordered lesson ids for quick switching
let appConfig = null;
let reviewQueue = [];
let reviewPos = 0;
let reviewRequeued = new Set();
let reviewStats = { cards: 0, cardGrades: [0, 0, 0, 0], newCards: 0, mistakes: 0, mistakeGot: 0, mistakeMissed: 0, points: 0, pointGrades: [0, 0, 0, 0] };
let reviewFlipped = false;
let reviewKeyHandler = null;
let reviewLessonMap = {};
let feynmanKeyHandler = null;
let mistakeKeyHandler = null;
let feynmanRevealed = false;
let mistakeRevealed = false;
let mistakeQueue = [];
let mistakePos = 0;
let mistakeStats = { shown: 0, got: 0, missed: 0 };

// List endpoints return lessons without image payloads for speed. The lesson
// detail view needs the real images, so cache the full record per lesson to
// avoid re-downloading ~40 MB on every tab switch.
const fullLessonCache = new Map();
async function getLessonFull(lessonId, force = false) {
  if (!force && fullLessonCache.has(lessonId)) return fullLessonCache.get(lessonId);
  const lesson = await db.get("lessons", lessonId);
  if (lesson) fullLessonCache.set(lessonId, lesson);
  return lesson;
}

function sameDay(ts, now = Date.now()) {
  if (!ts) return false;
  return dayKey(new Date(ts)) === dayKey(new Date(now));
}

function getNewCardsPerDay() {
  const n = parseInt(appConfig?.new_cards_per_day, 10);
  return n > 0 ? n : 20;
}
async function saveNewCardsPerDay(m) {
  const n = parseInt(m, 10);
  const val = n > 0 ? n : 20;
  const res = await api.saveConfig({ new_cards_per_day: val });
  if (res.error) { toast(res.error, "error"); return false; }
  await loadAppConfig();
  return true;
}

function getNewPointsPerDay() {
  const n = parseInt(appConfig?.new_points_per_day, 10);
  return n > 0 ? n : 15;
}
async function saveNewPointsPerDay(m) {
  const n = parseInt(m, 10);
  const val = n > 0 ? n : 15;
  const res = await api.saveConfig({ new_points_per_day: val });
  if (res.error) { toast(res.error, "error"); return false; }
  await loadAppConfig();
  return true;
}

/* Build one ordered, mixed study queue:
 * due review cards -> due mistakes -> due key points, with new cards
 * interleaved every few items and capped by the daily new-card limit. */
// Round-robin across lessons so cards from one course stop arriving in a solid
// block: each pass takes one entry per lesson, which interleaves the subjects.
function interleaveByLesson(entries) {
  const buckets = new Map();
  for (const e of entries) {
    const lid = e.kind === "card" ? (e.card && e.card.lessonId)
      : e.kind === "point" ? (e.lesson && e.lesson.id)
      : (e.mistake && e.mistake.lessonId);
    const key = String(lid || "?");
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(e);
  }
  if (buckets.size < 2) return entries; // nothing to interleave
  const lists = [...buckets.values()];
  const out = [];
  for (let i = 0; out.length < entries.length; i++) {
    let progressed = false;
    for (const list of lists) {
      if (i < list.length) { out.push(list[i]); progressed = true; }
    }
    if (!progressed) break;
  }
  return out;
}

// Word set of a card's text, used to spot knowledge points that a flashcard
// already tests. Build once per queue, bucketed by lesson so a queue pass stays
// linear instead of comparing every point against every card.
function wordSet(text) {
  return new Set(String(text || "").toLowerCase().match(/[a-z0-9\u4e00-\u9fff]{3,}/g) || []);
}
// Words that identify WHICH entity a sentence is about: capitalised names
// (Streptococcus, agalactiae) and single letters/numbers (group A, type II).
// Two sentences can share most of their vocabulary yet describe different
// organisms, so a card only "covers" a point when these identifiers match too.
function distinctiveSet(text) {
  const out = new Set();
  for (const w of String(text || "").match(/\b[A-Z][a-z]{2,}\b|\b[A-Z]\b|\b\d+\b/g) || []) {
    out.add(w.toLowerCase());
  }
  return out;
}
function cardsByLessonIndex(cards) {
  const idx = new Map();
  for (const c of cards || []) {
    const text = (c.front || "") + " " + (c.back || "");
    const w = wordSet(text);
    if (!w.size) continue;
    const lid = String(c.lessonId || "?");
    if (!idx.has(lid)) idx.set(lid, []);
    idx.get(lid).push({ words: w, distinct: distinctiveSet(text) });
  }
  return idx;
}
// True when a flashcard already tests this point: high word overlap AND every
// distinguishing identifier of the point appears in that same card.
function pointCoveredByCards(point, lessonId, idx) {
  const sets = idx.get(String(lessonId || "?"));
  if (!sets || !sets.length) return false;
  const title = point && point.title;
  const pw = wordSet(title);
  if (pw.size < 2) return false;
  const pd = distinctiveSet(title);
  for (const card of sets) {
    let hit = 0;
    for (const w of pw) if (card.words.has(w)) hit++;
    if (hit / pw.size < 0.75) continue;
    // Compare identifiers against the card's identifier set, not its word set:
    // identifiers are often one character ("group B"), and the word set only
    // keeps tokens of 3+ characters.
    let sameEntity = true;
    for (const d of pd) if (!card.distinct.has(d)) { sameEntity = false; break; }
    if (sameEntity) return true;
  }
  return false;
}

function planStudyQueue(cards, lessons, mistakes, now = Date.now()) {
  const cardLimit = getNewCardsPerDay();
  const pointLimit = getNewPointsPerDay();
  const cardIdx = cardsByLessonIndex(cards);
  const allDueCards = cards.filter((c) => isDue(c, now));
  const isNew = (c) => c.reps === 0 && c.lapses === 0;
  const dueReviewCards = allDueCards.filter((c) => !isNew(c));
  const newCards = allDueCards.filter(isNew);

  // A new card counts toward today's limit once it has been graded the
  // first time (newDoneAt is stamped by gradeStudyEntry).
  const introducedCardsToday = cards.filter((c) => sameDay(c.newDoneAt, now)).length;
  const selectedNewCards = newCards
    .filter((c) => !sameDay(c.newDoneAt, now))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .slice(0, Math.max(0, cardLimit - introducedCardsToday));

  const dueMistakes = mistakes
    .filter((m) => !m.mastered && m.nextReview <= now)
    .sort((a, b) => a.nextReview - b.nextReview);

  // Key points: never-tested points are treated as "new" and capped per
  // day; previously rated points come back only when their interval is due.
  const newPointEntries = [];
  const duePointEntries = [];
  lessons.forEach((lesson) => (lesson.points || []).forEach((point, idx) => {
    if (point.feynmanStage == null) {
      // Skip a brand-new point the course's own flashcards already cover.
      if (pointCoveredByCards(point, lesson.id, cardIdx)) return;
      newPointEntries.push({
        kind: "point", lesson, point, idx,
        due: lesson.createdAt || now, id: lesson.id + ":" + idx, isNewPoint: true,
      });
    } else if (isPointDue(point, now)) {
      duePointEntries.push({
        kind: "point", lesson, point, idx,
        due: point.feynmanDue != null ? point.feynmanDue : (lesson.createdAt || now),
        id: lesson.id + ":" + idx,
      });
    }
  }));
  const pointRank = (p) => (p.importance === "high" ? 0 : p.importance === "low" ? 2 : 1);
  const pointSort = (a, b) => {
    if ((a.due || 0) !== (b.due || 0)) return (a.due || 0) - (b.due || 0);
    return pointRank(a.point) - pointRank(b.point);
  };
  duePointEntries.sort(pointSort);
  newPointEntries.sort(pointSort);

  const introducedPointsToday = lessons.reduce(
    (sum, l) => sum + (l.points || []).filter((p) => sameDay(p.feynmanIntroducedAt, now)).length, 0
  );
  const selectedNewPoints = newPointEntries.slice(0, Math.max(0, pointLimit - introducedPointsToday));

  const base = interleaveByLesson([
    ...dueReviewCards.map((card) => ({ kind: "card", card, due: card.due, id: card.id })),
    ...dueMistakes.map((m) => ({ kind: "mistake", mistake: m, due: m.nextReview, id: m.id })),
    ...duePointEntries,
  ].sort((a, b) => (a.due || 0) - (b.due || 0)));

  const entries = [];
  let ci = 0, pi = 0;
  for (let i = 0; i < base.length; i++) {
    entries.push(base[i]);
    if ((i + 1) % 4 === 0) {
      if (ci < selectedNewCards.length) {
        entries.push({ kind: "card", card: selectedNewCards[ci], due: selectedNewCards[ci].due, id: selectedNewCards[ci].id, isNewCard: true });
        ci++;
      } else if (pi < selectedNewPoints.length) {
        entries.push(selectedNewPoints[pi++]);
      }
    }
  }
  while (ci < selectedNewCards.length) {
    entries.push({ kind: "card", card: selectedNewCards[ci], due: selectedNewCards[ci].due, id: selectedNewCards[ci].id, isNewCard: true });
    ci++;
  }
  while (pi < selectedNewPoints.length) entries.push(selectedNewPoints[pi++]);

  return {
    entries,
    dueCardCount: dueReviewCards.length,
    newCardCount: selectedNewCards.length,
    remainingNewCount: newCards.filter((c) => !sameDay(c.newDoneAt, now)).length - selectedNewCards.length,
    dueMistakeCount: dueMistakes.length,
    duePointCount: duePointEntries.length + selectedNewPoints.length,
    newPointCount: selectedNewPoints.length,
    remainingNewPointCount: newPointEntries.length - selectedNewPoints.length,
  };
}


/* ---------------- time tracking ---------------- */
const ACTIVITY_LABELS = { study: "Reading / notes", review: "Spaced review", quiz: "Quizzes", mistakes: "Mistakes" };
let currentActivity = null;
let activitySeconds = 0;
let lastTick = Date.now();
let lastInteraction = Date.now();
const IDLE_LIMIT_MS = 90000; // count study time only if the user acted within the last ~1.5 min

function setActivity(a) {
  if (a === currentActivity) return;
  flushActivity();
  currentActivity = a;
  activitySeconds = 0;
  lastTick = Date.now();
  if (a) lastInteraction = Date.now();
}

function flushActivity() {
  if (currentActivity && activitySeconds > 1) {
    const sec = Math.round(activitySeconds);
    activitySeconds = 0;
    const date = dayKey(new Date());
    const id = date + ":" + currentActivity;
    db.get("studyLog", id)
      .then((rec) => db.put("studyLog", { id, date, activity: currentActivity, seconds: (rec?.seconds || 0) + sec }))
      .catch(() => {});
  }
}

function startTimeTracking() {
  // Any real interaction (mouse/keyboard/scroll/touch) marks the user as active.
  const markActive = () => { lastInteraction = Date.now(); };
  ["pointermove", "pointerdown", "keydown", "scroll", "touchstart", "wheel"].forEach((ev) => {
    document.addEventListener(ev, markActive, { passive: true });
  });
  setInterval(() => {
    const now = Date.now();
    const active = currentActivity && document.visibilityState === "visible" && (now - lastInteraction) < IDLE_LIMIT_MS;
    if (active) activitySeconds += (now - lastTick) / 1000;
    lastTick = now;
  }, 1000);
  setInterval(() => { flushActivity(); checkGoalCelebration(); }, 30000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushActivity();
  });
  window.addEventListener("beforeunload", flushActivity);
}

function getGoalMinutes() {
  const g = parseInt(appConfig?.goal_minutes, 10);
  return g > 0 ? g : 30;
}

// ---- Interactive desk pet ----
/* The pet's two-state control, exposed for the hidden menu's "重新显示桌宠".
   initPet() owns the state; this just flips it, so there is exactly one writer. */
let showPetAgain = () => {};

function initPet() {
  const pet = document.getElementById("pet");
  if (!pet || pet.dataset.init) return;
  pet.dataset.init = "1";

  // Two states only: shown, or collapsed to the corner pill. They are driven from
  // ONE flag so they can never disagree — the earlier hover-reveal version could
  // end up with the pet "shown" and display:none at the same time, which left a
  // 0×0 ghost that could not be grabbed or dismissed.
  let hidden = false;
  try { hidden = localStorage.getItem("mbbs_pet_hidden") === "1"; } catch { /* ignore */ }
  // Declared here, not next to its click handler below: applyPetState() runs first
  // and reads it, and a `const` further down would be in its temporal dead zone.
  const hideBtn = document.getElementById("pet-hide");
  const applyPetState = () => {
    document.body.classList.toggle("pet-hidden", hidden);
    pet.classList.toggle("show", !hidden);
    if (hideBtn) {
      hideBtn.textContent = hidden ? "🐾" : "×";
      hideBtn.title = hidden ? "显示桌宠" : "收起宠物（专注计时会留在右下角）";
    }
    try { hidden ? localStorage.setItem("mbbs_pet_hidden", "1") : localStorage.removeItem("mbbs_pet_hidden"); } catch { /* ignore */ }
  };

  // Restore saved position.
  try {
    const saved = localStorage.getItem("mbbs_pet_pos");
    if (saved) { const p = JSON.parse(saved); pet.style.right = "auto"; pet.style.bottom = "auto"; pet.style.left = p.left + "px"; pet.style.top = p.top + "px"; }
  } catch { /* ignore */ }

  // No hover-to-reveal: the pet is either there or it is not, and it can be
  // grabbed at any time. Chasing the pointer into the corner to make the timer
  // appear was the "躲猫猫" part.
  applyPetState();
  showPetAgain = () => { hidden = false; applyPetState(); };

  // ---- Timer: today's study minutes + a configurable focus (pomodoro) ----
  const todayVal = document.getElementById("pet-today-val");
  const goalVal = document.getElementById("pet-goal-val");
  const pomoBtn = document.getElementById("pet-pomo-btn");
  const pomoMini = document.getElementById("pet-pomo-mini");
  const DEFAULT_POMO_MIN = 25;
  let pomoMinutes = Number(localStorage.getItem("mbbs_pomo_min")) || DEFAULT_POMO_MIN;
  const POMO_MS = () => pomoMinutes * 60 * 1000;
  let pomoEnd = 0;         // epoch ms when a running session ends (0 = not running)
  let pomoPaused = false;
  let pomoRemainMs = POMO_MS();

  let todayBaseSec = 0; // studyLog total for today (updated every 30 s)
  async function refreshTodayBase() {
    try {
      const log = await db.getAll("studyLog").catch(() => []);
      const tk = dayKey(new Date());
      todayBaseSec = (log || []).filter((r) => r.date === tk).reduce((a, r) => a + (r.seconds || 0), 0);
    } catch { /* ignore */ }
  }
  function renderToday() {
    // Add the current in-progress activity seconds so the seconds tick live.
    const live = todayBaseSec + (currentActivity ? activitySeconds : 0);
    const mins = Math.floor(live / 60), secs = Math.round(live % 60);
    const goalMin = getGoalMinutes();
    if (todayVal) todayVal.textContent = `${mins}m ${secs}s`;
    if (goalVal) goalVal.textContent = goalMin + "m";
  }
  refreshTodayBase();
  renderToday();
  setInterval(refreshTodayBase, 30000);
  setInterval(renderToday, 1000); // refresh the seconds every second

  function fmtPomo(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(s / 60), sec = s % 60;
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  function renderPomo() {
    const live = pomoPaused ? pomoRemainMs : (pomoEnd ? pomoEnd - Date.now() : POMO_MS());
    const active = !!pomoEnd || pomoPaused;
    const txt = active ? "🎯 " + fmtPomo(live) : `🎯 专注 ${pomoMinutes}:00`;
    if (pomoBtn) { pomoBtn.textContent = active ? ("🎯 " + fmtPomo(live)) : `🎯 专注 ${pomoMinutes}:00`; pomoBtn.classList.toggle("running", active); }
    // Mini pill is always visible → the pomodoro is always reachable.
    if (pomoMini) { pomoMini.textContent = txt; pomoMini.hidden = false; };
  }
  function tickPomo() {
    if (pomoEnd && !pomoPaused) {
      if (Date.now() >= pomoEnd) {
        pomoEnd = 0; pomoPaused = false; pomoRemainMs = POMO_MS();
        renderPomo();
        toast("⏰ 专注计时结束！休息一下吧。", "success");
        return;
      }
      renderPomo();
    }
  }
  setInterval(tickPomo, 1000);
  renderPomo();

  // Pomodoro detail modal (set time / start-pause / reset). Built on the fly.
  function openPomoDetail() {
    const active = !!pomoEnd || pomoPaused;
    const live = pomoPaused ? pomoRemainMs : (pomoEnd ? Math.max(0, pomoEnd - Date.now()) : POMO_MS());
    openModal(`
      <h2>🎯 专注计时</h2>
      <div class="field"><label>专注时长（分钟）</label>
        <input type="number" id="pomo-min" min="1" max="180" value="${pomoMinutes}" style="width:110px;padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:14px">
      </div>
      <div class="sub" style="margin:6px 0 12px">当前状态：<b id="pomo-status">${active ? (pomoPaused ? "已暂停(" + fmtPomo(pomoRemainMs) + ")" : "专注中(" + fmtPomo(live) + ")") : "未开始"}</b></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-accent" id="pomo-start">${pomoPaused ? "▶ 继续" : pomoEnd ? "⏸ 暂停" : "▶ 开始专注"}</button>
        <button class="btn btn-ghost" id="pomo-reset">↺ 重置</button>
        <button class="btn btn-ghost" id="pomo-close">关闭</button>
      </div>`);
    $("#pomo-close").addEventListener("click", closeModal);
    $("#pomo-reset").addEventListener("click", () => { pomoEnd = 0; pomoPaused = false; pomoRemainMs = POMO_MS(); renderPomo(); closeModal(); toast("已重置专注计时"); });
    $("#pomo-start").addEventListener("click", () => {
      const mins = parseInt($("#pomo-min").value, 10);
      if (mins > 0) { pomoMinutes = Math.max(1, Math.min(180, mins)); try { localStorage.setItem("mbbs_pomo_min", String(pomoMinutes)); } catch { /* ignore */ } }
      if (pomoPaused) { pomoEnd = Date.now() + pomoRemainMs; pomoPaused = false; }
      else if (pomoEnd) { pomoRemainMs = Math.max(0, pomoEnd - Date.now()); pomoEnd = 0; pomoPaused = true; }
      else { pomoRemainMs = POMO_MS(); pomoEnd = Date.now() + POMO_MS(); pomoPaused = false; }
      renderPomo(); closeModal();
    });
  }
  if (pomoBtn) pomoBtn.addEventListener("click", (e) => { e.stopPropagation(); openPomoDetail(); });
  if (pomoMini) pomoMini.addEventListener("click", openPomoDetail);

  // Collapse / restore the pet. The button lives OUTSIDE #pet (see index.html):
  // it used to be a child, which meant collapsing the pet hid the only control
  // that could bring it back — the pet could be dismissed but never restored from
  // the page itself.
  if (hideBtn) hideBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    hidden = !hidden;
    applyPetState();
    toast(hidden ? "已收起宠物 — 专注计时仍在右下角，点 🐾 可以再打开" : "🐾 桌宠回来了");
  });

  // Drag the pet.
  let dragging = false;
  pet.addEventListener("pointerdown", (e) => {
    dragging = false;
    pet.setPointerCapture(e.pointerId);
  });
  pet.addEventListener("pointermove", (e) => {
    if (!pet.hasPointerCapture(e.pointerId)) return;
    dragging = true;
    pet.classList.add("dragging");
    const w = pet.offsetWidth, h = pet.offsetHeight;
    let left = e.clientX - w / 2, top = e.clientY - h / 2;
    // Keep the pet fully inside the viewport AND clear of the bottom-right corner
    // where the focus pill lives, so the two never stack on top of each other.
    const pillGuard = 46;
    left = Math.max(0, Math.min(window.innerWidth - w, left));
    top = Math.max(0, Math.min(window.innerHeight - h - pillGuard, top));
    pet.style.left = left + "px";
    pet.style.top = top + "px";
    pet.style.right = "auto";
    pet.style.bottom = "auto";
    try { localStorage.setItem("mbbs_pet_pos", JSON.stringify({ left, top })); } catch { /* ignore */ }
  });
  pet.addEventListener("pointerup", () => { pet.classList.remove("dragging"); });

  // A saved position from a larger window (or a bigger monitor) can leave the pet
  // hanging off-screen after a resize, which is the worst version of "it covers my
  // work" — it covers nothing and cannot be dragged back. Pull it into view.
  const clampPetToViewport = () => {
    if (!pet.style.left) return;                 // still using the default corner
    const w = pet.offsetWidth, h = pet.offsetHeight;
    const left = Math.max(0, Math.min(window.innerWidth - w, parseFloat(pet.style.left) || 0));
    const top = Math.max(0, Math.min(window.innerHeight - h - 46, parseFloat(pet.style.top) || 0));
    pet.style.left = left + "px";
    pet.style.top = top + "px";
    try { localStorage.setItem("mbbs_pet_pos", JSON.stringify({ left, top })); } catch { /* ignore */ }
  };
  window.addEventListener("resize", clampPetToViewport);
  clampPetToViewport();
}
async function saveGoalMinutes(m) {
  const n = parseInt(m, 10);
  const val = n > 0 ? n : 30;
  const res = await api.saveConfig({ goal_minutes: val });
  if (res.error) { toast(res.error, "error"); return false; }
  await loadAppConfig();
  return true;
}
function goalCelebratedKey() {
  return "mbbs-goal-celebrated:" + dayKey(new Date());
}
async function checkGoalCelebration() {
  try {
    const goalSec = getGoalMinutes() * 60;
    const tk = dayKey(new Date());
    const log = await db.getAll("studyLog");
    const todaySec = log.filter((r) => r.date === tk).reduce((a, r) => a + r.seconds, 0);
    if (todaySec >= goalSec && !localStorage.getItem(goalCelebratedKey())) {
      localStorage.setItem(goalCelebratedKey(), "1");
      toast(`🎉 Daily goal reached — ${fmtDuration(todaySec)} studied today!`, "success");
    }
  } catch { /* ignore transient errors */ }
}

/* ---------------- LLM prompts ---------------- */
/* ---------------- Study profile: subject-adaptive prompts ----------------
 * The generation prompts are derived from the active study profile, so the same
 * build can serve a medicine programme or a science programme. `SYS` stays a
 * module-level binding because all thirteen prompt sites read it directly; it is
 * rebuilt whenever the config loads.
 */
const DEFAULT_STUDY = {
  site_title: "MBBS Revision",
  site_sub: "Active Recall · Spaced Repetition",
  learner: "a medical student",
  language: "en",
  auto_subject: true,
  subjects: [{
    id: "general",
    name: "Medicine",
    keywords: [],
    focus: "anatomy, physiology, pathology, clinical features and signs, investigations, diagnosis and differential, treatment and management",
  }],
};

// Single entry point for (re)loading the server config: every call site also
// re-derives the prompt language/site branding from the (possibly changed) study
// profile, so editing the profile in Settings takes effect on the next action.
async function loadAppConfig() {
  try {
    appConfig = await api.getConfig();
  } catch {
    appConfig = { has_text_key: false, has_vision_key: false };
  }
  // Trial mode: browsing is public, AI is not. The server enforces that (401 on
  // /api/llm and /api/vision); telling the API client here turns the refusal into one
  // clear sentence instead of a generic "unauthorized" in the middle of a
  // generation, and the sidebar says the same thing before anyone clicks. The
  // owner's own browser still holds a token and keeps the full site.
  api.setTrialMode(!!appConfig.trial && !appConfig.trial_owner);
  SYS = buildSys();
  applySiteBranding();
  applyModeBanner();
  return appConfig;
}

// One sidebar notice for the two "no login screen" situations: trial mode (browsing
// is public, AI is not) and an instance with no password at all (the local default).
function applyModeBanner() {
  const trial = !!(appConfig && appConfig.trial && !appConfig.trial_owner);
  const open = !!(appConfig && appConfig.open);
  const mode = trial ? "trial" : (open ? "open" : "");
  // Log out only means something once there is a password to log back in with.
  const lo = document.getElementById("btn-logout");
  if (lo) lo.style.display = open ? "none" : "";
  const existing = document.getElementById("trial-banner");
  if (!mode) { if (existing) existing.remove(); return; }
  if (existing && existing.dataset.mode === mode) return;
  if (existing) existing.remove();
  const el = document.createElement("div");
  el.id = "trial-banner";
  el.dataset.mode = mode;
  el.className = "trial-banner" + (mode === "open" ? " open-banner" : "");
  el.innerHTML = mode === "trial"
    ? "<b>试用版</b> · 可自由浏览全部课程<br><span>AI 生成 / 上传 / 导出需要密码</span>"
    : "<b>免密模式</b> · 本机使用无需登录<br><span>想加密码：设置 → Account</span>";
  const nav = document.getElementById("nav");
  if (nav && nav.parentElement) nav.parentElement.insertBefore(el, nav.nextSibling);
}

// The study profile owns the site's name, so the shell reflects it without a
// separate build.
function applySiteBranding() {
  const prof = studyProfile();
  if (prof.site_title) {
    document.title = prof.site_title;
    document.querySelectorAll(".brand-title").forEach((el) => { el.textContent = prof.site_title; });
  }
  if (prof.site_sub) {
    document.querySelectorAll(".brand-sub").forEach((el) => { el.textContent = prof.site_sub; });
  }
}

function studyProfile() {
  const s = (appConfig && appConfig.study) || {};
  return {
    ...DEFAULT_STUDY,
    ...s,
    subjects: (Array.isArray(s.subjects) && s.subjects.length) ? s.subjects : DEFAULT_STUDY.subjects,
  };
}

// The student's own note / provenance for a course, shown under the title.
function courseBriefBox(lesson) {
  const brief = String((lesson && lesson.brief) || "").trim();
  const range = String((lesson && lesson.pageRange) || "").trim();
  const sources = Array.isArray(lesson && lesson.sources) ? lesson.sources : [];
  if (!brief && !range && sources.length < 2) return "";
  return `
    <div class="sub" style="margin-top:9px;padding:9px 12px;background:var(--surface-2);border-radius:9px;font-size:12.5px;line-height:1.65;max-width:70ch">
      ${brief ? `📝 ${escapeHtml(brief)}<br>` : ""}
      ${range ? `📄 页码范围：${escapeHtml(range)}<br>` : ""}
      ${sources.length > 1 ? `📎 来源文件：${sources.map((x) => `${escapeHtml(x.filename || "")}（${x.pages || 0}页）`).join("、")}` : ""}
      <div style="margin-top:6px"><button class="chip" id="btn-edit-brief" style="padding:2px 9px;font-size:11.5px">✎ 编辑说明</button></div>
    </div>`;
}

function subjectById(id) {
  const prof = studyProfile();
  return prof.subjects.find((s) => s.id === id) || null;
}

// Longest-keyword match wins, so "生理学实验" binds to the lab subject rather
// than the broader "生理" one; an explicit lesson.subjectId always wins.
function subjectForLesson(lesson) {
  const prof = studyProfile();
  if (lesson && lesson.subjectId) {
    const hit = subjectById(lesson.subjectId);
    if (hit) return hit;
  }
  const title = String((lesson && lesson.title) || "");
  if (prof.auto_subject && title) {
    let best = null, bestLen = 0;
    for (const s of prof.subjects) {
      for (const k of (s.keywords || [])) {
        const kk = String(k || "").trim();
        if (kk && title.toLowerCase().includes(kk.toLowerCase()) && kk.length > bestLen) {
          best = s; bestLen = kk.length;
        }
      }
    }
    if (best) return best;
  }
  return subjectById("general") || prof.subjects[prof.subjects.length - 1] || DEFAULT_STUDY.subjects[0];
}

// The language contract every generation prompt shares.
function languageRule(lang) {
  if (lang === "bilingual") {
    return 'Write in CHINESE. Chinese is the main language of every sentence — do not write English sentences and do not add a separate English translation line. The ONLY English is a parenthetical gloss for terminology: the first time a specialised term, structure, molecule, technique, disease or concept appears, put the English in parentheses straight after the Chinese, e.g. "静息膜电位（resting membrane potential）", "钠钾泵（Na⁺/K⁺-ATPase）". Do this once per point, for terms a student would meet in English textbooks or exams — not for ordinary words. Keep symbols, formulas, gene/protein names, units and standard abbreviations exactly as the slides write them.';
  }
  if (lang === "zh") {
    return "Write in clear Chinese, keeping established scientific terms, symbols and formulas in their standard form, with the English term in parentheses where that is the usual convention.";
  }
  return "Write in clear English using precise terminology.";
}

// The student's own note about a course ("chapter 3, focus on regulation; pages
// 10-15 are examinable"). It is authoritative guidance for scope and emphasis,
// so every generation prompt carries it verbatim.
function briefBlock(brief) {
  const b = String(brief || "").trim();
  if (!b) return "";
  return `\nSTUDENT'S CONTEXT FOR THIS COURSE (treat as authoritative guidance about scope and emphasis; do not contradict it):\n${b}\n`;
}

// Quantitative points are useless without the working: a bare "Y ≈ 0.91" cannot
// be checked or reproduced. This rule forces the substitution and the arithmetic
// to be written out, and is shared by the point, card and quiz prompts.
const DERIVATION_RULE = [
  'SHOW THE WORKING for anything quantitative. Whenever a point, card, option or answer involves a formula, a derivation or a calculation, do NOT state only the result. Write the chain so a student can follow and reproduce it:',
  '  1. the formula itself;',
  '  2. the same formula with the actual numbers and units substituted;',
  '  3. the intermediate arithmetic, step by step (simplify the denominator, cancel units, ...);',
  '  4. the final value WITH its unit, then a one-line sanity check (order of magnitude, limiting case, or whether the size/sign makes physical sense).',
  'Example shape: $Y = \\frac{[L]}{K_d + [L]} = \\frac{10^{-5}}{10^{-6} + 10^{-5}} = \\frac{10^{-5}}{1.1\\times10^{-5}} \\approx 0.91$ — at 10× K_d the receptor is about 91% occupied.',
  'NEVER present a computed number on its own: a result without its derivation counts as incomplete. Keep every formula in LaTeX ($...$ or $$...$).',
].join('\n');

// The site renders formulas with KaTeX, so the AI must emit LaTeX rather than
// plain text like "v = Vmax[S]/(Km+[S])". Shared by every prompt via buildSys.
const MATH_RULE = 'Write every mathematical expression as LaTeX: inline math inside $...$ (e.g. $K_d = \\frac{[L][R]}{[LR]}$), and a standalone equation on its own line inside $$...$$. Subscripts, superscripts, fractions, Greek letters, units and chemical equations all belong in math mode — never write a bare formula like v = Vmax[S]/(Km+[S]).';

// The language contract is stated in the system prompt, but long task
// instructions (the MCQ prompt especially) make the model drift away from it —
// only about a third of generated items carried the gloss. So the rule is
// repeated inside each task prompt, right where the content is written.
// Subject-specific generation rules, written per subject in the study profile.
// The template stays shared (so every fix to the common rules reaches all
// subjects), while these two fields make each subject's output genuinely
// different: `quiz` shapes the question types, `notes` shapes the notes.
function subjectQuizRule(subject) {
  const q = String((subject && subject.quiz) || "").trim();
  if (!q) return "";
  return `\nSUBJECT QUESTION STYLE — this course is ${subject.name}. ${q}\n`;
}

function subjectNotesRule(subject) {
  const n = String((subject && subject.notes) || "").trim();
  if (!n) return "";
  return `\nSUBJECT NOTES FOCUS — this course is ${subject.name}. In every explanation: ${n}\n`;
}

function languageReminder() {
  const lang = studyProfile().language;
  if (lang === "bilingual") {
    return 'LANGUAGE (applies to every field below): write in Chinese. The FIRST time a specialised term appears in a field, put its English in parentheses, e.g. "流动镶嵌模型（fluid mosaic model）", "扩散系数（diffusion coefficient）". Do this in the question stem AND in the options and explanation. Keep ordinary words Chinese-only — do not gloss them.';
  }
  if (lang === "zh") return 'LANGUAGE: write in Chinese.';
  return 'LANGUAGE: write in English.';
}

function buildSys() {
  const prof = studyProfile();
  return `You are an expert educator preparing concise, exam-focused revision material for ${prof.learner}. ${languageRule(prof.language)} ${MATH_RULE} Respond with ONLY valid JSON (no markdown fences, no commentary).`;
}

let SYS = buildSys();

const pointsPrompt = (chunk, outline, subject, brief) => `Extract ALL the important knowledge points from these lecture slides for exam revision.${briefBlock(brief)}

${languageReminder()}${subjectNotesRule(subject)}

${DERIVATION_RULE}

Cover everything the slides present, with particular attention to: ${(subject && subject.focus) || "core concepts, mechanisms, key facts and quantities"}. Also capture any names, symbols, units, numbers, formulas, definitions, classification criteria and experimental methods the slides state. Do not miss noteworthy or easily-confused details. Be comprehensive and FINE-GRAINED — extract every distinct, individually-testable point as its OWN separate point; NEVER merge related-but-distinct concepts into one broad point.

SKIP ATTRIBUTION AND PRIORITY TRIVIA. Do NOT create a point out of who discovered, proposed or first described something, the year it happened, the journal or textbook it appeared in, or a prize it won — these come from the slides' history and reference sections and are not knowledge a student needs. A knowledge point must be something the student has to UNDERSTAND or be able to APPLY. The only exception is when the slide treats the attribution itself as core examinable content. Aim for 2-4 points per CONTENT slide (fewer on a thin slide, and none at all on a structure slide — see below); a single named entity, quantity or mechanism discussed on one slide deserves its OWN point. Prefer MORE, finer points over summarizing or collapsing.

STRUCTURE SLIDES ARE NOT CONTENT — do not mine them for points. An outline, agenda, "Part List"/"Behavior List", "what we will cover", lecture roadmap, recap or summary, overview-of-techniques, "Any questions?", title, section-divider, acknowledgement or reference/citation slide only LISTS what is coming or what has passed; it does not teach it. On those slides:
  - A topic that appears only as a bullet gets NO point, however much you know about it. Never expand such a bullet into an explanation of your own.
  - Why this matters: a point written off an outline bullet is filed under the OUTLINE's page number, which drags a whole block of the lecture to the front of the reading order and leaves the slides that actually teach that topic referenced by nobody.
  - Every point must come from the slide that teaches it, and carry THAT slide's number.

MANDATORY completeness — account for every CONTENT slide and surface EVERY named concrete entity the text mentions: if a specific item is named (a molecule, pathway, technique, model, theorem, experiment, researcher or organism), give it its OWN point with what the slides say about it; if a content slide explains several such items, each gets its own point. Do NOT only give conceptual overviews while skipping named entities — those are what a student must memorise. Return JSON {"points":[...]} with every point found.

${outline ? `LECTURE STRUCTURE — these are the ONLY valid level-1 topics:
${outline}
"category" must be [topic, subtopic, aspect]:
  - topic: copy one of the level-1 labels above EXACTLY, character for character. Never invent, rename, reword, translate or pluralise it — a variant spelling splits the tree into parallel branches.
  - subtopic: the specific sub-area this point belongs to. Copy that topic's subtopic label exactly when one fits; otherwise a short concrete noun phrase naming it. It MUST genuinely sit inside the topic: a host-defence mechanism must NOT be filed under a disease topic such as "Pharyngitis".
  - aspect: OPTIONAL third level. Add it ONLY when it truly separates this point from its siblings inside the same subtopic, and then use a concrete item or a specific angle (e.g. "Nasal hairs", "Centor score", "Loading dose"). NEVER use generic filler ("Definition", "Overview", "Treatment", "Pathophysiology", "Anatomy", "Physiology", "Classification", "Etiology", "Clinical features", "Management") and NEVER restate the point's own title. If no such label exists, return [topic, subtopic] only — 2 levels is the normal case, not a failure.
  - Reuse identical labels for related points so they group together.` : `"category" is 2-3 labels from BROAD to SPECIFIC, e.g. ["Shock", "Hypovolemic shock", "Clinical stages"]. Rules: level 1 = a main teaching block of this lecture, NOT the lecture title restated and NOT a generic subject word ("Pathology"/"Introduction"/"Overview"/"Classification"/"Management"); ALL level-1 labels must be the SAME granularity and use ONE canonical spelling each (never both "Chest wall anatomy" and "Anatomy of the chest wall"). Level 2 must be a concrete sub-area that genuinely belongs to level 1. Level 3 is OPTIONAL: only when it truly distinguishes sibling points, using a concrete item or specific angle — never a generic word and never a restatement of the point's title; otherwise return 2 levels. Reuse identical labels for related points.`}

For each key point return:
- "title": a specific, concise heading
- "category": [topic, subtopic, aspect] as described above
- "explanation": a single STRING of bullet points (each line starting with "- ", lines separated by newlines), covering the mechanism or reasoning, the key facts, the numbers/units, and why it matters in this subject. Use 3-5 bullets normally; if the point is quantitative, ONE bullet MUST carry the full worked derivation (per SHOW THE WORKING above) and you may use extra bullets for it. Do NOT return it as an array.
- "importance": "high" | "medium" | "low"
- "mnemonic": a short memory aid, or null
- "tags": 1-3 short topic tags (e.g. "Cardiology", "Pharmacology")
- "keyTerms": 2-5 exact key terms or phrases from the explanation to highlight
- "slide": the number of the slide that actually TEACHES this point, taken from the "Slide N:" labels. It must never be an outline / agenda / recap / title / reference slide that merely mentions the topic (see STRUCTURE SLIDES above)
- "supplement": OPTIONAL, ONLY for genuinely complex / easily-confused / high-yield points. A short, plain-Chinese INTUITIVE explanation that makes it easy to understand and remember — e.g. an analogy, a memory trick, a rule of thumb, or a "why this matters in practice" note. Write it as an everyday, vivid explanation in Chinese (1-2 sentences). Set to null for simple points — do NOT pad every point. This is woven into the note's body.

Order the points in the most efficient, logical learning sequence — foundational concepts and definitions first, then mechanisms and derivations, then applications, methods and worked results.

Return JSON: {"points":[...]}

Slides:
---
${chunk}
---`;

const outlinePrompt = (title, summary, brief) => `Build the FIXED topic skeleton that will be used to classify every knowledge point of this lecture. Consistency matters far more than elegance: every point will later be filed under exactly one of these labels, so a wobbly skeleton produces a messy tree.

Lecture title: ${title}

Slide titles:
${summary}

Return JSON: {"sections":[{"topic":"Main topic, 1-5 words","subtopics":["Sub-topic, 1-5 words","..."]}]}
${briefBlock(brief)}

RULES — follow all of them:
1. Return 3-6 topics. Together they must PARTITION the lecture: every slide falls under exactly one topic (no gaps, no overlaps).
2. A topic is a teaching block of THIS lecture — NOT the lecture title restated, and NOT a generic school subject.
   - BAD (title restated): lecture "Respiratory tract infections" -> topic "Respiratory tract infections".
   - BAD (generic): "Pathology", "Introduction", "Overview", "Classification", "Management", "General", "Anatomy", "Physiology".
   - GOOD for that lecture: "Host defences of the respiratory tract", "Upper respiratory tract infections", "Lower respiratory tract infections", "Specific pathogens and treatment".
3. All topics must be at the SAME granularity. Never mix a whole system ("Circulatory system") with an organ ("Heart") or one disease ("Shock").
4. ONE canonical name per concept. Never emit near-duplicates: do NOT list both "Chest wall anatomy" and "Anatomy of the chest wall" — pick exactly one spelling and reuse it everywhere, because variants split the tree into parallel branches.
5. Each topic gets 2-6 subtopics: concrete nouns (structures, diseases, mechanisms, drug classes), mutually exclusive, and genuinely INSIDE that topic — a host-defence mechanism must never sit under a disease such as "Pharyngitis".
6. Order topics, and the subtopics within each topic, in teaching order (the order they appear in the slides).
7. Names are short noun phrases, Title Case, no trailing punctuation, no numbering.`;

const coveragePrompt = (chunk, titles, outline, subject, brief, gapsNote = "") => `Here are lecture slides and the knowledge points already extracted from the whole lecture.

${languageReminder()}

Focus on the same dimensions as the main extraction: ${(subject && subject.focus) || "core concepts, mechanisms, key facts and quantities"}.${briefBlock(brief)}

Fill gaps ONLY from slides that actually teach something. Never add a point for a topic that appears merely as a bullet on an outline / agenda / recap / overview-of-techniques / title / reference slide — those lists are not content, and a point filed under such a page pushes a block of the lecture out of reading order. Each added point must carry the number of the slide that teaches it.

Already extracted points (titles): ${titles}

${outline ? `LECTURE STRUCTURE — these are the ONLY valid level-1 topics:\n${outline}\n` : ""}
CATEGORY RULES (identical for every point): "category" is [topic, subtopic, aspect]. topic = copy a level-1 label above EXACTLY (never rename/pluralise it, one canonical spelling only). subtopic = a concrete sub-area that genuinely belongs to that topic (a host-defence mechanism must not sit under a disease topic). aspect = OPTIONAL; use a concrete item or specific angle that separates sibling points, never a generic word ("Definition"/"Treatment"/"Pathophysiology"/"Anatomy"/"Physiology"/"Classification"/"Management") and never a restatement of the point's title; otherwise return [topic, subtopic] only.

Slides:
---
${chunk}
---
${gapsNote}
Find IMPORTANT knowledge points in these slides that are MISSING from the "already extracted" list (not covered by any existing title). Return them as JSON in the same format:
{"points":[{"title":"...","category":["topic","subtopic","aspect"],"explanation":"...","importance":"high|medium|low","mnemonic":"... or null","tags":["..."],"keyTerms":["..."],"slide":N}, ...]}

Be thorough: scan every slide in the chunk and check EVERY named concrete entity (specific drugs, structures, nerves, muscles, procedures, causes, types). If a named entity is NOT already covered by an existing title, add it as its own point. Do not skip named drugs/structures just because the concept seems similar — each distinct named entity is its own point. If everything important is already covered, return {"points":[]}.`;

// Re-file existing points under a (possibly rebuilt) skeleton WITHOUT
// regenerating any content — used by "重新整理分类" to fix old lessons whose
// hierarchy was produced by the earlier, looser category rules.
const reclassifyPrompt = (itemsText, outline) => `Assign a "category" to each knowledge point of this lecture, using ONLY the lecture structure below. Do not rewrite, add or remove points — you are only filing them.

LECTURE STRUCTURE — these are the ONLY valid level-1 topics:
${outline}

CATEGORY RULES:
- topic: copy one of the level-1 labels above EXACTLY, character for character. Never invent, rename, reword, translate or pluralise it — a variant spelling splits the tree into parallel branches.
- subtopic: the specific sub-area this point belongs to. Copy that topic's subtopic label exactly when one fits; otherwise a short concrete noun phrase naming it. It MUST genuinely sit inside the topic: a host-defence mechanism must NOT be filed under a disease topic such as "Pharyngitis".
- aspect: OPTIONAL third level. Add it ONLY when it truly separates this point from its siblings inside the same subtopic, and then use a concrete item or a specific angle (e.g. "Nasal hairs", "Centor score", "Loading dose"). NEVER generic filler ("Definition", "Overview", "Treatment", "Pathophysiology", "Anatomy", "Physiology", "Classification", "Etiology", "Clinical features", "Management") and NEVER a restatement of the point's own title. Otherwise return [topic, subtopic] only — 2 levels is the normal case.
- Reuse identical labels for related points so they group together.

Points:
${itemsText}

Return JSON: {"categories":[{"i":1,"category":["topic","subtopic","aspect"]}, ...]}
Include EVERY point exactly once, keyed by the index number shown above.`;

const cardsPrompt = (ptext, subject) => `Create active-recall flashcards from these key points. "front" = a question or cloze-style prompt that forces recall; "back" = a concise, specific answer (1-3 sentences).

${languageReminder()}${subjectNotesRule(subject)}

${DERIVATION_RULE}

STRICT rules — a card earns its place only if answering it teaches the subject:
- ONE FACT PER CARD. If a key point carries a list, make one card per item, or one card for the principle that organises the list. Never a card whose answer is "A, B, C and D".
- TEST THE SUBJECT, NEVER THE LECTURE'S PACKAGING. No card asks what the learning outcomes, objectives or aims are, what the session covers, which textbook or chapter something came from, or how the course is assessed. Key points often contain such lines ("Learning outcomes: …", "Objectives: …", "References: …") — when one does, ignore the framing and make the card from the content it names; "What are the learning outcomes for X?" can only be answered by remembering how the slides were worded.
- NEVER ATTRIBUTION. No "who discovered / described / defined / cloned it", no "in which year", no "who won which prize". Test the fact, not the name and date. Names stay only where the name itself is examinable — an eponymous sign a clinician must recognise, for instance.
- THE FRONT MUST STAND ALONE. A student who has never seen these slides must be able to answer it. Never refer to "the diagram", "the figure above", "this table" or "slide N", and never ask what a picture shows — state the finding instead.
- Keep the answer to one or two sentences of real content: if an honest answer needs more, split it into several cards. Never answer with a paragraph.
- The front is a prompt, not a topic title — it must force recall of a specific fact ("Which nerve supplies …?", "What happens to X when Y?", "Why does Z …?"). Prefer why / what-happens questions over yes-no.
- Use only facts actually present in the key points: do not invent, assume or import outside knowledge, and keep every term exactly as the key points name it.

Return JSON: {"cards":[{"front":"...","back":"..."}]}

Key points:
${ptext}`;

const mcqPrompt = (ptext, n, subject, isRetry = false) => `Create EXACTLY ${n} single-best-answer multiple-choice questions (university exam style: a clear stem, one unambiguously best option) from these key points — one question for EACH of the ${n} points, so every point is tested. Do NOT produce fewer than ${n} questions; if a point is hard to make a question from, still make a valid one. Output all ${n}.${isRetry ? `

ONE OR MORE OF THESE WAS REJECTED BY AN AUTOMATIC CHECK because its explanation contradicted itself — it named a different option as correct, or called a wrong option "correct". Rewrite them so exactly ONE option is true and the explanation defends exactly that one.` : ""}

${languageReminder()}${subjectQuizRule(subject)}

Each question:
- "question": the question stem — a short scenario, applied problem or direct question
- "options": array of 4-5 answer choices
- "answer": integer index (0-based) of the correct option
- "explanation": 3-5 sentences, in this EXACT order: (1) name the correct option's letter and say why it is right; (2) then walk the OTHER options in letter order (A, B, C, D, E) and say why each one is wrong. Never call the correct option wrong, never call a wrong option right, and never leave an option unmentioned. Write it as a clean verdict — no thinking out loud, no "等等", "然而", "实际上", "该选项本身正确", "本题可能有问题" or any sentence that takes a verdict back.
- Refer to an option ONLY as "选项A" / "选项B" / … . Never write a bare letter as an option reference and never write lists of bare letters ("A、C、D"): the letters A–E are also chemical symbols, so a bare "C" between commas may be read as carbon and the explanation then says the opposite of what it means. "选项C的…" is unambiguous.
- "slide": the integer slide number (from the "[Slide N]" label in front of the point) where this question's concept mainly comes from; use the smallest slide number if it spans several

STRICT rules — anchor every question to the source material ONLY:
- TEST UNDERSTANDING, NEVER ATTRIBUTION. Do not write questions about who discovered, proposed, first described or named something; which scientist did it; in which year; in which journal; or who won which prize. These test recall of names and dates, teach the student nothing about the subject, and are the fastest way to make a question worthless. The ONE exception is when the key point itself is that attribution AND the course treats it as examinable — otherwise ignore every name, year and citation in the key points.
- TEST THE SUBJECT, NEVER THE LECTURE'S OWN PACKAGING. Never ask what the learning outcomes, objectives or aims are, what a "key point" or "stated objective" is, what the session will cover, what the lecturer recommends, which textbook/chapter/slide/page something came from, or how the course is assessed. "Which of the following is a stated learning outcome for X?" and "Which textbook is the primary reference for X?" are the worst questions in a bank: the only way to answer them is to remember how the slides were worded, so they teach no medicine at all. Expect the key points to contain such lines ("Learning outcomes: …", "Objectives: …", "References: …"): when a point is one of those, ignore its framing and test the content it names — from "Learning outcome: describe the causes and clinical features of intestinal obstruction" ask about the causes or the clinical features themselves. Never let the OPTIONS be the objective sentences either.
- Every stem must be answerable by a student who has never seen these slides but knows the subject. If the question cannot be answered without knowing how this particular lecture was organised, it is not a question about medicine — rewrite it around the underlying fact.
- Prefer questions that require reasoning — "why does this happen", "what would change if", "which prediction follows", "which quantity results" — over questions that ask for a bare fact. A student who understands the material should be able to answer; a student who only memorised a phrase should not.
- Every question and every option must come from facts actually present in the key points. Do NOT introduce, invent, or assume any concept, structure, number, or terminology that is not in the key points. Do not borrow from general knowledge.
- You may only base a question on a concept the key points actually state. If a concept isn't in the key points, don't test it.
- There must be exactly ONE clearly-correct option; every distractor must be unambiguously wrong AND drawn from related concepts that also appear in the key points (so it's a fair distractor, not a made-up one). NEVER let a distractor also be correct — e.g. if both the SA node and AV node are correct for a stem, do NOT write that question; choose a stem with exactly one clear answer.

SELF-CHECK each question before returning it — this is where these questions most often break:
- Read every NON-answer option on its own, as a standalone statement about the subject. If it is ALSO true (even if it does not match the answer exactly, or is about a related structure), the question is broken: rewrite that option so it is factually FALSE, or change the stem. A distractor must be wrong, not merely less complete.
- A stem phrased "which of the following is CORRECT?" is the usual culprit, because any true statement satisfies it. Prefer making the distractors clearly false; if you cannot, phrase the stem as "which of the following is INCORRECT?" instead and make exactly one option false.
- "Partly right" options (a true clause glued to a false clause) are ambiguous for the same reason — either make the whole option false, or drop it.
- "Which one BEST shows / is MOST accurate…" is the same trap: the other options are still true statements and the student cannot tell them apart. Do not write a "most accurate" stem at all — give a stem that only one option satisfies, and make every other option false.
- Do not test two related true facts with one stem: if two options describe two genuinely correct mechanisms, merge them into the correct option or drop one, so a well-prepared student can only pick one.
- Never write two options that are two halves of the same fact (one mechanism split across two choices), and never write a distractor whose only flaw is what it leaves out: that is the same ambiguity.
- Every distractor must be a FALSE statement about this subject. The wrongness must be in the option's text (a reversed direction, a swapped structure, a wrong number/unit, a mechanism that does not exist), so a student who knows the material can rule it out by reading it alone.
- Vary the OPTION ORDER so the correct answer is not always "A" — place the correct option at varied positions (A/B/C/D/E).
- Keep the options the same SHAPE: comparable length, same grammatical form, same level of specificity, all in the same language. The correct option must never be the longest, the most detailed, or the only hedged one — students learn to exploit that instead of reasoning.
- Never use "以上都对 / 以上都错 / A 和 B 都对 / 以上都不是" style options. They collapse the question into a guess.
- Make each distractor a PLAUSIBLE mistake rather than random nonsense: base it on a confusion a student could genuinely have (mixing up two structures, reversing a direction, swapping the regulator, using the wrong relation, forgetting a factor) so the explanation can teach by correcting it.
- Vary the DEPTH across the set: some items should test a fact that simply has to be known, others should require applying or reasoning about it. Do not make every item the same depth.
- Every stem must stand on its own: a student should understand what is being asked before reading the options. Do not write stems whose answer is "it depends" without saying what it depends on.
- Prefer POSITIVE questions ("Which… is a…", "What structure…"). Use an exclusion "NOT / EXCEPT" item ONLY when the key points explicitly list a closed set of members and exactly one is genuinely excluded — and state that boundary using ONLY the key points' own wording.
- Keep every term to the exact name used in the key points.

Return JSON: {"questions":[...]}

Key points:
${ptext}`;

// LLMs often put the correct option first (answer always "A"). Shuffle each
// question's options so the correct answer lands at a random position. This
// keeps the explanation valid (it describes the answer's CONTENT, not position).
/* Rewrite the option letters quoted inside an explanation so they still point
 * at the same options after the choices have been shuffled.
 *
 * The AI writes "B正确，A、C错误" against the order it produced. Shuffling moves
 * the options but leaves that text alone, so without this the explanation ends
 * up describing a different option than the stored answer (24% of one real
 * question bank was wrong this way).
 *
 * Only text that clearly refers to an option is touched — a lone letter before
 * 正确/错误/项/是, a letter after 选项, or a letter inside a "、" or "，" list.
 * A letter inside a word (维生素B, 维生素D) is left alone.
 */
function remapOptionLetters(text, order, count) {
  const last = String.fromCharCode(64 + Math.min(count, 26));
  const LETTER = "[A-" + last + "]";
  // old letter -> new letter
  const map = {};
  for (let newI = 0; newI < order.length; newI++) {
    map[String.fromCharCode(65 + order[newI])] = String.fromCharCode(65 + newI);
  }
  const swap = (letter) => map[letter] || letter;
  let out = String(text);
  // "B正确" / "B项错误" / "B是正确答案". The verdict word must be a real one:
  // a bare 是/对/为 would also match prose like "维生素D是脂溶性…", which is not
  // an option reference at all.
  out = out.replace(new RegExp("(^|[^A-Za-z0-9])(" + LETTER + ")(?=\\s*(?:项)?\\s*(?:正确|错误|不正确|不对|符合|不符))", "g"),
    (m, pre, L) => pre + swap(L));
  out = out.replace(new RegExp("(^|[^A-Za-z0-9])(" + LETTER + ")(?=\\s*[对错](?=[，。；：、\\s)）]|$))", "g"),
    (m, pre, L) => pre + swap(L));
  out = out.replace(new RegExp("(^|[^A-Za-z0-9])(" + LETTER + ")(?=\\s*是\\s*(?:正确|错误|对|错|答案))", "g"),
    (m, pre, L) => pre + swap(L));
  // "选项B" — the only form the generator is allowed to use for a bare option
  // reference, and the only one that is always safe to remap.
  out = out.replace(new RegExp("(选项\\s*)(" + LETTER + ")", "g"), (m, pre, L) => pre + swap(L));
  // Bare letters in lists are NOT remapped any more. Chemical symbols sit in the
  // same A–E range separated by the same 、/，, so the old list rules rewrote real
  // chemistry: "原子——Cα、O、C、N、H、Cα——共面" came back as "Cα、O、D、N、H、Bα".
  // The generator now refers to options as 选项A / 选项B (see mcqPrompt), which the
  // rule above covers.
  return out;
}

/* Which option does the explanation itself call the correct one?
 *
 * The generator is told to open with "X正确：…" and then rule out the rest. When
 * it instead says a different option is correct — or writes "B错误：…该选项描述
 * 正确" — the question is self-contradictory and sometimes has two true options.
 * Returns the 0-based index, or null when no verdict can be read.
 *
 * Used twice: quizPrompt's questions are checked before they are saved, and
 * shuffleQuizOptions uses it to detect a stale answer after remapping.
 */
function explanationAnswerLetter(text, count) {
  const last = String.fromCharCode(64 + Math.min(count || 5, 26));
  const L = "[A-" + last + "]";
  const src = String(text || "");
  const said = (re) => {
    const m = src.match(re);
    return m ? m[1].charCodeAt(0) - 65 : null;
  };
  // "B正确" / "B项正确" / "选项B正确" / "B是正确答案" / "B为正确选项" / "B对。"
  const verdict = new RegExp("(?:选项\\s*)?(" + L + ")\\s*(?:项)?\\s*(?:是|为)?\\s*(?:正确|对)(?![不])"
    + "|(?:选项\\s*)?(" + L + ")\\s*(?:项)?\\s*(?:是|为)\\s*正确答案");
  const m = src.match(new RegExp(verdict.source));
  if (m) {
    const letter = m[1] || m[2];
    return letter ? letter.charCodeAt(0) - 65 : null;
  }
  // "正确答案：C" / "正确答案是C"
  return said(new RegExp("正确答案[：:是]?\\s*(?:选项\\s*)?(" + L + ")"));
}

/* True when a question cannot be answered honestly.
 *
 * Two failures, both seen in real banks:
 *   * the explanation also calls a NON-answer option correct ("B错误：…但该
 *     选项描述正确" / "实际上C也是正确的") — the student can defend two choices;
 *   * the explanation's own verdict contradicts the stored "answer" index.
 * A question that trips either is dropped and regenerated rather than shown.
 */
const QUIZ_TAKEBACK = /(?:也|仍|其实|实际)?(?:是|为)?正确的[，。；]|该选项(?:本身)?正确|选项(?:本身)?(?:也)?正确|本题(?:可能)?有问题|需要重新检查|实际上[^。]{0,12}正确|但[^。]{0,24}正确/;
/* Questions about the LECTURE rather than about the subject: what the learning
 * outcomes/objectives are ("Which of the following is a stated learning outcome
 * for X?"), what the session will cover, which textbook or chapter something came
 * from, how the course is assessed. They can only be answered by remembering how
 * the slides were worded — they teach no medicine — and they were the most common
 * junk item in the real bank: 85 "learning outcome" questions out of 20,349, whose
 * options were literally the objective sentences off the slide.
 *
 * Deliberately narrow, because two of these patterns over-matched badly at first:
 * "What is the most likely outcome of this interaction?", "the functional outcome
 * of the reconstruction", "the main outcome of their work", "expected outcome for
 * the majority" are ordinary medical English and were being dropped wholesale. A
 * bare outcome/objective therefore never counts — it has to sit in a teaching
 * context ("outcome of this lecture", "lecture outcomes", "stated objectives") —
 * while phrases that merely SOUND meta stay: "What is the purpose of bolus
 * tracking in CT?", "Explain the clinical significance of venous anastomoses". */
const QUIZ_JUNK_STEM = [
  "learning\\s+(outcome|objective)s?",
  "(outcome|objective)s?\\s+(of|for)\\s+(this|the|these)\\s+(lecture|session|chapter|course|module|component|teaching|topic|block|unit)\\b",
  "lectures?'?s?\\s+(learning\\s+)?(outcome|objective|aim)s?\\b",
  "(aim|goal)s?\\s+of\\s+(this|the)\\s+(lecture|session|chapter|course|module|teaching)\\b",
  "at\\s+the\\s+end\\s+of\\s+(this|the)\\s+(lecture|session|chapter)",
  "\\b(objectives?|outcomes?)\\s+(listed|stated)\\b|\\b(listed|stated)\\s+(learning\\s+)?(objectives?|outcomes?)\\b",
  "which\\s+textbook\\b|according\\s+to\\s+the\\s+textbook\\b|\\bprimary\\s+textbook\\b|\\btextbook\\s+(reading|reference|edition)\\b",
  "\\b(recommended|further|suggested|required)\\s+reading\\b|\\breading\\s+list\\b",
  "\\b(course|module)\\s+guidelines?\\b|\\bassessment\\s+(criteria|format)\\b|\\bmarking\\s+scheme\\b|\\bexam\\s+format\\b",
  "what\\s+(will|would)\\s+(be\\s+)?covered\\b|\\bagenda\\s+(of|for)\\s+(this|the)\\s+(lecture|session|course|module|topic)",
  "which\\s+(chapter|slide|page)\\b|how\\s+many\\s+(slides|pages)\\b",
  // Chinese lectures: only asking forms, so a lecture that legitimately teaches a
  // study framework ("课程用智慧层次模型指导学习目标") is not swallowed by the noun alone.
  "学习目标(是|为|包括|有哪)|(本章|本节课|本讲|这门课|该课程)的?(学习目标|教学目的|教学大纲)|(下列|以下|哪个|哪一项)是.{0,10}(学习目标|教学目的)",
  "教学目的(是|为|包括)|本章目的|教学大纲|考试范围|参考书(是|为|哪)",
  "根据(本章|本节课|本讲|本课程|该课程)?的?(学习目标|教学大纲|教学目的|课程安排)",
  // Asking what the lecture covers, one level down from the objectives.
  "topics?\\s+(that\\s+are\\s+)?covered\\s+in\\s+(the|this)\\s+(lecture|session|chapter|course)|key\\s+topic\\s+covered",
  "what\\s+does\\s+(the|this)\\s+(lecture|session|chapter)\\s+(cover|discuss|address)",
  // Attribution and trivia. The prompt already bans "who discovered / which year"
  // items; these catch the few that still got through ("Who discovered X-rays, and
  // when?", "In which year did the WHO declare tuberculosis a global emergency?").
  // Deliberately NOT included: a stem that names a researcher while asking about the
  // finding itself ("Katz and co-workers … what was the outcome of their work?") —
  // that answer is real physiology, so it stays.
  "\\bwho\\s+(first\\s+)?(discovered|described|proposed|introduced|coined|invented|demonstrated|cloned|established|identified)\\b",
  "\\bin\\s+(which|what)\\s+year\\s+(did|was|were)\\b",
  "\\bwhich\\s+(scientist|researcher|physician)\\b",
  "\\bwho\\s+(won|defined)\\b|\\band\\s+who\\s+(described|discovered|proposed|defined)\\b",
  // Deliberately absent: "named after" and "eponym". Those words appear in real
  // questions about examinable names — why the hippocampus is called that, what
  // Duchenne's smile is, which protease is named for its substrate — so matching
  // them would delete good items along with the trivia.
];
const QUIZ_META = new RegExp(QUIZ_JUNK_STEM.join("|"), "i");
/* Option texts that collapse a question into a guess ("all of the above", "none of
 * the above", "A and B are both true"). The prompt bans them outright, so a
 * generated one means the request was ignored: drop the question and retry. The
 * bank cleaner reads this same literal and, where the offending option is only a
 * distractor, removes just that option instead of the whole question. */
const QUIZ_BANNED_OPTION = /all\s+of\s+the\s+above|none\s+of\s+the\s+above|\bboth\s+a\s+and\s+b\b|以上(都|均)对?|以上都不是|a\s*和\s*b\s*都/i;
function quizQuestionInvalid(q) {
  if (!q || !Array.isArray(q.options) || q.options.length < 2) return true;
  const n = q.options.length;
  const ans = Number(q.answer);
  if (!(ans >= 0 && ans < n)) return true;
  // A question about the lecture's own objectives/textbook cannot be answered from
  // the subject itself, so it is dropped and regenerated like any other broken item.
  if (QUIZ_META.test(String(q.question || ""))) return true;
  // "All of the above" / "None of the above" as an option: the prompt forbids it, so
  // one appearing means the instruction was ignored. It also silently breaks the
  // item whenever it is the correct choice, because then nothing in the options is
  // the fact being tested.
  if (q.options.some((o) => QUIZ_BANNED_OPTION.test(String(o)))) return true;
  // Four copies of the same choice (seen in a real bank: one citation repeated in
  // every slot) is not a question.
  if (new Set(q.options.map((o) => String(o))).size !== n) return true;
  const expl = String(q.explanation || "");
  if (!expl.trim()) return true;
  const said = explanationAnswerLetter(expl, n);
  if (said != null && said !== ans) return true;
  // The explanation must not describe another option as correct.
  const L = "[A-" + String.fromCharCode(64 + Math.min(n, 26)) + "]";
  const words = new RegExp("(?:选项\\s*)?(" + L + ")\\s*(?:项)?\\s*[^。；]{0,24}?"
    + "(?:也是?正确的|是正确的|描述正确|本身正确|正确(?=[，。；、]))", "g");
  let m;
  while ((m = words.exec(expl)) !== null) {
    if (m[1] && m[1].charCodeAt(0) - 65 !== ans) return true;
  }
  return QUIZ_TAKEBACK.test(expl);
}

function shuffleQuizOptions(questions) {
  (questions || []).forEach((q) => {
    if (!Array.isArray(q.options) || q.options.length < 2) return;
    const order = q.options.map((_, i) => i);
    const before = q.options.slice();
    const beforeExpl = q.explanation;
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    q.options = order.map((i) => q.options[i]);
    const oldAnswer = Number(q.answer);
    q.answer = order.indexOf(oldAnswer);
    // Keep the explanation's "B正确 / A错误" references aligned with the new order.
    if (q.explanation) {
      q.explanation = remapOptionLetters(q.explanation, order, q.options.length);
      // Last line of defence: if the explanation says a DIFFERENT option is the
      // correct one — the AI's own text contradicting its "answer" index, or a
      // remap that could not be followed — put the options back in the order the
      // explanation was written against (it is the model's own original order).
      // The explanation has to be rolled back too: keeping the remapped text while
      // restoring the options is what left stored banks with letters that no longer
      // matched their own answer key.
      const said = explanationAnswerLetter(q.explanation, q.options.length);
      if (said != null && said !== q.answer) {
        q.options = before;
        q.answer = oldAnswer;
        q.explanation = beforeExpl;
      }
    }
  });
  return questions;
}

const visionPrompt = `You are analyzing an image from a university lecture slide. Describe it for a student's revision notes. Return JSON:
{"type":"diagram|chart|histology|anatomy|table|photo|other","caption":"what it shows, one sentence","takeaway":"the key medical point a student should remember from it, one or two sentences"}`;

const figureDetectPrompt = `This is a lecture slide image. Find the medical/anatomical FIGURES on it (diagrams, drawings, charts, photos, labeled images) — ignore text-only regions.

For each figure return:
- "bbox": [x0, y0, x1, y1] — coordinates as FRACTIONS of the image (0 to 1), tightly around the figure
- "caption": what the figure shows, one sentence
- "takeaway": the key medical point to remember from it

Return JSON: {"figures":[{"bbox":[x0,y0,x1,y1],"caption":"...","takeaway":"..."}]}
If there are no figures (text only), return {"figures":[]}.`;

function cropImage(dataUrl, bbox) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth, h = img.naturalHeight;
        const v = bbox.map((n) => Math.min(1, Math.max(0, Number(n) || 0)));
        const x0 = Math.min(v[0], v[2]), x1 = Math.max(v[0], v[2]);
        const y0 = Math.min(v[1], v[3]), y1 = Math.max(v[1], v[3]);
        const cw = Math.round((x1 - x0) * w);
        const ch = Math.round((y1 - y0) * h);
        // Skip degenerate boxes (points/slivers) that would produce tiny black crops.
        if (cw < 80 || ch < 80 || cw / ch > 8 || ch / cw > 8) { resolve(null); return; }
        const canvas = document.createElement("canvas");
        canvas.width = cw; canvas.height = ch;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, Math.round(x0 * w), Math.round(y0 * h), cw, ch, 0, 0, cw, ch);
        // Skip near-black (empty) crops — e.g. a region with no visible content.
        try {
          const data = ctx.getImageData(0, 0, cw, ch).data;
          let dark = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] < 25 && data[i + 1] < 25 && data[i + 2] < 25) dark++;
          }
          if (dark / (data.length / 4) > 0.97) { resolve(null); return; }
        } catch { /* ignore pixel check failure */ }
        resolve(canvas.toDataURL("image/jpeg", 0.9));
      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error("image load failed"));
    img.src = dataUrl;
  });
}

// Interactive crop picker: show the full slide image and let the user drag/resize
// a selection box. On save, the chosen region (as fractions of the image) is
// stored as `slide.figureCrop`, so the note displays that zoomed region.
// `pageDataUrl` = the full-page render, `currentCrop` = [x0,y0,x1,y1] or null.
function openCropPicker(lessonId, slideIndex, pageDataUrl, currentCrop, onSave) {
  const img = new Image();
  img.onload = () => {
    const natW = img.naturalWidth, natH = img.naturalHeight;
    const maxW = Math.min(900, window.innerWidth * 0.85);
    const maxH = window.innerHeight * 0.7;
    const scale = Math.min(maxW / natW, maxH / natH);
    const dispW = Math.round(natW * scale), dispH = Math.round(natH * scale);
    // If the user already saved a region, show it; otherwise start with NO box
    // and let them draw one by dragging on the image.
    const hasSaved = currentCrop && currentCrop.length === 4;
    const def = hasSaved ? currentCrop : null;
    let sx = def ? def[0] * dispW : 0, sy = def ? def[1] * dispH : 0;
    let sw = def ? (def[2] - def[0]) * dispW : 0, sh = def ? (def[3] - def[1]) * dispH : 0;
    openModal(`
      <h2 style="margin-bottom:8px">✂ 选择配图区域</h2>
      <p class="sub" style="margin-bottom:8px">${hasSaved ? "拖动/缩放蓝色框调整区域，然后「保存」." : "在图片上按住左键<b>拖拽划出</b>要放大的区域，松开定型，可再拖动/缩放."}</p>
      <div id="crop-scroll" style="overflow:auto;max-height:70vh;border:1px solid var(--border);border-radius:8px">
        <div style="position:relative;width:${dispW}px;user-select:none" id="crop-stage">
          <img src="${pageDataUrl}" style="width:${dispW}px;display:block" draggable="false">
          <div id="crop-mask" class="crop-mask" style="left:${sx}px;top:${sy}px;width:${sw}px;height:${sh}px">
            <div class="crop-handle se"></div><div class="crop-handle nw"></div>
          </div>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-accent" id="crop-save">💾 保存为配图</button>
        <button class="btn btn-ghost" id="crop-reset">↺ 重置为整页</button>
        <button class="btn btn-ghost" id="crop-cancel">取消</button>
      </div>`);
    const stage = $("#crop-stage"), mask = $("#crop-mask"), scrollBox = $("#crop-scroll");
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    let resizing = false, moving = false, drawing = false;
    let startX = 0, startY = 0, ox = sx, oy = sy, ow = sw, oh = sh;
    const syncMask = () => { mask.style.left = sx + "px"; mask.style.top = sy + "px"; mask.style.width = sw + "px"; mask.style.height = sh + "px"; };
    const followBox = () => {
      if (!scrollBox) return;
      const sr = scrollBox.getBoundingClientRect();
      const mr = mask.getBoundingClientRect();
      if (mr.right > sr.right) scrollBox.scrollLeft += (mr.right - sr.right);
      else if (mr.left < sr.left) scrollBox.scrollLeft -= (sr.left - mr.left);
      if (mr.bottom > sr.bottom) scrollBox.scrollTop += (mr.bottom - sr.bottom);
      else if (mr.top < sr.top) scrollBox.scrollTop -= (sr.top - mr.top);
    };
    // Draw a fresh box by dragging on the image (click+hold, drag to the other corner).
    mask.addEventListener("pointerdown", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.target.classList.contains("crop-handle")) { resizing = true; startX = e.clientX; startY = e.clientY; ox = sx; oy = sy; ow = sw; oh = sh; }
      else { moving = true; startX = e.clientX; startY = e.clientY; ox = sx; oy = sy; }
      mask.setPointerCapture(e.pointerId);
    });
    stage.addEventListener("pointerdown", (e) => {
      if (e.target === mask || e.target.closest(".crop-handle")) return; // handled above
      if (e.target.tagName !== "IMG") return;
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      drawing = true;
      ox = px; oy = py; sx = px; sy = py; sw = 1; sh = 1;
      mask.setPointerCapture(e.pointerId);
      syncMask();
    });
    stage.addEventListener("pointermove", (e) => {
      if (drawing) {
        const rect = stage.getBoundingClientRect();
        const px = clamp(e.clientX - rect.left, 0, dispW);
        const py = clamp(e.clientY - rect.top, 0, dispH);
        // normalize so dragging any direction works
        sx = Math.min(px, ox || px); sy = Math.min(py, oy || py);
        sw = Math.abs(px - (ox ?? px)) || 1; sh = Math.abs(py - (oy ?? py)) || 1;
        if (sx + sw > dispW) sx = dispW - sw;
        if (sy + sh > dispH) sy = dispH - sh;
        syncMask(); followBox(); return;
      }
      if (!resizing && !moving) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (resizing) {
        sw = clamp(ow + dx, 60, dispW - sx);
        sh = clamp(oh + dy, 60, dispH - sy);
      } else if (moving) {
        sx = clamp(ox + dx, 0, dispW - sw);
        sy = clamp(oy + dy, 0, dispH - sh);
      }
      syncMask();
      followBox();
    });
    stage.addEventListener("pointerup", () => { resizing = false; moving = false; drawing = false; });
    $("#crop-reset").addEventListener("click", () => { sx = 0; sy = 0; sw = dispW; sh = dispH; syncMask(); });
    $("#crop-cancel").addEventListener("click", closeModal);
    $("#crop-save").addEventListener("click", () => {
      const bbox = [clamp(sx / dispW, 0, 1), clamp(sy / dispH, 0, 1), clamp((sx + sw) / dispW, 0, 1), clamp((sy + sh) / dispH, 0, 1)];
      closeModal();
      onSave(bbox);
    });
  };
  img.src = pageDataUrl;
}

// Apply a saved figureCrop to a rendered note figure (async replace img src).
async function applyFigureCrop(imgEl, pageDataUrl, bbox) {
  try {
    const cropped = await cropImage(pageDataUrl, bbox);
    if (cropped) { imgEl.src = cropped; imgEl.dataset.appliedCrop = "1"; }
  } catch { /* keep full page */ }
}

const ocrPrompt = `Transcribe all the readable text on this page image, preserving headings and reading order. Return JSON: {"text":"..."}`;

const figureCaptionPrompt = (slideText, n) => `This lecture slide contains ${n} figure(s) (diagrams/images). The slide text is:

"""
${slideText || "(no text)"}
"""

Based on the slide text, infer what each figure most likely shows (one entry per figure, in order). For each:
- "caption": one sentence describing what the figure likely depicts
- "takeaway": the key medical point to remember from it

Return JSON: {"figures":[{"caption":"...","takeaway":"..."}]} — exactly ${n} entries.`;

// Batched version: answer captions for several slides in ONE call (many fewer
// round-trips than one call per slide, which dominated generation time).
const figureCaptionBatchPrompt = (slides) => `Below are ${slides.length} lecture slide(s), each containing 1–4 figures (diagrams/images). For every slide, infer from its text what each figure most likely shows. One entry per figure, in order.

${slides.map((s) => `--- Slide ${s.index} (${s.n} figure(s)) ---\n${s.text || "(no text)"}`).join("\n\n")}

Important: some figure labels may be cut off at the edge of the embedded figure image (e.g. "Uln…", "Deep anc…", "Axillary a."). Use the slide text to reconstruct the COMPLETE label and use the full term in the caption/takeaway — e.g. "Ulnar artery", "Deep palmar arch", "Axillary artery". Do not reproduce truncated fragment.

Return JSON with the EXACT schema:
{"slides":[{"index": <slide index number>, "figures":[{"caption":"...","takeaway":"..."}]}]}
— exactly one object per slide, in the same order and slide numbers as above, with exactly ${slides.map((s) => s.n).join(", ")} figure(s) per matching slide.`;

// Attach inferred captions to figures on the given slides, batching several
// slides per LLM call (5 per call) and running batches in parallel.
// opts.lo / opts.hi place this step's progress inside its own band of the bar (it
// used to own the tail 0.72→1.0 when it ran last).
// opts.onlyMissing skips slides whose figures are already captioned, so re-running
// a generation does not pay for the same captions again — captions describe the
// figures in the PDF, which do not change when the notes are rewritten.
async function attachFigureCaptions(slides, pm, opts = {}) {
  const lo = opts.lo != null ? opts.lo : 0.72;
  const hi = opts.hi != null ? opts.hi : 1.0;
  const onlyMissing = opts.onlyMissing !== false;
  let done = 0;
  const total = slides.length;
  const batches = [];
  for (let i = 0; i < slides.length; i += 5) batches.push(slides.slice(i, i + 5));
  await parallelMap(batches, 8, async (batch) => {
    if (pm && pm.isCancelled()) return;
    // Strip old vision crops first so they don't accumulate on regenerate.
    batch.forEach((slide) => {
      slide.images = (slide.images || []).filter((im) => !/^slide/.test(im.name || ""));
    });
    const items = batch.map((slide) => {
      const figs = (slide.images || []).filter((im) => im.kind !== "page" && im.kind !== "logo").slice(0, 4);
      return { index: slide.index, text: slide.text || "", n: figs.length, figs };
    });
    const reqItems = items.filter((it) => it.n > 0)
      .filter((it) => !onlyMissing || it.figs.some((im) => !im.caption || !(im.caption.caption || im.caption.takeaway)));
    if (!reqItems.length) { done += batch.length; return; }
    const r = await api.llm(
      [{ role: "system", content: SYS }, { role: "user", content: figureCaptionBatchPrompt(reqItems) }],
      { json_mode: true, max_tokens: 2500 }
    );
    if (r && r.usage) pm.addTokens(r.usage.total_tokens);
    if (!r.error) {
      const parsed = parseJSON(r.content);
      const capsByIndex = {};
      (parsed && Array.isArray(parsed.slides) ? parsed.slides : []).forEach((s) => {
        if (s && s.index != null && Array.isArray(s.figures)) capsByIndex[s.index] = s.figures;
      });
      items.forEach((it) => {
        const caps = capsByIndex[it.index] || [];
        it.figs.forEach((im, i) => {
          if (caps[i]) im.caption = { type: "figure", caption: caps[i].caption || "", takeaway: caps[i].takeaway || "" };
        });
      });
    }
    done += batch.length;
    if (pm) {
      pm.msg(`Attaching figures ${done}/${total}…`);
      pm.setProgress(lo + (done / total) * (hi - lo));
    }
  });
  return done;
}

/* ---------------- chunking ----------------
 * A slide's figure captions can be appended to its text, because a page whose whole
 * content is a diagram otherwise reads as a bare title:
 *
 *     Slide 24:
 *     Centrifugation: Theory
 *
 * Nothing extractable comes out of that, so no point ever references the page and it
 * disappears from every point-driven view — while its topic gets written off some
 * other page that merely mentions the words, often an agenda slide, which also drops
 * the point in the wrong place in lecture order.
 *
 * Two rules decide when captions are worth their tokens, because feeding every
 * caption to every page is expensive: on the real Lecture 1.2, captions run ~176
 * characters a page and 55 of 87 pages hold under 200 characters of text, so a plain
 * text-length threshold would have inflated the extraction input by half.
 *
 *   - captionsFor: an explicit set of slide numbers. The coverage pass uses this to
 *     re-send ONLY the pages that produced no point in the first pass, which targets
 *     the real failure exactly and costs a fraction of a percent of the lesson.
 *   - otherwise, only pages whose entire text is a title (under TITLE_ONLY_CHARS)
 *     carry their captions in the first pass — cheap insurance that never touches a
 *     page that has prose of its own.
 */
const TITLE_ONLY_CHARS = 60;

function figureCaptionLines(s) {
  const lines = [];
  (s.images || []).forEach((im) => {
    if (im.kind === "page" || im.kind === "logo") return;
    const c = im.caption;
    const cap = typeof c === "string" ? c : (c && c.caption) || "";
    const take = c && typeof c === "object" ? (c.takeaway || "") : "";
    const txt = [cap, take].filter(Boolean).join(" — ");
    if (txt) lines.push("- " + txt.slice(0, 300));
  });
  return lines.join("\n");
}

function buildSlideBlocks(slides, opts = {}) {
  const captionsFor = opts.captionsFor || null;
  return slides.map((s) => {
    let b = `Slide ${s.index}:\n${s.text || "(no text)"}`;
    if (s.notes) b += `\nSpeaker notes: ${s.notes}`;
    const wantCaption = captionsFor
      ? captionsFor.has(Number(s.index))
      : (s.text || "").trim().length < TITLE_ONLY_CHARS;
    if (wantCaption) {
      const caps = figureCaptionLines(s);
      if (caps) b += `\nThis slide is mostly a figure; what the figure shows:\n${caps}`;
    }
    return b;
  });
}
function chunkText(items, max = 5500) {
  const chunks = [];
  let cur = "";
  for (const it of items) {
    if (cur && cur.length + it.length > max) { chunks.push(cur); cur = ""; }
    cur += (cur ? "\n\n" : "") + it;
  }
  if (cur) chunks.push(cur);
  return chunks;
}
function explanationText(exp) {
  // The LLM sometimes returns explanation as an ARRAY of strings instead of a
  // bullet string. Normalize both forms into a newline-separated bullet list.
  if (Array.isArray(exp)) {
    return exp.map((it) => {
      const s = String(it == null ? "" : it).trim();
      return "- " + s.replace(/^[-*•]\s+/, "");
    }).join("\n");
  }
  return exp || "";
}

function pointsToText(points) {
  return points.map((p, i) => `${i + 1}. ${p.title}\n   ${explanationText(p.explanation)}`).join("\n");
}

async function parallelMap(items, concurrency, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      try { out[i] = await fn(items[i], i); } catch (e) { out[i] = { error: String((e && e.message) || e) }; }
    }
  });
  await Promise.all(workers);
  return out;
}

function withStats(lessons, cards) {
  const now = Date.now();
  const map = {};
  cards.forEach((c) => {
    map[c.lessonId] = map[c.lessonId] || { cardCount: 0, dueCards: 0 };
    map[c.lessonId].cardCount++;
    if (isDue(c, now)) map[c.lessonId].dueCards++;
  });
  return lessons.map((l) => ({ ...l, cardCount: map[l.id]?.cardCount || 0, dueCards: map[l.id]?.dueCards || 0 }));
}

function feynmanPct(stage) {
  return [0, 33, 67, 100][stage] ?? 0;
}

function isMastered(p) {
  return p.feynmanStage != null && p.feynmanStage >= 2;
}

function pointMastery(points) {
  if (!points?.length) return { pointPct: 0, reviewed: 0, total: 0 };
  const total = points.length;
  const reviewed = points.filter((p) => p.feynmanStage != null).length;
  const sum = points.reduce((a, p) => a + feynmanPct(p.feynmanStage), 0);
  return { pointPct: Math.round(sum / total), reviewed, total };
}

function computeMasteryMap(lessons, cards, quizzes) {
  const quizByLesson = {};
  quizzes.forEach((q) => {
    const prev = quizByLesson[q.lessonId];
    if (!prev || (q.score ?? -1) > (prev.score ?? -1)) quizByLesson[q.lessonId] = q;
  });
  const cardsByLesson = {};
  cards.forEach((c) => { (cardsByLesson[c.lessonId] = cardsByLesson[c.lessonId] || []).push(c); });
  const map = {};
  lessons.forEach((l) => {
    const lc = cardsByLesson[l.id] || [];
    const seen = lc.filter((c) => c.reps >= 1).length;
    const mature = lc.filter((c) => c.interval >= 21).length;
    const q = quizByLesson[l.id];
    const pm = pointMastery(l.points);
    const cardPct = lc.length ? (mature / lc.length) * 100 : null;
    // The list endpoint sends a slim quiz (score + questionCount) because the whole
    // question bank is megabytes per lesson and this only needs the count. A quiz
    // fetched per lesson still carries its real `questions` array.
    const qTotal = q ? (q.questionCount ?? q.questions?.length ?? 0) : 0;
    const quizPct = qTotal ? ((q.score ?? 0) / qTotal) * 100 : null;
    let wSum = 0, pSum = 0;
    if ((l.points || []).length) { wSum += 30; pSum += 30 * pm.pointPct; }
    if (lc.length) { wSum += 40; pSum += 40 * cardPct; }
    if (quizPct != null) { wSum += 30; pSum += 30 * quizPct; }
    map[l.id] = {
      totalCards: lc.length, seen, mature, quiz: q,
      pointPct: pm.pointPct, reviewedPoints: pm.reviewed, totalPoints: pm.total,
      pct: wSum ? Math.round(pSum / wSum) : 0,
    };
  });
  return map;
}

/* ---------------- init / navigation ---------------- */
async function init() {
  document.querySelectorAll(".nav-item").forEach((b) => {
    b.addEventListener("click", () => navigate(b.dataset.view));
  });
  const lo = $("#btn-logout");
  if (lo) lo.addEventListener("click", () => { api.setToken(""); showLogin(); });
  const authed = await api.checkAuth();
  if (authed) await enterApp();
  else showLogin();
  initPet();
  initHiddenMenu();
}

/* ---------------- Hidden tools menu ----------------
 * Maintenance and one-off tools live out of the way: five quick taps on the
 * sidebar brand (works with a mouse or a finger) open them. Nothing here is part
 * of daily study, so it stays invisible until asked for.
 */
function initHiddenMenu() {
  const brand = document.querySelector("#sidebar .brand");
  if (!brand || brand.dataset.hmBound) return;
  brand.dataset.hmBound = "1";
  brand.style.cursor = "default";
  let taps = 0;
  let timer = null;
  brand.addEventListener("click", () => {
    taps += 1;
    clearTimeout(timer);
    timer = setTimeout(() => { taps = 0; }, 2500);
    if (taps >= 5) {
      taps = 0;
      clearTimeout(timer);
      openHiddenMenu();
    }
  });
}

function openHiddenMenu() {
  const prof = studyProfile();
  openModal(`
    <h2>🛠 工具 & 维护</h2>
    <p class="sub" style="margin-bottom:14px">隐藏菜单 · 连点侧边栏左上角标题 5 次打开</p>
    <div style="display:flex;flex-direction:column;gap:8px">
      <button class="q-option" data-tool="health"><span class="letter">🩺</span><span><b>数据体检</b><br><span class="sub">检查重复课程 / 空课程 / 孤儿数据 / 存储占用</span></span></button>
      <button class="q-option" data-tool="reclassify"><span class="letter">🏷</span><span><b>重排全部分类</b><br><span class="sub">用新规则重新整理所有课的知识点层级（不重新生成内容）</span></span></button>
      <button class="q-option" data-tool="tokens"><span class="letter">🔢</span><span><b>Token 用量统计</b><br><span class="sub">按课程查看 AI 调用消耗</span></span></button>
      <button class="q-option" data-tool="preset"><span class="letter">📚</span><span><b>学科预设</b><br><span class="sub">当前：${escapeHtml(prof.site_title || "")} · ${escapeHtml(prof.language || "")}</span></span></button>
      <button class="q-option" data-tool="export"><span class="letter">⬇</span><span><b>导出全部数据（JSON 备份）</b><br><span class="sub">课程 + 知识点 + 闪卡 + 题目，可留档或迁移</span></span></button>
      <button class="q-option" id="pet-show" data-tool="pet"><span class="letter">🐾</span><span><b>重新显示桌宠</b><br><span class="sub">刚才收起的小宠物会回到右下角（专注计时一直在）</span></span></button>
      <button class="q-option" data-tool="diagnostics"><span class="letter">📋</span><span><b>诊断信息</b><br><span class="sub">版本 / 服务地址 / 数量统计，反馈问题时可复制</span></span></button>
    </div>
    <div id="hm-out" style="margin-top:14px"></div>
    <div style="display:flex;justify-content:flex-end;margin-top:14px">
      <button class="btn btn-ghost" id="hm-close">关闭</button>
    </div>`);
  $("#hm-close").addEventListener("click", closeModal);
  document.querySelectorAll("#modal-root [data-tool]").forEach((b) => {
    b.addEventListener("click", () => runHiddenTool(b.dataset.tool, $("#hm-out")));
  });
}

async function runHiddenTool(tool, out) {
  const say = (html) => { out.innerHTML = `<div class="card" style="padding:12px 14px;font-size:13px;line-height:1.7">${html}</div>`; };
  if (tool === "tokens") { closeModal(); navigate("token"); return; }
  if (tool === "reclassify") { closeModal(); reclassifyAllLessons(); return; }
  if (tool === "preset") { closeModal(); navigate("settings"); return; }
  if (tool === "pet") {
    closeModal();
    // Drive the same state the pet itself uses, rather than poking the DOM: two
    // different writers is how the pet ended up "shown" and display:none at once.
    showPetAgain();
    toast("🐾 桌宠回来了 —— 拖到别处，或点它右上角的 × 再收起", "success");
    return;
  }
  out.innerHTML = `<div class="loading"><div class="spinner"></div>处理中…</div>`;
  if (tool === "health") return say(await hiddenHealthReport());
  if (tool === "diagnostics") return say(hiddenDiagnostics());
  if (tool === "export") return hiddenExportAll(out);
}

// A quick integrity pass over everything the client can see without extra APIs.
async function hiddenHealthReport() {
  const [lessons, cards, quizzes, images] = await Promise.all([
    db.getAllLite("lessons").catch(() => []),
    db.getAllLite("cards").catch(() => []),
    db.getAll("quizzes").catch(() => []),
    db.getAll("lessonImages").catch(() => []),
  ]);
  const key = (r) => `${(r.title || "").trim()}|${(r.slides || []).length}|${r.filename || ""}`;
  const seen = new Map();
  (lessons || []).forEach((l) => seen.set(key(l), (seen.get(key(l)) || 0) + 1));
  const dupGroups = [...seen.values()].filter((n) => n > 1);
  const dupExtra = dupGroups.reduce((a, n) => a + n - 1, 0);
  const noPoints = (lessons || []).filter((l) => !(l.points || []).length).length;
  const lessonIds = new Set((lessons || []).map((l) => l.id));
  const orphanImg = (images || []).filter((r) => !lessonIds.has(r.id)).length;
  const orphanCards = (cards || []).filter((c) => !lessonIds.has(c.lessonId)).length;
  const orphanQuiz = (quizzes || []).filter((q) => !lessonIds.has(q.lessonId)).length;
  const row = (ok, label, detail) => `<div>${ok ? "✅" : "⚠️"} <b>${label}</b> — ${detail}</div>`;
  return [
    row(true, "课程", `${(lessons || []).length} 门 · 知识点 ${(lessons || []).reduce((a, l) => a + (l.points || []).length, 0)} 个`),
    row(true, "闪卡 / 题目", `${(cards || []).length} 张 · ${(quizzes || []).length} 份`),
    row(dupExtra === 0, "重复课程", dupExtra === 0 ? "没有重复" : `${dupGroups.length} 组重复，共多出 ${dupExtra} 条 ← 建议清理（本地可跑 dedupe_lessons.py）`),
    row(orphanImg + orphanCards + orphanQuiz === 0, "孤儿数据", orphanImg + orphanCards + orphanQuiz === 0 ? "没有孤儿数据" : `图片 ${orphanImg} · 闪卡 ${orphanCards} · 题目 ${orphanQuiz}`),
    row(noPoints === 0, "未生成知识点的课程", noPoints === 0 ? "全部已生成" : `${noPoints} 门（Lessons 页可一键补生成）`),
  ].join("");
}

function hiddenDiagnostics() {
  const prof = studyProfile();
  return [
    `<div><b>站点</b>：${escapeHtml(prof.site_title || "")}（${escapeHtml(prof.language || "")}）</div>`,
    `<div><b>服务地址</b>：${escapeHtml(location.origin)}</div>`,
    `<div><b>模型</b>：${escapeHtml((appConfig && appConfig.text && appConfig.text.model) || "?")}</div>`,
    `<div><b>学科数</b>：${(prof.subjects || []).length}</div>`,
    `<div><b>上传上限</b>：${_maxUploadMb} MB</div>`,
    `<div><b>构建</b>：${escapeHtml(document.querySelector('script[src*="app.js"]')?.getAttribute("src") || "")}</div>`,
  ].join("");
}

async function hiddenExportAll(out) {
  try {
    const lessons = await db.getAllFull("lessons");
    // getAllFull, not getAll: the list endpoint now sends slim quizzes (score plus a
    // question count). A backup that silently dropped every question bank would be
    // worse than no backup at all.
    const [cards, quizzes, favs] = await Promise.all([db.getAll("cards"), db.getAllFull("quizzes"), db.getAll(FAV_STORE).catch(() => [])]);
    const blob = new Blob([JSON.stringify({ exportedAt: Date.now(), lessons, cards, quizzes, quizFavs: favs }, null, 0)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `revision-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    out.innerHTML = `<div class="card" style="padding:12px 14px;font-size:13px">✅ 已导出 ${lessons.length} 门课 · ${cards.length} 张卡 · ${quizzes.length} 份题目 · ${favs.length} 道收藏（文件已开始下载）</div>`;
  } catch (e) {
    out.innerHTML = `<div class="card" style="padding:12px 14px;font-size:13px;color:var(--red)">导出失败：${escapeHtml(String(e.message || e))}</div>`;
  }
}

async function enterApp() {
  await loadAppConfig();
  renderAiStatus();
  if (!window.__mbbsTT) { window.__mbbsTT = true; startTimeTracking(); }
  startAutoSave();
  await navigate("dashboard");
}

// ---- Auto-save: periodically persist the in-progress page's session state ----
let _autoSaveTimer = null;
function getAutoSaveInterval() {
  const n = parseInt(localStorage.getItem("mbbs_auto_save_sec") || "30", 10);
  return Number.isFinite(n) && n >= 5 ? n : 30;
}
function autoSaveCurrentProgress() {
  try {
    // Quiz in progress: persist answers + running score.
    if (quizSession && quizSession.quiz) {
      const qz = quizSession.quiz;
      qz.userAnswers = quizSession.answers.slice();
      qz.score = quizSession.answers.filter((a, j) => a === qz.questions[j].answer).length;
      qz.completed = false;
      db.put("quizzes", qz).catch(() => {});
    }
    // Feynman in progress: persist the session's graded points.
    if (feynmanSession && feynmanSession.lesson) {
      db.put("lessons", feynmanSession.lesson).catch(() => {});
    }
    // Review: cards are already saved per-grade (SM-2), nothing extra to flush.
  } catch { /* best-effort */ }
}
function startAutoSave() {
  if (_autoSaveTimer) clearInterval(_autoSaveTimer);
  _autoSaveTimer = setInterval(autoSaveCurrentProgress, getAutoSaveInterval() * 1000);
}
function restartAutoSave() {
  if (_autoSaveTimer) { clearInterval(_autoSaveTimer); startAutoSave(); }
}

function showLogin() {
  const sidebar = $("#sidebar");
  if (sidebar) sidebar.style.display = "none";
  $("#view").innerHTML = `
    <div style="max-width:380px;margin:90px auto">
      <div class="card" style="padding:30px">
        <div style="font-size:38px;text-align:center">🩺</div>
        <h1 style="text-align:center;font-size:20px;margin:6px 0 2px">MBBS Revision</h1>
        <p class="sub" style="text-align:center;margin-bottom:20px">Sign in to your account</p>
        <input type="password" id="login-pw" placeholder="Password" autocomplete="current-password" style="width:100%;padding:11px 13px;border:1.5px solid var(--border);border-radius:9px;font-size:15px;margin-bottom:12px">
        <button class="btn btn-primary btn-lg" id="login-btn" style="width:100%">Log in</button>
        <div id="login-err" class="sub" style="color:var(--red);text-align:center;margin-top:12px"></div>
      </div>
    </div>`;
  const pw = $("#login-pw");
  pw.focus();
  const doLogin = async () => {
    const r = await api.login(pw.value);
    if (r.error) { $("#login-err").textContent = r.error; return; }
    api.setToken(r.token);
    const sb = $("#sidebar");
    if (sb) sb.style.display = "";
    await enterApp();
  };
  $("#login-btn").addEventListener("click", doLogin);
  pw.addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
}

function renderAiStatus() {
  const t = appConfig?.has_text_key ? "Text ✓" : "Text ✗";
  const v = appConfig?.has_vision_key ? "Vision ✓" : "Vision ✗";
  const el = $("#ai-status");
  if (el) el.textContent = `AI: ${t} · ${v}`;
}

function navigate(view) {
  // Leaving a lesson for another page: remember the spot before the view is torn
  // down (after this, currentLessonId is null and the scroll position is gone).
  saveReadingPosition();
  if (quizPreview) { quizPreview = null; document.removeEventListener("keydown", quizPreviewKeydown); }
  if (quizReview) { quizReview = null; document.removeEventListener("keydown", quizReviewKeydown); }
  currentView = view;
  immersiveOn = false;
  document.body.classList.remove("immersive");
  currentLessonId = null;
  if (reviewKeyHandler) { document.removeEventListener("keydown", reviewKeyHandler); reviewKeyHandler = null; }
  if (feynmanKeyHandler) { document.removeEventListener("keydown", feynmanKeyHandler); feynmanKeyHandler = null; }
  if (mistakeKeyHandler) { document.removeEventListener("keydown", mistakeKeyHandler); mistakeKeyHandler = null; }
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  if (view === "review") setActivity("review"); else setActivity(null);
  refreshBadges();
  switch (view) {
    case "dashboard": renderDashboard(); break;
    case "lessons": renderLessons(); break;
    case "nav": renderKnowledgeNav(); break;
    case "review": renderReview(); break;
    case "mistakes": renderMistakes(); break;
    case "favs": renderFavs(); break;
    case "progress": renderProgress(); break;
    case "formulas": renderFormulas(); break;
    case "token": renderTokenStats(); break;
    case "search": renderSearch(); break;
    case "settings": renderSettings(); break;
    default: renderDashboard();
  }
}

async function refreshBadges() {
  const [cards, lessons, mistakes] = await Promise.all([
    db.getAllLite("cards"), db.getAllLite("lessons"), db.getAll("mistakes"),
  ]);
  const plan = planStudyQueue(cards, lessons, mistakes);
  const dueTotal = plan.entries.length;
  const dueMistakes = plan.dueMistakeCount;
  const rb = $("#review-badge"), mb = $("#mistake-badge");
  rb.textContent = dueTotal; rb.hidden = dueTotal === 0;
  mb.textContent = dueMistakes; mb.hidden = dueMistakes === 0;
  // Starred questions are a standing collection, not a due count: show the total.
  const favs = await loadFavs().catch(() => null);
  const fb = $("#fav-badge");
  if (fb && favs) { fb.textContent = favItems.length; fb.hidden = favItems.length === 0; }
}

/* ---------------- Dashboard ---------------- */
async function renderDashboard() {
  const [lessons, cards, mistakes, log, quizzes] = await Promise.all([
    db.getAllLite("lessons"), db.getAllLite("cards"), db.getAll("mistakes"), db.getAll("studyLog"), db.getAll("quizzes"),
  ]);
  const now = Date.now();
  const plan = planStudyQueue(cards, lessons, mistakes, now);
  const dueCards = plan.dueCardCount + plan.newCardCount;
  const dueMistakes = plan.dueMistakeCount;
  const duePoints = plan.duePointCount;
  const totalPoints = lessons.reduce((a, l) => a + (l.points?.length || 0), 0);
  const mastery = computeMasteryMap(lessons, cards, quizzes);
  const lessonsWith = withStats(lessons, cards).map((l) => ({ ...l, pct: mastery[l.id]?.pct ?? 0 }));
  const t = computeTimeStats(log);
  const goalMin = getGoalMinutes();
  const goalPct = Math.min(100, Math.round((t.todaySec / (goalMin * 60)) * 100));
  const goalReached = t.todaySec >= goalMin * 60;
  const studyBreakdown = [
    plan.dueCardCount ? `${plan.dueCardCount} 复习卡` : "",
    plan.newCardCount ? `${plan.newCardCount} 新卡(上限 ${getNewCardsPerDay()})` : "",
    plan.remainingNewCount > 0 ? `${plan.remainingNewCount} 新卡明天继续` : "",
    plan.newPointCount ? `${plan.newPointCount} 新知识点(上限 ${getNewPointsPerDay()})` : "",
    plan.remainingNewPointCount > 0 ? `${plan.remainingNewPointCount} 新知识点明天继续` : "",
    (duePoints - plan.newPointCount) > 0 ? `${duePoints - plan.newPointCount} 到期知识点` : "",
    dueMistakes ? `${dueMistakes} 错题` : "",
  ].filter(Boolean).join(" · ") || "今天已全部完成";

  $("#view").innerHTML = `
    <div class="page-head">
      <div class="title-wrap"><h1>Dashboard</h1><p class="sub">Your active-recall command center.</p></div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost" id="btn-progress">📈 Progress</button>
        <button class="btn btn-primary btn-lg" id="btn-upload">＋ Upload lesson</button>
      </div>
    </div>
    <div class="card" style="margin-bottom:20px;display:flex;gap:18px;align-items:center;overflow:hidden;padding:0">
      <div style="flex:1;min-width:200px;padding:18px 0 18px 20px">
        <div style="font-size:17px;font-weight:700">你好！我是你的 AI 学习搭子 🤖✨</div>
        <div class="sub" style="margin-top:6px">上传课件 → 提炼知识点 → 主动回忆复习。今天也一起加油！</div>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-accent" id="btn-welcome-study" ${plan.entries.length ? "" : "disabled"}>🎯 开始今日学习 (${plan.entries.length})</button>
          <button class="btn btn-ghost" id="btn-welcome-upload">＋ 上传课件</button>
        </div>
      </div>
      <img src="img/dashboard-bot2.png" alt="AI study assistant" style="width:130px;height:auto;object-fit:contain;flex-shrink:0;margin-right:14px;max-height:180px">
    </div>
    ${continueReadingCard(lessons)}
    <div class="card" style="margin-bottom:20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <div style="font-weight:700;white-space:nowrap">🎯 Daily goal</div>
      <div class="progress-bar" style="flex:1;min-width:160px;height:12px"><div class="progress-fill" style="width:${goalPct}%"></div></div>
      <div class="sub" style="white-space:nowrap">${fmtDuration(t.todaySec)} / ${goalMin}m ${goalReached ? "🎉 done!" : ""}</div>
    </div>
    <div class="grid grid-3" style="margin-bottom:24px">
      <div class="card stat"><div class="stat-num">${lessons.length}</div><div class="stat-label">Lessons saved</div></div>
      <div class="card stat"><div class="stat-num">${totalPoints}</div><div class="stat-label">Key points distilled</div></div>
      <div class="card stat stat-click" data-go="review"><div class="stat-num" style="color:${dueCards ? "var(--amber)" : "inherit"}">${dueCards}</div><div class="stat-label">Cards due today</div></div>
      <div class="card stat stat-click" data-go="review"><div class="stat-num" style="color:${duePoints ? "var(--amber)" : "inherit"}">${duePoints}</div><div class="stat-label">Points due today</div></div>
      <div class="card stat stat-click" data-go="mistakes"><div class="stat-num" style="color:${dueMistakes ? "var(--red)" : "inherit"}">${dueMistakes}</div><div class="stat-label">Mistakes to review</div></div>
      <div class="card stat stat-click" data-go="progress"><div class="stat-num">${fmtDuration(t.todaySec)}</div><div class="stat-label">Studied today</div></div>
      <div class="card stat stat-click" data-go="progress"><div class="stat-num">🔥 ${t.streak}</div><div class="stat-label">Day streak</div></div>
    </div>
    <div class="card" style="margin-bottom:26px;padding:18px 20px">
      <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
        <button class="btn btn-accent btn-lg" id="btn-study" ${plan.entries.length ? "" : "disabled"}>🎯 Start today's study (${plan.entries.length})</button>
        <button class="btn btn-danger" id="btn-mistakes" ${dueMistakes ? "" : "disabled"}>📕 只复习错题 (${dueMistakes})</button>
        <div class="sub" style="flex:1;min-width:200px">队列：${escapeHtml(studyBreakdown)}。复习卡与错题优先，新卡自动穿插并受每日上限控制。</div>
      </div>
    </div>
    <h2>Recent lessons</h2>
    ${lessonsWith.length ? lessonsWith.sort((a, b) => b.createdAt - a.createdAt).slice(0, 6).map(lessonRow).join("") : emptyState("📚", "No lessons yet — upload your first PPT or PDF.")}
  `;
  $("#btn-upload").addEventListener("click", openUpload);
  $("#btn-progress").addEventListener("click", () => navigate("progress"));
  $("#btn-study").addEventListener("click", () => navigate("review"));
  $("#btn-mistakes").addEventListener("click", () => navigate("mistakes"));
  const wStudy = $("#btn-welcome-study");
  if (wStudy) wStudy.addEventListener("click", () => navigate("review"));
  const wUpload = $("#btn-welcome-upload");
  if (wUpload) wUpload.addEventListener("click", openUpload);
  const cont = $("#btn-continue-read");
  if (cont) cont.addEventListener("click", () => {
    const best = latestReadPos(lessons);
    if (best) openLesson(best.lesson.id, best.pos.tab || "points");
  });
  const contForget = $("#btn-continue-forget");
  if (contForget) contForget.addEventListener("click", () => {
    const best = latestReadPos(lessons);
    if (!best) return;
    readPosForget(best.lesson.id);
    toast("已清除这门课的阅读位置", "");
    renderDashboard();
  });
  $("#view").querySelectorAll("[data-go]").forEach((el) => el.addEventListener("click", () => navigate(el.dataset.go)));
  $("#view").querySelectorAll(".lesson-item").forEach((el) =>
    el.addEventListener("click", () => openLesson(el.dataset.id)));
}

/* Dashboard: "pick up where you left off".
 *
 * The reading position is restored automatically when a lesson is opened, but you
 * have to remember WHICH lesson that was. This card answers that, and carries the
 * same position chip so the note can be dropped when a lesson is finished.
 */
function continueReadingCard(lessons) {
  const best = latestReadPos(lessons);
  if (!best) return "";
  const { lesson, pos } = best;
  const where = pos.label ? escapeHtml(pos.label) : (pos.tab === "quiz" ? "测验进度" : "阅读进度");
  const when = fmtDate(pos.at);
  return `
    <div class="card" id="continue-card" style="margin-bottom:20px;display:flex;gap:14px;align-items:center;flex-wrap:wrap">
      <div style="flex:1;min-width:220px">
        <div style="font-weight:700">📍 继续上次阅读</div>
        <div class="sub" style="margin-top:5px">${escapeHtml(lesson.title)}</div>
        <div class="sub" style="margin-top:4px;font-size:12px;opacity:.85">上次读到：${where} · ${when}</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-accent" id="btn-continue-read">▶ 继续阅读</button>
        <button class="btn btn-ghost btn-sm" id="btn-continue-forget" title="不再记住这门课的位置">✕ 清除</button>
      </div>
    </div>`;
}

// Extract a course-code group from a lesson title, e.g. "CPR63 Shock; Heart
// Failure 2025" -> "CPR63", "GIS06 Anatomy..." -> "GIS06". Titles without a
// leading code return null.
function courseGroup(title) {
  const m = String(title || "").match(/^([A-Za-z]{2,6})\s*(\d{2,3})/);
  if (m) return (m[1] + m[2]).toUpperCase();
  return null;
}

// Natural sort key for a course-code label: split into [letterPart, numberValue],
// so "CPR27" < "CPR63" and "CPR117" > "CPR63" (numeric, not lexicographic).
function codeSortKey(label) {
  const s = String(label || "");
  const match = /^([A-Za-z]+)\s*(\d+)$/.exec(s.trim());
  if (match) return [match[1].toUpperCase(), Number(match[2])];
  return [s.toUpperCase(), 0];
}
// Comparator for group labels: letters first, then numeric value.
function compareCodeLabels(a, b) {
  if (a === "📁 其他") return 1;
  if (b === "📁 其他") return -1;
  if (a === b) return 0;
  const ka = codeSortKey(a), kb = codeSortKey(b);
  if (ka[0] !== kb[0]) return ka[0] < kb[0] ? -1 : 1;
  return ka[1] - kb[1];
}

// Resolve a lesson's category using the USER-defined classification:
//   1. manual override (lessonId -> category id)
//   2. first category whose pattern matches the title / auto code
//   3. auto-extracted code (CPR63...) as a fallback group
//   4. "📁 其他"
// Returns { key, label, catId } — key is the grouping key, label is display text.
function classifyLesson(lesson, cls) {
  const catById = {};
  (cls?.categories || []).forEach((c) => { if (c.id) catById[c.id] = c; });
  // 1. manual override
  const manualId = (cls?.manual || {})[lesson.id];
  if (manualId === "__none__") return { key: "other", label: "📁 其他", catId: null };
  if (manualId && catById[manualId]) return { key: "cat:" + manualId, label: catById[manualId].name, catId: manualId };
  const title = String(lesson.title || "");
  const autoCode = courseGroup(title);
  // 2. pattern match — a category pattern is a regex (case-insensitive) run
  //    against the lesson title; the auto code is also eligible.
  for (const c of cls?.categories || []) {
    const pat = String(c.pattern || "").trim();
    if (!pat) continue;
    try {
      if (new RegExp(pat, "i").test(title) || (autoCode && new RegExp(pat, "i").test(autoCode))) {
        return { key: "cat:" + c.id, label: c.name, catId: c.id };
      }
    } catch { /* invalid regex → skip */ }
  }
  // 3. Auto-code fallback — group by the LETTER PREFIX, not the full code:
  //    "HNS01".."HNS52" belong together as one "HNS" group, whereas keying on the
  //    full code produced 52 separate one-lesson groups. Courses whose title
  //    carries no code still fall through to 📁 其他.
  if (autoCode) {
    const prefix = autoCode.replace(/\d+$/, "");
    return { key: "code:" + prefix, label: prefix || autoCode, catId: null };
  }
  // 4. other
  return { key: "other", label: "📁 其他", catId: null };
}

let lessonsFolderFilter = ""; // "" all, "__none__" unfiled, else folder id
// Course-code groups the student chose to hide on the Lessons page (e.g. keep
// only HNS visible while revising neuro). Persisted per browser.
let hiddenGroups = new Set();
try { hiddenGroups = new Set(JSON.parse(localStorage.getItem("mbbs_hidden_groups") || "[]")); } catch { hiddenGroups = new Set(); }
function saveHiddenGroups() {
  try { localStorage.setItem("mbbs_hidden_groups", JSON.stringify([...hiddenGroups])); } catch { /* ignore */ }
}
let lessonsSelectMode = false;
let lessonsSelection = new Set();
let lessonsAnchorId = null; // range-select anchor
let currentFolders = [];
function folderName(folders, id) { return (folders || []).find((f) => f.id === id)?.name || id; }

// Which group header a lesson appears under on the Lessons page.
// classifyLesson groups by classification category — rules the user writes on the
// 分类 page (course-code patterns). A fresh instance has no rules at all, so every
// lesson fell into a bare "📁 其他" header even though the user had filed them into
// folders, which reads like a folder they never created. With no rules configured,
// group by folder instead: the header then matches the folder chips above.
function groupForLesson(lesson, cls, folders) {
  const g = classifyLesson(lesson, cls);
  const hasRules = (cls?.categories || []).some((c) => String(c.pattern || "").trim());
  // An explicit "未分类" on a lesson is the user's own decision — respect it rather
  // than quietly re-filing the lesson under its folder.
  const explicitNone = lesson && (cls?.manual || {})[lesson.id] === "__none__";
  if (!hasRules && !explicitNone && g.key === "other" && lesson && lesson.folderId) {
    return { key: "folder:" + lesson.folderId, label: "📁 " + folderName(folders, lesson.folderId), catId: null };
  }
  return g;
}

function lessonRow(l, cls, catOpts) {
  const cardCount = l.cardCount ?? 0;
  const due = l.dueCards ?? 0;
  const pct = l.pct ?? 0;
  const showBar = l.pct != null;
  const manualId = (cls?.manual || {})[l.id] || "";
  const showCat = catOpts != null; // only Lessons list renders the category picker
  const check = lessonsSelectMode
    ? `<input type="checkbox" class="lesson-check" data-id="${l.id}" ${lessonsSelection.has(l.id) ? "checked" : ""} title="选择这门课" style="width:17px;height:17px;flex:none;cursor:pointer">`
    : "";
  return `
    <div class="lesson-item" data-id="${l.id}">
      ${check}
      <div class="lesson-ico">${l.kind === "pdf" ? "📄" : "📑"}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">
          <span>${escapeHtml(l.title)}</span>
          <button class="chip" data-rename-lesson="${l.id}" title="重命名这门课（课程标题）" style="font-size:12px;padding:3px 7px">✎</button>
        </div>
        <div class="sub">${l.kind.toUpperCase()} · ${fmtDate(l.createdAt)} · ${l.slides?.length || 0} slides</div>
        ${l.folderId ? `<div class="sub" style="font-size:11px;color:var(--brand)">📁 ${escapeHtml(folderName(currentFolders, l.folderId))}</div>` : ""}
        ${showBar ? `<div class="progress-bar" style="height:6px;margin-top:8px"><div class="progress-fill" style="width:${pct}%"></div></div>` : ""}
        ${showCat ? `<div style="margin-top:8px">
          <select class="lesson-cat search-select" data-lesson="${l.id}" title="设置该课分类（自动 = 按分类规则匹配）" style="font-size:12px;padding:3px 8px;max-width:200px">
            <option value="">自动</option>
            ${catOpts || ""}
            <option value="__none__" ${manualId === "__none__" ? "selected" : ""}>📁 其他</option>
          </select>
        </div>` : ""}
      </div>
      <div class="lesson-meta">
        ${l.points?.length ? `<span class="pill pill-brand">${l.points.length} points</span>` : ""}
        ${cardCount ? `<span class="pill pill-accent">${cardCount} cards</span>` : ""}
        ${showBar ? `<span class="pill pill-gray">${pct}%</span>` : ""}
        ${due ? `<span class="pill pill-amber">${due} due</span>` : ""}
      </div>
    </div>`;
}

function emptyState(ico, text, btn) {
  return `<div class="empty"><div class="empty-ico">${ico}</div><div>${text}</div>${btn || ""}</div>`;
}

// Rename a lesson. Its title was auto-derived from the uploaded file name, and it
// shows up as the chapter label in the formula library, as the row title on the
// Lessons page, and as the grouping key for course codes — but it could only ever
// be set at upload time.
//
// Subject inference matches a lesson's TITLE against each subject's keywords, so a
// rename can move a lesson between subjects in either direction:
//   "生理学 第二章 …" → "膜转运"          loses the only keyword → would fall to 通用
//   "第一章 生命的化学基础" → "生物化学 第一章 …"  gains a keyword → should re-file
// So resolve the subject from the NEW title first, and only fall back to the old
// one when the new title matches nothing (a pin that merely freezes the old subject
// would make it impossible to fix a mis-filed chapter by renaming it).
async function renameLesson(lessonId) {
  const lesson = await db.get("lessons", lessonId);
  if (!lesson) return false;
  const next = prompt("重命名这一章（课程标题）：", lesson.title || "");
  if (next == null) return false;
  const name = String(next).trim();
  if (!name || name === lesson.title) return false;
  const before = lesson.subjectId ? subjectById(lesson.subjectId) : subjectForLesson(lesson);
  const after = subjectForLesson({ ...lesson, title: name, subjectId: null });
  const general = subjectById("general");
  const keep = (after && (!general || after.id !== general.id)) ? after : before;
  if (keep && keep.id) lesson.subjectId = keep.id;
  lesson.title = name;
  await db.put("lessons", lesson);
  return true;
}

/* ---------------- Lessons list ---------------- */
async function renderLessons() {
  const [lessons, cards, quizzes, cls, folders] = await Promise.all([
    db.getAllLite("lessons"), db.getAllLite("cards"), db.getAll("quizzes"), api.getClassification().catch(() => ({ categories: [], manual: {} })), (db.getAll("folders").catch(() => []) || []),
  ]);
  currentFolders = folders || [];
  const mastery = computeMasteryMap(lessons, cards, quizzes);
  let lessonsWith = withStats(lessons, cards).map((l) => ({ ...l, pct: mastery[l.id]?.pct ?? 0 }));
  // Active folder filter ("" all, "__none__" unfiled, else a folder id).
  if (lessonsFolderFilter === "__none__") lessonsWith = lessonsWith.filter((l) => !l.folderId);
  else if (lessonsFolderFilter) lessonsWith = lessonsWith.filter((l) => l.folderId === lessonsFolderFilter);
  const sorted = [...lessonsWith].sort((a, b) => b.createdAt - a.createdAt);
  const groups = new Map(); // groupKey -> {label, items}
  for (const l of sorted) {
    const g = groupForLesson(l, cls, currentFolders);
    // Keep the key on the stored group: the hide/restore controls and the
    // "已隐藏" banner all address groups by this key.
    if (!groups.has(g.key)) groups.set(g.key, { key: g.key, label: g.label, items: [] });
    groups.get(g.key).items.push(l);
  }
  // Sort group order by course-code natural order (letters, then numeric value),
  // with "📁 其他" last.
  const groupOrder = [...groups.values()].sort((a, b) => compareCodeLabels(a.label, b.label));
  // Within each group, sort by the lesson's own course code (natural order),
  // then by most recently created.
  groupOrder.forEach((g) => {
    g.items.sort((a, b) => {
      const c = compareCodeLabels(courseGroup(a.title) || "", courseGroup(b.title) || "");
      if (c) return c;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
  });
  const catOpts = (cls?.categories || []).map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join("");
  // Flatten the grouped list into an ordered array of group-headers and lesson
  // items, then render lazily in batches so hundreds of lessons don't freeze the
  // page. `items` = [{type:'group',g} | {type:'lesson',l}]
  const items = [];
  const hiddenOnes = groupOrder.filter((g) => hiddenGroups.has(g.key));
  for (const g of groupOrder) {
    if (hiddenGroups.has(g.key)) continue;   // hidden by the student
    items.push({ type: "group", g });
    g.items.forEach((l) => items.push({ type: "lesson", l }));
  }
  const hiddenLessons = hiddenOnes.reduce((a, g) => a + g.items.length, 0);
  const BATCH = 60; // lesson rows per batch
  let visible = Math.min(BATCH * 2, items.length); // show ~2 batches initially
  const renderList = () => {
    let lessonCount = 0, out = "", shownAny = false;
    for (let i = 0; i < items.length && lessonCount < visible; i++) {
      const it = items[i];
      if (it.type === "group") {
        // show a group header only if it has at least one lesson reaching the cap
        out += `<div style="grid-column:1/-1;margin:14px 0 4px">
          <div style="font-weight:700;color:var(--text-2);letter-spacing:.04em;display:flex;align-items:center;gap:8px">
            <span class="pill pill-brand" style="font-size:11px;letter-spacing:.08em">${escapeHtml(it.g.label)}</span>
            <span class="sub">${it.g.items.length} lesson${it.g.items.length > 1 ? "s" : ""}</span>
            <button class="chip hm-hide-group" data-hidegroup="${escapeHtml(it.g.key)}" title="隐藏这个分组（只影响显示）" style="font-size:11px;padding:2px 9px">👁 隐藏</button>
          </div>
        </div>`;
      } else {
        out += lessonRow(it.l, cls, catOpts);
        lessonCount++;
        shownAny = true;
      }
    }
    const remaining = items.filter((it) => it.type === "lesson").length - lessonCount;
    const moreBtn = remaining > 0 && shownAny
      ? `<div style="grid-column:1/-1;text-align:center;margin-top:16px">
          <button class="btn btn-ghost" id="btn-load-more">⬇ 加载更多（还有 ${remaining} 门）</button>
        </div>` : "";
    return { gridHtml: out, moreBtn, remaining };
  };
  const rl = renderList();
  const missingCount = items.filter((x) => x.type === "lesson" && !(x.l.points || []).length).length;
  $("#view").innerHTML = `
    <div class="page-head">
      <div class="title-wrap"><h1>Lessons</h1><p class="sub">Everything you've studied, grouped by course code. ${items.filter((x) => x.type === "lesson").length} lessons total.</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${missingCount ? `<button class="btn btn-accent" id="btn-gen-missing" title="为所有还没提炼知识点的课一键生成笔记">📝 一键生成未生成的笔记 (${missingCount})</button>` : ""}
        <button class="btn btn-sm btn-ghost" id="btn-reclassify-all" title="用新的分类规则重新整理所有课程的知识点层级（不重新生成内容，每门约 2 次 AI 调用）">🏷 重排全部分类</button>
        <button class="btn btn-primary" id="btn-newtext">✍ New text lesson</button>
        <button class="btn btn-primary" id="btn-upload">＋ Upload lesson</button>
      </div>
    </div>
    <div class="card" style="margin-bottom:16px;display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:12px 14px">
      <button class="btn btn-sm ${lessonsSelectMode ? "btn-accent" : "btn-ghost"}" id="btn-select-mode" title="多选课程，再移动到文件夹">${lessonsSelectMode ? "✓ 完成" : "☑ 多选"}</button>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;flex:1;min-width:180px">
        <button class="chip ${!lessonsFolderFilter ? "active" : ""}" data-folder="">全部</button>
        <button class="chip ${lessonsFolderFilter === "__none__" ? "active" : ""}" data-folder="__none__">未分类</button>
        ${(folders || []).map((f) => `<span style="display:inline-flex;align-items:center;gap:2px">
          <button class="chip ${lessonsFolderFilter === f.id ? "active" : ""}" data-folder="${f.id}">🗂 ${escapeHtml(f.name)}</button>
          <button class="chip" data-rename="${f.id}" title="重命名" style="font-size:12px;padding:4px 7px">✎</button>
          <button class="chip" data-delfolder="${f.id}" title="删除" style="font-size:12px;padding:4px 7px">✕</button>
        </span>`).join("")}
      </div>
      <input type="text" id="new-folder-name" placeholder="新文件夹名" style="flex:1;min-width:130px;padding:7px 10px;border:1.5px solid var(--border);border-radius:9px;font-size:13px">
      <button class="btn btn-sm" id="btn-new-folder">＋ 新建文件夹</button>
      ${lessonsSelectMode ? `
        <span class="sub" style="margin-left:auto">已选 <b id="sel-count">${lessonsSelection.size}</b> 门</span>
        <select id="move-folder" class="search-select" style="padding:5px 9px;border:1.5px solid var(--border);border-radius:9px;font-size:13px">
          <option value="">移到文件夹…</option>
          <option value="__none__">📁 移出到未分类</option>
          ${(folders || []).map((f) => `<option value="${f.id}">→ ${escapeHtml(f.name)}</option>`).join("")}
        </select>
        <button class="btn btn-sm btn-primary" id="btn-move">移动</button>` : ""}
    </div>
    ${hiddenOnes.length ? `<div class="card" style="margin-bottom:14px;padding:10px 14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span class="sub">👁 已隐藏 ${hiddenOnes.length} 个分组（${hiddenLessons} 门课）</span>
      ${hiddenOnes.map((g) => `<button class="chip" data-showgroup="${escapeHtml(g.key)}" title="点击恢复显示">${escapeHtml(g.label)} ＋</button>`).join("")}
      <button class="btn btn-sm btn-ghost" id="btn-show-all-groups" style="margin-left:auto">全部显示</button>
    </div>` : ""}
    <div class="grid">${items.filter((x) => x.type === "lesson").length ? rl.gridHtml : emptyState("📚", hiddenOnes.length ? "所有分组都被隐藏了——用上方的按钮恢复。" : "No lessons yet.")}${rl.moreBtn}</div>
  `;
  const genMissing = $("#btn-gen-missing");
  if (genMissing) genMissing.addEventListener("click", () => generateAllMissing());
  const rcAll = $("#btn-reclassify-all");
  if (rcAll) rcAll.addEventListener("click", () => reclassifyAllLessons());
  $("#btn-upload").addEventListener("click", openUpload);
  $("#btn-newtext").addEventListener("click", () => openCreateText());
  // ---- Folder bar handlers ----
  $("#btn-select-mode").addEventListener("click", () => { lessonsSelectMode = !lessonsSelectMode; renderLessons(); });
  $("#view").querySelectorAll(".chip[data-folder]").forEach((c) => c.addEventListener("click", () => { lessonsFolderFilter = c.dataset.folder; renderLessons(); }));
  $("#btn-new-folder").addEventListener("click", async () => {
    const name = ($("#new-folder-name").value || "").trim();
    if (!name) { toast("请输入文件夹名", "error"); return; }
    await db.put("folders", { id: uid(), name, createdAt: Date.now() });
    toast("文件夹已创建 ✓", "success");
    renderLessons();
  });
  $("#view").querySelectorAll(".chip[data-rename]").forEach((c) => c.addEventListener("click", async () => {
    const f = currentFolders.find((x) => x.id === c.dataset.rename);
    const name = prompt("重命名文件夹：", f?.name || "");
    if (name && name.trim() && f) { f.name = name.trim(); await db.put("folders", f); renderLessons(); }
  }));
  // Lesson titles were only ever set at upload (defaulting to the file name), so
  // offer the same ✎ the folders have. Bound per button: #view survives innerHTML
  // replacement and a delegated listener would stack up on every render.
  $("#view").querySelectorAll(".chip[data-rename-lesson]").forEach((c) => c.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    if (await renameLesson(c.dataset.renameLesson)) {
      toast("已重命名 ✓", "success");
      renderLessons();
    }
  }));
  $("#view").querySelectorAll(".chip[data-delfolder]").forEach((c) => c.addEventListener("click", async () => {
    if (!confirm("删除这个文件夹？（里面的课会变成未分类）")) return;
    await db.delete("folders", c.dataset.delfolder);
    const ls = await db.getAllLite("lessons");
    for (const l of ls) if (l.folderId === c.dataset.delfolder) { l.folderId = null; await db.put("lessons", l); }
    if (lessonsFolderFilter === c.dataset.delfolder) lessonsFolderFilter = "";
    toast("文件夹已删除 ✓", "success");
    renderLessons();
  }));
  const btnMove = $("#btn-move");
  if (btnMove) btnMove.addEventListener("click", async () => {
    if (!lessonsSelection.size) { toast("请先勾选课程", "error"); return; }
    // Popup page: pick the folder to move the selected lessons into.
    openModal(`
      <h2>移动到文件夹</h2>
      <p class="sub" style="margin-bottom:14px">将选中的 <b>${lessonsSelection.size}</b> 门课移动到：</p>
      <div class="grid" style="grid-template-columns:1fr;gap:10px">
        <button class="q-option" data-target="__none__"><span class="letter">📁</span><span>未分类（移出所有文件夹）</span></button>
        ${(folders || []).map((f) => `<button class="q-option" data-target="${f.id}"><span class="letter">🗂</span><span>${escapeHtml(f.name)}</span></button>`).join("")}
      </div>`);
    $("#modal-root").querySelectorAll(".q-option[data-target]").forEach((btn) => btn.addEventListener("click", async () => {
      const targetId = btn.dataset.target === "__none__" ? null : btn.dataset.target;
      let done = 0;
      for (const id of [...lessonsSelection]) {
        const l = lessons.find((x) => x.id === id);
        if (l) { l.folderId = targetId; await db.put("lessons", l); done++; }
      }
      lessonsSelection.clear();
      closeModal();
      toast(`已将 ${done} 门课${targetId ? "移入文件夹" : "移到未分类"} ✓`, "success");
      renderLessons();
    }));
  });
  const loadMore = $("#btn-load-more");
  if (loadMore) {
    loadMore.addEventListener("click", (e) => {
      e.stopPropagation();
      const grid = e.target.closest(".grid");
      visible += BATCH;
      const r = renderList();
      // Replace only the grid contents (keep header), append next batch.
      if (grid) {
        grid.innerHTML = (items.filter((x) => x.type === "lesson").length ? r.gridHtml : emptyState("📚", "No lessons yet.")) + r.moreBtn;
      }
      bindLessonRows();
    });
  }
  // Hide / restore a whole course-code group (display-only; nothing is deleted).
  const bindGroupVisibility = () => {
    $("#view").querySelectorAll(".hm-hide-group").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      hiddenGroups.add(b.dataset.hidegroup);
      saveHiddenGroups();
      renderLessons();
    }));
    $("#view").querySelectorAll("[data-showgroup]").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      hiddenGroups.delete(b.dataset.showgroup);
      saveHiddenGroups();
      renderLessons();
    }));
    const all = $("#btn-show-all-groups");
    if (all) all.addEventListener("click", () => { hiddenGroups.clear(); saveHiddenGroups(); renderLessons(); });
  };
  bindGroupVisibility();

  const bindLessonRows = () => {
    $("#view").querySelectorAll(".lesson-item").forEach((el) => el.addEventListener("click", () => openLesson(el.dataset.id)));
    $("#view").querySelectorAll(".lesson-check").forEach((cb) => {
      cb.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = cb.dataset.id;
        if (e.shiftKey && lessonsAnchorId) {
          // range-select: select from anchor to this row
          const order = items.filter((x) => x.type === "lesson").map((x) => x.l.id);
          const ai = order.indexOf(lessonsAnchorId), bi = order.indexOf(id);
          if (ai !== -1 && bi !== -1) {
            const [lo, hi] = ai < bi ? [ai, bi] : [bi, ai];
            order.slice(lo, hi + 1).forEach((lid) => lessonsSelection.add(lid));
          }
          lessonsAnchorId = id;
          $("#view").querySelectorAll(".lesson-check").forEach((c) => { c.checked = lessonsSelection.has(c.dataset.id); });
        } else {
          if (lessonsSelection.has(id)) lessonsSelection.delete(id); else lessonsSelection.add(id);
          lessonsAnchorId = id;
          cb.checked = lessonsSelection.has(id);
        }
        const cnt = $("#sel-count"); if (cnt) cnt.textContent = lessonsSelection.size;
      });
    });
    $("#view").querySelectorAll(".lesson-item").forEach((el) => {
      const sel = el.querySelector(".lesson-cat");
      if (sel) {
        sel.addEventListener("click", (e) => e.stopPropagation());
        sel.addEventListener("change", async (e) => {
          e.stopPropagation();
          const lessonId = sel.dataset.lesson;
          const val = sel.value;
          const cur = await api.getClassification().catch(() => null);
          if (!cur) return;
          const manual = cur.manual || {};
          if (val === "") delete manual[lessonId];
          else manual[lessonId] = val;
          const r = await api.saveClassification({ categories: cur.categories || [], manual });
          if (r.error) { toast(r.error, "error"); return; }
          renderLessons();
          toast("分类已更新 ✓", "success");
        });
      }
    });
  };
  bindLessonRows();
}

/* ---------------- Lesson detail ---------------- */
// opts.restore=false when the caller is about to scroll somewhere specific
// (openPoint / openSlide): restoring the saved spot first would fight that jump.
async function openLesson(id, tab = "points", opts = {}) {
  // Remember where we were in the lesson we are leaving before switching away.
  saveReadingPosition();
  currentLessonId = id;
  currentTab = tab || "points";
  currentView = "lesson";
  quizFavOnly = false; // the "only starred" filter does not carry across lessons
  setActivity("study");
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
  await renderLessonDetail({ resetScroll: true });
  if (opts.restore !== false) {
    const pos = restoreSavedReadingPosition(id);
    if (pos) {
      const where = pos.label ? `：${pos.label}` : "";
      toast(`📍 已回到上次读到的位置${where}`, "");
    }
  }
}

/* ---------------- Keep the reader's place across re-renders ----------------
 * A full re-render replaces every node, so the browser forgets the scroll
 * position and the page snaps to the top — jarring when you were halfway down a
 * long point list. We remember the first card still visible in the viewport and
 * scroll back to its old offset; anchoring on an element (not a pixel number)
 * survives the height changes a re-render often brings.
 */
function captureReadingAnchor() {
  // The individual note cards first, then the quiz card. A generic `.card` is
  // only a last resort: in the flat "按讲义顺序" list every point sits inside ONE
  // wrapper .card, which has no id and no title of its own, so anchoring on it
  // recorded nothing that could be restored.
  for (const selector of ["#kp-list .kp-section", "#qv-card", "#tab-body .card"]) {
    for (const el of document.querySelectorAll(selector)) {
      const r = el.getBoundingClientRect();
      if (r.bottom > 8) return { id: el.id || null, el, top: r.top, y: window.scrollY };
    }
  }
  return { id: null, el: null, top: 0, y: window.scrollY };
}

function restoreReadingAnchor(anchor) {
  if (!anchor) return;
  if (anchor.el && anchor.el.isConnected) {
    const r = anchor.el.getBoundingClientRect();
    window.scrollBy(0, r.top - anchor.top);
    return;
  }
  if (anchor.id) {
    const el = document.getElementById(anchor.id);
    if (el) { window.scrollBy(0, el.getBoundingClientRect().top - anchor.top); return; }
  }
  window.scrollTo(0, anchor.y);
}

/* ---------------- Saved reading position ----------------
 * The block above keeps your place through a re-render inside one visit. This
 * one keeps it ACROSS visits: a lecture's notes are a long scroll, and coming
 * back tomorrow to the top of a 200-point list means hunting for the paragraph
 * you stopped at.
 *
 * One entry per lesson, in localStorage (a reading preference, like the folded
 * subjects), capped so the list cannot grow without bound. Like the in-session
 * restore it stores the first card on screen plus its viewport offset rather
 * than a pixel count, so a re-render that changes the page height still lands on
 * the same paragraph.
 */
const READ_POS_KEY = "mbbs_read_pos";
const READ_POS_MAX = 60;

function readPosMap() {
  try {
    const v = JSON.parse(localStorage.getItem(READ_POS_KEY) || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

function writeReadPosMap(map) {
  try { localStorage.setItem(READ_POS_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}

// Keep the most recently read lessons and drop the rest, so a long-lived browser
// does not accumulate an entry per lesson ever opened.
function pruneReadPos(map) {
  const ids = Object.keys(map);
  if (ids.length <= READ_POS_MAX) return map;
  ids.sort((a, b) => (map[a]?.at || 0) - (map[b]?.at || 0));
  ids.slice(0, ids.length - READ_POS_MAX).forEach((id) => delete map[id]);
  return map;
}

function readPosGet(lessonId) {
  return lessonId ? (readPosMap()[lessonId] || null) : null;
}

// Saves are ignored until this moment (see readPosForget).
let readPosQuietUntil = 0;

function readPosForget(lessonId) {
  const map = readPosMap();
  delete map[lessonId];
  writeReadPosMap(map);
  // Getting to the "forget" control usually means scrolling back up, and that
  // scroll would immediately record a new position — so ignore saves for a moment.
  readPosQuietUntil = Date.now() + 2000;
}

// The most recently read lesson that still exists, for the dashboard's
// "continue where you left off" card.
function latestReadPos(lessons) {
  const map = readPosMap();
  const byId = new Map((lessons || []).map((l) => [l.id, l]));
  let best = null;
  for (const [id, pos] of Object.entries(map)) {
    const lesson = byId.get(id);
    if (!lesson || !pos) continue;
    if (!best || (pos.at || 0) > (best.pos.at || 0)) best = { lesson, pos };
  }
  return best;
}

// What to call the place you stopped at: the title of the card on screen.
function readingLabelAt(el) {
  const sec = el && el.closest ? el.closest(".kp-section") : null;
  const t = sec ? sec.querySelector(".kp-subtitle") : null;
  if (t && t.textContent.trim()) return t.textContent.trim().slice(0, 80);
  return "";
}

let readPosTimer = 0;
// True while a restore is scrolling the page into place: the restore itself fires
// scroll events, and saving during them recorded the half-restored spot over the
// good one — a single failed restore used to destroy the position permanently.
let readPosRestoring = false;

function scheduleSaveReadingPos() {
  if (readPosTimer) return;
  readPosTimer = window.setTimeout(() => { readPosTimer = 0; saveReadingPosition(); }, 700);
}

function saveReadingPosition(lessonId = currentLessonId) {
  if (readPosRestoring) return;
  if (Date.now() < readPosQuietUntil) return;
  // Only the two long-scrolling tabs are worth remembering: the slides/figures
  // tabs are browsed by image, and cards/quiz keep their own progress.
  if (!lessonId || currentView !== "lesson") return;
  if (currentTab !== "points" && currentTab !== "quiz") return;
  const a = captureReadingAnchor();
  const map = readPosMap();
  // Which topic groups were open. Without this a restored position would land on
  // a page with everything collapsed, which reads nothing like where you stopped.
  const openGroups = [...document.querySelectorAll("details.kp-group[open]")]
    .map((d) => d.dataset.gkey).filter(Boolean).slice(0, 120);
  map[lessonId] = {
    at: Date.now(),
    y: Math.round(window.scrollY),
    anchorId: a.id || null,
    anchorTop: Math.round(a.top || 0),
    tab: currentTab,
    label: readingLabelAt(a.el),
    openGroups,
  };
  writeReadPosMap(pruneReadPos(map));
}

function applyReadPos(pos) {
  // Reopen the groups the reader had expanded, so the page has the same shape (and
  // the same height above the saved card) as when the position was recorded.
  if (Array.isArray(pos.openGroups) && pos.openGroups.length) {
    const want = new Set(pos.openGroups);
    document.querySelectorAll("details.kp-group").forEach((d) => { if (want.has(d.dataset.gkey)) d.open = true; });
  }
  const el = pos.anchorId ? document.getElementById(pos.anchorId) : null;
  // Topic groups are collapsed by default, and a card inside a closed <details>
  // has no layout at all — scrollBy() would then land anywhere. Open the group
  // that holds the saved card first, which is also what the reader expects: you
  // come back and see the paragraph you stopped at, not a closed summary row.
  if (el) {
    document.querySelectorAll("details.kp-group").forEach((d) => { if (d.contains(el)) d.open = true; });
  }
  restoreReadingAnchor({ id: pos.anchorId, el, top: pos.anchorTop || 0, y: pos.y });
}

/* Put the reader back where they stopped. Returns the entry it restored, or null.
 * Only the tab it was saved in is restored — a position in the notes means
 * nothing in the quiz — and a position within the first screen is ignored, since
 * that is the top anyway. */
function restoreSavedReadingPosition(lessonId) {
  const pos = readPosGet(lessonId);
  if (!pos || !(pos.y > 60)) return null;
  if (pos.tab && pos.tab !== currentTab) return null;
  readPosRestoring = true;
  const done = () => { readPosRestoring = false; };
  requestAnimationFrame(() => {
    applyReadPos(pos);
    // Typeset formulas and decoded figures change the offsets just after the
    // first paint, which would leave the reader a screen or two off; re-apply
    // once the layout has settled.
    setTimeout(() => applyReadPos(pos), 300);
  });
  setTimeout(done, 1100);
  return pos;
}

// Flush the position when the page is hidden or closed: a tab switch or a
// browser close never fires our own navigation handlers.
window.addEventListener("pagehide", () => saveReadingPosition());
document.addEventListener("visibilitychange", () => { if (document.hidden) saveReadingPosition(); });
window.addEventListener("scroll", () => { if (currentView === "lesson") scheduleSaveReadingPos(); }, { passive: true });

/* The "you were here" chip in the lesson header.
 *
 * The position is restored automatically when the lesson opens, so this exists
 * for the two cases that leaves open: you scrolled away and want it back, and you
 * finished with this lesson and want it forgotten.
 */
function readPosChip(lessonId, pointCount) {
  const pos = readPosGet(lessonId);
  if (!pos || !(pos.y > 60)) return "";
  // Say how far in this is, so the chip also answers "how much is left".
  const where = pos.label ? escapeHtml(pos.label) : (pos.tab === "quiz" ? "测验进度" : "阅读进度");
  return `<div class="sub readpos-chip" style="margin-top:7px;display:flex;gap:6px;align-items:center;font-size:12px;flex-wrap:wrap">
    <button class="chip" id="btn-goto-readpos" title="回到这个位置">📍 上次读到：${where}</button>
    <span class="sub" style="font-size:11.5px;opacity:.75">${fmtDate(pos.at)}${pointCount ? " · 共 " + pointCount + " 个知识点" : ""}</span>
    <button class="chip" id="btn-forget-readpos" title="不再记住这门课的位置">✕ 忘记</button>
  </div>`;
}

// opts.resetScroll: true for deliberate navigation (opening a lesson, switching
// tabs). Everything else — saving a note, flipping a point to English, rating a
// recall — keeps the reader exactly where they were.
async function renderLessonDetail(opts) {
  const keepScroll = !(opts && opts.resetScroll);
  const anchor = keepScroll ? captureReadingAnchor() : null;
  try {
    await renderLessonDetailBody();
  } finally {
    if (anchor) requestAnimationFrame(() => restoreReadingAnchor(anchor));
  }
}

const enViewLoaded = new Set();

async function renderLessonDetailBody() {
  const lesson = await getLessonFull(currentLessonId);
  if (!lesson) { navigate("lessons"); return; }
  // Restore the per-point English choices once per lesson per session.
  if (!enViewLoaded.has(lesson.id)) { enViewLoaded.add(lesson.id); loadEnView(lesson.id); }
  const [cards, quizRecs] = await Promise.all([
    db.getAllByIndex("cards", "lessonId", currentLessonId),
    db.getAllByIndex("quizzes", "lessonId", currentLessonId),
    loadFavs(), // the star state renders synchronously, so favourites must be in hand
  ]);
  const quiz = latestQuiz(quizRecs);

  // Build the ordered lesson list once for quick prev/next switching. Use the
  // same "course code" grouping the Lessons list shows, so ◀ ▶ follow the order
  // you see on the page (e.g. CPR04 → CPR63 → GIS06).
  const all = await db.getAllLite("lessons");
  lessonOrder = all
    .map((l) => ({ id: l.id, createdAt: l.createdAt || 0, code: courseGroup(l.title) || "" }))
    .sort((a, b) => (compareCodeLabels(a.code, b.code) || ((a.createdAt || 0) - (b.createdAt || 0))))
    .map((x) => x.id);
  const idx = lessonOrder.indexOf(currentLessonId);
  const prevId = idx > 0 ? lessonOrder[idx - 1] : null;
  const nextId = idx >= 0 && idx < lessonOrder.length - 1 ? lessonOrder[idx + 1] : null;

  const tabs = [
    ["points", "Key points"], ["cards", "Flashcards"], ["quiz", "Quiz"], ["mindmap", "Mind map"], ["figures", "Figures"], ["slides", "Slides"],
  ];
  const isImmersive = immersiveOn && currentTab === "points";

  const switchBtns = `
    <button class="btn btn-sm btn-ghost" id="btn-back" title="返回课程列表">←</button>
    <button class="btn btn-sm btn-ghost" id="btn-prev-lesson" ${prevId ? "" : "disabled"} title="上一课">◀</button>
    <button class="btn btn-sm btn-ghost" id="btn-next-lesson" ${nextId ? "" : "disabled"} title="下一课">▶</button>`;
  const immersiveBtn = `<button class="btn btn-sm ${isImmersive ? "btn-accent" : "btn-ghost"}" id="btn-immersive" title="${isImmersive ? "退出沉浸式" : "全屏专注阅读知识点"}">${isImmersive ? "⊟ 退出沉浸" : "🌗 沉浸式"}</button>`;

  if (isImmersive) {
    document.body.classList.add("immersive");
    $("#view").innerHTML = `
      <div class="page-head" style="margin-bottom:12px">
        <div class="title-wrap"><h1>${escapeHtml(lesson.title)}</h1><p class="sub">${lesson.points?.length || 0} points</p></div>
        <div style="display:flex;gap:5px;align-items:center">${switchBtns}${immersiveBtn}</div>
      </div>
      <div id="tab-body-immersive"></div>`;
    $("#btn-prev-lesson").addEventListener("click", () => { if (prevId) openLesson(prevId); });
    $("#btn-back").addEventListener("click", () => navigate("lessons"));
    $("#btn-next-lesson").addEventListener("click", () => { if (nextId) openLesson(nextId); });
    $("#btn-immersive").addEventListener("click", () => { immersiveOn = false; renderLessonDetail({ resetScroll: true }); });
    renderImmersivePoints(lesson);
    return;
  }

  document.body.classList.remove("immersive");
  const detailSubj = subjectForLesson(lesson);
  const subjectPicker = `
        <select id="lesson-subject" class="search-select" title="该课所属学科：决定 AI 提炼知识点时关注哪些维度（自动 = 按课程名匹配）"
          style="padding:4px 9px;border:1.5px solid var(--border);border-radius:9px;font-size:12px;margin-top:7px">
          <option value="" ${lesson.subjectId ? "" : "selected"}>📚 自动 · ${escapeHtml(detailSubj.name)}</option>
          ${studyProfile().subjects.map((s) => `<option value="${escapeHtml(s.id)}" ${lesson.subjectId === s.id ? "selected" : ""}>📚 ${escapeHtml(s.name)}</option>`).join("")}
        </select>`;
  $("#view").innerHTML = `
    <div class="page-head">
      <div class="title-wrap">
        <h1>${escapeHtml(lesson.title)}</h1>
        <p class="sub">${lesson.kind.toUpperCase()} · ${fmtDate(lesson.createdAt)} · ${lesson.slides?.length || 0} slides · ${lesson.points?.length || 0} points · ${cards.length} cards</p>
        ${readPosChip(lesson.id, lesson.points?.length || 0)}
        ${subjectPicker}
        ${courseBriefBox(lesson)}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;justify-content:flex-end">
        ${switchBtns}
        ${immersiveBtn}
        <button class="btn btn-accent" id="btn-gen">✨ 一键生成</button>
        <button class="btn btn-sm btn-ghost" id="btn-gen-points" title="只重新提炼知识点">📌 知识点</button>
        <button class="btn btn-sm btn-ghost" id="btn-gen-cards" title="只重新生成闪卡">🃏 闪卡</button>
        <button class="btn btn-sm btn-ghost" id="btn-gen-quiz" title="只重新生成题目">📝 题目</button>
        <button class="btn btn-sm btn-ghost" id="btn-gen-figs" title="只重新配图">🖼 配图</button>
        <button class="btn btn-sm btn-ghost" id="btn-reclassify" title="用新的分类规则重新整理这门课的知识点层级（不重新生成内容，成本极低）">🏷 重排分类</button>
        <button class="btn btn-sm btn-ghost" id="btn-export" title="下载 PDF">📄 PDF</button>
        <button class="btn btn-sm btn-ghost" id="btn-export-anki" title="${cards.length ? "下载 Anki 卡包" : "这门课还没有闪卡，先生成再导出"}" style="${cards.length ? "" : "opacity:.45"}">🃏 Anki</button>
        <button class="btn btn-sm btn-ghost" id="btn-export-drive" title="上传 PDF 到 Google Drive">☁️ Drive</button>
        <button class="btn btn-sm btn-ghost" id="btn-export-json" title="导出整门课（含配图+闪卡+题目）为 JSON，可分享给他人导入">⬇ JSON</button>
        <button class="btn btn-sm btn-ghost" id="btn-import-json" title="导入他人分享的课程 JSON 文件">⬆ 导入</button>
        <button class="btn btn-danger btn-ghost" id="btn-del">🗑</button>
      </div>
    </div>
    <div class="tabs">${tabs.map(([k, label]) => `<button class="tab ${k === currentTab ? "active" : ""}" data-tab="${k}">${label}</button>`).join("")}</div>
    <div id="tab-body"></div>
  `;
  $("#view").querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => { immersiveOn = false; currentTab = t.dataset.tab; renderLessonDetail({ resetScroll: true }); }));
  $("#btn-prev-lesson").addEventListener("click", () => { if (prevId) openLesson(prevId); });
  $("#btn-back").addEventListener("click", () => navigate("lessons"));
  $("#btn-next-lesson").addEventListener("click", () => { if (nextId) openLesson(nextId); });
  $("#btn-immersive").addEventListener("click", () => { immersiveOn = true; currentTab = "points"; renderLessonDetail({ resetScroll: true }); });
  const gotoPos = $("#btn-goto-readpos");
  if (gotoPos) gotoPos.addEventListener("click", () => {
    const p = readPosGet(lesson.id);
    if (!p) return;
    applyReadPos(p);
    // Flipping to the saved tab first would land on the top of that tab, so the
    // chip switches tab without restoring and then scrolls to the saved anchor.
    if (p.tab && p.tab !== currentTab) {
      currentTab = p.tab;
      renderLessonDetail({ resetScroll: true }).then(() => setTimeout(() => applyReadPos(p), 120));
    }
  });
  const forgetPos = $("#btn-forget-readpos");
  if (forgetPos) forgetPos.addEventListener("click", () => {
    readPosForget(lesson.id);
    toast("已忘记这门课的阅读位置", "");
    renderLessonDetail();
  });
  $("#btn-gen").addEventListener("click", () => confirmGenerate("将<b>重新生成全部内容</b>（知识点、闪卡、题目、配图），并替换已有内容。确定继续？", () => generateStudySet(currentLessonId, !!lesson.points?.length)));
  $("#btn-gen-points").addEventListener("click", () => confirmGenerate("将<b>重新提炼知识点</b>并替换现有知识点（闪卡、题目不受影响）。确定继续？", () => generatePointsOnly(currentLessonId)));
  $("#btn-gen-cards").addEventListener("click", () => confirmGenerate("将<b>重新生成闪卡</b>并替换现有闪卡。确定继续？", () => generateCardsOnly(currentLessonId)));
  $("#btn-gen-quiz").addEventListener("click", () => confirmGenerate("将<b>重新生成题目</b>并替换现有题目。确定继续？", () => regenerateQuiz(currentLessonId)));
  $("#btn-gen-figs").addEventListener("click", () => confirmGenerate("将<b>重新配图</b>并更新图注。确定继续？", () => generateFiguresOnly(currentLessonId)));
  $("#btn-reclassify").addEventListener("click", () => confirmGenerate("将用新的分类规则<b>重新整理这门课的知识点层级</b>（不重新生成内容，仅重排分类）。确定继续？", () => reclassifyCurrentLesson(currentLessonId)));
  $("#btn-export").addEventListener("click", () => exportPdfOnly(currentLessonId));
  $("#btn-export-anki").addEventListener("click", () => {
    if (!cards.length) { toast("这门课还没有闪卡 —— 先点「🃏 闪卡」生成，再导出 Anki", "error"); return; }
    exportAnkiOnly(currentLessonId);
  });
  $("#btn-export-drive").addEventListener("click", () => exportLessonToDrive(currentLessonId));
  $("#btn-export-json").addEventListener("click", () => exportLessonJson(currentLessonId));
  $("#btn-import-json").addEventListener("click", importLessonJson);
  const subjSel = $("#lesson-subject");
  if (subjSel) subjSel.addEventListener("change", async () => {
    lesson.subjectId = subjSel.value || null;
    lesson.updatedAt = Date.now();
    await db.put("lessons", lesson);
    fullLessonCache.set(lesson.id, lesson);
    const chosen = lesson.subjectId ? subjectById(lesson.subjectId) : null;
    toast(chosen ? `学科已设为「${chosen.name}」` : "学科已设为自动匹配", "success");
    renderLessonDetail();
  });
  const editBrief = $("#btn-edit-brief");
  if (editBrief) editBrief.addEventListener("click", () => openBriefEditor(lesson));
  $("#btn-del").addEventListener("click", () => deleteLesson(currentLessonId));
  renderTabBody(lesson, cards, quiz);
}

function renderImmersivePoints(lesson) {
  const body = $("#tab-body-immersive");
  if (body) renderPointsTab(body, lesson);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function exportPdfOnly(lessonId) {
  toast("正在生成 PDF…");
  let pdf;
  try {
    pdf = await loadLessonPdf(lessonId);
  } catch (e) {
    toast("PDF 导出失败: " + (e && e.message || e), "error");
    return;
  }
  if (pdf && pdf.blob) downloadBlob(pdf.blob, pdf.filename);
  else toast("PDF 导出失败", "error");
}

async function exportAnkiOnly(lessonId) {
  toast("正在导出 Anki…");
  const apkg = await api.exportFile(lessonId, "apkg");
  if (apkg.ok) {
    downloadBlob(apkg.blob, apkg.filename);
    toast("Anki 导出完成 ✓", "success");
  } else if (/no flashcards/i.test(apkg.error || "")) {
    // This used to be swallowed silently, which made the button look broken.
    toast("这门课还没有闪卡 —— 先在课程页点「🃏 闪卡」生成，再导出 Anki", "error");
  } else {
    toast("Anki 导出失败: " + apkg.error, "error");
  }
}

// Export the WHOLE lesson (with slides/images, cards, quiz) as a single JSON
// file so it can be shared and re-imported on another deployment.
async function exportLessonJson(lessonId) {
  try {
    const lesson = await db.get("lessons", lessonId);
    if (!lesson) { toast("课程不存在", "error"); return; }
    const cards = await db.getAllByIndex("cards", "lessonId", lessonId);
    // Only the current bank: exporting every leftover quiz record would re-import
    // them as duplicates.
    const quizzes = [latestQuiz(await db.getAllByIndex("quizzes", "lessonId", lessonId))].filter(Boolean);
    const payload = { version: 1, exportedAt: Date.now(), lesson, cards, quizzes };
    const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    const title = (lesson.title || "lesson").replace(/[^\w\-]+/g, "_").slice(0, 60) || "lesson";
    downloadBlob(blob, `${title}.json`);
    toast("已导出课程 JSON（可分享给他人导入）✓", "success");
  } catch (e) { toast("导出失败: " + (e && e.message || e), "error"); }
}

// Import a shared lesson JSON file (from exportLessonJson).
function importLessonJson() {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "application/json,.json";
  inp.onchange = async () => {
    const file = inp.files && inp.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      if (!payload.lesson) { toast("不是有效的课程文件", "error"); return; }
      const r = await api.post("/api/import", { lesson: payload.lesson, cards: payload.cards || [], quizzes: payload.quizzes || [] });
      if (r.ok) { toast(`已导入课程「${r.title}」✓`, "success"); if (typeof renderLessons === "function") renderLessons(); }
      else toast("导入失败: " + (r.error || ""), "error");
    } catch (e) { toast("导入失败: " + (e && e.message || e), "error"); }
  };
  inp.click();
}

async function exportLessonToDrive(lessonId) {
  // 前端生成和网站一致的 PDF，先本地下载，再上传 Google Drive。
  let pdf;
  try {
    pdf = await loadLessonPdf(lessonId);
  } catch (e) {
    toast("PDF 生成失败: " + (e && e.message || e), "error");
    return;
  }
  if (!pdf || !pdf.blob) { toast("PDF 生成失败", "error"); return; }
  downloadBlob(pdf.blob, pdf.filename);
  toast("已下载 PDF，正在上传 Google Drive…");
  const r = await api.uploadPdf(lessonId, pdf.blob, pdf.filename);
  if (!r.ok || r.error) {
    toast("Drive 上传失败（PDF 已在本地保存）: " + (r.error || "未知错误"), "error");
    return;
  }
  toast("已上传到 Google Drive ✓" + (r.link ? " — " + r.link : ""));
}

/* Build a print-friendly container that mirrors the site's visual style,
 * then html2pdf turns the live DOM into a PDF. */
function buildExportContainer(lesson, quiz) {
  const c = document.createElement("div");
  c.id = "pdf-export";
  // Keep it in normal document flow (not position:fixed offscreen) — html2canvas
  // frequently renders fixed/hidden layers as a blank PDF.
  c.style.cssText = "width:100%;max-width:760px;margin:0 auto;background:#fff;color:#0f172a;padding:26px 30px;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;";
  const points = lesson.points || [];
  // ---- render one key-point card (reused for PDF) ----
  const pointCard = (p) => {
    const imp = p.importance || "medium";
    const impColor = imp === "high" ? "#dc2626" : imp === "low" ? "#16a34a" : "#d97706";
    const impBg = imp === "high" ? "#fee2e2" : imp === "low" ? "#dcfce7" : "#fef3c7";
    const bullets = (p.explanation || "").split("\n").map(s => s.replace(/^[-*•]\s*/, "").trim()).filter(Boolean);
    return `
      <div style="border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;margin:0 0 10px;background:#fff;page-break-inside:avoid;">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;text-transform:uppercase;background:${impBg};color:${impColor};">${imp}</span>
          <span style="font-size:15px;font-weight:700;color:#0f172a;">${escapeHtml(p.title || "Point")}</span>
          ${(p.tags || []).slice(0,2).map(t => `<span style="font-size:11px;background:#f8fafc;border:1px solid #e2e8f0;color:#475569;padding:2px 8px;border-radius:20px;">${escapeHtml(t)}</span>`).join("")}
        </div>
        <div style="font-size:12px;line-height:1.6;color:#475569;margin-top:6px;">
          ${bullets.map(b => `<div style="margin:0 0 2px;">• ${escapeHtml(b)}</div>`).join("")}
        </div>
        ${p.mnemonic ? `<div style="margin-top:8px;background:#fef3c7;border-left:3px solid #d97706;padding:8px 10px;border-radius:8px;font-size:12px;color:#475569;"><b style="color:#d97706;">🧠 Mnemonic:</b> ${mdInline(p.mnemonic)}</div>` : ""}
      </div>`;
  };
  // ---- render the group tree (topic -> subtopic -> aspect) like the site ----
  const renderTree = (node, depth) => {
    let html = "";
    if (node.name) {
      if (depth === 1) {
        html += `<div style="font-size:16px;font-weight:800;color:#0f766e;margin:14px 0 8px;">${escapeHtml(node.name)} <span style="color:#94a3b8;font-weight:400;font-size:12px;">(${countTreePoints(node)})</span></div>`;
      } else if (depth === 2) {
        html += `<div style="font-size:14px;font-weight:700;color:#0f172a;margin:12px 0 6px;padding-left:10px;border-left:3px solid #0d9488;">${escapeHtml(node.name)}</div>`;
      } else {
        html += `<div style="font-size:12.5px;font-weight:600;color:#475569;margin:9px 0 4px;padding-left:10px;">${escapeHtml(node.name)}</div>`;
      }
    }
    if ((node.points || []).length) {
      html += `<div style="padding-left:${depth ? 10 : 0}px;">${node.points.map(pointCard).join("")}</div>`;
    }
    (node.children || []).forEach((child) => { html += renderTree(child, depth + 1); });
    return html;
  };
  const pointHtml = points.length ? renderTree(buildPointTree(points), 0) : "";

  const questions = (quiz && quiz.questions) || [];
  const quizHtml = questions.map((q, i) => {
    const opts = (q.options || []).map((o, j) => {
      const right = j === q.answer;
      return `<div style="font-size:12px;line-height:1.5;color:${right ? "#16a34a" : "#475569"};font-weight:${right ? "700" : "400"};">${String.fromCharCode(65 + j)}) ${mdInline(o)}${right ? "  ✓" : ""}</div>`;
    }).join("");
    return `
      <div style="border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;margin:0 0 10px;page-break-inside:avoid;">
        <div style="font-size:13px;font-weight:700;color:#0f172a;">Q${i + 1}. ${mdInline(q.question || "")}</div>
        <div style="margin-top:6px;">${opts}</div>
        ${q.explanation ? `<div style="margin-top:6px;font-size:11px;color:#16a34a;"><b>Answer:</b> ${mdInline(q.explanation)}</div>` : ""}
      </div>`;
  }).join("");

  c.innerHTML = `
    <div style="border-bottom:3px solid #0d9488;padding-bottom:12px;margin-bottom:16px;">
      <div style="font-size:22px;font-weight:800;color:#0f766e;">${escapeHtml(lesson.title || "Lesson")}</div>
      <div style="font-size:12px;color:#94a3b8;margin-top:4px;">${lesson.kind ? lesson.kind.toUpperCase() : ""} · ${lesson.points?.length || 0} points · ${questions.length} questions</div>
    </div>
    <h2 style="font-size:17px;font-weight:800;color:#0d9488;margin:0 0 10px;">📌 Key Points</h2>
    ${points.length ? pointHtml : '<div style="color:#94a3b8;font-size:13px;">No key points generated yet.</div>'}
    <h2 style="font-size:17px;font-weight:800;color:#0d9488;margin:18px 0 10px;">📝 Quiz</h2>
    ${questions.length ? quizHtml : '<div style="color:#94a3b8;font-size:13px;">No quiz generated yet.</div>'}
  `;
  return c;
}

/* Prefer the site-styled (html2pdf) output, but never leave the user with
 * nothing: if the browser PDF fails, fall back to the server-generated PDF. */
async function loadLessonPdf(lessonId) {
  try {
    const pdf = await exportLessonPdf(lessonId);
    if (pdf && pdf.blob) return pdf;
  } catch (e) {
    // fall through to server PDF
  }
  const r = await api.exportFile(lessonId, "pdf");
  if (r.ok) return { blob: r.blob, filename: r.filename };
  throw new Error("PDF 导出失败");
}

/* html2pdf is a ~900 KB bundle that only matters when the user exports a PDF, so
 * index.html no longer loads it up front — that single file used to be ~40% of a
 * first visit's bytes (about 7 s on a 1 Mbps link). Load it on first use and
 * remember the promise so concurrent exports share one fetch. The caller
 * (loadLessonPdf) already falls back to the server-rendered PDF if this fails. */
let html2pdfPromise = null;
function ensureHtml2pdf() {
  if (window.html2pdf) return Promise.resolve();
  if (!html2pdfPromise) {
    html2pdfPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "vendor/html2pdf.bundle.min.js";
      s.onload = () => resolve();
      s.onerror = () => { html2pdfPromise = null; reject(new Error("html2pdf 加载失败")); };
      document.head.appendChild(s);
    });
  }
  return html2pdfPromise;
}

async function exportLessonPdf(lessonId) {
  await ensureHtml2pdf();
  if (!window.html2pdf) throw new Error("html2pdf not loaded");
  const lesson = await getLessonFull(lessonId);
  if (!lesson) throw new Error("Lesson not found");
  const quiz = latestQuiz(await db.getAllByIndex("quizzes", "lessonId", lessonId));
  const base = (lesson.title || "lesson").replace(/[^\w\u4e00-\u9fff-]+/g, "_").replace(/^_+|_+$/g, "") || "lesson";
  const filename = base.slice(0, 60) + ".pdf";
  const container = buildExportContainer(lesson, quiz);
  document.body.appendChild(container);
  try {
    // Let fonts/layout settle before html2canvas snapshots the DOM.
    await new Promise((r) => setTimeout(r, 400));
    const worker = html2pdf()
      .set({
        margin: [8, 8, 8, 8],
        filename,
        image: { type: "jpeg", quality: 0.95 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff", logging: false },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        pagebreak: { mode: ["avoid-all"] },
      })
      .from(container);
    const blob = await worker.outputPdf("blob");
    // A blank html2pdf result is only a few KB (multiple pages usually >10KB).
    // If it's suspiciously tiny, treat as a rendering failure so the caller
    // can fall back to the server-generated PDF.
    if (!blob || blob.size < 5120) throw new Error("PDF 渲染结果为空");
    return { blob, filename };
  } finally {
    container.remove();
  }
}

async function renderTabBody(lesson, cards, quiz) {
  // Release the cards-browse keyboard handler from the previous tab render.
  if (cardsKbHandler) { document.removeEventListener("keydown", cardsKbHandler); cardsKbHandler = null; }
  // Leaving the quiz tab ends preview mode: otherwise its ←/→ handler would keep
  // firing from another tab and bounce the user back here.
  if (quizPreview && currentTab !== "quiz") {
    quizPreview = null;
    document.removeEventListener("keydown", quizPreviewKeydown);
  }
  // Same for review mode, which binds its own ←/→/Esc handler.
  if (quizReview && currentTab !== "quiz") {
    quizReview = null;
    document.removeEventListener("keydown", quizReviewKeydown);
  }
  const body = $("#tab-body");
  if (currentTab === "points") renderPointsTab(body, lesson);
  else if (currentTab === "cards") renderCardsTab(body, lesson, cards);
  else if (currentTab === "quiz") renderQuizTab(body, lesson, quiz);
  else if (currentTab === "mindmap") renderMindmapTab(body, lesson);
  else if (currentTab === "figures") renderFiguresTab(body, lesson);
  else if (currentTab === "slides") renderSlidesTab(body, lesson);
}

// Reading order for the key-points tab: "topic" (the three-level theme tree) or
// "slide" (flat, in lecture order). A reading preference, so it is remembered.
let pointsOrderMode = (() => {
  try { return localStorage.getItem("mbbs_points_order") === "slide" ? "slide" : "topic"; } catch { return "topic"; }
})();

function renderPointsTab(body, lesson) {
  const points = lesson.points || [];
  if (!points.length) {
    body.innerHTML = emptyState("✨", "No key points yet. Generate them from your slides with AI.",
      `<div style="margin-top:14px"><button class="btn btn-accent btn-lg" id="btn-gen2">✨ Generate study set</button></div>`);
    const b = $("#btn-gen2"); if (b) b.addEventListener("click", () => generateStudySet(currentLessonId));
    return;
  }
  const reviewed = points.filter((p) => p.feynmanStage != null).length;
  const highCount = points.filter((p) => p.importance === "high").length;
  const unmasteredCount = points.filter((p) => !isMastered(p)).length;
  const dueCount = points.filter((p) => isPointDue(p)).length;
  body.innerHTML = `
    <div class="card" style="margin-bottom:16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
      <div style="flex:1;min-width:180px">
        <div style="font-weight:600">🎓 Feynman self-test</div>
        <div class="sub">Explain each point in your own words, then self-rate how well you did. ${reviewed}/${points.length}        ${dueCount} due now.</div>
      </div>
      <button class="btn btn-accent" id="btn-feynman">Start self-test${dueCount ? ` (${dueCount})` : ""}</button>
    </div>
    <div class="kp-filters" id="kp-filters">
      <button class="chip active" data-f="all">全部 (${points.length})</button>
      <button class="chip" data-f="high">🔥 高频 (${highCount})</button>
      <button class="chip" data-f="unmastered">📌 没掌握 (${unmasteredCount})</button>
      <span class="sub" style="margin-left:6px;font-size:12px">顺序</span>
      <button class="chip ${pointsOrderMode === "topic" ? "active" : ""}" data-o="topic" title="按三级主题分组（便于查找，但阅读顺序会跳）">🌳 按主题</button>
      <button class="chip ${pointsOrderMode === "slide" ? "active" : ""}" data-o="slide" title="按讲义页序平铺（顺序和老师讲课一致，每点标注所属主题）">📄 按讲义顺序</button>
      <button class="btn btn-sm btn-ghost" id="btn-expand-all" data-state="collapsed">📂 全部展开</button>
      <button class="btn btn-sm btn-ghost" id="btn-cloze-all" style="margin-left:auto" data-state="shown">🙈 全部遮字</button>
    </div>
    <div id="kp-list"></div>`;
  $("#btn-feynman").addEventListener("click", () => openFeynmanChooser(currentLessonId, points));
  // Global expand/collapse toggle for the collapsible key-point groups.
  const btnExpand = $("#btn-expand-all");
  btnExpand.addEventListener("click", () => {
    const expand = btnExpand.dataset.state !== "expanded";
    document.querySelectorAll("details.kp-group").forEach((d) => { d.open = expand; });
    btnExpand.dataset.state = expand ? "expanded" : "collapsed";
    btnExpand.textContent = expand ? "📂 全部收起" : "📂 全部展开";
  });
  // Global cloze toggle — hide/reveal every visible card's key terms at once.
  const btnAll = $("#btn-cloze-all");
  btnAll.addEventListener("click", () => {
    const hiding = btnAll.dataset.state !== "hidden";
    const list = $("#kp-list");
    list.querySelectorAll("mark.hl").forEach((m) => setCloze(m, hiding));
    list.querySelectorAll(".cloze-btn").forEach((b) => {
      b.dataset.state = hiding ? "hidden" : "shown";
      b.textContent = hiding ? "👁 显示" : "🙈 遮字";
    });
    btnAll.dataset.state = hiding ? "hidden" : "shown";
    btnAll.textContent = hiding ? "👁 全部显示" : "🙈 全部遮字";
  });
  // Cloze: hide/reveal key terms (delegated so it survives re-renders).
  // Must be async: the manual-figure buttons below await their save before re-rendering.
  $("#kp-list").addEventListener("click", async (e) => {
    const enBtn = e.target.closest(".en-btn");
    if (enBtn) {
      const lessonId = currentLessonId;
      getLessonFull(lessonId).then((les) => {
        if (les) flipPointToEnglish(les, Number(enBtn.dataset.idx), enBtn);
      });
      return;
    }
    const snav = e.target.closest(".slide-nav");
    if (snav) { openSlide(snav.dataset.lesson, parseInt(snav.dataset.slide, 10)); return; }
    // Manually inserted figures: add / caption / delete, all on one knowledge point.
    const figAdd = e.target.closest("[data-fig-add]");
    if (figAdd) {
      const ptIdx = Number(figAdd.dataset.pt);
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.style.display = "none";
      document.body.appendChild(input);
      input.addEventListener("change", async () => {
        const file = input.files && input.files[0];
        input.remove();
        if (!file) return;
        figAdd.disabled = true;
        figAdd.textContent = "⏳ 处理中…";
        try {
          const okAdd = await addPointFigure(currentLessonId, ptIdx, file);
          if (!okAdd) { toast("这张图没能读取", "error"); return; }
          const cap = prompt("给这张图写个说明（可留空）：", "");
          if (cap && cap.trim()) {
            const les = fullLessonCache.get(currentLessonId);
            const fig = ((les?.points || [])[ptIdx]?.figures || []).slice(-1)[0];
            if (fig) await setPointFigureCaption(currentLessonId, ptIdx, fig.id, cap);
          }
          toast("已插入图片 ✓（大图已自动压缩）", "success");
          await renderLessonDetail();
        } catch (err) {
          toast("插入失败：" + (err && err.message ? err.message : err), "error");
        } finally {
          figAdd.disabled = false;
          figAdd.textContent = "＋ 插入图片";
        }
      });
      input.click();
      return;
    }
    const figDel = e.target.closest("[data-fig-del]");
    if (figDel) {
      if (!confirm("删除这张手动插入的图？")) return;
      if (await removePointFigure(currentLessonId, Number(figDel.dataset.pt), figDel.dataset.figDel)) {
        toast("已删除", "success");
        await renderLessonDetail();
      }
      return;
    }
    const figCap = e.target.closest("[data-fig-cap]");
    if (figCap) {
      const les = fullLessonCache.get(currentLessonId);
      const fig = (((les?.points || [])[Number(figCap.dataset.pt)] || {}).figures || []).find((f) => f.id === figCap.dataset.figCap);
      const next = prompt("图片说明：", (fig && fig.caption) || "");
      if (next == null) return;
      if (await setPointFigureCaption(currentLessonId, Number(figCap.dataset.pt), figCap.dataset.figCap, next)) {
        await renderLessonDetail();
      }
      return;
    }
    const rbtn = e.target.closest(".recall-btn");
    if (rbtn) {
      // Toggle: start recall, or exit an active one on the same card.
      if (recallState && recallState.active && recallState.card === rbtn.closest(".kp-section")) exitRecall();
      else startPointRecall(rbtn.closest(".kp-section"));
      return;
    }
    // In-recall self-rating buttons. data-got sits on the <button>, not on the
    // .recall-rate wrapper this used to read it from: the wrapper's dataset.got
    // was always undefined, so rateRecall("undefined") never matched got === "0",
    // took the "remembered" branch and *removed* the wrong marker — both buttons
    // painted the term green. (The 1/2 keyboard path passed a real value, which
    // is why it looked like it worked sometimes.)
    const rate = e.target.closest("[data-got]");
    if (rate) { rateRecall(rate.dataset.got); return; }
    const btn = e.target.closest(".cloze-btn");
    if (btn) {
      const card = btn.closest(".kp-section");
      const hiding = btn.dataset.state !== "hidden";
      card.querySelectorAll("mark.hl").forEach((m) => setCloze(m, hiding));
      btn.dataset.state = hiding ? "hidden" : "shown";
      btn.textContent = hiding ? "👁 显示" : "🙈 遮字";
      return;
    }
    const mark = e.target.closest("mark.hl");
    if (mark) setCloze(mark, !mark.classList.contains("cloze-hidden"));
  });
  let filter = "all";
  const renderList = () => {
    const filtered = points.filter((p) => {
      if (filter === "high") return p.importance === "high";
      if (filter === "unmastered") return !isMastered(p);
      return true;
    });
    const list = $("#kp-list");
    if (!filtered.length) {
      list.innerHTML = emptyState(filter === "unmastered" ? "🎉" : "🔍", filter === "unmastered" ? "All points mastered — nice work!" : "No points match this filter.");
    } else if (pointsOrderMode === "slide") {
      // Lecture order: one flat pass over the slides, each point labelled with the
      // theme it belongs to so the grouping is still visible.
      const shown = new Set();
      list.innerHTML = `<div class="card" style="padding:6px 20px 14px">${orderPointsBySlide(filtered).map((p) => {
        const path = categoryPath(p);
        const page = p.slide != null ? `第 ${escapeHtml(String(p.slide))} 页` : "无页码";
        return `<div class="sub" style="font-size:11.5px;margin-top:12px;opacity:.75">📄 ${page}${path.length ? ` · ${path.map(escapeHtml).join(" › ")}` : ""}</div>`
          + pointSection(p, lesson, shown);
      }).join("")}</div>`;
    } else {
      const tree = buildPointTree(filtered);
      list.innerHTML = renderPointTree(tree, lesson, 0, new Set());
    }
    // Apply any saved user crop (show the zoomed region), wire the crop button
    // and the "view full slide" click.
    list.querySelectorAll(".kp-fig").forEach((fig) => {
      const slideIdx = parseInt(fig.dataset.slide, 10);
      const lesson = fullLessonCache.get(currentLessonId);
      const slide = lesson?.slides?.find((s) => Number(s.index) === slideIdx);
      const pageIm = slide?.images?.find((im) => im.kind === "page");
      const full = pageIm?.dataUrl || "";
      const secId = fig.closest(".kp-section")?.id || ""; // remember note section
      const saveCrop = async (bbox) => {
        const l = fullLessonCache.get(currentLessonId);
        const s = l?.slides?.find((x) => Number(x.index) === slideIdx);
        if (l && s) {
          s.figureCrop = bbox;
          l.updatedAt = Date.now();
          await db.put("lessons", l);
          fullLessonCache.set(l.id, l);
          await renderLessonDetail();
          requestAnimationFrame(() => {
            const el = document.getElementById(secId);
            if (el) {
              // Expand any collapsed category group so the point is visible.
              document.querySelectorAll("details.kp-group").forEach((d) => { if (d.contains(el)) d.open = true; });
              el.scrollIntoView({ behavior: "smooth", block: "start" });
              el.classList.add("kp-flash");
              setTimeout(() => el.classList.remove("kp-flash"), 2000);
            }
          });
          toast("配图区域已更新 ✓", "success");
        }
      };
      const cropStr = fig.dataset.crop;
      const crop = cropStr ? cropStr.split(",").map(Number).filter((n) => !isNaN(n)) : null;
      const imgEl = fig.querySelector("img");
      if (imgEl && crop && crop.length === 4 && full) applyFigureCrop(imgEl, full, crop);
      fig.querySelectorAll(".kp-crop-btn").forEach((btn) => btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!full) { toast("该页没有整页图，无法选择区域。", "error"); return; }
        openCropPicker(currentLessonId, slideIdx, full, crop, saveCrop);
      }));
      const mainImg = fig.querySelector(".kp-fig-wrap img, img");
      if (mainImg) mainImg.addEventListener("click", () => {
        // Clicking a figure opens the full slide WITH the crop picker built in,
        // so the user can view the whole slide and draw a box in one place.
        if (full) openCropPicker(currentLessonId, slideIdx, full, crop, saveCrop);
        else openModal(`<h2 style="margin-bottom:12px">Slide ${slideIdx}</h2><img src="${mainImg.src}" style="max-width:100%;max-height:70vh;object-fit:contain;border-radius:10px">`);
      });
    });
  };
  // Two independent chip groups share this bar: data-f picks the filter, data-o
  // picks the reading order. The old handler assigned chip.dataset.f for every chip,
  // which would have set the filter to undefined as soon as an order chip was added.
  const kpFilters = $("#kp-filters");
  const paintChips = () => {
    kpFilters.querySelectorAll(".chip[data-f]").forEach((c) => c.classList.toggle("active", c.dataset.f === filter));
    kpFilters.querySelectorAll(".chip[data-o]").forEach((c) => c.classList.toggle("active", c.dataset.o === pointsOrderMode));
  };
  kpFilters.querySelectorAll(".chip[data-f]").forEach((chip) => chip.addEventListener("click", () => {
    filter = chip.dataset.f;
    paintChips();
    renderList();
  }));
  kpFilters.querySelectorAll(".chip[data-o]").forEach((chip) => chip.addEventListener("click", () => {
    pointsOrderMode = chip.dataset.o === "slide" ? "slide" : "topic";
    try { localStorage.setItem("mbbs_points_order", pointsOrderMode); } catch { /* ignore */ }
    paintChips();
    renderList();
  }));
  paintChips();
  renderList();
}

/* ---------------- Knowledge-point de-duplication ----------------
 * Exact-title matching missed the common failure where the model emits the same
 * point twice with a qualifier ("…（艾林方程）") or a slightly longer wording.
 * Titles are normalised (bracketed add-ons and punctuation removed); when two
 * normalised titles are near-identical the bodies are compared too, so only a
 * real content overlap is dropped.
 */
function normPointTitle(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, "")   // drop parenthetical add-ons
    .replace(/[^\p{L}\p{N}]+/gu, "");             // drop punctuation/space/case
}
function bigramSet(s) {
  const out = new Set();
  const t = String(s || "");
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
function bigramSim(a, b) {
  const A = bigramSet(a), B = bigramSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
function pointBodyKey(p) {
  return normPointTitle(String(p && p.title || "") + String(explanationText(p && p.explanation) || ""));
}
/* Title words that only glue a phrase together — dropping one never loses a fact. */
const POINT_GLUE_WORDS = new Set(("the a an of and or with without in on at to for from by as is are was were be been vs versus " +
  "plus also its their this that these those which when where what how why into than then there use used uses using " +
  "show shows shown based due see overview summary introduction note notes remark remarks aspect aspects detail details " +
  "point points concept concepts definition definitions example examples type types kind kinds form forms part parts " +
  "step steps stage stages").split(" "));
/* The meaningful terms of a point title: latin words of 4+ characters, shorter tokens
   that carry a capital (acronyms: HSC, RAI, D2, CT) and CJK runs. */
function pointContentTerms(title) {
  const out = new Set();
  for (const raw of String(title || "").match(/[A-Za-z][A-Za-z0-9-]*/g) || []) {
    const w = raw.toLowerCase();
    if (POINT_GLUE_WORDS.has(w) || /^[0-9]+$/.test(w)) continue;
    if (w.length >= 4 || (w.length >= 2 && /[A-Z]/.test(raw))) out.add(w);
  }
  for (const run of String(title || "").match(/[\u4e00-\u9fff]{2,}/g) || []) out.add(run);
  return [...out];
}
/* Everything the surviving point says, as a word set plus a punctuation-free string. */
function pointKeepEvidence(p) {
  const text = [String(p && p.title || ""), explanationText(p && p.explanation) || "",
    (p && (p.keyTerms || []).join(" ")) || ""].join(" ");
  const words = new Set((text.match(/[A-Za-z0-9-]+/g) || []).map((w) => w.toLowerCase()));
  const joined = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return { words, joined };
}
/* True when dropping `drop` in favour of `keep` would lose a term: every content
   word of the dropped title has to appear somewhere in the survivor. Without this,
   "Interpreting Pituitary vs Target Hormone Levels: Primary Disorder" folded into
   the Secondary Disorder point (the shared scaffolding satisfied every similarity
   measure while the distinguishing word was absent) — as did vulvar→vaginal and
   aripiprazole→clozapine in the pharmacology decks. */
function pointTermLoss(drop, keep) {
  const { words, joined } = pointKeepEvidence(keep);
  return pointContentTerms(drop && drop.title).filter((t) =>
    /^[a-z0-9-]+$/.test(t) ? !words.has(t) : !joined.includes(t));
}
function dedupePoints(list) {
  const items = (list || [])
    .filter((p) => p && String(p.title || "").trim())
    .map((p) => ({ p, key: normPointTitle(p.title), body: pointBodyKey(p), slide: Number(p.slide) || 0 }))
    .filter((x) => x.key);
  const dropped = new Set();
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (dropped.has(a) || dropped.has(b)) continue;
      // Points filed on pages far apart in the deck are different topics, however
      // similar the wording ("钠钾泵的化学计量" vs "钠钾泵的发现与定义").
      if (a.slide && b.slide && Math.abs(a.slide - b.slide) > 2) continue;
      // Same title once normalised -> keep the first.
      if (a.key === b.key) { dropped.add(b); continue; }
      // Same-length titles that differ in one or two characters are a contrastive
      // pair — Aα vs Aβ fibres, 谷氨酸 vs 赖氨酸, 细胞 vs 细胞器 level — and those are
      // separate points, not duplicates.
      if (a.key.length === b.key.length) {
        let diff = 0;
        for (let k = 0; k < a.key.length; k++) if (a.key[k] !== b.key[k]) diff++;
        if (diff <= 2) continue;
      }
      const [short, long] = a.key.length <= b.key.length ? [a, b] : [b, a];
      const bodySim = bigramSim(a.body, b.body);
      // No merge that would drop a title term the survivor never says.
      const dropsShort = pointTermLoss(short.p, long.p).length === 0;
      const dropsLong = pointTermLoss(long.p, short.p).length === 0;
      // One title extends the other ("…基础化学知识" vs "…基础化学知识与生物有机
      // 分子知识") and the bodies overlap -> keep only the fuller point, since the
      // shorter one is a strict subset of it.
      if (long.key.startsWith(short.key)
        && short.key.length / long.key.length >= 0.5
        && bodySim >= 0.45
        && dropsShort) {
        dropped.add(short);
        continue;
      }
      // The shorter title is contained in the middle of the longer one ("时值" vs
      // "基强度与时值作为兴奋性的数值指标") -> again the short one is a subset.
      if (short.key.length >= 4 && long.key.includes(short.key) && bodySim >= 0.55 && dropsShort) {
        dropped.add(short);
        continue;
      }
      // Near-identical titles AND overlapping bodies -> the later one goes.
      if (bigramSim(a.key, b.key) >= 0.85 && bodySim >= 0.6 && dropsLong) dropped.add(b);
    }
  }
  return items.filter((x) => !dropped.has(x)).map((x) => x.p);
}

function buildPointTree(points) {
  const root = { name: "", children: [], points: [] };
  points.forEach((p) => {
    const rawCat = Array.isArray(p.category) && p.category.length ? p.category : [p.topic || (p.tags && p.tags[0]) || "General"];
    // Smooth the category for display, without modifying the stored point.
    let cat = smoothenCategory(rawCat);
    let node = root;
    for (const raw of cat) {
      const label = String(raw == null ? "" : raw).trim();
      if (!label) continue;
      const key = label.toLowerCase();
      let child = node.children.find((c) => c.key === key);
      if (!child) { child = { name: label, key, children: [], points: [] }; node.children.push(child); }
      node = child;
    }
    node.points.push(p);
  });

  // Order every level by the earliest slide it contains, so the tree follows
  // the same top-to-bottom order as the lecture slides (not the AI's ordering).
  const minSlide = (nd) => {
    let m = Infinity;
    (nd.points || []).forEach((p) => { const s = Number(p.slide); if (s && s > 0 && s < m) m = s; });
    (nd.children || []).forEach((c) => { const s = minSlide(c); if (s < m) m = s; });
    return m;
  };
  const sortBySlide = (nd) => {
    (nd.children || []).forEach(sortBySlide);
    nd.children.sort((a, b) => minSlide(a) - minSlide(b));
  };
  sortBySlide(root);

  return root;
}

// Flat list in lecture order. Grouping points by theme is what makes a long lesson
// navigable, but a themed tree CANNOT also preserve the slide order: a group whose
// points sit on slides 3 and 24 forces the reading order to jump to 24 and back to
// 3. Measured on the real chapters, no choice of group sort key fixes it — sorting
// groups by min / p25 / median / mean / max slide all leave 650+ out-of-order steps,
// against 0 for a plain slide-ordered list. So lecture order is offered as its own
// view instead of being "fixed" by re-tuning the tree.
function orderPointsBySlide(points) {
  return (points || [])
    .map((p, i) => ({ p, i, s: Number(p.slide) || Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => (a.s - b.s) || (a.i - b.i))   // stable; points without a slide last
    .map((x) => x.p);
}

// The category path, for the breadcrumb shown beside a point in lecture order.
function categoryPath(p) {
  const raw = Array.isArray(p && p.category) && p.category.length
    ? p.category
    : (p && p.topic ? [p.topic] : (p && p.tags && p.tags[0] ? [p.tags[0]] : ["General"]));
  return smoothenCategory(raw);
}

// Normalize each point's category so the hierarchy is consistent:
//  - drop generic field labels ("Cardiology", "Pathology"...) from level 1
//  - snap level 1 to the canonical outline topic when the content matches
const GENERIC_L1 = new Set(["cardiology", "pathology", "physiology", "anatomy", "pharmacology", "pathophysiology", "biochemistry", "microbiology", "immunology", "neurology", "general", "introduction", "overview", "basic science", "clinical medicine", "definitions", "background", "histology", "embryology", "genetics", "genomics", "imaging", "radiology", "surgery", "medicine", "clinical sciences", "basic sciences"]);

// Generic "aspect" labels that, when used as the 3rd level, just repeat under
// every topic and make the tree look mechanical. We drop them to 2 levels.
const GENERIC_ASPECT = new Set([
  "definition", "definitions", "treatment", "management", "pathophysiology", "pathogenesis",
  "anatomy", "physiology", "classification", "types", "clinical features", "features",
  "overview", "introduction", "general", "diagnosis", "investigations", "clinical anatomy",
  "structure", "function", "functions", "causes", "etiology", "pathology", "clinical relevance",
  "clinical", "investigation", "diagnosis & management", "diagnosis and management",
]);

const normCat = (s) => String(s || "").trim().toLowerCase();

/* Display-level smoothing of a category array (without rewriting stored data):
 *  - drop a generic top-level label when a more specific one exists
 *  - drop a generic 3rd-level "aspect" so identical labels don't repeat everywhere
 */
function smoothenCategory(cat) {
  let c = Array.isArray(cat) ? cat.map((x) => String(x || "").trim()).filter(Boolean) : [];
  if (!c.length) return ["General"];
  while (c.length > 1 && GENERIC_L1.has(normCat(c[0]))) c = c.slice(1);
  if (c.length >= 3 && GENERIC_ASPECT.has(normCat(c[c.length - 1]))) c = c.slice(0, 2);
  if (c.length >= 2 && normCat(c[0]) === normCat(c[1])) c.splice(1, 1);
  if (!c.length) return ["General"];
  return c;
}

// Order- and filler-insensitive key for a category label: "Chest wall anatomy"
// and "Anatomy of the chest wall" collapse to the SAME key, so the model's
// wording variants get merged into one branch instead of splitting the tree.
const CAT_FILLER = new Set(["of", "the", "and", "in", "to", "a", "an", "for", "on", "with", "at", "by", "from", "its"]);
function catWordKey(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\s]+/g, " ").split(/\s+/)
    .filter((w) => w && !CAT_FILLER.has(w)).sort().join(" ");
}
function catFlat(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeCategories(points, outlineSections) {
  const norm = (s) => String(s || "").trim().toLowerCase();
  const sections = (outlineSections || []).filter((s) => s && s.topic);
  if (!sections.length) return;
  // Canonical skeleton: one entry per outline topic, each with its sub-topics.
  const topics = sections.map((s) => ({
    topic: s.topic,
    key: catWordKey(s.topic),
    flat: catFlat(s.topic),
    subs: (s.subtopics || []).filter(Boolean).map((x) => ({ name: x, key: catWordKey(x), flat: catFlat(x) })),
  }));
  // Match a label to a canonical topic: exact word-set, then whole-word flat
  // containment (both directions) for wording variants like "Thoracic wall".
  const findTopic = (label) => {
    const k = catWordKey(label), f = catFlat(label);
    if (!k) return null;
    for (const t of topics) if (t.key === k) return t;
    if (f.length > 4) {
      for (const t of topics) if (t.flat === f) return t;
      for (const t of topics) {
        if (!t.flat) continue;
        if (t.flat.includes(f) || f.includes(t.flat)) {
          // only accept when the shorter side is a real substring of the longer
          if (Math.min(t.flat.length, f.length) / Math.max(t.flat.length, f.length) > 0.45) return t;
        }
      }
    }
    return null;
  };
  const findSub = (t, label) => {
    const k = catWordKey(label), f = catFlat(label);
    if (!k) return null;
    for (const s of t.subs) if (s.key === k) return s;
    if (f.length > 4) for (const s of t.subs) if (s.flat && (s.flat === f || s.flat.includes(f) || f.includes(s.flat))) return s;
    return null;
  };

  points.forEach((p) => {
    let cat = Array.isArray(p.category) ? p.category.map((x) => String(x || "").trim()).filter(Boolean) : [];
    while (cat.length > 1 && GENERIC_L1.has(norm(cat[0]))) cat = cat.slice(1);
    if (!cat.length) return;

    // 1) Snap level 1 onto a canonical outline topic (merges wording variants).
    let t = findTopic(cat[0]);

    // 2) Level 1 is actually one of the skeleton's sub-topics (the model
    //    promoted it): lift its parent topic to level 1 and keep the specific
    //    label as level 2, so the branch hangs off the right topic.
    if (!t) {
      for (const cand of topics) {
        const s = findSub(cand, cat[0]);
        if (s && !GENERIC_ASPECT.has(norm(s.name)) && catFlat(s.name).length >= 4) {
          t = cand; cat = [cand.topic, s.name, ...cat.slice(1)]; break;
        }
      }
    }

    // 3) Level 1 matches nothing, but level 2 names a topic's sub-topic: the
    //    point was misfiled (e.g. a host-defence point under "Pharyngitis").
    //    Re-file it under that topic and keep the specific sub-topic as level 2.
    if (!t && cat[1]) {
      for (const cand of topics) {
        const s = findSub(cand, cat[1]);
        if (s) { t = cand; cat = [cand.topic, cat[1], ...cat.slice(2)]; break; }
      }
    }

    // 4) Canonicalise level 2 to the topic's own sub-topic wording.
    if (t) {
      cat[0] = t.topic;
      if (cat[1]) { const s = findSub(t, cat[1]); if (s) cat[1] = s.name; }
    }

    if (cat[1] && norm(cat[1]) === norm(cat[0])) cat.splice(1, 1);
    p.category = cat;
  });
}

function countTreePoints(node) {
  let n = (node.points || []).length;
  (node.children || []).forEach((c) => (n += countTreePoints(c)));
  return n;
}

// `path` is the chain of group names down to this node, written onto the element
// as data-gkey. The category names are stable, so a saved reading position can
// reopen exactly the groups the reader had expanded (see applyReadPos).
function renderPointTree(node, lesson, depth, shownSlides, path = "") {
  // Level-1 / 2 / 3 groups are collapsible and hidden by default.
  // Clicking a heading expands the level below it.
  const hasChildren = (node.children || []).length > 0;
  const hasPoints = (node.points || []).length > 0;
  const here = node.name ? (path ? path + "\u0001" + node.name : node.name) : path;
  const childrenHtml = hasChildren
    ? node.children.map((c) => renderPointTree(c, lesson, depth + 1, shownSlides, here)).join("")
    : "";
  const pointsHtml = hasPoints
    ? `<div class="card" style="padding:6px 20px 14px;margin-top:6px">${node.points.map((p) => pointSection(p, lesson, shownSlides)).join("")}</div>`
    : "";

  if (depth >= 1 && depth <= 3 && (hasChildren || hasPoints)) {
    const levelClass = depth === 1 ? "tree-l1" : depth === 2 ? "tree-l2" : "tree-l3";
    // A 3rd-level group with exactly one point opens by default.
    const autoOpen = depth === 3 && !hasChildren && node.points && node.points.length === 1;
    const openAttr = autoOpen ? " open" : "";
    return `<details class="kp-group" data-gkey="${escapeHtml(here)}"${openAttr}>
      <summary class="${levelClass} kp-summary">${depth === 1 ? "" : `<span class="kp-arrow">▸</span> `}${escapeHtml(node.name)}${depth === 1 ? ` <span class="sub">(${countTreePoints(node)})</span>` : ""}</summary>
      ${pointsHtml}${childrenHtml}
    </details>`;
  }

  let html = "";
  if (node.name) html += `<div class="tree-l3">${escapeHtml(node.name)}</div>`;
  return html + pointsHtml + childrenHtml;
}

/* ---------------- Per-point English view ----------------
 * Flip a single knowledge point to English on demand — handy when the exam or
 * the textbook is in English but the notes are Chinese. The translation is
 * cached on the point (`p.en`) and saved with the lesson, so switching back and
 * forth costs nothing after the first call. `enViewState` is session-only: a
 * refresh starts in Chinese again.
 */
const enViewState = new Map(); // "lessonId:pointIndex" -> showing English?
const enKey = (lessonId, idx) => `${lessonId}:${idx}`;

// Remember which points you flipped to English, per lesson, so a refresh (or
// coming back later) does not silently revert them. Kept in localStorage rather
// than the lesson record: it is a reading preference, not study data.
function loadEnView(lessonId) {
  try {
    const raw = localStorage.getItem("mbbs_en_view_" + lessonId);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) arr.forEach((i) => enViewState.set(enKey(lessonId, Number(i)), true));
  } catch { /* ignore */ }
}

function saveEnView(lessonId) {
  try {
    const ids = [];
    enViewState.forEach((on, k) => {
      if (!on) return;
      const cut = k.lastIndexOf(":");
      if (k.slice(0, cut) === lessonId) ids.push(Number(k.slice(cut + 1)));
    });
    localStorage.setItem("mbbs_en_view_" + lessonId, JSON.stringify(ids));
  } catch { /* ignore */ }
}

// Flip every point of a lesson to one language at once.
async function setAllPointsLanguage(lesson, toEnglish) {
  if (!toEnglish) {
    (lesson.points || []).forEach((_, i) => enViewState.set(enKey(lesson.id, i), false));
    saveEnView(lesson.id);
    renderLessonDetail();
    toast("已全部切回中文 ✓", "success");
    return;
  }
  const pending = (lesson.points || []).map((p, i) => ({ p, i })).filter((x) => !(x.p.en && x.p.en.title));
  if (!pending.length) {
    (lesson.points || []).forEach((_, i) => enViewState.set(enKey(lesson.id, i), true));
    saveEnView(lesson.id);
    renderLessonDetail();
    toast("已全部切换为英文 ✓", "success");
    return;
  }
  if (!(await requireTextKey())) return;
  const est = pending.length;
  if (!confirm(`将把 ${est} 个知识点翻译成英文（已翻译的会跳过）。

这会调用 ${est} 次 AI，可能产生费用。继续？`)) return;
  const pm = progressPanel(`全部翻译 · ${est} 个知识点`);
  pm.addStep(`翻译 ${est} 个知识点`);
  pm.setStep(0, "running");
  let done = 0, failed = 0;
  await parallelMap(pending, 4, async (x) => {
    if (pm.isCancelled()) return null;
    const ok = await translatePoint(lesson, x.i);
    if (ok) enViewState.set(enKey(lesson.id, x.i), true); else failed++;
    done++;
    pm.msg(`翻译 ${done}/${est}${failed ? `（${failed} 个失败）` : ""}…`);
    pm.setProgress(done / est);
  });
  if (pm.isCancelled()) { pm.cancelled(); return; }
  await db.put("lessons", lesson);
  fullLessonCache.set(lesson.id, lesson);
  saveEnView(lesson.id);
  pm.setStep(0, failed ? "error" : "done");
  pm.done(`${done - failed}/${est} 已翻译`, "查看课程", () => renderLessonDetail());
  toast(`翻译完成：${done - failed}/${est} ✓`, failed ? "warn" : "success");
  renderLessonDetail();
}

// Repaint ONE point card after a language flip.
//
// Re-rendering the whole lesson (renderLessonDetail) would throw away the scroll
// position and flash the page — the student loses their place every time they
// peek at the English. Only three nodes actually change, so touch only those:
// the subtitle, the body, and the button strip.
function applyPointLanguage(lesson, idx) {
  const card = document.getElementById("kp-" + idx);
  const point = (lesson.points || [])[idx];
  if (!card || !point) return false;
  const showEn = !!(point.en && point.en.title && enViewState.get(enKey(lesson.id, idx)));
  const terms = (point.keyTerms && point.keyTerms.length) ? point.keyTerms : titleWords(point.title);

  const sub = card.querySelector(".kp-subtitle");
  if (sub) sub.innerHTML = mdInline(showEn ? point.en.title : point.title);

  const body = card.querySelector(".kp-body");
  if (body) {
    const text = showEn ? (point.en.explanation || "") : explanationText(point.explanation);
    const supp = showEn ? (point.en.supplement || "") : (point.supplement || "");
    // Chinese gets term highlighting; the English text has no Chinese terms to mark.
    body.innerHTML = (showEn ? mdFull(text) : mdFull(highlightTerms(text, terms)))
      + (supp ? `<div class="kp-supplement"><b>💡 理解:</b> ${escapeHtml(supp)}</div>` : "");
  }

  const enBtn = card.querySelector(".en-btn");
  if (enBtn) {
    enBtn.textContent = "🌐 " + (showEn ? "中文" : "EN");
    enBtn.title = showEn ? "切回中文" : "翻译成英文（首次需调用一次 AI，之后缓存）";
  }

  // "遮字" masks Chinese terms, so it makes no sense in the English view: hide
  // it there, and put it back (in its original slot) when returning to Chinese.
  const strip = card.querySelector(".kp-subhead span:last-child");
  let cloze = card.querySelector(".cloze-btn");
  if (showEn) {
    if (cloze) cloze.style.display = "none";
  } else if (!cloze && terms.length && strip && enBtn) {
    cloze = document.createElement("button");
    cloze.className = "btn btn-sm btn-ghost cloze-btn";
    cloze.dataset.state = "shown";
    cloze.textContent = "🙈 遮字";
    enBtn.insertAdjacentElement("afterend", cloze);
  } else if (cloze) {
    cloze.style.display = "";
  }
  return true;
}

async function flipPointToEnglish(lesson, idx, btn) {
  const point = (lesson.points || [])[idx];
  if (!point) return;
  // Already translated: just toggle, no AI call.
  if (point.en && point.en.title) {
    enViewState.set(enKey(lesson.id, idx), !enViewState.get(enKey(lesson.id, idx)));
    saveEnView(lesson.id);
    // In-place repaint: the page keeps its scroll position.
    if (!applyPointLanguage(lesson, idx)) renderLessonDetail();
    return;
  }
  const restore = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "⏳ 翻译中…"; }
  const ok = await translatePoint(lesson, idx);
  if (btn) { btn.disabled = false; btn.textContent = restore; }
  if (!ok) return;
  enViewState.set(enKey(lesson.id, idx), true);
  saveEnView(lesson.id);
  toast("已切换为英文 ✓", "success");
  if (!applyPointLanguage(lesson, idx)) renderLessonDetail();
}

// Translate one point and store it on the point. Returns true on success.
async function translatePoint(lesson, idx) {
  const point = (lesson.points || [])[idx];
  if (!point) return false;
  const prompt = `Translate this study note into precise academic English for a university student.
Rules: keep every formula as LaTeX wrapped in $...$; keep symbols, units, numbers and gene/protein names exactly as written; keep the bullet structure (lines starting with "- ").
Return JSON: {"title":"...","explanation":"...","supplement":"..." or null}

title: ${point.title}

explanation:
${explanationText(point.explanation)}

supplement: ${point.supplement || "(none)"}`;
  const r = await api.llm(
    [{ role: "system", content: SYS }, { role: "user", content: prompt }],
    { json_mode: true, max_tokens: 2500, slot: "translate", lessonId: lesson.id, lessonTitle: lesson.title }
  );
  if (r && r.error) { toast("翻译失败：" + r.error, "error"); return false; }
  const parsed = parseJSON(r && r.content);
  if (!parsed || !parsed.title) { toast("翻译失败：返回格式异常", "error"); return false; }
  point.en = {
    title: String(parsed.title || "").trim(),
    explanation: String(parsed.explanation || ""),
    supplement: parsed.supplement ? String(parsed.supplement) : "",
    at: Date.now(),
  };
  return true;
}

function pointSection(p, lesson, shownSlides) {
  const imp = p.importance === "high" ? "high" : p.importance === "low" ? "low" : "medium";
  const idx = (lesson?.points || []).indexOf(p);
  const tags = p.tags || [];
  const terms = p.keyTerms?.length ? p.keyTerms : titleWords(p.title);
  const slide = p.slide != null ? (lesson?.slides || []).find((s) => s.index === Number(p.slide)) : null;
  // Figures from the same slide are shown once (on the first point of that slide);
  // later points on the same slide just reference them.
  let figs = [];
  let figNote = "";
  if (slide) {
    if (shownSlides && shownSlides.has(slide.index)) {
      figNote = `<div class="sub" style="margin-top:6px">🖼 配图见本页上方知识点</div>`;
    } else {
      // Default: real embedded figures only (avoid whole-page outline slides).
      // If the user picked a region (figureCrop), show that zoomed region of the
      // full page instead.
      if (slide.figureCrop && (slide.images || []).some((im) => im.kind === "page")) {
        figs = [(slide.images || []).find((im) => im.kind === "page")];
      } else {
        figs = (slide.images || []).filter((im) => im.kind !== "page" && im.kind !== "logo").slice(0, 3);
        // Fallback for decks whose pages are one whole-page image (scanned
        // handouts, image-exported PDFs): there are no separate figures to show,
        // so surface the page itself instead of leaving the point picture-less.
        if (!figs.length) {
          const pageIm = (slide.images || []).find((im) => im.kind === "page" && im.dataUrl);
          if (pageIm) figs = [pageIm];
        }
      }
      if (shownSlides && figs.length) shownSlides.add(slide.index);
    }
  }
  // Manually inserted figures belong to the point itself and always show, so they
  // are kept out of the per-slide dedupe used for the auto-extracted ones.
  const manualFigs = (Array.isArray(p.figures) ? p.figures : []).filter((f) => f && f.dataUrl);
  // English view: on-demand translation cached on the point itself (`p.en`), so
  // flipping back and forth is free after the first translation.
  const showEn = !!(p.en && p.en.title && enViewState.get(enKey(lesson.id, idx)));
  const dispTitle = showEn ? p.en.title : p.title;
  const dispBody = showEn ? (p.en.explanation || "") : explanationText(p.explanation);
  const dispSupp = showEn ? (p.en.supplement || "") : (p.supplement || "");
  return `
    <div class="kp-section" id="kp-${idx}" data-idx="${idx}">
      <div class="kp-subhead">
        <span class="imp imp-${imp}">${imp}</span>
        <span class="kp-subtitle">${mdInline(dispTitle)}</span>
        ${tags.map((t) => `<span class="pill pill-gray">${escapeHtml(t)}</span>`).join("")}
        ${(p.weakTerms || []).length ? `<span class="pill pill-amber" title="回忆时没记住的术语">⚠ 弱项 ${p.weakTerms.length}</span>` : ""}
        ${p.feynmanStage != null ? `<span class="pill ${feynmanPct(p.feynmanStage) >= 67 ? "pill-brand" : feynmanPct(p.feynmanStage) >= 33 ? "pill-amber" : "pill-gray"}" title="Feynman 自测 · 已复习 ${p.feynmanCount || 0} 次 · 上次 ${p.feynmanLast ? fmtDate(p.feynmanLast) : ""}">✓ 已复习 ${feynmanPct(p.feynmanStage)}%</span>` : `<span class="pill pill-gray" title="还没做过 Feynman 自测">○ 未复习</span>`}
        <span style="margin-left:auto;display:flex;gap:6px;align-items:center">
          <button class="btn btn-sm btn-ghost en-btn" data-idx="${idx}" title="${showEn ? "切回中文" : "翻译成英文（首次需调用一次 AI，之后缓存）"}">🌐 ${showEn ? "中文" : "EN"}</button>
          ${p.slide != null ? `<button class="btn btn-sm btn-ghost slide-nav" data-lesson="${lesson.id}" data-slide="${p.slide}" title="跳转到原课件对应页">📄 Slide ${p.slide}</button>` : ""}
          ${terms.length && !showEn ? `<button class="btn btn-sm btn-ghost cloze-btn" data-state="shown">🙈 遮字</button>` : ""}
          ${terms.length ? `<button class="btn btn-sm btn-ghost recall-btn" data-state="idle" title="逐个回想术语：空格揭示 → 自评记住/没记住">🔎 回忆</button>` : ""}
        </span>
      </div>
      <div class="kp-body">${showEn ? mdFull(dispBody) : mdFull(highlightTerms(dispBody, terms))}${dispSupp ? `<div class="kp-supplement"><b>💡 理解:</b> ${escapeHtml(dispSupp)}</div>` : ""}</div>
      ${p.mnemonic ? `<div class="kp-mnemonic"><b>🧠 Mnemonic:</b> ${md(p.mnemonic)}</div>` : ""}
      ${figs.length ? `<div class="kp-figs">${figs.map((im) => `
        <figure class="kp-fig" data-slide="${slide.index}" data-crop="${(slide.figureCrop || []).join(",")}" data-full="${im.dataUrl}">
          <div class="kp-fig-wrap"><img src="${im.dataUrl}" alt="">${slide.figureCrop ? `<span class="kp-crop-badge">✂ 已选区域</span>` : ""}</div>
          <figcaption>${escapeHtml(im.caption?.caption || im.caption?.takeaway || `Slide ${slide.index}`)} <button class="btn btn-sm btn-ghost kp-crop-btn" title="选择/调整配图显示区域">✂ 选区域</button></figcaption>
        </figure>`).join("")}</div>` : ""}
      ${figNote}
      ${manualFiguresHtml(manualFigs, idx)}
    </div>`;
}

// The block for figures the user inserted by hand on this point: the images plus
// caption/delete controls, and the insert button. Always rendered — the insert
// button must be reachable even on a point that has no figure yet.
function manualFiguresHtml(figs, idx) {
  const list = (figs || []).filter((f) => f && f.dataUrl);
  const images = list.map((f) => `
        <figure class="kp-fig kp-fig-manual" data-fig="${escapeHtml(f.id)}" data-full="${f.dataUrl}">
          <div class="kp-fig-wrap"><img src="${f.dataUrl}" alt=""><span class="kp-crop-badge">✋ 手动插入</span></div>
          <figcaption>
            ${f.caption ? escapeHtml(f.caption) : `<span class="sub">${escapeHtml(f.name || "插图")}</span>`}
            <button class="btn btn-sm btn-ghost" data-fig-cap="${escapeHtml(f.id)}" data-pt="${idx}" title="给这张图写个说明">✎ 说明</button>
            <button class="btn btn-sm btn-ghost" data-fig-del="${escapeHtml(f.id)}" data-pt="${idx}" title="删除这张图">🗑 删除</button>
          </figcaption>
        </figure>`).join("");
  return `${list.length ? `<div class="kp-figs">${images}</div>` : ""}
      <div class="kp-fig-add">
        <button class="btn btn-sm btn-ghost" data-fig-add data-pt="${idx}" title="从文件里选一张图，插到这个知识点下面（大图会自动压缩）">＋ 插入图片</button>
      </div>`;
}

function renderCardsTab(body, lesson, cards) {
  if (!cards.length) {
    body.innerHTML = emptyState("🃏", "No flashcards yet.", `<div style="margin-top:14px"><button class="btn btn-accent" id="btn-gen3">✨ Generate study set</button></div>`);
    const b = $("#btn-gen3"); if (b) b.addEventListener("click", () => generateStudySet(currentLessonId));
    return;
  }
  let idx = 0, flipped = false, grading = false;
  const render = () => {
    const card = cards[idx];
    const preview = [0, 1, 2, 3].map((g) => schedule(card, g));
    body.innerHTML = `
      <div class="flashcard-wrap">
        <div class="sub" style="text-align:center;margin-bottom:12px">Card ${idx + 1} / ${cards.length} · 翻牌后评分（同今日学习）</div>
        <div class="flashcard" id="fc">
          <div class="card-label">Question</div>
          <div class="card-text" id="fc-text"></div>
        </div>
        <div id="fc-grades" hidden style="margin-top:14px">
          <div class="review-grade">
            <button class="grade-btn grade-0" data-g="0"><span>Again</span><span class="g-int">${intervalLabel(preview[0].interval)}</span><span class="g-key">1</span></button>
            <button class="grade-btn grade-1" data-g="1"><span>Hard</span><span class="g-int">${intervalLabel(preview[1].interval)}</span><span class="g-key">2</span></button>
            <button class="grade-btn grade-2" data-g="2"><span>Good</span><span class="g-int">${intervalLabel(preview[2].interval)}</span><span class="g-key">3</span></button>
            <button class="grade-btn grade-3" data-g="3"><span>Easy</span><span class="g-int">${intervalLabel(preview[3].interval)}</span><span class="g-key">4</span></button>
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:16px">
          <button class="btn" id="fc-prev">← Prev</button>
          <span class="sub" style="align-self:center">空格 翻牌 · 1-4 评分 · ←→ 切换</span>
          <button class="btn" id="fc-next">Next →</button>
        </div>
      </div>`;
    flipped = false; grading = false;
    const fc = $("#fc"), text = $("#fc-text");
    text.className = "card-text";
    fc.querySelector(".card-label").textContent = "Question";
    text.innerHTML = mdFull(card.front);
    fc.addEventListener("click", () => { if (!flipped) flip(); });
    $("#fc-prev").addEventListener("click", () => { idx = (idx - 1 + cards.length) % cards.length; render(); });
    $("#fc-next").addEventListener("click", () => { idx = (idx + 1) % cards.length; render(); });
    body.querySelectorAll(".grade-btn").forEach((b) => b.addEventListener("click", () => grade(parseInt(b.dataset.g, 10))));
  };
  const flip = () => {
    if (flipped) return;
    flipped = true;
    const fc = $("#fc"), text = $("#fc-text");
    fc.querySelector(".card-label").textContent = "Answer";
    text.className = "card-text answer";
    text.innerHTML = mdFull(cards[idx].back);
    $("#fc-grades").hidden = false;
  };
  const grade = async (g) => {
    if (!flipped || grading) return;
    if (blockTrialWrite()) return;
    grading = true;
    const c = cards[idx];
    const updated = schedule(c, g);
    await db.put("cards", updated);
    cards[idx] = updated;
    grading = false;
    idx = (idx + 1) % cards.length;
    render();
  };
  // Keyboard: Space/Enter flip, 1-4 grade, ArrowLeft/Right switch.
  let kb = (e) => {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); }
    else if (e.key === "1") grade(0); else if (e.key === "2") grade(1); else if (e.key === "3") grade(2); else if (e.key === "4") grade(3);
    else if (e.code === "ArrowLeft") { idx = (idx - 1 + cards.length) % cards.length; render(); }
    else if (e.code === "ArrowRight") { idx = (idx + 1) % cards.length; render(); }
  };
  document.addEventListener("keydown", kb);
  // cleanup on tab change / navigation: store handler to remove later.
  cardsKbHandler = kb;
  render();
}

/* ---------------- Starred quiz questions ----------------
 * Starring saves a SNAPSHOT of the question (text, options, answer, explanation)
 * into its own store instead of setting a flag on the quiz record. A quiz record
 * is replaced wholesale when questions are regenerated, so a flag would silently
 * drop every starred question at the next regenerate — precisely the questions
 * worth keeping. Keeping the snapshot also lets the favourites page render
 * without loading every lesson's question bank.
 */
const FAV_STORE = "quizFavs";

// A question's identity is its text. Two records holding the same question —
// before and after a regenerate — must resolve to the same favourite, and the
// key has to be stable across devices, so it is a hash of lesson + normalised
// text rather than an index into the bank (indices shift on every regenerate).
// Accepts either the question object or its bare text: String(questionObject) is
// "[object Object]", so a caller passing the object where text was expected would
// silently hash the same constant for every question and never match.
function favKey(lessonId, question) {
  const text = question && typeof question === "object" ? question.question : question;
  const raw = `${lessonId || ""}\u0000${String(text || "").replace(/\s+/g, " ").trim().toLowerCase()}`;
  let h = 0x811c9dc5; // FNV-1a, 32-bit
  for (let i = 0; i < raw.length; i++) { h ^= raw.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return "f" + h.toString(16).padStart(8, "0");
}

let favKeys = null;  // Set of favKey()s, or null before the first load
let favItems = [];   // the same favourites as full records (for the ⭐ page)

async function loadFavs(force) {
  if (favKeys && !force) return favKeys;
  const items = await db.getAll(FAV_STORE).catch(() => []);
  favItems = items || [];
  favKeys = new Set(favItems.map((f) => f.id));
  return favKeys;
}

function isFav(lessonId, question) {
  return !!favKeys && favKeys.has(favKey(lessonId, question));
}

async function setFav(lesson, q, on) {
  await loadFavs();
  const id = favKey(lesson.id, q.question);
  if (on) {
    const rec = {
      id, lessonId: lesson.id, lessonTitle: lesson.title || "",
      question: q.question, options: q.options, answer: q.answer,
      explanation: q.explanation || "", slide: q.slide ?? null,
      savedAt: Date.now(),
    };
    await db.put(FAV_STORE, rec);
    favItems = [rec, ...favItems.filter((f) => f.id !== id)];
    favKeys.add(id);
  } else {
    await db.delete(FAV_STORE, id);
    favItems = favItems.filter((f) => f.id !== id);
    favKeys.delete(id);
  }
  const on2 = favItems.length;
  const badge = $("#fav-badge");
  if (badge) { badge.textContent = on2; badge.hidden = on2 === 0; }
  return on;
}

function favButton(i, lessonId, q) {
  const on = isFav(lessonId, q);
  return `<button class="fav-star${on ? " on" : ""}" type="button" data-fav-idx="${i}"
    title="${on ? "取消收藏" : "收藏这道题"}" aria-pressed="${on}">${on ? "★" : "☆"}</button>`;
}

// Stars are re-bound after every render; the question index (not the text) is
// the handle so two identical questions in one bank stay independent buttons.
// stopPropagation keeps the surrounding card's own click (e.g. "open preview")
// from firing when the star is what was clicked.
function bindFavStars(root, lesson, questions) {
  (root || document).querySelectorAll("[data-fav-idx]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const q = questions[Number(btn.dataset.favIdx)];
      if (!q) return;
      const on = !isFav(lesson.id, q);
      btn.disabled = true;
      try {
        await setFav(lesson, q, on);
      } catch (err) {
        btn.disabled = false;
        toast("收藏失败：" + (err.message || err), "error");
        return;
      }
      btn.disabled = false;
      btn.classList.toggle("on", on);
      btn.textContent = on ? "★" : "☆";
      btn.title = on ? "取消收藏" : "收藏这道题";
      btn.setAttribute("aria-pressed", String(on));
      toast(on ? "已收藏 ⭐" : "已取消收藏");
      // Keep the bank's "only starred" filter honest without re-rendering: a
      // re-render would throw away the reader's scroll position in a long bank.
      const fo = document.getElementById("btn-favonly");
      if (fo) {
        const n = questions.filter((x) => isFav(lesson.id, x)).length;
        fo.textContent = `${quizFavOnly ? "★" : "☆"} 只看收藏 (${n})`;
        fo.disabled = n === 0;
      }
      // With "only starred" on, the question just un-starred no longer belongs on
      // screen. Safe to re-render: that filter only exists in the bank view, and
      // starting a quiz clears it.
      if (!on && quizFavOnly) renderLessonDetail();
    });
  });
}

/* Which quiz record belongs to a lesson.
 * A lesson can hold more than one quiz record: regenerating used to insert a new
 * record without removing the old one, and the store returns records in insertion
 * order, so taking [0] showed the OLDEST bank — regeneration looked like it had
 * done nothing. The newest record by createdAt is the bank the user last asked
 * for; records with no createdAt sort last rather than first.
 */
function latestQuiz(recs) {
  const list = (recs || []).filter(Boolean);
  if (list.length <= 1) return list[0] || null;
  return list.reduce((best, r) => ((r.createdAt || 0) >= (best.createdAt || 0) ? r : best));
}

function renderQuizTab(body, lesson, quiz) {
  if (!quiz || !quiz.questions?.length) {
    body.innerHTML = emptyState("📝", "No quiz yet. Generate questions to test yourself.",
      `<div style="margin-top:14px"><button class="btn btn-accent btn-lg" id="btn-gen4">✨ Generate quiz</button></div>`);
    const b = $("#btn-gen4"); if (b) b.addEventListener("click", () => generateStudySet(currentLessonId));
    return;
  }
  // Preview mode takes over the tab (and is cleared when the lesson changes).
  if (quizPreview && quizPreview.lessonId === lesson.id) {
    renderQuizPreview(body, lesson, quiz);
    return;
  }
  if (quizPreview) { quizPreview = null; document.removeEventListener("keydown", quizPreviewKeydown); }
  // Review mode likewise owns the tab while it is open.
  if (quizReview && quizReview.lessonId === lesson.id) {
    renderQuizReview(body, lesson, quiz);
    return;
  }
  if (quizReview) { quizReview = null; document.removeEventListener("keydown", quizReviewKeydown); }
  const lastScore = quiz.score != null ? `${quiz.score}/${quiz.questions.length}` : "—";
  // How much there is to look back at: every question with a recorded answer,
  // counting a retake in flight, so the entry button is not shown when empty.
  const answeredCount = quizAttemptSources(quiz).reduce((n, s) => Math.max(n, quizReviewEntries(quiz, s, "all").length), 0);
  // Starring is a reading choice about THIS bank, so the "only starred" filter
  // lives per lesson and is dropped when another lesson is opened.
  const favCount = quiz.questions.filter((q) => isFav(lesson.id, q)).length;
  const shown = quiz.questions
    .map((q, i) => ({ q, i }))
    .filter((x) => !quizFavOnly || isFav(lesson.id, x.q));
  body.innerHTML = `
    <div class="card" style="margin-bottom:18px;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <div>
        <div class="sub">Last score</div>
        <div style="font-size:26px;font-weight:800">${lastScore}</div>
      </div>
      <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-accent" id="btn-take">▶ Take quiz</button>
        ${answeredCount ? `<button class="btn btn-ghost" id="btn-review" title="逐题回看你的作答：你的答案、正确答案和解析">🕘 回看已答 (${answeredCount})</button>` : ""}
        <button class="btn btn-ghost" id="btn-preview">📖 预览题目</button>
        <button class="btn btn-ghost" id="btn-regenq">↻ Regenerate questions</button>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px">
      <h3 style="margin:0">Question bank (${shown.length})</h3>
      <button class="btn btn-ghost btn-sm" id="btn-favonly" title="只显示我收藏的题目"
        ${favCount ? "" : "disabled"}>${quizFavOnly ? "★" : "☆"} 只看收藏 (${favCount})</button>
    </div>
    ${(quiz.userAnswers || []).some((x) => x != null) ? `<p class="sub" style="margin-bottom:10px">✅/❌ 标出的是你上次答过的题（你的选择 + 解析），展开可复习。</p>` : ""}
    ${quizFavOnly && !shown.length ? `<div class="card" style="padding:14px" class="sub">这个课程的收藏题目已被清空或尚未收藏，点题目右上角 ☆ 即可收藏。</div>` : ""}
    <div class="grid">${shown.map(({ q, i }) => {
      const ua = quiz.userAnswers?.[i];
      const answered = ua != null && ua !== undefined;
      const ok = answered && ua === q.answer;
      return `<div class="card" data-preview-q="${i}" style="cursor:pointer" title="点击预览这道题（一题一屏，可前后翻页）">
        <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:8px">
          <div style="font-weight:600;flex:1;min-width:0">Q${i + 1}. ${mdInline(q.question)} ${answered ? `<span style="font-size:12px">${ok ? "✅" : "❌"}</span>` : ""}</div>
          ${favButton(i, lesson.id, q)}
        </div>
        ${answered ? `<details style="margin-bottom:8px"><summary class="sub" style="cursor:pointer">查看你的答题与解析</summary><div class="q-expl ${ok ? "correct" : "wrong"}" style="margin-top:8px">你的答案：${mdInline(q.options[ua])} · 正确答案：${mdInline(q.options[q.answer])}<br>${mdFull(q.explanation || "")}</div></details>` : ""}
        <ol style="margin:0;padding-left:20px;color:var(--text-2)">${q.options.map((o, j) => `<li style="${j === q.answer ? "color:var(--green);font-weight:600" : ""}${answered && j === ua && ua !== q.answer ? "color:var(--red);font-weight:600" : ""}">${mdInline(o)}${j === q.answer ? " ✓" : ""}${answered && j === ua ? " ← 你的选择" : ""}</li>`).join("")}</ol>
      </div>`;
    }).join("")}</div>
  `;
  $("#btn-take").addEventListener("click", () => startQuiz(currentLessonId));
  $("#btn-preview").addEventListener("click", () => quizPreviewEnter(currentLessonId, 0));
  $("#btn-regenq").addEventListener("click", () => regenerateQuiz(currentLessonId));
  const br = $("#btn-review");
  if (br) br.addEventListener("click", () => quizReviewEnter(currentLessonId));
  const fo = $("#btn-favonly");
  if (fo) fo.addEventListener("click", () => { quizFavOnly = !quizFavOnly; renderLessonDetail(); });
  bindFavStars(body, lesson, quiz.questions);
  // Clicking a question in the bank opens it in the preview, at that question.
  body.querySelectorAll("[data-preview-q]").forEach((el) => el.addEventListener("click", (e) => {
    if (e.target.closest("details, button, a, summary")) return; // let those work normally
    quizPreviewEnter(currentLessonId, Number(el.dataset.previewQ) || 0);
  }));
}

/* ---------------- Quiz preview: one question per screen ----------------
 * A reading mode for the question bank: prev/next (buttons or ←/→), a progress
 * bar, and answers hidden until asked for — so skimming the questions before an
 * attempt does not spoil the self-test.
 */
let quizPreview = null; // { lessonId, idx, show }
let quizFavOnly = false; // question bank filter: show only starred questions

function quizPreviewEnter(lessonId, idx) {
  quizPreview = { lessonId, idx: Math.max(0, idx | 0), show: false };
  document.addEventListener("keydown", quizPreviewKeydown);
  renderLessonDetail();
}

function quizPreviewExit() {
  quizPreview = null;
  document.removeEventListener("keydown", quizPreviewKeydown);
  renderLessonDetail();
}

function quizPreviewMove(delta) {
  if (!quizPreview) return;
  quizPreview.idx = Math.max(0, quizPreview.idx + delta);
  quizPreview.show = false; // each new question starts with the answer hidden
  renderLessonDetail();
  const el = document.getElementById("qv-card");
  if (el) el.scrollIntoView({ block: "nearest" });
}

function quizPreviewToggleAnswer() {
  if (!quizPreview) return;
  quizPreview.show = !quizPreview.show;
  renderLessonDetail();
}

function quizPreviewKeydown(e) {
  if (!quizPreview) return;
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (e.key === "ArrowLeft") { e.preventDefault(); quizPreviewMove(-1); }
  else if (e.key === "ArrowRight") { e.preventDefault(); quizPreviewMove(1); }
  else if (e.key === " " || e.key === "Enter") { e.preventDefault(); quizPreviewToggleAnswer(); }
  else if (e.key === "Escape") { e.preventDefault(); quizPreviewExit(); }
}

function renderQuizPreview(body, lesson, quiz) {
  const qs = quiz.questions || [];
  const i = Math.max(0, Math.min(quizPreview.idx, qs.length - 1));
  quizPreview.idx = i; // clamp when the bank shrank after a regenerate
  const q = qs[i];
  const ua = quiz.userAnswers?.[i];
  const answered = ua != null;
  const pct = Math.round(((i + 1) / qs.length) * 100);
  const nav = (side) => `
    <button class="btn ${side === "next" ? "btn-primary" : "btn-ghost"}" id="qv-${side}"
      ${(side === "prev" ? i === 0 : i === qs.length - 1) ? "disabled" : ""}>
      ${side === "prev" ? "◀ 上一题" : "下一题 ▶"}
    </button>`;
  body.innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <span class="pill pill-brand">📖 预览模式</span>
        <b style="font-size:15px">Q ${i + 1} / ${qs.length}</b>
        ${answered ? `<span class="sub">上次作答：${ua === q.answer ? "✅ 正确" : "❌ 错误"}</span>` : ""}
        <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap">
          ${favButton(i, lesson.id, q)}
          ${nav("prev")}${nav("next")}
          <button class="btn btn-ghost" id="qv-exit">✕ 退出预览</button>
        </div>
      </div>
      <div class="progress-bar" style="height:6px;margin-top:12px"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="sub" style="margin-top:7px;font-size:12px">← → 翻页 · 空格显示/隐藏答案 · Esc 退出</div>
    </div>
    <div class="card" id="qv-card">
      <div style="font-size:16px;font-weight:600;line-height:1.6;margin-bottom:14px">Q${i + 1}. ${mdInline(q.question)}</div>
      <ol style="margin:0;padding-left:22px;line-height:1.9">
        ${(q.options || []).map((o, j) => {
          const isAns = j === q.answer;
          const isPick = answered && j === ua;
          const style = quizPreview.show && isAns ? "color:var(--green);font-weight:700"
            : (isPick && !isAns ? "color:var(--red);font-weight:600" : "");
          const mark = quizPreview.show && isAns ? " ✓" : (isPick ? " ← 你的选择" : "");
          return `<li style="${style}">${mdInline(o)}${mark}</li>`;
        }).join("")}
      </ol>
      <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border)">
        ${quizPreview.show ? `
          <div class="q-expl correct" style="margin-top:0">
            <b>正确答案：${mdInline((q.options || [])[q.answer] || "")}</b><br>
            ${mdFull(q.explanation || "")}
          </div>
          <button class="btn btn-ghost btn-sm" id="qv-hide" style="margin-top:10px">🙈 隐藏答案</button>`
        : `<button class="btn btn-accent" id="qv-show">👁 显示答案与解析</button>
           <span class="sub" style="margin-left:10px">先自己想一想，再看答案</span>`}
      </div>
    </div>
    <div style="display:flex;justify-content:space-between;gap:10px;margin-top:16px">
      ${nav("prev")}
      <button class="btn btn-ghost" id="qv-jump">跳到第…题</button>
      ${nav("next")}
    </div>`;
  $("#qv-prev").addEventListener("click", () => quizPreviewMove(-1));
  $("#qv-next").addEventListener("click", () => quizPreviewMove(1));
  $("#qv-exit").addEventListener("click", quizPreviewExit);
  // The star updates in place. Re-rendering here would be wrong: a re-render
  // starts the question with its answer hidden, throwing away what is on screen
  // while the reader is mid-question.
  bindFavStars(body, lesson, qs);
  const showBtn = $("#qv-show"); if (showBtn) showBtn.addEventListener("click", quizPreviewToggleAnswer);
  const hideBtn = $("#qv-hide"); if (hideBtn) hideBtn.addEventListener("click", quizPreviewToggleAnswer);
  $("#qv-jump").addEventListener("click", () => {
    const raw = prompt(`跳到第几题？（1 – ${qs.length}）`, String(i + 1));
    if (raw == null) return;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return;
    quizPreview.idx = Math.max(1, Math.min(qs.length, n)) - 1;
    quizPreview.show = false;
    renderLessonDetail();
  });
}

/* ---------------- Quiz review: look back at answered questions ----------------
 * One question per screen with the answer already on show, because this is a
 * re-reading mode, not a self-test: the point is to see what you picked, what was
 * right, and why. Filters narrow it to the misses, which is what a re-read is
 * usually for.
 *
 * Answers are kept per attempt. Before this, every attempt overwrote
 * quiz.userAnswers, so starting a retake quietly destroyed the record of the
 * previous one — the exact thing a "look back" feature needs to still exist.
 */
let quizReview = null; // { lessonId, srcKey, filter, idx }
const QUIZ_ATTEMPT_CAP = 10; // attempts kept per quiz; each is one small int array

function quizAttemptScore(answers, questions) {
  return (answers || []).reduce((s, a, i) => s + (a != null && questions[i] && a === questions[i].answer ? 1 : 0), 0);
}

// Every set of answers this quiz can be reviewed from, newest first.
function quizAttemptSources(quiz) {
  const qs = quiz.questions || [];
  const trim = (arr) => (arr || []).slice(0, qs.length);
  const out = [];
  // A retake in flight is worth reviewing too — otherwise its answers would be
  // invisible until the attempt is finished.
  if (quiz.completed === false && (quiz.userAnswers || []).some((x) => x != null)) {
    const answers = trim(quiz.userAnswers);
    out.push({ key: "current", label: "本次（进行中）", note: "还没答完", answers, score: quizAttemptScore(answers, qs), at: quiz.lastTaken || null });
  }
  const hist = Array.isArray(quiz.attempts) ? quiz.attempts : [];
  const past = hist.map((a, k) => {
    const answers = trim(a.answers);
    return {
      key: "a" + k,
      label: `第 ${k + 1} 次`,
      note: a.at ? new Date(a.at).toLocaleString() : "",
      answers,
      score: a.score != null ? a.score : quizAttemptScore(answers, qs),
      at: a.at || null,
    };
  });
  out.push(...past.reverse()); // newest attempt first
  // A quiz finished before attempt history existed: the live answers are all we
  // have, so present them as the single past attempt instead of showing nothing.
  if (!past.length && quiz.completed && (quiz.userAnswers || []).some((x) => x != null)) {
    const answers = trim(quiz.userAnswers);
    out.push({ key: "legacy", label: "上一次作答", note: quiz.lastTaken ? new Date(quiz.lastTaken).toLocaleString() : "", answers, score: quiz.score != null ? quiz.score : quizAttemptScore(answers, qs), at: quiz.lastTaken || null });
  }
  return out;
}

// `host` says where the review is drawn: "lesson" renders it as a takeover of the
// lesson's Quiz tab (reading a past attempt later on), "quiz" renders it inside
// the quiz screen, so a question you just answered can be re-read mid-attempt.
function quizReviewEnter(lessonId, srcKey, filter, host) {
  if (quizPreview) { quizPreview = null; document.removeEventListener("keydown", quizPreviewKeydown); }
  quizReview = { lessonId, srcKey: srcKey || null, filter: filter || "all", idx: 0, host: host === "quiz" ? "quiz" : "lesson" };
  document.addEventListener("keydown", quizReviewKeydown);
  reviewRerender();
}

// A live quiz session is what makes the in-quiz host possible; without one (an
// attempt that has already been finished) fall back to the lesson view.
function quizReviewHost() {
  return quizReview && quizReview.host === "quiz" && quizSession ? "quiz" : "lesson";
}

function reviewRerender() {
  if (!quizReview) return;
  if (quizReviewHost() === "quiz") renderQuizReviewInline();
  else renderLessonDetail();
}

function quizReviewExit() {
  const host = quizReview ? quizReviewHost() : "lesson";
  quizReview = null;
  document.removeEventListener("keydown", quizReviewKeydown);
  if (host === "quiz" && quizSession) renderQuizQuestion();
  else renderLessonDetail();
}

function quizReviewKeydown(e) {
  if (!quizReview) return;
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (e.key === "ArrowLeft") { e.preventDefault(); quizReviewMove(-1); }
  else if (e.key === "ArrowRight") { e.preventDefault(); quizReviewMove(1); }
  else if (e.key === "Escape") { e.preventDefault(); quizReviewExit(); }
}

function quizReviewMove(delta) {
  if (!quizReview) return;
  quizReview.idx = Math.max(0, quizReview.idx + delta);
  reviewRerender();
  const el = document.getElementById("qr-card");
  if (el) el.scrollIntoView({ block: "nearest" });
}

function quizReviewEntries(quiz, src, filter) {
  const rows = (quiz.questions || []).map((q, i) => ({ q, i, ua: src.answers[i] ?? null }));
  if (filter === "wrong") return rows.filter((r) => r.ua != null && r.ua !== r.q.answer);
  if (filter === "right") return rows.filter((r) => r.ua != null && r.ua === r.q.answer);
  if (filter === "todo") return rows.filter((r) => r.ua == null);
  return rows.filter((r) => r.ua != null); // "all" means every answered question
}

function renderQuizReview(body, lesson, quiz) {
  const qs = quiz.questions || [];
  const sources = quizAttemptSources(quiz);
  // Fall back when the stored source is gone (a regenerate replaces the record).
  let src = sources.find((s) => s.key === quizReview.srcKey) || sources[0];
  if (!src) {
    const host = quizReviewHost();
    quizReview = null;
    document.removeEventListener("keydown", quizReviewKeydown);
    if (host === "quiz" && quizSession) renderQuizQuestion();
    else renderQuizTab(body, lesson, quiz);
    return;
  }
  quizReview.srcKey = src.key;

  const counts = {
    all: quizReviewEntries(quiz, src, "all").length,
    wrong: quizReviewEntries(quiz, src, "wrong").length,
    right: quizReviewEntries(quiz, src, "right").length,
    todo: quizReviewEntries(quiz, src, "todo").length,
  };
  const entries = quizReviewEntries(quiz, src, quizReview.filter);
  const answered = counts.all;
  const pctRight = answered ? Math.round((counts.right / answered) * 100) : 0;

  const chips = [
    ["all", `全部已答 (${counts.all})`],
    ["wrong", `✗ 只答错 (${counts.wrong})`],
    ["right", `✓ 只答对 (${counts.right})`],
    ["todo", `未答 (${counts.todo})`],
  ].filter(([k]) => k === "all" || counts[k] > 0 || k === quizReview.filter);

  if (!entries.length) {
    body.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <span class="pill pill-brand">🕘 回看已答</span>
          ${attemptPicker(src, sources)}
          ${chipRow(chips, quizReview.filter)}
          <div style="margin-left:auto"><button class="btn btn-ghost" id="qr-exit">✕ 退出回看</button></div>
        </div>
      </div>
      ${emptyState(quizReview.filter === "todo" ? "✅" : "🕘",
        quizReview.filter === "todo" ? "这次作答没有漏掉的题目。" : "这个筛选下没有题目。",
        `<p class="sub" style="margin-top:10px">换一个筛选条件，或点「▶ Take quiz」先答一次。</p>`)}`;
    $("#qr-exit").addEventListener("click", quizReviewExit);
    bindReviewControls(body);
    return;
  }

  const i = Math.max(0, Math.min(quizReview.idx, entries.length - 1));
  quizReview.idx = i; // clamp when a filter change shortened the list
  const { q, i: qi, ua } = entries[i];
  const ok = ua != null && ua === q.answer;
  const pct = Math.round(((i + 1) / entries.length) * 100);
  const navBtn = (side) => `
    <button class="btn ${side === "next" ? "btn-primary" : "btn-ghost"}" id="qr-${side}"
      ${(side === "prev" ? i === 0 : i === entries.length - 1) ? "disabled" : ""}>
      ${side === "prev" ? "◀ 上一题" : "下一题 ▶"}
    </button>`;

  body.innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <span class="pill pill-brand">🕘 回看已答</span>
        ${attemptPicker(src, sources)}
        <b style="font-size:15px">Q ${qi + 1} · 第 ${i + 1} / ${entries.length} 题</b>
        <span class="sub">${escapeHtml(src.label)}：答对 ${src.score} / ${qs.length} · 正确率 ${pctRight}%</span>
        <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap">
          ${navBtn("prev")}${navBtn("next")}
          <button class="btn btn-ghost" id="qr-exit">✕ 退出回看</button>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">${chipRow(chips, quizReview.filter)}</div>
      <div class="progress-bar" style="height:6px;margin-top:12px"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="sub" style="margin-top:7px;font-size:12px">← → 翻页 · Esc 退出 · 答案已直接显示（回看模式，不是自测）</div>
    </div>
    <div class="card" id="qr-card">
      <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:14px">
        <div style="font-size:16px;font-weight:600;line-height:1.6;flex:1;min-width:0">
          <span class="sub" style="font-size:12px">Q${qi + 1}</span> ${mdInline(q.question)}
        </div>
        ${favButton(qi, lesson.id, q)}
      </div>
      <ol style="margin:0;padding-left:22px;line-height:1.9">
        ${(q.options || []).map((o, j) => {
          const isAns = j === q.answer;
          const isPick = ua != null && j === ua;
          const style = isAns ? "color:var(--green);font-weight:700" : (isPick ? "color:var(--red);font-weight:600" : "");
          const mark = isAns && isPick ? " ✓ ← 你选的（正确）" : isAns ? " ✓ 正确答案" : (isPick ? " ← 你选的" : "");
          return `<li style="${style}">${mdInline(o)}${mark}</li>`;
        }).join("")}
      </ol>
      <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border)">
        ${ua == null
          ? `<div class="q-expl" style="margin-top:0"><b>这次没有作答</b><br>正确答案：${mdInline((q.options || [])[q.answer] || "")}</div>`
          : `<div class="q-expl ${ok ? "correct" : "wrong"}" style="margin-top:0">
               <b>${ok ? "✓ 你答对了" : "✗ 你答错了"}</b> · 你的答案：${mdInline((q.options || [])[ua] || "")} · 正确答案：${mdInline((q.options || [])[q.answer] || "")}
               ${q.explanation ? `<div style="margin-top:10px">${mdFull(q.explanation)}</div>` : ""}
             </div>`}
      </div>
    </div>
    <div style="display:flex;justify-content:space-between;gap:10px;margin-top:16px">
      ${navBtn("prev")}
      ${quizReview.filter === "wrong" && counts.wrong ? `<span class="sub" style="align-self:center">共 ${counts.wrong} 道错题，逐一回看</span>` : ""}
      ${navBtn("next")}
    </div>`;

  $("#qr-prev").addEventListener("click", () => quizReviewMove(-1));
  $("#qr-next").addEventListener("click", () => quizReviewMove(1));
  $("#qr-exit").addEventListener("click", quizReviewExit);
  bindReviewControls(body);
  bindFavStars(body, lesson, qs);
}

// Attempt picker + filter chips are re-rendered on change, which is exactly the
// right trade here: unlike a live quiz, nothing on this screen is transient.
function attemptPicker(src, sources) {
  if (sources.length <= 1) {
    return `<span class="sub" title="${escapeHtml(src.note || "")}">${escapeHtml(src.label)}${src.note ? " · " + escapeHtml(src.note) : ""}</span>`;
  }
  return `<select id="qr-src" class="btn btn-ghost btn-sm" style="padding:6px 8px" title="选择要回看的某次作答">
    ${sources.map((s) => `<option value="${escapeHtml(s.key)}" ${s.key === src.key ? "selected" : ""}>${escapeHtml(s.label)} · ${s.score}分${s.note ? " · " + escapeHtml(s.note) : ""}</option>`).join("")}
  </select>`;
}

function chipRow(chips, active) {
  return chips.map(([k, label]) =>
    `<button class="chip ${k === active ? "active" : ""}" data-qrfilter="${k}">${label}</button>`).join("");
}

function bindReviewControls(root) {
  const sel = (root || document).querySelector("#qr-src");
  if (sel) sel.addEventListener("change", () => {
    quizReview.srcKey = sel.value;
    quizReview.idx = 0;
    reviewRerender();
  });
  (root || document).querySelectorAll("[data-qrfilter]").forEach((b) => b.addEventListener("click", () => {
    if (quizReview.filter === b.dataset.qrfilter) return;
    quizReview.filter = b.dataset.qrfilter;
    quizReview.idx = 0; // a different filter is a different list
    reviewRerender();
  }));
}

// The review, drawn inside the quiz screen. The list itself is the same renderer
// the lesson tab uses; only the frame around it differs, plus the way back to the
// question you were on.
function renderQuizReviewInline() {
  if (!quizSession) { quizReview = null; renderLessonDetail(); return; }
  const { quiz, lesson, pos } = quizSession;
  $("#view").innerHTML = `
    <div class="page-head">
      <div class="title-wrap"><h1>Quiz · 回看已答</h1>
        <p class="sub">这是本次作答的记录，答案已直接显示；回看不会改变你的作答。</p></div>
      <button class="btn btn-primary" id="qr-resume">↩ 回到第 ${pos + 1} 题</button>
    </div>
    <div id="qr-host"></div>`;
  renderQuizReview($("#qr-host"), lesson, quiz);
  const rb = $("#qr-resume");
  if (rb) rb.addEventListener("click", quizReviewExit);
}

function renderMindmapTab(body, lesson) {
  const points = lesson.points || [];
  if (!points.length) { body.innerHTML = emptyState("🧠", "No key points to map yet."); return; }
  // Build the classification tree (same hierarchy used by the points tree),
  // then render it as a proper mind map: course title at the root, categories
  // as branches (collapsible + colour-coded by depth), knowledge points as
  // clickable leaf nodes.
  const tree = buildPointTree(points);
  const impColor = { high: "imp imp-high", medium: "imp imp-medium", low: "imp imp-low" };
  const impShort = { high: "H", medium: "M", low: "L" };

  const leafNode = (p, shown) => {
    const imp = p.importance === "high" ? "high" : p.importance === "low" ? "low" : "medium";
    const title = (p.title || "").replace(/^[^:]*:\s*/, ""); // drop "Pneumonia: " prefix inside a branch
    return `<li class="mm-leaf"><div class="mm-point ${imp}" data-point="${p.title}" title="点击查看该知识点">
      <span class="mm-dot ${imp}"></span><span class="mm-point-title">${mdInline(title)}</span>
      <span class="mm-imp ${imp}">${impShort[imp]}</span></div></li>`;
  };

  const renderNode = (node, depth) => {
    const levelClass = depth === 1 ? "mm-l1" : depth === 2 ? "mm-l2" : "mm-l3";
    const childHtml = (node.children || []).map((c) => renderNode(c, depth + 1)).join("");
    const leafHtml = (node.points || []).map((p) => leafNode(p)).join("");
    const count = countTreePoints(node);
    const open = depth <= 2 ? " open" : ""; // open top branches by default
    if ((node.children || []).length === 0) {
      // leaf branch: just show its points
      return `${leafHtml}`;
    }
    return `<li class="mm-branch ${levelClass}"><details class="mm-details"${open}>
      <summary class="mm-summary"><span class="mm-arrow">▸</span>${escapeHtml(node.name)}<span class="mm-count">${count}</span></summary>
      <ul class="mm-children">${leafHtml}${childHtml}</ul>
    </details></li>`;
  };

  let branchHtml = "";
  if (tree.points.length) branchHtml += `<ul class="mm-children mm-root-pts">${tree.points.map(leafNode).join("")}</ul>`;
  if (tree.children.length) branchHtml += `<ul class="mm-children">${tree.children.map((c) => renderNode(c, 1)).join("")}</ul>`;

  body.innerHTML = `<div class="mindmap2">
    <div class="mm-root"><span class="mm-root-ico">🧠</span><span class="mm-root-title">${escapeHtml(lesson.title)}</span><span class="mm-root-sub">${points.length} 个知识点</span></div>
    ${branchHtml}
  </div>`;
  body.querySelectorAll(".mm-point").forEach((el) => el.addEventListener("click", () => {
    const title = el.dataset.point;
    const idx = points.findIndex((p) => p.title === title);
    if (idx >= 0) openPoint(lesson.id, idx);
  }));
}

function renderSlidesTab(body, lesson) {
  body.innerHTML = `<div class="sub" style="margin-bottom:12px">${lesson.slides?.length || 0} slides</div>` +
    (lesson.slides || []).map((s) => `
      <div class="slide-card" id="slide-${s.index}">
        <div class="slide-head"><span class="slide-num">Slide ${s.index}</span>${s.notes ? `<span class="pill pill-amber">notes</span>` : ""}</div>
        ${s.text ? `<div class="slide-text">${escapeHtml(s.text)}</div>` : `<div class="sub">(no text)</div>`}
        ${s.images?.filter((im) => im.kind !== "figure").length ? `<div class="slide-images">${s.images.filter((im) => im.kind !== "figure").map((im) => `
          <figure style="margin:0;max-width:220px">
            <img src="${im.dataUrl}" style="max-height:140px;width:100%;object-fit:contain;border:1px solid var(--border);border-radius:8px">
            ${im.caption ? `<figcaption class="sub" style="font-size:12px;margin-top:4px">${escapeHtml(im.caption.caption || im.caption.takeaway || "")}</figcaption>` : ""}
          </figure>`).join("")}</div>` : ""}
        ${s.notes ? `<div class="slide-notes">🎤 ${escapeHtml(s.notes)}</div>` : ""}
      </div>`).join("");
}

function collectLessonFigures(lesson, limit = 12) {
  const figs = [];
  const seen = new Set();
  (lesson?.slides || []).forEach((s) => (s.images || []).forEach((im) => {
    if (!im || im.kind === "page" || im.kind === "logo" || !im.dataUrl) return;
    if (seen.has(im.dataUrl)) return;
    seen.add(im.dataUrl);
    figs.push({ slide: s.index, im });
  }));
  return figs.slice(0, limit);
}

function collectLessonSlides(lesson, limit = 8) {
  const slides = [];
  const seen = new Set();
  (lesson?.slides || []).forEach((s) => {
    const page = (s.images || []).find((im) => im.kind === "page");
    if (!page || !page.dataUrl) return;
    if (seen.has(page.dataUrl)) return;
    seen.add(page.dataUrl);
    slides.push({ slide: s.index, im: page, text: s.text || "" });
  });
  return slides.slice(0, limit);
}

function collectLessonSlidesForSlide(lesson, slideNum, span = 1) {
  const target = Number(slideNum);
  const targetSet = new Set();
  [-span, 0, span].forEach((d) => { if (target + d >= 1) targetSet.add(target + d); });
  const out = [];
  (lesson?.slides || []).forEach((s) => {
    if (!targetSet.has(Number(s.index))) return;
    const page = (s.images || []).find((im) => im.kind === "page");
    if (!page || !page.dataUrl) return;
    out.push({ slide: s.index, im: page, text: s.text || "" });
  });
  out.sort((a, b) => a.slide - b.slide);
  return out;
}

/* Which key point is this question actually about?
 *
 * Used to give a question its "related slide". Positional matching (question i ↔
 * point i) only holds inside the batch that produced it — once the point list is
 * de-duplicated or re-ordered, every later index shifts and the questions point at
 * the wrong page. Comparing the words of the stem + options against the point's
 * title/explanation survives re-ordering, and returns null when nothing is close,
 * so the caller can fall back instead of inventing a slide.
 */
function matchQuestionToPoint(q, points) {
  if (!q || !Array.isArray(points) || !points.length) return null;
  const qTerms = quizTerms([q.question, ...(q.options || [])].join(" "));
  if (!qTerms.size) return null;
  let best = null, bestScore = 0;
  for (const p of points) {
    if (!p || p.slide == null) continue;
    const pTerms = quizTerms([p.title, explanationText(p.explanation), (p.keyTerms || []).join(" ")].join(" "));
    if (!pTerms.size) continue;
    let common = 0;
    for (const t of qTerms) if (pTerms.has(t)) common++;
    const score = common / Math.sqrt(qTerms.size * pTerms.size);
    // The earliest slide wins ties, so a question spanning two pages still opens
    // the view at the first page that teaches it.
    if (score > bestScore || (score === bestScore && best && Number(p.slide) < Number(best.slide))) {
      best = p; bestScore = score;
    }
  }
  return bestScore >= 0.18 ? best : null;
}

// Word/bigram set used for the comparison above. Latin words plus CJK bigrams and
// trigrams, so Chinese and English material both match without a segmenter.
const QUIZ_TERM_STOP = new Set(["the","and","for","with","that","this","from","are","was","were","its","their","which","into","such","can","not","but","has","have","been","they","these","those","other","than","then","when","where","how","what","why","who","will","would","may","might","each","more","most","some","same","only","also","used","using","use","one","two","three","all","very","often","well","make","made","does","about","over","under","is","of","in","to","a","an","as","at","by","on","or","it","be"]);
function quizTerms(text) {
  const out = new Set();
  const s = String(text || "");
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9-]{2,}/g)) {
    const w = m[0].toLowerCase();
    if (!QUIZ_TERM_STOP.has(w)) out.add(w);
  }
  for (const m of s.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = m[0];
    for (const n of [2, 3]) for (let i = 0; i + n <= run.length; i++) out.add(run.slice(i, i + n));
  }
  return out;
}

function renderFiguresTab(body, lesson) {
  let figs = [];
  (lesson.slides || []).forEach((s) => (s.images || []).filter((im) => im.kind !== "page" && im.kind !== "logo").forEach((im) => figs.push({ slide: s.index, im })));
  // No separate figures? Show the pages themselves (scanned / image-only files).
  let fellBack = false;
  if (!figs.length) {
    (lesson.slides || []).forEach((s) => {
      const im = (s.images || []).find((x) => x.kind === "page" && x.dataUrl);
      if (im) figs.push({ slide: s.index, im });
    });
    fellBack = figs.length > 0;
  }
  if (!figs.length) {
    body.innerHTML = emptyState("🖼", "No figures found in this file.");
    return;
  }
  const uncaptioned = figs.filter((f) => !f.im.caption).length;
  body.innerHTML = `
    <div class="page-head" style="margin-bottom:14px">
      <div class="title-wrap"><h2>Figures & diagrams</h2><p class="sub">${figs.length} ${fellBack ? "page" : "figure"}${figs.length === 1 ? "" : "s"}${fellBack ? "（这份文件每页是整页图片，没有独立插图，所以按页显示）" : (uncaptioned ? ` · ${uncaptioned} not yet captioned` : " · all captioned")}</p></div>
      <button class="btn btn-accent" id="btn-caption">🖼 Caption with vision</button>
    </div>
    <div class="grid grid-2">${figs.map((f) => `
      <div class="card">
        <img src="${f.im.dataUrl}" style="width:100%;max-height:420px;object-fit:contain;background:#f8fafc;border:1px solid var(--border);border-radius:10px;cursor:zoom-in" data-full="${f.im.dataUrl}">
        <div style="margin-top:10px">
          <div class="sub" style="margin-bottom:4px">Slide ${f.slide}${f.im.caption?.type ? ` · <span class="pill pill-gray">${escapeHtml(f.im.caption.type)}</span>` : ""}</div>
          ${f.im.caption ? `
            <div style="font-weight:600">${escapeHtml(f.im.caption.caption || "")}</div>
            <div class="sub" style="margin-top:4px">${escapeHtml(f.im.caption.takeaway || "")}</div>` : `<div class="sub">Not captioned yet.</div>`}
        </div>
      </div>`).join("")}</div>`;
  $("#btn-caption").addEventListener("click", () => captionFigures(currentLessonId));
  body.querySelectorAll("img[data-full]").forEach((img) => img.addEventListener("click", () => {
    openModal(`<h2 style="margin-bottom:12px">Figure</h2><img src="${img.dataset.full}" style="max-width:100%;max-height:70vh;object-fit:contain;border-radius:10px">`);
  }));
}

async function captionFigures(lessonId) {
  const lesson = await db.get("lessons", lessonId);
  const cfg = appConfig || {};
  if (!cfg.has_vision_key) { toast("Add a vision API key in Settings first.", "error"); return; }
  const jobs = [];
  (lesson.slides || []).forEach((s) => (s.images || []).slice(0, 3).forEach((im) => { if (!im.caption) jobs.push(im); }));
  if (!jobs.length) { toast("All figures already captioned."); return; }
  const capped = jobs.slice(0, 24);
  const pm = progressPanel((lesson?.title || "配图") + " · 配图");
  pm.addStep(`Caption ${capped.length} figures with vision`);
  pm.setStep(0, "running");
  let capDone = 0;
  await parallelMap(capped, 8, async (im) => {
    if (pm.isCancelled()) return;
    const r = await api.vision(im.dataUrl, visionPrompt);
      if (r && r.usage) pm.addTokens(r.usage.total_tokens);
    if (!r.error) { const p = parseJSON(r.content); if (p) im.caption = p; }
    capDone++;
    pm.msg(`Analyzing figures ${capDone}/${capped.length}…`);
    pm.setProgress(capDone / capped.length);
  });
  if (pm.isCancelled()) { pm.cancelled(); return; }
  await db.put("lessons", lesson);
  fullLessonCache.set(lesson.id, lesson);
  pm.setStep(0, "done");
  pm.done("Figures captioned", "查看课程", () => renderLessonDetail());
  toast("Figures captioned ✓", "success");
}

/* ---------------- Upload flow ---------------- */
/* ---------------- Upload: multiple files, merge, brief, page range ----------------
 * One lesson often spans several decks/handouts. This collects the picked files
 * first (so the student can add a course title, a free-text brief that the AI
 * treats as scope guidance, and an optional page range), then either merges them
 * into ONE lesson with pages renumbered 1..N, or saves each file on its own.
 */

// Parse a page spec like "3-25, 30, 40–45" into a Set of page numbers.
// Returns null when the spec is empty (meaning: keep every page).
function parsePageRange(spec, maxPage) {
  const text = String(spec || "").trim();
  if (!text) return null;
  const set = new Set();
  for (const part of text.split(/[,，;；\s]+/)) {
    if (!part) continue;
    const m = part.match(/^(\d+)\s*[-–—~至到]\s*(\d+)$/);
    if (m) {
      let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      if (a > b) { const t = a; a = b; b = t; }
      for (let i = Math.max(1, a); i <= b; i++) {
        if (maxPage == null || i <= maxPage) set.add(i);
      }
    } else if (/^\d+$/.test(part)) {
      const n = parseInt(part, 10);
      if (n >= 1 && (maxPage == null || n <= maxPage)) set.add(n);
    }
  }
  return set.size ? set : null;
}

// Concatenate several parsed files into ONE lesson: pages are renumbered 1..N in
// the order the files were listed, and each page remembers where it came from so
// the source deck is still traceable.
function mergeParsedResults(entries) {
  const slides = [];
  let n = 0;
  for (const { res, filename } of entries) {
    for (const sl of (res.slides || [])) {
      n += 1;
      slides.push({ ...sl, index: n, sourceFile: filename, sourceIndex: sl.index });
    }
  }
  return { kind: (entries[0] && entries[0].res && entries[0].res.kind) || "pptx", slides };
}

// Edit a course's own note (and its page-range record) after upload; the brief
// feeds the next generation run as scope guidance.
function openBriefEditor(lesson) {
  openModal(`
    <h2>📝 课程说明</h2>
    <p class="sub" style="margin-bottom:12px">这段说明会交给 AI 作为范围/侧重参考，也会显示在课程页。</p>
    <div class="field"><label>补充说明</label>
      <textarea id="eb-brief" rows="4" placeholder="如：本部分对应教材第3章，重点讲代谢调控" style="width:100%;resize:vertical;font-family:inherit">${escapeHtml(lesson.brief || "")}</textarea></div>
    <div class="field"><label>页码范围（记录用，不会重新过滤已上传的页）</label>
      <input type="text" id="eb-range" value="${escapeHtml(lesson.pageRange || "")}" placeholder="如 3-25" style="width:100%"></div>
    <div style="display:flex;gap:10px;margin-top:14px">
      <button class="btn btn-primary" id="eb-save">💾 保存</button>
      <button class="btn btn-ghost" id="eb-cancel">取消</button>
    </div>`);
  $("#eb-cancel").addEventListener("click", closeModal);
  $("#eb-save").addEventListener("click", async () => {
    lesson.brief = ($("#eb-brief").value || "").trim();
    lesson.pageRange = ($("#eb-range").value || "").trim();
    lesson.updatedAt = Date.now();
    await db.put("lessons", lesson);
    fullLessonCache.set(lesson.id, lesson);
    closeModal();
    toast("说明已保存 ✓", "success");
    renderLessonDetail();
  });
}

// The server's per-request upload cap (a local instance can raise it via
// MAX_UPLOAD_MB). Read once per upload-sheet open so the hint stays truthful.
let _maxUploadMb = 150;
async function refreshUploadLimit() {
  try {
    const r = await fetch("/api/health");
    const d = await r.json();
    if (d && d.max_upload_mb) _maxUploadMb = d.max_upload_mb;
  } catch { /* keep the default */ }
  return _maxUploadMb;
}

async function openUpload() {
  await refreshUploadLimit();
  const remembered = localStorage.getItem("mbbs_up_autogen") !== "0"; // default on
  const picked = []; // File[]
  openModal(`
    <h2>📥 上传课程</h2>
    <p class="sub" style="margin-bottom:14px">支持 <b>.pptx</b> / <b>.pdf</b>，可一次选多个文件。同一节课的多个文件可以<b>合并成一门课</b>。</p>
    <div class="dropzone" id="dz">
      <div class="dz-ico">📥</div>
      <div style="font-weight:600;margin-top:6px">拖拽文件到这里，或点击选择，也可以直接粘贴（⌘V）</div>
      <div class="sub">可多选 · PowerPoint (.pptx) 或 PDF (.pdf) · 也支持粘贴截图 / 文字</div>
      <div class="sub" style="margin-top:4px;font-size:11.5px;opacity:.75">单个文件上限 ${_maxUploadMb} MB · 更大的教科书请先用 <code>split_pdf.py</code> 拆分</div>
      <input type="file" id="dz-input" multiple accept=".pptx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation">
    </div>
    <div id="up-list"></div>
    <div class="field" style="margin-top:12px"><label>课程标题（留空则用第一个文件名）</label>
      <input type="text" id="up-title" placeholder="如：生理学 第3章 代谢" style="width:100%"></div>
    <div class="field"><label>补充说明（可选）</label>
      <textarea id="up-brief" rows="3" placeholder="如：本部分对应教材第3章，重点讲代谢调控；第10-15页是考点" style="width:100%;resize:vertical;font-family:inherit"></textarea>
      <div class="hint">会交给 AI 作为范围/侧重参考，同时显示在课程页。</div></div>
    <div class="field"><label>PDF 压缩（仅 .pdf 生效）</label>
      <select id="up-compress" class="search-select" style="width:100%">
        <option value="high">高压缩 —— 体积最小（约省一半），文字型课件足够清晰</option>
        <option value="medium" selected>标准 —— 推荐</option>
        <option value="low">原画质 —— 图多的课件更清晰，体积约为标准的 2 倍</option>
      </select></div>
    <div class="field"><label>页码范围 / 拆分（可选，仅 .pdf 生效）</label>
      <input type="text" id="up-pages" placeholder="如 3-25, 30 或 1-50, 51-100" style="width:100%">
      <div style="display:flex;gap:16px;margin-top:8px;flex-wrap:wrap">
        <label class="sub" style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="radio" name="up-range-mode" value="slice" checked> 只取这些页（合成一门课）
        </label>
        <label class="sub" style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="radio" name="up-range-mode" value="split"> 按逗号拆成多门课
        </label>
      </div>
      <div class="hint">拆分示例：填 <b>1-50, 51-100, 101-150</b> → 生成 3 门课，各含对应页。<br>合并多个文件时，“只取这些页”按<b>拼接后的连续页码</b>计算。</div></div>
    <div id="up-merge-wrap" class="field" style="display:none">
      <label>多个文件的处理方式</label>
      <label class="sub" style="display:flex;align-items:center;gap:7px;margin-top:7px;cursor:pointer">
        <input type="radio" name="up-merge" value="merge" checked> 合并成一门课（页面按顺序拼接并重新编号）
      </label>
      <label class="sub" style="display:flex;align-items:center;gap:7px;margin-top:5px;cursor:pointer">
        <input type="radio" name="up-merge" value="split"> 每个文件各自成一门课
      </label>
    </div>
    <label style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13.5px;color:var(--text-2);cursor:pointer">
      <input type="checkbox" id="up-auto-gen" ${remembered ? "checked" : ""}> 上传后自动制作笔记（生成知识点/闪卡/题目）
    </label>
    <div style="display:flex;gap:10px;margin-top:16px">
      <button class="btn btn-accent" id="up-go">📥 开始上传</button>
      <button class="btn btn-ghost" id="up-cancel">取消</button>
    </div>
    <div id="up-status" style="margin-top:10px"></div>
  `);

  const dz = $("#dz"), input = $("#dz-input"), dst = $("#up-status");
  const autoBox = $("#up-auto-gen");
  const listEl = $("#up-list"), mergeWrap = $("#up-merge-wrap");

  const renderList = () => {
    if (!picked.length) { listEl.innerHTML = ""; mergeWrap.style.display = "none"; return; }
    mergeWrap.style.display = picked.length > 1 ? "" : "none";
    listEl.innerHTML = `<div class="card" style="padding:8px 12px;margin-top:10px">
      ${picked.map((f, i) => `<div style="display:flex;align-items:center;gap:8px;padding:3px 0">
        <span class="sub" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${i + 1}. ${escapeHtml(f.name)} <span style="opacity:.6">(${(f.size / 1048576).toFixed(1)} MB)</span></span>
        <button class="chip" data-rm="${i}" title="移除" style="padding:2px 8px">✕</button>
      </div>`).join("")}
    </div>`;
    listEl.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", () => {
      picked.splice(Number(b.dataset.rm), 1);
      renderList();
    }));
  };
  const addFiles = (files) => {
    const oversize = [];
    for (const f of files) {
      if (picked.some((x) => x.name === f.name && x.size === f.size)) continue;
      if (f.size > _maxUploadMb * 1048576) { oversize.push(f); continue; }
      picked.push(f);
    }
    renderList();
    if (oversize.length) {
      toast(`${oversize.length} 个文件超过 ${_maxUploadMb} MB 上限：${oversize[0].name}${oversize.length > 1 ? " 等" : ""}。请先用 split_pdf.py 拆分后上传。`, "error");
    }
  };

  if (autoBox) autoBox.addEventListener("change", () => { try { localStorage.setItem("mbbs_up_autogen", autoBox.checked ? "1" : "0"); } catch { /* ignore */ } });
  dz.addEventListener("click", () => input.click());
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("drag"); addFiles([...(e.dataTransfer.files || [])]); });
  input.addEventListener("change", () => { addFiles([...(input.files || [])]); input.value = ""; });

  // ---- Paste support (⌘V) -------------------------------------------------
  // Three things can arrive on the clipboard, and each has a natural home:
  //   files (copied in Finder)  -> the same list as drag & drop
  //   images (a screenshot)     -> its own one-page-per-image lesson
  //   plain text (copied notes) -> the "text lesson" flow, pre-filled
  const onPaste = async (e) => {
    // Self-detach when this sheet is gone (closeModal only clears the DOM).
    if (!document.getElementById("up-go")) { document.removeEventListener("paste", onPaste); return; }
    const dt = e.clipboardData;
    if (!dt) return;
    const files = [...(dt.files || [])];
    const docs = files.filter((f) => /\.(pptx?|pdf)$/i.test(f.name) || /pdf|presentation/i.test(f.type || ""));
    const imgs = files.filter((f) => /^image\//i.test(f.type || ""));
    const text = (dt.getData("text/plain") || "").trim();

    if (docs.length) {
      e.preventDefault();
      addFiles(docs);
      toast(`已粘贴 ${docs.length} 个文件`, "success");
      return;
    }
    if (imgs.length) {
      e.preventDefault();
      const ok = confirm(`检测到 ${imgs.length} 张图片（截图）。\n\n要把它们作为「一页一张图」的课程保存吗？\n（取消则忽略）`);
      if (!ok) return;
      closeModal();
      await saveImageLesson(imgs, { brief: "" });
      return;
    }
    if (text.length >= 20) {
      e.preventDefault();
      const ok = confirm(`检测到粘贴的文字（${text.length} 字）。\n\n要创建为一门「文字课程」吗？`);
      if (!ok) return;
      closeModal();
      openCreateText(text);
    }
  };
  document.addEventListener("paste", onPaste);
  $("#up-cancel").addEventListener("click", closeModal);
  // Uploading a batch of decks takes minutes; without a lock a second click
  // starts a SECOND run over the same files and silently creates duplicates.
  let uploading = false;
  $("#up-go").addEventListener("click", async () => {
    if (uploading) return;
    if (!picked.length) { toast("请先选择文件", "error"); return; }
    uploading = true;
    const btn = $("#up-go");
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "上传中…（请勿重复点击）";
    try {
      await runUpload(picked, {
        dst,
        title: ($("#up-title").value || "").trim(),
        brief: ($("#up-brief").value || "").trim(),
        pages: ($("#up-pages").value || "").trim(),
        merge: (document.querySelector('input[name="up-merge"]:checked') || {}).value !== "split",
        compress: ($("#up-compress") || {}).value || "medium",
        rangeMode: (document.querySelector('input[name="up-range-mode"]:checked') || {}).value || "slice",
        autoGen: autoBox ? autoBox.checked : true,
      });
    } finally {
      uploading = false;
      if (document.body.contains(btn)) { btn.disabled = false; btn.textContent = original; }
    }
  });
}

// Split a spec into its comma-separated segments: "1-50, 51-100" -> ["1-50","51-100"].
function splitRangeSegments(spec) {
  return String(spec || "").split(/[,，;；]+/).map((x) => x.trim()).filter(Boolean);
}

// Parse the picked files, apply the page range / compression settings, then save
// the lessons: one per split segment, one merged lesson, or one per file.
async function runUpload(files, opts) {
  const dst = opts.dst;
  const valid = files.filter((f) => /\.(pptx?|pdf)$/i.test(f.name));
  if (!valid.length) { toast("请选择 .pptx 或 .pdf 文件", "error"); return; }
  const compress = opts.compress || "medium";
  const segments = (opts.rangeMode === "split") ? splitRangeSegments(opts.pages) : [];

  // Guard against accidental re-uploads: warn when a file would produce a
  // course whose title already exists (the usual cause of duplicate courses).
  try {
    const existing = await db.getAllLite("lessons");
    const have = new Set((existing || []).map((l) => String(l.title || "").trim().toLowerCase()));
    const dupes = valid.filter((f) => {
      const guess = (f.name || "").replace(/\.(pptx?|pdf)$/i, "").replace(/[-_]+/g, " ").trim().toLowerCase();
      return guess && have.has(guess);
    });
    if (dupes.length) {
      const names = dupes.slice(0, 5).map((f) => "· " + f.name).join("\n");
      const more = dupes.length > 5 ? `\n…还有 ${dupes.length - 5} 个` : "";
      if (!confirm(`检测到 ${dupes.length} 个文件与已有课程同名：\n\n${names}${more}\n\n继续上传会新建重复的课程。确定继续吗？`)) return;
    }
  } catch { /* duplicate check is best-effort */ }
  const errors = [];
  const savedIds = [];
  const status = [];

  const finish = (extra) => {
    if (extra) status.push(extra);
    errors.forEach((e) => status.push(`❌ ${e}`));
    dst.innerHTML = `<div class="sub">${status.map(escapeHtml).join("<br>")}</div>`;
    closeModal();
    toast(`✅ 上传完成：${savedIds.length} 门课${errors.length ? `，${errors.length} 个失败` : ""}`, errors.length ? "warn" : "success");
    if (opts.autoGen && savedIds.length) {
      toast(`🔄 正在自动制作笔记（${savedIds.length} 门课，依次生成）…`);
      (async () => { for (const id of savedIds) await generateStudySet(id); })();
    } else if (savedIds.length === 1) {
      openLesson(savedIds[0]);
    }
  };

  // ---- Split mode: the comma-separated segments become separate lessons, and
  //      each segment is parsed on its own so the server never renders the
  //      pages that fall outside it. ----
  if (segments.length > 1) {
    const total = valid.length * segments.length;
    let done = 0;
    for (const file of valid) {
      const base = file.name.replace(/\.(pptx?|pdf)$/i, "").replace(/[-_]+/g, " ").trim() || "Lesson";
      for (const seg of segments) {
        done += 1;
        dst.innerHTML = `<div class="loading"><div class="spinner"></div>拆分解析 “${escapeHtml(file.name)}” p.${escapeHtml(seg)} (${done}/${total})…</div>`;
        const res = await api.parseFile(file, { pageRange: seg, compress });
        if (res.error) { errors.push(`${file.name} p.${seg}：${res.error}`); continue; }
        const slides = res.slides || [];
        if (!slides.length) { errors.push(`${file.name} p.${seg}：该范围没有页面`); continue; }
        const id = await saveParsedLesson(res, `${base} p.${seg}`, true, false, {
          title: opts.title ? `${opts.title} · p.${seg}` : `${base} · p.${seg}`,
          brief: opts.brief,
          pageRange: seg,
        });
        if (id) savedIds.push(id);
        status.push(`${base} p.${seg} → ${slides.length} 页`);
      }
    }
    finish(`已按 ${segments.length} 段拆分`);
    return;
  }

  // ---- Normal mode: parse every file first, so the page range can be applied
  //      to the merged numbering and a partial failure doesn't leave a
  //      half-built lesson. ----
  const joinChunks = valid.length > 1 && opts.merge;
  dst.innerHTML = `<div class="loading"><div class="spinner"></div>解析中 0/${valid.length} …</div>`;
  const parsed = [];
  for (let i = 0; i < valid.length; i++) {
    const file = valid[i];
    dst.innerHTML = `<div class="loading"><div class="spinner"></div>解析 “${escapeHtml(file.name)}” (${i + 1}/${valid.length})…</div>`;
    const res = await api.parseFile(file, { compress });
    if (res.error) errors.push(`${file.name}：${res.error}`);
    else parsed.push({ res, filename: file.name });
  }
  if (!parsed.length) {
    dst.innerHTML = `<div class="q-expl wrong">❌ 全部解析失败<br>${errors.map(escapeHtml).join("<br>")}</div>`;
    toast("上传失败", "error");
    return;
  }

  // Slice to the requested page range (null = keep everything).
  let rangeNote = "";
  const applyRange = (slides, maxPage) => {
    const keep = parsePageRange(opts.pages, maxPage);
    if (!keep) return slides;
    return slides.filter((sl) => keep.has(Number(sl.index)));
  };

  if (joinChunks) {
    const merged = mergeParsedResults(parsed);
    const total = merged.slides.length;
    merged.slides = applyRange(merged.slides, total);
    if (!merged.slides.length) {
      dst.innerHTML = `<div class="q-expl wrong">❌ 页码范围过滤后没有剩余页面（共 ${total} 页）</div>`;
      return;
    }
    merged.slides.forEach((sl, i) => { sl.index = i + 1; });
    if (opts.pages) rangeNote = opts.pages;
    const id = await saveParsedLesson(merged, parsed[0].filename, true, false, {
      title: opts.title || parsed[0].filename.replace(/\.(pptx?|pdf)$/i, "").replace(/[-_]+/g, " ").trim(),
      brief: opts.brief,
      pageRange: rangeNote,
      sources: parsed.map((e) => ({ filename: e.filename, kind: e.res.kind, pages: (e.res.slides || []).length })),
    });
    if (id) savedIds.push(id);
    status.push(`合并 ${parsed.length} 个文件 → ${merged.slides.length} 页`);
  } else {
    for (const entry of parsed) {
      const slides = applyRange(entry.res.slides || [], (entry.res.slides || []).length);
      if (!slides.length) { errors.push(`${entry.filename}：页码范围过滤后无剩余页面`); continue; }
      const res = { ...entry.res, slides };
      const id = await saveParsedLesson(res, entry.filename, true, false, {
        title: parsed.length === 1 && opts.title ? opts.title : "",
        brief: opts.brief,
        pageRange: opts.pages || "",
      });
      if (id) savedIds.push(id);
      status.push(`${entry.filename} → ${slides.length} 页`);
    }
  }
  finish();
}

async function handleFile(file) {
  const ok = /\.(pptx?|pdf)$/i.test(file.name);
  if (!ok) { toast("Please choose a .pptx or .pdf file.", "error"); return; }
  $("#up-status").innerHTML = `<div class="loading"><div class="spinner"></div>Parsing “${escapeHtml(file.name)}”…</div>`;
  const res = await api.parseFile(file);
  if (res.error) { $("#up-status").innerHTML = `<div class="q-expl wrong">${escapeHtml(res.error)}</div>`; return; }
  closeModal();
  await saveParsedLesson(res, file.name);
}

async function saveParsedLesson(res, filename, silent = false, autoGen = false, opts = {}) {
  const title = ((opts.title || "").trim()
    || (filename || "lesson").replace(/\.(pptx?|pdf)$/i, "").replace(/[-_]+/g, " ").trim()
    || "Untitled lesson");
  const lesson = {
    id: uid(),
    title,
    filename,
    kind: res.kind || "pptx",
    createdAt: Date.now(),
    slides: res.slides || [],
    points: [],
    quizId: null,
  };
  // Student-supplied context: shown on the lesson page and fed to the AI as
  // scope/emphasis guidance. `sources` records the merged files.
  if (opts.brief) lesson.brief = opts.brief;
  if (opts.pageRange) lesson.pageRange = opts.pageRange;
  if (Array.isArray(opts.sources) && opts.sources.length > 1) lesson.sources = opts.sources;
  await db.put("lessons", lesson);
  fullLessonCache.set(lesson.id, lesson);
  toast("Lesson saved ✓");
  if (autoGen) { generateStudySet(lesson.id); return lesson.id; }  // auto-generate, no modal
  if (silent) return lesson.id; // batch upload: don't pop the "generate?" modal per file
  // Ask whether to generate now
  openModal(`
    <h2>Lesson imported</h2>
    <p>“${escapeHtml(title)}” — ${lesson.slides.length} slides parsed.</p>
    <p class="sub">Next, let AI distill the key points, flashcards, quiz questions and figure captions.</p>
    <div style="display:flex;gap:10px;margin-top:18px">
      <button class="btn btn-accent" id="go-gen">✨ Generate study set</button>
      <button class="btn btn-ghost" id="go-later">Just view slides</button>
    </div>`);
  $("#go-gen").addEventListener("click", () => { closeModal(); generateStudySet(lesson.id); });
  $("#go-later").addEventListener("click", () => { closeModal(); openLesson(lesson.id); });
}

/* ---------------- Create a lesson from typed / pasted text ---------------- */
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ""));
    fr.onerror = () => reject(new Error("读取文件失败"));
    fr.readAsDataURL(file);
  });
}

// Downscale a manually inserted figure before storing it. A phone photo or a
// full-page screenshot is several MB; kept as-is it bloats the lesson record and
// every backup and export. 1600 px on the long edge keeps chart labels and scale
// bars legible while cutting a photo down to a few hundred KB.
async function shrinkImageFile(file, maxPx = 1600, quality = 0.86) {
  const raw = await fileToDataUrl(file);
  if (!/^data:image\//.test(raw)) return raw;
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("图片无法解码"));
      im.src = raw;
    });
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) return raw;
    const scale = Math.min(1, maxPx / Math.max(w, h));
    // Already small and already compressed: keep the original bytes untouched.
    if (scale === 1 && /^data:image\/(jpeg|png|webp)/.test(raw) && raw.length < 400 * 1024) return raw;
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext("2d");
    // White backing: JPEG has no alpha, so a transparent PNG would come out black.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, 0, 0, cw, ch);
    const out = canvas.toDataURL("image/jpeg", quality);
    return out.length < raw.length ? out : raw;
  } catch { return raw; }   // no canvas / decode failure → keep the original bytes
}

// Add a figure to ONE knowledge point. Stored on the point itself rather than on the
// slide, because the point is what the student is reading; the server keeps the
// base64 out of the lesson record (see _strip_lesson_images) so list views stay light.
async function addPointFigure(lessonId, pointIdx, file) {
  const lesson = fullLessonCache.get(lessonId) || await getLessonFull(lessonId);
  const p = lesson && (lesson.points || [])[pointIdx];
  if (!p) return false;
  const dataUrl = await shrinkImageFile(file, 1600, 0.86);
  if (!dataUrl) return false;
  p.figures = Array.isArray(p.figures) ? p.figures : [];
  p.figures.push({
    id: uid(),
    dataUrl,
    name: String(file.name || "插图"),
    mime: file.type || "",
    caption: "",
    addedAt: Date.now(),
  });
  lesson.updatedAt = Date.now();
  await db.put("lessons", lesson);
  fullLessonCache.set(lesson.id, lesson);
  return true;
}

async function removePointFigure(lessonId, pointIdx, figId) {
  const lesson = fullLessonCache.get(lessonId) || await getLessonFull(lessonId);
  const p = lesson && (lesson.points || [])[pointIdx];
  if (!p || !Array.isArray(p.figures)) return false;
  const before = p.figures.length;
  p.figures = p.figures.filter((f) => f.id !== figId);
  if (p.figures.length === before) return false;
  lesson.updatedAt = Date.now();
  await db.put("lessons", lesson);
  fullLessonCache.set(lesson.id, lesson);
  return true;
}

async function setPointFigureCaption(lessonId, pointIdx, figId, caption) {
  const lesson = fullLessonCache.get(lessonId) || await getLessonFull(lessonId);
  const p = lesson && (lesson.points || [])[pointIdx];
  const fig = p && (p.figures || []).find((f) => f.id === figId);
  if (!fig) return false;
  fig.caption = String(caption || "").trim();
  lesson.updatedAt = Date.now();
  await db.put("lessons", lesson);
  fullLessonCache.set(lesson.id, lesson);
  return true;
}

// Turn pasted screenshots into a lesson: one page per image, no server parse —
// the images ARE the pages. Handy for slide screenshots or photographed pages.
async function saveImageLesson(imageFiles, opts = {}) {
  if (!imageFiles || !imageFiles.length) return null;
  // Saving the pages needs no AI key; only the optional auto-generate does.
  if (opts.autoGen && !(await requireTextKey())) return null;
  const pm = progressPanel("粘贴的图片 · 保存课程");
  pm.addStep(`处理 ${imageFiles.length} 张图片`);
  pm.setStep(0, "running");
  const slides = [];
  for (let i = 0; i < imageFiles.length; i++) {
    const f = imageFiles[i];
    let dataUrl = "";
    try { dataUrl = await fileToDataUrl(f); } catch { continue; }
    if (!dataUrl) continue;
    slides.push({
      index: slides.length + 1,
      text: "",
      notes: "",
      images: [{
        name: f.name || `pasted${i + 1}.png`,
        mime: f.type || "image/png",
        dataUrl,
        kind: "page",
      }],
    });
    pm.msg(`处理图片 ${i + 1}/${imageFiles.length}…`);
    pm.setProgress((i + 1) / imageFiles.length);
  }
  if (!slides.length) { pm.fail("没有可用的图片"); toast("图片读取失败", "error"); return null; }
  const stamp = new Date().toLocaleString();
  const id = await saveParsedLesson({ kind: "pdf", slides }, `粘贴的图片 ${stamp}`, true, false, {
    title: opts.title || `粘贴的图片 ${stamp}`,
    brief: opts.brief || "",
  });
  pm.setStep(0, "done");
  pm.done(`${slides.length} 页`, "查看课程", () => openLesson(id));
  if (opts.autoGen) generateStudySet(id);
  else openLesson(id);
  return id;
}

// presetBody: text pasted on the upload sheet, pre-filled here so pasting notes
// goes straight into this flow.
function openCreateText(presetBody = "") {
  const preset = String(presetBody || "");
  // Copied notes usually start with their own heading — offer it as the title.
  const firstLine = preset.split("\n").map((l) => l.trim()).find(Boolean) || "";
  const guessTitle = (firstLine.length >= 2 && firstLine.length <= 60) ? firstLine : "";
  openModal(`
    <h2>✍ New text lesson</h2>
    <p class="sub" style="margin-bottom:14px">Paste or type your own notes, then let AI build key points, flashcards and quiz. Each blank line becomes a separate "slide" (page).</p>
    <div class="field"><label>Title (e.g. “CPR63 Shock — my notes”)</label>
      <input type="text" id="newtext-title" value="${escapeHtml(guessTitle)}" placeholder="e.g. GIS01 Liver anatomy" style="width:100%">
    </div>
    <div class="field"><label>Content</label>
      <textarea id="newtext-body" rows="14" placeholder="Paste your notes here…&#10;&#10;Separate paragraphs with a blank line." style="width:100%;resize:vertical;font-family:inherit">${escapeHtml(preset)}</textarea>
    </div>
    <div style="display:flex;gap:10px;align-items:center;margin-top:4px">
      <button class="btn btn-ghost" id="newtext-import">📄 Import .txt/.md</button>
      <input type="file" id="newtext-file" accept=".txt,.md,text/plain,text/markdown" hidden>
    </div>
    <div style="display:flex;gap:10px;margin-top:16px">
      <button class="btn btn-accent" id="newtext-save">💾 Save lesson</button>
      <button class="btn btn-ghost" id="newtext-cancel">Cancel</button>
    </div>`);
  $("#newtext-file").addEventListener("change", async (e) => {
    const f = (e.target.files || [])[0];
    if (!f) return;
    const text = await f.text();
    if (!$("#newtext-title").value) $("#newtext-title").value = f.name.replace(/\.(txt|md)$/i, "");
    $("#newtext-body").value = ($("#newtext-body").value ? $("#newtext-body").value + "\n\n" : "") + text.trim();
    toast("Imported " + f.name, "success");
  });
  $("#newtext-import").addEventListener("click", () => $("#newtext-file").click());
  $("#newtext-cancel").addEventListener("click", closeModal);
  $("#newtext-save").addEventListener("click", async () => {
    const title = ($("#newtext-title").value || "").trim();
    const body = ($("#newtext-body").value || "").trim();
    if (!title) { toast("Please enter a title.", "error"); return; }
    if (!body) { toast("Please add some content.", "error"); return; }
    // Split on blank lines → one slide per paragraph.
    const slides = body.split(/\n\s*\n/)
      .map((block) => block.trim())
      .filter((b) => b.length > 0)
      .map((block, i) => ({
        index: i + 1,
        text: block.split("\n").map((l) => l.trim()).filter(Boolean).join("\n"),
        notes: "",
        images: [],
      }));
    if (!slides.length) { toast("Content is empty after splitting.", "error"); return; }
    closeModal();
    const lesson = {
      id: uid(),
      title,
      filename: title + ".txt",
      kind: "text",
      createdAt: Date.now(),
      slides,
      points: [],
      quizId: null,
    };
    await db.put("lessons", lesson);
    fullLessonCache.set(lesson.id, lesson);
    toast("Lesson saved ✓");
    openModal(`
      <h2>Lesson created</h2>
      <p>“${escapeHtml(title)}” — ${slides.length} slide${slides.length > 1 ? "s" : ""} from your text.</p>
      <p class="sub">Next, let AI distill the key points, flashcards and quiz questions.</p>
      <div style="display:flex;gap:10px;margin-top:18px">
        <button class="btn btn-accent" id="go-gen">✨ Generate study set</button>
        <button class="btn btn-ghost" id="go-later">Just view slides</button>
      </div>`);
    $("#go-gen").addEventListener("click", () => { closeModal(); generateStudySet(lesson.id); });
    $("#go-later").addEventListener("click", () => { closeModal(); openLesson(lesson.id); });
  });
}

/* ---------------- AI generation pipeline ---------------- */
// One-click: generate a study set for every lesson that has no key points yet.
// Lessons are processed serially so many don't generate concurrently (which
// would overload the AI gateway and freeze the UI).
async function generateAllMissing() {
  const lessons = await db.getAllLite("lessons").catch(() => []);
  const missing = lessons.filter((l) => !(l.points || []).length);
  if (!missing.length) { toast("所有课程都已生成笔记 ✓", "success"); return; }
  if (!confirm(`将依次生成 ${missing.length} 门未生成笔记的课程（知识点/闪卡/题目/配图）。\n按顺序进行，需要较长时间。确定继续？`)) return;
  for (let i = 0; i < missing.length; i++) {
    const l = missing[i];
    toast(`🔄 正在生成第 ${i + 1}/${missing.length} 门：${l.title}`);
    try { await generateStudySet(l.id); } catch { /* keep going */ }
  }
  toast(`✅ 已为 ${missing.length} 门课生成笔记`, "success");
  renderLessons();
}

async function generateStudySet(lessonId, regenerate = false) {
  const lesson = await db.get("lessons", lessonId);
  if (!lesson) return;
  window.__llmCtx = { lessonId: lesson.id, lessonTitle: lesson.title };
  const pm = progressPanel((regenerate ? "重新生成 · " : "") + lesson.title);
  const cfg = appConfig || {};
  if (!cfg.has_text_key) {
    pm.close();
    openModal(`<h2>AI key missing</h2><p>Set your <b>DeepSeek (text)</b> API key to generate notes, flashcards and quizzes. (A vision key is only needed for figure captions and OCR of scanned pages.)</p>
      <div style="margin-top:16px"><button class="btn btn-primary" id="go-settings">Open Settings</button></div>`);
    $("#go-settings").addEventListener("click", () => { closeModal(); navigate("settings"); });
    return;
  }
  const hasVision = !!cfg.has_vision_key;
  let step = 0;

  // Optional step 0 — OCR image-only PDF pages (scanned handouts, no text layer)
  const scanned = (lesson.slides || []).filter(
    (s) => !s.text && (s.images || []).some((im) => im.kind === "page")
  );
  if (scanned.length) {
    if (hasVision) {
      pm.addStep(`OCR ${scanned.length} image-only page${scanned.length > 1 ? "s" : ""} (vision)`);
      pm.setStep(step, "running");
      let ocrDone = 0;
      await parallelMap(scanned, 8, async (s) => {
        if (pm.isCancelled()) return;
        const img = (s.images || []).find((im) => im.kind === "page");
        const r = await api.vision(img.dataUrl, ocrPrompt);
      if (r && r.usage) pm.addTokens(r.usage.total_tokens);
        if (!r.error) { const p = parseJSON(r.content); if (p?.text) s.text = (s.text ? s.text + "\n" : "") + p.text; }
        ocrDone++;
        pm.msg(`Reading pages ${ocrDone}/${scanned.length}…`);
        pm.setProgress((ocrDone / scanned.length) * 0.15);
      });
      pm.setStep(step, "done");
    } else {
      pm.addStep(`${scanned.length} image-only page(s) — skipped (no vision key)`);
      pm.setStep(step, "done");
    }
    step++;
  }

  // Step — figure captions, BEFORE the notes are written.
  // These captions describe what each diagram shows, and a page that is nothing but
  // a diagram has no other text to extract from. Running this first is what lets the
  // extractor see those pages at all (buildSlideBlocks below appends the captions
  // for text-poor slides). It used to run last, purely as a display step, which is
  // why figure-only pages ended up with no knowledge points and therefore no entry
  // in any point-driven view. It is a text model call, so it needs no vision key.
  const slidesWithFigs = (lesson.slides || []).filter((s) => (s.images || []).some((im) => im.kind !== "page" && im.kind !== "logo"));
  if (slidesWithFigs.length) {
    pm.addStep(`Read figures & captions (${slidesWithFigs.length} slides)`);
    pm.setStep(step, "running");
    await attachFigureCaptions(slidesWithFigs, pm, { lo: 0.15, hi: 0.27 });
    pm.setStep(step, "done");
    step++;
    // Persist straight away: these captions cost a model call each, so they must
    // survive a cancelled or failed run rather than being paid for twice.
    await db.put("lessons", lesson);
  }

  // Build slide text AFTER any OCR and captions
  const blocks = buildSlideBlocks(lesson.slides || []);
  const chunks = chunkText(blocks, 2800);

  // Step — analyze lecture structure (so every point uses a consistent hierarchy)
  let outlineText = "";
  let outlineSections = [];
  {
    const summary = (lesson.slides || []).map((s) => {
      const first = (s.text || "").split("\n").map((l) => l.trim()).filter(Boolean)[0] || "";
      return `Slide ${s.index}: ${first.slice(0, 80)}`;
    }).join("\n");
    pm.addStep("Analyze lecture structure");
    pm.setStep(step, "running");
    const or = await api.llm([{ role: "system", content: SYS }, { role: "user", content: outlinePrompt(lesson.title, summary, lesson.brief) }], { json_mode: true, max_tokens: 2000, slot: "outline" });
      if (or && or.usage) pm.addTokens(or.usage.total_tokens);
    if (!or.error) {
      const op = parseJSON(or.content);
      if (op && Array.isArray(op.sections) && op.sections.length) { outlineText = JSON.stringify(op.sections); outlineSections = op.sections; }
    }
    pm.setStep(step, "done");
    step++;
    if (pm.isCancelled()) { pm.cancelled(); return; }
  }

  // Step — extract key points
  pm.addStep(`Extract key points${chunks.length > 1 ? ` (${chunks.length} parts)` : ""}`);
  pm.setStep(step, chunks.length ? "running" : "done");
  let points = lesson.points || [];
  let newPoints = [];
  if (chunks.length) {
    pm.msg(`Analyzing ${chunks.length} part${chunks.length > 1 ? "s" : ""} in parallel…`);
    pm.setProgress(0.27); // give the bar a foot in the door so it doesn't sit at 0
    const results = new Array(chunks.length);
    let idx = 0, doneCnt = 0;
    const workers = Array.from({ length: Math.min(8, chunks.length) }, async () => {
      while (idx < chunks.length) {
        const i = idx++;
        const chunk = chunks[i];
        if (pm.isCancelled()) { results[i] = null; doneCnt++; continue; }
        const r = await api.llm([{ role: "system", content: SYS }, { role: "user", content: pointsPrompt(chunk, outlineText, subjectForLesson(lesson), lesson.brief) }], { json_mode: true, max_tokens: 12000 });
        if (r && r.usage) pm.addTokens(r.usage.total_tokens);
        results[i] = r.error ? { error: r.error } : (parseJSON(r.content)?.points || []);
        doneCnt++;
        pm.setProgress(0.27 + (doneCnt / chunks.length) * 0.28); // 0.27 → 0.55
      }
    });
    await Promise.all(workers);
    for (const res of results) {
      if (!res) continue;
      if (res.error) { pm.setStep(step, "error"); pm.msg("Key points: " + res.error); toast("Points failed: " + res.error, "error"); }
      else newPoints = newPoints.concat(res);
    }
    if (newPoints.length) { points = newPoints; pm.setStep(step, "done"); } else pm.setStep(step, "error");
    pm.setProgress(0.55);
  }
  if (pm.isCancelled()) { pm.cancelled(); return; }
  step++;

  // Step — coverage check (fill any important points the first pass missed)
  // Pages the first pass wrote nothing for. These are the ones that vanish from
  // every point-driven view, and they are almost always the diagram-only pages,
  // so this pass is where their figure captions earn their keep: exactly these
  // slides are sent back, and nothing else.
  //
  // Sending the WHOLE deck here (as this used to do) made the model re-emit every
  // point of the lecture a second time with a slightly longer title — the source
  // of the near-duplicated notes that then show up twice in 按讲义顺序.
  const coveredIdx = new Set(newPoints.map((p) => Number(p.slide)).filter((n) => Number.isFinite(n) && n > 0));
  const uncovered = (lesson.slides || []).filter((s) => !coveredIdx.has(Number(s.index)));
  const covChunks = uncovered.length
    ? chunkText(buildSlideBlocks(uncovered, { captionsFor: new Set(uncovered.map((s) => Number(s.index))) }), 2800)
    : [];
  if (newPoints.length && covChunks.length) {
    pm.addStep("Coverage check — fill gaps");
    pm.setStep(step, "running");
    let titles = newPoints.map((p) => p.title).join(", ");
    let added = 0;
    const gapsNote = uncovered.length
      ? `\nSTILL UNCOVERED — the first pass produced NO point for these slides: ${uncovered.map((s) => s.index).join(", ")}.\nLook at them again here. A slide that is mostly a diagram carries its content in the caption under "what the figure shows" — that text IS the slide's content, so extract from it. Give every new point the number of the slide it came from. Skip a page only if it genuinely teaches nothing (title, outline, agenda, recap, section divider, acknowledgement or reference list).`
      : "";
    pm.msg(`Checking coverage across ${covChunks.length} part${covChunks.length > 1 ? "s" : ""}${uncovered.length ? `, ${uncovered.length} uncovered slide(s)` : ""}…`);
    const results = await parallelMap(covChunks, 8, async (chunk) => {
      if (pm.isCancelled()) return null;
      const r = await api.llm([{ role: "system", content: SYS }, { role: "user", content: coveragePrompt(chunk, titles, outlineText, subjectForLesson(lesson), lesson.brief, gapsNote) }], { json_mode: true, max_tokens: 12000 });
      if (r && r.usage) pm.addTokens(r.usage.total_tokens);
      if (r.error) return { error: r.error };
      const parsed = parseJSON(r.content);
      return parsed && Array.isArray(parsed.points) ? parsed.points : [];
    });
    for (const res of results) {
      if (!res) continue;
      if (res.error) { pm.setStep(step, "error"); toast("Coverage check failed: " + res.error, "error"); }
      else { newPoints = newPoints.concat(res); added += res.length; }
    }
    if (added) pm.msg(`Coverage check added ${added} missing points.`);
    pm.setStep(step, "done");
    pm.setProgress(0.63);
    step++;
  }
  if (pm.isCancelled()) { pm.cancelled(); return; }

  // Normalize hierarchy so related points land in the same groups
  if (newPoints.length) normalizeCategories(newPoints, outlineSections);

  // dedupe (normalised titles + content overlap, see dedupePoints)
  if (newPoints.length) {
    newPoints = dedupePoints(newPoints);
    points = newPoints;
  }

  // Normalize explanations (LLM sometimes returns arrays) so bullet points render correctly
  points.forEach((p) => { if (p) p.explanation = explanationText(p.explanation); });

  if (pm.isCancelled()) { pm.cancelled(); return; }

  // Step — flashcards
  pm.addStep("Generate flashcards");
  let cards = [];
  if (points.length) {
    pm.setStep(step, "running");
    const pchunks = chunkText([pointsToText(points)], 9000);
    pm.msg(`Writing flashcards (${pchunks.length} part${pchunks.length > 1 ? "s" : ""})…`);
    const results = await parallelMap(pchunks, 8, async (pchunk) => {
      if (pm.isCancelled()) return null;
      const r = await api.llm([{ role: "system", content: SYS }, { role: "user", content: cardsPrompt(pchunk, subjectForLesson(lesson)) }], { json_mode: true, max_tokens: 8000 });
      if (r && r.usage) pm.addTokens(r.usage.total_tokens);
      if (r.error) return { error: r.error };
      const parsed = parseJSON(r.content);
      return parsed && Array.isArray(parsed.cards) ? parsed.cards : [];
    });
    for (const res of results) {
      if (!res) continue;
      if (res.error) { pm.setStep(step, "error"); toast("Flashcards failed: " + res.error, "error"); }
      else cards = cards.concat(res.map((c) => newCard({ lessonId, front: c.front, back: c.back })));
    }
    if (cards.length) pm.setStep(step, "done"); else pm.setStep(step, "error");
    pm.setProgress(0.73);
  } else pm.setStep(step, "done");
  if (pm.isCancelled()) { pm.cancelled(); return; }
  step++;

  // Step — quiz
  pm.addStep("Generate quiz questions");
  let quiz = null;
  if (points.length) {
    pm.setStep(step, "running");
    // Cover EVERY knowledge point with at least one question. Split the points
    // into small batches (12 each) and generate one question per point in each
    // batch, in parallel, so large lessons are fully covered without truncation.
    const B = 12;
    const pointBatches = [];
    for (let i = 0; i < points.length; i += B) pointBatches.push(points.slice(i, i + B));
    const qs = [];
    pm.msg(`Writing questions (${pointBatches.length} batches, ${points.length} points)…`);
    const results = await parallelMap(pointBatches, 8, async (batch) => {
      if (pm.isCancelled()) return null;
      const txt = batch.map((p, i) => `${i + 1}. [Slide ${p.slide ?? "?"}] ${p.title}\n   ${explanationText(p.explanation)}`).join("\n");
      const n = batch.length; // one question per point in this batch
      // Ask for this batch's questions, then re-ask for any that came back
      // self-contradictory (two true options, or an explanation that names a
      // different option as correct) — up to two extra attempts.
      let good = [];
      let want = batch;
      for (let attempt = 0; attempt < 3 && want.length; attempt++) {
        if (pm.isCancelled()) return good;
        const askTxt = want.map((p, i) => `${i + 1}. [Slide ${p.slide ?? "?"}] ${p.title}\n   ${explanationText(p.explanation)}`).join("\n");
        const r = await api.llm([{ role: "system", content: SYS }, { role: "user", content: mcqPrompt(askTxt, want.length, subjectForLesson(lesson), attempt > 0) }], { json_mode: true, max_tokens: 12000 });
        if (r && r.usage) pm.addTokens(r.usage.total_tokens);
        if (r.error) return { error: r.error };
        const parsed = parseJSON(r.content);
        const questions = parsed && Array.isArray(parsed.questions) ? parsed.questions : [];
        // 回填来源 slide。Position is only a FALLBACK: the model is asked for the
        // slide on each question, and a positional guess is what mis-tagged a whole
        // bank once the key points were re-ordered/de-duplicated (q i stopped
        // matching point i, so "本题相关 slide" showed unrelated pages). Matching
        // on the point's own title is order-independent.
        questions.forEach((qq, i) => {
          if (!qq || qq.slide != null) return;
          const point = matchQuestionToPoint(qq, want) || want[i];
          if (point && point.slide != null) qq.slide = Number(point.slide);
        });
        const bad = [];
        questions.forEach((qq, i) => {
          if (quizQuestionInvalid(qq)) bad.push(want[i]);
          else good.push(qq);
        });
        if (bad.length) pm.msg(`${bad.length} 道题解析自相矛盾，正在重出…`);
        want = bad;
      }
      return good;
    });
    for (const res of results) {
      if (!res) continue;
      if (res.error) { pm.setStep(step, "error"); toast("Quiz failed: " + res.error, "error"); }
      else qs.push(...res);
    }
    if (qs.length) {
      shuffleQuizOptions(qs);
      quiz = { id: uid(), lessonId, createdAt: Date.now(), questions: qs, userAnswers: [], score: null, completed: false };
      pm.setStep(step, "done");
    } else pm.setStep(step, "error");
    pm.setProgress(0.82);
  } else pm.setStep(step, "done");
  if (pm.isCancelled()) { pm.cancelled(); return; }
  step++;

  if (pm.isCancelled()) { pm.cancelled(); return; }

  // Re-generate: replace old cards/quiz instead of duplicating
  if (regenerate) {
    const [oldCards, oldQuizzes] = await Promise.all([
      db.getAllByIndex("cards", "lessonId", lessonId),
      db.getAllByIndex("quizzes", "lessonId", lessonId),
    ]);
    await Promise.all([...oldCards.map((c) => db.delete("cards", c.id)), ...oldQuizzes.map((q) => db.delete("quizzes", q.id))]);
  }

  // Save
  lesson.points = points;
  // Persist the topic skeleton so the hierarchy can be re-normalised later
  // (and stays stable across devices) without regenerating the lesson.
  if (outlineSections.length) lesson.outline = outlineSections;
  lesson.updatedAt = Date.now();
  await db.put("lessons", lesson);
  if (cards.length) await db.bulkPut("cards", cards);
  if (quiz) {
    await db.put("quizzes", quiz);
    lesson.quizId = quiz.id;
    await db.put("lessons", lesson);
  }
  fullLessonCache.set(lesson.id, lesson);
  const genSummary = `${points.length} points · ${cards.length} cards · ${quiz?.questions.length || 0} questions`;
  // The notes were rebuilt: "kp-42" no longer means the same paragraph, so a saved
  // reading position for this lesson would land on unrelated material.
  readPosForget(lesson.id);
  pm.done(genSummary, "查看课程", () => openLesson(lessonId));
  toast("Study set ready ✓", "success");
  refreshBadges();
}

/* ---------------- Independent single-component generation ---------------- */
async function requireTextKey() {
  if ((appConfig || {}).has_text_key) return true;
  openModal(`<h2>AI key missing</h2><p>Set your <b>DeepSeek (text)</b> API key first.</p>
    <div style="margin-top:16px"><button class="btn btn-primary" id="go-settings">Open Settings</button></div>`);
  $("#go-settings").addEventListener("click", () => { closeModal(); navigate("settings"); });
  return false;
}

async function generatePointsOnly(lessonId) {
  const lesson = await db.get("lessons", lessonId);
  if (!lesson) return;
  window.__llmCtx = { lessonId: lesson.id, lessonTitle: lesson.title };
  if (!(await requireTextKey())) return;
  const cfg = appConfig || {};
  const pm = progressPanel((lesson.title || "知识点") + " · 提炼知识点");
  let step = 0;

  // OCR (optional)
  const scanned = (lesson.slides || []).filter((s) => !s.text && (s.images || []).some((im) => im.kind === "page"));
  if (scanned.length) {
    if (cfg.has_vision_key) {
      pm.addStep(`OCR ${scanned.length} image-only page${scanned.length > 1 ? "s" : ""} (vision)`);
      pm.setStep(step, "running");
      let ocrDone = 0;
      await parallelMap(scanned, 8, async (s) => {
        if (pm.isCancelled()) return;
        const img = (s.images || []).find((im) => im.kind === "page");
        const r = await api.vision(img.dataUrl, ocrPrompt);
      if (r && r.usage) pm.addTokens(r.usage.total_tokens);
        if (!r.error) { const p = parseJSON(r.content); if (p?.text) s.text = (s.text ? s.text + "\n" : "") + p.text; }
        ocrDone++;
        pm.msg(`Reading pages ${ocrDone}/${scanned.length}…`);
        pm.setProgress((ocrDone / scanned.length) * 0.15);
      });
      pm.setStep(step, "done");
    } else {
      pm.addStep(`${scanned.length} image-only page(s) — skipped (no vision key)`);
      pm.setStep(step, "done");
    }
    step++;
  }

  // Figure captions first, for the same reason as in generateStudySet: they are the
  // only content on a diagram-only page, and the extraction below appends them for
  // text-poor slides. Existing captions are reused rather than paid for again.
  const slidesWithFigs = (lesson.slides || []).filter((s) => (s.images || []).some((im) => im.kind !== "page" && im.kind !== "logo"));
  if (slidesWithFigs.length) {
    pm.addStep(`Read figures & captions (${slidesWithFigs.length} slides)`);
    pm.setStep(step, "running");
    await attachFigureCaptions(slidesWithFigs, pm, { lo: 0.15, hi: 0.27 });
    pm.setStep(step, "done");
    step++;
    await db.put("lessons", lesson); // keep the captions even if the run is abandoned
  }

  const blocks = buildSlideBlocks(lesson.slides || []);
  const chunks = chunkText(blocks, 2800);

  let outlineText = "";
  let outlineSections = [];
  {
    const summary = (lesson.slides || []).map((s) => {
      const first = (s.text || "").split("\n").map((l) => l.trim()).filter(Boolean)[0] || "";
      return `Slide ${s.index}: ${first.slice(0, 80)}`;
    }).join("\n");
    pm.addStep("Analyze lecture structure");
    pm.setStep(step, "running");
    const or = await api.llm([{ role: "system", content: SYS }, { role: "user", content: outlinePrompt(lesson.title, summary, lesson.brief) }], { json_mode: true, max_tokens: 2000, slot: "outline" });
      if (or && or.usage) pm.addTokens(or.usage.total_tokens);
    if (!or.error) {
      const op = parseJSON(or.content);
      if (op && Array.isArray(op.sections) && op.sections.length) { outlineText = JSON.stringify(op.sections); outlineSections = op.sections; }
    }
    pm.setStep(step, "done");
    step++;
  }
  if (pm.isCancelled()) { pm.cancelled(); return; }

  pm.addStep(`Extract key points${chunks.length > 1 ? ` (${chunks.length} parts)` : ""}`);
  pm.setStep(step, chunks.length ? "running" : "done");
  let newPoints = [];
  if (chunks.length) {
    pm.msg(`Analyzing ${chunks.length} part${chunks.length > 1 ? "s" : ""} in parallel…`);
    const results = await parallelMap(chunks, 8, async (chunk) => {
      if (pm.isCancelled()) return null;
      const r = await api.llm([{ role: "system", content: SYS }, { role: "user", content: pointsPrompt(chunk, outlineText, subjectForLesson(lesson), lesson.brief) }], { json_mode: true, max_tokens: 12000 });
      if (r && r.usage) pm.addTokens(r.usage.total_tokens);
      if (r.error) return { error: r.error };
      const parsed = parseJSON(r.content);
      return parsed && Array.isArray(parsed.points) ? parsed.points : [];
    });
    for (const res of results) {
      if (!res) continue;
      if (res.error) { pm.setStep(step, "error"); pm.msg("Key points: " + res.error); toast("Points failed: " + res.error, "error"); }
      else newPoints = newPoints.concat(res);
    }
    if (newPoints.length) pm.setStep(step, "done"); else pm.setStep(step, "error");
    pm.setProgress(0.42);
  }
  if (pm.isCancelled()) { pm.cancelled(); return; }
  step++;

  // Same backstop as in generateStudySet: re-send ONLY the slides that produced no
  // point, with their figure captions attached, so a diagram-only page is not left
  // unreachable from the notes. Re-sending the whole deck here duplicated the notes.
  const coveredIdx = new Set(newPoints.map((p) => Number(p.slide)).filter((n) => Number.isFinite(n) && n > 0));
  const uncovered = (lesson.slides || []).filter((s) => !coveredIdx.has(Number(s.index)));
  const covChunks = uncovered.length
    ? chunkText(buildSlideBlocks(uncovered, { captionsFor: new Set(uncovered.map((s) => Number(s.index))) }), 2800)
    : [];
  if (newPoints.length && covChunks.length) {
    pm.addStep("Coverage check — fill gaps");
    pm.setStep(step, "running");
    const titles = newPoints.map((p) => p.title).join(", ");
    let added = 0;
    const gapsNote = uncovered.length
      ? `\nSTILL UNCOVERED — the first pass produced NO point for these slides: ${uncovered.map((s) => s.index).join(", ")}.\nLook at them again here. A slide that is mostly a diagram carries its content in the caption under "what the figure shows" — that text IS the slide's content, so extract from it. Give every new point the number of the slide it came from. Skip a page only if it genuinely teaches nothing (title, outline, agenda, recap, section divider, acknowledgement or reference list).`
      : "";
    pm.msg(`Checking coverage across ${covChunks.length} part${covChunks.length > 1 ? "s" : ""}${uncovered.length ? `, ${uncovered.length} uncovered slide(s)` : ""}…`);
    const results = await parallelMap(covChunks, 8, async (chunk) => {
      if (pm.isCancelled()) return null;
      const r = await api.llm([{ role: "system", content: SYS }, { role: "user", content: coveragePrompt(chunk, titles, outlineText, subjectForLesson(lesson), lesson.brief, gapsNote) }], { json_mode: true, max_tokens: 12000 });
      if (r && r.usage) pm.addTokens(r.usage.total_tokens);
      if (r.error) return { error: r.error };
      const parsed = parseJSON(r.content);
      return parsed && Array.isArray(parsed.points) ? parsed.points : [];
    });
    for (const res of results) {
      if (!res) continue;
      if (res.error) { pm.setStep(step, "error"); toast("Coverage check failed: " + res.error, "error"); }
      else { newPoints = newPoints.concat(res); added += res.length; }
    }
    if (added) pm.msg(`Coverage check added ${added} missing points.`);
    pm.setStep(step, "done");
    pm.setProgress(0.5);
    step++;
  }
  if (pm.isCancelled()) { pm.cancelled(); return; }

  if (newPoints.length) {
    normalizeCategories(newPoints, outlineSections);
    const seenTitles = new Set();
    newPoints = newPoints.filter((p) => {
      const k = String(p.title || "").trim().toLowerCase();
      if (!k || seenTitles.has(k)) return false;
      seenTitles.add(k);
      return true;
    });
    newPoints.forEach((p) => { if (p) p.explanation = explanationText(p.explanation); });
    lesson.points = newPoints;
    lesson.updatedAt = Date.now();
    await db.put("lessons", lesson);
  }
  fullLessonCache.set(lesson.id, lesson);
  readPosForget(lesson.id);   // the note numbers were just re-assigned
  const count = (lesson.points || []).length;
  pm.done(`${count} points`, "查看课程", () => openLesson(lessonId, "points"));
  toast("知识点已更新 ✓", "success");
  refreshBadges();
}

/* ---------------- Re-file an existing lesson's hierarchy ----------------
 * Rebuilds the topic skeleton and re-assigns every existing point's
 * "category", WITHOUT regenerating any content. Cheap (~2 calls/lesson):
 * brings lessons created under the older, looser category rules onto the
 * current 3-level scheme. Points, explanations, cards and quizzes are
 * untouched — only the filing changes.
 */
async function reclassifyLesson(lessonId, opts = {}) {
  const lesson = await db.get("lessons", lessonId);
  if (!lesson) return { ok: false, reason: "not found" };
  const pts = lesson.points || [];
  if (!pts.length) return { ok: false, reason: "no points" };
  const slides = lesson.slides || [];
  if (!slides.length) return { ok: false, reason: "no slides" };
  if (!(await requireTextKey())) return { ok: false, reason: "no key" };

  // 1) Rebuild the skeleton from the slide titles (same input as generation).
  const summary = slides.map((s) => {
    const first = (s.text || "").split("\n").map((l) => l.trim()).filter(Boolean)[0] || "";
    return `Slide ${s.index}: ${first.slice(0, 80)}`;
  }).join("\n");
  const or = await api.llm(
    [{ role: "system", content: SYS }, { role: "user", content: outlinePrompt(lesson.title, summary, lesson.brief) }],
    { json_mode: true, max_tokens: 2000, slot: "outline", lessonId: lesson.id, lessonTitle: lesson.title }
  );
  if (opts.onTokens && or?.usage) opts.onTokens(or.usage.total_tokens);
  const op = or && !or.error ? parseJSON(or.content) : null;
  const outlineSections = (op && Array.isArray(op.sections) && op.sections.length) ? op.sections : (lesson.outline || []);
  if (!outlineSections.length) return { ok: false, reason: (or && or.error) || "outline failed" };
  const outlineText = JSON.stringify(outlineSections);

  // 2) Re-file the points in batches (the skeleton is global, so batches stay
  //    consistent with each other).
  const B = 60;
  let filed = 0;
  for (let i = 0; i < pts.length; i += B) {
    const batch = pts.slice(i, i + B);
    const itemsText = batch.map((p, j) => `${i + j + 1}. [Slide ${p.slide ?? "?"}] ${p.title}\n   ${explanationText(p.explanation).slice(0, 160)}`).join("\n");
    const r = await api.llm(
      [{ role: "system", content: SYS }, { role: "user", content: reclassifyPrompt(itemsText, outlineText) }],
      { json_mode: true, max_tokens: 8000, slot: "reclassify", lessonId: lesson.id, lessonTitle: lesson.title }
    );
    if (opts.onTokens && r?.usage) opts.onTokens(r.usage.total_tokens);
    const parsed = r && !r.error ? parseJSON(r.content) : null;
    if (!parsed || !Array.isArray(parsed.categories)) continue;
    parsed.categories.forEach((c) => {
      const idx = Number(c && c.i) - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx >= pts.length) return;
      const cat = Array.isArray(c.category) ? c.category.map((x) => String(x || "").trim()).filter(Boolean) : [];
      if (cat.length) { pts[idx].category = cat; filed++; }
    });
  }

  // 3) Normalise: merge wording variants and snap every level onto the skeleton.
  normalizeCategories(pts, outlineSections);
  lesson.outline = outlineSections;
  lesson.points = pts;
  lesson.updatedAt = Date.now();
  await db.put("lessons", lesson);
  fullLessonCache.set(lesson.id, lesson);
  return { ok: true, filed, points: pts.length };
}

async function reclassifyCurrentLesson(lessonId) {
  const pm = progressPanel("重新整理分类");
  pm.addStep("重建主题骨架");
  pm.setStep(0, "running");
  const res = await reclassifyLesson(lessonId, { onTokens: (t) => pm.addTokens(t) });
  if (!res.ok) {
    pm.setStep(0, "error");
    pm.fail("失败：" + res.reason);
    toast("分类整理失败：" + res.reason, "error");
    return;
  }
  pm.setStep(0, "done");
  pm.done(`${res.filed}/${res.points} 个知识点已重排`, "查看课程", () => openLesson(lessonId, "points"));
  toast("分类已重新整理 ✓", "success");
  renderLessonDetail();
}

async function reclassifyAllLessons() {
  const all = await db.getAllLite("lessons");
  const targets = (all || []).filter((l) => (l.points || []).length && (l.slides || []).length);
  if (!targets.length) { toast("没有可整理的课程", "error"); return; }
  if (!confirm(`将重新整理 ${targets.length} 门课的分类（不重新生成内容，每门约 2 次 AI 调用）。继续？`)) return;
  if (!(await requireTextKey())) return;
  const pm = progressPanel(`重新整理分类 · ${targets.length} 门课`);
  pm.addStep(`重排 ${targets.length} 门课的分类`);
  pm.setStep(0, "running");
  let done = 0, failed = 0, filedTotal = 0;
  for (const l of targets) {
    if (pm.isCancelled()) { pm.cancelled(); return; }
    try {
      const res = await reclassifyLesson(l.id, { onTokens: (t) => pm.addTokens(t) });
      if (res.ok) filedTotal += res.filed; else failed++;
    } catch { failed++; }
    done++;
    pm.msg(`已处理 ${done}/${targets.length} · ${(l.title || "").slice(0, 40)}`);
    pm.setProgress(done / targets.length);
  }
  pm.setStep(0, failed ? "error" : "done");
  pm.done(`${done - failed}/${targets.length} 门课已重排 · ${filedTotal} 个知识点`);
  toast(`分类整理完成：${done - failed}/${targets.length} 门课 ✓`, "success");
  renderLessons();
}

async function generateCardsOnly(lessonId) {
  const lesson = await db.get("lessons", lessonId);
  if (!lesson) return;
  window.__llmCtx = { lessonId: lesson.id, lessonTitle: lesson.title };
  if (!(lesson.points || []).length) { toast("先提炼知识点再生成闪卡。", "error"); return; }
  if (!(await requireTextKey())) return;
  const pm = progressPanel((lesson.title || "闪卡") + " · 生成闪卡");
  pm.addStep("Generate flashcards");
  pm.setStep(0, "running");
  const pchunks = chunkText([pointsToText(lesson.points)], 9000);
  let cards = [];
  pm.msg(`Writing flashcards (${pchunks.length} part${pchunks.length > 1 ? "s" : ""})…`);
  const results = await parallelMap(pchunks, 8, async (pchunk) => {
    if (pm.isCancelled()) return null;
    const r = await api.llm([{ role: "system", content: SYS }, { role: "user", content: cardsPrompt(pchunk, subjectForLesson(lesson)) }], { json_mode: true, max_tokens: 8000 });
      if (r && r.usage) pm.addTokens(r.usage.total_tokens);
    if (r.error) return { error: r.error };
    const parsed = parseJSON(r.content);
    return parsed && Array.isArray(parsed.cards) ? parsed.cards : [];
  });
  for (const res of results) {
    if (!res) continue;
    if (res.error) { pm.setStep(0, "error"); toast("Flashcards failed: " + res.error, "error"); }
    else cards = cards.concat(res.map((c) => newCard({ lessonId, front: c.front, back: c.back })));
  }
  if (pm.isCancelled()) { pm.cancelled(); return; }
  if (cards.length) {
    const oldCards = await db.getAllByIndex("cards", "lessonId", lessonId);
    await Promise.all(oldCards.map((c) => db.delete("cards", c.id)));
    await db.bulkPut("cards", cards);
    pm.setStep(0, "done");
  } else pm.setStep(0, "error");
  pm.done(`${cards.length} cards`, "查看课程", () => openLesson(lessonId, "cards"));
  toast("闪卡已更新 ✓", "success");
  refreshBadges();
}

async function generateFiguresOnly(lessonId) {
  const lesson = await db.get("lessons", lessonId);
  if (!lesson) return;
  window.__llmCtx = { lessonId: lesson.id, lessonTitle: lesson.title };
  if (!(await requireTextKey())) return;
  const pm = progressPanel((lesson.title || "配图") + " · 配图");
  const slidesWithFigs = (lesson.slides || []).filter((s) => (s.images || []).some((im) => im.kind !== "page" && im.kind !== "logo"));
  if (!slidesWithFigs.length) { pm.close(); toast("没有找到可用的配图。", "error"); return; }
  pm.addStep(`Attach figures & captions (${slidesWithFigs.length} slides)`);
  pm.setStep(0, "running");
  await attachFigureCaptions(slidesWithFigs, pm, { lo: 0.05, hi: 0.98, onlyMissing: false });
  if (pm.isCancelled()) { pm.cancelled(); return; }
  pm.setStep(0, "done");
  lesson.updatedAt = Date.now();
  await db.put("lessons", lesson);
  fullLessonCache.set(lesson.id, lesson);
  pm.done("配图完成", "查看课程", () => openLesson(lessonId, "points"));
  toast("配图已更新 ✓", "success");
}

async function regenerateQuiz(lessonId) {
  const lesson = await db.get("lessons", lessonId);
  const pm = progressPanel((lesson?.title || "测验") + " · 重生成题目");
  pm.addStep("Generate quiz questions");
  pm.setStep(0, "running");
  const points = lesson.points || [];
  const B = 12;
  const pointBatches = [];
  for (let i = 0; i < points.length; i += B) pointBatches.push(points.slice(i, i + B));
  const qs = [];
  const results = await parallelMap(pointBatches, 8, async (batch) => {
    if (pm.isCancelled()) return null;
    const txt = batch.map((p, i) => `${i + 1}. ${p.title}\n   ${explanationText(p.explanation)}`).join("\n");
    const n = batch.length;
    let good = [];
    let want = batch;
    for (let attempt = 0; attempt < 3 && want.length; attempt++) {
      if (pm.isCancelled()) return good;
      const askTxt = want.map((p, i) => `${i + 1}. ${p.title}\n   ${explanationText(p.explanation)}`).join("\n");
      const r = await api.llm([{ role: "system", content: SYS }, { role: "user", content: mcqPrompt(askTxt, want.length, subjectForLesson(lesson), attempt > 0) }], { json_mode: true, max_tokens: 12000 });
      if (r && r.usage) pm.addTokens(r.usage.total_tokens);
      if (r.error) return { error: r.error };
      const parsed = parseJSON(r.content);
      const questions = parsed && Array.isArray(parsed.questions) ? parsed.questions : [];
      // Match by content, not position (see matchQuestionToPoint).
      questions.forEach((qq, i) => {
        if (!qq || qq.slide != null) return;
        const point = matchQuestionToPoint(qq, want) || want[i];
        if (point && point.slide != null) qq.slide = Number(point.slide);
      });
      const bad = [];
      questions.forEach((qq, i) => { if (quizQuestionInvalid(qq)) bad.push(want[i]); else good.push(qq); });
      want = bad;
    }
    return good;
  });
  for (const res of results) {
    if (!res) continue;
    if (res.error) { pm.setStep(0, "error"); toast(res.error, "error"); }
    else qs.push(...res);
  }
  if (pm.isCancelled()) { pm.cancelled(); return; }
  if (qs.length) {
    shuffleQuizOptions(qs);
    const quiz = { id: uid(), lessonId, createdAt: Date.now(), questions: qs, userAnswers: [], score: null, completed: false };
    // Replace, do not append. Leaving the old record behind made the store return
    // both, and reads then had to guess which bank was current — regeneration
    // looked like it had done nothing. Done after generation succeeds so a failed
    // regenerate never destroys the existing quiz.
    const stale = await db.getAllByIndex("quizzes", "lessonId", lessonId).catch(() => []);
    await Promise.all(stale.filter((q) => q && q.id !== quiz.id).map((q) => db.delete("quizzes", q.id).catch(() => {})));
    await db.put("quizzes", quiz);
    pm.setStep(0, "done");
    pm.done("Quiz regenerated", "查看课程", () => renderLessonDetail());
    toast("Quiz regenerated ✓", "success");
  } else {
    pm.setStep(0, "error");
    pm.close();
    toast("Quiz regeneration failed", "error");
  }
}

/* ---------------- Feynman self-test ---------------- */
let feynmanSession = null;

function openFeynmanChooser(lessonId, points) {
  const due = (points || []).filter((p) => isPointDue(p));
  const unmastered = (points || []).filter((p) => !isMastered(p));
  if (due.length && due.length === points.length) { startFeynman(lessonId, "due"); return; }
  openModal(`
    <h2>选择自测范围</h2>
    <p class="sub" style="margin-bottom:14px">现在按间隔重复排期：优先复习已到期的知识点，评完会按 1/3/7/14/30 天再次出现。</p>
    <div style="display:flex;flex-direction:column;gap:10px">
      <button class="btn btn-accent" id="feyn-mode-due" ${due.length ? "" : "disabled"}>📅 到期知识点 (${due.length})</button>
      <button class="btn" id="feyn-mode-unmastered" ${unmastered.length ? "" : "disabled"}>📌 未掌握知识点 (${unmastered.length})</button>
      <button class="btn btn-ghost" id="feyn-mode-all">📚 全部知识点 (${(points || []).length})</button>
      <button class="btn btn-ghost" id="feyn-mode-cancel">取消</button>
    </div>`);
  $("#feyn-mode-due").addEventListener("click", () => { closeModal(); startFeynman(lessonId, "due"); });
  $("#feyn-mode-unmastered").addEventListener("click", () => { closeModal(); startFeynman(lessonId, "unmastered"); });
  $("#feyn-mode-all").addEventListener("click", () => { closeModal(); startFeynman(lessonId, "all"); });
  $("#feyn-mode-cancel").addEventListener("click", closeModal);
}

async function startFeynman(lessonId, mode = "due") {
  const lesson = await db.getLight("lessons", lessonId);
  if (!lesson?.points?.length) { toast("No key points to test yet."); return; }
  // Full lesson (with slide images) for showing figures alongside each card.
  const fullLesson = await db.get("lessons", lessonId).catch(() => null);
  const points = lesson.points;
  const order = [];
  points.forEach((p, idx) => {
    if (mode === "all") order.push(idx);
    else if (mode === "unmastered" && !isMastered(p)) order.push(idx);
    else if (mode === "due" && isPointDue(p)) order.push(idx);
  });
  if (mode !== "all") {
    // High-yield points first, then by due time / original order.
    const rank = (p) => (p.importance === "high" ? 0 : p.importance === "low" ? 2 : 1);
    order.sort((a, b) => rank(points[a]) - rank(points[b]) || (points[a].feynmanDue || 0) - (points[b].feynmanDue || 0));
  }
  if (!order.length) { toast("这个范围内没有知识点。"); return; }
  setActivity("study");
  feynmanSession = { lesson, fullLesson, pos: 0, order, grades: new Array(order.length).fill(null), mode };
  if (feynmanKeyHandler) document.removeEventListener("keydown", feynmanKeyHandler);
  feynmanKeyHandler = (e) => {
    const tag = e.target && e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    const code = e.code;
    if (code === "Space" || code === "Enter" || code === "ArrowUp" || code === "ArrowDown") {
      e.preventDefault();
      revealFeynman();
    } else if (feynmanRevealed && ["1", "2", "3", "4"].includes(e.key)) {
      gradeFeynman(Number(e.key) - 1);
    } else if (feynmanRevealed && code === "ArrowLeft") {
      gradeFeynman(0);
    } else if (feynmanRevealed && code === "ArrowRight") {
      gradeFeynman(2);
    }
  };
  document.addEventListener("keydown", feynmanKeyHandler);
  showFeynmanCard();
}

function showFeynmanCard() {
  const s = feynmanSession;
  if (!s || s.pos >= s.order.length) { finishFeynman(); return; }
  const p = s.lesson.points[s.order[s.pos]];
  feynmanRevealed = false;
  // Gather figures from the same slide (from the FULL lesson so images exist).
  let figs = [];
  if (s.fullLesson && p.slide != null) {
    const sl = (s.fullLesson.slides || []).find((x) => Number(x.index) === Number(p.slide));
    if (sl) figs = (sl.images || []).filter((im) => im.kind !== "page" && im.kind !== "logo").slice(0, 3);
  }
  let figsHtml = figs.length ? `<div class="kp-figs" style="margin-top:12px">${figs.map((im) => `
      <figure class="kp-fig"><img src="${im.dataUrl}" alt=""><figcaption>${escapeHtml(im.caption?.caption || im.caption?.takeaway || `Slide ${p.slide}`)}</figcaption></figure>`).join("")}</div>` : "";
  // Region crop: reuse the interactive crop picker so the user can select a
  // sub-region of this point's slide and keep it as the Feynman figure.
  let cropBtn = "", cropFig = "";
  let feynSlide = null, feynFull = "";
  if (s.fullLesson && p.slide != null) {
    feynSlide = (s.fullLesson.slides || []).find((x) => Number(x.index) === Number(p.slide)) || null;
    const pageIm = feynSlide ? (feynSlide.images || []).find((im) => im.kind === "page") : null;
    feynFull = pageIm?.dataUrl || "";
    const crop = feynSlide && feynSlide.figureCrop && feynSlide.figureCrop.length === 4 ? feynSlide.figureCrop : null;
    if (feynFull) {
      cropBtn = `<button class="btn btn-sm btn-ghost kp-crop-btn" data-slide="${p.slide}" style="margin-top:8px">✂ ${crop ? "调整已选配图区域" : "裁剪配图区域"}</button>`;
      if (crop) cropFig = `<figure class="kp-fig" data-slide="${p.slide}" data-crop="${crop.join(",")}" data-full="${feynFull}" style="margin-top:8px"><div class="kp-fig-wrap"><img src="${feynFull}" alt=""><span class="kp-crop-badge">✂ 已选区域</span></div></figure>`;
    }
  }
  // Once the user has picked a region, drop the original un-cropped figures so
  // only the selected (adjusted) region is shown.
  if (feynSlide && feynSlide.figureCrop && feynSlide.figureCrop.length === 4) figsHtml = "";
  $("#view").innerHTML = `
    <div class="page-head">
      <div class="title-wrap"><h1>🎓 Feynman self-test</h1><p class="sub">${s.pos + 1} of ${s.order.length}${s.mode === "due" ? " · 到期知识点" : s.mode === "unmastered" ? " · 未掌握" : ""}</p></div>
      <button class="btn btn-ghost" id="feynman-undo" ${s.pos > 0 ? "" : "disabled"}>↩ 撤回</button>
    </div>
    <div class="review-stage">
      <div class="card" style="margin-bottom:14px">
        <div style="margin-bottom:6px">
          <span class="imp imp-${p.importance === "high" ? "high" : p.importance === "low" ? "low" : "medium"}">${p.importance || "medium"}</span>
          ${(p.tags || []).map((t) => `<span class="pill pill-gray">${escapeHtml(t)}</span>`).join("")}
        </div>
        <div style="font-size:18px;font-weight:700">${mdInline(p.title)}</div>
        <div class="sub" style="margin-top:10px">🤔 Explain this in your own words (out loud or in your head) as if teaching a classmate. Then reveal the answer.</div>
      </div>
      <div id="feynman-answer" hidden>
        <div class="card" style="border-color:var(--brand)">
          <div class="r-q">${mdInline(p.title)}</div>
          <div class="r-divider"></div>
          <div class="r-a">${mdFull(highlightTerms(explanationText(p.explanation), p.keyTerms))}</div>
          ${figsHtml}
          ${cropFig}
          ${cropBtn}
          ${p.mnemonic ? `<div class="kp-mnemonic"><b>🧠 Mnemonic:</b> ${md(p.mnemonic)}</div>` : ""}
        </div>
        <div class="sub" style="margin:14px 0 6px">How well did you explain it?</div>
        <div class="review-grade">
          <button class="grade-btn grade-0" data-g="0"><span>Couldn't</span><span class="g-int">0%</span></button>
          <button class="grade-btn grade-1" data-g="1"><span>Vague</span><span class="g-int">33%</span></button>
          <button class="grade-btn grade-2" data-g="2"><span>Good</span><span class="g-int">67%</span></button>
          <button class="grade-btn grade-3" data-g="3"><span>Excellent</span><span class="g-int">100%</span></button>
        </div>
      </div>
      <button class="btn btn-primary" id="feynman-reveal" style="width:100%">Reveal answer <span style="opacity:.6;font-weight:400">(空格/↑↓)</span></button>
    </div>`;
  $("#feynman-reveal").addEventListener("click", revealFeynman);
  $("#feynman-undo").addEventListener("click", () => {
    if (feynmanSession && feynmanSession.pos > 0) {
      feynmanSession.pos--;
      showFeynmanCard();
    }
  });
  $("#view").querySelectorAll(".grade-btn").forEach((b) => b.addEventListener("click", () => gradeFeynman(parseInt(b.dataset.g, 10))));
  // Wire the region-crop button (opens the picker) + apply any saved crop.
  $("#view").querySelectorAll(".kp-fig[data-crop]").forEach((fig) => {
    const img = fig.querySelector("img");
    const crop = (fig.dataset.crop || "").split(",").map(Number).filter((n) => !isNaN(n));
    if (img && crop.length === 4 && fig.dataset.full) applyFigureCrop(img, fig.dataset.full, crop);
  });
  const saveFeynCrop = async (bbox) => {
    const s2 = feynmanSession;
    const p2 = s2.lesson.points[s2.order[s2.pos]];
    const sl = (s2.fullLesson.slides || []).find((x) => Number(x.index) === Number(p2.slide));
    if (sl) { sl.figureCrop = bbox; s2.fullLesson.updatedAt = Date.now(); await db.put("lessons", s2.fullLesson); }
    toast("配图区域已更新 ✓", "success");
    showFeynmanCard();
  };
  $("#view").querySelectorAll(".kp-crop-btn").forEach((btn) => btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const slideIdx = parseInt(btn.dataset.slide, 10);
    const crop = feynSlide && feynSlide.figureCrop && feynSlide.figureCrop.length === 4 ? feynSlide.figureCrop : null;
    if (!feynFull) { toast("该页没有整页图，无法选择区域。", "error"); return; }
    openCropPicker(currentLessonId, slideIdx, feynFull, crop, saveFeynCrop);
  }));
}

function revealFeynman() {
  if (!feynmanSession || feynmanRevealed) return;
  feynmanRevealed = true;
  const rv = $("#feynman-reveal"); if (rv) rv.hidden = true;
  const ans = $("#feynman-answer"); if (ans) ans.hidden = false;
}

async function gradeFeynman(grade) {
  const s = feynmanSession;
  const idx = s.order[s.pos];
  const p = s.lesson.points[idx];
  s.lesson.points[idx] = schedulePoint(p, grade);
  s.grades[s.pos] = grade;
  // Real-time save: persist immediately so progress isn't lost if the user quits early.
  // The session uses a light lesson (no image payloads); the server merges
  // images back on PUT, and we only patch the cached full lesson's points.
  try {
    await db.put("lessons", s.lesson);
    const cached = fullLessonCache.get(s.lesson.id);
    if (cached && cached.points) cached.points[idx] = s.lesson.points[idx];
  } catch { /* keep going even if save fails */ }
  s.pos++;
  showFeynmanCard();
}

async function finishFeynman() {
  if (feynmanKeyHandler) { document.removeEventListener("keydown", feynmanKeyHandler); feynmanKeyHandler = null; }
  setActivity(null);
  const s = feynmanSession;
  if (!s) return;
  await db.put("lessons", s.lesson);
  const counts = { 0: 0, 1: 0, 2: 0, 3: 0 };
  s.grades.forEach((g) => { if (g != null) counts[g]++; });
  const done = s.grades.filter((g) => g != null).length;
  const lessonId = s.lesson.id;
  feynmanSession = null;
  refreshBadges();
  $("#view").innerHTML = `
    <div class="card" style="max-width:540px;margin:40px auto;text-align:center">
      <div class="empty-ico" style="font-size:44px">🎓</div>
      <h2>Feynman self-test done</h2>
      <p class="sub">${done} points reviewed — Excellent ${counts[3]} · Good ${counts[2]} · Vague ${counts[1]} · Couldn't ${counts[0]}</p>
      <p class="sub">These ratings now count toward your lesson mastery (30%).</p>
      <button class="btn btn-primary" id="feynman-done">Back to lesson</button>
    </div>`;
  $("#feynman-done").addEventListener("click", () => openLesson(lessonId, "points"));
}

/* ---------------- Quiz taking ---------------- */
let quizSession = null;
let quizKeyHandler = null;
let cardsKbHandler = null;

// Persist a wrong answer to the mistake book IMMEDIATELY (not only at quiz end),
// so a mistake is recorded even if the user quits mid-quiz. Dedupes by question
// text within the lesson; if the same mistake exists and is unmastered, bump it.
/* Open the notes at the knowledge point a question came from.
 *
 * This is what "回到那个知识点" means: clicking a mistake, a starred question or a
 * search hit should land ON the paragraph, not merely open the lecture — and it
 * must NOT restore the reader's saved position, which would drag them somewhere
 * else entirely. Prefers the stored index, then a content match, and finally opens
 * the notes at the top rather than at that unrelated saved position.
 */
async function openQuestionSource(lessonId, q) {
  const lesson = await getLessonFull(lessonId).catch(() => null);
  if (!lesson || !(lesson.points || []).length) {
    await openLesson(lessonId, "points", { restore: false });
    return;
  }
  let idx = Number.isInteger(q && q.pointIdx) ? q.pointIdx : -1;
  if (!(idx >= 0 && idx < lesson.points.length)) {
    const hit = matchQuestionToPoint(q, lesson.points);
    idx = hit ? lesson.points.indexOf(hit) : -1;
  }
  if (idx >= 0) { await openPoint(lessonId, idx); return; }
  await openLesson(lessonId, "points", { restore: false });
}

async function recordQuizMistake(lesson, w) {
  try {
    // Remember which key point the question came from, so opening the mistake can
    // go straight to that paragraph instead of only opening the lesson. Matching by
    // content (not by position) keeps this right even after the notes are edited.
    const hit = matchQuestionToPoint(w, (lesson && lesson.points) || []);
    const pointIdx = hit ? (lesson.points || []).indexOf(hit) : -1;
    const link = { pointIdx: pointIdx >= 0 ? pointIdx : null, pointTitle: hit ? hit.title : "" };
    const existing = await db.getAllByIndex("mistakes", "lessonId", lesson.id);
    const dup = existing.find((m) => m.question === w.question && !m.mastered);
    if (dup) {
      dup.userAnswer = w.options[w.userAnswer];
      dup.nextReview = Date.now();
      dup.reviewCount = (dup.reviewCount || 0) + 1;
      if (link.pointIdx != null) Object.assign(dup, link);
      await db.put("mistakes", dup);
    } else {
      await db.put("mistakes", {
        id: uid(), lessonId: lesson.id, lessonTitle: lesson.title,
        question: w.question, options: w.options, answer: w.answer,
        userAnswer: w.userAnswer, explanation: w.explanation,
        ...link,
        createdAt: Date.now(), nextReview: Date.now(), stage: 0, reviewCount: 1, mastered: false,
      });
    }
  } catch { /* ignore transient errors */ }
}

async function startQuiz(lessonId) {
  const [quizRecs, lesson] = await Promise.all([
    db.getAllByIndex("quizzes", "lessonId", lessonId),
    db.get("lessons", lessonId),
    loadFavs(), // stars are shown while answering, so load before the first render
  ]);
  const quiz = latestQuiz(quizRecs);
  if (!quiz) return;
  quizFavOnly = false; // the bank's filter must not follow the reader into an attempt
  setActivity("quiz");
  // Resume a partially-answered quiz (progress is saved after each answer).
  const saved = (quiz.userAnswers || []).filter((_, i) => i < (quiz.questions || []).length);
  const resumePos = (saved.length > 0 && !quiz.completed) ? saved.length : 0;
  quizSession = { quiz, lesson, pos: resumePos, answers: resumePos ? saved : [], wrong: [] };
  // Space / Enter advances once the question is answered; ← / → step through the
  // quiz so an earlier answer can be re-read without the mouse.
  if (quizKeyHandler) document.removeEventListener("keydown", quizKeyHandler);
  quizKeyHandler = (e) => {
    if (quizReview) return; // the review screen owns the keys while it is open
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const step = (sel) => {
      const b = $(sel);
      if (b && !b.disabled) { e.preventDefault(); b.click(); }
    };
    if (e.key === " " || e.key === "Enter" || e.key === "ArrowRight") step("#q-next");
    else if (e.key === "ArrowLeft") step("#q-prev");
  };
  document.addEventListener("keydown", quizKeyHandler);
  renderQuizQuestion();
}

/* ---------------- The quiz screen ----------------
 * One question at a time, and after answering you can step BACK through the ones
 * you have already done. Those come back read-only — your pick, the right answer
 * and the explanation — because the attempt is already recorded and the score
 * counts it; re-answering would silently rewrite the result.
 *
 * Forward is only allowed once the current question is answered, so the answers
 * stay a dense prefix: no gaps, and "finished" keeps meaning "all answered"
 * exactly as it did before.
 */
function quizFeedbackHtml(lesson, q, ua, correct, showPick) {
  // Resolve the slide from the NOTES rather than trusting the number stored on the
  // question. The stored one is a snapshot from generation time: an attempt that
  // was open while the notes were re-ordered (or de-duplicated) writes its whole
  // bank back on every answer, which silently restores the old, wrong page — how
  // a phase-contrast/DIC question kept showing the mitosis slide.
  const qSlide = slideForQuestion(lesson, q);
  let figs = qSlide != null ? collectLessonSlidesForSlide(lesson, qSlide) : collectLessonSlides(lesson, 6);
  if (!figs.length) figs = collectLessonSlides(lesson, 6);
  const figHtml = figs.length ? `
    <details style="margin-top:14px;border:1px solid var(--border);border-radius:10px;padding:10px 12px;background:var(--surface-2)">
      <summary style="cursor:pointer;font-weight:600">📄 本题相关 slide (${figs.length})</summary>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">
        ${figs.map((f) => `<figure style="margin:0;max-width:200px">
          <img src="${f.im.dataUrl}" data-full="${f.im.dataUrl}" style="width:100%;max-height:150px;object-fit:contain;border:1px solid var(--border);border-radius:8px;cursor:zoom-in" title="点击放大">
          <figcaption class="sub" style="font-size:11px;margin-top:4px">Slide ${f.slide}</figcaption>
        </figure>`).join("")}
      </div>
    </details>` : "";
  const pick = showPick && ua != null
    ? `你的答案：${mdInline((q.options || [])[ua] || "")} · 正确答案：${mdInline((q.options || [])[q.answer] || "")}<br>`
    : "";
  return `<div class="q-expl ${correct ? "correct" : "wrong"}"><b>${correct ? "✓ Correct" : "✗ Incorrect"}</b><br>${pick}${mdFull(q.explanation || "")}</div>${figHtml}`;
}

/* Which slide should "本题相关 slide" open for this question?
 *
 * A live match against the lesson's key points is authoritative, because the
 * points are the material the question was written from; the number stored on the
 * question is only a fallback for when nothing matches confidently.
 */
function slideForQuestion(lesson, q) {
  const matched = matchQuestionToPoint(q, (lesson && lesson.points) || []);
  if (matched && matched.slide != null) return Number(matched.slide);
  return q && q.slide != null ? Number(q.slide) : null;
}

function bindSlideZoom(root) {
  (root || document).querySelectorAll("img[data-full]").forEach((img) => img.addEventListener("click", () => {
    openModal(`<h2 style="margin-bottom:12px">相关 slide</h2><img src="${img.dataset.full}" style="max-width:100%;max-height:70vh;object-fit:contain;border-radius:10px">`);
  }));
}

// Show the recorded choice and the correct one, and take the options out of play.
function quizLockOptions(q, ua) {
  document.querySelectorAll("#options .q-option").forEach((b) => {
    const bi = Number(b.dataset.i);
    if (bi === q.answer) b.classList.add("correct");
    else if (bi === ua) b.classList.add("wrong");
    b.disabled = true;
  });
}

function renderQuizQuestion() {
  const { quiz, lesson, pos, answers } = quizSession;
  const q = quiz.questions[pos];
  const n = quiz.questions.length;
  const ua = answers[pos] ?? null;
  const done = ua != null;
  const correct = done && ua === q.answer;
  const answeredCount = answers.filter((x) => x != null).length;
  const scoreSoFar = answers.reduce((s, a, i) => s + (a != null && a === quiz.questions[i].answer ? 1 : 0), 0);
  const last = pos + 1 >= n;
  $("#view").innerHTML = `
    <div class="page-head">
      <div class="title-wrap"><h1>Quiz</h1><p class="sub">Question ${pos + 1} / ${n}${answeredCount ? ` · 已答 ${answeredCount} 题（答对 ${scoreSoFar}）` : ""}</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${answeredCount ? `<button class="btn btn-ghost" id="q-review" title="逐题回看这次答过的题，可按只答错筛选">🕘 回看已答 (${answeredCount})</button>` : ""}
      </div>
    </div>
    <div class="progress-bar" style="margin-bottom:16px"><div class="progress-fill" style="width:${(pos / n) * 100}%"></div></div>
    ${done ? `<div class="card" style="margin-bottom:12px;padding:10px 14px;background:var(--surface-2)">
      <span class="sub">已作答（${correct ? "✅ 答对" : "❌ 答错"}）· 下面是你的选择和正确答案，本题不能再改。</span></div>` : ""}
    <div class="card" style="margin-bottom:18px">
      <div style="display:flex;align-items:flex-start;gap:10px">
        <div style="font-size:17px;font-weight:600;flex:1;min-width:0">${mdFull(q.question)}</div>
        ${favButton(pos, lesson.id, q)}
      </div>
    </div>
    <div id="options">${q.options.map((o, i) => `<button class="q-option" data-i="${i}"><span class="letter">${String.fromCharCode(65 + i)}.</span><span>${mdInline(o)}</span></button>`).join("")}</div>
    <div id="feedback"></div>
    <div style="display:flex;align-items:center;gap:10px;margin-top:18px;flex-wrap:wrap">
      <button class="btn btn-ghost" id="q-prev" ${pos === 0 ? "disabled" : ""}>◀ 上一题</button>
      <span class="sub">${pos === 0 ? "已经是第一题" : "上一题可以回看"}</span>
      <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn ${done ? "btn-primary" : "btn-ghost"}" id="q-next" ${done ? "" : "disabled"}
          title="${done ? "" : "先答这道题"}">${last ? "Finish" : "下一题 ▶"}</button>
      </div>
    </div>
    ${done ? "" : `<p class="sub" style="margin-top:8px">选一个选项作答；“下一题”会在答完后可用；答过的题点“上一题”即可回看。</p>`}
  `;
  bindFavStars($("#view"), lesson, quiz.questions);
  $("#q-prev").addEventListener("click", () => { if (pos > 0) { quizSession.pos--; renderQuizQuestion(); } });
  $("#q-next").addEventListener("click", () => {
    if (pos + 1 < n) { quizSession.pos++; renderQuizQuestion(); }
    else finishQuiz();
  });
  const r1 = $("#q-review");
  if (r1) r1.addEventListener("click", () => quizReviewEnter(lesson.id, "current", "all", "quiz"));

  // Already answered: replay the recorded result instead of offering the options.
  if (done) {
    quizLockOptions(q, ua);
    const fb = $("#feedback");
    fb.innerHTML = quizFeedbackHtml(lesson, q, ua, correct, true);
    bindSlideZoom(fb);
    return;
  }

  $("#options").querySelectorAll(".q-option").forEach((btn) => btn.addEventListener("click", () => {
    const i = parseInt(btn.dataset.i, 10);
    const right = i === q.answer;
    quizSession.answers.push(i);
    // Save progress after EVERY answer (so refresh/exit keeps the attempt).
    {
      const qz = quizSession.quiz;
      qz.userAnswers = quizSession.answers.slice();
      qz.score = quizSession.answers.filter((a, j) => a === qz.questions[j].answer).length;
      qz.completed = false;
      qz.lastTaken = Date.now();
      db.put("quizzes", qz);
    }
    if (!right) {
      const wrong = { ...q, userAnswer: i };
      quizSession.wrong.push(wrong);
      recordQuizMistake(quizSession.lesson, wrong); // real-time mistake sync
    }
    // Re-render rather than patch the DOM: the answered question now comes back
    // through the read-only branch, which is where the locked options, the
    // explanation and the updated "已答 n 题" counter all live. One code path for
    // "answered", whether it was just now or three questions ago.
    renderQuizQuestion();
  }));
}

async function finishQuiz() {
  setActivity("study");
  const { quiz, lesson, answers, wrong } = quizSession;
  const score = answers.filter((a, i) => a === quiz.questions[i].answer).length;
  quiz.userAnswers = answers;
  quiz.score = score;
  quiz.completed = true;
  quiz.lastTaken = Date.now();
  // Archive this attempt. userAnswers alone only ever holds the newest set, so a
  // later retake would erase the record of this one — and looking back at what you
  // answered is the whole point of the review mode.
  const hist = Array.isArray(quiz.attempts) ? quiz.attempts.slice() : [];
  hist.push({ at: quiz.lastTaken, score, answers: answers.slice() });
  quiz.attempts = hist.slice(-QUIZ_ATTEMPT_CAP);
  await db.put("quizzes", quiz);

  quizSession = null;
  refreshBadges();
  const wrongCount = answers.reduce((n, a, i) => n + (a !== quiz.questions[i].answer ? 1 : 0), 0);
  $("#view").innerHTML = `
    <div class="card" style="max-width:560px;margin:40px auto;text-align:center">
      <div class="empty-ico" style="font-size:44px">${score === quiz.questions.length ? "🎉" : score >= quiz.questions.length * 0.7 ? "👍" : "📚"}</div>
      <h2>${score} / ${quiz.questions.length}</h2>
      <p class="sub">${wrong.length} question${wrong.length === 1 ? "" : "s"} added to your mistake notebook.</p>
      <div style="display:flex;gap:10px;justify-content:center;margin-top:16px;flex-wrap:wrap">
        <button class="btn btn-primary" id="r-back">Back to lesson</button>
        ${wrongCount ? `<button class="btn btn-accent" id="r-review-wrong">🕘 回看答错的 ${wrongCount} 题</button>` : ""}
        <button class="btn btn-ghost" id="r-review">🕘 回看这次作答</button>
        <button class="btn btn-ghost" id="r-mistakes">📕 Open mistakes</button>
      </div>
    </div>`;
  $("#r-back").addEventListener("click", () => openLesson(lesson.id));
  $("#r-mistakes").addEventListener("click", () => navigate("mistakes"));
  // Review opens on the lesson's Quiz tab: that is where the review renders.
  const openReview = (filter) => {
    currentTab = "quiz";
    quizReviewEnter(lesson.id, "a" + Math.max(0, (quiz.attempts || []).length - 1), filter);
  };
  $("#r-review").addEventListener("click", () => openReview("all"));
  const rw = $("#r-review-wrong");
  if (rw) rw.addEventListener("click", () => openReview("wrong"));
}

/* ---------------- Today's study (unified review queue) ---------------- */
async function renderReview() {
  const [cards, lessons, mistakes] = await Promise.all([
    db.getAll("cards"), db.getAll("lessons"), db.getAll("mistakes"),
  ]);
  reviewLessonMap = {};
  lessons.forEach((l) => (reviewLessonMap[l.id] = l.title));
  const plan = planStudyQueue(cards, lessons, mistakes);
  if (!plan.entries.length) {
    setActivity(null);
    const moreNew = [
      plan.remainingNewCount > 0 ? `${plan.remainingNewCount} 张新卡` : "",
      plan.remainingNewPointCount > 0 ? `${plan.remainingNewPointCount} 个新知识点` : "",
    ].filter(Boolean).join("、");
    const moreTxt = moreNew ? ` 还有 ${moreNew} 按每日上限留到明天。` : "";
    $("#view").innerHTML = emptyState("🎉", `今天的复习队列已清空。${moreTxt}`, `<div style="margin-top:14px"><button class="btn btn-primary" id="r-lessons">📚 Browse lessons</button></div>`);
    $("#r-lessons").addEventListener("click", () => navigate("lessons"));
    return;
  }
  reviewQueue = plan.entries;
  reviewPos = 0;
  reviewRequeued = new Set();
  reviewStats = {
    cards: 0, cardGrades: [0, 0, 0, 0], newCards: 0,
    mistakes: 0, mistakeGot: 0, mistakeMissed: 0,
    points: 0, pointGrades: [0, 0, 0, 0],
  };
  if (reviewKeyHandler) document.removeEventListener("keydown", reviewKeyHandler);
  reviewKeyHandler = (e) => {
    const tag = e.target && e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    const code = e.code;
    if (code === "Space" || code === "Enter" || code === "ArrowUp" || code === "ArrowDown") {
      e.preventDefault();
      flipReviewCard();
      return;
    }
    if (!reviewFlipped || reviewPos >= reviewQueue.length) return;
    const entry = reviewQueue[reviewPos];
    if (entry.kind === "mistake") {
      if (code === "ArrowLeft" || e.key === "1") gradeStudyEntry(false);
      else if (code === "ArrowRight" || e.key === "2") gradeStudyEntry(true);
    } else {
      if (["1", "2", "3", "4"].includes(e.key)) gradeStudyEntry(Number(e.key) - 1);
      else if (code === "ArrowLeft") gradeStudyEntry(0);
      else if (code === "ArrowRight") gradeStudyEntry(2);
    }
  };
  document.addEventListener("keydown", reviewKeyHandler);
  showReviewCard();
}

function studyKindBadge(entry) {
  if (entry.kind === "card" && entry.isNewCard) return `<span class="pill pill-accent">🆕 新卡</span>`;
  if (entry.kind === "card") return `<span class="pill pill-brand">🃏 闪卡</span>`;
  if (entry.kind === "mistake") return `<span class="pill pill-red">📕 错题</span>`;
  if (entry.isNewPoint) return `<span class="pill pill-accent">🎓 新知识点</span>`;
  return `<span class="pill pill-amber">🎓 知识点</span>`;
}

function showReviewCard() {
  if (reviewPos >= reviewQueue.length) { finishReview(); return; }
  reviewFlipped = false;
  const entry = reviewQueue[reviewPos];
  const remaining = reviewQueue.length - reviewPos;
  const head = `
    <div class="page-head">
      <div class="title-wrap"><h1>🎯 Today's study</h1><p class="sub">${remaining} item${remaining === 1 ? "" : "s"} remaining · ${studyKindBadge(entry)}</p></div>
    </div>`;

  if (entry.kind === "card") {
    const card = entry.card;
    const preview = [0, 1, 2, 3].map((g) => schedule(card, g));
    const meta = `interval ${intervalLabel(card.interval)} · ease ${card.ease} · reps ${card.reps}`;
    const lessonTitle = reviewLessonMap[card.lessonId] || "";
    $("#view").innerHTML = head + `
      <div class="review-stage">
        <div class="flashcard" id="r-fc">
          ${lessonTitle ? `<div style="margin-bottom:12px"><span class="pill pill-gray">📚 ${escapeHtml(lessonTitle)}</span></div>` : ""}
          <div class="card-label" id="r-label">Question</div>
          <div class="card-text" id="r-text"></div>
        </div>
        <button class="btn btn-primary btn-lg" id="r-reveal" style="width:100%;margin-top:16px">Show answer <span style="opacity:.6;font-weight:400">(空格 / ↑↓)</span></button>
        <div id="r-grades" hidden>
          <div class="review-grade">
            <button class="grade-btn grade-0" data-g="0"><span>Again</span><span class="g-int">${intervalLabel(preview[0].interval)}</span><span class="g-key">1</span></button>
            <button class="grade-btn grade-1" data-g="1"><span>Hard</span><span class="g-int">${intervalLabel(preview[1].interval)}</span><span class="g-key">2</span></button>
            <button class="grade-btn grade-2" data-g="2"><span>Good</span><span class="g-int">${intervalLabel(preview[2].interval)}</span><span class="g-key">3</span></button>
            <button class="grade-btn grade-3" data-g="3"><span>Easy</span><span class="g-int">${intervalLabel(preview[3].interval)}</span><span class="g-key">4</span></button>
          </div>
        </div>
        <div class="sub" style="text-align:center;margin-top:12px">${meta} · 空格/↑↓ 翻面 · 1-4 或 ←→ 评分</div>
      </div>`;
    $("#r-text").innerHTML = mdFull(card.front);
    $("#r-fc").addEventListener("click", flipReviewCard);
    $("#r-reveal").addEventListener("click", flipReviewCard);
    $("#view").querySelectorAll(".grade-btn").forEach((b) => b.addEventListener("click", () => gradeStudyEntry(parseInt(b.dataset.g, 10))));
    return;
  }

  if (entry.kind === "mistake") {
    const m = entry.mistake;
    const userText = m.options ? (m.options[m.userAnswer] ?? m.userAnswer) : m.userAnswer;
    const correctText = m.options ? m.options[m.answer] : m.answer;
    $("#view").innerHTML = head + `
      <div class="review-stage">
        <div class="card" style="margin-bottom:14px">
          <div style="margin-bottom:10px"><span class="pill pill-gray">📚 ${escapeHtml(m.lessonTitle || reviewLessonMap[m.lessonId] || "")}</span> <span class="pill pill-red">📕 错题</span></div>
          <div style="font-weight:600;font-size:16px">${mdInline(m.question)}</div>
        </div>
        <button class="btn btn-primary btn-lg" id="r-reveal" style="width:100%">Show answer <span style="opacity:.6;font-weight:400">(空格 / ↑↓)</span></button>
        <div id="r-grades" hidden style="margin-top:16px">
          ${userText != null ? `<div class="q-expl wrong" style="margin-bottom:8px"><b>✗ 你的答案:</b> ${escapeHtml(userText)}</div>` : ""}
          <div class="q-expl correct" style="margin-bottom:8px"><b>✓ 正确答案:</b> ${escapeHtml(correctText)}</div>
          ${m.explanation ? `<div class="q-expl">${mdFull(m.explanation)}</div>` : ""}
          <div class="review-grade" style="margin-top:16px">
            <button class="grade-btn grade-0" data-ok="0"><span>Still wrong</span><span class="g-key">1</span></button>
            <button class="grade-btn grade-2" data-ok="1"><span>Got it</span><span class="g-key">2</span></button>
          </div>
        </div>
        <div class="sub" style="text-align:center;margin-top:12px">空格/↑↓ 显示答案 · ←/1 还错 · →/2 对了</div>
      </div>`;
    $("#r-reveal").addEventListener("click", flipReviewCard);
    $("#view").querySelectorAll(".grade-btn").forEach((b) => b.addEventListener("click", () => gradeStudyEntry(b.dataset.ok === "1")));
    return;
  }

  // Knowledge point (Feynman-style recall)
  const { lesson, point } = entry;
  const preview = [0, 1, 2, 3].map((g) => schedulePoint(point, g));
  const imp = point.importance === "high" ? "high" : point.importance === "low" ? "low" : "medium";
  $("#view").innerHTML = head + `
    <div class="review-stage">
      <div class="card" style="margin-bottom:14px">
        <div style="margin-bottom:6px">
          <span class="imp imp-${imp}">${imp}</span>
          ${(point.tags || []).map((t) => `<span class="pill pill-gray">${escapeHtml(t)}</span>`).join("")}
          <span class="pill pill-gray">📚 ${escapeHtml(lesson.title)}</span>
        </div>
        <div style="font-size:18px;font-weight:700">${mdInline(point.title)}</div>
        <div class="sub" style="margin-top:10px">🤔 用自己的话解释这个概念，像在教同学一样。然后显示答案并自评。</div>
      </div>
      <button class="btn btn-primary btn-lg" id="r-reveal" style="width:100%">Show answer <span style="opacity:.6;font-weight:400">(空格 / ↑↓)</span></button>
      <div id="r-grades" hidden style="margin-top:16px">
        <div class="card" style="border-color:var(--brand)">
          <div class="r-a">${mdFull(highlightTerms(explanationText(point.explanation), point.keyTerms))}</div>
          ${point.mnemonic ? `<div class="kp-mnemonic"><b>🧠 Mnemonic:</b> ${md(point.mnemonic)}</div>` : ""}
          ${point.supplement ? `<div class="kp-supplement"><b>💡 理解:</b> ${mdInline(point.supplement)}</div>` : ""}
          <div id="r-figs"></div>
        </div>
        <div class="sub" style="margin:14px 0 6px">你解释得怎么样？</div>
        <div class="review-grade">
          <button class="grade-btn grade-0" data-g="0"><span>Couldn't</span><span class="g-int">${intervalLabel(preview[0].feynmanInterval != null ? preview[0].feynmanInterval : (preview[0].feynmanDue - Date.now()) / 86400000)}</span><span class="g-key">1</span></button>
          <button class="grade-btn grade-1" data-g="1"><span>Vague</span><span class="g-int">${intervalLabel(preview[1].feynmanInterval != null ? preview[1].feynmanInterval : (preview[1].feynmanDue - Date.now()) / 86400000)}</span><span class="g-key">2</span></button>
          <button class="grade-btn grade-2" data-g="2"><span>Good</span><span class="g-int">${intervalLabel(preview[2].feynmanInterval != null ? preview[2].feynmanInterval : (preview[2].feynmanDue - Date.now()) / 86400000)}</span><span class="g-key">3</span></button>
          <button class="grade-btn grade-3" data-g="3"><span>Excellent</span><span class="g-int">${intervalLabel(preview[3].feynmanInterval != null ? preview[3].feynmanInterval : (preview[3].feynmanDue - Date.now()) / 86400000)}</span><span class="g-key">4</span></button>
        </div>
      </div>
      <div class="sub" style="text-align:center;margin-top:12px">空格/↑↓ 显示答案 · 1-4 或 ←→ 评分</div>
    </div>`;
  $("#r-reveal").addEventListener("click", flipReviewCard);
  $("#view").querySelectorAll(".grade-btn").forEach((b) => b.addEventListener("click", () => gradeStudyEntry(parseInt(b.dataset.g, 10))));
  if (point.slide != null) loadReviewPointFigure(lesson.id, point.slide, "r-figs");
}

// Asynchronously load the figure for a knowledge point's slide (from the FULL
// lesson, which includes the image payloads) into a container in the review UI.
async function loadReviewPointFigure(lessonId, slideIdx, containerId) {
  try {
    let lesson = fullLessonCache.get(lessonId);
    if (!lesson) { lesson = await db.get("lessons", lessonId); if (lesson) fullLessonCache.set(lessonId, lesson); }
    const slide = lesson?.slides?.find((s) => Number(s.index) === Number(slideIdx));
    const pageIm = slide?.images?.find((im) => im.kind === "page");
    const figData = pageIm?.dataUrl || (slide?.images?.find?.((im) => im.kind !== "page" && im.kind !== "logo")?.dataUrl);
    const el = document.getElementById(containerId);
    if (el && figData) {
      el.innerHTML = `<div class="kp-figs"><figure class="kp-fig"><img src="${figData}" alt=""><figcaption>Slide ${slideIdx}</figcaption></figure></div>`;
      el.querySelector("img").addEventListener("click", () => openModal(`<h2 style="margin-bottom:12px">Slide ${slideIdx}</h2><img src="${figData}" style="max-width:100%;max-height:70vh;object-fit:contain;border-radius:10px">`));
    }
  } catch { /* ignore */ }
}

function flipReviewCard() {
  if (reviewPos >= reviewQueue.length) return;
  const entry = reviewQueue[reviewPos];
  if (entry.kind === "card") {
    reviewFlipped = !reviewFlipped;
    const card = entry.card;
    const label = $("#r-label");
    const t = $("#r-text");
    const rv = $("#r-reveal");
    const g = $("#r-grades");
    if (reviewFlipped) {
      if (label) label.textContent = "Answer";
      t.className = "card-text answer";
      t.innerHTML = `<div class="r-q">${mdFull(card.front)}</div><div class="r-divider"></div><div class="r-a">${mdFull(card.back)}</div>`;
      if (rv) rv.hidden = true;
      if (g) g.hidden = false;
    } else {
      if (label) label.textContent = "Question";
      t.className = "card-text";
      t.innerHTML = mdFull(card.front);
      if (rv) rv.hidden = false;
      if (g) g.hidden = true;
    }
    return;
  }
  if (reviewFlipped) return;
  reviewFlipped = true;
  const rv = $("#r-reveal"); if (rv) rv.hidden = true;
  const g = $("#r-grades"); if (g) g.hidden = false;
}

// Re-insert a missed entry a fixed number of cards LATER instead of at the very
// end: appending put it right back in front of the student on a short queue,
// which read as "the same card keeps coming back".
const REQUEUE_GAP = 8;
function requeueLater(entry) {
  const at = reviewPos + REQUEUE_GAP;
  // On a queue with fewer than GAP entries left there is nowhere to "delay" to:
  // inserting would land it back among the next couple of cards, which is the
  // back-to-back repeat being complained about. Let it wait for the next session
  // instead — the SM-2 schedule already brings it back tomorrow.
  if (at >= reviewQueue.length) return;
  reviewQueue.splice(at, 0, entry);
}

async function gradeStudyEntry(value) {
  if (!reviewFlipped || reviewPos >= reviewQueue.length) return;
  if (blockTrialWrite()) return;
  const entry = reviewQueue[reviewPos];

  if (entry.kind === "card") {
    const grade = Number(value);
    const card = entry.card;
    const wasNew = card.reps === 0 && card.lapses === 0 && !sameDay(card.newDoneAt);
    const updated = schedule(card, grade);
    if (wasNew) updated.newDoneAt = Date.now();
    await db.put("cards", updated);
    reviewStats.cards++;
    if (wasNew) reviewStats.newCards++;
    reviewStats.cardGrades[grade] = (reviewStats.cardGrades[grade] || 0) + 1;
    if (grade === 0 && !reviewRequeued.has(card.id)) {
      reviewRequeued.add(card.id);
      requeueLater({ ...entry, card: updated });
    }
  } else if (entry.kind === "mistake") {
    const gotIt = !!value;
    const updated = scheduleMistake(entry.mistake, gotIt);
    await db.put("mistakes", updated);
    reviewStats.mistakes++;
    if (gotIt) reviewStats.mistakeGot++; else reviewStats.mistakeMissed++;
  } else {
    const grade = Number(value);
    const { lesson, point, idx } = entry;
    const updatedPoint = schedulePoint(point, grade);
    lesson.points[idx] = updatedPoint;
    await db.put("lessons", lesson);
    const cached = fullLessonCache.get(lesson.id);
    if (cached && cached.points) cached.points[idx] = updatedPoint;
    reviewStats.points++;
    reviewStats.pointGrades[grade] = (reviewStats.pointGrades[grade] || 0) + 1;
    if (grade === 0 && !reviewRequeued.has(entry.id)) {
      reviewRequeued.add(entry.id);
      requeueLater({ ...entry, point: updatedPoint });
    }
  }

  reviewPos++;
  showReviewCard();
}

function finishReview() {
  if (reviewKeyHandler) { document.removeEventListener("keydown", reviewKeyHandler); reviewKeyHandler = null; }
  setActivity(null);
  refreshBadges();
  const cardLine = reviewStats.cards
    ? `${reviewStats.cards} 卡片 (Again ${reviewStats.cardGrades[0]} · Hard ${reviewStats.cardGrades[1]} · Good ${reviewStats.cardGrades[2]} · Easy ${reviewStats.cardGrades[3]}${reviewStats.newCards ? ` · 新卡 ${reviewStats.newCards}` : ""})`
    : "";
  const pointLine = reviewStats.points
    ? `${reviewStats.points} 知识点 (没想起来 ${reviewStats.pointGrades[0]} · 模糊 ${reviewStats.pointGrades[1]} · 良好 ${reviewStats.pointGrades[2]} · 优秀 ${reviewStats.pointGrades[3]})`
    : "";
  const mistakeLine = reviewStats.mistakes
    ? `${reviewStats.mistakes} 错题 (掌握 ${reviewStats.mistakeGot} · 仍错 ${reviewStats.mistakeMissed})`
    : "";
  const lines = [cardLine, pointLine, mistakeLine].filter(Boolean).join("<br>");
  $("#view").innerHTML = `
    <div class="card" style="max-width:560px;margin:40px auto;text-align:center">
      <div class="empty-ico" style="font-size:44px">✅</div>
      <h2>今日学习完成</h2>
      <p class="sub">${lines || "没有需要复习的项目。"}</p>
      <button class="btn btn-primary" id="r-done">Done</button>
    </div>`;
  $("#r-done").addEventListener("click", () => navigate("dashboard"));
}

/* ---------------- Mistakes ---------------- */
async function renderMistakes() {
  const mistakes = await db.getAll("mistakes");
  const now = Date.now();
  const active = mistakes.filter((m) => !m.mastered);
  const due = active.filter((m) => m.nextReview <= now);
  $("#view").innerHTML = `
    <div class="page-head">
      <div class="title-wrap"><h1>Mistake notebook</h1><p class="sub">${active.length} active · ${mistakes.length - active.length} mastered · ${due.length} due now</p></div>
      <button class="btn btn-danger" id="btn-mr" ${due.length ? "" : "disabled"}>📕 Review due (${due.length})</button>
    </div>
    <div class="grid">${active.length ? active.sort((a, b) => a.nextReview - b.nextReview).map(mistakeRow).join("") : emptyState("📕", "No active mistakes — nice work!")}</div>
  `;
  $("#btn-mr").addEventListener("click", startMistakeReview);
  // Clicking a mistake goes to the knowledge point it tests (see openQuestionSource).
  $("#view").querySelectorAll(".mistake-item").forEach((el) => el.addEventListener("click", async () => {
    const m = (mistakes || []).find((x) => x.id === el.dataset.mistake);
    if (m) { await openQuestionSource(m.lessonId, m); return; }
    await openLesson(el.dataset.lesson, "points", { restore: false });
  }));
}

function mistakeRow(m) {
  const opts = m.options ? `<div class="sub" style="margin-top:6px">Your answer: <b style="color:var(--red)">${mdInline(m.options[m.userAnswer] ?? m.userAnswer)}</b> · Correct: <b style="color:var(--green)">${mdInline(m.options[m.answer])}</b></div>` : "";
  return `
    <div class="card mistake-item" data-lesson="${m.lessonId}" data-mistake="${escapeHtml(m.id)}" style="cursor:pointer">
      <div class="sub" style="display:flex;justify-content:space-between;margin-bottom:6px;gap:8px">
        <span>${escapeHtml(m.lessonTitle)}${m.pointTitle ? ` · 📖 ${escapeHtml(m.pointTitle)}` : ""}</span>
        <span class="pill pill-gray">next ${fmtDate(m.nextReview)}</span>
      </div>
      <div style="font-weight:600">${mdInline(m.question)}</div>
      ${opts}
      ${m.explanation ? `<div class="q-expl" style="margin-top:8px">${mdFull(m.explanation)}</div>` : ""}
    </div>`;
}

async function startMistakeReview() {
  const mistakes = await db.getAll("mistakes");
  const now = Date.now();
  mistakeQueue = mistakes.filter((m) => !m.mastered && m.nextReview <= now);
  if (!mistakeQueue.length) { renderMistakes(); return; }
  setActivity("mistakes");
  mistakePos = 0;
  mistakeStats = { shown: 0, got: 0, missed: 0 };
  if (mistakeKeyHandler) document.removeEventListener("keydown", mistakeKeyHandler);
  mistakeKeyHandler = (e) => {
    const tag = e.target && e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    const code = e.code;
    if (code === "Space" || code === "Enter" || code === "ArrowUp" || code === "ArrowDown") {
      e.preventDefault();
      revealMistake();
    } else if (mistakeRevealed && code === "ArrowLeft") {
      gradeMistake(mistakeQueue[mistakePos], false);
    } else if (mistakeRevealed && code === "ArrowRight") {
      gradeMistake(mistakeQueue[mistakePos], true);
    }
  };
  document.addEventListener("keydown", mistakeKeyHandler);
  showMistakeCard();
}

function showMistakeCard() {
  if (mistakePos >= mistakeQueue.length) { finishMistakeReview(); return; }
  const m = mistakeQueue[mistakePos];
  mistakeRevealed = false;
  $("#view").innerHTML = `
    <div class="page-head"><div class="title-wrap"><h1>Mistake review</h1><p class="sub">${mistakePos + 1} of ${mistakeQueue.length}</p></div></div>
    <div class="review-stage">
      <div class="card" style="margin-bottom:14px"><div style="font-weight:600;font-size:16px">${mdInline(m.question)}</div></div>
      <div id="mr-reveal" hidden>
        <div class="q-expl correct" style="margin-bottom:12px"><b>✓ Correct answer:</b> ${mdInline(m.options ? m.options[m.answer] : m.answer)}</div>
        ${m.explanation ? `<div class="q-expl">${mdFull(m.explanation)}</div>` : ""}
        <button class="btn btn-ghost btn-sm" id="mr-goto" style="margin-top:10px">📖 看对应的知识点${m.pointTitle ? `：${escapeHtml(m.pointTitle)}` : ""}</button>
        <div class="review-grade" style="margin-top:16px">
          <button class="grade-btn grade-0" id="mr-miss">Still wrong</button>
          <button class="grade-btn grade-2" id="mr-got">Got it</button>
        </div>
      </div>
      <button class="btn btn-primary" id="mr-show" style="width:100%">Show answer <span style="opacity:.6;font-weight:400">(空格/↑↓ · ←错 →对)</span></button>
    </div>`;
  $("#mr-show").addEventListener("click", revealMistake);
  $("#mr-goto").addEventListener("click", () => openQuestionSource(m.lessonId, m));
  $("#mr-got").addEventListener("click", () => gradeMistake(m, true));
  $("#mr-miss").addEventListener("click", () => gradeMistake(m, false));
}

function revealMistake() {
  if (!mistakeQueue.length || mistakeRevealed) return;
  mistakeRevealed = true;
  const s = $("#mr-show"); if (s) s.hidden = true;
  const r = $("#mr-reveal"); if (r) r.hidden = false;
}

async function gradeMistake(m, gotIt) {
  const updated = scheduleMistake(m, gotIt);
  await db.put("mistakes", updated);
  mistakeStats.shown++;
  if (gotIt) mistakeStats.got++; else mistakeStats.missed++;
  mistakePos++;
  showMistakeCard();
}

function finishMistakeReview() {
  if (mistakeKeyHandler) { document.removeEventListener("keydown", mistakeKeyHandler); mistakeKeyHandler = null; }
  setActivity(null);
  refreshBadges();
  $("#view").innerHTML = `
    <div class="card" style="max-width:520px;margin:40px auto;text-align:center">
      <div class="empty-ico" style="font-size:44px">📕</div>
      <h2>Mistake review done</h2>
      <p class="sub">${mistakeStats.shown} reviewed — Got it ${mistakeStats.got} · Still wrong ${mistakeStats.missed}</p>
      <button class="btn btn-primary" id="m-done">Done</button>
    </div>`;
  $("#m-done").addEventListener("click", () => navigate("mistakes"));
}

/* ---------------- Progress (time stats + mastery) ---------------- */
function computeTimeStats(log) {
  const now = new Date();
  const byDay = {};
  const byActivity = {};
  log.forEach((r) => {
    byDay[r.date] = (byDay[r.date] || 0) + r.seconds;
    byActivity[r.activity] = (byActivity[r.activity] || 0) + r.seconds;
  });
  const todayKey = dayKey(now);
  const todaySec = byDay[todayKey] || 0;
  let weekSec = 0;
  for (let i = 0; i < 7; i++) { const d = new Date(now); d.setDate(d.getDate() - i); weekSec += byDay[dayKey(d)] || 0; }
  const allSec = Object.values(byDay).reduce((a, b) => a + b, 0);
  const days = new Set(Object.keys(byDay).filter((k) => byDay[k] > 0));
  let cursor = new Date(now);
  if (!days.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (days.has(dayKey(cursor))) { streak++; cursor.setDate(cursor.getDate() - 1); }
  const series = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    series.push({ label: shortDay(d), sec: byDay[dayKey(d)] || 0, today: i === 0 });
  }
  const maxSec = Math.max(1, ...series.map((s) => s.sec));
  return { todaySec, weekSec, allSec, streak, series, byActivity, maxSec };
}

function lpRow(x) {
  const { lesson, totalCards, seen, mature, quiz, pct, pointPct = 0, reviewedPoints = 0, totalPoints = 0 } = x;
  // `questionCount` comes from the slim list payload; `questions` from a per-lesson fetch.
  const qTotal = quiz ? (quiz.questionCount ?? quiz.questions?.length ?? 0) : 0;
  const quizTxt = qTotal ? `${quiz.score ?? 0}/${qTotal}` : "—";
  const parts = [];
  if (totalPoints) parts.push(`🎓 ${reviewedPoints}/${totalPoints} points (${pointPct}%)`);
  if (totalCards) parts.push(`cards ${seen}/${totalCards} · ${mature} mastered`);
  if (qTotal) parts.push(`quiz ${quizTxt}`);
  return `
    <div class="lp-row" data-id="${lesson.id}">
      <div class="lp-top">
        <span class="lp-title">${escapeHtml(lesson.title)}</span>
        <span class="lp-pct">${pct}%</span>
      </div>
      <div class="progress-bar" style="height:8px"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="lp-meta sub">${parts.join(" · ") || "no activity yet"}</div>
    </div>`;
}

async function renderProgress() {
  const [lessons, cards, quizzes, log] = await Promise.all([
    db.getAllLite("lessons"), db.getAllLite("cards"), db.getAll("quizzes"), db.getAll("studyLog"),
  ]);
  const t = computeTimeStats(log);

  // per-lesson mastery (Feynman points + cards + quiz)
  const mastery = computeMasteryMap(lessons, cards, quizzes);
  const lp = lessons.map((l) => ({ lesson: l, ...mastery[l.id] }));
  const matureCards = cards.filter((c) => c.interval >= 21).length;
  const masteredLessons = lp.filter((x) => x.pct >= 80).length;

  $("#view").innerHTML = `
    <div class="page-head">
      <div class="title-wrap"><h1>Progress</h1><p class="sub">Study time & mastery at a glance.</p></div>
    </div>

    <div class="grid grid-4" style="margin-bottom:20px">
      <div class="card stat"><div class="stat-num">${fmtDuration(t.todaySec)}</div><div class="stat-label">Studied today</div></div>
      <div class="card stat"><div class="stat-num">${fmtDuration(t.weekSec)}</div><div class="stat-label">Last 7 days</div></div>
      <div class="card stat"><div class="stat-num">${fmtDuration(t.allSec)}</div><div class="stat-label">All time</div></div>
      <div class="card stat"><div class="stat-num">🔥 ${t.streak}</div><div class="stat-label">Day streak</div></div>
    </div>

    <div class="card" style="margin-bottom:20px">
      <h3>Last 7 days</h3>
      <div class="chart">${t.series.map((s) => `
        <div class="chart-col">
          <div class="chart-val">${s.sec ? fmtDuration(s.sec) : ""}</div>
          <div class="chart-bar" style="height:${Math.max(3, Math.round((s.sec / t.maxSec) * 120))}px" title="${fmtDuration(s.sec)}"></div>
          <div class="chart-label ${s.today ? "chart-today" : ""}">${s.today ? "Today" : s.label}</div>
        </div>`).join("")}</div>
    </div>

    <div class="grid grid-2" style="margin-bottom:20px">
      <div class="card">
        <h3>Time by activity</h3>
        ${Object.keys(ACTIVITY_LABELS).map((a) => `
          <div class="break-row">
            <span class="break-label">${ACTIVITY_LABELS[a]}</span>
            <div class="progress-bar" style="flex:1;height:8px"><div class="progress-fill" style="width:${t.allSec ? Math.round((t.byActivity[a] || 0) / t.allSec * 100) : 0}%"></div></div>
            <span class="sub" style="width:56px;text-align:right">${fmtDuration(t.byActivity[a] || 0)}</span>
          </div>`).join("")}
        <div class="sub" style="margin-top:4px">Only counts time while the tab is visible and you're actively studying.</div>
      </div>
      <div class="card">
        <h3>Mastery overview</h3>
        <div class="stat" style="margin-bottom:14px"><div class="stat-num">${matureCards}<span class="sub" style="font-size:16px"> / ${cards.length}</span></div><div class="stat-label">cards mastered (interval ≥ 21 days)</div></div>
        <div class="stat" style="margin-bottom:14px"><div class="stat-num">${masteredLessons}<span class="sub" style="font-size:16px"> / ${lessons.length}</span></div><div class="stat-label">lessons ≥ 80% mastered</div></div>
        <div class="stat"><div class="stat-num">${quizzes.length}</div><div class="stat-label">quiz attempts</div></div>
      </div>
    </div>

    <div class="card">
      <h3>Per-lesson mastery</h3>
      <div class="sub" style="margin-bottom:6px">Click a lesson to open it. Mastery = 30% Feynman points + 40% mature cards + 30% best quiz score.</div>
      ${lp.length ? lp.sort((a, b) => b.lesson.createdAt - a.lesson.createdAt).map(lpRow).join("") : '<div class="sub">No lessons yet.</div>'}
    </div>`;

  $("#view").querySelectorAll(".lp-row").forEach((el) => el.addEventListener("click", () => openLesson(el.dataset.id)));
}

/* ---------------- Search ---------------- */
const TYPE_META = {
  lesson: { label: "Lessons", ico: "📚", tab: "points" },
  point: { label: "Key points", ico: "✨", tab: "points" },
  card: { label: "Flashcards", ico: "🃏", tab: "cards" },
  question: { label: "Quiz questions", ico: "📝", tab: "quiz" },
  mistake: { label: "Mistakes", ico: "📕", tab: "quiz" },
};

function buildSearchIndex(lessons, cards, quizzes, mistakes) {
  const lessonById = {};
  lessons.forEach((l) => (lessonById[l.id] = l));
  const idx = [];
  lessons.forEach((l) => idx.push({
    type: "lesson", lessonId: l.id, lessonTitle: l.title,
    title: l.title, text: l.title + "\n" + (l.slides || []).map((s) => s.text || "").join("\n"),
    importance: null, tags: [],
  }));
  lessons.forEach((l) => (l.points || []).forEach((p, pi) => idx.push({
    type: "point", lessonId: l.id, lessonTitle: l.title,
    title: p.title, text: [p.title, explanationText(p.explanation), p.mnemonic || "", ...(p.tags || [])].join("\n"),
    importance: p.importance || "medium", tags: p.tags || [],
    // Position inside lesson.points — this is what openPoint() needs to scroll to the
    // hit and highlight it. Without it a search hit for a knowledge point could only
    // open the lesson, leaving the student to hunt for the row themselves.
    pointIdx: pi,
  })));
  cards.forEach((c) => idx.push({
    type: "card", lessonId: c.lessonId, lessonTitle: lessonById[c.lessonId]?.title || "—",
    title: c.front, text: (c.front || "") + "\n" + (c.back || ""),
    importance: null, tags: [],
  }));
  quizzes.forEach((q) => (q.questions || []).forEach((qq) => idx.push({
    type: "question", lessonId: q.lessonId, lessonTitle: lessonById[q.lessonId]?.title || "—",
    title: qq.question, text: [qq.question, ...(qq.options || [])].join("\n"),
    importance: null, tags: [],
  })));
  mistakes.forEach((m) => idx.push({
    type: "mistake", lessonId: m.lessonId, lessonTitle: m.lessonTitle || "—",
    title: m.question, text: [m.question, ...(m.options || []), m.explanation || ""].join("\n"),
    importance: null, tags: [],
  }));
  return idx;
}

function searchResultRow(it) {
  const meta = TYPE_META[it.type];
  const imp = it.importance && it.importance !== "medium"
    ? `<span class="imp imp-${it.importance === "high" ? "high" : "low"}">${it.importance}</span>` : "";
  // A knowledge-point hit carries its position inside the lesson, so the click can
  // land ON the point instead of merely opening the lesson.
  const pt = Number.isInteger(it.pointIdx) ? ` data-pt="${it.pointIdx}"` : "";
  return `
    <div class="search-row" data-lesson="${it.lessonId}" data-tab="${meta.tab}"${pt}>
      <div class="search-ico">${meta.ico}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600">${escapeHtml(it.title)}</div>
        <div class="sub" style="font-size:12.5px">${meta.label} · ${escapeHtml(it.lessonTitle)}</div>
      </div>
      ${imp}
    </div>`;
}

/* ---------------- Token statistics ---------------- */
/* ---------------- Formula library (per subject) ----------------
 * A worked-formula reference grouped by subject: every formula met so far, what
 * each symbol means, when to use it, and three basic worked examples.
 *
 * The formulas are identified by the AI rather than by scraping `$...$` out of
 * the notes: the raw text contains stray dollar signs, single inline symbols,
 * units and mid-sentence fragments, so a regex pass produces mostly noise.
 */
const FORMULA_PROMPT = (items) => `From these study notes, extract every GENUINE mathematical formula (an equation or quantitative relation with symbols). Ignore stray "$" characters, lone symbols used inline, units, numbers, and prose fragments — only complete, reusable formulas that a student would apply.

RULES
- Only extract relations the notes actually state, or that are completely standard for this exact topic. Never invent a formula, symbol or unit to fill space.
- Use ONE notation convention throughout: "_o" for outside the membrane (letter o, never the digit 0), "_i" for inside, "_m" for membrane. Never write the same quantity two ways (e.g. "C_o" in one place and "C_0" in another) — the same relation written twice would be a duplicate entry.
- If a formula is an approximation or special case of another one you also list, say so in "conditions" and keep it as its OWN entry (e.g. the exact Nernst equation and the 60/z log form are two separate formulas).
- Self-consistency is mandatory: every condition or given value you state must agree with your own worked solution. If a question asks the student to explain why a result deviates from a simple prediction, do NOT fix that same factor in the question's premise — leave it as the thing to be reasoned about.
- Unit discipline: in every worked solution, convert each quantity to ONE consistent unit system BEFORE substituting, and write the conversion out explicitly (1 m² = 10⁴ cm², 1 m³ = 10⁶ cm³, 1 μm = 10⁻⁴ cm, 1 mol/m³ = 10⁻⁶ mol/cm³). Get the exponent right: a volume conversion changes the exponent by 6, an area conversion by 4.
- Magnitude sanity check: compare the final answer against the real value for the subject before returning it (O₂ flux across the alveolar membrane is ~10⁻⁴ mol/s, a single-channel current is a few pA, a membrane potential is tens of mV, an enzyme rate is μmol/s). If your result is orders of magnitude away, a conversion or an exponent is wrong — redo the arithmetic rather than returning it.
- List each relation ONCE. If two forms differ only in which symbol names the same quantity (the same weighted average written once with V_m and once with E_R), keep a single entry and mention the alternative notation in "symbols".
- Constants and temperature: state the temperature you assume, and use ONE value of the thermal factor consistently everywhere in this answer. At 37 °C, 2.303RT/F ≈ 61.5 mV (use 61.5/z, not 60/z); at 25 °C it is ≈ 59.2 mV. Never insert the 25 °C constant into a question that states 37 °C, and never report two different equilibrium potentials for the same ion at the same concentrations in different entries — a student will compare them and one will look wrong.
- Do not spend two entries on ONE relation restated with a constant factor — most often a total rate and the same thing per unit area (dQ/dt = -DA·dC/dx vs J = -D·dC/dx), or a per-mole and a per-gram form. List the form the notes use and mention the other in "conditions". This applies ONLY to such a restatement of the SAME relation: a different ion, transporter, pump or reaction is a DIFFERENT formula and needs its own entry. 钠钾泵、钠钙交换体、钙泵、SGLT、ABC转运蛋白 are five separate formulas, never one.
- "examQuestion" is required for EVERY formula, including reaction and stoichiometry entries (3Na⁺ + 2K⁺ + ATP → …, SGLT, ABC transporters, gating). Those cannot be solved by substitution, so for them the synoptic question must instead ask for a PREDICTION or CONSEQUENCE: what happens to transport if a step is blocked, an inhibitor is added, the gradient is reversed, or the stoichiometry changes — and why. Never leave "examQuestion" empty.
- "work" must read as the FINAL, clean solution a student could copy straight into an exam: steps separated by ；or newlines, ONE unit conversion per step, each conversion written correctly the first time. A student reads this to learn the method, so never include your own hesitation or a false start — no "？", no "需换算：", no "其实/等等/重新/应该是", and never a wrong intermediate that you then correct in the next clause. Write the conversion once, correctly (1 mmol/L = 1×10⁻⁶ mol/cm³), rather than writing "1 mol/L/cm" and repairing it afterwards.
- Signs: work with magnitudes and state the direction in words (由肠腔侧进入血液), instead of writing a minus sign in front of a quantity you then treat as positive.

For each formula return:
- "name": what it is called, in the notes' language, with the English in parentheses
- "latex": the formula in LaTeX (no surrounding $ signs)
- "symbols": one short line naming every symbol with its unit, e.g. "K 分配系数（无量纲）；D 扩散系数（cm²/s）；δ 膜厚度（cm）"
- "usage": when and why a student uses it (1-2 sentences)
- "conditions": assumptions or limits, or "" if none
- "params": explanations for the INTERPRETIVE COEFFICIENTS of the formula — and ONLY those. Each: {"symbol": the symbol exactly as it appears in the LaTeX, "name": the Chinese name, "role": …, "changes": …, "typical": …}
  * INTERPRETIVE COEFFICIENT = a property of the system that a student has to reason with: K_m, J_max, P, D, k, g, G, P_0, E_X, E_R, L_p, K_d, 通透性系数、电导、平衡电位、速率常数、分配系数、反射系数、化学计量比、开放概率. These get all three parts: "role" = what it means physically and what it lets you judge, compare or predict (2-3 句, e.g. "K_m 反映载体对底物的亲和力，K_m 越小亲和力越高；知道 K_m 就能判断某浓度下转运是否已接近饱和，也是解释竞争性抑制的关键"); "changes" = what makes it CHANGE and what leaves it UNCHANGED, naming the mechanism — physiological (激素、发育、组织差异), pathological, experimental (温度、pH), pharmacological (抑制剂类型) — and say explicitly when it is a fixed property of the molecule that does NOT change with substrate concentration or flux (e.g. "K_m 是载体本身的性质，不随底物浓度改变；竞争性抑制剂使表观 K_m 增大而 J_max 不变"); "typical" = its range in this subject with units.
  * DO NOT create an entry for a quantity that needs no explanation. ATP/ADP/Pi、各种离子或底物浓度（[K⁺]_o、[Na⁺]_i、[Ca²⁺]_i、[glucose]_o）、膜电位 V_m、电流 I、绝对温度 T、面积 A、厚度 δ、分子量、化学计量数、以及结构片段或分子名称（M1-M6、NPA motif、12 个跨膜螺旋、GLUT1）are NOT coefficients. A separate entry for them is padding — and writing the same "ATP 三磷酸腺苷" entry under every pump formula is worse than useless. They are already covered by "symbols".
  * EXCEPTION: a plain quantity gets exactly ONE compact line — fill only "symbol", "name" and a ≤25 字 "role", leaving "changes" and "typical" empty — when there is a real trap a student can fall into: a unit conversion, a sign convention, or a definition that is commonly confused. e.g. "T —— 必须用绝对温度（K），不能代摄氏温度"; "Z —— 离子价数，带正负号，影响 Nernst 方程方向"; "δ —— 膜厚度，注意 nm/μm 与 cm 的换算". No mechanism story and no range for these.
  * Before writing "typical", CHECK THE ORDER OF MAGNITUDE by substituting realistic values into the formula, and make sure the value fits the situation you NAME (a 5 nm membrane is not a 10 μm epithelium: with a mmol/L gradient, dC/dx across a membrane is ~1–100 mol·cm⁻⁴, not 10⁻³; across a 10 μm epithelium it is ~10⁻⁴–10⁻²). Write ranges increasing (10⁻⁵～10⁻³), never decreasing.
  * CONSISTENCY — a student who compares two entries and finds two different values for one quantity concludes the whole library is unreliable:
    - The same quantity gets the SAME range everywhere in this answer. If D is 10⁻⁶～10⁻⁵ cm²/s in water for one formula, do not quote a different range for the same medium in another; if E_Ca is +130 mV in one entry, do not write +120 mV in the next. Give the range per medium explicitly (水溶液 vs 膜脂内) rather than one blended figure.
    - Units must match the definition you gave in "symbols" and in the formula itself: if P is defined in cm/s, never quote cm³/s for it.
    - A quoted value must not contradict its own formula: substituting it back must give a physically possible result (a G_Na range that, put into I = G_X(V_m − E_X), yields a current the cell's pumps could never sustain is wrong).
- "point": the title of the knowledge point in the notes this formula was taken from, copied VERBATIM without the 【课程名】 prefix; "" if no single point covers it
- "scenarios": WHERE THIS FORMULA ACTUALLY COMES UP — 2-3 concrete situations from the course and the exam. For each, say which topic/chapter it belongs to, what problem it solves there, and what kind of question gets asked about it. Write this for a student revising for the exam, not as a dictionary definition. Example of the level wanted: "气体交换：用扩散速率比较 O₂ 与 CO₂ 通过呼吸膜的快慢；常考'肺气肿使呼吸膜面积减少后扩散量如何变化'。药物吸收：估算药物跨肠上皮的吸收速率。"
- "examples": EXACTLY 3 questions of the kind a university exam would ACTUALLY ask. Draw on the CLASSIC questions about this formula that appear in standard textbooks and past exam papers for this subject — the problems students actually meet, not invented filler. Do not invent fake exam names or attributions; just make the problem itself a standard, realistic one. They must NOT be bare "given A, B and C, compute D" substitutions — that is not how these are examined. Each question must:
  * sit in a real subject context (a physiological, experimental, clinical or engineering situation) rather than listing bare symbols;
  * make the student decide that this formula is the right tool and work out which of the STATED quantities is the one wanted — the given data are always sufficient, never deliberately incomplete;
  * involve at least one of: a second step, a comparison between two conditions, a rearrangement for a different unknown, an estimate using realistic magnitudes, or an interpretation of what the result means;
  * use REAL magnitudes as they appear in the subject (e.g. membrane thickness ~5 nm, alveolar area ~70 m², resting potential ~-70 mV), never arbitrary round numbers, and always carry units;
  * stay answerable in a few lines — worth doing in an exam, not a research problem.
  * BE SOLVABLE FROM ITS OWN STATEMENT — this is a hard requirement, and rearranging for another unknown is where it usually breaks: asking for τ or R rather than for U needs MORE given data than a plain substitution, so the question must supply it (a real exam question always does). If you notice mid-solution that a value is missing, do NOT report that — go back and rewrite the QUESTION so it states the value, the way the exam paper would, and then solve it properly.
  Each: {"q": the question, "work": the full solution steps, "answer": the final result with its unit, "why": one short line naming the skill it tests}
  A question you cannot answer is never acceptable output. "answer" must be a definite result with its unit — a number, a sign, or a stated relation — and never 信息不足 / 无法求解 / 需补充条件 / 无法确定 / "cannot be determined", nor a remark about what further data would be needed. "work" is a solution a student copies to learn the method, so it must never narrate doubt or negotiate with the missing value ("但 R 未知…", "假设已达稳态…则…", "本题信息不足"): if the example cannot be made solvable with realistic numbers, replace it with a different, well-posed question about the same formula.
- "examQuestion": ONE harder, synoptic question on this formula — the kind that separates grades. It should combine the formula with another relation or fact from the course, or require the student to reason about a limiting case or a change in two quantities at once. If a student can answer it by substituting into the formula once, it is too easy. Format: {"q": the question, "work": the full solution steps, "answer": the final result with its unit, "point": one short line naming what it tests}

Return JSON: {"formulas":[...]}
Notes:
${items}`;

function subjectLessonData(lessons, subjectId) {
  const out = [];
  for (const l of (lessons || [])) {
    if (subjectForLesson(l).id !== subjectId) continue;
    out.push(l);
  }
  return out;
}

// Collect every point in a subject as {text, lessonId, idx, title}. The extra
// fields are kept so a formula extracted from a point can link back to it.
function subjectPointNotes(lessons) {
  const out = [];
  for (const l of lessons) {
    (l.points || []).forEach((p, idx) => {
      const body = explanationText(p.explanation);
      out.push({
        lessonId: l.id,
        idx,
        title: String(p.title || "").trim(),
        text: `【${l.title}】${p.title}\n${body}`,
      });
    });
  }
  return out;
}

// Chunk whole points (never split one mid-way) so the prompt's 【课程名】 marker
// stays attached to the notes it belongs to.
function chunkEntries(entries, maxChars = 9000) {
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const e of entries) {
    if (cur.length && len + e.text.length > maxChars) { chunks.push(cur); cur = []; len = 0; }
    cur.push(e);
    len += e.text.length + 2;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// Two extraction passes routinely write the same relation in slightly different
// LaTeX — "C_o" vs "C_0", "V_m" vs "V_{\text{m}}", "\dfrac" vs "\frac", stray
// \left/\right and spacing macros. Keying on the raw string let those through as
// "new" formulas, so the library listed one equation twice under two names.
// Normalising the wrappers away (and collapsing the o/0 subscript drift) makes
// those collide. \approx is deliberately NOT collapsed to "=": the exact Nernst
// equation and its 60/z approximation are genuinely two different formulas.
function formulaKey(latex) {
  return String(latex || "")
    .toLowerCase()
    .replace(/\\(?:left|right|bigg?|Bigg?)\s*/g, "")
    .replace(/\\(?:text|mathrm|operatorname|mathit|mathbf|mathsf|displaystyle|scriptstyle|scriptscriptstyle)\s*/g, "")
    .replace(/\\(?:dfrac|tfrac|cfrac)\b/g, "\\frac")
    .replace(/\\lg\b/g, "\\log")
    .replace(/\\(?:quad|qquad|thinspace|enspace|negthinspace|,|;|:|!)\s*/g, "")
    .replace(/\\[ ,;:!]/g, "")
    .replace(/\\cdot|\\times/g, "*")
    .replace(/[−–—]/g, "-")
    .replace(/[\s{}]/g, "")
    // Subscript letter-o ("outside") vs subscript zero: same quantity, two ways.
    .replace(/_o(?![a-z])/g, "_0");
}

// Last-resort recovery of a reply that is not valid JSON. Whole-batch rejection is
// what let a 395-point chapter cost ~70k tokens and contribute nothing, three times
// over. Most malformed replies still contain formula objects that arrived intact,
// so walk the "formulas" array and parse each object on its own: one broken object
// then costs one formula instead of the entire batch.
function salvageFormulas(text) {
  const s = String(text || "");
  const out = [];
  const key = s.indexOf('"formulas"');
  if (key === -1) return out;
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = key; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth++; continue; }
    if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const o = JSON.parse(s.slice(start, i + 1));
          // Require latex: an entry without it is dropped by the merge anyway, and
          // counting it would overstate how much was actually recovered.
          if (o && typeof o === "object" && typeof o.latex === "string" && o.latex.trim()) out.push(o);
        } catch { /* this object is the broken one — skip it, keep the rest */ }
        start = -1;
      }
      if (depth < 0) break;
    }
  }
  return out;
}

// A reaction arrow is the reliable signal that an entry is a chemical equation, a
// transport stoichiometry or a conformational cycle rather than something you can
// compute with. Mixing those into the formula table buries the real formulas —
// 钠钾泵 3Na⁺+2K⁺+ATP→… sitting next to 菲克定律 is not a formula sheet.
const REACTION_ARROW_RE = /\\xrightarrow|\\xleftarrow|\\rightleftharpoons|\\leftrightharpoons|\\longleftrightarrow|\\longrightarrow|\\longleftarrow|→|←|⇌|⇋|↔/;
// A bare \to or \rightarrow is ambiguous on its own — "x \to 0" is a limit, not a
// reaction — so those only count when the arrow separates named species
// (\text{谷氨酸} \to \text{GABA}) or when species are added or exchanged ("+").
// An unnamed "A \to B" stays with the formulas: it is indistinguishable from math.
const PLAIN_ARROW_RE = /\\rightarrow|\\leftarrow|\\to(?![a-z])/;
// Some stoichiometries carry no arrow at all ("2α + 2β + 1γ"), so the name is the
// only signal. A subunit composition is not something a student computes with.
const CHEM_NAME_RE = /化学计量|化学式|亚基组成/;

function isReactionEntry(f) {
  const tex = String((f && f.latex) || "");
  if (REACTION_ARROW_RE.test(tex)) return true;
  if (PLAIN_ARROW_RE.test(tex) && (tex.includes("+") || tex.includes("\\text"))) return true;
  return CHEM_NAME_RE.test(String((f && f.name) || ""));
}

// Chunking a subject into batches is deterministic, so a batch can be identified by
// its contents. That identity is what makes a retry cheap: after a partial failure
// only the batches that never came back get re-sent, instead of re-paying for a whole
// chapter (a 395-point chapter costs ~70k tokens per full pass).
function chunkId(chunk) {
  const s = (chunk || []).map((e) => `${e.lessonId}#${e.idx}#${e.title}`).join("|");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + "-" + (chunk || []).length;
}

// Which batches are already accounted for.
function seedDoneChunks(chunks, chunkIds, existing) {
  const done = new Set((existing && existing.doneChunks) || []);
  // A library written before per-batch tracking has no doneChunks. Fall back to the
  // lesson-level record — a batch counts as done when every lesson it covers is in
  // lessonIds — otherwise the first retry after upgrading re-scans everything.
  if (existing && !Array.isArray(existing.doneChunks) && Array.isArray(existing.lessonIds)) {
    const cov = new Set(existing.lessonIds);
    chunks.forEach((c, i) => { if (c.every((e) => cov.has(e.lessonId))) done.add(chunkIds[i]); });
  }
  return done;
}

// A lesson counts as included only when EVERY batch that touches it has come back.
function lessonsFullyDone(lessons, chunks, chunkIds, doneSet) {
  const out = new Set();
  for (const l of (lessons || [])) {
    let touched = false;
    let allDone = true;
    chunks.forEach((c, i) => {
      if (!c.some((e) => e.lessonId === l.id)) return;
      touched = true;
      if (!doneSet.has(chunkIds[i])) allDone = false;
    });
    if (touched && allDone) out.add(l.id);
  }
  return out;
}

// Shape one raw model record into the stored formula shape. `pointIndex` maps a
// knowledge-point title to its lesson+index, turning the model's verbatim "point"
// answer into a clickable source link.
function cleanFormula(f, pointIndex) {
  const eq = f && f.examQuestion;
  return {
    name: asText(f.name),
    latex: asText(f.latex),
    symbols: asText(f.symbols),
    usage: asText(f.usage),
    conditions: asText(f.conditions),
    scenarios: asText(f.scenarios, true),
    examples: Array.isArray(f.examples) ? f.examples.slice(0, 3).map((e) => ({
      q: asText(e && e.q),
      work: asText(e && e.work),
      answer: asText(e && e.answer),
      why: asText(e && e.why),
    })).filter((e) => e.q) : [],
    // One applied, exam-style question per formula.
    examQuestion: (eq && asText(eq.q)) ? {
      q: asText(eq.q),
      work: asText(eq.work),
      answer: asText(eq.answer),
      point: asText(eq.point),
    } : null,
    src: (pointIndex && pointIndex.get(asText(f.point))) || null,
    // Coefficient-by-coefficient explanation. Kept as structured records, not one
    // blob, so the card can label 含义/会因何改变/量级 separately.
    params: Array.isArray(f.params) ? f.params.map((p) => ({
      symbol: asText(p && p.symbol),
      name: asText(p && p.name),
      role: asText(p && p.role),
      changes: asText(p && p.changes),
      typical: asText(p && p.typical),
    // Drop entries that carry nothing: a symbol with no explanation renders as a
    // bare label and is pure noise. The model sometimes emits those for trivial
    // quantities even when told not to create an entry for them.
    })).filter((p) => (p.symbol || p.name) && (p.role || p.changes || p.typical)) : [],
  };
}

// opts.incremental: only scan lessons not yet folded into this subject's formula
// library, then merge with what is already there. Uploading a new chapter should
// not re-pay for the chapters already extracted.
// Models do not always honour "return a string": lists and small objects come
// back for fields like `scenarios` or `symbols`. Flattening them here keeps the
// content (and its list shape) instead of collapsing a list into "a,b,c".
function asText(v, bullet = false) {
  if (v == null) return "";
  if (Array.isArray(v)) {
    return v
      .map((x) => (typeof x === "object" && x ? asText(x) : String(x).trim()))
      .filter(Boolean)
      .map((x) => (bullet ? "- " + x : x))
      .join("\n");
  }
  if (typeof v === "object") {
    return Object.entries(v).map(([k, val]) => `- ${k}：${asText(val)}`).filter(Boolean).join("\n");
  }
  return String(v).trim();
}

async function generateSubjectFormulas(subjectId, pm, opts = {}) {
  const allLessons = await db.getAll("lessons");
  const lessons = subjectLessonData(allLessons, subjectId);
  const existing = await db.get("formulas", subjectId).catch(() => null);
  const covered = new Set((existing && existing.lessonIds) || []);
  const ready = lessons.filter((l) => (l.points || []).length);
  if (!ready.length) return { ok: false, reason: "这个学科还没有生成过知识点" };
  // The unit of work is a BATCH, not a lesson. Batches are derived from every ready
  // lesson (so the set is stable between runs), and one that already came back is
  // skipped — a retry after a partial failure therefore costs only what was missing.
  const entries = subjectPointNotes(ready);
  const chunks = chunkEntries(entries);
  const chunkIds = chunks.map((c) => chunkId(c));
  const doneChunks = seedDoneChunks(chunks, chunkIds, existing);
  const runIdx = chunks.map((_, i) => i).filter((i) => !opts.incremental || !doneChunks.has(chunkIds[i]));
  if (!runIdx.length) {
    return { ok: false, reason: opts.incremental ? "没有新的批次需要提取（都已包含）" : "这个学科还没有生成过知识点" };
  }
  // Title -> source point, so the model's verbatim "point" answer can be turned
  // back into a clickable jump to the knowledge point that explains the formula.
  const pointIndex = new Map();
  for (const e of entries) {
    if (e.title && !pointIndex.has(e.title)) pointIndex.set(e.title, { lessonId: e.lessonId, idx: e.idx, title: e.title });
  }
  pm.addStep(`扫描 ${entries.length} 个知识点（${runIdx.length}/${chunks.length} 批${runIdx.length < chunks.length ? "，其余已完成" : ""}）`);
  pm.setStep(0, "running");
  let done = 0;
  const work = runIdx.map((i) => ({ i, chunk: chunks[i] }));
  const results = await parallelMap(work, 3, async ({ i, chunk }) => {
    if (pm.isCancelled()) return null;
    const r = await api.llm(
      [{ role: "system", content: SYS }, { role: "user", content: FORMULA_PROMPT(chunk.map((e) => e.text).join("\n\n")) }],
      // 16000 is the server's ceiling. A chapter with many formulas produces long
      // JSON (a 395-point chapter returned 16.7k characters), so leave headroom.
      { json_mode: true, max_tokens: 16000, slot: "formulas" }
    );
    if (r && r.usage) pm.addTokens(r.usage.total_tokens);
    done++;
    pm.msg(`提取公式 ${done}/${work.length}…`);
    pm.setProgress(done / work.length);
    if (r && r.error) return { chunkIndex: i, error: r.error };
    const parsed = parseJSON(r && r.content);
    if (!parsed || !Array.isArray(parsed.formulas)) {
      // An unparseable reply is NOT the same as "this batch contains no formulas".
      // Returning [] here made the two indistinguishable: a whole chapter could be
      // scanned, cost real tokens, contribute nothing, and still be recorded as
      // "included" — so the UI never offered to retry it and the loss was silent.
      const rawText = String((r && r.content) || "");
      const len = rawText.length;
      const why = len > 14000 ? "（内容接近上限，疑似被截断）" : "";
      const salvaged = salvageFormulas(rawText);
      if (salvaged.length) {
        // Keep what arrived and still report the batch as incomplete, so the
        // chapter is not recorded as done and can be retried.
        return { chunkIndex: i, formulas: salvaged, error: `返回内容不完整，已抢救出 ${salvaged.length} 条公式（${len} 字符）`, unparsed: true };
      }
      return { chunkIndex: i, error: `返回内容无法解析为公式 JSON（${len} 字符）${why}`, unparsed: true };
    }
    return { chunkIndex: i, formulas: parsed.formulas };
  });
  pm.setStep(0, "done");
  // Merge, dropping duplicates by their normalised LaTeX. In incremental mode the
  // already-extracted formulas are the starting point. A full re-extraction
  // starts from empty, but if ANY batch failed we seed from the existing library
  // instead: otherwise a single failed batch would silently DROP every formula
  // that only that batch had found, shrinking the library on a "refresh".
  const keepOld = !!existing && Array.isArray(existing.formulas);
  const hadError = results.some((r) => r && r.error);
  const seedOld = keepOld && (opts.incremental || hadError);
  const base = seedOld ? existing.formulas.slice() : [];
  const merged = base.slice();
  const keptCount = base.length;
  if (seedOld && hadError && !opts.incremental) {
    pm.msg("有批次失败：保留原有公式，只补充本次成功提取的结果。");
  }
  if (hadError) pm.setStep(0, "error");
  // Batches that came back cleanly are recorded as done, so a retry only sends the
  // ones that did not. A lesson counts as included once every batch touching it is
  // accounted for — from the previous runs plus this one.
  const okChunkIds = results.filter((r) => r && !r.error && Number.isInteger(r.chunkIndex)).map((r) => chunkIds[r.chunkIndex]);
  const allDone = new Set([...doneChunks, ...okChunkIds]);
  const scannedIds = [...lessonsFullyDone(ready, chunks, chunkIds, allDone)];
  // Which record of a duplicate pair to keep: the one carrying more of the new
  // format. An old entry and a fresh extraction of the same relation can collide,
  // and "keep the first" would silently preserve the staler copy — so a
  // re-extraction could never upgrade anything.
  const richness = (f) => (f.scenarios ? 2 : 0) + (((f.examples || []).some((e) => e && e.why)) ? 1 : 0) + (f.src ? 1 : 0);
  let firstError = "";
  for (const res of results) {
    if (!res) continue;
    // A salvaged batch carries BOTH its recovered formulas and an error: keep the
    // formulas, remember the error, and let the chapter stay retryable.
    const list = Array.isArray(res) ? res : (Array.isArray(res.formulas) ? res.formulas : []);
    if (res.error) { if (!firstError) firstError = res.error; }
    for (const f of list) {
      if (!f || !f.latex || !String(f.latex).trim()) continue;
      const fresh = cleanFormula(f, pointIndex);
      const at = merged.findIndex((m) => formulaKey(m.latex) === formulaKey(fresh.latex));
      if (at >= 0) {
        if (richness(fresh) > richness(merged[at])) merged[at] = fresh;
        continue;
      }
      merged.push(fresh);
    }
  }
  if (!merged.length) return { ok: false, reason: firstError || "没有识别到公式" };
  const doc = {
    id: subjectId,
    subjectId,
    subjectName: (subjectById(subjectId) || {}).name || subjectId,
    formulas: merged,
    // Only lessons whose every batch is accounted for — NOT every lesson of the
    // subject. Using all lessons marked a chapter as done the moment it existed,
    // even when its scan had failed, so it could never be picked up again.
    lessonIds: [...new Set([...covered, ...scannedIds])],
    // Per-batch progress, so a retry re-sends only the batches that failed.
    doneChunks: [...allDone],
    lessons: [...new Set([...((existing && existing.lessons) || []), ...lessons.map((l) => l.title)])],
    generatedAt: Date.now(),
    model: (appConfig && appConfig.text && appConfig.text.model) || "",
  };
  await db.put("formulas", doc);
  return { ok: true, count: merged.length, added: merged.length - keptCount, doc, hadError };
}

// Which subjects the user folded away on the 公式库 page. A reading preference,
// so it lives in localStorage rather than in the stored library.
function loadFoldedSubjects() {
  try {
    const arr = JSON.parse(localStorage.getItem("mbbs_formula_folded") || "[]");
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch { return []; }
}

function saveFoldedSubjects(set) {
  try { localStorage.setItem("mbbs_formula_folded", JSON.stringify([...set])); } catch { /* ignore */ }
}

// How the 公式库 lists each subject's formulas: one flat table in extraction
// order ("flat"), or grouped under the chapter each formula came from
// ("chapter"). The chapter of a formula answers "where does this belong in the
// course", which is how a formula is actually looked up before an exam.
function formulaGroupMode() {
  try { return localStorage.getItem("mbbs_formula_group") === "flat" ? "flat" : "chapter"; } catch { return "chapter"; }
}

function saveFormulaGroupMode(mode) {
  try { localStorage.setItem("mbbs_formula_group", mode); } catch { /* ignore */ }
}

/* ---------------- ⭐ Starred questions page ----------------
 * A flat, cross-lesson list of the questions flagged as important. Grouped by
 * lesson, because that is how the material is organised, and the correct answer
 * is always visible: this page is for re-reading what matters, while recall
 * practice stays in the lesson's own quiz tab.
 */
let favQuery = ""; // survives a re-render so un-starring does not clear the search

async function renderFavs() {
  const view = $("#view");
  await loadFavs(true);
  const all = favItems.slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  // A starred question outlives its lesson (deleting a lesson removes its
  // favourites, but a restore or an import can still leave one behind), so the
  // lesson lookup is allowed to miss.
  const lessons = await db.getAllLite("lessons").catch(() => []);
  const lessonById = new Map((lessons || []).map((l) => [l.id, l]));

  if (!all.length) {
    view.innerHTML = `
      <div class="page-head"><div class="title-wrap"><h1>⭐ 收藏题目</h1><p class="sub">把重要的题目收藏起来，考前只看这些。</p></div></div>
      ${emptyState("⭐", "还没有收藏任何题目",
        `<p class="sub" style="margin-top:10px">到任意课程的 <b>Quiz</b> 标签页，点题目右上角的 ☆ 即可收藏。<br>收藏的是题目快照，所以即使之后「重生成题目」，收藏也不会丢。</p>
         <div style="margin-top:14px"><button class="btn btn-accent btn-lg" id="fav-go">📚 去课程列表</button></div>`)}`;
    $("#fav-go").addEventListener("click", () => navigate("lessons"));
    return;
  }

  const groups = new Map(); // lessonId -> { title, items[] }
  for (const f of all) {
    const key = f.lessonId || "";
    if (!groups.has(key)) {
      const l = lessonById.get(key);
      groups.set(key, { lessonId: key, title: (l && l.title) || f.lessonTitle || "(未知课程)", gone: !l, items: [] });
    }
    groups.get(key).items.push(f);
  }
  const lessonCount = groups.size;

  const cardHtml = (f) => {
    const opts = (f.options || []).map((o, j) => `<li style="${j === f.answer ? "color:var(--green);font-weight:600" : ""}">${mdInline(o)}${j === f.answer ? " ✓" : ""}</li>`).join("");
    const hay = [f.question, f.lessonTitle, f.explanation, ...(f.options || [])].join(" ").toLowerCase();
    return `<div class="card fav-item" data-favcard data-hay="${escapeHtml(hay)}" style="margin-bottom:12px">
      <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:8px">
        <div style="font-weight:600;flex:1;min-width:0">${mdInline(f.question)}</div>
        <button class="fav-star on" type="button" data-unfav="${escapeHtml(f.id)}" title="取消收藏" aria-pressed="true">★</button>
      </div>
      <ol style="margin:0 0 10px;padding-left:20px;color:var(--text-2)">${opts}</ol>
      ${f.explanation ? `<details><summary class="sub" style="cursor:pointer">解析</summary><div class="q-expl correct" style="margin-top:8px">${mdFull(f.explanation)}</div></details>` : ""}
      <div class="sub" style="font-size:11px;margin-top:8px">收藏于 ${new Date(f.savedAt || Date.now()).toLocaleDateString()}</div>
    </div>`;
  };

  view.innerHTML = `
    <div class="page-head">
      <div class="title-wrap"><h1>⭐ 收藏题目</h1><p class="sub">共 ${all.length} 道 · 来自 ${lessonCount} 门课 · 收藏的是题目快照，重生成题目也不会丢</p></div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <input id="fav-search" type="search" placeholder="搜索题目 / 选项 / 解析 / 课程…" value="${escapeHtml(favQuery)}"
        style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:9px;font-size:14px">
    </div>
    <div id="fav-groups">
      ${[...groups.values()].map((g) => `
        <div class="fav-group" data-favgroup style="margin-bottom:22px">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
            <h3 style="margin:0">${escapeHtml(g.title)}</h3>
            <span class="pill">${g.items.length}</span>
            ${g.gone ? `<span class="sub" style="color:var(--red)">课程已删除</span>`
              : `<button class="btn btn-ghost btn-sm" data-openlesson="${escapeHtml(g.lessonId)}">↗ 打开课程 Quiz</button>`}
          </div>
          ${g.items.map(cardHtml).join("")}
        </div>`).join("")}
      <div id="fav-none" class="sub" hidden style="padding:20px;text-align:center">没有匹配的题目</div>
    </div>`;

  // Filtering hides cards instead of re-rendering, so typing never loses focus.
  const applyFilter = () => {
    const q = ($("#fav-search").value || "").trim().toLowerCase();
    favQuery = q;
    let visible = 0;
    view.querySelectorAll("[data-favcard]").forEach((el) => {
      const hit = !q || (el.dataset.hay || "").includes(q);
      el.hidden = !hit;
      if (hit) visible++;
    });
    view.querySelectorAll("[data-favgroup]").forEach((g) => {
      g.hidden = ![...g.querySelectorAll("[data-favcard]")].some((c) => !c.hidden);
    });
    $("#fav-none").hidden = visible > 0;
  };
  $("#fav-search").addEventListener("input", applyFilter);
  if (favQuery) applyFilter();

  view.querySelectorAll("[data-openlesson]").forEach((b) => b.addEventListener("click", () => openLesson(b.dataset.openlesson, "quiz")));

  // Un-starring removes just that card, then the group if it emptied, so the
  // reader keeps their scroll position and search text.
  view.querySelectorAll("[data-unfav]").forEach((b) => b.addEventListener("click", async () => {
    const rec = favItems.find((x) => x.id === b.dataset.unfav);
    if (!rec) return;
    b.disabled = true;
    try {
      const lesson = lessonById.get(rec.lessonId) || { id: rec.lessonId, title: rec.lessonTitle };
      await setFav(lesson, rec, false);
    } catch (err) {
      b.disabled = false;
      toast("取消收藏失败：" + (err.message || err), "error");
      return;
    }
    const card = b.closest("[data-favcard]");
    const group = b.closest("[data-favgroup]");
    if (card) card.remove();
    if (group && !group.querySelector("[data-favcard]")) group.remove();
    toast("已取消收藏");
    if (!favItems.length) { renderFavs(); return; }
    applyFilter();
    const sub = view.querySelector(".page-head .sub");
    if (sub) sub.textContent = `共 ${favItems.length} 道 · 来自 ${view.querySelectorAll("[data-favgroup]").length} 门课 · 收藏的是题目快照，重生成题目也不会丢`;
  }));
}

async function renderFormulas() {
  const prof = studyProfile();
  const allLessons = await db.getAll("lessons").catch(() => []);
  const docs = await db.getAll("formulas").catch(() => []);
  const docById = new Map((docs || []).map((d) => [d.subjectId, d]));
  // A formula answers "what do I compute"; the chapter answers "where does this
  // belong in the course", which is how a student actually looks a formula up
  // before an exam. Every formula already records the lesson it was extracted
  // from, so the chapter is just that lesson's title.
  const lessonTitleById = new Map((allLessons || []).map((l) => [l.id, l.title]));
  const rows = prof.subjects.map((subj) => {
    const lessons = subjectLessonData(allLessons, subj.id);
    const withPoints = lessons.filter((l) => (l.points || []).length);
    return { subj, lessons, withPoints, doc: docById.get(subj.id) || null };
  }).filter((r) => r.lessons.length || r.doc);
  const totalFormulas = rows.reduce((n, r) => n + ((r.doc && r.doc.formulas) || []).length, 0);
  const totalChem = rows.reduce((n, r) => n + ((r.doc && r.doc.formulas) || []).filter(isReactionEntry).length, 0);
  const totalMath = totalFormulas - totalChem;
  // Folded subjects are remembered per browser, the same way the per-point English
  // toggle is: hiding a subject is a reading preference, not a one-off click.
  const collapsedSubjects = new Set(loadFoldedSubjects());
  const foldable = rows.filter((r) => ((r.doc && r.doc.formulas) || []).length).length;
  // Chapter grouping is a reading preference, so it is remembered like the fold.
  const groupMode = formulaGroupMode();
  const groupable = rows.some((r) => {
    const items = (r.doc && r.doc.formulas) || [];
    return new Set(items.map((f) => (f.src && f.src.lessonId) || "")).size > 1;
  });

  const cards = rows.map((r) => {
    const doc = r.doc;
    const items = (doc && doc.formulas) || [];
    // Lessons with points that are not yet folded into this subject's library:
    // the signal that a freshly uploaded chapter still needs extracting.
    const covered = new Set((doc && doc.lessonIds) || []);
    const pending = r.withPoints.filter((l) => !covered.has(l.id));
    // Chapters this subject draws formulas from, with an inline rename: the title
    // came from the uploaded file name, and it is what the badges below show.
    const chapterIds = new Map();
    for (const l of r.withPoints) chapterIds.set(l.title, l.id);
    const chapters = [...new Set(items.map((f) => f.src && f.src.lessonId ? (lessonTitleById.get(f.src.lessonId) || "") : "").filter(Boolean))];
    // The fallback subject earns a word of explanation: a lesson lands here when its
    // title matches no keyword, which otherwise looks like a formula-library bug.
    const isGeneral = ((subjectById("general") || {}).id || "general") === r.subj.id;
    // How many BATCHES are still outstanding, computed the same way the extraction
    // itself decides what to send — so the number shown is the number that will run.
    const allChunks = chunkEntries(subjectPointNotes(r.withPoints));
    const allChunkIds = allChunks.map((c) => chunkId(c));
    const doneSet = seedDoneChunks(allChunks, allChunkIds, doc);
    const remaining = allChunks.filter((c, i) => !doneSet.has(allChunkIds[i])).length;
    // Formulas written by an older prompt have no 常用场景 and no example
    // commentary. Nothing tells the user that, and incremental extraction can
    // never reach them (their lessons are already "covered"), so the library
    // silently stays on the old, weaker format. Count them and say so.
    const stale = items.filter((f) => !f.scenarios || !(f.examples || []).length || (f.examples || []).some((e) => !e.why)).length;
    // Which chapter a formula belongs to: the lesson it was extracted from. With
    // no source point there is no lessonId, so fall back to the subject's only
    // lesson if there is exactly one — with several, guessing would be wrong.
    const chapterOf = (f) => {
      const fromSrc = f.src && lessonTitleById.get(f.src.lessonId);
      if (fromSrc) return fromSrc;
      return r.withPoints.length === 1 ? r.withPoints[0].title : "";
    };
    const btn = !r.withPoints.length
      ? `<span class="sub">先给它下面的课生成知识点</span>`
      : (!doc
        ? `<button class="btn btn-accent btn-sm" data-gen-formula="${escapeHtml(r.subj.id)}">✨ 提取公式</button>`
        : (remaining
          ? `<button class="btn btn-accent btn-sm" data-gen-formula="${escapeHtml(r.subj.id)}" data-incremental="1">＋ 补齐 ${remaining} 批${pending.length ? `（${pending.length} 门课）` : ""}</button>
             <button class="btn btn-ghost btn-sm" data-gen-formula="${escapeHtml(r.subj.id)}">↻ 全部重提取</button>`
          : `<button class="btn ${stale ? "btn-accent" : "btn-ghost"} btn-sm" data-gen-formula="${escapeHtml(r.subj.id)}">${stale ? "↻ 升级重提取" : "↻ 重新提取"}</button>`));
    // One subject per fold. With several subjects the page became a very long
    // scroll dominated by whichever library was opened last, so each subject
    // collapses to a single header line and the state is remembered.
    const folded = collapsedSubjects.has(r.subj.id);
    // The table holds formulas you can compute with; reaction schemes are kept,
    // but in their own block below it so they stop burying the formulas.
    const mathItems = items.filter((f) => !isReactionEntry(f));
    const chemItems = items.filter(isReactionEntry);
    return `
      <div class="card formula-group" data-group="${escapeHtml(r.subj.id)}">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" data-fold="${escapeHtml(r.subj.id)}" title="${folded ? "展开" : "收起"}这个学科" style="padding:2px 8px;font-size:13px">${folded ? "▸" : "▾"}</button>
          <h3 style="margin:0;cursor:pointer" data-fold="${escapeHtml(r.subj.id)}">📚 ${escapeHtml(r.subj.name)}</h3>
          <span class="sub">${r.lessons.length} 门课 · ${r.withPoints.length} 门已有知识点 · ${mathItems.length} 个公式${chemItems.length ? ` · ${chemItems.length} 个化学式（另列）` : ""}${folded && items.length ? "（已收起）" : ""}</span>
          <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap">${btn}</div>
        </div>
        ${remaining ? `<div class="sub" data-fold-warn style="margin-top:7px;font-size:12.5px;color:var(--amber,#b45309)${folded ? ";display:none" : ""}">⚠️ 还有 ${remaining}/${allChunks.length} 批没有提取成功${pending.length ? `（${pending.map((l) => escapeHtml(l.title)).join("、")}）` : ""} —— 点「补齐 ${remaining} 批」只补这些，已完成的批次不会重跑、也不会重复收费。</div>` : ""}
        ${stale ? `<div class="sub" data-fold-warn style="margin-top:7px;font-size:12.5px;color:var(--amber,#b45309)${folded ? ";display:none" : ""}">⚠️ 有 ${stale}/${items.length} 个公式是旧版格式（缺「常用场景」或例题「考什么」）：例题多为机械代公式，不含真实考题思路。点「↻ 升级重提取」重新生成即可补全。</div>` : ""}
        ${chapters.length ? `<div class="sub" data-fold-warn style="margin-top:6px;font-size:12px${folded ? ";display:none" : ""}">📕 章节：${chapters.map((t) => {
          const lid = chapterIds.get(t);
          return `${escapeHtml(t)}${lid ? ` <button class="chip" data-rename-lesson="${lid}" title="重命名这一章（课程标题）" style="font-size:12px;padding:3px 7px">✎</button>` : ""}`;
        }).join(" ｜ ")}</div>` : ""}
        ${doc && doc.generatedAt ? `<div class="sub" data-fold-warn style="margin-top:6px;font-size:12px${folded ? ";display:none" : ""}">更新于 ${new Date(doc.generatedAt).toLocaleString()}</div>` : ""}
        ${isGeneral ? `<div class="sub" data-fold-warn style="margin-top:6px;font-size:12px;color:var(--amber,#b45309)${folded ? ";display:none" : ""}">「通用」是兜底学科：这些课的标题没有匹配到任何学科关键词（${r.withPoints.map((l) => escapeHtml(l.title)).join("、")}）。改法二选一 —— 在课程页把「学科」下拉框手动指定，或点上面的 ✎ 重命名时把学科名写进标题（例如「生物化学 第一章 …」）。</div>` : ""}
        <div class="formula-body"${folded ? ` style="display:none"` : ""} data-lesson-order="${escapeHtml(JSON.stringify(r.withPoints.map((l) => l.title)))}">
          ${mathItems.length ? `<div style="margin-top:14px" data-formula-grid>${mathItems.map((f, i) => formulaCard(f, i, r.subj.id, chapterOf(f))).join("")}</div>`
            : `<div class="sub" style="margin-top:10px">${items.length ? "这个学科目前只有化学式，没有可计算的公式——见下方「化学反应式」。" : `还没有提取公式${r.withPoints.length ? "——点右上角按钮，AI 会从该学科的知识点里整理出公式、用法和例题。" : "。"}`}</div>`}
          ${chemItems.length ? `<details class="chem-block" style="margin-top:16px">
            <summary class="sub" style="cursor:pointer;font-weight:600;padding:9px 12px;background:var(--surface);border-radius:8px">⚗️ 化学反应式与转运化学计量（${chemItems.length} 条 · 点开看）</summary>
            <div class="sub" style="margin:8px 0 0;font-size:12px">反应式、泵与转运体的化学计量、构象循环等非计算类条目——已从上面的公式表中分出，避免和数学公式混在一起。</div>
            <div class="chem-body" style="margin-top:10px">${chemItems.map((f, i) => formulaCard(f, i, r.subj.id, chapterOf(f))).join("")}</div>
          </details>` : ""}
        </div>
      </div>`;
  }).join("");

  $("#view").innerHTML = `
    <div class="page-head">
      <div class="title-wrap">
        <h1>📐 公式库</h1>
        <p class="sub">按学科汇总所有学过的公式：含义、符号、适用条件、常用场景，以及每个公式 3 道考试风格例题 + 1 道真题演练。化学方程式与转运化学计量不计入公式表，另列在各学科下方。${totalFormulas ? `共 ${totalMath} 个公式${totalChem ? ` · ${totalChem} 个化学式` : ""}。` : ""}</p>
      </div>
      ${totalFormulas >= 6 ? `<input id="formula-search" class="input" type="search" placeholder="搜索公式、符号或场景…" style="max-width:280px">
        <div id="formula-search-note" class="sub" style="font-size:12px;flex-basis:100%"></div>` : ""}
      ${foldable >= 2 ? `<button id="formula-fold-all" class="btn btn-ghost btn-sm" title="把每个学科收成一行">▸ 全部收起</button>
      <button id="formula-unfold-all" class="btn btn-ghost btn-sm" title="展开每个学科">▾ 全部展开</button>` : ""}
      ${groupable ? `<button id="formula-group-toggle" class="btn btn-ghost btn-sm" title="按公式所属的章节分组（章节顺序＝课程顺序）">${groupMode === "chapter" ? "📕 按章节分组" : "📄 平铺列表"}</button>` : ""}
      ${totalFormulas ? `<button id="formula-print" class="btn btn-ghost btn-sm" title="打印或存成 PDF（会自动展开所有答案）">🖨 打印公式表</button>` : ""}
    </div>
    ${rows.length ? cards : emptyState("📐", "还没有可汇总的课程。先上传课件并生成知识点。")}`;

  // Fold / unfold one subject. Kept in the DOM rather than re-rendering: folding is
  // a visibility change, and a re-render would collapse <details> the user opened
  // and lose the scroll position.
  // Re-apply the chosen listing to every subject. Runs on first paint too, so a
  // remembered "按章节分组" is already in effect when the page appears.
  const applyGroupMode = () => {
    const chapterMode = formulaGroupMode() === "chapter";
    $("#view").querySelectorAll(".formula-body").forEach((body) => {
      const grid = body.querySelector("[data-formula-grid]");
      // Flat view: the cards are the same elements, so put them back in the grid
      // in the order they are currently shown and drop the sections.
      body.querySelectorAll(".formula-chapter").forEach((d) => {
        if (!chapterMode && grid) {
          const inner = d.querySelector(".formula-chapter-body");
          if (inner) [...inner.children].forEach((c) => grid.appendChild(c));
        }
        d.remove();
      });
      if (chapterMode) groupFormulaCardsByChapter(body);
    });
  };
  applyGroupMode();

  const applyFold = (sid, folded) => {
    // Match by dataset rather than building a selector: no escaping to get wrong.
    const group = [...$("#view").querySelectorAll(".formula-group")].find((g) => g.dataset.group === sid);
    if (!group) return;
    const body = group.querySelector(".formula-body");
    const caret = group.querySelector("[data-fold]");
    const count = group.querySelector(".sub");
    if (body) body.style.display = folded ? "none" : "";
    if (caret) caret.textContent = folded ? "▸" : "▾";
    const warn = group.querySelectorAll('[data-fold-warn]');
    warn.forEach((w) => { w.style.display = folded ? "none" : ""; });
    if (count) {
      const base = count.dataset.base || count.textContent.replace("（已收起）", "");
      count.dataset.base = base;
      count.textContent = base + (folded ? "（已收起）" : "");
    }
  };
  $("#view").querySelectorAll("[data-fold]").forEach((el) => el.addEventListener("click", () => {
    const sid = el.dataset.fold;
    const nowFolded = !collapsedSubjects.has(sid);
    if (nowFolded) collapsedSubjects.add(sid); else collapsedSubjects.delete(sid);
    saveFoldedSubjects(collapsedSubjects);
    applyFold(sid, nowFolded);
  }));
  const foldAllBtn = $("#formula-fold-all");
  if (foldAllBtn) foldAllBtn.addEventListener("click", () => {
    rows.forEach((r) => { if (((r.doc && r.doc.formulas) || []).length) { collapsedSubjects.add(r.subj.id); applyFold(r.subj.id, true); } });
    saveFoldedSubjects(collapsedSubjects);
  });
  const unfoldAllBtn = $("#formula-unfold-all");
  if (unfoldAllBtn) unfoldAllBtn.addEventListener("click", () => {
    rows.forEach((r) => { collapsedSubjects.delete(r.subj.id); applyFold(r.subj.id, false); });
    saveFoldedSubjects(collapsedSubjects);
  });

  const groupBtn = $("#formula-group-toggle");
  if (groupBtn) groupBtn.addEventListener("click", () => {
    const next = formulaGroupMode() === "chapter" ? "flat" : "chapter";
    saveFormulaGroupMode(next);
    groupBtn.textContent = next === "chapter" ? "📕 按章节分组" : "📄 平铺列表";
    applyGroupMode();
    // Keep the search filter honest: hiding a card also has to hide the chapter
    // section it now lives in (the sections are created after the search ran).
    const box = $("#formula-search");
    if (box && box.value.trim()) box.dispatchEvent(new Event("input"));
  });

  // Print / save as PDF. The print stylesheet expands every <details> so the
  // worked solutions land on the sheet rather than hiding behind a toggle that
  // does not exist on paper.
  const printBtn = $("#formula-print");
  if (printBtn) printBtn.addEventListener("click", () => window.print());

  // Filter formula cards by free text. Worth having once a subject passes a
  // handful of formulas — scanning 40 cards by eye is how formulas get missed.
  const searchBox = $("#formula-search");
  if (searchBox) {
    searchBox.addEventListener("input", () => {
      const q = searchBox.value.trim().toLowerCase();
      let shown = 0;
      // A folded subject must not hide a hit: while a query is active every body is
      // shown, and clearing the box restores each subject's own fold state.
      $("#view").querySelectorAll(".formula-body").forEach((b) => {
        const group = b.closest(".formula-group");
        const sid = group && group.dataset.group;
        b.style.display = (q || !collapsedSubjects.has(sid)) ? "" : "none";
      });
      $("#view").querySelectorAll(".formula-card").forEach((el) => {
        const hit = !q || (el.dataset.search || "").includes(q);
        el.style.display = hit ? "" : "none";
        if (hit) shown++;
      });
      // The chemical block is closed by default, so a hit inside it would be
      // invisible: open it while a query is active and restore it afterwards.
      $("#view").querySelectorAll("details.chem-block").forEach((d) => {
        const any = [...d.querySelectorAll(".formula-card")].some((el) => el.style.display !== "none");
        if (q) d.open = any || d.open;
      });
      $("#view").querySelectorAll(".formula-group").forEach((g) => {
        const any = [...g.querySelectorAll(".formula-card")].some((el) => el.style.display !== "none");
        g.style.display = any ? "" : "none";
      });
      // Chapter sections: a section whose cards are all filtered out must go too,
      // and a folded section has to open so its hits are actually visible.
      $("#view").querySelectorAll("details.formula-chapter").forEach((d) => {
        const any = [...d.querySelectorAll(".formula-card")].some((el) => el.style.display !== "none");
        d.style.display = any ? "" : "none";
        if (q && any) d.open = true;
      });
      const note = $("#formula-search-note");
      if (note) note.textContent = q ? `匹配 ${shown} / ${totalFormulas} 个条目（已自动展开收起的学科与化学式）` : "";
    });
  }

  // Jump from a formula back to the knowledge point that explains it. The link
  // closes the loop: a formula alone says what to compute, not why it holds.
  // Bound per button, not delegated from #view: #view survives innerHTML
  // replacement, so a listener added there would stack up on every re-render.
  $("#view").querySelectorAll("[data-src-lesson]").forEach((b) => b.addEventListener("click", () => {
    openPoint(b.dataset.srcLesson, Number(b.dataset.srcIdx) || 0);
  }));

  // Rename a chapter straight from the formula library. It is the same lesson title
  // shown on the Lessons page and in every chapter badge, so re-render afterwards to
  // refresh the badges.
  $("#view").querySelectorAll("[data-rename-lesson]").forEach((b) => b.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    if (await renameLesson(b.dataset.renameLesson)) {
      toast("已重命名（课程标题已更新，章节徽章同步）", "success");
      renderFormulas();
    }
  }));

  // Turn a formula into a flashcard. The library alone is passive — you read a
  // formula and it feels familiar without being recallable. Pushing it into the
  // existing SM-2 queue is what makes it stick, and it adds no new machinery:
  // the scheduler, the review view and the Anki export already handle cards.
  $("#view").querySelectorAll("[data-make-card]").forEach((b) => b.addEventListener("click", async () => {
    const sid = b.dataset.makeCard;
    const doc = await db.get("formulas", sid).catch(() => null);
    const f = doc && (doc.formulas || [])[Number(b.dataset.cardIdx)];
    if (!f) return;
    const existing = (await db.getAll("cards").catch(() => [])) || [];
    const front = formulaCardFront(f);
    if (existing.some((c) => c && c.front === front)) {
      b.textContent = "✅ 已在复习队列";
      b.disabled = true;
      toast("这张闪卡已经在复习队列里了", "");
      return;
    }
    const lessons = subjectLessonData(await db.getAll("lessons").catch(() => []), sid);
    const lessonId = (f.src && f.src.lessonId) || (lessons[0] || {}).id || null;
    await db.bulkPut("cards", [newCard({ lessonId, front, back: formulaCardBack(f), source: "公式库" })]);
    b.textContent = "✅ 已加入复习";
    b.disabled = true;
    toast("已加入闪卡队列 —— 以后按间隔重复出现，直到你回想得出来", "success");
  }));

  $("#view").querySelectorAll("[data-gen-formula]").forEach((b) => b.addEventListener("click", async () => {
    const sid = b.dataset.genFormula;
    const incremental = b.dataset.incremental === "1";
    const name = (subjectById(sid) || {}).name || sid;
    if (!(await requireTextKey())) return;
    const pm = progressPanel(`${name} · ${incremental ? "纳入新课程" : "提取公式"}`);
    const res = await generateSubjectFormulas(sid, pm, { incremental });
    if (!res.ok) { pm.fail(res.reason); toast(res.reason, "error"); return; }
    if (res.hadError) {
      // Say it plainly: the run finished but part of it produced nothing, and those
      // chapters are still waiting. Staying quiet here is what hid a whole chapter.
      pm.done(`${res.count} 个公式（有批次失败）`, "查看公式库", () => renderFormulas());
      toast("⚠️ 有批次没能解析出公式：本次结果已保留原库，失败的部分下次可以再试。", "error");
      renderFormulas();
      return;
    }
    pm.done(`${res.count} 个公式${incremental ? `（新增 ${res.added}）` : ""}`, "查看公式库", () => renderFormulas());
    toast(incremental ? `✅ 新增 ${res.added} 个公式，共 ${res.count} 个` : `✅ 已整理 ${res.count} 个公式（含场景与例题）`, "success");
    renderFormulas();
  }));
}

// Render a bare LaTeX string as a display formula.
// It must go through mdFull(): that is what pulls formulas out before HTML
// escaping and hands them to KaTeX. Inserting "$$latex$$" straight into
// innerHTML would show the raw source, and escaping it first would corrupt any
// LaTeX containing <, > or &.
function formulaBlock(latex) {
  const tex = String(latex || "").trim();
  if (!tex) return "";
  return mdFull("$$" + tex + "$$");
}

// A parameter's symbol arrives as raw LaTeX ("\frac{dC}{dx}", "K_m") or as plain
// words ("outward-open ↔ inward-open", "3.8 Å"). mdInline only typesets what is
// delimited by $...$, so an undelimited "\frac{dC}{dx}" was rendered as literal
// source text in the card. Wrap the ones that really are math — but NOT prose,
// which would be typeset as a run of italic variables with the spaces dropped.
function paramSymbolHtml(sym) {
  const t = String(sym || "").trim();
  if (!t) return "";
  if (/\$/.test(t)) return mdInline(t);
  const isTex = /\\[a-zA-Z]+/.test(t) || (/^[A-Za-z0-9_^{}()+\-*/.\sΔδμσπ]+$/.test(t) && /[_^]/.test(t));
  return mdInline(isTex ? "$" + t + "$" : t);
}

// Front/back for the "make a flashcard" button. The front must NOT contain the
// formula, or it is a recognition task rather than a recall one: it names the
// formula and gives the situation it applies to, and the back carries the
// relation plus the symbols needed to read it.
function firstSentence(s) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const m = t.match(/^.{4,90}?[。.；;!?！？]/);
  return m ? m[0] : t.slice(0, 90);
}

function formulaCardFront(f) {
  const hint = firstSentence(f.usage) || firstSentence(f.scenarios);
  return `写出这个公式：${f.name || ""}${hint ? "\n（适用情形：" + hint + "）" : ""}`;
}

function formulaCardBack(f) {
  return [
    "$$" + String(f.latex || "").trim() + "$$",
    f.symbols ? "**符号**：" + f.symbols : "",
    f.conditions ? "**适用条件**：" + f.conditions : "",
  ].filter(Boolean).join("\n\n");
}

/* Chapter sections for the formula library.
 *
 * The library already knew each formula's chapter (f.src.lessonId -> the lesson
 * title) and showed it as a badge, but every formula of a subject then sat in one
 * flat list ordered by the extraction, so a 60-formula subject was unscannable
 * and "which chapter is this from" had to be read off each card.
 *
 * Grouping is done on the existing cards rather than by re-rendering, because the
 * same card elements are also what the search box filters: one set of cards, two
 * views over it. Chapters keep the order the course was studied in (the order of
 * the lessons), and formulas without a source lesson fall into a trailing
 * "未归入章节" section instead of being hidden.
 */
function groupFormulaCardsByChapter(body) {
  const grid = body.querySelector("[data-formula-grid]");
  if (!grid) return;
  const cards = [...grid.querySelectorAll(".formula-card")];
  // The chapter order is the lesson order: the sections must read like the course.
  const lessons = JSON.parse(body.dataset.lessonOrder || "[]");
  const rank = new Map(lessons.map((t, i) => [t, i]));
  const sections = new Map();
  cards.forEach((c) => {
    const key = c.dataset.chapter || "";
    if (!sections.has(key)) sections.set(key, []);
    sections.get(key).push(c);
  });
  const keys = [...sections.keys()].sort((a, b) => {
    if (!a) return 1;                       // un-filed formulas go last
    if (!b) return -1;
    const ra = rank.has(a) ? rank.get(a) : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(b) ? rank.get(b) : Number.MAX_SAFE_INTEGER;
    return (ra - rb) || a.localeCompare(b);
  });
  grid.querySelectorAll(".formula-chapter").forEach((el) => el.remove());
  grid.querySelectorAll(".formula-card").forEach((el) => el.remove());
  keys.forEach((key) => {
    // A formula added before its chapter is uploaded has no lesson title: keep it
    // visible and labelled rather than silently dropping it from the library.
    const inner = sections.get(key).map((c) => c.outerHTML).join("");
    const head = key
      ? `<div class="formula-chapter-name">📕 ${mdInline(key)}</div>`
      : `<div class="formula-chapter-name">📎 未归入章节</div>`;
    grid.insertAdjacentHTML("beforeend",
      `<details class="formula-chapter" data-chapter="${escapeHtml(key)}" open>`
      + `<summary>${head}<span class="formula-chapter-count">${sections.get(key).length} 个</span></summary>`
      + `<div class="formula-chapter-body">${inner}</div></details>`);
  });
}

function formulaCard(f, i, subjectId, chapter) {
  const ex = f.examples || [];
  // The card carries its chapter as data so grouping / filtering can read it back
  // off the DOM without re-deriving it (and so a 100-card subject costs nothing
  // extra to group).
  const chapterKey = String(chapter || "");
  // Plain-text index for the search box: everything the user might remember about
  // a formula, so they can find it without recalling its name.
  const searchText = [
    f.name, f.latex, f.symbols, f.usage, f.conditions, f.scenarios, chapter || "",
    ...ex.flatMap((e) => [e.q, e.work, e.answer, e.why]),
    f.examQuestion ? [f.examQuestion.q, f.examQuestion.answer, f.examQuestion.point].join(" ") : "",
    ...(f.params || []).flatMap((p) => [p.symbol, p.name, p.role, p.changes, p.typical]),
  ].filter(Boolean).join(" ").toLowerCase();
  return `
    <div class="card formula-card" data-search="${escapeHtml(searchText)}" data-chapter="${escapeHtml(chapterKey)}" style="margin:10px 0;background:var(--surface-2)">
      <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
        <b style="font-size:15px">${i + 1}. ${mdInline(f.name || "")}</b>
        ${chapter ? `<span class="sub" title="来自这节课：${escapeHtml(chapter)}" style="font-size:11.5px;padding:2px 8px;border:1px solid var(--border);border-radius:999px;background:var(--surface)">📕 ${mdInline(chapter)}</span>` : ""}
        ${f.src ? `<button class="btn btn-ghost btn-sm" data-src-lesson="${escapeHtml(f.src.lessonId)}" data-src-idx="${f.src.idx}" title="跳到讲解这个公式的知识点" style="font-size:11.5px;padding:2px 8px">📖 ${mdInline(f.src.title)}</button>` : ""}
        <button class="btn btn-ghost btn-sm" data-make-card="${escapeHtml(subjectId)}" data-card-idx="${i}" title="把「看公式」变成「想公式」：加入间隔重复复习队列" style="margin-left:auto;font-size:11.5px;padding:2px 8px">🎴 做成闪卡</button>
      </div>
      <div style="margin:10px 0;padding:10px 14px;background:var(--surface);border-radius:9px;overflow-x:auto">
        ${formulaBlock(f.latex)}
      </div>
      ${f.symbols ? `<div class="sub" style="margin-bottom:6px"><b>符号：</b>${mdInline(f.symbols)}</div>` : ""}
      ${f.usage ? `<div class="sub" style="margin-bottom:6px"><b>用法：</b>${mdInline(f.usage)}</div>` : ""}
      ${f.conditions ? `<div class="sub" style="margin-bottom:6px"><b>适用条件：</b>${mdInline(f.conditions)}</div>` : ""}
      ${(() => {
        // Filter here as well as on write: a library saved by an earlier version
        // can already contain content-free entries, and they must not render.
        const ps = (f.params || []).filter((p) => p && (p.role || p.changes || p.typical));
        if (!ps.length) return "";
        return `<div style="margin:9px 0;padding:9px 12px;background:var(--surface);border-left:3px solid var(--amber,#b45309);border-radius:0 8px 8px 0">
        <b>🔍 参数详解</b><div class="sub" style="font-size:12px;margin-top:2px">每个系数的含义、用处，以及什么情况会让它变</div>
        <div style="margin-top:8px">
          ${ps.map((p) => (p.changes || p.typical)
            ? `
            <div style="padding:8px 0;border-top:1px dashed var(--border)">
              <div><b>${paramSymbolHtml(p.symbol)}</b>${p.name ? ` <span class="sub">${mdInline(p.name)}</span>` : ""}${p.typical ? ` <span class="sub" style="font-size:12px">· 常见量级：${mdInline(p.typical)}</span>` : ""}</div>
              ${p.role ? `<div class="sub" style="margin-top:4px;font-size:12.5px"><b>含义与用处：</b>${mdInline(p.role)}</div>` : ""}
              ${p.changes ? `<div class="sub" style="margin-top:3px;font-size:12.5px"><b>会因什么改变：</b>${mdInline(p.changes)}</div>` : ""}
            </div>`
            : `
            <div class="sub" style="padding:5px 0;border-top:1px dashed var(--border);font-size:12.5px">
              <b>${paramSymbolHtml(p.symbol)}</b>${p.name ? ` ${mdInline(p.name)}` : ""}${p.role ? ` —— ${mdInline(p.role)}` : ""}
            </div>`).join("")}
        </div>
      </div>`;
      })()}
      ${f.scenarios ? `<div class="sub" style="margin:9px 0;padding:9px 12px;background:var(--surface);border-left:3px solid var(--brand);border-radius:0 8px 8px 0"><b>📍 常用场景</b><div style="margin-top:4px">${mdFull(f.scenarios)}</div></div>` : ""}
      ${ex.length ? `<details style="margin-top:8px">
        <summary class="sub" style="cursor:pointer;font-weight:600">📝 考试风格例题（${ex.length} 道，点开看解法）</summary>
        <div style="margin-top:8px">
          ${ex.map((e, j) => `
            <div style="padding:9px 12px;background:var(--surface);border-radius:8px;margin-bottom:8px">
              <div><b>例${j + 1}.</b> ${mdFull(e.q)}</div>
              ${e.work ? `<div class="sub" style="margin-top:6px;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;white-space:pre-wrap">${mdFull(e.work)}</div>` : ""}
              ${e.answer ? `<div style="margin-top:5px;color:var(--green);font-weight:600">→ ${mdInline(e.answer)}</div>` : ""}
              ${e.why ? `<div class="sub" style="margin-top:5px;font-size:12px;opacity:.85">考什么：${mdInline(e.why)}</div>` : ""}
            </div>`).join("")}
        </div>
      </details>` : `<div class="sub" style="margin-top:6px">（没有例题——重新提取可补上）</div>`}
      ${f.examQuestion ? `
      <div style="margin-top:10px;padding:11px 13px;border:1.5px dashed var(--brand);border-radius:9px;background:var(--surface)">
        <div style="font-weight:700;margin-bottom:7px">🎯 真题演练 <span class="sub" style="font-weight:400">（先自己做，再展开对答案）</span></div>
        <div>${mdInline(f.examQuestion.q)}</div>
        <details style="margin-top:9px">
          <summary class="sub" style="cursor:pointer;font-weight:600">👁 展开解法与答案</summary>
          <div style="margin-top:8px">
            ${f.examQuestion.work ? `<div class="sub" style="font-family:ui-monospace,Menlo,monospace;font-size:12.5px;white-space:pre-wrap">${mdInline(f.examQuestion.work)}</div>` : ""}
            ${f.examQuestion.answer ? `<div style="margin-top:6px;color:var(--green);font-weight:700">→ ${mdInline(f.examQuestion.answer)}</div>` : ""}
            ${f.examQuestion.point ? `<div class="sub" style="margin-top:6px;font-size:12px">考点：${mdInline(f.examQuestion.point)}</div>` : ""}
          </div>
        </details>
      </div>` : ""}
    </div>`;
}

async function renderTokenStats() {
  const logs = (await db.getAll("tokenLog").catch(() => [])) || [];
  const byLesson = new Map(); // key -> {title, calls, prompt, completion, total}
  let grand = { calls: 0, prompt: 0, completion: 0, total: 0 };
  logs.forEach((r) => {
    const key = r.lessonId || "other";
    if (!byLesson.has(key)) byLesson.set(key, { title: r.lessonTitle || "未归类", calls: 0, prompt: 0, completion: 0, total: 0 });
    const g = byLesson.get(key);
    g.calls += 1;
    g.prompt += r.prompt_tokens || 0;
    g.completion += r.completion_tokens || 0;
    g.total += r.total_tokens || 0;
    grand.calls += 1;
    grand.prompt += r.prompt_tokens || 0;
    grand.completion += r.completion_tokens || 0;
    grand.total += r.total_tokens || 0;
  });
  const rows = [...byLesson.values()].sort((a, b) => b.total - a.total);
  const maxTotal = Math.max(1, ...rows.map((r) => r.total));
  const fmt = (n) => n.toLocaleString();
  const table = rows.length ? `
    <div class="card" style="padding:0;overflow:auto">
      <table style="width:100%;border-collapse:collapse;font-size:13.5px">
        <thead>
          <tr style="background:var(--surface-2)">
            <th style="text-align:left;padding:10px 14px">课程</th>
            <th style="padding:10px 8px;text-align:right">调用次数</th>
            <th style="padding:10px 8px;text-align:right">输入 tokens</th>
            <th style="padding:10px 8px;text-align:right">输出 tokens</th>
            <th style="padding:10px 14px;text-align:right">总 tokens</th>
            <th style="padding:10px 14px;width:24%"></th>
          </tr>
        </thead>
        <tbody>${rows.map((r) => {
          const bar = Math.round((r.total / maxTotal) * 100);
          return `<tr style="border-top:1px solid var(--border)">
            <td style="padding:10px 14px;font-weight:600">${escapeHtml(r.title)}</td>
            <td style="padding:10px 8px;text-align:right">${r.calls}</td>
            <td style="padding:10px 8px;text-align:right;color:var(--text-2)">${fmt(r.prompt)}</td>
            <td style="padding:10px 8px;text-align:right;color:var(--text-2)">${fmt(r.completion)}</td>
            <td style="padding:10px 14px;text-align:right;font-weight:700">${fmt(r.total)}</td>
            <td style="padding:10px 14px"><div style="background:var(--surface-2);border-radius:6px;height:8px;overflow:hidden"><div style="width:${bar}%;height:100%;background:var(--brand)"></div></div></td>
          </tr>`;
        }).join("")}</tbody>
      </table>
    </div>` : emptyState("🔢", "还没有 token 记录。生成一次笔记后这里会统计每次 AI 调用的 token 用量。");

  $("#view").innerHTML = `
    <div class="page-head">
      <div class="title-wrap"><h1>🔢 Token 统计</h1><p class="sub">每次 AI 生成（知识点/闪卡/题目/配图）消耗的 token，按课程汇总。</p></div>
    </div>
    <div class="grid grid-3" style="margin-bottom:20px">
      <div class="card stat"><div class="stat-num">${fmt(grand.total)}</div><div class="stat-label">总 tokens</div></div>
      <div class="card stat"><div class="stat-num">${fmt(grand.calls)}</div><div class="stat-label">AI 调用次数</div></div>
      <div class="card stat"><div class="stat-num">${fmt(grand.prompt + grand.completion)}</div><div class="stat-label">累计消耗</div></div>
    </div>
    ${table}`;
}

async function renderSearch() {
  // Search indexes question stems and options, which the slim list payload leaves
  // out (the whole bank is megabytes and nothing else at list level needs it), so
  // this one view asks for the full quiz records. It is a deliberate user action,
  // not part of page load.
  const [lessons, cards, quizzes, mistakes] = await Promise.all([
    db.getAll("lessons"), db.getAll("cards"), db.getAllFull("quizzes").catch(() => []), db.getAll("mistakes"),
  ]);
  const idx = buildSearchIndex(lessons, cards, quizzes, mistakes);
  const allTags = [...new Set(idx.flatMap((i) => i.tags || []))].sort();

  $("#view").innerHTML = `
    <div class="page-head">
      <div class="title-wrap"><h1>Search</h1><p class="sub">Search across lessons, key points, flashcards, quiz questions and mistakes.</p></div>
    </div>
    <div class="card" style="margin-bottom:18px">
      <input type="text" id="search-q" placeholder="Search anything… e.g. “heart failure”, “Troponin”, “pharmacology”" autocomplete="off" style="width:100%;padding:13px 15px;border:1.5px solid var(--border);border-radius:11px;font-size:15px;margin-bottom:12px">
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <select id="search-type" class="search-select">
          <option value="all">All types</option>
          ${Object.entries(TYPE_META).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("")}
        </select>
        <select id="search-imp" class="search-select">
          <option value="all">All importance</option>
          <option value="high">High yield</option>
          <option value="medium">Medium</option>
          <option value="low">Low yield</option>
        </select>
        <select id="search-tag" class="search-select" ${allTags.length ? "" : "disabled"}>
          <option value="all">${allTags.length ? "All tags" : "No tags yet"}</option>
          ${allTags.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("")}
        </select>
      </div>
    </div>
    <div id="search-results"></div>`;

  const renderResults = () => {
    const q = $("#search-q").value;
    const type = $("#search-type").value;
    const imp = $("#search-imp").value;
    const tag = $("#search-tag").value;
    const query = q.trim().toLowerCase();
    const hasFilter = query || type !== "all" || imp !== "all" || tag !== "all";
    const filtered = idx.filter((it) => {
      if (type !== "all" && it.type !== type) return false;
      if (imp !== "all" && it.importance !== imp) return false;
      if (tag !== "all" && !(it.tags || []).includes(tag)) return false;
      if (query && !it.text.toLowerCase().includes(query)) return false;
      return true;
    });
    const box = $("#search-results");
    if (!filtered.length) {
      box.innerHTML = emptyState("🔍", hasFilter ? "No matches." : "Type to search your study material.");
      return;
    }
    const groups = {};
    filtered.forEach((it) => (groups[it.type] = groups[it.type] || []).push(it));
    box.innerHTML = Object.entries(groups).map(([type, items]) => `
      <h3 style="margin:16px 0 8px">${TYPE_META[type].ico} ${TYPE_META[type].label} <span class="sub">(${items.length})</span></h3>
      <div class="card" style="padding:6px 14px">${items.slice(0, 50).map(searchResultRow).join("")}</div>`).join("");
    box.querySelectorAll(".search-row").forEach((el) => el.addEventListener("click", () => {
      // Landing on the lesson alone is not "found it": for a knowledge point, jump to
      // that exact point — openPoint expands its groups and flashes the row.
      if (el.dataset.pt != null && el.dataset.pt !== "") openPoint(el.dataset.lesson, Number(el.dataset.pt));
      else openLesson(el.dataset.lesson, el.dataset.tab);
    }));
  };

  $("#search-q").addEventListener("input", renderResults);
  ["#search-type", "#search-imp", "#search-tag"].forEach((sel) => $(sel).addEventListener("change", renderResults));
  renderResults();
}

/* ---------------- Backup / restore ---------------- */
const BACKUP_STORES = ["lessons", "cards", "quizzes", "mistakes", "studyLog"];

async function exportBackup() {
  const data = {};
  for (const s of BACKUP_STORES) data[s] = await db.getAllFull(s);
  const payload = { app: "mbbs-revision", version: 1, exportedAt: new Date().toISOString(), data };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `mbbs-revision-backup-${dayKey(new Date())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  const counts = Object.entries(data).map(([k, v]) => `${v.length} ${k}`).join(", ");
  toast(`Backup downloaded — ${counts}`, "success");
}

async function importBackup(file) {
  const msg = $("#backup-msg");
  let obj;
  try {
    obj = JSON.parse(await file.text());
  } catch {
    toast("Not a valid JSON file.", "error");
    return;
  }
  const data = obj && obj.data && typeof obj.data === "object" ? obj.data : obj;
  const stores = {};
  let total = 0;
  for (const s of BACKUP_STORES) {
    const arr = data[s];
    if (arr == null) continue;
    if (!Array.isArray(arr)) { toast(`Backup field "${s}" is not an array.`, "error"); return; }
    stores[s] = arr;
    total += arr.length;
  }
  if (!total) { toast("No recognizable data in this backup.", "error"); return; }
  if (!confirm(`Import ${total} records?\n\nThis MERGES with your current data — records with the same ID will be overwritten. Continue?`)) return;
  if (msg) msg.textContent = "Importing…";
  try {
    for (const s of BACKUP_STORES) {
      if (stores[s]?.length) await db.bulkPut(s, stores[s]);
    }
    fullLessonCache.clear();
  } catch (e) {
    if (msg) msg.textContent = "";
    toast("Import failed: " + (e.message || e), "error");
    return;
  }
  if (msg) msg.textContent = "Imported ✓";
  const counts = Object.entries(stores).map(([k, v]) => `${v.length} ${k}`).join(", ");
  toast(`Import complete — ${counts}`, "success");
  refreshBadges();
  navigate("dashboard");
}

/* ---------------- Knowledge navigator ---------------- */
function navPointLink(p, lesson) {
  const idx = (lesson.points || []).indexOf(p);
  const imp = p.importance === "high" ? "high" : p.importance === "low" ? "low" : "medium";
  const pct = feynmanPct(p.feynmanStage);
  return `
    <div class="nav-point" data-lesson="${lesson.id}" data-idx="${idx}">
      <span class="imp imp-${imp}" style="font-size:10px;padding:1px 6px">${imp}</span>
      <span class="nav-point-title">${mdInline(p.title)}</span>
      ${p.feynmanStage != null ? `<span class="pill ${pct >= 67 ? "pill-brand" : pct >= 33 ? "pill-amber" : "pill-gray"}" style="font-size:10px;padding:1px 7px">🎓 ${pct}%</span>` : ""}
    </div>`;
}

function renderNavTree(node, lesson, depth) {
  let html = "";
  if (node.name) {
    if (depth === 1) html += `<div class="nav-l1">${escapeHtml(node.name)}</div>`;
    else if (depth === 2) html += `<div class="nav-l2">${escapeHtml(node.name)}</div>`;
    else html += `<div class="nav-l3">${escapeHtml(node.name)}</div>`;
  }
  if ((node.points || []).length) {
    html += `<div class="nav-points">${node.points.map((p) => navPointLink(p, lesson)).join("")}</div>`;
  }
  if ((node.children || []).length) {
    html += `<div class="nav-children">${node.children.map((c) => renderNavTree(c, lesson, depth + 1)).join("")}</div>`;
  }
  return html;
}

async function openPoint(lessonId, idx) {
  await openLesson(lessonId, "points", { restore: false });
  const focus = () => {
    const el = document.getElementById("kp-" + idx);
    if (!el) return false;
    // Expand every collapsed group that contains the target so it's visible.
    document.querySelectorAll("details.kp-group").forEach((d) => { if (d.contains(el)) d.open = true; });
    // If there's a tab body, also expand any groups above the point.
    const body = document.getElementById("tab-body");
    if (body) body.querySelectorAll("details.kp-group").forEach((d) => { if (d.contains(el)) d.open = true; });
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.classList.add("kp-flash");
    setTimeout(() => el.classList.remove("kp-flash"), 2200);
    return true;
  };
  // Retry while the render settles. The old window was ~1.5s, which a large lesson
  // (fetch the full record, then lay out and typeset hundreds of points) can easily
  // exceed — and failure was silent, so the jump simply appeared to do nothing.
  // Give it ~6s and say so if it still cannot find the row.
  let tries = 0;
  const attempt = () => {
    if (focus()) return;
    if (++tries < 40) setTimeout(attempt, 150);
    else toast("没能定位到那个知识点（页面可能还在加载，稍后重试即可）", "");
  };
  requestAnimationFrame(attempt);
  setTimeout(attempt, 120);
}

async function openSlide(lessonId, slideIndex) {
  await openLesson(lessonId, "slides", { restore: false });
  requestAnimationFrame(() => {
    const el = document.getElementById("slide-" + slideIndex);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.classList.add("kp-flash");
      setTimeout(() => el.classList.remove("kp-flash"), 2200);
    }
  });
}

async function renderKnowledgeNav() {
  const [lessons, cards, quizzes] = await Promise.all([
    db.getAllLite("lessons"), db.getAllLite("cards"), db.getAll("quizzes"),
  ]);
  const mastery = computeMasteryMap(lessons, cards, quizzes);
  const withPoints = lessons.filter((l) => (l.points || []).length).sort((a, b) => b.createdAt - a.createdAt);

  $("#view").innerHTML = `
    <div class="page-head">
      <div class="title-wrap"><h1>知识导航</h1><p class="sub">按课程浏览全部知识点——点击课程展开分类树，点击知识点直接跳转。</p></div>
      <button class="btn btn-ghost" id="btn-nav-expand-all" data-state="collapsed">📂 全部展开</button>
    </div>
    <div class="grid">${withPoints.length ? withPoints.map((l) => `
      <div class="card nav-lesson" style="padding:14px 18px">
        <div class="nav-lesson-head" data-lesson="${l.id}" style="display:flex;align-items:center;gap:10px;cursor:pointer">
          <span class="nav-arrow">▸</span>
          <span style="font-weight:700">${escapeHtml(l.title)}</span>
          <span class="sub" style="margin-left:auto">${(l.points || []).length} points · ${mastery[l.id]?.pct ?? 0}%</span>
        </div>
        <div class="nav-lesson-body" hidden style="margin-top:10px">
          ${renderNavTree(buildPointTree(l.points || []), l, 0)}
        </div>
      </div>`).join("") : emptyState("📖", "还没有知识点——先上传课件生成。")}</div>`;

  // Global expand/collapse for every course tree in the knowledge navigation.
  const navExpand = $("#btn-nav-expand-all");
  if (navExpand) {
    navExpand.addEventListener("click", () => {
      const expand = navExpand.dataset.state !== "expanded";
      $("#view").querySelectorAll(".nav-lesson-body").forEach((body) => {
        body.hidden = !expand;
        const head = body.previousElementSibling;
        if (head) head.querySelector(".nav-arrow").textContent = expand ? "▾" : "▸";
      });
      navExpand.dataset.state = expand ? "expanded" : "collapsed";
      navExpand.textContent = expand ? "📂 全部收起" : "📂 全部展开";
    });
  }
  $("#view").querySelectorAll(".nav-lesson-head").forEach((h) => h.addEventListener("click", () => {
    const body = h.nextElementSibling;
    body.hidden = !body.hidden;
    h.querySelector(".nav-arrow").textContent = body.hidden ? "▸" : "▾";
  }));
  $("#view").querySelectorAll(".nav-point").forEach((el) => el.addEventListener("click", () => openPoint(el.dataset.lesson, parseInt(el.dataset.idx, 10))));
}

/* ---------------- Settings ---------------- */
const MODEL_CATALOG = {
  text: [
    { id: "deepseek-flash", name: "DeepSeek V4.1 Flash (官方 · 多模态)", base_url: "https://api.deepseek.com" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro (即将路由到 V4.1)", base_url: "https://api.deepseek.com" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash (旧名, 已指向 V4.1)", base_url: "https://api.deepseek.com" },
    { id: "deepseek-chat", name: "DeepSeek Chat (V3)", base_url: "https://api.deepseek.com" },
    { id: "kimi-k3", name: "Kimi K3 (Moonshot)", base_url: "https://api.moonshot.cn/v1" },
    { id: "kimi-latest", name: "Kimi Latest (Moonshot)", base_url: "https://api.moonshot.cn/v1" },
    { id: "qwen-max", name: "Qwen Max (Alibaba)", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    { id: "qwen3.8-max", name: "Qwen 3.8 Max (Alibaba)", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    { id: "qwen-plus", name: "Qwen Plus (Alibaba)", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    { id: "gpt-4o", name: "GPT-4o (OpenAI)", base_url: "https://api.openai.com/v1" },
  ],
  vision: [
    { id: "deepseek-flash", name: "DeepSeek V4.1 Flash (官方 · 多模态)", base_url: "https://api.deepseek.com" },
    { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision (旧名, 已指向 V4.1)", base_url: "https://api.deepseek.com" },
    { id: "qwen3.7-plus", name: "Qwen 3.7 Plus (Alibaba)", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    { id: "qwen-vl-max", name: "Qwen-VL-Max (Alibaba)", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    { id: "qwen-vl-plus", name: "Qwen-VL-Plus (Alibaba)", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    { id: "qwen3.8-max", name: "Qwen 3.8 Max (Alibaba)", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    { id: "gpt-4o", name: "GPT-4o (OpenAI)", base_url: "https://api.openai.com/v1" },
  ],
};

async function renderSettings() {
  const cfg = await api.getConfig();
  const clsForSettings = await api.getClassification().catch(() => ({ categories: [], manual: {} }));
  const studyProf = { ...DEFAULT_STUDY, ...(cfg.study || {}) };
  if (!Array.isArray(studyProf.subjects) || !studyProf.subjects.length) studyProf.subjects = DEFAULT_STUDY.subjects;
  const field = (key, label) => {
    const v = cfg[key] || {};
    const current = v.model || "";
    const catalog = MODEL_CATALOG[key] || [];
    const opts = catalog.map((m) => {
      const isCur = m.id === current;
      return `<option value="${escapeHtml(m.id)}" data-base="${escapeHtml(m.base_url)}" ${isCur ? "selected" : ""}>${escapeHtml(m.name)}${isCur ? " · ✅当前" : ""}</option>`;
    }).join("");
    const curUnknown = current && !catalog.some((m) => m.id === current);
    return `
      <div class="field">
        <label>${label}</label>
        <input type="text" id="set-${key}-base" value="${escapeHtml(v.base_url || "")}" placeholder="https://...">
        <div style="display:flex;gap:8px;margin-top:8px">
          <select id="set-${key}-sel" class="search-select" style="flex:1;min-width:0">
            <option value="">— 选择模型 —</option>
            ${opts}
            ${curUnknown ? `<option value="${escapeHtml(current)}" data-base="" selected>${escapeHtml(current)} · ✅当前(自定义)</option>` : ""}
            <option value="__custom__">✍ 自定义…</option>
          </select>
          <input type="text" id="set-${key}-model" value="${escapeHtml(current)}" placeholder="model id" style="flex:1;min-width:0">
        </div>
        <div style="margin-top:8px">
          <input type="password" id="set-${key}-key" placeholder="${cfg["has_" + key + "_key"] ? "key saved — leave blank to keep" : "API key"}">
        </div>
        <div class="hint">
          ${cfg["has_" + key + "_key"] ? "✓ key saved (" + (v.api_key || "") + ")" : "No key set yet."}
          <button type="button" class="btn btn-sm btn-ghost" id="set-${key}-refresh" style="margin-left:8px;padding:2px 8px">🔄 拉取厂商模型</button>
        </div>
      </div>`;
  };
  $("#view").innerHTML = `
    <div class="page-head"><div class="title-wrap"><h1>Settings</h1><p class="sub">Configure your AI providers. Everything is stored on the server and synced across your devices.</p></div></div>
    <div class="grid grid-2">
      <div class="card"><h3>🧠 Text model (notes / cards / quiz)</h3><p class="sub" style="margin-bottom:14px">当前: <b>${escapeHtml(cfg.text?.model || "未设置")}</b> · 用于提炼知识点/闪卡/题目</p>${field("text", "Base URL")}</div>
      <div class="card"><h3>🖼 Vision model (figures) — 可选</h3>
        <p class="sub" style="margin-bottom:14px">当前: <b>${escapeHtml(cfg.vision?.model || "未设置")}</b> · 主流程已不用视觉：配图直接取 PDF 内嵌图，图注由 DeepSeek 根据上下文生成；视觉仅用于扫描件 OCR（可选）</p>
        <div class="field">
          <label>视觉模型来源</label>
          <select id="set-vision-provider" class="search-select" style="width:100%">
            ${Object.entries(cfg.vision_presets || {}).map(([pid, p]) => {
              const sel = pid === (cfg.vision_active || "bailian");
              return `<option value="${escapeHtml(pid)}" ${sel ? "selected" : ""}>${escapeHtml(p.label || pid)}${p.api_key ? "" : "（未配置 key）"}</option>`;
            }).join("")}
          </select>
          <div class="hint">选择后，下面的 Base URL / 模型 / key 会切换到该来源；各自独立保存。</div>
        </div>
      ${field("vision", "Base URL")}</div>
    </div>
    <div style="margin-top:20px;display:flex;gap:10px;align-items:center">
      <button class="btn btn-primary btn-lg" id="btn-save">💾 Save settings</button>
      <span class="sub" id="save-msg"></span>
    </div>
    <div class="card" style="margin-top:20px">
      <h3>📚 学科与语言（决定 AI 提炼什么、用什么语言）</h3>
      <p class="sub" style="margin-bottom:12px">每门课可归属一个<b>学科</b>，学科决定 AI 提炼知识点时关注哪些维度（例如生理学偏重机制与调节，生物化学偏重代谢通路与酶动力学）。课程按名称自动匹配，也可在课程页手动指定。</p>
      <div class="grid grid-2">
        <div class="field"><label>站点名称</label>
          <input type="text" id="study-title" value="${escapeHtml(studyProf.site_title || "")}" style="width:100%"></div>
        <div class="field"><label>学习者描述（写进 AI 提示词，如 “an undergraduate science student at Peking University”）</label>
          <input type="text" id="study-learner" value="${escapeHtml(studyProf.learner || "")}" style="width:100%"></div>
      </div>
      <div class="grid grid-2">
        <div class="field"><label>输出语言</label>
          <select id="study-lang" class="search-select" style="width:100%">
            <option value="en" ${studyProf.language === "en" ? "selected" : ""}>English</option>
            <option value="zh" ${studyProf.language === "zh" ? "selected" : ""}>中文</option>
            <option value="bilingual" ${studyProf.language === "bilingual" ? "selected" : ""}>中英双语对照（术语英中并列）</option>
          </select></div>
        <div class="field"><label>自动匹配学科</label>
          <label class="sub" style="display:flex;align-items:center;gap:7px;margin-top:8px">
            <input type="checkbox" id="study-auto" ${studyProf.auto_subject ? "checked" : ""}> 按课程名称自动归属学科
          </label></div>
      </div>
      <div class="field"><label>一键套用预设</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${Object.entries(appConfig?.study_presets || {}).map(([pid, p]) => `<button class="btn btn-sm" data-study-preset="${escapeHtml(pid)}">${escapeHtml(p.label || pid)}</button>`).join("")}
        </div>
        <div class="hint">套用预设会替换下面的学科列表（不影响已上传的课程内容）。</div>
      </div>
      <div class="field"><label>学科列表（JSON，可自行增改；keywords 用于按课程名自动匹配，最长匹配优先）</label>
        <textarea id="study-subjects" rows="12" style="width:100%;resize:vertical;font-family:ui-monospace,Menlo,monospace;font-size:12px">${escapeHtml(JSON.stringify(studyProf.subjects || [], null, 2))}</textarea>
      </div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-primary" id="btn-study-save">💾 保存学科设置</button>
        <span class="sub" id="study-msg"></span>
      </div>
    </div>
    <div class="card" style="margin-top:20px">
      <h3>🎯 Daily goal</h3>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:6px">
        <input type="number" id="goal-min" min="1" max="600" value="${getGoalMinutes()}" style="width:110px;padding:9px 11px;border:1.5px solid var(--border);border-radius:9px;font-size:14px">
        <span class="sub">minutes of focused study per day</span>
        <button class="btn btn-primary btn-sm" id="btn-goal">Save goal</button>
        <span class="sub" id="goal-msg"></span>
      </div>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:10px">
        <input type="number" id="new-per-day" min="1" max="200" value="${getNewCardsPerDay()}" style="width:110px;padding:9px 11px;border:1.5px solid var(--border);border-radius:9px;font-size:14px">
        <span class="sub">new cards introduced per day (prevents overload)</span>
        <button class="btn btn-primary btn-sm" id="btn-newperday">Save limit</button>
        <span class="sub" id="newperday-msg"></span>
      </div>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:10px">
        <input type="number" id="autosave-sec" min="5" max="600" value="${getAutoSaveInterval()}" style="width:110px;padding:9px 11px;border:1.5px solid var(--border);border-radius:9px;font-size:14px">
        <span class="sub">seconds between auto-saves of the page you're on</span>
        <button class="btn btn-primary btn-sm" id="btn-autosave">Save interval</button>
        <span class="sub" id="autosave-msg"></span>
      </div>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:10px">
        <input type="number" id="new-points-per-day" min="1" max="200" value="${getNewPointsPerDay()}" style="width:110px;padding:9px 11px;border:1.5px solid var(--border);border-radius:9px;font-size:14px">
        <span class="sub">new knowledge points introduced per day</span>
        <button class="btn btn-primary btn-sm" id="btn-newpointsperday">Save limit</button>
        <span class="sub" id="newpointsperday-msg"></span>
      </div>
    </div>
    <div class="card" style="margin-top:26px">
      <h3>📂 课程分类（你自己定义的分类体系）</h3>
      <p class="sub" style="margin-bottom:12px">在 Lessons 页面按你的分类分组显示。每个分类可写一个 <b>pattern</b>（正则，不区分大小写），会用它匹配课程标题来自动归类；也可以直接在每张课程卡片右下角手动指定分类。不匹配任何分类时按标题前缀代码（如 CPR63）分组，否则进「📁 其他」。</p>
      <div class="field"><label>分类配置（JSON，可编辑保存）</label>
        <textarea id="clf-json" rows="9" style="width:100%;resize:vertical;font-family:ui-monospace,Menlo,monospace;font-size:12px">${escapeHtml(JSON.stringify(clsForSettings, null, 2))}</textarea>
      </div>
      <div style="display:flex;gap:10px;align-items:center;margin-top:4px">
        <button class="btn btn-accent btn-sm" id="btn-clf-addcat">＋ 快捷添加分类</button>
        <button class="btn btn-primary btn-sm" id="btn-clf-save">💾 保存分类</button>
        <span class="sub" id="clf-msg"></span>
      </div>
      <div id="clf-quick" style="display:none;margin-top:12px;border:1px dashed var(--border);border-radius:10px;padding:12px">
        <div class="field"><label>分类名称（如 CPRS / GIS / IM）</label><input type="text" id="clf-q-name" placeholder="如 CPRS" style="width:100%"></div>
        <div class="field"><label>匹配 pattern（正则，匹配课程标题；留空 = 只用手动指定）</label><input type="text" id="clf-q-pattern" placeholder="如 ^CPR|CPRS" style="width:100%"></div>
        <button class="btn btn-primary btn-sm" id="btn-clf-q-add">添加</button>
      </div>
    </div>
    <div class="card" style="margin-top:26px">
      <h3>How it works</h3>
      <ul class="sub" style="padding-left:20px;line-height:1.8">
        <li>Upload a <b>.pptx</b> or <b>.pdf</b> — it's parsed and stored on the server (SQLite), synced across your devices.</li>
        <li>“Generate study set” runs entirely on DeepSeek: key points, active-recall flashcards, MCQ quizzes, and figure captions inferred from the slide context.</li>
        <li><b>今日学习</b> 把到期卡片、知识点和错题合并成一个队列；新卡片和新知识点受每日上限控制，避免一次过载。知识点自评也按 1/3/7/14/30 天间隔重复出现。</li>
      </ul>
    </div>
    <div class="card" style="margin-top:26px">
      <h3>💾 Backup & restore</h3>
      <p class="sub" style="margin-bottom:14px">Download all your lessons, cards, quizzes, mistakes and study time as a JSON file, and restore it later or on another device. API keys and password are <b>not</b> included for security.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <button class="btn btn-accent" id="btn-export">⬇ Export backup</button>
        <button class="btn btn-ghost" id="btn-import">⬆ Import backup</button>
        <input type="file" id="import-file" accept=".json,application/json" hidden>
        <span class="sub" id="backup-msg"></span>
      </div>
    </div>
    <div class="card" style="margin-top:26px">
      <h3>☁️ Google Drive 上传</h3>
      <p class="sub" style="margin-bottom:14px">把生成好的课程 PDF 自动上传到你的 Google Drive（用 Service Account，凭据不会暴露给浏览器）。</p>
      <div class="field"><label>Google Drive 文件夹 ID（可选）</label><input type="text" id="drive-folder" value="${escapeHtml(cfg.drive_folder_id || "")}" placeholder="留空则上传到 Drive 根目录"></div>
      <div class="field"><label>代理地址（可选，连不上 Google 时用，如 http://127.0.0.1:7890）</label><input type="text" id="drive-proxy" value="${escapeHtml(cfg.drive_proxy || "")}" placeholder="http://127.0.0.1:7890"></div>
      <div class="hint" id="drive-status">${cfg.has_drive_service ? "✅ 已检测到 service account 凭据" : "⚠️ 未检测到 data/google-service-account.json"}</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px">
        <button class="btn btn-primary btn-sm" id="btn-drive-save">保存设置</button>
        <span class="sub" id="drive-msg"></span>
      </div>
    </div>
    <div class="card" style="margin-top:26px">
      <h3>🔒 Account</h3>
      <p class="sub" style="margin-bottom:14px">${appConfig?.open
        ? "本机模式：当前没有密码，打开网址即可使用；同一网络里的其他人也一样。设置一个密码后，才需要登录。"
        : "Change your login password. You'll be asked to log in again on other devices."}</p>
      ${appConfig?.open ? "" : '<div class="field"><label>Current password</label><input type="password" id="pw-old" placeholder="Current password"></div>'}
      <div class="field"><label>New password (min 8 characters)</label><input type="password" id="pw-new" placeholder="New password"></div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-primary" id="btn-pw">${appConfig?.open ? "设置密码" : "Update password"}</button>
        ${appConfig?.open ? "" : '<button class="btn btn-ghost" id="btn-logout2">🚪 Log out</button>'}
        <span class="sub" id="pw-msg"></span>
      </div>
    </div>`;
  ["text", "vision"].forEach((key) => {
    const sel = $("#set-" + key + "-sel");
    const modelInput = $("#set-" + key + "-model");
    const baseInput = $("#set-" + key + "-base");
    sel.addEventListener("change", () => {
      const val = sel.value;
      if (val === "__custom__") { modelInput.value = ""; modelInput.focus(); }
      else if (val) {
        const opt = sel.options[sel.selectedIndex];
        modelInput.value = val;
        if (opt.dataset.base) baseInput.value = opt.dataset.base;
      }
    });
    modelInput.addEventListener("input", () => {
      const matches = [...sel.options].some((o) => o.value === modelInput.value);
      sel.value = modelInput.value ? (matches ? modelInput.value : "__custom__") : "";
    });
    $("#set-" + key + "-refresh").addEventListener("click", async () => {
      const btn = $("#set-" + key + "-refresh");
      btn.textContent = "🔄 拉取中…";
      const r = await api.getModels(key);
      btn.textContent = "🔄 拉取厂商模型";
      if (r.error || !r.models?.length) { toast("无法获取模型列表：" + (r.error || "空列表"), "error"); return; }
      const existing = new Set([...sel.options].map((o) => o.value));
      let added = 0;
      for (const mid of r.models) {
        if (!existing.has(mid)) {
          const o = document.createElement("option");
          o.value = mid; o.textContent = mid; o.dataset.base = baseInput.value;
          sel.appendChild(o); existing.add(mid); added++;
        }
      }
      toast(`新增 ${added} 个模型（厂商共 ${r.models.length} 个）`, "success");
    });
  });

  $("#btn-save").addEventListener("click", async () => {
    const cfgOut = {
      text: { base_url: $("#set-text-base").value, model: $("#set-text-model").value, api_key: $("#set-text-key").value },
      vision: { base_url: $("#set-vision-base").value, model: $("#set-vision-model").value, api_key: $("#set-vision-key").value },
      vision_active: ($("#set-vision-provider") || {}).value || undefined,
    };
    const res = await api.saveConfig(cfgOut);
    if (res.error) { toast(res.error, "error"); return; }
    await loadAppConfig();
    renderAiStatus();
    $("#save-msg").textContent = "Saved ✓";
    toast("Settings saved", "success");
  });
  const provSel = $("#set-vision-provider");
  if (provSel) {
    provSel.addEventListener("change", async () => {
      const r = await api.saveConfig({ vision_active: provSel.value });
      if (r.error) { toast(r.error, "error"); return; }
      renderSettings();
      toast("视觉来源已切换", "success");
    });
  }
  $("#btn-goal").addEventListener("click", async () => {
    const ok = await saveGoalMinutes($("#goal-min").value);
    if (ok) { $("#goal-msg").textContent = "Saved ✓"; toast("Daily goal updated", "success"); }
  });
  $("#btn-newperday").addEventListener("click", async () => {
    const ok = await saveNewCardsPerDay($("#new-per-day").value);
    if (ok) { $("#newperday-msg").textContent = "Saved ✓"; toast("Daily new-card limit updated", "success"); }
  });
  $("#btn-newpointsperday").addEventListener("click", async () => {
    const ok = await saveNewPointsPerDay($("#new-points-per-day").value);
    if (ok) { $("#newpointsperday-msg").textContent = "Saved ✓"; toast("Daily new-point limit updated", "success"); }
  });
  $("#btn-autosave").addEventListener("click", () => {
    const n = parseInt($("#autosave-sec").value, 10);
    if (!Number.isFinite(n) || n < 5) { toast("请输入 ≥5 秒", "error"); return; }
    localStorage.setItem("mbbs_auto_save_sec", String(n));
    restartAutoSave();
    $("#autosave-msg").textContent = "Saved ✓";
    toast(`自动保存间隔设为 ${n} 秒`, "success");
  });
  $("#btn-pw").addEventListener("click", async () => {
    const oldEl = $("#pw-old");  // absent while the instance has no password
    const r = await api.changePassword(oldEl ? oldEl.value : "", $("#pw-new").value);
    if (r.error) { $("#pw-msg").textContent = r.error; return; }
    if (r.token) api.setToken(r.token);
    $("#pw-msg").textContent = "Password updated ✓";
    toast(appConfig?.open ? "密码已设置，其它设备现在需要登录" : "Password updated", "success");
    $("#pw-new").value = "";
    // The banner and the log-out button depend on whether a password exists now.
    await loadAppConfig();
    renderSettings();
  });
  const lo2 = $("#btn-logout2");  // absent while the instance has no password
  if (lo2) lo2.addEventListener("click", () => { api.setToken(""); showLogin(); });
  $("#btn-drive-save").addEventListener("click", async () => {
    const id = ($("#drive-folder").value || "").trim();
    const proxy = ($("#drive-proxy").value || "").trim();
    const r = await api.saveConfig({ drive_folder_id: id, drive_proxy: proxy });
    if (r.error) { toast(r.error, "error"); return; }
    await loadAppConfig();
    $("#drive-msg").textContent = "Saved ✓";
    $("#drive-status").textContent = appConfig.has_drive_service ? "✅ 已检测到 service account 凭据" : "⚠️ 未检测到 data/google-service-account.json";
    toast("Google Drive 设置已保存", "success");
  });
  $("#btn-export").addEventListener("click", exportBackup);
  $("#btn-import").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", () => {
    const f = $("#import-file").files[0];
    if (f) importBackup(f);
    $("#import-file").value = "";
  });
  // ---- 学科与语言设置 ----
  const saveStudy = async (payload, msgEl) => {
    const r = await api.saveConfig(payload);
    if (r.error) { toast(r.error, "error"); return false; }
    await loadAppConfig();
    if (msgEl) msgEl.textContent = "已保存 ✓";
    toast("学科设置已保存 ✓", "success");
    return true;
  };
  $("#btn-study-save").addEventListener("click", async () => {
    let subs;
    try {
      subs = JSON.parse($("#study-subjects").value);
    } catch (e) {
      toast("学科 JSON 解析失败：" + e.message, "error");
      return;
    }
    if (!Array.isArray(subs) || !subs.length) { toast("学科列表不能为空", "error"); return; }
    const ok = await saveStudy({
      study: {
        site_title: $("#study-title").value,
        learner: $("#study-learner").value,
        language: $("#study-lang").value,
        auto_subject: $("#study-auto").checked,
        subjects: subs,
      },
    }, $("#study-msg"));
    if (ok) renderSettings();
  });
  $("#view").querySelectorAll("[data-study-preset]").forEach((b) => b.addEventListener("click", async () => {
    const pid = b.dataset.studyPreset;
    if (!confirm("套用该预设会替换当前学科列表，继续？")) return;
    const ok = await saveStudy({ study_preset: pid }, $("#study-msg"));
    if (ok) renderSettings();
  }));
  $("#btn-clf-addcat").addEventListener("click", () => {
    const q = $("#clf-quick");
    q.style.display = q.style.display === "none" ? "block" : "none";
  });
  $("#btn-clf-q-add").addEventListener("click", async () => {
    const name = ($("#clf-q-name").value || "").trim();
    const pat = ($("#clf-q-pattern").value || "").trim();
    if (!name) { toast("请输入分类名称", "error"); return; }
    // Load current, append, save.
    const r = await api.getClassification().catch(() => ({ categories: [], manual: {} }));
    if (r.error) { toast(r.error, "error"); return; }
    const id = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    r.categories = r.categories || [];
    r.categories.push({ id, name, pattern: pat });
    const sv = await api.saveClassification({ categories: r.categories, manual: r.manual || {} });
    if (sv.error) { toast(sv.error, "error"); return; }
    renderSettings();
    toast("分类已添加 ✓", "success");
  });
  $("#btn-clf-save").addEventListener("click", async () => {
    let parsed;
    try {
      parsed = JSON.parse($("#clf-json").value);
    } catch (e) {
      toast("JSON 解析失败：" + e.message, "error");
      return;
    }
    const cats = Array.isArray(parsed.categories) ? parsed.categories : [];
    const manualObj = parsed && typeof parsed.manual === "object" && parsed.manual ? parsed.manual : {};
    const sv = await api.saveClassification({ categories: cats, manual: manualObj });
    if (sv.error) { toast(sv.error, "error"); return; }
    renderSettings();
    toast("分类已保存 ✓", "success");
  });
}

/* ---------------- Delete lesson ---------------- */
async function deleteLesson(id) {
  if (!confirm("Delete this lesson and all its cards / quizzes / mistakes?")) return;
  await db.delete("lessons", id);
  fullLessonCache.delete(id);
  readPosForget(id);       // the saved spot of a deleted lesson is meaningless
  // The lesson's image payloads live in their own store (keyed by lesson id);
  // without this they linger as orphaned megabytes nobody can see or reclaim.
  await db.delete("lessonImages", id).catch(() => {});
  const [cards, quizzes, mistakes, favs] = await Promise.all([
    db.getAllByIndex("cards", "lessonId", id),
    db.getAllByIndex("quizzes", "lessonId", id),
    db.getAllByIndex("mistakes", "lessonId", id),
    db.getAll(FAV_STORE).catch(() => []),
  ]);
  await Promise.all(cards.map((c) => db.delete("cards", c.id)));
  await Promise.all(quizzes.map((q) => db.delete("quizzes", q.id)));
  await Promise.all(mistakes.map((m) => db.delete("mistakes", m.id)));
  // A deleted lesson takes its starred questions with it, the same way its cards
  // and mistakes go — otherwise the ⭐ page fills up with questions from courses
  // that are no longer in the library.
  await Promise.all((favs || []).filter((f) => f.lessonId === id).map((f) => db.delete(FAV_STORE, f.id)));
  if (favKeys) await loadFavs(true);
  refreshBadges();
  navigate("lessons");
}

/* ---------------- boot ---------------- */
init();
