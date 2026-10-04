import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { z } from 'zod';
import { defaultRecurrence, type Calendar, type EventDetail, type EventDraft, type Login, type Occurrence, type Preferences as Settings } from '../shared';
import { api, errorMessage, RequestError, setCSRF } from './api';
import { addDays, addMonths, dateLabel, dayEvents, midnight, monthDays, monthLabel, monthStart, moveDraft, timeLabel, today, wallTime, weekStart } from './dates';
import { Editor } from './Editor';
import { Preferences } from './Preferences';
import { Dialog } from './Dialog';
import { Icon } from './Icon';
import { DateField, europeanDate } from './DateField';
import { TimeGrid, weekDates } from './TimeGrid';
import { Transfer } from './Transfer';

type SessionInfo = { accountKey: string; csrf: string; timezones: string[]; calendars?: Calendar[] };
type EditState = { key: string; initial: EventDraft; detail?: EventDetail; accountKey: string };
const prefsSchema = z.object({ theme: z.enum(['light', 'dark', 'system']), firstWeekday: z.union([z.literal(0), z.literal(1)]), hour12: z.boolean(),
  timezone: z.string(), defaultCalendar: z.string(), reminder: z.union([z.literal('none'), z.number().int().min(0).max(525600)]), hiddenCalendars: z.array(z.string()).max(256) });
const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const defaults: Settings = { theme: 'system', firstWeekday: 1, hour12: false, timezone: browserTimezone, defaultCalendar: '', reminder: 1440, hiddenCalendars: [] };
function loadPreferences(session: SessionInfo) {
  try {
    const stored = prefsSchema.parse(JSON.parse(localStorage.getItem(`calendar.preferences.${session.accountKey}`) ?? 'null'));
    return { ...stored, timezone: session.timezones.includes(stored.timezone) ? stored.timezone : 'UTC' };
  } catch { return { ...defaults, timezone: session.timezones.includes(browserTimezone) ? browserTimezone : 'UTC' }; }
}
const colorStyle = (color: string) => {
  const channels = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  const luminance = .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
  return { '--calendar-color': color, '--calendar-text': luminance > .179 ? '#000' : '#fff' } as CSSProperties;
};

