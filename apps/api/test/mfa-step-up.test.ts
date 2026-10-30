/**
 * MFA step-up: the second factor, its enrolment, and the server-signed
 * assertion a policy can demand before it accepts an approval.
 *
 * The tests are in two halves. The first is pure — TOTP codes, the window,
 * the constant-time comparison — and needs no database. The second is the
 * flow a person actually walks: enrol, confirm, verify, ask for an assertion
 * for an action, and present it.
 *
 * Two rules are asserted throughout, because they are the two that make the
 * control real rather than decorative: a code is spent by the first endpoint
 * that accepts it, and an assertion is bound to the action it was issued for.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { insertInvoice, insertPurchaseOrder, withTenantTransaction } from '@permitzero/db';
import {
  deriveMfaAssertionKey,
  generateTotpSecret,
  totpCode,
  verifyMfaAssertion,
  verifyTotpCode,
} from '@permitzero/policy';
import { buildApp } from '../src/app.js';
import { createModelAdapter } from '../src/model.js';

import {
  closeApp,
  closeTestDb,
  freshApp,
  intakeBody,
  paymentArgs,
  postJson,
  testConfig,
  type ApiFixture,
} from './helpers.js';

const AUDIT_KEY = 'test-audit-hmac-key-for-mfa-step-up';

let t: ApiFixture;

beforeEach(async () => {
  t = await freshApp();
});

afterAll(async () => {
  await closeTestDb();
});

/**
 * Rebuild the app with a server key, WITHOUT reseeding.
 *
 * The file-level `beforeEach` has already seeded this test's fixture, so
 * calling `freshApp()` again would truncate and reseed — and the second seed
 * would run against a fixture whose tenant id had already been captured by
 * the caller. What these tests need is a different CONFIG, not different
 * data: the seeded fixture is the subject under test.
 *
 * The MFA routes are registered by `app.ts` itself, with the same prefix and
 * the same context, so the routes under test are the real ones rather than a
 * test-only copy. The route module is new and `app.ts` was owned by another
 * agent while it was written, so this file mounted it locally first; now that
 * the registration is in `app.ts`, mounting it again would declare the same
 * path twice and the app would refuse to start.
 */
async function appWithAuditKey(key: string | null): Promise<void> {
  await closeApp(t);
  const config = { ...testConfig(), modelProvider: 'disabled' as const, auditHmacKey: key };
  const { app } = await buildApp({
    db: t.db,
    dbRuntime: t.runtime,
    config,
    model: createModelAdapter(config.modelProvider),
  });
  t = { ...t, app };
}

interface ActionSummary {
  action_id: string;
  state: string;
  decision: string;
}

/** An action in the approval queue, so the step-up has something to bind to. */
async function approvalAction(invoiceId: string): Promise<ActionSummary> {
  await insertPurchaseOrder(t.db.db, {
    purchaseOrderId: `PO-${invoiceId}`,
    tenantId: t.tenantId,
    vendorId: 'VEN-017',
    amountMinor: BigInt(3000000),
    currency: 'USD',
  });
  await insertInvoice(t.db.db, {
    invoiceId,
    tenantId: t.tenantId,
    vendorId: 'VEN-017',
    amountMinor: BigInt(3000000),
    currency: 'USD',
    purchaseOrderId: `PO-${invoiceId}`,
  });
  const res = await postJson(
    t,
    '/v1/actions',
    t.agentToken,
    intakeBody(t.agentId, { arguments: paymentArgs({ invoice_id: invoiceId, amount_minor: 3000000 }) }),
  );
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json as ActionSummary;
}

interface EnrolResponse {
  secret: string;
  uri: string;
  algorithm: string;
  digits: number;
  period_seconds: number;
  enrolled: boolean;
}

async function enrol(token = t.approver1Token): Promise<EnrolResponse> {
  const res = await postJson(t, '/v1/me/mfa/enrol', token, {});
  expect(res.status).toBe(200);
  return res.json as EnrolResponse;
}

async function confirm(code: string, token = t.approver1Token): Promise<{ status: number; json: unknown }> {
  return postJson(t, '/v1/me/mfa/confirm', token, { code });
}

async function verify(code: string, token = t.approver1Token): Promise<{ status: number; json: unknown }> {
  return postJson(t, '/v1/me/mfa/verify', token, { code });
}

