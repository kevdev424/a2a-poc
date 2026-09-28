/** A minimal, independently implemented A2A participant using Node HTTP.
 * It intentionally does not import the reference agent or the SDK server.
 * See docs/agent-integration.md for provisioning and launch instructions. */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { commandSchema, CONTRACT, fixtureAvailability, slotKey, type Fixture, type Run } from '../packages/shared/src/contract.js';
import { verifyContact } from '../packages/shared/src/auth.js';
import { guardedFetch } from '../packages/shared/src/a2a.js';
import type { JWK } from 'jose';

const id = process.env.AGENT_ID || 'cedar'; const name = process.env.AGENT_NAME || 'Cedar'; const port = Number(process.env.AGENT_PORT || 4204);
const platformUrl = process.env.PLATFORM_URL || 'http://127.0.0.1:4100';
const fixture: Fixture = process.env.AGENT_FIXTURE ? JSON.parse(process.env.AGENT_FIXTURE) : { timezone: 'America/New_York', startHour: 18, endHour: 22, preferredHour: 19 };
const safeFetch = guardedFetch([new URL(platformUrl).origin]);
const jwks = await safeFetch(`${platformUrl}/api/jwks`); if (!jwks.ok) throw new Error('Platform key unavailable'); const { keys } = await jwks.json() as { keys: JWK[] };
const card = { name, description: 'An independently implemented scheduling participant.', version: '1.0.0',
  supportedInterfaces: [{ url: `http://127.0.0.1:${port}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  capabilities: { streaming: false, extensions: [{ uri: CONTRACT, required: true, params: { agentId: id } }] },
  securitySchemes: { kin: { httpAuthSecurityScheme: { scheme: 'bearer', bearerFormat: 'JWT' } } }, securityRequirements: [{ schemes: { kin: { list: [] } } }],
  defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'],
  skills: [{ id: 'schedule-participate', name: 'Participate in scheduling', description: 'Shares permitted availability and votes on proposals.', tags: ['scheduling'] }],
};
async function platform<T>(path: string, body?: unknown): Promise<T> {
  const credential = process.env.AGENT_CREDENTIAL_FILE ? readFileSync(process.env.AGENT_CREDENTIAL_FILE, 'utf8').trim() : process.env.AGENT_CREDENTIAL || '';
  const response = await safeFetch(`${platformUrl}/api/agent${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`Platform rejected operation (${response.status})`); return await response.json() as T;
}
const server = createServer(async (req, res) => {
  function reply(status: number, data: unknown) { res.writeHead(status, { 'Content-Type': 'application/json', 'A2A-Version': '1.0', 'A2A-Extensions': CONTRACT }); res.end(JSON.stringify(data)); }
  if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') { reply(200, card); return; }
  if (req.method === 'GET' && req.url === '/health') { reply(200, { status: 'ok', agentId: id }); return; }
  if (req.method !== 'POST' || req.url !== '/a2a') { reply(404, { error: 'Not found' }); return; }
  try {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1]; if (!token) { reply(401, { error: 'Contact token required' }); return; }
    const claims = await verifyContact(token, keys[0]!, id);
    let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 128_000) { reply(413, { error: 'Payload too large' }); return; } }
    const rpc = JSON.parse(raw) as { jsonrpc: string; id: string; method: string; params: { message: { parts: { data?: unknown }[] } } };
    if (rpc.jsonrpc !== '2.0' || rpc.method !== 'SendMessage') { reply(403, { error: 'Only SendMessage is supported' }); return; }
    const command = commandSchema.parse(rpc.params.message.parts.find(p => p.data)?.data);
    if (command.action === 'start' || claims.runId !== command.runId || !claims.actions.includes(command.action)) { reply(403, { error: 'Command outside contact scope' }); return; }
    const run = await platform<Run>(`/runs/${command.runId}`);
    if (claims.sub !== run.leaderAgentId || JSON.stringify(command.request) !== JSON.stringify(run.request) || Math.abs(Date.now() - Date.parse(command.sentAt)) > 300_000) { reply(403, { error: 'Unauthorized scheduling command' }); return; }
    const taskId = randomUUID(), contextId = randomUUID();
    await platform(`/runs/${run.id}/traces`, { direction: 'incoming', peerAgentId: claims.sub, action: command.action, taskId, contextId });
    console.log(JSON.stringify({ agent: id, from: claims.sub, action: command.action, runId: run.id, taskId }));
    const availability = fixtureAvailability(command.request, fixture);
    const base = { contract: CONTRACT, runId: run.id, sentAt: new Date().toISOString() };
    let answer;
    if (command.action === 'availability') {
      answer = { ...base, action: 'availability', availability };
      await platform(`/runs/${run.id}/activity`, { eventId: 'availability', kind: 'availability', text: 'Shared my permitted availability from an independent A2A implementation.' });
    } else {
      const accepted = availability.slots.some(s => slotKey(s) === slotKey(command.slot));
      await platform(`/runs/${run.id}/receipts`, { revision: command.revision, slot: command.slot, accepted });
      answer = { ...base, action: 'vote', revision: command.revision, slot: command.slot, accepted };
      await platform(`/runs/${run.id}/activity`, { eventId: `vote:${command.revision}`, kind: 'negotiation', text: accepted ? 'This time works. My person will make the final decision.' : 'Please try another option.' });
    }
    reply(200, { jsonrpc: '2.0', id: rpc.id, result: { task: { id: taskId, contextId, status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() }, artifacts: [{ artifactId: randomUUID(), name: 'Scheduling result', parts: [{ data: answer, mediaType: 'application/json' }] }] } } });
  } catch { reply(401, { error: 'Invalid authorization or scheduling request' }); }
});
server.listen(port, '127.0.0.1', () => console.log(`${name} ready at http://127.0.0.1:${port}`));
function stop() { server.close(() => process.exit(0)); server.closeAllConnections(); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);
