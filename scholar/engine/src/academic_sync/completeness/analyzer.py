"""Completeness analysis.

The central rule this module exists to enforce: a detailed syllabus is never
sufficient by itself to call a course COMPLETE. If extraction found
references to material that was never actually inspected (see
extraction.classify.find_reference_phrases, which feeds
UnresolvedReference rows of kind EXTERNAL_REFERENCE_UNINSPECTED), the course
cannot be COMPLETE regardless of how much the syllabus contains.
"""

from __future__ import annotations

from academic_sync.models.domain import CourseCompletenessReport, UnresolvedReference
from academic_sync.models.enums import CompletenessStatus, SourceType, UnresolvedReferenceKind

# Source types that, if never inspected for a course that clearly has them
# (e.g. the syllabus mentions quizzes but no D2L quiz page was ever scanned),
# should stop us from calling the course fully COMPLETE. This is intentionally
# a soft signal (missing_source_types), not a hard gate -- some courses
# genuinely don't use Discussions, Checklists, etc.
TYPICAL_SOURCE_TYPES = {
    SourceType.SYLLABUS,
    SourceType.D2L_CONTENT,
    SourceType.D2L_CALENDAR,
    SourceType.D2L_DROPBOX,
    SourceType.D2L_QUIZZES,
    SourceType.D2L_ANNOUNCEMENTS,
}


