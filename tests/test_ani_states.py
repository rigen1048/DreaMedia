"""Ani state machine — pure transition tests (D19)."""
import time

from Orchestrator.Ani.Filter.states import (
    classify_transition,
    episodes_aired,
    next_check_for,
    parse_release_ts,
)

NOW = int(time.time())
DAY = 24 * 3600


def _video(published="", status=None, episodes=None, next_ep=None, next_at=None):
    v = {"published": published, "status": status, "episodes": episodes}
    if next_ep is not None:
        v["next_airing"] = {"episode": next_ep, "airingAt": next_at}
    return v


def test_unknown_with_release_becomes_announced():
    future = NOW + 30 * DAY
    ts = future
    assert classify_transition("unknown", ts, 0, "NOT_YET_RELEASED", NOW) == "announced"


def test_unknown_without_release_stays_unknown():
    assert classify_transition("unknown", None, 0, None, NOW) == "unknown"


def test_announced_becomes_airing_after_grace_with_episodes():
    past_release = NOW - 3 * 24 * 3600  # bypassed 72h > 48h grace
    assert classify_transition("announced", past_release, 2, "RELEASING", NOW) == "airing"


def test_announced_within_grace_stays_announced():
    recent = NOW - 12 * 3600  # bypassed only 12h
    assert classify_transition("announced", recent, 1, "RELEASING", NOW) == "announced"


def test_airing_finished_becomes_finished():
    assert classify_transition("airing", None, 12, "FINISHED", NOW) == "finished"


def test_episodes_aired_from_next_airing():
    assert episodes_aired(_video(next_ep=5, next_at=NOW + DAY)) == 4
    assert episodes_aired(_video(status="FINISHED", episodes=24)) == 24
    assert episodes_aired(_video()) == 0


def test_next_check_cadences():
    assert next_check_for("unknown", None, NOW) == NOW + 30 * DAY
    future_release = NOW + 60 * DAY
    # announced, confirm not yet reached → check at T−1 month
    assert next_check_for("announced", future_release, NOW) == future_release - 30 * DAY
    # announced, inside confirm window → check at T−12h
    near_release = NOW + 5 * DAY
    assert next_check_for("announced", near_release, NOW) == near_release - 12 * 3600


def test_parse_release_ts_prefers_start_date():
    v = _video(published="2026-10-01")
    ts = parse_release_ts(v)
    assert ts is not None
    assert time.strftime("%Y-%m-%d", time.gmtime(ts)) == "2026-10-01"
