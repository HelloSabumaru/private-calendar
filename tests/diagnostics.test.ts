import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { ApiError } from '../src/server/errors.js';
import { writeEvent } from '../src/server/ics.js';
import { defaultRecurrence, type Calendar, type EventDraft } from '../src/shared.js';
import { mockDav } from './dav-server.js';

const origin = 'https://calendar.test';
const secret = 'PRIVATE-DIAGNOSTIC-SENTINEL';
const draft: EventDraft = { calendarId: '', title: `${secret}-title`, description: `${secret}-notes`, location: `${secret}-location`,
  start: '2026-10-04T09:00:00', end: '2026-10-04T10:00:00', allDay: false, timezone: 'Europe/Prague', reminder: 1440, recurrence: defaultRecurrence };
type LogRecord = { msg: string; reqId?: string; operationId?: string; step?: string; durationMs?: number; failureCategory?: string; status?: number };
function captureLogs() {
  let output = '';
  const stream = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
  return { stream, text: () => output, records: () => output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as LogRecord) };
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

describe('private operator diagnostics', () => {
  let dav: Awaited<ReturnType<typeof mockDav>>;
  let system: Awaited<ReturnType<typeof createApp>>;
  let logs: ReturnType<typeof captureLogs>;
  let cookie: string; let csrf: string; let accountKey: string; let calendar: Calendar;
  const headers = () => ({ cookie, origin, 'x-csrf-token': csrf, authorization: `${secret}-authorization` });
  const session = () => system.sessions.get(cookie.split('=')[1]);
  const failures = () => logs.records().filter(record => record.msg === 'Calendar processing failed');
  const create = (operationId = randomUUID()) => system.app.inject({ method: 'POST', url: '/api/events',
    headers: { ...headers(), 'idempotency-key': operationId }, payload: { ...draft, calendarId: calendar.id } });
  const inspect = (operationId: string) => system.app.inject({ url: `/api/operations/${operationId}?private=${secret}`, headers: headers() });
  const makeUncertain = async () => {
    session().client.createCalendarObject = async () => new Response(null, { status: 503 });
    session().fetch = async () => new Response(`${secret}-upstream-error`, { status: 503 });
    const operationId = randomUUID(), response = await create(operationId);
    expect(response.statusCode, response.body).toBe(200); expect(response.json().state).toBe('uncertain');
    return { operationId, operation: session().operations.get(operationId)! };
  };
  beforeEach(async () => {
    dav = await mockDav(); logs = captureLogs();
    system = await createApp(loadConfig({ CALDAV_URL: dav.url, CALDAV_ALLOW_HTTP: 'true', APP_ORIGIN: origin }), { logger: { stream: logs.stream } });
    const response = await system.app.inject({ method: 'POST', url: '/api/session', headers: { origin }, payload: { method: 'basic', username: 'user', password: 'password' } });
    expect(response.statusCode, response.body).toBe(200);
    cookie = String(response.headers['set-cookie']).split(';')[0]; csrf = response.json().csrf; accountKey = response.json().accountKey; calendar = response.json().calendars[0];
  });
  afterEach(async () => {
    await system?.app.close(); await dav?.close();
    for (const privateValue of [secret, cookie, csrf, accountKey, dav?.url]) if (privateValue) expect(logs.text()).not.toContain(privateValue);
    for (const record of failures()) {
      expect(record.step).toBeTypeOf('string'); expect(record.failureCategory).toBeTypeOf('string');
      expect(record.durationMs).toBeTypeOf('number'); expect(record.durationMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(record.durationMs)).toBe(true);
    }
  });

  it('omits credentials, headers, invalid operation IDs, and arbitrary request paths', async () => {
    const basic = await system.app.inject({ method: 'POST', url: '/api/session', headers: headers(),
      payload: { method: 'basic', username: `${secret}-username`, password: `${secret}-password` } });
    expect(basic.statusCode).toBe(401);
    const bearer = await system.app.inject({ method: 'POST', url: '/api/session', headers: headers(), payload: { method: 'bearer', token: `${secret}-token` } });
    expect(bearer.statusCode).toBe(401);
    const malformed = await system.app.inject({ method: 'POST', url: `/api/events?private=${secret}`, headers: { ...headers(), 'idempotency-key': secret }, payload: draft });
    expect(malformed.statusCode).toBe(400);
    expect((await system.app.inject({ url: `/api/events/${secret}?q=${secret}`, headers: headers() })).statusCode).toBe(400);
    expect((await system.app.inject({ url: `/unknown/${secret}?q=${secret}`, headers: headers() })).statusCode).toBe(404);
    expect((await system.app.inject({ url: `/bad/%xx/${secret}?q=${secret}`, headers: headers() })).statusCode).toBe(400);
    expect(failures().some(record => record.step === 'login' && record.failureCategory === 'authentication')).toBe(true);
    expect(failures().every(record => !record.operationId)).toBe(true);
  });

  it('reports the failing discovery step without leaking unexpected messages or causes', async () => {
    session().client.fetchCalendars = async () => { throw new Error(`${secret} ${dav.url}`, { cause: { password: secret, ics: writeEvent(draft, secret) } }); };
    const response = await system.app.inject({ url: `/api/calendars?private=${secret}`, headers: headers() });
    expect(response.statusCode).toBe(502); expect(response.json().code).toBe('UPSTREAM'); expect(response.body).not.toContain(secret);
    expect(failures()).toContainEqual(expect.objectContaining({ step: 'discovery', failureCategory: 'upstream-transport' }));
  });

  it('retains the inner resource-read step when an update fails before preparing ICS', async () => {
    const resourceId = (await create()).json().resourceId;
    const detail = (await system.app.inject({ url: `/api/events/${resourceId}`, headers: headers() })).json();
    session().fetch = async () => { throw new Error(secret); };
    const operationId = randomUUID();
    const response = await system.app.inject({ method: 'PATCH', url: `/api/events/${resourceId}`, headers: { ...headers(), 'idempotency-key': operationId, 'if-match': detail.etag }, payload: detail.draft });
    expect(response.statusCode).toBe(502);
    expect(failures()).toContainEqual(expect.objectContaining({ operationId, step: 'resource-read', failureCategory: 'upstream-transport' }));
    expect(session().locks.size).toBe(0);
  });

  it.each([403, 400, 503])('reports measured write response rejection with upstream status %s', async status => {
    session().client.createCalendarObject = async () => new Response(secret, { status });
    session().fetch = async () => new Response(secret, { status: 503 });
    const operationId = randomUUID(), response = await create(operationId);
    expect(response.statusCode).toBe(status === 503 ? 200 : status === 403 ? 403 : 422);
    expect(failures()).toContainEqual(expect.objectContaining({ operationId, step: 'mutation-write', status, failureCategory: status === 403 ? 'authorization' : 'upstream-response' }));
    expect(session().operations.get(operationId)?.state).toBe(status === 503 ? 'uncertain' : 'failed');
  });

  it('logs swallowed inspection exceptions and non-OK responses while retaining uncertain state', async () => {
    const { operationId } = await makeUncertain();
    session().fetch = async () => { throw new Error(`${secret}-inspect`); };
    expect((await inspect(operationId)).json().state).toBe('uncertain');
    session().fetch = async () => new Response(secret, { status: 403 });
    expect((await inspect(operationId)).json().state).toBe('uncertain');
    session().fetch = async () => new Response(secret, { status: 404 });
    expect((await inspect(operationId)).json().state).toBe('failed');
    expect(failures()).toContainEqual(expect.objectContaining({ operationId, step: 'reconciliation-read', failureCategory: 'upstream-transport' }));
    expect(failures()).toContainEqual(expect.objectContaining({ operationId, step: 'reconciliation-read', failureCategory: 'authorization', status: 403 }));
    expect(failures()).toContainEqual(expect.objectContaining({ operationId, step: 'reconciliation-read', failureCategory: 'not-found', status: 404 }));
  });

  it.each(['actual', 'intended'] as const)('distinguishes failed canonicalization of %s ICS from transport errors', async side => {
    const { operationId, operation } = await makeUncertain(), original = operation.intended!;
    session().fetch = async () => new Response(side === 'actual' ? secret : original);
    if (side === 'intended') operation.intended = secret;
    expect((await inspect(operationId)).json().state).toBe('uncertain');
    expect(failures()).toContainEqual(expect.objectContaining({ operationId, step: `reconciliation-canonical-${side}`, failureCategory: 'ics-processing' }));
    operation.intended = original; session().fetch = async () => new Response(original);
    expect((await inspect(operationId)).json().state).toBe('success');
  });

  it('propagates genuine401 inspection failures and expires the session', async () => {
    const current = session(), { operationId } = await makeUncertain();
    current.fetch = async () => { throw new ApiError(401, 'UPSTREAM_AUTH', 'The CalDAV server rejected your credentials. Sign in again.'); };
    const response = await inspect(operationId);
    expect(response.statusCode).toBe(401); expect(current.abort.signal.aborted).toBe(true);
    expect(failures()).toContainEqual(expect.objectContaining({ operationId, step: 'reconciliation-read', failureCategory: 'authentication', status: 401 }));
  });

  it('keeps concurrent operation IDs and failure categories isolated, including primitive throws', async () => {
    const first = randomUUID(), second = randomUUID(), entered = deferred(), release = deferred(); let count = 0;
    session().client.createCalendarObject = async ({ filename }) => {
      if (++count === 2) entered.resolve(); await release.promise;
      if (filename === `${first}.ics`) throw secret;
      throw new DOMException(secret, 'TimeoutError');
    };
    session().fetch = async () => new Response(secret, { status: 503 });
    const pending = [create(first).then(response => response), create(second).then(response => response)];
    await entered.promise; release.resolve();
    for (const response of await Promise.all(pending)) expect(response.json().state).toBe('uncertain');
    const records = failures().filter(record => record.step === 'mutation-write');
    expect(records).toHaveLength(2);
    expect(records).toContainEqual(expect.objectContaining({ operationId: first, failureCategory: 'upstream-transport' }));
    expect(records).toContainEqual(expect.objectContaining({ operationId: second, failureCategory: 'timeout' }));
    expect(new Set(records.map(record => record.reqId)).size).toBe(2);
  });

  it('reports partial range failures without exposing calendar names or event fields', async () => {
    session().calendars.get(calendar.id)!.calendar.name = `${secret}-calendar`;
    session().client.fetchCalendarObjects = async () => { throw new Error(secret); };
    const params = new URLSearchParams({ start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z', timezone: 'Europe/Prague', calendars: calendar.id });
    const response = await system.app.inject({ url: `/api/events?${params}`, headers: headers() });
    expect(response.statusCode).toBe(200); expect(response.json().complete).toBe(false); expect(response.json().warnings).toHaveLength(1);
    expect(failures()).toContainEqual(expect.objectContaining({ step: 'calendar-range', failureCategory: 'upstream-transport' }));
  });

  it('keeps successful DELETE404 and duplicate imports quiet', async () => {
    const resourceId = (await create()).json().resourceId;
    const detail = (await system.app.inject({ url: `/api/events/${resourceId}`, headers: headers() })).json();
    session().client.deleteCalendarObject = async () => new Response(null, { status: 404 });
    const removed = await system.app.inject({ method: 'DELETE', url: `/api/events/${resourceId}`, headers: { ...headers(), 'if-match': detail.etag, 'idempotency-key': randomUUID() } });
    expect(removed.json().state).toBe('success');
    const payload = { calendarId: calendar.id, ics: writeEvent(draft, `${secret}-foreign-uid`) };
    const importOne = () => system.app.inject({ method: 'POST', url: '/api/import', headers: { ...headers(), 'idempotency-key': randomUUID() }, payload });
    expect((await importOne()).json().state).toBe('success'); expect((await importOne()).json().skipped).toBe(true);
    expect(failures()).toHaveLength(0);
  });

  it('logs a lost DELETE response but keeps confirming reconciliation404 quiet', async () => {
    const resourceId = (await create()).json().resourceId;
    const detail = (await system.app.inject({ url: `/api/events/${resourceId}`, headers: headers() })).json();
    session().client.deleteCalendarObject = async () => { dav.objects.clear(); throw new Error(secret); };
    const operationId = randomUUID();
    const response = await system.app.inject({ method: 'DELETE', url: `/api/events/${resourceId}`, headers: { ...headers(), 'if-match': detail.etag, 'idempotency-key': operationId } });
    expect(response.json().state).toBe('success'); expect(dav.objects.size).toBe(0);
    expect(failures()).toEqual([expect.objectContaining({ operationId, step: 'mutation-write', failureCategory: 'upstream-transport' })]);
  });

  it('preserves parser/body-limit/rate-limit responses and correlates session-guard errors', async () => {
    const operationId = randomUUID();
    const csrfError = await system.app.inject({ method: 'POST', url: '/api/events', headers: { ...headers(), 'x-csrf-token': secret, 'idempotency-key': operationId }, payload: draft });
    expect(csrfError.statusCode).toBe(403);
    expect(failures()).toContainEqual(expect.objectContaining({ operationId, step: 'session-guard', failureCategory: 'authorization' }));
    const invalidPatch = await system.app.inject({ method: 'PATCH', url: `/api/events/${'a'.repeat(43)}`, headers: { ...headers(), 'idempotency-key': operationId }, payload: {} });
    expect(invalidPatch.statusCode).toBe(400);
    expect(failures()).toContainEqual(expect.objectContaining({ operationId, failureCategory: 'validation' }));
    const parserError = await system.app.inject({ method: 'POST', url: '/api/events', headers: { ...headers(), 'content-type': 'application/json' }, payload: `${secret}{` });
    expect(parserError.statusCode).toBe(400);
    const bodyError = await system.app.inject({ method: 'POST', url: '/api/events', headers: headers(), payload: { ...draft, description: secret.repeat(20000) } });
    expect(bodyError.statusCode).toBe(413);
    const limited = await createApp(loadConfig({ CALDAV_URL: dav.url, CALDAV_ALLOW_HTTP: 'true', APP_ORIGIN: origin }), { logger: { stream: logs.stream }, limits: { requests: 1, logins: 1 } });
    try {
      const login = () => limited.app.inject({ method: 'POST', url: '/api/session', headers: { origin }, payload: { method: 'basic', username: 'user', password: 'password' } });
      expect((await login()).statusCode).toBe(200); expect((await login()).statusCode).toBe(429);
    } finally { await limited.app.close(); }
    expect(failures()).toContainEqual(expect.objectContaining({ status: 400, failureCategory: 'validation' }));
    expect(failures()).toContainEqual(expect.objectContaining({ status: 413, failureCategory: 'validation' }));
    expect(failures()).toContainEqual(expect.objectContaining({ status: 429, failureCategory: 'capacity' }));
  });

  it('leaves logging disabled when no logger is requested', async () => {
    const quiet = await createApp(loadConfig({ CALDAV_URL: dav.url, CALDAV_ALLOW_HTTP: 'true', APP_ORIGIN: origin }));
    const stdout = vi.spyOn(process.stdout, 'write'), stderr = vi.spyOn(process.stderr, 'write');
    try {
      expect((await quiet.app.inject({ url: '/api/session' })).statusCode).toBe(401);
      expect(stdout).not.toHaveBeenCalled(); expect(stderr).not.toHaveBeenCalled();
    } finally { stdout.mockRestore(); stderr.mockRestore(); await quiet.app.close(); }
  });
});
