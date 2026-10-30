from typing import Any, Dict, List, Tuple
from returns.result import Result, Success, Failure


def filter_words(
    videos: Tuple[Dict[int, Dict[str, Any]]],
    words: List[str],
) -> Result[Tuple[Dict[int, Dict[str, Any]]], str]:
    """
    Keep only the videos whose title contains any of the given words
    (case-insensitive, substring match).

    Returns
    -------
    Success( (filtered_dict,) )
    Failure("Not Found")
    """
    if not words or not videos or not videos[0]:
        return Failure("Not Found")

    videos_dict = videos[0]
    lower_words = [w.lower() for w in words]

    filtered: Dict[int, Dict[str, Any]] = {}
    new_idx = 1

    for video in videos_dict.values():
        title = str(video.get("title", "")).lower()
        if any(word in title for word in lower_words):
            filtered[new_idx] = video
            new_idx += 1

    if not filtered:
        return Failure("Not Found")

    return Success((filtered,))
