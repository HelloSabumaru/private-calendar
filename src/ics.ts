import ICAL from 'ical.js';
import { Temporal } from '@js-temporal/polyfill';
import { defaultRecurrence, type EventDetail, type EventDraft, type Occurrence, type Recurrence } from './shared.js';
import { ApiError } from './errors.js';
import type { Timezones } from './timezones.js';

export type Resource = { id: string; calendarId: string; etag: string; ics: string };
export function createIcsCodec(timezones: Timezones) {
  const timezoneComponent = timezones.component;
  const knownZones = new Set(timezones.names);
  const text = (component: ICAL.Component, name: string) => String(component.getFirstPropertyValue(name) ?? '');
  const cancelled = (event: ICAL.Event) => text(event.component, 'status').toUpperCase() === 'CANCELLED';

  function parseCalendar(ics: string) {
    if (new TextEncoder().encode(ics).byteLength > 1024 * 1024) throw new ApiError(422, 'ICS_LIMIT', 'This calendar resource is too large.');
    const component = ICAL.Component.fromString(ics);
    if (component.name !== 'vcalendar') throw new ApiError(422, 'ICS_INVALID', 'Expected a VCALENDAR document.');
    const events = component.getAllSubcomponents('vevent');
    if (!events.length || events.length > 2000) throw new ApiError(422, 'ICS_INVALID', 'Unsupported calendar resource structure.');
    for (const event of events) {
      for (const property of event.getAllProperties()) {
        const tzid = property.getParameter('tzid');
        if (typeof tzid === 'string' && !component.getTimeZoneByID(tzid) && !ICAL.TimezoneService.has(tzid)) throw new ApiError(422, 'TIMEZONE_UNKNOWN', `Timezone ${tzid} has no definition.`);
      }
    }
    return component;
  }

  function masterOf(calendar: ICAL.Component) {
    const events = calendar.getAllSubcomponents('vevent');
    const masters = events.filter(event => !event.hasProperty('recurrence-id'));
    if (masters.length !== 1 || !text(masters[0], 'uid') || events.some(event => text(event, 'uid') !== text(masters[0], 'uid'))) throw new ApiError(422, 'EDIT_UNSUPPORTED', 'This resource cannot be safely edited or deleted as one series.');
    return new ICAL.Event(masters[0], { strictExceptions: true });
  }

  function wall(time: ICAL.Time, preferred?: string) {
    if (preferred && knownZones.has(preferred) && !time.isDate && time.zone !== ICAL.Timezone.localTimezone) return Temporal.Instant.fromEpochMilliseconds(time.toUnixTime() * 1000).toZonedDateTimeISO(preferred).toPlainDateTime().toString({ smallestUnit: 'second' });
    return time.toString().replace(/Z$/, '');
  }

  function recurrenceOf(event: ICAL.Event): Recurrence {
    const rule = event.component.getFirstPropertyValue('rrule') as ICAL.Recur | null;
    if (!rule) return { ...defaultRecurrence };
    return {
      frequency: ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq) ? rule.freq as Recurrence['frequency'] : 'NONE',
      interval: rule.interval, weekdays: (rule.getComponent('BYDAY') ?? []) as Recurrence['weekdays'],
      end: rule.count ? 'count' : rule.until ? 'until' : 'never', count: rule.count || undefined,
      until: rule.until ? wall(rule.until.convertToZone(event.startDate.zone)).slice(0, 10) : undefined,
    };
  }

  function scheduleReason(event: ICAL.Event) {
    const c = event.component;
    if (Object.keys(event.exceptions).length || c.hasProperty('rdate') || c.hasProperty('exdate') || c.hasProperty('exrule')) return 'Existing exceptions and additional recurrence dates are preserved. Schedule changes are unavailable.';
    const rules = c.getAllProperties('rrule');
    if (rules.length > 1) return 'Multiple recurrence rules are preserved. Schedule changes are unavailable.';
    const rule = c.getFirstPropertyValue('rrule') as ICAL.Recur | null;
    if (rule && (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq) ||
      Object.keys(rule.parts).some(key => !((key === 'BYDAY' && rule.freq === 'WEEKLY') ||
        (key === 'BYMONTH' && rule.freq === 'YEARLY' && JSON.stringify(rule.getComponent(key)) === JSON.stringify([event.startDate.month])) ||
        (key === 'BYMONTHDAY' && ['MONTHLY', 'YEARLY'].includes(rule.freq) && JSON.stringify(rule.getComponent(key)) === JSON.stringify([event.startDate.day])))) ||
      (rule.getComponent('BYDAY') ?? []).some(day => !['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'].includes(String(day))) || rule.wkst !== ICAL.Time.MONDAY)) return 'This recurrence rule is preserved. Schedule changes are unavailable.';
    if (!['UTC', 'floating'].includes(event.startDate.zone.tzid) && !knownZones.has(event.startDate.zone.tzid)) return 'This event uses a custom timezone. Schedule changes are unavailable.';
    if (event.startDate.zone.tzid !== event.endDate.zone.tzid && !text(c, 'x-private-calendar-timezone')) return 'This event uses different start and end timezones. Schedule changes are unavailable.';
  }

  function supportedAlarm(alarm: ICAL.Component) {
    const trigger = alarm.getFirstProperty('trigger');
    return text(alarm, 'action').toUpperCase() === 'DISPLAY' && trigger?.getFirstValue() instanceof ICAL.Duration &&
      String(trigger.getParameter('related') ?? 'START').toUpperCase() === 'START' && !alarm.hasProperty('repeat') && !alarm.hasProperty('duration');
  }

  function eventDetail(resource: Resource): EventDetail {
    const calendar = parseCalendar(resource.ics);
    const event = masterOf(calendar);
    const reason = scheduleReason(event);
    const preferred = text(event.component, 'x-private-calendar-timezone') || undefined;
    const alarms = event.component.getAllSubcomponents('valarm');
    return {
      id: resource.id, etag: resource.etag, recurring: event.isRecurring(), scheduleEditable: !reason,
      editReason: reason, alarmCount: alarms.length, unsupportedAlarms: alarms.filter(a => !supportedAlarm(a)).length,
      recurrenceText: event.component.getAllProperties('rrule').map(p => String(p.getFirstValue())).join('; ') || undefined,
      canUpdate: true, canDelete: calendar.getAllSubcomponents().every(c => ['vevent', 'vtimezone'].includes(c.name)),
      deleteReason: calendar.getAllSubcomponents().some(c => !['vevent', 'vtimezone'].includes(c.name)) ? 'Deletion is unavailable because this resource contains unrelated calendar components.' : undefined,
      draft: {
        calendarId: resource.calendarId, title: event.summary || '', description: event.description || '', location: event.location || '',
        start: wall(event.startDate, preferred), end: wall(event.endDate, preferred), allDay: event.startDate.isDate,
        timezone: preferred ?? event.startDate.zone.tzid, recurrence: recurrenceOf(event), reminder: 'preserve',
        ...(preferred ? { startOffset: offsetChoice(event.startDate, preferred), endOffset: offsetChoice(event.endDate, preferred) } : {}),
      },
    };
  }

  function offsetChoice(time: ICAL.Time, timezone: string): 'earlier' | 'later' | undefined {
    if (time.isDate) return;
    const plain = Temporal.PlainDateTime.from(wall(time, timezone));
    const early = plain.toZonedDateTime(timezone, { disambiguation: 'earlier' });
    const late = plain.toZonedDateTime(timezone, { disambiguation: 'later' });
    if (early.epochMilliseconds !== late.epochMilliseconds) return time.toUnixTime() * 1000 === late.epochMilliseconds ? 'later' : 'earlier';
  }

  function resolveWall(value: string, timezone: string, choice?: 'earlier' | 'later') {
    const plain = Temporal.PlainDateTime.from(value);
    const early = plain.toZonedDateTime(timezone, { disambiguation: 'earlier' });
    const late = plain.toZonedDateTime(timezone, { disambiguation: 'later' });
    if (!early.toPlainDateTime().equals(plain) || !late.toPlainDateTime().equals(plain)) throw new ApiError(422, 'DST_GAP', 'This time does not exist because clocks move forward. Choose another time.');
    if (early.epochMilliseconds !== late.epochMilliseconds && !choice) throw new ApiError(422, 'DST_OVERLAP', 'This time occurs twice. Choose the earlier or later offset.');
    return choice === 'later' ? late : early;
  }

  function draftTime(value: string, draft: EventDraft, choice?: 'earlier' | 'later') {
    if (draft.allDay) {
      Temporal.PlainDate.from(value);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ApiError(422, 'DATE_INVALID', 'All-day events require dates.');
      return ICAL.Time.fromDateString(value);
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) throw new ApiError(422, 'DATE_INVALID', 'Enter a date and time.');
    const plain = Temporal.PlainDateTime.from(value);
    let zone = draft.timezone;
    if (zone !== 'floating') {
      if (!knownZones.has(zone)) throw new ApiError(422, 'TIMEZONE_UNKNOWN', 'Choose a supported timezone.');
      const resolved = resolveWall(value, zone, choice);
      const early = plain.toZonedDateTime(zone, { disambiguation: 'earlier' });
      const late = plain.toZonedDateTime(zone, { disambiguation: 'later' });
      if (draft.recurrence.frequency !== 'NONE' && resolved.epochMilliseconds !== early.epochMilliseconds) {
        throw new ApiError(422, 'DST_OVERLAP', 'Recurring events must use the earlier offset, as required by iCalendar.');
      }
      // UTC keeps either selected instant unambiguous for a nonrecurring event.
      if (draft.recurrence.frequency === 'NONE' && early.epochMilliseconds !== late.epochMilliseconds) {
        return ICAL.Time.fromJSDate(new Date(resolved.epochMilliseconds), true);
      }
    } else zone = 'floating';
    return ICAL.Time.fromData({ year: plain.year, month: plain.month, day: plain.day, hour: plain.hour, minute: plain.minute, second: plain.second, isDate: false },
      zone === 'floating' ? ICAL.Timezone.localTimezone : ICAL.TimezoneService.get(zone)!);
  }

  function applySchedule(calendar: ICAL.Component, event: ICAL.Event, draft: EventDraft) {
    const start = draftTime(draft.start, draft, draft.startOffset);
    const end = draftTime(draft.end, draft, draft.endOffset);
    if (end.compare(start) <= 0) throw new ApiError(422, 'DATE_ORDER', 'End must be after start.');
    if (draft.timezone !== 'UTC' && draft.timezone !== 'floating' && !draft.allDay && !calendar.getTimeZoneByID(draft.timezone)) calendar.addSubcomponent(timezoneComponent(draft.timezone)!);
    event.startDate = start; event.endDate = end;
    event.component.removeAllProperties('x-private-calendar-timezone');
    if (!draft.allDay && draft.timezone !== 'floating' && (start.zone.tzid !== draft.timezone || end.zone.tzid !== draft.timezone)) event.component.updatePropertyWithValue('x-private-calendar-timezone', draft.timezone);
    event.component.removeAllProperties('rrule');
    const r = draft.recurrence;
    if (r.frequency === 'NONE') return;
    if (r.frequency === 'WEEKLY' && r.weekdays.length) {
      const firstDay = (['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const)[Temporal.PlainDate.from(draft.start.slice(0, 10)).dayOfWeek - 1];
      if (!r.weekdays.includes(firstDay)) throw new ApiError(422, 'RECURRENCE_START', 'The start date must be one of the selected repeat weekdays.');
    }
    const parts = [`FREQ=${r.frequency}`, `INTERVAL=${r.interval}`, 'WKST=MO'];
    if (r.frequency === 'YEARLY') parts.push(`BYMONTH=${start.month}`);
    if (r.frequency === 'MONTHLY' || r.frequency === 'YEARLY') parts.push(`BYMONTHDAY=${start.day}`);
    if (r.frequency === 'WEEKLY' && r.weekdays.length) parts.push(`BYDAY=${[...new Set(r.weekdays)].join(',')}`);
    if (r.end === 'count') parts.push(`COUNT=${r.count}`);
    if (r.end === 'until') {
      Temporal.PlainDate.from(r.until!);
      if (r.until! < draft.start.slice(0, 10)) throw new ApiError(422, 'RECURRENCE_END', 'The recurrence end must be on or after its start.');
      const until = draft.allDay ? ICAL.Time.fromDateString(r.until!) : draftTime(`${r.until}T23:59:59`, { ...draft, recurrence: defaultRecurrence }, 'earlier');
      parts.push(`UNTIL=${(draft.allDay || draft.timezone === 'floating' ? until : until.convertToZone(ICAL.Timezone.utcTimezone)).toICALString()}`);
    }
    event.component.updatePropertyWithValue('rrule', ICAL.Recur.fromString(parts.join(';')));
  }

  function applyReminder(event: ICAL.Event, draft: EventDraft) {
    if (draft.reminder === 'preserve') return;
    const alarms = event.component.getAllSubcomponents('valarm').filter(supportedAlarm);
    if (draft.reminder === 'none') { for (const alarm of alarms) event.component.removeSubcomponent(alarm); return; }
    const alarm = alarms[0] ?? new ICAL.Component('valarm');
    if (!alarms.length) { alarm.updatePropertyWithValue('action', 'DISPLAY'); event.component.addSubcomponent(alarm); }
    for (const extra of alarms.slice(1)) event.component.removeSubcomponent(extra);
    alarm.updatePropertyWithValue('trigger', ICAL.Duration.fromSeconds(-draft.reminder * 60));
    if (!alarm.hasProperty('description')) alarm.updatePropertyWithValue('description', draft.title);
  }

  function writeEvent(draft: EventDraft, uid: string, original?: string) {
    const calendar = original ? parseCalendar(original) : new ICAL.Component('vcalendar');
    let event: ICAL.Event;
    if (original) event = masterOf(calendar);
    else {
      calendar.updatePropertyWithValue('version', '2.0');
      calendar.updatePropertyWithValue('prodid', '-//Private Calendar//Web Calendar 1.0//EN');
      const c = new ICAL.Component('vevent'); calendar.addSubcomponent(c); event = new ICAL.Event(c); event.uid = uid;
      c.updatePropertyWithValue('created', ICAL.Time.now().convertToZone(ICAL.Timezone.utcTimezone));
    }
    if (original) {
      const base = eventDetail({ id: '', calendarId: draft.calendarId, etag: '', ics: original });
      const fields = ['start', 'end', 'timezone', 'allDay', 'recurrence', 'startOffset', 'endOffset'] as const;
      const changed = fields.some(key => JSON.stringify(base.draft[key]) !== JSON.stringify(draft[key]));
      if (changed && !base.scheduleEditable) throw new ApiError(422, 'EDIT_UNSUPPORTED', base.editReason!);
      if (changed) applySchedule(calendar, event, draft);
    } else applySchedule(calendar, event, draft);
    for (const [property, value] of [['summary', draft.title], ['description', draft.description], ['location', draft.location]]) {
      if (text(event.component, property) !== value) event.component.updatePropertyWithValue(property, value);
    }
    applyReminder(event, draft);
    const now = ICAL.Time.now().convertToZone(ICAL.Timezone.utcTimezone);
    event.component.updatePropertyWithValue('dtstamp', now); event.component.updatePropertyWithValue('last-modified', now);
    event.sequence = (event.sequence || 0) + (original ? 1 : 0);
    return calendar.toString() + '\r\n';
  }

  function millis(time: ICAL.Time, timezone: string) {
    if (time.isDate) return Temporal.PlainDate.from(time.toString()).toZonedDateTime(timezone).epochMilliseconds;
    if (time.zone === ICAL.Timezone.localTimezone) return Temporal.PlainDateTime.from(time.toString()).toZonedDateTime(timezone, { disambiguation: 'compatible' }).epochMilliseconds;
    return time.toUnixTime() * 1000;
  }

  function normalizeYearly(event: ICAL.Event) {
    // Explicit defaults prevent an implicit February 29 from becoming March 1.
    for (const property of event.component.getAllProperties('rrule')) {
      const rule = property.getFirstValue() as ICAL.Recur;
      if (rule.freq === 'YEARLY' && !['BYDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYMONTHDAY'].some(key => rule.getComponent(key)?.length)) {
        if (!rule.getComponent('BYMONTH')?.length) rule.setComponent('BYMONTH', [event.startDate.month]);
        rule.setComponent('BYMONTHDAY', [event.startDate.day]);
      }
    }
  }

  function expandResources(resources: Resource[], from: string, until: string, timezone: string) {
    const rangeStart = Date.parse(from), rangeEnd = Date.parse(until);
    const occurrences: Occurrence[] = []; const warnings: string[] = [];
    const deadline = performance.now() + 2500;
    let totalSteps = 0;
    for (const resource of resources) {
      try {
        const calendar = parseCalendar(resource.ics);
        const components = calendar.getAllSubcomponents('vevent');
        const masters = components.filter(c => !c.hasProperty('recurrence-id'));
        const seen = new Set<string>();
        const append = (event: ICAL.Event, start: ICAL.Time, end: ICAL.Time, recurrenceId: string, recurring: boolean, base?: ICAL.Event, originalTime?: ICAL.Time) => {
          if (cancelled(event) || seen.has(recurrenceId)) return;
          if (base && originalTime) {
            const excluded = base.component.getAllProperties('exdate').flatMap(p => p.getValues()).some(value => value instanceof ICAL.Time &&
              (value.isDate ? value.toString() === originalTime.convertToZone(base.startDate.zone).toString().slice(0, 10) : millis(value, timezone) === millis(originalTime, timezone)));
            if (excluded) return;
          }
          const startMs = millis(start, timezone), endMs = millis(end, timezone);
          if (startMs >= rangeEnd || (endMs === startMs ? startMs < rangeStart : endMs <= rangeStart)) return;
          if (occurrences.length >= 10000) throw new Error('Occurrence limit reached');
          seen.add(recurrenceId);
          occurrences.push({ id: `${resource.id}:${recurrenceId}`, resourceId: resource.id, calendarId: resource.calendarId,
            title: (event.component.hasProperty('summary') ? event.summary : base?.summary) || '(Untitled)',
            description: (event.component.hasProperty('description') ? event.description : base?.description) || '',
            location: (event.component.hasProperty('location') ? event.location : base?.location) || '',
            start: start.isDate ? start.toString() : new Date(startMs).toISOString(),
            end: end.isDate ? end.toString() : new Date(endMs).toISOString(), allDay: start.isDate, recurring, recurrenceId: recurring && originalTime ? originalTime.toString() : undefined });
        };
        for (const c of masters) {
          const event = new ICAL.Event(c, { strictExceptions: true });
          if (!event.isRecurring()) { append(event, event.startDate, event.endDate, event.uid, false); continue; }
          const exceptions = components.filter(other => other.hasProperty('recurrence-id') && text(other, 'uid') === event.uid).map(c => new ICAL.Event(c));
          // A moved exception can enter the range even when its original date is outside it.
          for (const exception of exceptions) append(exception, exception.startDate, exception.endDate, `${event.uid}:${exception.recurrenceId.toString()}`, true, event, exception.recurrenceId);
          let greatestShift = 0;
          for (const exception of exceptions) if (!cancelled(exception) && exception.startDate) greatestShift = Math.max(greatestShift, Math.abs(millis(exception.startDate, timezone) - millis(exception.recurrenceId, timezone)));
          normalizeYearly(event);
          const periods = new Map<string, ICAL.Period>();
          for (const property of c.getAllProperties('rdate')) {
            const values = property.getValues();
            if (values[0] instanceof ICAL.Period) {
              for (const value of values as ICAL.Period[]) periods.set(value.start.toString(), value);
              property.resetType('date-time'); property.setValues((values as ICAL.Period[]).map(value => value.start));
            }
          }
          if (!c.hasProperty('rrule')) {
            const startProperty = new ICAL.Property('rdate');
            startProperty.setValue(event.startDate.clone()); c.addProperty(startProperty);
          }
          const iterator = event.iterator(); let steps = 0;
          while (true) {
            if (++steps > 100000 || ++totalSteps > 250000 || performance.now() > deadline) throw new Error('Recurrence expansion limit reached');
            const next = iterator.next(); if (!next) break;
            if (millis(next, timezone) > rangeEnd + greatestShift + 86400000) break;
            const details = event.getOccurrenceDetails(next);
            const periodEnd = details.item === event ? periods.get(next.toString())?.getEnd() : undefined;
            append(details.item, details.startDate, periodEnd ?? details.endDate, `${event.uid}:${next.toString()}`, true, event, next);
          }
        }
        // Detached exception-only documents are displayable but not editable as a whole series.
        for (const c of components.filter(c => c.hasProperty('recurrence-id') && !masters.some(m => text(m, 'uid') === text(c, 'uid')))) {
          const event = new ICAL.Event(c); append(event, event.startDate, event.endDate, `${event.uid}:${event.recurrenceId.toString()}`, true, undefined, event.recurrenceId);
        }
      } catch (error) { warnings.push(`${resource.id}: ${error instanceof ApiError ? error.message : 'Some events could not be fully expanded within resource limits.'}`); }
    }
    occurrences.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
    return { occurrences, warnings };
  }

  function canonicalICS(ics: string) {
    const normalize = (c: ICAL.Component): unknown => [c.name,
      c.getAllProperties().map(p => JSON.stringify(p.toJSON())).sort(),
      c.getAllSubcomponents().map(child => JSON.stringify(normalize(child))).sort()];
    return JSON.stringify(normalize(parseCalendar(ics)));
  }

  const cloneComponent = (component: ICAL.Component) => new ICAL.Component(JSON.parse(JSON.stringify(component.toJSON())));

  function selectOccurrence(calendar: ICAL.Component, recurrenceId: string) {
    const master = masterOf(calendar);
    if (!master.isRecurring()) throw new ApiError(422, 'OCCURRENCE_INVALID', 'This event does not repeat.');
    const selected = ICAL.Time.fromString(recurrenceId, undefined);
    selected.zone = master.startDate.zone;
    if (selected.isDate !== master.startDate.isDate || selected.toString() !== recurrenceId) throw new ApiError(422, 'OCCURRENCE_INVALID', 'Choose a valid occurrence.');
    if (calendar.getAllSubcomponents('vevent').some(c => c.getFirstProperty('recurrence-id')?.getParameter('range'))) throw new ApiError(422, 'EDIT_UNSUPPORTED', 'Individual edits are unavailable for series with future-range changes.');
    if (calendar.getAllSubcomponents('vevent').some(c => c.hasProperty('recurrence-id') && ['rrule', 'rdate', 'exdate', 'exrule'].some(name => c.hasProperty(name)))) throw new ApiError(422, 'EDIT_UNSUPPORTED', 'Individual edits are unavailable for exceptions with their own recurrence rules.');
    const iterable = new ICAL.Event(cloneComponent(master.component));
    for (const property of iterable.component.getAllProperties('rdate')) {
      const values = property.getValues();
      if (values[0] instanceof ICAL.Period) { property.resetType('date-time'); property.setValues((values as ICAL.Period[]).map(value => value.start)); }
    }
    if (!iterable.component.hasProperty('rrule')) { const p = new ICAL.Property('rdate'); p.setValue(iterable.startDate.clone()); iterable.component.addProperty(p); }
    normalizeYearly(iterable);
    const iterator = iterable.iterator();
    let found = false;
    for (let i = 0; i < 100000; i++) {
      const next = iterator.next();
      if (!next || next.compare(selected) > 0) break;
      if (next.compare(selected) === 0) { found = true; break; }
      if (i === 99999) throw new ApiError(422, 'ICS_LIMIT', 'This occurrence exceeds the recurrence processing limit.');
    }
    if (!found) throw new ApiError(422, 'OCCURRENCE_INVALID', 'This occurrence is no longer in the series.');
    const details = master.getOccurrenceDetails(selected) as { item: ICAL.Event; startDate: ICAL.Time; endDate: ICAL.Time };
    if (cancelled(details.item)) throw new ApiError(422, 'OCCURRENCE_INVALID', 'This occurrence was cancelled.');
    const effective = cloneComponent(master.component);
    if (details.item !== master) {
      for (const property of details.item.component.getAllProperties()) {
        effective.removeAllProperties(property.name);
      }
      for (const property of details.item.component.getAllProperties()) effective.addProperty(new ICAL.Property(JSON.parse(JSON.stringify(property.toJSON()))));
      const names = new Set(details.item.component.getAllSubcomponents().map(c => c.name));
      for (const name of names) effective.removeAllSubcomponents(name);
      for (const child of details.item.component.getAllSubcomponents()) effective.addSubcomponent(cloneComponent(child));
    }
    for (const property of ['rrule', 'rdate', 'exdate', 'exrule', 'recurrence-id', 'duration']) effective.removeAllProperties(property);
    const event = new ICAL.Event(effective);
    event.startDate = details.startDate; event.endDate = details.endDate;
    const period = master.component.getAllProperties('rdate').flatMap(p => p.getValues()).find(value => value instanceof ICAL.Period && value.start.compare(selected) === 0);
    if (details.item === master && period instanceof ICAL.Period) event.endDate = period.getEnd();
    const single = new ICAL.Component('vcalendar');
    for (const property of calendar.getAllProperties()) single.addProperty(new ICAL.Property(JSON.parse(JSON.stringify(property.toJSON()))));
    for (const zone of calendar.getAllSubcomponents('vtimezone')) single.addSubcomponent(cloneComponent(zone));
    single.addSubcomponent(effective);
    return { master, selected, single };
  }

  function occurrenceDetail(resource: Resource, recurrenceId: string): EventDetail {
    const calendar = parseCalendar(resource.ics);
    const { single } = selectOccurrence(calendar, recurrenceId);
    const result = eventDetail({ ...resource, ics: single.toString() });
    return { ...result, recurring: true, recurrenceId, canDelete: true };
  }

  function writeOccurrence(resource: Resource, recurrenceId: string, draft?: EventDraft) {
    const calendar = parseCalendar(resource.ics);
    const { master, selected, single } = selectOccurrence(calendar, recurrenceId);
    const updated = draft ? parseCalendar(writeEvent({ ...draft, recurrence: defaultRecurrence }, master.uid, single.toString())) : single;
    const exception = updated.getFirstSubcomponent('vevent')!;
    if (!draft) { exception.updatePropertyWithValue('status', 'CANCELLED'); exception.updatePropertyWithValue('dtstamp', ICAL.Time.now().convertToZone(ICAL.Timezone.utcTimezone)); }
    const event = new ICAL.Event(exception);
    event.recurrenceId = selected;
    for (const old of calendar.getAllSubcomponents('vevent')) {
      const id = old.getFirstPropertyValue('recurrence-id');
      if (id instanceof ICAL.Time && id.compare(selected) === 0) calendar.removeSubcomponent(old);
    }
    updated.removeSubcomponent(exception); calendar.addSubcomponent(exception);
    for (const zone of updated.getAllSubcomponents('vtimezone')) if (!calendar.getTimeZoneByID(text(zone, 'tzid'))) calendar.addSubcomponent(cloneComponent(zone));
    return calendar.toString() + '\r\n';
  }

  function splitImport(ics: string) {
    const calendar = parseCalendar(ics);
    if (calendar.getAllSubcomponents().some(c => !['vevent', 'vtimezone'].includes(c.name))) throw new ApiError(422, 'IMPORT_UNSUPPORTED', 'Import a calendar containing events and timezone definitions.');
    const groups = new Map<string, ICAL.Component[]>();
    for (const event of calendar.getAllSubcomponents('vevent')) {
      const uid = text(event, 'uid');
      if (!uid || uid.length > 1000) throw new ApiError(422, 'ICS_INVALID', 'Each imported event needs a valid UID.');
      groups.set(uid, [...groups.get(uid) ?? [], event]);
    }
    if (groups.size > 100) throw new ApiError(422, 'IMPORT_LIMIT', 'Import at most 100 event series at a time.');
    return [...groups].map(([uid, events]) => {
      const result = cloneComponent(calendar);
      result.removeAllSubcomponents('vevent');
      for (const event of events) result.addSubcomponent(cloneComponent(event));
      const master = masterOf(result);
      if (!master.startDate || !master.endDate) throw new ApiError(422, 'ICS_INVALID', 'An imported event has invalid dates.');
      return { uid, title: master.summary || '(Untitled)', ics: result.toString() + '\r\n' };
    });
  }

  function mergeExport(documents: string[]) {
    const result = new ICAL.Component('vcalendar');
    result.updatePropertyWithValue('version', '2.0'); result.updatePropertyWithValue('prodid', '-//Private Calendar//Export//EN');
    const zones = new Map<string, string>();
    const uids = new Set<string>();
    for (const source of documents) {
      const calendar = parseCalendar(source);
      for (const zone of calendar.getAllSubcomponents('vtimezone')) {
        const id = text(zone, 'tzid'), signature = JSON.stringify(zone.toJSON());
        if (!zones.has(id) || zones.get(id) === signature) continue;
        let suffix = zones.size + 1;
        let unique = `${id}-export-${suffix}`;
        while (zones.has(unique) || calendar.getTimeZoneByID(unique)) unique = `${id}-export-${++suffix}`;
        zone.updatePropertyWithValue('tzid', unique);
        const rename = (component: ICAL.Component) => {
          for (const property of component.getAllProperties()) if (property.getParameter('tzid') === id) property.setParameter('tzid', unique);
          for (const child of component.getAllSubcomponents()) rename(child);
        };
        rename(calendar);
      }
      for (const property of calendar.getAllProperties()) if (!['version', 'prodid', 'method'].includes(property.name) && !result.getAllProperties(property.name).some(p => JSON.stringify(p.toJSON()) === JSON.stringify(property.toJSON()))) result.addProperty(new ICAL.Property(JSON.parse(JSON.stringify(property.toJSON()))));
      for (const component of calendar.getAllSubcomponents()) {
        if (component.name === 'vtimezone') {
          const id = text(component, 'tzid'), signature = JSON.stringify(component.toJSON());
          if (zones.has(id)) continue;
          zones.set(id, signature);
        } else if (component.name === 'vevent' && !component.hasProperty('recurrence-id')) {
          const uid = text(component, 'uid');
          if (uids.has(uid)) throw new ApiError(422, 'EXPORT_UID', 'Duplicate event identities prevent a safe combined export.');
          uids.add(uid);
        }
        result.addSubcomponent(cloneComponent(component));
      }
    }
    return result.toString() + '\r\n';
  }
  return { parseCalendar, eventDetail, resolveWall, writeEvent, expandResources, canonicalICS, occurrenceDetail, writeOccurrence, splitImport, mergeExport };
}
export type IcsCodec = ReturnType<typeof createIcsCodec>;
