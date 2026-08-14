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
