import httpx

def send_notification(message: str) -> httpx.Response:
    """
    Send a critical notification to http://0.0.0.0:8000/notification (Front end)

    Args:
        message: The notification message string.

    Returns:
        The httpx Response object.
    """
    url = "http://0.0.0.0:8000/notification"
    payload = {"critical": message}

    with httpx.Client() as client:
        response = client.post(url, json=payload)
        response.raise_for_status()  # optional: raise on 4xx/5xx
        return response
