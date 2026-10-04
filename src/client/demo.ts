import { Temporal } from '@js-temporal/polyfill';
import type { DemoResponse } from './demo-state';

let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<number, { resolve: (response: DemoResponse) => void; reject: (error: unknown) => void }>();

function calendarWorker() {
  if (!worker) {
    worker = new Worker(new URL('./demo-worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent<{ id: number; response: DemoResponse }>) => {
      pending.get(event.data.id)?.resolve(event.data.response);
    });
    worker.addEventListener('error', () => {
      worker?.terminate(); worker = undefined;
      for (const request of pending.values()) request.reject(new Error('The demo could not load. Reload to try again.'));
    });
  }
  return worker;
}

export async function demoRequest(path: string, options: RequestInit): Promise<Response> {
  const signal = options.signal;
  signal?.throwIfAborted();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = Temporal.Now.plainDateISO(timezone).toString();
  const activeWorker = calendarWorker();
  const id = ++sequence;
  const response = await new Promise<DemoResponse>((resolve, reject) => {
    const finish = () => { pending.delete(id); signal?.removeEventListener('abort', abort); };
    const abort = () => { finish(); reject(signal?.reason); };
    pending.set(id, { resolve: value => { finish(); resolve(value); }, reject: error => { finish(); reject(error); } });
    signal?.addEventListener('abort', abort, { once: true });
    try { activeWorker.postMessage({ id, date, timezone, request: { path, method: options.method ?? 'GET', headers: Object.fromEntries(new Headers(options.headers)), body: options.body } }); }
    catch (error) { finish(); reject(error); }
  });
  return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'Content-Type': 'application/json' } });
}
