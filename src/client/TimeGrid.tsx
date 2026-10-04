import { useEffect, useMemo, useRef, type CSSProperties, type DragEvent } from 'react';
import type { Occurrence } from '../shared';
import { addDays, dateLabel, timeLabel, type DayEvents, type TimedEvent } from './dates';

const hourHeight = 88;
function layout(events: readonly TimedEvent[]) {
  const slots = events.map(event => ({ ...event, lane: 0, lanes: 1 })).sort((a, b) => a.start - b.start || b.end - a.end);
  let group: typeof slots = [], ends: number[] = [];
  const finish = () => { for (const slot of group) slot.lanes = ends.length; group = []; ends = []; };
  for (const slot of slots) {
    if (group.length && ends.every(end => end <= slot.start)) finish();
    let lane = ends.findIndex(end => end <= slot.start);
    if (lane === -1) lane = ends.length;
    ends[lane] = Math.max(slot.end, slot.start + 15); slot.lane = lane; group.push(slot);
  }
  finish(); return slots;
}
export function TimeGrid({ dates, activeDate, eventDays, timezone, hour12, colorStyle, onOpen, onAdd, onDrop, onDay }: { dates: string[]; activeDate: string; eventDays: ReadonlyMap<string, DayEvents>; timezone: string; hour12: boolean; colorStyle: (calendarId: string) => CSSProperties; onOpen: (event: Occurrence) => void; onAdd: (date: string, time?: string) => void; onDrop: (eventId: string, date: string, time?: string) => void; onDay: (date: string) => void }) {
  const scroll = useRef<HTMLDivElement>(null);
  const first = dates[0];
  const dateKey = dates.join(',');
  const timedEvents = useMemo(() => new Map(dates.map(date => [date, layout(eventDays.get(date)?.timed ?? [])])), [dateKey, eventDays]);
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    element.scrollTop = 8 * hourHeight;
    const align = () => { element.scrollLeft = Math.max(0, dates.indexOf(activeDate)) * (element.scrollWidth - 56) / dates.length; };
    align(); const observer = new ResizeObserver(align); observer.observe(element);
    return () => observer.disconnect();
  }, [first, activeDate, dateKey]);
  const drag = (event: DragEvent, item: Occurrence) => { event.dataTransfer.setData('application/x-calendar-event', item.id); event.dataTransfer.effectAllowed = 'move'; };
  const drop = (event: DragEvent, date: string, time?: string) => { event.preventDefault(); const id = event.dataTransfer.getData('application/x-calendar-event'); if (id) onDrop(id, date, time); };
  return <section className="time-grid-scroll" ref={scroll} aria-label={dates.length === 1 ? 'Day calendar' : 'Week calendar'}>
    <div className="time-grid" style={{ '--day-count': dates.length } as CSSProperties}>
      <div className="time-grid-header"><span className="time-label">All-day</span>{dates.map(date => <div className="time-day-head" key={date} onDragOver={event => event.preventDefault()} onDrop={event => drop(event, date)}>
        <button className="time-day-name" onClick={() => onDay(date)}>{dateLabel(date)}</button>
        {eventDays.get(date)?.allDay.map(event => <button key={event.id} className="event-chip" style={colorStyle(event.calendarId)} draggable onDragStart={e => drag(e, event)} onClick={() => onOpen(event)}>{event.title}</button>)}
        <button className="all-day-add" aria-label={`New all-day event on ${dateLabel(date)}`} onClick={() => onAdd(date)}>+</button>
      </div>)}</div>
      <div className="time-grid-body"><div className="time-axis">{Array.from({ length: 24 }, (_, hour) => <span key={hour} style={{ top: hour * hourHeight }}>{timeLabel(`${first}T${String(hour).padStart(2, '0')}:00:00Z`, 'UTC', hour12)}</span>)}</div>
        {dates.map(date => <div key={date} className="time-column">
          {Array.from({ length: 48 }, (_, index) => { const time = `${String(Math.floor(index / 2)).padStart(2, '0')}:${index % 2 ? '30' : '00'}`; return <button key={index} className={`time-slot ${index % 2 ? 'half-hour' : ''}`} aria-label={`New event on ${dateLabel(date)} at ${time}`} onClick={() => onAdd(date, time)} onDragOver={event => event.preventDefault()} onDrop={event => drop(event, date, time)} />; })}
          {timedEvents.get(date)?.map(({ event, start, end, lane, lanes }) => <button key={event.id} className="timed-event event-chip" style={{ ...colorStyle(event.calendarId), top: start / 60 * hourHeight, height: Math.max(24, (end - start) / 60 * hourHeight), left: `${lane / lanes * 100}%`, width: `${100 / lanes}%` }} draggable onDragStart={e => drag(e, event)} onClick={() => onOpen(event)} title={`${event.title}, ${timeLabel(event.start, timezone, hour12)} – ${timeLabel(event.end, timezone, hour12)}`}><span>{event.title}</span><time>{timeLabel(event.start, timezone, hour12)} – {timeLabel(event.end, timezone, hour12)}</time></button>)}
        </div>)}
      </div>
    </div>
  </section>;
}
export const weekDates = (start: string) => Array.from({ length: 7 }, (_, index) => addDays(start, index));
