import express from 'express';
import { randomUUID } from 'node:crypto';
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore, STATE_HEADERS_KEY, type AgentExecutor, type RequestContext, type ExecutionEventBus } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler } from '@a2a-js/sdk/server/express';
import { TaskState, type Task as TaskType } from '@a2a-js/sdk';
import type { JWK } from 'jose';
import { AgentCard, Task, callAgent, resultData, taskIds, guardedFetch } from '../../../packages/shared/src/a2a.js';
import { commandSchema, answerSchema, CONTRACT, fixtureAvailability, rankSlots, slotKey, MAX_PROPOSALS, type Command, type Answer, type Fixture, type Run, type Availability } from '../../../packages/shared/src/contract.js';
import { verifyContact } from '../../../packages/shared/src/auth.js';

type Peer = { id: string; name: string; card: Record<string, unknown> };
type FailureReason = 'no_overlap' | 'unavailable' | 'invalid_response' | 'no_consensus' | 'deadline';
class NegotiationFailure extends Error { constructor(readonly reason: FailureReason) { super(reason); } }
export type AgentOptions = { id: string; name: string; port: number; platformUrl: string; credential: string | (() => string); publicJwk: JWK; fixture: Fixture; allowedOrigins: string[]; callTimeoutMs?: number; delayMs?: number; malformed?: boolean; participantOnly?: boolean };