def analyze_completeness(
    course_id: str,
    *,
    inspected_source_types: set[SourceType],
    unresolved_references: list[UnresolvedReference],
    conflicting_date_count: int,
    undated_graded_work_count: int,
    unnested_item_count: int = 0,
    unlinked_item_count: int = 0,
    missing_chapter_topic_count: int = 0,
    partial_chapter_topic_count: int = 0,
    is_synthetic: bool = False,
) -> CourseCompletenessReport:
    open_refs = [r for r in unresolved_references if not r.resolved]
    external_uninspected = [
        r for r in open_refs if r.kind == UnresolvedReferenceKind.EXTERNAL_REFERENCE_UNINSPECTED
    ]
    missing_types = sorted(
        (TYPICAL_SOURCE_TYPES - inspected_source_types), key=lambda t: t.value
    )

    notes: list[str] = []

    # A synthetic course (Course.is_synthetic, CLAUDE.md invariant 35) has
    # zero Source rows and zero ChapterTopic rows by design -- nothing was
    # ever scraped, and the custom-curriculum skill never calls
    # chapter-topic-add. Both are expected, permanent, correct facts about
    # this course type, not gaps -- left to the branch chain below, the
    # first branch would report it as permanently UNKNOWN ("no sources
    # scanned"), which reads as a stuck error state forever. Short-circuit
    # before any of the real-course checks run.
    if is_synthetic:
        return CourseCompletenessReport(
            course_id=course_id,
            status=CompletenessStatus.COMPLETE,
            inspected_source_types=sorted(inspected_source_types, key=lambda t: t.value),
            missing_source_types=[],
            unresolved_reference_count=len(open_refs),
            possible_hidden_obligations=[],
            conflicting_date_count=conflicting_date_count,
            undated_graded_work_count=undated_graded_work_count,
            unnested_item_count=unnested_item_count,
            unlinked_item_count=unlinked_item_count,
            missing_chapter_topic_count=0,
            partial_chapter_topic_count=0,
            safe_to_sync_clear_subset=True,
            notes=[
                "Synthetic course -- authored curriculum, no D2L sources or "
                "chapter-topic capture expected."
            ],
        )

    if conflicting_date_count > 0:
        status = CompletenessStatus.CONFLICTED
        notes.append(
            f"{conflicting_date_count} item(s) have conflicting dates from different "
            "sources with no clear revision relationship."
        )
    elif not inspected_source_types:
        status = CompletenessStatus.UNKNOWN
        notes.append("No sources have been scanned yet for this course.")
    elif (
        external_uninspected
        or undated_graded_work_count > 0
        or unnested_item_count > 0
        or unlinked_item_count > 0
        or missing_chapter_topic_count > 0
        or partial_chapter_topic_count > 0
    ):
        status = CompletenessStatus.INCOMPLETE
        if external_uninspected:
            notes.append(
                f"{len(external_uninspected)} reference(s) to material outside what's "
                "been inspected so far (e.g. \"see D2L\", \"details will be posted\")."
            )
        if undated_graded_work_count > 0:
            notes.append(
                f"{undated_graded_work_count} known graded item(s) have no confirmed date yet."
            )
        if unnested_item_count > 0:
            # This course has real module/chapter structure in D2L (some
            # item already carries a module_label) but these dated items
            # don't -- meaning the per-module/per-chapter content pages
            # were never actually opened for them. See CLAUDE.md invariant
            # 17 and docs/d2l_discovery.md#required-finds -- nesting is a
            # required find, not enrichment, once module structure exists.
            notes.append(
                f"{unnested_item_count} dated item(s) are missing module/chapter nesting "
                "even though this course has real module structure elsewhere -- the "
                "per-module content page for these items was never opened."
            )
        if unlinked_item_count > 0:
            # CLAUDE.md invariant 17 (amended): reference_url and
            # resource_url are independently required where applicable, not
            # either/or -- a resource_url (e.g. a printout/handout link)
            # never substitutes for the item's own reference_url (the real
            # submission/turn-in location).
            notes.append(
                f"{unlinked_item_count} graded item(s) (quiz/assignment/exam/etc.) are "
                "missing a reference_url -- the actual submission/turn-in location "
                "(D2L Dropbox/Quiz attempt page/ALEKS, etc.) was never located, even if "
                "a resource_url (textbook/printout) is already set. See "
                "docs/d2l_discovery.md#links."
            )
        if missing_chapter_topic_count > 0:
            # See CLAUDE.md invariant 26: once a course has WEEKLY_READING
            # items (i.e. real chapters/units are known to exist), every
            # chapter/unit they reference must have a saved ChapterTopic
            # row (chapter-topic-add). A thin capture is only acceptable
            # when the source itself is genuinely thin -- never as a stand-
            # in for a deeper structure that exists but wasn't fully
            # captured (that's what partial_chapter_topic_count catches).
            notes.append(
                f"{missing_chapter_topic_count} chapter/unit(s) referenced in this course's "
                "weekly reading blocks have no saved topic breakdown yet (chapter-topic-add "
                "was never run for them)."
            )
        if partial_chapter_topic_count > 0:
            # A saved row exists but hasn't been confirmed to be the
            # platform's real, complete, stable topic list -- it may still
            # be a sample or have been pulled from a personalized/adaptive
            # "what's next for you" view (e.g. ALEKS's Ready to Learn)
            # rather than the platform's real structure (e.g. ALEKS's View
            # All Topics). See CLAUDE.md invariant 26.
            notes.append(
                f"{partial_chapter_topic_count} chapter/unit(s) have a saved topic breakdown "
                "that hasn't been confirmed exhaustive yet (chapter-topic-add --exhaustive not "
                "set) -- may still be a partial/sampled capture."
            )
    elif missing_types:
        status = CompletenessStatus.COMPLETE_FOR_DATED_ITEMS
        notes.append(
            "No open references to uninspected material and no undated graded work, but "
            f"these source types were never scanned: {', '.join(t.value for t in missing_types)}. "
            "Treating dated items as trustworthy; not claiming full course coverage."
        )
    else:
        status = CompletenessStatus.COMPLETE
        notes.append("All typical source types inspected; no open references or undated graded work.")

    return CourseCompletenessReport(
        course_id=course_id,
        status=status,
        inspected_source_types=sorted(inspected_source_types, key=lambda t: t.value),
        missing_source_types=missing_types,
        unresolved_reference_count=len(open_refs),
        possible_hidden_obligations=[r.description for r in external_uninspected],
        conflicting_date_count=conflicting_date_count,
        undated_graded_work_count=undated_graded_work_count,
        unnested_item_count=unnested_item_count,
        unlinked_item_count=unlinked_item_count,
        missing_chapter_topic_count=missing_chapter_topic_count,
        partial_chapter_topic_count=partial_chapter_topic_count,
        # Item-level status (CLEAR vs UNRESOLVED/CONFLICTED) is what actually
        # gates an individual sync, independent of course-level completeness --
        # see reconciliation.engine.decide_action. A course being INCOMPLETE or
        # even CONFLICTED must not block syncing items that are themselves clear.
        safe_to_sync_clear_subset=True,
        notes=notes,
    )
