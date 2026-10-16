"""Stage: reconciliation. Decides what a sync would DO, without doing it.

This module never calls Google Calendar. It compares an incoming
(freshly extracted) AcademicItem against whatever is already stored locally
under the same fingerprint, plus that item's SyncRecord, and returns a
SyncAction. The actual Calendar write happens in the academic-import skill,
which calls Claude's Google Calendar connector and then records the result
via db.repository.upsert_sync_record.
"""

from __future__ import annotations

from dataclasses import dataclass

from academic_sync.models.domain import AcademicItem, SyncRecord
from academic_sync.models.enums import ItemStatus, ItemType, SyncAction

_COMPARED_FIELDS = (
    "title",
    "description",
    "date",
    "date_range_end",
    "start_time",
    "end_time",
    "due_time",
    "location_id",
    "platform_location",
    # Real incident, 2026-08-25: none of the fields below were compared,
    # so an item enriched via `render --save` (module_label, reference_url,
    # etc.) *after* its first sync was silently classified UNCHANGED even
    # though its rendered Calendar description had materially changed
    # (a new MODULE line, new LINKS, a new UNGRADED/(Inferred Date) tag) --
    # a real sync run would have skipped re-pushing that improvement to
    # the live event. These are exactly the fields `render`'s payload
    # builders read (directly, or via `render_cmd` defaulting `nesting`
    # from `module_label`) beyond the core scheduling fields above.
    "module_label",
    "reference_url",
    "reference_url_label",
    "resource_url",
    "resource_url_label",
    "submission_url",
    "submission_url_label",
    "weekly_links",
    "covered_chapters",
    "study_focus",
    "video_url",
    "video_url_label",
    "link_available_date",
    "is_optional",
    "is_inferred_date",
)


@dataclass
class PlanEntry:
    action: SyncAction
    item: AcademicItem
    existing_item: AcademicItem | None
    reason: str


def representation_changed(existing: AcademicItem, incoming: AcademicItem) -> bool:
    return any(getattr(existing, f) != getattr(incoming, f) for f in _COMPARED_FIELDS)


def snapshot_compared_fields(item: AcademicItem) -> dict[str, str | bool | None]:
    """The exact field values that matter for deciding whether a Calendar
    event needs re-pushing, stringified so they can be stored as JSON on
    `SyncRecord.last_synced_fields` and compared later without needing to
    parse dates/times back into typed objects -- both the storing side
    (`cli.py::record_sync_cmd`, right after a real Calendar write) and the
    comparing side (`decide_action` below) call this same function, so
    equality of the two dicts is a reliable signal either way.

    Real incident, 2026-08-25: an item already synced (real
    `SyncRecord.google_event_id`) got `module_label`/`reference_url`
    enriched afterward via `render --save`, outside the extraction
    pipeline. Standalone `plan` compares an item's current stored state
    against *itself* (see `sync/planner.py::compute_plan` -- both
    `existing` and `incoming` resolve to the same row when there's no
    fresh extraction to diff against), so `representation_changed` can
    never detect this class of drift no matter which fields it checks --
    there is nothing else to compare against. This snapshot is what
    closes that gap: it's a real record of what was true *at the moment
    of the last actual push*, independent of what's in the row right now.
    """
    out: dict[str, str | bool | None] = {}
    for field in _COMPARED_FIELDS:
        value = getattr(item, field)
        if field == "weekly_links":
            # list[WeeklyLink] -> a stable, order-sensitive string so it
            # round-trips through JSON like every other value here.
            # kind/chapter are appended only when set, so links saved
            # before those fields existed keep their original snapshot
            # string and don't register as spurious drift.
            value = ";".join(
                f"{link.label}|{link.url}"
                + (f"|{link.kind}" if link.kind else "")
                + (f"|{link.chapter}" if link.chapter else "")
                for link in value
            ) or None
        elif field in ("covered_chapters", "study_focus"):
            # Empty -> None so items synced before these fields existed
            # (snapshot lacks the key, .get() -> None) don't read as drift.
            value = ";".join(value) or None
        elif hasattr(value, "isoformat"):
            value = value.isoformat()
        out[field] = value
    return out


