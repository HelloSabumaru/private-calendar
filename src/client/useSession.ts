import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { Calendar, Login, Preferences } from '../shared';
import { api, errorMessage, invalidateSessionRequests, RequestError, setCSRF } from './api';

export type SessionInfo = { accountKey: string; csrf: string; timezones: string[]; calendars?: Calendar[] };
type Transition = { type: 'signed-in' | 'expired' | 'logout' | 'signing-out'; accountChanged: boolean; firstSignIn: boolean; timezone?: string };
type SessionTicket = { accountKey: string; isCurrent: () => boolean };
export type SessionBoundary = {
  capture: () => SessionTicket | undefined;
  subscribe: (listener: (transition: Transition) => void) => () => void;
};

const prefsSchema = z.object({ theme: z.enum(['light', 'dark', 'system']), firstWeekday: z.union([z.literal(0), z.literal(1)]), hour12: z.boolean(),
  timezone: z.string(), defaultCalendar: z.string(), reminder: z.union([z.literal('none'), z.number().int().min(0).max(525600)]), hiddenCalendars: z.array(z.string()).max(256) });
export const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const defaults: Preferences = { theme: 'system', firstWeekday: 1, hour12: false, timezone: browserTimezone, defaultCalendar: '', reminder: 1440, hiddenCalendars: [] };
function loadPreferences(session: SessionInfo): Preferences {
  try {
    const stored = prefsSchema.parse(JSON.parse(localStorage.getItem(`calendar.preferences.${session.accountKey}`) ?? 'null'));
    return { ...stored, timezone: session.timezones.includes(stored.timezone) ? stored.timezone : 'UTC' };
  } catch { return { ...defaults, timezone: session.timezones.includes(browserTimezone) ? browserTimezone : 'UTC' }; }
}

export function useSession() {
  const [session, setSession] = useState<SessionInfo>();
  const [prefs, setPrefs] = useState(defaults);
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState('');
  const current = useRef<SessionInfo | undefined>(undefined);
  const oldAccount = useRef<string | undefined>(undefined);
  const generation = useRef(0);
  const mounted = useRef(false);
  const signingOut = useRef(false);
  const listeners = useRef(new Set<(transition: Transition) => void>());
  const [boundary] = useState<SessionBoundary>(() => ({
    capture: () => {
      const accountKey = current.current?.accountKey;
      if (!accountKey || signingOut.current) return;
      const started = generation.current;
      return { accountKey, isCurrent: () => mounted.current && !signingOut.current && started === generation.current && current.current?.accountKey === accountKey };
    },
    subscribe: listener => { listeners.current.add(listener); return () => { listeners.current.delete(listener); }; },
  }));
  const acceptSession = useCallback((value: SessionInfo) => {
    const preferences = loadPreferences(value);
    const transition: Transition = { type: 'signed-in', accountChanged: !!oldAccount.current && oldAccount.current !== value.accountKey, firstSignIn: !oldAccount.current, timezone: preferences.timezone };
    generation.current++;
    current.current = value; oldAccount.current = value.accountKey;
    setCSRF(value.csrf, value.accountKey); setSession(value); setPrefs(preferences); setLoading(false); setSigningIn(false); setError('');
    for (const listener of listeners.current) listener(transition);
  }, []);
  const clearSession = useCallback((type: 'expired' | 'logout') => {
    generation.current++; current.current = undefined; signingOut.current = false;
    setCSRF(''); setSession(undefined); setLoading(false); setSigningIn(false);
    setError(type === 'expired' ? 'Session expired. Sign in again.' : '');
    for (const listener of listeners.current) listener({ type, accountChanged: false, firstSignIn: false });
  }, []);
  useEffect(() => {
    mounted.current = true;
    const started = generation.current;
    const controller = new AbortController();
    const isCurrent = () => mounted.current && !controller.signal.aborted && started === generation.current;
    const expire = () => clearSession(signingOut.current ? 'logout' : 'expired');
    window.addEventListener('calendar:expired', expire);
    void api<SessionInfo>('/session', { signal: controller.signal }).then(value => { if (isCurrent()) acceptSession(value); }).catch(error => {
      if (isCurrent() && !(error instanceof RequestError && error.status === 401)) setError(errorMessage(error));
    }).finally(() => { if (mounted.current && !controller.signal.aborted && started === generation.current) setLoading(false); });
    return () => { mounted.current = false; generation.current++; controller.abort(); window.removeEventListener('calendar:expired', expire); };
  }, [acceptSession, clearSession]);
  useEffect(() => { document.documentElement.dataset.theme = prefs.theme; }, [prefs.theme]);

  const signIn = async (login: Login) => {
    const started = ++generation.current;
    invalidateSessionRequests();
    const isCurrent = () => mounted.current && started === generation.current;
    setSigningIn(true); setError('');
    try {
      const value = await api<SessionInfo>('/session', { method: 'POST', body: JSON.stringify(login) });
      if (!isCurrent()) return false;
      acceptSession(value); return true;
    } catch (error) { if (isCurrent()) setError(errorMessage(error)); return false; }
    finally { if (isCurrent()) setSigningIn(false); }
  };
  const signOut = async () => {
    if (!current.current || signingOut.current) return;
    const started = ++generation.current;
    signingOut.current = true;
    invalidateSessionRequests();
    for (const listener of listeners.current) listener({ type: 'signing-out', accountChanged: false, firstSignIn: false });
    try { await api('/session', { method: 'DELETE' }); if (mounted.current && started === generation.current) clearSession('logout'); }
    catch (error) {
      if (mounted.current && started === generation.current) {
        signingOut.current = false; setError(errorMessage(error));
        // Restart loading after invalidating requests for a failed sign-out.
        if (current.current) setSession({ ...current.current });
      }
    }
  };
  const savePreferences = (value: Preferences) => {
    setPrefs(value);
    if (current.current) {
      try { localStorage.setItem(`calendar.preferences.${current.current.accountKey}`, JSON.stringify(value)); }
      catch { setError('Preferences could not be stored in this browser.'); }
    }
  };
  return { session, prefs, loading, signingIn, error, setError, boundary, signIn, signOut, savePreferences };
}
