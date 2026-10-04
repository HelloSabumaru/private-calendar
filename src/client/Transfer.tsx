import { useEffect, useState } from 'react';
import type { Calendar, ImportEvent, Operation } from '../shared';
import { api, errorMessage, RequestError } from './api';
import { Dialog } from './Dialog';

export function downloadICS(ics: string, name: string) {
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = `${name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 100) || 'calendar'}.ics`;
  link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type Item = ImportEvent & { key: string; operation?: Operation; error?: string };
export function Transfer({ mode, calendars, suspended, onChanged, onClose }: { mode: 'import' | 'export'; calendars: Calendar[]; suspended: boolean; onChanged: () => void; onClose: () => void }) {
  const choices = calendars.filter(c => mode === 'export' || c.canCreate);
  const [calendarId, setCalendarId] = useState(choices[0]?.id ?? '');
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = items.some(item => item.operation && ['pending', 'uncertain'].includes(item.operation.state));
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (busy || pending) event.preventDefault(); };
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard);
  }, [busy, pending]);
  const started = items.some(item => item.operation);
  const update = (key: string, changes: Partial<Item>) => setItems(previous => previous.map(item => item.key === key ? { ...item, ...changes } : item));
  async function preview(file?: File) {
    if (!file) return;
    setItems([]); setError(''); setBusy(true);
    try {
      if (file.size > 200000) throw new Error('Choose an ICS file smaller than 200 kB.');
      const result = await api<ImportEvent[]>('/import/preview', { method: 'POST', body: JSON.stringify({ ics: await file.text() }) });
      setItems(result.map(item => ({ ...item, key: crypto.randomUUID() })));
    } catch (error) { setError(error instanceof Error && !(error instanceof TypeError) ? error.message : errorMessage(error)); }
    finally { setBusy(false); }
  }
  async function run() {
    setBusy(true); setError('');
    try {
      if (mode === 'export') {
        const result = await api<{ ics: string }>(`/calendars/${calendarId}/export`);
        downloadICS(result.ics, calendars.find(c => c.id === calendarId)?.name ?? 'calendar');
        onClose(); return;
      }
      for (const item of items) {
        if (item.operation?.state === 'success') continue;
        try {
          let operation = item.operation;
          if (operation && ['pending', 'uncertain'].includes(operation.state)) {
            try { operation = await api<Operation>(`/operations/${operation.id}`); } catch (error) { if (error instanceof RequestError && error.status === 404) operation = undefined; else throw error; }
            update(item.key, { operation });
            if (operation && ['pending', 'uncertain'].includes(operation.state)) break;
            if (operation?.state === 'success') { onChanged(); continue; }
          }
          const id = operation?.id ?? item.key;
          update(item.key, { operation: { id, state: 'pending' }, error: undefined });
          operation = await api<Operation>('/import', { method: 'POST', headers: { 'Idempotency-Key': id }, body: JSON.stringify({ calendarId, ics: item.ics }) });
          update(item.key, { operation, error: operation.error });
          if (operation.state === 'success') onChanged();
          else break;
        } catch (error) {
          update(item.key, { error: errorMessage(error), operation: { id: item.operation?.id ?? item.key, state: error instanceof RequestError && error.status < 500 ? 'failed' : 'uncertain' } });
          break;
        }
      }
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  if (suspended) return null;
  return <Dialog title={mode === 'import' ? 'Import ICS' : 'Export calendar'} onClose={() => { if (!busy && !pending) onClose(); else setError('Check the pending import before closing.'); }}>
    {error && <p className="notice" role="alert">{error}</p>}
    <label>Calendar<select value={calendarId} disabled={busy || started} onChange={event => setCalendarId(event.target.value)}>{choices.map(calendar => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}</select></label>
    {mode === 'import' && <>
      <label>ICS file<input type="file" accept=".ics,text/calendar" disabled={busy || started} onChange={event => { void preview(event.target.files?.[0]); }} /></label>
      {!!items.length && <ul className="import-list">{items.map(item => <li key={item.key}><span>{item.title}</span><span className="muted">{item.operation?.state === 'success' ? item.operation.skipped ? 'Already exists' : 'Imported' : item.error ?? (item.operation?.state === 'pending' ? 'Pending' : item.operation?.state === 'uncertain' ? 'Checking…' : '')}</span></li>)}</ul>}
    </>}
    <div className="dialog-actions"><button className="primary" disabled={busy || !calendarId || mode === 'import' && (!items.length || items.every(item => item.operation?.state === 'success'))} onClick={() => { void run(); }}>{busy ? 'Working…' : mode === 'export' ? 'Download' : pending ? 'Check status' : 'Import'}</button><button disabled={busy || pending} onClick={onClose}>Done</button></div>
  </Dialog>;
}
