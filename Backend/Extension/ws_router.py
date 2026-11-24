"""WebSocket policy for the extension's token-authenticated GraphQL lane.

Also provides best-effort broadcast of `success`/`news` messages to
extension clients per user (used by the unified import queue workers).
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any
from urllib.parse import urlsplit

from strawberry.exceptions import ConnectionRejectionError
from strawberry.fastapi import GraphQLRouter

TokenValidator = Callable[[str], Awaitable[int | None]]
_EXTENSION_SCHEMES = frozenset(
    {"chrome-extension", "moz-extension", "safari-web-extension"}
)
_log = logging.getLogger("dreamedia.extension.websocket")

# Best-effort pending messages per user, keyed by user_id.
# The extension polls /extension/sources/status for missed messages;
# this broadcast is a push-side best-effort when a WebSocket is open.
_pending_messages: dict[int, list[dict]] = {}


def is_browser_extension_origin(origin: str) -> bool:
    """Allow only a bare origin using a known browser-extension scheme.

    Extension IDs are browser/profile-specific, so they cannot be hard-coded
    in the server. This route does not use ambient cookies: a valid per-user
    token must still be supplied in graphql-transport-ws connection_init.
    """
    try:
        parts = urlsplit(origin)
        port = parts.port
    except ValueError:
        return False
    return (
        parts.scheme.lower() in _EXTENSION_SCHEMES
        and bool(parts.hostname)
        and parts.username is None
        and parts.password is None
        and port is None
        and parts.path in ("", "/")
        and not parts.query
        and not parts.fragment
    )


async def broadcast_to_user(user_id: int, message: dict) -> None:
    """Best-effort: queue a `success`/`news` message for a user's extension.

    Messages are stored per-user and delivered on the next WebSocket
    receive cycle, or retrieved via the REST status endpoint.
    """
    _pending_messages.setdefault(user_id, []).append(message)
    # Cap the pending list so it doesn't grow unbounded.
    if len(_pending_messages[user_id]) > 100:
        _pending_messages[user_id] = _pending_messages[user_id][-100:]


def take_pending_messages(user_id: int) -> list[dict]:
    """Drain and return all pending messages for a user (extension poll)."""
    return _pending_messages.pop(user_id, [])


class ExtensionGraphQLRouter(GraphQLRouter):
    """GraphQLRouter with extension-origin handling and pre-ACK token auth."""

    def __init__(
        self,
        *args: Any,
        token_validator: TokenValidator,
        **kwargs: Any,
    ) -> None:
        self.token_validator = token_validator
        super().__init__(*args, **kwargs)

    def is_websocket_origin_allowed(self, request: Any, origin: str) -> bool:
        if is_browser_extension_origin(origin):
            return True
        return super().is_websocket_origin_allowed(request, origin)

    async def on_ws_connect(self, context: Any) -> Any:
        """Validate the explicit token before Strawberry sends connection_ack."""
        if not isinstance(context, MutableMapping):
            _log.warning("Rejected extension WebSocket: unsupported context type")
            raise ConnectionRejectionError()

        params = context.get("connection_params")
        token = params.get("token") if isinstance(params, MutableMapping) else None
        if not isinstance(token, str) or not token:
            _log.warning("Rejected extension WebSocket: missing connection token")
            raise ConnectionRejectionError()

        # Do not log or echo the raw token. A None result means invalid/revoked;
        # validator exceptions propagate as transient server failures (not 4403).
        user_id = await self.token_validator(token)
        if user_id is None:
            _log.warning("Rejected extension WebSocket: invalid or revoked token")
            raise ConnectionRejectionError()

        context["ext_user_id"] = user_id

        # Deliver any pending messages on connect (best-effort push).
        pending = take_pending_messages(user_id)
        if pending:
            context["pending_messages"] = pending

        return await super().on_ws_connect(context)
