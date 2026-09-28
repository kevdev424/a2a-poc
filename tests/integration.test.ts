import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../apps/server/src/store.js';
import { callAgent } from '../packages/shared/src/a2a.js';
import { issueContact } from '../packages/shared/src/auth.js';
import { CONTRACT, type Run } from '../packages/shared/src/contract.js';
import { harness, request } from './harness.js';

test('three independent agents negotiate directly, approvals gate a stable calendar event, reload preserves history', { timeout: 45_000 }, async () => {
  const h = await harness();
  try {
    const run = await h.run(); assert.equal(run.status, 'awaiting_approval', JSON.stringify(run)); assert.ok(run.proposal);
    const state = await h.state(); const traces = state.traces.filter(t => t.runId === run.id);
    assert.ok(traces.some(t => t.senderId === 'sample-alice' && t.recipientId === 'sample-bob' && t.action === 'availability'));
    assert.ok(traces.some(t => t.senderId === 'sample-alice' && t.recipientId === 'sample-carol' && t.action === 'propose'));
    assert.ok(traces.every(t => t.taskId && t.contextId && t.taskId !== run.id));
    assert.ok(h.output.join('').includes('"from":"sample-alice","action":"propose"'));
    assert.equal(h.children.size, 3); assert.equal(new Set([...h.children.values()].map(c => c.pid)).size, 3);
    const before = await fetch(`${h.platformUrl}/api/runs/${run.id}/calendar.ics`, { headers: { Cookie: h.cookies.get('alice')! } }); assert.equal(before.status, 409);
    for (const profile of ['alice', 'bob', 'carol']) await h.ok(`/runs/${run.id}/approval`, { revision: run.proposal!.revision, decision: 'approve' }, profile);
    const complete = (await h.state()).runs[0]!; assert.equal(complete.status, 'approved'); assert.equal(complete.approvals.length, 3);
    await h.ok(`/runs/${run.id}/approval`, { revision: run.proposal!.revision, decision: 'approve' });
    const first = await fetch(`${h.platformUrl}/api/runs/${run.id}/calendar.ics`, { headers: { Cookie: h.cookies.get('alice')! } }); assert.equal(first.status, 200); assert.match(first.headers.get('content-type')!, /text\/calendar/);
    const event = await first.text(); const second = await fetch(`${h.platformUrl}/api/runs/${run.id}/calendar.ics`, { headers: { Cookie: h.cookies.get('bob')! } }); assert.equal(await second.text(), event); assert.match(event, new RegExp(`UID:${run.id}@kin.local`)); assert.match(event, /BEGIN:VEVENT/);
    const reload = await h.state(); assert.equal(reload.activities.length, (await h.state()).activities.length); assert.equal(reload.runs[0]!.status, 'approved');
    assert.equal(reload.activities.filter(a => a.kind === 'complete').length, 1);
    assert.ok(!JSON.stringify(reload).includes(h.credentials.get('sample-alice')!));
    assert.ok(!JSON.stringify(h.runtime.store.all('SELECT * FROM activities')).includes('Bearer'));
  } finally { await h.close(); }
});

test('an independently configured external agent participates using its issued credential', { timeout: 45_000 }, async () => {
  const h = await harness({ externalCarol: true });
  try { const run = await h.run(); assert.equal(run.status, 'awaiting_approval', JSON.stringify(run)); assert.ok((await h.state()).traces.some(t => t.senderId === 'sample-alice' && t.recipientId === 'external-carol')); assert.ok(h.output.join('').includes('"agent":"external-carol","from":"sample-alice"')); }
  finally { await h.close(); }
});

test('agents try a second proposal after a preference rejection', { timeout: 45_000 }, async () => {
  const h = await harness({ fixtures: { 'sample-bob': { rejectFirst: true } } });
  try { const run = await h.run(); assert.equal(run.status, 'awaiting_approval', JSON.stringify(run)); assert.equal(run.proposal!.revision, 2); assert.ok((await h.state()).activities.some(a => a.text.includes('try the next'))); }
  finally { await h.close(); }
});

test('no common availability produces an actionable outcome and permits a new request', { timeout: 45_000 }, async () => {
  const h = await harness({ fixtures: { 'sample-carol': { unavailable: true } } });
  try { const run = await h.run(); assert.equal(run.status, 'failed'); assert.match(run.error!, /no shared availability/i); assert.equal(run.proposal, null); const next = await h.run({ ...request, title: 'Another try' }); assert.equal(next.status, 'failed'); assert.notEqual(next.id, run.id); }
  finally { await h.close(); }
});

