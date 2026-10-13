/* 阶段三：对一门「还没有公式」的课（物理化学 第四章 酶 / 学科 phys-chem-cmb）走真实提取流程 ——
 * 只把 /api/llm 的回复换成固定的假公式（零 token 成本），其余（写库、渲染、跳转）全是真的。
 * 断言：库页与课内都出现、数字一致；跑完删除新建的 doc，核对整个 formulas 库的 md5 还原。 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { chromium } from "playwright";
import { LAUNCH_OPTS, assertLocal } from "./launch.mjs";
const BASE = process.env.BASE || 'http://127.0.0.1:8757';
assertLocal(BASE);
const SUBJ = 'phys-chem-cmb';
const LESSON = '4fbc1456-0b63-48fa-9feb-da165d934c37';
const md5 = (o) => crypto.createHash('md5').update(JSON.stringify(o, Object.keys(o).sort())).digest('hex');
const curlJson = (path) => JSON.parse(execFileSync('curl', ['-s', `${BASE}${path}`], { maxBuffer: 1 << 28 }));
const storeMd5 = () => md5(curlJson('/api/store/formulas').items);

const lesson = curlJson(`/api/store/lessons/${LESSON}`).item;
const titles = (lesson.points || []).map(p => String(p.title || '').trim()).filter(Boolean);
console.log(`课程「${lesson.title}」知识点 ${titles.length} 个`);
const before = storeMd5();
const hadDoc = curlJson('/api/store/formulas').items.some(d => d.subjectId === SUBJ);
console.log(`formulas 库 md5(before)=${before}  已有 ${SUBJ} doc? ${hadDoc}`);

const mk = (n, i) => ({
  name: `ZZ MOCK 公式 ${n}`,
  latex: `E_{mock${n}} = m c^{2} + ${n}`,
  symbols: 'E 能量；m 质量；c 光速', usage: `测试用第 ${n} 条`, conditions: '仅用于回归测试',
  scenarios: '- 测试场景', examples: [{ q: `例${n}`, work: '...', answer: String(n), why: '测试' }],
  examQuestion: { q: `真题${n}`, work: '...', answer: String(n), point: '测试' },
  params: [], point: titles[(i * 7) % titles.length] || '',
});
const b = await chromium.launch(LAUNCH_OPTS);
const ctx = await b.newContext({ serviceWorkers: 'block' });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
let calls = 0;
await p.route('**/api/llm', async (r) => {
  const n = ++calls;
  const formulas = [mk(n * 2 - 1, n), mk(n * 2, n + 1)];
  await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: JSON.stringify({ formulas }), usage: { total_tokens: 0 } }) });
});
await p.goto(`${BASE}/?view=formulas`, { waitUntil: 'load' });
await p.waitForSelector('.formula-group', { timeout: 40000 });
await p.waitForTimeout(1500);
await p.locator(`.formula-group[data-group="${SUBJ}"] [data-gen-formula]`).first().click();
await p.waitForTimeout(12000);
console.log(`提取：/api/llm 调用 ${calls} 次（批次数）`);
const lib = await p.evaluate((sid) => {
  const g = document.querySelector(`.formula-group[data-group="${sid}"]`);
  return {
    sub: g ? g.querySelector('h3').parentElement.querySelector('.sub').textContent.trim() : null,
    cards: g ? g.querySelectorAll('.formula-card').length : 0,
    chapters: g ? [...g.querySelectorAll('details.formula-chapter')].map(d => `${d.dataset.chapter}=${d.querySelector('.formula-chapter-count').textContent}`) : [],
  };
}, SUBJ);
console.log('库页:', JSON.stringify(lib));
await p.goto(`${BASE}/?view=lessons`, { waitUntil: 'load' });
await p.waitForSelector('.lesson-item[data-id]', { timeout: 40000 });
await p.waitForTimeout(900);
await p.locator(`.lesson-item[data-id="${LESSON}"]`).first().click();
await p.waitForSelector('.tabs .tab', { timeout: 40000 });
await p.waitForTimeout(2000);
const tab = p.locator('.tabs .tab', { hasText: '公式' }).first();
const label = (await tab.textContent()).trim();
await tab.click();
await p.waitForTimeout(2500);
const course = await p.evaluate(() => ({ cards: document.querySelectorAll('#tab-body .formula-card').length, src: document.querySelectorAll('#tab-body [data-src-lesson]').length }));
console.log('课内:', label, JSON.stringify(course));
const libTotal = lib.cards;
console.log(`\n断言：课内 ${course.cards} == 库页该课 ${libTotal} →`, course.cards === libTotal && course.cards > 0 ? 'PASS ✓' : 'FAIL ✗');
console.log('ERRORS:', JSON.stringify(errs));
await b.close();

console.log('\n清理：删除新建的 doc →', execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'DELETE', `${BASE}/api/store/formulas/${SUBJ}`]).toString().trim());
const after = storeMd5();
console.log(`formulas 库 md5(after) =${after}  ${after === before ? 'RESTORED ✓' : 'MISMATCH ✗'}`);