async function deleteMfa(token = t.approver1Token, code?: string): Promise<{ status: number; json: unknown }> {
  const res = await t.app.inject({
    method: 'DELETE',
    url: '/v1/me/mfa',
    headers: { authorization: `Bearer ${token}` },
    payload: code !== undefined ? { code } : undefined,
  });
  return { status: res.statusCode, json: res.json() as unknown };
}

/** The enrolment marker, read through the management pool. */
async function enrolledAt(userId: string): Promise<string | null> {
  const rows = await t.db.sql<{ mfa_enrolled_at: string | null }[]>`
    SELECT mfa_enrolled_at::text AS mfa_enrolled_at FROM users WHERE id = ${userId}`;
  return rows[0]?.mfa_enrolled_at ?? null;
}

/**
 * The code from the step that just ended.
 *
 * A code is spent by the first endpoint that accepts it, so confirming and
 * verifying have to use different codes. The previous step's code is still
 * inside the one-step drift window, which makes the pair deterministic
 * without waiting half a minute for the next code.
 */
function previousStepCode(secret: string): string {
  return totpCode(secret, Date.now() - 30_000);
}

function currentStepCode(secret: string): string {
  return totpCode(secret, Date.now());
}

// ---------------------------------------------------------------------------
// The factor itself
// ---------------------------------------------------------------------------

describe('totp', () => {
  it('accepts a code generated for the current time and refuses a wrong one', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const code = totpCode(secret, Date.now());
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyTotpCode(secret, code, Date.now())).toBe(true);
    expect(verifyTotpCode(secret, code === '000000' ? '111111' : '000000', Date.now())).toBe(false);
  });

  it('refuses a code from a step far outside the window', () => {
    const secret = generateTotpSecret();
    const stale = totpCode(secret, Date.now() - 10 * 60_000);
    expect(verifyTotpCode(secret, stale, Date.now())).toBe(false);
    // The same code is accepted when the window is wide enough to reach it,
    // which is what makes the window — not the comparison — the control.
    expect(verifyTotpCode(secret, stale, Date.now(), 20)).toBe(true);
  });

  it('refuses a code that is not six digits, and one from another secret', () => {
    const secret = generateTotpSecret();
    const other = generateTotpSecret();
    expect(verifyTotpCode(secret, '12345', Date.now())).toBe(false);
    expect(verifyTotpCode(secret, 'abcdef', Date.now())).toBe(false);
    expect(verifyTotpCode(secret, totpCode(other, Date.now()), Date.now())).toBe(false);
  });

  it('produces the same code for the same step and a different one for the next', () => {
    const secret = generateTotpSecret();
    const at = Date.now();
    expect(totpCode(secret, at)).toBe(totpCode(secret, at));
    expect(totpCode(secret, at)).not.toBe(totpCode(secret, at + 30_000));
  });
});

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

