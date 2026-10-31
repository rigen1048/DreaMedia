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
