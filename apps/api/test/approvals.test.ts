/**
 * Human approvals: quorum math, binding to the reviewed hash and revision,
 * veto on reject, the dual-control gate on bank-detail changes, the four-eyes
 * rule that keeps the requester out of the approval, and the step-up
 * assertion a policy can demand before it accepts a decision.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildApProtectPolicyDocument,
  createRevision,
  insertInvoice,
  insertPurchaseOrder,
  publishRevision,
  withTenantTransaction,
} from '@permitzero/db';
import { newId } from '@permitzero/domain';
import { policyDocumentSchema } from '@permitzero/schemas';
import { deriveMfaAssertionKey, hashPolicyDocument, issueMfaAssertion } from '@permitzero/policy';
import { buildApp } from '../src/app.js';
import { createModelAdapter } from '../src/model.js';
import {
  closeApp,
  closeTestDb,
  freshApp,
  getJson,
  intakeBody,
  paymentArgs,
  postJson,
  testConfig,
  uniqueKey,
  type ApiFixture,
} from './helpers.js';

let t: ApiFixture;

beforeEach(async () => {
  t = await freshApp();
});

afterAll(async () => {
  await closeTestDb();
});

interface IntakeResponse {
  action_id: string;
  state: string;
  decision: string;
  action_hash: string;
  policy_revision: { id: string; revision_number: number; policy_hash: string } | null;
  approval: { required_approvals: number } | null;
}

async function approvalAction(amountMinor = 3000000, token?: string): Promise<IntakeResponse> {
  await insertPurchaseOrder(t.db.db, {
    purchaseOrderId: 'PO-APR-1',
    tenantId: t.tenantId,
    vendorId: 'VEN-017',
    amountMinor: BigInt(amountMinor),
    currency: 'USD',
  });
  await insertInvoice(t.db.db, {
    invoiceId: 'INV-APR-1',
    tenantId: t.tenantId,
    vendorId: 'VEN-017',
    amountMinor: BigInt(amountMinor),
    currency: 'USD',
    purchaseOrderId: 'PO-APR-1',
  });
  const res = await postJson(
    t,
    '/v1/actions',
    token ?? t.agentToken,
    intakeBody(t.agentId, { arguments: paymentArgs({ invoice_id: 'INV-APR-1', amount_minor: amountMinor }) }),
  );
  expect(res.status).toBe(201);
  return res.json as IntakeResponse;
}

function approveBody(action: IntakeResponse, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision: 'APPROVE',
    reason_code: 'EVIDENCE_REVIEWED',
    idempotency_key: uniqueKey('approval'),
    action_hash: action.action_hash,
    policy_revision_id: action.policy_revision?.id ?? '',
    ...overrides,
  };
}

describe('approvals', () => {
  it('completes a single-approval quorum; the agent collects the permit', async () => {
    const action = await approvalAction();
    expect(action.decision).toBe('REQUIRE_APPROVAL');

    const res = await postJson(t, `/v1/actions/${action.action_id}/approve`, t.approver1Token, approveBody(action));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      state: 'APPROVED',
      permit: null,
      approval_progress: {
        required_approvals: 1,
        approvals_received: 1,
        distinct_approvers: 1,
      },
    });

    // The human never sees the token; the agent collects it exactly once.
    const collected = await postJson(t, `/v1/actions/${action.action_id}/permit`, t.agentToken, {});
    expect(collected.status).toBe(201);
    expect((collected.json as { token: string }).token).toMatch(/^pzpt_/);
    const fetched = await getJson(t, `/v1/actions/${action.action_id}`, t.agentToken);
    expect(fetched.json).toMatchObject({
      state: 'PERMIT_ISSUED',
      permit: { audience: 'payment.execute' },
    });
    const again = await postJson(t, `/v1/actions/${action.action_id}/permit`, t.agentToken, {});
    expect(again.status).toBe(409);
    await closeApp(t);
  });

  it('refuses permit collection before quorum and by strangers', async () => {
    const action = await approvalAction();
    const early = await postJson(t, `/v1/actions/${action.action_id}/permit`, t.agentToken, {});
    expect(early.status).toBe(409);

    const approved = await postJson(
      t,
      `/v1/actions/${action.action_id}/approve`,
      t.approver1Token,
      approveBody(action),
    );
    expect(approved.status).toBe(200);
    const auditor = await postJson(t, `/v1/actions/${action.action_id}/permit`, t.auditorToken, {});
    expect(auditor.status).toBe(403);
    await closeApp(t);
  });

  it('rejects double decisions and decisions after quorum', async () => {
    const action = await approvalAction();
    const first = await postJson(t, `/v1/actions/${action.action_id}/approve`, t.approver1Token, approveBody(action));
    expect(first.status).toBe(200);

    const again = await postJson(t, `/v1/actions/${action.action_id}/approve`, t.approver1Token, approveBody(action));
    expect(again.status).toBe(409);

    const other = await postJson(t, `/v1/actions/${action.action_id}/approve`, t.approver2Token, approveBody(action));
    expect(other.status).toBe(409);
    await closeApp(t);
  });

  it('vetoes on the first reject', async () => {
    const action = await approvalAction();
    const rejected = await postJson(t, `/v1/actions/${action.action_id}/reject`, t.approver1Token, {
      decision: 'REJECT',
      reason_code: 'AMOUNT_UNJUSTIFIED',
      idempotency_key: uniqueKey('reject'),
    });
    expect(rejected.status).toBe(200);
    expect(rejected.json).toMatchObject({ state: 'REJECTED' });

    const late = await postJson(t, `/v1/actions/${action.action_id}/approve`, t.approver2Token, approveBody(action));
    expect(late.status).toBe(409);
    await closeApp(t);
  });

  it('invalidates reviews when the action or policy drifted', async () => {
    const action = await approvalAction();
    const driftedHash = await postJson(
      t,
      `/v1/actions/${action.action_id}/approve`,
      t.approver1Token,
      approveBody(action, { action_hash: `sha256:${'00'.repeat(32)}` }),
    );
    expect(driftedHash.status).toBe(409);
    expect(driftedHash.json).toMatchObject({ error: { code: 'APPROVAL_INVALIDATED' } });

    const driftedRevision = await postJson(
      t,
      `/v1/actions/${action.action_id}/approve`,
      t.approver1Token,
      approveBody(action, { policy_revision_id: newId('policyRevision') }),
    );
    expect(driftedRevision.status).toBe(409);
    expect(driftedRevision.json).toMatchObject({ error: { code: 'APPROVAL_INVALIDATED' } });
    await closeApp(t);
  });

  it('refuses non-approvers', async () => {
    const action = await approvalAction();
    const agent = await postJson(t, `/v1/actions/${action.action_id}/approve`, t.agentToken, approveBody(action));
    expect(agent.status).toBe(403);
    const operator = await postJson(t, `/v1/actions/${action.action_id}/approve`, t.operatorToken, approveBody(action));
    expect(operator.status).toBe(403);
    const auditor = await postJson(t, `/v1/actions/${action.action_id}/reject`, t.auditorToken, {
      decision: 'REJECT',
      reason_code: 'OTHER',
      idempotency_key: uniqueKey('reject'),
    });
    expect(auditor.status).toBe(403);
    await closeApp(t);
  });

  it('holds bank-detail changes for dual control plus independent verification', async () => {
    const created = await postJson(
      t,
      '/v1/actions',
      t.agentToken,
      intakeBody(t.agentId, {
        tool_name: 'vendor.update_bank_details',
        task_purpose: 'Rotate the vendor payout account',
        arguments: {
          vendor_id: 'VEN-017',
          new_beneficiary_ref: 'BEN-017-NEW',
          reason: 'Vendor letter dated 2026-10-01',
          verification_ref: null,
        },
      }),
    );
    expect(created.status).toBe(201);
    const action = created.json as IntakeResponse;
    expect(action.decision).toBe('REQUIRE_APPROVAL');
    expect(action.approval?.required_approvals).toBe(2);

    const first = await postJson(t, `/v1/actions/${action.action_id}/approve`, t.approver1Token, approveBody(action));
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({
      state: 'APPROVAL_REQUIRED',
      approval_progress: { distinct_approvers: 1, independent_verification_present: false },
    });

    // Two approvals but no out-of-band verification: still held.
    const second = await postJson(t, `/v1/actions/${action.action_id}/approve`, t.approver2Token, approveBody(action));
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({
      state: 'APPROVAL_REQUIRED',
      approval_progress: { distinct_approvers: 2, independent_verification_present: false },
    });

    const verified = await postJson(
      t,
      `/v1/actions/${action.action_id}/approve`,
      t.ownerToken,
      approveBody(action, { reason_code: 'VENDOR_VERIFIED_OUT_OF_BAND' }),
    );
    expect(verified.status).toBe(200);
    expect(verified.json).toMatchObject({
      state: 'APPROVED',
      approval_progress: { distinct_approvers: 3, independent_verification_present: true },
    });

    const collected = await postJson(t, `/v1/actions/${action.action_id}/permit`, t.agentToken, {});
    expect(collected.status).toBe(201);
    await closeApp(t);
  });

  it('expires the approval window instead of deciding late', async () => {
    const action = await approvalAction();
    await t.db.sql`UPDATE actions SET expires_at = now() - interval '1 second' WHERE action_id = ${action.action_id}`;
    const late = await postJson(t, `/v1/actions/${action.action_id}/approve`, t.approver1Token, approveBody(action));
    expect(late.status).toBe(409);
    const fetched = await getJson(t, `/v1/actions/${action.action_id}`, t.agentToken);
    expect(fetched.json).toMatchObject({ state: 'EXPIRED' });
    await closeApp(t);
  });
});

/**
 * Four eyes. The quorum counted distinct approvers, which is not the same
 * thing as an approver who is independent of the requester: an owner could
 * submit an action and then be its only approver, and a quorum of one would
 * have been satisfied.
 */
