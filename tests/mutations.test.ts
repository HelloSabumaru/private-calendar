import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { writeEvent } from '../src/server/ics.js';
import { retainResourceLocation } from '../src/server/sessions.js';
import { defaultRecurrence, type Calendar, type EventDetail, type EventDraft } from '../src/shared.js';
import { mockDav } from './dav-server.js';

const origin = 'https://calendar.test';
const draft: EventDraft = { calendarId: '', title: 'Original', description: 'Notes', location: '',
  start: '2026-10-04T09:00:00', end: '2026-10-04T10:00:00', allDay: false, timezone: 'Europe/Prague',
  reminder: 1440, recurrence: defaultRecurrence };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

describe('mutation commands and operation tracking', () => {
  let dav: Awaited<ReturnType<typeof mockDav>>;
  let system: Awaited<ReturnType<typeof createApp>>;
  let cookie: string; let csrf: string; let calendar: Calendar;
  const headers = () => ({ cookie, origin, 'x-csrf-token': csrf });
  const session = () => system.sessions.get(cookie.split('=')[1]);
  const create = (body: EventDraft = { ...draft, calendarId: calendar.id }, operationId = randomUUID(), creationId = operationId) =>
    system.app.inject({ method: 'POST', url: '/api/events', headers: { ...headers(), 'idempotency-key': operationId, 'x-event-id': creationId }, payload: body });
  const read = async (resourceId: string, recurrenceId?: string) => {
    const response = await system.app.inject({ url: `/api/events/${resourceId}${recurrenceId ? `?${new URLSearchParams({ recurrenceId })}` : ''}`, headers: headers() });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<EventDetail>();
  };
  const change = (method: 'PATCH' | 'DELETE', detail: EventDetail, body?: EventDraft, operationId = randomUUID()) =>
    system.app.inject({ method, url: `/api/events/${detail.id}${detail.recurrenceId ? `?${new URLSearchParams({ recurrenceId: detail.recurrenceId })}` : ''}`,
      headers: { ...headers(), 'if-match': detail.etag, 'idempotency-key': operationId }, ...(body ? { payload: body } : {}) });
  const load = async () => {
    const result = await system.app.inject({ url: `/api/events?${new URLSearchParams({ start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z', timezone: 'Europe/Prague', calendars: calendar.id })}`, headers: headers() });
    expect(result.statusCode, result.body).toBe(200);
    return result.json<{ occurrences: { resourceId: string; recurrenceId?: string }[] }>().occurrences;
  };
  beforeEach(async () => {
    dav = await mockDav();
    system = await createApp(loadConfig({ CALDAV_URL: dav.url, CALDAV_ALLOW_HTTP: 'true', APP_ORIGIN: origin, UPSTREAM_TIMEOUT_MS: '500' }));
    const response = await system.app.inject({ method: 'POST', url: '/api/session', headers: { origin }, payload: { method: 'basic', username: 'user', password: 'password' } });
    expect(response.statusCode, response.body).toBe(200);
    cookie = String(response.headers['set-cookie']).split(';')[0]; csrf = response.json().csrf; calendar = response.json().calendars[0];
  });
  afterEach(async () => { await system?.app.close(); await dav?.close(); });

  it('joins concurrent requests for one creation key before asynchronous preparation', async () => {
    const operationId = randomUUID();
    const results = await Promise.all([create(undefined, operationId), create(undefined, operationId)]);
    for (const result of results) { expect(result.statusCode, result.body).toBe(200); expect(result.json().state).toBe('success'); }
    expect(results[0].json()).toEqual(results[1].json());
    expect(dav.requests.filter(request => request.method === 'PUT')).toHaveLength(1);
    expect(dav.objects.size).toBe(1);
  });

  it('rejects concurrent reuse of a key with a different command', async () => {
    const operationId = randomUUID();
    const results = await Promise.all([create(undefined, operationId), create({ ...draft, calendarId: calendar.id, title: 'Changed' }, operationId)]);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
    expect(results.find(result => result.statusCode === 409)!.json().code).toBe('OPERATION_REUSED');
    expect(dav.requests.filter(request => request.method === 'PUT')).toHaveLength(1);
  });

  it('locks the event during its initial read while joining identical update requests', async () => {
    const resourceId = (await create()).json().resourceId;
    const original = await read(resourceId), next = { ...original.draft, title: 'Updated' };
    const entered = deferred(), release = deferred(), current = session(), originalFetch = current.fetch;
    let hold = true;
    current.fetch = async (input, init) => {
      if (hold && init?.method === 'GET') { hold = false; entered.resolve(); await release.promise; }
      return originalFetch(input, init);
    };
    const operationId = randomUUID();
    const first = change('PATCH', original, next, operationId).then(response => response);
    await entered.promise;
    const joined = change('PATCH', original, next, operationId).then(response => response);
    try {
      const busy = await change('PATCH', original, { ...next, title: 'Competing change' });
      expect(busy.statusCode, busy.body).toBe(409); expect(busy.json().code).toBe('EVENT_BUSY');
    } finally { release.resolve(); }
    const results = await Promise.all([first, joined]);
    for (const result of results) expect(result.json().state, result.body).toBe('success');
    expect(dav.requests.filter(request => request.method === 'PUT')).toHaveLength(2);
    expect((await read(resourceId)).draft.title).toBe('Updated');
    expect(current.locks.size).toBe(0);
  });

  it('retries a failed command with its original serialized content and rejects changed drafts', async () => {
    const operationId = randomUUID();
    dav.state.mode = 'drop-before-put';
    const failed = await create(undefined, operationId);
    expect(failed.json().state, failed.body).toBe('failed');
    const changed = await create({ ...draft, calendarId: calendar.id, title: 'Changed' }, operationId);
    expect(changed.statusCode).toBe(409); expect(changed.json().code).toBe('OPERATION_REUSED');
    const retry = await create(undefined, operationId);
    expect(retry.json().state, retry.body).toBe('success');
    const writes = dav.requests.filter(request => request.method === 'PUT');
    expect(writes).toHaveLength(2); expect(writes[0].body).toBe(writes[1].body);
    expect(dav.objects.size).toBe(1);
  });

  it('keeps an uncertain event locked until reconciliation establishes the write', async () => {
    dav.state.mode = 'unavailable-after-put';
    const operationId = randomUUID(), pending = await create(undefined, operationId);
    expect(pending.json().state, pending.body).toBe('uncertain');
    const competing = await create(undefined, randomUUID(), operationId);
    expect(competing.statusCode).toBe(409); expect(competing.json().code).toBe('EVENT_BUSY');
    const retry = await create(undefined, operationId);
    expect(retry.json().state).toBe('uncertain');
    expect(dav.requests.filter(request => request.method === 'PUT')).toHaveLength(1);
    dav.state.unavailable = false;
    const status = await system.app.inject({ url: `/api/operations/${operationId}`, headers: headers() });
    expect(status.json().state, status.body).toBe('success');
    expect((await create(undefined, operationId)).json().state).toBe('success');
    expect(dav.requests.filter(request => request.method === 'PUT')).toHaveLength(1);
  });

  it.each(['', 'drop-after-put', 'unavailable-after-put'] as const)('discards whole-event authority only after DELETE success with mode %s', async mode => {
    const resourceId = (await create()).json().resourceId, original = await read(resourceId), current = session();
    dav.state.mode = mode;
    const operationId = randomUUID(), removed = await change('DELETE', original, undefined, operationId);
    expect(removed.statusCode, removed.body).toBe(200);
    if (mode === 'unavailable-after-put') {
      expect(removed.json().state).toBe('uncertain'); expect(current.resourceLocations.has(resourceId)).toBe(true);
      dav.state.unavailable = false;
      const status = await system.app.inject({ url: `/api/operations/${operationId}`, headers: headers() });
      expect(status.json().state, status.body).toBe('success');
    } else expect(removed.json().state).toBe('success');
    expect(current.resources.has(resourceId)).toBe(false); expect(current.resourceLocations.has(resourceId)).toBe(false);
    expect(dav.objects.size).toBe(0);
    const repeated = await change('DELETE', original, undefined, operationId);
    expect(repeated.json().state, repeated.body).toBe('success');
    expect(dav.requests.filter(request => request.method === 'DELETE')).toHaveLength(1);
  });

  it('uses update permission for occurrence cancellation and preserves series authority', async () => {
    dav.objects.set('/u/calendar/series.ics', writeEvent({ ...draft, recurrence: { ...defaultRecurrence, frequency: 'DAILY', end: 'count', count: 3 } }, 'series'));
    const occurrences = await load(), occurrence = occurrences[1];
    const original = await read(occurrence.resourceId, occurrence.recurrenceId);
    const current = session(); current.calendars.get(calendar.id)!.calendar.canDelete = false;
    const changed = await change('PATCH', original, { ...original.draft, title: 'Only this occurrence' });
    expect(changed.json().state, changed.body).toBe('success');
    const latest = await read(occurrence.resourceId, occurrence.recurrenceId);
    const canceled = await change('DELETE', latest);
    expect(canceled.json().state, canceled.body).toBe('success');
    expect(current.resourceLocations.has(occurrence.resourceId)).toBe(true); expect(dav.objects.size).toBe(1);
    expect(dav.requests.filter(request => request.method === 'DELETE')).toHaveLength(0);
    expect(dav.requests.filter(request => request.method === 'PUT')).toHaveLength(2);
    const whole = await read(occurrence.resourceId);
    const denied = await change('DELETE', whole);
    expect(denied.statusCode).toBe(403);
    const remaining = await load(); expect(remaining).toHaveLength(2);
    expect(whole.draft.title).toBe('Original');
  });

  it('requires creation privilege for imports and strong ETags and a fixed calendar for edits', async () => {
    const resourceId = (await create()).json().resourceId, original = await read(resourceId);
    const weak = await change('PATCH', { ...original, etag: `W/${original.etag}` }, original.draft);
    expect(weak.statusCode).toBe(428); expect(weak.json().code).toBe('ETAG_REQUIRED');
    const moved = await change('PATCH', original, { ...original.draft, calendarId: 'another-calendar' });
    expect(moved.statusCode).toBe(422); expect(moved.json().code).toBe('CALENDAR_FIXED');
    session().calendars.get(calendar.id)!.calendar.canCreate = false;
    const imported = await system.app.inject({ method: 'POST', url: '/api/import', headers: { ...headers(), 'idempotency-key': randomUUID() },
      payload: { calendarId: calendar.id, ics: writeEvent(draft, 'imported') } });
    expect(imported.statusCode).toBe(403);
    expect(dav.requests.filter(request => request.method === 'PUT')).toHaveLength(1);
  });

  it('preserves unknown properties and alarms when updating an existing event', async () => {
    const source = writeEvent(draft, 'custom').replace('BEGIN:VEVENT\r\n', 'BEGIN:VEVENT\r\nX-PRIVATE-EXTENSION:keep-me\r\n');
    dav.objects.set('/u/calendar/custom.ics', source);
    const [event] = await load(), original = await read(event.resourceId);
    const changed = await change('PATCH', original, { ...original.draft, title: 'Changed title' });
    expect(changed.json().state, changed.body).toBe('success');
    const actual = dav.objects.get('/u/calendar/custom.ics')!;
    expect(actual).toContain('X-PRIVATE-EXTENSION:keep-me'); expect(actual).toContain('UID:custom');
    expect(actual.match(/BEGIN:VALARM/g)).toHaveLength(1); expect(actual).toContain('TRIGGER:-P1D');
  });

  it('fails metadata admission before registering or sending a write', async () => {
    const current = session();
    for (let i = 0; i < 20000; i++) retainResourceLocation(current, { id: `retained-${i}`, calendarId: calendar.id, etag: '"etag"', url: new URL(`u/calendar/retained-${i}.ics`, dav.url).href });
    const result = await create();
    expect(result.statusCode, result.body).toBe(503); expect(result.json().code).toBe('RESOURCE_LOCATION_LIMIT');
    expect(current.operations.size).toBe(0); expect(current.locks.size).toBe(0); expect(current.resources.size).toBe(0);
    expect(dav.requests.filter(request => request.method === 'PUT')).toHaveLength(0);
  });

  it('leaves no resource or operation placeholder when ICS preparation fails', async () => {
    const result = await create({ ...draft, calendarId: calendar.id, end: draft.start });
    expect(result.statusCode, result.body).toBe(422); expect(result.json().code).toBe('DATE_ORDER');
    const current = session(); expect(current.resourceLocations.size).toBe(0); expect(current.operations.size).toBe(0);
    expect(current.resources.size).toBe(0); expect(current.locks.size).toBe(0);
    expect(dav.requests.filter(request => request.method === 'PUT')).toHaveLength(0);
  });

  it('bounds unresolved operations and reclaims a completed entry for a new command', async () => {
    const current = session();
    for (let i = 0; i < 200; i++) {
      const id = randomUUID(); current.operations.set(id, { id, resourceId: `pending-${i}`, state: 'uncertain', fingerprint: 'pending',
        method: 'DELETE', url: new URL(`u/calendar/pending-${i}.ics`, dav.url).href });
    }
    const limited = await create();
    expect(limited.statusCode, limited.body).toBe(503); expect(limited.json().code).toBe('OPERATION_LIMIT');
    current.operations.values().next().value!.state = 'failed';
    const created = await create(); expect(created.json().state, created.body).toBe('success');
    expect(current.operations.size).toBe(200); expect(dav.requests.filter(request => request.method === 'PUT')).toHaveLength(1);
  });
});
