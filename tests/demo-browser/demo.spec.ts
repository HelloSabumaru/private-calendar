import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.beforeEach(async ({ page, context }) => {
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:4184' || url.pathname.startsWith('/api')) return route.abort();
    return route.continue();
  });
  await page.clock.setFixedTime(new Date('2026-10-04T08:00:00Z'));
  await page.goto('./');
  await expect(page.getByRole('button', { name: /Morning walk/ }).first()).toBeVisible();
});

test('loads from a Pages subpath without login or API requests and supports views', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
  await expect(page.getByText('Sample calendar. Changes reset when you reload.')).toBeVisible();
  for (const view of ['Week', 'Day', 'Agenda', 'Month']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    await expect(page.getByRole('button', { name: /Morning walk/ }).first()).toBeVisible();
  }
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Appearance').selectOption('dark');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: /Morning walk/ }).first()).toBeVisible();
});

test('creates, updates, deletes and resets demo events', async ({ page }) => {
  await page.getByRole('button', { name: 'New event', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Browser-only event');
  await page.getByRole('button', { name: 'Save event', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: /Browser-only event/ }).first().click();
  await page.getByLabel('Title', { exact: true }).fill('Updated browser event');
  await page.getByRole('button', { name: 'Save event', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: /Updated browser event/ }).first().click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete event', exact: true }).click();
  await expect(page.getByRole('button', { name: /Updated browser event/ })).toHaveCount(0);
  await page.getByRole('button', { name: /Morning walk/ }).first().click();
  await page.getByLabel('Title', { exact: true }).fill('Changed sample');
  await page.getByRole('button', { name: 'Save event', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Changed sample/ }).first()).toBeVisible();
  await page.getByRole('button', { name: 'More options' }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Reset demo', exact: true }).click();
  await expect(page.getByRole('button', { name: /Morning walk/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Changed sample/ })).toHaveCount(0);
});

test('changes one occurrence and preserves the rest of the series', async ({ page }) => {
  await page.getByRole('button', { name: /Stretch and reset/ }).first().click();
  await page.getByRole('button', { name: 'This occurrence', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('One special occurrence');
  await page.getByRole('button', { name: 'Save occurrence', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /One special occurrence/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Stretch and reset/ }).first()).toBeVisible();
  await page.getByRole('button', { name: /One special occurrence/ }).first().click();
  await page.getByRole('button', { name: 'This occurrence', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete occurrence', exact: true }).click();
  await expect(page.getByRole('button', { name: /One special occurrence/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Stretch and reset/ }).first()).toBeVisible();
});

test('imports and exports ICS files entirely in the browser', async ({ page }) => {
  const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:demo-file\r\nDTSTART:20261004T120000Z\r\nDTEND:20261004T130000Z\r\nSUMMARY:Imported demo event\r\nX-KEEP:custom\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  for (const status of ['Imported', 'Already exists']) {
    await page.getByRole('button', { name: 'More options' }).click();
    await page.getByRole('button', { name: 'Import ICS', exact: true }).click();
    await page.getByLabel('ICS file').setInputFiles({ name: 'demo.ics', mimeType: 'text/calendar', buffer: Buffer.from(ics) });
    await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.getByText(status, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
  }
  await page.getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Export calendar', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const path = await (await download).path();
  const exported = await readFile(path!, 'utf8');
  expect(exported).toContain('SUMMARY:Imported demo event');
  expect(exported).toContain('X-KEEP:custom');
  expect(exported).toContain('SUMMARY:Morning walk');
});

test('renders an event across the repeated autumn hour at its actual duration', async ({ page }) => {
  await page.getByRole('button', { name: 'New event', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Across the clock change');
  await page.getByLabel('Start', { exact: true }).fill('25/10/2026');
  await page.getByLabel('End', { exact: true }).fill('25/10/2026');
  await page.getByLabel('Start time', { exact: true }).fill('02:30');
  await page.getByLabel('End time', { exact: true }).fill('02:30');
  await page.getByRole('button', { name: 'Save event', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('occurs twice');
  await page.getByRole('combobox', { name: 'Start offset', exact: true }).selectOption('earlier');
  await page.getByRole('combobox', { name: 'End offset', exact: true }).selectOption('later');
  await page.getByRole('button', { name: 'Save event', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Choose date' }).click();
  await page.getByLabel('Date', { exact: true }).fill('25/10/2026');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await page.getByRole('button', { name: 'Day', exact: true }).click();
  const event = page.getByRole('button', { name: /Across the clock change/ });
  await expect(event).toContainText('02:30 UTC+02:00 – 02:30 UTC+01:00');
  await expect(event).toHaveCSS('height', '88px');
});
