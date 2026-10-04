import { useCallback, useEffect, useRef, useState } from 'react';
import { defaultRecurrence, type Calendar, type EventDetail, type EventDraft, type Occurrence, type Preferences } from '../shared';
import { api, errorMessage, RequestError } from './api';
import { addDays, moveDraft } from './dates';
import type { SessionBoundary } from './useSession';

type EditState = { key: string; initial: EventDraft; detail?: EventDetail; accountKey: string };
export function useEventEditor(boundary: SessionBoundary, date: string, prefs: Preferences, calendars: Calendar[], onError: (message: string) => void) {
  const [editor, setEditor] = useState<EditState>();
  const currentEditor = useRef<EditState | undefined>(undefined);
  const [scope, setScope] = useState<Occurrence>();
  const [readOnly, setReadOnly] = useState<{ event: Occurrence; reason: string }>();
  const request = useRef<AbortController | undefined>(undefined);
  const cancel = useCallback(() => { request.current?.abort(); request.current = undefined; }, []);
  const updateEditor = useCallback((value: EditState | undefined) => { currentEditor.current = value; setEditor(value); }, []);
  useEffect(() => boundary.subscribe(transition => {
    cancel(); setScope(undefined); setReadOnly(undefined);
    if (transition.type === 'logout' || transition.accountChanged) updateEditor(undefined);
  }), [boundary, cancel, updateEditor]);
  useEffect(() => cancel, [cancel]);
  const addEvent = (onDate = date, time?: string, allDay = false) => {
    const ticket = boundary.capture();
    if (!ticket) return;
    cancel(); setScope(undefined); setReadOnly(undefined);
    const writable = calendars.filter(calendar => calendar.canCreate);
    const calendarId = writable.find(calendar => calendar.id === prefs.defaultCalendar)?.id ?? writable[0]?.id;
    if (!calendarId) { onError('No writable calendar is available.'); return; }
    const start = `${onDate}T${time ?? '09:00'}:00`;
    const end = new Date(Date.parse(`${start}Z`) + 3600000).toISOString().slice(0, 19);
    updateEditor({ key: crypto.randomUUID(), accountKey: ticket.accountKey, initial: {
      calendarId, title: '', location: '', description: '', start: allDay ? onDate : start, end: allDay ? addDays(onDate, 1) : end,
      allDay, timezone: prefs.timezone, recurrence: { ...defaultRecurrence }, reminder: prefs.reminder,
    } });
  };
  const editEvent = async (event: Occurrence, occurrence = false, targetDate?: string, targetTime?: string) => {
    const ticket = boundary.capture();
    if (!ticket) return;
    cancel(); setReadOnly(undefined);
    const controller = new AbortController(); request.current = controller;
    const isCurrent = () => !controller.signal.aborted && request.current === controller && ticket.isCurrent();
    try {
      const query = occurrence && event.recurrenceId ? `?${new URLSearchParams({ recurrenceId: event.recurrenceId })}` : '';
      const detail = await api<EventDetail>(`/events/${event.resourceId}${query}`, { signal: controller.signal });
      if (!isCurrent()) return;
      if (targetDate && (!detail.canUpdate || !detail.scheduleEditable)) { onError(detail.editReason ?? 'This event cannot be moved.'); return; }
      setScope(undefined);
      updateEditor({ key: crypto.randomUUID(), accountKey: ticket.accountKey, initial: targetDate ? moveDraft(detail.draft, targetDate, targetTime) : detail.draft, detail });
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof RequestError && error.status === 422) { setScope(undefined); setReadOnly({ event, reason: error.message }); }
      else onError(errorMessage(error));
    } finally { if (request.current === controller) request.current = undefined; }
  };
  const openEvent = (event: Occurrence) => {
    if (!boundary.capture()) return;
    cancel(); setScope(undefined); setReadOnly(undefined);
    if (event.recurring && event.recurrenceId) setScope(event); else void editEvent(event);
  };
  const closeEditor = () => { cancel(); updateEditor(undefined); };
  const saved = (key: string) => {
    const ticket = boundary.capture();
    if (!ticket || currentEditor.current?.key !== key || currentEditor.current.accountKey !== ticket.accountKey) return false;
    closeEditor(); return true;
  };
  return { editor, scope, readOnly, addEvent, editEvent, openEvent, closeEditor, saved,
    closeScope: () => { cancel(); setScope(undefined); }, closeReadOnly: () => { cancel(); setReadOnly(undefined); } };
}
