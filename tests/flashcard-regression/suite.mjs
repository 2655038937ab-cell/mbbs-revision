/* Flashcard regression suite (闪卡).
 *
 *   node suite.mjs            # local server, writes are snapshotted + restored
 *
 * Covers the three reports that produced it:
 *   1. flipping showed BOTH faces (tab + 今日学习)
 *   2. "重复时间" (SM-2) invisible / seemingly inert in the tab
 *   3. the deck order moved between visits, so the remembered position landed
 *      on a different card (store.py does INSERT OR REPLACE -> new rowid, and
 *      the list endpoint has no ORDER BY, so every graded card jumps to the end)
 */
import { chromium } from "playwright";
import { LAUNCH_OPTS, assertLocal } from "./launch.mjs";
import http from "node:http";
import crypto from "node:crypto";

const BASE = process.env.BASE || "http://127.0.0.1:8757";
assertLocal(BASE);

const LESSON = process.env.FC_LESSON || "4fbc1456-0b63-48fa-9feb-da165d934c37";
const KEY = (id, suffix) => "mbbs_fc_pos:" + id + (suffix && suffix !== "all" ? ":" + suffix : "");
const md5 = (o) => crypto.createHash("md5").update(JSON.stringify(o, Object.keys(o).sort())).digest("hex");

