"""Read database call context and route all practice calls to the test number."""

import json
import os
import re
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from dotenv import dotenv_values


def test_phone_number() -> str:
    root = dotenv_values(Path(__file__).resolve().parent.parent / ".env")
    phone = (root.get("TEST_PHONE_NUMBER") or os.getenv("TEST_PHONE_NUMBER") or "").strip()
    if not re.fullmatch(r"\+[1-9]\d{6,14}", phone):
        raise RuntimeError("Set TEST_PHONE_NUMBER in E.164 format before testing")
    return phone


def backend_request(settings: tuple[str, str], path: str, body: dict | None = None):
    base_url, token = settings
    request = Request(
        base_url + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urlopen(request, timeout=30) as response:
        return json.load(response) if response.status != 204 else None


def claim_call(settings: tuple[str, str], attempt_id: int | None = None):
    return backend_request(settings, "/api/internal/test-calls/claim", {"callAttemptId": attempt_id})


def load_context(settings: tuple[str, str], attempt_id: str) -> dict:
    context = backend_request(settings, f"/api/internal/call-attempts/{attempt_id}/context")
    if context.get("testCall") is not True or context.get("phoneNumber") != test_phone_number():
        raise RuntimeError("Backend destination does not match TEST_PHONE_NUMBER")
    if context.get("status") != "calling":
        raise RuntimeError("The database call must be claimed before dialing")
    return context


def save_outcome(settings: tuple[str, str], attempt_id: str, status: str) -> None:
    try:
        backend_request(settings, f"/api/internal/call-attempts/{attempt_id}/outcome", {"status": status})
    except HTTPError as error:
        # A final transcript may already have been saved when the room closes.
        if error.code != 409:
            raise


def failed_dial_status(metadata: dict) -> str:
    """Only explicit SIP no-answer/busy/refusal results may trigger a backup."""
    code = str(metadata.get("sip_status_code", ""))
    if code == "603":
        return "rejected"  # The call was rejected; no conversation proved refusal of the job.
    return "no_answer" if code in {"408", "480", "486", "600"} else "failed"
