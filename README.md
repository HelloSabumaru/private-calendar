# Private Calendar

A private CalDAV web calendar with month, week, day, and agenda views, search, ICS import/export, light/dark themes, calendar filtering, event editing, recurrence, and reminders. React and the Node.js API run behind one HTTPS origin. Your existing CalDAV server remains authoritative; there is no application database.

## Run with Docker

1. Copy `.env.example` to `.env`.
2. Set `APP_ORIGIN` to the browser-facing HTTPS origin and `CALDAV_URL` to your server's final authenticated CalDAV endpoint. Set `CALDAV_ALLOWED_PATHS` to include its principal and calendar-home paths. Credentials are entered on the login screen.
3. Run `docker compose up --build -d`.
4. Configure your existing reverse proxy to forward that HTTPS origin to `http://127.0.0.1:6742`. Set its request timeout to at least 60 seconds and its request body limit to 256 KiB or greater.

For example, an existing Caddy proxy can use:

```caddyfile
calendar.example.net {
    reverse_proxy 127.0.0.1:6742
}
```

The application binds to loopback on the host. If your proxy runs in another container, connect it to the same Docker network and use `calendar:6742`; do not expose the API separately from the frontend. `/healthz` reports application health and the bundled timezone version, without contacting CalDAV.

Username/password, app passwords, and bearer tokens are supported. A gateway must provide a CalDAV endpoint accepting one of these methods; interactive OAuth/SSO redirects are not followed. For Nextcloud, include `/remote.php/dav/` in the allowed paths. For Radicale at the server root, use `/`. Use narrower prefixes when your server layout permits them.

HTTPS certificates are always verified. For a private certificate authority, mount its PEM file and set `NODE_EXTRA_CA_CERTS` to the container path. A trusted private-network HTTP server requires the explicit `CALDAV_ALLOW_HTTP=true` setting. This affects only the upstream connection; the browser origin still uses HTTPS and secure cookies.

## Develop locally

Use Node.js 22.12 or later and npm.

To try disposable sample calendars:

```bash
npm ci --include=dev
npm run demo
```

Open `https://localhost:4173`, accept the local certificate warning, and sign in with username `user` and password `password`. Select October 2026 to see sample events. Restarting resets the sample data; Ctrl+C stops the demo.

To connect your own CalDAV server:

```bash
npm ci
cp .env.example .env
npm run dev:certs
npm run dev
```

For development, set `APP_ORIGIN=https://localhost:5173`, `HOST=127.0.0.1`, and `PORT=6742` in `.env`, and configure your real CalDAV endpoint. Open `https://localhost:5173`. Trust `.certs/localhost.pem` locally, or replace the certificate/key with locally trusted `mkcert` files. The Vite proxy keeps API requests on the frontend origin. Certificates, credentials, and `.env` are ignored by Git.

For a production build without Docker, run `npm run build` and `npm start` behind your HTTPS proxy.

## Behavior and limits

