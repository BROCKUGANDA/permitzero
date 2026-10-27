import { expect, fileActionViaApi, loadAuth, seedSession, test } from './fixtures.js';

test.describe('actions list', () => {
  test.beforeAll(async ({}, testInfo) => {
    const auth = await loadAuth();
    const tag = String(testInfo.workerIndex);
    await fileActionViaApi(auth, {
      purpose: 'List probe authorized payment',
      invoice: 'INV-2041',
      amount: '3000.00',
      runId: `e2e-list-allow-${tag}`,
    });
    await fileActionViaApi(auth, {
      purpose: 'List probe refused payment',
      invoice: 'INV-2042',
      amount: '75000.00',
      runId: `e2e-list-deny-${tag}`,
    });
  });

  test('lists requests and opens the detail view', async ({ page, auth }) => {
    await seedSession(page, auth.ownerToken);
    await page.goto('/actions');
    await expect(page.getByRole('heading', { name: 'Actions' })).toBeVisible();
    await expect(page.getByRole('link', { name: /List probe authorized payment/ }).first()).toBeVisible();
    await page
      .getByRole('link', { name: /List probe authorized payment/ })
      .first()
      .click();
    await page.waitForURL(/\/actions\/act_/);
    await expect(page.getByRole('heading', { name: 'List probe authorized payment' })).toBeVisible();
  });

  test('state filter narrows the list', async ({ page, auth }) => {
    await seedSession(page, auth.ownerToken);
    await page.goto('/actions');
    await page.getByLabel('State').click();
    await page.getByRole('option', { name: 'denied' }).click();
    await expect(page.getByRole('link', { name: /List probe refused payment/ }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /List probe authorized payment/ })).toHaveCount(0);
  });

  test('agent id filter narrows the list', async ({ page, auth }) => {
    await seedSession(page, auth.ownerToken);
    await page.goto('/actions');
    await page.getByLabel('Agent ID').fill('agt_DOESNOTEXIST');
    await expect(page.getByText('No actions here')).toBeVisible();
  });
});