export function App() {
  const [session, setSession] = useState<SessionInfo>();
  const [prefs, setPrefs] = useState<Settings>(defaults);
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [events, setEvents] = useState<Occurrence[]>([]);
  const [date, setDate] = useState(today(browserTimezone));
  const [focusDay, setFocusDay] = useState(date);
  const [view, setView] = useState<'month' | 'agenda' | 'week' | 'day'>('month');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [lastRefresh, setLastRefresh] = useState('');
  const [editor, setEditor] = useState<EditState>();
  const [scope, setScope] = useState<Occurrence>();
  const [dateOpen, setDateOpen] = useState(false);
  const [jumpDate, setJumpDate] = useState(date);
  const [transfer, setTransfer] = useState<'import' | 'export'>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFrom, setSearchFrom] = useState(`${date.slice(0, 4)}-01-01`);
  const [searchEnd, setSearchEnd] = useState(`${date.slice(0, 4)}-12-31`);
  const [searchResults, setSearchResults] = useState<Occurrence[]>([]);
  const [searched, setSearched] = useState(false);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [readOnly, setReadOnly] = useState<Occurrence>();
  const [readOnlyReason, setReadOnlyReason] = useState('');
  const [calendarsOpen, setCalendarsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const [revision, setRevision] = useState(0);
  const refreshGeneration = useRef(0);
  const refreshing = useRef(false);
  const mounted = useRef(true);
  const oldAccount = useRef<string | undefined>(undefined);
  const days = monthDays(date, prefs.firstWeekday);
  const start = view === 'month' ? days[0] : view === 'week' ? weekStart(date, prefs.firstWeekday) : view === 'day' ? date : monthStart(date);
  const end = view === 'month' ? addDays(days[41], 1) : view === 'week' ? addDays(start, 7) : view === 'day' ? addDays(date, 1) : monthStart(addMonths(date, 1));
  const currentToday = today(prefs.timezone);
  const refresh = () => { if (!refreshing.current) setRevision(n => n + 1); };

  const acceptSession = useCallback((value: SessionInfo) => {
    if (oldAccount.current && oldAccount.current !== value.accountKey) { setEditor(undefined); setTransfer(undefined); }
    const preferences = loadPreferences(value);
    if (!oldAccount.current) { setDate(today(preferences.timezone)); setFocusDay(today(preferences.timezone)); }
    oldAccount.current = value.accountKey;
    setCSRF(value.csrf, value.accountKey); setSession(value); setPrefs(preferences);
    if (value.calendars) setCalendars(value.calendars);
    setError('');
  }, []);
  useEffect(() => {
    mounted.current = true;
    const expire = () => { refreshGeneration.current++; refreshing.current = false; setLoading(false); setSession(undefined); setCSRF(''); setEvents([]); setCalendars([]); setWarnings([]); setLastRefresh(''); setSettingsOpen(false); setCalendarsOpen(false); setMenuOpen(false); setScope(undefined); setDateOpen(false); setSearchOpen(false); setSearchResults([]); setReadOnly(undefined); setError('Session expired. Sign in again.'); };
    window.addEventListener('calendar:expired', expire);
    api<SessionInfo>('/session').then(acceptSession).catch(error => { if (!(error instanceof RequestError && error.status === 401)) setError(errorMessage(error)); }).finally(() => setLoading(false));
    return () => { mounted.current = false; window.removeEventListener('calendar:expired', expire); };
  }, [acceptSession]);
  useEffect(() => {
    document.documentElement.dataset.theme = prefs.theme;
  }, [prefs.theme]);
  useEffect(() => {
    if (!menuOpen) return;
    menu.current?.querySelector<HTMLButtonElement>('#account-menu button')?.focus();
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) setMenuOpen(false); };
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setMenuOpen(false); menu.current?.querySelector<HTMLButtonElement>('button')?.focus(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', keydown); };
  }, [menuOpen]);
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    const generation = ++refreshGeneration.current;
    refreshing.current = true;
    setLoading(true);
    (async () => {
      try {
        const data = await api<{ calendars: Calendar[] }>('/calendars', { signal: controller.signal });
        if (generation !== refreshGeneration.current) return;
        setCalendars(previous => JSON.stringify(previous) === JSON.stringify(data.calendars) ? previous : data.calendars);
        const ids = data.calendars.filter(c => !prefs.hiddenCalendars.includes(c.id)).map(c => c.id).join(',');
        const params = new URLSearchParams({ start: midnight(start, prefs.timezone), end: midnight(end, prefs.timezone), timezone: prefs.timezone, calendars: ids });
        const result = await api<{ occurrences: Occurrence[]; warnings: string[]; refreshedAt: string; complete: boolean }>(`/events?${params}`, { signal: controller.signal });
        if (generation !== refreshGeneration.current) return;
        setEvents(result.occurrences); setWarnings(result.warnings); setError('');
        if (result.complete) setLastRefresh(result.refreshedAt);
      } catch (error) { if (!controller.signal.aborted && generation === refreshGeneration.current) setError(errorMessage(error)); }
      finally { if (mounted.current && generation === refreshGeneration.current) { refreshing.current = false; setLoading(false); } }
    })();
    return () => controller.abort();
  }, [session, start, end, prefs.timezone, prefs.hiddenCalendars, revision]);
  useEffect(() => {
    if (!session) return;
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    const timer = window.setInterval(visible, 60000);
    document.addEventListener('visibilitychange', visible); window.addEventListener('focus', visible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('focus', visible); };
  }, [session]);

  const savePreferences = (value: Settings) => {
    setPrefs(value); setSettingsOpen(false);
    if (session) { try { localStorage.setItem(`calendar.preferences.${session.accountKey}`, JSON.stringify(value)); } catch { setError('Preferences could not be stored in this browser.'); } }
  };
  const addEvent = (onDate = date, time?: string) => {
    if (!session) return;
    const writable = calendars.filter(c => c.canCreate);
    const calendarId = writable.find(c => c.id === prefs.defaultCalendar)?.id ?? writable[0]?.id;
    if (!calendarId) { setError('No writable calendar is available.'); return; }
    const initialStart = `${onDate}T${time ?? '09:00'}:00`;
    const initialEnd = new Date(Date.parse(`${initialStart}Z`) + 3600000).toISOString().slice(0, 19);
    setEditor({ key: crypto.randomUUID(), accountKey: session.accountKey, initial: {
      calendarId, title: '', location: '', description: '', start: initialStart, end: initialEnd,
      allDay: false, timezone: prefs.timezone, recurrence: { ...defaultRecurrence }, reminder: prefs.reminder,
    } });
  };
  const editEvent = async (event: Occurrence, occurrence = false, targetDate?: string, targetTime?: string) => {
    if (!session) return;
    try {
      const query = occurrence && event.recurrenceId ? `?${new URLSearchParams({ recurrenceId: event.recurrenceId })}` : '';
      const detail = await api<EventDetail>(`/events/${event.resourceId}${query}`);
      if (targetDate && (!detail.canUpdate || !detail.scheduleEditable)) { setError(detail.editReason ?? 'This event cannot be moved.'); return; }
      setScope(undefined); setSearchOpen(false);
      setEditor({ key: crypto.randomUUID(), accountKey: session.accountKey, initial: targetDate ? moveDraft(detail.draft, targetDate, targetTime) : detail.draft, detail });
    }
    catch (error) {
      if (error instanceof RequestError && error.status === 422) { setReadOnly(event); setReadOnlyReason(error.message); }
      else setError(errorMessage(error));
    }
  };
  const openEvent = (event: Occurrence) => { setSearchOpen(false); if (event.recurring && event.recurrenceId) setScope(event); else void editEvent(event); };
  const dropEvent = (eventId: string, targetDate: string, targetTime?: string) => {
    const event = events.find(item => item.id === eventId);
    if (event) void editEvent(event, !!event.recurrenceId, targetDate, targetTime);
  };
  const runSearch = async () => {
    setSearchBusy(true); setSearchError('');
    const generation = refreshGeneration.current;
    try {
      const result = await api<{ occurrences: Occurrence[]; warnings: string[] }>(`/search?${new URLSearchParams({ q: searchQuery, start: midnight(searchFrom, prefs.timezone), end: midnight(addDays(searchEnd, 1), prefs.timezone), timezone: prefs.timezone, calendars: calendars.filter(c => !prefs.hiddenCalendars.includes(c.id)).map(c => c.id).join(',') })}`);
      if (generation !== refreshGeneration.current) return;
      setSearched(true); setSearchResults(result.occurrences); setSearchError(result.warnings.join(' '));
    } catch (error) { setSearchError(errorMessage(error)); }
    finally { setSearchBusy(false); }
  };
  const signOut = async () => {
    if (editor && !window.confirm('Discard your open draft and sign out?')) return;
    try { await api('/session', { method: 'DELETE' }); setEditor(undefined); setSession(undefined); setEvents([]); setCalendars([]); setWarnings([]); setLastRefresh(''); setScope(undefined); setSearchResults([]); setSearchOpen(false); setTransfer(undefined); setCSRF(''); setError(''); }
    catch (error) { setError(errorMessage(error)); }
  };
  const gridKey = (event: KeyboardEvent<HTMLButtonElement>, day: string) => {
    const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -(days.indexOf(day) % 7), End: 6 - days.indexOf(day) % 7 }[event.key];
    if (offset === undefined) return;
    event.preventDefault(); const next = addDays(day, offset); setFocusDay(next);
    if (next < days[0] || next > days[41]) setDate(next);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-date="${next}"]`)?.focus());
  };
  const calendarColor = (id: string) => calendars.find(c => c.id === id)?.color ?? '#27775c';
  const agendaDays = Array.from({ length: Number((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) }, (_, i) => addDays(start, i)).filter(day => dayEvents(events, day, prefs.timezone).length > 0);
  const focusTarget = days.includes(focusDay) ? focusDay : days[0];
  const selectDate = (value: string) => { setDate(value); setFocusDay(value); };
  const toggleCalendar = (id: string) => savePreferences({ ...prefs, hiddenCalendars: prefs.hiddenCalendars.includes(id) ? prefs.hiddenCalendars.filter(c => c !== id) : [...prefs.hiddenCalendars, id] });
  const eventRow = (event: Occurrence) => <EventRow key={event.id} event={event} color={calendarColor(event.calendarId)} timezone={prefs.timezone} hour12={prefs.hour12} onOpen={() => void openEvent(event)} />;
  const navigate = (offset: number) => selectDate(view === 'week' ? addDays(date, offset * 7) : view === 'day' ? addDays(date, offset) : addMonths(date, offset));
  const periodLabel = view === 'day' ? dateLabel(date) : view === 'week' ? `${europeanDate(start)} – ${europeanDate(addDays(end, -1))}` : monthLabel(date);
  const refreshLabel = loading ? 'Refreshing…' : lastRefresh ? `Updated ${timeLabel(lastRefresh, prefs.timezone, prefs.hour12)}` : 'Refresh';

  return <>
    {!session ? <LoginScreen error={error} loading={loading} hasDraft={!!editor} onLogin={acceptSession} /> : <div className="app-shell">
      <a className="skip-link" href="#calendar-main">Skip to calendar</a>
      <header className="app-toolbar">
        <span className="app-name"><Icon name="calendar" />Calendar</span>
        <div className="view-switch" aria-label="Calendar view">{(['month', 'week', 'day', 'agenda'] as const).map(item => <button key={item} aria-pressed={view === item} onClick={() => setView(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}</div>
        <select className="mobile-view" aria-label="Calendar view" value={view} onChange={event => setView(event.target.value as typeof view)}><option value="month">Month</option><option value="week">Week</option><option value="day">Day</option><option value="agenda">Agenda</option></select>
        <div className="toolbar-actions">
          <button className="icon-button" aria-label="Today" title="Today" onClick={() => selectDate(currentToday)}><Icon name="calendar" /></button>
          <button className="icon-button" aria-label="Search" title="Search" onClick={() => setSearchOpen(true)}><Icon name="search" /></button>
          <button className="icon-button" aria-label="Calendars" title="Calendars" onClick={() => setCalendarsOpen(true)}><Icon name="filter" /></button>
          <button className="icon-button" disabled={loading} aria-label="Refresh" title={refreshLabel} onClick={refresh}><Icon name="refresh" className={loading ? 'spinning' : undefined} /></button>
          <button className="icon-button" aria-label="Settings" title="Settings" onClick={() => setSettingsOpen(true)}><Icon name="settings" /></button>
          <div className="more-menu" ref={menu}>
            <button className="icon-button" aria-label="More options" title="More options" aria-expanded={menuOpen} aria-controls="account-menu" onClick={() => setMenuOpen(value => !value)}><Icon name="more" /></button>
            {menuOpen && <div id="account-menu" className="menu-popup"><button onClick={() => { setMenuOpen(false); setTransfer('import'); }}>Import ICS</button><button onClick={() => { setMenuOpen(false); setTransfer('export'); }}>Export calendar</button><button onClick={() => { setMenuOpen(false); void signOut(); }}>Sign out</button></div>}
          </div>
        </div>
        <span className="sr-only" role="status">{refreshLabel}</span>
      </header>
      <main id="calendar-main" className="main" tabIndex={-1}>
        <div className="month-navigation">
          <button className="icon-button" aria-label={`Previous ${view === 'agenda' ? 'month' : view}`} title="Previous" onClick={() => navigate(-1)}><Icon name="left" /></button>
          <div className="month-picker"><h1 aria-label={periodLabel}><button aria-label="Choose date" onClick={() => { setJumpDate(date); setDateOpen(true); }}>{periodLabel}<Icon name="down" /></button></h1></div>
          <button className="icon-button" aria-label={`Next ${view === 'agenda' ? 'month' : view}`} title="Next" onClick={() => navigate(1)}><Icon name="right" /></button>
        </div>
        {error && <div className="notice" role="alert">{error}<button onClick={refresh}>Retry</button></div>}
        {!!warnings.length && <details className="notice"><summary>Incomplete refresh ({warnings.length})</summary><ul>{warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}
        {view === 'week' || view === 'day' ? <TimeGrid activeDate={date} dates={view === 'week' ? weekDates(start) : [date]} events={events} timezone={prefs.timezone} hour12={prefs.hour12} colorStyle={id => colorStyle(calendarColor(id))} onOpen={openEvent} onAdd={(day, time) => { if (time) addEvent(day, time); else { addEvent(day); setEditor(previous => previous ? { ...previous, initial: { ...previous.initial, allDay: true, start: day, end: addDays(day, 1) } } : previous); } }} onDrop={dropEvent} onDay={day => { selectDate(day); setView('day'); }} /> : view === 'month' ? <>
          <div className="month-grid" role="grid" aria-label={monthLabel(date)} aria-busy={loading}>
            <div className="weekday-row" role="row">{Array.from({ length: 7 }, (_, i) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][(i + prefs.firstWeekday) % 7]).map(day => <div role="columnheader" key={day}>{day}</div>)}</div>
            {Array.from({ length: 6 }, (_, week) => <div className="week-row" role="row" key={week}>{days.slice(week * 7, week * 7 + 7).map(day => {
              const items = dayEvents(events, day, prefs.timezone);
              return <div role="gridcell" key={day} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); dropEvent(event.dataTransfer.getData('application/x-calendar-event'), day); }} className={`day-cell ${day.slice(0, 7) !== date.slice(0, 7) ? 'outside' : ''} ${day === currentToday ? 'today' : ''} ${day === date ? 'selected' : ''}`}>
                <button className="day-number" aria-label={`${dateLabel(day)}, ${items.length} ${items.length === 1 ? 'event' : 'events'}`} aria-current={day === currentToday ? 'date' : undefined} aria-pressed={day === date} tabIndex={day === focusTarget ? 0 : -1} data-date={day} onFocus={() => setFocusDay(day)} onKeyDown={e => gridKey(e, day)} onClick={() => selectDate(day)}>{Number(day.slice(-2))}</button>
                <div className="day-dots" aria-hidden="true">{items.slice(0, 4).map(event => <span key={event.id} style={colorStyle(calendarColor(event.calendarId))} />)}</div>
                <div className="day-events">{items.slice(0, 3).map(event => <button className="event-chip" draggable onDragStart={e => { e.dataTransfer.setData('application/x-calendar-event', event.id); e.dataTransfer.effectAllowed = 'move'; }} key={event.id} style={colorStyle(calendarColor(event.calendarId))} onClick={() => void openEvent(event)} title={event.title}><span>{!event.allDay && <time>{timeLabel(event.start, prefs.timezone, prefs.hour12)} </time>}{event.title}</span>{event.recurring && <span className="repeat-mark" aria-label="Recurring">↻</span>}</button>)}{items.length > 3 && <button className="more-events" onClick={() => { selectDate(day); setView('agenda'); }}>+{items.length - 3}</button>}</div>
              </div>;
            })}</div>)}
          </div>
          <section className="selected-day" aria-label="Selected date"><h2>{dateLabel(date)}</h2>{dayEvents(events, date, prefs.timezone).length ? dayEvents(events, date, prefs.timezone).map(eventRow) : <p className="empty-state">{loading ? 'Loading…' : 'No events'}</p>}</section>
        </> : <section className="agenda" aria-label="Agenda" aria-busy={loading}>
          {!agendaDays.length && <p className="empty-state">{loading ? 'Loading…' : 'No events'}</p>}
          {agendaDays.map(day => <section className="agenda-day" key={day}><h2 className={day === currentToday ? 'today-label' : undefined}>{dateLabel(day)}</h2>{dayEvents(events, day, prefs.timezone).map(eventRow)}</section>)}
        </section>}
      </main>
      <footer className="calendar-strip" aria-label="Visible calendars">{calendars.map(calendar => <button key={calendar.id} aria-pressed={!prefs.hiddenCalendars.includes(calendar.id)} style={colorStyle(calendar.color)} onClick={() => toggleCalendar(calendar.id)}>{calendar.name}</button>)}</footer>
      <button className="add-event primary" aria-label="New event" title="New event" disabled={!calendars.some(c => c.canCreate)} onClick={() => addEvent()}><Icon name="add" /></button>
    </div>}
    {dateOpen && session && <Dialog title="Choose date" onClose={() => setDateOpen(false)}><form onSubmit={event => { event.preventDefault(); selectDate(jumpDate); setDateOpen(false); }}><DateField label="Date" value={jumpDate} onChange={setJumpDate} /><div className="dialog-actions"><button type="submit" className="primary">Go</button></div></form></Dialog>}
    {scope && session && <Dialog title="Edit repeating event" onClose={() => setScope(undefined)}><div className="scope-actions"><button onClick={() => { void editEvent(scope, true); }}>This occurrence</button><button onClick={() => { void editEvent(scope); }}>Entire series</button></div></Dialog>}
    {searchOpen && session && <Dialog title="Search" onClose={() => setSearchOpen(false)}><form onSubmit={event => { event.preventDefault(); void runSearch(); }}><label>Search events<input autoFocus required maxLength={200} value={searchQuery} onChange={event => setSearchQuery(event.target.value)} /></label><div className="form-grid"><DateField label="From" value={searchFrom} onChange={setSearchFrom} /><DateField label="To" value={searchEnd} onChange={setSearchEnd} /></div><button className="primary" disabled={searchBusy}>{searchBusy ? 'Searching…' : 'Search'}</button></form>{searchError && <p className="notice" role="alert">{searchError}</p>}<div className="search-results">{searched && !searchBusy && !searchResults.length && <p className="empty-state">No events</p>}{searchResults.map(event => <div key={event.id}><span className="muted">{dateLabel(event.allDay ? event.start : wallTime(event.start, prefs.timezone).slice(0, 10))}</span>{eventRow(event)}</div>)}</div></Dialog>}
    {transfer && <Transfer mode={transfer} calendars={calendars} suspended={!session} onChanged={() => setRevision(n => n + 1)} onClose={() => setTransfer(undefined)} />}
    {editor && <Editor key={editor.key} initial={editor.initial} detail={editor.detail} calendars={calendars} timezones={session?.timezones ?? []} suspended={!session} onSaved={() => { setEditor(undefined); setRevision(n => n + 1); }} onClose={() => setEditor(undefined)} />}
    {calendarsOpen && session && <Dialog title="Calendars" onClose={() => setCalendarsOpen(false)}>
      <div className="calendar-list">{calendars.map(calendar => <label key={calendar.id} className="calendar-toggle"><input type="checkbox" checked={!prefs.hiddenCalendars.includes(calendar.id)} onChange={() => toggleCalendar(calendar.id)} style={{ accentColor: calendar.color }} /><span>{calendar.name}</span>{!calendar.canCreate && !calendar.canUpdate && !calendar.canDelete && <span className="read-only-badge">Read only</span>}</label>)}{!calendars.length && <p className="empty-state">No calendars</p>}</div>
      <div className="dialog-actions"><button onClick={() => setCalendarsOpen(false)}>Done</button></div>
    </Dialog>}
    {settingsOpen && session && <Preferences value={prefs} calendars={calendars} timezones={session.timezones} onSave={savePreferences} onClose={() => setSettingsOpen(false)} />}
    {readOnly && session && <Dialog title={readOnly.title} onClose={() => setReadOnly(undefined)}><p className="notice">{readOnlyReason}</p><p>{readOnly.start} — {readOnly.end}</p><p>{readOnly.location}</p><p className="event-description">{readOnly.description}</p></Dialog>}
  </>;
}

function EventRow({ event, color, timezone, hour12, onOpen }: { event: Occurrence; color: string; timezone: string; hour12: boolean; onOpen: () => void }) {
  return <button className="agenda-event" style={colorStyle(color)} onClick={onOpen}>
    <strong>{event.title}{event.recurring && <span className="repeat-mark" aria-label="Recurring"> ↻</span>}</strong>
    <span className="event-time">{event.allDay ? 'All day' : `${timeLabel(event.start, timezone, hour12)} – ${timeLabel(event.end, timezone, hour12)}`}</span>
    {event.location && <span className="event-location">{event.location}</span>}
  </button>;
}

function LoginScreen({ error, loading, hasDraft, onLogin }: { error: string; loading: boolean; hasDraft: boolean; onLogin: (info: SessionInfo) => void }) {
  const [method, setMethod] = useState<'basic' | 'bearer'>('basic');
  const [username, setUsername] = useState(''); const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  const submit = async () => {
    setBusy(true); setMessage('');
    const login: Login = method === 'basic' ? { method, username, password: secret } : { method, token: secret };
    try { onLogin(await api<SessionInfo>('/session', { method: 'POST', body: JSON.stringify(login) })); setSecret(''); }
    catch (error) { setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  };
  return <main className="login-page"><div className="login-form">
    <h1><Icon name="calendar" />Calendar</h1>
    {(message || error) && <div className="notice" role="alert">{message || error}</div>}
    {hasDraft && <p className="notice">Draft retained. Sign in to the same account.</p>}
    <form onSubmit={e => { e.preventDefault(); void submit(); }}>
      <label>Sign-in method<select value={method} disabled={busy} onChange={e => { setMethod(e.target.value as 'basic' | 'bearer'); setSecret(''); }}><option value="basic">Username and password</option><option value="bearer">Bearer token</option></select></label>
      {method === 'basic' && <label>Username<input autoFocus required autoComplete="username" value={username} maxLength={256} disabled={busy} onChange={e => setUsername(e.target.value)} /></label>}
      <label>{method === 'basic' ? 'Password' : 'Bearer token'}<input required type="password" autoComplete={method === 'basic' ? 'current-password' : 'off'} value={secret} maxLength={4096} disabled={busy} onChange={e => setSecret(e.target.value)} /></label>
      <button className="primary" type="submit" disabled={busy || loading}>{busy || loading ? 'Connecting…' : 'Sign in'}</button>
    </form>
  </div></main>;
}
