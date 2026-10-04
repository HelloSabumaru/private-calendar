import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { Login, Occurrence, Preferences as Settings } from '../shared';
import { addDays, addMonths, dateLabel, groupEventsByDate, monthDays, monthLabel, monthStart, timeLabel, today, wallTime, weekStart } from './dates';
import { Editor } from './Editor';
import { Preferences } from './Preferences';
import { Dialog } from './Dialog';
import { Icon } from './Icon';
import { DateField, europeanDate } from './DateField';
import { TimeGrid, weekDates } from './TimeGrid';
import { Transfer } from './Transfer';
import { browserTimezone, useSession } from './useSession';
import { useCalendarData } from './useCalendarData';
import { useEventSearch } from './useEventSearch';
import { useEventEditor } from './useEventEditor';

const colorStyle = (color: string) => {
  const channels = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  const luminance = .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
  return { '--calendar-color': color, '--calendar-text': luminance > .179 ? '#000' : '#fff' } as CSSProperties;
};

export function App() {
  const { session, prefs, loading: sessionLoading, signingIn, error, setError, boundary, signIn, signOut: endSession, savePreferences: storePreferences } = useSession();
  const [date, setDate] = useState(today(browserTimezone));
  const [focusDay, setFocusDay] = useState(date);
  const [view, setView] = useState<'month' | 'agenda' | 'week' | 'day'>('month');
  const [dateOpen, setDateOpen] = useState(false);
  const [jumpDate, setJumpDate] = useState(date);
  const [transfer, setTransfer] = useState<'import' | 'export'>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [calendarsOpen, setCalendarsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const days = monthDays(date, prefs.firstWeekday);
  const start = view === 'month' ? days[0] : view === 'week' ? weekStart(date, prefs.firstWeekday) : view === 'day' ? date : monthStart(date);
  const end = view === 'month' ? addDays(days[41], 1) : view === 'week' ? addDays(start, 7) : view === 'day' ? addDays(date, 1) : monthStart(addMonths(date, 1));
  const currentToday = today(prefs.timezone);
  const { calendars, events, warnings, lastRefresh, loading, refresh, changed } = useCalendarData(session, boundary, start, end, prefs, setError);
  const eventDays = useMemo(() => groupEventsByDate(events.filter(event => !prefs.hiddenCalendars.includes(event.calendarId)), prefs.timezone, start, end), [events, prefs.timezone, prefs.hiddenCalendars, start, end]);
  const search = useEventSearch(boundary, date, prefs, calendars);
  const editing = useEventEditor(boundary, date, prefs, calendars, setError);
  const { editor, scope, readOnly, addEvent, editEvent } = editing;
  useEffect(() => boundary.subscribe(transition => {
    setSettingsOpen(false); setCalendarsOpen(false); setMenuOpen(false); setDateOpen(false);
    if (transition.type === 'logout' || transition.accountChanged) setTransfer(undefined);
    if (transition.firstSignIn && transition.timezone) {
      const value = today(transition.timezone); setDate(value); setFocusDay(value);
    }
  }), [boundary]);
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
  const savePreferences = (value: Settings) => { storePreferences(value); setSettingsOpen(false); };
  const openEvent = (event: Occurrence) => { search.closeSearch(); editing.openEvent(event); };
  const dropEvent = (eventId: string, targetDate: string, targetTime?: string) => {
    const event = events.find(item => item.id === eventId);
    if (event) { search.closeSearch(); void editEvent(event, !!event.recurrenceId, targetDate, targetTime); }
  };
  const signOut = () => {
    if (editor && !window.confirm('Discard your open draft and sign out?')) return;
    void endSession();
  };
  const gridKey = (event: KeyboardEvent<HTMLButtonElement>, day: string) => {
    const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -(days.indexOf(day) % 7), End: 6 - days.indexOf(day) % 7 }[event.key];
    if (offset === undefined) return;
    event.preventDefault(); const next = addDays(day, offset); setFocusDay(next);
    if (next < days[0] || next > days[41]) setDate(next);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-date="${next}"]`)?.focus());
  };
  const calendarColor = (id: string) => calendars.find(c => c.id === id)?.color ?? '#27775c';
  const agendaDays = view === 'agenda' ? [...eventDays].filter(([, group]) => group.events.length > 0) : [];
  const selectedEvents = eventDays.get(date)?.events ?? [];
  const focusTarget = days.includes(focusDay) ? focusDay : days[0];
  const selectDate = (value: string) => { setDate(value); setFocusDay(value); };
  const toggleCalendar = (id: string) => savePreferences({ ...prefs, hiddenCalendars: prefs.hiddenCalendars.includes(id) ? prefs.hiddenCalendars.filter(c => c !== id) : [...prefs.hiddenCalendars, id] });
  const eventRow = (event: Occurrence) => <EventRow key={event.id} event={event} color={calendarColor(event.calendarId)} timezone={prefs.timezone} hour12={prefs.hour12} onOpen={() => void openEvent(event)} />;
  const navigate = (offset: number) => selectDate(view === 'week' ? addDays(date, offset * 7) : view === 'day' ? addDays(date, offset) : addMonths(date, offset));
  const periodLabel = view === 'day' ? dateLabel(date) : view === 'week' ? `${europeanDate(start)} – ${europeanDate(addDays(end, -1))}` : monthLabel(date);
  const refreshLabel = loading ? 'Refreshing…' : lastRefresh ? `Updated ${timeLabel(lastRefresh, prefs.timezone, prefs.hour12)}` : 'Refresh';

  return <>
    {!session ? <LoginScreen error={error} loading={sessionLoading || signingIn} hasDraft={!!editor} onLogin={signIn} /> : <div className="app-shell">
      <a className="skip-link" href="#calendar-main">Skip to calendar</a>
      <header className="app-toolbar">
        <span className="app-name"><Icon name="calendar" />Calendar</span>
        <div className="view-switch" aria-label="Calendar view">{(['month', 'week', 'day', 'agenda'] as const).map(item => <button key={item} aria-pressed={view === item} onClick={() => setView(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}</div>
        <select className="mobile-view" aria-label="Calendar view" value={view} onChange={event => setView(event.target.value as typeof view)}><option value="month">Month</option><option value="week">Week</option><option value="day">Day</option><option value="agenda">Agenda</option></select>
        <div className="toolbar-actions">
          <button className="icon-button" aria-label="Today" title="Today" onClick={() => selectDate(currentToday)}><Icon name="calendar" /></button>
          <button className="icon-button" aria-label="Search" title="Search" onClick={search.openSearch}><Icon name="search" /></button>
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
        {view === 'week' || view === 'day' ? <TimeGrid activeDate={date} dates={view === 'week' ? weekDates(start) : [date]} eventDays={eventDays} timezone={prefs.timezone} hour12={prefs.hour12} colorStyle={id => colorStyle(calendarColor(id))} onOpen={openEvent} onAdd={(day, time) => addEvent(day, time, !time)} onDrop={dropEvent} onDay={day => { selectDate(day); setView('day'); }} /> : view === 'month' ? <>
          <div className="month-grid" role="grid" aria-label={monthLabel(date)} aria-busy={loading}>
            <div className="weekday-row" role="row">{Array.from({ length: 7 }, (_, i) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][(i + prefs.firstWeekday) % 7]).map(day => <div role="columnheader" key={day}>{day}</div>)}</div>
            {Array.from({ length: 6 }, (_, week) => <div className="week-row" role="row" key={week}>{days.slice(week * 7, week * 7 + 7).map(day => {
              const items = eventDays.get(day)?.events ?? [];
              return <div role="gridcell" key={day} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); dropEvent(event.dataTransfer.getData('application/x-calendar-event'), day); }} className={`day-cell ${day.slice(0, 7) !== date.slice(0, 7) ? 'outside' : ''} ${day === currentToday ? 'today' : ''} ${day === date ? 'selected' : ''}`}>
                <button className="day-number" aria-label={`${dateLabel(day)}, ${items.length} ${items.length === 1 ? 'event' : 'events'}`} aria-current={day === currentToday ? 'date' : undefined} aria-pressed={day === date} tabIndex={day === focusTarget ? 0 : -1} data-date={day} onFocus={() => setFocusDay(day)} onKeyDown={e => gridKey(e, day)} onClick={() => selectDate(day)}>{Number(day.slice(-2))}</button>
                <div className="day-dots" aria-hidden="true">{items.slice(0, 4).map(event => <span key={event.id} style={colorStyle(calendarColor(event.calendarId))} />)}</div>
                <div className="day-events">{items.slice(0, 3).map(event => <button className="event-chip" draggable onDragStart={e => { e.dataTransfer.setData('application/x-calendar-event', event.id); e.dataTransfer.effectAllowed = 'move'; }} key={event.id} style={colorStyle(calendarColor(event.calendarId))} onClick={() => void openEvent(event)} title={event.title}><span>{!event.allDay && <time>{timeLabel(event.start, prefs.timezone, prefs.hour12)} </time>}{event.title}</span>{event.recurring && <span className="repeat-mark" aria-label="Recurring">↻</span>}</button>)}{items.length > 3 && <button className="more-events" onClick={() => { selectDate(day); setView('agenda'); }}>+{items.length - 3}</button>}</div>
              </div>;
            })}</div>)}
          </div>
          <section className="selected-day" aria-label="Selected date"><h2>{dateLabel(date)}</h2>{selectedEvents.length ? selectedEvents.map(eventRow) : <p className="empty-state">{loading ? 'Loading…' : 'No events'}</p>}</section>
        </> : <section className="agenda" aria-label="Agenda" aria-busy={loading}>
          {!agendaDays.length && <p className="empty-state">{loading ? 'Loading…' : 'No events'}</p>}
          {agendaDays.map(([day, group]) => <section className="agenda-day" key={day}><h2 className={day === currentToday ? 'today-label' : undefined}>{dateLabel(day)}</h2>{group.events.map(eventRow)}</section>)}
        </section>}
      </main>
      <footer className="calendar-strip" aria-label="Visible calendars">{calendars.map(calendar => <button key={calendar.id} aria-pressed={!prefs.hiddenCalendars.includes(calendar.id)} style={colorStyle(calendar.color)} onClick={() => toggleCalendar(calendar.id)}>{calendar.name}</button>)}</footer>
      <button className="add-event primary" aria-label="New event" title="New event" disabled={!calendars.some(c => c.canCreate)} onClick={() => addEvent()}><Icon name="add" /></button>
    </div>}
    {dateOpen && session && <Dialog title="Choose date" onClose={() => setDateOpen(false)}><form onSubmit={event => { event.preventDefault(); selectDate(jumpDate); setDateOpen(false); }}><DateField label="Date" value={jumpDate} onChange={setJumpDate} /><div className="dialog-actions"><button type="submit" className="primary">Go</button></div></form></Dialog>}
    {scope && session && <Dialog title="Edit repeating event" onClose={editing.closeScope}><div className="scope-actions"><button onClick={() => { void editEvent(scope, true); }}>This occurrence</button><button onClick={() => { void editEvent(scope); }}>Entire series</button></div></Dialog>}
    {search.open && session && <Dialog title="Search" onClose={search.closeSearch}><form onSubmit={event => { event.preventDefault(); void search.runSearch(); }}><label>Search events<input autoFocus required maxLength={200} value={search.query} onChange={event => search.setQuery(event.target.value)} /></label><div className="form-grid"><DateField label="From" value={search.from} onChange={search.setFrom} /><DateField label="To" value={search.end} onChange={search.setEnd} /></div><button className="primary" disabled={search.busy}>{search.busy ? 'Searching…' : 'Search'}</button></form>{search.error && <p className="notice" role="alert">{search.error}</p>}<div className="search-results">{search.searched && !search.busy && !search.results.length && <p className="empty-state">No events</p>}{search.results.map(event => <div key={event.id}><span className="muted">{dateLabel(event.allDay ? event.start : wallTime(event.start, prefs.timezone).slice(0, 10))}</span>{eventRow(event)}</div>)}</div></Dialog>}
    {transfer && <Transfer mode={transfer} calendars={calendars} suspended={!session} boundary={boundary} onChanged={changed} onClose={() => setTransfer(undefined)} />}
    {editor && <Editor key={editor.key} initial={editor.initial} detail={editor.detail} calendars={calendars} timezones={session?.timezones ?? []} suspended={!session} boundary={boundary} onSaved={() => { if (editing.saved(editor.key)) changed(); }} onClose={editing.closeEditor} />}
    {calendarsOpen && session && <Dialog title="Calendars" onClose={() => setCalendarsOpen(false)}>
      <div className="calendar-list">{calendars.map(calendar => <label key={calendar.id} className="calendar-toggle"><input type="checkbox" checked={!prefs.hiddenCalendars.includes(calendar.id)} onChange={() => toggleCalendar(calendar.id)} style={{ accentColor: calendar.color }} /><span>{calendar.name}</span>{!calendar.canCreate && !calendar.canUpdate && !calendar.canDelete && <span className="read-only-badge">Read only</span>}</label>)}{!calendars.length && <p className="empty-state">No calendars</p>}</div>
      <div className="dialog-actions"><button onClick={() => setCalendarsOpen(false)}>Done</button></div>
    </Dialog>}
    {settingsOpen && session && <Preferences value={prefs} calendars={calendars} timezones={session.timezones} onSave={savePreferences} onClose={() => setSettingsOpen(false)} />}
    {readOnly && session && <Dialog title={readOnly.event.title} onClose={editing.closeReadOnly}><p className="notice">{readOnly.reason}</p><p>{readOnly.event.start} — {readOnly.event.end}</p><p>{readOnly.event.location}</p><p className="event-description">{readOnly.event.description}</p></Dialog>}
  </>;
}

function EventRow({ event, color, timezone, hour12, onOpen }: { event: Occurrence; color: string; timezone: string; hour12: boolean; onOpen: () => void }) {
  return <button className="agenda-event" style={colorStyle(color)} onClick={onOpen}>
    <strong>{event.title}{event.recurring && <span className="repeat-mark" aria-label="Recurring"> ↻</span>}</strong>
    <span className="event-time">{event.allDay ? 'All day' : `${timeLabel(event.start, timezone, hour12)} – ${timeLabel(event.end, timezone, hour12)}`}</span>
    {event.location && <span className="event-location">{event.location}</span>}
  </button>;
}

function LoginScreen({ error, loading, hasDraft, onLogin }: { error: string; loading: boolean; hasDraft: boolean; onLogin: (login: Login) => Promise<boolean> }) {
  const [method, setMethod] = useState<'basic' | 'bearer'>('basic');
  const [username, setUsername] = useState(''); const [secret, setSecret] = useState('');
  const submit = async () => {
    const login: Login = method === 'basic' ? { method, username, password: secret } : { method, token: secret };
    if (await onLogin(login)) setSecret('');
  };
  return <main className="login-page"><div className="login-form">
    <h1><Icon name="calendar" />Calendar</h1>
    {error && <div className="notice" role="alert">{error}</div>}
    {hasDraft && <p className="notice">Draft retained. Sign in to the same account.</p>}
    <form onSubmit={e => { e.preventDefault(); void submit(); }}>
      <label>Sign-in method<select value={method} disabled={loading} onChange={e => { setMethod(e.target.value as 'basic' | 'bearer'); setSecret(''); }}><option value="basic">Username and password</option><option value="bearer">Bearer token</option></select></label>
      {method === 'basic' && <label>Username<input autoFocus required autoComplete="username" value={username} maxLength={256} disabled={loading} onChange={e => setUsername(e.target.value)} /></label>}
      <label>{method === 'basic' ? 'Password' : 'Bearer token'}<input required type="password" autoComplete={method === 'basic' ? 'current-password' : 'off'} value={secret} maxLength={4096} disabled={loading} onChange={e => setSecret(e.target.value)} /></label>
      <button className="primary" type="submit" disabled={loading}>{loading ? 'Connecting…' : 'Sign in'}</button>
    </form>
  </div></main>;
}
