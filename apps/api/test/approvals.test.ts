/**
 * Human approvals: quorum math, binding to the reviewed hash and revision,
 * veto on reject, and the dual-control gate on bank-detail changes.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { insertInvoice, insertPurchaseOrder } from '@permitzero/db';
import { newId } from '@permitzero/domain';
import {
  closeApp,
  closeTestDb,
  freshApp,
  getJson,
  intakeBody,
  paymentArgs,
  postJson,
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

async function approvalAction(amountMinor = 3000000): Promise<IntakeResponse> {
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
    t.agentToken,
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

    const approved = await postJson(t, `/v1/actions/${action.action_id}/approve`, t.approver1Token, approveBody(action));
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
