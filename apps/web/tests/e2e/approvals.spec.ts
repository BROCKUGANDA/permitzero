import type { Page } from '@playwright/test';
import { expect, seedSession, test } from './fixtures';

/** File a $30,000 PO-backed payment: deterministic approval territory. Returns the detail URL. */
async function fileApprovalPayment(
  page: Page,
  auth: { agentId: string },
  invoice: string,
  purpose: string,
): Promise<string> {
  await page.goto('/actions/new');
  await page.getByLabel('Why does this need to happen?').fill(purpose);
  await page.getByLabel('Invoice').fill(invoice);
  await page.getByLabel('Vendor').fill('VEN-017');
  await page.getByLabel('Amount').fill('30000.00');
  await page.getByLabel('Currency').fill('USD');
  await page.getByLabel('Payout destination').fill('BEN-017-VERIFIED');
  // Agent sessions file under their own identity: prefilled and locked.
  await expect(page.getByLabel('Agent ID')).toHaveValue(auth.agentId);
  await expect(page.getByLabel('Agent ID')).toBeDisabled();
  await page.getByRole('button', { name: 'Submit for decision' }).click();
  await page.waitForURL(/\/actions\/act_/);
  return page.url();
}

test.describe('approvals', () => {
  test('approve → collect → execute ends in a verified receipt', async ({ page, auth }) => {
    await test.step('agent files a payment that needs a human', async () => {
      await seedSession(page, auth.agentToken);
      await fileApprovalPayment(page, auth, 'INV-E2E-1', 'Pay the data-center build invoice.');
      await expect(page.getByText('Awaiting approval')).toBeVisible();
      await expect(page.getByText('The amount needs a human signature.')).toBeVisible();
    });

    let detailUrl = '';
    await test.step('approver sees it in the decision queue and approves', async () => {
      await seedSession(page, auth.approver1Token);
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Needs your decision' })).toBeVisible();
      const row = page.getByRole('link', { name: /Pay the data-center build invoice/ }).first();
      await row.click();
      await page.waitForURL(/\/actions\/act_/);
      detailUrl = page.url();
      await expect(page.getByText('0 of 1 approvals')).toBeVisible();

      await page.getByRole('button', { name: 'Approve', exact: true }).click();
      await page.getByRole('button', { name: 'Record approval' }).click();
      await expect(page.getByText('Approved', { exact: true })).toBeVisible();
      await expect(page.getByText('1 of 1 approvals')).toBeVisible();
    });

    await test.step('agent collects the single-use token and executes', async () => {
      await seedSession(page, auth.agentToken);
      await page.goto(detailUrl);
      await page.getByRole('button', { name: 'Collect permit token' }).click();
      await expect(page.getByText('Copy this now — it will not be shown again')).toBeVisible();
      await page.getByRole('button', { name: 'Execute now' }).click();
      await expect(page.getByText('Executed with a verified receipt')).toBeVisible();
      await expect(page.getByText('$30,000.00').last()).toBeVisible();
      await expect(page.getByText('BEN-017-VERIFIED').last()).toBeVisible();
    });

    await test.step('the action settles as done', async () => {
      await page.goto(detailUrl);
      await expect(page.getByText('Done')).toBeVisible();
    });
  });

  test('one rejection stops the action for good', async ({ page, auth }) => {
    await seedSession(page, auth.agentToken);
    const detailUrl = await fileApprovalPayment(page, auth, 'INV-E2E-2', 'Pay the disputed invoice.');
    await expect(page.getByText('Awaiting approval')).toBeVisible();

    await seedSession(page, auth.approver1Token);
    await page.goto(detailUrl);
    await page.getByRole('button', { name: 'Reject', exact: true }).click();
    await page.getByRole('button', { name: 'Record rejection' }).click();
    await expect(page.getByText('Rejected')).toBeVisible();
    await expect(page.getByText('Nothing to do here — this request is settled.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  });
});
