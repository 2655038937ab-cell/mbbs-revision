import { db } from "./db.js";
import { api } from "./api.js";
import { newCard, schedule, isDue, schedulePoint, isPointDue, scheduleMistake, uid } from "./sm2.js";
import { md, mdFull } from "./markdown.js";

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

function parseJSON(content) {
  if (typeof content !== "string") return content;
  let s = content.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end > start) s = s.slice(start, end + 1);
  try { return JSON.parse(s); } catch { return null; }
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
  if (days <= 0) return "<10m";
  if (days < 1) return "<1d";
  if (days >= 365) return Math.round(days / 365) + "y";
  if (days >= 30) return Math.round(days / 30) + "mo";
  return days + "d";
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
    return text.replace(new RegExp(pattern, "gi"), (m) => `==${m}==`);
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
  all.forEach((m) => setCloze(m, false));
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
  appConfig = await api.getConfig();
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
  appConfig = await api.getConfig();
  return true;
}

/* Build one ordered, mixed study queue:
 * due review cards -> due mistakes -> due key points, with new cards
 * interleaved every few items and capped by the daily new-card limit. */
function planStudyQueue(cards, lessons, mistakes, now = Date.now()) {
  const cardLimit = getNewCardsPerDay();
  const pointLimit = getNewPointsPerDay();
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

  const base = [
    ...dueReviewCards.map((card) => ({ kind: "card", card, due: card.due, id: card.id })),
    ...dueMistakes.map((m) => ({ kind: "mistake", mistake: m, due: m.nextReview, id: m.id })),
    ...duePointEntries,
  ].sort((a, b) => (a.due || 0) - (b.due || 0));

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
function initPet() {
  const pet = document.getElementById("pet");
  if (!pet || pet.dataset.init) return;
  pet.dataset.init = "1";

  // Restore saved position.
  try {
    const saved = localStorage.getItem("mbbs_pet_pos");
    if (saved) { const p = JSON.parse(saved); pet.style.right = "auto"; pet.style.bottom = "auto"; pet.style.left = p.left + "px"; pet.style.top = p.top + "px"; }
  } catch { /* ignore */ }

  // Show the pet only while the mouse is near the bottom-right corner.
  const HOT = 190; // px zone from the right/bottom
  let shown = false;
  let lastHotCheck = 0;
  const showPet = () => { if (!shown) { pet.classList.add("show"); shown = true; } };
  const hidePet = () => { if (shown && !dragging) { pet.classList.remove("show"); shown = false; } };
  document.addEventListener("mousemove", (e) => {
    // Throttle to ~every 150 ms so frequent mouse moves don't cause reflows.
    const now = Date.now();
    if (now - lastHotCheck < 150) return;
    lastHotCheck = now;
    const inZone = e.clientX >= (window.innerWidth - HOT) && e.clientY >= (window.innerHeight - HOT);
    if (inZone) showPet();
    else hidePet();
  });
  document.addEventListener("mouseleave", hidePet);

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
    left = Math.max(0, Math.min(window.innerWidth - w, left));
    top = Math.max(0, Math.min(window.innerHeight - h, top));
    pet.style.left = left + "px";
    pet.style.top = top + "px";
    pet.style.right = "auto";
    pet.style.bottom = "auto";
    try { localStorage.setItem("mbbs_pet_pos", JSON.stringify({ left, top })); } catch { /* ignore */ }
  });
  pet.addEventListener("pointerup", () => { pet.classList.remove("dragging"); });
}
async function saveGoalMinutes(m) {
  const n = parseInt(m, 10);
  const val = n > 0 ? n : 30;
  const res = await api.saveConfig({ goal_minutes: val });
  if (res.error) { toast(res.error, "error"); return false; }
  appConfig = await api.getConfig();
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
const SYS = "You are an expert medical educator preparing concise, exam-focused revision material for a medical student. Write in clear English using precise medical terminology. Respond with ONLY valid JSON (no markdown fences, no commentary).";

const pointsPrompt = (chunk, outline) => `Extract ALL the important knowledge points from these lecture slides for exam revision. Cover EVERY category the slides mention — anatomy, physiology, biochemistry, aetiology, pathogenesis, pathology, clinical features/symptoms/signs, investigations, diagnosis/differential, treatment (drugs/surgery/procedures), prognosis, prevention, and any important numbers, formulas, staging/classification/severity criteria. Do not miss noteworthy or easily-confused details. Be comprehensive and FINE-GRAINED — extract every distinct, individually-testable point as its OWN separate point; NEVER merge related-but-distinct concepts into one broad point. Aim for at least 2-4 points per slide; a single drug, mechanism, or landmark discussed on one slide deserves its OWN point. Prefer MORE, finer points over summarizing or collapsing.

MANDATORY completeness — account for every slide and surface EVERY named concrete entity the text mentions: if a specific DRUG is named (e.g. amiodarone, lidocaine, propranolol) give it its OWN point with class/mechanism/indication/effects where stated; if a named structure, artery, nerve, muscle, procedure or syndrome appears, give it its OWN point; if the slide lists multiple stable items, each gets its own point. Do NOT only give conceptual overviews while skipping named entities — those are what a student must memorise. Return JSON {"points":[...]} with every point found.

${outline ? `LECTURE STRUCTURE (classify EVERY point using EXACTLY these labels):
${outline}
"category" must be [topic, subtopic, aspect]. CRITICAL consistency rules:
  - level 1 must be ONE of the lecture's main topic blocks (usually 1-5), and ALL level-1 labels must be the SAME granularity — never mix a system ("Circulatory System") with an organ ("Heart") or a subject ("Histology") at level 1.
  - level 2 is a specific subtype; level 3 is a specific angle that DISTINGUISHES points, NEVER a generic repeatable word ("Definition", "Treatment", "Pathophysiology", "Anatomy", "Physiology", "Classification", "Etiology", "Clinical features").
  - if you cannot give a specific distinguishing level-3 label, return only [topic, subtopic] (2 levels) — do NOT invent a generic aspect.
Use the SAME labels for related points.` : `"category" is 2-3 labels from BROAD to SPECIFIC, e.g. ["Shock", "Hypovolemic shock", "Clinical stages"]. Rules: level 1 = a main topic block and ALL level-1 labels must be the SAME granularity; level 3 must be a specific distinguishing angle, NEVER a generic word ("Definition"/"Treatment"/"Pathophysiology"/"Anatomy"/"Physiology"/"Classification"); if no specific level-3 exists, return only [topic, subtopic]. Use the SAME labels for related points.`}

For each key point return:
- "title": a specific, concise heading
- "category": [topic, subtopic, aspect] as described above
- "explanation": a single STRING with 3-5 bullet points (each line starting with "- ", lines separated by newlines), covering the mechanism, key facts, numbers, and clinical relevance. Do NOT return it as an array.
- "importance": "high" | "medium" | "low"
- "mnemonic": a short memory aid, or null
- "tags": 1-3 short topic tags (e.g. "Cardiology", "Pharmacology")
- "keyTerms": 2-5 exact key terms or phrases from the explanation to highlight
- "slide": the slide number (from the "Slide N:" labels) this point mainly comes from
- "supplement": OPTIONAL, ONLY for genuinely complex / easily-confused / high-yield points. A short, plain-Chinese INTUITIVE explanation that makes it easy to understand and remember — e.g. an analogy, a memory trick, a rule of thumb, or a "why it's clinical" note. Write it as an everyday, vivid explanation in Chinese (1-2 sentences). Set to null for simple points — do NOT pad every point. This is woven into the note's body.

Order the points in the most efficient, logical learning sequence — foundational concepts first, then mechanisms, then clinical features and management.

Return JSON: {"points":[...]}

Slides:
---
${chunk}
---`;

const outlinePrompt = (title, summary) => `Here is a medical lecture. Identify its main topics (level 1) and their sub-topics (level 2), so every knowledge point can be classified consistently.

Lecture title: ${title}

Slide titles:
${summary}

Return JSON: {"sections":[{"topic":"Main topic, 1-4 words (e.g. 'Shock')","subtopics":["Sub-topic (e.g. 'Septic shock')","..."]}]}

IMPORTANT: the level-1 "topic" entries MUST be the lecture's MAIN topics — usually 1-5, and often named in the title (e.g. if the title is "Shock; Heart Failure", the topics are "Shock" and "Heart Failure"). Do NOT use generic categories like "Pathology", "Classification" or "Management" as a level-1 topic. All level-1 topics must be at the SAME granularity — never mix a system ("Circulatory System") with an organ ("Heart") or a subject ("Histology") at level 1. "subtopics" are the specific subtypes/concepts under each topic.`;

const coveragePrompt = (chunk, titles, outline) => `Here are lecture slides and the knowledge points already extracted from the whole lecture.

Already extracted points (titles): ${titles}

${outline ? `LECTURE STRUCTURE (use EXACTLY these labels for "category"):\n${outline}\n` : ""}
CATEGORY RULES (same for every point): level 1 must be a main topic block, and ALL level-1 labels must be the SAME granularity (no mixing system/organ/subject at level 1). Level 3 must be a specific distinguishing angle — NEVER a generic word like "Definition"/"Treatment"/"Pathophysiology"/"Anatomy"/"Physiology"/"Classification". If no specific level-3 exists, return only [topic, subtopic].

Slides:
---
${chunk}
---

Find IMPORTANT knowledge points in these slides that are MISSING from the "already extracted" list (not covered by any existing title). Return them as JSON in the same format:
{"points":[{"title":"...","category":["topic","subtopic","aspect"],"explanation":"...","importance":"high|medium|low","mnemonic":"... or null","tags":["..."],"keyTerms":["..."],"slide":N}, ...]}

Be thorough: scan every slide in the chunk and check EVERY named concrete entity (specific drugs, structures, nerves, muscles, procedures, causes, types). If a named entity is NOT already covered by an existing title, add it as its own point. Do not skip named drugs/structures just because the concept seems similar — each distinct named entity is its own point. If everything important is already covered, return {"points":[]}.`;

const cardsPrompt = (ptext) => `Create active-recall flashcards from these key points. "front" = a question or cloze-style prompt that forces recall; "back" = a concise, specific answer (1-3 sentences).

Return JSON: {"cards":[{"front":"...","back":"..."}]}

Key points:
${ptext}`;

const mcqPrompt = (ptext, n) => `Create EXACTLY ${n} single-best-answer multiple-choice questions (medical exam style) from these key points — one question for EACH of the ${n} points, so every point is tested. Do NOT produce fewer than ${n} questions; if a point is hard to make a question from, still make a valid one. Output all ${n}.

Each question:
- "question": the clinical vignette or direct question
- "options": array of 4-5 answer choices
- "answer": integer index (0-based) of the correct option
- "explanation": why the answer is correct and why the others are wrong

STRICT rules — anchor every question to the source material ONLY:
- Every question and every option must come from facts actually present in the key points. Do NOT introduce, invent, or assume any concept, structure, number, or terminology that is not in the key points. Do not borrow from general knowledge.
- You may only base a question on a concept the key points actually state. If a concept isn't in the key points, don't test it.
- There must be exactly ONE clearly-correct option; every distractor must be unambiguously wrong AND drawn from related concepts that also appear in the key points (so it's a fair distractor, not a made-up one). NEVER let a distractor also be correct — e.g. if both the SA node and AV node are correct for a stem, do NOT write that question; choose a stem with exactly one clear answer.
- Vary the OPTION ORDER so the correct answer is not always "A" — place the correct option at varied positions (A/B/C/D/E).
- Prefer POSITIVE questions ("Which… is a…", "What structure…"). Use an exclusion "NOT / EXCEPT" item ONLY when the key points explicitly list a closed set of members and exactly one is genuinely excluded — and state that boundary using ONLY the key points' own wording.
- Keep every term to the exact name used in the key points.

Return JSON: {"questions":[...]}

Key points:
${ptext}`;

// LLMs often put the correct option first (answer always "A"). Shuffle each
// question's options so the correct answer lands at a random position. This
// keeps the explanation valid (it describes the answer's CONTENT, not position).
function shuffleQuizOptions(questions) {
  (questions || []).forEach((q) => {
    if (!Array.isArray(q.options) || q.options.length < 2) return;
    const correct = q.options[q.answer];
    const idx = q.options.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    q.options = idx.map((i) => q.options[i]);
    q.answer = idx.indexOf(Number(q.answer));
  });
  return questions;
}

const visionPrompt = `You are analyzing an image from a medical lecture slide. Describe it for a student's revision notes. Return JSON:
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
async function attachFigureCaptions(slides, pm) {
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
    const reqItems = items.filter((it) => it.n > 0);
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
      pm.setProgress(0.72 + (done / total) * 0.28);
    }
  });
  return done;
}

/* ---------------- chunking ---------------- */
function buildSlideBlocks(slides) {
  return slides.map((s) => {
    let b = `Slide ${s.index}:\n${s.text || "(no text)"}`;
    if (s.notes) b += `\nSpeaker notes: ${s.notes}`;
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
    const quizPct = q?.questions?.length ? ((q.score ?? 0) / q.questions.length) * 100 : null;
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
}

async function enterApp() {
  try { appConfig = await api.getConfig(); } catch { appConfig = { has_text_key: false, has_vision_key: false }; }
  renderAiStatus();
  if (!window.__mbbsTT) { window.__mbbsTT = true; startTimeTracking(); }
  await navigate("dashboard");
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
    case "progress": renderProgress(); break;
    case "token": renderTokenStats(); break;
    case "search": renderSearch(); break;
    case "settings": renderSettings(); break;
    default: renderDashboard();
  }
}

async function refreshBadges() {
  const [cards, lessons, mistakes] = await Promise.all([
    db.getAll("cards"), db.getAll("lessons"), db.getAll("mistakes"),
  ]);
  const plan = planStudyQueue(cards, lessons, mistakes);
  const dueTotal = plan.entries.length;
  const dueMistakes = plan.dueMistakeCount;
  const rb = $("#review-badge"), mb = $("#mistake-badge");
  rb.textContent = dueTotal; rb.hidden = dueTotal === 0;
  mb.textContent = dueMistakes; mb.hidden = dueMistakes === 0;
}

/* ---------------- Dashboard ---------------- */
async function renderDashboard() {
  const [lessons, cards, mistakes, log, quizzes] = await Promise.all([
    db.getAll("lessons"), db.getAll("cards"), db.getAll("mistakes"), db.getAll("studyLog"), db.getAll("quizzes"),
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
  $("#view").querySelectorAll("[data-go]").forEach((el) => el.addEventListener("click", () => navigate(el.dataset.go)));
  $("#view").querySelectorAll(".lesson-item").forEach((el) =>
    el.addEventListener("click", () => openLesson(el.dataset.id)));
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
  // 3. auto code fallback
  if (autoCode) return { key: "code:" + autoCode, label: autoCode, catId: null };
  // 4. other
  return { key: "other", label: "📁 其他", catId: null };
}

function lessonRow(l, cls, catOpts) {
  const cardCount = l.cardCount ?? 0;
  const due = l.dueCards ?? 0;
  const pct = l.pct ?? 0;
  const showBar = l.pct != null;
  const manualId = (cls?.manual || {})[l.id] || "";
  const showCat = catOpts != null; // only Lessons list renders the category picker
  return `
    <div class="lesson-item" data-id="${l.id}">
      <div class="lesson-ico">${l.kind === "pdf" ? "📄" : "📑"}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700">${escapeHtml(l.title)}</div>
        <div class="sub">${l.kind.toUpperCase()} · ${fmtDate(l.createdAt)} · ${l.slides?.length || 0} slides</div>
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

/* ---------------- Lessons list ---------------- */
async function renderLessons() {
  const [lessons, cards, quizzes, cls] = await Promise.all([
    db.getAll("lessons"), db.getAll("cards"), db.getAll("quizzes"), api.getClassification().catch(() => ({ categories: [], manual: {} })),
  ]);
  const mastery = computeMasteryMap(lessons, cards, quizzes);
  const lessonsWith = withStats(lessons, cards).map((l) => ({ ...l, pct: mastery[l.id]?.pct ?? 0 }));
  const sorted = [...lessonsWith].sort((a, b) => b.createdAt - a.createdAt);
  const groups = new Map(); // groupKey -> {label, items}
  for (const l of sorted) {
    const g = classifyLesson(l, cls);
    if (!groups.has(g.key)) groups.set(g.key, { label: g.label, items: [] });
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
  for (const g of groupOrder) {
    items.push({ type: "group", g });
    g.items.forEach((l) => items.push({ type: "lesson", l }));
  }
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
        <button class="btn btn-primary" id="btn-newtext">✍ New text lesson</button>
        <button class="btn btn-primary" id="btn-upload">＋ Upload lesson</button>
      </div>
    </div>
    <div class="grid">${items.filter((x) => x.type === "lesson").length ? rl.gridHtml : emptyState("📚", "No lessons yet.")}${rl.moreBtn}</div>
  `;
  const genMissing = $("#btn-gen-missing");
  if (genMissing) genMissing.addEventListener("click", () => generateAllMissing());
  $("#btn-upload").addEventListener("click", openUpload);
  $("#btn-newtext").addEventListener("click", openCreateText);
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
  const bindLessonRows = () => {
    $("#view").querySelectorAll(".lesson-item").forEach((el) => el.addEventListener("click", () => openLesson(el.dataset.id)));
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
async function openLesson(id, tab = "points") {
  currentLessonId = id;
  currentTab = tab || "points";
  currentView = "lesson";
  setActivity("study");
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
  await renderLessonDetail();
}

async function renderLessonDetail() {
  const lesson = await getLessonFull(currentLessonId);
  if (!lesson) { navigate("lessons"); return; }
  const cards = await db.getAllByIndex("cards", "lessonId", currentLessonId);
  const quiz = (await db.getAllByIndex("quizzes", "lessonId", currentLessonId))[0];

  // Build the ordered lesson list once for quick prev/next switching.
  const all = await db.getAll("lessons");
  lessonOrder = all.map((l) => ({ id: l.id, createdAt: l.createdAt || 0 })).sort((a, b) => a.createdAt - b.createdAt).map((x) => x.id);
  const idx = lessonOrder.indexOf(currentLessonId);
  const prevId = idx > 0 ? lessonOrder[idx - 1] : null;
  const nextId = idx >= 0 && idx < lessonOrder.length - 1 ? lessonOrder[idx + 1] : null;

  const tabs = [
    ["points", "Key points"], ["cards", "Flashcards"], ["quiz", "Quiz"], ["mindmap", "Mind map"], ["figures", "Figures"], ["slides", "Slides"],
  ];
  const isImmersive = immersiveOn && currentTab === "points";

  const switchBtns = `
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
    $("#btn-next-lesson").addEventListener("click", () => { if (nextId) openLesson(nextId); });
    $("#btn-immersive").addEventListener("click", () => { immersiveOn = false; renderLessonDetail(); });
    renderImmersivePoints(lesson);
    return;
  }

  document.body.classList.remove("immersive");
  $("#view").innerHTML = `
    <div class="page-head">
      <div class="title-wrap">
        <h1>${escapeHtml(lesson.title)}</h1>
        <p class="sub">${lesson.kind.toUpperCase()} · ${fmtDate(lesson.createdAt)} · ${lesson.slides?.length || 0} slides · ${lesson.points?.length || 0} points · ${cards.length} cards</p>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;justify-content:flex-end">
        ${switchBtns}
        ${immersiveBtn}
        <button class="btn btn-accent" id="btn-gen">✨ 一键生成</button>
        <button class="btn btn-sm btn-ghost" id="btn-gen-points" title="只重新提炼知识点">📌 知识点</button>
        <button class="btn btn-sm btn-ghost" id="btn-gen-cards" title="只重新生成闪卡">🃏 闪卡</button>
        <button class="btn btn-sm btn-ghost" id="btn-gen-quiz" title="只重新生成题目">📝 题目</button>
        <button class="btn btn-sm btn-ghost" id="btn-gen-figs" title="只重新配图">🖼 配图</button>
        <button class="btn btn-sm btn-ghost" id="btn-export" title="下载 PDF">📄 PDF</button>
        <button class="btn btn-sm btn-ghost" id="btn-export-anki" title="下载 Anki 卡包">🃏 Anki</button>
        <button class="btn btn-sm btn-ghost" id="btn-export-drive" title="上传 PDF 到 Google Drive">☁️ Drive</button>
        <button class="btn btn-sm btn-ghost" id="btn-export-json" title="导出整门课（含配图+闪卡+题目）为 JSON，可分享给他人导入">⬇ JSON</button>
        <button class="btn btn-sm btn-ghost" id="btn-import-json" title="导入他人分享的课程 JSON 文件">⬆ 导入</button>
        <button class="btn btn-danger btn-ghost" id="btn-del">🗑</button>
      </div>
    </div>
    <div class="tabs">${tabs.map(([k, label]) => `<button class="tab ${k === currentTab ? "active" : ""}" data-tab="${k}">${label}</button>`).join("")}</div>
    <div id="tab-body"></div>
  `;
  $("#view").querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => { immersiveOn = false; currentTab = t.dataset.tab; renderLessonDetail(); }));
  $("#btn-prev-lesson").addEventListener("click", () => { if (prevId) openLesson(prevId); });
  $("#btn-next-lesson").addEventListener("click", () => { if (nextId) openLesson(nextId); });
  $("#btn-immersive").addEventListener("click", () => { immersiveOn = true; currentTab = "points"; renderLessonDetail(); });
  $("#btn-gen").addEventListener("click", () => confirmGenerate("将<b>重新生成全部内容</b>（知识点、闪卡、题目、配图），并替换已有内容。确定继续？", () => generateStudySet(currentLessonId, !!lesson.points?.length)));
  $("#btn-gen-points").addEventListener("click", () => confirmGenerate("将<b>重新提炼知识点</b>并替换现有知识点（闪卡、题目不受影响）。确定继续？", () => generatePointsOnly(currentLessonId)));
  $("#btn-gen-cards").addEventListener("click", () => confirmGenerate("将<b>重新生成闪卡</b>并替换现有闪卡。确定继续？", () => generateCardsOnly(currentLessonId)));
  $("#btn-gen-quiz").addEventListener("click", () => confirmGenerate("将<b>重新生成题目</b>并替换现有题目。确定继续？", () => regenerateQuiz(currentLessonId)));
  $("#btn-gen-figs").addEventListener("click", () => confirmGenerate("将<b>重新配图</b>并更新图注。确定继续？", () => generateFiguresOnly(currentLessonId)));
  $("#btn-export").addEventListener("click", () => exportPdfOnly(currentLessonId));
  $("#btn-export-anki").addEventListener("click", () => exportAnkiOnly(currentLessonId));
  $("#btn-export-drive").addEventListener("click", () => exportLessonToDrive(currentLessonId));
  $("#btn-export-json").addEventListener("click", () => exportLessonJson(currentLessonId));
  $("#btn-import-json").addEventListener("click", importLessonJson);
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
  } else if (apkg.error !== "No flashcards to export.") {
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
    const quizzes = await db.getAllByIndex("quizzes", "lessonId", lessonId);
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
        ${p.mnemonic ? `<div style="margin-top:8px;background:#fef3c7;border-left:3px solid #d97706;padding:8px 10px;border-radius:8px;font-size:12px;color:#475569;"><b style="color:#d97706;">🧠 Mnemonic:</b> ${escapeHtml(p.mnemonic)}</div>` : ""}
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
      return `<div style="font-size:12px;line-height:1.5;color:${right ? "#16a34a" : "#475569"};font-weight:${right ? "700" : "400"};">${String.fromCharCode(65 + j)}) ${escapeHtml(o)}${right ? "  ✓" : ""}</div>`;
    }).join("");
    return `
      <div style="border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;margin:0 0 10px;page-break-inside:avoid;">
        <div style="font-size:13px;font-weight:700;color:#0f172a;">Q${i + 1}. ${escapeHtml(q.question || "")}</div>
        <div style="margin-top:6px;">${opts}</div>
        ${q.explanation ? `<div style="margin-top:6px;font-size:11px;color:#16a34a;"><b>Answer:</b> ${escapeHtml(q.explanation)}</div>` : ""}
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

async function exportLessonPdf(lessonId) {
  if (!window.html2pdf) throw new Error("html2pdf not loaded");
  const lesson = await getLessonFull(lessonId);
  if (!lesson) throw new Error("Lesson not found");
  const quiz = (await db.getAllByIndex("quizzes", "lessonId", lessonId))[0] || null;
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
  const body = $("#tab-body");
  if (currentTab === "points") renderPointsTab(body, lesson);
  else if (currentTab === "cards") renderCardsTab(body, lesson, cards);
  else if (currentTab === "quiz") renderQuizTab(body, lesson, quiz);
  else if (currentTab === "mindmap") renderMindmapTab(body, lesson);
  else if (currentTab === "figures") renderFiguresTab(body, lesson);
  else if (currentTab === "slides") renderSlidesTab(body, lesson);
}

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
  $("#kp-list").addEventListener("click", (e) => {
    const snav = e.target.closest(".slide-nav");
    if (snav) { openSlide(snav.dataset.lesson, parseInt(snav.dataset.slide, 10)); return; }
    const rbtn = e.target.closest(".recall-btn");
    if (rbtn) {
      // Toggle: start recall, or exit an active one on the same card.
      if (recallState && recallState.active && recallState.card === rbtn.closest(".kp-section")) exitRecall();
      else startPointRecall(rbtn.closest(".kp-section"));
      return;
    }
    // In-recall self-rating buttons.
    const rate = e.target.closest(".recall-rate");
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
  $("#kp-filters").querySelectorAll(".chip").forEach((chip) => chip.addEventListener("click", () => {
    $("#kp-filters").querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    filter = chip.dataset.f;
    renderList();
  }));
  renderList();
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

function normalizeCategories(points, outlineSections) {
  const norm = (s) => String(s || "").trim().toLowerCase();
  const sections = (outlineSections || []).filter((s) => s && s.topic);
  const topicKeywords = sections.map((s) => ({ topic: s.topic, kws: [s.topic, ...(s.subtopics || [])].map(norm) }));
  points.forEach((p) => {
    let cat = Array.isArray(p.category) ? p.category.map((x) => String(x || "").trim()).filter(Boolean) : [];
    while (cat.length > 1 && GENERIC_L1.has(norm(cat[0]))) cat = cat.slice(1);
    const searchable = norm([cat.join(" "), p.title, (p.tags || []).join(" "), explanationText(p.explanation)].join(" "));
    let l1 = null;
    for (const { topic, kws } of topicKeywords) {
      if (kws.some((k) => k && searchable.includes(k))) { l1 = topic; break; }
    }
    if (l1) cat[0] = l1;
    if (cat[1] && norm(cat[1]) === norm(cat[0])) cat.splice(1, 1);
    p.category = cat;
  });
}

function countTreePoints(node) {
  let n = (node.points || []).length;
  (node.children || []).forEach((c) => (n += countTreePoints(c)));
  return n;
}

function renderPointTree(node, lesson, depth, shownSlides) {
  // Level-1 / 2 / 3 groups are collapsible and hidden by default.
  // Clicking a heading expands the level below it.
  const hasChildren = (node.children || []).length > 0;
  const hasPoints = (node.points || []).length > 0;
  const childrenHtml = hasChildren
    ? node.children.map((c) => renderPointTree(c, lesson, depth + 1, shownSlides)).join("")
    : "";
  const pointsHtml = hasPoints
    ? `<div class="card" style="padding:6px 20px 14px;margin-top:6px">${node.points.map((p) => pointSection(p, lesson, shownSlides)).join("")}</div>`
    : "";

  if (depth >= 1 && depth <= 3 && (hasChildren || hasPoints)) {
    const levelClass = depth === 1 ? "tree-l1" : depth === 2 ? "tree-l2" : "tree-l3";
    // A 3rd-level group with exactly one point opens by default.
    const autoOpen = depth === 3 && !hasChildren && node.points && node.points.length === 1;
    const openAttr = autoOpen ? " open" : "";
    return `<details class="kp-group"${openAttr}>
      <summary class="${levelClass} kp-summary">${depth === 1 ? "" : `<span class="kp-arrow">▸</span> `}${escapeHtml(node.name)}${depth === 1 ? ` <span class="sub">(${countTreePoints(node)})</span>` : ""}</summary>
      ${pointsHtml}${childrenHtml}
    </details>`;
  }

  let html = "";
  if (node.name) html += `<div class="tree-l3">${escapeHtml(node.name)}</div>`;
  return html + pointsHtml + childrenHtml;
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
      }
      if (shownSlides && figs.length) shownSlides.add(slide.index);
    }
  }
  return `
    <div class="kp-section" id="kp-${idx}" data-idx="${idx}">
      <div class="kp-subhead">
        <span class="imp imp-${imp}">${imp}</span>
        <span class="kp-subtitle">${escapeHtml(p.title)}</span>
        ${tags.map((t) => `<span class="pill pill-gray">${escapeHtml(t)}</span>`).join("")}
        ${(p.weakTerms || []).length ? `<span class="pill pill-amber" title="回忆时没记住的术语">⚠ 弱项 ${p.weakTerms.length}</span>` : ""}
        ${p.feynmanStage != null ? `<span class="pill ${feynmanPct(p.feynmanStage) >= 67 ? "pill-brand" : feynmanPct(p.feynmanStage) >= 33 ? "pill-amber" : "pill-gray"}" title="Feynman self-rating">🎓 ${feynmanPct(p.feynmanStage)}%</span>` : ""}
        <span style="margin-left:auto;display:flex;gap:6px;align-items:center">
          ${p.slide != null ? `<button class="btn btn-sm btn-ghost slide-nav" data-lesson="${lesson.id}" data-slide="${p.slide}" title="跳转到原课件对应页">📄 Slide ${p.slide}</button>` : ""}
          ${terms.length ? `<button class="btn btn-sm btn-ghost cloze-btn" data-state="shown">🙈 遮字</button>` : ""}
          ${terms.length ? `<button class="btn btn-sm btn-ghost recall-btn" data-state="idle" title="逐个回想术语：空格揭示 → 自评记住/没记住">🔎 回忆</button>` : ""}
        </span>
      </div>
      <div class="kp-body">${mdFull(highlightTerms(explanationText(p.explanation), terms))}${p.supplement ? `<div class="kp-supplement"><b>💡 理解:</b> ${escapeHtml(p.supplement)}</div>` : ""}</div>
      ${p.mnemonic ? `<div class="kp-mnemonic"><b>🧠 Mnemonic:</b> ${md(p.mnemonic)}</div>` : ""}
      ${figs.length ? `<div class="kp-figs">${figs.map((im) => `
        <figure class="kp-fig" data-slide="${slide.index}" data-crop="${(slide.figureCrop || []).join(",")}" data-full="${im.dataUrl}">
          <div class="kp-fig-wrap"><img src="${im.dataUrl}" alt="">${slide.figureCrop ? `<span class="kp-crop-badge">✂ 已选区域</span>` : ""}</div>
          <figcaption>${escapeHtml(im.caption?.caption || im.caption?.takeaway || `Slide ${slide.index}`)} <button class="btn btn-sm btn-ghost kp-crop-btn" title="选择/调整配图显示区域">✂ 选区域</button></figcaption>
        </figure>`).join("")}</div>` : ""}
      ${figNote}
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

