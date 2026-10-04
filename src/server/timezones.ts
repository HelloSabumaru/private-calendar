import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createTimezones, type TimezoneData } from '../timezones.js';

const data = JSON.parse(gunzipSync(readFileSync(new URL('../../data/timezones.json.gz', import.meta.url))).toString()) as TimezoneData;
export const timezones = createTimezones(data);
export const timezoneVersion = timezones.version;
export const timezoneNames = timezones.names;
export const timezoneComponent = timezones.component;
