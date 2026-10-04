"""Check the release image without real accounts or a writable filesystem."""
import json
import subprocess
import sys
import time
import urllib.request


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()


image = sys.argv[1]
container = docker('run', '-d', '--read-only', '--cap-drop=ALL',
                   '--security-opt=no-new-privileges:true', '--init',
                   '--memory=1g', '--cpus=2', '--pids-limit=128',
                   '-e', 'APP_ORIGIN=https://calendar.test',
                   '-e', 'CALDAV_URL=https://dav.example.test/',
                   '-e', 'PORT=6789', '-p', '127.0.0.1::6789', image)
try:
    details = json.loads(docker('inspect', container))[0]
    port = details['NetworkSettings']['Ports']['6789/tcp'][0]['HostPort']
    origin = f'http://127.0.0.1:{port}'
    for _ in range(100):
        try:
            with urllib.request.urlopen(origin + '/healthz', timeout=1) as response:
                assert json.load(response)['status'] == 'ok'
            break
        except OSError:
            time.sleep(0.1)
    else:
        raise AssertionError('Container startup timed out')

    with urllib.request.urlopen(origin + '/', timeout=3) as response:
        assert 'assets/' in response.read().decode()
        assert response.headers['Content-Security-Policy']

    probe = '''
(async () => {
const assert = (await import('node:assert/strict')).default;
const fs = (await import('node:fs')).default;
const { IcsWorkers } = await import('/app/dist/server/jobs.js');
const { defaultRecurrence } = await import('/app/dist/shared.js');
assert.notEqual(process.getuid(), 0);
for (const path of ['/app/LICENSE', '/app/dist/client/third-party-licenses.txt', '/app/data/timezones.json.gz', '/etc/ssl/certs/ca-certificates.crt']) assert.ok(fs.existsSync(path), path);
for (const path of ['/app/.env', '/app/.certs', '/app/.git', '/app/tests', '/app/node_modules/tsx', '/app/node_modules/typescript', '/usr/local/lib/node_modules/npm', '/usr/bin/npm', '/usr/bin/yarn', '/bin/sh']) assert.ok(!fs.existsSync(path), path);
const jobs = new IcsWorkers();
try {
  const ics = await jobs.run({kind:'write', uid:'image-check', draft:{calendarId:'calendar', title:'Image check', description:'', location:'', start:'2026-10-04T09:00:00', end:'2026-10-04T10:00:00', timezone:'Europe/Prague', allDay:false, reminder:1440, recurrence:defaultRecurrence}});
  const detail = await jobs.run({kind:'detail', resource:{id:'event', calendarId:'calendar', etag:'"test"', ics}});
  assert.equal(detail.draft.title, 'Image check');
  assert.equal(detail.draft.start, '2026-10-04T09:00:00');
  assert.equal(detail.alarmCount, 1);
} finally { await jobs.close(); }
console.log(`Runtime verified: Node ${process.version}, UID ${process.getuid()}, compiled ICS workers and timezone data.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
'''
    print(docker('exec', container, '/nodejs/bin/node', '-e', probe))
    healthcheck = details['Config']['Healthcheck']['Test']
    assert healthcheck[0] == 'CMD'
    docker('exec', container, *healthcheck[1:])
    docker('stop', '--time', '15', container)
    assert json.loads(docker('inspect', container))[0]['State']['ExitCode'] == 0
    print('Image startup, HTTP, configured health check, runtime contents, and clean shutdown passed.')
except Exception:
    print(docker('logs', container), file=sys.stderr)
    raise
finally:
    docker('rm', '-f', container)
