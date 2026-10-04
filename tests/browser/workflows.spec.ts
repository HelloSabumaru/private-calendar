import { expect, test, type Page } from '@playwright/test';

type HeldWindow = Window & { workflowHeld: Record<string, { release: () => void; completed: boolean }> };

async function holdResponse(page: Page, key: string, path: string, method = 'GET', replacement?: { status: number; body: unknown }) {
  await page.evaluate(({ key, path, method, replacement }) => {
    const target = window as unknown as HeldWindow;
    target.workflowHeld ??= {};
    const fetch = window.fetch.bind(window);
    let intercepted = false;
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (intercepted || !url.startsWith(path) || (init?.method ?? 'GET') !== method) return fetch(input, init);
      intercepted = true;
      // Ignore abort here to verify the response guard independently of fetch cancellation.
      const response = await fetch(input, { ...init, signal: undefined });
      await new Promise<void>(release => { target.workflowHeld[key] = { release, completed: false }; });
      target.workflowHeld[key].completed = true;
      return replacement ? new Response(JSON.stringify(replacement.body), { status: replacement.status, headers: { 'Content-Type': 'application/json' } }) : response;
    };
  }, { key, path, method, replacement });
}
async function waitForHeld(page: Page, key: string) {
  await expect.poll(() => page.evaluate(key => !!(window as unknown as HeldWindow).workflowHeld?.[key], key)).toBe(true);
}
async function releaseResponse(page: Page, key: string) {
  await page.evaluate(key => (window as unknown as HeldWindow).workflowHeld[key].release(), key);
  await expect.poll(() => page.evaluate(key => (window as unknown as HeldWindow).workflowHeld[key].completed, key)).toBe(true);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function expire(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event('calendar:expired')));
  await expect(page.getByRole('heading', { name: 'Calendar', exact: true })).toBeVisible();
}
async function submitLogin(page: Page) {
  await page.getByLabel('Username', { exact: true }).fill('user');
  await page.getByLabel('Password', { exact: true }).fill('password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
async function signIn(page: Page) {
  await submitLogin(page);
  await expect(page.getByLabel('Username', { exact: true })).toHaveCount(0);
  await expect(page.locator('.month-navigation h1')).toBeVisible();
}

test.beforeEach(async ({ page, request }) => {
  await request.post('/_test/reset');
  await page.clock.setFixedTime(new Date('2026-10-04T08:00:00Z'));
  await page.goto('/');
  await signIn(page);
  await expect(page.getByRole('button', { name: /Morning walk/ }).first()).toBeVisible();
});

test('reloading an active session leaves sign-in available after expiry', async ({ page }) => {
  await page.reload();
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await expire(page);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
  await signIn(page);
  await expect(page.getByRole('button', { name: /Morning walk/ }).first()).toBeVisible();
});

for (const transition of ['expiry', 'logout'] as const) {
  test(`a delayed event cannot reopen after ${transition} and reauthentication`, async ({ page }) => {
    await holdResponse(page, 'event', '/api/events/');
    await page.getByRole('button', { name: /Morning walk/ }).first().click();
    await waitForHeld(page, 'event');
    if (transition === 'expiry') await expire(page);
    else {
      await page.getByRole('button', { name: 'More options', exact: true }).click();
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Calendar', exact: true })).toBeVisible();
    }
    await signIn(page);
    await releaseResponse(page, 'event');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('Draft retained. Sign in to the same account.', { exact: true })).toHaveCount(0);
  });
}

for (const response of ['success', 'read-only error'] as const) {
  test(`a delayed event ${response} cannot replace the newer event draft`, async ({ page }) => {
    await holdResponse(page, 'event', '/api/events/', 'GET', response === 'success' ? undefined : { status: 422, body: { code: 'UNSUPPORTED', message: 'Old read-only event' } });
    await page.getByRole('button', { name: /Morning walk/ }).first().click();
    await waitForHeld(page, 'event');
    await page.getByRole('button', { name: /Lunch with Sam/ }).first().click();
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Lunch with Sam');
    await page.getByLabel('Title', { exact: true }).fill('Keep the newer draft');
    await releaseResponse(page, 'event');
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Keep the newer draft');
    await expect(page.getByText('Old read-only event', { exact: true })).toHaveCount(0);
  });
}

test('switching accounts discards retained drafts and ignores old event responses', async ({ page }) => {
  await page.getByRole('button', { name: 'New event', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Account A draft');
  await expire(page);
  await page.route('**/api/session', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), accountKey: 'another-account' } });
  });
  await signIn(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Morning walk/ }).first()).toBeVisible();
  await holdResponse(page, 'event', '/api/events/');
  await page.getByRole('button', { name: /Morning walk/ }).first().click();
  await waitForHeld(page, 'event');
  await expire(page);
  await page.unroute('**/api/session');
  await signIn(page);
  await page.getByRole('button', { name: 'New event', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Current account draft');
  await releaseResponse(page, 'event');
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Current account draft');
  await expect(page.getByRole('dialog')).toHaveCount(1);
});

