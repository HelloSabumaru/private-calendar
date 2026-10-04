import { describe, expect, it, vi } from 'vitest';
import { allowedUrl, createTransport } from '../src/server/transport.js';
import { loadConfig } from '../src/server/config.js';
const config = loadConfig({ CALDAV_URL: 'https://dav.test/dav/', CALDAV_ALLOWED_PATHS: '/dav/,/principals/', APP_ORIGIN: 'https://calendar.test' });
describe('restricted upstream transport', () => {
  it('allows authorized paths and rejects other destinations and ambiguous paths', () => {
    expect(allowedUrl('/dav/user/event.ics', config).pathname).toBe('/dav/user/event.ics');
    expect(allowedUrl('/principals/user/', config).pathname).toBe('/principals/user/');
    for (const url of ['https://other.test/dav/', 'http://dav.test/dav/', '/dav-other/', '/private/', '/dav/%252e%252e/private', '/dav/%5cprivate', '/dav/event.ics?destination=other', 'https://user:secret@dav.test/dav/']) expect(() => allowedUrl(url, config)).toThrow();
  });
  it('validates each redirect before forwarding credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://other.test/dav/' } }));
    await expect(createTransport(config, fetcher)('https://dav.test/dav/', { headers: { Authorization: 'Bearer test' } })).rejects.toThrow('outside');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('keeps DAV methods on permitted read redirects and refuses mutation redirects', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: '/dav/final/' } })).mockResolvedValueOnce(new Response('ok'));
    const result = await createTransport(config, fetcher)('https://dav.test/dav/', { method: 'PROPFIND', body: '<propfind/>', headers: { Authorization: 'Bearer test' } });
    expect(await result.text()).toBe('ok'); expect(fetcher.mock.calls[1][1]?.method).toBe('PROPFIND');
    fetcher.mockResolvedValue(new Response(null, { status: 307, headers: { location: '/dav/final/' } }));
    await expect(createTransport(config, fetcher)('https://dav.test/dav/', { method: 'PUT' })).rejects.toThrow('redirect');
  });
  it('limits response size even without Content-Length', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('a'.repeat(10 * 1024 * 1024 + 1)));
    await expect(createTransport(config, fetcher)('https://dav.test/dav/')).rejects.toThrow('too large');
  });
  it('defaults to verified HTTPS and makes private HTTP an explicit opt-in', () => {
    expect(() => loadConfig({ CALDAV_URL: 'http://localhost:5232/' })).toThrow('HTTPS');
    expect(loadConfig({ CALDAV_URL: 'http://localhost:5232/', CALDAV_ALLOW_HTTP: 'true' }).CALDAV_ALLOW_HTTP).toBe(true);
    expect(() => loadConfig({ CALDAV_URL: 'https://user:secret@dav.test/' })).toThrow('credentials');
    expect(() => loadConfig({ CALDAV_URL: 'https://dav.test/', APP_ORIGIN: 'http://calendar.test' })).toThrow('HTTPS');
  });
});
