"""Full Yt store facade.

Callers keep ONE class (PgStore); the user/process trigger split (D58/D62)
is enforced by WHERE each method lives, not by call sites.
"""
from Media.Yt.Config.Model.subscription import PgSubscription  # noqa: F401  (re-export)
from Media.Yt.SQL.process.store import YtProcessSQL
from Media.Yt.SQL.user.store import YtUserSQL


class PgStore(YtUserSQL, YtProcessSQL):
    """Yt store: user-triggered SQL + backend-mechanism SQL in one facade."""
