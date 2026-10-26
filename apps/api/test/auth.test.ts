/**
 * Authentication and tenant isolation: every /v1 route resolves the tenant
 * from the bearer token, and cross-tenant access is always 404, never 403.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTenant, findCredentialBySecretHash, revokeCredential } from '@permitzero/db';
import { newId } from '@permitzero/domain';
import {
  closeApp,
  closeTestDb,
  freshApp,
  getJson,
  intakeBody,
  makeAgent,
  makeUser,
  postJson,
  type ApiFixture,
} from './helpers.js';

let t: ApiFixture;

beforeEach(async () => {
  t = await freshApp();
});

afterAll(async () => {
  await closeTestDb();
});

async function teardown(): Promise<void> {
  await closeApp(t);
}

describe('authentication', () => {
  it('rejects missing and malformed credentials', async () => {
    const body = intakeBody(t.agentId);
    const missing = await postJson(t, '/v1/actions', null, body);
    expect(missing.status).toBe(401);
    expect(missing.json).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });

    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { authorization: 'Token abc', 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
    expect(res.statusCode).toBe(401);

    const unknown = await postJson(t, '/v1/actions', 'pz_no_such_token_000000000000', body);
    expect(unknown.status).toBe(401);
    await teardown();
  });

  it('rejects revoked credentials without saying why', async () => {
    const hash = createHash('sha256').update(t.agentToken, 'utf8').digest('hex');
    const cred = await findCredentialBySecretHash(t.db.db, hash);
    await revokeCredential(t.db.db, t.tenantId, cred?.credentialId ?? '', new Date());
    const res = await postJson(t, '/v1/actions', t.agentToken, intakeBody(t.agentId));
    expect(res.status).toBe(401);
    expect(res.json).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    await teardown();
  });

  it('stops agents submitting for other agents', async () => {
    const other = await makeAgent(t.db, t.tenantId, { name: 'second' });
    const res = await postJson(t, '/v1/actions', t.agentToken, intakeBody(other.agentId));
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ error: { code: 'FORBIDDEN' } });
    await teardown();
  });

  it('enforces the agent tool scope', async () => {
    const narrow = await makeAgent(t.db, t.tenantId, { name: 'reader', allowedTools: [] });
    const res = await postJson(t, '/v1/actions', narrow.token, intakeBody(narrow.agentId));
    expect(res.status).toBe(403);
    await teardown();
  });

  it('returns 404 for unknown agents rather than inventing one', async () => {
    const res = await postJson(t, '/v1/actions', t.operatorToken, intakeBody(newId('agent')));
    expect(res.status).toBe(404);
    await teardown();
  });

  it('lets human operators submit for an agent', async () => {
    const res = await postJson(t, '/v1/actions', t.operatorToken, intakeBody(t.agentId));
    expect(res.status).toBe(201);
    await teardown();
  });

  it('hides other tenants behind 404', async () => {
    const created = await postJson(t, '/v1/actions', t.agentToken, intakeBody(t.agentId));
    expect(created.status).toBe(201);
    const actionId = (created.json as { action_id: string }).action_id;

    const tenantB = await createTenant(t.db.db, {
      id: newId('tenant'),
      name: 'Tenant B',
      slug: 'tenant-b',
      defaultEnvironment: 'DEMO',
      synthetic: true,
    });
    const userB = await makeUser(t.db, tenantB.id, { label: 'b-owner', role: 'OWNER' });

    const read = await getJson(t, `/v1/actions/${actionId}`, userB.token);
    expect(read.status).toBe(404);
    const list = await getJson(t, '/v1/actions', userB.token);
    expect(list.status).toBe(200);
    expect(list.json).toMatchObject({ data: [] });
    const execute = await postJson(t, `/v1/actions/${actionId}/execute`, userB.token, {
      permit_token: 'pzpt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      idempotency_key: 'tenant-b-probe-0001',
    });
    expect(execute.status).toBe(404);
    await teardown();
  });
});