- Preferences persist in this browser per CalDAV account. Credentials, calendar contents, and drafts are never written to browser storage. Drafts survive failed saves and same-account reauthentication in the open tab; closing or reloading the tab loses them.
- Sessions remain in server memory and expire after 30 minutes without requests, or eight hours total. Background refresh counts as activity. Logout clears access and cached data. Restarting requires login again.
- Refresh runs on opening, navigation, changes, tab return, and every 60 seconds while visible. Incomplete refreshes display a warning and do not advance the last successful refresh time.
- Existing events stay in their calendar. Creation uses any writable calendar. Servers must report DAV permissions; missing permission information disables writes. Updates and deletions require a strong ETag.
- Choose one occurrence or the entire series when editing or deleting a repeating event. Single-occurrence changes preserve the original recurrence identity and create or update an exception; deleting an occurrence marks it cancelled. Individual edits are blocked for future-range changes. Exceptions and unsupported recurrence data are preserved. Metadata can be changed safely; schedule changes are blocked for series with exceptions or rules the editor cannot represent. Overrides retain their own content.
- Weekly selections must include the start weekday; an empty selection repeats on that weekday. Monthly events skip missing month days. Yearly February 29 events skip non-leap years. All-day end dates are exclusive in ICS and inclusive in the editor. Floating times use your display timezone.
- Nonexistent DST times are rejected. Repeated wall times require an offset choice. The later offset is represented as UTC for ordinary events; recurring events use iCalendar's earlier-offset convention.
- Reminders are stored as VALARM for delivery by other clients. Standard DISPLAY reminders can be replaced or removed; advanced alarms remain untouched. Reliable closed-browser notifications are outside this release.
- Failed saves retain drafts. Conflicts show the server version for explicit review. Uncertain outcomes are checked before retrying; creates keep a stable event identity even after reauthentication. Server transformations that prevent exact confirmation require review.
- Requests are limited to 120/minute per direct peer; login is limited to 10/minute. Forwarded client IP headers are not trusted. Deployments behind one proxy share its peer limit. API bodies are capped at 256 KiB, upstream responses at 10 MiB, and individual ICS resources at 1 MiB.
- Event ranges are capped at 93 days, 2,000 resources, and 16 MiB of source ICS. Recurrence output is capped at 10,000 occurrences with bounded iteration and isolated worker time/heap limits. Session resource caches are capped at 8 MiB each and 64 MiB total; unresolved mutation documents at 4 MiB each and 32 MiB total. Oversized or incomplete data is reported visibly.

- Dates use DD/MM/YYYY, with a 24-hour default. Week/day views use the selected first weekday and display timezone. Dragging into a date or time slot opens a draft for review; Save applies the move. Editing the start/end fields provides the same operation on touch screens and with a keyboard.
- Search checks title, location, and description in visible calendars across the chosen date range, up to one year and 1,000 matches. Searches ignore case and accents.
- Import ICS from More options, preview the event series, choose a writable calendar, and import. Files are limited to 200 kB and 100 series, with complete masters and their exceptions. Existing identities are retained; repeat imports use a stable destination, report Already exists, and leave server data untouched. Resolve a pending import with Check status before retrying or closing.
- Export a complete calendar from More options, or an individual event from its editor. Exports preserve source properties, alarms, exceptions, and timezone definitions. Calendar exports are bounded to 2,000 resources and 16 MiB. Different definitions with the same timezone name receive distinct export identifiers, preserving their event references and offsets.

Sharing/invitations, contacts/tasks, and offline writes are deferred.

## Verification

```bash
npm run typecheck
npm run lint
npm test
npx playwright install --with-deps chromium firefox webkit
npm run test:e2e
npm run test:interop
```

Browser tests use HTTPS with disposable mock calendars, including keyboard access, mobile layout, accessibility, draft retention, reauthentication, and logout. They never use your `.env` credentials.

If the demo is running, use `CALENDAR_TEST_PORT=4183 npm run test:e2e` to run browser tests on a separate port.

The interoperability test requires Python 3 with `venv`, installs pinned test dependencies in `.interop/venv`, and starts disposable local Radicale and application processes. An independent Python CalDAV client verifies edits in both directions, alarms and unsupported-property preservation, recurrence/DST, all-day dates, conflicts, occurrence editing/cancellation, ICS import/export, search, whole-series deletion, and logout. Test calendars live in a temporary directory and are removed afterward.

## Upgrade

1. Keep your `.env`, private CA mounts, and proxy configuration. Calendar data remains on CalDAV; use that server's usual backup procedure.
2. Update the application source, run the verification commands, and review configuration changes.
3. Run `docker compose build --pull` followed by `docker compose up -d`. Check `/healthz`, sign in again, and inspect a disposable event with another client. No application data migration is required.
4. To roll back, rebuild the previous source/lockfile and recreate the container. Sessions are intentionally discarded.

Dependency versions and the container base digest are pinned. Update them deliberately and rerun verification. The bundled timezone data uses IANA release **2026e**, generated with `libical/vzic` commit `42f509c9a613874a04af0d35be166c703a77389f` in `--pure` mode. To regenerate it, install the C compiler, make, GLib development files, Git, curl, and Python, then run `bash scripts/update-timezones.sh`. For a newer release, update the release/checksum in that script and rerun the timezone tests. Update the Node.js base together with timezone data so its ICU timezone rules remain current.