test('an old 401 cannot cancel sign-in while its response is pending', async ({ page }) => {
  await holdResponse(page, 'event', '/api/events/', 'GET', { status: 401, body: { code: 'SESSION', message: 'Old session expired' } });
  await page.getByRole('button', { name: /Morning walk/ }).first().click();
  await waitForHeld(page, 'event');
  await expire(page);
  await holdResponse(page, 'login', '/api/session', 'POST');
  await submitLogin(page); await waitForHeld(page, 'login');
  await releaseResponse(page, 'event');
  await expect(page.getByRole('button', { name: 'Connecting…', exact: true })).toBeDisabled();
  await releaseResponse(page, 'login');
  await expect(page.getByRole('button', { name: /Morning walk/ }).first()).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('an obsolete successful sign-in cannot undo another expiry', async ({ page }) => {
  await expire(page);
  await holdResponse(page, 'login', '/api/session', 'POST');
  await submitLogin(page); await waitForHeld(page, 'login');
  await expire(page); await releaseResponse(page, 'login');
  await expect(page.getByRole('heading', { name: 'Calendar', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: /Morning walk/ })).toHaveCount(0);
});

test('background calendar refresh does not discard a search response', async ({ page }) => {
  await holdResponse(page, 'search', '/api/search?');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByLabel('Search events', { exact: true }).fill('Morning');
  await page.getByRole('dialog').getByRole('button', { name: 'Search', exact: true }).click();
  await waitForHeld(page, 'search');
  const refreshed = page.waitForResponse(response => response.url().includes('/api/events?') && response.ok());
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await refreshed;
  await releaseResponse(page, 'search');
  await expect(page.getByRole('dialog').getByRole('button', { name: /Morning walk/ })).toBeVisible();
});

test('old search errors cannot overwrite results after reauthentication', async ({ page }) => {
  await holdResponse(page, 'search', '/api/search?', 'GET', { status: 500, body: { code: 'OLD', message: 'Obsolete search failure' } });
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByLabel('Search events', { exact: true }).fill('Morning');
  await page.getByRole('dialog').getByRole('button', { name: 'Search', exact: true }).click();
  await waitForHeld(page, 'search');
  await expire(page); await signIn(page);
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByLabel('Search events', { exact: true })).toHaveValue('');
  await page.getByLabel('Search events', { exact: true }).fill('Lunch');
  await page.getByRole('dialog').getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: /Lunch with Sam/ })).toBeVisible();
  await releaseResponse(page, 'search');
  await expect(page.getByRole('dialog').getByRole('button', { name: /Lunch with Sam/ })).toBeVisible();
  await expect(page.getByText('Obsolete search failure', { exact: true })).toHaveCount(0);
});

const importICS = (titles: string[]) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Workflows//EN\r\n${titles.map((title, index) => `BEGIN:VEVENT\r\nUID:workflow-import-${index}\r\nDTSTAMP:20261001T000000Z\r\nDTSTART:20261008T090000Z\r\nDTEND:20261008T100000Z\r\nSUMMARY:${title}\r\nEND:VEVENT\r\n`).join('')}END:VCALENDAR\r\n`;
async function openImport(page: Page) {
  await page.getByRole('button', { name: 'More options', exact: true }).click();
  await page.getByRole('button', { name: 'Import ICS', exact: true }).click();
}

test('expiry during file reading prevents an import preview request', async ({ page }) => {
  await openImport(page);
  await page.evaluate(() => {
    const target = window as unknown as HeldWindow; target.workflowHeld = {};
    const read = File.prototype.text;
    File.prototype.text = async function () {
      const text = await read.call(this);
      await new Promise<void>(release => { target.workflowHeld.file = { release, completed: false }; });
      target.workflowHeld.file.completed = true; return text;
    };
  });
  const previewRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/import/preview')) previewRequests.push(request.url()); });
  await page.getByLabel('ICS file', { exact: true }).setInputFiles({ name: 'events.ics', mimeType: 'text/calendar', buffer: Buffer.from(importICS(['Held file event'])) });
  await waitForHeld(page, 'file'); await expire(page); await signIn(page);
  await releaseResponse(page, 'file');
  expect(previewRequests).toEqual([]);
  await expect(page.getByText('Held file event', { exact: true })).toHaveCount(0);
});

test('expiry stops an import loop while retaining its pending item for review', async ({ page }) => {
  await openImport(page);
  await page.getByLabel('ICS file', { exact: true }).setInputFiles({ name: 'events.ics', mimeType: 'text/calendar', buffer: Buffer.from(importICS(['First held import', 'Second import'])) });
  await expect(page.getByText('Second import', { exact: true })).toBeVisible();
  await holdResponse(page, 'import', '/api/import', 'POST');
  const importRequests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/import' && request.method() === 'POST') importRequests.push(request.url()); });
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await waitForHeld(page, 'import'); await expire(page); await signIn(page);
  await releaseResponse(page, 'import');
  expect(importRequests).toHaveLength(1);
  await expect(page.getByRole('heading', { name: 'Import ICS', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check status', exact: true })).toBeEnabled();
});

test('an interrupted save retains its draft and ignores the old failure during a new status check', async ({ page }) => {
  await page.getByRole('button', { name: 'New event', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Retained while checking');
  await holdResponse(page, 'save', '/api/events', 'POST', { status: 422, body: { code: 'OLD', message: 'Obsolete save failure' } });
  await page.getByRole('button', { name: 'Save event', exact: true }).click();
  await waitForHeld(page, 'save'); await expire(page); await signIn(page);
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Retained while checking');
  await holdResponse(page, 'status', '/api/operations/');
  await page.getByRole('button', { name: 'Check status', exact: true }).click(); await waitForHeld(page, 'status');
  await releaseResponse(page, 'save');
  await expect(page.getByRole('button', { name: 'Check status', exact: true })).toBeDisabled();
  await expect(page.getByText('Obsolete save failure', { exact: true })).toHaveCount(0);
  await releaseResponse(page, 'status');
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Retained while checking');
  await expect(page.getByRole('button', { name: 'Save event', exact: true })).toBeEnabled();
});
