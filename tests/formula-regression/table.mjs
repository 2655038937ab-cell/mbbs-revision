/* 硬指标 1：遍历所有课程，「课内公式数 == 库页该课公式数」 */
import { openApp, lessonRows, libraryCounts, courseCount, BASE } from './lib.mjs';
const { b, p, errs } = await openApp();
const rows = await lessonRows(p);
const lib = await libraryCounts(p);
console.log(`${BASE}  课程数=${rows.length}`);
console.log('课程'.padEnd(44), '课内'.padStart(6), '库页'.padStart(6), '一致');
let bad = 0;
for (const r of rows) {
  if (/MASK AUDIT FIXTURE/i.test(r.title)) { console.log(`${r.title.slice(0,42).padEnd(44)} (task-9 夹具，跳过)`); continue; }
  const c = await courseCount(p, r.id);
  const lb = lib[r.title] ?? 0;
  const ok = c.cards === lb;
  if (!ok) bad++;
  console.log(`${r.title.slice(0,42).padEnd(44)} ${String(c.cards).padStart(6)} ${String(lb).padStart(6)}  ${ok ? 'YES' : 'NO  ← ' + c.tab}`);
}
console.log(`\n不一致行: ${bad} / ${rows.length}`);
console.log('ERRORS:', JSON.stringify(errs));
await b.close();
