import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { ApiError } from './errors.js';

export type ProcessingStep = 'request' | 'session-guard' | 'response-serialize' | 'login' | 'discovery' |
  'calendar-range' | 'range-expand' | 'resource-read' | 'event-detail' | 'mutation-identify' |
  'mutation-prepare' | 'mutation-write' | 'event-serialize' | 'occurrence-serialize' |
  'reconciliation-read' | 'reconciliation-canonical-actual' | 'reconciliation-canonical-intended' |
  'import-parse' | 'export-read' | 'export-serialize';
type FailureCategory = 'authentication' | 'authorization' | 'validation' | 'conflict' | 'not-found' |
  'capacity' | 'timeout' | 'cancelled' | 'destination' | 'upstream-response' | 'upstream-transport' |
  'ics-processing' | 'internal';
type FailureHint = 'upstream-transport' | 'ics-processing' | 'internal';
type Failure = { step: ProcessingStep; durationMs: number; failureCategory: FailureCategory; status?: number };

const validOperation = (value: string) => z.uuid().safeParse(value).success;
const duration = (started: number) => Math.max(0, Math.round((performance.now() - started) * 100) / 100);
const statusCategory = (status: number): FailureCategory => status === 401 ? 'authentication' : status === 403 ? 'authorization' :
  status === 404 ? 'not-found' : status === 409 || status === 412 ? 'conflict' : status === 429 ? 'capacity' : 'upstream-response';
function failureCategory(error: unknown, hint: FailureHint): FailureCategory {
  if (error instanceof z.ZodError) return 'validation';
  if (error instanceof ApiError) {
    if (['DESTINATION', 'REDIRECT', 'RESOURCE_PATH'].includes(error.code)) return 'destination';
    if (error.code.startsWith('ICS_') || ['RECURRENCE', 'IMPORT_INVALID'].includes(error.code)) return 'ics-processing';
    if (['BUSY', 'SESSION_LIMIT', 'OPERATION_LIMIT', 'RESOURCE_LOCATION_LIMIT', 'PENDING_LIMIT'].includes(error.code)) return 'capacity';
    if (hint === 'ics-processing') return 'ics-processing';
    if (error.status === 400 || error.status === 422 || error.status === 428) return 'validation';
    return statusCategory(error.status);
  }
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
  const status = errorStatus(error);
  if (status === 429) return 'capacity';
  if (status === 400 || status === 413 || status === 415) return 'validation';
  return hint;
}
function errorStatus(error: unknown) {
  const status = error instanceof ApiError ? error.status : error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
}

// Each request owns its context; sessions never retain request loggers or errors.
export class Diagnostics {
  private operationId?: string;
  private failures = new WeakMap<object, Failure>();
  private primitiveFailures = new Map<unknown, Failure>();
  private responses = new WeakMap<Response, { step: ProcessingStep; durationMs: number }>();
  private started = performance.now();
  constructor(private logger?: Pick<FastifyBaseLogger, 'warn'>) {}

  operation(id: string) { if (validOperation(id)) this.operationId = id; return this; }

  check<T>(step: ProcessingStep, hint: FailureHint, work: () => T): T {
    const started = performance.now();
    try { return work(); } catch (error) { this.remember(error, step, hint, started); throw error; }
  }

  async run<T>(step: ProcessingStep, hint: FailureHint, work: () => T | Promise<T>): Promise<T> {
    const started = performance.now();
    try { return await work(); } catch (error) { this.remember(error, step, hint, started); throw error; }
  }

  async response(step: ProcessingStep, work: () => Promise<Response>) {
    const started = performance.now();
    const response = await this.run(step, 'upstream-transport', work);
    this.responses.set(response, { step, durationMs: duration(started) });
    return response;
  }

  async inspect(work: () => Promise<Response>, missingMeansSuccess = false) {
    const response = await this.response('reconciliation-read', work);
    if (!response.ok && !(missingMeansSuccess && response.status === 404)) this.failResponse(response);
    return response;
  }

  failResponse(response: Response) { this.report(this.responseFailure(response)); }
  rejectResponse(response: Response, error: Error): never { this.failures.set(error, this.responseFailure(response)); throw error; }

  fail(error: unknown, step: ProcessingStep = 'request', hint: FailureHint = 'internal') {
    const retained = error && typeof error === 'object' ? this.failures.get(error) : this.primitiveFailures.get(error);
    this.report(retained ?? { step, durationMs: duration(this.started), failureCategory: failureCategory(error, hint), status: errorStatus(error) });
  }

  private remember(error: unknown, step: ProcessingStep, hint: FailureHint, started: number) {
    const failure = { step, durationMs: duration(started), failureCategory: failureCategory(error, hint), status: errorStatus(error) };
    if (error && typeof error === 'object') { if (!this.failures.has(error)) this.failures.set(error, failure); }
    else if (!this.primitiveFailures.has(error)) this.primitiveFailures.set(error, failure);
  }
  private report(failure: Failure) {
    this.logger?.warn({ ...failure, ...(this.operationId ? { operationId: this.operationId } : {}) }, 'Calendar processing failed');
  }
  private responseFailure(response: Response): Failure {
    return { ...(this.responses.get(response) ?? { step: 'request', durationMs: duration(this.started) }), failureCategory: statusCategory(response.status), status: response.status };
  }
}

export function safeError(error: unknown) { return { type: 'Error', message: 'Calendar processing failed', stack: '', failureCategory: failureCategory(error, 'internal'), status: errorStatus(error) }; }
export function safeMethod(method: unknown) { return typeof method === 'string' && ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS'].includes(method) ? method : 'OTHER'; }
