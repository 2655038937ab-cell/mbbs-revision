// Feature: per-knowledge-point "测一测" (active-recall self test).
//
// For a lesson, walk through each knowledge point as a recall drill:
//   1. show ONLY the concept title — the user recalls the key facts,
//   2. use the same LLM to generate a short probe question that prompts recall,
//   3. reveal the full point (explanation + mnemonic),
//   4. the user self-rates how well they recalled.
//
// Import path:  import { conceptTest } from "./features/conceptTest.js";

import { db, api, escapeHtml, toast, mdFull, parseJSON, closeModal } from "../core/index.js";

const SYS = "You are an expert medical educator creating concise, exam-focused active-recall checks. Respond with ONLY valid JSON (no markdown fences, no commentary).";

const probesPrompt = (pointsText) => `For each knowledge point below, write ONE short active-recall probe question. It must force the learner to recall the CORE fact/mechanism without giving it away (e.g. a "What/Why/When" question, or a one-blank cloze). Keep it to one sentence.

Return JSON: {"probes":[{"title":"exact point title","q":"the probe question"}]}

Key points:
${pointsText}`;

async function generateProbes(points) {
  const map = {};
  if (!points?.length) return map;
  const ptext = points.map((p, i) => `${i + 1}. ${p.title}\n   ${p.explanation || ""}`).join("\n");
  try {
    const r = await api.llm([{ role: "system", content: SYS }, { role: "user", content: probesPrompt(ptext) }], { json_mode: true, max_tokens: 8000 });
    const parsed = parseJSON(r.content);
    if (parsed && Array.isArray(parsed.probes)) {
      parsed.probes.forEach((pr) => { if (pr?.title) map[pr.title] = pr.q; });
    }
  } catch { /* probes are best-effort; fall back to no probe */ }
  return map;
}

export function renderConceptTest(container, lessonId) {
  if (!container || !lessonId) return;
  container.innerHTML = `<div class="loading"><div class="spinner"></div>正在准备测一测…</div>`;
  db.get("lessons", lessonId).then(async (lesson) => {
    const points = (lesson?.points) || [];
    if (!points.length) { container.innerHTML = `<div class="empty"><div class="empty-ico">📝</div>该课还没有提炼出知识点——先「生成笔记」再测。</div><div class="sub" style="text-align:center;margin-top:8px">或到「Key points」页生成。</div>`; return; }
    const probes = await generateProbes(points);
    run(container, lesson, points, probes);
  }).catch(() => { container.innerHTML = `<div class="empty">加载课程失败</div>`; });
}

function run(container, lesson, points, probes) {
  let idx = (points.findIndex((p) => !p.testResult)); // resume at first untested
  if (idx < 0) idx = 0; // all tested -> restart from top (results kept)
  let revealed = false;
  const stats = { recalled: 0, partial: 0, missed: 0 };
  const card = () => {
    const p = points[idx];
    const probe = probes[p.title];
    revealed = false;
    container.innerHTML = `
      <div class="page-head" style="margin-bottom:8px">
        <div class="title-wrap"><h1>测一测 · ${escapeHtml(lesson.title)}</h1>
          <p class="sub">${idx + 1} / ${points.length} · 主动回忆（先别看答案）${p.testResult ? " · 已测过，本次重测" : ""}</p></div>
        <button class="btn btn-ghost btn-sm" id="ct-exit">退出</button>
      </div>
      <div class="progress-bar" style="margin-bottom:16px"><div class="progress-fill" style="width:${(idx / points.length) * 100}%"></div></div>
      <div class="card" style="max-width:720px;margin:0 auto">
        <div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--text-3);margin-bottom:10px">概念 ${idx + 1} — 先凭记忆回想</div>
        <div style="font-size:20px;font-weight:700;margin-bottom:14px">${escapeHtml(p.title)}</div>
        ${probe ? `<div class="sub" style="background:var(--brand-soft);padding:10px 13px;border-radius:9px;margin-bottom:14px">💡 提示问题：${escapeHtml(probe)}</div>` : `<div class="sub" style="color:var(--text-3);margin-bottom:14px">回想这个概念的机制/关键数字/临床意义，再点下方按钮核对。</div>`}
        <div id="ct-reveal" hidden>
          <div class="kp-body" style="border-top:1px solid var(--border);padding-top:14px">${mdFull(p.explanation || "")}</div>
          ${p.mnemonic ? `<div class="kp-mnemonic" style="margin-top:10px"><b>🧠 记忆口诀：</b>${mdFull(p.mnemonic)}</div>` : ""}
          <div class="review-grade" style="margin-top:16px">
            <button class="grade-btn grade-0" data-g="missed">😐 没记住</button>
            <button class="grade-btn grade-1" data-g="partial">🙂 部分</button>
            <button class="grade-btn grade-2" data-g="recalled">😎 记住了</button>
          </div>
        </div>
        <button class="btn btn-primary btn-lg" id="ct-show" style="width:100%">显示答案 · 核对</button>
      </div>`;
    $("#ct-exit").addEventListener("click", () => { toast("进度已保存"); closeModal(); });
    $("#ct-show").addEventListener("click", () => {
      revealed = true;
      $("#ct-show").hidden = true;
      $("#ct-reveal").hidden = false;
    });
    container.querySelectorAll(".grade-btn").forEach((b) => b.addEventListener("click", () => {
      const g = b.dataset.g;
      stats[g]++;
      // Save this point's self-rating so progress survives refresh/exit.
      points[idx].testResult = { grade: g, ts: Date.now() };
      lesson.points = points;
      db.put("lessons", lesson).catch(() => {});
      idx++;
      if (idx < points.length) card(); else finish();
    }));
  };
  const finish = () => {
    const total = points.length;
    const pct = Math.round((((stats.recalled * 1 + stats.partial * 0.5) / total) * 100));
    container.innerHTML = `
      <div class="card" style="max-width:560px;margin:40px auto;text-align:center">
        <div class="empty-ico" style="font-size:44px">${pct >= 80 ? "🎉" : pct >= 50 ? "👍" : "📚"}</div>
        <h2>测一测完成</h2>
        <p class="sub">${total} 个概念 — 记住 ${stats.recalled} · 部分 ${stats.partial} · 没记住 ${stats.missed} · 掌握率约 ${pct}%</p>
        <p class="sub" style="margin-top:6px">没记住的会进错题本，建议到「Review/错题」再刷。</p>
        <div style="display:flex;gap:10px;justify-content:center;margin-top:16px">
          <button class="btn btn-primary" id="ct-again">再测一遍</button>
          <button class="btn btn-ghost" id="ct-back">返回</button>
        </div>
      </div>`;
    $("#ct-back").addEventListener("click", () => closeModal());
  };
  card();
}

export const conceptTest = {
  id: "conceptTest",
  label: "📝 测一测",
  description: "对每个知识点做主动回忆自测（先回想→核对→自评）",
  render: renderConceptTest,
};
