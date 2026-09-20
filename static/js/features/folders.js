// Feature: 文件夹 (lesson folders). Self-contained folder manager — create
// folders, multi-select lessons, move them into folders, filter by folder.
// Uses the generic `folders` store + a `folderId` field on lessons. No backend
// changes needed; launched independently of the (large) main app.

import { db, escapeHtml, toast, uid } from "../core/index.js";

async function load() {
  const [folders, lessons] = await Promise.all([
    (await db.getAll("folders").catch(() => [])) || [],
    (await db.getAll("lessons").catch(() => [])) || [],
  ]);
  return { folders, lessons };
}

export function renderFolderManager(container) {
  if (!container) return;
  container.innerHTML = `<div class="loading"><div class="spinner"></div>加载文件夹…</div>`;
  load().then(({ folders, lessons }) => {
    let filter = ""; // "" all, "__none__" unfiled, else folderId
    let selectMode = false;
    const selection = new Set();
    const sortedLessons = [...lessons].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    const visible = () => {
      if (filter === "__none__") return sortedLessons.filter((l) => !l.folderId);
      if (filter) return sortedLessons.filter((l) => l.folderId === filter);
      return sortedLessons;
    };

    const render = () => {
      const vis = visible();
      container.innerHTML = `
        <div class="page-head">
          <div class="title-wrap"><h1>📁 文件夹管理</h1><p class="sub">自建文件夹，多选课程放入不同文件夹。</p></div>
        </div>
        <div class="card" style="margin-bottom:16px;display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:12px 14px">
          <button class="btn btn-sm ${selectMode ? "btn-accent" : "btn-ghost"}" id="fm-select">${selectMode ? "✓ 完成" : "☑ 多选"}</button>
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;flex:1;min-width:180px">
            <button class="chip ${!filter ? "active" : ""}" data-folder="">全部 (${sortedLessons.length})</button>
            <button class="chip ${filter === "__none__" ? "active" : ""}" data-folder="__none__">未分类</button>
            ${(folders || []).map((f) => `<button class="chip ${filter === f.id ? "active" : ""}" data-folder="${f.id}">🗂 ${escapeHtml(f.name)} (${lessons.filter((l) => l.folderId === f.id).length})</button>`).join("")}
          </div>
          <input type="text" id="fm-newname" placeholder="新文件夹名" style="flex:1;min-width:130px;padding:7px 10px;border:1.5px solid var(--border);border-radius:9px;font-size:13px">
          <button class="btn btn-sm" id="fm-new">＋ 新建文件夹</button>
          ${selectMode ? `
            <span class="sub" style="margin-left:auto">已选 <b id="fm-count">${selection.size}</b> 门</span>
            <select id="fm-move" class="search-select" style="padding:5px 9px;border:1.5px solid var(--border);border-radius:9px;font-size:13px">
              <option value="">移到文件夹…</option>
              <option value="__none__">📁 移出到未分类</option>
              ${(folders || []).map((f) => `<option value="${f.id}">→ ${escapeHtml(f.name)}</option>`).join("")}
            </select>
            <button class="btn btn-sm btn-primary" id="fm-movebtn">移动</button>` : ""}
        </div>
        <div class="grid">
          ${vis.length ? vis.map((l) => `
            <div class="lesson-item" data-id="${l.id}">
              ${selectMode ? `<input type="checkbox" class="fm-check" data-id="${l.id}" ${selection.has(l.id) ? "checked" : ""} title="选择" style="width:17px;height:17px;flex:none;cursor:pointer">` : ""}
              <div class="lesson-ico">${l.kind === "pdf" ? "📄" : "📑"}</div>
              <div style="flex:1;min-width:0">
                <div style="font-weight:700">${escapeHtml(l.title)}</div>
                <div class="sub">${l.kind.toUpperCase()} · ${fmt(l.createdAt)} · ${l.slides?.length || 0} slides</div>
                ${l.folderId ? `<div class="sub" style="font-size:11px;color:var(--brand)">📁 ${escapeHtml(folderName(folders, l.folderId))}</div>` : ""}
              </div>
            </div>`).join("") : `<div class="empty" style="grid-column:1/-1"><div class="empty-ico">📚</div>${filter === "__none__" ? "所有课都已归档。" : filter ? "这个文件夹还是空的。" : "还没有课程。"}</div>`}
        </div>`;
      bind(vis);
    };

    const bind = (vis) => {
      container.querySelectorAll(".chip[data-folder]").forEach((c) => c.addEventListener("click", () => { filter = c.dataset.folder; render(); }));
      const selBtn = container.querySelector("#fm-select");
      if (selBtn) selBtn.addEventListener("click", () => { selectMode = !selectMode; render(); });
      const newBtn = container.querySelector("#fm-new");
      if (newBtn) newBtn.addEventListener("click", async () => {
        const name = (container.querySelector("#fm-newname")?.value || "").trim();
        if (!name) { toast("请输入文件夹名", "error"); return; }
        await db.put("folders", { id: uid(), name, createdAt: Date.now() });
        toast("文件夹已创建 ✓", "success");
        load().then((d) => render());
      });
      container.querySelectorAll(".fm-check").forEach((c) => c.addEventListener("change", () => {
        const id = c.dataset.id;
        if (c.checked) selection.add(id); else selection.delete(id);
        const cnt = container.querySelector("#fm-count"); if (cnt) cnt.textContent = selection.size;
      }));
      const moveBtn = container.querySelector("#fm-movebtn");
      if (moveBtn) moveBtn.addEventListener("click", async () => {
        const target = container.querySelector("#fm-move")?.value;
        if (!selection.size) { toast("请先勾选课程", "error"); return; }
        const targetId = !target || target === "__none__" ? null : target;
        let done = 0;
        for (const id of selection) {
          const l = lessons.find((x) => x.id === id);
          if (l) { l.folderId = targetId; await db.put("lessons", l); done++; }
        }
        selection.clear();
        toast(`已将 ${done} 门课${targetId ? "移入文件夹" : "移到未分类"} ✓`, "success");
        load().then((d) => render());
      });
    };

    render();
  }).catch(() => { container.innerHTML = `<div class="empty">加载失败</div>`; });
}

function fmt(ts) { return new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
function folderName(folders, id) { return (folders || []).find((f) => f.id === id)?.name || id; }

export const folders = {
  id: "folders",
  label: "📁 文件夹",
  description: "自建文件夹，多选课程分类整理",
  global: true, // doesn't need a pre-selected lesson; renders its own workspace
  render: renderFolderManager,
};