export function createAgent(options: AgentOptions) {
  const app = express(); app.disable('x-powered-by'); app.use(express.json({ limit: '128kb' }));
  const card = AgentCard.fromJSON({
    name: options.name, description: 'A personal scheduling agent with private sample availability. Negotiates directly with other people’s agents.', version: '1.0.0',
    supportedInterfaces: [{ url: `http://127.0.0.1:${options.port}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: { streaming: false, pushNotifications: false, extensions: [{ uri: CONTRACT, description: 'Kin scheduling v1', required: true, params: { agentId: options.id } }] },
    securitySchemes: { kin: { httpAuthSecurityScheme: { scheme: 'bearer', bearerFormat: 'JWT', description: 'Run-scoped contact token issued by the local platform' } } },
    securityRequirements: [{ schemes: { kin: { list: [] } } }], defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'],
    skills: [{ id: 'schedule-participate', name: 'Participate in scheduling', description: 'Returns availability and votes on proposed slots.', tags: ['scheduling'] }, ...(options.participantOnly ? [] : [{ id: 'schedule-lead', name: 'Lead scheduling', description: 'Contacts authorized peers directly and negotiates a shared time.', tags: ['scheduling'] }])],
  });
  const platformFetch = guardedFetch([new URL(options.platformUrl).origin], 10_000);
  async function platform<T>(path: string, body?: unknown): Promise<T> {
    const credential = typeof options.credential === 'function' ? options.credential() : options.credential;
    const response = await platformFetch(`${options.platformUrl}/api/agent${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(`Platform rejected agent operation (HTTP ${response.status})`);
    return await response.json() as T;
  }
  const activity = (runId: string, eventId: string, text: string, kind = 'working') => platform(`/runs/${runId}/activity`, { eventId, text, kind });
  const cache = new Map<string, Promise<Answer>>();
  const canceled = new Set<string>();
  const contexts = new Map<string, string>();
  async function negotiate(command: Extract<Command, { action: 'start' }>, context: RequestContext): Promise<Answer> {
    const run = await platform<Run>(`/runs/${command.runId}`);
    const base = { contract: CONTRACT, runId: run.id, sentAt: new Date().toISOString() } as const;
    function remaining() { if (canceled.has(context.taskId)) throw new NegotiationFailure('deadline'); const remaining = Date.parse(run.deadline) - Date.now(); if (remaining <= 0) throw new NegotiationFailure('deadline'); return remaining; }
    try {
      await activity(run.id, 'lead-start', 'I’m checking everyone’s availability and will negotiate with their agents directly.');
      const peers = await platform<Peer[]>(`/runs/${run.id}/peers`);
      const own = fixtureAvailability(command.request, options.fixture);
      const availability: Availability[] = [own];
      const contacts = new Map<string, string>();
      async function send(peer: Peer, request: Command): Promise<Answer> {
        remaining();
        let result;
        try { result = await callAgent(AgentCard.fromJSON(peer.card), request, contacts.get(peer.id)!, options.allowedOrigins, Math.min(options.callTimeoutMs || 15_000, remaining())); }
        catch { throw new NegotiationFailure(Date.now() >= Date.parse(run.deadline) ? 'deadline' : 'unavailable'); }
        await platform(`/runs/${run.id}/traces`, { direction: 'outgoing', peerAgentId: peer.id, action: request.action, ...taskIds(result) });
        const answer = answerSchema.safeParse(resultData(result));
        if (!answer.success || answer.data.runId !== run.id || (request.action === 'availability' && answer.data.action !== 'availability') || (request.action === 'propose' && (answer.data.action !== 'vote' || answer.data.revision !== request.revision || slotKey(answer.data.slot) !== slotKey(request.slot)))) throw new NegotiationFailure('invalid_response');
        return answer.data;
      }
      const others = peers.filter(p => p.id !== options.id);
      for (const peer of others) {
        remaining(); const authorization = await platform<{ token: string }>(`/runs/${run.id}/contacts`, { recipientId: peer.id }); contacts.set(peer.id, authorization.token);
        await activity(run.id, `contact:${peer.id}`, `Reaching out to ${peer.name} for availability.`, 'availability');
        const answer = await send(peer, { ...base, action: 'availability', request: command.request });
        if (answer.action === 'availability') availability.push(answer.availability);
      }
      const candidates = rankSlots(availability, command.request).slice(0, MAX_PROPOSALS);
      if (!candidates.length) throw new NegotiationFailure('no_overlap');
      for (const [index, slot] of candidates.entries()) {
        remaining(); const revision = index + 1;
        await activity(run.id, `proposing:${revision}`, `Found a shared option. Checking proposal ${revision} with everyone’s agents.`, 'negotiation');
        await platform(`/runs/${run.id}/receipts`, { revision, slot, accepted: true });
        let accepted = true;
        for (const peer of others) {
          const answer = await send(peer, { ...base, action: 'propose', revision, slot, request: command.request });
          if (answer.action !== 'vote' || !answer.accepted) accepted = false;
        }
        if (accepted) { remaining(); await platform(`/runs/${run.id}/proposal`, { revision, slot }); return { ...base, action: 'finished', outcome: 'proposed' }; }
        await activity(run.id, `rejected:${revision}`, 'An agent declined this option. I’ll try the next shared time.', 'negotiation');
      }
      throw new NegotiationFailure('no_consensus');
    } catch (error) {
      const reason = error instanceof NegotiationFailure ? error.reason : 'invalid_response';
      // The platform may already have closed the run because of expiry or revocation.
      try { await platform(`/runs/${run.id}/failure`, { reason }); } catch { /* terminal run */ }
      return { ...base, action: 'finished', outcome: 'failed' };
    }
  }
  async function handle(command: Command, context: RequestContext): Promise<Answer> {
    if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
    if (command.action === 'start') return negotiate(command, context);
    const base = { contract: CONTRACT, runId: command.runId, sentAt: new Date().toISOString() } as const;
    const availability = fixtureAvailability(command.request, options.fixture);
    if (command.action === 'availability') {
      await activity(command.runId, 'shared-availability', 'Shared my permitted availability. Calendar details stay private.', 'availability');
      return { ...base, action: 'availability', availability };
    }
    const accepted = availability.slots.some(s => slotKey(s) === slotKey(command.slot)) && !options.fixture.rejectAll && !(options.fixture.rejectFirst && command.revision === 1);
    await platform(`/runs/${command.runId}/receipts`, { revision: command.revision, slot: command.slot, accepted });
    await activity(command.runId, `vote:${command.revision}`, accepted ? 'This time works for my person. They will still review and approve it.' : 'This option does not work for my person. Please try another time.', 'negotiation');
    return { ...base, action: 'vote', revision: command.revision, slot: command.slot, accepted, reason: accepted ? undefined : 'Preference conflict' };
  }
  const executor: AgentExecutor = {
    async execute(context, bus) {
      const command = commandSchema.parse(context.userMessage.parts.find(p => p.content?.$case === 'data')?.content?.value);
      const headers = context.context.state.get(STATE_HEADERS_KEY) as Record<string, string | undefined>;
      const claims = await verifyContact((headers.authorization || '').replace(/^Bearer /, ''), options.publicJwk, options.id);
      if (claims.runId !== command.runId || !claims.actions.includes(command.action)) throw new Error('Contact scope does not authorize this command');
      const run = await platform<Run>(`/runs/${command.runId}`);
      if (JSON.stringify(run.request) !== JSON.stringify(command.request) || (command.action === 'start' ? claims.sub !== 'platform' || run.leaderAgentId !== options.id || options.participantOnly : claims.sub !== run.leaderAgentId)) throw new Error('Command does not match the authorized scheduling run');
      if (Math.abs(Date.now() - Date.parse(command.sentAt)) > 300_000) throw new Error('Command timestamp is stale');
      contexts.set(context.taskId, context.contextId);
      const task: TaskType = Task.fromJSON({ id: context.taskId, contextId: context.contextId, status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString() }, history: [], artifacts: [] });
      bus.publish(AgentEvent.task(task));
      await platform(`/runs/${command.runId}/traces`, { direction: 'incoming', peerAgentId: claims.sub, action: command.action, taskId: context.taskId, contextId: context.contextId });
      console.log(JSON.stringify({ agent: options.id, from: claims.sub, action: command.action, runId: command.runId, taskId: context.taskId }));
      const key = `${command.runId}:${command.action}:${command.action === 'propose' ? command.revision : 0}`;
      let work = cache.get(key); if (!work) { work = handle(command, context); cache.set(key, work); }
      const answer = await work;
      if (canceled.has(context.taskId)) return;
      task.status = { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: new Date().toISOString() };
      task.artifacts = [{ artifactId: randomUUID(), name: 'Scheduling result', description: '', metadata: undefined, extensions: [CONTRACT], parts: [{ content: { $case: 'data', value: options.malformed && command.action === 'availability' ? { broken: true } : answer }, filename: '', mediaType: 'application/json', metadata: undefined }] }];
      bus.publish(AgentEvent.task(task)); bus.finished();
      // Keep replay protection bounded for this local demo.
      if (cache.size > 1000) cache.delete(cache.keys().next().value!);
    },
    async cancelTask(taskId: string, bus: ExecutionEventBus) {
      canceled.add(taskId); bus.publish(AgentEvent.statusUpdate({ taskId, contextId: contexts.get(taskId) || '', status: { state: TaskState.TASK_STATE_CANCELED, message: undefined, timestamp: new Date().toISOString() }, metadata: undefined })); bus.finished();
    },
  };
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);
  app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: handler }));
  app.get('/health', (_req, res) => { res.json({ status: 'ok', agentId: options.id }); });
  app.use('/a2a', async (req, res, next) => {
    try {
      const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1]; if (!token) { res.status(401).json({ error: 'Contact token required' }); return; }
      const claims = await verifyContact(token, options.publicJwk, options.id);
      // Expose only the messaging surface required by this contract. This prevents a
      // token for one run from reading another run's tasks through generic SDK APIs.
      if (req.body?.method !== 'SendMessage') { res.status(403).json({ error: 'Only SendMessage is enabled for the local contract' }); return; }
      const command = commandSchema.parse(req.body?.params?.message?.parts?.find((p: { data?: unknown }) => p.data)?.data);
      if (claims.runId !== command.runId || !claims.actions.includes(command.action)) { res.status(403).json({ error: 'Contact token scope mismatch' }); return; }
      next();
    } catch { res.status(401).json({ error: 'Invalid or expired contact authorization' }); }
  }, jsonRpcHandler({ requestHandler: handler, userBuilder: async req => ({ isAuthenticated: true, userName: (await verifyContact(req.headers.authorization!.slice(7), options.publicJwk, options.id)).sub! }) }));
  return { app, card };
}
