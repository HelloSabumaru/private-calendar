import { createHash } from 'node:crypto';
import { DAVClient } from 'tsdav';
import type { Calendar, EventDraft, Login } from '../shared.js';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import { allowedUrl, createTransport } from './transport.js';
import { opaque, discardResource, retainOperation, retainResource, type CalendarEntry, type Mutation, type ResourceEntry, type Session } from './sessions.js';
import { runICS } from './jobs.js';

const hash = (input: string) => createHash('sha256').update(input).digest('base64url');
const strongETag = (etag: string) => /^"[^"\r\n]+"$/.test(etag);

export async function authenticate(config: Config, login: Login, baseFetch: typeof fetch = fetch): Promise<Session> {
  const isBasic = login.method === 'basic';
  const abort = new AbortController();
  const transport = createTransport(config, baseFetch);
  const guardedFetch: typeof fetch = async (input, init) => {
    const response = await transport(input, { ...init, signal: AbortSignal.any([abort.signal, ...(init?.signal ? [init.signal] : [])]) });
    if (response.status === 401) throw new ApiError(401, 'UPSTREAM_AUTH', 'The CalDAV server rejected your credentials. Sign in again.');
    return response;
  };
  const client = new DAVClient({ serverUrl: config.CALDAV_URL, defaultAccountType: 'caldav',
    authMethod: login.method === 'basic' ? 'Basic' : 'Bearer',
    credentials: login.method === 'basic' ? { username: login.username, password: login.password } : { accessToken: login.token }, fetch: guardedFetch });
  try {
    await client.login();
    const authorizedFetch: typeof fetch = (input, init) => guardedFetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)),
      Authorization: isBasic ? `Basic ${Buffer.from(`${client.credentials.username}:${client.credentials.password}`).toString('base64')}` : `Bearer ${client.credentials.accessToken}` } });
    const now = Date.now();
    const session: Session = { id: opaque(), csrf: opaque(), accountKey: hash(`${config.CALDAV_URL}\0${client.account?.principalUrl ?? (login.method === 'basic' ? login.username : 'token-user')}`),
      client, fetch: authorizedFetch, abort, created: now, touched: now, calendars: new Map(), resources: new Map(), operations: new Map(), locks: new Set(), cacheBytes: 0 };
    await discover(session, config);
    return session;
  } catch (error) { abort.abort(); client.credentials = {}; throw error; }
}

function privilegeNames(value: unknown): Set<string> {
  const names = new Set<string>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    for (const [key, child] of Object.entries(node)) { names.add(key.replace(/^.*:/, '')); visit(child); }
  };
  visit(value); return names;
}

export async function discover(session: Session, config: Config): Promise<Calendar[]> {
  const calendars = await session.client.fetchCalendars({ props: {
    'd:displayname': {}, 'ca:calendar-color': {}, 'c:calendar-timezone': {}, 'd:current-user-privilege-set': {},
    'd:resourcetype': {}, 'c:supported-calendar-component-set': {},
  }, projectedProps: { currentUserPrivilegeSet: true } });
  if (calendars.length > 256) throw new ApiError(502, 'CALENDAR_LIMIT', 'Too many calendars were returned.');
  const entries = new Map<string, CalendarEntry>();
  for (const upstream of calendars) {
    upstream.url = allowedUrl(upstream.url, config).href;
    if (upstream.components?.length && !upstream.components.includes('VEVENT')) continue;
    const privileges = privilegeNames(upstream.projectedProps?.currentUserPrivilegeSet);
    const all = privileges.has('all'), write = all || privileges.has('write');
    const id = hash(upstream.url);
    const calendar: Calendar = { id, name: typeof upstream.displayName === 'string' ? upstream.displayName : 'Calendar',
      color: /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(upstream.calendarColor ?? '') ? upstream.calendarColor!.slice(0, 7) : '#27775c',
      canCreate: write || privileges.has('bind'), canUpdate: write || privileges.has('write-content') || privileges.has('writeContent'),
      canDelete: write || privileges.has('unbind') };
    entries.set(id, { calendar, upstream });
  }
  session.calendars = entries;
  for (const [id, entry] of session.resources) if (!entries.has(entry.calendarId)) discardResource(session, id);
  return [...entries.values()].map(entry => entry.calendar);
}

