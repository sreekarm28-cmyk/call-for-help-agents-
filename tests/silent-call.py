"""Simulate a silent callee disconnecting; no network request or phone call."""

import asyncio
import json
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "LiveKit-Vobiz-Outbound"))
import agent


async def check() -> None:
    session_events = {}
    room_events = {}

    def listen(events):
        def on(name):
            def register(callback):
                events[name] = callback
                return callback
            return register
        return on

    session = Mock()
    session.on.side_effect = listen(session_events)
    session.start = AsyncMock()
    room = Mock(name="room")
    room.name = "silent-call-test"
    room.on.side_effect = listen(room_events)
    room.remote_participants = {}
    ctx = SimpleNamespace(
        job=SimpleNamespace(metadata=json.dumps({"call_attempt_id": "6"})), room=room,
        api=SimpleNamespace(sip=SimpleNamespace(create_sip_participant=AsyncMock()),
                            room=SimpleNamespace(delete_room=AsyncMock())),
        add_shutdown_callback=Mock(), shutdown=Mock(),
    )
    context = {"phoneNumber": "+919999900001", "preferredLanguage": "te"}
    with patch.object(agent, "AgentSession", return_value=session), \
         patch.object(agent.google.realtime, "RealtimeModel"), \
         patch.object(agent, "OutboundAssistant"), \
         patch.object(agent, "transcript_settings", return_value=("http://test", "token")), \
         patch.object(agent, "test_phone_number", return_value=context["phoneNumber"]), \
         patch.object(agent, "load_context", return_value=context), \
         patch.object(agent, "save_outcome") as save, \
         patch.object(agent, "save_transcript") as transcript, \
         patch.dict("os.environ", {"SIP_OUTBOUND_TRUNK_ID": "test-trunk"}):
        await agent.entrypoint(ctx)
        session_events["close"](None)
        save.assert_not_called()  # Session closure alone does not prove the phone disconnected.
        participant = SimpleNamespace(identity="phone-user")
        room_events["participant_disconnected"](participant)
        room_events["participant_disconnected"](participant)
        deadline = asyncio.get_running_loop().time() + 5
        while not save.called and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.05)
        save.assert_called_once_with(("http://test", "token"), "6", "failed")
        transcript.assert_not_called()
        # Delayed SDK shutdown must not write the outcome twice.
        await ctx.add_shutdown_callback.call_args.args[0]()
        save.assert_called_once()


asyncio.run(check())
print("PASS silent disconnect saves an unknown outcome once even when SDK shutdown is delayed.")
