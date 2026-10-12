import { chromium } from 'playwright';
export const EXE = process.env.PW_CHROME
  || (process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell');
export const BASE = process.env.BASE || 'http://127.0.0.1:8757';
export const DEBUG = !!process.env.DEBUG;

export async function boot({ blockSW = true } = {}) {
  const browser = await chromium.launch({ headless: true, executablePath: EXE });
  const ctx = await browser.newContext({
    serviceWorkers: blockSW ? 'block' : 'allow',
    viewport: { width: 1280, height: 1000 },
  });
  const page = await ctx.newPage();
  // The desk pet is a fixed 132px box in the bottom-right corner (#pet, z-index 60)
  // and swallows clicks on whatever sits under it. Mask controls live at the right
  // edge of a card, so the pet was intercepting "🔎 回忆" / the mask buttons of any
  // point scrolled to the bottom of the viewport. Hidden for the run; this is an
  // app-level overlap, reported separately, not something the mask code can fix.
  await page.addInitScript(() => {
    const add = () => {
      const st = document.createElement('style');
      st.textContent = '#pet,#pet-timer,#pet-bubble,#pet-pomo-mini{display:none!important}';
      (document.head || document.documentElement).appendChild(st);
    };
    if (document.head) add(); else document.addEventListener('DOMContentLoaded', add);
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const puts = [];
  page.on('response', async (res) => {
    if (res.request().method() === 'PUT' && res.url().includes('/api/store/')) {
      let bodyLen = 0;
      try { bodyLen = (res.request().postData() || '').length; } catch {}
      puts.push({ url: res.url(), status: res.status(), bodyLen });
    }
  });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  return { browser, ctx, page, errors, puts };
}

export async function goLessons(page) {
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.nav-item,button,a')]
      .find((e) => e.textContent.replace(/\s+/g, '') === '📚课程');
    if (b) b.click();
  });
  await page.waitForTimeout(2500);
}

export async function openLesson(page, id) {
  await goLessons(page);
  const sel = `.lesson-item[data-id="${id}"]`;
  await page.waitForSelector(sel, { timeout: 15000 });
  await page.click(sel);
  await page.waitForSelector('#kp-list', { timeout: 20000 });
  await page.waitForTimeout(700);
  // Flat "by slide" order so every point is a direct, visible .kp-section.
  const flat = await page.$('[data-o="slide"]');
  if (flat) { await flat.click(); await page.waitForTimeout(900); }
  const expand = await page.$('#btn-expand-all');
  if (expand) { const st = await expand.getAttribute('data-state'); if (st !== 'expanded') { await expand.click(); await page.waitForTimeout(500); } }
  await page.waitForSelector('#kp-0 .kp-body', { state: 'attached', timeout: 20000 });
  await page.waitForTimeout(600);
}

// Annotated flat text of a point body: masked spans appear as \x01<text>\x02.
export function annotate(page, idx) {
  return page.evaluate((i) => {
    const body = document.querySelector('#kp-' + i + ' .kp-body');
    if (!body) return null;
    let out = '';
    const walk = (el) => {
      for (const c of el.childNodes) {
        if (c.nodeType === 3) { out += c.nodeValue; continue; }
        if (c.nodeType !== 1) continue;
        if (c.classList.contains('kp-manual-mask')) { out += '\u0001' + (c.dataset.text || '') + '\u0002'; continue; }
        if (c.classList.contains('katex')) continue;
        if (c.closest('button,textarea,input,select')) continue;
        walk(c);
      }
    };
    walk(body);
    return { annotated: out, textContent: body.textContent };
  }, idx);
}

// Real mouse drag over the n-th occurrence of `needle` in the point's FULL text
// (masked spans count as their original characters, exactly like the app's own
// maskSourceParts). The visible characters of that occurrence are what the mouse
// drags over, so a masked occurrence is not selectable and throws.
export async function dragSelect(page, idx, needle, occ = 0) {
  const pts = await page.evaluate(({ i, needle, occ }) => {
    const root = document.querySelector('#kp-' + i + ' .kp-body');
    const parts = [];
    const walk = (el) => {
      for (const c of el.childNodes) {
        if (c.nodeType === 3) {
          if (!c.nodeValue) continue;
          const p = c.parentElement;
          if (p && p.closest('button,textarea,input,select')) continue;
          parts.push({ node: c, text: c.nodeValue, masked: false });
        } else if (c.nodeType === 1) {
          if (c.classList.contains('kp-manual-mask')) { parts.push({ node: c, text: c.dataset.text || '', masked: true }); continue; }
          if (c.classList.contains('katex')) continue;
          if (c.closest('button,textarea,input,select')) continue;
          walk(c);
        }
      }
    };
    walk(root);
    let flat = '';
    for (const p of parts) { p.start = flat.length; flat += p.text; }
    let at = -1, from = 0;
    for (let k = 0; k <= occ; k++) { at = flat.indexOf(needle, from); if (at < 0) return null; from = at + needle.length; }
    const end = at + needle.length;
    const covers = parts.filter((p) => p.start < end && p.start + p.text.length > at);
    if (!covers.length || covers.some((p) => p.masked)) return { maskedOut: true };
    const first = covers[0], last = covers[covers.length - 1];
    const rs = document.createRange();
    rs.setStart(first.node, Math.max(0, at - first.start));
    rs.setEnd(first.node, Math.max(1, at - first.start + 1));
    const re = document.createRange();
    const eoff = end - last.start;
    re.setStart(last.node, Math.max(0, eoff - 1));
    re.setEnd(last.node, eoff);
    // The drag has to happen where the mouse can actually reach: a point below the
    // fold would otherwise be dragged at an on-screen coordinate belonging to a
    // different paragraph (and the selection would land anywhere).
    const sec = root.closest('.kp-section') || root;
    sec.scrollIntoView({ block: 'center', behavior: 'instant' });
    const rect = () => ({ a: rs.getBoundingClientRect(), b: re.getBoundingClientRect() });
    let { a, b } = rect();
    const low = Math.min(a.top, b.top);
    const high = Math.max(a.bottom, b.bottom);
    if (low < 60 || high > window.innerHeight - 8) {
      window.scrollBy(0, low - 120);
      ({ a, b } = rect());
    }
    if (!a.width || !b.width || a.top < 0 || b.top < 0 || a.bottom > window.innerHeight || b.bottom > window.innerHeight) return null;
    return { sx: a.left + 1, sy: a.top + a.height / 2, ex: b.right - 1, ey: b.top + b.height / 2 };
  }, { i: idx, needle, occ });
  if (!pts) throw new Error(`dragSelect: "${needle}" #${occ} not found in kp-${idx}`);
  if (pts.maskedOut) throw new Error(`dragSelect: "${needle}" #${occ} is already masked (not selectable) in kp-${idx}`);
  await page.mouse.move(pts.sx, pts.sy);
  await page.mouse.down();
  await page.mouse.move((pts.sx + pts.ex) / 2, (pts.sy + pts.ey) / 2, { steps: 6 });
  await page.mouse.move(pts.ex, pts.ey, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(350);
  return pts;
}

export async function clickMaskFloat(page) {
  await page.waitForSelector('#mask-float-btn:not([hidden])', { timeout: 5000 });
  await page.click('#mask-float-btn');
  await page.waitForTimeout(900);
}

export async function maskVia(page, idx, needle, occ = 0) {
  await dragSelect(page, idx, needle, occ);
  await clickMaskFloat(page);
}

// ---- annotated text helpers (Node side) ----
export function stripMarkers(s) { return s.replace(/[\u0001\u0002]/g, ''); }
export function maskedRanges(s) {
  const out = []; let m;
  const re = /\u0001([^\u0002]*)\u0002/g;
  while ((m = re.exec(s))) out.push({ text: m[1], at: stripMarkers(s.slice(0, m.index)).length });
  return out;
}
// occurrence index (0-based) of the first stored mask text in the plain text
export function occurrenceOf(s, fragment, at) {
  const plain = stripMarkers(s);
  let count = 0, from = 0;
  for (;;) { const i = plain.indexOf(fragment, from); if (i < 0 || i >= at) return count === 0 ? -1 : count; if (i === at) return count; count++; from = i + fragment.length; }
}
export function lessonMasks(lessonJson, idx) {
  const p = lessonJson.points[idx];
  return (p && p.masks) || [];
}
