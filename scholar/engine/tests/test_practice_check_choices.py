from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from academic_sync.cli import app

runner = CliRunner()

EXPLAIN = "Natural selection acts on variation already present: the drug kills susceptible cells, so resistant ones leave more offspring."


def _mc(answer_text: str, wrong: list[str], n: int = 0, notes: bool = True) -> dict:
    q = {"type": "mc", "q": f"Question {n}: which is right?", "choices": [answer_text, *wrong], "answer": 0,
         "level": "apply", "explain": EXPLAIN}
    if notes:
        q["wrong"] = ["", *(f"confuses it with choice {i} concept" for i in range(len(wrong)))]
    return q


def _check(tmp_path: Path, questions: list[dict]) -> dict:
    f = tmp_path / "set.json"
    f.write_text(json.dumps({"questions": questions}), encoding="utf-8")
    r = runner.invoke(app, ["practice-check", str(f)])
    return json.loads(r.stdout[r.stdout.index("{"):])


def test_answer_much_longer_than_every_wrong_choice_is_refused(tmp_path):
    q = _mc("Resistant variants already present survive the drug and leave more offspring each generation",
            ["Bacteria learn it", "Drift spreads it", "Mutation is caused"])
    out = _check(tmp_path, [q])
    assert any("gives itself away by length" in p for p in out["problems"])


def test_parallel_choices_pass(tmp_path):
    q = _mc("Resistant variants already present survive and reproduce",
            ["The drug causes mutations toward resistance", "Bacteria learn to tolerate the drug",
             "Resistance spreads mainly by genetic drift"])
    out = _check(tmp_path, [q])
    assert not any("length" in p for p in out["problems"])


def test_set_where_the_answer_is_usually_longest_is_refused(tmp_path):
    qs = [_mc("A somewhat longer correct choice", ["Short wrong one", "Another wrong", "Third wrong"], n) for n in range(10)]
    out = _check(tmp_path, qs)
    assert any("is the longest choice" in p for p in out["problems"])


def test_set_with_answer_length_at_chance_passes(tmp_path):
    qs = [_mc("A somewhat longer correct choice" if n < 3 else "Short right",
              ["Short wrong one", "Another wrong one here", "Third"], n) for n in range(10)]
    out = _check(tmp_path, qs)
    assert not any("is the longest choice" in p for p in out["problems"])


def test_only_choices_that_point_at_other_choices_are_refused(tmp_path):
    q = _mc("Both species molt", ["Both A and B", "Neither species molts", "Neither of these"])
    out = _check(tmp_path, [q])
    flagged = [p for p in out["problems"] if "shuffles" in p]
    assert len(flagged) == 2 and not any("species" in p for p in flagged)


def test_every_wrong_choice_needs_its_mistake_named(tmp_path):
    out = _check(tmp_path, [_mc("Cats", ["Dogs", "Mice", "Rats"], notes=False)])
    assert any("needs `wrong`" in p for p in out["problems"])
    q = _mc("Cats", ["Dogs", "Mice", "Rats"])
    q["wrong"][2] = "wrong"
    out = _check(tmp_path, [q])
    assert any("choice C" in p for p in out["problems"])
    out = _check(tmp_path, [_mc("Cats", ["Dogs", "Mice", "Rats"])])
    assert not any("wrong`" in p for p in out["problems"])
