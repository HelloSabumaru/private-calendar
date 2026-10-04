import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';

test.beforeEach(async ({ page, request }) => {
  await request.post('/_test/reset');
  await page.clock.setFixedTime(new Date('2026-10-04T08:00:00Z'));
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill('user');
  await page.getByLabel('Password', { exact: true }).fill('password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'October 2026' })).toBeVisible();
  await page.getByRole('button', { name: 'Choose date' }).click();
  await page.getByLabel('Date', { exact: true }).fill('04/10/2026');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await expect(page.getByRole('button', { name: /Morning walk/ })).toBeVisible();
});

test('month, agenda, calendar visibility, and keyboard navigation', async ({ page }) => {
  await page.getByRole('button', { name: 'Agenda', exact: true }).click();
  await expect(page.getByRole('button', { name: /Morning walk/ })).toBeVisible();
  await page.getByRole('button', { name: 'Calendars', exact: true }).click();
  await page.getByLabel('Personal', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByText('No events', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Personal', exact: true }).click();
  await expect(page.getByRole('button', { name: /Morning walk/ })).toBeVisible();
  await page.getByRole('button', { name: 'Month', exact: true }).click();
  const day = page.locator('[data-date="2026-10-04"]'); await day.focus(); await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-date="2026-10-05"]')).toBeFocused();
});
test('creates an all-day recurring event with a reminder and deletes its entire series', async ({ page }) => {
  await page.getByRole('button', { name: 'New event' }).click();
  await page.getByLabel('Title', { exact: true }).fill('Family day');
  await page.getByLabel('All-day').check();
  await page.getByLabel('All-day').uncheck();
  await expect(page.getByLabel('End', { exact: true })).toHaveValue('04/10/2026');
  await expect(page.getByLabel('End time', { exact: true })).toHaveValue('10:00');
  await page.getByLabel('All-day').check();
  await page.getByLabel('End', { exact: true }).fill('04/10/2026');
  await page.getByRole('combobox', { name: 'Repeat', exact: true }).selectOption('DAILY');
  await page.getByLabel('Series ends').selectOption('count');
  await page.getByLabel('Occurrence count').fill('2');
  await page.getByRole('combobox', { name: 'Reminder', exact: true }).selectOption('1440');
  await page.getByRole('button', { name: 'Save event', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: /Family day/ }).first()).toBeVisible();
  await page.getByRole('button', { name: /Family day/ }).first().click();
  await page.getByRole('button', { name: 'Entire series', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Edit series' })).toBeVisible();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Delete series' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible(); await expect(page.getByRole('button', { name: /Family day/ })).toHaveCount(0);
});
test('failed saves retain the draft and allow a safe retry', async ({ page }) => {
  await page.getByRole('button', { name: 'New event' }).click(); await page.getByLabel('Title', { exact: true }).fill('Retained draft');
  await page.route('**/api/events', async route => {
    if (route.request().method() === 'POST') await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ code: 'UPSTREAM_WRITE', message: 'The server rejected this change. Your draft is retained.' }) }); else await route.continue();
  });
  await page.getByRole('button', { name: 'Save event', exact: true }).click(); await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Retained draft');
  await expect(page.getByRole('alert')).toContainText('retained'); await page.unroute('**/api/events');
  await page.getByRole('button', { name: 'Save event', exact: true }).click(); await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: /Retained draft/ })).toHaveCount(1);
});
test('reauthentication preserves the open draft and logout removes access', async ({ page, request }) => {
  await page.getByRole('button', { name: 'New event' }).click(); await page.getByLabel('Title', { exact: true }).fill('Resume me');
  await request.post('/_test/expire');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
  await request.post('/_test/reset'); await page.getByLabel('Username', { exact: true }).fill('user'); await page.getByLabel('Password', { exact: true }).fill('password');
  await page.getByRole('button', { name: 'Sign in' }).click(); await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Resume me');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click(); await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
  await page.reload(); await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
});
test('preferences persist without storing event data or credentials', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings' }).click(); await page.getByLabel('Appearance').selectOption('dark'); await page.getByLabel('Time format').selectOption('true');
  await page.getByRole('button', { name: 'Save settings' }).click(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const persisted = await page.evaluate(() => JSON.stringify({ ...localStorage })); expect(persisted).not.toContain('password'); expect(persisted).not.toContain('Morning walk');
  await page.reload(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
test('another tab can renew the same account session without losing a draft', async ({ page, context }) => {
  await page.getByRole('button', { name: 'New event' }).click(); await page.getByLabel('Title', { exact: true }).fill('Across tabs');
  const other = await context.newPage(); await other.goto('/');
  await other.evaluate(async () => {
    const response = await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'basic', username: 'user', password: 'password' }) });
    if (!response.ok) throw new Error('Could not renew the session');
  });
  await page.bringToFront();
  await page.getByRole('button', { name: 'Save event', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible(); await expect(page.getByRole('button', { name: /Across tabs/ })).toHaveCount(1);
  await other.close();
});
test('conflicts retain the draft and reapply only changed fields after review', async ({ page, request }) => {
  await page.getByRole('button', { name: /Morning walk/ }).click();
  await page.getByLabel('Title', { exact: true }).fill('My morning walk');
  await request.post('/_test/change-location');
  await page.getByRole('button', { name: 'Save event', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review the latest version' })).toBeVisible();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('My morning walk');
  await page.getByRole('button', { name: 'Review and reapply draft' }).click();
  await expect(page.getByLabel('Location', { exact: true })).toHaveValue('Changed by another client');
  await page.getByRole('button', { name: 'Save event', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button', { name: /My morning walk/ }).click();
  await expect(page.getByLabel('Location', { exact: true })).toHaveValue('Changed by another client');
});
test('uncertain writes stay locked until checked and do not create duplicates', async ({ page, request }) => {
  await page.getByRole('button', { name: 'New event' }).click();
  await page.getByLabel('Title', { exact: true }).fill('Saved once');
  await request.post('/_test/uncertain');
  await page.getByRole('button', { name: 'Save event', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('being checked');
  await expect(page.getByLabel('Title', { exact: true })).toBeDisabled();
  await request.post('/_test/recover');
  await page.getByRole('button', { name: 'Check status', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: /Saved once/ })).toHaveCount(1);
});
test('mobile layout has accessible controls and no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-date="2026-10-06"]').click();
  await expect(page.getByRole('button', { name: /Lunch with Sam/ })).toBeVisible();
  await page.getByRole('button', { name: 'New event' }).click(); await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('Start', { exact: true })).toHaveValue('06/10/2026');
  await expect(page.getByLabel('Start time', { exact: true })).toHaveValue('09:00');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const editor = await page.getByRole('dialog').boundingBox();
    const start = await page.getByLabel('Start', { exact: true }).boundingBox();
    expect(editor?.x).toBe(0);
    expect(editor?.width).toBe(width);
    expect(start?.width).toBeGreaterThanOrEqual(120);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('calendar and event editor meet automated accessibility checks', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'New event' }).click();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New event' })).toBeFocused();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Appearance').selectOption('dark');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'New event' }).click();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});


