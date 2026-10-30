import socket
import time

def has_internet() -> bool:
    """Checks if the system has an active internet connection using a simple socket check."""
    try:
        socket.create_connection(("1.1.1.1", 53), timeout=3)
        return True
    except (OSError, socket.timeout):
        return False

def wait_for_internet(check_interval: float = 5.0) -> None:
    """
    Block (pause the program) until an internet connection is available.
    Returns only when has_internet() becomes True.
    """
    while not has_internet():
        time.sleep(check_interval)
