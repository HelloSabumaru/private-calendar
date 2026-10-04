import { useEffect, useRef } from 'react';
import { Temporal } from '@js-temporal/polyfill';

export function europeanDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}` : value;
}
function isoDate(value: string) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) return value;
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  try { return Temporal.PlainDate.from(iso).toString(); } catch { return value; }
}

export function DateField({ label, value, onChange, withTime = false, disabled = false, description }: { label: string; value: string; onChange: (value: string) => void; withTime?: boolean; disabled?: boolean; description?: string }) {
  const [date, time = '09:00:00'] = value.split('T');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.setCustomValidity(/^\d{4}-\d{2}-\d{2}$/.test(date) ? '' : 'Enter a valid date as DD/MM/YYYY.'); }, [date]);
  return <div className={withTime ? 'date-time-field' : undefined}>
    <label>{label}<input ref={input} type="text" inputMode="numeric" required aria-description={description} placeholder="DD/MM/YYYY" pattern="[0-9]{2}/[0-9]{2}/[0-9]{4}" value={europeanDate(date)} disabled={disabled} onChange={event => onChange(`${isoDate(event.target.value)}${withTime ? `T${time}` : ''}`)} /></label>
    {withTime && <label>{label} time<input type="text" inputMode="numeric" required placeholder="HH:MM" pattern="([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?" value={time.replace(/:00$/, '').length === 5 ? time.slice(0, 5) : time} disabled={disabled} onChange={event => onChange(`${date}T${event.target.value}`)} /></label>}
  </div>;
}
