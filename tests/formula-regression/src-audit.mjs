/* 硬指标 3：src 解析失配 —— 独立复算 + 页面 DOM 对照。
 * 数据侧：每条带 src 的公式，记录 (lessonId, idx) 在课程当前 points 里是否还对得上；
 *         对不上的按 精确标题 → 归一化 → 包含 重新解析（= 3805489 的行为），仍解析不到 = 未归类。
 * 页面侧：公式库总卡片数 / 带 📖 来源按钮的卡片数 / 「📎 未归类」里的卡片数 / 按钮 title 标了
 *         "已按标题重新定位" 的卡片数。
 * 只读，不写任何数据。
 */
import { execFileSync } from 'node:child_process';
import { chromium } from "playwright";
import { LAUNCH_OPTS } from "./launch.mjs";
const BASE = process.env.BASE || 'http://127.0.0.1:8757';
const j = (path) => JSON.parse(execFileSync('curl', ['-s', `${BASE}${path}`], { maxBuffer: 1 << 28 }));

const lessons = j('/api/store/lessons?lite=1').items;
const docs = j('/api/store/formulas').items;
const byId = new Map(lessons.map((l) => [l.id, l]));

// same tier as normPointTitle(): drop parenthetical add-ons, then all punctuation/space/case
const norm = (s) => String(s || '').toLowerCase()
  .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, '');
function resolve(f) {
  const lesson = byId.get(f && f.src && f.src.lessonId);
  if (!lesson) return { kind: 'dead-course' };
  const pts = lesson.points || [];
  const want = String((f.src.title) || '').trim();
  const recIdx = Number.isInteger(f.src.idx) ? f.src.idx : -1;
  const titleAt = (i) => String((pts[i] && pts[i].title) || '').trim();
  if (recIdx >= 0 && recIdx < pts.length && titleAt(recIdx) === want) return { kind: 'exact-at-idx', lesson };
  if (!want) return { kind: 'no-title' };
  const exact = pts.findIndex((p) => String((p && p.title) || '').trim() === want);
  if (exact >= 0) return { kind: 'rematched-exact', lesson, idx: exact };
  const wn = norm(want);
  if (!wn) return { kind: 'unresolved' };
  let hit = -1;
  for (let i = 0; i < pts.length; i++) if (norm(titleAt(i)) === wn) { hit = i; break; }
  if (hit >= 0) return { kind: 'rematched-normalized', lesson, idx: hit };
  for (let i = 0; i < pts.length; i++) {
    const have = norm(titleAt(i));
    if (have && (have.includes(wn) || wn.includes(have))) { hit = i; break; }
  }
  if (hit >= 0) return { kind: 'rematched-contains', lesson, idx: hit };
  return { kind: 'unresolved', lesson };
}

let total = 0, withSrc = 0;
const kinds = {};
for (const d of docs) for (const f of (d.formulas || [])) {
  total++;
  if (!f || !f.src) { kinds['no-src'] = (kinds['no-src'] || 0) + 1; continue; }
  withSrc++;
  const r = resolve(f);
  kinds[r.kind] = (kinds[r.kind] || 0) + 1;
}
const resolvedKinds = ['exact-at-idx', 'rematched-exact', 'rematched-normalized', 'rematched-contains'];
const resolved = resolvedKinds.reduce((s, k) => s + (kinds[k] || 0), 0);
const unresolved = (kinds['unresolved'] || 0) + (kinds['dead-course'] || 0) + (kinds['no-title'] || 0);
const rematched = resolved - (kinds['exact-at-idx'] || 0);

console.log('=== 数据侧（独立复算，只读）===');
console.log(`公式总数=${total}  带 src=${withSrc}`);
for (const k of Object.keys(kinds).sort()) console.log(`  ${k.padEnd(22)} ${kinds[k]}`);
console.log(`→ 解析得到来源（页面上应有 📖 按钮）=${resolved}；解析不到（应落「未归类」）=${unresolved}`);
console.log(`→ 其中记录位置已失效、靠标题重新定位的 = ${rematched}（这就是 3805489 修掉的"指向错误"部分）`);
console.log(`→ 记录 (lessonId, idx) 原地就对得上的 = ${kinds['exact-at-idx'] || 0}`);

const b = await chromium.launch(LAUNCH_OPTS);
const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 1500, height: 1000 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0, 200)); });
await p.goto(`${BASE}/?view=formulas`, { waitUntil: 'load' });
await p.waitForSelector('.formula-group', { timeout: 40000 });
await p.waitForTimeout(2000);
const dom = await p.evaluate(() => {
  const cards = [...document.querySelectorAll('.formula-card')];
  const unfiled = document.querySelector('.formula-group[data-group="__unfiled__"]');
  const srcBtns = [...document.querySelectorAll('.formula-card [data-src-lesson]')];
  return {
    cards: cards.length,
    srcButtons: srcBtns.length,
    rematchedButtons: srcBtns.filter((x) => /已按标题重新定位/.test(x.getAttribute('title') || '')).length,
    unfiledCards: unfiled ? unfiled.querySelectorAll('.formula-card').length : 0,
    unfiledHead: unfiled ? unfiled.querySelector('h3').textContent.trim() : null,
    unfiledChips: unfiled ? [...unfiled.querySelectorAll('.formula-card')].slice(0, 3).map((c) => c.innerText.split('\n').slice(0, 2).join(' | ')) : [],
  };
});
console.log('\n=== 页面 DOM（公式库）===');
console.log(JSON.stringify(dom, null, 1));
console.log(`\n断言 A：库页卡片数 ${dom.cards} == 数据侧公式总数 ${total} →`, dom.cards === total ? 'PASS ✓' : 'FAIL ✗');
console.log(`断言 B：带 📖 来源按钮 ${dom.srcButtons} == 解析得到来源 ${resolved} →`, dom.srcButtons === resolved ? 'PASS ✓' : 'FAIL ✗');
console.log(`断言 C：「未归类」卡片 ${dom.unfiledCards} == 解析不到 ${unresolved} →`, dom.unfiledCards === unresolved ? 'PASS ✓' : 'FAIL ✗');
console.log(`断言 D：标了"已按标题重新定位"的按钮 ${dom.rematchedButtons} == 数据侧重定位数 ${rematched} →`, dom.rematchedButtons === rematched ? 'PASS ✓' : 'FAIL ✗');
console.log('ERRORS:', JSON.stringify(errs));
await b.close();
