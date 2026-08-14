import { db } from "./db.js";
import { api } from "./api.js";
import { newCard, schedule, isDue, scheduleMistake, uid } from "./sm2.js";
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

function shortDay(d) {
  return d.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
}

function openModal(html) {
  $("#modal-root").innerHTML = `<div class="modal-backdrop" id="mb"><div class="modal">${html}</div></div>`;
  $("#mb").addEventListener("mousedown", (e) => {
    if (e.target.id === "mb") closeModal();
  });
}
function closeModal() { $("#modal-root").innerHTML = ""; }

function progressModal(title) {
  openModal(`
    <h2>${escapeHtml(title)}</h2>
    <div class="progress-bar" style="margin:14px 0 18px"><div class="progress-fill" id="pgfill" style="width:0%"></div></div>
    <div id="pgsteps"></div>
    <div id="pgmsg" class="sub" style="margin-top:14px"></div>`);
  const st = [];
  return {
    addStep(label) {
      st.push(label);
      $("#pgsteps").innerHTML = st.map((l, i) =>
        `<div class="step-row"><span class="step-ico" id="ico${i}">⏳</span><span>${escapeHtml(l)}</span></div>`).join("");
    },
    setStep(i, state) {
      const map = { pending: "⏳", running: "🔄", done: "✅", error: "⚠️" };
      const n = $("#ico" + i); if (n) n.textContent = map[state] || "⏳";
    },
    setProgress(p) { const f = $("#pgfill"); if (f) f.style.width = Math.min(100, Math.round(p * 100)) + "%"; },
    msg(m) { const n = $("#pgmsg"); if (n) n.textContent = m; },
    close() { closeModal(); },
  };
}

/* ---------------- app state ---------------- */
let currentView = "dashboard";
let currentLessonId = null;
let currentTab = "points";
let appConfig = null;
let reviewQueue = [];
let reviewPos = 0;
let reviewRequeued = new Set();
let reviewStats = { shown: 0, again: 0, hard: 0, good: 0, easy: 0 };
let mistakeQueue = [];
let mistakePos = 0;
let mistakeStats = { shown: 0, got: 0, missed: 0 };

/* ---------------- time tracking ---------------- */
const ACTIVITY_LABELS = { study: "Reading / notes", review: "Spaced review", quiz: "Quizzes", mistakes: "Mistakes" };
let currentActivity = null;
let activitySeconds = 0;
let lastTick = Date.now();

