import random
from typing import Dict

def get_privacy_headers() -> Dict[str, str]:
    """
    Returns realistic browser headers to reduce fingerprinting.
    Easy to maintain with version variables.
    """
    # ==================== CONFIG - EASY TO BUMP ====================
    CHROME_VERSION = "136"
    FIREFOX_VERSION = "131"
    WINDOWS_VERSION = (
        "Windows NT 10.0"  # Change to "Windows NT 10.0" (still used for Win11)
    )
    MAC_VERSION = "Macintosh; Intel Mac OS X 10_15_7"
    LINUX_VERSION = "X11; Linux x86_64"
    # ============================================================

    user_agents = [
        f"Mozilla/5.0 ({WINDOWS_VERSION}; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{CHROME_VERSION}.0.0.0 Safari/537.36",
        f"Mozilla/5.0 ({WINDOWS_VERSION}; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{CHROME_VERSION}.0.0.0 Safari/537.36 Edg/{CHROME_VERSION}.0.0",
        f"Mozilla/5.0 ({MAC_VERSION}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{CHROME_VERSION}.0.0.0 Safari/537.36",
        f"Mozilla/5.0 ({LINUX_VERSION}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{CHROME_VERSION}.0.0.0 Safari/537.36",
        f"Mozilla/5.0 ({WINDOWS_VERSION}; Win64; x64; rv:{FIREFOX_VERSION}.0) Gecko/20100101 Firefox/{FIREFOX_VERSION}.0",
    ]

    accept_languages = [
        "en-US,en;q=0.9",
        "en-US,en;q=0.8",
        "en-GB,en;q=0.9",
    ]

    return {
        "User-Agent": random.choice(user_agents),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": random.choice(accept_languages),
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "DNT": "1",
        "Sec-GPC": "1",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-User": "?1",
        "Sec-Fetch-Dest": "document",
        "Cache-Control": "max-age=0",
        "Upgrade-Insecure-Requests": "1",
        "Priority": "u=0, i",
    }
