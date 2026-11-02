import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

// Runs against the Firebase emulators via `npm run test:e2e:cloud` (see playwright.cloud.config.ts).
const PROJECT = 'demo-openplan3d';
const FIRESTORE = `http://127.0.0.1:8080`;
const AUTH = `http://127.0.0.1:9099`;
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';

async function resetEmulators() {
  await fetch(`${FIRESTORE}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  // The admin token bypasses the security rules, which make config/access console-only.
  const res = await fetch(`${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/config/access`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { allowedEmails: { arrayValue: { values: [{ stringValue: ALICE }, { stringValue: BOB }] } } } }),
  });
  if (!res.ok) throw new Error(`Could not seed config/access: ${res.status}`);
}

async function newUser(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4189', viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    localStorage.setItem('hasSeenWelcome', 'true');
  });
  const page = await context.newPage();
  page.on('pageerror', error => { throw error; });
  return { context, page };
}

async function signIn(page: Page, email: string) {
  await page.goto('/');
  await page.waitForFunction(() => typeof (window as any).__o3dTestSignIn === 'function');
  await page.evaluate(address => (window as any).__o3dTestSignIn(address), email);
  await expect(page.getByRole('button', { name: 'Account menu', exact: true })).toBeVisible();
}

async function rename(page: Page, name: string) {
  await page.getByTitle('Click to rename', { exact: true }).click();
  const field = page.getByRole('textbox', { name: 'Project name', exact: true });
  await expect(field).toBeFocused();
  await page.keyboard.type(name);
  await page.keyboard.press('Enter');
  await expect(page.getByTitle('Click to rename', { exact: true })).toHaveText(name);
}

/** Ctrl+S saves locally and flushes the cloud push, so tests do not wait for the 5 s debounce. */
async function saveAndFlush(page: Page) {
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('sync-status')).toHaveText('Synced');
}

const card = (page: Page, name: string) =>
  page.locator('div.group', { has: page.getByRole('link', { name: `Open ${name}`, exact: true }) });

test('cloud sync: upload, share with an editor, conflict, remote notice and public link', async ({ browser }) => {
  test.setTimeout(180_000);
  await resetEmulators();
  const alice = await newUser(browser);
  const bob = await newUser(browser);
  const carol = await newUser(browser);
  const A = alice.page, B = bob.page, C = carol.page;

  await test.step('alice creates, edits and uploads a project', async () => {
    await signIn(A, ALICE);
    await A.getByRole('button', { name: 'New Project' }).first().click();
    await expect(A).toHaveURL(/\/editor\?id=/);
    await rename(A, 'Alice plan');
    await A.keyboard.press('Control+s');
    await expect(A.getByText('Saved ✓')).toBeVisible();
    await A.getByRole('link', { name: 'Projects' }).click();
    await expect(A).toHaveURL(/\/$/);
    await expect(A.getByText('You have 1 project only in this browser')).toBeVisible();
    await A.getByRole('button', { name: 'Upload all' }).click();
    await expect(card(A, 'Alice plan').getByText('Synced', { exact: true })).toBeVisible();
  });

  await test.step('alice adds bob as an editor', async () => {
    await A.getByRole('button', { name: 'Project actions for Alice plan' }).click();
    await A.getByRole('menuitem', { name: 'Share…' }).click();
    const dialog = A.getByRole('dialog');
    await dialog.getByLabel('Email address to add as editor').fill(BOB);
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(dialog.getByText(BOB, { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();
  });

  await test.step('bob sees it in the cloud and opens it', async () => {
    await signIn(B, BOB);
    await expect(card(B, 'Alice plan').getByText('In cloud', { exact: true })).toBeVisible();
    await B.getByRole('link', { name: 'Open Alice plan', exact: true }).first().click();
    await expect(B.getByTitle('Click to rename', { exact: true })).toHaveText('Alice plan');
    await expect(B.getByTestId('sync-status')).toHaveText('Synced');
  });

  await test.step('conflict: bob edits after alice, keeps his as a copy', async () => {
    await A.getByRole('link', { name: 'Open Alice plan', exact: true }).first().click();
    await expect(A.getByTitle('Click to rename', { exact: true })).toHaveText('Alice plan');
    await rename(A, 'Alice v2');
    await saveAndFlush(A);
    await expect(B.getByText('Updated by alice@example.com.')).toBeVisible();
    await rename(B, 'Bob edit');
    await B.keyboard.press('Control+s');
    await expect(B.getByText('This project was changed elsewhere.')).toBeVisible();
    await B.getByRole('button', { name: 'Keep mine as a copy' }).click();
    await expect(B.getByText(/Your version was saved as/)).toBeVisible();
    await expect(B.getByTitle('Click to rename', { exact: true })).toHaveText('Alice v2');
    await B.getByRole('link', { name: 'Projects' }).click();
    await expect(B.getByRole('link', { name: 'Open Bob edit (My version)', exact: true }).first()).toBeVisible();
    await expect(B.getByRole('link', { name: 'Open Alice v2', exact: true }).first()).toBeVisible();
    await B.getByRole('link', { name: 'Open Alice v2', exact: true }).first().click();
    await expect(B.getByTitle('Click to rename', { exact: true })).toHaveText('Alice v2');
  });

  await test.step('remote notice: bob is clean, alice changes it again', async () => {
    await expect(B.getByTestId('sync-status')).toHaveText('Synced');
    await rename(A, 'Alice v3');
    await saveAndFlush(A);
    const notice = B.getByRole('status').filter({ hasText: 'Updated by alice@example.com.' });
    await expect(notice).toBeVisible();
    await notice.getByRole('button', { name: 'Reload' }).click();
    await expect(B.getByTitle('Click to rename', { exact: true })).toHaveText('Alice v3');
    await expect(notice).toHaveCount(0);
  });

  let shareUrl = '';
  await test.step('alice turns on the public link', async () => {
    await A.getByRole('link', { name: 'Projects' }).click();
    await A.getByRole('button', { name: 'Project actions for Alice v3' }).click();
    await A.getByRole('menuitem', { name: 'Share…' }).click();
    const dialog = A.getByRole('dialog');
    await dialog.getByRole('switch', { name: 'Public view link' }).click();
    const input = dialog.getByLabel('Public view link', { exact: true }).and(A.locator('input'));
    await expect(input).toHaveValue(/\/editor\?share=[a-f0-9]{32}$/);
    shareUrl = await input.inputValue();
  });

  await test.step('carol opens the link read-only and saves a copy', async () => {
    await C.goto(shareUrl);
    const banner = C.getByTestId('share-banner');
    await expect(banner).toContainText('Alice v3');
    await expect(C.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    await expect(C.getByRole('button', { name: 'Export', exact: true })).toBeVisible();
    await banner.getByRole('button', { name: 'Save a copy to this browser' }).click();
    await expect(C).toHaveURL(/\/editor\?id=/);
    await expect(C.getByTestId('share-banner')).toHaveCount(0);
    await expect(C.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    await expect(C.getByTitle('Click to rename', { exact: true })).toContainText('Alice v3');
  });

  await test.step('alice turns sharing off', async () => {
    const dialog = A.getByRole('dialog');
    await dialog.getByRole('switch', { name: 'Public view link' }).click();
    await expect(dialog.getByRole('switch', { name: 'Public view link' })).toHaveAttribute('aria-checked', 'false');
    await C.goto(shareUrl);
    await expect(C.getByRole('alert')).toContainText('invalid or sharing has been turned off');
  });

  await Promise.all([alice.context.close(), bob.context.close(), carol.context.close()]);
});
