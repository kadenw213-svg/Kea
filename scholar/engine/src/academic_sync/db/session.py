"""Engine/session management."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker

from academic_sync.config import get_db_url

_engine: Engine | None = None
_SessionFactory: sessionmaker | None = None


def get_engine(db_url: str | None = None) -> Engine:
    """Get the (process-cached) engine, creating tables and applying any
    pending migrations the first time it's built for a given URL.

    This used to only happen via an explicit `academic-sync db-init` call --
    every other command silently assumed migrations had already been run.
    That bit us directly: three migrations were added and shipped in code
    without anyone re-running db-init, so every command against the
    existing project database failed with "no such column" the moment it
    touched a new field. `run_migrations` is idempotent (it tracks a stored
    schema version and only applies what's missing), so there's no real
    cost to always calling it here instead of trusting a separate manual
    step -- do not revert to migrations only running on explicit db-init."""
    global _engine
    if _engine is None or db_url is not None:
        url = db_url or get_db_url()
        _engine = create_engine(url, connect_args={"check_same_thread": False})
        from academic_sync.db.migrations import run_migrations

        run_migrations(_engine)
    return _engine


def get_session_factory(db_url: str | None = None) -> sessionmaker:
    global _SessionFactory
    if _SessionFactory is None or db_url is not None:
        _SessionFactory = sessionmaker(bind=get_engine(db_url), expire_on_commit=False)
    return _SessionFactory


@contextmanager
def session_scope(db_url: str | None = None) -> Iterator[Session]:
    factory = get_session_factory(db_url)
    session = factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def reset_engine_cache() -> None:
    """Test helper: force the next get_engine()/get_session_factory() call to rebuild."""
    global _engine, _SessionFactory
    _engine = None
    _SessionFactory = None
