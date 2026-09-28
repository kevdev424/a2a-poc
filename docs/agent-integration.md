# Connecting an external agent

Kin is a localhost development environment. Agents use A2A 1.0 JSON-RPC, implement the [scheduling v1 contract](scheduling-contract.md), and call the platform’s agent APIs with their own credential.

## Try the independent participant

The example runs a minimal Node HTTP server independently of the reference agent. It can participate but cannot lead. Use a new local profile for this example, since each profile has one active agent.

1. Add the new origin to the demo’s allowlist before starting it. On PowerShell:

   ```powershell
   $env:ALLOWED_AGENT_ORIGINS = 'http://127.0.0.1:4201,http://127.0.0.1:4202,http://127.0.0.1:4203,http://127.0.0.1:4204'
   npm run dev
   ```

2. In a second terminal, publish the participant’s Agent Card:

   ```powershell
   $env:AGENT_ID = 'cedar'
   $env:AGENT_NAME = 'Cedar'
   $env:AGENT_PORT = '4204'
   npm run agent:example
   ```

3. Add a local profile in the web application. Register `http://127.0.0.1:4204/.well-known/agent-card.json` under **Your agent**. Registration returns a platform credential once and displays it in the UI. Copy it privately.
4. Stop the example with `Ctrl+C`, set `$env:AGENT_CREDENTIAL` to that credential in the second terminal, and restart `npm run agent:example`. Alternatively, set `AGENT_CREDENTIAL_FILE` to a private text file containing the credential; the example reads it on each request.
5. Connect this person with Alice, create a circle, and enable both agents. Alice’s Maple agent can lead the negotiation. Cedar cannot lead, and the UI disables planning from Cedar’s profile.

Never put platform credentials in the Agent Card or a URL. The registration credential is separate from short-lived peer contact tokens. Re-registering the same external agent refreshes its platform credential; update its configuration accordingly. Sample credentials are preconfigured by the development runner.

To run the full reference agent independently, use `npm run agent` with the same identity/port/credential variables. Add `ALLOWED_AGENT_ORIGINS` to its environment, since a leading agent makes outbound peer calls. `PLATFORM_URL` defaults to `http://127.0.0.1:4100`.

`AGENT_FIXTURE` optionally supplies JSON with `timezone`, `startHour`, `endHour`, and `preferredHour` for deterministic availability. The full reference agent also understands `unavailable`, `rejectFirst`, and `rejectAll` fixture flags. The fixture belongs to the agent and is never placed in its Agent Card.

## Agent Card

Serve this JSON at a registered URL. The backend validates the card and keeps the selected JSON-RPC endpoint; other advertised transports are not used.

```json
{
  "name": "Cedar",
  "description": "My personal scheduling participant",
  "version": "1.0.0",
  "supportedInterfaces": [{
    "url": "http://127.0.0.1:4204/a2a",
    "protocolBinding": "JSONRPC",
    "protocolVersion": "1.0"
  }],
  "capabilities": {
    "streaming": false,
    "extensions": [{
      "uri": "https://kin.local/contracts/scheduling/v1",
      "required": true,
      "params": { "agentId": "cedar" }
    }]
  },
  "securitySchemes": {
    "kin": { "httpAuthSecurityScheme": { "scheme": "bearer", "bearerFormat": "JWT" } }
  },
  "securityRequirements": [{ "schemes": { "kin": { "list": [] } } }],
  "defaultInputModes": ["application/json"],
  "defaultOutputModes": ["application/json"],
  "skills": [{
    "id": "schedule-participate",
    "name": "Participate in scheduling",
    "description": "Shares availability and votes on slots",
    "tags": ["scheduling"]
  }]
}
```

Use a unique `params.agentId` matching the agent’s configured identity. Add a `schedule-lead` skill only if the implementation handles `start` and performs peer negotiation. Both the card origin and the A2A endpoint origin must appear in the configured allowlist. For a hosted agent, advertise its reachable HTTPS endpoint and arrange connectivity back to the platform; tunnel setup is outside this demo.

## Authentication

Platform callbacks use `Authorization: Bearer <platformCredential>`. The platform resolves the agent identity from the credential hash, rather than callback names or browser profile selection.

Peer A2A calls use a different bearer token signed with Ed25519. Fetch the public key from `GET /api/jwks`. Verify `alg=EdDSA`, issuer `kin-local`, audience equal to the recipient agent ID, and expiration. Then check:

- `runId` matches the structured command.
- `actions` includes the command’s action.
- `sub` is `platform` for `start`; for peer requests it is the run’s leading agent.
- `GET /api/agent/runs/:id` succeeds for the recipient, confirming current circle permissions and an active run.
- The command’s scheduling request matches the platform’s immutable request. Its `sentAt` must be within five minutes of the current time.

The reference implementations enable only `SendMessage` on their A2A surface. This prevents a scoped contact token from using generic task retrieval to access a different run. Responses include task and context IDs for tracing. Polling, streaming, push notifications, and generic task listing are outside this v1 contract.

## Platform API

All agent routes below require the agent’s platform credential. JSON bodies are strict; unknown fields are rejected. The platform port is 4100 by default.

| Route | Purpose / body |
|---|---|
| `GET /api/agent/runs/:id` | Current request, participants, leading agent, status, deadline, and proposal |
| `GET /api/agent/runs/:id/peers` | Leader only: registered peer IDs, names, and cards; includes self |
| `POST /api/agent/runs/:id/contacts` | Leader only: `{ "recipientId": "cedar" }`; returns a run-scoped `token` |
| `POST /api/agent/runs/:id/activity` | `{ "eventId": "unique-key", "kind": "availability", "text": "Shared permitted availability." }` |
| `POST /api/agent/runs/:id/traces` | `{ "direction": "incoming", "peerAgentId": "sample-alice", "action": "availability", "taskId": "...", "contextId": "..." }` |
| `POST /api/agent/runs/:id/receipts` | Participant’s own `{ "revision": 1, "slot": { "start": "...", "end": "..." }, "accepted": true }` |
| `POST /api/agent/runs/:id/proposal` | Leader only: `{ "revision": 1, "slot": { "start": "...", "end": "..." } }` |
| `POST /api/agent/runs/:id/failure` | Leader only: `{ "reason": "no_overlap" }` |

Activity kinds are `working`, `availability`, and `negotiation`. Failure reasons are `no_overlap`, `unavailable`, `invalid_response`, `no_consensus`, and `deadline`.

Every participant, including the leader, must submit its **own acceptance receipt** for the same slot and revision before the leader publishes a proposal. The platform checks these independently authenticated receipts. Receipt duplicates are harmless; conflicting receipts for a revision return 409. Activity is deduplicated by `(runId, authenticatedAgentId, eventId)`. Proposal duplicates do not clear approvals.

Reports arriving after a run ends or permissions are revoked are rejected. Agents must stop work when a platform request indicates the run is no longer active. Use human-readable summaries for activity, never raw protocol payloads or credentials.
