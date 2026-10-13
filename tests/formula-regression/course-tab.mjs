import { openApp, lessonRows, courseCount, BASE } from './lib.mjs';
const { b, p, errs } = await openApp();
const rows = await lessonRows(p);
for (const r of rows) {
  if (!/生理学 第二章|物理化学 第四章|生物化学 第二章/.test(r.title)) continue;
  const c = await courseCount(p, r.id);
  const html = await p.evaluate(() => {
    const t = document.querySelector('#tab-body');
    return {
      head: t ? t.innerText.split('\n').filter(Boolean).slice(0, 4).join(' | ') : null,
      cards: document.querySelectorAll('#tab-body .formula-card').length,
      srcButtons: document.querySelectorAll('#tab-body [data-src-lesson]').length,
      buttons: [...document.querySelectorAll('#tab-body .btn')].map(x => x.textContent.replace(/\s+/g, ' ').trim()).slice(0, 6),
    };
  });
  console.log(JSON.stringify({ title: r.title, tab: c, ...html }, null, 1));
}
console.log('ERRORS:', JSON.stringify(errs));
await b.close();
