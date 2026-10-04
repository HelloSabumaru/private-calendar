import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutgoingHttpHeaders } from 'node:http';
import { createApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { retainOperation, retainResource } from '../src/server/sessions.js';
import { mockDav } from './dav-server.js';

const origin = 'https://calendar.test';
const credentials = { method: 'basic', username: 'user', password: 'password' };
const cookieFrom = (response: { headers: OutgoingHttpHeaders }) => String(response.headers['set-cookie']).split(';')[0];
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

describe('session replacement at capacity', () => {
  let dav: Awaited<ReturnType<typeof mockDav>>;
  let system: Awaited<ReturnType<typeof createApp>>;
  let cookie: string;
  let pauseDiscoveryResponse: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  const login = (existingCookie?: string, password = credentials.password) => system.app.inject({
    method: 'POST', url: '/api/session', headers: { origin, ...(existingCookie ? { cookie: existingCookie } : {}) },
    payload: { ...credentials, password },
  });
  const sessionRequest = (sessionCookie: string) => system.app.inject({ url: '/api/session', headers: { cookie: sessionCookie } });
  beforeEach(async () => {
    dav = await mockDav();
    pauseDiscoveryResponse = undefined;
    const controlledFetch: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const pause = url.pathname === '/u/calendar/' ? pauseDiscoveryResponse : undefined;
      if (pause) pauseDiscoveryResponse = undefined;
      const response = await fetch(input, init);
      if (!pause) return response;
      const buffered = new Response(await response.arrayBuffer(), { status: response.status, statusText: response.statusText, headers: response.headers });
      pause.entered.resolve();
      await pause.release.promise;
      return buffered;
    };
    system = await createApp(loadConfig({ CALDAV_URL: dav.url, CALDAV_ALLOW_HTTP: 'true', APP_ORIGIN: origin, MAX_SESSIONS: '1', UPSTREAM_TIMEOUT_MS: '1000' }), { fetch: controlledFetch });
    const response = await login();
    expect(response.statusCode, response.body).toBe(200);
    cookie = cookieFrom(response);
  });
  afterEach(async () => { await system?.app.close(); await dav?.close(); });

  it('replaces the current session and clears its credentials and retained state', async () => {
    const old = system.sessions.get(cookie.split('=')[1]);
    const calendarId = old.calendars.keys().next().value!;
    const url = new URL('u/calendar/event.ics', dav.url).href;
    retainResource(old, { id: 'event', calendarId, url, etag: '"1"', ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' });
    retainOperation(old, { id: 'operation', state: 'pending', resourceId: 'event', fingerprint: 'test', url, method: 'PUT', intended: 'private event' });
    old.locks.add('event');

    const response = await login(cookie);
    expect(response.statusCode, response.body).toBe(200);
    const renewed = cookieFrom(response);
    expect(renewed).not.toBe(cookie);
    expect(response.json().csrf).not.toBe(old.csrf);
    expect(old.abort.signal.aborted).toBe(true);
    expect(old.client.credentials).toEqual({});
    expect(old.client.authHeaders).toBeUndefined();
    expect(old.client.account?.credentials).toEqual({});
    expect(old.calendars.size).toBe(0);
    expect(old.resources.size).toBe(0);
    expect(old.resourceLocations.size).toBe(0);
    expect(old.resourceLocationBytes).toBe(0);
    expect(old.operations.size).toBe(0);
    expect(old.locks.size).toBe(0);
    expect(old.cacheBytes).toBe(0);
    const stale = await sessionRequest(cookie);
    expect(stale.statusCode).toBe(401);
    expect(stale.headers['set-cookie']).toBeUndefined();
    expect((await sessionRequest(renewed)).statusCode).toBe(200);
  });

  it.each([undefined, '__Host-calendar=unknown'])('rejects a new login at capacity with cookie %s and preserves the current session', async existingCookie => {
    const old = system.sessions.get(cookie.split('=')[1]);
    const admission = vi.spyOn(system.sessions, 'add');
    const response = await login(existingCookie);
    expect(response.statusCode, response.body).toBe(503);
    expect(response.json().code).toBe('SESSION_LIMIT');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(old.abort.signal.aborted).toBe(false);
    expect(old.client.credentials).toMatchObject({ username: 'user', password: 'password' });
    expect((await sessionRequest(cookie)).statusCode).toBe(200);
    const rejected = admission.mock.calls[0][0];
    expect(rejected.abort.signal.aborted).toBe(true);
    expect(rejected.client.credentials).toEqual({});
    expect(rejected.client.authHeaders).toBeUndefined();
    expect(rejected.client.account?.credentials).toEqual({});
  });

  it('keeps the original session usable after authentication fails', async () => {
    const old = system.sessions.get(cookie.split('=')[1]);
    const response = await login(cookie, 'wrong-password');
    expect(response.statusCode, response.body).toBe(401);
    expect(response.json().code).toBe('UPSTREAM_AUTH');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(old.abort.signal.aborted).toBe(false);
    expect(old.client.credentials).toMatchObject({ username: 'user', password: 'password' });
    expect((await sessionRequest(cookie)).statusCode).toBe(200);
    expect((await system.app.inject({ url: '/api/calendars', headers: { cookie } })).statusCode).toBe(200);
  });

  it('admits only one concurrent replacement of the same session at capacity', async () => {
    const responses = await Promise.all([login(cookie), login(cookie)]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 503]);
    const accepted = responses.find(response => response.statusCode === 200)!;
    const rejected = responses.find(response => response.statusCode === 503)!;
    expect(rejected.json().code).toBe('SESSION_LIMIT');
    expect(rejected.headers['set-cookie']).toBeUndefined();
    expect((await sessionRequest(cookie)).statusCode).toBe(401);
    expect((await sessionRequest(cookieFrom(accepted))).statusCode).toBe(200);
  });

  it('rejects an old in-flight response without clearing the replacement cookie', async () => {
    const pause = { entered: deferred(), release: deferred() };
    pauseDiscoveryResponse = pause;
    const pending = system.app.inject({ url: '/api/calendars', headers: { cookie } }).then(response => response);
    await pause.entered.promise;
    let renewed: string;
    try {
      const response = await login(cookie);
      expect(response.statusCode, response.body).toBe(200);
      renewed = cookieFrom(response);
    } finally { pause.release.resolve(); }
    const stale = await pending;
    expect(stale.statusCode, stale.body).toBe(401);
    expect(stale.headers['set-cookie']).toBeUndefined();
    expect((await sessionRequest(renewed)).statusCode).toBe(200);
  });
});
