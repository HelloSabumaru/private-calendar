import { describe, expect, it } from 'vitest';
import ICAL from 'ical.js';
import { defaultRecurrence, type EventDraft } from '../src/shared.js';
import { canonicalICS, eventDetail, expandResources, parseCalendar, resolveWall, mergeExport, occurrenceDetail, splitImport, writeEvent, writeOccurrence } from '../src/server/ics.js';
import { runICS } from '../src/server/jobs.js';

export const draft: EventDraft = { calendarId: 'test', title: 'Walk', description: 'Bring tea', location: 'Park', start: '2026-10-04T09:00:00', end: '2026-10-04T10:00:00', allDay: false, timezone: 'Europe/Prague', reminder: 1440, recurrence: defaultRecurrence };
export const wrap = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Independent client//EN\r\n${body.trim().replace(/\r?\n/g, '\r\n')}\r\nEND:VCALENDAR\r\n`;
const resource = (ics: string) => ({ id: 'resource', calendarId: 'test', etag: '"1"', ics });
const expand = (ics: string, from = '2026-10-01T00:00:00Z', until = '2026-11-01T00:00:00Z', timezone = 'Europe/Prague') => expandResources([resource(ics)], from, until, timezone);

describe('calendar standards and preservation', () => {
  it('writes local named time, VTIMEZONE, and a one-day VALARM', () => {
    const ics = writeEvent(draft, 'identity');
    const calendar = parseCalendar(ics), event = new ICAL.Event(calendar.getFirstSubcomponent('vevent')!);
    expect(event.uid).toBe('identity'); expect(calendar.getFirstSubcomponent('vtimezone')).not.toBeNull();
    expect(event.startDate.toUnixTime()).toBe(Date.parse('2026-10-04T07:00:00Z') / 1000);
    expect(event.component.getFirstSubcomponent('valarm')!.getFirstPropertyValue('trigger')!.toString()).toBe('-P1D');
    expect(expand(ics).occurrences[0].start).toBe('2026-10-04T07:00:00.000Z');
  });
  it('uses exclusive all-day ends and handles multi-day overlap', () => {
    const ics = writeEvent({ ...draft, allDay: true, start: '2026-09-30', end: '2026-10-03' }, 'holiday');
    expect(ics).toContain('DTEND;VALUE=DATE:20261003');
    expect(expand(ics).occurrences[0]).toMatchObject({ allDay: true, start: '2026-09-30', end: '2026-10-03' });
    expect(expand(ics, '2026-10-03T00:00:00Z').occurrences).toHaveLength(0);
  });
  it('preserves attendees, unknown properties, alarms, and unrelated components', () => {
    const original = wrap(`X-CUSTOM-CALENDAR:keep\nBEGIN:VEVENT\nUID:foreign\nDTSTART:20261004T090000Z\nDURATION:PT1H\nSUMMARY:Before\nATTENDEE;CN=Jane;PARTSTAT=ACCEPTED:mailto:jane@example.test\nX-UNSUPPORTED;X-PARAM=preserve:opaque\nBEGIN:VALARM\nACTION:EMAIL\nTRIGGER:-PT2H\nDESCRIPTION:Mail\nSUMMARY:Mail\nATTENDEE:mailto:jane@example.test\nEND:VALARM\nEND:VEVENT\nBEGIN:VJOURNAL\nUID:journal\nSUMMARY:Keep me\nEND:VJOURNAL`);
    const initial = eventDetail(resource(original));
    const updated = writeEvent({ ...initial.draft, title: 'After' }, 'ignored', original);
    expect(updated).toContain('UID:foreign'); expect(updated).toContain('PARTSTAT=ACCEPTED'); expect(updated).toContain('X-UNSUPPORTED;X-PARAM=preserve:opaque');
    expect(updated).toContain('ACTION:EMAIL'); expect(updated).toContain('DURATION:PT1H'); expect(updated).toContain('BEGIN:VJOURNAL');
    expect(canonicalICS(original)).not.toBe(canonicalICS(updated));
  });
  it('displays complex BYSETPOS rules while blocking schedule changes', () => {
    const ics = wrap(`BEGIN:VEVENT\nUID:complex\nDTSTART:20260130T090000Z\nDTEND:20260130T100000Z\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1\nSUMMARY:Last workday\nEND:VEVENT`);
    const initial = eventDetail(resource(ics)); expect(initial.scheduleEditable).toBe(false);
    expect(expand(ics).occurrences[0].start).toBe('2026-10-30T09:00:00.000Z');
    expect(writeEvent({ ...initial.draft, title: 'Renamed' }, 'ignored', ics)).toContain('BYSETPOS=-1');
    expect(() => writeEvent({ ...initial.draft, start: '2026-01-30T11:00:00' }, 'ignored', ics)).toThrow('preserved');
  });
  it('displays moved exceptions whose recurrence ID is outside the requested range', () => {
    const ics = wrap(`BEGIN:VEVENT\nUID:series\nDTSTART:20260901T090000Z\nDTEND:20260901T100000Z\nRRULE:FREQ=DAILY;COUNT=3\nSUMMARY:Base\nEND:VEVENT\nBEGIN:VEVENT\nUID:series\nRECURRENCE-ID:20260902T090000Z\nDTSTART:20261005T110000Z\nDTEND:20261005T120000Z\nSUMMARY:Moved\nEND:VEVENT`);
    expect(expand(ics).occurrences).toHaveLength(1); expect(expand(ics).occurrences[0].title).toBe('Moved');
    const initial = eventDetail(resource(ics)); expect(initial.scheduleEditable).toBe(false);
    expect(writeEvent({ ...initial.draft, title: 'Base renamed' }, 'ignored', ics)).toContain('SUMMARY:Moved');
  });
  it('applies THISANDFUTURE changes without duplicate occurrences', () => {
    const ics = wrap(`BEGIN:VEVENT\nUID:range\nDTSTART:20261001T090000Z\nDTEND:20261001T100000Z\nRRULE:FREQ=DAILY;COUNT=4\nSUMMARY:Base\nEND:VEVENT\nBEGIN:VEVENT\nUID:range\nRECURRENCE-ID;RANGE=THISANDFUTURE:20261002T090000Z\nDTSTART:20261002T110000Z\nDTEND:20261002T120000Z\nSUMMARY:Later\nEND:VEVENT`);
    const occurrences = expand(ics).occurrences; expect(occurrences).toHaveLength(4);
    expect(occurrences.map(e => e.start)).toEqual(['2026-10-01T09:00:00.000Z', '2026-10-02T11:00:00.000Z', '2026-10-03T11:00:00.000Z', '2026-10-04T11:00:00.000Z']);
  });
  it('respects EXDATE, RDATE and cancelled exceptions', () => {
    const ics = wrap(`BEGIN:VEVENT\nUID:exceptions\nDTSTART:20261001T090000Z\nDTEND:20261001T100000Z\nRRULE:FREQ=DAILY;COUNT=4\nEXDATE:20261002T090000Z\nRDATE:20261008T090000Z\nSUMMARY:Base\nEND:VEVENT\nBEGIN:VEVENT\nUID:exceptions\nRECURRENCE-ID:20261003T090000Z\nDTSTART:20261003T090000Z\nDTEND:20261003T100000Z\nSTATUS:CANCELLED\nEND:VEVENT`);
    expect(expand(ics).occurrences.map(e => e.start.slice(8, 10))).toEqual(['01', '04', '08']);
  });
  it('includes DTSTART and honors longer RDATE periods without an RRULE', () => {
    const ics = wrap(`BEGIN:VEVENT\nUID:period\nDTSTART:20261001T090000Z\nDTEND:20261001T100000Z\nRDATE;VALUE=PERIOD:20261003T090000Z/20261003T120000Z\nSUMMARY:Period\nEND:VEVENT`);
    const result = expand(ics); expect(result.warnings).toEqual([]);
    expect(result.occurrences.map(e => [e.start, e.end])).toEqual([['2026-10-01T09:00:00.000Z', '2026-10-01T10:00:00.000Z'], ['2026-10-03T09:00:00.000Z', '2026-10-03T12:00:00.000Z']]);
  });
  it('excludes duplicate RDATE/RRULE dates and DTSTART when excluded', () => {
    const ics = wrap(`BEGIN:VEVENT\nUID:duplicate\nDTSTART:20261001T090000Z\nDTEND:20261001T100000Z\nRRULE:FREQ=DAILY;COUNT=3\nRDATE:20261001T090000Z,20261002T090000Z\nEXDATE:20261001T090000Z,20261002T090000Z\nSUMMARY:Excluded\nEND:VEVENT`);
    expect(expand(ics).occurrences.map(e => e.start)).toEqual(['2026-10-03T09:00:00.000Z']);
  });
  it('prefers embedded timezone definitions and preserves them during metadata edits', () => {
    const ics = wrap(`BEGIN:VTIMEZONE\nTZID:Europe/Prague\nBEGIN:STANDARD\nDTSTART:19700101T000000\nTZOFFSETFROM:+0330\nTZOFFSETTO:+0330\nEND:STANDARD\nEND:VTIMEZONE\nBEGIN:VEVENT\nUID:embedded\nDTSTART;TZID=Europe/Prague:20261004T090000\nDTEND;TZID=Europe/Prague:20261004T100000\nSUMMARY:Embedded\nEND:VEVENT`);
    expect(expand(ics).occurrences[0].start).toBe('2026-10-04T05:30:00.000Z');
    const updated = writeEvent({ ...eventDetail(resource(ics)).draft, title: 'Renamed' }, 'ignored', ics);
    expect(updated).toContain('TZOFFSETTO:+0330'); expect(expand(updated).occurrences[0].start).toBe('2026-10-04T05:30:00.000Z');
  });
  it('keeps floating events at local wall time in the chosen display timezone', () => {
    const ics = writeEvent({ ...draft, timezone: 'floating' }, 'float');
    expect(expand(ics).occurrences[0].start).toBe('2026-10-04T07:00:00.000Z');
    expect(expand(ics, undefined, undefined, 'America/New_York').occurrences[0].start).toBe('2026-10-04T13:00:00.000Z');
  });
  it('maintains local recurrence time across daylight saving changes', () => {
    const ics = writeEvent({ ...draft, start: '2026-10-24T09:00:00', end: '2026-10-24T10:00:00', recurrence: { ...defaultRecurrence, frequency: 'DAILY', end: 'count', count: 3 } }, 'dst');
    expect(expand(ics).occurrences.map(e => e.start)).toEqual(['2026-10-24T07:00:00.000Z', '2026-10-25T08:00:00.000Z', '2026-10-26T08:00:00.000Z']);
  });
  it('rejects nonexistent times and requires a choice for repeated wall time', () => {
    expect(() => resolveWall('2026-03-29T02:30:00', 'Europe/Prague')).toThrow('does not exist');
    expect(() => resolveWall('2026-10-25T02:30:00', 'Europe/Prague')).toThrow('occurs twice');
    expect(resolveWall('2026-10-25T02:30:00', 'Europe/Prague', 'later').epochMilliseconds - resolveWall('2026-10-25T02:30:00', 'Europe/Prague', 'earlier').epochMilliseconds).toBe(3600000);
  });
  it('represents the later offset without losing its instant', () => {
    const ics = writeEvent({ ...draft, start: '2026-10-25T02:30:00', end: '2026-10-25T03:30:00', startOffset: 'later' }, 'later');
    expect(expand(ics).occurrences[0].start).toBe('2026-10-25T01:30:00.000Z');
    expect(eventDetail(resource(ics)).draft.start).toBe('2026-10-25T02:30:00');
  });
  it('uses inclusive recurrence end dates', () => {
    const ics = writeEvent({ ...draft, recurrence: { ...defaultRecurrence, frequency: 'DAILY', end: 'until', until: '2026-10-06' } }, 'until');
    expect(expand(ics).occurrences.map(e => e.start.slice(8, 10))).toEqual(['04', '05', '06']);
  });
  it('creates aligned weekly rules and rejects a start outside selected weekdays', () => {
    const recurrence = { ...defaultRecurrence, frequency: 'WEEKLY' as const, weekdays: ['SU', 'TU'] as ('SU' | 'TU')[], end: 'count' as const, count: 3 };
    expect(expand(writeEvent({ ...draft, recurrence }, 'weekly')).occurrences.map(e => e.start.slice(0, 10))).toEqual(['2026-10-04', '2026-10-06', '2026-10-11']);
    expect(() => writeEvent({ ...draft, recurrence: { ...recurrence, weekdays: ['TU'] } }, 'invalid')).toThrow('selected repeat weekdays');
  });
  it('skips absent monthly dates and yearly leap days', () => {
    const monthly = writeEvent({ ...draft, start: '2026-01-31T09:00:00', end: '2026-01-31T10:00:00', recurrence: { ...defaultRecurrence, frequency: 'MONTHLY', end: 'count', count: 3 } }, 'monthly');
    expect(expand(monthly, '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z').occurrences.map(e => e.start.slice(0, 10))).toEqual(['2026-01-31', '2026-03-31', '2026-05-31']);
    const yearly = writeEvent({ ...draft, allDay: true, start: '2024-02-29', end: '2024-03-01', recurrence: { ...defaultRecurrence, frequency: 'YEARLY' } }, 'yearly');
    expect(expand(yearly, '2025-01-01T00:00:00Z', '2026-01-01T00:00:00Z').occurrences).toHaveLength(0);
  });
  it('reports bounded expansion instead of hanging on pathological series', () => {
    const ics = wrap(`BEGIN:VEVENT\nUID:huge\nDTSTART:19000101T000000Z\nRRULE:FREQ=SECONDLY\nSUMMARY:Huge\nEND:VEVENT`);
    expect(expand(ics).warnings).toHaveLength(1);
  });
  it('does not silently use UTC for undefined custom timezone identifiers', () => {
    const ics = wrap(`BEGIN:VEVENT\nUID:unknown\nDTSTART;TZID=Missing/Zone:20261004T090000\nSUMMARY:Unknown\nEND:VEVENT`);
    expect(expand(ics).warnings[0]).toContain('has no definition');
  });
  it('processes ICS in an isolated worker', async () => {
    const result = await runICS({ kind: 'write', draft, uid: 'worker' }); expect(result).toContain('UID:worker');
  });
});


