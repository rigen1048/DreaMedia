"""Client-side probe mirroring Extension/shared/background.js.

Start qa/ws_test_server.py first, then run from the repository root:
    cd Backend
    uv run python ../qa/ws_extension_probe.py --duration 45 --ping-interval 20

The defaults target only the loopback test server. The probe sends no browser
cookies or production credentials; it uses the fake dm_ token configured for
the isolated test server. Use --duration 0 for a quick handshake/reconnect run.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
from typing import Any

try:
    from websockets.asyncio.client import connect
except ImportError:  # Compatibility with the older websockets bundled by Uvicorn.
    from websockets.legacy.client import connect
from websockets.exceptions import ConnectionClosed

DEFAULT_TOKEN = os.environ.get(
    "DREAMEDIA_WS_TEST_TOKEN", "dm_local_test_token_not_for_production"
)
DEFAULT_ORIGIN = "chrome-extension://iemcebbhpkagkchbdcfbbomcnjiodlhe"


def close_code(error: ConnectionClosed) -> int | None:
    received = getattr(error, "rcvd", None)
    return getattr(received, "code", getattr(error, "code", None))


def encode(message: dict[str, Any]) -> str:
    return json.dumps(message, separators=(",", ":"))


async def receive_message(websocket: Any, timeout: float) -> dict[str, Any]:
    while True:
        raw = await asyncio.wait_for(websocket.recv(), timeout=timeout)
        message = json.loads(raw)
        if message.get("type") == "ping":
            pong: dict[str, Any] = {"type": "pong"}
            if "payload" in message:
                pong["payload"] = message["payload"]
            await websocket.send(encode(pong))
            continue
        return message


async def probe_connection(args: argparse.Namespace, duration: float) -> None:
    async with connect(
        args.url,
        origin=args.origin,
        subprotocols=["graphql-transport-ws"],
        open_timeout=args.timeout,
        close_timeout=args.timeout,
        ping_interval=None,
    ) as websocket:
        if websocket.subprotocol != "graphql-transport-ws":
            raise RuntimeError(f"Unexpected negotiated subprotocol: {websocket.subprotocol!r}")

        await websocket.send(encode({"type": "connection_init", "payload": {"token": args.token}}))
        ack = await receive_message(websocket, args.timeout)
        if ack.get("type") != "connection_ack":
            raise RuntimeError(f"Expected connection_ack, received {ack!r}")

        operation_id = "probe"
        await websocket.send(encode({
            "id": operation_id,
            "type": "subscribe",
            "payload": {"query": "query { extPing }", "variables": {}},
        }))
        result = await receive_message(websocket, args.timeout)
        if (
            result.get("id") != operation_id
            or result.get("type") != "next"
            or result.get("payload", {}).get("data", {}).get("extPing") is not True
            or result.get("payload", {}).get("errors")
        ):
            raise RuntimeError(f"Authenticated extPing failed: {result!r}")
        complete = await receive_message(websocket, args.timeout)
        if complete.get("id") != operation_id or complete.get("type") != "complete":
            raise RuntimeError(f"Expected operation complete, received {complete!r}")

        deadline = time.monotonic() + duration
        next_ping = time.monotonic() + args.ping_interval
        ping_count = 0
        while next_ping <= deadline:
            await asyncio.sleep(max(0, next_ping - time.monotonic()))
            await websocket.send(encode({"type": "ping"}))
            pong = await receive_message(websocket, args.timeout)
            if pong.get("type") != "pong":
                raise RuntimeError(f"Expected matching pong, received {pong!r}")
            ping_count += 1
            print(f"PASS heartbeat {ping_count}: GraphQL ping/pong round-trip")
            next_ping += args.ping_interval
        await asyncio.sleep(max(0, deadline - time.monotonic()))

        print(
            f"PASS authenticated connection ({args.origin}), extPing=true, "
            f"{ping_count} heartbeat(s), duration={duration:g}s"
        )


async def probe_invalid_token(args: argparse.Namespace) -> None:
    async with connect(
        args.url,
        origin=args.origin,
        subprotocols=["graphql-transport-ws"],
        open_timeout=args.timeout,
        close_timeout=args.timeout,
        ping_interval=None,
    ) as websocket:
        await websocket.send(encode({
            "type": "connection_init",
            "payload": {"token": "dm_invalid_probe_token"},
        }))
        try:
            message = await asyncio.wait_for(websocket.recv(), timeout=args.timeout)
        except ConnectionClosed as error:
            code = close_code(error)
            if code != 4403:
                raise RuntimeError(f"Invalid token closed with {code}, expected 4403") from error
            print("PASS invalid token rejected before connection_ack (close code 4403)")
            return
        raise RuntimeError(f"Invalid token unexpectedly received {message!r}")


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="ws://127.0.0.1:8765/ext/graphql")
    parser.add_argument("--origin", default=DEFAULT_ORIGIN)
    parser.add_argument("--token", default=DEFAULT_TOKEN)
    parser.add_argument("--duration", type=float, default=45.0,
                        help="how long to keep the authenticated socket open (default: 45s)")
    parser.add_argument("--ping-interval", type=float, default=20.0,
                        help="GraphQL heartbeat interval (default: 20s)")
    parser.add_argument("--timeout", type=float, default=10.0)
    args = parser.parse_args()
    if args.duration < 0 or args.ping_interval <= 0 or args.timeout <= 0:
        parser.error("duration must be >= 0; ping-interval and timeout must be > 0")

    await probe_connection(args, args.duration)
    # Open a fresh authenticated socket to verify the client can reconnect.
    await probe_connection(args, 0)
    print("PASS fresh authenticated reconnect")
    await probe_invalid_token(args)


if __name__ == "__main__":
    asyncio.run(main())
