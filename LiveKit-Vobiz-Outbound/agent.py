"""Place outbound calls over a Vobiz SIP trunk with a LiveKit voice agent."""

import asyncio
import json
import logging
import os
import re
import sys
from pathlib import Path

from dotenv import load_dotenv
from google.protobuf.duration_pb2 import Duration

from livekit import api
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    cli,
)
from livekit.agents.llm import ChatMessage
from livekit.plugins import google
from livekit.protocol import sip as sip_protocol
from transcript_store import save_transcript, transcript_settings
from call_language import language_instruction
from call_backend import failed_dial_status, load_context, save_outcome, test_phone_number
from call_prompt import booking_instructions
from call_ending import booking_end_call_tool

load_dotenv(Path(__file__).resolve().parent / ".env.local")

logger = logging.getLogger("vobiz-outbound")

# Must match AGENT_NAME in make_call.py.
AGENT_NAME = "outbound-caller"
PARTICIPANT_IDENTITY = "phone-user"
RINGING_TIMEOUT_SECONDS = 45


class OutboundAssistant(Agent):
    def __init__(self, language: str = "en", context: dict | None = None) -> None:
        super().__init__(
            instructions=booking_instructions(context, language) if context else """You are Helpfully's AI assistant running a practice call.
The person answering is role-playing a plumber. Introduce yourself and say this is a test.
The sample customer has a leaking kitchen tap in Indiranagar, Bengaluru.
They prefer tomorrow afternoon and can pay up to ₹500 for the visit.
The sample listing shows a 4.5-out-of-5 rating from 20 reviews. Treat these as sample values.

Ask one short question at a time. Ask for the visit fee and what it covers.
Explain that the repair fee can be decided on site after inspection. Ask whether
any repair estimate they volunteer is separate from the visit fee and what it excludes.
Ask for the earliest date and time they can visit. If asked for the budget, answer directly.
Read back the exact fee and visit time and ask the plumber to confirm or correct them.
Ask whether the listing rating and review count match what they know. If they give
different numbers, repeat the new rating and count and ask whether you heard correctly.
If they volunteer a contact number, read it back digit by digit. If anything is unclear,
ask once and acknowledge what is still unknown. Never guess or claim independent verification.

Acknowledge corrections and use the corrected values. Keep replies brief and natural.
Collect details for the test. Do not book a visit or make any commitment.
When the person is finished, thank them and end the call.""" + "\n\n" + language_instruction(language),
            tools=[booking_end_call_tool()],
        )


server = AgentServer()


