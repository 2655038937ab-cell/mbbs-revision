// Feature: 混淆概念辨析 (confusable-concept contrast quiz).
//
// Uses the same LLM to find CONCEPTS THAT ARE EASY TO CONFUSE inside a lesson and
// turns each pair into a single-best-answer comparison question ("Which is true
// of A vs B? / What is the key difference?"). Present as a self-test, track
// mistakes.

import { db, api, escapeHtml, toast, mdFull, parseJSON, chunkText, closeModal } from "../core/index.js";

const SYS = "You are an expert medical educator. Build comparison questions that expose commonly-confused concepts. Respond ONLY with valid JSON.";

const contrastPrompt = (pointsText, n) => `From these key points, find up to ${n} PAIRS of concepts that a student could easily CONFUSE (e.g. similar names, similar mechanisms, near-opposite findings).

For each pair write ONE single-best-answer comparison question:
- "pair": "A vs B" (the two confused concepts)
- "question": a vignette/direct question that forces the learner to distinguish them
- "options": 4-5 answer choices
- "answer": integer index (0-based) of the correct choice
- "explanation": WHY the answer is correct and the key distinguishing fact

Return JSON: {"questions":[{"pair":"...","question":"...","options":["..."],"answer":0,"explanation":"..."}]}

Key points:
${pointsText}`;

export function renderContrast(container, lessonId) {
  if (!container || !lessonId) return;
  container.innerHTML = `<div class="loading"><div class="spinner"></div>正在用 AI 找易混淆概念并出对比题…</div>`;
  db.get("lessons", lessonId).then(async (lesson) => {
    const points = (lesson?.points) || [];
    if (points.length < 2) { container.innerHTML = `<div class="empty"><div class="empty-ico">🔀</div>该课知识点太少（至少 2 个）才能做混淆辨析——先多生成几点，或到「Key points」页补。</div>`; return; }
    const qs = [];
    const chunks = chunkText([points.map((p, i) => `${i + 1}. ${p.title}\n   ${p.explanation || ""}`).join("\n")], 9000);
    for (const c of chunks) {
      const r = await api.llm([{ role: "system", content: SYS }, { role: "user", content: contrastPrompt(c, 8) }], { json_mode: true, max_tokens: 8000 });
      const parsed = parseJSON(r.content);
      if (parsed && Array.isArray(parsed.questions)) qs.push(...parsed.questions);
      if (r.error) { toast("混淆辨析生成失败: " + r.error, "error"); break; }
    }
    if (!qs.length) { container.innerHTML = `<div class="empty"><div class="empty-ico">🤷</div>没生成出对比题（可能知识点太相近或 AI 没找到混淆对）。可重试或先补充知识点。</div>`; return; }
    run(container, lesson, qs);
  }).catch(() => { container.innerHTML = `<div class="empty">加载课程失败</div>`; });
}

function run(container, lesson, questions) {
  let idx = 0;
  let correct = 0;
  const mistakes = [];
  const q = () => {
    const item = questions[idx];
    let answered = false;
    container.innerHTML = `
      <div class="page-head" style="margin-bottom:8px">
        <div class="title-wrap"><h1>🔀 混淆辨析 · ${escapeHtml(lesson.title)}</h1>
          <p class="sub">${idx + 1} / ${questions.length} · 区分易混概念</p></div>
        <button class="btn btn-ghost btn-sm" id="cx-exit">退出</button>
      </div>
      <div class="progress-bar" style="margin-bottom:16px"><div class="progress-fill" style="width:${(idx / questions.length) * 100}%"></div></div>
      <div class="card" style="max-width:720px;margin:0 auto">
        ${item.pair ? `<div style="font-size:12px;font-weight:700;color:var(--amber);margin-bottom:10px">⚠️ 易混：${escapeHtml(item.pair)}</div>` : ""}
        <div style="font-size:17px;font-weight:600;margin-bottom:16px">${mdFull(item.question)}</div>
        <div id="cx-opts">${item.options.map((o, i) => `<button class="q-option" data-i="${i}"><span class="letter">${String.fromCharCode(65 + i)}.</span><span>${escapeHtml(o)}</span></button>`).join("")}</div>
        <div id="cx-fb"></div>
      </div>`;
    $("#cx-exit").addEventListener("click", () => toast("已退出"));
    container.querySelectorAll("#cx-opts .q-option").forEach((btn) => btn.addEventListener("click", () => {
      if (answered) return;
      answered = true;
      const i = parseInt(btn.dataset.i, 10);
      const ok = i === item.answer;
      if (ok) correct++;
      else mistakes.push({ ...item, userAnswer: i });
      container.querySelectorAll("#cx-opts .q-option").forEach((b) => {
        const bi = parseInt(b.dataset.i, 10);
        if (bi === item.answer) b.classList.add("correct");
        else if (bi === i) b.classList.add("wrong");
        b.disabled = true;
      });
      $("#cx-fb").innerHTML = `<div class="q-expl ${ok ? "correct" : "wrong"}"><b>${ok ? "✓ 对" : "✗ 错：正确答案是 " + String.fromCharCode(65 + item.answer)}</b><br>${mdFull(item.explanation || "")}</div>
        <div style="margin-top:14px;text-align:right"><button class="btn btn-primary" id="cx-next">${idx + 1 < questions.length ? "下一题 →" : "完成"}</button></div>`;
      $("#cx-next").addEventListener("click", () => { idx++; if (idx < questions.length) q(); else finish(); });
    }));
  };
  const finish = () => {
    container.innerHTML = `
      <div class="card" style="max-width:560px;margin:40px auto;text-align:center">
        <div class="empty-ico" style="font-size:44px">${correct === questions.length ? "🎉" : "👍"}</div>
        <h2>混淆辨析完成</h2>
        <p class="sub">${correct} / ${questions.length} 答对 · ${mistakes.length} 题易混概念答错（已计入错题本记录）</p>
        <div style="display:flex;gap:10px;justify-content:center;margin-top:16px">
          <button class="btn btn-primary" id="cx-again">再练一次</button>
          <button class="btn btn-ghost" id="cx-back">返回</button>
        </div>
      </div>`;
    $("#cx-back").addEventListener("click", () => closeModal());
  };
  q();
}

export const contrast = {
  id: "contrast",
  label: "🔀 混淆辨析",
  description: "用 AI 找出易混淆概念，出对比题帮你区分",
  render: renderContrast,
};
