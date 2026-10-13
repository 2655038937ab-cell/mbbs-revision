/* 硬指标 3：改一门课的学科分类后，库页分组跟随、旧位置不残留；测完还原并核对 md5。
 * API 调用走 curl（Node 24 的 undici 在大的 lesson 载荷上会偶发 assert 崩溃）。 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { openApp, gotoLibrary, BASE } from './lib.mjs';
import { assertLocal } from './launch.mjs';
assertLocal(BASE);
const md5 = (o) => crypto.createHash('md5').update(JSON.stringify(o, Object.keys(o).sort())).digest('hex');
const LESSON = process.argv[2] || '2c26cef9-8fb3-4b44-b748-cd1e26856a19';
const TO = process.argv[3] || 'biochemistry';
const getLesson = (id) => JSON.parse(execFileSync('curl', ['-s', `${BASE}/api/store/lessons/${id}`], { maxBuffer: 1 << 28 })).item;
const putLesson = (l) => execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'PUT', '-H', 'Content-Type: application/json',
  '--data-binary', '@-', `${BASE}/api/store/lessons/${encodeURIComponent(l.id)}`],
  { input: JSON.stringify(l), maxBuffer: 1 << 28 }).toString().trim();

const snap = async (p) => p.evaluate(() => {
  const out = {};
  for (const g of document.querySelectorAll('.formula-group')) {
    out[g.dataset.group] = [...g.querySelectorAll('details.formula-chapter[data-chapter]')]
      .map(d => `${d.dataset.chapter || '未归类'}=${(d.querySelector('.formula-chapter-count') || {}).textContent?.trim()}`)
      .concat([`cards=${g.querySelectorAll('.formula-card').length}`]);
  }
  return out;
});

const orig = getLesson(LESSON);
const h0 = md5(orig);
console.log(`lesson ${LESSON} "${orig.title}"  subjectId=${orig.subjectId}  md5=${h0}`);

const { b, p, errs } = await openApp();
await gotoLibrary(p);
const before = await snap(p);
console.log('改前分组:', JSON.stringify(before));
console.log('改成', TO, '→ HTTP', putLesson({ ...orig, subjectId: TO, updatedAt: Date.now() }));
await gotoLibrary(p);
const after = await snap(p);
console.log('改后分组:', JSON.stringify(after));
const where = Object.entries(after).filter(([, v]) => v.some(x => x.startsWith(orig.title))).map(([k]) => k);
console.log(`断言：章节「${orig.title}」出现在 ${JSON.stringify(where)}（期望 ["${TO}"]）`, where.length === 1 && where[0] === TO ? 'PASS ✓' : 'FAIL ✗');
const gone = !(before[TO] || []).some(x => x.startsWith(orig.title));
console.log('旧位置（改前的学科）本来就没有它:', gone ? 'n/a（原本不在 ' + TO + '）' : '');
console.log('ERRORS:', JSON.stringify(errs));
await b.close();

console.log('还原 → HTTP', putLesson(orig));
const fin = getLesson(LESSON);
console.log(`md5(restored)=${md5(fin)} ${md5(fin) === h0 ? 'RESTORED ✓' : 'MISMATCH ✗'}  subjectId=${fin.subjectId} updatedAt=${fin.updatedAt}`);
