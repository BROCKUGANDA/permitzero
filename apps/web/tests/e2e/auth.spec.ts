import { expect, signIn, test } from './fixtures';

test.describe('auth', () => {
  test('sends visitors without a token to login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL('/login');
    await expect(page.getByRole('heading', { name: 'Sign in with a token' })).toBeVisible();
  });

  test('rejects a token that is too short to be real', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('pz_…').fill('short');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('That does not look like a token')).toBeVisible();
    await expect(page).toHaveURL('/login');
  });

  test('owner login lands on a healthy overview', async ({ page, auth }) => {
    await signIn(page, auth.ownerToken);
    await expect(page.getByRole('heading', { name: 'Good to see you, SYNTHETIC.' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Enforcement health' })).toBeVisible();
    await expect(page.getByText('Enforcing')).toBeVisible();
    await expect(page.getByText('Demonstration data')).toBeVisible();
  });

  test('sign out returns to login and locks the app', async ({ page, auth }) => {
    await signIn(page, auth.ownerToken);
    await page.getByRole('button', { name: /SYNTHETIC Owner/ }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL('/login');
    await page.goto('/');
    await expect(page).toHaveURL('/login');
  });
});
