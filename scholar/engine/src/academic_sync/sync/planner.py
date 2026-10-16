"""Computes a sync plan (CREATE/UPDATE/UNCHANGED/CONFLICT/REVIEW/...) for a
batch of freshly extracted items against local state, without writing
anything to the database or to Google Calendar. Applying a plan is a
separate, explicit step -- see docs/architecture.md#sync-stage.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.orm import Session

from academic_sync.db import repository
from academic_sync.models.domain import AcademicItem, SyncRecord
from academic_sync.reconciliation.engine import PlanEntry, decide_action


@dataclass
class SyncPlan:
    course_id: str
    entries: list[PlanEntry]

    def counts(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for e in self.entries:
            out[e.action.value] = out.get(e.action.value, 0) + 1
        return out


def compute_plan(session: Session, course_id: str, incoming_items: list[AcademicItem]) -> SyncPlan:
    entries: list[PlanEntry] = []
    for incoming in incoming_items:
        existing = None
        sync_record = None

        if incoming.fingerprint:
            existing_row = repository.find_item_by_fingerprint(session, course_id, incoming.fingerprint)
            if existing_row is not None:
                existing = repository.get_academic_item(session, existing_row.id)
                sr_row = repository.get_sync_record(session, existing_row.id)
                if sr_row is not None:
                    sync_record = SyncRecord.model_validate(sr_row)

        entries.append(decide_action(incoming, existing, sync_record))
    return SyncPlan(course_id=course_id, entries=entries)
