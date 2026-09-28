import { randomUUID } from 'node:crypto';
import { AgentCard, Message, Task, TaskState, type SendMessageResult } from '@a2a-js/sdk';
import { ClientFactory, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { CONTRACT, type Command } from './contract.js';

export function assertOrigin(raw: string, origins: string[]): URL {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !origins.includes(url.origin) || url.hash) throw new Error('Destination is not an allowed development origin');
  return url;
}
export function guardedFetch(origins: string[], timeoutMs = 15_000): typeof fetch {
  return async (input, init) => {
    assertOrigin(input instanceof Request ? input.url : String(input), origins);
    return fetch(input, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  };
}
export async function loadCard(url: string, origins: string[]) {
  const response = await guardedFetch(origins, 5000)(url, { headers: { 'A2A-Version': '1.0' } });
  if (!response.ok) throw new Error(`Agent Card returned HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 100_000) throw new Error('Agent Card is too large');
  const card = AgentCard.fromJSON(JSON.parse(text));
  if (!card.name || card.name.length > 100 || !card.version) throw new Error('Invalid Agent Card');
  const endpoint = card.supportedInterfaces.find(i => i.protocolBinding === 'JSONRPC' && i.protocolVersion === '1.0');
  if (!endpoint) throw new Error('Agent must advertise A2A 1.0 JSON-RPC');
  assertOrigin(endpoint.url, origins);
  if (!card.capabilities?.extensions.some(e => e.uri === CONTRACT)) throw new Error('Agent does not implement the Kin scheduling v1 contract');
  const canLead = card.skills.some(s => s.id === 'schedule-lead');
  const canParticipate = card.skills.some(s => s.id === 'schedule-participate');
  if (!canParticipate) throw new Error('Agent must advertise schedule-participate');
  // Limit the SDK to the validated interface rather than any other advertised endpoint.
  return { card: { ...card, supportedInterfaces: [endpoint] }, canLead, canParticipate };
}
export async function callAgent(card: AgentCard, command: Command, token: string, origins: string[], timeoutMs = 15_000): Promise<SendMessageResult> {
  const client = await new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: guardedFetch(origins, timeoutMs) })] }).createFromAgentCard(card);
  return client.sendMessage({
    message: Message.fromJSON({ messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data: command, mediaType: 'application/json' }], extensions: [CONTRACT] }),
    configuration: undefined, metadata: undefined, tenant: '',
  }, { signal: AbortSignal.timeout(timeoutMs), serviceParameters: { Authorization: `Bearer ${token}`, 'A2A-Extensions': CONTRACT } });
}
export function resultData(result: SendMessageResult): unknown {
  const messages = 'status' in result ? [...result.artifacts.flatMap(a => a.parts), ...result.history.flatMap(m => m.parts)] : result.parts;
  if ('status' in result && result.status?.state !== TaskState.TASK_STATE_COMPLETED) throw new Error('Agent task did not complete');
  return messages.find(p => p.content?.$case === 'data')?.content?.value;
}
export function taskIds(result: SendMessageResult) {
  return 'status' in result ? { taskId: result.id, contextId: result.contextId } : { taskId: result.taskId, contextId: result.contextId };
}
export { AgentCard, Message, Task };
