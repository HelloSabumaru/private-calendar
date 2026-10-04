import { createHash } from 'node:crypto';
import type { Operation } from '../shared.js';
import { CalDavAccess, occurrenceId, type MutationCommand, type PreparedMutation } from './caldav-access.js';
import { ApiError } from './errors.js';
import { Diagnostics } from './diagnostics.js';
import { discardResource, retainOperation, type Mutation, type ResourceLocation, type Session } from './sessions.js';

const trackers = new WeakMap<Session, OperationTracker>();
export function operationTracker(session: Session) {
  let tracker = trackers.get(session);
  if (!tracker) { tracker = new OperationTracker(session); trackers.set(session, tracker); }
  return tracker;
}
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, ordered(child)]));
  return value;
}
export function publicOperation(operation: Mutation): Operation {
  return { id: operation.id, state: operation.state, resourceId: operation.resourceId, error: operation.error, skipped: operation.skipped };
}

export class OperationTracker {
  private requests = new Map<string, { fingerprint: string; running: Promise<Operation> }>();
  private inspections = new Map<string, Promise<void>>();
  constructor(private session: Session) {}

  confirmAbsence(resource: ResourceLocation) {
    for (const operation of this.session.operations.values()) {
      if (operation.state === 'uncertain' && operation.method === 'DELETE' && operation.resourceId === resource.id &&
          operation.calendarId === resource.calendarId && operation.url === resource.url) this.succeed(operation);
    }
    discardResource(this.session, resource.id);
  }

  run(command: MutationCommand, access: CalDavAccess, diagnostics = new Diagnostics()): Promise<Operation> {
    if (this.session.abort.signal.aborted) return Promise.reject(new ApiError(401, 'SESSION_EXPIRED', 'Your session ended. Sign in again.'));
    const fingerprint = createHash('sha256').update(JSON.stringify(ordered(command))).digest('base64url');
    const existing = this.requests.get(command.operationId) ?? this.session.operations.get(command.operationId);
    if (existing && existing.fingerprint !== fingerprint) return Promise.reject(new ApiError(409, 'OPERATION_REUSED', 'Use a new operation identifier for a changed draft.'));
    const request = this.requests.get(command.operationId);
    if (request) return request.running;
    try { this.reserve(command.operationId); } catch (error) { return Promise.reject(error); }
    // Claim the key before any asynchronous resource loading or ICS preparation.
    const running = Promise.resolve().then(() => this.execute(command, fingerprint, access, diagnostics)).finally(() => this.requests.delete(command.operationId));
    this.requests.set(command.operationId, { fingerprint, running });
    return running;
  }

  reconcile(operation: Mutation, access: CalDavAccess, diagnostics = new Diagnostics()): Promise<void> {
    if (operation.state !== 'uncertain') return Promise.resolve();
    const inspection = this.inspections.get(operation.id);
    if (inspection) return inspection;
    const running = this.inspect(operation, access, diagnostics).finally(() => this.inspections.delete(operation.id));
    this.inspections.set(operation.id, running);
    return running;
  }

  private reserve(operationId: string) {
    if (this.session.operations.has(operationId)) return;
    const retained = () => new Set([...this.session.operations.keys(), ...this.requests.keys()]).size;
    if (retained() >= 200) {
      for (const [id, operation] of this.session.operations) {
        if (!this.requests.has(id) && (operation.state === 'success' || operation.state === 'failed')) { this.session.operations.delete(id); break; }
      }
    }
    if (retained() >= 200) throw new ApiError(503, 'OPERATION_LIMIT', 'Resolve pending changes before making more changes.');
  }

