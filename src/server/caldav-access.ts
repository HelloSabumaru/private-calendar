import { createHash } from 'node:crypto';
import type { EventDetail, EventDraft } from '../shared.js';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import { Diagnostics } from './diagnostics.js';
import { runICS } from './jobs.js';
import { retainResource, type CalendarEntry, type Mutation, type ResourceEntry, type ResourceLocation, type Session } from './sessions.js';
import { allowedUrl } from './transport.js';

type Change = { operationId: string };
type ExistingEvent = Change & { resourceId: string; etag: string };
export type MutationCommand =
  | (Change & { kind: 'create'; creationId: string; draft: EventDraft })
  | (Change & { kind: 'import'; creationId: string; calendarId: string; ics: string })
  | (ExistingEvent & { kind: 'update'; draft: EventDraft })
  | (ExistingEvent & { kind: 'delete' })
  | (ExistingEvent & { kind: 'update-occurrence'; recurrenceId: string; draft: EventDraft })
  | (ExistingEvent & { kind: 'delete-occurrence'; recurrenceId: string });

export type PreparedMutation =
  | { mode: 'create'; method: 'PUT'; resource: ResourceEntry; filename: string; intended: string; collision: 'compare' | 'skip' }
  | { mode: 'update'; method: 'PUT'; resource: ResourceEntry; etag: string; intended: string }
  | { mode: 'delete'; method: 'DELETE'; resource: ResourceEntry; etag: string };

type ResourceAccess = {
  calendar(session: Session, id: string): CalendarEntry;
  resource(session: Session, id: string): ResourceLocation;
  fetch(session: Session, location: ResourceLocation): Promise<ResourceEntry>;
  detail(session: Session, resource: ResourceEntry, recurrenceId?: string): Promise<EventDetail>;
};
const strongETag = (etag: string) => /^"[^"\r\n]+"$/.test(etag);
export const occurrenceId = (command: MutationCommand) =>
  command.kind === 'update-occurrence' || command.kind === 'delete-occurrence' ? command.recurrenceId : undefined;

export class CalDavAccess {
  constructor(private session: Session, private config: Config, private access: ResourceAccess, private diagnostics = new Diagnostics()) {}

  identify(command: MutationCommand): ResourceLocation {
    return this.diagnostics.check('mutation-identify', 'internal', () => this.identifyResource(command));
  }

  private identifyResource(command: MutationCommand): ResourceLocation {
    if (command.kind === 'create' || command.kind === 'import') {
      const calendarId = command.kind === 'create' ? command.draft.calendarId : command.calendarId;
      const entry = this.access.calendar(this.session, calendarId);
      if (!entry.calendar.canCreate) throw new ApiError(403, 'PERMISSION', 'This calendar does not allow creating events.');
      const url = allowedUrl(new URL(`${command.creationId}.ics`, entry.upstream.url.endsWith('/') ? entry.upstream.url : `${entry.upstream.url}/`), this.config).href;
      return { id: createHash('sha256').update(url).digest('base64url'), url, calendarId, etag: '' };
    }
    const resource = this.access.resource(this.session, command.resourceId);
    this.authorize(command, resource);
    if (!strongETag(command.etag)) throw new ApiError(428, 'ETAG_REQUIRED', 'A strong event ETag is required. Reload the event.');
    if ((command.kind === 'update' || command.kind === 'update-occurrence') && command.draft.calendarId !== resource.calendarId) {
      throw new ApiError(422, 'CALENDAR_FIXED', 'Existing events remain in their original calendar.');
    }
    return resource;
  }

  async prepare(command: MutationCommand, location: ResourceLocation, remembered?: string): Promise<PreparedMutation> {
    if (command.kind === 'create' || command.kind === 'import') {
      const resource = { ...location, ics: '' };
      const intended = remembered ?? (command.kind === 'import' ? command.ics : await this.diagnostics.run('event-serialize', 'ics-processing', () => runICS({ kind: 'write', draft: command.draft, uid: `${command.creationId}@private-calendar` })));
      // Reserve metadata before registering the pending operation.
      retainResource(this.session, resource);
      return { mode: 'create', method: 'PUT', resource, filename: `${command.creationId}.ics`, intended, collision: command.kind === 'import' ? 'skip' : 'compare' };
    }
    const resource = await this.access.fetch(this.session, location);
    if (resource.etag !== command.etag) return this.conflict(resource, occurrenceId(command));
    if (command.kind === 'delete' || command.kind === 'delete-occurrence') {
      const capabilities = await this.access.detail(this.session, resource, occurrenceId(command));
      if (!capabilities.canDelete || (command.kind === 'delete-occurrence' && !capabilities.canUpdate)) {
        throw new ApiError(422, 'DELETE_UNSUPPORTED', capabilities.deleteReason ?? 'This resource cannot be safely deleted.');
      }
    }
    if (command.kind === 'delete') return { mode: 'delete', method: 'DELETE', resource, etag: command.etag };
    const intended = remembered ?? (command.kind === 'update' ?
      await this.diagnostics.run('event-serialize', 'ics-processing', () => runICS({ kind: 'write', draft: command.draft, uid: '', original: resource.ics })) :
      await this.diagnostics.run('occurrence-serialize', 'ics-processing', () => runICS({ kind: 'occurrence', resource, recurrenceId: command.recurrenceId, draft: command.kind === 'update-occurrence' ? command.draft : undefined })));
    return { mode: 'update', method: 'PUT', resource, etag: command.etag, intended };
  }

  write(command: MutationCommand, prepared: PreparedMutation): Promise<Response> {
    return this.diagnostics.response('mutation-write', () => this.writeResource(command, prepared));
  }

  private writeResource(command: MutationCommand, prepared: PreparedMutation): Promise<Response> {
    this.authorize(command, prepared.resource);
    if (prepared.mode === 'create') return this.session.client.createCalendarObject({
      calendar: this.access.calendar(this.session, prepared.resource.calendarId).upstream,
      filename: prepared.filename, iCalString: prepared.intended, headers: { 'If-None-Match': '*' },
    });
    const calendarObject = { url: prepared.resource.url, etag: prepared.etag };
    return prepared.mode === 'delete' ? this.session.client.deleteCalendarObject({ calendarObject }) :
      this.session.client.updateCalendarObject({ calendarObject: { ...calendarObject, data: prepared.intended } });
  }

  inspect(operation: Mutation) {
    return this.diagnostics.inspect(async () => {
      const resource = this.access.resource(this.session, operation.resourceId);
      if (resource.url !== operation.url) throw new ApiError(404, 'EVENT_MISSING', 'This event is no longer available.');
      return this.session.fetch(resource.url, { method: 'GET' });
    }, operation.method === 'DELETE');
  }

  async conflict(resource: ResourceEntry, recurrenceId?: string): Promise<never> {
    const latest = await this.access.fetch(this.session, resource);
    throw new ApiError(409, 'CONFLICT', 'This event changed on the server. Review the latest version before saving.', {
      latest: await this.access.detail(this.session, latest, recurrenceId),
    });
  }

  private authorize(command: MutationCommand, resource: ResourceLocation) {
    const { calendar } = this.access.calendar(this.session, resource.calendarId);
    const permitted = command.kind === 'create' || command.kind === 'import' ? calendar.canCreate :
      command.kind === 'delete' ? calendar.canDelete : calendar.canUpdate;
    if (!permitted) throw new ApiError(403, 'PERMISSION', 'This calendar does not allow this change.');
  }
}
