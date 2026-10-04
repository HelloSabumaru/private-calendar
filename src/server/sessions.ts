import { randomBytes } from 'node:crypto';
import type { DAVClient, DAVCalendar } from 'tsdav';
import type { Calendar, Operation } from '../shared.js';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import type { Resource } from './ics.js';

export type CalendarEntry = { calendar: Calendar; upstream: DAVCalendar };
export type ResourceEntry = Resource & { url: string };
export type ResourceLocation = Omit<ResourceEntry, 'ics'>;
export type Mutation = Operation & {
  resourceId: string; fingerprint: string; url: string; method: 'PUT' | 'DELETE'; intended?: string; etag?: string; running?: Promise<void>;
};
export type Session = {
  id: string; csrf: string; accountKey: string; client: DAVClient; fetch: typeof fetch; abort: AbortController;
  created: number; touched: number; calendars: Map<string, CalendarEntry>; resources: Map<string, ResourceEntry>;
  resourceLocations: Map<string, ResourceLocation>; resourceLocationBytes: number;
  operations: Map<string, Mutation>; locks: Set<string>; cacheBytes: number;
};

const liveSessions = new Set<Session>();
let cacheBytes = 0;
let resourceLocationBytes = 0;
let resourceLocationCount = 0;
const size = (source: string) => Buffer.byteLength(source);
const locationSize = (resource: ResourceLocation) => size(resource.id) + size(resource.calendarId) + size(resource.url) + size(resource.etag);
function discardCachedResource(session: Session, id: string) {
  const resource = session.resources.get(id);
  if (!resource) return;
  const bytes = size(resource.ics);
  session.resources.delete(id); session.cacheBytes -= bytes; cacheBytes -= bytes;
}
export function discardResource(session: Session, id: string) {
  discardCachedResource(session, id);
  const location = session.resourceLocations.get(id);
  if (!location) return;
  const bytes = locationSize(location);
  session.resourceLocations.delete(id); session.resourceLocationBytes -= bytes; resourceLocationBytes -= bytes; resourceLocationCount--;
}
function evictResource(session: Session) {
  const id = session.resources.keys().next().value;
  if (!id) return false;
  discardCachedResource(session, id); return true;
}
export function retainResourceLocation(session: Session, resource: ResourceLocation) {
  if (session.abort.signal.aborted) throw new ApiError(401, 'SESSION_EXPIRED', 'Your session ended. Sign in again.');
  if (!session.calendars.has(resource.calendarId)) throw new ApiError(404, 'CALENDAR_MISSING', 'This calendar is no longer available.');
  const previous = session.resourceLocations.get(resource.id);
  const bytes = locationSize(resource), previousBytes = previous ? locationSize(previous) : 0;
  // Locations survive ICS eviction and cover repeated ranges, including year-long searches.
  if (size(resource.url) > 4096 || size(resource.etag) > 1024 ||
      (!previous && (session.resourceLocations.size >= 20000 || resourceLocationCount >= 100000)) ||
      session.resourceLocationBytes - previousBytes + bytes > 16 * 1024 * 1024 || resourceLocationBytes - previousBytes + bytes > 64 * 1024 * 1024) {
    throw new ApiError(503, 'RESOURCE_LOCATION_LIMIT', 'Too many event locations are retained. Sign in again before loading more events.');
  }
  const location = { id: resource.id, calendarId: resource.calendarId, url: resource.url, etag: resource.etag };
  session.resourceLocations.set(resource.id, location);
  session.resourceLocationBytes += bytes - previousBytes; resourceLocationBytes += bytes - previousBytes;
  if (!previous) resourceLocationCount++;
}
export function retainResource(session: Session, resource: ResourceEntry) {
  if (session.abort.signal.aborted) throw new ApiError(401, 'SESSION_EXPIRED', 'Your session ended. Sign in again.');
  const bytes = size(resource.ics);
  if (bytes > 1024 * 1024) throw new ApiError(422, 'ICS_LIMIT', 'This event exceeds the resource size limit.');
  retainResourceLocation(session, resource);
  discardCachedResource(session, resource.id);
  session.resources.set(resource.id, resource); session.cacheBytes += bytes; cacheBytes += bytes;
  while (session.resources.size > 2000 || session.cacheBytes > 8 * 1024 * 1024) evictResource(session);
  while (cacheBytes > 64 * 1024 * 1024) {
    const victim = [...liveSessions].find(s => s.resources.size);
    if (!victim || !evictResource(victim)) break;
  }
}
export function retainOperation(session: Session, operation: Mutation) {
  if (session.abort.signal.aborted) throw new ApiError(401, 'SESSION_EXPIRED', 'Your session ended. Sign in again.');
  const bytes = size(operation.intended ?? '');
  const retained = (s: Session) => [...s.operations.values()].reduce((n, op) => n + size(op.intended ?? ''), 0);
  for (const s of liveSessions) for (const op of s.operations.values()) if (op.state === 'success' || op.state === 'failed') { op.intended = undefined; op.running = undefined; }
  if (retained(session) + bytes > 4 * 1024 * 1024 || [...liveSessions].reduce((n, s) => n + retained(s), 0) + bytes > 32 * 1024 * 1024) throw new ApiError(503, 'OPERATION_LIMIT', 'Resolve pending changes before making more changes.');
  session.operations.set(operation.id, operation);
}

export class SessionStore {
  private entries = new Map<string, Session>();
  constructor(private config: Config) {}
  add(session: Session, replacingId?: string) {
    this.sweep();
    const replacing = replacingId !== undefined && this.entries.has(replacingId);
    if (this.entries.size - Number(replacing) >= this.config.MAX_SESSIONS) throw new ApiError(503, 'SESSION_LIMIT', 'Too many active sessions. Try again later.');
    this.remove(replacingId);
    this.entries.set(session.id, session);
    liveSessions.add(session);
  }
  get(id: string | undefined) {
    const session = id ? this.entries.get(id) : undefined;
    if (!session) throw new ApiError(401, 'SESSION_EXPIRED', 'Sign in to access your calendars.');
    const now = Date.now();
    if (now - session.touched > this.config.SESSION_IDLE_MINUTES * 60000 || now - session.created > this.config.SESSION_MAX_HOURS * 3600000) {
      this.remove(session.id); throw new ApiError(401, 'SESSION_EXPIRED', 'Your session expired. Sign in again.');
    }
    session.touched = now;
    return session;
  }
  remove(id: string | undefined) {
    const session = id ? this.entries.get(id) : undefined;
    if (!session) return;
    session.abort.abort(); session.client.credentials = {}; session.client.authHeaders = undefined;
    if (session.client.account) session.client.account.credentials = {};
    cacheBytes -= session.cacheBytes; session.cacheBytes = 0; liveSessions.delete(session);
    resourceLocationBytes -= session.resourceLocationBytes; session.resourceLocationBytes = 0; resourceLocationCount -= session.resourceLocations.size;
    session.calendars.clear(); session.resources.clear(); session.resourceLocations.clear(); session.operations.clear(); session.locks.clear();
    this.entries.delete(session.id);
  }
  sweep() {
    const now = Date.now();
    for (const session of this.entries.values()) if (now - session.touched > this.config.SESSION_IDLE_MINUTES * 60000 || now - session.created > this.config.SESSION_MAX_HOURS * 3600000) this.remove(session.id);
  }
  close() { for (const id of this.entries.keys()) this.remove(id); }
}
export const opaque = () => randomBytes(32).toString('base64url');