describe('four eyes', () => {
  it('refuses an approval from the requester of the action', async () => {
    // The owner submits the payment themselves…
    const action = await approvalAction(3000000, t.ownerToken);
    expect(action.decision).toBe('REQUIRE_APPROVAL');

    // …and cannot then approve it.
    const self = await postJson(t, `/v1/actions/${action.action_id}/approve`, t.ownerToken, approveBody(action));
    expect(self.status).toBe(403);
    expect(self.json).toMatchObject({ error: { code: 'FORBIDDEN' } });

    // The refusal left nothing behind: no decision, no movement.
    const fetched = await getJson(t, `/v1/actions/${action.action_id}`, t.ownerToken);
    expect(fetched.json).toMatchObject({
      state: 'APPROVAL_REQUIRED',
      approval_progress: { distinct_approvers: 0, approvals_received: 0 },
    });

    // A different principal may still approve it.
    const other = await postJson(t, `/v1/actions/${action.action_id}/approve`, t.approver1Token, approveBody(action));
    expect(other.status).toBe(200);
    expect(other.json).toMatchObject({ state: 'APPROVED' });
    await closeApp(t);
  });

  it('still reaches a quorum of two when the requester is one of the approvers', async () => {
    // Bank-detail changes need two approvals and independent verification.
    // The owner submits it, so the owner cannot be one of the two — the
    // quorum has to be reached by the people who are left.
    const created = await postJson(
      t,
      '/v1/actions',
      t.ownerToken,
      intakeBody(t.agentId, {
        tool_name: 'vendor.update_bank_details',
        task_purpose: 'Rotate the vendor payout account',
        arguments: {
          vendor_id: 'VEN-017',
          new_beneficiary_ref: 'BEN-017-NEW',
          reason: 'Vendor letter dated 2026-10-01',
          verification_ref: null,
        },
      }),
    );
    expect(created.status).toBe(201);
    const action = created.json as IntakeResponse;
    expect(action.decision).toBe('REQUIRE_APPROVAL');
    expect(action.approval?.required_approvals).toBe(2);

    const self = await postJson(t, `/v1/actions/${action.action_id}/approve`, t.ownerToken, approveBody(action));
    expect(self.status).toBe(403);

    // One approval is not two, and the requester's refusal did not count.
    const first = await postJson(
      t,
      `/v1/actions/${action.action_id}/approve`,
      t.approver1Token,
      approveBody(action, { reason_code: 'VENDOR_VERIFIED_OUT_OF_BAND' }),
    );
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({
      state: 'APPROVAL_REQUIRED',
      approval_progress: { distinct_approvers: 1, independent_verification_present: true },
    });

    // The second, independent approver closes it.
    const second = await postJson(t, `/v1/actions/${action.action_id}/approve`, t.approver2Token, approveBody(action));
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({
      state: 'APPROVED',
      approval_progress: { distinct_approvers: 2, independent_verification_present: true },
    });
    await closeApp(t);
  });
});

