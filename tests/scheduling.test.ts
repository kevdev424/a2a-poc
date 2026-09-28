import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { fixtureAvailability, rankSlots, requestSchema, slotKey, validSlot } from '../packages/shared/src/contract.js';
import { assertOrigin } from '../packages/shared/src/a2a.js';
import { issueContact, makeKeys, verifyContact } from '../packages/shared/src/auth.js';
import { calendarEvent } from '../packages/shared/src/ical.js';
import { request } from './harness.js';
import type { Run } from '../packages/shared/src/contract.js';

test('ranks shared slots by combined preference, then earliest instant', () => {
  const slots = ['2026-10-04T22:00:00Z', '2026-10-04T23:00:00Z', '2026-10-05T00:00:00Z'].map(start => ({ start, end: DateTime.fromISO(start).plus({ hours: 1 }).toUTC().toISO()! }));
  const ranked = rankSlots([{ slots: slots.map((s, i) => ({ ...s, preference: [10, 8, 9][i]! })) }, { slots: slots.map((s, i) => ({ ...s, preference: [4, 10, 9][i]! })) }], request);
  assert.equal(slotKey(ranked[0]!), slotKey(slots[1]!)); assert.equal(slotKey(ranked[1]!), slotKey(slots[2]!));
  assert.deepEqual(rankSlots([{ slots: [{ ...slots[0]!, preference: 10 }] }, { slots: [{ ...slots[1]!, preference: 10 }] }], request), []);
});
test('timezone ranges preserve duration across both DST transitions', () => {
  for (const day of ['2026-03-08', '2026-11-01']) {
    const scheduling = { ...request, from: day, to: day, durationMinutes: 60 };
    const availability = fixtureAvailability(scheduling, { timezone: 'America/New_York', startHour: 0, endHour: 5, preferredHour: 2 });
    assert.ok(availability.slots.length > 0); assert.ok(availability.slots.every(s => validSlot(s, scheduling)));
    const london = fixtureAvailability(scheduling, { timezone: 'Europe/London', startHour: 5, endHour: 12, preferredHour: 7 });
    assert.ok(rankSlots([availability, london], scheduling).length > 0);
  }
});
test('validates date bounds, timezone, duration, and rejects wrong-duration candidates', () => {
  assert.equal(requestSchema.safeParse({ ...request, timezone: 'not/a-zone' }).success, false);
  assert.equal(requestSchema.safeParse({ ...request, to: '2026-10-01' }).success, false);
  assert.equal(requestSchema.safeParse({ ...request, to: '2026-12-01' }).success, false);
  assert.equal(requestSchema.safeParse({ ...request, durationMinutes: 0 }).success, false);
  assert.equal(validSlot({ start: '2026-10-04T22:00:00Z', end: '2026-10-04T23:30:00Z' }, request), false);
});
test('development destination policy rejects unlisted origins and embedded credentials', () => {
  const origins = ['http://127.0.0.1:4201'];
  assert.equal(assertOrigin(origins[0]! + '/a2a', origins).port, '4201');
  for (const url of ['http://127.0.0.1:9999/a2a', 'http://example.com/a2a', 'http://token@127.0.0.1:4201/a2a', 'file:///etc/passwd']) assert.throws(() => assertOrigin(url, origins));
});
test('contact JWTs bind sender, recipient, run, allowed actions and expiry', async () => {
  const keys = await makeKeys(); const token = await issueContact(keys.privateJwk, 'alice-agent', 'bob-agent', 'run-1', ['availability'], new Date(Date.now() + 60_000).toISOString());
  const verified = await verifyContact(token, keys.publicJwk, 'bob-agent'); assert.equal(verified.sub, 'alice-agent'); assert.equal(verified.runId, 'run-1'); assert.deepEqual(verified.actions, ['availability']);
  await assert.rejects(verifyContact(token, keys.publicJwk, 'carol-agent'));
  await assert.rejects(verifyContact(token.slice(0, -5) + 'aaaaa', keys.publicJwk, 'bob-agent'));
  const expired = await issueContact(keys.privateJwk, 'alice-agent', 'bob-agent', 'run-1', ['availability'], new Date(Date.now() - 1000).toISOString());
  await assert.rejects(verifyContact(expired, keys.publicJwk, 'bob-agent'));
});
test('calendar export is approval-gated, stable, escaped, and byte-folded', () => {
  const run = { id: 'run-1', status: 'approved', createdAt: '2026-10-01T12:00:00Z', request: { ...request, title: 'Dinner, friends; with a long title ' + 'é'.repeat(80) }, proposal: { start: '2026-10-04T23:00:00Z', end: '2026-10-05T00:00:00Z', revision: 1, uid: 'run-1@kin.local' } } as Run;
  const event = calendarEvent(run, []); assert.equal(event, calendarEvent(run, [])); assert.match(event, /UID:run-1@kin.local/); assert.match(event, /DTSTART:20261004T230000Z/); assert.match(event, /Dinner\\, friends\\;/);
  assert.ok(event.split('\r\n').every(line => Buffer.byteLength(line) <= 75)); assert.equal((event.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.throws(() => calendarEvent({ ...run, status: 'awaiting_approval' }, []));
});
