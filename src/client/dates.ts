import { Temporal } from '@js-temporal/polyfill';
import type { Occurrence } from '../shared';

export const today = (timezone: string) => Temporal.Now.plainDateISO(timezone).toString();
export const addDays = (date: string, days: number) => Temporal.PlainDate.from(date).add({ days }).toString();
export const addMonths = (date: string, months: number) => Temporal.PlainDate.from(date).add({ months }).toString();
export const monthStart = (date: string) => `${date.slice(0, 7)}-01`;
export function monthDays(date: string, firstWeekday: number) {
  const first = Temporal.PlainDate.from(monthStart(date));
  const start = first.subtract({ days: (first.dayOfWeek % 7 - firstWeekday + 7) % 7 });
  return Array.from({ length: 42 }, (_, index) => start.add({ days: index }).toString());
}
export const midnight = (date: string, timezone: string) => Temporal.PlainDate.from(date).toZonedDateTime(timezone).toInstant().toString();
export function eventDay(instant: string, timezone: string) { return Temporal.Instant.from(instant).toZonedDateTimeISO(timezone).toPlainDate().toString(); }
export function dayEvents(events: Occurrence[], date: string, timezone: string) {
  return events.filter(event => {
    const start = event.allDay ? event.start : eventDay(event.start, timezone);
    const end = event.allDay ? event.end : eventDay(event.end, timezone);
    return date >= start && (event.allDay ? date < end : date <= end && (date === start || Date.parse(event.end) > Date.parse(midnight(date, timezone))));
  }).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
}
export const monthLabel = (date: string) => new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
export const dateLabel = (date: string) => new Intl.DateTimeFormat('en-GB', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
export const timeLabel = (instant: string, timezone: string, hour12: boolean) => new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit', timeZone: timezone, hour12 }).format(new Date(instant));

export function weekStart(date: string, firstWeekday: number) {
  const day = Temporal.PlainDate.from(date);
  return day.subtract({ days: (day.dayOfWeek % 7 - firstWeekday + 7) % 7 }).toString();
}
export const wallTime = (instant: string, timezone: string) => Temporal.Instant.from(instant).toZonedDateTimeISO(timezone).toPlainDateTime().toString({ smallestUnit: 'second' });
export function moveDraft(draft: import('../shared').EventDraft, targetDate: string, targetTime?: string) {
  const dayShift = Temporal.PlainDate.from(targetDate).since(Temporal.PlainDate.from(draft.start.slice(0, 10))).days;
  if (draft.allDay) return { ...draft, start: targetDate, end: addDays(draft.end, dayShift) };
  const original = Temporal.PlainDateTime.from(draft.start);
  const start = targetTime ? Temporal.PlainDateTime.from(`${targetDate}T${targetTime}`) : original.add({ days: dayShift });
  const duration = original.until(Temporal.PlainDateTime.from(draft.end));
  return { ...draft, start: start.toString({ smallestUnit: 'second' }), end: start.add(duration).toString({ smallestUnit: 'second' }), startOffset: undefined, endOffset: undefined };
}
