import { parentPort, workerData } from 'node:worker_threads';
import { canonicalICS, eventDetail, expandResources, mergeExport, occurrenceDetail, splitImport, writeEvent, writeOccurrence } from './ics.js';
import { ApiError } from './errors.js';
import type { IcsJob } from './jobs.js';

try {
  const job = workerData as IcsJob;
  const result = job.kind === 'expand' ? expandResources(job.resources, job.start, job.end, job.timezone) :
    job.kind === 'detail' ? job.recurrenceId ? occurrenceDetail(job.resource, job.recurrenceId) : eventDetail(job.resource) :
    job.kind === 'write' ? writeEvent(job.draft, job.uid, job.original) : job.kind === 'occurrence' ? writeOccurrence(job.resource, job.recurrenceId, job.draft) :
    job.kind === 'import' ? splitImport(job.ics) : job.kind === 'export' ? mergeExport(job.documents) : canonicalICS(job.ics);
  parentPort!.postMessage({ result });
} catch (error) {
  parentPort!.postMessage({ error: error instanceof ApiError ? { status: error.status, code: error.code, message: error.message } : { status: 422, code: 'ICS_INVALID', message: 'The event contains invalid or unsupported calendar data.' } });
}