export function getCalendar(session: Session, id: string) {
  const entry = session.calendars.get(id);
  if (!entry) throw new ApiError(404, 'CALENDAR_MISSING', 'This calendar is no longer available.');
  return entry;
}
export function getResource(session: Session, id: string) {
  const entry = session.resources.get(id);
  if (!entry) throw new ApiError(404, 'EVENT_MISSING', 'Refresh the calendar to access this event.');
  getCalendar(session, entry.calendarId);
  return entry;
}

export async function readRange(session: Session, config: Config, calendarIds: string[], start: string, end: string, timezone: string) {
  const resources: ResourceEntry[] = []; const warnings: string[] = [];
  let resourceBytes = 0;
  // Padding includes floating dates interpreted by servers in a different local timezone.
  const timeRange = { start: new Date(Date.parse(start) - 36 * 3600000).toISOString(), end: new Date(Date.parse(end) + 36 * 3600000).toISOString() };
  for (const id of calendarIds) {
    const entry = getCalendar(session, id);
    try {
      const objects = await session.client.fetchCalendarObjects({ calendar: entry.upstream, timeRange, expand: false, urlFilter: () => true });
      if (resources.length + objects.length > 2000) throw new ApiError(502, 'RESOURCE_LIMIT', 'The range contains too many calendar resources.');
      for (const object of objects) {
        const url = allowedUrl(object.url, config).href;
        if (!url.startsWith(entry.upstream.url.endsWith('/') ? entry.upstream.url : `${entry.upstream.url}/`)) throw new ApiError(502, 'RESOURCE_PATH', 'An event is outside its calendar collection.');
        if (typeof object.data !== 'string') throw new ApiError(502, 'ICS_INVALID', 'The server returned invalid calendar data.');
        const resource = { id: hash(url), calendarId: id, etag: object.etag ?? '', ics: object.data, url };
        resourceBytes += Buffer.byteLength(resource.ics);
        if (resourceBytes > 16 * 1024 * 1024) throw new ApiError(502, 'RESOURCE_LIMIT', 'The requested events exceed the processing size limit.');
        retainResource(session, resource); resources.push(resource);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) throw error;
      warnings.push(`${entry.calendar.name}: ${error instanceof ApiError ? error.message : 'Could not refresh this calendar.'}`);
    }
  }
  const result = await runICS({ kind: 'expand', resources, start, end, timezone });
  const eventWarnings = result.warnings.map(warning => {
    const resource = resources.find(r => warning.startsWith(`${r.id}:`));
    return resource ? `${getCalendar(session, resource.calendarId).calendar.name}${warning.slice(resource.id.length)}` : warning;
  });
  return { ...result, warnings: [...warnings, ...eventWarnings], refreshedAt: new Date().toISOString(), complete: warnings.length === 0 && result.warnings.length === 0 };
}

export async function fetchResource(session: Session, resource: ResourceEntry): Promise<ResourceEntry> {
  const response = await session.fetch(resource.url, { method: 'GET' });
  if (response.status === 404) throw new ApiError(404, 'EVENT_MISSING', 'This event was deleted on the server.');
  if (response.status === 403) throw new ApiError(403, 'PERMISSION', 'The server denied access to this event.');
  if (!response.ok) throw new ApiError(502, 'UPSTREAM', 'The CalDAV server could not read this event.', { retryable: true });
  const latest = { ...resource, ics: await response.text(), etag: response.headers.get('etag') ?? '' };
  retainResource(session, latest); return latest;
}

export async function detail(session: Session, resource: ResourceEntry, recurrenceId?: string) {
  const result = await runICS({ kind: 'detail', resource, recurrenceId });
  const { calendar } = getCalendar(session, resource.calendarId);
  return { ...result, canUpdate: result.canUpdate && calendar.canUpdate && strongETag(resource.etag), canDelete: result.canDelete && (recurrenceId ? calendar.canUpdate : calendar.canDelete) && strongETag(resource.etag) };
}

async function conflict(session: Session, resource: ResourceEntry, recurrenceId?: string) {
  const latest = await fetchResource(session, resource);
  throw new ApiError(409, 'CONFLICT', 'This event changed on the server. Review the latest version before saving.', { latest: await detail(session, latest, recurrenceId) });
}

