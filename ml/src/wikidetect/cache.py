"""One sqlite score cache for everything (calibrate, sweep, serve).

Keyed (model_id, sha256(text)) — model_id encodes checkpoint identity and
max_length (e.g. "desklib@v1.01/768", "lora-2026-07-15-a/768") so a
fine-tune never collides with baseline scores. Replaces the two JSON caches
the JS/Python split maintained (.classify-cache.json, .scores-cache.json).
"""

import hashlib
import sqlite3

from . import config


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


class ScoreCache:
    def __init__(self, path=None):
        path = path or config.CACHE_DB
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path)
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS scores ("
            " model_id TEXT NOT NULL, sha256 TEXT NOT NULL, p REAL NOT NULL,"
            " PRIMARY KEY (model_id, sha256))"
        )

    def get(self, model_id: str, text: str) -> float | None:
        row = self._db.execute(
            "SELECT p FROM scores WHERE model_id = ? AND sha256 = ?",
            (model_id, text_hash(text)),
        ).fetchone()
        return row[0] if row else None

    def put(self, model_id: str, text: str, p: float):
        self._db.execute(
            "INSERT OR REPLACE INTO scores VALUES (?, ?, ?)",
            (model_id, text_hash(text), p),
        )
        self._db.commit()

    def put_many(self, model_id: str, pairs: list[tuple[str, float]]):
        self._db.executemany(
            "INSERT OR REPLACE INTO scores VALUES (?, ?, ?)",
            [(model_id, text_hash(t), p) for t, p in pairs],
        )
        self._db.commit()

    def close(self):
        self._db.close()
