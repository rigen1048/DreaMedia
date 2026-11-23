"""Yt media config: Hardcoded policy values + Model shapes for THIS media.

The shared cross-media fetch contract (Video/FetchPayload — every media's
fetcher returns it) lives at the backend root in Model/; only Yt-specific
config belongs here. Nothing in this package may be imported by another
media or by the cross-media layers.
"""
