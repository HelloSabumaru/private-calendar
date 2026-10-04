# Private Calendar

A private web calendar for CalDAV servers, including Radicale and Nextcloud. Calendar data stays on your server; the app has no database.

Includes month/week/day/agenda views, search, event and occurrence editing, drag-and-drop, ICS import/export, reminders, and themes.

## Try the demo

The demo runs entirely in your browser, with sample events around today and no account. Edits reset on reload; preferences persist in this browser.

To run it locally, use Node.js 22.12 or later and npm:

```bash
npm ci --include=dev
npm run demo
```

Open **http://127.0.0.1:4173**. Ctrl+C stops the local preview.

`npm run build:demo` creates `dist/demo`, which can also be served by any static host. Use `npm run preview:demo` to preview that build locally. Connecting to a real CalDAV account requires the server deployment below.

## Deploy with Docker

1. Copy `.env.example` to `.env`.
2. Set these values:

   | Setting | Value |
   |---|---|
   | `APP_ORIGIN` | Your browser-facing HTTPS origin, such as `https://calendar.example.net` |
   | `CALDAV_URL` | Your final authenticated CalDAV endpoint, without credentials |
   | `CALDAV_ALLOWED_PATHS` | Allowed path prefixes covering the endpoint, principal, and calendar home |

   Use `/remote.php/dav/` for Nextcloud, or `/` for Radicale at the root. Sign in with a username/password, app password, or bearer token. Interactive SSO is unsupported.

3. Run `docker compose up --build -d`.
4. Forward your HTTPS origin to `http://127.0.0.1:6742` using your reverse proxy. Allow requests of at least 256 KiB and a timeout of at least 60 seconds.

Example Caddy configuration:

```caddyfile
calendar.example.net {
    reverse_proxy 127.0.0.1:6742
}
```

For a proxy on the same Docker network, use `calendar:6742`. Frontend and API must share one HTTPS origin. Health check: `/healthz`.

For a private CalDAV CA, mount its PEM file readable by container UID **65532** and set `NODE_EXTRA_CA_CERTS` to that path. `CALDAV_ALLOW_HTTP=true` permits a trusted HTTP upstream; browser access still requires HTTPS. See [.env.example](.env.example) for other settings.

To use a published release, set `CALENDAR_IMAGE=ghcr.io/hellosabumaru/calendar:<version>` in `.env`, replacing `<version>` with a release tag, then run `docker compose up -d --no-build --pull always`. Release images support AMD64 and ARM64. Compose limits the container to 1 GiB of memory, two CPUs, and 128 processes; adjust these limits for your host and workload.

The runtime contains Node.js and application dependencies, without a shell or package managers. Run one application instance; sessions and pending operation status live in memory. After a restart, sign in and inspect the calendar before retrying an uncertain write.

## Develop with your own server

Create `.env` using the CalDAV settings above. Set `APP_ORIGIN=https://localhost:5173`, `HOST=127.0.0.1`, and `PORT=6742`, then run:

```bash
npm ci --include=dev
npm run dev:certs
npm run dev
```

Open **https://localhost:5173**. Trust `.certs/localhost.pem` locally, or replace the certificate and key with trusted `mkcert` files.

For production without Docker, use the production `.env` settings, run `npm run build` and `npm start`, and place the app behind your HTTPS proxy.

## Behavior and limits

- Dates use **DD/MM/YYYY**, with a 24-hour default. Preferences persist per account in this browser.
- Credentials and sessions stay in server memory; events and drafts are not stored in browser storage. Sessions expire after 30 idle minutes or eight hours by default. Restarting requires signing in again.
- Refresh runs after changes, navigation, tab return, and every 60 seconds while visible. Incomplete refreshes show a warning.
- Failed saves retain drafts; conflicts require review. Resolve uncertain saves/imports with **Check status** before retrying. Closing or reloading the tab loses drafts.
- Edit one occurrence or an entire series. Existing events stay in their calendar. Permissions and concurrent changes are respected; unsupported recurrence structures restrict editing. Alarms, exceptions, and unknown ICS properties are preserved.
- All-day end dates are inclusive in the editor, exclusive in ICS. Monthly/yearly recurrences skip missing dates; weekly selections must include the start weekday. Nonexistent DST times are rejected; repeated times require an offset choice.
- Dragging opens a draft; **Save** applies the move. Start/end fields also work with touch and keyboard controls.
- Search matches title, location, and description in visible calendars, ignoring case and accents.
- Import/export ICS through **More options**, or export an event from its editor. Repeat imports report **Already exists** and leave server data untouched.
- Reminders use `VALARM` for delivery by compatible clients. Closed-browser notifications, sharing/invitations, contacts/tasks, and offline writes are outside this release.

| Operation | Limit |
|---|---|
| Search | One year, 1,000 matches |
| ICS import | 200 kB, 100 series |
| Calendar reads/export | 2,000 resources, 16 MiB of source ICS |
| Event range | 93 days, 10,000 occurrences |

Requests default to 120/minute and logins to 10/minute per client IP, configurable with `RATE_LIMIT_REQUESTS` and `RATE_LIMIT_LOGINS`. Forwarded client addresses are ignored by default, so clients behind one proxy share its budget. Set `TRUSTED_PROXIES` to the comma-separated IPs or CIDRs of your proxies to give clients separate budgets. Use the proxy's source address as seen by the container; a host proxy may appear as the Docker network gateway. Your proxy must replace incoming forwarding headers, and direct access to the app must remain restricted.

## Verify

```bash
npm run typecheck
npm run lint
npm test
npx playwright install --with-deps chromium firefox webkit
npm run test:e2e
npm run test:demo
npm run test:interop
docker build -t private-calendar:check .
python3 scripts/test-image.py private-calendar:check
```

Tests use disposable calendars, without your `.env` credentials. If the demo is running, use `CALENDAR_TEST_PORT=4183 npm run test:e2e`. Interoperability tests require Python 3 with `venv` and install their dependencies automatically; they check the API against Radicale with an independent client.

## Upgrade and maintenance

Keep your `.env`, private CA mounts, and proxy configuration. Update the source, review configuration changes, and run the checks above, then:

```bash
docker compose build --pull
docker compose up -d
```

Check `/healthz` and sign in again. Back up data on CalDAV. To roll back, restore the previous source and lockfile, then rebuild.

Dependencies and the container base are pinned. Timezone data is IANA **2026e**; regenerate it with `bash scripts/update-timezones.sh` (requires a C compiler, make, GLib development files, Git, curl, and Python). For a new release, update the script's release/checksum and the Node.js base to keep ICU rules current.

Dependabot opens weekly updates for npm packages, both Docker base images, and GitHub Actions. Review and merge these updates through the checks above. Changing a pinned base digest requires a reviewed update; `--pull` alone keeps the existing digest.

## License

[MIT](LICENSE). Third-party dependencies retain their own licenses; browser notices are in [public/third-party-licenses.txt](public/third-party-licenses.txt).
