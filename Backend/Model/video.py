"""Shared data shapes for the fetch pipeline.

Every fetcher, for every media, returns the same contract:
    Success((videos_dict,))  — 1-element tuple holding
    {1: {id, title, url, thumbnail, published}, 2: {...}, ...}
    sorted newest → oldest.

Filters and ts-processing consume only this shape — that uniformity is
what makes sources pluggable.
"""
from typing import Any, Dict, Optional, Tuple

from pydantic import BaseModel


class Video(BaseModel):
    id: str
    title: str
    url: str
    published: str
    thumbnail: Optional[str] = None


# The wire shape between fetchers, filters, and savers.
VideosDict = Dict[int, Dict[str, Any]]
FetchPayload = Tuple[VideosDict]
