# Helpfully — Call for Help Agent

A service-booking prototype that finds nearby providers, makes test phone calls,
and shows extracted offers so the user can choose a first choice and backup.

## Current flow

Sign in → submit request → verify address → search Google Maps through MCP →
rank providers → save shortlist → call providers → save transcript → extract
fees and visit time with Gemini → display offers → request booking confirmation.

Calls currently use the configured **test phone number**, with real provider
details kept as context. Transcript accuracy and production security still need work.

## Run locally

Requires Node.js with npm and a running PostgreSQL database.

1. Run `npm ci` to install the locked JavaScript dependencies.
2. Copy `.env.example` to `.env`. Set the database URL, Google keys, session secret,
   and private call transcript token. Keep `TEST_CALLS_ENABLED=false` initially.
3. Create the PostgreSQL database and role used in that URL, if not already present.
4. Run `npm run db:migrate`.
5. Run `npm run dev` to start the UI, API, and search/extraction worker.

Open the URL Vite prints in the terminal. The API defaults to port 3001.
Phone calls require the separate Python agent and dispatcher; see the
[voice setup](LiveKit-Vobiz-Outbound/README.md).

## Project folders

| Folder | Responsibility |
| --- | --- |
| `src/` | React and TypeScript UI |
| `server/routes/` | HTTP endpoints |
| `server/requests/` | Request validation |
| `server/providers/`, `server/mcp/` | Address lookup, Google search, ranking |
| `server/bookings/` | Confirmation and retry rules |
| `server/scheduler/` | Search, outreach, and extraction workers |
| `server/` | App setup, call handling, extraction, and tracing |
| `LiveKit-Vobiz-Outbound/` | Python voice agent and phone dispatcher |
| `database/` | PostgreSQL schema and migrations |
| `tests/`, `evaluation/` | Flow tests and synthetic extraction evaluations |

## Checks

- `npm run build` — TypeScript checks and UI build.
- `npm run test:provider-flow` — flow tests using a temporary schema in local
  PostgreSQL and mocked external APIs; no phone calls. Uses `TEST_DATABASE_URL`
  when set, otherwise `DATABASE_URL`.

Keep credentials, real call recordings, and private customer data out of Git.
The voice integration includes upstream code under its original
[MIT license](LiveKit-Vobiz-Outbound/LICENSE).
