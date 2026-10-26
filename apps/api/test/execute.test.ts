/**
 * Execution: permits spend exactly once through the broker, receipts prove
 * effects, and mode changes between intake and execute are still honored.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTenant, insertInvoice, insertPurchaseOrder, setEnforcementMode } from '@permitzero/db';
import { clearConnectorFaultProfile, setConnectorFaultProfile } from '@permitzero/broker';
import { newId } from '@permitzero/domain';
import {
  closeApp,
  closeTestDb,
  freshApp,
  getJson,
  intakeBody,
  makeAgent,
  makeUser,
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
  policy_revision: { id: string } | null;
  permit: { permit_id: string; token: string } | null;
}

async function authorizsedPayment(): Promise<IntakeResponse> {
  const res = await postJson(t, '/v1/actions', t.agentToken, intakeBody(t.agentId));
  expect(res.status).toBe(201);
  return res.json as IntakeResponse;
}

function executeBody(token: string): Record<string, unknown> {
  return { permit_token: token, idempotency_key: uniqueKey('exec') };
}

describe('execute', () => {
  it('spends a permit once and returns the verified receipt', async () => {
    const action = await authorizsedPayment();
    const token = action.permit?.token ?? '';
    expect(token).toMatch(/^pzpt_/);

    const res = await postJson(t, `/v1/actions/${action.action_id}/execute`, t.agentToken, executeBody(token));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      action_id: action.action_id,
      state: 'SUCCEEDED',
      accepted: true,
      receipt: {
        amount_minor: 300000,
        currency: 'USD',
        beneficiary_ref: 'BEN-017-VERIFIED',
        simulated: true,
      },
    });

    const fetched = await getJson(t, `/v1/actions/${action.action_id}`, t.agentToken);
    expect(fetched.json).toMatchObject({
      state: 'SUCCEEDED',
      execution: { state: 'SUCCEEDED', attempt_number: 1 },
    });

    const replay = await postJson(t, `/v1/actions/${action.action_id}/execute`, t.agentToken, executeBody(token));
    expect(replay.status).toBe(409);
    await closeApp(t);
  });

  it('rejects unknown and malformed permits without executing', async () => {
    const action = await authorizsedPayment();
    const unknown = await postJson(
      t,
      `/v1/actions/${action.action_id}/execute`,
      t.agentToken,
      executeBody(`pzpt_${'A'.repeat(43)}`),
    );
    expect(unknown.status).toBe(403);
    expect(unknown.json).toMatchObject({ error: { code: 'PERMIT_INVALID' } });

    const malformed = await postJson(t, `/v1/actions/${action.action_id}/execute`, t.agentToken, {
      permit_token: 'definitely-not-a-permit-token',
      idempotency_key: uniqueKey('exec'),
    });
    expect(malformed.status).toBe(403);

    const missing = await postJson(t, `/v1/actions/${action.action_id}/execute`, t.agentToken, {
      idempotency_key: uniqueKey('exec'),
    });
    expect(missing.status).toBe(422);

    // Nothing executed: the action still holds its live permit.
    const fetched = await getJson(t, `/v1/actions/${action.action_id}`, t.agentToken);
    expect(fetched.json).toMatchObject({ state: 'PERMIT_ISSUED', execution: null });
    await closeApp(t);
  });

  it('refuses to execute reads and undecided actions', async () => {
    const read = await postJson(
      t,
      '/v1/actions',
      t.agentToken,
      intakeBody(t.agentId, { tool_name: 'invoice.read', arguments: { invoice_id: 'INV-2041' } }),
    );
    const readId = (read.json as IntakeResponse).action_id;
    const res = await postJson(t, `/v1/actions/${readId}/execute`, t.agentToken, executeBody(`pzpt_${'A'.repeat(43)}`));
    expect(res.status).toBe(409);
    await closeApp(t);
  });

  it('restricts who may spend a permit', async () => {
    const other = await makeAgent(t.db, t.tenantId, { name: 'intruder' });
    const action = await authorizsedPayment();
    const token = action.permit?.token ?? '';

    const intruder = await postJson(t, `/v1/actions/${action.action_id}/execute`, other.token, executeBody(token));
    expect(intruder.status).toBe(403);
    const auditor = await postJson(t, `/v1/actions/${action.action_id}/execute`, t.auditorToken, executeBody(token));
    expect(auditor.status).toBe(403);

    // Operators and services may drive execution for the owning agent.
    const operator = await postJson(t, `/v1/actions/${action.action_id}/execute`, t.operatorToken, executeBody(token));
    expect(operator.status).toBe(200);
    await closeApp(t);
  });

  it('lets services execute on behalf of agents', async () => {
    const action = await authorizsedPayment();
    const res = await postJson(
      t,
      `/v1/actions/${action.action_id}/execute`,
      t.serviceToken,
      executeBody(action.permit?.token ?? ''),
    );
    expect(res.status).toBe(200);
    await closeApp(t);
  });

  it('flags unknown outcomes for reconciliation instead of guessing', async () => {
    const action = await authorizsedPayment();
    setConnectorFaultProfile({ timeoutAfterDispatch: true });
    try {
      const res = await postJson(
        t,
        `/v1/actions/${action.action_id}/execute`,
        t.agentToken,
        executeBody(action.permit?.token ?? ''),
      );
      expect(res.status).toBe(409);
      expect(res.json).toMatchObject({ error: { code: 'UNKNOWN_OUTCOME' } });
      const rows = await t.db.sql<{ event_type: string; queue_name: string }[]>`
        SELECT event_type, queue_name FROM outbox_events WHERE event_type = 'execution.unknown_outcome'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ queue_name: 'pz.reconciliation' });
      const fetched = await getJson(t, `/v1/actions/${action.action_id}`, t.agentToken);
      expect(fetched.json).toMatchObject({ state: 'UNKNOWN_OUTCOME' });
    } finally {
      clearConnectorFaultProfile();
    }
    await closeApp(t);
  });

  it('honors an emergency stop raised after intake', async () => {
    const action = await authorizsedPayment();
    await setEnforcementMode(t.db.db, { tenantId: t.tenantId, mode: 'EMERGENCY_STOP', reason: 'drill' });
    const res = await postJson(
      t,
      `/v1/actions/${action.action_id}/execute`,
      t.agentToken,
      executeBody(action.permit?.token ?? ''),
    );
    expect(res.status).toBe(423);
    const fetched = await getJson(t, `/v1/actions/${action.action_id}`, t.agentToken);
    expect(fetched.json).toMatchObject({ state: 'PERMIT_ISSUED', execution: null });
    await closeApp(t);
  });

  it('hides other tenants from execute', async () => {
    const action = await authorizsedPayment();
    const tenantB = await createTenant(t.db.db, {
      id: newId('tenant'),
      name: 'Tenant B',
      slug: 'tenant-b-exec',
      defaultEnvironment: 'DEMO',
      synthetic: true,
    });
    const userB = await makeUser(t.db, tenantB.id, { label: 'b-owner', role: 'OWNER' });
    const res = await postJson(
      t,
      `/v1/actions/${action.action_id}/execute`,
      userB.token,
      executeBody(action.permit?.token ?? ''),
    );
    expect(res.status).toBe(404);
    await closeApp(t);
  });

  it('runs the full human-in-the-loop loop to a receipt', async () => {
    await insertPurchaseOrder(t.db.db, {
      purchaseOrderId: 'PO-E2E-1',
      tenantId: t.tenantId,
      vendorId: 'VEN-017',
      amountMinor: 3000000n,
      currency: 'USD',
    });
    await insertInvoice(t.db.db, {
      invoiceId: 'INV-E2E-1',
      tenantId: t.tenantId,
      vendorId: 'VEN-017',
      amountMinor: 3000000n,
      currency: 'USD',
      purchaseOrderId: 'PO-E2E-1',
    });
    const created = await postJson(
      t,
      '/v1/actions',
      t.agentToken,
      intakeBody(t.agentId, { arguments: paymentArgs({ invoice_id: 'INV-E2E-1', amount_minor: 3000000 }) }),
    );
    expect(created.status).toBe(201);
    const action = created.json as IntakeResponse;
    expect(action.decision).toBe('REQUIRE_APPROVAL');

    const approved = await postJson(t, `/v1/actions/${action.action_id}/approve`, t.approver1Token, {
      decision: 'APPROVE',
      reason_code: 'PO_CONFIRMED',
      idempotency_key: uniqueKey('approval'),
      action_hash: action.action_hash,
      policy_revision_id: action.policy_revision?.id ?? '',
    });
    expect(approved.status).toBe(200);
    expect(approved.json).toMatchObject({ state: 'APPROVED' });

    const collected = await postJson(t, `/v1/actions/${action.action_id}/permit`, t.agentToken, {});
    expect(collected.status).toBe(201);
    const token = (collected.json as { token: string }).token;

    const executed = await postJson(t, `/v1/actions/${action.action_id}/execute`, t.agentToken, executeBody(token));
    expect(executed.status).toBe(200);
    expect(executed.json).toMatchObject({
      state: 'SUCCEEDED',
      receipt: { amount_minor: 3000000, currency: 'USD', simulated: true },
    });
    await closeApp(t);
  });

  it('runs a bank-detail change from approval to staged effect', async () => {
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

    const approval = (token: string, reason: string) =>
      postJson(t, `/v1/actions/${action.action_id}/approve`, token, {
        decision: 'APPROVE',
        reason_code: reason,
        idempotency_key: uniqueKey('approval'),
        action_hash: action.action_hash,
        policy_revision_id: action.policy_revision?.id ?? '',
      });
    expect((await approval(t.approver1Token, 'EVIDENCE_REVIEWED')).status).toBe(200);
    expect((await approval(t.approver2Token, 'PO_CONFIRMED')).status).toBe(200);
    const quorum = await approval(t.ownerToken, 'VENDOR_VERIFIED_OUT_OF_BAND');
    expect(quorum.status).toBe(200);
    expect(quorum.json).toMatchObject({ state: 'APPROVED' });

    const collected = await postJson(t, `/v1/actions/${action.action_id}/permit`, t.agentToken, {});
    expect(collected.status).toBe(201);
    const executed = await postJson(
      t,
      `/v1/actions/${action.action_id}/execute`,
      t.agentToken,
      executeBody((collected.json as { token: string }).token),
    );
    expect(executed.status).toBe(200);
    expect(executed.json).toMatchObject({
      state: 'SUCCEEDED',
      receipt: { amount_minor: 0, currency: 'XXX', beneficiary_ref: 'BEN-017-NEW', simulated: true },
    });
    await closeApp(t);
  });
});
