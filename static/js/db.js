// Server-side data layer (replaces IndexedDB so every device shares one account).
// Same interface as before: db.put / get / getAll / getAllByIndex / delete / bulkPut / clear.
// Works for any store name (lessons, cards, quizzes, mistakes, studyLog, ...).

import { authedFetch } from "./api.js";

async function j(resp) {
  const data = await resp.json().catch(() => ({ error: "Bad response" }));
  if (!resp.ok) throw new Error(data.error || "HTTP " + resp.status);
  return data;
}

// Records that came back from a list-only (lite) or slimmed endpoint. Those
// endpoints deliberately omit fields — point explanations, keyTerms,
// supplements, figure captions, the outline, slide text — so saving one of them
// back would delete that content for good. That is not hypothetical: a folder
// edit once wrote a lite lesson back and wiped a whole lesson's explanations,
// captions and slide text. Anything loaded through getAllLite/getLight/…
// is remembered here and refused by put(), so the mistake fails loudly and
// immediately instead of quietly destroying data.
const _partialRecords = new WeakSet();

export function markPartial(records) {
  const list = Array.isArray(records) ? records : [records];
  for (const r of list) if (r && typeof r === "object") _partialRecords.add(r);
  return records;
}

// In-memory cache for list endpoints so fast page switching doesn't re-fetch
// and re-parse the large lessons/cards stores on every navigation.
const _listCache = new Map();
const _listT = new Map();
const _LIST_TTL = 5000; // 5 s
function _freeCache(store) { _listCache.delete(store); _listT.delete(store); }
function _thawCache(store) {
  const t = _listT.get(store);
  if (t != null && Date.now() - t < _LIST_TTL) return _listCache.get(store);
  _freeCache(store);
  return null;
}

export const db = {
  async put(store, value) {
    if (value && typeof value === "object" && _partialRecords.has(value)) {
      const err = new Error(`refusing to save a list-only record of "${store}" (id ${value.id}): `
        + "it is missing fields the list endpoint never sent. Load it with db.get() first.");
      console.error(err.message);
      throw err;
    }
    _freeCache(store);
    await j(await authedFetch(`/api/store/${store}/${encodeURIComponent(value.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    }));
    return value;
  },
  async bulkPut(store, values) {
    if (!values || !values.length) return;
    _freeCache(store);
    // Chunk into ~50-item batches so JSON.stringify never blocks the main
    // thread on a huge array (e.g. hundreds of cards after generation), which
    // would freeze page navigation.
    const CHUNK = 50;
    for (let i = 0; i < values.length; i += CHUNK) {
      const batch = values.slice(i, i + CHUNK);
      await j(await authedFetch(`/api/store/${store}/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: batch }),
      }));
    }
  },
  async get(store, id) {
    const d = await j(await authedFetch(`/api/store/${store}/${encodeURIComponent(id)}`));
    return d.item ?? null;
  },
  async getLight(store, id) {
    // Single light lesson (no image payloads) for flows that only touch
    // points/text, e.g. the Feynman self-test.
    const d = await j(await authedFetch(`/api/store/${store}/${encodeURIComponent(id)}?light=1`));
    // Deliberately NOT marked partial: "light" only nulls image dataUrls, and the
    // server re-attaches them from the lessonImages store on PUT, so saving such a
    // record back is safe (the Feynman self-test autosaves exactly this way). Only
    // the field-slimming list endpoints lose content for good.
    return d.item ?? null;
  },
  async getAll(store) {
    const hit = _thawCache(store);
    if (hit) return hit;
    const d = await j(await authedFetch(`/api/store/${store}`));
    // The lesson list is slimmed server-side even without ?lite=1 (it drops figure
    // captions, the outline, notes, keyTerms and supplements), so those records are
    // partial too and must never be written back.
    const items = store === "lessons" ? markPartial(d.items || []) : (d.items || []);
    _listCache.set(store, items);
    _listT.set(store, Date.now());
    return items;
  },
  async getAllLite(store) {
    // Scheduling-only view of a store: point explanations and slide text, and a
    // card's front/back, are left out. Those are read by the review screen, the
    // full-text search and the formula library, which fetch the full list
    // themselves. Browsing views (dashboard, lesson list, knowledge tree, progress,
    // sidebar badges) need none of it, and on a 258-lesson library this is the
    // difference between 5.2 MB and 1.5 MB on every page load.
    const key = `${store}:lite`;
    const hit = _thawCache(key);
    if (hit) return hit;
    const d = await j(await authedFetch(`/api/store/${store}?lite=1`));
    const items = markPartial(d.items || []);
    _listCache.set(key, items);
    _listT.set(key, Date.now());
    return items;
  },
  async getAllFull(store) {
    // Lessons are returned without image payloads by default; backups need
    // the full records (add ?full=1, which other stores ignore).
    const d = await j(await authedFetch(`/api/store/${store}?full=1`));
    return d.items || [];
  },
  async getAllByIndex(store, index, value) {
    // the only index used app-wide is "lessonId"
    const d = await j(await authedFetch(`/api/store/${store}?lessonId=${encodeURIComponent(value)}`));
    return d.items || [];
  },
  async delete(store, id) {
    _freeCache(store);
    await j(await authedFetch(`/api/store/${store}/${encodeURIComponent(id)}`, { method: "DELETE" }));
  },
  async clear(store) {
    _freeCache(store);
    await j(await authedFetch(`/api/store/${store}`, { method: "DELETE" }));
  },
};
