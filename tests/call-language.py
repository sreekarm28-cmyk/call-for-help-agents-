"""Check call-language retrieval and instructions without starting the voice agent."""

import io
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "LiveKit-Vobiz-Outbound"))
from call_language import language_instruction, load_call_language


with patch("call_language.urlopen", return_value=io.StringIO('{"preferredLanguage":"te"}')) as lookup:
    language = load_call_language(("http://127.0.0.1:3001", "test-token"), "42")
    assert language == "te"
    request = lookup.call_args.args[0]
    assert request.full_url == "http://127.0.0.1:3001/api/internal/call-attempts/42/language"
    assert request.get_header("Authorization") == "Bearer test-token"
    assert "Telugu" in language_instruction(language)
    assert "switch" in language_instruction(language)

try:
    language_instruction("unsupported")
except ValueError:
    pass
else:
    raise AssertionError("Unsupported language must be rejected")

print("PASS linked calls load the authenticated language and apply safe voice instructions.")
