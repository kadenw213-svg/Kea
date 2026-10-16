from __future__ import annotations

from academic_sync.chapter_topics import (
    build_chapter_topic_blocks,
    canonicalize_chapter_label,
    split_chapter_segments,
)
from academic_sync.models.domain import ChapterTopic


def test_split_chapter_segments_with_colon_topic():
    assert split_chapter_segments("Chapter 22: Descent with Modification") == [
        ("Chapter 22", "Descent with Modification"),
    ]


def test_split_chapter_segments_bare_chapter_no_topic():
    assert split_chapter_segments("Chapter 1; Chapter 2") == [
        ("Chapter 1", ""),
        ("Chapter 2", ""),
    ]


def test_split_chapter_segments_mixed_chapter_and_plain_text():
    assert split_chapter_segments("Syllabus and Orientation; Chapter 22: Descent with Modification") == [
        (None, "Syllabus and Orientation"),
        ("Chapter 22", "Descent with Modification"),
    ]


def test_split_chapter_segments_unit_label():
    assert split_chapter_segments("Unit 2: Graphs & Functions") == [("Unit 2", "Graphs & Functions")]


def test_split_chapter_segments_module_label():
    assert split_chapter_segments(
        "Module 1: Introduction to Research: Finding the Conversation"
    ) == [("Module 1", "Introduction to Research: Finding the Conversation")]


def test_canonicalize_chapter_label_module():
    assert canonicalize_chapter_label("Module 3") == "module-3"


def test_canonicalize_chapter_label_normalizes_casing_and_whitespace():
    assert canonicalize_chapter_label("Chapter 23") == "chapter-23"
    assert canonicalize_chapter_label("chapter  23") == "chapter-23"
    assert canonicalize_chapter_label("CHAPTER 23") == "chapter-23"


def test_canonicalize_chapter_label_unit():
    assert canonicalize_chapter_label("Unit 2") == "unit-2"


def test_canonicalize_chapter_label_falls_back_for_unrecognized_shape():
    assert canonicalize_chapter_label("Lesson Four: Cells") == "lesson four: cells"


def _topic(**kwargs) -> ChapterTopic:
    defaults = dict(id="t1", course_id="c1", chapter_label="Chapter 23")
    defaults.update(kwargs)
    return ChapterTopic(**defaults)


def test_build_chapter_topic_blocks_with_saved_topic_includes_vocab_and_objectives():
    segments = [("Chapter 23", "Evolution of Populations")]
    topic = _topic(
        chapter_label="Chapter 23",
        vocabulary="microevolution, genetic drift",
        objectives=["Explain X", "Distinguish Y"],
    )
    blocks = build_chapter_topic_blocks(segments, {"chapter-23": topic})
    assert blocks == [
        {
            "label": "Chapter 23 — Evolution of Populations",
            "items": ["Vocabulary: microevolution, genetic drift", "Explain X", "Distinguish Y"],
        }
    ]


def test_build_chapter_topic_blocks_no_saved_topic_falls_back_to_header_only():
    segments = [("Chapter 26", "Phylogeny and Classification")]
    blocks = build_chapter_topic_blocks(segments, {})
    assert blocks == [{"text": "Chapter 26 — Phylogeny and Classification"}]


def test_build_chapter_topic_blocks_bare_chapter_label_no_topic_text():
    # CHE1011's real chapters are only ever named "Chapter 1"/"Chapter 2" --
    # no invented topic title.
    segments = [("Chapter 1", "")]
    topic = _topic(chapter_label="Chapter 1", objectives=["Read syllabus"])
    blocks = build_chapter_topic_blocks(segments, {"chapter-1": topic})
    assert blocks == [{"label": "Chapter 1", "items": ["Read syllabus"]}]


def test_build_chapter_topic_blocks_non_chapter_segment_is_plain_text():
    segments = [(None, "Syllabus and Orientation")]
    blocks = build_chapter_topic_blocks(segments, {})
    assert blocks == [{"text": "Syllabus and Orientation"}]


