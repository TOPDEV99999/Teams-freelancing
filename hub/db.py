from __future__ import annotations

from pathlib import Path
from typing import Iterator

from sqlalchemy import event
from sqlmodel import Session, SQLModel, create_engine, select

from .config import config
from . import models  # noqa: F401  (register tables)
from .models import Account


def _make_engine(url: str):
    if url.startswith("sqlite:///") and ":memory:" not in url:
        Path(url.removeprefix("sqlite:///")).parent.mkdir(parents=True, exist_ok=True)
    eng = create_engine(url, connect_args={"check_same_thread": False})

    @event.listens_for(eng, "connect")
    def _pragmas(dbapi_conn, _):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA busy_timeout=5000")
        cur.close()

    return eng


engine = _make_engine(config.DATABASE_URL)


def get_session() -> Iterator[Session]:
    with Session(engine) as session:
        yield session


DEFAULT_ACCOUNTS = [
    ("me", "Me", "Profile 1"),
    ("friend_a", "Friend A", "Profile 2"),
    ("friend_b", "Friend B", "Profile 3"),
    ("friend_c", "Friend C", "Profile 4"),
]


# Columns added after the first release: (table, column, SQL type + default).
_MIGRATIONS = [
    ("accounts", "prompt_template", "VARCHAR NOT NULL DEFAULT ''"),
    ("jobs", "target_accounts", "JSON NOT NULL DEFAULT '[]'"),
    ("jobs", "auto_send", "BOOLEAN NOT NULL DEFAULT 0"),
    ("jobs", "auto_style", "VARCHAR NOT NULL DEFAULT ''"),
    ("submissions", "auto", "BOOLEAN NOT NULL DEFAULT 0"),
    ("submissions", "hold_until", "DATETIME"),
    ("conversations", "parsed_v", "INTEGER NOT NULL DEFAULT 0"),
    ("accounts", "currency", "VARCHAR NOT NULL DEFAULT 'USD'"),
    ("submissions", "currency", "VARCHAR NOT NULL DEFAULT 'USD'"),
]


def _migrate() -> None:
    if not str(engine.url).startswith("sqlite"):
        return
    with engine.begin() as conn:
        added: set[tuple[str, str]] = set()
        for table, col, ddl in _MIGRATIONS:
            cols = {r[1] for r in conn.exec_driver_sql(f"PRAGMA table_info({table})")}
            if cols and col not in cols:
                conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")
                added.add((table, col))
        # Every start: drop messages that were not read with Workana's verified markup (parsed_v < 2) - e.g. read by
        # an outdated extension before it was reloaded - so those conversations are read again properly.
        if "parsed_v" in {r[1] for r in conn.exec_driver_sql("PRAGMA table_info(conversations)")}:
            conn.exec_driver_sql("DELETE FROM messages WHERE EXISTS (SELECT 1 FROM conversations c WHERE c.account_id = "
                                 "messages.account_id AND c.slug = messages.slug AND c.parsed_v < 2)")
            conn.exec_driver_sql("UPDATE conversations SET name = '', synced_at = NULL, parsed_v = 0 WHERE parsed_v = 1")
        # The dashboard only alerts on client messages: Workana's own notifications are not kept as notices.
        if {r[1] for r in conn.exec_driver_sql("PRAGMA table_info(notices)")}:
            conn.exec_driver_sql("DELETE FROM notices WHERE kind = 'notification'")
        if ("conversations", "parsed_v") in added:
            # Inbox v1.3.0 read Workana's conversation LIST as if it were messages: drop those and re-read.
            conn.exec_driver_sql("DELETE FROM messages")
            conn.exec_driver_sql("UPDATE conversations SET name = '', snippet = '', synced_at = NULL")
        # v1.1: one submission per (job, account) instead of one per job (multi-account bidding).
        idx = {r[1]: r[2] for r in conn.exec_driver_sql("PRAGMA index_list(submissions)")}
        if idx.get("ix_submissions_job_id") == 1:
            conn.exec_driver_sql("DROP INDEX ix_submissions_job_id")
            conn.exec_driver_sql("CREATE INDEX ix_submissions_job_id ON submissions (job_id)")
        if "uq_submission_job_account" not in idx:
            conn.exec_driver_sql(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_submission_job_account ON submissions (job_id, account_id)")


def init_db() -> None:
    from .services.settings_store import seed_defaults

    SQLModel.metadata.create_all(engine)
    _migrate()
    with Session(engine) as s:
        seed_defaults(s)
        if not s.exec(select(Account)).first():
            for aid, name, profile in DEFAULT_ACCOUNTS:
                s.add(Account(id=aid, display_name=name, chrome_profile=profile))
        # Runtime state never survives a restart.
        for acc in s.exec(select(Account)).all():
            acc.ext_connected = False
            s.add(acc)
        s.commit()
