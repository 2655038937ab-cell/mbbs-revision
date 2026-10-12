import { boot, openLesson, maskVia, dragSelect, clickMaskFloat, annotate, maskedRanges, stripMarkers } from './pw.mjs';
import { createFixture } from './fixture.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8757';
// A fresh id every run: the server remembers a deleted record id for 12 h and
// answers a re-create with {"ok":true,"ignored":true} without storing anything, so
// reusing one fixed fixture id across runs silently produces a "missing" lesson.
const ID = process.env.FIXID || ('zz-mask-audit-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
console.log('fixture lesson id:', ID);

// The server closes idle keep-alive sockets now and then; an undici parser
// assertion from one of our probe fetches must not abort the whole run.
process.on('unhandledRejection', (e) => console.log('[warn] unhandled rejection:', (e && e.message) || e));
// undici (Node's fetch) now and then asserts in its own socket handler when the
// server closes a keep-alive connection; it is thrown from an event callback, so
// only this catches it, and it says nothing about the response we already read.
process.on('uncaughtException', (e) => console.log('[warn] uncaught:', (e && e.message) || e));

const results = [];
const notes = [];
let page, errors, puts, browser;

function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function T(id, name, fn) {
  const before = errors.length;
  try {
    const ev = await fn();
    results.push({ id, name, ok: true, ev: ev || '', errs: errors.slice(before) });
  } catch (e) {
    results.push({ id, name, ok: false, ev: String(e && e.message || e), errs: errors.slice(before) });
  }
  if (process.env.VERBOSE) console.log(`[${results.at(-1).ok ? 'PASS' : 'FAIL'}] ${id} ${name} :: ${results.at(-1).ev}`);
}
const srv = async (idx) => {
  const r = await fetch(`${BASE}/api/store/lessons/${ID}`);
  const j = await r.json();
  return { lesson: j.item, masks: (j.item.points[idx] && j.item.points[idx].masks) || [] };
};
const reset = async () => { await createFixture(BASE, ID); };
const fresh = async () => { await reset(); await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(3000); await openLesson(page, ID); };
const marks = (idx) => page.$$eval(`#kp-${idx} .kp-body .kp-manual-mask`, els => els.map(e => ({ i: e.dataset.i, text: e.dataset.text })));
const btnInfo = (idx = 0) => page.evaluate((i) => {
  const card = document.getElementById('kp-' + i);
  return {
    floatHidden: document.getElementById('mask-float-btn')?.hidden,
    clear: !!card?.querySelector('.clear-masks-btn'),
    clearText: card?.querySelector('.clear-masks-btn')?.textContent || null,
    show: !!card?.querySelector('.show-masks-btn'),
    showText: card?.querySelector('.show-masks-btn')?.textContent || null,
    sep: card ? card.querySelectorAll('.mask-sep').length : 0,
  };
}, idx);

// Any leftover zz-* throwaway from an interrupted earlier run would sit in the
// today-study queue ahead of ours (they share feynmanDue = 1) and in the lesson
// list, so the queue would start on the wrong card.
async function cleanupFixtures() {
  const r = await fetch(`${BASE}/api/store/lessons`);
  const j = await r.json();
  const junk = (j.items || []).filter(l => String(l.id).startsWith('zz-') && l.id !== ID);
  for (const l of junk) {
    try { const d = await fetch(`${BASE}/api/store/lessons/${encodeURIComponent(l.id)}`, { method: 'DELETE' }); await d.text().catch(() => {}); }
    catch (e) { console.log('[warn] could not delete ' + l.id + ': ' + e.message); }
  }
  return junk.map(l => l.id);
}
const removed = await cleanupFixtures();
if (removed.length) console.log('cleaned leftover fixtures:', removed.join(', '));

await reset();
({ browser, page, errors, puts } = await boot());
await openLesson(page, ID);

/* ---------------- A ---------------- */
await T('A1', '同一段同词3次，分别遮第1/2/3处', async () => {
  await fresh();
  const orig = stripMarkers((await annotate(page, 0)).annotated);
  const exp = [0, 23, 35];
  for (let k = 0; k < 3; k++) {
    await maskVia(page, 0, '地高辛', k);
    const a = await annotate(page, 0);
    const rng = maskedRanges(a.annotated);
    assert(rng.length === k + 1, `after #${k}: expected ${k + 1} masks, got ${rng.length}`);
    assert(rng.every((r, j) => r.text === '地高辛' && r.at === exp[j]), `after #${k}: offsets ${JSON.stringify(rng.map(r => r.at))} != ${exp.slice(0, k + 1)}`);
    assert(stripMarkers(a.annotated) === orig, 'flat text changed');
  }
  const { masks } = await srv(0);
  assert(JSON.stringify(masks) === JSON.stringify([{ t: '地高辛', n: 0 }, { t: '地高辛', n: 1 }, { t: '地高辛', n: 2 }]), 'server masks ' + JSON.stringify(masks));
  return `offsets ${exp.join(',')} correct; server ${JSON.stringify(masks)}`;
});

await T('A2', '删掉第1处后，原 n=1 仍遮在正确位置', async () => {
  await fresh();
  await maskVia(page, 0, '地高辛', 0);
  await maskVia(page, 0, '地高辛', 1);
  await page.hover('.kp-manual-mask[data-i="0"]');
  await page.waitForTimeout(200);
  await page.click('.kp-manual-mask[data-i="0"] .kp-mask-x');
  await page.waitForTimeout(1200);
  let a = await annotate(page, 0), rng = maskedRanges(a.annotated);
  assert(rng.length === 1 && rng[0].at === 23, `after delete: ${JSON.stringify(rng)} (want one at 23)`);
  const after = await srv(0);
  assert(JSON.stringify(after.masks) === JSON.stringify([{ t: '地高辛', n: 1 }]), 'server ' + JSON.stringify(after.masks));
  // and after a reload (fresh render from the server)
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(3000); await openLesson(page, ID);
  a = await annotate(page, 0); rng = maskedRanges(a.annotated);
  assert(rng.length === 1 && rng[0].at === 23, `after reload: ${JSON.stringify(rng)} (want one at 23)`);
  return 'remaining n=1 landed on original char offset 23 (2nd occurrence), before and after reload';
});

await T('A3a', '选区跨 markdown 元素（粗体/斜体/行内代码）', async () => {
  await fresh();
  const needle = '粗体开头与斜体中间还有inline code结尾';
  await maskVia(page, 1, needle, 0);
  const { masks } = await srv(1);
  assert(masks.length === 1 && masks[0].t === needle && masks[0].n === 0, 'server ' + JSON.stringify(masks));
  const m = await marks(1);
  assert(m.length >= 3, `expected the mask split over >=3 elements, got ${m.length}`);
  assert(new Set(m.map(x => x.i)).size === 1, 'mask parts do not share data-i');
  const joined = m.map(x => x.text).join('');
  assert(joined === needle, `the span group does not reassemble the selection: ${JSON.stringify(joined)} != ${JSON.stringify(needle)}`);
  const a = await annotate(page, 1);
  assert(!a.textContent.includes(needle), 'fragment still visible in textContent');
  assert(stripMarkers(a.annotated) === '粗体开头与斜体中间还有inline code结尾。公式  混在中间。', 'flat text changed: ' + JSON.stringify(stripMarkers(a.annotated)));
  return `${m.length} element-level spans, one group (data-i=0), server ${JSON.stringify(masks)}`;
});

await T('A3b', '选区跨公式 .katex', async () => {
  await fresh();
  const needle = '结尾。公式  混在中间';
  await maskVia(page, 1, needle, 0);
  const { masks } = await srv(1);
  assert(masks.length === 1 && masks[0].t === needle, 'server ' + JSON.stringify(masks));
  const m = await marks(1);
  assert(m.length === 2, `expected 2 spans around the formula, got ${m.length}`);
  const inKatex = await page.$$eval(`#kp-1 .katex .kp-manual-mask`, e => e.length);
  assert(inKatex === 0, 'mask wrapped text INSIDE katex');
  const a = await annotate(page, 1);
  assert(stripMarkers(a.annotated) === '粗体开头与斜体中间还有inline code结尾。公式  混在中间。', 'flat text changed: ' + JSON.stringify(stripMarkers(a.annotated)));
  return `${m.length} spans around the formula, none inside; server ${JSON.stringify(masks)}`;
});

await T('A3c', '选区跨两个段落/li', async () => {
  await fresh();
  const needle = '接力词甲。接力词乙紧接着';
  await maskVia(page, 2, needle, 0);
  const { masks } = await srv(2);
  assert(masks.length === 1 && masks[0].t === needle, 'server ' + JSON.stringify(masks));
  const m = await marks(2);
  assert(m.length === 2, `expected 2 spans across the two <li>, got ${m.length}`);
  const lis = await page.$$eval(`#kp-2 li`, e => e.length);
  assert(lis === 2, 'li count changed: ' + lis);
  return `${m.length} spans across 2 <li>; server ${JSON.stringify(masks)}`;
});

await T('A4', '选区含标点/英文/数字/中英混排', async () => {
  await fresh();
  const needle = '0.125 mg/d，即 digoxin 0.25mg，中文English混排（2026）';
  await maskVia(page, 3, needle, 0);
  const { masks } = await srv(3);
  assert(masks.length === 1 && masks[0].t === needle && masks[0].n === 0, 'server ' + JSON.stringify(masks));
  const a = await annotate(page, 3);
  assert(maskedRanges(a.annotated).length === 1 && maskedRanges(a.annotated)[0].at === 3, 'offset ' + JSON.stringify(maskedRanges(a.annotated)));
  return `server ${JSON.stringify(masks)}`;
});

await T('A5', '空选区 / 只选空格 / 选完点空白 → 不产生遮字', async () => {
  await fresh();
  // plain click (collapsed selection)
  await page.mouse.click(500, 400);
  await page.waitForTimeout(300);
  assert((await btnInfo()).floatHidden !== false, 'float button visible on a collapsed selection');
  // select a single space
  await dragSelect(page, 4, ' ', 0);
  await page.waitForTimeout(300);
  assert((await btnInfo()).floatHidden !== false, 'float button visible for a whitespace-only selection');
  // a real selection followed by a click elsewhere
  await dragSelect(page, 4, '肾上腺素能受体', 0);
  await page.mouse.click(30, 500);
  await page.waitForTimeout(300);
  assert((await btnInfo()).floatHidden !== false, 'float button still visible after clicking away');
  const { masks } = await srv(4);
  assert(masks.length === 0, 'a mask was created: ' + JSON.stringify(masks));
  return 'no float button, no mask, for all three cases';
});

await T('A6', '选中超过一行的长段落', async () => {
  await fresh();
  const needle = '这是一个很长的段落，用来测试跨行选区是否会被截断。肾上腺素能受体广泛分布于心血管系统，激动后通过 G 蛋白偶联通路产生正性肌力与正性频率作用。肾上腺素';
  await maskVia(page, 4, needle, 0);
  const { masks } = await srv(4);
  assert(masks.length === 1 && masks[0].t === needle, 'server ' + JSON.stringify(masks).slice(0, 200));
  return `${needle.length} chars masked as one fragment`;
});

/* ---------------- B ---------------- */
await T('B7', '色块外观 + 点击揭示 → 再点遮住', async () => {
  await fresh();
  await maskVia(page, 3, 'digoxin', 0);
  const hidden = await page.evaluate(() => {
    const s = document.querySelector('#kp-3 .kp-manual-mask');
    const t = s.querySelector('.kp-mask-t');
    return { bg: getComputedStyle(s).backgroundColor, color: getComputedStyle(t).color, len: t.textContent.length, rects: s.getClientRects().length };
  });
  assert(hidden.bg === 'rgb(15, 23, 42)', 'dark block background is ' + hidden.bg);
  assert(hidden.color === 'rgba(0, 0, 0, 0)', 'hidden text is not transparent: ' + hidden.color);
  assert(hidden.len === 0, 'hidden text still in the DOM');
  await page.click('#kp-3 .kp-manual-mask');
  await page.waitForTimeout(250);
  const shown = await page.evaluate(() => {
    const s = document.querySelector('#kp-3 .kp-manual-mask');
    return { revealed: s.classList.contains('revealed'), color: getComputedStyle(s.querySelector('.kp-mask-t')).color, text: s.querySelector('.kp-mask-t').textContent, body: document.querySelector('#kp-3 .kp-body').textContent };
  });
  assert(shown.revealed && shown.color !== 'rgba(0, 0, 0, 0)' && shown.text === 'digoxin', 'reveal failed: ' + JSON.stringify(shown));
  assert(shown.body.includes('digoxin'), 'revealed text not readable in body');
  await page.click('#kp-3 .kp-manual-mask');
  await page.waitForTimeout(250);
  const back = await page.evaluate(() => {
    const s = document.querySelector('#kp-3 .kp-manual-mask');
    return { revealed: s.classList.contains('revealed'), text: s.querySelector('.kp-mask-t').textContent };
  });
  assert(!back.revealed && back.text === '', 're-hide failed: ' + JSON.stringify(back));
  return 'block bg rgb(15,23,42), hidden text transparent; reveal shows text; click again hides';
});

await T('B8', '一键显示按钮存在 + 全部揭示 + 刷新回到遮住', async () => {
  await fresh();
  await maskVia(page, 0, '地高辛', 0);
  await maskVia(page, 0, '地高辛', 1);
  await page.waitForTimeout(600);
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(3000); await openLesson(page, ID);
  const bi = await btnInfo();
  assert(bi.show, '「👁 一键显示 (N)」is missing after a reload (clear-masks-btn present: ' + bi.clear + ', its text: ' + bi.clearText + ')');
  assert(/一键显示\s*\(2\)/.test(bi.showText || ''), 'wrong label: ' + bi.showText);
  await page.click('.show-masks-btn');
  await page.waitForTimeout(700);
  const revealed = await page.$$eval('#kp-0 .kp-manual-mask.revealed', e => e.length);
  assert(revealed === 2, 'after 一键显示: revealed=' + revealed);
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(3000); await openLesson(page, ID);
  const again = await page.$$eval('#kp-0 .kp-manual-mask.revealed', e => e.length);
  assert(again === 0, 'after reload the masks stayed revealed: ' + again);
  return 'button present, reveals 2, reload hides them again';
});

await T('B9', '高亮术语开关：术语黄底且文字可读 → 再点恢复', async () => {
  await fresh();
  const has = await page.$$eval('#kp-0 mark.hl', e => e.length);
  assert(has === 1, 'expected 1 highlighted term, got ' + has);
  await page.click('#kp-0 .cloze-btn');
  await page.waitForTimeout(300);
  const off = await page.evaluate(() => {
    const m = document.querySelector('#kp-0 mark.hl');
    const cs = getComputedStyle(m);
    return { cls: m.className, bg: cs.backgroundColor, color: cs.color, text: m.textContent };
  });
  assert(/hl-emph/.test(off.cls), 'hl-emph not applied: ' + off.cls);
  assert(off.text === '治疗窗', 'term text was removed: ' + JSON.stringify(off.text));
  assert(off.color !== 'rgba(0, 0, 0, 0)', 'term text is transparent (unreadable): ' + off.color);
  assert(!/rgba\(0, 0, 0, 0\)/.test(off.bg), 'background transparent');
  await page.click('#kp-0 .cloze-btn');
  await page.waitForTimeout(300);
  const on = await page.$$eval('#kp-0 mark.hl.hl-emph', e => e.length);
  assert(on === 0, 'hl-emph survived the second click');
  const txt2 = await page.$eval('#kp-0 mark.hl', m => m.textContent);
  assert(txt2 === '治疗窗', 'term text lost after toggling back: ' + JSON.stringify(txt2));
  return `term readable while highlighted: bg=${off.bg} color=${off.color} text=${off.text}`;
});

await T('B9b', '🔎 回忆 仍会遮住术语；🖍 高亮开关不会把它放出来', async () => {
  await fresh();
  const n0 = await page.$$eval('#kp-9 mark.hl', e => e.length);
  assert(n0 === 2, 'fixture should render 2 terms, got ' + n0);
  await page.click('#kp-9 .recall-btn');
  await page.waitForTimeout(500);
  // recall reveals the first term and leaves the rest blanked
  const blanked = await page.$$eval('#kp-9 mark.hl.cloze-hidden', e => e.length);
  assert(blanked === 1, 'recall no longer blanks the remaining term: ' + blanked);
  const blankText = await page.$$eval('#kp-9 mark.hl.cloze-hidden', els => els.map(e => e.textContent));
  assert(blankText.every(t => /^_+$/.test(t)), 'a recall blank is showing its text: ' + JSON.stringify(blankText));
  await page.click('#kp-9 .cloze-btn');
  await page.waitForTimeout(300);
  const after = await page.$$eval('#kp-9 mark.hl.cloze-hidden', els => els.map(e => e.textContent));
  assert(after.length === 1 && /^_+$/.test(after[0]), 'the highlight toggle restored a recall blank: ' + JSON.stringify(after));
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  const revealed = await page.$$eval('#kp-9 mark.hl.cloze-revealed', e => e.length);
  assert(revealed >= 1, 'space no longer reveals the next term');
  return `recall kept 1 blank (${blankText[0].length} underscores) through the 🖍 toggle; space still advances`;
});

/* ---------------- C ---------------- */
await T('C10', '同词多处时点某个色块的 × 只删那一个', async () => {
  await fresh();
  await maskVia(page, 0, '地高辛', 0);
  await maskVia(page, 0, '地高辛', 1);
  await maskVia(page, 0, '地高辛', 2);
  await page.hover('.kp-manual-mask[data-i="1"]');
  await page.waitForTimeout(200);
  await page.click('.kp-manual-mask[data-i="1"] .kp-mask-x');
  await page.waitForTimeout(1200);
  const { masks } = await srv(0);
  assert(JSON.stringify(masks) === JSON.stringify([{ t: '地高辛', n: 0 }, { t: '地高辛', n: 2 }]), 'server ' + JSON.stringify(masks));
  const a = await annotate(page, 0);
  const rng = maskedRanges(a.annotated);
  assert(rng.length === 2 && rng[0].at === 0 && rng[1].at === 35, 'remaining ' + JSON.stringify(rng));
  return 'removed the middle mask only; remaining at 0 and 35; server ' + JSON.stringify(masks);
});

await T('C11', '清除手动遮字清空全部；清零后两个按钮都消失', async () => {
  await fresh();
  await maskVia(page, 0, '地高辛', 0);
  await maskVia(page, 0, '地高辛', 1);
  await page.waitForTimeout(400);
  page.once('dialog', d => d.accept());
  await page.click('.clear-masks-btn');
  await page.waitForTimeout(1200);
  const bi = await btnInfo();
  const { masks } = await srv(0);
  const spans = await page.$$eval('#kp-0 .kp-manual-mask', e => e.length);
  assert(masks.length === 0 && spans === 0, 'not cleared: server=' + JSON.stringify(masks) + ' spans=' + spans);
  assert(!bi.clear, '🗑 clear button still present');
  assert(!bi.show, '👁 show button still present');
  assert(bi.sep === 0, `stray separator "·" left behind: ${bi.sep} (it is never removed)`);
  return `cleared; buttons gone; stray separators=${bi.sep}`;
});

/* ---------------- D ---------------- */
await T('D12', 'PUT 200（非 409）+ 刷新后仍在 + 请求体 < 1MB', async () => {
  await fresh();
  puts.length = 0;
  await maskVia(page, 0, '地高辛', 0);
  const lessonPuts = puts.filter(p => p.url.includes('/lessons/'));
  assert(lessonPuts.length >= 1, 'no lesson PUT seen');
  const bad = lessonPuts.filter(p => p.status !== 200);
  assert(!bad.length, 'non-200 PUT: ' + JSON.stringify(bad));
  const maxLen = Math.max(...lessonPuts.map(p => p.bodyLen));
  assert(maxLen < 1024 * 1024, 'request body ' + maxLen + ' bytes >= 1MB');
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(3000); await openLesson(page, ID);
  const spans = await page.$$eval('#kp-0 .kp-manual-mask', e => e.length);
  assert(spans === 1, 'mask lost after reload: ' + spans);
  return `lesson PUT status=200, max body=${maxLen}B (<1MB), mask survived reload`;
});

await T('D12b', '带图片的大课时保存请求体仍然 < 1MB（图片被剥离）', async () => {
  await reset();
  const base = (await srv(0)).lesson;
  const img = 'data:image/jpeg;base64,' + 'A'.repeat(2 * 1024 * 1024);
  const big = {
    ...base,
    kind: 'pdf',
    slides: [
      { index: 1, text: 'slide one', images: [{ name: 'p1.jpg', mime: 'image/jpeg', kind: 'page', dataUrl: img }, { name: 'p1-f1.jpg', mime: 'image/jpeg', kind: 'figure', dataUrl: img }] },
      { index: 2, text: 'slide two', images: [{ name: 'p2.jpg', mime: 'image/jpeg', kind: 'page', dataUrl: img }] },
    ],
  };
  const fullLen = JSON.stringify(big).length;
  const r = await fetch(`${BASE}/api/store/lessons/${ID}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(big) });
  assert(r.ok, 'big fixture PUT ' + r.status);
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(3000);
  await openLesson(page, ID);
  const stored = (await srv(0)).lesson;
  const storedImgs = ((stored.slides || [])[0] || {}).images || [];
  assert(storedImgs.some(i => i.dataUrl), 'the fixture really should carry page images now');
  puts.length = 0;
  await maskVia(page, 0, '地高辛', 0);
  const lp = puts.filter(p => p.url.includes('/lessons/'));
  assert(lp.length >= 1 && lp.every(p => p.status === 200), 'PUTs ' + JSON.stringify(lp));
  const maxLen = Math.max(...lp.map(p => p.bodyLen));
  assert(maxLen < 1024 * 1024, `request body ${maxLen}B >= 1MB (full record would be ${fullLen}B)`);
  return `full record ${(fullLen / 1048576).toFixed(2)}MB → PUT body ${(maxLen / 1024).toFixed(0)}KB`;
});

await T('D13', '保存前后 points 数量与 explanation 总长不变（没写丢内容）', async () => {
  await fresh();
  const sum = (l) => (l.points || []).reduce((a, p) => a + (typeof p.explanation === 'string' ? p.explanation.length : 0), 0);
  const b = await srv(0);
  const before = { n: b.lesson.points.length, len: sum(b.lesson), slides: (b.lesson.slides || []).length, keys: Object.keys(b.lesson).sort().join(',') };
  await maskVia(page, 0, '地高辛', 0);
  const a = await srv(0);
  const after = { n: a.lesson.points.length, len: sum(a.lesson), slides: (a.lesson.slides || []).length, keys: Object.keys(a.lesson).sort().join(',') };
  assert(before.n === after.n && before.len === after.len, `lost content: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  assert(before.keys === after.keys, `lesson keys changed: ${before.keys} -> ${after.keys}`);
  return `points ${before.n}, explanation chars ${before.len} unchanged after the mask save`;
});

/* ---------------- E ---------------- */
await T('E14', '高亮开关 ↔ 手动遮字 互不干扰', async () => {
  await fresh();
  await maskVia(page, 0, '地高辛', 0);
  const before = maskedRanges((await annotate(page, 0)).annotated);
  await page.click('#kp-0 .cloze-btn');
  await page.waitForTimeout(300);
  await page.click('#kp-0 .cloze-btn');
  await page.waitForTimeout(300);
  const after = maskedRanges((await annotate(page, 0)).annotated);
  const { masks } = await srv(0);
  assert(JSON.stringify(before) === JSON.stringify(after), `masks moved: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  assert(masks.length === 1 && masks[0].n === 0, 'server masks changed: ' + JSON.stringify(masks));
  return 'mask stays on the same character range through a highlight toggle';
});

await T('E15', '今日学习知识点卡里遮字生效；揭示不串到主页面', async () => {
  await fresh();
  await maskVia(page, 0, '地高辛', 0);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.nav-item,button,a')].find(e => e.textContent.replace(/\s+/g, '').startsWith('🎯今日学习'));
    if (b) b.click();
  });
  await page.waitForTimeout(4000);
  // The answer (and with it the .r-a body) sits behind 显示答案.
  const revealBtn = await page.$('#r-reveal');
  if (revealBtn && await revealBtn.isVisible()) { await revealBtn.click(); await page.waitForTimeout(800); }
  const current = await page.evaluate(() => {
    const ra = document.querySelector('.r-a[data-lesson][data-idx]');
    return ra ? ra.dataset.lesson + ':' + ra.dataset.idx : null;
  });
  assert(current === `${ID}:0`, `today-study queue starts on a different card (${current})`);
  const sel = `.r-a[data-lesson="${ID}"][data-idx="0"]`;
  const inCard = await page.$$eval(`${sel} .kp-manual-mask`, e => e.length);
  assert(inCard === 1, 'card did not apply the mask: ' + inCard);
  await page.click(`${sel} .kp-manual-mask`);
  await page.waitForTimeout(400);
  const revealedInCard = await page.$$eval(`.r-a[data-lesson="${ID}"][data-idx="0"] .kp-manual-mask.revealed`, e => e.length);
  assert(revealedInCard === 1, 'mask did not reveal in the card: ' + revealedInCard);
  // back to the lesson: the session reveal set is keyed by lesson:idx only, so the
  // main page may already show it revealed — record the real behaviour.
  await openLesson(page, ID);
  const leaked = await page.$$eval('#kp-0 .kp-manual-mask.revealed', e => e.length);
  assert(leaked === 0, 'revealing in the today-study card also revealed the mask on the lesson page (leaked=' + leaked + ')');
  return `card masks=1, reveals in card; lesson page stays hidden on return (revealed=${leaked})`;
});

await T('E16', '英文视图（🌐 EN）不套手动遮字、不报错', async () => {
  await fresh();
  await maskVia(page, 3, 'digoxin', 0);
  assert((await page.$$eval('#kp-3 .kp-manual-mask', e => e.length)) === 1, 'mask not applied first');
  await page.click('#kp-3 .en-btn');
  await page.waitForTimeout(800);
  const spans = await page.$$eval('#kp-3 .kp-manual-mask', e => e.length);
  const body = await page.$eval('#kp-3 .kp-body', e => e.textContent);
  assert(spans === 0, 'manual mask still wrapped in the EN view: ' + spans);
  assert(/Dose 0.125/.test(body), 'EN body not rendered: ' + body.slice(0, 80));
  await page.click('#kp-3 .en-btn');
  await page.waitForTimeout(800);
  const back = await page.$$eval('#kp-3 .kp-manual-mask', e => e.length);
  assert(back === 1, 'mask did not come back in the Chinese view: ' + back);
  return 'EN view: 0 mask spans; back to 中文: 1 span';
});

await T('E17', 'Feynman 自测 / 评分 / 搜索 / 导出 PDF 各点一次，无 JS 错误', async () => {
  await fresh();
  const b4 = errors.length;
  // Feynman self-test
  await page.click('#btn-feynman');
  await page.waitForTimeout(900);
  const modal = await page.$('.modal, #modal-root');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  // Escape alone does not reliably close the chooser: drop whatever modal is left,
  // then re-open the lesson so #kp-q is definitely back.
  await page.evaluate(() => {
    document.querySelectorAll('.modal-backdrop, .modal').forEach(m => m.remove());
    const root = document.getElementById('modal-root');
    if (root) root.innerHTML = '';
  });
  await page.waitForTimeout(400);
  await openLesson(page, ID);
  // in-lesson search
  await page.fill('#kp-q', '地高辛');
  await page.waitForTimeout(700);
  const hits = await page.$$eval('#kp-list .kp-section', e => e.length);
  assert(hits >= 1, 'search returned nothing');
  await page.fill('#kp-q', '');
  await page.waitForTimeout(700);
  // global nav: search page
  await page.evaluate(() => { const b = [...document.querySelectorAll('.nav-item,button,a')].find(e => e.textContent.replace(/\s+/g, '') === '🔍搜索'); if (b) b.click(); });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { const b = [...document.querySelectorAll('.nav-item,button,a')].find(e => e.textContent.replace(/\s+/g, '') === '📚课程'); if (b) b.click(); });
  await page.waitForTimeout(1500);
  await openLesson(page, ID);
  // export PDF (server-side; may fail with 502 on its own, that is not a JS error)
  const pdfBtn = await page.$('#btn-export');
  if (pdfBtn) { await pdfBtn.click(); await page.waitForTimeout(2500); }
  const fresh2 = errors.slice(b4);
  assert(fresh2.length === 0, 'JS errors: ' + JSON.stringify(fresh2));
  notes.push('E17: Feynman modal opened=' + !!modal + ', search hits=' + hits + ', #btn-export clicked=' + !!pdfBtn);
  return `no JS errors (feynman modal=${!!modal}, search hits=${hits}, export clicked=${!!pdfBtn})`;
});

/* ---------------- F ---------------- */
await T('F18', '旧形状 ["片段"] 仍可用（视为 n=0）', async () => {
  await fresh();
  const m = await marks(5);
  assert(m.length === 1 && m[0].text === '片段' && m[0].i === '0', 'legacy mask not applied: ' + JSON.stringify(m));
  const a = await annotate(page, 5);
  const rng = maskedRanges(a.annotated);
  assert(rng[0].at === 11, 'legacy mask is not on the FIRST occurrence (offset ' + rng[0].at + ', want 11)');
  const { masks } = await srv(5);
  assert(JSON.stringify(masks) === JSON.stringify(['片段']), 'server should still hold the legacy shape before any edit: ' + JSON.stringify(masks));
  // any later edit rewrites it as {t,n} and keeps the same spot
  await maskVia(page, 5, '旧数据里存的是裸字符串', 0);
  const after = await srv(5);
  assert(after.masks.every(x => x && typeof x === 'object' && 't' in x && 'n' in x), 'not upgraded to {t,n}: ' + JSON.stringify(after.masks));
  const up = after.masks.find(x => x.t === '片段');
  assert(up && up.n === 0, 'legacy entry lost/changed: ' + JSON.stringify(after.masks));
  return `legacy applied at offset 11; upgraded to ${JSON.stringify(after.masks)}`;
});

await T('F19', '遮字片段与 explanation 不再匹配：不报错、不遮错、不增长、有提示或清理', async () => {
  await fresh();
  const b4 = errors.length;
  const spans = await page.$$eval('#kp-6 .kp-manual-mask', e => e.length);
  const { masks } = await srv(6);
  assert(errors.length === b4, 'JS errors on a mismatched mask: ' + JSON.stringify(errors.slice(b4)));
  assert(spans === 1, 'expected only the resolvable mask to be applied, got ' + spans);
  assert(masks.length === 2, 'the stored list grew unexpectedly: ' + JSON.stringify(masks));
  const a = await annotate(page, 6);
  const dead = masks.filter(m => !a.annotated.includes(m.t));
  assert(dead.length === 1, 'fixture no longer exercises the mismatched case');
  const bi = await btnInfo();
  const stale = await page.$('.mask-stale-btn');
  if (!stale) throw new Error(`no hint for the ${dead.length} mask whose text no longer exists, and the badge still says "${bi.clearText}" (it counts the dead one)`);
  const txt = await stale.textContent();
  assert(/1/.test(txt), 'hint does not say how many are stale: ' + txt);
  await stale.click();
  await page.waitForTimeout(1200);
  const after = await srv(6);
  assert(after.masks.length === 1 && after.masks[0].t === '早已不存在', 'cleanup removed the wrong entries: ' + JSON.stringify(after.masks));
  return `1 dead mask detected, hint "${txt.trim()}", cleaned to ${JSON.stringify(after.masks)}`;
});

await T('F20', '同一片段不同 n 混合、乱序存储', async () => {
  await fresh();
  const m = await marks(7);
  assert(m.length === 2, 'expected 2 masks, got ' + m.length);
  const a = await annotate(page, 7);
  const rng = maskedRanges(a.annotated);
  const plain = '丙一，丙二，丙三，丙四。';
  assert(rng.length === 2 && rng[0].at === 3 && rng[1].at === 9 && rng.every(r => r.text === '丙'),
    `out-of-order n landing wrong: ${JSON.stringify(rng)} (want the 2nd at 3 and the 4th at 9)`);
  const byI = {};
  for (const s of m) byI[s.i] = s;
  assert(a.annotated.indexOf('\u0001丙\u0002') === 3, 'first marker not at char 3');
  return 'stored [n=3, n=1] applied to the 4th and the 2nd occurrence respectively';
});

/* ---------------- report ---------------- */
console.log('\n════════════ RESULT ════════════');
let pass = 0, fail = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(6)} ${r.name}`);
  console.log(`       ${r.ev}`);
  if (r.errs && r.errs.length) console.log(`       !! JS errors: ${JSON.stringify(r.errs)}`);
  r.ok ? pass++ : fail++;
}
console.log(`════════ ${pass} passed, ${fail} failed ════════`);
if (notes.length) { console.log('\nNOTES'); notes.forEach(n => console.log(' - ' + n)); }
console.log('\nALL JS ERRORS ON THE PAGE:', errors.length ? JSON.stringify(errors) : 'none');
await browser.close();
// leave the server as we found it
try { const d = await fetch(`${BASE}/api/store/lessons/${encodeURIComponent(ID)}`, { method: 'DELETE' }); await d.text().catch(() => {}); console.log('fixture deleted:', ID); }
catch (e) { console.log('could not delete the fixture:', e.message); }
process.exit(fail ? 1 : 0);
