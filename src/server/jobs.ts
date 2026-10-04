import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { EventDetail, EventDraft, ImportEvent, Occurrence } from '../shared.js';
import type { Resource } from './ics.js';
import { ApiError } from './errors.js';

export type IcsJob = { kind: 'expand'; resources: Resource[]; start: string; end: string; timezone: string } |
  { kind: 'detail'; resource: Resource; recurrenceId?: string } | { kind: 'write'; draft: EventDraft; uid: string; original?: string } | { kind: 'canonical'; ics: string } | { kind: 'occurrence'; resource: Resource; recurrenceId: string; draft?: EventDraft } | { kind: 'import'; ics: string } | { kind: 'export'; documents: string[] };
type Result<J extends IcsJob> = J extends { kind: 'expand' } ? { occurrences: Occurrence[]; warnings: string[] } : J extends { kind: 'detail' } ? EventDetail : J extends { kind: 'import' } ? ImportEvent[] : string;
let active = 0;
const workers = new Set<Worker>();

export async function runICS<J extends IcsJob>(job: J): Promise<Result<J>> {
  if (active >= 4) throw new ApiError(503, 'BUSY', 'Calendar processing is busy. Try again shortly.', { retryable: true });
  active++;
  const compiled = new URL('./ics-worker.js', import.meta.url);
  const options = { workerData: job, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } };
  const worker = existsSync(compiled) ? new Worker(compiled, options) :
    new Worker(`require('tsx/cjs/api').register();require(${JSON.stringify(fileURLToPath(new URL('./ics-worker.ts', import.meta.url)))});`, { ...options, eval: true });
  workers.add(worker);
  try {
    return await new Promise<Result<J>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new ApiError(422, 'ICS_LIMIT', 'Calendar processing exceeded its time limit.')), 7000);
      worker.once('message', ({ result, error }) => { clearTimeout(timeout); if (error) reject(new ApiError(error.status, error.code, error.message)); else resolve(result); });
      worker.once('error', () => { clearTimeout(timeout); reject(new ApiError(502, 'ICS_WORKER', 'Calendar processing failed.')); });
      worker.once('exit', () => { clearTimeout(timeout); reject(new ApiError(502, 'ICS_WORKER', 'Calendar processing stopped.')); });
    });
  } finally { await worker.terminate(); workers.delete(worker); active--; }
}
export async function stopWorkers() { await Promise.all([...workers].map(worker => worker.terminate())); }
