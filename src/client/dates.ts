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
export type TimedEvent = { event: Occurrence; start: number; end: number };
export type DayEvents = { events: readonly Occurrence[]; allDay: readonly Occurrence[]; timed: readonly TimedEvent[] };
export function groupEventsByDate(events: readonly Occurrence[], timezone: string, start: string, end: string): ReadonlyMap<string, DayEvents> {
  const groups = new Map<string, { events: Occurrence[]; allDay: Occurrence[]; timed: TimedEvent[] }>();
  for (let date = Temporal.PlainDate.from(start); date.toString() < end; date = date.add({ days: 1 })) {
    groups.set(date.toString(), { events: [], allDay: [], timed: [] });
  }
  const dates = [...groups.keys()];
  if (!dates.length) return groups;
  const indices = new Map(dates.map((date, index) => [date, index]));
  const dayStarts = new Map<string, bigint>();
  const dayStart = (date: string) => {
    let instant = dayStarts.get(date);
    if (instant === undefined) {
      instant = Temporal.PlainDate.from(date).toZonedDateTime(timezone).epochNanoseconds;
      dayStarts.set(date, instant);
    }
    return instant;
  };
  const ordered = [...events].sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
  for (const event of ordered) {
    let startDay = event.start, endDay = event.end, startMinutes = 0, endMinutes = 1440, endInstant = 0n;
    if (!event.allDay) {
      const first = Temporal.Instant.from(event.start).toZonedDateTimeISO(timezone);
      const last = Temporal.Instant.from(event.end).toZonedDateTimeISO(timezone);
      startDay = first.toPlainDate().toString(); endDay = last.toPlainDate().toString();
      startMinutes = first.hour * 60 + first.minute; endMinutes = last.hour * 60 + last.minute;
      endInstant = last.epochNanoseconds;
    }
    const firstDay = startDay < start ? start : startDay;
    const lastDay = endDay > dates[dates.length - 1] ? dates[dates.length - 1] : endDay;
    if (firstDay > lastDay) continue;
    const firstIndex = indices.get(firstDay), lastIndex = indices.get(lastDay);
    if (firstIndex === undefined || lastIndex === undefined) continue;
    for (let index = firstIndex; index <= lastIndex; index++) {
      const date = dates[index];
      if (event.allDay ? date >= endDay : date !== startDay && endInstant <= dayStart(date)) continue;
      const group = groups.get(date)!;
      group.events.push(event);
      if (event.allDay) group.allDay.push(event);
      else group.timed.push({ event, start: startDay < date ? 0 : startMinutes, end: endDay > date ? 1440 : endMinutes });
    }
  }
  return groups;
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
