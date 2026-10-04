import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import ICAL from 'ical.js';

const data = JSON.parse(gunzipSync(readFileSync(new URL('../../data/timezones.json.gz', import.meta.url))).toString()) as { version: string; zones: Record<string, string> };
export const timezoneVersion = data.version;
export const timezoneNames = ['UTC', ...Object.keys(data.zones).sort()];

export function timezoneComponent(name: string): ICAL.Component | undefined {
  const source = data.zones[name];
  if (source) {
    const component = ICAL.Component.fromString(source);
    component.updatePropertyWithValue('tzid', name);
    return component;
  }
}
for (const name of Object.keys(data.zones)) {
  const component = timezoneComponent(name)!;
  ICAL.TimezoneService.register(new ICAL.Timezone({ component, tzid: name }), name);
}
