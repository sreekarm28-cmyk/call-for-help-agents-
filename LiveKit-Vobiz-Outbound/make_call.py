"""Dispatch the agent to place a call."""

import argparse
import asyncio
import json
import re
import secrets
from pathlib import Path

from dotenv import load_dotenv

from livekit import api
from call_language import LANGUAGES
from call_backend import claim_call, test_phone_number
from transcript_store import transcript_settings

load_dotenv(Path(__file__).resolve().parent / ".env.local")

AGENT_NAME = "outbound-caller"  # must match AGENT_NAME in agent.py
E164 = re.compile(r"\+[1-9]\d{6,14}")


def e164(value: str) -> str:
    value = value.strip()
    if not E164.fullmatch(value):
        raise argparse.ArgumentTypeError(f"{value!r} is not in E.164 format, like +919876543210")
    return value


def sip_header(value: str) -> tuple[str, str]:
    key, separator, header_value = value.partition("=")
    if not separator:
        raise argparse.ArgumentTypeError(f"{value!r} is not in KEY=VALUE format")
    if not key.startswith("X-VH-"):
        raise argparse.ArgumentTypeError(f"{key!r} must start with X-VH-, or Vobiz drops it")
    return key, header_value


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--to", type=e164, help="legacy argument; destination is always TEST_PHONE_NUMBER")
    parser.add_argument("--watch", action="store_true", help="dispatch queued database test calls one at a time")
    parser.add_argument("--call-attempt-id", type=int, help="database call attempt to save the transcript against")
    parser.add_argument("--language", choices=sorted(LANGUAGES), help="test call language; linked calls use the database language")
    parser.add_argument(
        "--from",
        dest="from_number",
        type=e164,
        help="caller ID, which must be a number on your trunk. Defaults to the trunk's number",
    )
    parser.add_argument(
        "--header",
        action="append",
        default=[],
        type=sip_header,
        metavar="X-VH-KEY=VALUE",
        help="custom SIP header for the INVITE. Can be repeated",
    )
    args = parser.parse_args()
    if not args.watch and args.call_attempt_id is None:
        parser.error("Use --watch or --call-attempt-id so the backend can enforce the account call limit")
    if args.call_attempt_id is not None and not 0 < args.call_attempt_id <= 9223372036854775807:
        parser.error("--call-attempt-id must be a positive database ID")

    metadata: dict[str, object] = {"phone_number": test_phone_number()}
    if args.call_attempt_id is not None:
        metadata["call_attempt_id"] = str(args.call_attempt_id)
    if args.language:
        metadata["preferred_language"] = args.language
    if args.from_number:
        metadata["from_number"] = args.from_number
    if args.header:
        metadata["sip_headers"] = dict(args.header)

    if args.watch and args.call_attempt_id is not None:
        parser.error("--watch and --call-attempt-id cannot be combined")
    if args.watch or args.call_attempt_id is not None:
        settings = transcript_settings()
        while True:
            claimed = await asyncio.to_thread(claim_call, settings, args.call_attempt_id)
            if claimed:
                linked = {**metadata, "call_attempt_id": str(claimed["callAttemptId"])}
                await dispatch(linked)
            elif not args.watch:
                print("The call is unavailable, or another test call is still active.")
            if not args.watch:
                return
            await asyncio.sleep(2)
    else:
        await dispatch(metadata)


async def dispatch(metadata: dict[str, object]) -> None:
    # Reapply the override immediately before sending any metadata to LiveKit.
    metadata["phone_number"] = test_phone_number()
    lkapi = api.LiveKitAPI()
    try:
        result = await lkapi.agent_dispatch.create_dispatch(
            api.CreateAgentDispatchRequest(
                agent_name=AGENT_NAME,
                room=f"call-{secrets.token_hex(4)}",
                metadata=json.dumps(metadata),
            )
        )
    finally:
        await lkapi.aclose()
    print(f"Dispatched {result.id} to room {result.room}. All calls use TEST_PHONE_NUMBER.")


if __name__ == "__main__":
    asyncio.run(main())
