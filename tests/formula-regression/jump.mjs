/* 硬指标 3 的"不能张冠李戴"：点一个标了"已按标题重新定位"的 📖 按钮，
 * 断言打开的正是按钮上写的那条知识点（课内 data-idx 对应的 .kp-subtitle 文本 == 按钮标题）。 */
import { chromium } from "playwright";
import { LAUNCH_OPTS } from "./launch.mjs";
const BASE = process.env.BASE || 'http://127.0.0.1:8757';
const N = Number(process.env.N || 4);
const b = await chromium.launch(LAUNCH_OPTS);
const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 1500, height: 1000 } });
const p = await ctx.newPage();
const errs = []; p.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
await p.goto(`${BASE}/?view=formulas`, { waitUntil: 'load' });
await p.waitForSelector('.formula-group', { timeout: 40000 });
await p.waitForTimeout(1800);
const targets = await p.evaluate((n) => [...document.querySelectorAll('.formula-card [data-src-lesson]')]
  .filter(x => /已按标题重新定位/.test(x.getAttribute('title') || ''))
  .slice(0, n)
  .map(x => ({ label: x.textContent.trim().replace(/^📖\s*/, ''), lesson: x.dataset.srcLesson, idx: Number(x.dataset.srcIdx), name: x.closest('.formula-card').querySelector('.formula-name')?.textContent.trim() || '' })), N);
console.log(`找到 ${targets.length} 个"已按标题重新定位"的来源按钮`);
let bad = 0;
for (const t of targets) {
  await p.goto(`${BASE}/?view=formulas`, { waitUntil: 'load' });
  await p.waitForSelector('.formula-group', { timeout: 40000 });
  await p.waitForTimeout(1500);
  const sel = `.formula-card [data-src-lesson="${t.lesson}"][data-src-idx="${t.idx}"]`;
  const btn = p.locator(sel).first();
  if (!(await btn.count())) { console.log(`  跳过（找不到按钮 ${sel}）`); continue; }
  await btn.scrollIntoViewIfNeeded().catch(()=>{});
  await btn.click();
  await p.waitForSelector('#kp-list .kp-section', { timeout: 40000 }).catch(()=>{});
  await p.waitForTimeout(2500);
  const landed = await p.evaluate((idx) => {
    const sec = document.querySelector(`#kp-list .kp-section[data-idx="${idx}"]`);
    if (!sec) return { found: false };
    const t = sec.querySelector(".kp-subtitle");
    return { found: true, title: t ? t.textContent.trim() : (sec.innerText.split("\n").filter(Boolean)[1] || "").trim(), vis: sec.getBoundingClientRect().height > 0 };
  }, t.idx);
  const same = landed.found && landed.title === t.label;
  if (!same) bad++;
  console.log(`  ${same ? 'PASS' : 'FAIL'}  按钮「${t.label}」→ 课内 idx=${t.idx} 的标题「${landed.title}」${landed.vis ? '' : ' (不可见)'}`);
}
console.log(`\n错位 ${bad} / ${targets.length}`);
console.log('ERRORS:', JSON.stringify(errs));
await b.close();