describe('milestone 3 calendar preservation', () => {
  const series = () => writeEvent({ ...draft, start: '2026-10-24T09:00:00', end: '2026-10-24T10:00:00', recurrence: { ...defaultRecurrence, frequency: 'DAILY', end: 'count', count: 3 } }, 'series');
  it('edits a single occurrence across DST without moving the series', () => {
    const original = series().replace('SUMMARY:Walk', 'X-UNKNOWN:keep\r\nATTENDEE:mailto:friend@example.test\r\nSUMMARY:Walk');
    const detail = occurrenceDetail(resource(original), '2026-10-25T09:00:00');
    expect(detail.draft.start).toBe('2026-10-25T09:00:00');
    const updated = writeOccurrence(resource(original), detail.recurrenceId!, { ...detail.draft, title: 'One walk', start: '2026-10-25T11:00:00', end: '2026-10-25T12:00:00' });
    expect(updated).toContain('RECURRENCE-ID;TZID=Europe/Prague:20261025T090000');
    const result = expand(updated).occurrences;
    expect(result.map(e => e.start)).toEqual(['2026-10-24T07:00:00.000Z', '2026-10-25T10:00:00.000Z', '2026-10-26T08:00:00.000Z']);
    expect(result.map(e => e.title)).toEqual(['Walk', 'One walk', 'Walk']);
    const exception = parseCalendar(updated).getAllSubcomponents('vevent')[1];
    expect(exception.getFirstPropertyValue('x-unknown')).toBe('keep');
    expect(exception.getFirstSubcomponent('valarm')).not.toBeNull();
    expect(updated).toContain('ATTENDEE:mailto:friend@example.test');
  });
  it('updates an existing moved exception and preserves its own properties', () => {
    let ics = series(); const id = '2026-10-25T09:00:00';
    const first = occurrenceDetail(resource(ics), id);
    ics = writeOccurrence(resource(ics), id, { ...first.draft, start: '2026-10-28T10:00:00', end: '2026-10-28T11:00:00' });
    const calendar = parseCalendar(ics); calendar.getAllSubcomponents('vevent')[1].updatePropertyWithValue('x-exception', 'preserve'); ics = calendar.toString();
    const latest = occurrenceDetail(resource(ics), id);
    const updated = writeOccurrence(resource(ics), id, { ...latest.draft, title: 'Moved and renamed' });
    expect(parseCalendar(updated).getAllSubcomponents('vevent')).toHaveLength(2);
    expect(updated).toContain('X-EXCEPTION:preserve');
    expect(expand(updated).occurrences.find(e => e.title === 'Moved and renamed')?.recurrenceId).toBe(id);
  });
  it('cancels only one all-day occurrence and leaves other days and rules intact', () => {
    const ics = writeEvent({ ...draft, allDay: true, start: '2026-10-04', end: '2026-10-06', recurrence: { ...defaultRecurrence, frequency: 'DAILY', end: 'count', count: 3 } }, 'dates');
    const updated = writeOccurrence(resource(ics), '2026-10-05');
    expect(updated).toContain('RECURRENCE-ID;VALUE=DATE:20261005');
    expect(updated).toContain('STATUS:CANCELLED');
    expect(expand(updated).occurrences.map(e => e.start)).toEqual(['2026-10-04', '2026-10-06']);
  });
  it('edits an RDATE period while retaining its duration and master', () => {
    const ics = wrap('BEGIN:VEVENT\nUID:period-edit\nDTSTART:20261001T090000Z\nDTEND:20261001T100000Z\nRDATE;VALUE=PERIOD:20261003T090000Z/20261003T120000Z\nSUMMARY:Period\nEND:VEVENT');
    const detail = occurrenceDetail(resource(ics), '2026-10-03T09:00:00Z');
    expect(detail.draft.end).toBe('2026-10-03T12:00:00');
    const updated = writeOccurrence(resource(ics), detail.recurrenceId!, { ...detail.draft, title: 'Long period' });
    expect(expand(updated).occurrences[1].end).toBe('2026-10-03T12:00:00.000Z');
  });
  it('rejects invented occurrences and future-range edits', () => {
    expect(() => occurrenceDetail(resource(series()), '2026-10-27T09:00:00')).toThrow('no longer');
    const range = wrap('BEGIN:VEVENT\nUID:range\nDTSTART:20261001T090000Z\nRRULE:FREQ=DAILY;COUNT=4\nEND:VEVENT\nBEGIN:VEVENT\nUID:range\nRECURRENCE-ID;RANGE=THISANDFUTURE:20261002T090000Z\nDTSTART:20261002T110000Z\nEND:VEVENT');
    expect(() => occurrenceDetail(resource(range), '2026-10-03T09:00:00Z')).toThrow('future-range');
  });
  it('splits import by UID, keeping exceptions, zones, alarms and unknown data', () => {
    const first = series(); const second = writeEvent({ ...draft, title: 'Other event' }, 'other');
    const combined = mergeExport([first, second]);
    const items = splitImport(combined);
    expect(items).toHaveLength(2);
    expect(items.map(item => item.uid)).toEqual(['series', 'other']);
    expect(items[0].ics).toContain('BEGIN:VTIMEZONE'); expect(items[0].ics).toContain('BEGIN:VALARM');
    expect(expand(items[0].ics).occurrences).toHaveLength(3);
    expect(parseCalendar(combined).getAllSubcomponents('vtimezone')).toHaveLength(1);
  });
  it('rejects incomplete imports and keeps distinct export timezone definitions', () => {
    expect(() => splitImport(wrap('BEGIN:VEVENT\nUID:detached\nRECURRENCE-ID:20261003T090000Z\nDTSTART:20261003T110000Z\nEND:VEVENT'))).toThrow('cannot be safely');
    const first = series(), other = writeEvent(draft, 'different');
    const exported = mergeExport([first, other.replace('TZOFFSETTO:+0100', 'TZOFFSETTO:+0130')]);
    const zones = parseCalendar(exported).getAllSubcomponents('vtimezone');
    expect(zones).toHaveLength(2);
    expect(zones[0].getFirstPropertyValue('tzid')).not.toBe(zones[1].getFirstPropertyValue('tzid'));
    expect(exported).toContain('TZID=Europe/Prague-export-2');
    expect(exported).toContain('TZOFFSETTO:+0130');
  });
});


it('selects leap-day occurrences without changing an imported yearly rule', () => {
  const ics = wrap('BEGIN:VEVENT\nUID:leap-selection\nDTSTART;VALUE=DATE:20240229\nDTEND;VALUE=DATE:20240301\nRRULE:FREQ=YEARLY\nSUMMARY:Leap\nEND:VEVENT');
  const selected = occurrenceDetail(resource(ics), '2028-02-29');
  expect(selected.draft.start).toBe('2028-02-29');
  const updated = writeOccurrence(resource(ics), '2028-02-29', { ...selected.draft, title: 'Next leap day' });
  expect(updated).toContain('RRULE:FREQ=YEARLY\r\n');
  expect(updated).toContain('RECURRENCE-ID;VALUE=DATE:20280229');
});
