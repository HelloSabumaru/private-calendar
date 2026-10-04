import { createHash } from 'node:crypto';
import { DAVClient } from 'tsdav';
import type { Calendar, Login } from '../shared.js';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import { Diagnostics } from './diagnostics.js';
import { allowedUrl, createTransport } from './transport.js';
import { opaque, discardResource, retainResource, type CalendarEntry, type Mutation, type ResourceEntry, type ResourceLocation, type Session, type SessionStore } from './sessions.js';
import { CalDavAccess, type MutationCommand } from './caldav-access.js';
import { operationTracker } from './operations.js';
export { publicOperation } from './operations.js';

const hash = (input: string) => createHash('sha256').update(input).digest('base64url');
const strongETag = (etag: string) => /^"[^"\r\n]+"$/.test(etag);

export async function authenticate(config: Config, login: Login, services: Pick<SessionStore, 'cache' | 'jobs'>, baseFetch: typeof fetch = fetch, diagnostics = new Diagnostics()): Promise<Session> {
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
    await diagnostics.run('login', 'upstream-transport', () => client.login());
    const authorizedFetch: typeof fetch = (input, init) => guardedFetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)),
      Authorization: isBasic ? `Basic ${Buffer.from(`${client.credentials.username}:${client.credentials.password}`).toString('base64')}` : `Bearer ${client.credentials.accessToken}` } });
    const now = Date.now();
    const session: Session = { cache: services.cache, jobs: services.jobs, id: opaque(), csrf: opaque(), accountKey: hash(`${config.CALDAV_URL}\0${client.account?.principalUrl ?? (login.method === 'basic' ? login.username : 'token-user')}`),
      client, fetch: authorizedFetch, abort, created: now, touched: now, calendars: new Map(), resources: new Map(), resourceLocations: new Map(), resourceLocationBytes: 0, operations: new Map(), locks: new Set(), cacheBytes: 0 };
    await discover(session, config, diagnostics);
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

export async function discover(session: Session, config: Config, diagnostics = new Diagnostics()): Promise<Calendar[]> {
  return diagnostics.run('discovery', 'upstream-transport', async () => {
    const calendars = await diagnostics.run('discovery', 'upstream-transport', () => session.client.fetchCalendars({ props: {
      'd:displayname': {}, 'ca:calendar-color': {}, 'c:calendar-timezone': {}, 'd:current-user-privilege-set': {},
      'd:resourcetype': {}, 'c:supported-calendar-component-set': {},
    }, projectedProps: { currentUserPrivilegeSet: true } }));
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
    for (const [id, entry] of session.resourceLocations) if (!entries.has(entry.calendarId)) discardResource(session, id);
    return [...entries.values()].map(entry => entry.calendar);
  });
}
export function getCalendar(session: Session, id: string) {
  const entry = session.calendars.get(id);
  if (!entry) throw new ApiError(404, 'CALENDAR_MISSING', 'This calendar is no longer available.');
  return entry;
}
export function getResource(session: Session, id: string) {
  const entry = session.resourceLocations.get(id);
  if (!entry) throw new ApiError(404, 'EVENT_MISSING', 'Refresh the calendar to access this event.');
  getCalendar(session, entry.calendarId);
  return entry;
}

export async function readRange(session: Session, config: Config, calendarIds: string[], start: string, end: string, timezone: string, diagnostics = new Diagnostics()) {
  const resources: ResourceEntry[] = []; const warnings: string[] = [];
  let resourceBytes = 0;
  // Padding includes floating dates interpreted by servers in a different local timezone.
  const timeRange = { start: new Date(Date.parse(start) - 36 * 3600000).toISOString(), end: new Date(Date.parse(end) + 36 * 3600000).toISOString() };
  for (const id of calendarIds) {
    const entry = getCalendar(session, id);
    try {
      await diagnostics.run('calendar-range', 'upstream-transport', async () => {
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
      });
    } catch (error) {
      diagnostics.fail(error, 'calendar-range', 'upstream-transport');
      if (error instanceof ApiError && error.status === 401) throw error;
      warnings.push(`${entry.calendar.name}: ${error instanceof ApiError ? error.message : 'Could not refresh this calendar.'}`);
    }
  }
  const result = await diagnostics.run('range-expand', 'ics-processing', () => session.jobs.run({ kind: 'expand', resources, start, end, timezone }));
  const eventWarnings = result.warnings.map(warning => {
    const resource = resources.find(r => warning.startsWith(`${r.id}:`));
    return resource ? `${getCalendar(session, resource.calendarId).calendar.name}${warning.slice(resource.id.length)}` : warning;
  });
  return { ...result, warnings: [...warnings, ...eventWarnings], refreshedAt: new Date().toISOString(), complete: warnings.length === 0 && result.warnings.length === 0 };
}

