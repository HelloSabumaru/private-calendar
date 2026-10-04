import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { ApiError } from '../errors';
import type { IcsCodec, Resource } from '../ics';
import { defaultRecurrence, draftSchema, type Calendar, type EventDraft, type Operation } from '../shared';

export type DemoRequest = { path: string; method: string; headers: Record<string, string>; body?: string };
export type DemoResponse = { status: number; body: unknown };
const importSchema = z.object({ calendarId: z.string().optional(), ics: z.string().max(200000) });
const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en-GB');

export class DemoCalendar {
  private readonly calendars: Calendar[] = [{ id: 'personal', name: 'Personal', color: '#27775c', canCreate: true, canUpdate: true, canDelete: true }];
  private readonly resources = new Map<string, Resource>();
  private readonly operations = new Map<string, { fingerprint: string; result: Operation }>();
  private revision = 0;
  private sourceBytes = 0;

  constructor(private readonly codec: IcsCodec, private readonly timezones: string[], date: string, timezone: string) {
    const day = Temporal.PlainDate.from(date);
    const zone = timezones.includes(timezone) ? timezone : 'UTC';
    const draft: EventDraft = { calendarId: 'personal', title: 'Morning walk', description: 'A little fresh air to start the day.', location: 'Park', start: `${day}T09:00:00`, end: `${day}T10:00:00`, allDay: false, timezone: zone, reminder: 1440, recurrence: defaultRecurrence };
    const samples: EventDraft[] = [
      draft,
      { ...draft, title: 'Lunch with friends', description: 'Catch up over lunch.', location: 'Little café', start: `${day.add({ days: 2 })}T12:30:00`, end: `${day.add({ days: 2 })}T13:30:00` },
      { ...draft, title: 'Long weekend', description: '', location: '', allDay: true, start: day.add({ days: 5 }).toString(), end: day.add({ days: 8 }).toString(), reminder: 'none' },
      { ...draft, title: 'Stretch and reset', description: 'Make some time for yourself.', location: '', start: `${day}T18:00:00`, end: `${day}T18:30:00`, recurrence: { ...defaultRecurrence, frequency: 'WEEKLY', end: 'count', count: 8 } },
    ];
    for (const [index, sample] of samples.entries()) this.store(`sample-${index}`, sample.calendarId, codec.writeEvent(sample, `sample-${index}@calendar.demo`));
  }

  handle(request: DemoRequest): DemoResponse {
    try { return { status: 200, body: this.route(request) }; }
    catch (error) {
      if (error instanceof ApiError) return { status: error.status, body: { code: error.code, message: error.message, ...error.extra } };
      if (error instanceof z.ZodError || error instanceof SyntaxError) return { status: 400, body: { code: 'VALIDATION', message: 'Check the event details and try again.' } };
      return { status: 422, body: { code: 'ICS_INVALID', message: 'This calendar data could not be processed.' } };
    }
  }

  private store(id: string, calendarId: string, ics: string) {
    const bytes = new TextEncoder().encode(ics).byteLength;
    const previous = this.resources.get(id);
    const total = this.sourceBytes - (previous ? new TextEncoder().encode(previous.ics).byteLength : 0) + bytes;
    if (!previous && this.resources.size >= 2000 || total > 16 * 1024 * 1024) throw new ApiError(422, 'ICS_LIMIT', 'This demo calendar is full. Reload to reset it.');
    this.resources.set(id, { id, calendarId, ics, etag: `"demo-${++this.revision}"` });
    this.sourceBytes = total;
  }

  private resource(id: string) {
    const result = this.resources.get(id);
    if (!result) throw new ApiError(404, 'EVENT_MISSING', 'This event no longer exists.');
    return result;
  }

  private calendar(id: string) {
    if (!this.calendars.some(calendar => calendar.id === id)) throw new ApiError(404, 'CALENDAR_MISSING', 'Choose an available calendar.');
    return id;
  }

  private range(url: URL, search: boolean) {
    const start = url.searchParams.get('start') ?? '', end = url.searchParams.get('end') ?? '';
    const timezone = url.searchParams.get('timezone') ?? 'UTC';
    const duration = Date.parse(end) - Date.parse(start);
    if (!Number.isFinite(duration) || duration <= 0 || duration > (search ? 367 : 93) * 86400000) throw new ApiError(400, 'RANGE', 'Choose a valid date range.');
    if (!this.timezones.includes(timezone)) throw new ApiError(400, 'TIMEZONE_UNKNOWN', 'Choose a supported timezone.');
    const ids = (url.searchParams.get('calendars') ?? '').split(',');
    const resources = [...this.resources.values()].filter(resource => ids.includes(resource.calendarId));
    const result = this.codec.expandResources(resources, start, end, timezone);
    if (search) {
      const query = normalize(url.searchParams.get('q') ?? '');
      result.occurrences = result.occurrences.filter(event => normalize(`${event.title}\n${event.description}\n${event.location}`).includes(query)).slice(0, 1000);
    }
    return { ...result, refreshedAt: new Date().toISOString(), complete: !result.warnings.length };
  }

