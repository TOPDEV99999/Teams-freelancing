from types import SimpleNamespace

import pytest

from hub.services.assignment import DISQUALIFIED, choose_account, parse_budget, score_account


def acc(id, cats, min_budget=None, active=True):
    return SimpleNamespace(id=id, categories=cats, min_budget=min_budget, active=active)


def job(title="", desc="", skills=(), category=None, bmin=None, bmax=None):
    return SimpleNamespace(title=title, description=desc, skills=list(skills), category=category,
                           budget_min=bmin, budget_max=bmax)


def test_best_keyword_match_wins():
    j = job("Landing page en WordPress", "Necesito WordPress con Elementor", ["WordPress"])
    accounts = [acc("me", ["python", "django"]), acc("friend_a", ["wordpress", "elementor"])]
    best, scores = choose_account(j, accounts)
    assert best == "friend_a"
    assert scores["friend_a"] > scores["me"]


def test_below_threshold_is_unassigned():
    j = job("Translate a manual", "English to Spanish")
    best, _ = choose_account(j, [acc("me", ["python"])])
    assert best is None


def test_inactive_accounts_ignored():
    j = job("Python script", skills=["Python"])
    best, scores = choose_account(j, [acc("me", ["python"], active=False)])
    assert best is None and scores == {}


def test_budget_disqualifies():
    j = job("Python script", skills=["Python"], bmin=10, bmax=40)
    assert score_account(j, acc("me", ["python"], min_budget=100)) == DISQUALIFIED


def test_word_boundaries():
    # "java" must not match "javascript"
    assert score_account(job("JavaScript dev"), acc("x", ["java"])) == 0


def test_ties_are_deterministic():
    j = job("Python", skills=["Python"])
    best, _ = choose_account(j, [acc("zeta", ["python"]), acc("alpha", ["python"])])
    assert best == "alpha"


@pytest.mark.parametrize("text,expected", [
    ("USD 50 - 100", (50, 100)),
    ("Menos de USD 50", (None, 50)),
    ("Más de USD 3.000", (3000, None)),
    ("USD 1,000 - 3,000", (1000, 3000)),
    ("$ 15 - 45 USD / hora", (15, 45)),
    ("USD 250", (250, 250)),
    ("A convenir", (None, None)),
    ("", (None, None)),
])
def test_parse_budget(text, expected):
    assert parse_budget(text) == expected
