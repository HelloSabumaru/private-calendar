import type { Config } from './config.js';
import { ApiError } from './errors.js';

export function allowedUrl(raw: string | URL, config: Config): URL {
  const url = new URL(raw, config.CALDAV_URL);
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); } catch { throw new ApiError(502, 'DESTINATION', 'The CalDAV server returned an invalid resource URL.'); }
  if (url.origin !== new URL(config.CALDAV_URL).origin || url.username || url.password || url.search || url.hash || /[%\\\u0000-\u001f]/.test(pathname) || pathname.split('/').some(p => p === '.' || p === '..') ||
    !config.allowedPaths.some(prefix => pathname === prefix.replace(/\/$/, '') || pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))) {
    throw new ApiError(502, 'DESTINATION', 'The CalDAV server returned a destination outside the configured paths.');
  }
  return url;
}

export function createTransport(config: Config, baseFetch: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    let url = allowedUrl(request?.url ?? String(input), config);
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const signal = AbortSignal.any([AbortSignal.timeout(config.UPSTREAM_TIMEOUT_MS), ...(init?.signal ? [init.signal] : []), ...(request?.signal ? [request.signal] : [])]);
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await baseFetch(url, { ...init, method, redirect: 'manual', signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects === 3 || !['GET', 'PROPFIND', 'REPORT', 'OPTIONS'].includes(method) || response.status === 303) throw new ApiError(502, 'REDIRECT', 'Unsupported CalDAV redirect. Configure its final endpoint.');
        url = allowedUrl(new URL(location, url), config);
        continue;
      }
      const sizeLimit = 10 * 1024 * 1024;
      if (Number(response.headers.get('content-length')) > sizeLimit) { await response.body?.cancel(); throw new ApiError(502, 'UPSTREAM_LIMIT', 'The CalDAV response is too large.'); }
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.length;
            if (size > sizeLimit) throw new ApiError(502, 'UPSTREAM_LIMIT', 'The CalDAV response is too large.');
            chunks.push(value);
          }
        } finally { await reader.cancel(); }
      }
      return new Response(size ? Buffer.concat(chunks) : null, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    throw new ApiError(502, 'REDIRECT', 'Too many CalDAV redirects.');
  };
}
