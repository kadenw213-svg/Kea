from __future__ import annotations

import uuid
from datetime import date

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from academic_sync.db.orm import Base
from academic_sync.models.domain import Course
from academic_sync.models.enums import CourseStatus


@pytest.fixture()
def session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    with Session(engine) as s:
        yield s
    engine.dispose()


@pytest.fixture()
def make_course(session):
    from academic_sync.db import repository

    def _make(
        code: str = "BIO1112",
        term: str = "Fall 2026",
        name: str = "General Biology II",
        **kwargs,
    ) -> Course:
        course = Course(
            id=uuid.uuid4().hex,
            course_code=code,
            name=name,
            term=term,
            status=CourseStatus.ACTIVE,
            start_date=kwargs.pop("start_date", date(2026, 8, 24)),
            end_date=kwargs.pop("end_date", date(2026, 12, 12)),
            **kwargs,
        )
        repository.upsert_course(session, course)
        return course

    return _make