  private async execute(command: MutationCommand, fingerprint: string, access: CalDavAccess, diagnostics: Diagnostics) {
    const previous = this.session.operations.get(command.operationId);
    if (previous) {
      await previous.running;
      await this.reconcile(previous, access, diagnostics);
      if (previous.state !== 'failed') return publicOperation(previous);
    }
    const resource = access.identify(command);
    if (this.session.locks.has(resource.id)) throw new ApiError(409, 'EVENT_BUSY', 'A change to this event is already pending.');
    for (const operation of this.session.operations.values()) {
      if (operation.resourceId === resource.id && (operation.state === 'pending' || operation.state === 'uncertain')) {
        throw new ApiError(409, 'EVENT_BUSY', 'Resolve the pending change before editing this event.');
      }
    }
    this.session.locks.add(resource.id);
    try {
      const prepared = await diagnostics.run('mutation-prepare', 'internal', () => access.prepare(command, resource, previous?.intended));
      const operation: Mutation = { id: command.operationId, fingerprint, state: 'pending', resourceId: resource.id, calendarId: resource.calendarId, url: resource.url,
        method: prepared.method, ...(prepared.mode === 'delete' ? { etag: prepared.etag } : { intended: prepared.intended, ...(prepared.mode === 'update' ? { etag: prepared.etag } : {}) }) };
      retainOperation(this.session, operation);
      operation.running = this.write(command, prepared, operation, access, diagnostics);
      try { await operation.running; } finally { operation.running = undefined; }
      return publicOperation(operation);
    } finally { this.session.locks.delete(resource.id); }
  }

  private async write(command: MutationCommand, prepared: PreparedMutation, operation: Mutation, access: CalDavAccess, diagnostics: Diagnostics) {
    try {
      const response = await access.write(command, prepared);
      if (response.status === 412) {
        if (prepared.mode === 'create' && prepared.collision === 'skip') { operation.skipped = true; this.succeed(operation); }
        else if (prepared.mode === 'create') {
          operation.state = 'uncertain'; await this.reconcile(operation, access, diagnostics);
          if (publicOperation(operation).state === 'failed') await access.conflict(prepared.resource, occurrenceId(command));
        } else {
          operation.state = 'failed'; operation.error = 'This event changed on the server.';
          await access.conflict(prepared.resource, occurrenceId(command));
        }
      } else if (response.ok || (prepared.mode === 'delete' && response.status === 404)) this.succeed(operation);
      else if (response.status >= 500) {
        diagnostics.failResponse(response);
        operation.state = 'uncertain'; await this.reconcile(operation, access, diagnostics);
      }
      else {
        operation.state = 'failed';
        if (response.status === 403) diagnostics.rejectResponse(response, new ApiError(403, 'PERMISSION', 'The server denied this change.'));
        diagnostics.rejectResponse(response, new ApiError(422, 'UPSTREAM_WRITE', 'The CalDAV server rejected this change. Your draft is retained.'));
      }
    } catch (error) {
      if (operation.state === 'failed' || (error instanceof ApiError && (error.status < 500 || error.code === 'DESTINATION' || error.code === 'REDIRECT'))) {
        if (operation.state === 'pending') operation.state = 'failed';
        throw error;
      }
      diagnostics.fail(error, 'mutation-write', 'upstream-transport');
      operation.state = 'uncertain'; await this.reconcile(operation, access, diagnostics);
    }
  }

  private async inspect(operation: Mutation, access: CalDavAccess, diagnostics: Diagnostics) {
    try {
      const response = await access.inspect(operation);
      if (operation.state !== 'uncertain') return;
      if (response.status === 404) {
        if (operation.method === 'DELETE') this.succeed(operation);
        else { operation.state = 'failed'; operation.error = 'The event was not found. Retry the same draft to resolve the write safely.'; }
      } else if (response.ok && operation.method === 'PUT') {
        const actual = await diagnostics.run('reconciliation-canonical-actual', 'ics-processing', async () => this.session.jobs.run({ kind: 'canonical', ics: await response.text() }));
        const intended = await diagnostics.run('reconciliation-canonical-intended', 'ics-processing', () => this.session.jobs.run({ kind: 'canonical', ics: operation.intended! }));
        if (actual === intended) this.succeed(operation);
        else { operation.state = 'failed'; operation.error = 'The server contains a different version. Reload and review before retrying.'; }
      } else if (response.ok) { operation.state = 'failed'; operation.error = 'The event still exists. Reload it before retrying deletion.'; }
    } catch (error) {
      diagnostics.fail(error, 'reconciliation-read', 'upstream-transport');
      if (error instanceof ApiError && error.status === 401) throw error;
      // Preserve uncertain writes until the authorized resource can be inspected.
    }
  }

  private succeed(operation: Mutation) {
    operation.state = 'success'; operation.error = undefined; operation.intended = undefined;
    if (operation.method === 'DELETE') discardResource(this.session, operation.resourceId);
  }
}
