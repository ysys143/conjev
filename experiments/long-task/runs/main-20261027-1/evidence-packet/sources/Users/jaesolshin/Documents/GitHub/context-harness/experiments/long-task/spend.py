"""Atomic study-wide Jev reservations, including requests with unknown outcomes.

Pricing/context source checked 2026-10-26: https://docs.typesafe.ai/models
USD 0.042 per million input tokens; output free; at most 64k default input.
Use 65,536 tokens as the conservative reservation; long-context calls are refused.
No credentials are accepted or stored by this ledger.
"""
from __future__ import annotations

import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from grading import digest

NANODOLLARS_PER_INPUT_TOKEN = 42
RESERVED_INPUT_TOKENS = 65_536
RESERVATION = RESERVED_INPUT_TOKENS * NANODOLLARS_PER_INPUT_TOKEN
STUDY_LIMIT = 10_000_000_000
EXPECTED_MODEL = "jev-1.14.0"


class SpendLedger:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = path
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS policy (singleton INTEGER PRIMARY KEY CHECK(singleton=1), limit_nano INTEGER NOT NULL)")
            db.execute("INSERT OR IGNORE INTO policy VALUES (1,?)", (STUDY_LIMIT,))
            if db.execute("SELECT limit_nano FROM policy WHERE singleton=1").fetchone()[0] != STUDY_LIMIT:
                raise ValueError("Existing study spend policy differs; do not reset the ledger")
            db.execute("CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, run TEXT NOT NULL, request_sha256 TEXT NOT NULL, reserved_nano INTEGER NOT NULL, charged_nano INTEGER, model TEXT, response_sha256 TEXT, created_at REAL NOT NULL)")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        try:
            with db:
                yield db
        finally:
            db.close()

    def reserve(self, run: str, request: dict, *, long_context: bool = False) -> str:
        if not run or long_context or request.get("model") not in ("jev-latest", EXPECTED_MODEL):
            raise ValueError("Unfrozen model or unsupported context; no call authorized")
        if not isinstance(request.get("state"), (str, dict, list)) or not isinstance(request.get("questions"), dict):
            raise ValueError("Invalid Jev request")
        identity = uuid.uuid4().hex
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            used = db.execute("SELECT COALESCE(SUM(COALESCE(charged_nano,reserved_nano)),0) FROM calls").fetchone()[0]
            if used + RESERVATION > STUDY_LIMIT:
                raise ValueError("Study-wide Jev spend ceiling reached; keep the study incomplete")
            db.execute("INSERT INTO calls VALUES (?,?,?,?,NULL,NULL,NULL,?)",
                       (identity, run, digest(request), RESERVATION, time.time()))
        return identity

    def settle(self, identity: str, response: dict) -> None:
        usage = response.get("usage", {})
        count = usage.get("input_tokens")
        output = usage.get("output_tokens")
        if type(count) is not int or not 0 <= count <= RESERVED_INPUT_TOKENS or type(output) is not int or output < 0:
            raise ValueError("Missing or invalid usage; the full reservation remains charged")
        # A model mismatch keeps its full reservation and stops further study work.
        if response.get("model") != EXPECTED_MODEL:
            raise ValueError("Jev model drift; retain evidence and the reservation")
        fingerprint = digest(response)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT response_sha256 FROM calls WHERE id=?", (identity,)).fetchone()
            if row is None:
                raise ValueError("Unknown originating call")
            if row[0] is not None:
                if row[0] != fingerprint:
                    raise ValueError("Conflicting outcome for an already settled call")
                return
            db.execute("UPDATE calls SET charged_nano=?,model=?,response_sha256=? WHERE id=?",
                       (count * NANODOLLARS_PER_INPUT_TOKEN, EXPECTED_MODEL, fingerprint, identity))

    def call_count(self, run: str) -> int:
        with self.connect() as db:
            return db.execute("SELECT COUNT(*) FROM calls WHERE run=?", (run,)).fetchone()[0]

    def summary(self) -> dict:
        with self.connect() as db:
            rows = db.execute("SELECT charged_nano,reserved_nano FROM calls").fetchall()
        known = sum(c for c, _ in rows if c is not None)
        unknown = sum(r for c, r in rows if c is None)
        return {"calls": len(rows), "unknown_calls": sum(c is None for c, _ in rows),
                "known_spend_usd": known / 1e9, "unknown_reserved_usd": unknown / 1e9,
                "committed_upper_usd": (known + unknown) / 1e9, "ceiling_usd": STUDY_LIMIT / 1e9}
