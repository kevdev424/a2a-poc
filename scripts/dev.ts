import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { bootstrap } from '../apps/server/src/store.js';
const root = process.cwd(); const directory = resolve(process.env.DATA_DIR || '.data');
const config = await bootstrap(directory, Number(process.env.AGENT_BASE_PORT || 4201));
const port = Number(process.env.PORT || 4100); const webPort = Number(process.env.WEB_PORT || 5173);
const platformUrl = `http://127.0.0.1:${port}`;
const allowedOrigins = process.env.ALLOWED_AGENT_ORIGINS || config.samples.map(s => `http://127.0.0.1:${s.port}`).join(',');
const children: ChildProcess[] = []; let stopping = false;
function start(label: string, args: string[], extra: Record<string, string> = {}, cwd = root) {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, DATA_DIR: directory, PORT: String(port), WEB_PORT: String(webPort), PLATFORM_URL: platformUrl, ALLOWED_AGENT_ORIGINS: allowedOrigins, ...extra }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  for (const source of [child.stdout, child.stderr]) source?.on('data', data => process.stdout.write(`[${label}] ${data}`));
  child.once('exit', code => { if (!stopping) { console.error(`${label} exited (${code}). Stopping the demo.`); stop(code || 1); } }); children.push(child); return child;
}
function stop(code = 0) { if (stopping) return; stopping = true; for (const child of children) child.kill(); setTimeout(() => process.exit(code), 500).unref(); }
process.once('SIGINT', () => stop()); process.once('SIGTERM', () => stop());
async function ready(url: string) { for (let i = 0; i < 100; i++) { try { const res = await fetch(url, { signal: AbortSignal.timeout(500) }); if (res.ok) return; } catch { /* still starting */ } await new Promise(r => setTimeout(r, 100)); } throw new Error(`Service did not start: ${url}`); }
try {
  start('platform', ['--import', 'tsx', 'apps/server/src/main.ts']); await ready(`${platformUrl}/api/health`);
  for (const sample of config.samples) start(sample.name, ['--import', 'tsx', 'apps/agent/src/main.ts'], { AGENT_ID: sample.agentId, AGENT_PORT: String(sample.port), AGENT_CREDENTIAL: sample.credential });
  await Promise.all(config.samples.map(s => ready(`http://127.0.0.1:${s.port}/health`)));
  start('web', [resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1'], {}, resolve('apps/web'));
  console.log(`\nKin is starting at http://127.0.0.1:${webPort}\nThree separate personal agents are ready. Ctrl+C stops all services.\n`);
} catch (error) { console.error(error instanceof Error ? error.message : 'Startup failed'); stop(1); }
