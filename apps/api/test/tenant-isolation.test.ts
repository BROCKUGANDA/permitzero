/**
 * Tenant isolation over HTTP, with the database doing the enforcing.
 *
 * Two things have to be true before the assertions below mean anything, and the
 * first test establishes both, because without it a 404 could just as easily come
 * from a missing fixture as from isolation:
 *
 *   1. the pool serving these requests is the restricted `pz_app` role, so
 *      row-level security actually applies to traffic;
 *   2. the other tenant's rows genuinely exist — visible on the exempt admin pool.
 *
 * `freshApp()` wires every route through `pz_app`, which makes the rest of this
 * suite an RLS suite as a side effect: a handler that loses its tenant context
 * reads nothing, and its own existing assertion fails.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { newId } from '@permitzero/domain';
import { createTenant, rlsEnforcementState } from '@permitzero/db';
import type { AuditBundle, CreateActionResponse } from '@permitzero/schemas';
import {
  auth,
  closeApp,
  freshApp,
  getJson,
  makeUser,
  paymentArgs,
  postJson,
  uniqueKey,
  type ApiFixture,
} from './helpers.js';

async function submitPayment(fixture: ApiFixture, runId: string): Promise<string> {
  const created = await postJson(fixture, '/v1/actions', fixture.agentToken, {
    agent_id: fixture.agentId,
    run_id: runId,
    task_purpose: 'Pay a verified invoice',
    tool_name: 'payment.execute',
    arguments: paymentArgs(),
    evidence_refs: [],
    idempotency_key: uniqueKey(`iso-${runId}`),
    environment: 'DEMO',
  });
  expect(created.status).toBe(201);
  return (created.json as CreateActionResponse).action_id;
}

async function otherTenant(fixture: ApiFixture, label: string) {
  const suffix = randomBytes(6).toString('hex');
  const tenant = await createTenant(fixture.db.db, {
    id: newId('tenant'),
    name: `Tenant ${label}`,
    slug: `tenant-${label.toLowerCase()}-${suffix}`,
    defaultEnvironment: 'DEMO',
    synthetic: true,
  });
  const owner = await makeUser(fixture.db, tenant.id, { label: `${label.toLowerCase()}-owner`, role: 'OWNER' });
  return { tenant, owner };
}

describe('tenant isolation (http + row-level security)', () => {
  let t: ApiFixture;

  beforeAll(async () => {
    t = await freshApp();
  });

  it('the runtime pool serving these requests is bound by row-level security', async () => {
    const state = await rlsEnforcementState(t.runtime);
    expect(state.role).toBe('pz_app');
    expect(state.subjectToRls).toBe(true);
    expect(state.enforced).toBe(true);
    expect(state.unenforcedTables).toEqual([]);

    // The setup pool is deliberately the opposite. Nothing in this file reads
    // tenant rows through it except to prove the row exists.
    const admin = await rlsEnforcementState(t.db);
    expect(admin.subjectToRls).toBe(false);
  });

  it('another tenant cannot read an action by id, and the row really exists', async () => {
    const actionId = await submitPayment(t, 'run_isolation_1');
    const { owner: ownerB } = await otherTenant(t, 'B');

    const present = await t.db.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM actions WHERE action_id = ${actionId}`;
    expect(present[0]?.n).toBe('1');

    const peek = await getJson(t, `/v1/actions/${actionId}`, ownerB.token);
    expect(peek.status).toBe(404);

    const list = await getJson(t, '/v1/actions', ownerB.token);
    expect(list.status).toBe(200);
    expect((list.json as { data: Array<{ action_id: string }> }).data.map((a) => a.action_id)).not.toContain(actionId);

    const audit = await getJson(t, `/v1/audit?action_id=${actionId}`, ownerB.token);
    expect(audit.status).toBe(200);
    expect((audit.json as { data: unknown[] }).data).toEqual([]);
  });

  it('a cross-tenant execute attempt neither runs nor reveals the action', async () => {
    const actionId = await submitPayment(t, 'run_isolation_2');
    const { owner: ownerC } = await otherTenant(t, 'C');
    const res = await postJson(t, `/v1/actions/${actionId}/execute`, ownerC.token, {
      permit_token: 'pzpt_' + 'A'.repeat(43),
      idempotency_key: uniqueKey('iso-exec'),
    });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.json)).not.toMatch(/payment|receipt|amount_minor/);
  });

  it('the evidence bundle never mixes tenants', async () => {
    const actionId = await submitPayment(t, 'run_isolation_3');
    const { tenant: tenantD, owner: ownerD } = await otherTenant(t, 'D');

    const own = await getJson(t, '/v1/evidence/bundle', ownerD.token);
    expect(own.status).toBe(200);
    const bundle = own.json as AuditBundle;
    expect(bundle.manifest.tenant_id).toBe(tenantD.id);
    expect(bundle.events).toEqual([]);

    // And tenant A's bundle contains its own action and nothing from D.
    const aBundle = await getJson(t, '/v1/evidence/bundle', t.ownerToken);
    expect(aBundle.status).toBe(200);
    const a = aBundle.json as AuditBundle;
    expect(a.manifest.tenant_id).toBe(t.tenantId);
    expect(a.events.length).toBeGreaterThan(0);
    expect(a.events.every((e) => e.tenant_id === t.tenantId)).toBe(true);
    expect(a.events.some((e) => e.action_id === actionId)).toBe(true);
    expect(a.events.every((e) => e.tenant_id !== tenantD.id)).toBe(true);
  });

  it('a forged tenant header changes nothing', async () => {
    const { tenant: tenantE } = await otherTenant(t, 'E');
    const res = await t.app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { ...auth(t.auditorToken), 'x-tenant-id': tenantE.id, 'x-permitzero-tenant': tenantE.id },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain(tenantE.id);
  });

  it('an agent credential cannot reach another tenant even with that tenant named in the body', async () => {
    const { tenant: tenantF } = await otherTenant(t, 'F');
    const created = await postJson(t, '/v1/actions', t.agentToken, {
      agent_id: t.agentId,
      tenant_id: tenantF.id,
      run_id: 'run_isolation_4',
      task_purpose: 'Pay a verified invoice',
      tool_name: 'payment.execute',
      arguments: paymentArgs(),
      evidence_refs: [],
      idempotency_key: uniqueKey('iso-tenant-field'),
      environment: 'DEMO',
    });
    // The request schema is strict, so naming a tenant in the body is rejected
    // outright rather than silently ignored. Either way the only acceptable
    // outcome is: it did not authorise anything in tenant F.
    expect([422, 201]).toContain(created.status);
    if (created.status === 201) {
      const actionId = (created.json as CreateActionResponse).action_id;
      const row = await t.db.sql<{ tenant_id: string }[]>`
        SELECT tenant_id FROM actions WHERE action_id = ${actionId}`;
      expect(row[0]?.tenant_id).toBe(t.tenantId);
    } else {
      const foreign = await t.db.sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM actions WHERE tenant_id = ${tenantF.id}`;
      expect(foreign[0]?.n).toBe('0');
    }
  });
});