describe('mfa enrolment', () => {
  it('enrolment and confirmation set mfa_enrolled_at', async () => {
    await appWithAuditKey(AUDIT_KEY);
    const approverId = t.seeded.userIds['approver1'] ?? '';
    expect(await enrolledAt(approverId)).toBeNull();

    const enrolment = await enrol();
    expect(enrolment.enrolled).toBe(false);
    expect(enrolment.uri).toMatch(/^otpauth:\/\/totp\/PermitZero:/);
    expect(enrolment.algorithm).toBe('SHA1');
    expect(enrolment.digits).toBe(6);
    expect(enrolment.period_seconds).toBe(30);
    // A secret that was handed over but not proven is not an enrolment.
    expect(await enrolledAt(approverId)).toBeNull();

    const wrong = await confirm('000000' === currentStepCode(enrolment.secret) ? '111111' : '000000');
    expect(wrong.status).toBe(422);
    expect(await enrolledAt(approverId)).toBeNull();

    const confirmed = await confirm(previousStepCode(enrolment.secret));
    expect(confirmed.status).toBe(200);
    expect(confirmed.json).toMatchObject({ enrolled: true });
    expect(await enrolledAt(approverId)).not.toBeNull();
    await closeApp(t);
  });

  it('refuses to confirm the same code twice', async () => {
    await appWithAuditKey(AUDIT_KEY);
    const enrolment = await enrol();
    const code = previousStepCode(enrolment.secret);

    const first = await confirm(code);
    expect(first.status).toBe(200);

    // The code is spent. Presenting it again is a replay, and it is refused
    // as one rather than as a typo.
    const second = await confirm(code);
    expect(second.status).toBe(422);
    expect((second.json as { error: { message: string } }).error.message).toMatch(/already been used/i);
    await closeApp(t);
  });

  it('removes the secret and clears the marker', async () => {
    await appWithAuditKey(AUDIT_KEY);
    const approverId = t.seeded.userIds['approver1'] ?? '';
    const enrolment = await enrol();
    expect((await confirm(previousStepCode(enrolment.secret))).status).toBe(200);
    expect(await enrolledAt(approverId)).not.toBeNull();

    const removed = await deleteMfa(t.approver1Token, currentStepCode(enrolment.secret));
    expect(removed.status).toBe(200);
    expect(removed.json).toMatchObject({ deleted: true });
    expect(await enrolledAt(approverId)).toBeNull();

    const rows = await t.db.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM mfa_secrets`;
    expect(rows[0]?.n).toBe('0');

    // And there is nothing left to remove.
    expect((await deleteMfa()).status).toBe(404);
    await closeApp(t);
  });

  it('refuses to enrol an agent or a service credential', async () => {
    await appWithAuditKey(AUDIT_KEY);
    const agent = await postJson(t, '/v1/me/mfa/enrol', t.agentToken, {});
    expect(agent.status).toBe(403);
    const service = await postJson(t, '/v1/me/mfa/enrol', t.serviceToken, {});
    expect(service.status).toBe(403);
    await closeApp(t);
  });

  it('refuses to enrol without a server key to protect the secret with', async () => {
    await appWithAuditKey(null);
    const res = await postJson(t, '/v1/me/mfa/enrol', t.approver1Token, {});
    expect(res.status).toBe(409);
    await closeApp(t);
  });

  it('lets the runtime role move only mfa_enrolled_at on a user row', async () => {
    await appWithAuditKey(AUDIT_KEY);
    const approverId = t.seeded.userIds['approver1'] ?? '';
    const before = await t.db.sql<{ display_name: string }[]>`
      SELECT display_name FROM users WHERE id = ${approverId}`;

    // The write the enrolment needs: one column, on the account that belongs
    // to this tenant. It goes through the restricted runtime role, so this
    // only works because migration 0008 opened that one column.
    await withTenantTransaction(t.runtime, t.tenantId, async (tx) => {
      await tx.execute(sql`UPDATE users SET mfa_enrolled_at = now() WHERE id = ${approverId}`);
    });

    // Everything else on that row is still closed, and closed by the
    // DATABASE rather than by the application agreeing with itself.
    await expect(
      withTenantTransaction(t.runtime, t.tenantId, async (tx) =>
        tx.execute(sql`UPDATE users SET display_name = 'tampered' WHERE id = ${approverId}`),
      ),
    ).rejects.toThrow();

    const after = await t.db.sql<{ display_name: string }[]>`
      SELECT display_name FROM users WHERE id = ${approverId}`;
    expect(after[0]?.display_name).toBe(before[0]?.display_name);
    await closeApp(t);
  });
});

// ---------------------------------------------------------------------------
// The step-up
// ---------------------------------------------------------------------------

describe('mfa step-up', () => {
  it('refuses when MFA is not enrolled', async () => {
    await appWithAuditKey(AUDIT_KEY);
    const action = await approvalAction('INV-STEPUP-NONE');
    const res = await postJson(t, `/v1/actions/${action.action_id}/step-up`, t.approver1Token, {});
    expect(res.status).toBe(409);
    expect((res.json as { error: { message: string } }).error.message).toMatch(/not enrolled/i);
    await closeApp(t);
  });

  it('refuses when MFA is enrolled but not recently verified', async () => {
    await appWithAuditKey(AUDIT_KEY);
    const enrolment = await enrol();
    expect((await confirm(previousStepCode(enrolment.secret))).status).toBe(200);

    const action = await approvalAction('INV-STEPUP-STALE');
    const res = await postJson(t, `/v1/actions/${action.action_id}/step-up`, t.approver1Token, {});
    expect(res.status).toBe(403);
    expect((res.json as { error: { message: string } }).error.message).toMatch(/verification/i);
    await closeApp(t);
  });

  it('issues an assertion after a recent verification, and it verifies for that action', async () => {
    await appWithAuditKey(AUDIT_KEY);
    const enrolment = await enrol();
    expect((await confirm(previousStepCode(enrolment.secret))).status).toBe(200);
    expect((await verify(currentStepCode(enrolment.secret))).status).toBe(200);

    const action = await approvalAction('INV-STEPUP-OK');
    const res = await postJson(t, `/v1/actions/${action.action_id}/step-up`, t.approver1Token, {});
    expect(res.status).toBe(200);
    const assertion = (res.json as { mfa_context_ref: string }).mfa_context_ref;
    expect(assertion).toMatch(/^pzmfa\./);

    const verdict = verifyMfaAssertion(assertion, deriveMfaAssertionKey(AUDIT_KEY), {
      tenantId: t.tenantId,
      actorId: t.seeded.userIds['approver1'] ?? '',
      actionId: action.action_id,
      now: new Date(),
    });
    expect(verdict.ok).toBe(true);
    await closeApp(t);
  });

  it('binds the assertion to the action it was issued for', async () => {
    await appWithAuditKey(AUDIT_KEY);
    const enrolment = await enrol();
    expect((await confirm(previousStepCode(enrolment.secret))).status).toBe(200);
    expect((await verify(currentStepCode(enrolment.secret))).status).toBe(200);

    const first = await approvalAction('INV-STEPUP-A');
    const second = await approvalAction('INV-STEPUP-B');
    const issued = await postJson(t, `/v1/actions/${first.action_id}/step-up`, t.approver1Token, {});
    expect(issued.status).toBe(200);
    const assertion = (issued.json as { mfa_context_ref: string }).mfa_context_ref;

    const key = deriveMfaAssertionKey(AUDIT_KEY);
    const actorId = t.seeded.userIds['approver1'] ?? '';
    expect(
      verifyMfaAssertion(assertion, key, {
        tenantId: t.tenantId,
        actorId,
        actionId: first.action_id,
        now: new Date(),
      }).ok,
    ).toBe(true);

    // The same assertion presented for a different action is not an
    // assertion for that action.
    const other = verifyMfaAssertion(assertion, key, {
      tenantId: t.tenantId,
      actorId,
      actionId: second.action_id,
      now: new Date(),
    });
    expect(other.ok).toBe(false);
    expect(other.ok === false ? other.reason : '').toBe('SUBJECT_MISMATCH');
    await closeApp(t);
  });

  it('refuses an assertion signed with a different key', async () => {
    await appWithAuditKey(AUDIT_KEY);
    const enrolment = await enrol();
    expect((await confirm(previousStepCode(enrolment.secret))).status).toBe(200);
    expect((await verify(currentStepCode(enrolment.secret))).status).toBe(200);

    const action = await approvalAction('INV-STEPUP-KEY');
    const issued = await postJson(t, `/v1/actions/${action.action_id}/step-up`, t.approver1Token, {});
    expect(issued.status).toBe(200);
    const assertion = (issued.json as { mfa_context_ref: string }).mfa_context_ref;

    const forged = verifyMfaAssertion(assertion, deriveMfaAssertionKey('a-different-server-key'), {
      tenantId: t.tenantId,
      actorId: t.seeded.userIds['approver1'] ?? '',
      actionId: action.action_id,
      now: new Date(),
    });
    expect(forged.ok).toBe(false);
    expect(forged.ok === false ? forged.reason : '').toBe('BAD_SIGNATURE');
    await closeApp(t);
  });

  it('refuses a step-up for somebody who is not an approver', async () => {
    await appWithAuditKey(AUDIT_KEY);
    const enrolment = await enrol();
    expect((await confirm(previousStepCode(enrolment.secret))).status).toBe(200);
    expect((await verify(currentStepCode(enrolment.secret))).status).toBe(200);

    const action = await approvalAction('INV-STEPUP-ROLE');
    const operator = await postJson(t, `/v1/actions/${action.action_id}/step-up`, t.operatorToken, {});
    expect(operator.status).toBe(403);
    const auditor = await postJson(t, `/v1/actions/${action.action_id}/step-up`, t.auditorToken, {});
    expect(auditor.status).toBe(403);
    await closeApp(t);
  });

  it('refuses a step-up for an action that does not exist in this tenant', async () => {
    await appWithAuditKey(AUDIT_KEY);
    const enrolment = await enrol();
    expect((await confirm(previousStepCode(enrolment.secret))).status).toBe(200);
    expect((await verify(currentStepCode(enrolment.secret))).status).toBe(200);

    const res = await postJson(t, '/v1/actions/act_00000000000000000000000000/step-up', t.approver1Token, {});
    expect(res.status).toBe(404);
    await closeApp(t);
  });
});
