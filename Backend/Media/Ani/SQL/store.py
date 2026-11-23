"""Full Ani store facade (see Media/Yt/SQL/store.py for the pattern)."""
from Media.Ani.Config.Model.due import AniDue  # noqa: F401  (re-export)
from Media.Ani.SQL.process.store import AniProcessSQL
from Media.Ani.SQL.user.store import AniUserSQL


class AniStore(AniUserSQL, AniProcessSQL):
    """Ani store: user-triggered SQL + backend-mechanism SQL in one facade."""
