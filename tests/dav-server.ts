import { createServer, type IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';

const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const response = (href: string, props: string) => `<d:response><d:href>${escape(href)}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const multistatus = (body: string) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:ca="http://apple.com/ns/ical/">${body}</d:multistatus>`;

export async function mockDav() {
  const objects = new Map<string, string>();
  const requests: { method: string; url: string; headers: IncomingMessage['headers']; body: string }[] = [];
  const state = { allowBearer: false, readOnly: false, rejectAuth: false, unavailable: false, mode: '' as '' | 'drop-before-put' | 'drop-after-put' | 'unavailable-after-put', beforePut: undefined as (() => void) | undefined };
  const etag = (body: string) => `"${createHash('sha256').update(body).digest('hex')}"`;
  const server = createServer(async (req, res) => {
    const buffers: Buffer[] = []; for await (const chunk of req) buffers.push(chunk);
    const body = Buffer.concat(buffers).toString(), url = req.url!, method = req.method!;
    requests.push({ method, url, body, headers: req.headers });
    if (state.unavailable) { req.socket.destroy(); return; }
    if (state.rejectAuth || !(req.headers.authorization === `Basic ${Buffer.from('user:password').toString('base64')}` || state.allowBearer && req.headers.authorization === 'Bearer test-token')) { res.writeHead(401); res.end(); return; }
    if (method === 'PROPFIND') {
      const privilege = `<d:current-user-privilege-set><d:privilege><d:${state.readOnly ? 'read' : 'all'}/></d:privilege></d:current-user-privilege-set>`;
      const root = '<d:current-user-principal><d:href>/u/</d:href></d:current-user-principal><c:calendar-home-set><d:href>/u/</d:href></c:calendar-home-set><d:resourcetype><d:collection/></d:resourcetype>';
      const calendar = `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Personal</d:displayname><ca:calendar-color>#267353ff</ca:calendar-color><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>${privilege}<d:supported-report-set/>`;
      const xml = url === '/u/' && req.headers.depth === '1' ? response('/u/', root) + response('/u/calendar/', calendar) : response(url, url === '/u/calendar/' ? calendar : root);
      res.writeHead(207, { 'Content-Type': 'application/xml' }); res.end(multistatus(xml)); return;
    }
    if (method === 'REPORT') {
      const xml = [...objects.entries()].filter(([path]) => !body.includes('calendar-multiget') || body.includes(path)).map(([path, ics]) => response(path, `<d:getetag>${escape(etag(ics))}</d:getetag><c:calendar-data>${escape(ics)}</c:calendar-data>`)).join('');
      res.writeHead(207, { 'Content-Type': 'application/xml' }); res.end(multistatus(xml)); return;
    }
    if (method === 'GET') {
      const ics = objects.get(url);
      res.writeHead(ics ? 200 : 404, ics ? { 'Content-Type': 'text/calendar', ETag: etag(ics) } : {}); res.end(ics); return;
    }
    if (method === 'PUT' || method === 'DELETE') {
      if (state.readOnly) { res.writeHead(403); res.end(); return; }
      if (method === 'PUT' && state.beforePut) { state.beforePut(); state.beforePut = undefined; }
      const current = objects.get(url);
      if (req.headers['if-none-match'] === '*' ? !!current : !current || req.headers['if-match'] !== etag(current)) { res.writeHead(412); res.end(); return; }
      if (state.mode === 'drop-before-put') { state.mode = ''; req.socket.destroy(); return; }
      if (method === 'DELETE') objects.delete(url); else objects.set(url, body);
      if (state.mode) { if (state.mode === 'unavailable-after-put') state.unavailable = true; state.mode = ''; req.socket.destroy(); return; }
      res.writeHead(current ? 204 : 201); res.end(); return;
    }
    res.writeHead(405); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  return { url: `http://127.0.0.1:${address.port}/`, objects, requests, state, etag,
    close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}
