"""SQLite-backed record store (server-side persistence).

Replaces the browser's IndexedDB so every device sees the same data.
Records are JSON blobs keyed by (store, id), with an optional lesson_id
column for indexed lookups (the only index the frontend uses is "lessonId").
"""
import json
import sqlite3
import threading


class Store:
    def __init__(self, path):
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS records (
                store TEXT NOT NULL,
                id TEXT NOT NULL,
                lesson_id TEXT,
                data TEXT NOT NULL,
                PRIMARY KEY (store, id)
            )
            """
        )
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_records_lesson ON records (store, lesson_id)"
        )
        self._conn.commit()

    @staticmethod
    def _lesson_id(rec):
        if isinstance(rec, dict) and rec.get("lessonId"):
            return str(rec["lessonId"])
        return None

    def put(self, store, rec):
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO records (store, id, lesson_id, data) VALUES (?,?,?,?)",
                (store, rec["id"], self._lesson_id(rec), json.dumps(rec, ensure_ascii=False)),
            )
            self._conn.commit()
        return rec

    def bulk_put(self, store, recs):
        if not recs:
            return
        rows = [
            (store, r["id"], self._lesson_id(r), json.dumps(r, ensure_ascii=False))
            for r in recs
        ]
        with self._lock:
            self._conn.executemany(
                "INSERT OR REPLACE INTO records (store, id, lesson_id, data) VALUES (?,?,?,?)",
                rows,
            )
            self._conn.commit()

    def get(self, store, rec_id):
        with self._lock:
            row = self._conn.execute(
                "SELECT data FROM records WHERE store=? AND id=?", (store, rec_id)
            ).fetchone()
        return json.loads(row[0]) if row else None

    def all(self, store, lesson_id=None):
        with self._lock:
            if lesson_id is not None:
                rows = self._conn.execute(
                    "SELECT data FROM records WHERE store=? AND lesson_id=?",
                    (store, lesson_id),
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT data FROM records WHERE store=?", (store,)
                ).fetchall()
        return [json.loads(r[0]) for r in rows]

    def delete(self, store, rec_id):
        with self._lock:
            self._conn.execute(
                "DELETE FROM records WHERE store=? AND id=?", (store, rec_id)
            )
            self._conn.commit()

    def clear(self, store):
        with self._lock:
            self._conn.execute("DELETE FROM records WHERE store=?", (store,))
            self._conn.commit()
