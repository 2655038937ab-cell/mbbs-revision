// Server-side data layer (replaces IndexedDB so every device shares one account).
// Same interface as before: db.put / get / getAll / getAllByIndex / delete / bulkPut / clear.
// Works for any store name (lessons, cards, quizzes, mistakes, studyLog, ...).

import { authedFetch } from "./api.js";

async function j(resp) {
  const data = await resp.json().catch(() => ({ error: "Bad response" }));
  if (!resp.ok) throw new Error(data.error || "HTTP " + resp.status);
  return data;
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
    return d.item ?? null;
  },
  async getAll(store) {
    const hit = _thawCache(store);
    if (hit) return hit;
    const d = await j(await authedFetch(`/api/store/${store}`));
    const items = d.items || [];
    _listCache.set(store, items);
    _listT.set(store, Date.now());
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
