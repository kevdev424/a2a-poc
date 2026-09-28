import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAgent } from './agent.js';
import type { Bootstrap } from '../../server/src/store.js';
import type { Fixture } from '../../../packages/shared/src/contract.js';
const id = process.env.AGENT_ID || 'sample-alice';
const configPath = resolve(process.env.DATA_DIR || '.data', 'dev-secrets.json');
const config: Bootstrap | undefined = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : undefined;
const sample = config?.samples.find(s => s.agentId === id);
const platformUrl = process.env.PLATFORM_URL || 'http://127.0.0.1:4100';
const response = await fetch(`${platformUrl}/api/jwks`, { signal: AbortSignal.timeout(10_000) });
if (!response.ok) throw new Error('Platform public key is unavailable');
const { keys } = await response.json() as { keys: import('jose').JWK[] };
const port = Number(process.env.AGENT_PORT || sample?.port || 4204);
const fixture: Fixture = process.env.AGENT_FIXTURE ? JSON.parse(process.env.AGENT_FIXTURE) : { timezone: 'America/New_York', startHour: id === 'sample-bob' ? 17 : 18, endHour: 22, preferredHour: id === 'sample-bob' ? 20 : 19 };
const runtime = createAgent({ id, name: process.env.AGENT_NAME || sample?.name || 'Your agent', port, platformUrl, publicJwk: keys[0]!,
  credential: () => process.env.AGENT_CREDENTIAL_FILE ? readFileSync(process.env.AGENT_CREDENTIAL_FILE, 'utf8').trim() : process.env.AGENT_CREDENTIAL || sample?.credential || '', fixture,
  allowedOrigins: process.env.ALLOWED_AGENT_ORIGINS?.split(',').map(s => s.trim()) || config?.samples.map(s => `http://127.0.0.1:${s.port}`) || [],
  callTimeoutMs: process.env.AGENT_CALL_TIMEOUT_MS ? Number(process.env.AGENT_CALL_TIMEOUT_MS) : undefined,
  delayMs: process.env.AGENT_DELAY_MS ? Number(process.env.AGENT_DELAY_MS) : undefined,
  malformed: process.env.AGENT_MALFORMED === '1', participantOnly: process.env.AGENT_PARTICIPANT_ONLY === '1',
});
const server = runtime.app.listen(port, '127.0.0.1', () => console.log(`${process.env.AGENT_NAME || sample?.name || id} ready at http://127.0.0.1:${port}`));
function stop() { server.close(() => process.exit(0)); server.closeAllConnections(); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);
