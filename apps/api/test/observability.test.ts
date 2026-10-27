/**
 * Observability at the HTTP boundary: does a real decision actually move a real
 * counter, and does the trace header actually round-trip.
 *
 * The failure mode these tests exist to prevent is the metric that is declared
 * and never recorded. A registry full of series that no code path increments
 * passes every unit test in `packages/observability` and still shows an operator
 * an empty dashboard, so the assertions here go through the routes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { traceIdFromW3C, w3cTraceIdFromId } from '@permitzero/domain';
import { buildApp, type BuiltApp } from '../src/app.js';
import { createModelAdapter } from '../src/model.js';
import {
  closeApp,
  closeTestDb,
  freshApp,
  paymentArgs,
  postJson,
  testConfig,
  testDb,
  testRuntimeDb,
  uniqueKey,
  type ApiFixture,
} from './helpers.js';

const METRICS_TOKEN = 'test-metrics-token';

describe('metrics endpoint', () => {
  let t: ApiFixture;

  beforeAll(async () => {
    t = await freshApp();
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('refuses an unauthenticated scrape and says how to authenticate', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/Bearer/);
    // The exposition is not leaked to the caller that failed auth.
    expect(res.body).not.toContain('pz_http_requests_total');
  });

  it('refuses a wrong token without treating its length as a secret', async () => {
    for (const bad of ['Bearer wrong', 'Bearer ' + 'x'.repeat(64), 'Basic Zm9vOmJhcg==']) {
      const res = await t.app.inject({ method: 'GET', url: '/metrics', headers: { authorization: bad } });
      expect(res.statusCode, bad).toBe(401);
    }
  });

  it('serves Prometheus text to the right bearer', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain; version=0.0.4');
    expect(res.body).toContain('# TYPE pz_http_requests_total counter');
    expect(res.body).toContain('pz_tenant_isolation_enforced');
  });

  it('reports tenant isolation as enforced, from the database rather than from config', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    });
    // This is the number that would be 0 for a deployment that pointed
    // DATABASE_URL_RUNTIME back at the superuser, and it is produced by asking
    // Postgres what role the serving pool actually is.
    expect(res.body).toMatch(/pz_tenant_isolation_enforced\{role="pz_app"[^}]*\} 1/);
  });

  it('registers no metrics route at all when the token is not configured', async () => {
    const database = await testDb();
    const runtime = await testRuntimeDb();
    const config = { ...testConfig(), metricsToken: null };
    const built: BuiltApp = await buildApp({
      db: database,
      dbRuntime: runtime,
      config,
      model: createModelAdapter('disabled'),
    });
    const res = await built.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
    await built.app.close();
  });
});

describe('decision metrics are produced by real traffic', () => {
  let t: ApiFixture;

  beforeAll(async () => {
    t = await freshApp();
  });

  const scrape = async (): Promise<string> => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    });
    return res.body;
  };

  it('counts a policy decision made through POST /v1/actions', async () => {
    const before = await scrape();
    const created = await postJson(t, '/v1/actions', t.agentToken, {
      agent_id: t.agentId,
      run_id: 'run_metrics_1',
      task_purpose: 'Pay a verified invoice',
      tool_name: 'payment.execute',
      arguments: paymentArgs(),
      evidence_refs: [],
      idempotency_key: uniqueKey('metrics'),
      environment: 'DEMO',
    });
    expect(created.status).toBe(201);

    const after = await scrape();
    expect(after).toMatch(/pz_decisions_total\{[^}]*decision="ALLOW"[^}]*tool="payment\.execute"[^}]*\} 1/);
    expect(after).toContain('pz_policy_evaluations_total');
    expect(after).toContain('pz_decision_duration_seconds_count');
    // Model disabled for this fixture: the series must say so rather than omit
    // the label and leave "did the model run?" unanswerable.
    expect(after).toMatch(/pz_policy_evaluations_total\{[^}]*model_signal_used="false"/);
    void before;
  });

  it('counts a denied decision under its own label, not merged with allows', async () => {
    const created = await postJson(t, '/v1/actions', t.agentToken, {
      agent_id: t.agentId,
      run_id: 'run_metrics_2',
      task_purpose: 'Pay far too much',
      tool_name: 'payment.execute',
      // Above every policy limit in the shipped corpus.
      arguments: paymentArgs({ amount_minor: 999_999_999_99 }),
      evidence_refs: [],
      idempotency_key: uniqueKey('metrics-deny'),
      environment: 'DEMO',
    });
    expect(created.status).toBe(201);
    const after = await scrape();
    expect(after).toMatch(/pz_decisions_total\{[^}]*decision="DENY"[^}]*\} 1/);
  });

  it('labels requests by route pattern, never by concrete path', async () => {
    await scrape();
    const after = await scrape();
    expect(after).toContain('route="/v1/actions"');
    // A per-action series would make the cardinality equal to the number of
    // actions ever submitted; assert none exists.
    expect(after).not.toMatch(/route="\/v1\/actions\/act_/);
  });

  it('collapses unrouted probes into one label instead of minting a series per probe', async () => {
    for (const path of ['/nope', '/v1/zzz', '/../../etc/passwd']) {
      await t.app.inject({ method: 'GET', url: path });
    }
    const after = await scrape();
    expect(after).toContain('route="unmatched"');
    expect(after).not.toContain('route="/etc/passwd"');
  });
});

describe('trace context at the boundary', () => {
  let t: ApiFixture;

  beforeAll(async () => {
    t = await freshApp();
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('answers every request with a valid traceparent', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health/live' });
    expect(res.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it('adopts the caller trace id so the audit chain and their spans are one query', async () => {
    const incoming = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const created = await t.app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { 'content-type': 'application/json', traceparent: incoming, authorization: `Bearer ${t.agentToken}` },
      payload: JSON.stringify({
        agent_id: t.agentId,
        run_id: 'run_trace_1',
        task_purpose: 'Pay a verified invoice',
        tool_name: 'payment.execute',
        arguments: paymentArgs(),
        evidence_refs: [],
        idempotency_key: uniqueKey('trace'),
        environment: 'DEMO',
      }),
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { trace_id: string };
    // The action's trace id carries the caller's 32-hex trace id, so a log line,
    // the HTTP response and the audit event all match the caller's own trace.
    // Asserted by decoding the stored id back to the caller's hex, rather than by
    // comparing against a literal produced with the same helper that wrote it.
    expect(body.trace_id).toMatch(/^trc_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(w3cTraceIdFromId(body.trace_id)).toBe('0af7651916cd43dd8448eb211c80319c');
    const echoed = String(created.headers.traceparent);
    expect(echoed).toContain('0af7651916cd43dd8448eb211c80319c');
    expect(echoed).not.toBe(incoming); // parent id is ours, not the caller's
  });

  it('discards a malformed caller header rather than propagating it', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { traceparent: "00-'; DROP TABLE audit_events;-- -xx-01" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(res.headers.traceparent).not.toContain('DROP');
  });

  it('puts the same trace id in an error envelope that the response header carries', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/v1/actions/act_00000000000000000000000000',
      headers: { authorization: `Bearer ${t.ownerToken}` },
    });
    expect(res.statusCode).toBe(404);
    const header = String(res.headers.traceparent);
    const callerTraceHex = header.split('-')[1] as string;
    // The envelope reports the domain form (`trc_` + base32) and the header
    // reports the W3C form (32 hex). Same 128 bits, two bases, so the check is
    // that one converts to the other rather than that the strings are equal.
    expect(JSON.stringify(res.json())).toContain(traceIdFromW3C(callerTraceHex) as string);
    expect(w3cTraceIdFromId(traceIdFromW3C(callerTraceHex) as string)).toBe(callerTraceHex);
  });
});