test('negotiation stops after three rejected candidates', { timeout: 45_000 }, async () => {
  const h = await harness({ fixtures: { 'sample-bob': { rejectAll: true } } });
  try { const run = await h.run(); assert.equal(run.status, 'failed'); assert.match(run.error!, /three proposals/); assert.equal(h.runtime.store.all('SELECT * FROM receipts WHERE run_id=? AND agent_id=?', run.id, 'sample-bob').length, 3); }
  finally { await h.close(); }
});

test('invalid agent replies cannot produce a proposal', { timeout: 45_000 }, async () => {
  const h = await harness({ modes: { 'sample-bob': { AGENT_MALFORMED: '1' } } });
  try { const run = await h.run(); assert.equal(run.status, 'failed'); assert.match(run.error!, /does not match the scheduling contract/); }
  finally { await h.close(); }
});

test('unavailable and slow peers close the run without exporting an event', { timeout: 45_000 }, async () => {
  const h = await harness();
  try {
    await h.stopAgent('sample-bob'); const missing = await h.run(); assert.equal(missing.status, 'failed'); assert.match(missing.error!, /could not be reached/);
    await h.launch('sample-bob', 4302, { AGENT_DELAY_MS: '1500' }); const slow = await h.run(); assert.equal(slow.status, 'failed'); assert.match(slow.error!, /could not be reached/);
  } finally { await h.close(); }
});

test('revoked group permission blocks new runs and aborts an existing negotiation', { timeout: 45_000 }, async () => {
  const h = await harness({ modes: { 'sample-alice': { AGENT_DELAY_MS: '500' } } });
  try {
    const started = await h.ok(`/groups/${h.group.id}/runs`, request) as Run;
    await h.ok(`/groups/${h.group.id}/permission`, { enabled: false }, 'bob');
    const run = (await h.state()).runs.find(r => r.id === started.id)!; assert.equal(run.status, 'failed'); assert.match(run.error!, /disabled/);
    assert.equal((await h.json(`/groups/${h.group.id}/runs`, request)).status, 409);
    assert.equal((await h.json(`/agent/runs/${started.id}/contacts`, { recipientId: 'sample-bob' }, 'alice', h.credentials.get('sample-alice'))).status, 409);
  } finally { await h.close(); }
});

test('deadline expiry is enforced independently of agent responses', { timeout: 45_000 }, async () => {
  const h = await harness({ negotiationMs: 150, modes: { 'sample-alice': { AGENT_DELAY_MS: '1000' } } });
  try { const run = await h.run(); assert.equal(run.status, 'failed'); assert.match(run.error!, /deadline/); }
  finally { await h.close(); }
});

test('authorization rejects forged identities, invalid destinations, wrong recipient/run/action, and expired tokens', { timeout: 45_000 }, async () => {
  const h = await harness({ modes: { 'sample-alice': { AGENT_DELAY_MS: '800' } } });
  try {
    assert.equal((await h.json('/agents/register', { cardUrl: 'http://127.0.0.1:9999/.well-known/agent-card.json' })).status, 400);
    assert.equal((await h.json('/agent/runs/missing/activity', { eventId: 'fake', kind: 'working', text: 'fake' }, 'alice', 'forged-credential')).status, 401);
    const run = await h.ok(`/groups/${h.group.id}/runs`, request) as Run;
    const credential = h.credentials.get('sample-bob')!;
    assert.equal((await h.json(`/agent/runs/${run.id}/peers`, undefined, 'bob', credential)).status, 403);
    assert.equal((await h.json(`/agent/runs/${run.id}/activity`, { eventId: 'fake', kind: 'working', text: 'hello', actorName: 'Alice' }, 'bob', credential)).status, 400);
    const payload = { eventId: 'repeat', kind: 'working', text: 'I am Bob’s agent.' };
    await h.ok(`/agent/runs/${run.id}/activity`, payload, 'bob', credential); await h.ok(`/agent/runs/${run.id}/activity`, payload, 'bob', credential);
    const recorded = (await h.state()).activities.filter(a => a.text === payload.text); assert.equal(recorded.length, 1); assert.equal(recorded[0]!.actorId, 'sample-bob'); assert.equal(recorded[0]!.actorName, 'bob');
    const recipient = h.runtime.store.agent('sample-bob')!;
    const command = { contract: CONTRACT, action: 'availability', runId: run.id, sentAt: new Date().toISOString(), request } as const;
    const token = await issueContact(h.runtime.config.privateJwk, 'sample-alice', 'sample-carol', run.id, ['availability'], run.deadline);
    await assert.rejects(callAgent(recipient.card, command, token, ['http://127.0.0.1:4302']));
    const wrongRun = await issueContact(h.runtime.config.privateJwk, 'sample-alice', 'sample-bob', 'other-run', ['availability'], run.deadline);
    await assert.rejects(callAgent(recipient.card, command, wrongRun, ['http://127.0.0.1:4302']));
    const wrongAction = await issueContact(h.runtime.config.privateJwk, 'sample-alice', 'sample-bob', run.id, ['propose'], run.deadline);
    await assert.rejects(callAgent(recipient.card, command, wrongAction, ['http://127.0.0.1:4302']));
    const expired = await issueContact(h.runtime.config.privateJwk, 'sample-alice', 'sample-bob', run.id, ['availability'], new Date(Date.now() - 1000).toISOString());
    await assert.rejects(callAgent(recipient.card, command, expired, ['http://127.0.0.1:4302']));
    assert.equal((await h.json(`/agent/runs/${run.id}/contacts`, { recipientId: 'unrelated-agent' }, 'alice', h.credentials.get('sample-alice'))).status, 403);
  } finally { await h.close(); }
});

