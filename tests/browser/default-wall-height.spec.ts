import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function exported(page: Page) {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSON', exact: true }).click();
  return JSON.parse(await readFile((await (await pending).path())!, 'utf8')).floors[0];
}

async function openDimensionSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByRole('button', { name: 'Dimensions', exact: true }).click();
  return dialog;
}

test('new walls take the Default wall height from Settings and existing walls keep theirs', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    localStorage.setItem('o3d_tips_seen', JSON.stringify(['first-wall', 'first-furniture', 'first-3d', 'first-export', 'first-door']));
  });
  await page.goto('/editor');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import JSON', exact: true }).click();
  await (await chooser).setFiles(resolve('tests/fixtures/connected-dimensions.openplan.json'));
  const original = await exported(page);

  let dialog = await openDimensionSettings(page);
  const height = dialog.getByRole('textbox', { name: 'Default wall height (cm)', exact: true });
  await expect(height).toHaveValue('280');
  // Invalid drafts keep the saved value; a value with its own unit is converted to cm.
  for (const value of ['', '0', '-5', 'tall']) {
    await height.fill(value); await height.press('Enter');
    await expect(height).toHaveValue('280');
  }
  await height.fill('2.5 m'); await height.press('Enter');
  await expect(height).toHaveValue('250');
  await dialog.getByRole('button', { name: 'ft, inch', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'Default wall height (in)', exact: true })).toHaveValue('98.4');
  await dialog.getByRole('button', { name: 'm, cm', exact: true }).click();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();

  // Draw one wall in empty space to the left of the plan.
  const canvas = page.locator('canvas[aria-label="Floor plan editor canvas"]');
  const box = (await canvas.boundingBox())!;
  await page.getByRole('button', { name: 'Save', exact: true }).press('w');
  await page.mouse.click(box.x + 40, box.y + box.height - 60);
  await page.mouse.click(box.x + 40, box.y + box.height - 160);
  await page.keyboard.press('Escape');

  const edited = await exported(page);
  const added = edited.walls.filter((wall: { id: string }) => !original.walls.some((item: { id: string }) => item.id === wall.id));
  expect(added.length).toBeGreaterThan(0);
  for (const wall of added) expect(wall).toMatchObject({ height: 250, startHeight: 250, endHeight: 250 });
  for (const wall of original.walls) expect(edited.walls.find((item: { id: string }) => item.id === wall.id)).toEqual(wall);

  // The setting is remembered after a reload.
  await page.reload();
  dialog = await openDimensionSettings(page);
  await expect(dialog.getByRole('textbox', { name: 'Default wall height (cm)', exact: true })).toHaveValue('250');
});
