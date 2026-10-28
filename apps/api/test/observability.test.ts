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
import { randomBytes } from 'node:crypto';
import { traceIdFromW3C, w3cTraceIdFromId } from '@permitzero/domain';
import { schema, type Db } from '@permitzero/db';
import { sql } from 'drizzle-orm';
import { MetaProviderClient } from '@permitzero/provider-meta';
import type { MetaProviderConfig } from '@permitzero/provider-meta';
import { buildApp, type BuiltApp } from '../src/app.js';
import { createModelAdapter, type ModelAdapter } from '../src/model.js';
import { verifyAuditChains } from '../src/observability.js';
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

const { auditEvents } = schema;

/** The exposition, as the scraper sees it. */
async function scrapeMetrics(fixture: ApiFixture): Promise<string> {
  const res = await fixture.app.inject({
    method: 'GET',
    url: '/metrics',
    headers: { authorization: `Bearer ${METRICS_TOKEN}` },
  });
  expect(res.statusCode).toBe(200);
  return res.body;
}

/**
 * The value of one series in the exposition, or null when it is absent.
 *
 * Read by name and label rather than by a regular expression over the whole
 * line, because a series carries the deployment's const labels as well as its
 * own — and an assertion written against the exact label order breaks the
 * moment somebody adds one.
 */
function seriesValue(body: string, name: string, labels: Record<string, string> = {}): number | null {
  for (const line of body.split('\n')) {
    if (!line.startsWith(name)) continue;
    const open = line.indexOf('{');
    const close = line.lastIndexOf('}');
    if (open === -1 || close < open) continue;
    const labelText = line.slice(open + 1, close);
    if (!Object.entries(labels).every(([key, value]) => labelText.includes(`${key}="${value}"`))) continue;
    const value = Number(line.slice(close + 1).trim());
    if (Number.isFinite(value)) return value;
  }
  return null;
}

/** One intake, so the deployment has audit events and an outbox row to report. */
async function submitAction(fixture: ApiFixture, runId: string): Promise<number> {
  const created = await postJson(fixture, '/v1/actions', fixture.agentToken, {
    agent_id: fixture.agentId,
    run_id: runId,
    task_purpose: 'Pay a verified invoice',
    tool_name: 'payment.execute',
    arguments: paymentArgs(),
    evidence_refs: [],
    idempotency_key: uniqueKey(runId),
    environment: 'DEMO',
  });
  return created.status;
}

/**
 * Append an audit event whose hash does not match its own contents.
 *
 * This is what an attacker with database access would leave behind, and it is
 * exactly what the append trigger cannot catch: the trigger checks the
 * sequence and the previous-hash link, but it was handed the hash rather than
 * recomputing it. Only a later verification can notice.
 */
async function appendTamperedAuditEvent(db: Db, tenantId: string): Promise<void> {
  // The head of the chain, so the row links correctly and the only thing
  // wrong with it is its own hash.
  const head = (await db.db.execute(
    sql`SELECT event_hash FROM audit_events WHERE tenant_id = ${tenantId} ORDER BY sequence DESC LIMIT 1`,
  )) as unknown as Array<{ event_hash: string }>;
  const previousHash = head[0]?.event_hash ?? null;
  await db.db.insert(auditEvents).values({
    eventId: `aud_${randomBytes(13).toString('hex')}`,
    tenantId,
    actorType: 'SYSTEM',
    actorId: 'system:tamper',
    eventType: 'action.tampered',
    eventTime: new Date(),
    traceId: `trc_${randomBytes(13).toString('hex').toUpperCase().slice(0, 26)}`,
    payloadRedactedJson: {},
    previousHash,
    // A well-formed hash that is simply not this row's hash.
    eventHash: `sha256:${'0'.repeat(64)}`,
    hashVersion: 'pz-audit-v1',
    // NULL so the trigger assigns the next sequence, exactly as it does for
    // every other append.
    sequence: null as unknown as bigint,
  });
}

