import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Temporal } from '@js-temporal/polyfill';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Occurrence } from '../src/shared';
import { addDays, groupEventsByDate, monthDays } from '../src/client/dates';
import { TimeGrid } from '../src/client/TimeGrid';

const event = (id: string, start: string, end: string, allDay = false): Occurrence => ({
  id, resourceId: id, calendarId: 'calendar', title: id, description: '', location: '',
  start, end, allDay, recurring: false,
});
const ids = (groups: ReturnType<typeof groupEventsByDate>, date: string) => groups.get(date)?.events.map(item => item.id);
afterEach(() => vi.restoreAllMocks());

describe('display-date event groups', () => {
  it('keeps all-day events before timed events, sorted by start without changing the input', () => {
    const events = [
      event('late', '2026-10-04T15:00:00Z', '2026-10-04T16:00:00Z'),
      event('day', '2026-10-04', '2026-10-05', true),
      event('early', '2026-10-04T08:00:00Z', '2026-10-04T09:00:00Z'),
      event('long-day', '2026-10-03', '2026-10-05', true),
    ];
    const groups = groupEventsByDate(events, 'UTC', '2026-10-04', '2026-10-06');
    expect(ids(groups, '2026-10-04')).toEqual(['long-day', 'day', 'early', 'late']);
    expect(groups.get('2026-10-04')?.allDay.map(item => item.id)).toEqual(['long-day', 'day']);
    expect(groups.get('2026-10-04')?.timed.map(item => item.event.id)).toEqual(['early', 'late']);
    expect(events.map(item => item.id)).toEqual(['late', 'day', 'early', 'long-day']);
    expect(ids(groups, '2026-10-05')).toEqual([]);
  });

  it('uses an exclusive all-day end date and clips long spans to the visible range', () => {
    const groups = groupEventsByDate([
      event('long', '1900-01-01', '2100-12-31', true),
      event('one-day', '2026-10-04', '2026-10-05', true),
      event('empty', '2026-10-04', '2026-10-04', true),
      event('outside', '2026-10-07', '2026-10-08', true),
    ], 'America/Los_Angeles', '2026-10-03', '2026-10-06');
    expect([...groups.keys()]).toEqual(['2026-10-03', '2026-10-04', '2026-10-05']);
    expect(ids(groups, '2026-10-03')).toEqual(['long']);
    expect(ids(groups, '2026-10-04')).toEqual(['long', 'one-day']);
    expect(ids(groups, '2026-10-05')).toEqual(['long']);
  });

  it('clips timed events across days using their display-timezone wall-clock times', () => {
    const item = event('overnight', '2026-10-03T20:30:00Z', '2026-10-05T01:15:00Z');
    const groups = groupEventsByDate([item], 'Europe/Prague', '2026-10-03', '2026-10-06');
    expect(groups.get('2026-10-03')?.timed).toEqual([{ event: item, start: 1350, end: 1440 }]);
    expect(groups.get('2026-10-04')?.timed).toEqual([{ event: item, start: 0, end: 1440 }]);
    expect(groups.get('2026-10-05')?.timed).toEqual([{ event: item, start: 0, end: 195 }]);
    const clipped = groupEventsByDate([item], 'Europe/Prague', '2026-10-04', '2026-10-05');
    expect([...clipped.keys()]).toEqual(['2026-10-04']);
    expect(clipped.get('2026-10-04')?.timed).toEqual([{ event: item, start: 0, end: 1440 }]);
  });

  it('excludes a timed midnight end but keeps zero-duration and fractional-midnight events', () => {
    const groups = groupEventsByDate([
      event('midnight-end', '2026-10-03T21:00:00Z', '2026-10-03T22:00:00Z'),
      event('instant', '2026-10-03T22:00:00Z', '2026-10-03T22:00:00Z'),
      event('fraction', '2026-10-03T21:30:00Z', '2026-10-03T22:00:00.001Z'),
    ], 'Europe/Prague', '2026-10-03', '2026-10-05');
    expect(ids(groups, '2026-10-03')).toEqual(['midnight-end', 'fraction']);
    expect(ids(groups, '2026-10-04')).toEqual(['fraction', 'instant']);
    expect(groups.get('2026-10-03')?.timed[0]).toMatchObject({ start: 1380, end: 1440 });
    expect(groups.get('2026-10-04')?.timed[1]).toMatchObject({ start: 0, end: 0 });
  });

  it('groups the same instant on different dates when the display timezone changes', () => {
    const item = event('zone', '2026-10-04T00:30:00Z', '2026-10-04T01:30:00Z');
    const utc = groupEventsByDate([item], 'UTC', '2026-10-03', '2026-10-05');
    const west = groupEventsByDate([item], 'America/Los_Angeles', '2026-10-03', '2026-10-05');
    expect(ids(utc, '2026-10-04')).toEqual(['zone']);
    expect(ids(west, '2026-10-03')).toEqual(['zone']);
    expect(ids(west, '2026-10-04')).toEqual([]);
    expect(west.get('2026-10-03')?.timed[0]).toMatchObject({ start: 1050, end: 1110 });
  });

  it('handles short and repeated daylight-saving hours using local dates and times', () => {
    const spring = event('spring', '2026-03-29T00:30:00Z', '2026-03-29T01:30:00Z');
    const springSpan = event('spring-span', '2026-03-28T23:30:00Z', '2026-03-30T00:15:00Z');
    const springGroups = groupEventsByDate([spring, springSpan], 'Europe/Prague', '2026-03-28', '2026-03-31');
    expect(ids(springGroups, '2026-03-28')).toEqual([]);
    expect(springGroups.get('2026-03-29')?.timed).toEqual([
      { event: springSpan, start: 30, end: 1440 }, { event: spring, start: 90, end: 210 },
    ]);
    expect(springGroups.get('2026-03-30')?.timed).toEqual([{ event: springSpan, start: 0, end: 135 }]);
    const fall = event('fall', '2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z');
    const fallGroups = groupEventsByDate([fall], 'Europe/Prague', '2026-10-25', '2026-10-26');
    expect(fallGroups.get('2026-10-25')?.timed).toEqual([{ event: fall, start: 150, end: 150 }]);
  });

  it('excludes the end boundary when midnight is skipped or a whole date does not exist', () => {
    const cairoBoundary = Temporal.PlainDate.from('2026-04-24').toZonedDateTime('Africa/Cairo');
    expect(cairoBoundary.hour).toBe(1);
    const cairo = event('midnight-gap', cairoBoundary.subtract({ hours: 1 }).toInstant().toString(), cairoBoundary.toInstant().toString());
    const cairoGroups = groupEventsByDate([cairo], 'Africa/Cairo', '2026-04-23', '2026-04-25');
    expect(ids(cairoGroups, '2026-04-23')).toEqual(['midnight-gap']);
    expect(ids(cairoGroups, '2026-04-24')).toEqual([]);
    const skipped = event('date-gap', '2011-12-30T09:00:00Z', '2011-12-30T10:00:00Z');
    const skippedGroups = groupEventsByDate([skipped], 'Pacific/Apia', '2011-12-29', '2012-01-01');
    expect(ids(skippedGroups, '2011-12-29')).toEqual(['date-gap']);
    expect(ids(skippedGroups, '2011-12-30')).toEqual([]);
    expect(ids(skippedGroups, '2011-12-31')).toEqual([]);
  });

  it('converts each timed endpoint only once, independent of repeated day reads and grid rendering', () => {
    const dates = monthDays('2026-10-04', 1);
    const events = Array.from({ length: 1000 }, (_, index) => {
      const date = dates[index % dates.length];
      return event(`event-${index}`, `${date}T09:00:00Z`, `${date}T10:00:00Z`);
    });
    const from = vi.spyOn(Temporal.Instant, 'from');
    const groups = groupEventsByDate(events, 'Europe/Prague', dates[0], addDays(dates[41], 1));
    expect(from).toHaveBeenCalledTimes(2000);
    for (let read = 0; read < 2; read++) for (const date of dates) expect(groups.get(date)?.events.length).toBeGreaterThan(0);
    const markup = renderToStaticMarkup(createElement(TimeGrid, {
      dates: dates.slice(0, 7), activeDate: dates[0], eventDays: groups, timezone: 'Europe/Prague', hour12: false,
      colorStyle: () => ({}), onOpen: vi.fn(), onAdd: vi.fn(), onDrop: vi.fn(), onDay: vi.fn(),
    }));
    expect(markup).toContain('Week calendar');
    expect(markup).toContain('event-0');
    expect(from).toHaveBeenCalledTimes(2000);
  });

  it('returns no groups for an empty visible range', () => {
    expect(groupEventsByDate([event('event', '2026-10-04T09:00:00Z', '2026-10-04T10:00:00Z')], 'UTC', '2026-10-04', '2026-10-04').size).toBe(0);
  });
});