export async function reconcile(session: Session, operation: Mutation) {
  if (operation.state !== 'uncertain') return;
  try {
    const response = await session.fetch(operation.url, { method: 'GET' });
    if (response.status === 404) {
      operation.state = operation.method === 'DELETE' ? 'success' : 'failed';
      operation.error = operation.method === 'PUT' ? 'The event was not found. Retry the same draft to resolve the write safely.' : undefined;
    } else if (response.ok && operation.method === 'PUT') {
      const actual = await runICS({ kind: 'canonical', ics: await response.text() });
      const intended = await runICS({ kind: 'canonical', ics: operation.intended! });
      operation.state = actual === intended ? 'success' : 'failed';
      operation.error = actual === intended ? undefined : 'The server contains a different version. Reload and review before retrying.';
    } else if (response.ok && operation.method === 'DELETE') {
      operation.state = 'failed'; operation.error = 'The event still exists. Reload it before retrying deletion.';
    }
  } catch { /* Keep uncertain until the upstream can be inspected. */ }
}

export async function mutate(session: Session, config: Config, operationId: string, kind: 'create' | 'update' | 'delete', draft?: EventDraft, resourceId?: string, etag?: string, creationId = operationId, extension: { recurrenceId?: string; ics?: string; calendarId?: string } = {}) {
  const fingerprint = hash(JSON.stringify({ kind, draft, resourceId, etag, creationId, extension }));
  const previous = session.operations.get(operationId);
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new ApiError(409, 'OPERATION_REUSED', 'Use a new operation identifier for a changed draft.');
    await previous.running; await reconcile(session, previous);
    if (previous.state !== 'failed') return publicOperation(previous);
    session.operations.delete(operationId);
  }
  if (session.operations.size >= 200) {
    for (const [id, op] of session.operations) if (op.state === 'success' || op.state === 'failed') { session.operations.delete(id); break; }
    if (session.operations.size >= 200) throw new ApiError(503, 'OPERATION_LIMIT', 'Resolve pending changes before making more changes.');
  }
  let resource: ResourceEntry;
  if (kind === 'create') {
    const entry = getCalendar(session, draft?.calendarId ?? extension.calendarId!);
    if (!entry.calendar.canCreate) throw new ApiError(403, 'PERMISSION', 'This calendar does not allow creating events.');
    const url = allowedUrl(new URL(`${creationId}.ics`, entry.upstream.url.endsWith('/') ? entry.upstream.url : `${entry.upstream.url}/`), config).href;
    resource = { id: hash(url), url, calendarId: draft?.calendarId ?? extension.calendarId!, ics: '', etag: '' };
  } else {
    resource = getResource(session, resourceId!);
    const entry = getCalendar(session, resource.calendarId);
    if (!(kind === 'delete' && !extension.recurrenceId ? entry.calendar.canDelete : entry.calendar.canUpdate)) throw new ApiError(403, 'PERMISSION', 'This calendar does not allow this change.');
    if (!etag || !strongETag(etag)) throw new ApiError(428, 'ETAG_REQUIRED', 'A strong event ETag is required. Reload the event.');
    resource = await fetchResource(session, resource);
    if (resource.etag !== etag) return conflict(session, resource, extension.recurrenceId);
    const capabilities = await detail(session, resource, extension.recurrenceId);
    if (kind === 'delete' && !(extension.recurrenceId ? capabilities.canUpdate && capabilities.canDelete : capabilities.canDelete)) throw new ApiError(422, 'DELETE_UNSUPPORTED', capabilities.deleteReason ?? 'This resource cannot be safely deleted.');
    if (draft && draft.calendarId !== resource.calendarId) throw new ApiError(422, 'CALENDAR_FIXED', 'Existing events remain in their original calendar.');
  }
  if (session.locks.has(resource.id)) throw new ApiError(409, 'EVENT_BUSY', 'A change to this event is already pending.');
  // Keep an uncertain operation locked until reconciliation has completed.
  for (const op of session.operations.values()) if (op.resourceId === resource.id && ['pending', 'uncertain'].includes(op.state)) throw new ApiError(409, 'EVENT_BUSY', 'Resolve the pending change before editing this event.');
  session.locks.add(resource.id);
  try {
    const deletingResource = kind === 'delete' && !extension.recurrenceId;
    const intended = deletingResource ? undefined : previous?.intended ?? (extension.recurrenceId ? await runICS({ kind: 'occurrence', resource, recurrenceId: extension.recurrenceId, draft: kind === 'delete' ? undefined : draft }) : extension.ics ?? await runICS({ kind: 'write', draft: draft!, uid: `${creationId}@private-calendar`, original: kind === 'update' ? resource.ics : undefined }));
    const operation: Mutation = { id: operationId, fingerprint, state: 'pending', resourceId: resource.id, url: resource.url,
      method: deletingResource ? 'DELETE' : 'PUT', intended, etag };
    retainOperation(session, operation);
    retainResource(session, resource);
    operation.running = (async () => {
      try {
        const response = kind === 'create' ? await session.client.createCalendarObject({ calendar: getCalendar(session, resource.calendarId).upstream,
          filename: `${creationId}.ics`, iCalString: intended!, headers: { 'If-None-Match': '*' } }) :
          !deletingResource ? await session.client.updateCalendarObject({ calendarObject: { url: resource.url, etag, data: intended! } }) :
            await session.client.deleteCalendarObject({ calendarObject: { url: resource.url, etag } });
        if (response.status === 412) {
          if (kind === 'create' && extension.ics) { operation.state = 'success'; operation.skipped = true; }
          else if (kind === 'create') { operation.state = 'uncertain'; await reconcile(session, operation); if (publicOperation(operation).state === 'failed') await conflict(session, resource, extension.recurrenceId); }
          else { operation.state = 'failed'; operation.error = 'This event changed on the server.'; await conflict(session, resource, extension.recurrenceId); }
        } else if (response.ok || (deletingResource && response.status === 404)) operation.state = 'success';
        else if (response.status === 403) { operation.state = 'failed'; throw new ApiError(403, 'PERMISSION', 'The server denied this change.'); }
        else if (response.status >= 500) { operation.state = 'uncertain'; await reconcile(session, operation); }
        else { operation.state = 'failed'; throw new ApiError(422, 'UPSTREAM_WRITE', 'The CalDAV server rejected this change. Your draft is retained.'); }
      } catch (error) {
        if (error instanceof ApiError && (error.status < 500 || error.code === 'DESTINATION' || error.code === 'REDIRECT')) { if (operation.state === 'pending') operation.state = 'failed'; throw error; }
        operation.state = 'uncertain'; await reconcile(session, operation);
      }
    })();
    await operation.running;
    operation.running = undefined;
    if (operation.state === 'success') operation.intended = undefined;
    return publicOperation(operation);
  } finally { session.locks.delete(resource.id); }
}
export function publicOperation(operation: Mutation) {
  return { id: operation.id, state: operation.state, resourceId: operation.resourceId, error: operation.error, skipped: operation.skipped };
}

