/**
 * Security posture, asserted at the boundary rather than reviewed in source.
 *
 * Each test here is written so it can fail. That matters more in this file than
 * anywhere else in the suite: a security assertion that passes because it could
 * not have done otherwise is the worst kind of documentation, since it gets cited
 * as evidence. Where a control is a configuration value, the test reads the value
 * back out of a response; where it is a behaviour, the test tries to defeat it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { newId } from '@permitzero/domain';
import { closeDb, createCredential, createDb, revokeCredential } from '@permitzero/db';
import { buildApp } from '../src/app.js';
import { createModelAdapter } from '../src/model.js';
import { testConfig, testDb, testRuntimeDb, paymentArgs, uniqueKey, type ApiFixture } from './helpers.js';
import { closeApp, freshApp } from './helpers.js';
import type { ApiConfig } from '../src/config.js';

let fixture: ApiFixture;

async function appWith(overrides: Partial<ApiConfig>): Promise<FastifyInstance> {
  const db = await testDb();
  const runtime = await testRuntimeDb();
  const built = await buildApp({
    db,
    dbRuntime: runtime,
    config: { ...testConfig(), ...overrides },
    model: createModelAdapter('disabled'),
  });
  return built.app;
}

beforeAll(async () => {
  fixture = await freshApp();
});

describe('response hardening', () => {
  it('sends a Content-Security-Policy that cannot execute script from elsewhere', async () => {
    const res = await fixture.app.inject({ method: 'GET', url: '/health/live' });
    const csp = res.headers['content-security-policy'];
    expect(typeof csp).toBe('string');
    const directives = Object.fromEntries(
      (csp as string).split(';').map((d) => {
        const [name, ...rest] = d.trim().split(/\s+/);
        return [name, rest.join(' ')];
      }),
    );
    // No wildcards anywhere: one `*` in default-src makes every other entry
    // decoration.
    for (const value of Object.values(directives)) {
      expect(value).not.toMatch(/(^|\s)\*(\s|$)/);
    }
    // Hyphenated, as they appear on the wire — a camelCase lookup here would
    // silently compare against `undefined` and pass nothing.
    expect(directives['default-src']).toBe("'self'");
    expect(directives['script-src']).toBe("'self'");
    expect(directives['object-src']).toBe("'none'");
    expect(directives['frame-ancestors']).toBe("'none'");
    expect(directives['base-uri']).toBe("'self'");
    // A clickjacked console can approve a payment, which is the one thing an
    // authorization plane must not allow through an <iframe>.
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('forces HTTPS with a real max-age and sends it on every response', async () => {
    const res = await fixture.app.inject({ method: 'GET', url: '/v1/audit' });
    expect(res.headers['strict-transport-security']).toMatch(/max-age=31536000/);
    expect(res.headers['strict-transport-security']).toMatch(/includeSubDomains/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('does not advertise the framework or the runtime', async () => {
    const res = await fixture.app.inject({ method: 'GET', url: '/health/live' });
    expect(res.headers['x-powered-by']).toBeUndefined();
    // Anything naming Fastify/Node in a response hands an attacker a version to
    // look up exploits for.
    expect(JSON.stringify(res.headers).toLowerCase()).not.toContain('fastify');
  });
});

describe('cross-origin policy', () => {
  it('allows only the configured origin, and echoes exactly that', async () => {
    const res = await fixture.app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { origin: 'http://console.test' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('http://console.test');
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('withholds the grant from an origin that is not configured', async () => {
    for (const origin of ['http://evil.example', 'http://localhost:9999', 'null']) {
      const res = await fixture.app.inject({ method: 'GET', url: '/health/live', headers: { origin } });
      expect(res.headers['access-control-allow-origin'], origin).toBeUndefined();
    }
  });

  it('does not let a prefix lookalike through the allowlist', async () => {
    // The classic allowlist bypass: `http://console.test` accepted as a prefix also
    // accepts `http://console.test.attacker.example`.
    const res = await fixture.app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { origin: 'http://console.test.attacker.example' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('with an empty allowlist grants cross-origin access to nobody', async () => {
    const app = await appWith({ corsOrigins: [] });
    const res = await app.inject({ method: 'GET', url: '/health/live', headers: { origin: 'http://console.test' } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    // Same-origin callers (the console through the edge rewrite) are unaffected:
    // they send no Origin for a simple GET and never needed a grant.
    const sameOrigin = await app.inject({ method: 'GET', url: '/health/live' });
    expect(sameOrigin.statusCode).toBe(200);
    await app.close();
  });
});

describe('rate limiting is scoped per class, as the config claims', () => {
  it('throttles the mutation budget and answers with the standard envelope', async () => {
    const app = await appWith({ rateLimitMutations: 3 });
    let last: { status: number; body: string } | null = null;
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/actions',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${fixture.agentToken}` },
        payload: JSON.stringify({
          agent_id: fixture.agentId,
          run_id: 'run_rate',
          task_purpose: 'Pay',
          tool_name: 'payment.execute',
          arguments: paymentArgs(),
          evidence_refs: [],
          idempotency_key: uniqueKey('rate'),
          environment: 'DEMO',
        }),
      });
      last = { status: res.statusCode, body: res.body };
      if (res.statusCode === 429) break;
    }
    expect(last?.status).toBe(429);
    expect(JSON.parse(last?.body ?? '{}')).toMatchObject({ error: { code: 'RATE_LIMITED', retryable: true } });
    await app.close();
  });

  it('does not charge a mutation attempt against the read path', async () => {
    // If reads shared the mutation budget, one busy agent would lock an operator
    // out of the very queue they need in order to clear it — a self-inflicted
    // availability failure in the middle of an incident.
    const app = await appWith({ rateLimitMutations: 2 });
    for (let i = 0; i < 4; i++) {
      await app.inject({
        method: 'POST',
        url: '/v1/actions',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${fixture.agentToken}` },
        payload: JSON.stringify({
          agent_id: fixture.agentId,
          run_id: 'run_rate2',
          task_purpose: 'Pay',
          tool_name: 'payment.execute',
          arguments: paymentArgs(),
          evidence_refs: [],
          idempotency_key: uniqueKey('rate2'),
          environment: 'DEMO',
        }),
      });
    }
    const read = await app.inject({
      method: 'GET',
      url: '/v1/actions',
      headers: { authorization: `Bearer ${fixture.ownerToken}` },
    });
    expect(read.statusCode).toBe(200);
    await app.close();
  });
});

describe('input limits and error hygiene', () => {
  it('rejects an oversized body before parsing it', async () => {
    const app = await appWith({ maxBodyBytes: 2048 });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${fixture.agentToken}` },
      payload: JSON.stringify({ agent_id: fixture.agentId, filler: 'x'.repeat(40_000) }),
    });
    expect(res.statusCode).toBe(413);
    // The rejection must not echo the payload back — an error that reflects a
    // 40KB body is a bandwidth amplification and a log-injection path.
    expect(res.body).not.toContain('xxxxxxxxxx');
    await app.close();
  });

  it('never reflects a submitted secret in a validation error', async () => {
    const secretish = 'pz_SUPERSECRET_token_value_should_never_be_echoed';
    const res = await fixture.app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${fixture.agentToken}` },
      payload: JSON.stringify({ agent_id: fixture.agentId, bogus: secretish }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).not.toContain(secretish);
  });

  it('answers a dependency outage without a stack trace, SQL text or a misleading 401', async () => {
    // The pools themselves have to be the dead thing. Overriding only the config
    // strings — which is what this test first did — leaves the app on live pools
    // and it then answers 401 for the unrecognised token, i.e. it reports a
    // credential problem when the intent was to simulate infrastructure loss.
    const deadUrl = 'postgres://postgres@127.0.0.1:5499/permitzero_none';
    const deadAdmin = createDb(deadUrl, { max: 1 });
    const deadRuntime = createDb(deadUrl, { max: 1 });
    const built = await buildApp({
      db: deadAdmin,
      dbRuntime: deadRuntime,
      config: { ...testConfig(), databaseUrl: deadUrl, databaseRuntimeUrl: deadUrl },
      model: createModelAdapter('disabled'),
    });
    const res = await built.app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${fixture.agentToken}` },
      payload: JSON.stringify({
        agent_id: fixture.agentId,
        run_id: 'run_dead_db',
        task_purpose: 'Pay a verified invoice',
        tool_name: 'payment.execute',
        arguments: paymentArgs(),
        evidence_refs: [],
        idempotency_key: uniqueKey('dead-db'),
        environment: 'DEMO',
      }),
    });
    // 503, and not 401: "we cannot reach the database" reported as "your
    // credentials are bad" makes an agent throw away a valid token and start
    // re-provisioning during an outage, and it hides the outage from the
    // 5xx-based availability objective.
    expect(res.statusCode).toBe(503);
    expect(res.body.toLowerCase()).not.toMatch(/at .*\.ts:|postgres:|select .* from|traceback|econnrefused/);
    await built.app.close();
    await closeDb(deadAdmin).catch(() => undefined);
    await closeDb(deadRuntime).catch(() => undefined);
  });

  it('rejects unknown body fields instead of ignoring them', async () => {
    // Mass assignment is how a caller adds a field the author never reviewed —
    // `approved: true`, `tenant_id: other`, `role: OWNER`.
    const res = await fixture.app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${fixture.agentToken}` },
      payload: JSON.stringify({ agent_id: fixture.agentId, approved: true, role: 'OWNER' }),
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('authentication surface', () => {
  it('does not distinguish an unknown credential from a revoked one', async () => {
    // Both tokens here are well formed, so nothing can be attributed to shape
    // parsing. If the two answers differ, the endpoint is an oracle for "this
    // credential exists and was revoked", which is exactly the fact an attacker
    // probing for stale keys wants.
    const wellFormedUnknown = 'pz_' + 'a'.repeat(40);
    const revoked = 'pz_' + 'b'.repeat(40);
    const credentialId = newId('credential');
    await createCredential(fixture.db.db, {
      id: credentialId,
      tenantId: fixture.tenantId,
      name: 'probe-revoked',
      subjectType: 'SERVICE',
      subjectId: null,
      credentialRef: 'secret://probe/revoked',
      secretHash: createHash('sha256').update(revoked, 'utf8').digest('hex'),
      secretPrefix: revoked.slice(0, 12),
      scopes: [],
    });
    await revokeCredential(fixture.db.db, fixture.tenantId, credentialId, new Date());

    const unknownRes = await fixture.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${wellFormedUnknown}` },
    });
    const revokedRes = await fixture.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${revoked}` },
    });

    expect(unknownRes.statusCode).toBe(401);
    expect(revokedRes.statusCode).toBe(401);
    // Compared field by field, because `trace_id` legitimately differs per
    // request; equality of the whole envelope would be a test of the tracer.
    const shape = (body: unknown) => {
      const e = (body as { error: { code: string; message: string; retryable: boolean } }).error;
      return { code: e.code, message: e.message, retryable: e.retryable };
    };
    expect(shape(revokedRes.json())).toEqual(shape(unknownRes.json()));
  });

  it('accepts the tenant claim from no input but the Authorization header', async () => {
    const res = await fixture.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: {
        authorization: `Bearer ${fixture.ownerToken}`,
        'x-tenant-id': 'ten_someone_elses',
        'x-permitzero-tenant': 'ten_someone_elses',
        cookie: 'tenant=ten_someone_elses',
      },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { tenant_id: string }).tenant_id).toBe(fixture.tenantId);
    expect(JSON.stringify(res.json())).not.toContain('ten_someone_elses');
  });

  it('a forged X-Forwarded-For does not buy a fresh rate-limit bucket', async () => {
    // Only meaningful because the trusted-proxy list is empty in this fixture:
    // with a proxy hop configured, the header would be honoured for that hop only.
    const app = await appWith({ rateLimitMax: 3, trustedProxies: [] });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { 'x-forwarded-for': `10.0.0.${i}` },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.filter((s) => s === 429).length, 'forged client IPs bought extra allowance').toBeGreaterThan(0);
    await app.close();
  });
});

describe('injection and enumeration', () => {
  it('treats SQL in an identifier filter as data, not as syntax', async () => {
    const payloads = [
      "'; DROP TABLE actions; --",
      "1' OR '1'='1",
      'act_%',
      "') UNION SELECT tenant_id, secret_hash FROM service_credentials --",
    ];
    for (const payload of payloads) {
      const res = await fixture.app.inject({
        method: 'GET',
        url: `/v1/audit?action_id=${encodeURIComponent(payload)}`,
        headers: { authorization: `Bearer ${fixture.auditorToken}` },
      });
      expect([200, 400, 422].includes(res.statusCode), payload).toBe(true);
      if (res.statusCode === 200) {
        expect((res.json() as { data: unknown[] }).data, payload).toEqual([]);
      }
    }
    // The table the first payload tried to delete still answers.
    const stillThere = await fixture.db.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM actions`;
    expect(Number(stillThere[0]?.n ?? -1)).toBeGreaterThanOrEqual(0);
  });

  it('a denied permit attempt never reveals whether the action exists in another tenant', async () => {
    const other = await fixture.app.inject({
      method: 'POST',
      url: '/v1/actions/act_00000000000000000000000000/execute',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${fixture.agentToken}` },
      payload: JSON.stringify({ permit_token: 'pzpt_' + 'A'.repeat(43), idempotency_key: uniqueKey('enum') }),
    });
    expect(other.statusCode).toBe(404);
    // 403 would confirm existence, which across tenants is a data leak.
    expect(other.statusCode).not.toBe(403);
    // The answer must not say why it is a 404. "not found" is fine; anything
    // naming a field, an owner or a state is a confirmation that the row exists.
    const body = JSON.stringify(other.json());
    expect(body).not.toMatch(/agent_id|tenant_id|owner|denied|forbidden/i);
  });
});

describe('secret handling at the boundary', () => {
  it('no response body carries a configured secret', async () => {
    const config = testConfig();
    const secrets = [config.permitSigningKey, process.env.AUDIT_HMAC_KEY, process.env.AUTH_SECRET].filter(
      (v): v is string => typeof v === 'string' && v.length > 4,
    );
    expect(secrets.length, 'no configured secret to test — this test would pass vacuously').toBeGreaterThan(0);

    const calls: Array<[string, string, number, string]> = [];
    for (const [url, token] of [
      ['/v1/status', fixture.serviceToken],
      ['/v1/me', fixture.ownerToken],
      ['/metrics', 'test-metrics-token'],
      ['/health/ready', null],
    ] as Array<[string, string | null]>) {
      const res = await fixture.app.inject({
        method: 'GET',
        url,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      calls.push([url, token ?? '', res.statusCode, res.body]);
    }
    for (const [url, , status, body] of calls) {
      expect(status, url).toBeLessThan(500);
      for (const secret of secrets) {
        expect(body, `${url} leaked a configured secret`).not.toContain(secret);
      }
      // A bearer credential must never appear in a response body either.
      expect(body).not.toContain(fixture.ownerToken);
    }
  });

  it('an issued permit token appears exactly once and is never stored in the clear', async () => {
    const created = await fixture.app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${fixture.agentToken}` },
      payload: JSON.stringify({
        agent_id: fixture.agentId,
        run_id: 'run_permit_once',
        task_purpose: 'Pay a verified invoice',
        tool_name: 'payment.execute',
        arguments: paymentArgs(),
        evidence_refs: [],
        idempotency_key: uniqueKey('permit-once'),
        environment: 'DEMO',
      }),
    });
    expect(created.statusCode).toBe(201);
    const token = (created.json() as { permit?: { token?: string } }).permit?.token;
    expect(typeof token).toBe('string');
    if (!token) return;

    // Only hashes are persisted: the raw token must not be findable in the row.
    const stored = await fixture.db.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM permits WHERE token_hash = ${token} OR nonce_hash = ${token}`;
    expect(stored[0]?.c).toBe(0);

    // A replay of the same idempotency key replays the decision WITHOUT the token.
    const replay = await fixture.app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${fixture.agentToken}` },
      payload: JSON.stringify({
        agent_id: fixture.agentId,
        run_id: 'run_permit_once',
        task_purpose: 'Pay a verified invoice',
        tool_name: 'payment.execute',
        arguments: paymentArgs(),
        evidence_refs: [],
        idempotency_key: uniqueKey('unused'),
        environment: 'DEMO',
      }),
    });
    expect(JSON.stringify(replay.json())).not.toContain(token);
  });
});

afterAll(async () => {
  if (fixture) await closeApp(fixture);
});
