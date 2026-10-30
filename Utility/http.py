"""HTTP client factories. HTTP/2 enforced everywhere (D12).

- get_async_client: shared async client for direct API/RSS calls.
- get_ydl_opts: yt-dlp options carrying privacy headers + consent cookies.
"""
from __future__ import annotations

import random
from contextlib import asynccontextmanager
from typing import Any, AsyncGenerator, Dict, Optional

import httpx

from Utility.logs import log

# ==================== CONFIG - EASY TO BUMP ====================
CHROME_VERSION = "136"
FIREFOX_VERSION = "131"
_WINDOWS = "Windows NT 10.0"
_MAC = "Macintosh; Intel Mac OS X 10_15_7"
_LINUX = "X11; Linux x86_64"
# ===============================================================

_USER_AGENTS = [
    f"Mozilla/5.0 ({_WINDOWS}; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{CHROME_VERSION}.0.0.0 Safari/537.36",
    f"Mozilla/5.0 ({_WINDOWS}; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{CHROME_VERSION}.0.0.0 Safari/537.36 Edg/{CHROME_VERSION}.0.0",
    f"Mozilla/5.0 ({_MAC}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{CHROME_VERSION}.0.0.0 Safari/537.36",
    f"Mozilla/5.0 ({_LINUX}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{CHROME_VERSION}.0.0.0 Safari/537.36",
    f"Mozilla/5.0 ({_WINDOWS}; Win64; x64; rv:{FIREFOX_VERSION}.0) Gecko/20100101 Firefox/{FIREFOX_VERSION}.0",
]

_ACCEPT_LANGUAGES = ["en-US,en;q=0.9", "en-US,en;q=0.8", "en-GB,en;q=0.9"]


def get_privacy_headers() -> Dict[str, str]:
    """Realistic rotating browser headers to reduce fingerprinting."""
    return {
        "User-Agent": random.choice(_USER_AGENTS),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": random.choice(_ACCEPT_LANGUAGES),
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


@asynccontextmanager
async def get_async_client(
    *,
    timeout: float = 30.0,
) -> AsyncGenerator[httpx.AsyncClient, None]:
    """HTTP/2 async client with privacy headers. One per call site for now;
    pooling across requests is a deliberate future optimization."""
    async with httpx.AsyncClient(
        http2=True,
        headers=get_privacy_headers(),
        timeout=timeout,
        follow_redirects=True,
    ) as client:
        yield client


def _fetch_fresh_consent_cookies(timeout: float = 10.0) -> Dict[str, str]:
    """Fetch fresh YouTube consent cookies by simulating a clean visit."""
    cookies: Dict[str, str] = {}
    try:
        with httpx.Client(
            http2=True,
            headers=get_privacy_headers(),
            timeout=httpx.Timeout(timeout),
            follow_redirects=True,
        ) as temp_client:
            resp = temp_client.get("https://www.youtube.com")
            for name in ["CONSENT", "SOCS", "VISITOR_PRIVACY_METADATA"]:
                if name in resp.cookies:
                    cookies[name] = resp.cookies[name]
                elif name in temp_client.cookies:
                    cookies[name] = temp_client.cookies[name]
    except Exception as e:
        log.warning("Failed to fetch consent cookies (%s); using fallbacks", e)
    return cookies


def get_ydl_opts(proxy: Optional[str] = None, timeout: float = 30.0) -> Dict[str, Any]:
    """yt-dlp options: privacy headers + fresh YouTube consent cookies."""
    headers = get_privacy_headers()
    cookies = _fetch_fresh_consent_cookies(timeout=10.0)

    consent = cookies.get("CONSENT", "YES+1")
    socs = cookies.get(
        "SOCS", "CAESHAgBEhJnd3NfMjAyNDAyMjctMF9SQzEaAmVuIAEaBgiA2v6bBg"
    )
    vpm = cookies.get("VISITOR_PRIVACY_METADATA", "CgJCRBIEGgAgSQ%3D%3D")
    headers["Cookie"] = f"CONSENT={consent}; SOCS={socs}; VISITOR_PRIVACY_METADATA={vpm}"

    opts: Dict[str, Any] = {
        "quiet": True,
        "extract_flat": True,
        "playlistreverse": True,  # newest first
        "ignoreerrors": True,
        "no_warnings": True,
        "socket_timeout": timeout,
        "http_headers": headers,
    }
    if proxy:
        opts["proxy"] = proxy
    return opts
