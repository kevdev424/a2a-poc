# Kin — A2A social scheduling

A local proof of concept for bringing personal agents into a social space. People register an agent, connect with friends, create a circle, and ask their own agent to negotiate an event with the other members’ agents.

The initiating agent makes **direct A2A calls to participant agents**. The platform supplies discovery, scoped authorization, persistent activity, and human approval. It has no scheduling agent.

## Run locally

Requires Node.js **24 or newer** (Node 26 is supported) and npm. No Docker, model API keys, or real calendars are needed.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. One command starts the Node platform on port 4100, Vite on 5173, and three separate agent processes on 4201–4203. `Ctrl+C` stops the services. If a required port is occupied, startup reports the error and stops the demo.

### Try the complete flow

1. On Alice’s profile, open **Your agent** and select **Connect Maple**. Switch demo profiles using the selector at the bottom of the sidebar; connect **Orbit** for Bob and **Juniper** for Carol.
2. Switch to Alice. Open **Find your people** and send requests to Bob and Carol. Switch to each recipient and accept the request.
3. Switch to Alice and create a circle with both friends.
4. Open the circle from each profile and enable that person’s agent. Permissions are off by default.
5. On Alice’s profile, select **Plan something**. The sample agents are available every day between 6 pm and 10 pm in `America/New_York` (Orbit also allows 5 pm). Try a one-hour dinner in the coming week.
6. Watch the activity timeline. Expand **Connection activity** to see the initiating agent’s direct A2A calls and remote task IDs.
7. Approve the proposed time from all three profiles. Download the `.ics` event. Repeated downloads contain one event with the same UID.

Reloading preserves history and approval decisions. Restarting preserves finished data and marks unfinished negotiations interrupted. Use revised inputs to start a new run after a failure or rejection.

## Checks

```sh
npm run typecheck
npm run build
npm test
```

Tests exercise real HTTP traffic with independently running agent processes. They cover direct negotiation, a separately implemented participant, ranking, retries after preference conflicts, calendar approval, deduplication, authorization, malformed replies, unreachable/slow peers, deadlines, revocation, stale approvals, DST, and restart persistence. Test services use ports 4301–4304 and 4400 and isolated databases under `.data/test-*`. They do not modify the normal demo database.

`npm run build` builds the web application. Once built, the platform also serves it at http://127.0.0.1:4100 when launched from the repository root:

```sh
node --import tsx apps/server/src/main.ts
```

Run the agents separately as described in the integration guide if not using the development command.

## Bring your own agent

See [the integration guide](docs/agent-integration.md) and [the scheduling contract](docs/scheduling-contract.md). A2A support alone is insufficient: the agent must implement Kin’s scheduling behavior and authorization contract.

- `apps/agent` is the full reference agent, including direct peer negotiation.
- `examples/participant.ts` is a minimal participant built with Node HTTP, without the SDK server or reference agent implementation. It proves wire-level interoperability with the SDK client.
- The official `@a2a-js/sdk` is pinned to **1.2.1**, targeting **A2A 1.0 JSON-RPC**. Dependency versions are recorded in `package-lock.json`.

## Configuration and data

| Variable | Default | Purpose |
|---|---|---|
| `DATA_DIR` | `.data` | SQLite database and local development keys |
| `PORT` | `4100` | Platform port |
| `WEB_PORT` | `5173` | Web development port |
| `AGENT_BASE_PORT` | `4201` | Ports assigned to samples when a data directory is first created |
| `ALLOWED_AGENT_ORIGINS` | Three sample origins | Comma-separated, exact origins permitted for outbound agent calls |

Changing sample ports after creating a data directory requires a new `DATA_DIR`; existing registrations and bootstrap configuration preserve their original addresses. Set an explicit allowlist when adding an external agent. Cross-origin redirects and URLs with embedded usernames/passwords are rejected.

The platform binds to loopback. Profiles are **development identities**, and the switcher deliberately lets the local developer represent any seeded person. This is not a public authentication system.

Private keys and sample credentials live in `.data/dev-secrets.json`; the database stores agent credential hashes. Neither file is tracked by Git. Credentials do not appear in Agent Cards, activity records, task traces, or public state. Preserve the data directory to keep the same keys and registrations. A new directory creates a fresh demo.

## Boundaries

One active agent per user; all circle members are required participants. Requests span up to 31 days and last 15–240 minutes. Negotiation tries up to three candidates and has a two-minute deadline. Approval requires every person on the current proposal revision. Revised proposals clear previous approvals; a human rejection ends that proposal.

Sample agents are deterministic, and the UI uses an explicit scheduling form. There are no LLM calls, real calendar connections, public signup, human chat messages, automatic recovery, or consumer-agent integrations. Muse access remains unverified. An external agent must be reachable by its peers and able to reach the local platform. Calendar export produces a file; it does not create or send invitations through a calendar provider.
