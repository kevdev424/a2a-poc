import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { makeKeys } from '../../../packages/shared/src/auth.js';
import type { JWK } from 'jose';
import type { Activity, AppState, Friendship, Group, PublicAgent, Run, Trace, User } from '../../../packages/shared/src/contract.js';
import type { AgentCard } from '@a2a-js/sdk';

export type AgentRecord = PublicAgent & { credentialHash: string; card: AgentCard };
export type Bootstrap = { privateJwk: JWK; publicJwk: JWK; samples: { userId: string; agentId: string; name: string; port: number; credential: string }[] };
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export async function bootstrap(directory: string, basePort = 4201): Promise<Bootstrap> {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'dev-secrets.json');
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as Bootstrap;
  const keys = await makeKeys();
  const config: Bootstrap = { ...keys, samples: ['alice', 'bob', 'carol'].map((userId, index) => ({ userId, agentId: `sample-${userId}`, name: ['Maple', 'Orbit', 'Juniper'][index]!, port: basePort + index, credential: randomBytes(32).toString('base64url') })) };
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 }); return config;
}

export class Store {
  readonly db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'kin.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, timezone TEXT NOT NULL, color TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id));
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id), credential_hash TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS friends (id TEXT PRIMARY KEY, from_id TEXT NOT NULL REFERENCES users(id), to_id TEXT NOT NULL REFERENCES users(id), pair TEXT NOT NULL UNIQUE, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id));
      CREATE TABLE IF NOT EXISTS members (group_id TEXT NOT NULL REFERENCES groups(id), user_id TEXT NOT NULL REFERENCES users(id), enabled INTEGER NOT NULL DEFAULT 0, agent_id TEXT, PRIMARY KEY(group_id,user_id));
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS activities (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, run_id TEXT, actor_id TEXT, actor_name TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, event_key TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS approvals (run_id TEXT NOT NULL REFERENCES runs(id), user_id TEXT NOT NULL REFERENCES users(id), revision INTEGER NOT NULL, decision TEXT NOT NULL, PRIMARY KEY(run_id,user_id,revision));
      CREATE TABLE IF NOT EXISTS receipts (run_id TEXT NOT NULL REFERENCES runs(id), agent_id TEXT NOT NULL, revision INTEGER NOT NULL, slot_key TEXT NOT NULL, accepted INTEGER NOT NULL, PRIMARY KEY(run_id,agent_id,revision));
      CREATE TABLE IF NOT EXISTS traces (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), sender_id TEXT NOT NULL, recipient_id TEXT NOT NULL, action TEXT NOT NULL, task_id TEXT NOT NULL, context_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(run_id,sender_id,recipient_id,action,task_id));
    `);
    const seed = this.db.prepare('INSERT OR IGNORE INTO users VALUES (?,?,?,?)');
    seed.run('alice', 'Alice Chen', 'America/New_York', 'peach');
    seed.run('bob', 'Bob Rivera', 'America/New_York', 'lavender');
    seed.run('carol', 'Carol Park', 'America/New_York', 'sage');
    for (const row of this.all<{ data: string }>('SELECT data FROM runs')) {
      const run = JSON.parse(row.data) as Run;
      if (run.status === 'negotiating') {
        run.status = 'interrupted'; run.error = 'The platform restarted. Start a new scheduling request.'; this.saveRun(run);
        this.activity(run.groupId, run.id, null, 'Platform', 'interrupted', run.error, `restart:${run.id}`);
      }
    }
  }
  all<T>(sql: string, ...params: (string | number | null)[]): T[] { return this.db.prepare(sql).all(...params) as unknown as T[]; }
  one<T>(sql: string, ...params: (string | number | null)[]): T | undefined { return this.db.prepare(sql).get(...params) as unknown as T | undefined; }
  execute(sql: string, ...params: (string | number | null)[]) { return this.db.prepare(sql).run(...params); }
  transaction<T>(work: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value = work(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  users() { return this.all<User>('SELECT * FROM users ORDER BY rowid'); }
  user(id: string) { return this.one<User>('SELECT * FROM users WHERE id=?', id); }
  agents(): AgentRecord[] { return this.all<{ data: string }>('SELECT data FROM agents').map(r => JSON.parse(r.data)); }
  agent(id: string): AgentRecord | undefined { return this.agents().find(a => a.id === id); }
  userAgent(userId: string) { return this.agents().find(a => a.userId === userId); }
  credential(token: string) { const row = this.one<{ data: string }>('SELECT data FROM agents WHERE credential_hash=?', hash(token)); return row ? JSON.parse(row.data) as AgentRecord : undefined; }
  saveAgent(agent: AgentRecord) { this.execute('INSERT INTO agents VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, credential_hash=excluded.credential_hash', agent.id, agent.userId, agent.credentialHash, JSON.stringify(agent)); }
  groups(): Group[] { return this.all<{ id: string; name: string; created_by: string }>('SELECT * FROM groups ORDER BY rowid').map(g => ({ id: g.id, name: g.name, createdBy: g.created_by, members: this.all<{ user_id: string; enabled: number; agent_id: string | null }>('SELECT * FROM members WHERE group_id=?', g.id).map(m => ({ userId: m.user_id, enabled: !!m.enabled, agentId: m.agent_id })) })); }
  group(id: string) { return this.groups().find(g => g.id === id); }
  friends(): Friendship[] { return this.all<{ id: string; from_id: string; to_id: string; status: 'pending' | 'accepted' }>('SELECT * FROM friends').map(f => ({ id: f.id, fromId: f.from_id, toId: f.to_id, status: f.status })); }
  run(id: string): Run | undefined { const row = this.one<{ data: string }>('SELECT data FROM runs WHERE id=?', id); if (!row) return undefined; const run = JSON.parse(row.data) as Run; run.approvals = this.all<Run['approvals'][number]>('SELECT user_id AS userId, revision, decision FROM approvals WHERE run_id=?', id); return run; }
  runs() { return this.all<{ id: string }>('SELECT id FROM runs ORDER BY rowid DESC').map(r => this.run(r.id)!); }
  saveRun(run: Run) { this.execute('INSERT INTO runs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', run.id, run.groupId, JSON.stringify({ ...run, approvals: [] })); }
  activity(groupId: string, runId: string | null, actorId: string | null, actorName: string, kind: string, text: string, key: string) {
    return this.execute('INSERT OR IGNORE INTO activities VALUES (?,?,?,?,?,?,?,?,?)', randomUUID(), groupId, runId, actorId, actorName, kind, text, new Date().toISOString(), key).changes > 0;
  }
  trace(trace: Omit<Trace, 'id' | 'createdAt'>) { this.execute('INSERT OR IGNORE INTO traces VALUES (?,?,?,?,?,?,?,?)', randomUUID(), trace.runId, trace.senderId, trace.recipientId, trace.action, trace.taskId, trace.contextId, new Date().toISOString()); }
  state(userId: string, config: Bootstrap): AppState {
    const groups = this.groups().filter(g => g.members.some(m => m.userId === userId));
    const ids = new Set(groups.map(g => g.id)); const runs = this.runs().filter(r => ids.has(r.groupId)); const runIds = new Set(runs.map(r => r.id));
    return { currentUser: this.user(userId)!, users: this.users(), agents: this.agents().map(({ card, credentialHash, ...publicAgent }) => publicAgent),
      friends: this.friends().filter(f => f.fromId === userId || f.toId === userId), groups, runs,
      activities: this.all<Activity>('SELECT id, group_id AS groupId, run_id AS runId, actor_id AS actorId, actor_name AS actorName, kind, text, created_at AS createdAt FROM activities ORDER BY rowid').filter(a => ids.has(a.groupId)),
      traces: this.all<Trace>('SELECT id, run_id AS runId, sender_id AS senderId, recipient_id AS recipientId, action, task_id AS taskId, context_id AS contextId, created_at AS createdAt FROM traces ORDER BY rowid').filter(t => runIds.has(t.runId)),
      samples: config.samples.map(s => ({ userId: s.userId, cardUrl: `http://127.0.0.1:${s.port}/.well-known/agent-card.json` })),
    };
  }
  close() { this.db.close(); }
}
