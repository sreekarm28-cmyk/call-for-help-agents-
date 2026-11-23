"""Exercise test routing and database prompt construction without placing a call."""

from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "LiveKit-Vobiz-Outbound"))
from call_backend import failed_dial_status, load_context, test_phone_number
from call_prompt import booking_instructions

context = {
    "testCall": True, "phoneNumber": "+919999900001", "status": "calling",
    "preferredLanguage": "te",
    "request": {"service": "electrician", "description": "Kitchen socket sparks",
                "maxVisitFee": "650.00", "preferredDate": "2026-11-22", "address": None},
    "provider": {"name": "Test Electrical Services", "rating": 4.5},
}
with patch.dict("os.environ", {"TEST_PHONE_NUMBER": "+919999900001"}), \
        patch("call_backend.dotenv_values", return_value={}), \
        patch("call_backend.backend_request", return_value=context):
    assert test_phone_number() == "+919999900001"
    loaded = load_context(("http://test", "token"), "42")
    prompt = booking_instructions(loaded, "te")
    assert "Kitchen socket sparks" in prompt and "650.00" in prompt and "Telugu" in prompt
    assert "leaking kitchen tap" not in prompt
    context["callPurpose"] = "confirmation"
    context["confirmation"] = {
        "bookingId": "7", "visitDate": "2026-11-22", "visitTime": "10:00",
        "visitFee": "300.00", "repairCostNotes": "Repair price decided on site.",
    }
    confirmation = booking_instructions(context, "te")
    assert "test confirmation call" in confirmation
    assert "300.00" in confirmation and "10:00" in confirmation
    assert "Do not collect a fresh offer" in confirmation
    assert "call end_call" in confirmation
    assert "Do not mention or call the backup" in confirmation
    context["phoneNumber"] = "+919999900099"
    try:
        load_context(("http://test", "token"), "42")
    except RuntimeError:
        pass
    else:
        raise AssertionError("A vendor destination must be rejected")
print("PASS database context reaches the voice prompt and vendor-number routing is rejected.")
print("PASS confirmation calls use the selected terms and a separate acceptance prompt.")
assert failed_dial_status({"sip_status_code": "486"}) == "no_answer"
assert failed_dial_status({"sip_status_code": 408}) == "no_answer"
assert failed_dial_status({"sip_status_code": "603"}) == "rejected"
assert failed_dial_status({"sip_status_code": "503"}) == "failed"
assert failed_dial_status({}) == "failed"
print("PASS infrastructure failures cannot be mistaken for an unanswered call and trigger backup.")