export async function exportCalendar(session: Session, config: Config, calendarId: string) {
  const entry = getCalendar(session, calendarId);
  const objects = await session.client.fetchCalendarObjects({ calendar: entry.upstream, expand: false, urlFilter: () => true });
  if (objects.length > 2000) throw new ApiError(422, 'EXPORT_LIMIT', 'This calendar exceeds the export resource limit.');
  let bytes = 0;
  const documents = objects.map(object => {
    const url = allowedUrl(object.url, config).href;
    if (!url.startsWith(entry.upstream.url.endsWith('/') ? entry.upstream.url : `${entry.upstream.url}/`) || typeof object.data !== 'string') throw new ApiError(502, 'RESOURCE_PATH', 'The server returned invalid calendar resources.');
    bytes += Buffer.byteLength(object.data);
    if (bytes > 16 * 1024 * 1024) throw new ApiError(422, 'EXPORT_LIMIT', 'This calendar exceeds the export size limit.');
    return object.data;
  });
  return { ics: await runICS({ kind: 'export', documents }) };
}
export async function importEvent(session: Session, config: Config, operationId: string, calendarId: string, ics: string) {
  const entries = await runICS({ kind: 'import', ics });
  if (entries.length !== 1) throw new ApiError(422, 'IMPORT_INVALID', 'Import one event series per operation.');
  const digest = createHash('sha256').update(entries[0].uid).digest('hex');
  const identity = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return mutate(session, config, operationId, 'create', undefined, undefined, undefined, identity, { calendarId, ics: entries[0].ics });
}
