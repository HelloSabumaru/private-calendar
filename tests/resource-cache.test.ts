import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { discover, fetchResource, getResource } from '../src/server/dav.js';
import { writeEvent } from '../src/server/ics.js';
import { discardResource, opaque, retainOperation, retainResource, retainResourceLocation, type Session } from '../src/server/sessions.js';
import { defaultRecurrence, type Calendar, type EventDetail, type EventDraft } from '../src/shared.js';
import { mockDav } from './dav-server.js';

const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
const draft: EventDraft = { calendarId: '', title: 'Retained event', description: '', location: '', start: '2026-10-04T09:00:00', end: '2026-10-04T10:00:00', allDay: false, timezone: 'Europe/Prague', reminder: 'none', recurrence: defaultRecurrence };
const largeEvent = (uid: string) => {
  const source = writeEvent({ ...draft, title: uid }, uid);
  const padding = 'a'.repeat(1024 * 1024 - 1024 - Buffer.byteLength(source) - 12);
  return source.replace('END:VCALENDAR', `X-PADDING:${padding}\r\nEND:VCALENDAR`);
};

describe('authorized resources and the ICS cache', () => {
  let dav: Awaited<ReturnType<typeof mockDav>>;
  let system: Awaited<ReturnType<typeof createApp>>;
  let config: ReturnType<typeof loadConfig>;
  let session: Session; let calendar: Calendar; let cookie: string; let csrf: string;
  const origin = 'https://calendar.test';
  const headers = () => ({ cookie, origin, 'x-csrf-token': csrf });
  const range = () => system.app.inject({ url: `/api/events?${new URLSearchParams({ start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z', timezone: 'Europe/Prague', calendars: calendar.id })}`, headers: headers() });
  const addEvent = (name = 'original') => {
    const path = `/u/calendar/${name}.ics`, source = writeEvent(draft, name);
    dav.objects.set(path, source);
    return { path, source, url: new URL(path, dav.url).href, id: hash(new URL(path, dav.url).href) };
  };
  beforeEach(async () => {
    dav = await mockDav();
    config = loadConfig({ CALDAV_URL: dav.url, CALDAV_ALLOW_HTTP: 'true', APP_ORIGIN: origin });
    system = await createApp(config);
    const login = await system.app.inject({ method: 'POST', url: '/api/session', headers: { origin }, payload: { method: 'basic', username: 'user', password: 'password' } });
    expect(login.statusCode, login.body).toBe(200);
    cookie = String(login.headers['set-cookie']).split(';')[0]; csrf = login.json().csrf; calendar = login.json().calendars[0];
    session = system.sessions.get(cookie.split('=')[1]);
  });

  it('accounts for cache and pending-operation budgets independently in each application', async () => {
    const other = await createApp(config);
    const document = 'x'.repeat(1024 * 1024), intended = 'x'.repeat(4 * 1024 * 1024);
    const fill = (current: Session, count: number) => {
      const calendarId = current.calendars.keys().next().value!;
      for (let index = 0; index < count; index++) retainResource(current, { id: `event-${index}`, calendarId,
        url: new URL(`u/calendar/event-${index}.ics`, dav.url).href, etag: '"1"', ics: document });
      retainOperation(current, { id: randomUUID(), calendarId, resourceId: 'event-0', url: new URL('u/calendar/event-0.ics', dav.url).href,
        fingerprint: 'pending', method: 'PUT', state: 'uncertain', intended });
    };
    try {
      fill(session, 1);
      for (let index = 0; index < 8; index++) {
        const login = await other.app.inject({ method: 'POST', url: '/api/session', headers: { origin }, payload: { method: 'basic', username: 'user', password: 'password' } });
        expect(login.statusCode, login.body).toBe(200);
        const current = other.sessions.get(String(login.headers['set-cookie']).split(';')[0].split('=')[1]);
        expect(current.cache).not.toBe(session.cache); expect(current.jobs).not.toBe(session.jobs);
        fill(current, 8);
        expect(current.cacheBytes).toBe(8 * 1024 * 1024);
      }
      expect(session.resources.size).toBe(1); expect(session.cacheBytes).toBe(1024 * 1024);
      expect(session.operations.values().next().value?.intended).toBe(intended);
      await other.app.close();
      expect(session.cacheBytes).toBe(1024 * 1024); expect(session.abort.signal.aborted).toBe(false);
    } finally { await other.app.close(); }
  });

  it('closing one application leaves another application worker running', async () => {
    const other = await createApp(config);
    try {
      const running = session.jobs.run({ kind: 'write', draft, uid: 'still-running' });
      await other.app.close();
      expect(await running).toContain('UID:still-running');
      await expect(other.sessions.jobs.run({ kind: 'write', draft, uid: 'closed' })).rejects.toMatchObject({ code: 'BUSY' });
    } finally { await other.app.close(); }
  });

  it('limits worker capacity per application', async () => {
    const other = await createApp(config);
    try {
      const running = Promise.all(Array.from({ length: 4 }, (_, index) => session.jobs.run({ kind: 'write', draft, uid: `worker-${index}` })));
      await expect(session.jobs.run({ kind: 'write', draft, uid: 'busy' })).rejects.toMatchObject({ code: 'BUSY' });
      const independent = other.sessions.jobs.run({ kind: 'write', draft, uid: 'independent' });
      expect(await independent).toContain('UID:independent');
      expect(await running).toHaveLength(4);
    } finally { await other.app.close(); }
  });
  afterEach(async () => { vi.restoreAllMocks(); await system?.app.close(); await dav?.close(); });

  it('refetches original authorized URLs for details, export, and editing after content eviction', async () => {
    const before = dav.requests.length;
    for (let i = 0; i < 9; i++) dav.objects.set(`/u/calendar/event-${i}.ics`, largeEvent(`event-${i}`));
    const listed = await range();
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().complete).toBe(true); expect(listed.json().occurrences).toHaveLength(9);
    const first = listed.json().occurrences[0];
    const path = '/u/calendar/event-0.ics', url = new URL(path, dav.url).href;
    expect(first.title).toBe('event-0');
    expect(session.resources.has(first.resourceId)).toBe(false);
    expect(session.resourceLocations.get(first.resourceId)).toEqual({ id: first.resourceId, calendarId: calendar.id, url, etag: dav.etag(dav.objects.get(path)!) });
    expect(session.cacheBytes).toBeLessThanOrEqual(8 * 1024 * 1024);

    const detail = await system.app.inject({ url: `/api/events/${first.resourceId}`, headers: headers() });
    expect(detail.statusCode, detail.body).toBe(200);
    const original = detail.json<EventDetail>();
    expect(original.draft.title).toBe('event-0'); expect(original.canUpdate).toBe(true);

    await range(); expect(session.resources.has(first.resourceId)).toBe(false);
    const exported = await system.app.inject({ url: `/api/events/${first.resourceId}/export`, headers: headers() });
    expect(exported.statusCode, exported.body).toBe(200); expect(exported.json().ics).toBe(dav.objects.get(path));

    await range(); expect(session.resources.has(first.resourceId)).toBe(false);
    const edited = await system.app.inject({ method: 'PATCH', url: `/api/events/${first.resourceId}`, headers: { ...headers(), 'if-match': original.etag, 'idempotency-key': randomUUID() }, payload: { ...original.draft, title: 'Edited after eviction' } });
    expect(edited.statusCode, edited.body).toBe(200); expect(edited.json().state).toBe('success');
    expect(dav.objects.get(path)).toContain('SUMMARY:Edited after eviction');
    const reads = dav.requests.slice(before).filter(request => request.method === 'GET');
    expect(reads).toHaveLength(3); expect(reads.every(request => request.url === path)).toBe(true);
    expect(reads.every(request => request.headers.authorization === `Basic ${Buffer.from('user:password').toString('base64')}`)).toBe(true);
    expect(dav.requests.find(request => request.method === 'PUT')).toMatchObject({ url: path, headers: { 'if-match': original.etag } });
  });

  it('keeps locations across cache count eviction and bounds accumulated metadata without evicting known IDs', async () => {
    const event = addEvent(); await range();
    for (let i = 1; i < 20000; i++) {
      const url = new URL(`/u/calendar/retained-${i}.ics`, dav.url).href;
      const resource = { id: hash(url), calendarId: calendar.id, url, etag: '"known"', ics: event.source };
      if (i <= 2000) retainResource(session, resource); else retainResourceLocation(session, resource);
    }
    expect(session.resources.size).toBe(2000); expect(session.resources.has(event.id)).toBe(false);
    expect(session.resourceLocations.size).toBe(20000);
    expect(getResource(session, event.id)).toMatchObject({ url: event.url });
    const extra = addEvent('beyond-capacity');
    const overflow = await range();
    expect(overflow.statusCode, overflow.body).toBe(200); expect(overflow.json().complete).toBe(false);
    expect(overflow.json().warnings).toEqual([expect.stringContaining('Too many event locations')]);
    expect(session.resourceLocations.size).toBe(20000); expect(session.resourceLocations.has(extra.id)).toBe(false);
    expect((await system.app.inject({ url: `/api/events/${event.id}`, headers: headers() })).statusCode).toBe(200);
  });

  it('rejects unknown IDs without fetching or writing a guessed resource URL', async () => {
    const unknown = opaque(), before = dav.requests.length;
    for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
      const result = await system.app.inject({ method, url: `/api/events/${unknown}`, headers: { ...headers(), 'if-match': '"unknown"', 'idempotency-key': randomUUID() }, ...(method === 'PATCH' ? { payload: { ...draft, calendarId: calendar.id } } : {}) });
      expect(result.statusCode, result.body).toBe(404); expect(result.json().code).toBe('EVENT_MISSING');
    }
    expect(dav.requests).toHaveLength(before);
  });

  it('fetches only the stored destination and rejects upstream destinations outside the allowlist', async () => {
    const event = addEvent(); await range();
    const latest = await fetchResource(session, { ...getResource(session, event.id), url: 'https://outside.test/guessed.ics' });
    expect(latest.url).toBe(event.url); expect(dav.requests.at(-1)?.url).toBe(event.path);
    vi.spyOn(session.client, 'fetchCalendarObjects').mockResolvedValue([{ url: 'https://outside.test/other.ics', data: event.source, etag: '"other"' }]);
    const result = await range();
    expect(result.json().complete).toBe(false); expect(result.json().warnings).toEqual([expect.stringContaining('outside the configured paths')]);
    expect(session.resourceLocations.size).toBe(1);
  });

  it('removes cached content and uncached authority when discovery revokes a calendar', async () => {
    const event = addEvent(); await range();
    const uncachedUrl = new URL('/u/calendar/uncached.ics', dav.url).href;
    retainResourceLocation(session, { id: hash(uncachedUrl), calendarId: calendar.id, url: uncachedUrl, etag: '"uncached"' });
    expect(session.resources.size).toBe(1); expect(session.resourceLocations.size).toBe(2);
    vi.spyOn(session.client, 'fetchCalendars').mockResolvedValue([]);
    const result = await system.app.inject({ url: '/api/calendars', headers: headers() });
    expect(result.json().calendars).toEqual([]);
    expect(session.resources.size).toBe(0); expect(session.cacheBytes).toBe(0);
    expect(session.resourceLocations.size).toBe(0); expect(session.resourceLocationBytes).toBe(0);
    const requests = dav.requests.length;
    expect((await system.app.inject({ url: `/api/events/${event.id}`, headers: headers() })).statusCode).toBe(404);
    expect(dav.requests).toHaveLength(requests);
  });

  it('does not restore authority when an in-flight resource fetch finishes after revocation', async () => {
    const event = addEvent(); await range();
    let finish!: (response: Response) => void;
    vi.spyOn(session, 'fetch').mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    const pending = fetchResource(session, getResource(session, event.id));
    vi.spyOn(session.client, 'fetchCalendars').mockResolvedValue([]);
    await discover(session, config);
    finish(new Response(event.source, { headers: { etag: '"late"' } }));
    await expect(pending).rejects.toMatchObject({ code: 'EVENT_MISSING' });
    expect(session.resources.size).toBe(0); expect(session.resourceLocations.size).toBe(0);
    expect(session.cacheBytes).toBe(0); expect(session.resourceLocationBytes).toBe(0);
  });

  it('clears both resource stores and byte counters on explicit removal and logout', async () => {
    const first = addEvent(), second = addEvent('second'); await range();
    discardResource(session, first.id);
    expect(session.resources.has(first.id)).toBe(false); expect(session.resourceLocations.has(first.id)).toBe(false);
    expect(session.cacheBytes).toBe(Buffer.byteLength(second.source));
    const loggedOut = await system.app.inject({ method: 'DELETE', url: '/api/session', headers: headers() });
    expect(loggedOut.statusCode).toBe(200);
    expect(session.resources.size).toBe(0); expect(session.resourceLocations.size).toBe(0);
    expect(session.cacheBytes).toBe(0); expect(session.resourceLocationBytes).toBe(0); expect(session.abort.signal.aborted).toBe(true);
    expect((await system.app.inject({ url: `/api/events/${second.id}`, headers: headers() })).statusCode).toBe(401);
  });

  it.each([404, 403])('clears resource authority when the upstream returns %i', async status => {
    const event = addEvent(); await range();
    vi.spyOn(session, 'fetch').mockResolvedValue(new Response(null, { status }));
    await expect(fetchResource(session, getResource(session, event.id))).rejects.toMatchObject({ status });
    expect(session.resources.size).toBe(0); expect(session.resourceLocations.size).toBe(0);
    expect(session.cacheBytes).toBe(0); expect(session.resourceLocationBytes).toBe(0);
  });
});
