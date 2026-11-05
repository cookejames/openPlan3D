import { expect, test, type Page } from '@playwright/test';

/** An empty floor with two map labels 1000 cm apart, used to turn plan centimetres into screen pixels. */
function plan() {
  const floor = {
    id: 'ground', name: 'Ground Floor', level: 0, walls: [], rooms: [], doors: [], windows: [], furniture: [], stairs: [], columns: [],
    guides: [], measurements: [], annotations: [], groups: [],
    textAnnotations: [
      { id: 'a', text: 'Map A', x: -500, y: -500, fontSize: 10, rotation: 0, color: '#555555' },
      { id: 'b', text: 'Map B', x: 500, y: -500, fontSize: 10, rotation: 0, color: '#555555' },
      { id: 'c', text: 'Map C', x: 500, y: 500, fontSize: 10, rotation: 0, color: '#555555' },
    ],
  };
  return { id: 'landscape-plan', name: 'Landscape plan', floors: [floor], activeFloorId: 'ground', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

async function open(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('o3d_tips_seen', JSON.stringify(['first-wall', 'first-furniture', 'first-3d', 'first-export', 'first-door']));
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      if ((text === 'Map A' || text === 'Map B') && this.canvas.getAttribute('aria-label') === 'Floor plan editor canvas') {
        const p = new DOMPoint(x, y).matrixTransform(this.getTransform()), b = this.canvas.getBoundingClientRect();
        if (text === 'Map B') (window as any).__mapFrame = ((window as any).__mapFrame ?? 0) + 1;
        ((window as any).__map ??= {})[text] = { x: b.x + p.x * b.width / this.canvas.width, y: b.y + p.y * b.height / this.canvas.height, width: b.width };
      }
      return maxWidth === undefined ? fill.call(this, text, x, y) : fill.call(this, text, x, y, maxWidth);
    };
  });
  await page.goto('/editor');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import JSON', exact: true }).click();
  const project = plan();
  await (await chooser).setFiles({ name: 'landscape.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)) });
  await expect(page.getByRole('button', { name: project.name, exact: true })).toBeVisible();
  const frame = await page.evaluate(() => (window as any).__mapFrame ?? 0);
  await page.getByTitle('Zoom to Fit (F)', { exact: true }).first().press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__mapFrame ?? 0)).toBeGreaterThan(frame);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

/** Screen position of plan point (x, y) in cm, from a frame drawn at the canvas's current size. Selecting an
 *  area opens the Properties panel and resizes the canvas, so wait for the redraw that follows. */
async function screen(page: Page, x: number, y: number) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect.poll(() => page.evaluate(() => {
    const m = (window as any).__map, b = document.querySelector('[aria-label="Floor plan editor canvas"]')!.getBoundingClientRect();
    return m?.['Map A']?.width === b.width && m?.['Map B']?.width === b.width;
  })).toBe(true);
  return page.evaluate(({ x, y }) => {
    const a = (window as any).__map['Map A'], b = (window as any).__map['Map B'], zoom = (b.x - a.x) / 1000;
    return { x: a.x + (x + 500) * zoom, y: a.y + (y + 500) * zoom };
  }, { x, y });
}

async function outline(page: Page, corners: [number, number][]) {
  for (const [x, y] of [...corners, corners[0]]) {
    const p = await screen(page, x, y);
    await page.mouse.click(p.x, p.y);
  }
}

/** Canvas pixel colour under plan point (x, y). */
async function pixel(page: Page, x: number, y: number) {
  const p = await screen(page, x, y);
  return page.evaluate(({ x, y }) => {
    const canvas = document.querySelector('[aria-label="Floor plan editor canvas"]') as HTMLCanvasElement;
    const r = canvas.getBoundingClientRect();
    const d = canvas.getContext('2d')!.getImageData(Math.round((x - r.x) * canvas.width / r.width), Math.round((y - r.y) * canvas.height / r.height), 1, 1).data;
    return [d[0], d[1], d[2]];
  }, p);
}

test('ground areas tile without overlapping, take a surface, toggle and undo', async ({ page }) => {
  test.setTimeout(90_000);
  await open(page);
  const background = await pixel(page, 150, 100), backgroundRight = await pixel(page, 450, 100);

  await page.getByRole('button', { name: 'Save', exact: true }).press('o');
  await outline(page, [[0, 0], [300, 0], [300, 200], [0, 200]]);
  await outline(page, [[300, 0], [600, 0], [600, 200], [300, 200]]);
  await expect(page.getByText("Ground areas can't overlap", { exact: false })).toBeHidden();
  await outline(page, [[100, 100], [400, 100], [400, 300], [100, 300]]);
  await expect(page.getByText("Ground areas can't overlap", { exact: false })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Save', exact: true }).press('l');
  await expect(page.getByRole('button', { name: /Grass 1/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Grass 2/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Grass 3/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save', exact: true }).press('l');

  const grass = await pixel(page, 150, 100);
  expect(grass).not.toEqual(background);

  // Select the first area and change its surface.
  await page.getByRole('button', { name: 'Save', exact: true }).press('v');
  const centre = await screen(page, 150, 100);
  await page.mouse.click(centre.x, centre.y);
  await expect(page.getByRole('heading', { name: 'Ground Area' })).toBeVisible();
  await page.getByRole('radio', { name: 'Gravel' }).last().click();
  await expect(page.getByRole('radio', { name: 'Gravel' }).last()).toHaveAttribute('aria-checked', 'true');

  // The status bar switch hides and shows the layer.
  const toggle = page.getByTitle('Show or hide landscaping in 2D and 3D');
  await toggle.click();
  await expect.poll(() => pixel(page, 450, 100)).toEqual(backgroundRight);
  await toggle.click();
  await expect.poll(() => pixel(page, 450, 100)).not.toEqual(backgroundRight);

  // Undo the surface change, then the second area.
  const undo = page.getByRole('button', { name: 'Undo', exact: true }).first();
  await undo.click();
  await page.mouse.click(centre.x, centre.y);
  await expect(page.getByRole('radio', { name: 'Grass' }).last()).toHaveAttribute('aria-checked', 'true');
  await undo.click();
  await expect.poll(() => pixel(page, 450, 100)).toEqual(backgroundRight);
});
