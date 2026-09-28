import type { Run, User } from './contract.js';
function escape(value: string) { return value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,'); }
function timestamp(value: string) { return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
function fold(line: string) {
  const output: string[] = []; let current = '';
  for (const char of line) {
    if (Buffer.byteLength(current + char, 'utf8') > 75) { output.push(current); current = ' '; }
    current += char;
  }
  output.push(current); return output.join('\r\n');
}
export function calendarEvent(run: Run, users: User[]): string {
  if (run.status !== 'approved' || !run.proposal) throw new Error('Every participant must approve before exporting');
  const proposal = run.proposal;
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Kin//A2A Social Scheduling//EN', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    `UID:${proposal.uid}`, `DTSTAMP:${timestamp(run.createdAt)}`, `DTSTART:${timestamp(proposal.start)}`, `DTEND:${timestamp(proposal.end)}`,
    `SUMMARY:${escape(run.request.title)}`, `DESCRIPTION:${escape(`Planned by your agents. Approved by ${users.map(u => u.name).join(', ')}. Display timezone: ${run.request.timezone}.`)}`,
    `X-KIN-TIMEZONE:${escape(run.request.timezone)}`, 'END:VEVENT', 'END:VCALENDAR', ''].map(fold).join('\r\n');
}