def decide_action(
    incoming: AcademicItem,
    existing: AcademicItem | None,
    sync_record: SyncRecord | None,
) -> PlanEntry:
    if incoming.status == ItemStatus.CONFLICTED:
        return PlanEntry(SyncAction.CONFLICT, incoming, existing, "Item has unresolved conflicting evidence.")

    if incoming.status == ItemStatus.CANCELLED:
        if sync_record and sync_record.google_event_id:
            return PlanEntry(
                SyncAction.CANCELLED_BY_SOURCE, incoming, existing,
                "Source explicitly indicates this obligation no longer applies.",
            )
        return PlanEntry(SyncAction.IGNORE, incoming, existing, "Cancelled and never synced; nothing to do.")

    # A SUPERSEDED item is a retired duplicate row (CLAUDE.md invariant 30 --
    # confident-duplicate resolution keeps the row instead of deleting it,
    # so the history stays auditable). Without this check it falls through
    # to is_ready_to_sync() below, which returns False for any status other
    # than CLEAR/SYNCED -- producing a REVIEW entry with a misleading
    # "missing a required field" reason, even though the item was never
    # missing anything and nothing here actually needs attention.
    if incoming.status == ItemStatus.SUPERSEDED:
        return PlanEntry(
            SyncAction.IGNORE, incoming, existing,
            "Superseded by a newer duplicate-resolved version of this item; nothing to sync.",
        )

    # A plain READING item never syncs as its own event, full stop --
    # build_event_payload raises for it (CLAUDE.md invariants 24/25); its
    # content is required to live in a covering lecture's DETAILS or the
    # course's WEEKLY_READING block instead. is_ready_to_sync() doesn't
    # exclude it (it's about field presence, not type), so without this
    # check `plan` reports it as a real CREATE/UPDATE candidate a sync
    # pass would then have to skip -- correct in effect, but noisy and
    # easy to mistake for a real gap. IGNORE, same as an already-handled
    # CANCELLED item, is the honest classification.
    if incoming.item_type == ItemType.READING:
        return PlanEntry(
            SyncAction.IGNORE, incoming, existing,
            "Plain READING item -- never syncs as its own event; content belongs in a "
            "covering lecture's DETAILS or a WEEKLY_READING block instead.",
        )

    if not incoming.is_ready_to_sync():
        return PlanEntry(
            SyncAction.REVIEW, incoming, existing,
            "Missing a required field (date, or start time for a fixed-time meeting) -- not safe to sync.",
        )

    if existing is None:
        return PlanEntry(SyncAction.CREATE, incoming, existing, "No existing record for this fingerprint.")

    if sync_record is None or not sync_record.google_event_id:
        if representation_changed(existing, incoming):
            return PlanEntry(
                SyncAction.CREATE, incoming, existing,
                "Existing record was never synced; treating as new.",
            )
        return PlanEntry(SyncAction.CREATE, incoming, existing, "Matches stored record, never synced yet.")

    # Prefer comparing against a real snapshot of what was actually last
    # pushed (see snapshot_compared_fields) over comparing the current row
    # against itself -- the latter can never detect drift from enrichment
    # applied directly via `render --save` after the item was synced,
    # since both sides are the same stored data in that case.
    if sync_record.last_synced_fields is not None:
        current = snapshot_compared_fields(incoming)
        # Compared field-by-field with .get(), not dict ==: a snapshot
        # recorded before a field joined _COMPARED_FIELDS simply lacks that
        # key, which must read as None (the new field's default), not as
        # drift on every previously-synced item.
        changed = sorted(
            f for f in _COMPARED_FIELDS
            if current.get(f) != sync_record.last_synced_fields.get(f)
        )
        if not changed:
            return PlanEntry(SyncAction.UNCHANGED, incoming, existing, "No change since last sync.")
        return PlanEntry(
            SyncAction.UPDATE, incoming, existing,
            f"Fields changed since last sync: {', '.join(changed)}.",
        )

    # A SyncRecord written before last_synced_fields existed (every real
    # sync performed before 2026-08-25's fix) has no baseline to compare
    # against at all -- NOT "known unchanged." Falling back to
    # representation_changed(existing, incoming) here would silently
    # reproduce the exact bug this snapshot exists to fix, since standalone
    # `plan` passes the same stored row as both `existing` and `incoming`
    # (see sync/planner.py::compute_plan) and that comparison is always
    # False regardless of real drift. Flag it for one push instead --
    # record_sync_cmd backfills last_synced_fields the moment that push
    # actually happens, after which real drift detection works normally.
    return PlanEntry(
        SyncAction.UPDATE, incoming, existing,
        "No payload snapshot recorded from this item's last sync (predates "
        "drift tracking) -- pushing once to backfill it; real content may "
        "or may not have changed.",
    )
