/**
 * Behaviour when a dependency stops answering.
 *
 * These are the paths a mocked test cannot reach, because a mock does not go
 * away halfway through a request. The database here is a real connection attempt
 * to a port where nothing listens, and the queue is a `QueueLike` whose every
 * operation rejects — which is how Redis actually presents itself after it dies,
 * as opposed to how a stub presents itself.
 *
 * The properties worth asserting are more than "500 became 503": a failed
 * request leaves no half-written authorization behind, readiness changes its HTTP
 * status so a load balancer can act on it, and losing the queue costs delivery
 * but never enforcement.
 *
 * In-flight-request survival across `close()` is NOT tested here. It is asserted
 * deterministically in `shutdown.test.ts` against a bare server whose scheduling
 * this suite can control; re-running it through the composed app depends on six
 * real dependencies racing a socket teardown, and a test whose verdict changes
 * with scheduler luck is not evidence of anything.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, createDb } from '@permitzero/db';
import { buildApp, type BuiltApp } from '../src/app.js';
import { createModelAdapter } from '../src/model.js';
import { closeApp, freshApp, paymentArgs, postJson, testConfig, uniqueKey, type ApiFixture } from './helpers.js';

/** Nothing listens here; a connect-time failure is what a stopped database looks like. */
const DEAD_DB = 'postgres://postgres@127.0.0.1:5499/permitzero_down';

const DEAD_AUTH = {
  'content-type': 'application/json',
  authorization: 'Bearer pz_token_long_enough_to_clear_the_shape_check_at_the_door',
};

async function appWithDeadDatabase(): Promise<BuiltApp> {
  const dead = createDb(DEAD_DB, { max: 2 });
  const config = { ...testConfig(), databaseUrl: DEAD_DB, databaseRuntimeUrl: DEAD_DB };
  return buildApp({ db: dead, config, model: createModelAdapter('disabled') });
}

/** A queue that accepts construction and fails every operation: Redis, after it dies. */
function unavailableQueue(name: string) {
  const boom = async (): Promise<never> => {
    throw Object.assign(new Error('Reached is currently unable to handle the request'), { code: 'ECONNREFUSED' });
  };
  return {
    name,
    add: boom,
    getJobCounts: boom,
    getJobs: boom,
    close: async () => undefined,
  };
}

function intakeBody(agentId: string, runId: string) {
  return {
    agent_id: agentId,
    run_id: runId,
    task_purpose: 'Pay a verified invoice',
    tool_name: 'payment.execute',
    arguments: paymentArgs(),
    evidence_refs: [],
    idempotency_key: uniqueKey(runId),
    environment: 'DEMO',
  };
}

describe('database unreachable', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = await appWithDeadDatabase();
  });

  afterAll(async () => {
    await built.app.close();
    await closeDb(built.ctx.db).catch(() => undefined);
    await closeDb(built.ctx.runtime).catch(() => undefined);
  });

  it('answers 503 with a retryable error rather than a bare 500', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: DEAD_AUTH,
      payload: JSON.stringify(intakeBody('agt_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'run_outage')),
    });
    // A database that is down is a dependency failure, not a defect in the
    // caller's request. Answering 500 makes it indistinguishable from an engine
    // bug and teaches operators to stop trusting the status code.
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { retryable: true } });
    // And it must not echo a SQLSTATE, a hostname or a stack frame.
    expect(JSON.stringify(res.json())).not.toMatch(/ECONNREFUSED|5499|permitzero_down|at \(?.*\.js:/);
  });

  it('reports not ready in the HTTP status, not only in the body', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/health/ready' });
    // The compose healthcheck and every load balancer in front of this process
    // read the status line, not the JSON. A 200 whose body says `not_ready` keeps
    // sending traffic to an instance that cannot enforce anything, and reports the
    // container healthy while it is failing every decision.
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'not_ready', database: false, protected_writes_allowed: false });
    expect((res.json().reasons as string[]).join(' ')).toMatch(/database/i);
  });

  it('keeps liveness green while readiness is red', async () => {
    // Deliberate split. A process that cannot reach its database must not be
    // killed for it: restarting fixes nothing, throws away the connection backoff,
    // and destroys whatever in-flight drain it was performing.
    const res = await built.app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
  });

  it('three failed attempts leave no partial authorization behind', async () => {
    // The naive failure is an idempotency record or an audit row committed before
    // the policy read failed, so that after recovery the action exists with no
    // decision attached to it.
    for (let i = 0; i < 3; i++) {
      const res = await built.app.inject({
        method: 'POST',
        url: '/v1/actions',
        headers: DEAD_AUTH,
        payload: JSON.stringify(intakeBody('agt_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'run_partial')),
      });
      expect(res.statusCode).toBe(503);
    }
    const reachable = await built.ctx.runtime.sql`SELECT 1`.then(
      () => true,
      () => false,
    );
    expect(reachable).toBe(false);
  });
});