function renderQuizTab(body, lesson, quiz) {
  if (!quiz || !quiz.questions?.length) {
    body.innerHTML = emptyState("📝", "No quiz yet. Generate questions to test yourself.",
      `<div style="margin-top:14px"><button class="btn btn-accent btn-lg" id="btn-gen4">✨ Generate quiz</button></div>`);
    const b = $("#btn-gen4"); if (b) b.addEventListener("click", () => generateStudySet(currentLessonId));
    return;
  }
  const lastScore = quiz.score != null ? `${quiz.score}/${quiz.questions.length}` : "—";
  body.innerHTML = `
    <div class="card" style="margin-bottom:18px;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <div>
        <div class="sub">Last score</div>
        <div style="font-size:26px;font-weight:800">${lastScore}</div>
      </div>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn btn-accent" id="btn-take">▶ Take quiz</button>
        <button class="btn btn-ghost" id="btn-regenq">↻ Regenerate questions</button>
      </div>
    </div>
    <h3>Question bank (${quiz.questions.length})</h3>
    <div class="grid">${quiz.questions.map((q, i) => `
      <div class="card">
        <div style="font-weight:600;margin-bottom:8px">Q${i + 1}. ${escapeHtml(q.question)}</div>
        <ol style="margin:0;padding-left:20px;color:var(--text-2)">${q.options.map((o, j) => `<li style="${j === q.answer ? "color:var(--green);font-weight:600" : ""}">${escapeHtml(o)}${j === q.answer ? " ✓" : ""}</li>`).join("")}</ol>
      </div>`).join("")}</div>
  `;
  $("#btn-take").addEventListener("click", () => startQuiz(currentLessonId));
  $("#btn-regenq").addEventListener("click", () => regenerateQuiz(currentLessonId));
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
      <span class="mm-dot ${imp}"></span><span class="mm-point-title">${escapeHtml(title)}</span>
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

function renderFiguresTab(body, lesson) {
  const figs = [];
  (lesson.slides || []).forEach((s) => (s.images || []).filter((im) => im.kind !== "page" && im.kind !== "logo").forEach((im) => figs.push({ slide: s.index, im })));
  if (!figs.length) {
    body.innerHTML = emptyState("🖼", "No figures found in this file.");
    return;
  }
  const uncaptioned = figs.filter((f) => !f.im.caption).length;
  body.innerHTML = `
    <div class="page-head" style="margin-bottom:14px">
      <div class="title-wrap"><h2>Figures & diagrams</h2><p class="sub">${figs.length} figure${figs.length === 1 ? "" : "s"}${uncaptioned ? ` · ${uncaptioned} not yet captioned` : " · all captioned"}</p></div>
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
function openUpload() {
  const remembered = localStorage.getItem("mbbs_up_autogen") !== "0"; // default on
  openModal(`
    <h2>Upload a lesson</h2>
    <p class="sub" style="margin-bottom:16px">Supported: <b>.pptx</b> and <b>.pdf</b>. The file is parsed locally on your machine and never leaves it (except AI calls you explicitly run).</p>
    <div class="dropzone" id="dz">
      <div class="dz-ico">📥</div>
      <div style="font-weight:600;margin-top:6px">Drag & drop your file(s) here, or click to browse</div>
      <div class="sub">PowerPoint (.pptx) or PDF (.pdf) — 支持多选/批量上传</div>
      <input type="file" id="dz-input" multiple accept=".pptx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation">
    </div>
    <label style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13.5px;color:var(--text-2);cursor:pointer">
      <input type="checkbox" id="up-auto-gen" ${remembered ? "checked" : ""}> 上传后自动制作笔记（生成知识点/闪卡/题目）
    </label>
    <div id="up-status"></div>
  `);
  const dz = $("#dz"), input = $("#dz-input");
  const dst = $("#up-status");
  const autoBox = $("#up-auto-gen");
  if (autoBox) autoBox.addEventListener("change", () => { try { localStorage.setItem("mbbs_up_autogen", autoBox.checked ? "1" : "0"); } catch { /* ignore */ } });
  dz.addEventListener("click", () => input.click());
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("drag"); const files = [...(e.dataTransfer.files || [])]; if (files.length) uploadAll(files, dst); });
  input.addEventListener("change", () => { const files = [...(input.files || [])]; if (files.length) uploadAll(files, dst); });
}

// Upload several files at once, processing them one at a time and showing progress.
// When "auto-generate" is on, each uploaded lesson is generated (serially, so
// multiple lessons don't generate concurrently and freeze the UI).
async function uploadAll(files, dst) {
  const valid = files.filter((f) => /\.(pptx?|pdf)$/i.test(f.name));
  if (!valid.length) { toast("Please choose .pptx or .pdf files.", "error"); return; }
  const autoGen = (document.getElementById("up-auto-gen") || {}).checked !== false;
  dst.innerHTML = `<div class="loading"><div class="spinner"></div>上传中 0/${valid.length} …</div>`;
  let done = 0, succeeded = 0, failed = 0;
  const uploadedIds = [];
  for (const file of valid) {
    dst.innerHTML = `<div class="loading"><div class="spinner"></div>解析 “${escapeHtml(file.name)}” (${done + 1}/${valid.length})…</div>`;
    const res = await api.parseFile(file);
    if (res.error) {
      failed++;
      dst.innerHTML = `<div class="q-expl wrong">❌ ${escapeHtml(file.name)}：${escapeHtml(res.error)}</div>`;
      await new Promise((r) => setTimeout(r, 400));
    } else {
      succeeded++;
      const id = await saveParsedLesson(res, file.name, true); // silent: just save, collect id
      if (id) uploadedIds.push(id);
      done++;
      dst.innerHTML = `<div class="loading"><div class="spinner"></div>上传中 ${done}/${valid.length} …</div>`;
    }
  }
  closeModal();
  toast(`✅ 上传完成：${succeeded} 成功${failed ? `，${failed} 失败` : ""}`, failed ? "warn" : "success");
  // If auto-generate is on, generate each uploaded lesson serially (one at a
  // time) so multiple lessons never generate concurrently and freeze the UI.
  if (autoGen && uploadedIds.length) {
    toast(`🔄 正在自动制作笔记（${uploadedIds.length} 门课，依次生成）…`);
    for (let i = 0; i < uploadedIds.length; i++) {
      await generateStudySet(uploadedIds[i]);
    }
  }
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

async function saveParsedLesson(res, filename, silent = false, autoGen = false) {
  const title = (filename || "lesson").replace(/\.(pptx?|pdf)$/i, "").replace(/[-_]+/g, " ").trim() || "Untitled lesson";
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
function openCreateText() {
  openModal(`
    <h2>✍ New text lesson</h2>
    <p class="sub" style="margin-bottom:14px">Paste or type your own notes, then let AI build key points, flashcards and quiz. Each blank line becomes a separate "slide" (page).</p>
    <div class="field"><label>Title (e.g. “CPR63 Shock — my notes”)</label>
      <input type="text" id="newtext-title" placeholder="e.g. GIS01 Liver anatomy" style="width:100%">
    </div>
    <div class="field"><label>Content</label>
      <textarea id="newtext-body" rows="14" placeholder="Paste your notes here…&#10;&#10;Separate paragraphs with a blank line." style="width:100%;resize:vertical;font-family:inherit"></textarea>
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
  const lessons = await db.getAll("lessons").catch(() => []);
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

  // Build slide text AFTER any OCR
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
    const or = await api.llm([{ role: "system", content: SYS }, { role: "user", content: outlinePrompt(lesson.title, summary) }], { json_mode: true, max_tokens: 1500 });
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
    pm.setProgress(0.15); // give the bar a foot in the door so it doesn't sit at 0
    const results = new Array(chunks.length);
    let idx = 0, doneCnt = 0;
    const workers = Array.from({ length: Math.min(8, chunks.length) }, async () => {
      while (idx < chunks.length) {
        const i = idx++;
        const chunk = chunks[i];
        if (pm.isCancelled()) { results[i] = null; doneCnt++; continue; }
        const r = await api.llm([{ role: "system", content: SYS }, { role: "user", content: pointsPrompt(chunk, outlineText) }], { json_mode: true, max_tokens: 12000 });
        if (r && r.usage) pm.addTokens(r.usage.total_tokens);
        results[i] = r.error ? { error: r.error } : (parseJSON(r.content)?.points || []);
        doneCnt++;
        pm.setProgress(0.15 + (doneCnt / chunks.length) * 0.27); // 0.15 → 0.42
      }
    });
    await Promise.all(workers);
    for (const res of results) {
      if (!res) continue;
      if (res.error) { pm.setStep(step, "error"); pm.msg("Key points: " + res.error); toast("Points failed: " + res.error, "error"); }
      else newPoints = newPoints.concat(res);
    }
    if (newPoints.length) { points = newPoints; pm.setStep(step, "done"); } else pm.setStep(step, "error");
    pm.setProgress(0.42);
  }
  if (pm.isCancelled()) { pm.cancelled(); return; }
  step++;

  // Step — coverage check (fill any important points the first pass missed)
  if (newPoints.length) {
    pm.addStep("Coverage check — fill gaps");
    pm.setStep(step, "running");
    let titles = newPoints.map((p) => p.title).join(", ");
    let added = 0;
    pm.msg(`Checking coverage across ${chunks.length} part${chunks.length > 1 ? "s" : ""}…`);
    const results = await parallelMap(chunks, 8, async (chunk) => {
      if (pm.isCancelled()) return null;
      const r = await api.llm([{ role: "system", content: SYS }, { role: "user", content: coveragePrompt(chunk, titles, outlineText) }], { json_mode: true, max_tokens: 12000 });
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

  // Normalize hierarchy so related points land in the same groups
  if (newPoints.length) normalizeCategories(newPoints, outlineSections);

  // dedupe by title (case-insensitive)
  if (newPoints.length) {
    const seenTitles = new Set();
    newPoints = newPoints.filter((p) => {
      const k = String(p.title || "").trim().toLowerCase();
      if (!k || seenTitles.has(k)) return false;
      seenTitles.add(k);
      return true;
    });
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
      const r = await api.llm([{ role: "system", content: SYS }, { role: "user", content: cardsPrompt(pchunk) }], { json_mode: true, max_tokens: 8000 });
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
    pm.setProgress(0.62);
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
      const txt = batch.map((p, i) => `${i + 1}. ${p.title}\n   ${explanationText(p.explanation)}`).join("\n");
      const n = batch.length; // one question per point in this batch
      const r = await api.llm([{ role: "system", content: SYS }, { role: "user", content: mcqPrompt(txt, n) }], { json_mode: true, max_tokens: 12000 });
      if (r && r.usage) pm.addTokens(r.usage.total_tokens);
      if (r.error) return { error: r.error };
      const parsed = parseJSON(r.content);
      return parsed && Array.isArray(parsed.questions) ? parsed.questions : [];
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
    pm.setProgress(0.72);
  } else pm.setStep(step, "done");
  if (pm.isCancelled()) { pm.cancelled(); return; }
  step++;

  // Step — attach embedded figures + captions from slide context (text model only, no vision)
  const slidesWithFigs = (lesson.slides || []).filter((s) => (s.images || []).some((im) => im.kind !== "page" && im.kind !== "logo"));
  if (slidesWithFigs.length) {
    pm.addStep(`Attach figures & captions (${slidesWithFigs.length} slides)`);
    pm.setStep(step, "running");
    await attachFigureCaptions(slidesWithFigs, pm);
    pm.setStep(step, "done");
  }

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
    const or = await api.llm([{ role: "system", content: SYS }, { role: "user", content: outlinePrompt(lesson.title, summary) }], { json_mode: true, max_tokens: 1500 });
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
      const r = await api.llm([{ role: "system", content: SYS }, { role: "user", content: pointsPrompt(chunk, outlineText) }], { json_mode: true, max_tokens: 12000 });
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

  if (newPoints.length) {
    pm.addStep("Coverage check — fill gaps");
    pm.setStep(step, "running");
    const titles = newPoints.map((p) => p.title).join(", ");
    let added = 0;
    pm.msg(`Checking coverage across ${chunks.length} part${chunks.length > 1 ? "s" : ""}…`);
    const results = await parallelMap(chunks, 8, async (chunk) => {
      if (pm.isCancelled()) return null;
      const r = await api.llm([{ role: "system", content: SYS }, { role: "user", content: coveragePrompt(chunk, titles, outlineText) }], { json_mode: true, max_tokens: 12000 });
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
  const count = (lesson.points || []).length;
  pm.done(`${count} points`, "查看课程", () => openLesson(lessonId, "points"));
  toast("知识点已更新 ✓", "success");
  refreshBadges();
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
    const r = await api.llm([{ role: "system", content: SYS }, { role: "user", content: cardsPrompt(pchunk) }], { json_mode: true, max_tokens: 8000 });
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
  await attachFigureCaptions(slidesWithFigs, pm);
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
    const r = await api.llm([{ role: "system", content: SYS }, { role: "user", content: mcqPrompt(txt, n) }], { json_mode: true, max_tokens: 12000 });
      if (r && r.usage) pm.addTokens(r.usage.total_tokens);
    if (r.error) return { error: r.error };
    const parsed = parseJSON(r.content);
    return parsed && Array.isArray(parsed.questions) ? parsed.questions : [];
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
  const figsHtml = figs.length ? `<div class="kp-figs" style="margin-top:12px">${figs.map((im) => `
      <figure class="kp-fig"><img src="${im.dataUrl}" alt=""><figcaption>${escapeHtml(im.caption?.caption || im.caption?.takeaway || `Slide ${p.slide}`)}</figcaption></figure>`).join("")}</div>` : "";
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
        <div style="font-size:18px;font-weight:700">${escapeHtml(p.title)}</div>
        <div class="sub" style="margin-top:10px">🤔 Explain this in your own words (out loud or in your head) as if teaching a classmate. Then reveal the answer.</div>
      </div>
      <div id="feynman-answer" hidden>
        <div class="card" style="border-color:var(--brand)">
          <div class="r-q">${escapeHtml(p.title)}</div>
          <div class="r-divider"></div>
          <div class="r-a">${mdFull(highlightTerms(explanationText(p.explanation), p.keyTerms))}</div>
          ${figsHtml}
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
async function recordQuizMistake(lesson, w) {
  try {
    const existing = await db.getAllByIndex("mistakes", "lessonId", lesson.id);
    const dup = existing.find((m) => m.question === w.question && !m.mastered);
    if (dup) {
      dup.userAnswer = w.options[w.userAnswer];
      dup.nextReview = Date.now();
      dup.reviewCount = (dup.reviewCount || 0) + 1;
      await db.put("mistakes", dup);
    } else {
      await db.put("mistakes", {
        id: uid(), lessonId: lesson.id, lessonTitle: lesson.title,
        question: w.question, options: w.options, answer: w.answer,
        userAnswer: w.userAnswer, explanation: w.explanation,
        createdAt: Date.now(), nextReview: Date.now(), stage: 0, reviewCount: 1, mastered: false,
      });
    }
  } catch { /* ignore transient errors */ }
}

async function startQuiz(lessonId) {
  const quiz = (await db.getAllByIndex("quizzes", "lessonId", lessonId))[0];
  const lesson = await db.get("lessons", lessonId);
  if (!quiz) return;
  setActivity("quiz");
  quizSession = { quiz, lesson, pos: 0, answers: [], wrong: [] };
  // Space / Enter advances to the next question (like clicking "Next").
  if (quizKeyHandler) document.removeEventListener("keydown", quizKeyHandler);
  quizKeyHandler = (e) => {
    if (e.key === " " || e.key === "Enter") {
      const n = $("#q-next");
      if (n) { e.preventDefault(); n.click(); }
    }
  };
  document.addEventListener("keydown", quizKeyHandler);
  renderQuizQuestion();
}

function renderQuizQuestion() {
  const { quiz, pos } = quizSession;
  const q = quiz.questions[pos];
  $("#view").innerHTML = `
    <div class="page-head"><div class="title-wrap"><h1>Quiz</h1><p class="sub">Question ${pos + 1} / ${quiz.questions.length}</p></div></div>
    <div class="progress-bar" style="margin-bottom:20px"><div class="progress-fill" style="width:${((pos) / quiz.questions.length) * 100}%"></div></div>
    <div class="card" style="margin-bottom:18px">
      <div style="font-size:17px;font-weight:600">${mdFull(q.question)}</div>
    </div>
    <div id="options">${q.options.map((o, i) => `<button class="q-option" data-i="${i}"><span class="letter">${String.fromCharCode(65 + i)}.</span><span>${escapeHtml(o)}</span></button>`).join("")}</div>
    <div id="feedback"></div>
  `;
  let answered = false;
  $("#options").querySelectorAll(".q-option").forEach((btn) => btn.addEventListener("click", () => {
    if (answered) return;
    answered = true;
    const i = parseInt(btn.dataset.i, 10);
    const correct = i === q.answer;
    quizSession.answers.push(i);
    if (!correct) {
      const wrong = { ...q, userAnswer: i };
      quizSession.wrong.push(wrong);
      recordQuizMistake(quizSession.lesson, wrong); // real-time mistake sync
    }
    $("#options").querySelectorAll(".q-option").forEach((b) => {
      const bi = parseInt(b.dataset.i, 10);
      if (bi === q.answer) b.classList.add("correct");
      else if (bi === i) b.classList.add("wrong");
      b.disabled = true;
    });
    const fb = $("#feedback");
    fb.innerHTML = `<div class="q-expl ${correct ? "correct" : "wrong"}"><b>${correct ? "✓ Correct" : "✗ Incorrect"}</b><br>${mdFull(q.explanation || "")}</div>
      <div style="margin-top:14px;text-align:right"><button class="btn btn-primary" id="q-next">${pos + 1 < quiz.questions.length ? "Next →" : "Finish"}</button></div>`;
    $("#q-next").addEventListener("click", () => {
      if (pos + 1 < quiz.questions.length) { quizSession.pos++; renderQuizQuestion(); }
      else finishQuiz();
    });
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
  await db.put("quizzes", quiz);

  quizSession = null;
  refreshBadges();
  $("#view").innerHTML = `
    <div class="card" style="max-width:560px;margin:40px auto;text-align:center">
      <div class="empty-ico" style="font-size:44px">${score === quiz.questions.length ? "🎉" : score >= quiz.questions.length * 0.7 ? "👍" : "📚"}</div>
      <h2>${score} / ${quiz.questions.length}</h2>
      <p class="sub">${wrong.length} question${wrong.length === 1 ? "" : "s"} added to your mistake notebook.</p>
      <div style="display:flex;gap:10px;justify-content:center;margin-top:16px">
        <button class="btn btn-primary" id="r-back">Back to lesson</button>
        <button class="btn btn-ghost" id="r-mistakes">📕 Open mistakes</button>
      </div>
    </div>`;
  $("#r-back").addEventListener("click", () => openLesson(lesson.id));
  $("#r-mistakes").addEventListener("click", () => navigate("mistakes"));
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
          <div style="font-weight:600;font-size:16px">${escapeHtml(m.question)}</div>
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
        <div style="font-size:18px;font-weight:700">${escapeHtml(point.title)}</div>
        <div class="sub" style="margin-top:10px">🤔 用自己的话解释这个概念，像在教同学一样。然后显示答案并自评。</div>
      </div>
      <button class="btn btn-primary btn-lg" id="r-reveal" style="width:100%">Show answer <span style="opacity:.6;font-weight:400">(空格 / ↑↓)</span></button>
      <div id="r-grades" hidden style="margin-top:16px">
        <div class="card" style="border-color:var(--brand)">
          <div class="r-a">${mdFull(highlightTerms(explanationText(point.explanation), point.keyTerms))}</div>
          ${point.mnemonic ? `<div class="kp-mnemonic"><b>🧠 Mnemonic:</b> ${md(point.mnemonic)}</div>` : ""}
          ${point.supplement ? `<div class="kp-supplement"><b>💡 理解:</b> ${escapeHtml(point.supplement)}</div>` : ""}
          <div id="r-figs"></div>
        </div>
        <div class="sub" style="margin:14px 0 6px">你解释得怎么样？</div>
        <div class="review-grade">
          <button class="grade-btn grade-0" data-g="0"><span>Couldn't</span><span class="g-int">${intervalLabel((preview[0].feynmanDue - Date.now()) / 86400000)}</span><span class="g-key">1</span></button>
          <button class="grade-btn grade-1" data-g="1"><span>Vague</span><span class="g-int">${intervalLabel((preview[1].feynmanDue - Date.now()) / 86400000)}</span><span class="g-key">2</span></button>
          <button class="grade-btn grade-2" data-g="2"><span>Good</span><span class="g-int">${intervalLabel((preview[2].feynmanDue - Date.now()) / 86400000)}</span><span class="g-key">3</span></button>
          <button class="grade-btn grade-3" data-g="3"><span>Excellent</span><span class="g-int">${intervalLabel((preview[3].feynmanDue - Date.now()) / 86400000)}</span><span class="g-key">4</span></button>
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

async function gradeStudyEntry(value) {
  if (!reviewFlipped || reviewPos >= reviewQueue.length) return;
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
      reviewQueue.push({ ...entry, card: updated });
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
      reviewQueue.push({ ...entry, point: updatedPoint });
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
  $("#view").querySelectorAll(".mistake-item").forEach((el) => el.addEventListener("click", () => openLesson(el.dataset.lesson)));
}

function mistakeRow(m) {
  const opts = m.options ? `<div class="sub" style="margin-top:6px">Your answer: <b style="color:var(--red)">${escapeHtml(m.options[m.userAnswer] ?? m.userAnswer)}</b> · Correct: <b style="color:var(--green)">${escapeHtml(m.options[m.answer])}</b></div>` : "";
  return `
    <div class="card mistake-item" data-lesson="${m.lessonId}" style="cursor:pointer">
      <div class="sub" style="display:flex;justify-content:space-between;margin-bottom:6px"><span>${escapeHtml(m.lessonTitle)}</span><span class="pill pill-gray">next ${fmtDate(m.nextReview)}</span></div>
      <div style="font-weight:600">${escapeHtml(m.question)}</div>
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
      <div class="card" style="margin-bottom:14px"><div style="font-weight:600;font-size:16px">${escapeHtml(m.question)}</div></div>
      <div id="mr-reveal" hidden>
        <div class="q-expl correct" style="margin-bottom:12px"><b>✓ Correct answer:</b> ${escapeHtml(m.options ? m.options[m.answer] : m.answer)}</div>
        ${m.explanation ? `<div class="q-expl">${mdFull(m.explanation)}</div>` : ""}
        <div class="review-grade" style="margin-top:16px">
          <button class="grade-btn grade-0" id="mr-miss">Still wrong</button>
          <button class="grade-btn grade-2" id="mr-got">Got it</button>
        </div>
      </div>
      <button class="btn btn-primary" id="mr-show" style="width:100%">Show answer <span style="opacity:.6;font-weight:400">(空格/↑↓ · ←错 →对)</span></button>
    </div>`;
  $("#mr-show").addEventListener("click", revealMistake);
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
  const quizTxt = quiz?.questions?.length ? `${quiz.score ?? 0}/${quiz.questions.length}` : "—";
  const parts = [];
  if (totalPoints) parts.push(`🎓 ${reviewedPoints}/${totalPoints} points (${pointPct}%)`);
  if (totalCards) parts.push(`cards ${seen}/${totalCards} · ${mature} mastered`);
  if (quiz?.questions?.length) parts.push(`quiz ${quizTxt}`);
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
    db.getAll("lessons"), db.getAll("cards"), db.getAll("quizzes"), db.getAll("studyLog"),
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
  lessons.forEach((l) => (l.points || []).forEach((p) => idx.push({
    type: "point", lessonId: l.id, lessonTitle: l.title,
    title: p.title, text: [p.title, explanationText(p.explanation), p.mnemonic || "", ...(p.tags || [])].join("\n"),
    importance: p.importance || "medium", tags: p.tags || [],
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
  return `
    <div class="search-row" data-lesson="${it.lessonId}" data-tab="${meta.tab}">
      <div class="search-ico">${meta.ico}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600">${escapeHtml(it.title)}</div>
        <div class="sub" style="font-size:12.5px">${meta.label} · ${escapeHtml(it.lessonTitle)}</div>
      </div>
      ${imp}
    </div>`;
}

/* ---------------- Token statistics ---------------- */
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
  const [lessons, cards, quizzes, mistakes] = await Promise.all([
    db.getAll("lessons"), db.getAll("cards"), db.getAll("quizzes"), db.getAll("mistakes"),
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
    box.querySelectorAll(".search-row").forEach((el) => el.addEventListener("click", () => openLesson(el.dataset.lesson, el.dataset.tab)));
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
      <span class="nav-point-title">${escapeHtml(p.title)}</span>
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
  await openLesson(lessonId, "points");
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
  // Retry for up to ~1.5s in case the render is still settling.
  let tries = 0;
  const attempt = () => {
    if (focus()) return;
    if (++tries < 15) setTimeout(attempt, 100);
  };
  requestAnimationFrame(attempt);
  setTimeout(attempt, 120);
}

async function openSlide(lessonId, slideIndex) {
  await openLesson(lessonId, "slides");
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
    db.getAll("lessons"), db.getAll("cards"), db.getAll("quizzes"),
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
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", base_url: "https://api.deepseek.com" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", base_url: "https://api.deepseek.com" },
    { id: "deepseek-chat", name: "DeepSeek Chat (V3)", base_url: "https://api.deepseek.com" },
    { id: "kimi-k3", name: "Kimi K3 (Moonshot)", base_url: "https://api.moonshot.cn/v1" },
    { id: "kimi-latest", name: "Kimi Latest (Moonshot)", base_url: "https://api.moonshot.cn/v1" },
    { id: "qwen-max", name: "Qwen Max (Alibaba)", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    { id: "qwen3.8-max", name: "Qwen 3.8 Max (Alibaba)", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    { id: "qwen-plus", name: "Qwen Plus (Alibaba)", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    { id: "gpt-4o", name: "GPT-4o (OpenAI)", base_url: "https://api.openai.com/v1" },
  ],
  vision: [
    { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision (官方)", base_url: "https://api.deepseek.com" },
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
      <p class="sub" style="margin-bottom:14px">Change your login password. You'll be asked to log in again on other devices.</p>
      <div class="field"><label>Current password</label><input type="password" id="pw-old" placeholder="Current password"></div>
      <div class="field"><label>New password (min 8 characters)</label><input type="password" id="pw-new" placeholder="New password"></div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-primary" id="btn-pw">Update password</button>
        <button class="btn btn-ghost" id="btn-logout2">🚪 Log out</button>
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
    appConfig = await api.getConfig();
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
  $("#btn-pw").addEventListener("click", async () => {
    const r = await api.changePassword($("#pw-old").value, $("#pw-new").value);
    if (r.error) { $("#pw-msg").textContent = r.error; return; }
    if (r.token) api.setToken(r.token);
    $("#pw-msg").textContent = "Password updated ✓";
    toast("Password updated", "success");
    $("#pw-old").value = ""; $("#pw-new").value = "";
  });
  $("#btn-logout2").addEventListener("click", () => { api.setToken(""); showLogin(); });
  $("#btn-drive-save").addEventListener("click", async () => {
    const id = ($("#drive-folder").value || "").trim();
    const proxy = ($("#drive-proxy").value || "").trim();
    const r = await api.saveConfig({ drive_folder_id: id, drive_proxy: proxy });
    if (r.error) { toast(r.error, "error"); return; }
    appConfig = await api.getConfig();
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
  const [cards, quizzes, mistakes] = await Promise.all([
    db.getAllByIndex("cards", "lessonId", id),
    db.getAllByIndex("quizzes", "lessonId", id),
    db.getAllByIndex("mistakes", "lessonId", id),
  ]);
  await Promise.all(cards.map((c) => db.delete("cards", c.id)));
  await Promise.all(quizzes.map((q) => db.delete("quizzes", q.id)));
  await Promise.all(mistakes.map((m) => db.delete("mistakes", m.id)));
  refreshBadges();
  navigate("lessons");
}

/* ---------------- boot ---------------- */
init();
