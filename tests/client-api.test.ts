import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, setCSRF } from '../src/client/api';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('client request session boundaries', () => {
  let expired = vi.fn<() => void>();
  beforeEach(() => {
    const events = new EventTarget(); expired = vi.fn<() => void>(); events.addEventListener('calendar:expired', expired);
    vi.stubGlobal('window', events); setCSRF('csrf-old', 'account-old');
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('rejects private responses from a previous session', async () => {
    const response = deferred<Response>(); vi.stubGlobal('fetch', vi.fn(() => response.promise));
    const request = api('/events/old');
    const rejected = expect(request).rejects.toMatchObject({ data: { code: 'SESSION_CHANGED' } });
    setCSRF('csrf-new', 'account-new'); response.resolve(json({ title: 'Old private event' }));
    await rejected; expect(expired).not.toHaveBeenCalled();
  });

  it.each([401, 403])('does not renew or expire a new session for an obsolete %s', async status => {
    const response = deferred<Response>(); const fetch = vi.fn(() => response.promise); vi.stubGlobal('fetch', fetch);
    const request = api('/events/old');
    const rejected = expect(request).rejects.toMatchObject({ data: { code: 'SESSION_CHANGED' } });
    setCSRF('csrf-new', 'account-new'); response.resolve(json({ code: status === 403 ? 'CSRF' : 'SESSION', message: 'Old session' }, status));
    await rejected; expect(expired).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry an old write when its session renewal finishes after logout', async () => {
    const renewal = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(json({ code: 'CSRF', message: 'Renew' }, 403)).mockImplementationOnce(() => renewal.promise);
    vi.stubGlobal('fetch', fetch);
    const request = api('/events/old', { method: 'PATCH', body: '{}' });
    const rejected = expect(request).rejects.toMatchObject({ data: { code: 'SESSION_CHANGED' } });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    setCSRF(''); renewal.resolve(json({ accountKey: 'account-old', csrf: 'renewed-old' }));
    await rejected; expect(fetch).toHaveBeenCalledTimes(2); expect(expired).not.toHaveBeenCalled();
  });

  it('renews the same account and retries with its new CSRF token', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ code: 'CSRF', message: 'Renew' }, 403))
      .mockResolvedValueOnce(json({ accountKey: 'account-old', csrf: 'renewed' })).mockResolvedValueOnce(json({ saved: true }));
    vi.stubGlobal('fetch', fetch);
    await expect(api('/events/old', { method: 'PATCH', body: '{}' })).resolves.toEqual({ saved: true });
    expect(fetch.mock.calls[2][1].headers['X-CSRF-Token']).toBe('renewed'); expect(expired).not.toHaveBeenCalled();
  });
});
