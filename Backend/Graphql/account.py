"""Account-level GraphQL: portable backup (D56) + extension tokens (D55)."""
from __future__ import annotations

from typing import Optional

import strawberry
from returns.result import Failure
from strawberry.types import Info

from Database import portable
from Extension import tokens
from Graphql.children import _uid, _unwrap


@strawberry.type
class AccountQuery:
    @strawberry.field
    async def export_data(self, info: Info) -> str:
        """Portable txt backup (D56): decrypted JSON snapshot, shown once as a
        download. Schema-version-independent by design."""
        result = await portable.export_user(await _uid(info))
        return _unwrap(result)


@strawberry.type
class ImportResult:
    channels: int
    cards: int
    anime: int
    skipped: int


@strawberry.type
class AccountMutation:
    @strawberry.field
    async def import_data(self, info: Info, payload: str) -> ImportResult:
        """Restore a portable export — re-encrypts under the current key."""
        result = await portable.import_user(await _uid(info), payload)
        counts = _unwrap(result)
        return ImportResult(**counts)

    @strawberry.field
    async def ext_issue_token(self, info: Info) -> str:
        """Rotate the extension token; the raw value is returned ONCE (D55)."""
        return await tokens.issue_token(await _uid(info))

    @strawberry.field
    async def ext_revoke_token(self, info: Info) -> bool:
        await tokens.revoke_token(await _uid(info))
        return True
