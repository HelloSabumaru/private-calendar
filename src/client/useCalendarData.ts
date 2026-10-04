import { useCallback, useEffect, useRef, useState } from 'react';
import type { Calendar, Occurrence, Preferences } from '../shared';
import { api, errorMessage } from './api';
import { midnight } from './dates';
import type { SessionBoundary, SessionInfo } from './useSession';

const empty = { calendars: [] as Calendar[], events: [] as Occurrence[], warnings: [] as string[], lastRefresh: '' };
export function useCalendarData(session: SessionInfo | undefined, boundary: SessionBoundary, start: string, end: string, prefs: Preferences, onError: (message: string) => void) {
  const [data, setData] = useState(empty);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const activeRequest = useRef<AbortController | undefined>(undefined);
  const refresh = useCallback(() => { if (!activeRequest.current && boundary.capture()) setRevision(value => value + 1); }, [boundary]);
  useEffect(() => boundary.subscribe(() => {
    activeRequest.current?.abort(); activeRequest.current = undefined;
    setData(empty); setLoading(false);
  }), [boundary]);
  useEffect(() => {
    const ticket = boundary.capture();
    if (!session || !ticket) return;
    const controller = new AbortController();
    activeRequest.current = controller; setLoading(true);
    const isCurrent = () => !controller.signal.aborted && ticket.isCurrent() && activeRequest.current === controller;
    void (async () => {
      try {
        const result = await api<{ calendars: Calendar[] }>('/calendars', { signal: controller.signal });
        if (!isCurrent()) return;
        setData(previous => ({ ...previous, calendars: JSON.stringify(previous.calendars) === JSON.stringify(result.calendars) ? previous.calendars : result.calendars }));
        const ids = result.calendars.filter(calendar => !prefs.hiddenCalendars.includes(calendar.id)).map(calendar => calendar.id).join(',');
        const params = new URLSearchParams({ start: midnight(start, prefs.timezone), end: midnight(end, prefs.timezone), timezone: prefs.timezone, calendars: ids });
        const events = await api<{ occurrences: Occurrence[]; warnings: string[]; refreshedAt: string; complete: boolean }>(`/events?${params}`, { signal: controller.signal });
        if (!isCurrent()) return;
        setData(previous => ({ ...previous, events: events.occurrences, warnings: events.warnings, lastRefresh: events.complete ? events.refreshedAt : previous.lastRefresh }));
        onError('');
      } catch (error) { if (isCurrent()) onError(errorMessage(error)); }
      finally { if (isCurrent()) { activeRequest.current = undefined; setLoading(false); } }
    })();
    return () => { controller.abort(); if (activeRequest.current === controller) activeRequest.current = undefined; };
  }, [session, boundary, start, end, prefs.timezone, prefs.hiddenCalendars, revision, onError]);
  useEffect(() => {
    if (!session) return;
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    const timer = window.setInterval(visible, 60000);
    document.addEventListener('visibilitychange', visible); window.addEventListener('focus', visible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('focus', visible); };
  }, [session, refresh]);
  const changed = () => setRevision(value => value + 1);
  return { ...data, loading, refresh, changed };
}
