import { test as base, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface E2EAuth {
  tenantId: string;
  agentId: string;
  agentToken: string;
  ownerToken: string;
  approver1Token: string;
  approver2Token: string;
  operatorToken: string;
  auditorToken: string;
}

let cached: E2EAuth | null = null;

export async function loadAuth(): Promise<E2EAuth> {
  if (cached) return cached;
  const raw = await readFile(path.resolve('test-results', 'e2e-auth.json'), 'utf8');
  cached = JSON.parse(raw) as E2EAuth;
  return cached;
}

/** Sign in through the real login form, like an operator would. */
export async function signIn(page: Page, token: string): Promise<void> {
  await page.goto('/login');
  await page.getByPlaceholder('pz_…').fill(token);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('/');
}

/**
 * Sign in without touching the UI, for specs that start past login. The
 * token is planted before any page script runs, so the auth provider picks
 * it up on its very first render — no hydration race, no redirect flicker.
 */
export async function seedSession(page: Page, token: string): Promise<void> {
  await page.addInitScript((t) => window.localStorage.setItem('pz_token', t), token);
}

/** File an action straight at the API. For specs arranging their own data. */
export async function fileActionViaApi(
  auth: E2EAuth,
  input: { purpose: string; invoice: string; amount: string; runId: string },
): Promise<{ action_id: string; state: string }> {
  const apiPort = Number(process.env['E2E_API_PORT'] ?? 3101);
  const [major, minor = '00'] = input.amount.split('.');
  const res = await fetch(`http://127.0.0.1:${apiPort}/v1/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.agentToken}` },
    body: JSON.stringify({
      agent_id: auth.agentId,
      run_id: input.runId,
      task_purpose: input.purpose,
      tool_name: 'payment.execute',
      arguments: {
        invoice_id: input.invoice,
        vendor_id: 'VEN-017',
        amount_minor: Number(major) * 100 + Number(minor.padEnd(2, '0').slice(0, 2)),
        currency: 'USD',
        beneficiary_ref: 'BEN-017-VERIFIED',
      },
      evidence_refs: [],
      idempotency_key: `e2e-${input.runId}-${Date.now()}`,
      environment: 'DEMO',
    }),
  });
  if (!res.ok) throw new Error(`API intake failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { action_id: string; state: string };
}

interface Fixtures {
  auth: E2EAuth;
}

export const test = base.extend<Fixtures>({
  auth: async ({}, use) => {
    await use(await loadAuth());
  },
});

export { expect } from '@playwright/test';