@server.rtc_session(agent_name=AGENT_NAME)
async def entrypoint(ctx: JobContext) -> None:
    ctx.log_context_fields = {"room": ctx.room.name}

    # make_call.py puts the call details in the dispatch metadata.
    metadata = json.loads(ctx.job.metadata)
    attempt_id = metadata.get("call_attempt_id")
    if attempt_id is None:
        raise ValueError("A database call attempt is required to enforce the account call limit")
    if attempt_id is not None and not re.fullmatch(r"[1-9][0-9]{0,18}", str(attempt_id)):
        raise ValueError("Invalid call attempt ID")
    settings = transcript_settings() if attempt_id is not None else None
    language = metadata.get("preferred_language", "en")
    context = None
    destination = test_phone_number()
    if settings is not None:
        try:
            context = await asyncio.to_thread(load_context, settings, str(attempt_id))
        except Exception:
            await asyncio.to_thread(save_outcome, settings, str(attempt_id), "failed")
            raise
        language = context["preferredLanguage"]
        destination = context["phoneNumber"]

    session: AgentSession = AgentSession(
        llm=google.realtime.RealtimeModel(
            model="gemini-3.1-flash-live-preview",
            api_version="v1beta",
            voice="Puck",
        ),
    )
    transcript: list[str] = []
    turn_counts = {"user": 0, "assistant": 0}

    @session.on("conversation_item_added")
    def capture_turn(event) -> None:
        item = event.item
        if not isinstance(item, ChatMessage) or item.role not in ("user", "assistant"):
            return
        if item.text_content and item.text_content.strip():
            speaker = "You" if item.role == "user" else "Agent"
            suffix = " [interrupted]" if item.interrupted else ""
            transcript.append(f"{speaker}: {item.text_content.strip()}{suffix}")
            turn_counts[item.role] += 1
            logger.info(
                "transcript turns captured: You=%d Agent=%d",
                turn_counts["user"],
                turn_counts["assistant"],
            )

    transcript_printed = False
    empty_outcome = "failed"
    save_task: asyncio.Task[None] | None = None

    async def persist(text: str) -> None:
        if settings is None or attempt_id is None:
            return
        try:
            await asyncio.to_thread(save_transcript, settings, str(attempt_id), text)
            logger.info("Transcript saved for call attempt %s", attempt_id)
        except Exception:
            logger.exception("Could not save transcript for call attempt %s", attempt_id)

    async def persist_empty_outcome() -> None:
        try:
            if settings is not None:
                await asyncio.to_thread(save_outcome, settings, str(attempt_id), empty_outcome)
                logger.info("Empty call saved as %s for call attempt %s", empty_outcome, attempt_id)
        except Exception:
            logger.exception("Could not save empty-call outcome for call attempt %s", attempt_id)

    def print_transcript() -> None:
        nonlocal transcript_printed, save_task
        if transcript_printed:
            return
        transcript_printed = True
        if transcript:
            text = "\n".join(transcript)
            if settings:
                save_task = asyncio.create_task(persist(text))
            else:
                print("\nCall transcript\n" + text, flush=True)
        else:
            print("\nCall transcript: no conversation text captured.", flush=True)

    @session.on("close")
    def on_session_close(_event) -> None:
        print_transcript()

    loop = asyncio.get_running_loop()

    def finish_disconnected_call() -> None:
        nonlocal save_task
        print_transcript()
        if not transcript and save_task is None:
            # The phone participant has left, so record the unknown outcome even
            # if SDK session shutdown stalls. Silence must not trigger the backup.
            save_task = asyncio.create_task(persist_empty_outcome())

    @ctx.room.on("participant_disconnected")
    def on_participant_disconnected(participant) -> None:
        if participant.identity == PARTICIPANT_IDENTITY:
            # Allow final turns to arrive if session teardown stalls after hangup.
            loop.call_later(3, finish_disconnected_call)

    async def hangup() -> None:
        print_transcript()
        try:
            # Deleting the room ends the phone call for the SIP participant.
            await ctx.api.room.delete_room(api.DeleteRoomRequest(room=ctx.room.name))
        finally:
            if save_task:
                await save_task
            elif settings is not None:
                # A connected call without a transcript has an unknown outcome;
                # never treat it as unanswered and risk booking the backup too.
                await persist_empty_outcome()

    ctx.add_shutdown_callback(hangup)

    # Start the session first so none of the callee's audio is lost after they answer.
    await session.start(agent=OutboundAssistant(language, context), room=ctx.room)
    if not session.room_io:
        raise RuntimeError("room_io is unavailable, use the dev or start command")
    session.room_io.set_participant(PARTICIPANT_IDENTITY)

    try:
        await ctx.api.sip.create_sip_participant(
            api.CreateSIPParticipantRequest(
                room_name=ctx.room.name,
                sip_trunk_id=os.environ["SIP_OUTBOUND_TRUNK_ID"],
                sip_call_to=destination,
                sip_number=metadata.get("from_number", ""),
                participant_identity=PARTICIPANT_IDENTITY,
                headers=metadata.get("sip_headers", {}),
                include_headers=sip_protocol.SIP_X_HEADERS,
                krisp_enabled=True,
                ringing_timeout=Duration(seconds=RINGING_TIMEOUT_SECONDS),
                wait_until_answered=True,
                media=sip_protocol.SIPMediaConfig(
                    only_listed_codecs=True,
                    codecs=[sip_protocol.SIPCodec(name="PCMU")],
                ),
            )
        )
    except api.TwirpError as e:
        # Covers rejected calls and calls that ring out without an answer.
        logger.warning(f"call did not connect: {e.message}")
        empty_outcome = failed_dial_status(e.metadata)
        if settings is not None:
            await asyncio.to_thread(save_outcome, settings, str(attempt_id), empty_outcome)
        ctx.shutdown("call did not connect")
        return

    # sip.callIDFull identifies this call in the Vobiz CDR, so log it to join the two records.
    callee = ctx.room.remote_participants.get(PARTICIPANT_IDENTITY)
    call_id = callee.attributes.get("sip.callIDFull") if callee else None
    logger.info("call answered", extra={"sip_call_id": call_id})

    # The agent waits for the callee to say hello. To speak first, call session.generate_reply().


if __name__ == "__main__":
    sys.stdout.reconfigure(errors="backslashreplace")
    cli.run_app(server)
