import httpx
import pytest
from returns.result import Failure, Success

from Media.Yt.Fetch import yt_rss


ATOM = 'http://www.w3.org/2005/Atom'
YOUTUBE = 'http://www.youtube.com/xml/schemas/2015'
CHANNEL = "UC" + "a" * 22
VIDEO_ID = "video123"


def feed(body: str) -> str:
    return f'<feed xmlns="{ATOM}" xmlns:yt="{YOUTUBE}">{body}</feed>'


class FakeClient:
    def __init__(self, body):
        self.body = body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def get(self, url):
        return httpx.Response(
            200,
            text=self.body,
            headers={"content-type": "application/atom+xml"},
            request=httpx.Request("GET", url),
        )


def mock_feed(monkeypatch, body):
    monkeypatch.setattr(
        yt_rss,
        "get_async_client",
        lambda **kwargs: FakeClient(body),
    )


@pytest.mark.asyncio
async def test_http_200_valid_atom_feed_returns_video_payload(monkeypatch):
    body = feed(
        f"<entry><yt:videoId>{VIDEO_ID}</yt:videoId><title>Episode 1</title>"
        "<published>2026-11-22T00:00:00+00:00</published></entry>"
    )
    mock_feed(monkeypatch, body)

    result = await yt_rss.yt_rss(CHANNEL)

    assert isinstance(result, Success)
    video = result.unwrap()[0][1]
    assert video["id"] == VIDEO_ID
    assert video["title"] == "Episode 1"


@pytest.mark.asyncio
async def test_valid_empty_atom_feed_is_distinguished_from_invalid_response(monkeypatch):
    mock_feed(monkeypatch, feed("<title>Channel</title>"))

    result = await yt_rss.yt_rss(CHANNEL)

    assert isinstance(result, Failure)
    assert result.failure() == "Empty Feed"


@pytest.mark.parametrize(
    "body",
    [
        "<html><title>consent required</title></html>",
        "<feed><entry><title>Wrong namespace</title></entry></feed>",
        "<feed xmlns='http://www.w3.org/2005/Atom'><entry><title>Missing IDs</title></entry></feed>",
        "<feed xmlns='http://www.w3.org/2005/Atom'>",
    ],
)
@pytest.mark.asyncio
async def test_http_200_invalid_or_unusable_feed_is_not_reported_as_empty(monkeypatch, body):
    mock_feed(monkeypatch, body)

    result = await yt_rss.yt_rss(CHANNEL)

    assert isinstance(result, Failure)
    assert result.failure() == "Invalid Feed"
