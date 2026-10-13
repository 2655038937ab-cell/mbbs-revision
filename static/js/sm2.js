// Spaced repetition — SM-2 style scheduler.
// grades: 0 = Again, 1 = Hard, 2 = Good, 3 = Easy

const DAY = 24 * 60 * 60 * 1000;

export function newCard({ lessonId, front, back, source, src }) {
  const now = Date.now();
  return {
    id: uid(),
    lessonId,
    front,
    back,
    source: source || "",
    // Where in the courseware this card came from: { idx: index in
    // lesson.points, slide: the slide that teaches it, title }. The flashcard tab
    // sorts by it, so a deck follows the slides instead of a random row order.
    src: src || null,
    ease: 2.5,
    interval: 0, // days
    reps: 0,
    lapses: 0,
    due: now,
    createdAt: now,
  };
}

/* The four buttons' next intervals for THIS card, in days, strictly increasing
 * (Again < Hard < Good < Easy).
 *
 * The previews on the flashcard used to come from four separate schedule() calls
 * whose branches disagreed: a brand-new card showed Hard 1d == Good 1d, and a
 * card with interval 1 showed Easy 3d < Good 6d. Both the buttons and the click
 * now read this one function, so the number under a button is exactly the
 * interval that clicking it writes.
 *
 * Steps follow SM-2 (first success 1 day, second 6 days, then interval × ease);
 * Hard is a smaller step than Good, Easy is 1.3 × Good. A brand-new card's Hard
 * is half a day rather than a full day so the four steps stay ordered without
 * inflating the first Good interval.
 */
export function previewIntervals(card) {
  const c = card || {};
  const ease = Number.isFinite(c.ease) ? c.ease : 2.5;
  const interval = Number.isFinite(c.interval) ? c.interval : 0;
  const reps = Number.isFinite(c.reps) ? c.reps : 0;
  const again = 0;
  const hard = interval > 0 ? Math.max(1, Math.round(interval * 1.2)) : 0.5;
  const good = reps === 0 ? 1 : reps === 1 ? 6 : Math.max(1, Math.round(interval * ease));
  const easy = reps === 0 ? 2 : Math.max(2, Math.round(good * 1.3));
  // Keep the promise the four buttons make, whatever the branches produced.
  const h = Math.max(again + 0.5, hard);
  const g = Math.max(h + 0.5, good);
  const e = Math.max(g + 0.5, easy);
  return { again, hard: h, good: g, easy: e };
}

export function schedule(card, grade) {
  const now = Date.now();
  let { ease, lapses } = card;
  const g = Math.max(0, Math.min(3, Number(grade) || 0));
  const preview = previewIntervals(card);
  const interval = [preview.again, preview.hard, preview.good, preview.easy][g];
  const reps = g === 0 ? 0 : (Number.isFinite(card.reps) ? card.reps : 0) + 1;

  if (g === 0) {
    // Again: back in the queue now, and the ease takes the hit.
    lapses += 1;
    ease = Math.max(1.3, ease - 0.2);
  } else if (g === 1) {
    ease = Math.max(1.3, ease - 0.15);
  } else if (g === 3) {
    ease = Math.min(3.0, ease + 0.15);
  }

  return {
    ...card,
    ease: Math.round(ease * 100) / 100,
    interval,
    reps,
    lapses,
    due: now + interval * DAY,
    lastReviewed: now,
  };
}

export function isDue(card, now = Date.now()) {
  return card.due <= now;
}

/* ---------------- Key-point (Feynman) scheduler ----------------
 * The Feynman self-rating (0-3) feeds a ladder of increasing review
 * intervals so knowledge points come back for spaced re-testing,
 * not just a one-off pass.
 */
const POINT_INTERVALS = [0, 1, 3, 7, 14, 30]; // days, indexed by feynmanLevel

export function schedulePoint(point, grade) {
  const now = Date.now();
  const prevLevel = point.feynmanLevel;
  let level = prevLevel == null ? 0 : prevLevel;
  let lapses = point.feynmanLapses || 0;
  let reps = point.feynmanReps || 0;

  if (grade === 0) {
    // Couldn't recall: drop a level and re-test today.
    level = Math.max(0, level - 1);
    lapses += 1;
  } else if (grade === 1) {
    // Vague: stay at the same level (retested in 1 day).
    if (prevLevel == null) level = 0;
  } else if (grade === 2) {
    level = Math.min(POINT_INTERVALS.length - 1, level + 1);
  } else {
    level = Math.min(POINT_INTERVALS.length - 1, level + 2);
  }

  reps += 1;
  // Again = today, Vague = tomorrow, Good/Excellent = ladder interval.
  const interval = grade === 0 ? 0 : grade === 1 ? 1 : POINT_INTERVALS[level];
  const due = now + interval * DAY;
  return {
    ...point,
    feynmanStage: grade,
    feynmanLevel: level,
    // The scheduled gap in whole days. Callers display this directly instead of
    // deriving it from `feynmanDue - Date.now()`, which carries a millisecond
    // rounding error and renders as "2.999999988425926d".
    feynmanInterval: interval,
    feynmanDue: due,
    feynmanLast: now,
    feynmanCount: (point.feynmanCount || 0) + 1,
    feynmanReps: reps,
    feynmanLapses: lapses,
    feynmanIntroducedAt: point.feynmanIntroducedAt || (point.feynmanStage == null && grade > 0 ? now : null),
  };
}

export function isPointDue(point, now = Date.now()) {
  if (!point || point.feynmanStage == null || point.feynmanDue == null) return true;
  return point.feynmanDue <= now;
}

export function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
}

// Mistake notebook scheduler (simple ladder, independent from cards).
const MISTAKE_INTERVALS = [1, 3, 7, 14, 30]; // days between reviews
export function scheduleMistake(mistake, gotIt) {
  const now = Date.now();
  let { stage = 0, reviewCount = 0 } = mistake;
  if (gotIt) {
    stage = Math.min(stage + 1, MISTAKE_INTERVALS.length);
    reviewCount += 1;
  } else {
    stage = Math.max(0, stage - 1);
  }
  const mastered = stage >= MISTAKE_INTERVALS.length;
  const nextReview = mastered
    ? now + 365 * DAY
    : now + MISTAKE_INTERVALS[Math.max(0, stage)] * DAY;
  return { ...mistake, stage, reviewCount, mastered, nextReview, lastReviewed: now };
}
