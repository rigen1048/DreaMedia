"""Pure-filter tests — owner scenarios as executable spec."""
from returns.result import Failure, Success

from Orchestrator.Yt.Filter.last_seen import filter_new_videos
from Orchestrator.Yt.Filter.scan import filter_words

PAYLOAD = (
    {
        1: {"id": "v3", "title": "Newest", "url": "u3"},
        2: {"id": "v2", "title": "Middle Banana", "url": "u2"},
        3: {"id": "v1", "title": "Oldest", "url": "u1"},
    },
)


def test_last_seen_none_returns_everything():
    assert filter_new_videos(PAYLOAD, None).unwrap() == PAYLOAD


def test_last_seen_latest_is_same():
    result = filter_new_videos(PAYLOAD, "v3")
    assert isinstance(result, Failure)
    assert result.failure() == "Same"


def test_last_seen_gap_returns_only_newer():
    result = filter_new_videos(PAYLOAD, "v1")
    kept = result.unwrap()[0]
    assert [v["id"] for v in kept.values()] == ["v3", "v2"]


def test_last_seen_not_found_carries_full_payload():
    result = filter_new_videos(PAYLOAD, "ghost")
    assert isinstance(result, Failure)
    kind, full = result.failure()
    assert kind == "Not Found"
    assert full == PAYLOAD


def test_filter_words_case_insensitive_substring():
    result = filter_words(PAYLOAD, ["BANANA"])
    kept = result.unwrap()[0]
    assert list(kept) == [1]
    assert kept[1]["id"] == "v2"


def test_filter_words_no_match_fails():
    result = filter_words(PAYLOAD, ["dragon"])
    assert isinstance(result, Failure)
