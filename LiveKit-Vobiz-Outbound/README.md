# Vobiz + LiveKit: outbound voice agent

Place phone calls over a Vobiz SIP trunk with a [LiveKit Agents](https://docs.livekit.io/agents/) voice assistant.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10%2B-3776AB.svg)](https://www.python.org/)
[![LiveKit Agents 1.8](https://img.shields.io/badge/LiveKit%20Agents-1.8-00C2FF.svg)](https://docs.livekit.io/agents/)

```
make_call.py --> agent dispatch --> agent joins room --> LiveKit outbound trunk --SIP--> Vobiz --PSTN--> Callee
```

To answer calls instead, see [Livekit-vobiz-inbound](https://github.com/vobiz-ai/Livekit-vobiz-inbound).

## Prerequisites

- Python 3.10 or newer
- A [LiveKit Cloud](https://cloud.livekit.io) project
- A [Vobiz](https://console.vobiz.ai) account with a phone number, an outbound SIP trunk, and a SIP credential attached to that trunk

The agent uses Gemini Live and requires `GOOGLE_API_KEY` in `.env.local`.

## Set up

### 1. Install

```bash
git clone https://github.com/vobiz-ai/LiveKit-Vobiz-Outbound.git
cd LiveKit-Vobiz-Outbound
uv venv && uv pip install -r requirements.txt
cp .env.example .env.local
```

Fill in `.env.local`. `VOBIZ_SIP_DOMAIN` is the domain of your Vobiz outbound trunk.

### 2. Create the LiveKit trunk

```bash
uv run python setup_trunk.py
```

Add the printed `SIP_OUTBOUND_TRUNK_ID` to `.env.local`. To update the credentials later, run the script again and it updates that trunk.

### 3. Run the agent

```bash
uv run python agent.py dev
```

### 4. Place a call

In a second terminal:

```bash
uv run python make_call.py --watch
```

This requires the root app and database worker, a queued database call, and
`TEST_CALLS_ENABLED=true`. It starts dispatching queued test calls. Answer the
call and say hello; the agent replies once the person has spoken.

All outbound destinations are overridden with `TEST_PHONE_NUMBER`. For linked calls,
the backend returns that number and the voice agent checks it again before dialing.
The original provider stays linked to the call attempt in the database.

For database-driven testing, set `TEST_CALLS_ENABLED=true` in the project root
`.env` when ready. Start the app and voice agent, then run
`uv run python make_call.py --watch` from this folder. It claims one queued call at
a time and passes its ID to the agent. The agent loads the real request context,
uses its saved language, and saves the finished transcript. The extraction worker
then fills the offer fields for Current bookings. Use Ctrl+C to stop dispatching.
For one specific queued attempt, use `--call-attempt-id <id>`.
If dispatch stops unexpectedly, inspect the active call before retrying; a claimed
call stays marked calling to prevent another call being started automatically.

New service requests infer a suggested call language from the verified address's
state using the shared defaults in `config/call-languages.json`. Linked calls read
`preferred_language` from the request through the authenticated backend endpoint.
Unlinked practice calls accept `--language te`, `--language kn`, or another code
from that file. Linked older requests resolve and save the address-based language
before a call when it is missing. An unknown state falls back to English. The voice
prompt asks the agent to switch languages if the vendor requests it.

To save a test call in the app, set `CALL_TRANSCRIPT_TOKEN` to a shared secret in the
root `.env`, run the database migrations, and start the app and worker with
`npm run dev` from the project root. Run the voice agent as above. Dispatch with
`--call-attempt-id <id>` using a queued call attempt provisioned for the test number.
The agent reads the shared secret and API port from the root `.env`. For an agent
running on a separate host, set `CALL_TRANSCRIPT_TOKEN` and
`CALL_TRANSCRIPT_API_URL` in its environment. The API URL must be reachable from
that host.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `LIVEKIT_URL` | Yes | LiveKit project URL |
| `LIVEKIT_API_KEY` | Yes | LiveKit API key |
| `LIVEKIT_API_SECRET` | Yes | LiveKit API secret |
| `VOBIZ_SIP_DOMAIN` | Yes | Domain of your Vobiz outbound trunk |
| `VOBIZ_USERNAME` | Yes | SIP credential username |
| `VOBIZ_PASSWORD` | Yes | SIP credential password |
| `VOBIZ_OUTBOUND_NUMBER` | Yes | Caller ID, in E.164 format |
| `SIP_OUTBOUND_TRUNK_ID` | Yes | Printed by `setup_trunk.py` |

To change the voice, models or prompt, edit `agent.py`.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| The dispatch succeeds but nothing happens | The worker must be running and registered, on the same LiveKit project as `make_call.py` |
| The call is rejected, or shows the wrong number | The caller ID must be a number on your Vobiz account |
| `call did not connect` in the agent log | The log line includes the SIP status. Check the call in the Vobiz Console logs |

## Learn more

- [Vobiz LiveKit integration guide](https://www.vobiz.ai/docs/integrations/livekit)
- [LiveKit outbound calls](https://docs.livekit.io/telephony/making-calls/outbound-calls/)
- [Inbound calling example](https://github.com/vobiz-ai/Livekit-vobiz-inbound)
- [Call transfer example](https://github.com/vobiz-ai/Vobiz-Livekit-Call-Transfer-Example)

## License

[MIT](./LICENSE) © Vobiz. Questions: open an issue or email [piyush@vobiz.ai](mailto:piyush@vobiz.ai).
