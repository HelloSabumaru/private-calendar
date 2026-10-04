import { createIcsCodec } from '../ics.js';
import { timezones } from './timezones.js';

export type { Resource } from '../ics.js';
export const { parseCalendar, eventDetail, resolveWall, writeEvent, expandResources, canonicalICS, occurrenceDetail, writeOccurrence, splitImport, mergeExport } = createIcsCodec(timezones);
