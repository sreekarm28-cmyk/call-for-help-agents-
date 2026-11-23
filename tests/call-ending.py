"""Verify the installed end-call tool closes the session and deletes the SIP room.

Uses SDK code with fake session/job objects; no model request or phone call is made.
"""

import asyncio
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "LiveKit-Vobiz-Outbound"))
from call_ending import booking_end_call_tool


async def check() -> None:
    tool = booking_end_call_tool()
    speech = Mock()
    session = Mock()
    session.current_agent._get_activity_or_raise.return_value = SimpleNamespace(
        llm=None, realtime_llm_session=None,
    )
    ctx = SimpleNamespace(session=session, speech_handle=speech)
    job = SimpleNamespace(delete_room=AsyncMock(), add_shutdown_callback=Mock(), shutdown=Mock())

    goodbye = await tool._end_call(ctx)
    assert "one short" in goodbye and "current language" in goodbye
    session.shutdown.assert_not_called()  # Do not cut off the final speech.
    speech.add_done_callback.call_args.args[0](speech)
    session.shutdown.assert_called_once()

    event_name, on_close = session.once.call_args.args
    assert event_name == "close"
    with patch("livekit.agents.beta.tools.end_call.get_job_context", return_value=job):
        on_close(SimpleNamespace(reason=SimpleNamespace(value="user_initiated")))
    job.shutdown.assert_called_once()
    await job.add_shutdown_callback.call_args.args[0]()
    job.delete_room.assert_awaited_once()  # Disconnects the SIP phone participant.


asyncio.run(check())
print("PASS end-call tool waits for speech, closes the session, and deletes the SIP room.")
