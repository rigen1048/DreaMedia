"""Account-level GraphQL: portable backup (D56) + extension tokens (D55)."""
from __future__ import annotations

from typing import List, Optional

import strawberry
from returns.result import Failure
from strawberry.types import Info

from Database.Backup import csvio, portable
from Extension import sites, tokens
from Extension.store import ExtDomainStore
from Graphql.children import _uid, _unwrap

_domains = ExtDomainStore()


@strawberry.type
class ExtDomain:
    id: int
    domain: Optional[str]
    media: str
    enabled: bool


@strawberry.type
class ExtLearnedSite:
    id: int
    entry_id: int
    entry_title: Optional[str]
    domain: Optional[str]
    url: Optional[str]
    season: Optional[int]
    episode: Optional[int]
    use_count: int
    last_used_at: Optional[str]


@strawberry.type
class AccountQuery:
    @strawberry.field
    async def export_data(self, info: Info) -> str:
        """Portable txt backup (D56): decrypted JSON snapshot, shown once as a
        download. Schema-version-independent by design."""
        result = await portable.export_user(await _uid(info))
        return _unwrap(result)

    @strawberry.field
    async def ext_domains(self, info: Info) -> List[ExtDomain]:
        """Extension v2: the website allowlist (only these domains run the
        extension's content scripts)."""
        user_id = await _uid(info)
        _unwrap(await _domains.ensure_default_youtube(user_id))
        rows = await _domains.list_domains(user_id)
        return [ExtDomain(**r) for r in rows]

    @strawberry.field
    async def ext_learned_sites(self, info: Info) -> List[ExtLearnedSite]:
        """Phase 5 learned map: which site serves which anime, manageable
        from the Extension page."""
        rows = _unwrap(await sites.list_watch_sites(await _uid(info)))
        return [ExtLearnedSite(**r) for r in rows]

    @strawberry.field
    async def export_csv(self, info: Info, media: str) -> str:
        """CSV backup, one file per media (FreeTube-compatible YouTube
        columns; anime carries title + AniList id + cursor)."""
        user_id = await _uid(info)
        if media == "yt":
            return _unwrap(await csvio.export_youtube(user_id))
        if media == "ani":
            return _unwrap(await csvio.export_anime(user_id))
        raise ValueError("media must be yt|ani")


@strawberry.type
class ImportResult:
    channels: int
    cards: int
    anime: int
    skipped: int


@strawberry.type
class CsvImportResult:
    imported: int
    skipped: int
    errors: List[str]


@strawberry.type
class AccountMutation:
    @strawberry.field
    async def import_data(self, info: Info, payload: str) -> ImportResult:
        """Restore a portable export — re-encrypts under the current key."""
        result = await portable.import_user(await _uid(info), payload)
        counts = _unwrap(result)
        return ImportResult(**counts)

    @strawberry.field
    async def import_csv(self, info: Info, media: str, payload: str) -> CsvImportResult:
        """CSV import: FreeTube / HydraWatch / our own exports."""
        user_id = await _uid(info)
        if media == "yt":
            return CsvImportResult(**_unwrap(await csvio.import_youtube(user_id, payload)))
        if media == "ani":
            return CsvImportResult(**_unwrap(await csvio.import_anime(user_id, payload)))
        raise ValueError("media must be yt|ani")

    @strawberry.field
    async def ext_issue_token(self, info: Info) -> str:
        """Rotate the extension token; the raw value is returned ONCE (D55)."""
        return await tokens.issue_token(await _uid(info))

    @strawberry.field
    async def ext_revoke_token(self, info: Info) -> bool:
        await tokens.revoke_token(await _uid(info))
        return True

    @strawberry.field
    async def ext_add_domain(self, info: Info, domain: str, media: str) -> ExtDomain:
        result = await _domains.add_domain(await _uid(info), domain, media)
        return ExtDomain(**_unwrap(result))

    @strawberry.field
    async def ext_set_domain_enabled(self, info: Info, domain_id: int, enabled: bool) -> bool:
        _unwrap(await _domains.set_enabled(await _uid(info), domain_id, enabled))
        return True

    @strawberry.field
    async def ext_remove_domain(self, info: Info, domain_id: int) -> bool:
        _unwrap(await _domains.remove_domain(await _uid(info), domain_id))
        return True

    @strawberry.field
    async def ext_delete_learned_site(self, info: Info, site_id: int) -> bool:
        _unwrap(await sites.delete_watch_site(await _uid(info), site_id))
        return True
