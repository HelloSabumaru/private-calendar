import { describe, expect, it } from 'vitest';
import { DemoCalendar, type DemoRequest } from '../src/client/demo-state';
import { defaultRecurrence, type EventDetail, type EventDraft, type ImportEvent, type Occurrence, type Operation } from '../src/shared';
import { createIcsCodec } from '../src/ics';
import { timezones } from '../src/server/timezones';

const codec = createIcsCodec(timezones);
const create = () => new DemoCalendar(codec, timezones.names, '2026-10-04', 'Europe/Prague');
const query = '/events?start=2026-10-01T00:00:00Z&end=2026-11-01T00:00:00Z&timezone=Europe%2FPrague&calendars=personal';
const draft: EventDraft = { calendarId: 'personal', title: 'Demo edit', description: '', location: '', start: '2026-10-04T11:00:00', end: '2026-10-04T12:00:00', allDay: false, timezone: 'Europe/Prague', recurrence: defaultRecurrence, reminder: 'none' };
function request(calendar: DemoCalendar, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return calendar.handle({ path, method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const mutationHeaders = (etag?: string) => ({ 'idempotency-key': crypto.randomUUID(), ...(etag ? { 'if-match': etag } : {}) });
const events = (calendar: DemoCalendar) => (request(calendar, query).body as { occurrences: Occurrence[] }).occurrences;

describe('browser demo', () => {
  it('starts without credentials, seeds the selected day and isolates changes per page', () => {
    const calendar = create();
    expect(request(calendar, '/session').body).toMatchObject({ accountKey: 'demo', timezones: expect.arrayContaining(['Europe/Prague']) });
    expect(events(calendar).find(event => event.title === 'Morning walk')).toMatchObject({ start: '2026-10-04T07:00:00.000Z' });
    request(calendar, '/events/sample-0', 'DELETE', undefined, mutationHeaders((request(calendar, '/events/sample-0').body as EventDetail).etag));
    expect(events(calendar).some(event => event.title === 'Morning walk')).toBe(false);
    expect(events(create()).some(event => event.title === 'Morning walk')).toBe(true);
  });

  it('supports creation, conditional edits, deletion and idempotent status checks', () => {
    const calendar = create(), headers = mutationHeaders();
    const creation: DemoRequest = { path: '/events', method: 'POST', headers, body: JSON.stringify(draft) };
    const first = calendar.handle(creation);
    expect(first.status).toBe(200);
    expect(calendar.handle(creation)).toEqual(first);
    const operation = first.body as Operation;
    expect(request(calendar, `/operations/${operation.id}`).body).toEqual(operation);
    expect(events(calendar).filter(event => event.title === draft.title)).toHaveLength(1);
    expect(calendar.handle({ ...creation, body: JSON.stringify({ ...draft, title: 'Different command' }) })).toMatchObject({ status: 409, body: { code: 'OPERATION_REUSED' } });
    const detail = request(calendar, `/events/${operation.resourceId}`).body as EventDetail;
    expect(request(calendar, `/events/${detail.id}`, 'PATCH', { ...detail.draft, title: 'Changed' }, mutationHeaders(detail.etag)).status).toBe(200);
    expect(request(calendar, `/events/${detail.id}`, 'DELETE', undefined, mutationHeaders(detail.etag))).toMatchObject({ status: 409, body: { latest: { draft: { title: 'Changed' } } } });
    const latest = request(calendar, `/events/${detail.id}`).body as EventDetail;
    expect(request(calendar, `/events/${detail.id}`, 'DELETE', undefined, mutationHeaders(latest.etag)).status).toBe(200);
    expect(request(calendar, `/events/${detail.id}`).status).toBe(404);
  });

  it('edits and cancels individual occurrences without changing their neighbors', () => {
    const calendar = create();
    const original = events(calendar).filter(event => event.resourceId === 'sample-3');
    const path = `/events/sample-3?${new URLSearchParams({ recurrenceId: original[0].recurrenceId! })}`;
    const detail = request(calendar, path).body as EventDetail;
    expect(request(calendar, path, 'PATCH', { ...detail.draft, title: 'Just this one' }, mutationHeaders(detail.etag)).status).toBe(200);
    expect(events(calendar).filter(event => event.resourceId === 'sample-3').map(event => event.title)).toEqual(['Just this one', ...original.slice(1).map(event => event.title)]);
    const latest = request(calendar, path).body as EventDetail;
    expect(request(calendar, path, 'DELETE', undefined, mutationHeaders(latest.etag)).status).toBe(200);
    expect(events(calendar).filter(event => event.resourceId === 'sample-3')).toHaveLength(original.length - 1);
  });

  it('preserves imported ICS, skips duplicate identities and exports the calendar', () => {
    const calendar = create();
    const ics = codec.writeEvent({ ...draft, title: 'Imported café' }, 'external-identity').replace('END:VEVENT', 'X-EXTERNAL:keep\r\nEND:VEVENT');
    const preview = request(calendar, '/import/preview', 'POST', { ics }).body as ImportEvent[];
    expect(preview[0]).toMatchObject({ uid: 'external-identity', title: 'Imported café' });
    const imported = request(calendar, '/import', 'POST', { ics: preview[0].ics, calendarId: 'personal' }, mutationHeaders()).body as Operation;
    expect(imported.state).toBe('success');
    expect(request(calendar, '/import', 'POST', { ics, calendarId: 'personal' }, mutationHeaders()).body).toMatchObject({ skipped: true, resourceId: imported.resourceId });
    const exported = request(calendar, `/events/${imported.resourceId}/export`).body as { ics: string };
    expect(codec.canonicalICS(exported.ics)).toBe(codec.canonicalICS(ics));
    const combined = request(calendar, '/calendars/personal/export').body as { ics: string };
    expect(codec.splitImport(combined.ics)).toHaveLength(5);
    expect(combined.ics).toContain('X-EXTERNAL:keep');
    expect(request(calendar, query.replace('/events?', '/search?q=CAFE&')).body).toMatchObject({ occurrences: expect.arrayContaining([expect.objectContaining({ title: 'Imported café' })]) });
    expect(request(calendar, query.replace('calendars=personal', 'calendars=')).body).toMatchObject({ occurrences: [] });
  });

  it('keeps the elapsed duration and offset selections during the repeated DST hour', () => {
    const calendar = create();
    const operation = request(calendar, '/events', 'POST', { ...draft, title: 'Clock change', start: '2026-10-25T02:30:00', end: '2026-10-25T02:30:00', startOffset: 'earlier', endOffset: 'later' }, mutationHeaders()).body as Operation;
    const event = events(calendar).find(event => event.resourceId === operation.resourceId)!;
    expect(Date.parse(event.end) - Date.parse(event.start)).toBe(3600000);
    expect(request(calendar, `/events/${operation.resourceId}`).body).toMatchObject({ draft: { startOffset: 'earlier', endOffset: 'later' } });
    expect(request(calendar, '/events', 'POST', { ...draft, start: '2026-03-29T02:30:00', end: '2026-03-29T03:30:00' }, mutationHeaders())).toMatchObject({ status: 422, body: { code: 'DST_GAP' } });
  });

  it('validates malformed input, calendar selections and date ranges', () => {
    const calendar = create();
    expect(request(calendar, '/events', 'POST', { ...draft, title: '' }, mutationHeaders()).status).toBe(400);
    expect(request(calendar, '/events', 'POST', { ...draft, calendarId: 'missing' }, mutationHeaders()).status).toBe(404);
    expect(request(calendar, query.replace('2026-11-01', '2028-11-01')).status).toBe(400);
    expect(request(calendar, '/import/preview', 'POST', { ics: 'not a calendar' }).status).toBe(422);
  });
});