test('week and day views navigate and create events in time slots', async ({ page }) => {
  await page.getByRole('button', { name: 'Week', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Week calendar' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Morning walk/ })).toBeVisible();
  await page.getByRole('button', { name: 'Next week', exact: true }).click();
  await expect(page.getByRole('button', { name: /Lunch with Sam/ })).toBeVisible();
  await page.getByRole('button', { name: 'Tuesday 6 October', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Day calendar' })).toBeVisible();
  await page.getByRole('button', { name: 'New event on Tuesday 6 October at 14:30', exact: true }).click();
  await expect(page.getByLabel('Start', { exact: true })).toHaveValue('06/10/2026');
  await expect(page.getByLabel('Start time', { exact: true })).toHaveValue('14:30');
  await expect(page.getByLabel('End time', { exact: true })).toHaveValue('15:30');
  await page.getByLabel('Title', { exact: true }).fill('Afternoon coffee');
  await page.getByRole('button', { name: 'Save event', exact: true }).click();
  await expect(page.getByRole('button', { name: /Afternoon coffee/ })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 844 });
  await page.getByRole('combobox', { name: 'Calendar view', exact: true }).selectOption('week');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('an uncertain deletion settles after an event read confirms absence', async ({ page, request }) => {
  const loaded = page.waitForResponse(response => /\/api\/events\/[^/?]+$/.test(response.url()) && response.ok());
  await page.getByRole('button', { name: /Morning walk/ }).click();
  const { id } = await (await loaded).json();
  await request.post('/_test/uncertain');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete event', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check status', exact: true })).toBeEnabled();
  await request.post('/_test/recover');
  expect(await page.evaluate(async id => (await fetch(`/api/events/${id}`)).status, id)).toBe(404);
  await page.getByRole('button', { name: 'Check status', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Morning walk/ })).toHaveCount(0);
});

test('the repeated autumn hour has distinct positions, offsets, and selectable slots', async ({ page, request }) => {
  await request.post('/_test/dst');
  await page.getByRole('button', { name: 'Choose date', exact: true }).click();
  await page.getByLabel('Date', { exact: true }).fill('25/10/2026');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await page.getByRole('button', { name: 'Day', exact: true }).click();
  const across = page.getByRole('button', { name: /Across the clock change/ });
  await expect(across).toBeVisible();
  await expect(across).toHaveCSS('height', '88px');
  await expect(across).toContainText('02:30 UTC+02:00 – 02:30 UTC+01:00');
  await expect(page.locator('.time-column')).toHaveCSS('height', '2200px');
  await expect(page.getByRole('button', { name: /First repeated hour/ })).toHaveCSS('top', '176px');
  await expect(page.getByRole('button', { name: /Second repeated hour/ })).toHaveCSS('top', '264px');
  for (const choice of ['later', 'earlier'] as const) {
    const offset = choice === 'earlier' ? '+02:00' : '+01:00';
    const slot = page.getByRole('button', { name: `New event on Sunday 25 October at 02:30 UTC${offset}`, exact: true });
    await slot.scrollIntoViewIfNeeded();
    const box = (await slot.boundingBox())!;
    await slot.click({ position: { x: box.width - 8, y: 32 } });
    await expect(page.getByLabel('Start time', { exact: true })).toHaveValue('02:30');
    await expect(page.getByLabel('End time', { exact: true })).toHaveValue(choice === 'earlier' ? '02:30' : '03:30');
    await expect(page.getByRole('combobox', { name: 'Start offset', exact: true })).toHaveValue(choice);
    await page.getByLabel('Title', { exact: true }).fill(`${choice} slot event`);
    await page.getByRole('button', { name: 'Save event', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: new RegExp(`${choice} slot event`) })).toHaveCSS('height', '88px');
  }
  const target = page.getByRole('button', { name: 'New event on Sunday 25 October at 02:00 UTC+02:00', exact: true });
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  await across.dragTo(target, { targetPosition: { x: box.width - 8, y: 32 } });
  await expect(page.getByLabel('Start time', { exact: true })).toHaveValue('02:00');
  await expect(page.getByLabel('End time', { exact: true })).toHaveValue('02:00');
  await expect(page.getByRole('combobox', { name: 'Start offset', exact: true })).toHaveValue('earlier');
  await expect(page.getByRole('combobox', { name: 'End offset', exact: true })).toHaveValue('later');
  await page.getByRole('button', { name: 'Save event', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(across).toHaveCSS('height', '88px');
  await expect(across).toHaveCSS('top', '176px');
});

test('a DST week labels the changed clocks within its day column', async ({ page, request }) => {
  await request.post('/_test/dst');
  await page.getByRole('button', { name: 'Choose date', exact: true }).click();
  await page.getByLabel('Date', { exact: true }).fill('25/10/2026');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await page.getByRole('button', { name: 'Week', exact: true }).click();
  await expect(page.getByRole('button', { name: /Across the clock change/ })).toHaveCSS('height', '88px');
  const sunday = page.locator('.time-column').last();
  await expect(sunday).toHaveCSS('height', '2200px');
  await expect(sunday.locator('.time-slot-label').filter({ hasText: 'UTC+02:00' }).first()).toBeAttached();
  await expect(sunday.locator('.time-slot-label').filter({ hasText: 'UTC+01:00' }).first()).toBeAttached();
  await expect(sunday.locator('.time-slot-label').filter({ hasText: /^0?3:00$/ })).toHaveCount(1);
});

test('the short spring day skips missing slots and creates one elapsed-hour events', async ({ page, request }) => {
  await request.post('/_test/dst');
  await page.getByRole('button', { name: 'Choose date', exact: true }).click();
  await page.getByLabel('Date', { exact: true }).fill('29/03/2026');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await page.getByRole('button', { name: 'Day', exact: true }).click();
  await expect(page.getByRole('button', { name: /Across the spring change/ })).toHaveCSS('height', '88px');
  await expect(page.locator('.time-column')).toHaveCSS('height', '2024px');
  await expect(page.getByRole('button', { name: 'New event on Sunday 29 March at 02:30', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'New event on Sunday 29 March at 01:00', exact: true }).click();
  await expect(page.getByLabel('End time', { exact: true })).toHaveValue('03:00');
  await page.getByLabel('Title', { exact: true }).fill('Spring slot event');
  await page.getByRole('button', { name: 'Save event', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Spring slot event/ })).toHaveCSS('height', '88px');
});

test('European dates reject invalid days and search matches accented locations', async ({ page }) => {
  await page.getByRole('button', { name: 'New event' }).click();
  await page.getByLabel('Title', { exact: true }).fill('Invalid date');
  await page.getByLabel('Start', { exact: true }).fill('31/02/2026');
  await page.getByRole('button', { name: 'Save event', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.getByLabel('Start', { exact: true }).evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(false);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByLabel('Search events').fill('CAFE');
  await page.getByRole('dialog').getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: /Lunch with Sam/ })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: /Lunch with Sam/ }).click();
  await expect(page.getByLabel('Start', { exact: true })).toHaveValue('06/10/2026');
  await expect(page.getByLabel('Start time', { exact: true })).toHaveValue('12:30');
});