export async function fetchResource(session: Session, resource: ResourceLocation, diagnostics = new Diagnostics()): Promise<ResourceEntry> {
  return diagnostics.run('resource-read', 'upstream-transport', async () => {
    const location = getResource(session, resource.id);
    const response = await session.fetch(location.url, { method: 'GET' });
    if (response.status === 404) {
      getResource(session, location.id);
      operationTracker(session).confirmAbsence(location);
      throw new ApiError(404, 'EVENT_MISSING', 'This event was deleted on the server.');
    }
    if (response.status === 403) { discardResource(session, location.id); throw new ApiError(403, 'PERMISSION', 'The server denied access to this event.'); }
    if (!response.ok) throw new ApiError(502, 'UPSTREAM', 'The CalDAV server could not read this event.', { retryable: true });
    const latest = { ...location, ics: await response.text(), etag: response.headers.get('etag') ?? '' };
    getResource(session, location.id);
    retainResource(session, latest); return latest;
  });
}

export async function detail(session: Session, resource: ResourceEntry, recurrenceId?: string, diagnostics = new Diagnostics()) {
  const result = await diagnostics.run('event-detail', 'ics-processing', () => session.jobs.run({ kind: 'detail', resource, recurrenceId }));
  const { calendar } = getCalendar(session, resource.calendarId);
  return { ...result, canUpdate: result.canUpdate && calendar.canUpdate && strongETag(resource.etag), canDelete: result.canDelete && (recurrenceId ? calendar.canUpdate : calendar.canDelete) && strongETag(resource.etag) };
}

function caldavAccess(session: Session, config: Config, diagnostics: Diagnostics) {
  return new CalDavAccess(session, config, { calendar: getCalendar, resource: getResource,
    fetch: (current, location) => fetchResource(current, location, diagnostics),
    detail: (current, resource, recurrenceId) => detail(current, resource, recurrenceId, diagnostics) }, diagnostics);
}
export function reconcile(session: Session, config: Config, operation: Mutation, diagnostics = new Diagnostics()) {
  diagnostics.operation(operation.id);
  return operationTracker(session).reconcile(operation, caldavAccess(session, config, diagnostics), diagnostics);
}
export function mutate(session: Session, config: Config, command: MutationCommand, diagnostics = new Diagnostics()) {
  diagnostics.operation(command.operationId);
  return operationTracker(session).run(command, caldavAccess(session, config, diagnostics), diagnostics);
}

export async function exportCalendar(session: Session, config: Config, calendarId: string, diagnostics = new Diagnostics()) {
  return diagnostics.run('export-read', 'upstream-transport', async () => {
    const entry = getCalendar(session, calendarId);
    const objects = await diagnostics.run('export-read', 'upstream-transport', () => session.client.fetchCalendarObjects({ calendar: entry.upstream, expand: false, urlFilter: () => true }));
    if (objects.length > 2000) throw new ApiError(422, 'EXPORT_LIMIT', 'This calendar exceeds the export resource limit.');
    let bytes = 0;
    const documents = objects.map(object => {
      const url = allowedUrl(object.url, config).href;
      if (!url.startsWith(entry.upstream.url.endsWith('/') ? entry.upstream.url : `${entry.upstream.url}/`) || typeof object.data !== 'string') throw new ApiError(502, 'RESOURCE_PATH', 'The server returned invalid calendar resources.');
      bytes += Buffer.byteLength(object.data);
      if (bytes > 16 * 1024 * 1024) throw new ApiError(422, 'EXPORT_LIMIT', 'This calendar exceeds the export size limit.');
      return object.data;
    });
    return { ics: await diagnostics.run('export-serialize', 'ics-processing', () => session.jobs.run({ kind: 'export', documents })) };
  });
}
export async function importEvent(session: Session, config: Config, operationId: string, calendarId: string, ics: string, diagnostics = new Diagnostics()) {
  diagnostics.operation(operationId);
  const entries = await diagnostics.run('import-parse', 'ics-processing', () => session.jobs.run({ kind: 'import', ics }));
  if (entries.length !== 1) throw new ApiError(422, 'IMPORT_INVALID', 'Import one event series per operation.');
  const digest = createHash('sha256').update(entries[0].uid).digest('hex');
  const identity = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return mutate(session, config, { kind: 'import', operationId, creationId: identity, calendarId, ics: entries[0].ics }, diagnostics);
}
