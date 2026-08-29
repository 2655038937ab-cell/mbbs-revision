// Spaced repetition — SM-2 style scheduler.
// grades: 0 = Again, 1 = Hard, 2 = Good, 3 = Easy

const DAY = 24 * 60 * 60 * 1000;

export function newCard({ lessonId, front, back, source }) {
  const now = Date.now();
  return {
    id: uid(),
    lessonId,
    front,
    back,
    source: source || "",
    ease: 2.5,
    interval: 0, // days
    reps: 0,
    lapses: 0,
    due: now,
    createdAt: now,
  };
}

export function schedule(card, grade) {
  const now = Date.now();
  let { ease, interval, reps, lapses } = card;

  if (grade === 0) {
    // Again
    reps = 0;
    interval = 0;
    lapses += 1;
    ease = Math.max(1.3, ease - 0.2);
  } else if (grade === 1) {
    // Hard
    interval = interval === 0 ? 1 : Math.max(1, Math.round(interval * 1.2));
    ease = Math.max(1.3, ease - 0.15);
    reps += 1;
  } else if (grade === 2) {
    // Good
    if (reps === 0) interval = 1;
    else if (reps === 1) interval = 3;
    else interval = Math.round(interval * ease);
    reps += 1;
  } else {
    // Easy
    interval = interval === 0 ? 2 : Math.round(interval * ease * 1.3);
    ease = Math.min(3.0, ease + 0.15);
    reps += 1;
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
