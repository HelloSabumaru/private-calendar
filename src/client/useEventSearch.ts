import { useCallback, useEffect, useRef, useState } from 'react';
import type { Calendar, Occurrence, Preferences } from '../shared';
import { api, errorMessage } from './api';
import { addDays, midnight } from './dates';
import type { SessionBoundary } from './useSession';

export function useEventSearch(boundary: SessionBoundary, date: string, prefs: Preferences, calendars: Calendar[]) {
  const [initial] = useState(() => ({ open: false, query: '', from: `${date.slice(0, 4)}-01-01`, end: `${date.slice(0, 4)}-12-31`, results: [] as Occurrence[], searched: false, busy: false, error: '' }));
  const [search, setSearch] = useState(initial);
  const request = useRef<AbortController | undefined>(undefined);
  const cancel = useCallback(() => { request.current?.abort(); request.current = undefined; }, []);
  useEffect(() => boundary.subscribe(() => { cancel(); setSearch(initial); }), [boundary, cancel, initial]);
  const calendarsParam = calendars.filter(calendar => !prefs.hiddenCalendars.includes(calendar.id)).map(calendar => calendar.id).join(',');
  useEffect(() => {
    cancel(); setSearch(previous => ({ ...previous, results: [], searched: false, busy: false, error: '' }));
    return cancel;
  }, [prefs.timezone, calendarsParam, cancel]);
  const change = (field: 'query' | 'from' | 'end', value: string) => {
    cancel(); setSearch(previous => ({ ...previous, [field]: value, busy: false, error: '' }));
  };
  const open = () => setSearch(previous => ({ ...previous, open: true }));
  const close = () => { cancel(); setSearch(previous => ({ ...previous, open: false, busy: false })); };
  const run = async () => {
    const ticket = boundary.capture();
    if (!ticket) return;
    cancel(); const controller = new AbortController(); request.current = controller;
    const isCurrent = () => !controller.signal.aborted && request.current === controller && ticket.isCurrent();
    setSearch(previous => ({ ...previous, busy: true, error: '' }));
    try {
      const params = new URLSearchParams({ q: search.query, start: midnight(search.from, prefs.timezone), end: midnight(addDays(search.end, 1), prefs.timezone), timezone: prefs.timezone, calendars: calendarsParam });
      const result = await api<{ occurrences: Occurrence[]; warnings: string[] }>(`/search?${params}`, { signal: controller.signal });
      if (isCurrent()) setSearch(previous => ({ ...previous, searched: true, results: result.occurrences, error: result.warnings.join(' ') }));
    } catch (error) { if (isCurrent()) setSearch(previous => ({ ...previous, error: errorMessage(error) })); }
    finally { if (isCurrent()) { request.current = undefined; setSearch(previous => ({ ...previous, busy: false })); } }
  };
  return { ...search, openSearch: open, closeSearch: close, runSearch: run, setQuery: (value: string) => change('query', value), setFrom: (value: string) => change('from', value), setEnd: (value: string) => change('end', value) };
}
