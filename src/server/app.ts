import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import type { Writable } from 'node:stream';
import { z } from 'zod';
import { draftSchema, loginSchema } from '../shared.js';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import { Diagnostics, safeError, safeMethod } from './diagnostics.js';
import { SessionStore, type Session } from './sessions.js';
import { authenticate, detail, discover, exportCalendar, fetchResource, getResource, importEvent, mutate, publicOperation, readRange, reconcile } from './dav.js';
import { timezoneNames, timezoneVersion } from './timezones.js';

declare module 'fastify' { interface FastifyRequest { calendarSession?: Session; calendarDiagnostics: Diagnostics } }
const cookieName = '__Host-calendar';
const operationSchema = z.uuid();
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const occurrenceQuery = z.object({ recurrenceId: z.string().min(10).max(32).optional() });
const equal = (a: string, b: string) => { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };

export async function createApp(config: Config, options: { fetch?: typeof fetch; logger?: boolean | { stream: Writable }; staticRoot?: string; limits?: { requests: number; logins: number } } = {}) {
  const app = Fastify({ bodyLimit: 256 * 1024, requestTimeout: 30000, connectionTimeout: 10000,
    logger: options.logger ? { ...(typeof options.logger === 'object' ? { stream: options.logger.stream } : {}),
      serializers: { req: req => ({ method: safeMethod(req.method) }), err: safeError }, redact: ['req.headers.cookie', 'req.headers.authorization'] } : false });
  const sessions = new SessionStore(config);
  const sweep = setInterval(() => sessions.sweep(), 60000); sweep.unref();
  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"], fontSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"],
  } } });
  await app.register(rateLimit, { max: options.limits?.requests ?? 120, timeWindow: '1 minute' });
  app.decorateRequest('calendarSession', undefined);
  app.decorateRequest('calendarDiagnostics');
  app.addHook('onRequest', async (request, reply) => {
    request.calendarDiagnostics = new Diagnostics(request.log);
    const operationId = request.headers['idempotency-key'];
    if (typeof operationId === 'string') request.calendarDiagnostics.operation(operationId);
    request.calendarDiagnostics.check('session-guard', 'internal', () => {
      if (!request.url.startsWith('/api/')) return;
      reply.header('Cache-Control', 'no-store');
      const login = request.method === 'POST' && request.url === '/api/session';
      if (!['GET', 'HEAD'].includes(request.method) && request.headers.origin !== config.APP_ORIGIN) throw new ApiError(403, 'ORIGIN', 'Request origin does not match the application.');
      if (login) return;
      request.calendarSession = sessions.get(request.cookies[cookieName]);
      if (!['GET', 'HEAD'].includes(request.method)) {
        const token = request.headers['x-csrf-token'];
        if (typeof token !== 'string' || !equal(token, request.calendarSession.csrf)) throw new ApiError(403, 'CSRF', 'Refresh the session before making changes.');
      }
    });
  });
  app.addHook('preSerialization', async (request, reply) => {
    (request.calendarDiagnostics ??= new Diagnostics(request.log)).check('response-serialize', 'internal', () => {
      if (reply.statusCode < 400 && request.calendarSession?.abort.signal.aborted && !(request.method === 'DELETE' && request.url === '/api/session')) throw new ApiError(401, 'SESSION_EXPIRED', 'Your session ended. Sign in again.');
    });
  });
  app.setErrorHandler((error, request, reply) => {
    let status = 502; let response = { code: 'UPSTREAM', message: 'The calendar service could not complete this request. Try again.', retryable: true };
    if (error instanceof ApiError) { status = error.status; response = { code: error.code, message: error.message, retryable: false, ...error.extra }; }
    else if (error instanceof z.ZodError) { status = 400; response = { code: 'VALIDATION', message: error.issues[0]?.message ?? 'Invalid request.', retryable: false }; }
    else if (error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number') { status = error.statusCode; response = { code: 'REQUEST', message: status === 429 ? 'Too many requests. Try again shortly.' : 'Invalid request.', retryable: false }; }
    // A stale response must not clear a newer session cookie set by another tab.
    if (status === 401 && request.calendarSession) sessions.remove(request.calendarSession.id);
    (request.calendarDiagnostics ??= new Diagnostics(request.log)).fail(error);
    reply.code(status).send(response);
  });
  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ status: 'ok', timezoneVersion }));
  app.post('/api/session', { config: { rateLimit: { max: options.limits?.logins ?? 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const login = loginSchema.parse(request.body);
    if (login.method === 'basic' && (login.username.includes(':') || /[\r\n]/.test(login.username))) throw new ApiError(400, 'USERNAME', 'The username contains unsupported characters.');
    if (login.method === 'bearer' && /[\r\n]/.test(login.token)) throw new ApiError(400, 'TOKEN', 'The token contains unsupported characters.');
    const session = await authenticate(config, login, sessions, options.fetch, request.calendarDiagnostics);
    try { sessions.add(session, request.cookies[cookieName]); } catch (error) {
      session.abort.abort(); session.client.credentials = {}; session.client.authHeaders = undefined;
      if (session.client.account) session.client.account.credentials = {};
      throw error;
    }
    reply.setCookie(cookieName, session.id, { path: '/', secure: true, httpOnly: true, sameSite: 'strict', maxAge: config.SESSION_MAX_HOURS * 3600 });
    return { accountKey: session.accountKey, csrf: session.csrf, calendars: [...session.calendars.values()].map(c => c.calendar), timezones: timezoneNames };
  });
  app.get('/api/session', async request => {
    const session = request.calendarSession!;
    return { accountKey: session.accountKey, csrf: session.csrf, timezones: timezoneNames };
  });
  app.delete('/api/session', async (request, reply) => {
    sessions.remove(request.calendarSession!.id);
    reply.clearCookie(cookieName, { path: '/', secure: true, httpOnly: true, sameSite: 'strict' });
    return { ok: true };
  });
  app.get('/api/calendars', async request => ({ calendars: await discover(request.calendarSession!, config, request.calendarDiagnostics) }));
  app.get('/api/events', async request => {
    const query = z.object({ start: z.iso.datetime(), end: z.iso.datetime(), timezone: z.string().max(256), calendars: z.string().max(12000) }).parse(request.query);
    const ids = query.calendars ? query.calendars.split(',').map(id => idSchema.parse(id)) : [];
    if (new Set(ids).size !== ids.length || ids.length > 256) throw new ApiError(400, 'CALENDARS', 'Choose valid calendar identifiers.');
    if (Date.parse(query.end) <= Date.parse(query.start) || Date.parse(query.end) - Date.parse(query.start) > 93 * 86400000) throw new ApiError(400, 'RANGE', 'The event range must be between zero and 93 days.');
    if (!timezoneNames.includes(query.timezone)) throw new ApiError(400, 'TIMEZONE', 'Choose a supported display timezone.');
    return readRange(request.calendarSession!, config, ids, query.start, query.end, query.timezone, request.calendarDiagnostics);
  });
  app.get('/api/search', async request => {
    const query = z.object({ q: z.string().trim().min(1).max(200), start: z.iso.datetime(), end: z.iso.datetime(), timezone: z.string().max(256), calendars: z.string().max(12000) }).parse(request.query);
    const ids = query.calendars ? query.calendars.split(',').map(id => idSchema.parse(id)) : [];
    if (new Set(ids).size !== ids.length || ids.length > 256 || !timezoneNames.includes(query.timezone)) throw new ApiError(400, 'SEARCH', 'Choose valid calendars and a supported timezone.');
    const from = Date.parse(query.start), until = Date.parse(query.end);
    if (until <= from || until - from > 367 * 86400000) throw new ApiError(400, 'RANGE', 'Search a date range of at most one year.');
    const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en-GB');
    const needle = normalize(query.q);
    const matches = new Map<string, Awaited<ReturnType<typeof readRange>>['occurrences'][number]>();
    const warnings: string[] = [];
    for (let cursor = from; cursor < until; cursor += 90 * 86400000) {
      const result = await readRange(request.calendarSession!, config, ids, new Date(cursor).toISOString(), new Date(Math.min(until, cursor + 90 * 86400000)).toISOString(), query.timezone, request.calendarDiagnostics);
      warnings.push(...result.warnings);
      for (const event of result.occurrences) if ([event.title, event.description, event.location].some(value => normalize(value).includes(needle))) {
        matches.set(event.id, event);
        if (matches.size > 1000) throw new ApiError(422, 'SEARCH_LIMIT', 'Too many matches. Narrow your search or date range.');
      }
    }
    return { occurrences: [...matches.values()].sort((a, b) => a.start.localeCompare(b.start)), warnings: [...new Set(warnings)] };
  });
  app.get<{ Params: { id: string } }>('/api/events/:id', async request => {
    const session = request.calendarSession!;
    return detail(session, await fetchResource(session, getResource(session, idSchema.parse(request.params.id)), request.calendarDiagnostics), occurrenceQuery.parse(request.query).recurrenceId, request.calendarDiagnostics);
  });
  app.get<{ Params: { id: string } }>('/api/events/:id/export', async request => ({ ics: (await fetchResource(request.calendarSession!, getResource(request.calendarSession!, idSchema.parse(request.params.id)), request.calendarDiagnostics)).ics }));
  app.get<{ Params: { id: string } }>('/api/calendars/:id/export', async request => exportCalendar(request.calendarSession!, config, idSchema.parse(request.params.id), request.calendarDiagnostics));
  app.post('/api/import/preview', async request => {
    const { ics } = z.object({ ics: z.string().min(1).max(240000) }).parse(request.body);
    return request.calendarDiagnostics.run('import-parse', 'ics-processing', () => request.calendarSession!.jobs.run({ kind: 'import', ics }));
  });
  app.post('/api/import', async request => {
    const operationId = operationSchema.parse(request.headers['idempotency-key']);
    request.calendarDiagnostics.operation(operationId);
    const body = z.object({ calendarId: idSchema, ics: z.string().min(1).max(240000) }).parse(request.body);
    return importEvent(request.calendarSession!, config, operationId, body.calendarId, body.ics, request.calendarDiagnostics);
  });
  app.post('/api/events', async request => {
    const operationId = operationSchema.parse(request.headers['idempotency-key']);
    request.calendarDiagnostics.operation(operationId);
    return mutate(request.calendarSession!, config, { kind: 'create', operationId, draft: draftSchema.parse(request.body),
      creationId: request.headers['x-event-id'] ? operationSchema.parse(request.headers['x-event-id']) : operationId }, request.calendarDiagnostics);
  });
  app.patch<{ Params: { id: string } }>('/api/events/:id', async request => {
    const command = { operationId: operationSchema.parse(request.headers['idempotency-key']), resourceId: idSchema.parse(request.params.id),
      draft: draftSchema.parse(request.body), etag: z.string().max(256).parse(request.headers['if-match']) };
    request.calendarDiagnostics.operation(command.operationId);
    const { recurrenceId } = occurrenceQuery.parse(request.query);
    return mutate(request.calendarSession!, config, recurrenceId ? { ...command, kind: 'update-occurrence', recurrenceId } : { ...command, kind: 'update' }, request.calendarDiagnostics);
  });
  app.delete<{ Params: { id: string } }>('/api/events/:id', async request => {
    const command = { operationId: operationSchema.parse(request.headers['idempotency-key']), resourceId: idSchema.parse(request.params.id),
      etag: z.string().max(256).parse(request.headers['if-match']) };
    request.calendarDiagnostics.operation(command.operationId);
    const { recurrenceId } = occurrenceQuery.parse(request.query);
    return mutate(request.calendarSession!, config, recurrenceId ? { ...command, kind: 'delete-occurrence', recurrenceId } : { ...command, kind: 'delete' }, request.calendarDiagnostics);
  });
  app.get<{ Params: { id: string } }>('/api/operations/:id', async request => {
    const operationId = operationSchema.parse(request.params.id);
    request.calendarDiagnostics.operation(operationId);
    const operation = request.calendarSession!.operations.get(operationId);
    if (!operation) throw new ApiError(404, 'OPERATION_MISSING', 'This operation is not available. Refresh and inspect the calendar before retrying.');
    await reconcile(request.calendarSession!, config, operation, request.calendarDiagnostics);
    return publicOperation(operation);
  });
  const root = options.staticRoot ?? fileURLToPath(new URL('../client/', import.meta.url));
  const hasStaticRoot = existsSync(`${root}/index.html`);
  if (hasStaticRoot) {
    await app.register(staticFiles, { root, index: false });
    app.get('/', async (_request, reply) => reply.header('Cache-Control', 'no-cache').sendFile('index.html'));
  }
  app.setNotFoundHandler((request, reply) => {
    if (hasStaticRoot && request.method === 'GET' && !request.url.startsWith('/api/') && !/\.[a-z0-9]+(?:\?|$)/i.test(request.url)) return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    return reply.code(404).send({ code: 'NOT_FOUND', message: 'Not found.' });
  });
  app.addHook('onClose', async () => { clearInterval(sweep); await sessions.close(); });
  return { app, sessions };
}
