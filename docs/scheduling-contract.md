# Kin scheduling v1

Extension URI: `https://kin.local/contracts/scheduling/v1`. This is an application contract identifier; it need not resolve over the network. The schema source is `packages/shared/src/contract.ts`.

## Request and transport

Use A2A 1.0 `SendMessage`, with `A2A-Version: 1.0`, `A2A-Extensions` containing the extension URI, and bearer contact authorization. Send a structured `data` part with media type `application/json`. Task outputs contain one structured answer in an artifact. A returned task must reach `TASK_STATE_COMPLETED`; other terminal states count as a failed response.

All commands and answers contain `contract`, `runId`, `action`, and `sentAt` (an ISO timestamp with UTC or an explicit offset). A platform run ID differs from the remote A2A task/context IDs. Agents should persist or report these associations through the tracing API.

The immutable scheduling `request` is:

```json
{
  "title": "Dinner with the crew",
  "from": "2026-10-03",
  "to": "2026-10-05",
  "durationMinutes": 60,
  "timezone": "America/New_York"
}
```

`from` and `to` are inclusive local calendar dates in the request timezone, with at most 31 days. The title is 1–120 characters and duration is 15–240 minutes. Candidate instants use explicit UTC timestamps or offsets; candidates must fall entirely inside the date range and have the requested elapsed duration. Timezone conversion and daylight-saving changes must not alter that duration.

## Commands and answers

| Command | Additional fields | Answer |
|---|---|---|
| `start` | `request` | `finished` with `outcome: "proposed"` or `"failed"` |
| `availability` | `request` | `availability` with `availability.slots` |
| `propose` | `request`, `revision`, `slot` | `vote` with the same `revision` and `slot`, `accepted`, and optional `reason` |

A `slot` contains `start` and `end`. Availability supplies **exact candidate slots**, each with a preference score from 0 to 10. V1 intersects these exact candidates, rather than arbitrary free/busy intervals. Emit candidates on a 15-minute grid measured from the request range’s UTC start so implementations can find matching instants. The sample implementation walks UTC instants and checks each agent’s local working hours, including repeated/missing times at DST boundaries.

Example availability answer:

```json
{
  "contract": "https://kin.local/contracts/scheduling/v1",
  "runId": "the-platform-run-id",
  "action": "availability",
  "sentAt": "2026-09-28T15:00:00Z",
  "availability": {
    "slots": [{ "start": "2026-10-03T23:00:00Z", "end": "2026-10-04T00:00:00Z", "preference": 10 }]
  }
}
```

Do not send calendar entries, descriptions of private appointments, or calendar-provider credentials. Availability itself is shared only with authorized members for the current scheduling request.

## Leading negotiation

The leading agent obtains peers and contact tokens from the platform, then contacts peer endpoints **directly**. It combines its own availability with every peer’s, ranks shared candidates by summed preference, and breaks ties by earliest start instant.

Try at most the top three candidates, assigning revisions 1–3. For each candidate, ask every peer to vote and submit a receipt for the leader’s own acceptance. A participant submits its authenticated receipt before returning its vote. If any vote rejects, move to the next candidate. If all accept, publish that slot and revision using the proposal API.

Peer replies must match the contract, run ID, action, and proposed slot/revision. Malformed or mismatched replies fail the run. No overlap, unreachable peers, failure to agree, and deadline expiry produce distinct outcomes. Each reference peer call has a 15-second timeout, bounded by the run’s two-minute deadline. The platform enforces expiry independently.

## Human approval and persistence

Agent consensus creates an `awaiting_approval` proposal. It never authorizes calendar export by itself. Every participant approves the **same current revision** in the web application. A higher verified proposal revision clears earlier human approvals. Stale decisions return 409. A human rejection ends that proposal; a new scheduling run is required.

After all approvals, the event has a stable UID derived from the platform run ID. Downloads use UTC instants and preserve the display timezone in metadata. The same run produces the same event on repeated export requests.

The platform persists history, approvals, and task mappings in SQLite. Unfinished negotiations become `interrupted` on restart. Pending human approvals remain pending. Agents do not automatically resume interrupted negotiations.
