from types import SimpleNamespace

from hub.services.prompt import DEFAULT_STYLES, DEFAULT_TEMPLATE, build_prompt, parse_generation

KEYS = [s["key"] for s in DEFAULT_STYLES]


def _job():
    return SimpleNamespace(title="Landing page", description="Need WordPress site", budget_text="USD 100 - 250",
                           skills=["WordPress", "CSS"], category="IT", url="https://x")


def _acc():
    return SimpleNamespace(id="me", display_name="Me", profile_text="5 years WordPress", default_rate=20.0)


def test_build_prompt_fills_variables_and_keeps_json():
    p = build_prompt(DEFAULT_TEMPLATE, _job(), _acc(), DEFAULT_STYLES)
    assert "5 years WordPress" in p
    assert "Title: Landing page" in p
    assert "Skills: WordPress, CSS" in p
    assert "- short: direct, under 70 words" in p
    assert '{"formal":"...","friendly":"...","short":"...","technical":"...","price":0,"days":0}' in p
    assert "{account." not in p and "{job." not in p


def test_unknown_variables_left_untouched():
    p = build_prompt("Hello {nope} {job.title}", _job(), _acc(), DEFAULT_STYLES)
    assert p == "Hello {nope} Landing page"


def test_parse_plain_json():
    raw = '{"formal":"A","friendly":"B","short":"C","technical":"D","price":150,"days":5}'
    r = parse_generation(raw, KEYS)
    assert r["texts"] == {"formal": "A", "friendly": "B", "short": "C", "technical": "D"}
    assert r["price"] == 150 and r["days"] == 5


def test_parse_with_fences_prose_and_raw_newlines():
    raw = 'Sure! Here it is:\n```json\n{"formal":"Line1\nLine2","short":"Hi","price":"USD 120","days":"7 días"}\n```\nCopy code'
    r = parse_generation(raw, KEYS)
    assert r["texts"]["formal"] == "Line1\nLine2"
    assert r["texts"]["short"] == "Hi"
    assert r["price"] == 120 and r["days"] == 7


def test_parse_failures():
    assert parse_generation("", KEYS) is None
    assert parse_generation("no json here", KEYS) is None
    assert parse_generation('{"price": 10}', KEYS) is None
    assert parse_generation("{broken", KEYS) is None
