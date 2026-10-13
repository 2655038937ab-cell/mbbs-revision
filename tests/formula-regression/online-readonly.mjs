import { chromium } from "playwright";
import { LAUNCH_OPTS } from "./launch.mjs";
const BASE = process.env.BASE || 'https://43-133-79-77.sslip.io';
const b = await chromium.launch(LAUNCH_OPTS);
const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 1500, height: 1000 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
p.on('console', m => { if (m.type()==='error') errs.push('CONSOLE ' + m.text().slice(0,200)); });
await p.goto(`${BASE}/?view=formulas`, { waitUntil: 'load', timeout: 60000 });
await p.waitForSelector('.formula-group', { timeout: 60000 });
await p.waitForTimeout(2500);
const d = await p.evaluate(() => {
  const unfiled = document.querySelector('.formula-group[data-group="__unfiled__"]');
  const btns = [...document.querySelectorAll('.formula-card [data-src-lesson]')];
  return {
    groups: [...document.querySelectorAll('.formula-group')].map(g => g.dataset.group),
    cards: document.querySelectorAll('.formula-card').length,
    srcButtons: btns.length,
    rematched: btns.filter(x => /已按标题重新定位/.test(x.getAttribute('title')||'')).length,
    unfiledCards: unfiled ? unfiled.querySelectorAll('.formula-card').length : 0,
    warnQuotes: [...document.querySelectorAll('[data-fold-warn], .formula-group .sub')].map(e=>e.textContent).join(' ').match(/(?:点|按|点击)\s*「([^」]{1,24})」/g) || [],
  };
});
console.log('live formulas:', JSON.stringify(d, null, 1));
console.log('live page errors:', errs.length ? JSON.stringify(errs) : 'none');
await b.close();
