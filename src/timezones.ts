import ICAL from 'ical.js';

export type TimezoneData = { version: string; zones: Record<string, string> };
export type Timezones = ReturnType<typeof createTimezones>;

export function createTimezones(data: TimezoneData) {
  const component = (name: string): ICAL.Component | undefined => {
    const source = data.zones[name];
    if (source) {
      const zone = ICAL.Component.fromString(source);
      zone.updatePropertyWithValue('tzid', name);
      return zone;
    }
  };
  for (const name of Object.keys(data.zones)) {
    ICAL.TimezoneService.register(new ICAL.Timezone({ component: component(name)!, tzid: name }), name);
  }
  return { names: ['UTC', ...Object.keys(data.zones).sort()], version: data.version, component };
}
