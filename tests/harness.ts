import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import assert from 'node:assert/strict';
import { createApp } from '../apps/server/src/app.js';
import type { AppState, Fixture, Run, ScheduleRequest } from '../packages/shared/src/contract.js';

export const request: ScheduleRequest = { title: 'Dinner with friends', from: '2026-10-03', to: '2026-10-05', durationMinutes: 60, timezone: 'America/New_York' };
export async function waitUntil<T>(work: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs; let value: T | undefined;
  while (Date.now() < deadline) { value = await work(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 50)); }
  throw new Error(`Timed out waiting for condition. Last value: ${JSON.stringify(value)}`);
}
export type HarnessOptions = { fixtures?: Record<string, Partial<Fixture>>; modes?: Record<string, Record<string, string>>; negotiationMs?: number; externalCarol?: boolean };
export async function harness(options: HarnessOptions = {}) {
  const directory = resolve('.data', `test-${randomUUID()}`); const port = 4400; const basePort = 4301; const platformUrl = `http://127.0.0.1:${port}`;
  const origins = [4301, 4302, 4303, 4304, 4305].map(p => `http://127.0.0.1:${p}`);
  const runtime = await createApp({ directory, port, agentBasePort: basePort, allowedOrigins: origins, negotiationMs: options.negotiationMs });
  const server: Server = runtime.app.listen(port, '127.0.0.1'); await once(server, 'listening');
  const children = new Map<string, ChildProcess>(); const output: string[] = []; const cookies = new Map<string, string>(); const credentials = new Map<string, string>();
  async function json(path: string, body?: unknown, profile = 'alice', credential?: string) {
    const response = await fetch(platformUrl + '/api' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Request': '1', Cookie: cookies.get(profile) || '', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.json() as any, response };
  }
  async function ok(path: string, body?: unknown, profile = 'alice', credential?: string) { const result = await json(path, body, profile, credential); assert.ok(result.status < 300, `${path}: HTTP ${result.status} ${JSON.stringify(result.body)}`); return result.body; }
  async function launch(id: string, agentPort: number, extra: Record<string, string> = {}, credential?: string) {
    const fixture: Fixture = { timezone: 'America/New_York', startHour: 18, endHour: 22, preferredHour: id.endsWith('bob') ? 20 : 19, ...options.fixtures?.[id] };
    const entry = id === 'external-carol' ? 'examples/participant.ts' : 'apps/agent/src/main.ts';
    const child = spawn(process.execPath, ['--import', 'tsx', entry], { cwd: process.cwd(), env: { ...process.env, DATA_DIR: directory, PLATFORM_URL: platformUrl, AGENT_ID: id, AGENT_PORT: String(agentPort), AGENT_NAME: id === 'external-carol' ? 'Cedar (external)' : id.replace('sample-', ''), ALLOWED_AGENT_ORIGINS: origins.join(','), AGENT_FIXTURE: JSON.stringify(fixture), AGENT_CALL_TIMEOUT_MS: '1000', ...(credential ? { AGENT_CREDENTIAL: credential } : {}), ...options.modes?.[id], ...extra }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.set(id, child); child.stdout?.on('data', data => output.push(String(data))); child.stderr?.on('data', data => output.push(String(data)));
    await waitUntil(async () => { if (child.exitCode !== null) throw new Error(output.join('\n')); try { return (await fetch(`http://127.0.0.1:${agentPort}/health`, { signal: AbortSignal.timeout(200) })).ok; } catch { return false; } }, value => value, 15_000);
  }
  async function stopAgent(id: string) { const child = children.get(id); if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } children.delete(id); }
  async function close() { runtime.close(); const stopped = new Promise<void>(r => server.close(() => r())); server.closeAllConnections(); await stopped; for (const id of children.keys()) await stopAgent(id); }
  try {
    for (const id of ['alice', 'bob', 'carol']) { const session = await json('/session', { userId: id }); assert.equal(session.status, 200); cookies.set(id, session.response.headers.get('set-cookie')!.split(';')[0]!); }
    for (const sample of runtime.config.samples) {
      if (options.externalCarol && sample.userId === 'carol') { await launch('external-carol', 4304); const result = await ok('/agents/register', { cardUrl: 'http://127.0.0.1:4304/.well-known/agent-card.json' }, 'carol'); credentials.set('external-carol', result.platformCredential); await stopAgent('external-carol'); await launch('external-carol', 4304, {}, result.platformCredential); }
      else { await launch(sample.agentId, sample.port); const result = await ok('/agents/register', { cardUrl: `http://127.0.0.1:${sample.port}/.well-known/agent-card.json` }, sample.userId); credentials.set(sample.agentId, result.platformCredential); }
    }
    for (const target of ['bob', 'carol']) { const f = await ok('/friends', { userId: target }); await ok(`/friends/${f.id}/accept`, {}, target); }
    const group = await ok('/groups', { name: 'The weekend crew', userIds: ['bob', 'carol'] });
    for (const id of ['alice', 'bob', 'carol']) await ok(`/groups/${group.id}/permission`, { enabled: true }, id);
    async function state(profile = 'alice') { return await ok('/state', undefined, profile) as AppState; }
    async function run(schedule = request): Promise<Run> { const started = await ok(`/groups/${group.id}/runs`, schedule) as Run; return waitUntil(async () => (await state()).runs.find(r => r.id === started.id)!, r => r.status !== 'negotiating'); }
    return { runtime, server, platformUrl, directory, children, output, credentials, cookies, group, json, ok, state, run, launch, stopAgent, close };
  } catch (error) { await close(); throw error; }
}
