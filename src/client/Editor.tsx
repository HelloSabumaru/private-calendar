import { useEffect, useRef, useState } from 'react';
import { defaultRecurrence, type Calendar, type EventDetail, type EventDraft, type Operation } from '../shared';
import { Dialog } from './Dialog';
import { api, errorMessage, RequestError } from './api';
import { addDays } from './dates';
import { reminderLabel } from './Preferences';
import { Icon } from './Icon';
import { DateField } from './DateField';
import { downloadICS } from './Transfer';
import type { SessionBoundary } from './useSession';

type Props = { initial: EventDraft; detail?: EventDetail; calendars: Calendar[]; timezones: string[]; suspended: boolean; boundary: SessionBoundary; onSaved: () => void; onClose: () => void };
export function Editor({ initial, detail, calendars, timezones, suspended, boundary, onSaved, onClose }: Props) {
  const [draft, setDraft] = useState(initial);
  const [current, setCurrent] = useState(detail);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<EventDetail>();
  const [operation, setOperation] = useState<Operation>();
  const [timezoneOpen, setTimezoneOpen] = useState(!!initial.startOffset || !!initial.endOffset);
  const creationId = useRef(crypto.randomUUID());
  const attemptedCalendar = useRef<string | undefined>(undefined);
  const generation = useRef(0);
  const mounted = useRef(false);
  const currentOperation = useRef<Operation | undefined>(undefined);
  const updateOperation = (value: Operation | undefined) => { currentOperation.current = value; setOperation(value); };
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = boundary.subscribe(() => {
      generation.current++; setBusy(false);
      if (currentOperation.current?.state === 'pending') {
        const value = { ...currentOperation.current, state: 'uncertain' as const };
        currentOperation.current = value; setOperation(value);
        setError('The session changed while the outcome was being checked. Your draft is retained. Check status after signing in.');
      }
    });
    return () => { mounted.current = false; generation.current++; unsubscribe(); };
  }, [boundary]);
  const capture = () => {
    const ticket = boundary.capture();
    if (!ticket || suspended) return;
    const started = ++generation.current;
    return () => mounted.current && started === generation.current && ticket.isCurrent();
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(detail?.draft ?? initial);
  const pending = operation && ['pending', 'uncertain'].includes(operation.state);
  const writable = !current || current.canUpdate;
  const scheduleEditable = writable && (!current || current.scheduleEditable);
  const locked = busy || !!pending || !writable;
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirty || pending) event.preventDefault(); };
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard);
  }, [dirty, pending]);
  const change = <K extends keyof EventDraft>(key: K, value: EventDraft[K]) => { setDraft(old => ({ ...old, [key]: value })); setError(''); };
  const recurrence = <K extends keyof EventDraft['recurrence']>(key: K, value: EventDraft['recurrence'][K]) => change('recurrence', { ...draft.recurrence, [key]: value });
  const close = () => {
    if (busy || pending) { setError('A change is still being checked. Keep this draft open until its outcome is known.'); return; }
    if (!dirty || window.confirm('Discard this unsaved draft?')) onClose();
  };
  const result = (value: Operation) => {
    updateOperation(value);
    if (value.state === 'success') onSaved();
    else if (value.state === 'failed') setError(value.error ?? 'The save failed. Your draft is retained.');
    else setError('The server outcome is being checked. Your draft is retained; keep this window open.');
  };
  async function checkStatus() {
    if (!operation || busy) return;
    const isCurrent = capture();
    if (!isCurrent) return;
    setBusy(true);
    try { const value = await api<Operation>(`/operations/${operation.id}`); if (isCurrent()) result(value); }
    catch (error) {
      if (!isCurrent()) return;
      if (error instanceof RequestError && error.status === 404) { updateOperation(undefined); setError('The session restarted. Retry safely against the same event identity.'); }
      else setError(errorMessage(error));
    } finally { if (isCurrent()) setBusy(false); }
  }
  useEffect(() => {
    if (!pending || busy || suspended) return;
    const timer = window.setInterval(() => { void checkStatus(); }, 5000);
    return () => clearInterval(timer);
  });
  const send = async (deleting = false) => {
    if (busy || pending) return;
    if (deleting && (!current || !window.confirm(current.recurrenceId ? 'Delete only this occurrence? Unsaved changes will be discarded.' : current.recurring ? 'Delete this entire series, including every exception? Unsaved changes will be discarded.' : 'Delete this event? Unsaved changes will be discarded.'))) return;
    const isCurrent = capture();
    if (!isCurrent) return;
    setError(''); setConflict(undefined); setBusy(true);
    const id = crypto.randomUUID(); attemptedCalendar.current = draft.calendarId;
    updateOperation({ id, state: 'pending' });
    try {
      const value = await api<Operation>(current ? `/events/${current.id}${current.recurrenceId ? `?${new URLSearchParams({ recurrenceId: current.recurrenceId })}` : ''}` : '/events', {
        method: deleting ? 'DELETE' : current ? 'PATCH' : 'POST', body: deleting ? undefined : JSON.stringify(draft),
        headers: { 'Idempotency-Key': id, 'X-Event-ID': creationId.current, ...(current ? { 'If-Match': current.etag } : {}) },
      });
      if (isCurrent()) result(value);
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof RequestError && error.status < 500) { updateOperation(undefined); if (error.data.latest) setConflict(error.data.latest); }
      else updateOperation({ id, state: 'uncertain' });
      if (error instanceof RequestError && error.data.code === 'DST_OVERLAP') setTimezoneOpen(true);
      setError(errorMessage(error));
    } finally { if (isCurrent()) setBusy(false); }
  };
  const reapply = () => {
    if (!conflict) return;
    const merged = { ...conflict.draft };
    for (const key of Object.keys(draft) as (keyof EventDraft)[]) if (key !== 'calendarId' && (!current || JSON.stringify(draft[key]) !== JSON.stringify(current.draft[key]))) Object.assign(merged, { [key]: draft[key] });
    setCurrent(conflict); setDraft(merged); setConflict(undefined); updateOperation(undefined); setError('Draft reapplied to the latest version. Review it before saving.');
  };
  const exportEvent = async () => {
    const ticket = boundary.capture();
    if (!current || !ticket) return;
    const started = generation.current;
    const isCurrent = () => mounted.current && started === generation.current && ticket.isCurrent();
    try { const value = await api<{ ics: string }>(`/events/${current.id}/export`); if (isCurrent()) downloadICS(value.ics, draft.title); }
    catch (error) { if (isCurrent()) setError(errorMessage(error)); }
  };
  if (suspended) return null;
  const saveLabel = current?.recurrenceId ? 'Save occurrence' : current?.recurring ? 'Save series' : 'Save event';
  return <Dialog title={current ? current.recurrenceId ? 'Edit occurrence' : current.recurring ? 'Edit series' : 'Edit event' : 'New event'} onClose={close} closeLabel="Cancel" actions={<>
    {current && <button type="button" className="icon-button" aria-label="Export event" title="Export event" onClick={() => { void exportEvent(); }}><Icon name="download" /></button>}
    {current?.canDelete && <button type="button" className="icon-button danger" aria-label={current.recurrenceId ? 'Delete occurrence' : current.recurring ? 'Delete series' : 'Delete event'} title="Delete" disabled={busy || !!pending} onClick={() => void send(true)}><Icon name="delete" /></button>}
    <button className="icon-button" type="submit" form="event-form" aria-label={saveLabel} title={saveLabel} disabled={locked || !!conflict}><Icon name={busy ? 'refresh' : 'save'} className={busy ? 'spinning' : undefined} /></button>
  </>}>
    <form id="event-form" className="event-form" onSubmit={event => { event.preventDefault(); void send(); }}>
      {error && <div className="notice" role="alert">{error}{pending && <button type="button" disabled={busy} onClick={() => void checkStatus()}>Check status</button>}</div>}
      {conflict && <section className="conflict" aria-label="Review server changes"><h3>Review the latest version</h3><table><thead><tr><th>Field</th><th>Server</th><th>Your draft</th></tr></thead><tbody>{(['title', 'location', 'description', 'start', 'end', 'timezone'] as const).filter(key => draft[key] !== conflict.draft[key]).map(key => <tr key={key}><th>{key}</th><td>{conflict.draft[key] || '—'}</td><td>{draft[key] || '—'}</td></tr>)}</tbody></table><p>Recurrence and reminder changes are included when you reapply your draft.</p><div className="button-row"><button type="button" onClick={reapply}>Review and reapply draft</button><button type="button" onClick={() => { if (window.confirm('Discard your draft and load the server version?')) { setCurrent(conflict); setDraft(conflict.draft); setConflict(undefined); setError(''); } }}>Load server version</button></div></section>}
      {!writable && <p className="notice">This event is read-only, or the server did not provide a strong ETag.</p>}
      {current?.deleteReason && <p className="muted">{current.deleteReason}</p>}
      <div className="editor-texts">
        <input className="event-title" aria-label="Title" autoFocus required maxLength={1000} value={draft.title} disabled={locked} onChange={e => change('title', e.target.value)} placeholder="Title" />
        <input aria-label="Location" maxLength={2000} value={draft.location} disabled={locked} onChange={e => change('location', e.target.value)} placeholder="Location" />
        <textarea aria-label="Description" rows={2} maxLength={100000} value={draft.description} disabled={locked} onChange={e => change('description', e.target.value)} placeholder="Description" />
      </div>
      <label>Calendar<select value={draft.calendarId} disabled={locked || !!current || !!attemptedCalendar.current} onChange={e => change('calendarId', e.target.value)}>{calendars.filter(c => c.canCreate || c.id === draft.calendarId).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      {current?.editReason && <p className="notice">{current.editReason}</p>}
      <fieldset disabled={locked || !scheduleEditable}><legend className="sr-only">Schedule</legend>
        <label className="check-label">All-day<input type="checkbox" checked={draft.allDay} onChange={e => {
          const allDay = e.target.checked;
          setDraft(old => {
            if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(old.start) || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(old.end)) return old;
            const start = old.start && (allDay ? old.start.slice(0, 10) : `${old.start}T09:00:00`);
            const end = old.end && (allDay ? addDays(old.end.slice(0, 10), /T00:00(:00)?$/.test(old.end) ? 0 : 1) : `${addDays(old.end, -1)}T10:00:00`);
            return { ...old, allDay, start, end, startOffset: undefined, endOffset: undefined };
          });
        }} /></label>
        <div className="date-fields"><DateField label="Start" withTime={!draft.allDay} value={draft.start} onChange={value => change('start', value)} /><DateField label="End" description={draft.allDay ? 'Includes this day' : undefined} withTime={!draft.allDay} value={draft.allDay && /^\d{4}-\d{2}-\d{2}$/.test(draft.end) ? addDays(draft.end, -1) : draft.end} onChange={value => change('end', draft.allDay && /^\d{4}-\d{2}-\d{2}$/.test(value) ? addDays(value, 1) : value)} /></div>
        {!current?.recurrenceId && <div className="form-grid"><label>Repeat<select value={draft.recurrence.frequency} onChange={e => change('recurrence', { ...defaultRecurrence, frequency: e.target.value as EventDraft['recurrence']['frequency'] })}><option value="NONE">Does not repeat</option><option value="DAILY">Daily</option><option value="WEEKLY">Weekly</option><option value="MONTHLY">Monthly</option><option value="YEARLY">Yearly</option></select></label>{draft.recurrence.frequency !== 'NONE' && <label>Every (interval)<input type="number" required min={1} max={999} value={draft.recurrence.interval} onChange={e => recurrence('interval', Number(e.target.value))} /></label>}</div>}
        {draft.recurrence.frequency === 'WEEKLY' && <div className="weekday-options" aria-label="Repeat weekdays">{(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const).map(day => <label key={day}><input type="checkbox" checked={draft.recurrence.weekdays.includes(day)} onChange={e => recurrence('weekdays', e.target.checked ? [...draft.recurrence.weekdays, day] : draft.recurrence.weekdays.filter(d => d !== day))} />{day}</label>)}</div>}
        {draft.recurrence.frequency !== 'NONE' && <div className="form-grid"><label>Series ends<select value={draft.recurrence.end} onChange={e => change('recurrence', { ...draft.recurrence, end: e.target.value as EventDraft['recurrence']['end'], count: e.target.value === 'count' ? draft.recurrence.count ?? 10 : undefined, until: e.target.value === 'until' ? draft.recurrence.until ?? draft.start.slice(0, 10) : undefined })}><option value="never">Never</option><option value="until">On a date</option><option value="count">After a count</option></select></label>{draft.recurrence.end === 'until' && <DateField label="Last recurrence date" value={draft.recurrence.until ?? ''} onChange={value => recurrence('until', value)} />}{draft.recurrence.end === 'count' && <label>Occurrence count<input type="number" min={1} max={100000} required value={draft.recurrence.count ?? 10} onChange={e => recurrence('count', Number(e.target.value))} /></label>}</div>}
        {!draft.allDay && <details className="timezone-options" open={timezoneOpen} onToggle={e => setTimezoneOpen(e.currentTarget.open)}><summary>Time zone</summary>
          <label>Time zone<select value={draft.timezone} onChange={e => setDraft(old => ({ ...old, timezone: e.target.value, startOffset: undefined, endOffset: undefined }))}><option value="floating">Floating (local time)</option>{!timezones.includes(draft.timezone) && draft.timezone !== 'floating' && <option>{draft.timezone}</option>}{timezones.map(zone => <option key={zone}>{zone}</option>)}</select></label>
          <div className="form-grid">{(['startOffset', 'endOffset'] as const).map(key => <label key={key}>{key === 'startOffset' ? 'Start' : 'End'} offset<select value={draft[key] ?? ''} onChange={e => change(key, (e.target.value || undefined) as EventDraft[typeof key])}><option value="">Ask if ambiguous</option><option value="earlier">Earlier offset</option><option value="later">Later offset</option></select></label>)}</div>
        </details>}
      </fieldset>
      {!scheduleEditable && current?.recurrenceText && <p className="muted">Stored recurrence: <code>{current.recurrenceText}</code></p>}
      <label>Reminder<select value={draft.reminder} disabled={locked} onChange={e => change('reminder', ['none', 'preserve'].includes(e.target.value) ? e.target.value as 'none' | 'preserve' : Number(e.target.value))}>{current && <option value="preserve">Keep existing ({current.alarmCount})</option>}<option value="none">{current?.unsupportedAlarms ? 'Remove editable reminders' : 'No reminder'}</option>{[0, 5, 15, 30, 60, 1440, 10080].map(n => <option key={n} value={n}>{reminderLabel(n)}</option>)}</select></label>
      {!!current?.unsupportedAlarms && <p className="muted">{current.unsupportedAlarms} advanced reminder(s) will be preserved.</p>}
    </form>
  </Dialog>;
}