const META_CONFIG: MetaProviderConfig = {
  apiKey: 'test-key',
  baseUrl: 'https://provider.test/v1',
  modelId: 'test-model',
  timeoutMs: 2000,
  maxAttempts: 1,
  maxConcurrency: 1,
  retryBaseMs: 1,
  retryCapMs: 1,
  promptVersion: 'risk-hints-prompt-v1',
  // One transport failure is enough to open the circuit, so the test can prove
  // the gauge reads the provider's real state machine.
  breakerThreshold: 1,
  breakerCooldownMs: 30_000,
};

const VALID_HINTS = {
  schema_version: 'risk-hints.v1',
  instruction_injection_indicators: [],
  extracted_facts: {
    invoice_id: 'INV-2041',
    vendor_id: 'VEN-017',
    vendor_name: null,
    claimed_amount_minor: 300000,
    currency: 'USD',
    purchase_order_id: null,
    beneficiary_ref: 'BEN-017-VERIFIED',
    requested_bank_change: false,
  },
  missing_evidence: [],
  summary: 'Clean invoice text, no injection phrasing.',
};

/** A model adapter whose provider answers with whatever `respond` returns. */
function metaAdapter(respond: () => Response): ModelAdapter {
  const client = new MetaProviderClient(META_CONFIG, {
    fetchFn: (async () => respond()) as unknown as typeof fetch,
  });
  return createModelAdapter('meta', { meta: client });
}

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

describe('the audit chain is verified rather than asserted', () => {
  let t: ApiFixture;

  beforeAll(async () => {
    t = await freshApp();
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('verifies the chain of the tenant that produced the events', async () => {
    expect(await submitAction(t, 'run_chain_1')).toBe(201);
    // The sweep enumerates the tenants and recomputes every hash of each
    // chain. Before the fix nothing called this at all, so the zero-tolerance
    // objective could never leave MET.
    const sweep = await verifyAuditChains(t.runtime, { hmacKey: null });
    expect(sweep.tenants).toBeGreaterThan(0);
    expect(sweep.breaks).toBe(0);
  });

  it('publishes the verification result on the scrape', async () => {
    expect(await submitAction(t, 'run_chain_2')).toBe(201);
    const body = await scrapeMetrics(t);
    expect(seriesValue(body, 'pz_audit_chain_breaks')).toBe(0);
  });
});

describe('a broken audit chain is reported', () => {
  let t: ApiFixture;

  beforeAll(async () => {
    t = await freshApp();
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('publishes the break instead of the clean value the last sweep found', async () => {
    expect(await submitAction(t, 'run_chain_3')).toBe(201);
    await appendTamperedAuditEvent(t.db, t.tenantId);

    const sweep = await verifyAuditChains(t.runtime, { hmacKey: null });
    expect(sweep.breaks).toBeGreaterThan(0);

    // The gauge is what the `PermitZeroAuditChainBroken` alert reads, and it
    // has to be able to leave zero. This is the transition the alert exists
    // for.
    const body = await scrapeMetrics(t);
    expect(seriesValue(body, 'pz_audit_chain_breaks')).toBeGreaterThan(0);
  });
});

describe('the model provider reports its own activity', () => {
  let base: ApiFixture;

  beforeAll(async () => {
    base = await freshApp();
  });

  afterAll(async () => {
    await closeApp(base);
  });

  /**
   * A second app over the SAME database, with its own provider and its own
   * registry.
   *
   * Re-seeding per test would work too, but the seed is the one statement in
   * this suite that collides with a parallel run on the shared test database —
   * and the provider is the only thing that differs between these cases.
   */
  const appWithProvider = async (adapter: ModelAdapter): Promise<ApiFixture> => {
    const { app } = await buildApp({
      db: await testDb(),
      dbRuntime: await testRuntimeDb(),
      config: { ...testConfig(), modelProvider: 'meta' },
      model: adapter,
    });
    return { ...base, app };
  };

  const okResponse = (): Response =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_HINTS) } }] }), { status: 200 });

  it('counts a successful screening and its latency', async () => {
    const t = await appWithProvider(metaAdapter(okResponse));
    try {
      expect(await submitAction(t, 'run_model_ok')).toBe(201);
      const body = await scrapeMetrics(t);
      expect(seriesValue(body, 'pz_model_screenings_total', { status: 'OK' })).toBe(1);
      expect(seriesValue(body, 'pz_model_latency_seconds_count')).toBe(1);
    } finally {
      await closeApp(t);
    }
  });

  it('counts a failed screening, and reads the breaker the provider actually opened', async () => {
    const t = await appWithProvider(metaAdapter(() => new Response('upstream is unwell', { status: 500 })));
    try {
      // The screening fails, so the advice is degraded and the decision is not
      // an allow — the metrics must say so rather than staying silent.
      await submitAction(t, 'run_model_err');
      const body = await scrapeMetrics(t);
      expect(seriesValue(body, 'pz_model_screenings_total', { status: 'ERROR', error_class: 'PROVIDER_ERROR' })).toBe(
        1,
      );
      expect(seriesValue(body, 'pz_model_latency_seconds_count')).toBe(1);
      // The provider's own circuit breaker opened on the transport failure, and
      // the gauge reads the state machine rather than a constant.
      expect(seriesValue(body, 'pz_circuit_breaker_state', { dependency: 'meta' })).toBe(2);
    } finally {
      await closeApp(t);
    }
  });

  it('reports a closed breaker for a provider that is working', async () => {
    const t = await appWithProvider(metaAdapter(okResponse));
    try {
      expect(await submitAction(t, 'run_model_closed')).toBe(201);
      const body = await scrapeMetrics(t);
      expect(seriesValue(body, 'pz_circuit_breaker_state', { dependency: 'meta' })).toBe(0);
    } finally {
      await closeApp(t);
    }
  });
});

