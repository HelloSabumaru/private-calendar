import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { mockDav } from '../dav-server.js';
import { createApp } from '../../src/server/app.js';
import { loadConfig } from '../../src/server/config.js';
import { writeEvent } from '../../src/server/ics.js';
import { defaultRecurrence } from '../../src/shared.js';

const dav = await mockDav();
const seed = () => {
  dav.objects.clear(); dav.state.unavailable = false; dav.state.mode = ''; dav.state.rejectAuth = false;
  const base = { calendarId: '', title: 'Morning walk', description: 'A little fresh air.', location: 'The park', start: '2026-10-04T09:00:00', end: '2026-10-04T10:00:00', timezone: 'Europe/Prague', allDay: false, reminder: 1440 as const, recurrence: defaultRecurrence };
  dav.objects.set('/u/calendar/walk.ics', writeEvent(base, 'walk'));
  dav.objects.set('/u/calendar/lunch.ics', writeEvent({ ...base, title: 'Lunch with Sam', start: '2026-10-06T12:30:00', end: '2026-10-06T13:30:00', location: 'Little café' }, 'lunch'));
  dav.objects.set('/u/calendar/holiday.ics', writeEvent({ ...base, title: 'A long weekend', allDay: true, start: '2026-10-09', end: '2026-10-12', location: '' }, 'holiday'));
  dav.objects.set('/u/calendar/stretch.ics', writeEvent({ ...base, title: 'Stretch & reset', start: '2026-10-02T18:00:00', end: '2026-10-02T18:30:00', recurrence: { ...defaultRecurrence, frequency: 'WEEKLY', end: 'count', count: 6 } }, 'stretch'));
};
seed();
const port = Number(process.env.CALENDAR_TEST_PORT ?? '4173');
const { app } = await createApp(loadConfig({ APP_ORIGIN: `https://localhost:${port}`, CALDAV_URL: dav.url, CALDAV_ALLOW_HTTP: 'true' }), { staticRoot: `${process.cwd()}/dist/client`, limits: { requests: 10000, logins: 10000 } });
const proxy = createServer({ key: readFileSync('.certs/localhost-key.pem'), cert: readFileSync('.certs/localhost.pem') }, async (req, res) => {
  if (req.url === '/_test/reset' && req.method === 'POST') { seed(); res.end('ok'); return; }
  if (req.url === '/_test/expire' && req.method === 'POST') { dav.state.rejectAuth = true; res.end('ok'); return; }
  if (req.url === '/_test/change-location' && req.method === 'POST') { const path = '/u/calendar/walk.ics'; dav.objects.set(path, dav.objects.get(path)!.replace('LOCATION:The park', 'LOCATION:Changed by another client')); res.end('ok'); return; }
  if (req.url === '/_test/uncertain' && req.method === 'POST') { dav.state.mode = 'unavailable-after-put'; res.end('ok'); return; }
  if (req.url === '/_test/recover' && req.method === 'POST') { dav.state.unavailable = false; res.end('ok'); return; }
  const buffers: Buffer[] = []; for await (const chunk of req) buffers.push(chunk);
  const result = await app.inject({ method: req.method as 'GET', url: req.url!, headers: req.headers, payload: Buffer.concat(buffers) });
  res.writeHead(result.statusCode, result.headers); res.end(result.rawPayload);
});
await new Promise<void>(resolve => proxy.listen(port, '127.0.0.1', resolve));
async function stop() { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); await app.close(); await dav.close(); }
process.once('SIGTERM', () => { void stop(); }); process.once('SIGINT', () => { void stop(); });
