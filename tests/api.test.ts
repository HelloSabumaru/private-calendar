import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { defaultRecurrence, type Calendar, type EventDraft, type EventDetail } from '../src/shared.js';
import { mockDav } from './dav-server.js';
import { writeEvent } from '../src/server/ics.js';

describe('deployment rate limits', () => {
  let system: Awaited<ReturnType<typeof createApp>> | undefined;
  const origin = 'https://calendar.test';
  const start = async (env: NodeJS.ProcessEnv = {}) => {
    system = await createApp(loadConfig({ APP_ORIGIN: origin, CALDAV_URL: 'https://dav.example.test/',
      RATE_LIMIT_REQUESTS: '2', RATE_LIMIT_LOGINS: '1', ...env }));
    system.app.get('/_rate-check', async request => ({ clientIp: request.ip }));
    return system.app;
  };
  afterEach(async () => { await system?.app.close(); system = undefined; });

  it('ignores forwarded client addresses when proxy trust is disabled', async () => {
    const app = await start();
    const request = (client: string) => app.inject({ url: '/_rate-check', remoteAddress: '192.0.2.1', headers: { 'x-forwarded-for': client } });
    expect((await request('198.51.100.1')).statusCode).toBe(200);
    expect((await request('198.51.100.2')).statusCode).toBe(200);
    expect((await request('198.51.100.3')).statusCode).toBe(429);
    expect((await app.inject({ url: '/healthz', remoteAddress: '192.0.2.1' })).statusCode).toBe(200);
  });

  it('gives clients behind an explicitly trusted proxy separate budgets', async () => {
    const app = await start({ TRUSTED_PROXIES: '192.0.2.0/24' });
    const request = (client: string) => app.inject({ url: '/_rate-check', remoteAddress: '192.0.2.1', headers: { 'x-forwarded-for': client } });
    expect((await request('198.51.100.1')).statusCode).toBe(200);
    expect((await request('198.51.100.1')).statusCode).toBe(200);
    expect((await request('198.51.100.1')).statusCode).toBe(429);
    expect((await request('198.51.100.2')).statusCode).toBe(200);
  });

  it('keeps requests from an untrusted peer in its direct IP budget', async () => {
    const app = await start({ TRUSTED_PROXIES: '192.0.2.1' });
    const request = (client: string) => app.inject({ url: '/_rate-check', remoteAddress: '203.0.113.1', headers: { 'x-forwarded-for': client } });
    expect((await request('198.51.100.1')).statusCode).toBe(200);
    expect((await request('198.51.100.2')).statusCode).toBe(200);
    expect((await request('198.51.100.3')).statusCode).toBe(429);
  });

  it('stops client address resolution at the first untrusted proxy', async () => {
    const app = await start({ TRUSTED_PROXIES: '192.0.2.1' });
    const request = (client: string) => app.inject({ url: '/_rate-check', remoteAddress: '192.0.2.1', headers: { 'x-forwarded-for': `${client}, 203.0.113.1` } });
    expect((await request('198.51.100.1')).statusCode).toBe(200);
    expect((await request('198.51.100.2')).statusCode).toBe(200);
    expect((await request('198.51.100.3')).statusCode).toBe(429);
  });

  it('enforces the configured login budget independently of the request budget', async () => {
    const app = await start({ RATE_LIMIT_REQUESTS: '5' });
    const login = () => app.inject({ method: 'POST', url: '/api/session', headers: { origin },
      payload: { method: 'basic', username: 'invalid:name', password: 'test-password' } });
    expect((await login()).statusCode).toBe(400);
    expect((await login()).statusCode).toBe(429);
    expect((await app.inject({ url: '/api/session' })).statusCode).toBe(401);
  });

  it.each(['true', '1', 'loopback', '0.0.0.0/0', '::/0', '192.0.2.1/33', '::1/129', '192.0.2.1,', '192.0.2.1/24/8'])('rejects invalid or unrestricted proxy trust %s', value => {
    expect(() => loadConfig({ CALDAV_URL: 'https://dav.example.test/', TRUSTED_PROXIES: value })).toThrow('TRUSTED_PROXIES');
  });

  it('accepts explicit IPv4 and IPv6 proxy addresses and rejects disabled rate limits', () => {
    const config = loadConfig({ CALDAV_URL: 'https://dav.example.test/', TRUSTED_PROXIES: '192.0.2.1, ::1, 2001:db8::/64' });
    expect(config.trustedProxies).toEqual(['192.0.2.1', '::1', '2001:db8::/64']);
    for (const key of ['RATE_LIMIT_REQUESTS', 'RATE_LIMIT_LOGINS']) {
      expect(() => loadConfig({ CALDAV_URL: 'https://dav.example.test/', [key]: '0' })).toThrow();
    }
  });
});

