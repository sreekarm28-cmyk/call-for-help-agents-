"""Send a completed transcript to the application API."""

import json
import os
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from dotenv import dotenv_values


def transcript_settings() -> tuple[str, str]:
    app_env = dotenv_values(Path(__file__).resolve().parent.parent / ".env")
    token = (os.getenv("CALL_TRANSCRIPT_TOKEN") or app_env.get("CALL_TRANSCRIPT_TOKEN") or "").strip()
    base_url = os.getenv("CALL_TRANSCRIPT_API_URL") or f"http://127.0.0.1:{app_env.get('API_PORT') or '3001'}"
    if not token:
        raise RuntimeError("CALL_TRANSCRIPT_TOKEN is required to save a linked call")
    return base_url.rstrip("/"), token


def save_transcript(settings: tuple[str, str], attempt_id: str, transcript: str) -> None:
    base_url, token = settings
    request = Request(
        f"{base_url}/api/internal/call-attempts/{attempt_id}/transcript",
        data=json.dumps({"transcript": transcript}, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    for attempt in range(3):
        try:
            with urlopen(request, timeout=4):
                return
        except (URLError, TimeoutError) as error:
            if attempt == 2 or (isinstance(error, HTTPError) and error.code < 500):
                raise
            time.sleep(attempt + 1)
