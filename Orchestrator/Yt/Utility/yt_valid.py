from yt_dlp import YoutubeDL

def channel_exists():
    pass

def playlist_exists():
    pass

def video_exists(video_id: str) -> bool:
    """
    Returns True if the YouTube video exists and is accessible.
    """
    # Convert ID to URL if needed
    if not video_id.startswith(("http", "www")):
        url = f"https://www.youtube.com/watch?v={video_id}"
    else:
        url = video_id

    ydl_opts = {
        "quiet": True,
        "skip_download": True,
        "no_warnings": True,
        # Privacy & realistic browser headers
        "http_headers": {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Sec-Fetch-User": "?1",
        },
        # Network settings good for VPNs
        "socket_timeout": 20,
        "retries": 2,
        "extractor_retries": 2,
    }

    try:
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)

            # Video exists if we got basic info without error
            if info and info.get("id") and info.get("title"):
                return True
            return False

    except Exception:
        # Any error (video deleted, private, unavailable, etc.) = does not exist / inaccessible
        return False


if __name__ == "__main__":
    video_id = "__fmDj0ZJ1Q"
    exists = video_exists(video_id)
    print(f"Video exists: {exists}")
