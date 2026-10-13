/* Count how many /api/llm batches 「补齐 N 批」 actually sends, without spending
 * tokens or touching the store:
 *   - every POST /api/llm is counted and fulfilled with a canned (empty) payload
 *   - every write of the formulas store is short-circuited ({"ok":true})
 * Usage: node no-rerun.mjs [subjectId]     (default: the first group with an incremental button)
 */
import { chromium } from "playwright";
import { LAUNCH_OPTS, assertLocal } from "./launch.mjs";
const BASE = process.env.BASE || 'http://127.0.0.1:8757';
assertLocal(BASE);
const wantSubject = process.argv[2] || '';

const b = await chromium.launch(LAUNCH_OPTS);
const ctx = await b.newContext({ serviceWorkers: 'block' });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

let llmCalls = 0, putBlocked = 0;
await p.route('**/api/llm', async (route) => {
  llmCalls++;
  await route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ content: '{"formulas":[]}', usage: { total_tokens: 0 } }) });
});
await p.route('**/api/store/formulas**', async (route) => {
  const m = route.request().method();
  if (m === 'PUT' || m === 'POST' || m === 'DELETE') { putBlocked++; await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); }
  else await route.continue();
});

await p.goto(`${BASE}/?view=formulas`, { waitUntil: 'load' });
await p.waitForSelector('.formula-group', { timeout: 30000 });
await p.waitForTimeout(1800);

const groups = await p.evaluate(() => [...document.querySelectorAll('.formula-group')].map(g => {
  const btn = g.querySelector('[data-gen-formula][data-incremental]') || g.querySelector('[data-gen-formula]');
  return {
    id: g.dataset.group,
    header: g.querySelector('h3') ? g.querySelector('h3').textContent.trim() : '',
    sub: g.querySelector('.sub') ? g.querySelector('.sub').textContent.trim() : '',
    warn: [...g.querySelectorAll('[data-fold-warn]')].map(w => w.textContent.trim()).filter(t => t.includes('批')),
    label: btn ? btn.textContent.trim() : null,
    incremental: btn ? btn.dataset.incremental === '1' : false,
  };
}));
console.log('--- 改前/改后基线：各学科「补齐」按钮 ---');
for (const g of groups) if (g.label) console.log(JSON.stringify(g, null, 1));

const pick = wantSubject
  ? await p.locator(`.formula-group[data-group="${wantSubject}"] [data-gen-formula][data-incremental]`).first()
  : p.locator('[data-gen-formula][data-incremental]').first();
const count = await pick.count();
if (!count) { console.log('NO incremental button found — nothing to measure'); }
else {
  const lbl = (await pick.textContent()).trim();
  llmCalls = 0;
  await pick.click();
  await p.waitForTimeout(12000);
  console.log(`\n点击「${lbl}」→ /api/llm 请求数 = ${llmCalls}；被拦下的 formulas 写入 = ${putBlocked}`);
  if (process.env.MOCK_KEY) {
    const desc = await p.evaluate(() => { const e = document.querySelector('#progress-panel, .progress-panel, #pm'); return e ? e.innerText.slice(0, 300) : null; });
    console.log('progress panel:', desc);
  }
}
console.log('ERRORS:', JSON.stringify(errs));
await b.close();
