/* task-11: the desk pet must stop swallowing clicks aimed at right-edge buttons,
 * while staying draggable / double-clickable / with a clickable timer.
 *
 *   node pet-pointer.mjs            # after the fix (must all pass)
 *   node pet-pointer.mjs --before   # pre-fix CSS injected in-page: the failures
 *                                   # it prints ARE the bug reproduction
 *
 * A. the timer panel's dead space (text area, no control) must let clicks through
 * A2. the timer's own 🎯 button must still take its click
 * A3. the pet artwork box stays the drag handle (blocked by design — informational)
 * B. a REAL app button scrolled under the pet must be reachable
 * C. pet regressions: drag (real mouse), dblclick art, timer button, hide/restore
 */
import { chromium } from "playwright";
import { LAUNCH_OPTS, assertLocal } from "./launch.mjs";

const BASE = process.env.BASE || "http://127.0.0.1:8757";
assertLocal(BASE);      // this check drags the pet around a real page; keep it local

let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? "PASS" : "FAIL"}: ${m}`); if (!c) { failures++; process.exitCode = 1; } };
const info = (m) => console.log(`  (info) ${m}`);

const geom = (p) => p.evaluate(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), cx: Math.round(b.x + b.width / 2), cy: Math.round(b.y + b.height / 2) }; };
  const pet = document.querySelector("#pet");
  const timer = document.querySelector("#pet-timer");
  const pomo = document.querySelector("#pet-pomo-btn");
  return {
    petVisible: !!pet && pet.getBoundingClientRect().width > 0 && !document.body.classList.contains("pet-hidden"),
    pet: r(pet), timer: r(timer), pomo: r(pomo), img: r(pet && pet.querySelector("img")),
    petPE: pet ? getComputedStyle(pet).pointerEvents : null,
    timerPE: timer ? getComputedStyle(timer).pointerEvents : null,
    imgPE: pet && pet.querySelector("img") ? getComputedStyle(pet.querySelector("img")).pointerEvents : null,
    pomoPE: pomo ? getComputedStyle(pomo).pointerEvents : null,
  };
});

const topAt = (p, x, y) => p.evaluate(([x, y]) => {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const path = [];
  for (let e = el; e && path.length < 4; e = e.parentElement) path.push(e.id ? "#" + e.id : e.tagName.toLowerCase() + (e.className && typeof e.className === "string" ? "." + e.className.split(" ")[0] : ""));
  return { top: path[0], path: path.join(" < "), inPet: !!(el.closest && el.closest("#pet")), inTimer: !!(el.closest && el.closest("#pet-timer")) };
}, [x, y]);

async function probe(p, name, rect) {
  await p.evaluate(([id, r]) => {
    const old = document.getElementById(id); if (old) old.remove();
    const b = document.createElement("button");
    b.id = id; b.textContent = "probe";
    b.style.cssText = `position:fixed;z-index:1;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;`;
    b.addEventListener("click", () => { window.__probe = (window.__probe || 0) + 1; });
    document.body.appendChild(b);
  }, [name, rect]);
  await p.waitForTimeout(150);
  const c = await p.evaluate((id) => { const b = document.getElementById(id).getBoundingClientRect(); return { cx: Math.round(b.x + b.width / 2), cy: Math.round(b.y + b.height / 2) }; }, name);
  const top = await topAt(p, c.cx, c.cy);
  await p.evaluate(() => { window.__probe = 0; });
  let err = null;
  try { await p.locator("#" + name).click({ timeout: 2500 }); } catch (e) { err = String(e).split("\n")[0].slice(0, 90); }
  const clicks = await p.evaluate(() => window.__probe || 0);
  console.log(`  ${name} center (${c.cx},${c.cy}) -> elementFromPoint ${top.top}  [${top.path}]  click=${err ? "BLOCKED" : "ok"} received=${clicks}`);
  return { clicks, top, err };
}

(async () => {
  const browser = await chromium.launch(LAUNCH_OPTS);
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1500, height: 1000 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 250)));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 250)); });

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);
  if (process.argv.includes("--before")) {
    // Simulate the pre-fix CSS in-page (the repo is never touched) so the same
    // script can measure before/after.
    await page.addStyleTag({ content: "#pet{pointer-events:auto !important} #pet-timer{pointer-events:auto !important}" });
    await page.waitForTimeout(200);
    console.log("[--before mode: #pet / #pet-timer forced back to pointer-events:auto]");
  }
  let g = await geom(page);
  if (!g.petVisible) { await page.locator("#pet-show").click().catch(() => {}); await page.waitForTimeout(400); g = await geom(page); }

  console.log("=== geometry / computed pointer-events ===");
  console.log(`  #pet       ${JSON.stringify(g.pet)}  pointer-events: ${g.petPE}`);
  console.log(`  #pet img   ${JSON.stringify(g.img)}  pointer-events: ${g.imgPE}`);
  console.log(`  #pet-timer ${JSON.stringify(g.timer)}  pointer-events: ${g.timerPE}`);
  console.log(`  #pet-pomo-btn ${JSON.stringify(g.pomo)}  pointer-events: ${g.pomoPE}`);
  ok(g.petVisible, "pet and its timer are on screen");

  console.log("\n=== A. timer panel dead space (the reported blocker) ===");
  const dead = await page.evaluate(() => {
    const t = document.querySelector("#pet-timer").getBoundingClientRect();
    const b = document.querySelector("#pet-pomo-btn").getBoundingClientRect();
    return { left: t.left, top: t.top, width: t.width, height: Math.max(6, b.top - t.top - 2) };
  });
  const a = await probe(page, "probe-timer-dead", dead);
  ok(a.clicks === 1, "a button under the timer's text area receives the click");

  console.log("\n=== A2. the timer's 🎯 button keeps its click ===");
  const a2 = await probe(page, "probe-pomo", { left: g.pomo.x, top: g.pomo.y, width: g.pomo.w, height: g.pomo.h });
  ok(a2.top.inPet && a2.clicks === 0, "the pomo button still owns its own pixels (a probe blocked there is correct)");

  console.log("\n=== A3. artwork box (drag handle, blocked by design) ===");
  const a3 = await probe(page, "probe-art", { left: g.img.x, top: g.img.y, width: g.img.w, height: g.img.h });
  info(`artwork probe blocked=${a3.clicks === 0} (expected: the pet image is the drag handle)`);

  console.log("\n=== B. real app button scrolled under the pet ===");
  await page.locator("text=📚").first().click().catch(() => {});
  await page.waitForTimeout(900);
  await page.locator(".lesson-item[data-id]").first().click();
  await page.locator('#view .tab[data-tab="points"]').first().waitFor({ state: "visible", timeout: 25000 });
  await page.locator('#view .tab[data-tab="points"]').first().click();
  await page.waitForTimeout(1500);
  // Move the PET onto a real, visible app button (the pet is draggable and stays
  // where it is put — the reported case is "the pet covers a right-edge button").
  await page.evaluate(() => { document.querySelectorAll("#kp-list details.kp-group").forEach((d) => { d.open = true; }); });
  await page.waitForTimeout(500);
  // Playwright's CDP scrollIntoViewIfNeeded knows the app's real scroll pane.
  await page.locator(".kp-subhead .cloze-btn").first().scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(500);
  const pick = await page.evaluate(() => {
    const timer = document.querySelector("#pet-timer").getBoundingClientRect();
    const pet = document.querySelector("#pet").getBoundingClientRect();
    // Only the 🙈 遮字 button: starting recall is client-side only. The 🌐 EN
    // button would call the translation API (tokens + a lesson write), and the
    // slide-nav button would open a modal.
    const btns = [...document.querySelectorAll(".kp-subhead .cloze-btn")]
      .filter((b) => { const r = b.getBoundingClientRect(); return !b.closest("#pet") && r.width > 0 && r.top > 80 && r.bottom < 900 && Math.abs(r.left + r.width / 2 - (pet.left + pet.width / 2)) > 120; });
    if (!btns.length) {
      const all = [...document.querySelectorAll(".kp-subhead .cloze-btn")].slice(0, 4).map((b) => { const r = b.getBoundingClientRect(); return { txt: b.textContent.trim().slice(0, 10), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width) }; });
      return { none: true, all, vh: window.innerHeight, pet: { left: Math.round(pet.left), top: Math.round(pet.top) } };
    }
    const en = btns[0];
    en.dataset.petProbe = "1";
    const r = en.getBoundingClientRect();
    // Align the button with the timer panel's DEAD SPACE (the 📚 text band above
    // its button) — that is the strip the old CSS let swallow clicks, while the
    // artwork and the 🎯 button keep their pixels on purpose.
    const pomo = document.querySelector("#pet-pomo-btn").getBoundingClientRect();
    const deadX = timer.left + timer.width / 2;
    const deadY = (timer.top + pomo.top) / 2;
    return {
      label: (en.textContent || "").replace(/\s+/g, " ").trim().slice(0, 20),
      cls: en.className, before: (en.textContent || "").trim().slice(0, 12),
      sel: '[data-pet-probe="1"]',
      cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
      dx: Math.round(r.left + r.width / 2 - deadX),
      dy: Math.round(r.top + r.height / 2 - deadY),
    };
  });
  if (pick && pick.none) { console.log("  [diag] cloze buttons:", JSON.stringify(pick)); }
  if (!pick || pick.none) {
    info("no visible kp-subhead button found to drag the pet onto");
  } else {
    console.log(`  target real button「${pick.label}」(${pick.cls}) at (${pick.cx},${pick.cy}); dragging the pet by (${pick.dx},${pick.dy})`);
    await page.mouse.move(g.img.cx, g.img.cy);
    await page.mouse.down();
    await page.mouse.move(g.img.cx + pick.dx * 0.5, g.img.cy + pick.dy * 0.5, { steps: 6 });
    await page.mouse.move(g.img.cx + pick.dx, g.img.cy + pick.dy, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const state = await page.evaluate(({ cx, cy }) => {
      const t = document.querySelector("#pet-timer").getBoundingClientRect();
      const el = document.elementFromPoint(cx, cy);
      const btn = [...document.querySelectorAll(".kp-subhead .btn")].find((b) => { const r = b.getBoundingClientRect(); return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom; });
      const r = btn ? btn.getBoundingClientRect() : null;
      const overlap = r ? (Math.min(r.right, t.right) - Math.max(r.left, t.left) > 4 && Math.min(r.bottom, t.bottom) - Math.max(r.top, t.top) > 4) : false;
      return { overlap, top: el ? (el.id ? "#" + el.id : el.tagName.toLowerCase() + "." + String(el.className).split(" ")[0]) : null, inPet: !!(el && el.closest && el.closest("#pet")) };
    }, pick);
    console.log(`  after the drag: button/pet overlap=${state.overlap}; elementFromPoint(${pick.cx},${pick.cy}) -> ${state.top}${state.inPet ? "  (INSIDE #pet)" : ""}`);
    ok(state.overlap, "the pet now covers the real button (test setup valid)");
    ok(!state.inPet, "the covered button is still the hit target, not the pet");
    const beforeLabel = await page.evaluate((sel) => { const b = document.querySelector(sel); return b ? b.textContent.trim().slice(0, 14) : null; }, pick.sel);
    // A raw mouse click at the coordinates: no Playwright retries, no
    // actionability magic — whatever is on top gets it, exactly like a user.
    await page.mouse.move(pick.cx, pick.cy);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(700);
    const after2 = await page.evaluate((sel) => { const b = document.querySelector(sel); return b ? b.textContent.trim().slice(0, 14) : null; }, pick.sel);
    console.log(`  raw mouse click at (${pick.cx},${pick.cy}): label「${beforeLabel}」->「${after2}」`);
    ok(after2 !== beforeLabel, "a raw mouse click at those coordinates reaches the covered button and triggers its action");
  }

  console.log("\n=== C. pet regressions ===");
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  g = await geom(page);
  if (!g.petVisible) { await page.locator("#pet-show").click().catch(() => {}); await page.waitForTimeout(400); g = await geom(page); }
  const before = await page.evaluate(() => { const p = document.querySelector("#pet"); return { rect: JSON.stringify(p.getBoundingClientRect()) }; });
  await page.mouse.move(g.img.cx, g.img.cy);
  await page.mouse.down();
  await page.mouse.move(g.img.cx - 120, g.img.cy - 140, { steps: 6 });
  await page.mouse.move(g.img.cx - 200, g.img.cy - 200, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => {
    const p = document.querySelector("#pet");
    let pos = null; try { pos = JSON.parse(localStorage.getItem("mbbs_pet_pos") || "null"); } catch { /* ignore */ }
    return { left: p.style.left, top: p.style.top, rect: JSON.stringify(p.getBoundingClientRect()), pos };
  });
  console.log(`  drag: ${before.rect} -> ${after.rect}; style ${after.left}/${after.top}; ls ${JSON.stringify(after.pos)}`);
  ok(before.rect !== after.rect && after.left !== "" && after.pos, "the pet still drags with a real mouse and persists its position");

  const art1 = await page.evaluate(() => document.querySelector("#pet img").getAttribute("src"));
  await page.locator("#pet img").dblclick();
  await page.waitForTimeout(500);
  const art2 = await page.evaluate(() => document.querySelector("#pet img").getAttribute("src"));
  console.log(`  dblclick art: ${art1} -> ${art2}`);
  ok(art1 !== art2, "double-click still changes the pet artwork");

  await page.locator("#pet-pomo-btn").click();
  await page.waitForTimeout(600);
  const pomoOpen = await page.evaluate(() => !!(document.querySelector("#pomo-start")));
  console.log(`  timer button click -> pomodoro modal open: ${pomoOpen}`);
  ok(pomoOpen, "the timer's 🎯 button is still clickable");
  await page.locator("#pomo-close").click().catch(() => {});
  await page.waitForTimeout(500);

  let hideErr = null;
  try { await page.locator("#pet-hide").click({ timeout: 4000 }); } catch (e) { hideErr = String(e).split("\n")[0].slice(0, 90); }
  await page.waitForTimeout(300);
  const hiddenState = await page.evaluate(() => document.body.classList.contains("pet-hidden"));
  try { await page.locator("#pet-hide").click({ timeout: 4000 }); } catch { /* restore below */ }
  await page.waitForTimeout(300);
  const backState = await page.evaluate(() => !document.body.classList.contains("pet-hidden"));
  console.log(`  hide -> pet-hidden=${hiddenState}${hideErr ? " (" + hideErr + ")" : ""}; restore -> visible=${backState}`);
  ok(hiddenState && backState, "hide / restore still works");

  await page.evaluate(() => { for (const id of ["probe-timer-dead", "probe-pomo", "probe-art"]) { const b = document.getElementById(id); if (b) b.remove(); } });
  console.log(`\npage errors: ${errs.length ? JSON.stringify(errs) : "none"}`);
  if (errs.length) { failures++; process.exitCode = 1; }
  await browser.close();
  console.log(`\nDONE failures=${failures}`);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
