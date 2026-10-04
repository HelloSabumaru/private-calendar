import type { ApiErrorData } from '../shared';

export const isDemo = import.meta.env.MODE === 'demo';

export class RequestError extends Error {
  constructor(public status: number, public data: ApiErrorData) { super(data.message); }
}
let csrf = '';
let accountKey = '';
let sessionGeneration = 0;
export function invalidateSessionRequests() { sessionGeneration++; }
export function setCSRF(value: string, account = '') { invalidateSessionRequests(); csrf = value; accountKey = account; }
export async function api<T>(path: string, options: RequestInit = {}, renewSession = true): Promise<T> {
  const generation = sessionGeneration;
  const expectedAccount = accountKey;
  const ensureCurrent = () => {
    if (generation !== sessionGeneration) throw new RequestError(401, { code: 'SESSION_CHANGED', message: 'The session changed. Your draft is retained; sign in to the same account to continue.' });
  };
  const request: RequestInit = { ...options, credentials: 'same-origin',
    signal: options.signal ?? AbortSignal.timeout(45000),
    headers: { ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), 'X-CSRF-Token': csrf, ...options.headers } };
  const response = isDemo ? await (await import('./demo')).demoRequest(path, request) : await fetch(`/api${path}`, request);
  let body;
  try { body = await response.json(); } catch { throw new RequestError(response.status, { code: 'NETWORK', message: 'The server returned an unreadable response. Your draft is retained.' }); }
  ensureCurrent();
  if (!response.ok) {
    if (renewSession && expectedAccount && path !== '/session' && (response.status === 401 || response.status === 403 && body.code === 'CSRF')) {
      const renewed = await api<{ csrf: string; accountKey: string }>('/session', {}, false);
      ensureCurrent();
      if (renewed.accountKey !== expectedAccount) {
        window.dispatchEvent(new Event('calendar:expired'));
        throw new RequestError(401, { code: 'ACCOUNT_CHANGED', message: 'The signed-in account changed in another tab. Sign in again before saving this draft.' });
      }
      csrf = renewed.csrf;
      return api<T>(path, options, false);
    }
    if (response.status === 401 && expectedAccount) window.dispatchEvent(new Event('calendar:expired'));
    throw new RequestError(response.status, body);
  }
  return body as T;
}
export const errorMessage = (error: unknown) => error instanceof RequestError ? error.message : 'Could not reach the calendar service. Try again.';
