// Server-side data layer (replaces IndexedDB so every device shares one account).
// Same interface as before: db.put / get / getAll / getAllByIndex / delete / bulkPut / clear.
// Works for any store name (lessons, cards, quizzes, mistakes, studyLog, ...).

import { authedFetch } from "./api.js";

async function j(resp) {
  const data = await resp.json().catch(() => ({ error: "Bad response" }));
  if (!resp.ok) throw new Error(data.error || "HTTP " + resp.status);
  return data;
}

export const db = {
  async put(store, value) {
    await j(await authedFetch(`/api/store/${store}/${encodeURIComponent(value.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    }));
    return value;
  },
  async bulkPut(store, values) {
    if (!values || !values.length) return;
    await j(await authedFetch(`/api/store/${store}/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: values }),
    }));
  },
  async get(store, id) {
    const d = await j(await authedFetch(`/api/store/${store}/${encodeURIComponent(id)}`));
    return d.item ?? null;
  },
  async getAll(store) {
    const d = await j(await authedFetch(`/api/store/${store}`));
    return d.items || [];
  },
  async getAllByIndex(store, index, value) {
    // the only index used app-wide is "lessonId"
    const d = await j(await authedFetch(`/api/store/${store}?lessonId=${encodeURIComponent(value)}`));
    return d.items || [];
  },
  async delete(store, id) {
    await j(await authedFetch(`/api/store/${store}/${encodeURIComponent(id)}`, { method: "DELETE" }));
  },
  async clear(store) {
    await j(await authedFetch(`/api/store/${store}`, { method: "DELETE" }));
  },
};
