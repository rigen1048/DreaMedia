import logging
from typing import Optional, Dict
import httpx
from Model.http import get_privacy_headers

from contextlib import asynccontextmanager
from collections.abc import AsyncGenerator

logger = logging.getLogger(__name__)


def _fetch_fresh_consent_cookies(
    proxy: Optional[str] = None,
    timeout: float = 10.0,
) -> Dict[str, str]:
    """Fetch fresh YouTube consent cookies by simulating a clean visit."""
    headers = get_privacy_headers()
    cookies = {}

    try:
        with httpx.Client(
            http2=True,
            headers=headers,
            timeout=httpx.Timeout(timeout),
            follow_redirects=True,
            proxy=proxy,
        ) as temp_client:
            # Visit YouTube homepage to trigger consent cookies
            resp = temp_client.get("https://www.youtube.com")

            # Extract relevant consent cookies that YouTube set
            for name in ["CONSENT", "SOCS", "VISITOR_PRIVACY_METADATA"]:
                if name in resp.cookies:
                    cookies[name] = resp.cookies[name]
                elif name in temp_client.cookies:
                    cookies[name] = temp_client.cookies[name]

            if cookies:
                logger.info(f"✅ Fetched fresh consent cookies: {list(cookies.keys())}")
            else:
                logger.warning("⚠️ No consent cookies found, using fallback values.")

    except Exception as e:
        logger.warning(f"Failed to fetch fresh consent cookies: {e}. Using fallbacks.")

    return cookies


def get_production_client(
    proxy: Optional[str] = None,
    timeout: float = 30.0,
    apply_youtube_consent: bool = True,
):
    """
    Returns a ready-to-use HTTP/2 client.
    Set apply_youtube_consent=True to automatically add YouTube consent cookies.
    """
    headers = get_privacy_headers()

    logger.info("Initializing production HTTP/2 client...")

    client = httpx.Client(
        http2=True,
        headers=headers,
        timeout=httpx.Timeout(timeout),
        follow_redirects=True,
        # proxies=proxy,
    )

    # YouTube consent bypass (centralized in privacy master)
    if apply_youtube_consent:
        logger.info("Fetching fresh YouTube consent cookies...")
        fresh_cookies = _fetch_fresh_consent_cookies(proxy=proxy, timeout=10.0)

        # Apply fetched cookies (with safe fallbacks)
        if "CONSENT" in fresh_cookies:
            client.cookies.set("CONSENT", fresh_cookies["CONSENT"], domain=".youtube.com")
        else:
            client.cookies.set("CONSENT", "YES+1", domain=".youtube.com")

        if "SOCS" in fresh_cookies:
            client.cookies.set("SOCS", fresh_cookies["SOCS"], domain=".youtube.com")
        else:
            # Fallback (still works in many cases)
            client.cookies.set(
                "SOCS",
                "CAESHAgBEhJnd3NfMjAyNDAyMjctMF9SQzEaAmVuIAEaBgiA2v6bBg",
                domain=".youtube.com",
            )

        if "VISITOR_PRIVACY_METADATA" in fresh_cookies:
            client.cookies.set(
                "VISITOR_PRIVACY_METADATA", fresh_cookies["VISITOR_PRIVACY_METADATA"], domain=".youtube.com"
            )
        else:
            client.cookies.set(
                "VISITOR_PRIVACY_METADATA",
                "CgJCRBIEGgAgSQ%3D%3D",
                domain=".youtube.com",
            )

    logger.info(f"Production client ready (HTTP/2, {len(headers)} privacy headers)")
    return client

@asynccontextmanager
async def get_http_client(
    *,
    http2: bool = True,
    timeout: float = 30.0,
    follow_redirects: bool = True,
) -> AsyncGenerator[httpx.AsyncClient, None]:
    async with httpx.AsyncClient(
        http2=http2,
        timeout=timeout,
        follow_redirects=follow_redirects,
    ) as client:
        yield client


def get_ydl_opts(
    proxy: Optional[str] = None,
    timeout: float = 30.0,
) -> Dict[str, Any]:
    """
    Build a ready-to-use yt-dlp options dict.
    Uses get_production_client() which is strictly HTTP/2.
    Privacy headers + fresh consent cookies are applied automatically.
    """
    # get_production_client already forces http2=True
    client = get_production_client(
        proxy=proxy,
        timeout=timeout,
        apply_youtube_consent=True,
    )

    try:
        headers = dict(client.headers)

        # Build Cookie header from consent cookies
        cookie_parts = [f"{name}={value}" for name, value in client.cookies.items()]
        if cookie_parts:
            headers["Cookie"] = "; ".join(cookie_parts)

        ydl_opts: Dict[str, Any] = {
            "quiet": True,
            "extract_flat": True,
            "playlistreverse": True,          # Newest first
            "ignoreerrors": True,
            "no_warnings": True,
            "http_headers": headers,
        }

        if proxy:
            ydl_opts["proxy"] = proxy

        logger.info(
            "yt-dlp options prepared (HTTP/2 client → privacy headers + consent cookies)"
        )
        return ydl_opts

    finally:
        client.close()
