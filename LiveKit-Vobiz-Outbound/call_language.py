"""Resolve the call language and build the voice agent's language instruction."""

import json
from pathlib import Path
from urllib.request import Request, urlopen

LANGUAGES = json.loads(
    (Path(__file__).resolve().parent.parent / "config" / "call-languages.json").read_text(encoding="utf-8")
)["languages"]


def language_instruction(code: str) -> str:
    if code not in LANGUAGES:
        raise ValueError("Unsupported call language")
    telugu_style = (
        "For Telugu, sound like a local person on a phone call, for example: "
        "'విజిట్ ఫీ ఎంత ఉంటుంది?' or 'రేపు ఏ టైమ్‌కి రాగలరు?' "
        if code == "te" else ""
    )
    return (
        f"Speak {LANGUAGES[code]} from your first greeting and throughout the conversation. "
        "Deliver the introduction and questions in that language even though these instructions are written in English. "
        "Use everyday spoken language, not formal, literary, or textbook wording. "
        "Naturally use familiar English service words such as visit, repair, fee, time, and booking; "
        "do not force translations or repeat the same sentence in both languages. "
        + telugu_style +
        "This is a suggested language based on the service area. "
        "If the person asks for another language, switch to it. "
        "Keep names, phone numbers, prices, and appointment times accurate when switching languages."
    )


def load_call_language(settings: tuple[str, str], attempt_id: str) -> str:
    base_url, token = settings
    request = Request(
        f"{base_url}/api/internal/call-attempts/{attempt_id}/language",
        headers={"Authorization": f"Bearer {token}"},
    )
    with urlopen(request, timeout=5) as response:
        code = json.load(response)["preferredLanguage"]
    if code not in LANGUAGES:
        raise ValueError("Backend returned an unsupported call language")
    return code
