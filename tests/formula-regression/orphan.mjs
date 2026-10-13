/* 硬指标 4：孤儿公式（src.lessonId 指向不存在的课程 / src 解析不到）必须落在「未归类」且不报错。
 * 做法：备份 physiology 公式 doc → 注入一条孤儿 → 页面断言 → 原样 PUT 还原 → 核对 md5。
 * --dry 只做「原样 PUT 往返 + md5 一致」验证，不注入。 */
import { openApp, gotoLibrary, BASE } from './lib.mjs';
import { assertLocal } from './launch.mjs';
assertLocal(BASE);
import crypto from 'node:crypto';

const md5 = (o) => crypto.createHash('md5').update(JSON.stringify(o, Object.keys(o).sort())).digest('hex');
async function getDoc(id) {
  const r = await fetch(`${BASE}/api/store/formulas/${id}`);
  return (await r.json()).item;
}
async function putDoc(id, doc) {
  const r = await fetch(`${BASE}/api/store/formulas/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc),
  });
  return r.status;
}

const DRY = process.argv.includes('--dry');
const DOC = process.argv.find(a => /^--doc=/.test(a))?.split('=')[1] || 'physiology';
const original = await getDoc(DOC);
const h0 = md5(original);

console.log(`doc=${DOC} formulas=${original.formulas.length} md5(before)=${h0}`);
const st = await putDoc(DOC, original);
const back = await getDoc(DOC);
console.log(`原样 PUT 往返: HTTP ${st}  md5(after)=${md5(back)}  ${md5(back) === h0 ? 'IDENTICAL ✓' : 'CHANGED ✗'}`);
if (md5(back) !== h0) { console.log('往返会改动数据，放弃注入'); process.exit(1); }
if (DRY) process.exit(0);

const orphanName = `ZZ ORPHAN PROBE ${Date.now()}`;
const injected = JSON.parse(JSON.stringify(original));
injected.formulas.push({
  name: orphanName, latex: '\\text{orphan\\_probe} = 1', symbols: '-', usage: '-', conditions: '-',
  scenarios: '', examples: [], examQuestion: null, params: [],
  src: { lessonId: 'zz-dead-lesson-00000000', idx: 9999, title: '已删除课程里的知识点' },
});
console.log('注入孤儿 →', await putDoc(DOC, injected));

const { b, p, errs } = await openApp();
await gotoLibrary(p);
const res = await p.evaluate((nm) => {
  const out = { found: false, bucket: null, buckets: [], cardText: null };
  for (const g of document.querySelectorAll('.formula-group')) {
    const cards = [...g.querySelectorAll('.formula-card')];
    const hit = cards.find(c => c.innerText.includes(nm));
    if (hit) {
      out.found = true;
      out.group = g.dataset.group;
      out.cardText = hit.innerText.split('\n').slice(0, 3).join(' | ');
      const chap = hit.closest('details.formula-chapter');
      out.bucket = chap ? (chap.dataset.chapter || '(未归入章节)') : (hit.closest('.chem-block') ? 'chem-block' : '(none)');
      const head = (chap && chap.querySelector('summary')) || g.querySelector('h3');
      out.headText = head ? head.innerText.replace(/\s+/g, ' ').trim().slice(0, 80) : null;
      break;
    }
  }
  out.buckets = [...document.querySelectorAll('.formula-chapter-name')].map(e => e.textContent.trim());
  return out;
}, orphanName);
console.log('页面断言:', JSON.stringify(res, null, 1));
console.log('ERRORS:', JSON.stringify(errs));

console.log('还原 →', await putDoc(DOC, original));
const final = await getDoc(DOC);
console.log(`md5(restored)=${md5(final)}  ${md5(final) === h0 ? 'RESTORED ✓' : 'MISMATCH ✗'}`);
await b.close();
