import { useState } from 'react';
import type { Calendar, Preferences as Settings } from '../shared';
import { Dialog } from './Dialog';

export function Preferences({ value, calendars, timezones, onSave, onClose }: { value: Settings; calendars: Calendar[]; timezones: string[]; onSave: (value: Settings) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(value);
  const change = <K extends keyof Settings>(key: K, next: Settings[K]) => setDraft(old => ({ ...old, [key]: next }));
  return <Dialog title="Settings" onClose={onClose}>
    <form onSubmit={event => { event.preventDefault(); onSave(draft); }}>
      <div className="form-grid">
        <label>Appearance<select value={draft.theme} onChange={e => change('theme', e.target.value as Settings['theme'])}><option value="system">Follow system</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
        <label>First day of the week<select value={draft.firstWeekday} onChange={e => change('firstWeekday', Number(e.target.value) as 0 | 1)}><option value={1}>Monday</option><option value={0}>Sunday</option></select></label>
        <label>Time format<select value={String(draft.hour12)} onChange={e => change('hour12', e.target.value === 'true')}><option value="false">24-hour</option><option value="true">12-hour</option></select></label>
        <label>Display timezone<select value={draft.timezone} onChange={e => change('timezone', e.target.value)}>{timezones.map(zone => <option key={zone}>{zone}</option>)}</select></label>
        <label>Default calendar<select value={draft.defaultCalendar} onChange={e => change('defaultCalendar', e.target.value)}><option value="">First writable calendar</option>{calendars.filter(c => c.canCreate).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label>Default reminder<select value={draft.reminder} onChange={e => change('reminder', e.target.value === 'none' ? 'none' : Number(e.target.value))}><option value="none">No reminder</option>{[0, 5, 15, 30, 60, 1440, 10080].map(n => <option key={n} value={n}>{reminderLabel(n)}</option>)}</select></label>
      </div>
      <div className="dialog-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" type="submit" aria-label="Save settings">Save</button></div>
    </form>
  </Dialog>;
}
export const reminderLabel = (minutes: number) => minutes === 0 ? 'At start' : minutes < 60 ? `${minutes} minutes before` : minutes === 60 ? '1 hour before' : minutes === 1440 ? '1 day before' : minutes === 10080 ? '1 week before' : `${minutes} minutes before`;