function setActivity(a) {
  if (a === currentActivity) return;
  flushActivity();
  currentActivity = a;
  activitySeconds = 0;
  lastTick = Date.now();
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
  setInterval(() => {
    const now = Date.now();
    if (currentActivity && document.visibilityState === "visible") {
      activitySeconds += (now - lastTick) / 1000;
    }
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

const pointsPrompt = (chunk) => `Extract the most important knowledge points from these lecture slides for exam revision.

For each key point return:
- "title": a specific, concise heading
- "explanation": 2-4 sentences covering the mechanism, key facts, numbers, and clinical relevance
- "importance": "high" | "medium" | "low"
- "mnemonic": a short memory aid, or null

Return JSON: {"points":[...]}

Slides:
---
${chunk}
---`;

const cardsPrompt = (ptext) => `Create active-recall flashcards from these key points. "front" = a question or cloze-style prompt that forces recall; "back" = a concise, specific answer (1-3 sentences).

Return JSON: {"cards":[{"front":"...","back":"..."}]}

Key points:
${ptext}`;

const mcqPrompt = (ptext, n) => `Create ${n} single-best-answer multiple-choice questions (medical exam style) from these key points.

Each question:
- "question": the clinical vignette or direct question
- "options": array of 4-5 answer choices
- "answer": integer index (0-based) of the correct option
- "explanation": why the answer is correct and why the others are wrong

Return JSON: {"questions":[...]}

Key points:
${ptext}`;

const visionPrompt = `You are analyzing an image from a medical lecture slide. Describe it for a student's revision notes. Return JSON:
{"type":"diagram|chart|histology|anatomy|table|photo|other","caption":"what it shows, one sentence","takeaway":"the key medical point a student should remember from it, one or two sentences"}`;

const ocrPrompt = `Transcribe all the readable text on this page image, preserving headings and reading order. Return JSON: {"text":"..."}`;

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
function pointsToText(points) {
  return points.map((p, i) => `${i + 1}. ${p.title}\n   ${p.explanation}`).join("\n");
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

function computeMasteryMap(cards, quizzes) {
  const quizByLesson = {};
  quizzes.forEach((q) => {
    const prev = quizByLesson[q.lessonId];
    if (!prev || (q.score ?? -1) > (prev.score ?? -1)) quizByLesson[q.lessonId] = q;
  });
  const cardsByLesson = {};
  cards.forEach((c) => { (cardsByLesson[c.lessonId] = cardsByLesson[c.lessonId] || []).push(c); });
  const map = {};
  Object.keys(cardsByLesson).forEach((id) => {
    const lc = cardsByLesson[id];
    const seen = lc.filter((c) => c.reps >= 1).length;
    const mature = lc.filter((c) => c.interval >= 21).length;
    const q = quizByLesson[id];
    let pct = 0;
    if (lc.length && q?.questions?.length) pct = (mature / lc.length) * 0.6 + ((q.score ?? 0) / q.questions.length) * 0.4;
    else if (lc.length) pct = mature / lc.length;
    else if (q?.questions?.length) pct = (q.score ?? 0) / q.questions.length;
    map[id] = { totalCards: lc.length, seen, mature, quiz: q, pct: Math.round(pct * 100) };
  });
  Object.keys(quizByLesson).forEach((id) => {
    if (!map[id]) {
      const q = quizByLesson[id];
      map[id] = { totalCards: 0, seen: 0, mature: 0, quiz: q, pct: q?.questions?.length ? Math.round((q.score ?? 0) / q.questions.length * 100) : 0 };
    }
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
  currentLessonId = null;
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  if (view === "review") setActivity("review"); else setActivity(null);
  refreshBadges();
  switch (view) {
    case "dashboard": renderDashboard(); break;
    case "lessons": renderLessons(); break;
    case "review": renderReview(); break;
    case "mistakes": renderMistakes(); break;
    case "progress": renderProgress(); break;
    case "settings": renderSettings(); break;
    default: renderDashboard();
  }
}

async function refreshBadges() {
  const [cards, mistakes] = await Promise.all([db.getAll("cards"), db.getAll("mistakes")]);
  const now = Date.now();
  const dueCards = cards.filter((c) => isDue(c, now)).length;
  const dueMistakes = mistakes.filter((m) => !m.mastered && m.nextReview <= now).length;
  const rb = $("#review-badge"), mb = $("#mistake-badge");
  rb.textContent = dueCards; rb.hidden = dueCards === 0;
  mb.textContent = dueMistakes; mb.hidden = dueMistakes === 0;
}

/* ---------------- Dashboard ---------------- */
async function renderDashboard() {
  const [lessons, cards, mistakes, log, quizzes] = await Promise.all([
    db.getAll("lessons"), db.getAll("cards"), db.getAll("mistakes"), db.getAll("studyLog"), db.getAll("quizzes"),
  ]);
  const now = Date.now();
  const dueCards = cards.filter((c) => isDue(c, now)).length;
  const dueMistakes = mistakes.filter((m) => !m.mastered && m.nextReview <= now).length;
  const totalPoints = lessons.reduce((a, l) => a + (l.points?.length || 0), 0);
  const mastery = computeMasteryMap(cards, quizzes);
  const lessonsWith = withStats(lessons, cards).map((l) => ({ ...l, pct: mastery[l.id]?.pct ?? 0 }));
  const t = computeTimeStats(log);
  const goalMin = getGoalMinutes();
  const goalPct = Math.min(100, Math.round((t.todaySec / (goalMin * 60)) * 100));
  const goalReached = t.todaySec >= goalMin * 60;

  $("#view").innerHTML = `
    <div class="page-head">
      <div class="title-wrap"><h1>Dashboard</h1><p class="sub">Your active-recall command center.</p></div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost" id="btn-progress">📈 Progress</button>
        <button class="btn btn-primary btn-lg" id="btn-upload">＋ Upload lesson</button>
      </div>
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
      <div class="card stat stat-click" data-go="mistakes"><div class="stat-num" style="color:${dueMistakes ? "var(--red)" : "inherit"}">${dueMistakes}</div><div class="stat-label">Mistakes to review</div></div>
      <div class="card stat stat-click" data-go="progress"><div class="stat-num">${fmtDuration(t.todaySec)}</div><div class="stat-label">Studied today</div></div>
      <div class="card stat stat-click" data-go="progress"><div class="stat-num">🔥 ${t.streak}</div><div class="stat-label">Day streak</div></div>
    </div>
    <div class="grid grid-2" style="margin-bottom:26px">
      <button class="btn btn-accent btn-lg" id="btn-review" ${dueCards ? "" : "disabled"}>🔁 Start spaced review (${dueCards})</button>
      <button class="btn btn-danger btn-lg" id="btn-mistakes" ${dueMistakes ? "" : "disabled"}>📕 Review mistakes (${dueMistakes})</button>
    </div>
    <h2>Recent lessons</h2>
    ${lessonsWith.length ? lessonsWith.sort((a, b) => b.createdAt - a.createdAt).slice(0, 6).map(lessonRow).join("") : emptyState("📚", "No lessons yet — upload your first PPT or PDF.")}
  `;
  $("#btn-upload").addEventListener("click", openUpload);
  $("#btn-progress").addEventListener("click", () => navigate("progress"));
  $("#btn-review").addEventListener("click", () => navigate("review"));
  $("#btn-mistakes").addEventListener("click", () => navigate("mistakes"));
  $("#view").querySelectorAll("[data-go]").forEach((el) => el.addEventListener("click", () => navigate(el.dataset.go)));
  $("#view").querySelectorAll(".lesson-item").forEach((el) =>
    el.addEventListener("click", () => openLesson(el.dataset.id)));
}

function lessonRow(l) {
  const cardCount = l.cardCount ?? 0;
  const due = l.dueCards ?? 0;
  const pct = l.pct ?? 0;
  const showBar = l.pct != null;
  return `
    <div class="lesson-item" data-id="${l.id}">
      <div class="lesson-ico">${l.kind === "pdf" ? "📄" : "📑"}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700">${escapeHtml(l.title)}</div>
        <div class="sub">${l.kind.toUpperCase()} · ${fmtDate(l.createdAt)} · ${l.slides?.length || 0} slides</div>
        ${showBar ? `<div class="progress-bar" style="height:6px;margin-top:8px"><div class="progress-fill" style="width:${pct}%"></div></div>` : ""}
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
  const [lessons, cards, quizzes] = await Promise.all([db.getAll("lessons"), db.getAll("cards"), db.getAll("quizzes")]);
  const mastery = computeMasteryMap(cards, quizzes);
  const lessonsWith = withStats(lessons, cards).map((l) => ({ ...l, pct: mastery[l.id]?.pct ?? 0 }));
  $("#view").innerHTML = `
    <div class="page-head">
      <div class="title-wrap"><h1>Lessons</h1><p class="sub">Everything you've studied, stored locally.</p></div>
      <button class="btn btn-primary" id="btn-upload">＋ Upload lesson</button>
    </div>
    <div class="grid">${lessonsWith.length ? lessonsWith.sort((a, b) => b.createdAt - a.createdAt).map(lessonRow).join("") : emptyState("📚", "No lessons yet.")}</div>
  `;
  $("#btn-upload").addEventListener("click", openUpload);
  $("#view").querySelectorAll(".lesson-item").forEach((el) => el.addEventListener("click", () => openLesson(el.dataset.id)));
}

/* ---------------- Lesson detail ---------------- */
async function openLesson(id) {
  currentLessonId = id;
  currentTab = "points";
  currentView = "lesson";
  setActivity("study");
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
  await renderLessonDetail();
}

async function renderLessonDetail() {
  const lesson = await db.get("lessons", currentLessonId);
  if (!lesson) { navigate("lessons"); return; }
  const cards = await db.getAllByIndex("cards", "lessonId", currentLessonId);
  const quiz = (await db.getAllByIndex("quizzes", "lessonId", currentLessonId))[0];
  const tabs = [
    ["points", "Key points"], ["cards", "Flashcards"], ["quiz", "Quiz"], ["mindmap", "Mind map"], ["figures", "Figures"], ["slides", "Slides"],
  ];
  $("#view").innerHTML = `
    <div class="page-head">
      <div class="title-wrap">
        <h1>${escapeHtml(lesson.title)}</h1>
        <p class="sub">${lesson.kind.toUpperCase()} · ${fmtDate(lesson.createdAt)} · ${lesson.slides?.length || 0} slides · ${lesson.points?.length || 0} points · ${cards.length} cards</p>
      </div>
      <div style="display:flex;gap:8px">
        ${!lesson.points?.length ? `<button class="btn btn-accent" id="btn-gen">✨ Generate study set</button>` : `<button class="btn btn-ghost" id="btn-regen">↻ Re-generate</button>`}
        <button class="btn btn-danger btn-ghost" id="btn-del">🗑</button>
      </div>
    </div>
    <div class="tabs">${tabs.map(([k, label]) => `<button class="tab ${k === currentTab ? "active" : ""}" data-tab="${k}">${label}</button>`).join("")}</div>
    <div id="tab-body"></div>
  `;
  $("#view").querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => { currentTab = t.dataset.tab; renderLessonDetail(); }));
  const gen = $("#btn-gen"), regen = $("#btn-regen");
  if (gen) gen.addEventListener("click", () => generateStudySet(currentLessonId));
  if (regen) regen.addEventListener("click", () => generateStudySet(currentLessonId, true));
  $("#btn-del").addEventListener("click", () => deleteLesson(currentLessonId));
  renderTabBody(lesson, cards, quiz);
}

async function renderTabBody(lesson, cards, quiz) {
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
  body.innerHTML = points.map(kpCard).join("");
}

function kpCard(p) {
  const imp = p.importance === "high" ? "high" : p.importance === "low" ? "low" : "medium";
  return `
    <div class="kp">
      <div class="kp-head">
        <span class="imp imp-${imp}">${imp}</span>
        <h3 class="kp-title">${escapeHtml(p.title)}</h3>
      </div>
      <div class="kp-body">${mdFull(p.explanation)}</div>
      ${p.mnemonic ? `<div class="kp-mnemonic"><b>🧠 Mnemonic:</b> ${md(p.mnemonic)}</div>` : ""}
    </div>`;
}

function renderCardsTab(body, lesson, cards) {
  if (!cards.length) {
    body.innerHTML = emptyState("🃏", "No flashcards yet.", `<div style="margin-top:14px"><button class="btn btn-accent" id="btn-gen3">✨ Generate study set</button></div>`);
    const b = $("#btn-gen3"); if (b) b.addEventListener("click", () => generateStudySet(currentLessonId));
    return;
  }
  let idx = 0, flipped = false;
  body.innerHTML = `
    <div class="flashcard-wrap">
      <div class="sub" style="text-align:center;margin-bottom:12px">Browse · ${cards.length} cards (spaced review is in the Review tab)</div>
      <div class="flashcard" id="fc">
        <div class="card-label">Question</div>
        <div class="card-text" id="fc-text"></div>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:16px">
        <button class="btn" id="fc-prev">← Prev</button>
        <button class="btn" id="fc-next">Next →</button>
      </div>
    </div>`;
  const fc = $("#fc"), text = $("#fc-text");
  function show() {
    flipped = false;
    fc.querySelector(".card-label").textContent = "Question";
    text.className = "card-text";
    text.innerHTML = mdFull(cards[idx].front);
  }
  fc.addEventListener("click", () => {
    if (!flipped) { flipped = true; fc.querySelector(".card-label").textContent = "Answer"; text.className = "card-text answer"; text.innerHTML = mdFull(cards[idx].back); }
  });
  $("#fc-prev").addEventListener("click", () => { idx = (idx - 1 + cards.length) % cards.length; show(); });
  $("#fc-next").addEventListener("click", () => { idx = (idx + 1) % cards.length; show(); });
  show();
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
  const groups = { high: [], medium: [], low: [] };
  points.forEach((p) => { const g = groups[p.importance] || groups.medium; g.push(p); });
  const node = (p) => `<li><div class="node-title">${escapeHtml(p.title)}</div>${p.explanation ? `<div class="node-body">${mdFull(p.explanation)}</div>` : ""}</li>`;
  body.innerHTML = `<div class="mindmap"><h2 style="margin-bottom:8px">🧠 ${escapeHtml(lesson.title)}</h2>
    <ul>${groups.high.length ? `<li><span class="pill imp imp-high" style="display:inline-block;margin:6px 0">High yield</span><ul>${groups.high.map(node).join("")}</ul></li>` : ""}
    ${groups.medium.length ? `<li><span class="pill imp imp-medium" style="display:inline-block;margin:6px 0">Medium</span><ul>${groups.medium.map(node).join("")}</ul></li>` : ""}
    ${groups.low.length ? `<li><span class="pill imp imp-low" style="display:inline-block;margin:6px 0">Low yield</span><ul>${groups.low.map(node).join("")}</ul></li>` : ""}
    </ul></div>`;
}

function renderSlidesTab(body, lesson) {
  body.innerHTML = `<div class="sub" style="margin-bottom:12px">${lesson.slides?.length || 0} slides</div>` +
    (lesson.slides || []).map((s) => `
      <div class="slide-card">
        <div class="slide-head"><span class="slide-num">Slide ${s.index}</span>${s.notes ? `<span class="pill pill-amber">notes</span>` : ""}</div>
        ${s.text ? `<div class="slide-text">${escapeHtml(s.text)}</div>` : `<div class="sub">(no text)</div>`}
        ${s.images?.length ? `<div class="slide-images">${s.images.map((im) => `
          <figure style="margin:0;max-width:220px">
            <img src="${im.dataUrl}" style="max-height:140px;width:100%;object-fit:contain;border:1px solid var(--border);border-radius:8px">
            ${im.caption ? `<figcaption class="sub" style="font-size:12px;margin-top:4px">${escapeHtml(im.caption.caption || im.caption.takeaway || "")}</figcaption>` : ""}
          </figure>`).join("")}</div>` : ""}
        ${s.notes ? `<div class="slide-notes">🎤 ${escapeHtml(s.notes)}</div>` : ""}
      </div>`).join("");
}

function renderFiguresTab(body, lesson) {
  const figs = [];
  (lesson.slides || []).forEach((s) => (s.images || []).forEach((im) => figs.push({ slide: s.index, im })));
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
        <img src="${f.im.dataUrl}" style="width:100%;max-height:280px;object-fit:contain;background:#f8fafc;border:1px solid var(--border);border-radius:10px;cursor:zoom-in" data-full="${f.im.dataUrl}">
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
  const pm = progressModal("Captioning figures");
  pm.addStep(`Caption ${capped.length} figures with vision`);
  pm.setStep(0, "running");
  for (let i = 0; i < capped.length; i++) {
    pm.msg(`Analyzing figure ${i + 1}/${capped.length}…`);
    const r = await api.vision(capped[i].dataUrl, visionPrompt);
    if (!r.error) { const p = parseJSON(r.content); if (p) capped[i].caption = p; }
    pm.setProgress((i + 1) / capped.length);
  }
  await db.put("lessons", lesson);
  pm.setStep(0, "done");
  setTimeout(() => { pm.close(); renderLessonDetail(); }, 500);
}

/* ---------------- Upload flow ---------------- */
function openUpload() {
  openModal(`
    <h2>Upload a lesson</h2>
    <p class="sub" style="margin-bottom:16px">Supported: <b>.pptx</b> and <b>.pdf</b>. The file is parsed locally on your machine and never leaves it (except AI calls you explicitly run).</p>
    <div class="dropzone" id="dz">
      <div class="dz-ico">📥</div>
      <div style="font-weight:600;margin-top:6px">Drag & drop your file here, or click to browse</div>
      <div class="sub">PowerPoint (.pptx) or PDF (.pdf)</div>
      <input type="file" id="dz-input" accept=".pptx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation">
    </div>
    <div id="up-status"></div>
  `);
  const dz = $("#dz"), input = $("#dz-input");
  dz.addEventListener("click", () => input.click());
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("drag"); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
  input.addEventListener("change", () => { if (input.files[0]) handleFile(input.files[0]); });
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

async function saveParsedLesson(res, filename) {
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
  toast("Lesson saved ✓");
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

/* ---------------- AI generation pipeline ---------------- */
async function generateStudySet(lessonId, regenerate = false) {
  const lesson = await db.get("lessons", lessonId);
  if (!lesson) return;
  const pm = progressModal(regenerate ? "Re-generating study set" : "Generating study set");
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
      for (let i = 0; i < scanned.length; i++) {
        const s = scanned[i];
        const img = (s.images || []).find((im) => im.kind === "page");
        pm.msg(`Reading page ${s.index}… (${i + 1}/${scanned.length})`);
        const r = await api.vision(img.dataUrl, ocrPrompt);
        if (!r.error) { const p = parseJSON(r.content); if (p?.text) s.text = (s.text ? s.text + "\n" : "") + p.text; }
        pm.setProgress(((i + 1) / scanned.length) * 0.15);
      }
      pm.setStep(step, "done");
    } else {
      pm.addStep(`${scanned.length} image-only page(s) — skipped (no vision key)`);
      pm.setStep(step, "done");
    }
    step++;
  }

  // Build slide text AFTER any OCR
  const blocks = buildSlideBlocks(lesson.slides || []);
  const chunks = chunkText(blocks, 5500);

  // Step — extract key points
  pm.addStep(`Extract key points${chunks.length > 1 ? ` (${chunks.length} parts)` : ""}`);
  pm.setStep(step, chunks.length ? "running" : "done");
  let points = lesson.points || [];
  let newPoints = [];
  if (chunks.length) {
    for (let i = 0; i < chunks.length; i++) {
      pm.msg(`Analyzing slides part ${i + 1}/${chunks.length}…`);
      const r = await api.llm([{ role: "system", content: SYS }, { role: "user", content: pointsPrompt(chunks[i]) }], { json_mode: true, max_tokens: 8000 });
      if (r.error) { pm.setStep(step, "error"); pm.msg("Key points: " + r.error); toast("Points failed: " + r.error, "error"); break; }
      const parsed = parseJSON(r.content);
      if (parsed && Array.isArray(parsed.points)) newPoints = newPoints.concat(parsed.points);
      pm.setProgress(0.15 + ((i + 1) / chunks.length) * 0.3);
    }
    if (newPoints.length) { points = newPoints; pm.setStep(step, "done"); } else pm.setStep(step, "error");
  }
  step++;

  // Step — flashcards
  pm.addStep("Generate flashcards");
  let cards = [];
  if (points.length) {
    pm.setStep(step, "running");
    const pchunks = chunkText([pointsToText(points)], 9000);
    for (let i = 0; i < pchunks.length; i++) {
      pm.msg(`Writing flashcards ${i + 1}/${pchunks.length}…`);
      const r = await api.llm([{ role: "system", content: SYS }, { role: "user", content: cardsPrompt(pchunks[i]) }], { json_mode: true, max_tokens: 8000 });
      if (r.error) { pm.setStep(step, "error"); toast("Flashcards failed: " + r.error, "error"); break; }
      const parsed = parseJSON(r.content);
      if (parsed && Array.isArray(parsed.cards)) cards = cards.concat(parsed.cards.map((c) => newCard({ lessonId, front: c.front, back: c.back })));
    }
    if (cards.length) pm.setStep(step, "done"); else pm.setStep(step, "error");
    pm.setProgress(0.5);
  } else pm.setStep(step, "done");
  step++;

  // Step — quiz
  pm.addStep("Generate quiz questions");
  let quiz = null;
  if (points.length) {
    pm.setStep(step, "running");
    const pchunks = chunkText([pointsToText(points)], 9000);
    const qs = [];
    for (let i = 0; i < pchunks.length; i++) {
      pm.msg(`Writing questions ${i + 1}/${pchunks.length}…`);
      const r = await api.llm([{ role: "system", content: SYS }, { role: "user", content: mcqPrompt(pchunks[i], 6) }], { json_mode: true, max_tokens: 8000 });
      if (r.error) { pm.setStep(step, "error"); toast("Quiz failed: " + r.error, "error"); break; }
      const parsed = parseJSON(r.content);
      if (parsed && Array.isArray(parsed.questions)) qs.push(...parsed.questions);
    }
    if (qs.length) {
      quiz = { id: uid(), lessonId, createdAt: Date.now(), questions: qs.slice(0, 25), userAnswers: [], score: null, completed: false };
      pm.setStep(step, "done");
    } else pm.setStep(step, "error");
    pm.setProgress(0.6);
  } else pm.setStep(step, "done");
  step++;

  // Step — caption figures with vision
  const imgJobs = [];
  (lesson.slides || []).forEach((s) => (s.images || []).slice(0, 3).forEach((im) => imgJobs.push({ im })));
  const jobs = imgJobs.slice(0, 24);
  if (jobs.length && hasVision) {
    pm.addStep(`Caption figures with vision (${jobs.length})`);
    pm.setStep(step, "running");
    let done = 0;
    for (const { im } of jobs) {
      done++;
      pm.msg(`Analyzing figure ${done}/${jobs.length}…`);
      const r = await api.vision(im.dataUrl, visionPrompt);
      if (!r.error) { const p = parseJSON(r.content); if (p) im.caption = p; }
      pm.setProgress(0.6 + (done / jobs.length) * 0.4);
    }
    pm.setStep(step, "done");
  } else if (jobs.length) {
    pm.addStep(`Caption figures (${jobs.length}) — skipped (no vision key)`);
    pm.setStep(step, "done");
  }

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
  pm.setProgress(1);
  pm.msg(`Done — ${points.length} points, ${cards.length} cards, ${quiz?.questions.length || 0} questions.`);
  setTimeout(() => { pm.close(); openLesson(lessonId); refreshBadges(); }, 700);
}

async function regenerateQuiz(lessonId) {
  const lesson = await db.get("lessons", lessonId);
  const pm = progressModal("Regenerating quiz");
  pm.addStep("Generate quiz questions");
  pm.setStep(0, "running");
  const pchunks = chunkText([pointsToText(lesson.points || [])], 9000);
  const qs = [];
  for (let i = 0; i < pchunks.length; i++) {
    const r = await api.llm([{ role: "system", content: SYS }, { role: "user", content: mcqPrompt(pchunks[i], 6) }], { json_mode: true, max_tokens: 8000 });
    if (r.error) { pm.setStep(0, "error"); toast(r.error, "error"); break; }
    const parsed = parseJSON(r.content);
    if (parsed?.questions) qs.push(...parsed.questions);
  }
  if (qs.length) {
    const quiz = { id: uid(), lessonId, createdAt: Date.now(), questions: qs.slice(0, 25), userAnswers: [], score: null, completed: false };
    await db.put("quizzes", quiz);
    pm.setStep(0, "done");
  } else pm.setStep(0, "error");
  setTimeout(() => { pm.close(); renderLessonDetail(); }, 500);
}

/* ---------------- Quiz taking ---------------- */
let quizSession = null;

async function startQuiz(lessonId) {
  const quiz = (await db.getAllByIndex("quizzes", "lessonId", lessonId))[0];
  const lesson = await db.get("lessons", lessonId);
  if (!quiz) return;
  setActivity("quiz");
  quizSession = { quiz, lesson, pos: 0, answers: [], wrong: [] };
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
    if (!correct) quizSession.wrong.push({ ...q, userAnswer: i });
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

  // Record mistakes (dedupe by question text within lesson)
  const existing = await db.getAllByIndex("mistakes", "lessonId", lesson.id);
  for (const w of wrong) {
    const dup = existing.find((m) => m.question === w.question && !m.mastered);
    if (dup) {
      dup.userAnswer = w.options[w.userAnswer];
      dup.nextReview = Date.now();
      dup.reviewCount = (dup.reviewCount || 0) + 0;
      await db.put("mistakes", dup);
    } else {
      await db.put("mistakes", {
        id: uid(), lessonId: lesson.id, lessonTitle: lesson.title,
        question: w.question, options: w.options, answer: w.answer,
        userAnswer: w.userAnswer, explanation: w.explanation,
        createdAt: Date.now(), nextReview: Date.now(), stage: 0, reviewCount: 0, mastered: false,
      });
    }
  }
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

/* ---------------- Spaced review ---------------- */
async function renderReview() {
  const cards = await db.getAll("cards");
  const due = cards.filter((c) => isDue(c)).sort((a, b) => a.due - b.due);
  if (!due.length) {
    $("#view").innerHTML = emptyState("🎉", "All caught up! No cards due right now.", `<div style="margin-top:14px"><button class="btn btn-primary" id="r-lessons">📚 Browse lessons</button></div>`);
    $("#r-lessons").addEventListener("click", () => navigate("lessons"));
    return;
  }
  reviewQueue = due;
  reviewPos = 0;
  reviewRequeued = new Set();
  reviewStats = { shown: 0, again: 0, hard: 0, good: 0, easy: 0 };
  showReviewCard();
}

function showReviewCard() {
  if (reviewPos >= reviewQueue.length) { finishReview(); return; }
  const card = reviewQueue[reviewPos];
  let flipped = false;
  $("#view").innerHTML = `
    <div class="page-head"><div class="title-wrap"><h1>Spaced review</h1><p class="sub">${reviewQueue.length - reviewPos} card${reviewQueue.length - reviewPos === 1 ? "" : "s"} remaining</p></div></div>
    <div class="review-stage">
      <div class="flashcard" id="r-fc">
        <div class="card-label">Question</div>
        <div class="card-text" id="r-text"></div>
        <div class="sub" style="margin-top:14px">Tap to reveal answer</div>
      </div>
      <div id="r-grades" hidden>
        <div class="review-grade">
          <button class="grade-btn grade-0" data-g="0">Again</button>
          <button class="grade-btn grade-1" data-g="1">Hard</button>
          <button class="grade-btn grade-2" data-g="2">Good</button>
          <button class="grade-btn grade-3" data-g="3">Easy</button>
        </div>
      </div>
    </div>`;
  const fc = $("#r-fc"), text = $("#r-text"), grades = $("#r-grades");
  text.innerHTML = mdFull(card.front);
  fc.addEventListener("click", () => {
    if (flipped) return;
    flipped = true;
    fc.querySelector(".card-label").textContent = "Answer";
    text.className = "card-text answer";
    text.innerHTML = mdFull(card.back);
    fc.querySelector(".sub").remove();
    grades.hidden = false;
  });
  grades.querySelectorAll(".grade-btn").forEach((b) => b.addEventListener("click", () => gradeCard(parseInt(b.dataset.g, 10))));
}

async function gradeCard(grade) {
  const card = reviewQueue[reviewPos];
  const updated = schedule(card, grade);
  await db.put("cards", updated);
  reviewStats.shown++;
  if (grade === 0) reviewStats.again++;
  else if (grade === 1) reviewStats.hard++;
  else if (grade === 2) reviewStats.good++;
  else reviewStats.easy++;
  if (grade === 0 && !reviewRequeued.has(card.id)) {
    reviewRequeued.add(card.id);
    reviewQueue.push(updated);
  }
  reviewPos++;
  showReviewCard();
}

function finishReview() {
  refreshBadges();
  $("#view").innerHTML = `
    <div class="card" style="max-width:520px;margin:40px auto;text-align:center">
      <div class="empty-ico" style="font-size:44px">✅</div>
      <h2>Review complete</h2>
      <p class="sub">${reviewStats.shown} reviews — Again ${reviewStats.again} · Hard ${reviewStats.hard} · Good ${reviewStats.good} · Easy ${reviewStats.easy}</p>
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
  showMistakeCard();
}

function showMistakeCard() {
  if (mistakePos >= mistakeQueue.length) { finishMistakeReview(); return; }
  const m = mistakeQueue[mistakePos];
  let revealed = false;
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
      <button class="btn btn-primary" id="mr-show" style="width:100%">Show answer</button>
    </div>`;
  $("#mr-show").addEventListener("click", () => { revealed = true; $("#mr-show").hidden = true; $("#mr-reveal").hidden = false; });
  $("#mr-got").addEventListener("click", () => gradeMistake(m, true));
  $("#mr-miss").addEventListener("click", () => gradeMistake(m, false));
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
  const { lesson, totalCards, seen, mature, quiz, pct } = x;
  const quizTxt = quiz?.questions?.length ? `${quiz.score ?? 0}/${quiz.questions.length}` : "—";
  return `
    <div class="lp-row" data-id="${lesson.id}">
      <div class="lp-top">
        <span class="lp-title">${escapeHtml(lesson.title)}</span>
        <span class="lp-pct">${pct}%</span>
      </div>
      <div class="progress-bar" style="height:8px"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="lp-meta sub">cards ${seen}/${totalCards} seen · ${mature}/${totalCards} mastered · quiz ${quizTxt}</div>
    </div>`;
}

async function renderProgress() {
  const [lessons, cards, quizzes, log] = await Promise.all([
    db.getAll("lessons"), db.getAll("cards"), db.getAll("quizzes"), db.getAll("studyLog"),
  ]);
  const t = computeTimeStats(log);

  // per-lesson mastery
  const quizByLesson = {};
  quizzes.forEach((q) => {
    const prev = quizByLesson[q.lessonId];
    if (!prev || (q.score ?? -1) > (prev.score ?? -1)) quizByLesson[q.lessonId] = q;
  });
  const cardsByLesson = {};
  cards.forEach((c) => { (cardsByLesson[c.lessonId] = cardsByLesson[c.lessonId] || []).push(c); });
  const lp = lessons.map((l) => {
    const lc = cardsByLesson[l.id] || [];
    const seen = lc.filter((c) => c.reps >= 1).length;
    const mature = lc.filter((c) => c.interval >= 21).length;
    const q = quizByLesson[l.id];
    let pct = 0;
    if (lc.length && q?.questions?.length) pct = (mature / lc.length) * 0.6 + ((q.score ?? 0) / q.questions.length) * 0.4;
    else if (lc.length) pct = mature / lc.length;
    else if (q?.questions?.length) pct = (q.score ?? 0) / q.questions.length;
    return { lesson: l, totalCards: lc.length, seen, mature, quiz: q, pct: Math.round(pct * 100) };
  });
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
      <div class="sub" style="margin-bottom:6px">Click a lesson to open it. Mastery = 60% mature cards + 40% best quiz score.</div>
      ${lp.length ? lp.sort((a, b) => b.lesson.createdAt - a.lesson.createdAt).map(lpRow).join("") : '<div class="sub">No lessons yet.</div>'}
    </div>`;

  $("#view").querySelectorAll(".lp-row").forEach((el) => el.addEventListener("click", () => openLesson(el.dataset.id)));
}

/* ---------------- Settings ---------------- */
async function renderSettings() {
  const cfg = await api.getConfig();
  const field = (key, label, placeholder) => {
    const v = cfg[key] || {};
    return `
      <div class="field">
        <label>${label}</label>
        <input type="text" id="set-${key}-base" value="${escapeHtml(v.base_url || "")}" placeholder="https://...">
        <div style="display:flex;gap:10px;margin-top:8px">
          <input type="text" id="set-${key}-model" value="${escapeHtml(v.model || "")}" placeholder="model id">
          <input type="password" id="set-${key}-key" placeholder="${cfg["has_" + key + "_key"] ? "key saved — leave blank to keep" : "API key"}">
        </div>
        <div class="hint">${cfg["has_" + key + "_key"] ? "✓ key saved (" + (v.api_key || "") + ")" : "No key set yet."}</div>
      </div>`;
  };
  $("#view").innerHTML = `
    <div class="page-head"><div class="title-wrap"><h1>Settings</h1><p class="sub">Configure your AI providers. Everything is stored on the server and synced across your devices.</p></div></div>
    <div class="grid grid-2">
      <div class="card"><h3>🧠 Text model (notes / cards / quiz)</h3><p class="sub" style="margin-bottom:14px">DeepSeek — used to distill key points and write questions.</p>${field("text", "Base URL", "https://api.deepseek.com")}</div>
      <div class="card"><h3>🖼 Vision model (figures)</h3><p class="sub" style="margin-bottom:14px">Alibaba Bailian / Qwen-VL — used to caption figures & diagrams.</p>${field("vision", "Base URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")}</div>
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
    </div>
    <div class="card" style="margin-top:26px">
      <h3>How it works</h3>
      <ul class="sub" style="padding-left:20px;line-height:1.8">
        <li>Upload a <b>.pptx</b> or <b>.pdf</b> — it's parsed and stored on the server (SQLite), synced across your devices.</li>
        <li>“Generate study set” calls DeepSeek for key points, active-recall flashcards and MCQ quizzes, and Qwen-VL for figure captions.</li>
        <li>Review uses <b>spaced repetition</b> (SM-2). Wrong quiz answers go to your <b>mistake notebook</b> for re-testing.</li>
      </ul>
    </div>
    <div class="card" style="margin-top:26px">
      <h3>🔒 Account</h3>
      <p class="sub" style="margin-bottom:14px">Change your login password. You'll be asked to log in again on other devices.</p>
      <div class="field"><label>Current password</label><input type="password" id="pw-old" placeholder="Current password"></div>
      <div class="field"><label>New password (min 4 characters)</label><input type="password" id="pw-new" placeholder="New password"></div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-primary" id="btn-pw">Update password</button>
        <button class="btn btn-ghost" id="btn-logout2">🚪 Log out</button>
        <span class="sub" id="pw-msg"></span>
      </div>
    </div>`;
  $("#btn-save").addEventListener("click", async () => {
    const cfgOut = {
      text: { base_url: $("#set-text-base").value, model: $("#set-text-model").value, api_key: $("#set-text-key").value },
      vision: { base_url: $("#set-vision-base").value, model: $("#set-vision-model").value, api_key: $("#set-vision-key").value },
    };
    const res = await api.saveConfig(cfgOut);
    if (res.error) { toast(res.error, "error"); return; }
    appConfig = await api.getConfig();
    renderAiStatus();
    $("#save-msg").textContent = "Saved ✓";
    toast("Settings saved", "success");
  });
  $("#btn-goal").addEventListener("click", async () => {
    const ok = await saveGoalMinutes($("#goal-min").value);
    if (ok) { $("#goal-msg").textContent = "Saved ✓"; toast("Daily goal updated", "success"); }
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
}

/* ---------------- Delete lesson ---------------- */
async function deleteLesson(id) {
  if (!confirm("Delete this lesson and all its cards / quizzes / mistakes?")) return;
  await db.delete("lessons", id);
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
