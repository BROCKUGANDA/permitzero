/**
 * Health and status: public probes stay minimal while the authenticated
 * status names the tenant posture, honestly including disabled subsystems.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { setEnforcementMode } from '@permitzero/db';
import { closeApp, closeTestDb, freshApp, getJson, type ApiFixture } from './helpers.js';

let t: ApiFixture;

beforeEach(async () => {
  t = await freshApp();
});

afterAll(async () => {
  await closeTestDb();
});

describe('health and status', () => {
  it('answers liveness without credentials', async () => {
    const res = await getJson(t, '/health/live', null);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: 'ok' });
    await closeApp(t);
  });

  it('reports ready when the platform can enforce', async () => {
    const res = await getJson(t, '/health/ready', null);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      status: 'ready',
      database: true,
      migrations_applied: true,
      protected_writes_allowed: true,
      reasons: [],
    });
    await closeApp(t);
  });

  it('requires authentication for tenant status', async () => {
    const res = await getJson(t, '/v1/status', null);
    expect(res.status).toBe(401);
    await closeApp(t);
  });

  it('identifies the caller without leaking the credential', async () => {
    const user = await getJson(t, '/v1/me', t.approver1Token);
    expect(user.status).toBe(200);
    expect(user.json).toMatchObject({
      actor_type: 'USER',
      tenant_id: t.tenantId,
      roles: ['APPROVER'],
      environment: 'DEMO',
    });
    expect(user.json).not.toHaveProperty('credentialId');
    const agent = await getJson(t, '/v1/me', t.agentToken);
    expect(agent.json).toMatchObject({ actor_type: 'AGENT', actor_id: t.agentId, roles: [] });
    const service = await getJson(t, '/v1/me', t.serviceToken);
    expect(service.json).toMatchObject({ actor_type: 'WORKER', roles: ['SERVICE_AGENT'] });
    await closeApp(t);
  });

  it('describes the tenant posture including disabled subsystems', async () => {
    const res = await getJson(t, '/v1/status', t.agentToken);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      status: 'ok',
      enforcement_mode: 'ENFORCED',
      synthetic_data_mode: true,
      app_env: 'test',
      dependencies: {
        database: 'up',
        redis: 'disabled',
        queue: { status: 'disabled', depth: 0, oldest_job_age_ms: null, outbox_dead: 0 },
        model_provider: { enabled: false, status: 'disabled', breaker: 'CLOSED', model_id: null },
      },
      connectors: { total: 1, healthy: 1, degraded: 0, quarantined: 0 },
    });
    await closeApp(t);
  });

  it('keeps platform readiness separate from a tenant emergency stop', async () => {
    await setEnforcementMode(t.db.db, { tenantId: t.tenantId, mode: 'EMERGENCY_STOP', reason: 'drill' });
    const status = await getJson(t, '/v1/status', t.agentToken);
    expect(status.json).toMatchObject({ enforcement_mode: 'EMERGENCY_STOP' });
    const ready = await getJson(t, '/health/ready', null);
    expect(ready.json).toMatchObject({ status: 'ready', protected_writes_allowed: true });
    await closeApp(t);
  });

  it('reports the static provider when enabled', async () => {
    await closeApp(t);
    t = await freshApp({ model: 'static' });
    const res = await getJson(t, '/v1/status', t.agentToken);
    expect(res.json).toMatchObject({
      dependencies: {
        model_provider: { enabled: true, status: 'ok', breaker: 'CLOSED', model_id: 'static-v1' },
      },
    });
    await closeApp(t);
  });
});
