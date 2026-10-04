import { createIcsCodec } from '../ics';
import { createTimezones, type TimezoneData } from '../timezones';
import { DemoCalendar, type DemoRequest } from './demo-state';
import timezoneURL from '../../data/timezones.json.gz?url';

let calendar: Promise<DemoCalendar> | undefined;
async function initialize(date: string, timezone: string) {
  const response = await fetch(timezoneURL, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Timezone data unavailable');
  const bytes = new Uint8Array(await response.arrayBuffer());
  const blob = new Blob([bytes]);
  const text = bytes[0] === 0x1f && bytes[1] === 0x8b
    ? await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text()
    : await blob.text();
  const timezones = createTimezones(JSON.parse(text) as TimezoneData);
  return new DemoCalendar(createIcsCodec(timezones), timezones.names, date, timezone);
}

self.addEventListener('message', async (event: MessageEvent<{ id: number; request: DemoRequest; date: string; timezone: string }>) => {
  const { id, request, date, timezone } = event.data;
  try {
    calendar ??= initialize(date, timezone);
    self.postMessage({ id, response: (await calendar).handle(request) });
  } catch {
    calendar = undefined;
    self.postMessage({ id, response: { status: 503, body: { code: 'DEMO_UNAVAILABLE', message: 'The demo could not load. Reload to try again.' } } });
  }
});
