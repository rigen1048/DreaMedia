"""Supergraph (D25): merges the children schemas into the single GraphQL
the frontend talks to. Children stay independently mountable — the
federation-variant layout is structural, not process-level (docker app, D6).
"""
from __future__ import annotations

import strawberry

from Graphql.children import AniMutation, AniQuery, YtMutation, YtQuery


@strawberry.type
class Query(YtQuery, AniQuery):
    pass


@strawberry.type
class Mutation(YtMutation, AniMutation):
    pass


supergraph_schema = strawberry.Schema(query=Query, mutation=Mutation)
