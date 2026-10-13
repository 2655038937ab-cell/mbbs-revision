import { chromium } from "playwright";
import { LAUNCH_OPTS } from "./launch.mjs";
export const BASE = process.env.BASE || 'http://127.0.0.1:8757';
export const NODE = '/Users/liangweilin/Documents/Codex/2026-08-14/ban/outputs/DeepSeek Harness.app/Contents/Resources/node';

export async function openApp(opts = {}) {
  const b = await chromium.launch(LAUNCH_OPTS);
  const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 1500, height: 1000 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0, 200)); });
  return { b, ctx, p, errs };
}

export async function gotoLibrary(p) {
  await p.goto(`${BASE}/?view=formulas`, { waitUntil: 'load' });
  await p.waitForSelector('.formula-group', { timeout: 40000 });
  await p.waitForTimeout(1500);
}

// Every lesson row on the courses page: { id, title }
export async function lessonRows(p) {
  await p.goto(`${BASE}/?view=lessons`, { waitUntil: 'load' });
  await p.waitForSelector('.lesson-item[data-id]', { timeout: 40000 });
  await p.waitForTimeout(1200);
  return p.evaluate(() => [...document.querySelectorAll('.lesson-item[data-id]')]
    .map(e => ({ id: e.dataset.id, title: (e.innerText.split('\n').map(s => s.trim()).filter(Boolean)[1] || e.innerText.split('\n')[0] || '').trim() })));
}

export async function openLessonById(p, id) {
  await p.goto(`${BASE}/?view=lessons`, { waitUntil: 'load' });
  await p.waitForSelector('.lesson-item[data-id]', { timeout: 40000 });
  await p.waitForTimeout(900);
  const row = p.locator(`.lesson-item[data-id="${id}"]`).first();
  await row.click();
  await p.waitForSelector('.tabs .tab', { timeout: 40000 });
  await p.waitForTimeout(2200);
}

// Per-course formula counts as the LIBRARY shows them (chapter sections, math + chem).
export async function libraryCounts(p) {
  await gotoLibrary(p);
  return p.evaluate(() => {
    const per = {};
    for (const g of document.querySelectorAll('.formula-group')) {
      const subject = g.dataset.group;
      for (const d of g.querySelectorAll('details.formula-chapter[data-chapter]')) {
        const k = d.dataset.chapter || '(未归入章节)';
        const n = Number((d.querySelector('.formula-chapter-count') || {}).textContent?.replace(/\D/g, '') || 0);
        per[k] = (per[k] || 0) + n;
      }
    }
    return per;
  });
}

// Per-course formula count as the COURSE page shows it (the 📐 公式 tab).
export async function courseCount(p, id) {
  await openLessonById(p, id);
  const tab = p.locator('.tabs .tab', { hasText: '公式' }).first();
  if (!(await tab.count())) return { tab: null, cards: 0 };
  const label = (await tab.textContent()).trim();
  await tab.click();
  await p.waitForTimeout(2000);
  const cards = await p.locator('#tab-body .formula-card').count();
  const nTab = Number((label.match(/\((\d+)\)/) || [])[1] ?? NaN);
  return { tab: label, tabCount: nTab, cards };
}
