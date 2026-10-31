"""ts_proccess tests — rank prediction from upload gaps."""
from datetime import datetime, timedelta, timezone

from returns.result import Success

from Orchestrator.Yt.Filter.time import ts_proccess


def _payload_with_gaps(gap_days: int, n: int = 12):
    """Build a payload of n videos spaced gap_days apart, newest yesterday."""
    now = datetime.now(timezone.utc)
    payload = {}
    for i in range(n):
        dt = now - timedelta(days=1 + gap_days * i)
        payload[i + 1] = {"id": f"v{i}", "published": dt.strftime("%Y-%m-%dT%H:%M:%SZ")}
    return (payload,)


def test_daily_channel_ranks_day():
    result = ts_proccess(_payload_with_gaps(1))
    assert isinstance(result, Success)
    ts, rank = result.unwrap()
    assert rank == "day"
    assert ts > int(datetime.now(timezone.utc).timestamp())


def test_weekly_channel_ranks_week():
    _, rank = ts_proccess(_payload_with_gaps(7)).unwrap()
    assert rank == "week"


def test_monthly_channel_ranks_month():
    _, rank = ts_proccess(_payload_with_gaps(30)).unwrap()
    assert rank == "month"


def test_abandoned_channel():
    now = datetime.now(timezone.utc)
    old = (now - timedelta(days=800)).strftime("%Y-%m-%dT%H:%M:%SZ")
    payload = ({i + 1: {"id": f"v{i}", "published": old} for i in range(3)},)
    _, rank = ts_proccess(payload).unwrap()
    assert rank == "abandon"


def test_sparse_history_defaults_month():
    now = datetime.now(timezone.utc)
    recent = (now - timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%SZ")
    payload = ({1: {"id": "v1", "published": recent}},)
    _, rank = ts_proccess(payload).unwrap()
    assert rank == "month"
