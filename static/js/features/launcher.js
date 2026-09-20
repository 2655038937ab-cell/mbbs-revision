// Self-contained launcher for pluggable feature modules. Adds a floating "训练"
// button that opens a modal to pick a feature. Features marked `global` (e.g.
// folders) run without selecting a lesson; per-lesson features (测一测/混淆辨析)
// ask for a lesson first. Lives OUTSIDE app.js so features can be added without
// touching the (large, parallel-edited) main app.

import { features } from "./index.js";
import { db, escapeHtml, openModal, closeModal } from "../core/index.js";

const GLOBAL = features.filter((f) => f.global);
const PER_LESSON = features.filter((f) => !f.global);

function renderIntoModal(f, lessonId) {
  const mb = document.getElementById("modal-root");
  mb.innerHTML = `<div class="modal-backdrop" id="mb"><div class="modal" id="view-modal"></div></div>`;
  document.getElementById("mb").addEventListener("mousedown", (e) => { if (e.target.id === "mb") closeModal(); });
  f.render(document.getElementById("view-modal"), lessonId);
}

function featureButtons(handler) {
  return features.map((f) => `<button class="q-option" data-f="${f.id}"><span class="letter">${f.global ? "🗂" : f.id === "conceptTest" ? "📝" : "🔀"}</span><span><b>${escapeHtml(f.label)}</b><br><span class="sub">${escapeHtml(f.description)}</span></span></button>`).join("");
}

function pickLessonAndLaunch() {
  if (GLOBAL.length) {
    openModal(`
      <h2>✨ 训练 & 工具</h2>
      <p class="sub" style="margin-bottom:14px">选一个功能。</p>
      <div class="grid" style="grid-template-columns:1fr;gap:10px">${featureButtons()}</div>`);
    document.querySelectorAll("#modal-root .q-option[data-f]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const f = features.find((x) => x.id === btn.dataset.f);
        if (!f) return;
        if (f.global) { renderIntoModal(f, null); }
        else perLessonLaunch(f);
      });
    });
    return;
  }
  perLessonLaunch(PER_LESSON[0]);
}

function perLessonLaunch(f) {
  db.getAll("lessons").then((lessons) => {
    const sorted = [...(lessons || [])].sort((a, b) => b.createdAt - a.createdAt);
    if (!sorted.length) {
      openModal(`<h2>暂无课程</h2><p>请先上传/创建一门课，再使用智能训练。</p><button class="btn btn-primary" id="pk-close" style="margin-top:14px">好</button>`);
      document.getElementById("pk-close").addEventListener("click", closeModal);
      return;
    }
    openModal(`
      <h2>${escapeHtml(f.label)}</h2>
      <p class="sub" style="margin-bottom:14px">选择一门课开始。</p>
      <div class="field"><label>选择课程</label>
        <select id="pk-lesson" style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:9px;font-size:14px">
          ${sorted.map((l) => `<option value="${l.id}">${escapeHtml(l.title)}</option>`).join("")}
        </select>
        <button class="btn btn-primary" id="pk-go" style="width:100%;margin-top:12px">开始</button>
      </div>`);
    document.getElementById("pk-go").addEventListener("click", () => {
      const lid = document.getElementById("pk-lesson")?.value;
      if (lid) renderIntoModal(f, lid);
    });
  }).catch(() => openModal(`<h2>加载课程失败</h2><button class="btn" id="pk-close" style="margin-top:14px">关闭</button>`));
}

export function initFeatureLauncher() {
  if (document.getElementById("feature-launcher")) return;
  const btn = document.createElement("button");
  btn.id = "feature-launcher";
  btn.className = "btn btn-accent";
  btn.textContent = "✨ 训练";
  btn.title = "测一测 / 混淆辨析 / 文件夹整理";
  btn.style.cssText = "position:fixed;bottom:22px;left:22px;z-index:150;border-radius:99px;padding:11px 18px;box-shadow:var(--shadow)";
  btn.addEventListener("click", pickLessonAndLaunch);
  document.body.appendChild(btn);
}
