import { test, expect, devices } from '@playwright/test';

// A touch device opens the plan view-only with Pan Mode on, so a one-finger drag moves the plan;
// Enable editing goes back to selecting.
const { defaultBrowserType: _, ...phone } = devices['Pixel 7'];
test.use(phone);
test.skip(({ browserName }) => browserName !== 'chromium', 'Touch emulation (pointer: coarse) uses Chromium.');

test('view-only on a touch device starts in Pan Mode and Enable editing returns to selecting', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('o3d_tips_seen', JSON.stringify(['first-wall', 'first-furniture', 'first-3d', 'first-export', 'first-door'])));
  await page.goto('/editor');
  await expect(page.getByTestId('mobile-banner')).toBeVisible();
  const more = page.getByRole('button', { name: 'More actions', exact: true });
  const pan = page.getByRole('button', { name: /Pan Mode$/ });
  await more.click();
  await expect(pan).toHaveText('✓ Pan Mode');
  await page.keyboard.press('Escape');
  await page.getByTestId('mobile-enable-editing').click();
  await expect(page.getByTestId('mobile-banner')).toHaveCount(0);
  await more.click();
  await expect(pan).toHaveText('Pan Mode');
});