  private mutate(request: DemoRequest, run: (id: string) => Omit<Operation, 'id' | 'state'>) {
    const id = z.uuid().parse(request.headers['idempotency-key']);
    const fingerprint = JSON.stringify([request.path, request.method, request.body, request.headers['if-match'], request.headers['x-event-id']]);
    const existing = this.operations.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new ApiError(409, 'OPERATION_REUSED', 'This change identifier was already used. Try again.');
      return existing.result;
    }
    const result: Operation = { ...run(id), id, state: 'success' };
    this.operations.set(id, { fingerprint, result });
    if (this.operations.size > 2000) this.operations.delete(this.operations.keys().next().value!);
    return result;
  }

  private route(request: DemoRequest): unknown {
    const url = new URL(request.path, 'https://calendar.demo');
    const { pathname } = url, method = request.method;
    const body: unknown = request.body === undefined ? undefined : JSON.parse(request.body);
    if (pathname === '/session' && method === 'GET') return { accountKey: 'demo', csrf: 'demo', timezones: this.timezones };
    if (pathname === '/calendars' && method === 'GET') return { calendars: this.calendars };
    if (['/events', '/search'].includes(pathname) && method === 'GET') return this.range(url, pathname === '/search');
    if (pathname === '/events' && method === 'POST') return this.mutate(request, operationId => {
      const draft = draftSchema.parse(body);
      this.calendar(draft.calendarId);
      const id = z.uuid().parse(request.headers['x-event-id'] ?? operationId);
      if (this.resources.has(id)) throw new ApiError(409, 'CONFLICT', 'This event already exists.', { latest: this.codec.eventDetail(this.resource(id)) });
      this.store(id, draft.calendarId, this.codec.writeEvent(draft, `${id}@calendar.demo`));
      return { resourceId: id };
    });
    const eventPath = /^\/events\/([^/]+)(\/export)?$/.exec(pathname);
    if (eventPath) {
      const id = decodeURIComponent(eventPath[1]), recurrenceId = url.searchParams.get('recurrenceId');
      if (method === 'GET') {
        const resource = this.resource(id);
        return eventPath[2] ? { ics: resource.ics } : recurrenceId ? this.codec.occurrenceDetail(resource, recurrenceId) : this.codec.eventDetail(resource);
      }
      if (!eventPath[2] && ['PATCH', 'DELETE'].includes(method)) return this.mutate(request, () => {
        const resource = this.resource(id);
        const detail = recurrenceId ? this.codec.occurrenceDetail(resource, recurrenceId) : this.codec.eventDetail(resource);
        if (request.headers['if-match'] !== resource.etag) throw new ApiError(409, 'CONFLICT', 'This event changed. Review the latest version.', { latest: detail });
        if (method === 'DELETE') {
          if (!detail.canDelete) throw new ApiError(422, 'EDIT_UNSUPPORTED', detail.deleteReason ?? 'This event cannot be safely deleted.');
          if (recurrenceId) this.store(id, resource.calendarId, this.codec.writeOccurrence(resource, recurrenceId));
          else { this.resources.delete(id); this.sourceBytes -= new TextEncoder().encode(resource.ics).byteLength; }
        } else {
          const draft = draftSchema.parse(body);
          if (draft.calendarId !== resource.calendarId) throw new ApiError(422, 'CALENDAR_CHANGED', 'Existing events stay in their calendar.');
          this.store(id, resource.calendarId, recurrenceId ? this.codec.writeOccurrence(resource, recurrenceId, draft) : this.codec.writeEvent(draft, '', resource.ics));
        }
        return { resourceId: id };
      });
    }
    const exportPath = /^\/calendars\/([^/]+)\/export$/.exec(pathname);
    if (exportPath && method === 'GET') {
      const calendarId = this.calendar(decodeURIComponent(exportPath[1]));
      return { ics: this.codec.mergeExport([...this.resources.values()].filter(resource => resource.calendarId === calendarId).map(resource => resource.ics)) };
    }
    if (pathname === '/import/preview' && method === 'POST') return this.codec.splitImport(importSchema.parse(body).ics);
    if (pathname === '/import' && method === 'POST') return this.mutate(request, id => {
      const input = importSchema.parse(body), calendarId = this.calendar(input.calendarId ?? '');
      const events = this.codec.splitImport(input.ics);
      if (events.length !== 1) throw new ApiError(422, 'IMPORT_INVALID', 'Import one event series at a time.');
      const existing = [...this.resources.values()].find(resource => resource.calendarId === calendarId && this.codec.splitImport(resource.ics)[0].uid === events[0].uid);
      if (existing) return { resourceId: existing.id, skipped: true };
      this.store(id, calendarId, events[0].ics);
      return { resourceId: id };
    });
    const operationPath = /^\/operations\/([^/]+)$/.exec(pathname);
    if (operationPath && method === 'GET') {
      const operation = this.operations.get(operationPath[1]);
      if (!operation) throw new ApiError(404, 'OPERATION_MISSING', 'This change is no longer available.');
      return operation.result;
    }
    throw new ApiError(404, 'NOT_FOUND', 'This action is unavailable in the demo.');
  }
}
