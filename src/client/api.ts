import type { ApiErrorData } from '../shared';

export class RequestError extends Error {
  constructor(public status: number, public data: ApiErrorData) { super(data.message); }
}
let csrf = '';
let accountKey = '';
export function setCSRF(value: string, account = '') { csrf = value; accountKey = account; }
export async function api<T>(path: string, options: RequestInit = {}, renewSession = true): Promise<T> {
  const response = await fetch(`/api${path}`, { ...options, credentials: 'same-origin',
    signal: options.signal ?? AbortSignal.timeout(45000),
    headers: { ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), 'X-CSRF-Token': csrf, ...options.headers } });
  let body;
  try { body = await response.json(); } catch { throw new RequestError(response.status, { code: 'NETWORK', message: 'The server returned an unreadable response. Your draft is retained.' }); }
  if (!response.ok) {
    if (renewSession && accountKey && path !== '/session' && (response.status === 401 || response.status === 403 && body.code === 'CSRF')) {
      const renewed = await api<{ csrf: string; accountKey: string }>('/session', {}, false);
      if (renewed.accountKey !== accountKey) {
        window.dispatchEvent(new Event('calendar:expired'));
        throw new RequestError(401, { code: 'ACCOUNT_CHANGED', message: 'The signed-in account changed in another tab. Sign in again before saving this draft.' });
      }
      csrf = renewed.csrf;
      return api<T>(path, options, false);
    }
    if (response.status === 401 && accountKey) window.dispatchEvent(new Event('calendar:expired'));
    throw new RequestError(response.status, body);
  }
  return body as T;
}
export const errorMessage = (error: unknown) => error instanceof RequestError ? error.message : 'Could not reach the calendar service. Try again.';
