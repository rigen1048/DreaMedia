from typing import Any, Dict, Optional, Tuple, Union
from returns.result import Result, Success, Failure

def filter_new_videos(
    videos: Tuple[Dict[int, Dict[str, Any]]],
    last_seen: Optional[str] = None,
) -> Result[Tuple[Dict[int, Dict[str, Any]]], Union[str, Tuple[str, Tuple[Dict[int, Dict[str, Any]]]]]]:
    """
    Return only videos newer than `last_seen`.
    Rules
    -----
    - last_seen is None or empty → Success(original tuple)
    - last_seen == latest video id → Failure("Same")
    - last_seen found in the dict → Success(only newer videos)
    - last_seen not found → Failure(("Not Found", full_videos))
    """
    if not videos or not isinstance(videos, tuple) or len(videos) == 0:
        return Failure("Not Found")
    videos_dict = videos[0]
    if not videos_dict or not isinstance(videos_dict, dict):
        return Failure("Not Found")
    if not last_seen:
        return Success(videos)
    latest_id = videos_dict.get(1, {}).get("id")
    if last_seen == latest_id:
        return Failure("Same")
    found_key: Optional[int] = None
    for key, video in videos_dict.items():
        if video.get("id") == last_seen:
            found_key = key
            break
    if found_key is None:
        return Failure(("Not Found", videos))  # failure + full result
    filtered = {
        key: video
        for key, video in videos_dict.items()
        if key < found_key
    }
    return Success((filtered,))
