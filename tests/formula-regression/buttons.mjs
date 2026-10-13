/* 硬指标 5：页面文案里说「点 X」，X 是否真的渲染成按钮。
 * 只取紧跟「点/按/点击」的 「…」，避免把「常用场景」「考什么」这类字段名误判。 */
import { chromium } from "playwright";
import { LAUNCH_OPTS } from "./launch.mjs";
const BASE = process.env.BASE || 'http://127.0.0.1:8757';
const b = await chromium.launch(LAUNCH_OPTS);
const ctx = await b.newContext({ serviceWorkers: 'block' });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
await p.goto(`${BASE}/?view=formulas`, { waitUntil: 'load' });
await p.waitForSelector('.formula-group', { timeout: 30000 });
await p.waitForTimeout(1500);
const rows = await p.evaluate(() => [...document.querySelectorAll('.formula-group')].map(g => ({
  id: g.dataset.group,
  name: (g.querySelector('h3') || { textContent: '' }).textContent.replace(/\s+/g, ' ').trim(),
  buttons: (() => { const h = g.querySelector(':scope > div'); return h ? [...h.querySelectorAll('.btn')].map(b => b.textContent.replace(/\s+/g, ' ').trim()) : []; })(),
  texts: [...g.querySelectorAll('.sub, [data-fold-warn]')].map(e => e.textContent.replace(/\s+/g, ' ').trim()),
})));
let bad = 0, checked = 0;
for (const g of rows) {
  const quoted = new Set();
  for (const t of g.texts) for (const m of t.matchAll(/(?:点|按|点击)\s*「([^」]{1,24})」/g)) quoted.add(m[1].trim());
  for (const q of quoted) {
    checked++;
    const ok = g.buttons.some(bt => bt.includes(q));
    if (!ok) { bad++; console.log(`FAIL  ${g.id.padEnd(14)} 文案说「点${q}」，但实际按钮只有 ${JSON.stringify(g.buttons)}`); }
  }
}
console.log(`\n文案→按钮 不一致: ${bad} / 检查 ${checked} 处`);
console.log('ERRORS:', JSON.stringify(errs));
await b.close();