test('single occurrence edits and deletions leave the rest of the series intact', async ({ page }) => {
  const recurring = page.getByRole('button', { name: /Stretch & reset/ });
  const count = await recurring.count();
  await recurring.first().click();
  await page.getByRole('button', { name: 'This occurrence', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Edit occurrence' })).toBeVisible();
  await page.getByLabel('Title', { exact: true }).fill('Just this stretch');
  await page.getByRole('button', { name: 'Save occurrence', exact: true }).click();
  await expect(recurring).toHaveCount(count - 1);
  await page.getByRole('button', { name: /Just this stretch/ }).click();
  await page.getByRole('button', { name: 'This occurrence', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete occurrence', exact: true }).click();
  await expect(page.getByRole('button', { name: /Just this stretch/ })).toHaveCount(0);
  await expect(recurring).toHaveCount(count - 1);
});

test('dragging changes the draft and preserves duration until explicitly saved', async ({ page }) => {
  await page.getByRole('button', { name: /Morning walk/ }).dragTo(page.locator('[data-date="2026-10-07"]'));
  await expect(page.getByRole('heading', { name: 'Edit event' })).toBeVisible();
  await expect(page.getByLabel('Start', { exact: true })).toHaveValue('07/10/2026');
  await expect(page.getByLabel('End time', { exact: true })).toHaveValue('10:00');
  await page.getByRole('button', { name: 'Save event', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('gridcell').filter({ has: page.locator('[data-date="2026-10-07"]') }).getByRole('button', { name: /Morning walk/ })).toBeVisible();
  await page.getByRole('button', { name: 'Day', exact: true }).click();
  await page.getByRole('button', { name: 'Choose date', exact: true }).click();
  await page.getByLabel('Date', { exact: true }).fill('07/10/2026');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await page.getByRole('button', { name: /Morning walk/ }).dragTo(page.getByRole('button', { name: 'New event on Wednesday 7 October at 11:30', exact: true }));
  await expect(page.getByLabel('Start time', { exact: true })).toHaveValue('11:30');
  await expect(page.getByLabel('End time', { exact: true })).toHaveValue('12:30');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: /Morning walk/ }).click();
  await expect(page.getByLabel('Start time', { exact: true })).toHaveValue('09:00');
});

const importICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Independent//EN\r\nBEGIN:VEVENT\r\nUID:browser-import\r\nDTSTAMP:20261001T000000Z\r\nDTSTART:20261008T090000Z\r\nDTEND:20261008T100000Z\r\nSUMMARY:Imported meeting\r\nX-UNSUPPORTED:keep\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-P1D\r\nDESCRIPTION:Remember\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

test('imports an ICS file and exports complete original calendar data', async ({ page }) => {

  await page.getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Import ICS', exact: true }).click();
  await page.getByLabel('ICS file').setInputFiles({ name: 'sample.ics', mimeType: 'text/calendar', buffer: Buffer.from(importICS) });
  await expect(page.getByRole('dialog').getByText('Imported meeting', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText('Imported', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: /Imported meeting/ })).toBeVisible();
  await page.getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Export calendar', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const file = await download;
  const data = await readFile((await file.path())!, 'utf8');
  expect(data).toContain('UID:browser-import'); expect(data).toContain('X-UNSUPPORTED:keep'); expect(data).toContain('TRIGGER:-P1D'); expect(data).toContain('UID:stretch');
});

test('new views and search remain accessible', async ({ page }) => {
  await page.getByRole('button', { name: 'Week', exact: true }).click();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Day', exact: true }).click();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});


test('uncertain imports stay locked and repeated imports report existing events', async ({ page, request }) => {
  const selectFile = async () => {
    await page.getByRole('button', { name: 'More options' }).click();
    await page.getByRole('button', { name: 'Import ICS', exact: true }).click();
    await page.getByLabel('ICS file').setInputFiles({ name: 'sample.ics', mimeType: 'text/calendar', buffer: Buffer.from(importICS) });
    await expect(page.getByRole('dialog').getByText('Imported meeting', { exact: true })).toBeVisible();
  };
  await selectFile(); await request.post('/_test/uncertain');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check status', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
  await expect(page.getByLabel('ICS file')).toBeDisabled();
  await request.post('/_test/recover');
  await page.getByRole('button', { name: 'Check status', exact: true }).click();
  await expect(page.getByText('Imported', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await selectFile();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText('Already exists', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: /Imported meeting/ })).toHaveCount(1);
});
