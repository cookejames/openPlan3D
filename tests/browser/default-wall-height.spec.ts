import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function exported(page: Page) {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSON', exact: true }).click();
  return JSON.parse(await readFile((await (await pending).path())!, 'utf8'));
}

async function importJSON(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import JSON', exact: true }).click();
  await (await chooser).setFiles(file);
}

async function openProjectSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByRole('button', { name: 'Project', exact: true }).click();
  return dialog;
}

async function closeSettings(page: Page) {
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
}

/** Draw one wall in empty space to the left of the plan. */
async function drawWall(page: Page) {
  const canvas = page.locator('canvas[aria-label="Floor plan editor canvas"]');
  const box = (await canvas.boundingBox())!;
  await page.getByRole('button', { name: 'Save', exact: true }).press('w');
  await page.mouse.click(box.x + 40, box.y + box.height - 60);
  await page.mouse.click(box.x + 40, box.y + box.height - 160);
  await page.keyboard.press('Escape');
}

const newWalls = (before: any, after: any) =>
  after.floors[0].walls.filter((wall: { id: string }) => !before.floors[0].walls.some((item: { id: string }) => item.id === wall.id));

test('each project keeps its own Default wall height from the Project tab', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    localStorage.setItem('o3d_tips_seen', JSON.stringify(['first-wall', 'first-furniture', 'first-3d', 'first-export', 'first-door']));
  });
  await page.goto('/editor');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await importJSON(page, resolve('tests/fixtures/connected-dimensions.openplan.json'));
  const original = await exported(page);
  expect(original.defaultWallHeight).toBeUndefined();

  let dialog = await openProjectSettings(page);
  let height = dialog.getByRole('spinbutton', { name: 'Default wall height (cm)', exact: true });
  const reset = dialog.getByRole('button', { name: 'Use default wall height', exact: true });
  await expect(height).toHaveValue('280');
  await expect(reset).toBeDisabled();
  await height.fill('250'); await height.press('Tab');
  await expect(height).toHaveValue('250');
  // Blank or unusable drafts restore the project's value, like the slab thickness fields.
  for (const value of ['', '0', '-5']) {
    await height.fill(value); await height.press('Tab');
    await expect(height).toHaveValue('250');
  }
  await expect(reset).toBeEnabled();
  await closeSettings(page);

  await drawWall(page);
  const edited = await exported(page);
  expect(edited.defaultWallHeight).toBe(250);
  const added = newWalls(original, edited);
  expect(added.length).toBeGreaterThan(0);
  for (const wall of added) expect(wall).toMatchObject({ height: 250, startHeight: 250, endHeight: 250 });
  for (const wall of original.floors[0].walls) expect(edited.floors[0].walls.find((item: { id: string }) => item.id === wall.id)).toEqual(wall);

  // Saved with the project and restored after a reload.
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved ✓', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  dialog = await openProjectSettings(page);
  await expect(dialog.getByRole('spinbutton', { name: 'Default wall height (cm)', exact: true })).toHaveValue('250');
  await closeSettings(page);

  // A different project brings its own value, and new walls there use it.
  const other = { ...original, id: 'qa-default-wall-height-other', name: 'Other default height', defaultWallHeight: 320 };
  await importJSON(page, { name: 'other.openplan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(other)) });
  await expect(page.getByText('Other default height').first()).toBeVisible();
  dialog = await openProjectSettings(page);
  height = dialog.getByRole('spinbutton', { name: 'Default wall height (cm)', exact: true });
  await expect(height).toHaveValue('320');
  await closeSettings(page);
  const otherBefore = await exported(page);
  expect(otherBefore.defaultWallHeight).toBe(320);
  await drawWall(page);
  const otherAfter = await exported(page);
  for (const wall of newWalls(otherBefore, otherAfter)) expect(wall).toMatchObject({ height: 320, startHeight: 320, endHeight: 320 });

  // Resetting removes the project's value; new walls go back to 280 cm.
  dialog = await openProjectSettings(page);
  await dialog.getByRole('button', { name: 'Use default wall height', exact: true }).click();
  await expect(dialog.getByRole('spinbutton', { name: 'Default wall height (cm)', exact: true })).toHaveValue('280');
  await closeSettings(page);
  expect((await exported(page)).defaultWallHeight).toBeUndefined();
});