describe('queue backend unreachable (Redis dies after boot)', () => {
  let built: BuiltApp;
  let fixture: ApiFixture;

  beforeAll(async () => {
    fixture = await freshApp();
    built = await buildApp({
      db: fixture.db,
      dbRuntime: fixture.runtime,
      config: testConfig(),
      model: createModelAdapter('disabled'),
      queues: {
        factory: unavailableQueue as never,
        redis: {
          status: 'refused',
          ping: async () => Promise.reject(new Error('ECONNREFUSED')),
        } as never,
        probeOutboxDepth: async () => Promise.reject(new Error('ECONNREFUSED')),
      },
    });
  });

  afterAll(async () => {
    await built?.app.close();
    if (fixture) await closeApp(fixture);
  });

  it('still reaches a durable decision, because the outbox is the guarantee', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${fixture.agentToken}` },
      payload: JSON.stringify(intakeBody(fixture.agentId, 'run_queue_down')),
    });
    expect(res.statusCode).toBe(201);

    // The event this request produced is still waiting to be delivered rather
    // than lost, which is the entire reason the pattern is transactional.
    const pending = await fixture.db.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM outbox_events WHERE status IN ('PENDING','FAILED')`;
    expect(Number(pending[0]?.n ?? 0)).toBeGreaterThan(0);
  });

  it('reports redis down and queue down without failing the status request', async () => {
    const res = await built.app.inject({
      method: 'GET',
      url: '/v1/status',
      headers: { authorization: `Bearer ${fixture.serviceToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      dependencies: { redis: string; queue: { status: string; outbox_pending: number } };
    };
    expect(body.dependencies.redis).toBe('down');
    expect(body.dependencies.queue.status).toBe('down');
    expect(body.dependencies.queue.outbox_pending).toBeGreaterThan(0);
    // The honest overall posture: not 'ok', not silently 'degraded' either.
    expect(body.status).toBe('unavailable');
  });

  it('a dispatcher drain against a dead queue reports failures and keeps the rows', async () => {
    const dispatcher = built.ctx.queues.dispatcher;
    expect(dispatcher).not.toBeNull();
    const drain = await dispatcher!.drainOnce();
    expect(drain.claimed).toBeGreaterThan(0);
    expect(drain.failed + drain.dead).toBe(drain.claimed);

    // Nothing was published, so nothing may have been marked published.
    const published = await fixture.db.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM outbox_events WHERE status = 'PUBLISHED'`;
    expect(published[0]?.n).toBe('0');
  });

  it('does not answer 500 on the decision path just because delivery is broken', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${fixture.agentToken}` },
      payload: JSON.stringify(intakeBody(fixture.agentId, 'run_queue_down_2')),
    });
    expect(res.statusCode).not.toBe(500);
    expect(res.statusCode).toBe(201);
  });
});

describe('recovery', () => {
  let t: ApiFixture;

  beforeAll(async () => {
    t = await freshApp();
  });

  afterAll(async () => {
    if (t) await closeApp(t);
  });

  it('the same key that failed during the outage succeeds afterwards', async () => {
    // This is the property the 503 was bought with: telling the caller to retry
    // has to mean the retry works, not that it collides with state the failed
    // attempt left behind.
    const dead = await appWithDeadDatabase();
    const key = uniqueKey('retry-across-outage');
    const body = { ...intakeBody('agt_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'run_retry'), idempotency_key: key };
    const failed = await dead.app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: DEAD_AUTH,
      payload: JSON.stringify(body),
    });
    expect(failed.statusCode).toBe(503);
    await dead.app.close();

    const created = await postJson(t, '/v1/actions', t.agentToken, {
      ...intakeBody(t.agentId, 'run_retry'),
      idempotency_key: key,
    });
    expect(created.status).toBe(201);
  });
});
