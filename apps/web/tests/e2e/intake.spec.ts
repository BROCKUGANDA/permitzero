import { expect, seedSession, test } from './fixtures';

test.describe('intake', () => {
  test('a verified payment is authorized with its evidence', async ({ page, auth }) => {
    await seedSession(page, auth.agentToken);
    await page.goto('/actions/new');

    await page.getByLabel('Why does this need to happen?').fill('Pay the March hosting invoice.');
    await page.getByLabel('Invoice').fill('INV-2041');
    await page.getByLabel('Vendor').fill('VEN-017');
    await page.getByLabel('Amount').fill('3000.00');
    await page.getByLabel('Currency').fill('USD');
    await page.getByLabel('Payout destination').fill('BEN-017-VERIFIED');
    await expect(page.getByLabel('Agent ID')).toHaveValue(auth.agentId);
    await page.getByRole('button', { name: 'Submit for decision' }).click();

    await page.waitForURL(/\/actions\/act_/);
    await expect(page.getByRole('heading', { name: 'Pay the March hosting invoice.' })).toBeVisible();
    await expect(page.getByText('Permit ready')).toBeVisible();
    await expect(page.getByText('Allowed')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Why this decision' })).toBeVisible();
    await expect(page.getByText('The amount is within the automatic limit.')).toBeVisible();
  });

  test('an over-limit payment is denied with a plain-words reason', async ({ page, auth }) => {
    await seedSession(page, auth.agentToken);
    await page.goto('/actions/new');

    await page.getByLabel('Why does this need to happen?').fill('Pay the big invoice without review.');
    await page.getByLabel('Invoice').fill('INV-2042');
    await page.getByLabel('Vendor').fill('VEN-017');
    await page.getByLabel('Amount').fill('75000.00');
    await page.getByLabel('Currency').fill('USD');
    await page.getByLabel('Payout destination').fill('BEN-017-VERIFIED');
    await page.getByRole('button', { name: 'Submit for decision' }).click();

    await page.waitForURL(/\/actions\/act_/);
    await expect(page.getByText('Denied').first()).toBeVisible();
    await expect(page.getByText('The amount exceeds the hard limit.')).toBeVisible();
    await expect(page.getByText('Nothing to do here — this request is settled.')).toBeVisible();
  });

  test('empty fields are flagged before anything is sent', async ({ page, auth }) => {
    await seedSession(page, auth.agentToken);
    await page.goto('/actions/new');
    await page.getByRole('button', { name: 'Submit for decision' }).click();
    await expect(page.getByText('Say why this needs to happen.')).toBeVisible();
    await expect(page).toHaveURL('/actions/new');
  });

  test('a malformed amount is flagged inline', async ({ page, auth }) => {
    await seedSession(page, auth.agentToken);
    await page.goto('/actions/new');
    await page.getByLabel('Why does this need to happen?').fill('Pay something.');
    await page.getByLabel('Invoice').fill('INV-2041');
    await page.getByLabel('Vendor').fill('VEN-017');
    await page.getByLabel('Amount').fill('three thousand');
    await page.getByLabel('Currency').fill('USD');
    await page.getByLabel('Payout destination').fill('BEN-017-VERIFIED');
    await page.getByRole('button', { name: 'Submit for decision' }).click();
    await expect(page.getByText('Enter an amount like 3000.00.')).toBeVisible();
    await expect(page).toHaveURL('/actions/new');
  });
});
