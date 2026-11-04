import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function exportFloor(page: Page) {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSON', exact: true }).click();
  return JSON.parse(await readFile((await (await pending).path())!, 'utf8')).floors[0];
}

test('Height from floor edits furniture elevation with units, Undo/Redo and export', async ({ page }) => {
  const plan = JSON.parse(await readFile('tests/fixtures/connected-dimensions.openplan.json', 'utf8'));
  plan.floors[0].furniture = [{ id: 'cabinet', catalogId: 'desk', position: { x: 200, y: 150 }, rotation: 0, scale: { x: 1, y: 1, z: 1 } }];
  await page.goto('/editor');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import JSON', exact: true }).click();
  await (await chooser).setFiles({ name: 'elevation.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(plan)) });
  await page.getByRole('button', { name: 'Save', exact: true }).press('l');
  await page.getByRole('button', { name: '🖥️ Desk', exact: true }).click();

  const field = page.getByRole('spinbutton', { name: 'Height from floor (cm)', exact: true });
  await expect(field).toHaveValue('0');
  for (const draft of ['', '-5']) {
    await field.fill(draft); await field.press('Tab');
    await expect(field).toHaveValue('0');
  }
  expect((await exportFloor(page)).furniture[0].elevation).toBeUndefined();

  await field.fill('140'); await field.press('Tab');
  expect((await exportFloor(page)).furniture[0].elevation).toBe(140);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(field).toHaveValue('0');
  expect((await exportFloor(page)).furniture[0].elevation).toBeUndefined();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(field).toHaveValue('140');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Dimensions', exact: true }).click();
  await page.getByRole('button', { name: 'ft, inch', exact: true }).click();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  const inches = page.getByRole('spinbutton', { name: 'Height from floor (in)', exact: true });
  await expect(inches).toHaveValue(String(Math.round(140 / 2.54 * 10) / 10));
  await inches.fill('10'); await inches.press('Tab');
  expect((await exportFloor(page)).furniture[0].elevation).toBeCloseTo(25.4);
});