test('revised proposals clear approvals and reject stale decisions; rejection ends a proposal', { timeout: 45_000 }, async () => {
  const h = await harness();
  try {
    const run = await h.run(); assert.equal(run.status, 'awaiting_approval'); const first = run.proposal!;
    await h.ok(`/runs/${run.id}/approval`, { revision: first.revision, decision: 'approve' });
    const slot = { start: new Date(Date.parse(first.start) + 15 * 60_000).toISOString(), end: new Date(Date.parse(first.end) + 15 * 60_000).toISOString() };
    const body = { revision: 2, slot };
    assert.equal((await h.json(`/agent/runs/${run.id}/proposal`, body, 'alice', h.credentials.get('sample-alice'))).status, 409);
    for (const id of ['sample-alice', 'sample-bob', 'sample-carol']) {
      await h.ok(`/agent/runs/${run.id}/receipts`, { ...body, accepted: true }, 'alice', h.credentials.get(id));
      await h.ok(`/agent/runs/${run.id}/receipts`, { ...body, accepted: true }, 'alice', h.credentials.get(id));
    }
    await h.ok(`/agent/runs/${run.id}/proposal`, body, 'alice', h.credentials.get('sample-alice')); await h.ok(`/agent/runs/${run.id}/proposal`, body, 'alice', h.credentials.get('sample-alice'));
    const changed = (await h.state()).runs[0]!; assert.equal(changed.approvals.length, 0); assert.equal(changed.proposal!.revision, 2); assert.equal(changed.proposal!.uid, first.uid);
    assert.equal((await h.json(`/runs/${run.id}/approval`, { revision: 1, decision: 'approve' }, 'bob')).status, 409);
    await h.ok(`/runs/${run.id}/approval`, { revision: 2, decision: 'reject' }, 'bob');
    assert.equal((await h.state()).runs[0]!.status, 'rejected');
    assert.equal((await h.json(`/runs/${run.id}/approval`, { revision: 2, decision: 'approve' }, 'carol')).status, 409);
    assert.equal((await fetch(`${h.platformUrl}/api/runs/${run.id}/calendar.ics`, { headers: { Cookie: h.cookies.get('alice')! } })).status, 409);
  } finally { await h.close(); }
});

test('restart interrupts unfinished negotiations while retaining activity and completed data', { timeout: 45_000 }, async () => {
  const h = await harness({ modes: { 'sample-alice': { AGENT_DELAY_MS: '800' } } });
  const started = await h.ok(`/groups/${h.group.id}/runs`, request) as Run; const directory = h.directory;
  await h.close();
  const restored = new Store(directory);
  try { assert.equal(restored.run(started.id)!.status, 'interrupted'); assert.ok(restored.all<{ kind: string }>('SELECT kind FROM activities').some(a => a.kind === 'interrupted')); assert.equal(restored.groups().length, 1); }
  finally { restored.close(); }
});
