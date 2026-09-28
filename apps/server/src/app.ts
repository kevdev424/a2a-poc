import express, { type Request, type Response, type NextFunction } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { requestSchema, slotSchema, validSlot, slotKey, NEGOTIATION_MS, MAX_PROPOSALS, CONTRACT, type Run } from '../../../packages/shared/src/contract.js';
import { AgentCard, callAgent, loadCard, taskIds, resultData } from '../../../packages/shared/src/a2a.js';
import { issueContact } from '../../../packages/shared/src/auth.js';
import { calendarEvent } from '../../../packages/shared/src/ical.js';
import { bootstrap, hash, Store, type AgentRecord } from './store.js';

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
function requireCondition(value: unknown, status: number, message: string): asserts value { if (!value) throw new HttpError(status, message); }
export type ServerOptions = { directory: string; port?: number; agentBasePort?: number; allowedOrigins?: string[]; webPort?: number; negotiationMs?: number };
export async function createApp(options: ServerOptions) {
  const config = await bootstrap(options.directory, options.agentBasePort);
  const store = new Store(options.directory);
  const origins = options.allowedOrigins || config.samples.map(s => `http://127.0.0.1:${s.port}`);
  const browserOrigins = [`http://127.0.0.1:${options.port || 4100}`, `http://localhost:${options.port || 4100}`, `http://127.0.0.1:${options.webPort || 5173}`, `http://localhost:${options.webPort || 5173}`];
  const app = express(); app.disable('x-powered-by'); app.use(express.json({ limit: '128kb' }));
  let closed = false;
  const streams = new Set<Response>();
  const broadcast = () => { for (const stream of streams) stream.write('event: changed\ndata: {}\n\n'); };
  function userId(req: Request) {
    const sessionId = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('kin_session='))?.slice(12);
    return sessionId ? store.one<{ user_id: string }>('SELECT user_id FROM sessions WHERE id=?', sessionId)?.user_id || 'alice' : 'alice';
  }
  function member(req: Request, groupId: string) {
    const group = store.group(groupId); requireCondition(group, 404, 'Group not found');
    requireCondition(group.members.some(m => m.userId === userId(req)), 403, 'You are not a member of this group'); return group;
  }
  function agent(req: Request): AgentRecord {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const record = token ? store.credential(token) : undefined; requireCondition(record, 401, 'Valid agent credential required'); return record;
  }
  function authorizedRun(actor: AgentRecord, id: string, active = false) {
    const run = store.run(id); requireCondition(run, 404, 'Scheduling run not found');
    requireCondition(run.participants.some(p => p.agentId === actor.id), 403, 'Agent is not a participant');
    if (active) {
      requireCondition(run.status === 'negotiating' || run.status === 'awaiting_approval', 409, 'Scheduling run is no longer active');
      const group = store.group(run.groupId)!;
      requireCondition(run.participants.every(p => group.members.some(m => m.userId === p.userId && m.enabled && m.agentId === p.agentId)), 403, 'Group agent permission was revoked');
      requireCondition(run.status !== 'negotiating' || Date.parse(run.deadline) > Date.now(), 409, 'Negotiation deadline exceeded');
    }
    return run;
  }
  function leader(req: Request, id: string) { const actor = agent(req); const run = authorizedRun(actor, id, true); requireCondition(run.leaderAgentId === actor.id, 403, 'Only the initiating agent can perform this action'); return { actor, run }; }
  function failRun(id: string, text: string) {
    if (closed) return;
    const run = store.run(id); if (!run || run.status !== 'negotiating') return;
    run.status = 'failed'; run.error = text; store.saveRun(run);
    store.activity(run.groupId, run.id, null, 'Platform', 'failed', text, `failed:${run.id}`); broadcast();
  }
  app.use('/api', (req, _res, next) => {
    try {
      if (req.headers.origin) requireCondition(browserOrigins.includes(req.headers.origin), 403, 'Origin is not allowed');
      if (!['GET', 'HEAD'].includes(req.method) && !req.path.startsWith('/agent/')) requireCondition(req.headers['x-demo-request'] === '1', 403, 'Development request header required');
      next();
    } catch (error) { next(error); }
  });
  app.get('/api/health', (_req, res) => { res.json({ status: 'ok', contract: CONTRACT }); });
  app.get('/api/jwks', (_req, res) => { res.json({ keys: [{ ...config.publicJwk, alg: 'EdDSA', use: 'sig' }] }); });
  app.get('/api/state', (req, res) => { res.json(store.state(userId(req), config)); });
  app.post('/api/session', (req, res) => {
    const { userId: selected } = z.object({ userId: z.string() }).parse(req.body);
    requireCondition(store.user(selected), 404, 'Profile not found');
    const id = randomBytes(24).toString('base64url'); store.execute('INSERT INTO sessions VALUES (?,?)', id, selected);
    res.cookie('kin_session', id, { httpOnly: true, sameSite: 'strict', path: '/' }); res.json({ ok: true });
  });
  app.post('/api/profiles', (req, res) => {
    const body = z.object({ name: z.string().trim().min(2).max(60), timezone: requestSchema.shape.timezone }).strict().parse(req.body);
    const id = randomUUID(); store.execute('INSERT INTO users VALUES (?,?,?,?)', id, body.name, body.timezone, 'sky'); broadcast(); res.status(201).json(store.user(id));
  });
  app.post('/api/friends', (req, res) => {
    const { userId: target } = z.object({ userId: z.string() }).strict().parse(req.body); const from = userId(req);
    requireCondition(target !== from && store.user(target), 400, 'Choose another profile');
    const pair = [from, target].sort().join(':'); const existing = store.one<{ id: string }>('SELECT id FROM friends WHERE pair=?', pair);
    if (existing) { res.json({ id: existing.id }); return; }
    const id = randomUUID(); store.execute('INSERT INTO friends VALUES (?,?,?,?,?)', id, from, target, pair, 'pending'); broadcast(); res.status(201).json({ id });
  });
  app.post('/api/friends/:id/accept', (req, res) => {
    const friendship = store.friends().find(f => f.id === req.params.id); requireCondition(friendship, 404, 'Friend request not found');
    requireCondition(friendship.toId === userId(req), 403, 'Only the recipient can accept');
    store.execute("UPDATE friends SET status='accepted' WHERE id=?", friendship.id); broadcast(); res.json({ ok: true });
  });
  app.post('/api/groups', (req, res) => {
    const body = z.object({ name: z.string().trim().min(1).max(80), userIds: z.array(z.string()).min(1).max(9) }).strict().parse(req.body);
    const creator = userId(req); const ids = [...new Set([creator, ...body.userIds])];
    requireCondition(ids.length >= 2, 400, 'Add at least one friend');
    for (const target of ids.filter(id => id !== creator)) requireCondition(store.friends().some(f => f.status === 'accepted' && [f.fromId, f.toId].includes(creator) && [f.fromId, f.toId].includes(target)), 403, 'Group members must be accepted friends of the creator');
    const id = randomUUID(); store.transaction(() => { store.execute('INSERT INTO groups VALUES (?,?,?)', id, body.name, creator); for (const target of ids) store.execute('INSERT INTO members(group_id,user_id) VALUES (?,?)', id, target); });
    store.activity(id, null, null, store.user(creator)!.name, 'group', 'Created the group. Each person can enable their agent when they are ready.', `group:${id}`); broadcast(); res.status(201).json(store.group(id));
  });
  app.post('/api/groups/:id/permission', (req, res) => {
    const group = member(req, String(req.params.id)); const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    const actor = store.userAgent(userId(req)); requireCondition(!enabled || actor?.canParticipate, 409, 'Register a compatible agent first');
    store.transaction(() => {
      store.execute('UPDATE members SET enabled=?, agent_id=? WHERE group_id=? AND user_id=?', enabled ? 1 : 0, actor?.id || null, group.id, userId(req));
      if (!enabled) for (const run of store.runs().filter(r => r.groupId === group.id && ['negotiating', 'awaiting_approval'].includes(r.status))) {
        run.status = 'failed'; run.error = 'A participant disabled their agent for this group.'; store.saveRun(run);
        store.activity(group.id, run.id, null, 'Platform', 'failed', run.error, `permission-revoked:${run.id}`);
      }
    });
    store.activity(group.id, null, null, store.user(userId(req))!.name, 'permission', enabled ? 'Enabled their agent for scheduling in this group.' : 'Disabled their agent in this group.', randomUUID()); broadcast(); res.json({ ok: true });
  });
  app.post('/api/agents/register', async (req, res) => {
    const { cardUrl } = z.object({ cardUrl: z.url() }).strict().parse(req.body);
    const owner = userId(req); const sample = config.samples.find(s => `http://127.0.0.1:${s.port}/.well-known/agent-card.json` === cardUrl);
    requireCondition(!sample || sample.userId === owner, 403, 'This sample agent belongs to another profile');
    const loaded = await loadCard(cardUrl, origins);
    const agentId = loaded.card.capabilities!.extensions.find(e => e.uri === CONTRACT)?.params?.agentId;
    requireCondition(typeof agentId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(agentId), 400, 'Scheduling extension must declare params.agentId');
    requireCondition(!sample || sample.agentId === agentId, 400, 'Sample agent identity mismatch');
    const previous = store.userAgent(owner);
    requireCondition(!previous || previous.id === agentId, 409, 'This profile already has an active agent');
    const collision = store.agent(agentId); requireCondition(!collision || collision.userId === owner, 409, 'Agent identity belongs to another profile');
    const credential = sample?.credential || randomBytes(32).toString('base64url');
    store.saveAgent({ id: agentId, userId: owner, name: loaded.card.name, cardUrl, ...loaded, credentialHash: hash(credential), status: 'connected', checkedAt: new Date().toISOString(), skills: loaded.card.skills.map(s => s.id) });
    broadcast(); res.status(201).json({ agent: store.state(owner, config).agents.find(a => a.id === agentId), platformCredential: credential, sample: !!sample });
  });
  app.post('/api/agents/check', async (req, res) => {
    const actor = store.userAgent(userId(req)); requireCondition(actor, 404, 'Register an agent first');
    try { const loaded = await loadCard(actor.cardUrl, origins); requireCondition(loaded.card.capabilities!.extensions.find(e => e.uri === CONTRACT)?.params?.agentId === actor.id, 400, 'Agent identity changed'); Object.assign(actor, loaded, { status: 'connected' }); }
    catch { actor.status = 'unavailable'; }
    actor.checkedAt = new Date().toISOString(); store.saveAgent(actor); broadcast(); res.json({ status: actor.status });
  });
  app.post('/api/groups/:id/runs', async (req, res) => {
    const group = member(req, String(req.params.id)); const request = requestSchema.parse(req.body);
    requireCondition(group.members.every(m => m.enabled && m.agentId && store.agent(m.agentId)?.canParticipate), 409, 'Every member must register and enable their agent');
    const initiating = store.userAgent(userId(req)); requireCondition(initiating?.canLead, 409, 'Your agent cannot lead scheduling');
    requireCondition(!store.runs().some(r => r.groupId === group.id && ['negotiating', 'awaiting_approval'].includes(r.status)), 409, 'Finish the current request before starting another');
    const run: Run = { id: randomUUID(), groupId: group.id, initiatorId: userId(req), leaderAgentId: initiating.id, request, status: 'negotiating', createdAt: new Date().toISOString(), deadline: new Date(Date.now() + (options.negotiationMs || NEGOTIATION_MS)).toISOString(), participants: group.members.map(m => ({ userId: m.userId, agentId: m.agentId! })), proposal: null, error: null, approvals: [] };
    store.saveRun(run); store.activity(group.id, run.id, null, store.user(userId(req))!.name, 'request', `Asked ${initiating.name} to arrange “${request.title}” for everyone.`, `start:${run.id}`); broadcast(); res.status(202).json(run);
    void (async () => {
      try {
        const token = await issueContact(config.privateJwk, 'platform', initiating.id, run.id, ['start'], run.deadline);
        const result = await callAgent(initiating.card, { contract: CONTRACT, action: 'start', runId: run.id, sentAt: new Date().toISOString(), request }, token, origins, Math.max(1, Date.parse(run.deadline) - Date.now()));
        if (closed) return;
        store.trace({ runId: run.id, senderId: 'platform', recipientId: initiating.id, action: 'start', ...taskIds(result) });
        const data = resultData(result) as { outcome?: string } | undefined;
        if (store.run(run.id)?.status === 'negotiating') failRun(run.id, data?.outcome === 'failed' ? 'The agents could not agree on a time.' : 'The initiating agent finished without a verified proposal.');
        broadcast();
      } catch { failRun(run.id, 'The initiating agent was unavailable, returned an invalid response, or exceeded the negotiation deadline.'); }
    })();
  });
  app.post('/api/runs/:id/approval', (req, res) => {
    const body = z.object({ revision: z.number().int().min(1).max(MAX_PROPOSALS), decision: z.enum(['approve', 'reject']) }).strict().parse(req.body);
    const run = store.run(String(req.params.id)); requireCondition(run, 404, 'Run not found'); member(req, run.groupId);
    requireCondition(run.proposal?.revision === body.revision, 409, 'This proposal is stale. Refresh before approving.');
    requireCondition(run.participants.some(p => p.userId === userId(req)), 403, 'You are not a participant');
    const previous = run.approvals.find(a => a.userId === userId(req) && a.revision === body.revision);
    if (previous) { requireCondition(previous.decision === body.decision, 409, 'This decision was already recorded'); res.json(run); return; }
    requireCondition(run.status === 'awaiting_approval', 409, 'This proposal is no longer awaiting approval');
    store.transaction(() => {
      store.execute('INSERT INTO approvals VALUES (?,?,?,?)', run.id, userId(req), body.revision, body.decision);
      run.approvals = store.run(run.id)!.approvals;
      if (body.decision === 'reject') run.status = 'rejected';
      else if (run.participants.every(p => run.approvals.some(a => a.userId === p.userId && a.revision === body.revision && a.decision === 'approve'))) run.status = 'approved';
      store.saveRun(run);
      store.activity(run.groupId, run.id, null, store.user(userId(req))!.name, 'approval', body.decision === 'approve' ? 'Approved the proposed time.' : 'Declined the proposed time. Start a new request with revised preferences.', `approval:${run.id}:${body.revision}:${userId(req)}`);
      if (run.status === 'approved') store.activity(run.groupId, run.id, null, 'Platform', 'complete', 'Everyone approved. Your calendar event is ready to download.', `complete:${run.id}:${body.revision}`);
    }); broadcast(); res.json(store.run(run.id));
  });
  app.get('/api/runs/:id/calendar.ics', (req, res) => {
    const run = store.run(String(req.params.id)); requireCondition(run, 404, 'Run not found'); member(req, run.groupId);
    requireCondition(run.status === 'approved', 409, 'Every participant must approve before exporting');
    res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="kin-event.ics"' }).send(calendarEvent(run, store.users().filter(u => run.participants.some(p => p.userId === u.id))));
  });
  app.get('/api/events', (req, res) => {
    // Notifications contain no user data. The browser fetches authorized state after each update.
    userId(req); res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); res.flushHeaders();
    res.write('event: connected\ndata: {}\n\n'); streams.add(res); req.on('close', () => streams.delete(res));
  });
  app.get('/api/agent/runs/:id', (req, res) => { res.json(authorizedRun(agent(req), String(req.params.id), true)); });
  app.get('/api/agent/runs/:id/peers', (req, res) => {
    const { run } = leader(req, String(req.params.id));
    res.json(run.participants.map(p => { const peer = store.agent(p.agentId)!; return { id: peer.id, name: peer.name, card: AgentCard.toJSON(peer.card) }; }));
  });
  app.post('/api/agent/runs/:id/contacts', async (req, res) => {
    const { actor, run } = leader(req, String(req.params.id));
    requireCondition(run.status === 'negotiating', 409, 'Negotiation has ended');
    const { recipientId } = z.object({ recipientId: z.string() }).strict().parse(req.body);
    requireCondition(recipientId !== actor.id && run.participants.some(p => p.agentId === recipientId), 403, 'Recipient is not an authorized peer');
    res.json({ token: await issueContact(config.privateJwk, actor.id, recipientId, run.id, ['availability', 'propose'], run.deadline) });
  });
  app.post('/api/agent/runs/:id/activity', (req, res) => {
    const actor = agent(req); const run = authorizedRun(actor, String(req.params.id), true);
    const body = z.object({ eventId: z.string().min(1).max(100), kind: z.enum(['availability', 'negotiation', 'working']), text: z.string().trim().min(1).max(500) }).strict().parse(req.body);
    store.activity(run.groupId, run.id, actor.id, actor.name, body.kind, body.text, `agent:${run.id}:${actor.id}:${body.eventId}`); broadcast(); res.json({ ok: true });
  });
  app.post('/api/agent/runs/:id/traces', (req, res) => {
    const actor = agent(req); const run = authorizedRun(actor, String(req.params.id));
    const body = z.object({ direction: z.enum(['incoming', 'outgoing']), peerAgentId: z.string(), action: z.enum(['start', 'availability', 'propose']), taskId: z.string().min(1).max(100), contextId: z.string().min(1).max(100) }).strict().parse(req.body);
    requireCondition(body.peerAgentId === 'platform' ? body.action === 'start' && body.direction === 'incoming' && actor.id === run.leaderAgentId : run.participants.some(p => p.agentId === body.peerAgentId) && body.peerAgentId !== actor.id, 403, 'Trace peer is not part of this run');
    store.trace({ runId: run.id, senderId: body.direction === 'incoming' ? body.peerAgentId : actor.id, recipientId: body.direction === 'incoming' ? actor.id : body.peerAgentId, action: body.action, taskId: body.taskId, contextId: body.contextId }); broadcast(); res.json({ ok: true });
  });
  app.post('/api/agent/runs/:id/receipts', (req, res) => {
    const actor = agent(req); const run = authorizedRun(actor, String(req.params.id), true);
    requireCondition(run.status === 'negotiating' || run.status === 'awaiting_approval', 409, 'Negotiation has ended');
    const body = z.object({ revision: z.number().int().min(1).max(MAX_PROPOSALS), slot: slotSchema, accepted: z.boolean() }).strict().parse(req.body);
    requireCondition(validSlot(body.slot, run.request), 400, 'Proposed slot does not match the scheduling request');
    const prior = store.one<{ slot_key: string; accepted: number }>('SELECT * FROM receipts WHERE run_id=? AND agent_id=? AND revision=?', run.id, actor.id, body.revision);
    requireCondition(!prior || (prior.slot_key === slotKey(body.slot) && !!prior.accepted === body.accepted), 409, 'Conflicting receipt for this revision');
    store.execute('INSERT OR IGNORE INTO receipts VALUES (?,?,?,?,?)', run.id, actor.id, body.revision, slotKey(body.slot), body.accepted ? 1 : 0);
    res.json({ ok: true });
  });
  app.post('/api/agent/runs/:id/proposal', (req, res) => {
    const { actor, run } = leader(req, String(req.params.id));
    const body = z.object({ revision: z.number().int().min(1).max(MAX_PROPOSALS), slot: slotSchema }).strict().parse(req.body);
    requireCondition(validSlot(body.slot, run.request), 400, 'Proposed slot does not match the scheduling request');
    if (run.proposal && body.revision === run.proposal.revision) { requireCondition(slotKey(body.slot) === slotKey(run.proposal), 409, 'Conflicting proposal for this revision'); res.json(run); return; }
    requireCondition(!run.proposal || body.revision > run.proposal.revision, 409, 'Proposal revision is stale');
    for (const participant of run.participants) {
      const receipt = store.one<{ accepted: number; slot_key: string }>('SELECT accepted,slot_key FROM receipts WHERE run_id=? AND agent_id=? AND revision=?', run.id, participant.agentId, body.revision);
      requireCondition(receipt?.accepted && receipt.slot_key === slotKey(body.slot), 409, 'Every participant agent must independently accept this slot first');
    }
    store.transaction(() => {
      run.proposal = { ...body.slot, revision: body.revision, uid: `${run.id}@kin.local` }; run.status = 'awaiting_approval';
      store.execute('DELETE FROM approvals WHERE run_id=?', run.id); store.saveRun(run);
      store.activity(run.groupId, run.id, actor.id, actor.name, 'proposal', 'All agents agree on a time. Each person can now review and approve the proposal.', `proposal:${run.id}:${body.revision}`);
    }); broadcast(); res.json(store.run(run.id));
  });
  app.post('/api/agent/runs/:id/failure', (req, res) => {
    const { run } = leader(req, String(req.params.id));
    const { reason } = z.object({ reason: z.enum(['no_overlap', 'unavailable', 'invalid_response', 'no_consensus', 'deadline']) }).strict().parse(req.body);
    const descriptions = { no_overlap: 'There is no shared availability in this date range. Try different dates or a shorter duration.', unavailable: 'A participant agent could not be reached. Check its connection and try again.', invalid_response: 'A participant agent returned a response that does not match the scheduling contract.', no_consensus: 'The agents did not agree after three proposals. Try a new request.', deadline: 'Negotiation exceeded the two-minute deadline. Try a new request.' };
    failRun(run.id, descriptions[reason]); res.json({ ok: true });
  });
  const timer = setInterval(() => {
    for (const run of store.runs()) if (run.status === 'negotiating' && Date.parse(run.deadline) <= Date.now()) failRun(run.id, 'Negotiation exceeded the two-minute deadline. Try a new request.');
    for (const stream of streams) stream.write(': keepalive\n\n');
  }, 1000); timer.unref();
  const webDist = join(process.cwd(), 'apps', 'web', 'dist');
  if (existsSync(webDist)) { app.use(express.static(webDist)); app.get('/', (_req, res) => { res.sendFile(join(webDist, 'index.html')); }); }
  app.use((_req, res) => { res.status(404).json({ error: 'Route not found' }); });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) { res.status(400).json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }); return; }
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof Error && /Agent Card|Agent must|Agent does|Destination|Invalid URL/.test(error.message)) { res.status(400).json({ error: error.message }); return; }
    // Never expose protocol response bodies, tokens, or stack traces to the browser.
    res.status(500).json({ error: 'The operation could not be completed. Check the agent connection and try again.' });
  });
  return { app, store, config, close: () => { if (closed) return; closed = true; clearInterval(timer); for (const stream of streams) stream.end(); streams.clear(); store.close(); } };
}
