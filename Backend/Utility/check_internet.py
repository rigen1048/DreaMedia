import asyncio
import socket


def has_internet() -> bool:
    """Quick socket-level connectivity check."""
    try:
        socket.create_connection(("1.1.1.1", 53), timeout=3)
        return True
    except (OSError, socket.timeout):
        return False


async def wait_for_internet(check_interval: float = 5.0) -> None:
    """Async-block until connectivity returns. Never drops the task (D5)."""
    while not has_internet():
        await asyncio.sleep(check_interval)


async def wait_for_internet_bounded(max_seconds: float, check_interval: float = 5.0) -> bool:
    """Wait up to max_seconds for connectivity. False on timeout.

    The pipelines use this so an outage becomes a 'We cannot access the
    internet' alert (D60) instead of a silently swallowed forever-wait.
    """
    loop = asyncio.get_event_loop()
    deadline = loop.time() + max_seconds
    while not has_internet():
        if loop.time() >= deadline:
            return False
        await asyncio.sleep(check_interval)
    return True