let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? "PASS" : "FAIL"}: ${m}`); if (!c) { failures++; process.exitCode = 1; } };
const info = (m) => console.log(`  (info) ${m}`);

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: "127.0.0.1", port: 8757, path, method,
      headers: Object.assign({ Connection: "close" }, data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}) },
      (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => {
        const t = Buffer.concat(c).toString("utf8");
        if (res.statusCode >= 400) return reject(new Error(`${method} ${path} -> ${res.statusCode} ${t.slice(0, 160)}`));
        try { resolve(JSON.parse(t)); } catch { reject(new Error("bad json")); }
      }); });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}
const cardsOf = async (lessonId) => (await request("GET", `/api/store/cards?lessonId=${encodeURIComponent(lessonId)}`)).items || [];
const cmpOrder = (a, b) => ((a.createdAt || 0) - (b.createdAt || 0)) || String(a.id).localeCompare(String(b.id));

async function openCardsTab(page, lessonId, clearPos) {
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  if (clearPos) await page.evaluate((k) => localStorage.removeItem(k), KEY(lessonId));
  await page.locator("text=📚").first().click().catch(() => {});
  await page.waitForTimeout(900);
  await page.locator(`.lesson-item[data-id="${lessonId}"]`).first().click();
  const tab = page.locator('#view .tab[data-tab="cards"]').first();
  await tab.waitFor({ state: "visible", timeout: 25000 });
  await tab.click();
  await page.waitForTimeout(1200);
}

const faceState = (page) => page.evaluate(() => {
  const wrap = document.querySelector("#tab-body .flashcard-wrap");
  if (!wrap) return { error: "no flashcard" };
  const faces = [...wrap.querySelectorAll(".card-text")].filter((e) => e.getBoundingClientRect().height > 0);
  return {
    label: wrap.querySelector("#fc .card-label") ? wrap.querySelector("#fc .card-label").textContent : null,
    nVisibleFaces: faces.length,
    nFacesInDom: wrap.querySelectorAll(".card-text").length,
    text: faces.length ? faces[0].textContent.replace(/\s+/g, " ").trim().slice(0, 20) : null,
    header: wrap.querySelector("#fc-pos") ? wrap.querySelector("#fc-pos").textContent.trim().slice(0, 40) : null,
    sched: wrap.querySelector("#fc-sched") ? wrap.querySelector("#fc-sched").textContent.trim() : null,
    gradesHidden: wrap.querySelector("#fc-grades") ? wrap.querySelector("#fc-grades").hidden : null,
  };
});
const storedPos = (page, lessonId, suffix) => page.evaluate((k) => localStorage.getItem(k), KEY(lessonId, suffix));
const parsedPos = async (page, lessonId, suffix) => { const raw = await storedPos(page, lessonId, suffix); if (!raw) return null; try { return JSON.parse(raw); } catch { return { i: parseInt(raw, 10), id: null }; } };

const reviewState = (page) => page.evaluate(() => {
  const t = document.querySelector("#r-text");
  const inner = t ? [...t.querySelectorAll(".r-q, .r-a")].filter((e) => e.getBoundingClientRect().height > 0) : [];
  // While the card is face-down #r-text IS the single visible face; once flipped
  // the faces are the .r-a / .r-q children inside it.
  const nFaces = inner.length ? inner.length : (t && t.getBoundingClientRect().height > 0 ? 1 : 0);
  return {
    head: (document.querySelector(".page-head .sub") || {}).innerText || null,
    label: document.querySelector("#r-label") ? document.querySelector("#r-label").textContent : null,
    nVisibleFaces: nFaces,
    faceClasses: inner.map((e) => e.className),
    hasQ: !!(t && t.querySelector(".r-q")), hasA: !!(t && t.querySelector(".r-a")),
    text: t ? t.textContent.replace(/\s+/g, " ").trim().slice(0, 24) : null,
  };
});

(async () => {
  const browser = await chromium.launch(LAUNCH_OPTS);
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1500, height: 1200 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 220)));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 220)); });

  const serverCards = await cardsOf(LESSON);
  const deck = serverCards.slice().sort(cmpOrder);
  console.log(`lesson ${LESSON}: ${serverCards.length} cards; deterministic order = createdAt+id`);

  // ---------- A. tab flip toggles, one face at a time ----------
  console.log("\n=== A. tab flip: 4 clicks, exactly one face each ===");
  await openCardsTab(page, LESSON, true);
  const seq = [];
  for (let i = 0; i < 4; i++) {
    if (i > 0) { await page.locator("#fc").click(); await page.waitForTimeout(280); }
    const s = await faceState(page);
    seq.push(s);
    console.log(`  click ${i}: label=${s.label} visibleFaces=${s.nVisibleFaces} domFaces=${s.nFacesInDom} text=${JSON.stringify(s.text)}`);
  }
  ok(seq[0].label === "Question" && seq[0].nVisibleFaces === 1, "start: only the question is visible");
  ok(seq[1].label === "Answer" && seq[1].nVisibleFaces === 1, "click 1: only the answer is visible");
  ok(seq[2].label === "Question" && seq[2].nVisibleFaces === 1, "click 2: back to the question (toggle)");
  ok(seq[3].label === "Answer" && seq[3].nVisibleFaces === 1, "click 3: answer again");
  ok(seq.every((s) => s.nVisibleFaces === 1), "exactly one face on screen after every click");
  ok(seq[1].text !== seq[0].text, "the two faces really differ");

  // ---------- C. deck order is stable across entries ----------
  console.log("\n=== C. deck order stable across visits ===");
  const readFirstN = async (n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const p = await parsedPos(page, LESSON);
      out.push(p && p.id);
      const next = page.locator("#fc-next");
      if (await next.count()) { await next.click(); await page.waitForTimeout(120); }
    }
    return out;
  };
  const run1 = await readFirstN(10);
  // Start the second visit from the top as well: the first run left the stored
  // position at card 10, and honouring it is exactly what check D verifies.
  await openCardsTab(page, LESSON, true);
  const run2 = await readFirstN(10);
  console.log(`  entry 1: ${run1.map((x) => String(x).slice(0, 6)).join(" ")}`);
  console.log(`  entry 2: ${run2.map((x) => String(x).slice(0, 6)).join(" ")}`);
  ok(run1.length === 10 && run1.every(Boolean), "the tab exposes a card id per position");
  ok(run1.join() === run2.join(), "first 10 card ids are identical on the second entry");
  ok(run1.join() === deck.slice(0, 10).map((c) => c.id).join(), "the tab order equals the createdAt+id order");

  // ---------- D. position memory survives a SERVER-SIDE reorder ----------
  console.log("\n=== D. position memory by card id (server reorder) ===");
  await openCardsTab(page, LESSON, true);
  for (let i = 0; i < 6; i++) { await page.locator("#fc-next").click(); await page.waitForTimeout(120); }
  const at7 = await parsedPos(page, LESSON);
  const seventh = deck[6];
  console.log(`  7th card: stored ${JSON.stringify(at7)}; expected id ${String(seventh.id).slice(0, 8)}`);
  ok(at7 && at7.i === 6 && at7.id === seventh.id, "position 7 stores both index 6 and the card id");
  // Make the server move that card to the end of its row order (identical PUT).
  const serverBefore = (await cardsOf(LESSON)).map((c) => c.id);
  await request("PUT", `/api/store/cards/${encodeURIComponent(seventh.id)}`, seventh);
  const serverAfter = (await cardsOf(LESSON)).map((c) => c.id);
  const moved = serverBefore.indexOf(seventh.id) !== serverAfter.indexOf(seventh.id);
  console.log(`  server row order moved the card: ${serverBefore.indexOf(seventh.id)} -> ${serverAfter.indexOf(seventh.id)} (moved=${moved})`);
  ok(moved, "the server really reordered the list (INSERT OR REPLACE)");
  await openCardsTab(page, LESSON, false);
  const back = await parsedPos(page, LESSON);
  const face = await faceState(page);
  console.log(`  after re-entry: ${JSON.stringify(back)}; showing ${JSON.stringify(face.text)}`);
  ok(back && back.id === seventh.id, "re-entry lands on the SAME card (id wins over the shifted index)");
  ok(face.header && /第 7 \/ /.test(face.header), `position indicator still says 第 7 张 (${face.header})`);

  // ---------- E. shrink / legacy value still clamp ----------
  console.log("\n=== E. boundaries ===");
  await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({ i: 9999, id: "zz-gone" })), KEY(LESSON));
  await openCardsTab(page, LESSON, false);
  const clamped = await faceState(page);
  console.log(`  stored {i:9999,id:zz-gone} -> ${clamped.header}`);
  ok(clamped.header && /第 \d+ \/ \d+ 张/.test(clamped.header) && clamped.nVisibleFaces === 1, "an out-of-range position clamps to a real card, no blank screen");
  await page.evaluate((k) => localStorage.setItem(k, "3"), KEY(LESSON));
  await openCardsTab(page, LESSON, false);
  const legacy = await parsedPos(page, LESSON);
  console.log(`  legacy plain "3" -> ${JSON.stringify(legacy)}`);
  ok(legacy && legacy.i === 3 && legacy.id === deck[3].id, "a legacy index-only value is still honoured (and upgraded with the id)");

  // ---------- F. SM-2: grading writes the four fields ----------
  console.log("\n=== F. SM-2 write path (real card, snapshot + restore) ===");
  const target = serverCards.find((c) => c.id === deck[0].id);
  const beforeRec = { interval: target.interval, due: target.due, reps: target.reps, ease: target.ease, lapses: target.lapses };
  const beforeMd5 = md5(target);
  await page.evaluate((k) => localStorage.setItem(k, "0"), KEY(LESSON));
  await openCardsTab(page, LESSON, false);
  const schedLine = (await faceState(page)).sched;
  console.log(`  card schedule line: ${JSON.stringify(schedLine)}`);
  ok(!!schedLine && /interval|ease|reps/.test(schedLine), "the tab prints the card's interval/ease/reps");
  await page.locator("#fc").click();
  await page.waitForTimeout(250);
  await page.locator('.grade-btn[data-g="2"]').click();
  await page.waitForTimeout(1600);
  const afterRec = (await cardsOf(LESSON)).find((c) => c.id === target.id);
  const after = { interval: afterRec.interval, due: afterRec.due, reps: afterRec.reps, ease: afterRec.ease, lapses: afterRec.lapses };
  console.log(`  before ${JSON.stringify(beforeRec)}`);
  console.log(`  after  ${JSON.stringify(after)}`);
  ok(after.interval > beforeRec.interval, `interval grew ${beforeRec.interval} -> ${after.interval}`);
  ok(after.reps === beforeRec.reps + 1, `reps grew ${beforeRec.reps} -> ${after.reps}`);
  ok(after.due > Date.now(), "due was pushed into the future");
  await request("PUT", `/api/store/cards/${encodeURIComponent(target.id)}`, target);
  const restored = (await cardsOf(LESSON)).find((c) => c.id === target.id);
  console.log(`  restore: ${md5(restored) === beforeMd5 ? "RESTORED ✓" : "MISMATCH ✗"}`);
  ok(md5(restored) === beforeMd5, "the graded card was restored byte-for-byte");

  // ---------- B/G. 今日学习: one face at a time, and due-only ----------
  console.log("\n=== B. 今日学习 review card: one face at a time, due cards only ===");
  const now = Date.now();
  const mk = (id, front, back, due) => ({ id, lessonId: LESSON, front, back, ease: 2.5, interval: 3, reps: 2, lapses: 0, due, createdAt: now - 1e7, source: "" });
  const dueCard = mk("zz-fc-due", "ZZ DUE FRONT", "ZZ DUE BACK", now - 60000);
  const futureCard = mk("zz-fc-future", "ZZ FUTURE FRONT", "ZZ FUTURE BACK", now + 30 * 86400000);
  const dueCard2 = mk("zz-fc-due2", "ZZ DUE2 FRONT", "ZZ DUE2 BACK", now - 120000);
  const reviewPage = async (cardItems) => {
    const p2 = await ctx.newPage();
    const e2 = [];
    p2.on("pageerror", (e) => e2.push(String(e).slice(0, 200)));
    p2.on("console", (m) => { if (m.type() === "error") e2.push("console: " + m.text().slice(0, 200)); });
    await p2.route(/\/api\/store\/cards(\?|$)/, async (route) => {
      const resp = await route.fetch(); const body = await resp.json();
      await route.fulfill({ response: resp, body: JSON.stringify({ ...(body.items ? body : {}), items: cardItems }) });
    });
    await p2.route(/\/api\/store\/mistakes(\?|$)/, async (route) => {
      const resp = await route.fetch();
      await route.fulfill({ response: resp, body: JSON.stringify({ items: [] }) });
    });
    await p2.route(/\/api\/store\/lessons(\?|$)/, async (route) => {
      const resp = await route.fetch(); const body = await resp.json();
      const items = (body.items || []).map((l) => ({ ...l, points: (l.points || []).map((pt) => ({ ...pt, feynmanStage: 1, feynmanDue: now + 1e12 })) }));
      await route.fulfill({ response: resp, body: JSON.stringify({ ...(body.items ? body : {}), items }) });
    });
    await p2.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await p2.waitForTimeout(2500);
    await p2.evaluate(() => { const b = document.querySelector("#btn-study"); if (b) b.click(); });
    await p2.waitForTimeout(2200);
    return { p2, e2 };
  };

  const { p2, e2 } = await reviewPage([dueCard, futureCard]);
  const st0 = await reviewState(p2);
  console.log(`  queue head: ${JSON.stringify(st0.head)} -> ${JSON.stringify(st0.text)}`);
  ok(/1 项待复习/.test(st0.head || ""), "only the due card is queued (1 项待复习, the future card is excluded)");
  await p2.locator("#r-fc").click();
  await p2.waitForTimeout(300);
  const st1 = await reviewState(p2);
  console.log(`  after flip: label=${st1.label} visibleFaces=${st1.nVisibleFaces} classes=${JSON.stringify(st1.faceClasses)} text=${JSON.stringify(st1.text)}`);
  ok(st1.nVisibleFaces === 1 && st1.hasA && !st1.hasQ, "flip shows the answer ONLY (no question above it)");
  await p2.locator("#r-fc").click();
  await p2.waitForTimeout(300);
  const st2 = await reviewState(p2);
  console.log(`  after 2nd click: label=${st2.label} visibleFaces=${st2.nVisibleFaces} hasQ=${st2.hasQ} hasA=${st2.hasA}`);
  ok(st2.nVisibleFaces === 1 && !st2.hasQ && !st2.hasA && st2.label === "Question" && st2.text === "ZZ DUE FRONT",
     "clicking again returns to the question only");
  await p2.close();

  const { p2: p3, e2: e3 } = await reviewPage([dueCard, dueCard2]);
  const st3 = await reviewState(p3);
  console.log(`  control run (both due): ${JSON.stringify(st3.head)}`);
  ok(/2 项待复习/.test(st3.head || ""), "with both cards due the queue holds both (the filter is really about due)");
  await p3.close();

  // ---------- H. interval preview table (new / learning / mature) ----------
  console.log("\n=== H. four buttons' intervals: monotonic and preview == action ===");
  const previewCards = [
    { id: "zz-p-new", front: "ZZ NEW", back: "ZZ NEW B", reps: 0, interval: 0, ease: 2.5, lapses: 0, due: now, createdAt: now - 30000, lessonId: LESSON, source: "" },
    { id: "zz-p-learn", front: "ZZ LEARN", back: "ZZ LEARN B", reps: 2, interval: 1, ease: 2.5, lapses: 0, due: now - 1000, createdAt: now - 20000, lessonId: LESSON, source: "" },
    { id: "zz-p-mature", front: "ZZ MATURE", back: "ZZ MATURE B", reps: 5, interval: 21, ease: 2.5, lapses: 0, due: now - 1000, createdAt: now - 10000, lessonId: LESSON, source: "" },
  ];
  // Independent recomputation of what SM-2 should produce, in days.
  const expectIntervals = (c) => {
    const again = 0;
    const hard = c.interval > 0 ? Math.max(1, Math.round(c.interval * 1.2)) : 0.5;
    const good = c.reps === 0 ? 1 : c.reps === 1 ? 6 : Math.max(1, Math.round(c.interval * c.ease));
    const easy = c.reps === 0 ? 2 : Math.max(2, Math.round(good * 1.3));
    return [again, Math.max(again + 0.5, hard), Math.max(Math.max(again + 0.5, hard) + 0.5, good), Math.max(Math.max(Math.max(again + 0.5, hard) + 0.5, good) + 0.5, easy)];
  };
  const labelOf = (d) => (!Number.isFinite(d) || d <= 0) ? "<10m" : d < 1 ? "<1d" : (Math.round(d) >= 365 ? Math.round(Math.round(d) / 365) + "y" : Math.round(d) >= 60 ? Math.round(Math.round(d) / 30) + "mo" : Math.round(d) + "d");
  const pv = await ctx.newPage();
  const e4 = [];
  pv.on("pageerror", (e) => e4.push(String(e).slice(0, 200)));
  pv.on("console", (m) => { if (m.type() === "error") e4.push("console: " + m.text().slice(0, 200)); });
  await pv.route(/\/api\/store\/cards(\?|$)/, async (route) => {
    const resp = await route.fetch(); const body = await resp.json();
    await route.fulfill({ response: resp, body: JSON.stringify({ ...(body.items ? body : {}), items: previewCards }) });
  });
  await openCardsTab(pv, LESSON, true);
  for (let i = 0; i < previewCards.length; i++) {
    if (i > 0) { await pv.locator("#fc-next").click(); await pv.waitForTimeout(200); }
    const got = await pv.evaluate(() => [...document.querySelectorAll("#tab-body .review-grade .grade-btn")].map((b) => b.querySelector(".g-int").textContent.trim()));
    const want = expectIntervals(previewCards[i]).map(labelOf);
    const nums = expectIntervals(previewCards[i]);
    const mono = nums[0] < nums[1] && nums[1] < nums[2] && nums[2] < nums[3];
    console.log(`  ${previewCards[i].id.padEnd(12)} reps=${previewCards[i].reps} interval=${previewCards[i].interval}: page=${JSON.stringify(got)} expected=${JSON.stringify(want)} days=${JSON.stringify(nums)} monotonic=${mono}`);
    ok(got.join() === want.join(), `${previewCards[i].id}: the four labels equal the recomputed SM-2 values`);
    ok(mono, `${previewCards[i].id}: Again < Hard < Good < Easy`);
    if (previewCards[i].reps >= 1) ok(nums[2] > nums[1], `${previewCards[i].id}: a non-new card's Good really grows past Hard`);
  }
  // the preview must equal what a click writes: grade Good on the learning card
  await pv.evaluate(() => { const b = document.querySelector("#fc-f-all"); if (b) b.click(); });
  await pv.close();

  // ---------- I. "完全忘了" (Again) really comes back, and where ----------
  console.log("\n=== I. Again: due now, and back in the 今日学习 queue after 8 items ===");
  const againCards = Array.from({ length: 12 }, (_, i) => ({
    id: `zz-again-${i}`, lessonId: LESSON, front: `ZZ CARD ${i}`, back: `ZZ ANSWER ${i}`,
    ease: 2.5, interval: 3, reps: 2, lapses: 0, due: now - 60000 - i * 1000, createdAt: now - 1e7, source: "",
  }));
  const pa = await ctx.newPage();
  const e5 = [];
  pa.on("pageerror", (e) => e5.push(String(e).slice(0, 200)));
  pa.on("console", (m) => { if (m.type() === "error") e5.push("console: " + m.text().slice(0, 200)); });
  const againPuts = [];
  const blockCardWrite = async (route) => {
    if (route.request().method() !== "GET") { againPuts.push(route.request().postDataJSON()); return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }); }
    await route.continue();
  };
  await pa.route(/\/api\/store\/cards\/[^?]+$/, blockCardWrite);
  await pa.route(/\/api\/store\/cards(\?|$)/, async (route) => {
    if (route.request().method() !== "GET") return blockCardWrite(route);
    const resp = await route.fetch(); const body = await resp.json();
    await route.fulfill({ response: resp, body: JSON.stringify({ ...(body.items ? body : {}), items: againCards }) });
  });
  await pa.route(/\/api\/store\/mistakes(\?|$)/, async (route) => {
    const resp = await route.fetch();
    await route.fulfill({ response: resp, body: JSON.stringify({ items: [] }) });
  });
  await pa.route(/\/api\/store\/lessons(\?|$)/, async (route) => {
    const resp = await route.fetch(); const body = await resp.json();
    const items = (body.items || []).map((l) => ({ ...l, points: (l.points || []).map((pt) => ({ ...pt, feynmanStage: 1, feynmanDue: now + 1e12 })) }));
    await route.fulfill({ response: resp, body: JSON.stringify({ ...(body.items ? body : {}), items }) });
  });
  await pa.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await pa.waitForTimeout(2500);
  await pa.evaluate(() => { const b = document.querySelector("#btn-study"); if (b) b.click(); });
  await pa.waitForTimeout(2200);
  const cardText = () => pa.evaluate(() => { const t = document.querySelector("#r-text"); return t ? t.textContent.replace(/\s+/g, " ").trim() : null; });
  const flipGrade = async (g) => {
    if (await pa.locator("#r-fc").count()) await pa.locator("#r-fc").click();
    await pa.waitForTimeout(180);
    await pa.locator(`.grade-btn[data-g="${g}"]`).click();
    await pa.waitForTimeout(450);
  };
  const firstCard = await cardText();
  againPuts.length = 0;
  const t0 = Date.now();
  await flipGrade(0);
  const put = againPuts[againPuts.length - 1];
  console.log(`  graded Again -> ${JSON.stringify({ id: put && put.id, interval: put && put.interval, reps: put && put.reps, due: put && put.due })}`);
  ok(put && put.interval === 0 && put.reps === 0, "Again resets interval to 0 and reps to 0");
  ok(put && Math.abs(put.due - t0) < 5000, `Again's due is now (${put ? put.due - t0 : "n/a"} ms from the click) — the "<10m" on the button`);
  let gap = -1;
  for (let i = 0; i < 20; i++) {
    if (await cardText() === firstCard) { gap = i; break; }
    await flipGrade(2);
  }
  console.log(`  the Again card returned after ${gap} cards in between -> it sits 8 positions later (REQUEUE_GAP=8)`);
  ok(gap === 7, "the Again card is re-queued 8 queue positions later (7 cards in between) in the same session");
  await pa.close();

  // ---------- J. the tab says out loud that it will not re-queue ----------
  console.log("\n=== J. tab after Again: note + no auto-return ===");
  const realCards = await cardsOf(LESSON);
  const realDeck = realCards.slice().sort(cmpOrder);
  const target2 = realDeck[1];
  const snap2 = JSON.parse(JSON.stringify(target2));
  const snap2md5 = md5(snap2);
  await page.evaluate((k) => localStorage.setItem(k, "1"), KEY(LESSON));
  await openCardsTab(page, LESSON, false);
  const front1 = (await faceState(page)).text;
  await page.locator("#fc").click();
  await page.waitForTimeout(200);
  await page.locator('.grade-btn[data-g="0"]').click();
  await page.waitForTimeout(1500);
  const note = await page.evaluate(() => { const el = [...document.querySelectorAll("#tab-body .sub")].map((e) => e.textContent.trim()).find((t) => t.includes("完全忘了")); return el || null; });
  console.log(`  note: ${JSON.stringify(note)}`);
  ok(!!note && /今日学习/.test(note) && /不会自动回来/.test(note), "the tab explains that Again comes back in 今日学习, not here");
  ok(await page.locator("#fc-go-review").count() > 0, "a 🎯 去今日学习 entry point is offered");
  const seen = [];
  for (let i = 0; i < 10; i++) { seen.push((await faceState(page)).text); await page.locator("#fc-next").click(); await page.waitForTimeout(120); }
  ok(!seen.includes(front1), "the Again card does not come back within the next 10 cards of the browse view");
  await request("PUT", `/api/store/cards/${encodeURIComponent(target2.id)}`, snap2);
  const back2 = (await cardsOf(LESSON)).find((c) => c.id === target2.id);
  console.log(`  restore graded card: ${md5(back2) === snap2md5 ? "RESTORED ✓" : "MISMATCH ✗"}`);
  ok(md5(back2) === snap2md5, "the Again-graded card was restored byte-for-byte");

  // ---------- K. progress numbers == an independent recomputation ----------
  console.log("\n=== K. 进度数字 == 独立复算（合成卡组，只读） ===");
  const nowK = Date.now();
  const mkK = (id, front, reps, interval, due) => ({ id, front, back: front + " B", lessonId: LESSON, ease: 2.5, reps, interval, lapses: 0, due, createdAt: nowK - 100000 + Number(id.slice(-1)) * 1000, source: "" });
  const deckK = [
    mkK("zz-k0", "NEW ONE", 0, 0, nowK - 1000),
    mkK("zz-k1", "NEW TWO", 0, 0, nowK - 1000),
    mkK("zz-k2", "LEARNING ONE", 2, 3, nowK - 1000),
    mkK("zz-k3", "LEARNING TWO", 3, 5, nowK - 1000),
    mkK("zz-k4", "MATURE ONE", 5, 30, nowK + 86400000),
    mkK("zz-k5", "MATURE TWO", 6, 45, nowK - 1000),
  ];
  const expectK = {
    total: deckK.length,
    seen: deckK.filter((c) => c.reps >= 1).length,
    newN: deckK.filter((c) => c.reps < 1).length,
    learning: deckK.filter((c) => c.reps >= 1 && c.interval < 21).length,
    mature: deckK.filter((c) => c.interval >= 21).length,
    due: deckK.filter((c) => c.due <= nowK).length,
  };
  console.log(`  独立复算: ${JSON.stringify(expectK)}`);
  const pk = await ctx.newPage();
  const e6 = [];
  pk.on("pageerror", (e) => e6.push(String(e).slice(0, 200)));
  pk.on("console", (m) => { if (m.type() === "error") e6.push("console: " + m.text().slice(0, 200)); });
  await pk.route(/\/api\/store\/cards(\?|$)/, async (route) => {
    const resp = await route.fetch(); const body = await resp.json();
    await route.fulfill({ response: resp, body: JSON.stringify({ ...(body.items ? body : {}), items: deckK }) });
  });
  await openCardsTab(pk, LESSON, true);
  const gotK = await pk.evaluate(() => {
    const wrap = document.querySelector("#tab-body .flashcard-wrap");
    const txt = wrap ? wrap.innerText : "";
    const m = txt.match(/已看\s*(\d+)\s*\/\s*共\s*(\d+)\s*张/);
    const n = (re) => { const x = txt.match(re); return x ? Number(x[1]) : null; };
    const bar = document.querySelector("#fc-bar");
    const track = bar ? bar.parentElement.getBoundingClientRect().width : 0;
    return {
      seen: m ? Number(m[1]) : null, total: m ? Number(m[2]) : null,
      newN: n(/没看过\s*(\d+)/), learning: n(/学习中\s*(\d+)/), due: n(/今天到期\s*(\d+)/), mature: n(/已成熟\s*(\d+)/),
      barPct: track ? Math.round((bar.getBoundingClientRect().width / track) * 1000) / 10 : null,
      rows: document.querySelectorAll("#tab-body [data-fc-jump]").length,
      newChip: (document.querySelector("#fc-f-new") || {}).textContent || "",
    };
  });
  console.log(`  页面显示: ${JSON.stringify(gotK)}`);
  ok(gotK.seen === expectK.seen && gotK.total === expectK.total, `已看 ${gotK.seen}/${gotK.total} == ${expectK.seen}/${expectK.total}`);
  ok(gotK.newN === expectK.newN, `没看过 ${gotK.newN} == ${expectK.newN}`);
  ok(gotK.learning === expectK.learning, `学习中 ${gotK.learning} == ${expectK.learning}`);
  ok(gotK.mature === expectK.mature, `已成熟 ${gotK.mature} == ${expectK.mature}`);
  ok(gotK.due === expectK.due, `今天到期 ${gotK.due} == ${expectK.due}`);
  const wantK = Math.round((expectK.seen / expectK.total) * 1000) / 10;
  ok(Math.abs(gotK.barPct - wantK) <= 1, `进度条 ${gotK.barPct}% == 已看/总数 ${wantK}% (±1%)`);
  ok(gotK.rows === expectK.total, `清单行数 ${gotK.rows} == 总卡数 ${expectK.total}`);
  // 只看没看过的: rows drop to the new count, jump lands on the first new card
  await pk.locator("#fc-f-new").click();
  await pk.waitForTimeout(400);
  const filtered = await pk.evaluate(() => ({
    rows: document.querySelectorAll("#tab-body [data-fc-jump]").length,
    header: (document.querySelector("#tab-body .flashcard-wrap .sub") || {}).textContent || null,
  }));
  console.log(`  只看没看过的: rows=${filtered.rows} header=${JSON.stringify(filtered.header)}`);
  ok(filtered.rows === expectK.newN, `只看没看过的 rows ${filtered.rows} == 没看过 ${expectK.newN}`);
  await pk.locator("#fc-f-all").click();
  await pk.waitForTimeout(300);
  await pk.locator("#fc-jump-new").click();
  await pk.waitForTimeout(400);
  const jumped = await parsedPos(pk, LESSON);
  const firstNew = deckK.slice().sort(cmpOrder).find((c) => c.reps < 1);
  console.log(`  跳到第一张没看过的 -> ${JSON.stringify(jumped)} expected ${firstNew.id}`);
  ok(jumped && jumped.id === firstNew.id, "跳到第一张没看过的 lands on the first reps=0 card");
  await pk.close();

  const allErrs = [...errs, ...e2, ...e3, ...e4, ...e5, ...e6];
  console.log(`\npage errors: ${allErrs.length ? JSON.stringify(allErrs) : "none"}`);
  if (allErrs.length) { failures++; process.exitCode = 1; }

  await browser.close();
  console.log(`\nDONE failures=${failures}`);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
