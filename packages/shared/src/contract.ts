import { z } from 'zod';
import { DateTime, IANAZone } from 'luxon';

export const CONTRACT = 'https://kin.local/contracts/scheduling/v1';
export const MAX_PROPOSALS = 3;
export const NEGOTIATION_MS = 120_000;
const instant = z.iso.datetime({ offset: true });
export const requestSchema = z.object({
  title: z.string().trim().min(1).max(120),
  from: z.iso.date(), to: z.iso.date(),
  durationMinutes: z.number().int().min(15).max(240),
  timezone: z.string().refine(zone => IANAZone.isValidZone(zone), 'Use an IANA timezone'),
}).strict().superRefine((value, context) => {
  const days = DateTime.fromISO(value.to).diff(DateTime.fromISO(value.from), 'days').days;
  if (days < 0 || days > 30) context.addIssue({ code: 'custom', message: 'Choose a date range of 1–31 days', path: ['to'] });
});
export type ScheduleRequest = z.infer<typeof requestSchema>;
export const slotSchema = z.object({ start: instant, end: instant }).strict().refine(s => Date.parse(s.end) > Date.parse(s.start), 'Slot must have a positive duration');
export type Slot = z.infer<typeof slotSchema>;
export const availabilitySchema = z.object({ slots: z.array(slotSchema.safeExtend({ preference: z.number().int().min(0).max(10) })).max(10_000) }).strict();
export type Availability = z.infer<typeof availabilitySchema>;
const base = { contract: z.literal(CONTRACT), runId: z.string().min(1).max(100), sentAt: instant };
export const commandSchema = z.discriminatedUnion('action', [
  z.object({ ...base, action: z.literal('start'), request: requestSchema }).strict(),
  z.object({ ...base, action: z.literal('availability'), request: requestSchema }).strict(),
  z.object({ ...base, action: z.literal('propose'), request: requestSchema, revision: z.number().int().min(1).max(MAX_PROPOSALS), slot: slotSchema }).strict(),
]);
export type Command = z.infer<typeof commandSchema>;
export const answerSchema = z.discriminatedUnion('action', [
  z.object({ ...base, action: z.literal('availability'), availability: availabilitySchema }).strict(),
  z.object({ ...base, action: z.literal('vote'), revision: z.number().int().min(1).max(MAX_PROPOSALS), slot: slotSchema, accepted: z.boolean(), reason: z.string().max(200).optional() }).strict(),
  z.object({ ...base, action: z.literal('finished'), outcome: z.enum(['proposed', 'failed']) }).strict(),
]);
export type Answer = z.infer<typeof answerSchema>;

export type User = { id: string; name: string; timezone: string; color: string };
export type PublicAgent = { id: string; userId: string; name: string; cardUrl: string; canLead: boolean; canParticipate: boolean; status: string; checkedAt: string; skills: string[] };
export type Member = { userId: string; enabled: boolean; agentId: string | null };
export type Group = { id: string; name: string; createdBy: string; members: Member[] };
export type Friendship = { id: string; fromId: string; toId: string; status: 'pending' | 'accepted' };
export type Proposal = Slot & { revision: number; uid: string };
export type Run = { id: string; groupId: string; initiatorId: string; leaderAgentId: string; request: ScheduleRequest; status: 'negotiating' | 'awaiting_approval' | 'approved' | 'rejected' | 'failed' | 'interrupted'; createdAt: string; deadline: string; participants: { userId: string; agentId: string }[]; proposal: Proposal | null; error: string | null; approvals: { userId: string; revision: number; decision: string }[] };
export type Activity = { id: string; groupId: string; runId: string | null; actorId: string | null; actorName: string; kind: string; text: string; createdAt: string };
export type Trace = { id: string; runId: string; senderId: string; recipientId: string; action: string; taskId: string; contextId: string; createdAt: string };
export type AppState = { currentUser: User; users: User[]; agents: PublicAgent[]; friends: Friendship[]; groups: Group[]; runs: Run[]; activities: Activity[]; traces: Trace[]; samples: { userId: string; cardUrl: string }[] };

export function range(request: ScheduleRequest) {
  return { start: DateTime.fromISO(request.from, { zone: request.timezone }).startOf('day').toMillis(), end: DateTime.fromISO(request.to, { zone: request.timezone }).plus({ days: 1 }).startOf('day').toMillis() };
}
export function validSlot(slot: Slot, request: ScheduleRequest): boolean {
  const bounds = range(request);
  return Date.parse(slot.start) >= bounds.start && Date.parse(slot.end) <= bounds.end && Date.parse(slot.end) - Date.parse(slot.start) === request.durationMinutes * 60_000;
}
export function slotKey(slot: Slot) { return `${Date.parse(slot.start)}/${Date.parse(slot.end)}`; }

/** Each agent advertises exact candidate slots, with preferences from 0 to 10. */
export function rankSlots(all: Availability[], request: ScheduleRequest): Slot[] {
  if (!all.length) return [];
  const maps = all.map(a => new Map(a.slots.filter(s => validSlot(s, request)).map(s => [slotKey(s), s])));
  return [...maps[0]!.values()].filter(s => maps.every(m => m.has(slotKey(s))))
    .sort((a, b) => maps.reduce((sum, m) => sum + m.get(slotKey(b))!.preference - m.get(slotKey(a))!.preference, 0) || Date.parse(a.start) - Date.parse(b.start))
    .map(({ start, end }) => ({ start, end }));
}

export type Fixture = { timezone: string; startHour: number; endHour: number; preferredHour: number; unavailable?: boolean; rejectFirst?: boolean; rejectAll?: boolean };
export function fixtureAvailability(request: ScheduleRequest, fixture: Fixture): Availability {
  if (fixture.unavailable) return { slots: [] };
  const bounds = range(request);
  const slots: Availability['slots'] = [];
  // Walk UTC instants to handle missing/repeated wall-clock times at DST changes.
  for (let time = bounds.start; time + request.durationMinutes * 60_000 <= bounds.end; time += 15 * 60_000) {
    const start = DateTime.fromMillis(time, { zone: fixture.timezone });
    const end = DateTime.fromMillis(time + request.durationMinutes * 60_000, { zone: fixture.timezone });
    if (start.hour >= fixture.startHour && end.hour + end.minute / 60 <= fixture.endHour && start.toISODate() === end.toISODate()) {
      slots.push({ start: start.toUTC().toISO()!, end: end.toUTC().toISO()!, preference: Math.max(0, 10 - Math.round(Math.abs(start.hour + start.minute / 60 - fixture.preferredHour) * 2)) });
    }
  }
  return { slots };
}