const draft: EventDraft = { calendarId: '', title: 'Test', description: 'Private notes', location: '', start: '2026-10-04T09:00:00', end: '2026-10-04T10:00:00', allDay: false, timezone: 'Europe/Prague', reminder: 1440, recurrence: defaultRecurrence };
describe('same-origin CalDAV API', () => {
  let dav: Awaited<ReturnType<typeof mockDav>>;
  let system: Awaited<ReturnType<typeof createApp>>;
  let cookie: string; let csrf: string; let calendar: Calendar;
  const origin = 'https://calendar.test';
  const headers = () => ({ cookie, origin, 'x-csrf-token': csrf });
  const login = async () => {
    const result = await system.app.inject({ method: 'POST', url: '/api/session', headers: { origin }, payload: { method: 'basic', username: 'user', password: 'password' } });
    expect(result.statusCode, result.body).toBe(200);
    cookie = String(result.headers['set-cookie']).split(';')[0]; csrf = result.json().csrf; calendar = result.json().calendars[0];
    return result;
  };
  const create = (creationId = randomUUID(), operationId = randomUUID()) => system.app.inject({ method: 'POST', url: '/api/events', headers: { ...headers(), 'idempotency-key': operationId, 'x-event-id': creationId }, payload: { ...draft, calendarId: calendar.id } });
  beforeEach(async () => {
    dav = await mockDav();
    system = await createApp(loadConfig({ CALDAV_URL: dav.url, CALDAV_ALLOW_HTTP: 'true', APP_ORIGIN: origin, UPSTREAM_TIMEOUT_MS: '500' }));
    await login();
  });
  afterEach(async () => { await system?.app.close(); await dav?.close(); });
  it('imports with stable identities, avoids duplicates, and exports full calendars', async () => {
    const source = writeEvent({ ...draft, title: 'Imported', recurrence: { ...defaultRecurrence, frequency: 'DAILY', end: 'count', count: 2 } }, 'foreign-uid');
    const preview = await system.app.inject({ method: 'POST', url: '/api/import/preview', headers: headers(), payload: { ics: source } });
    expect(preview.statusCode, preview.body).toBe(200); expect(preview.json()[0].uid).toBe('foreign-uid');
    const put = () => system.app.inject({ method: 'POST', url: '/api/import', headers: { ...headers(), 'idempotency-key': randomUUID() }, payload: { calendarId: calendar.id, ics: source } });
    dav.state.mode = 'drop-after-put';
    expect((await put()).json().state).toBe('success');
    await login(); expect((await put()).json().state).toBe('success'); expect(dav.objects.size).toBe(1);
    const exported = await system.app.inject({ url: `/api/calendars/${calendar.id}/export`, headers: headers() });
    expect(exported.statusCode, exported.body).toBe(200); expect(exported.json().ics).toContain('UID:foreign-uid'); expect(exported.json().ics).toContain('BEGIN:VALARM');
    const changed = await system.app.inject({ method: 'POST', url: '/api/import', headers: { ...headers(), 'idempotency-key': randomUUID() }, payload: { calendarId: calendar.id, ics: source.replace('SUMMARY:Imported', 'SUMMARY:Different') } });
    expect(changed.statusCode).toBe(200); expect(changed.json().skipped).toBe(true); expect([...dav.objects.values()][0]).toContain('SUMMARY:Imported');
  });
  it('searches across months and normalizes location, description, and accents', async () => {
    dav.objects.set('/u/calendar/search.ics', writeEvent({ ...draft, title: 'Winter visit', location: 'Café', start: '2026-12-04T09:00:00', end: '2026-12-04T10:00:00' }, 'search'));
    const params = new URLSearchParams({ q: 'CAFE', start: '2026-01-01T00:00:00Z', end: '2027-01-01T00:00:00Z', timezone: 'Europe/Prague', calendars: calendar.id });
    const result = await system.app.inject({ url: `/api/search?${params}`, headers: headers() });
    expect(result.statusCode, result.body).toBe(200); expect(result.json().occurrences).toHaveLength(1); expect(result.json().occurrences[0].title).toBe('Winter visit');
    params.set('q', 'PRIVATE NOTES'); expect((await system.app.inject({ url: `/api/search?${params}`, headers: headers() })).json().occurrences).toHaveLength(1);
  });
  it('updates and cancels occurrences with conditional PUTs, preserving the master', async () => {
    dav.objects.set('/u/calendar/series.ics', writeEvent({ ...draft, recurrence: { ...defaultRecurrence, frequency: 'DAILY', end: 'count', count: 3 } }, 'series'));
    const list = await system.app.inject({ url: `/api/events?${new URLSearchParams({ start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z', timezone: 'Europe/Prague', calendars: calendar.id })}`, headers: headers() });
    const occurrence = list.json().occurrences[1];
    const url = `/api/events/${occurrence.resourceId}?${new URLSearchParams({ recurrenceId: occurrence.recurrenceId })}`;
    const detail = (await system.app.inject({ url, headers: headers() })).json<EventDetail>();
    expect(detail.draft.start).toBe('2026-10-05T09:00:00');
    const result = await system.app.inject({ method: 'PATCH', url, headers: { ...headers(), 'if-match': detail.etag, 'idempotency-key': randomUUID() }, payload: { ...detail.draft, title: 'Just Monday' } });
    expect(result.json().state, result.body).toBe('success');
    const latest = (await system.app.inject({ url, headers: headers() })).json<EventDetail>();
    const removed = await system.app.inject({ method: 'DELETE', url, headers: { ...headers(), 'if-match': latest.etag, 'idempotency-key': randomUUID() } });
    expect(removed.json().state, removed.body).toBe('success'); expect(dav.objects.size).toBe(1);
    expect(dav.requests.filter(r => r.method === 'PUT')).toHaveLength(2); expect(dav.requests.filter(r => r.method === 'DELETE')).toHaveLength(0);
    const original = dav.objects.get('/u/calendar/series.ics')!; expect(original).toContain('SUMMARY:Test'); expect(original).toContain('STATUS:CANCELLED'); expect(original).toContain('COUNT=3');
  });
  it('sets secure opaque session cookies and reads calendar permissions', async () => {
    const result = await login();
    expect(result.headers['set-cookie']).toContain('HttpOnly'); expect(result.headers['set-cookie']).toContain('Secure'); expect(result.headers['set-cookie']).toContain('SameSite=Strict');
    expect(result.body).not.toContain('password'); expect(calendar).toMatchObject({ name: 'Personal', canCreate: true, canUpdate: true, canDelete: true });
  });
  it('requires the configured origin and CSRF for mutations', async () => {
    const result = await system.app.inject({ method: 'POST', url: '/api/session', payload: { method: 'basic', username: 'user', password: 'password' } }); expect(result.statusCode).toBe(403);
    expect((await system.app.inject({ method: 'DELETE', url: '/api/session', headers: { cookie, origin } })).statusCode).toBe(403);
    expect((await system.app.inject({ method: 'DELETE', url: '/api/session', headers: { ...headers(), origin: 'https://different.test' } })).statusCode).toBe(403);
  });
  it('accepts gateway bearer tokens without exposing them to the browser', async () => {
    dav.state.allowBearer = true;
    const result = await system.app.inject({ method: 'POST', url: '/api/session', headers: { origin }, payload: { method: 'bearer', token: 'test-token' } });
    expect(result.statusCode, result.body).toBe(200); expect(result.body).not.toContain('test-token'); expect(result.json().calendars).toHaveLength(1);
  });
  it('keeps a stable creation identity when a new mutation key would conflict', async () => {
    const identity = randomUUID(); expect((await create(identity)).json().state).toBe('success');
    const result = await system.app.inject({ method: 'POST', url: '/api/events', headers: { ...headers(), 'idempotency-key': randomUUID(), 'x-event-id': identity }, payload: { ...draft, calendarId: calendar.id, title: 'Changed retry' } });
    expect(result.statusCode, result.body).toBe(409); expect(result.json().latest.draft.title).toBe('Test'); expect(dav.objects.size).toBe(1);
  });
  it('creates, lists, updates, and deletes only with conditional headers', async () => {
    const created = await create(); expect(created.statusCode, created.body).toBe(200); expect(created.json().state).toBe('success');
    const id = created.json().resourceId;
    const list = await system.app.inject({ url: `/api/events?${new URLSearchParams({ start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z', timezone: 'Europe/Prague', calendars: calendar.id })}`, headers: headers() });
    expect(list.statusCode, list.body).toBe(200); expect(list.json().occurrences).toHaveLength(1);
    const detail = (await system.app.inject({ url: `/api/events/${id}`, headers: headers() })).json<EventDetail>();
    const updated = await system.app.inject({ method: 'PATCH', url: `/api/events/${id}`, headers: { ...headers(), 'if-match': detail.etag, 'idempotency-key': randomUUID() }, payload: { ...detail.draft, title: 'Updated' } });
    expect(updated.statusCode, updated.body).toBe(200); expect([...dav.objects.values()][0]).toContain('SUMMARY:Updated');
    const latest = (await system.app.inject({ url: `/api/events/${id}`, headers: headers() })).json<EventDetail>();
    const removed = await system.app.inject({ method: 'DELETE', url: `/api/events/${id}`, headers: { ...headers(), 'if-match': latest.etag, 'idempotency-key': randomUUID() } });
    expect(removed.json().state).toBe('success'); expect(dav.objects.size).toBe(0);
    const writes = dav.requests.filter(r => ['PUT', 'DELETE'].includes(r.method)); expect(writes[0].headers['if-none-match']).toBe('*'); expect(writes[1].headers['if-match']).toBe(detail.etag); expect(writes[2].headers['if-match']).toBe(latest.etag);
  });
  it('detects races at PUT and returns the latest server version for review', async () => {
    const id = (await create()).json().resourceId;
    const detail = (await system.app.inject({ url: `/api/events/${id}`, headers: headers() })).json<EventDetail>();
    dav.state.beforePut = () => { const [path, ics] = [...dav.objects][0]; dav.objects.set(path, ics.replace('SUMMARY:Test', 'SUMMARY:Other client')); };
    const result = await system.app.inject({ method: 'PATCH', url: `/api/events/${id}`, headers: { ...headers(), 'if-match': detail.etag, 'idempotency-key': randomUUID() }, payload: { ...detail.draft, title: 'Draft' } });
    expect(result.statusCode, result.body).toBe(409); expect(result.json().latest.draft.title).toBe('Other client'); expect([...dav.objects.values()][0]).not.toContain('SUMMARY:Draft');
  });
  it('resolves a lost successful create response without duplicating an event', async () => {
    dav.state.mode = 'drop-after-put'; const id = randomUUID(), operationId = randomUUID();
    const result = await create(id, operationId); expect(result.statusCode, result.body).toBe(200); expect(result.json().state).toBe('success');
    const retry = await create(id, operationId); expect(retry.json().state).toBe('success'); expect(dav.objects.size).toBe(1);
  });
  it('retains uncertain operation status until the server is reachable', async () => {
    dav.state.mode = 'unavailable-after-put'; const result = await create(); expect(result.json().state).toBe('uncertain');
    dav.state.unavailable = false;
    const status = await system.app.inject({ url: `/api/operations/${result.json().id}`, headers: headers() }); expect(status.json().state).toBe('success'); expect(dav.objects.size).toBe(1);
  });
  it('safely retries the same creation identity after a failed save', async () => {
    dav.state.mode = 'drop-before-put'; const id = randomUUID(); const failed = await create(id);
    expect(failed.json().state).toBe('failed'); expect(dav.objects.size).toBe(0);
    const retry = await create(id); expect(retry.json().state).toBe('success'); expect(dav.objects.size).toBe(1);
  });
  it('blocks writes to read-only calendars', async () => {
    dav.state.readOnly = true; const discovered = await system.app.inject({ url: '/api/calendars', headers: headers() }); expect(discovered.json().calendars[0].canCreate).toBe(false);
    const result = await create(); expect(result.statusCode).toBe(403); expect(dav.objects.size).toBe(0);
  });
  it('bounds date ranges and request bodies', async () => {
    const result = await system.app.inject({ url: `/api/events?${new URLSearchParams({ start: '2026-01-01T00:00:00Z', end: '2027-01-01T00:00:00Z', timezone: 'UTC', calendars: calendar.id })}`, headers: headers() }); expect(result.statusCode).toBe(400);
    const large = await system.app.inject({ method: 'POST', url: '/api/events', headers: { ...headers(), 'idempotency-key': randomUUID() }, payload: { ...draft, description: 'a'.repeat(300000) } }); expect(large.statusCode).toBe(413);
  });
  it('removes access after logout and absolute session expiry', async () => {
    expect((await system.app.inject({ method: 'DELETE', url: '/api/session', headers: headers() })).statusCode).toBe(200);
    expect((await system.app.inject({ url: '/api/calendars', headers: headers() })).statusCode).toBe(401);
    await login(); const session = system.sessions.get(cookie.split('=')[1]); session.created -= 9 * 3600000;
    expect((await system.app.inject({ url: '/api/session', headers: headers() })).statusCode).toBe(401); expect(session.abort.signal.aborted).toBe(true);
  });
  it('rejects an old session without clearing a newly issued cookie', async () => {
    const oldCookie = cookie;
    const result = await system.app.inject({ method: 'POST', url: '/api/session', headers: headers(), payload: { method: 'basic', username: 'user', password: 'password' } });
    expect(result.statusCode).toBe(200);
    const stale = await system.app.inject({ url: '/api/calendars', headers: { cookie: oldCookie } });
    expect(stale.statusCode).toBe(401); expect(stale.headers['set-cookie']).toBeUndefined();
    const renewed = String(result.headers['set-cookie']).split(';')[0];
    expect((await system.app.inject({ url: '/api/session', headers: { cookie: renewed } })).statusCode).toBe(200);
  });
});