/**
 * `require_mfa` used to mean "the caller typed something in the box". It now
 * means "the server signed a step-up assertion for this approver, this action
 * and this tenant, and it has not expired".
 */
describe('mfa step-up', () => {
  const AUDIT_KEY = 'test-audit-hmac-key-for-mfa';

  /**
   * Rebuild the app with a different configuration, WITHOUT reseeding.
   *
   * The file-level `beforeEach` has already seeded this test's fixture, so
   * calling `freshApp()` again would truncate and reseed — and the second
   * seed would run against a fixture whose policy ids and tenant id had
   * already been captured by the caller. That produced a foreign-key failure
   * on a tenant that existed a moment earlier, which is a very confusing way
   * to learn that two fixtures disagree.
   *
   * What these tests actually need is a different CONFIG, not different data:
   * the seeded fixture is the subject under test.
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

  async function publishMfaPolicy(): Promise<void> {
    const policyId = t.seeded.policyIds[0] ?? '';
    const currentRevisionId = t.seeded.policyRevisionIds[0] ?? '';
    const base = buildApProtectPolicyDocument();
    const document = policyDocumentSchema.parse({
      ...base,
      rules: base.rules.map((rule) =>
        rule.id === 'approval-over-threshold'
          ? { ...rule, approval: { ...(rule.approval ?? {}), require_mfa: true } }
          : rule,
      ),
    });
    await withTenantTransaction(t.db, t.tenantId, async (tx) => {
      const revision = await createRevision(tx, {
        id: newId('policyRevision'),
        tenantId: t.tenantId,
        policyId,
        document,
        policyHash: hashPolicyDocument(document),
        changeReason: 'Test policy: approvals above the threshold require step-up.',
      });
      await publishRevision(tx, {
        tenantId: t.tenantId,
        policyId,
        revisionId: revision.revisionId,
        expectedCurrentRevisionId: currentRevisionId,
      });
    });
  }

  function assertion(actionId: string, actorId: string, key: Buffer, ttlMs = 300_000): string {
    const issuedAt = Date.now();
    return issueMfaAssertion({ tenantId: t.tenantId, actorId, actionId, issuedAt, expiresAt: issuedAt + ttlMs }, key);
  }

  it('accepts an approval only with a verifiable step-up assertion', async () => {
    await appWithAuditKey(AUDIT_KEY);
    await publishMfaPolicy();
    const action = await approvalAction();
    expect(action.decision).toBe('REQUIRE_APPROVAL');
    const approverId = t.seeded.userIds['approver1'] ?? '';

    // No assertion at all.
    const none = await postJson(t, `/v1/actions/${action.action_id}/approve`, t.approver1Token, approveBody(action));
    expect(none.status).toBe(422);
    expect(none.json).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });

    // A client string: the old control was satisfied by exactly this.
    const typed = await postJson(
      t,
      `/v1/actions/${action.action_id}/approve`,
      t.approver1Token,
      approveBody(action, { mfa_context_ref: 'x' }),
    );
    expect(typed.status).toBe(422);

    // A well-formed assertion signed with the wrong key.
    const forged = await postJson(
      t,
      `/v1/actions/${action.action_id}/approve`,
      t.approver1Token,
      approveBody(action, { mfa_context_ref: assertion(action.action_id, approverId, deriveMfaAssertionKey('wrong')) }),
    );
    expect(forged.status).toBe(422);

    // An assertion for a different action cannot be borrowed.
    const borrowed = await postJson(
      t,
      `/v1/actions/${action.action_id}/approve`,
      t.approver1Token,
      approveBody(action, {
        mfa_context_ref: assertion('act_00000000000000000000000000', approverId, deriveMfaAssertionKey(AUDIT_KEY)),
      }),
    );
    expect(borrowed.status).toBe(422);

    // An expired assertion is no assertion.
    const expired = await postJson(
      t,
      `/v1/actions/${action.action_id}/approve`,
      t.approver1Token,
      approveBody(action, {
        mfa_context_ref: assertion(action.action_id, approverId, deriveMfaAssertionKey(AUDIT_KEY), -1_000),
      }),
    );
    expect(expired.status).toBe(422);

    // The real thing: signed by the server for this approver and this action.
    const valid = await postJson(
      t,
      `/v1/actions/${action.action_id}/approve`,
      t.approver1Token,
      approveBody(action, {
        mfa_context_ref: assertion(action.action_id, approverId, deriveMfaAssertionKey(AUDIT_KEY)),
      }),
    );
    expect(valid.status).toBe(200);
    expect(valid.json).toMatchObject({ state: 'APPROVED' });
    await closeApp(t);
  });

  it('refuses a step-up assertion issued for a different approver', async () => {
    await appWithAuditKey(AUDIT_KEY);
    await publishMfaPolicy();
    const action = await approvalAction();
    const otherApproverId = t.seeded.userIds['approver2'] ?? '';
    const res = await postJson(
      t,
      `/v1/actions/${action.action_id}/approve`,
      t.approver1Token,
      approveBody(action, {
        mfa_context_ref: assertion(action.action_id, otherApproverId, deriveMfaAssertionKey(AUDIT_KEY)),
      }),
    );
    expect(res.status).toBe(422);
    await closeApp(t);
  });

  it('refuses every assertion when the server has no key to verify it with', async () => {
    // No `AUDIT_HMAC_KEY` means no key, which means a policy that requires
    // MFA cannot be satisfied. That is the fail-closed direction: the action
    // waits for a human with a verifiable step-up rather than being approved
    // on the strength of a string.
    await appWithAuditKey(null);
    await publishMfaPolicy();
    const action = await approvalAction();
    const approverId = t.seeded.userIds['approver1'] ?? '';
    const res = await postJson(
      t,
      `/v1/actions/${action.action_id}/approve`,
      t.approver1Token,
      approveBody(action, {
        mfa_context_ref: assertion(action.action_id, approverId, deriveMfaAssertionKey(AUDIT_KEY)),
      }),
    );
    expect(res.status).toBe(422);
    await closeApp(t);
  });
});
