/* 证明「补齐」只跑真正缺失的批次，不会重跑已命中批次。
 * 做法：备份 physiology doc → PUT 一个 generatedAt=now 的副本（=刚提取过、所有已覆盖课程都新鲜）
 *       → 点「补齐」数 /api/llm 请求 → 还原 doc 并核对 md5。不花 token（请求被拦截）。 */
import { chromium } from "playwright";
import { LAUNCH_OPTS, assertLocal } from "./launch.mjs";
import crypto from 'node:crypto';
const BASE = process.env.BASE || 'http://127.0.0.1:8757';
assertLocal(BASE);
const DOC = process.argv[2] || 'physiology';
const md5 = (o) => crypto.createHash('md5').update(JSON.stringify(o, Object.keys(o).sort())).digest('hex');
const getDoc = async (id) => (await (await fetch(`${BASE}/api/store/formulas/${id}`)).json()).item;
const putDoc = async (id, doc) => (await fetch(`${BASE}/api/store/formulas/${encodeURIComponent(id)}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc) })).status;

const original = await getDoc(DOC);
const h0 = md5(original);
console.log(`doc=${DOC} md5(before)=${h0}`);
const bumped = { ...original, generatedAt: Date.now() };
console.log('PUT generatedAt=now →', await putDoc(DOC, bumped));

const b = await chromium.launch(LAUNCH_OPTS);
const ctx = await b.newContext({ serviceWorkers: 'block' });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
let llm = 0;
await p.route('**/api/llm', async (r) => { llm++; await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: '{"formulas":[]}', usage: { total_tokens: 0 } }) }); });
await p.route('**/api/store/formulas**', async (r) => {
  const m = r.request().method();
  if (m === 'PUT' || m === 'POST' || m === 'DELETE') await r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  else await r.continue();
});
await p.goto(`${BASE}/?view=formulas`, { waitUntil: 'load' });
await p.waitForSelector('.formula-group', { timeout: 40000 });
await p.waitForTimeout(1800);
const btn = p.locator(`.formula-group[data-group="${DOC}"] [data-gen-formula][data-incremental]`).first();
const label = (await btn.textContent()).trim();
const warn = await p.locator(`.formula-group[data-group="${DOC}"]`).evaluate(g => [...g.querySelectorAll('[data-fold-warn]')].map(x => x.textContent.replace(/\s+/g, ' ').trim()).find(t => t.includes('批次')) || '');
console.log('按钮:', label);
console.log('文案:', warn);
llm = 0;
await btn.click();
await p.waitForTimeout(10000);
console.log(`→ /api/llm 请求数 = ${llm}（期望 1：只有新加的「生理学 第三节课」）`);
console.log('ERRORS:', JSON.stringify(errs));
await b.close();

console.log('还原 →', await putDoc(DOC, original));
const fin = await getDoc(DOC);
console.log(`md5(restored)=${md5(fin)} ${md5(fin) === h0 ? 'RESTORED ✓' : 'MISMATCH ✗'}`);
