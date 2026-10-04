"""Exercise the built web API and an independent client against disposable Radicale."""
import datetime
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import time
import uuid

import caldav
import icalendar
import requests


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def wait_for(url, process):
    for _ in range(100):
        if process.poll() is not None:
            raise AssertionError('Test server exited during startup; inspect .interop/server.log')
        try:
            response = requests.get(url, timeout=0.5)
            if response.status_code in (200, 401):
                return
        except requests.RequestException:
            pass
        time.sleep(0.1)
    raise AssertionError('Test server startup timed out')


def stop(process):
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


with tempfile.TemporaryDirectory(prefix='calendar-interop-') as temporary, open('.interop/server.log', 'w') as log:
    root = pathlib.Path(temporary)
    dav_port, app_port = free_port(), free_port()
    (root / 'users').write_text('interop:password\n')
    (root / 'config').write_text(f'''[server]
hosts = 127.0.0.1:{dav_port}
[auth]
type = htpasswd
htpasswd_filename = {root / 'users'}
htpasswd_encryption = plain
[storage]
filesystem_folder = {root / 'collections'}
''')
    dav = subprocess.Popen([sys.executable, '-m', 'radicale', '-C', str(root / 'config')], stdout=log, stderr=log)
    backend = None
    try:
        dav_url = f'http://127.0.0.1:{dav_port}/'
        app_url = f'http://127.0.0.1:{app_port}'
        origin = 'https://calendar.test'
        wait_for(dav_url, dav)
        client = caldav.DAVClient(url=dav_url, username='interop', password='password')
        calendar = client.principal().make_calendar(name='Disposable interoperability', cal_id=str(uuid.uuid4()))
        source = '''BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Independent Python client//EN
BEGIN:VEVENT
UID:independent
DTSTAMP:20261001T000000Z
DTSTART;TZID=Europe/Prague:20261004T090000
DTEND;TZID=Europe/Prague:20261004T100000
SUMMARY:Independent event
ATTENDEE;CN=Jane;PARTSTAT=ACCEPTED:mailto:jane@example.test
X-PRIVATE-PROPERTY;X-PARAM=preserve:keep-me
BEGIN:VALARM
ACTION:DISPLAY
TRIGGER:-P1D
DESCRIPTION:Remember
X-ALARM-EXTENSION:keep-alarm
END:VALARM
END:VEVENT
END:VCALENDAR
'''
        independent = calendar.save_event(source)
        calendar.save_event('''BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Independent Python client//EN
BEGIN:VEVENT
UID:all-day
DTSTAMP:20261001T000000Z
DTSTART;VALUE=DATE:20261009
DTEND;VALUE=DATE:20261012
SUMMARY:All-day holiday
END:VEVENT
END:VCALENDAR
''')
        calendar.save_event('''BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Independent Python client//EN
BEGIN:VEVENT
UID:existing-series
DTSTAMP:20261001T000000Z
DTSTART:20261001T090000Z
DTEND:20261001T100000Z
RRULE:FREQ=DAILY;COUNT=3
SUMMARY:Existing series
END:VEVENT
BEGIN:VEVENT
UID:existing-series
DTSTAMP:20261001T000000Z
RECURRENCE-ID:20261002T090000Z
DTSTART:20261005T110000Z
DTEND:20261005T120000Z
SUMMARY:Moved exception
END:VEVENT
END:VCALENDAR
''')
        backend = subprocess.Popen(['node', 'dist/server/index.js'], env={**os.environ, 'HOST': '127.0.0.1', 'PORT': str(app_port), 'APP_ORIGIN': origin, 'CALDAV_URL': dav_url, 'CALDAV_ALLOWED_PATHS': '/', 'CALDAV_ALLOW_HTTP': 'true'}, stdout=log, stderr=log)
        wait_for(app_url + '/healthz', backend)
        response = requests.post(app_url + '/api/session', headers={'Origin': origin}, json={'method': 'basic', 'username': 'interop', 'password': 'password'}, timeout=20)
        assert response.status_code == 200, response.text
        info = response.json()
        selected = next(c for c in info['calendars'] if c['name'] == 'Disposable interoperability')
        assert selected['canCreate'] and selected['canUpdate'] and selected['canDelete'], selected
        headers = {'Origin': origin, 'Cookie': '__Host-calendar=' + response.cookies['__Host-calendar'], 'X-CSRF-Token': info['csrf']}

        def api(method, path, body=None, extra=None):
            result = requests.request(method, app_url + '/api' + path, headers={**headers, **(extra or {})}, json=body, timeout=30)
            return result

        query = '/events?' + requests.compat.urlencode({'start': '2026-10-01T00:00:00Z', 'end': '2026-11-01T00:00:00Z', 'timezone': 'Europe/Prague', 'calendars': selected['id']})
        result = api('GET', query)
        assert result.status_code == 200, result.text
        events = result.json()['occurrences']
        assert result.json()['warnings'] == [], result.json()['warnings']
        normal = next(e for e in events if e['title'] == 'Independent event')
        assert normal['start'] == '2026-10-04T07:00:00.000Z', normal
        holiday = next(e for e in events if e['title'] == 'All-day holiday')
        assert holiday['start'] == '2026-10-09' and holiday['end'] == '2026-10-12' and holiday['allDay']
        assert next(e for e in events if e['title'] == 'Moved exception')['start'] == '2026-10-05T11:00:00.000Z'
        detail = api('GET', '/events/' + normal['resourceId']).json()
        changed = {**detail['draft'], 'title': 'Browser edit', 'location': 'Shared park'}
        saved = api('PATCH', '/events/' + normal['resourceId'], changed, {'If-Match': detail['etag'], 'Idempotency-Key': str(uuid.uuid4())})
        assert saved.status_code == 200 and saved.json()['state'] == 'success', saved.text
        independent.load()
        document = icalendar.Calendar.from_ical(independent.data)
        component = document.walk('VEVENT')[0]
        assert str(component['SUMMARY']) == 'Browser edit'
        assert str(component['X-PRIVATE-PROPERTY']) == 'keep-me'
        assert component['X-PRIVATE-PROPERTY'].params['X-PARAM'] == 'preserve'
        assert component['ATTENDEE'].params['PARTSTAT'] == 'ACCEPTED'
        assert document.walk('VALARM')[0]['TRIGGER'].dt == datetime.timedelta(days=-1)
        assert str(document.walk('VALARM')[0]['X-ALARM-EXTENSION']) == 'keep-alarm'
        latest = api('GET', '/events/' + normal['resourceId']).json()
        independent.data = independent.data.replace('SUMMARY:Browser edit', 'SUMMARY:Independent edit')
        independent.save()
        conflict = api('PATCH', '/events/' + normal['resourceId'], {**changed, 'title': 'Unapplied draft'}, {'If-Match': latest['etag'], 'Idempotency-Key': str(uuid.uuid4())})
        assert conflict.status_code == 409 and conflict.json()['latest']['draft']['title'] == 'Independent edit', conflict.text
        assert any(e['title'] == 'Independent edit' for e in api('GET', query).json()['occurrences'])
        creation_id = str(uuid.uuid4())
        new = {**changed, 'title': 'Created in browser', 'start': '2026-10-24T09:00:00', 'end': '2026-10-24T10:00:00', 'reminder': 1440,
               'recurrence': {'frequency': 'DAILY', 'interval': 1, 'weekdays': [], 'end': 'count', 'count': 3}}
        created = api('POST', '/events', new, {'Idempotency-Key': str(uuid.uuid4()), 'X-Event-ID': creation_id})
        assert created.status_code == 200 and created.json()['state'] == 'success', created.text
        other = calendar.event_by_uid(creation_id + '@private-calendar')
        other.load()
        parsed = icalendar.Calendar.from_ical(other.data)
        assert parsed.walk('VTIMEZONE') and parsed.walk('VALARM')
        assert parsed.walk('VEVENT')[0]['DTSTART'].params['TZID'] == 'Europe/Prague'
        displayed = [e['start'] for e in api('GET', query).json()['occurrences'] if e['title'] == 'Created in browser']
        assert displayed == ['2026-10-24T07:00:00.000Z', '2026-10-25T08:00:00.000Z', '2026-10-26T08:00:00.000Z'], displayed
        occurrence_url = '/events/' + created.json()['resourceId'] + '?' + requests.compat.urlencode({'recurrenceId': '2026-10-25T09:00:00'})
        occurrence = api('GET', occurrence_url).json()
        assert occurrence['draft']['start'] == '2026-10-25T09:00:00', occurrence
        single = {**occurrence['draft'], 'title': 'Only Sunday', 'start': '2026-10-25T11:00:00', 'end': '2026-10-25T12:00:00'}
        saved = api('PATCH', occurrence_url, single, {'If-Match': occurrence['etag'], 'Idempotency-Key': str(uuid.uuid4())})
        assert saved.status_code == 200 and saved.json()['state'] == 'success', saved.text
        other.load()
        components = icalendar.Calendar.from_ical(other.data).walk('VEVENT')
        assert len(components) == 2 and str(components[1]['SUMMARY']) == 'Only Sunday', components
        assert components[1]['RECURRENCE-ID'].dt.day == 25
        assert icalendar.Calendar.from_ical(other.data).walk('VALARM')
        latest_occurrence = api('GET', occurrence_url).json()
        cancelled = api('DELETE', occurrence_url, extra={'If-Match': latest_occurrence['etag'], 'Idempotency-Key': str(uuid.uuid4())})
        assert cancelled.json()['state'] == 'success', cancelled.text
        other.load()
        assert str(icalendar.Calendar.from_ical(other.data).walk('VEVENT')[1]['STATUS']) == 'CANCELLED'
        remaining = [e for e in api('GET', query).json()['occurrences'] if e['resourceId'] == created.json()['resourceId']]
        assert len(remaining) == 2, remaining
        import_source = source.replace('UID:independent', 'UID:imported-independent').replace('SUMMARY:Independent event', 'SUMMARY:Imported independent')
        preview = api('POST', '/import/preview', {'ics': import_source})
        assert preview.status_code == 200 and preview.json()[0]['uid'] == 'imported-independent', preview.text
        for _ in range(2):
            imported = api('POST', '/import', {'calendarId': selected['id'], 'ics': import_source}, {'Idempotency-Key': str(uuid.uuid4())})
            assert imported.status_code == 200 and imported.json()['state'] == 'success', imported.text
        imported_client = calendar.event_by_uid('imported-independent')
        imported_client.load()
        assert 'X-PRIVATE-PROPERTY' in imported_client.data and 'X-ALARM-EXTENSION' in imported_client.data
        exported = api('GET', '/calendars/' + selected['id'] + '/export')
        assert exported.status_code == 200, exported.text
        exported_calendar = icalendar.Calendar.from_ical(exported.json()['ics'])
        assert any(str(e['UID']) == 'imported-independent' for e in exported_calendar.walk('VEVENT'))
        assert exported_calendar.walk('VALARM')
        exported_created = next(e for e in exported_calendar.walk('VEVENT') if str(e['UID']) == creation_id + '@private-calendar' and 'RECURRENCE-ID' not in e)
        assert exported_created['DTSTART'].dt.utcoffset() == datetime.timedelta(hours=2), exported_created
        search = api('GET', '/search?' + requests.compat.urlencode({'q': 'Imported independent', 'start': '2026-01-01T00:00:00Z', 'end': '2027-01-01T00:00:00Z', 'timezone': 'Europe/Prague', 'calendars': selected['id']}))
        assert search.status_code == 200 and len(search.json()['occurrences']) == 1, search.text
        fold_id = str(uuid.uuid4())
        fold = {**new, 'title': 'Across the repeated hour', 'start': '2026-10-25T02:30:00', 'end': '2026-10-25T02:30:00',
                'startOffset': 'earlier', 'endOffset': 'later', 'reminder': 'none',
                'recurrence': {'frequency': 'NONE', 'interval': 1, 'weekdays': [], 'end': 'never'}}
        saved_fold = api('POST', '/events', fold, {'Idempotency-Key': str(uuid.uuid4()), 'X-Event-ID': fold_id})
        assert saved_fold.status_code == 200 and saved_fold.json()['state'] == 'success', saved_fold.text
        independent_fold = calendar.event_by_uid(fold_id + '@private-calendar')
        independent_fold.load()
        component = icalendar.Calendar.from_ical(independent_fold.data).walk('VEVENT')[0]
        assert component['DTSTART'].dt.hour == 0 and component['DTEND'].dt.hour == 1, component
        assert component['DTEND'].dt - component['DTSTART'].dt == datetime.timedelta(hours=1), component
        fold_detail = api('GET', '/events/' + saved_fold.json()['resourceId']).json()['draft']
        assert fold_detail['start'] == fold_detail['end'] == '2026-10-25T02:30:00', fold_detail
        assert fold_detail['startOffset'] == 'earlier' and fold_detail['endOffset'] == 'later', fold_detail
        created_detail = api('GET', '/events/' + created.json()['resourceId']).json()
        deleted = api('DELETE', '/events/' + created.json()['resourceId'], extra={'If-Match': created_detail['etag'], 'Idempotency-Key': str(uuid.uuid4())})
        assert deleted.json()['state'] == 'success', deleted.text
        assert not any(e['title'] == 'Created in browser' for e in api('GET', query).json()['occurrences'])
        assert api('DELETE', '/session').status_code == 200
        assert api('GET', '/calendars').status_code == 401
        print('Radicale + python-caldav: bidirectional edits, preservation, recurrence/DST, all-day dates, conflicts, occurrence edits/cancellation, ICS import/export, search, deletion, and logout passed.')
    finally:
        if backend:
            stop(backend)
        stop(dav)