describe('the delivery lag is measured on the rows, not on the queue', () => {
  it('reports a non-zero lag while there is no queue at all', async () => {
    const t = await freshApp();
    try {
      // This fixture has no Redis and no dispatcher, so the queue is empty and
      // the queue's own age would read zero. The outbox row is still
      // unpublished, so the row's age must not.
      expect(await submitAction(t, 'run_lag_1')).toBe(201);
      const body = await scrapeMetrics(t);
      expect(seriesValue(body, 'pz_outbox_oldest_unpublished_age_seconds')).toBeGreaterThan(0);
      // The queue's own backlog is published under its own name, so the two
      // quantities cannot be read as one.
      expect(seriesValue(body, 'pz_outbox_oldest_job_age_seconds')).toBe(0);
    } finally {
      await closeApp(t);
    }
  });
});

describe('the credential budget is applied', () => {
  it('answers 429 once the auth budget is spent, and says the request is retryable', async () => {
    const t = await freshApp({ config: { rateLimitAuth: 2 } });
    try {
      expect(await submitAction(t, 'run_rl_1')).toBe(201);
      expect(await submitAction(t, 'run_rl_2')).toBe(201);
      const third = await postJson(t, '/v1/actions', t.agentToken, {
        agent_id: t.agentId,
        run_id: 'run_rl_3',
        task_purpose: 'Pay a verified invoice',
        tool_name: 'payment.execute',
        arguments: paymentArgs(),
        evidence_refs: [],
        idempotency_key: uniqueKey('run_rl_3'),
        environment: 'DEMO',
      });
      expect(third.status).toBe(429);
      const error = (third.json as { error: { code: string; retryable: boolean } }).error;
      expect(error.code).toBe('RATE_LIMITED');
      // A shed request was never processed, so telling the caller it is
      // retryable is the difference between a caller that backs off and a
      // caller that gives up.
      expect(error.retryable).toBe(true);
    } finally {
      await closeApp(t);
    }
  });
});
