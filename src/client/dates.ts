import { Temporal } from '@js-temporal/polyfill';
import type { EventDraft, Occurrence } from '../shared';

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
export type OffsetChoice = 'earlier' | 'later';
const minutesBetween = (start: bigint, end: bigint) => Number(end - start) / 60_000_000_000;
function dayBounds(date: string, timezone: string) {
  const day = Temporal.PlainDate.from(date);
  return { start: day.toZonedDateTime(timezone), end: day.add({ days: 1 }).toZonedDateTime(timezone) };
}
export function offsetChoice(time: Temporal.ZonedDateTime): OffsetChoice | undefined {
  const wall = time.toPlainDateTime();
  const earlier = wall.toZonedDateTime(time.timeZoneId, { disambiguation: 'earlier' });
  const later = wall.toZonedDateTime(time.timeZoneId, { disambiguation: 'later' });
  if (earlier.epochNanoseconds === later.epochNanoseconds) return undefined;
  return time.epochNanoseconds === earlier.epochNanoseconds ? 'earlier' : 'later';
}
export function dayTimeline(date: string, timezone: string) {
  const { start, end } = dayBounds(date, timezone);
  const minutes = minutesBetween(start.epochNanoseconds, end.epochNanoseconds);
  const changesOffset = start.offset !== end.offset;
  const slots = Array.from({ length: Math.ceil(minutes / 30) }, (_, index) => {
    const time = start.add({ minutes: index * 30 });
    return { minute: index * 30, time: time.toPlainTime().toString({ smallestUnit: 'minute' }),
      utcOffset: time.offset, offset: changesOffset ? offsetChoice(time) : undefined };
  });
  return { minutes, slots };
}
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
  const boundaries = new Map<string, { start: bigint; end: bigint }>();
  const bounds = (date: string) => {
    let value = boundaries.get(date);
    if (value === undefined) {
      const day = dayBounds(date, timezone);
      value = { start: day.start.epochNanoseconds, end: day.end.epochNanoseconds };
      boundaries.set(date, value);
    }
    return value;
  };
  const ordered = [...events].sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
  for (const event of ordered) {
    let startDay = event.start, endDay = event.end, startInstant = 0n, endInstant = 0n;
    if (!event.allDay) {
      const first = Temporal.Instant.from(event.start).toZonedDateTimeISO(timezone);
      const last = Temporal.Instant.from(event.end).toZonedDateTimeISO(timezone);
      startDay = first.toPlainDate().toString(); endDay = last.toPlainDate().toString();
      startInstant = first.epochNanoseconds; endInstant = last.epochNanoseconds;
    }
    const firstDay = startDay < start ? start : startDay;
    const lastDay = endDay > dates[dates.length - 1] ? dates[dates.length - 1] : endDay;
    if (firstDay > lastDay) continue;
    const firstIndex = indices.get(firstDay), lastIndex = indices.get(lastDay);
    if (firstIndex === undefined || lastIndex === undefined) continue;
    for (let index = firstIndex; index <= lastIndex; index++) {
      const date = dates[index];
      if (event.allDay ? date >= endDay : date !== startDay && endInstant <= bounds(date).start) continue;
      const group = groups.get(date)!;
      group.events.push(event);
      if (event.allDay) group.allDay.push(event);
      else {
        const day = bounds(date);
        group.timed.push({ event, start: Math.max(0, minutesBetween(day.start, startInstant)),
          end: minutesBetween(day.start, endInstant < day.end ? endInstant : day.end) });
      }
    }
  }
  return groups;
}
export const monthLabel = (date: string) => new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
export const dateLabel = (date: string) => new Intl.DateTimeFormat('en-GB', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
export const timeLabel = (instant: string, timezone: string, hour12: boolean, showOffset = false) => new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit', timeZone: timezone, hour12,
  ...(showOffset ? { timeZoneName: 'longOffset' as const } : {}) }).format(new Date(instant)).replace('GMT', 'UTC');

export function weekStart(date: string, firstWeekday: number) {
  const day = Temporal.PlainDate.from(date);
  return day.subtract({ days: (day.dayOfWeek % 7 - firstWeekday + 7) % 7 }).toString();
}
export const wallTime = (instant: string, timezone: string) => Temporal.Instant.from(instant).toZonedDateTimeISO(timezone).toPlainDateTime().toString({ smallestUnit: 'second' });
export function moveDraft(draft: EventDraft, targetDate: string, targetTime?: string, targetOffset?: OffsetChoice, displayTimezone = draft.timezone) {
  const dayShift = Temporal.PlainDate.from(targetDate).since(Temporal.PlainDate.from(draft.start.slice(0, 10))).days;
  if (draft.allDay) return { ...draft, start: targetDate, end: addDays(draft.end, dayShift) };
  const original = Temporal.PlainDateTime.from(draft.start);
  if (targetTime) {
    const timezone = draft.timezone === 'floating' ? displayTimezone : draft.timezone;
    const from = original.toZonedDateTime(timezone, { disambiguation: draft.startOffset ?? 'compatible' });
    const until = Temporal.PlainDateTime.from(draft.end).toZonedDateTime(timezone, { disambiguation: draft.endOffset ?? 'compatible' });
    const target = Temporal.PlainDateTime.from(`${targetDate}T${targetTime}`).toZonedDateTime(displayTimezone, { disambiguation: targetOffset ?? 'compatible' });
    const start = target.withTimeZone(timezone), end = target.add(from.until(until, { largestUnit: 'hour' })).withTimeZone(timezone);
    return { ...draft, start: start.toPlainDateTime().toString({ smallestUnit: 'second' }), end: end.toPlainDateTime().toString({ smallestUnit: 'second' }),
      startOffset: offsetChoice(start), endOffset: offsetChoice(end) };
  }
  const start = original.add({ days: dayShift });
  const duration = original.until(Temporal.PlainDateTime.from(draft.end));
  return { ...draft, start: start.toString({ smallestUnit: 'second' }), end: start.add(duration).toString({ smallestUnit: 'second' }), startOffset: undefined, endOffset: undefined };
}