def test_build_chapter_topic_blocks_saved_topic_with_no_vocab_or_objectives_falls_back():
    # A ChapterTopic row can exist (discovery looked) but genuinely have
    # nothing real to report yet -- thin but true, not fabricated.
    segments = [("Chapter 5", "Cell Division")]
    topic = _topic(chapter_label="Chapter 5")
    blocks = build_chapter_topic_blocks(segments, {"chapter-5": topic})
    assert blocks == [{"text": "Chapter 5 — Cell Division"}]


def test_chapter_and_section_qualifier_still_matches_chapter():
    from academic_sync.chapter_topics import split_chapter_segments
    assert split_chapter_segments("Chapter 5: Systems (11/1); Chapter 7 and Section 2.2: Conics (11/11)") == [
        ("Chapter 5", "Systems (11/1)"), ("Chapter 7", "Conics (11/11)")]


def test_study_items_drop_objectives_that_only_restate_a_section_heading():
    # CHE-style redundancy (user-directed 2026-10-15, CLAUDE.md invariant
    # 40): an "objective" that is just a READING section heading, bare or
    # with a sub-heading, never repeats in TOPIC DETAIL.
    topic = _topic(
        chapter_label="Chapter 6",
        vocabulary="solute, solvent, molarity",
        sections=["6.1 Properties of Solutions", "6.3 Concentration Based on Moles"],
        objectives=[
            "6.1 Properties of Solutions",
            "6.1 Properties of Solutions: Henry's Law",
            "Calculate the molarity of a solution",
        ],
    )
    blocks = build_chapter_topic_blocks([("Chapter 6", "Solutions")], {"chapter-6": topic})
    assert blocks == [
        {
            "label": "Chapter 6 — Solutions",
            "items": ["Vocabulary: solute, solvent, molarity", "Calculate the molarity of a solution"],
        }
    ]


def test_added_content_renders_as_its_own_labeled_block_after_sourced_one():
    topic = _topic(
        chapter_label="Chapter 6",
        vocabulary="solute",
        objectives=["Define a solution"],
        added_vocabulary="colligative property",
        added_objectives=["Explain why salt lowers the freezing point of water"],
    )
    blocks = build_chapter_topic_blocks([("Chapter 6", "Solutions")], {"chapter-6": topic})
    assert blocks == [
        {"label": "Chapter 6 — Solutions", "items": ["Vocabulary: solute", "Define a solution"]},
        {
            "label": "Chapter 6 — Solutions — Added (not from instructor)",
            "items": [
                "Vocabulary: colligative property",
                "Explain why salt lowers the freezing point of water",
            ],
        },
    ]


def test_added_only_chapter_has_no_empty_sourced_header_line():
    topic = _topic(chapter_label="Chapter 6", added_objectives=["Explain osmosis"])
    blocks = build_chapter_topic_blocks([("Chapter 6", "Solutions")], {"chapter-6": topic})
    assert blocks == [
        {"label": "Chapter 6 — Solutions — Added (not from instructor)", "items": ["Explain osmosis"]}
    ]


def test_objective_with_real_content_after_a_section_prefix_is_kept():
    topic = _topic(
        chapter_label="Chapter 1",
        sections=["1.3 Complex Numbers"],
        objectives=["1.3 Complex Numbers: simplify to the form a+bi; perform operations"],
    )
    blocks = build_chapter_topic_blocks([("Chapter 1", "Review")], {"chapter-1": topic})
    assert blocks[0]["items"] == ["1.3 Complex Numbers: simplify to the form a+bi; perform operations"]


def test_added_vocabulary_leads_when_no_sourced_vocabulary():
    topic = _topic(chapter_label="Chapter 4", objectives=["Solve log equations"],
                   added_vocabulary="logarithm", added_objectives=["log_b x = y means b^y = x"])
    blocks = build_chapter_topic_blocks([("Chapter 4", "Logs")], {"chapter-4": topic})
    assert blocks == [
        {"label": "Chapter 4 — Logs",
         "items": ["Vocabulary, added (not from instructor): logarithm", "Solve log equations"]},
        {"label": "Chapter 4 — Logs — Added (not from instructor)", "items": ["log_b x = y means b^y = x"]},
    ]
