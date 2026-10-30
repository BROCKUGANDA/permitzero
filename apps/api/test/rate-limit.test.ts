/**
 * The shared rate-limit budget, asserted against a real Redis.
 *
 * The claim being tested is narrow and specific: the budget a credential has
 * is the same budget in every replica, and it is the same budget for the same
 * credential and not for a different one. A per-process limiter cannot be
 * tested for that at all, because two processes in one test file would each
 * have their own counter and both would pass — which is exactly what the
 * production deployment with N replicas does.
 *
 * So these tests use a real Redis and two independent app instances, which
 * are two processes as far as the limiter is concerned: separate local
 * counters, one shared counter.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import IORedis from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { createSharedCounter, SharedRateLimiter } from '@permitzero/observability';
import { buildApp } from '../src/app.js';
import type { AppContext } from '../src/app.js';
import { createModelAdapter } from '../src/model.js';
import type { ApiConfig } from '../src/config.js';
import { freshApp, intakeBody, testConfig, testDb, testRuntimeDb, type ApiFixture } from './helpers.js';

// The root `.env` is loaded by the test harness before this file reads the
// environment, so CI's Redis (a service container on its own port) is found
// here exactly as it is found by the queue.
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';

/** A dead port: nothing listens there, which is what a Redis outage looks like. */
const DEAD_REDIS_URL = 'redis://127.0.0.1:5499';

let fixture: ApiFixture;

function uniquePrefix(): string {
  return `pz-test-rl-${randomBytes(6).toString('hex')}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

/**
 * A connected Redis.
 *
 * The counter refuses to charge a client that is not ready — a command issued
 * before the handshake is refused rather than queued — so a test that means to
 * exercise the counter waits for the connection the way the application does
 * at boot.
 */
async function readyRedis(url = REDIS_URL): Promise<IORedis> {
  const client = new IORedis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  await waitFor(() => Promise.resolve(client.status === 'ready'), 5_000, 'the redis connection');
  return client;
}

/**
 * An app on the test database, with its own configuration.
 *
 * Two of these are two processes as far as the rate limiter is concerned:
 * separate in-process counters, and — when they are pointed at the same
 * Redis — one shared counter.
 */
async function appWith(overrides: Partial<ApiConfig>): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const db = await testDb();
  const runtime = await testRuntimeDb();
  const built = await buildApp({
    db,
    dbRuntime: runtime,
    config: { ...testConfig(), ...overrides },
    model: createModelAdapter('disabled'),
  });
  return built;
}

/** A request that carries a credential, which is what the budget is charged on. */
async function withCredential(app: FastifyInstance, token: string, url = '/v1/me'): Promise<number> {
  const res = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
  return res.statusCode;
}

beforeAll(async () => {
  fixture = await freshApp();
  // The shared counter must be reachable or none of these tests mean anything,
  // and a missing Redis in CI would otherwise look like a limiter that does
  // not work.
  const probe = new IORedis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await probe.connect();
    await probe.ping();
  } catch (err) {
    throw new Error(
      `The shared rate limit needs a Redis at ${REDIS_URL} (${err instanceof Error ? err.message : String(err)}).`,
    );
  } finally {
    probe.disconnect();
  }
});

describe('the shared rate-limit budget', () => {
  it('is exhausted across two processes that share the counter', async () => {
    process.env['RATE_LIMIT_REDIS_PREFIX'] = uniquePrefix();
    const first = await appWith({ redisUrl: REDIS_URL, rateLimitAuth: 2, rateLimitMax: 10_000 });
    const second = await appWith({ redisUrl: REDIS_URL, rateLimitAuth: 2, rateLimitMax: 10_000 });
    try {
      // The first process spends the shared allowance.
      expect(await withCredential(first.app, fixture.agentToken)).toBe(200);
      expect(await withCredential(first.app, fixture.agentToken)).toBe(200);

      // The second process has its own local budget — this is the first
      // request it has seen — and is refused anyway, because the allowance
      // lives in Redis and not in the process.
      const refused = await second.app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { authorization: `Bearer ${fixture.agentToken}` },
      });
      expect(refused.statusCode).toBe(429);
      expect((refused.json() as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
    } finally {
      await first.app.close();
      await second.app.close();
      delete process.env['RATE_LIMIT_REDIS_PREFIX'];
    }
  });

  it('frees the budget when the window passes, and the counter expires with it', async () => {
    const prefix = uniquePrefix();
    const client = await readyRedis();
    try {
      const limiter = new SharedRateLimiter({
        store: createSharedCounter(client),
        prefix,
        scope: 'auth',
        max: 2,
        timeWindowMs: 1_000,
      });
      const credential = 'pz_test_credential';

      expect((await limiter.charge(credential)).allowed).toBe(true);
      expect((await limiter.charge(credential)).allowed).toBe(true);
      const refused = await limiter.charge(credential);
      expect(refused.allowed).toBe(false);
      expect(refused.count).toBe(3);

      // The counter carries an expiry, set when it was created.
      const key = limiter.keyFor(credential);
      expect(await client.ttl(key)).toBeGreaterThan(0);

      // Once the window has passed the allowance is back.
      await sleep(1_000 - (Date.now() % 1_000) + 25);
      const afterWindow = await limiter.charge(credential);
      expect(afterWindow.allowed).toBe(true);
      expect(afterWindow.count).toBe(1);

      // And the counter of the window that ended is gone from Redis rather
      // than left behind forever.
      await waitFor(async () => (await client.exists(key)) === 0, 3_000, 'the counter to expire');
    } finally {
      client.disconnect();
    }
  });

  it('fails open when Redis is unavailable, and the local limit still applies', async () => {
    const built = await appWith({ redisUrl: DEAD_REDIS_URL, rateLimitAuth: 2, rateLimitMax: 10_000 });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        statuses.push(await withCredential(built.app, fixture.agentToken));
      }
      // The outage of the limiter is not an outage of the API.
      expect(statuses.filter((s) => s >= 500)).toEqual([]);
      // The request that could not be counted is still subject to a limit:
      // the local budget is the floor, and it is still there.
      expect(statuses.filter((s) => s === 429).length, 'the local limit did not apply').toBeGreaterThan(0);
      // And the failure is counted, so a limiter that is quietly not enforcing
      // anything is visible rather than silent.
      const failures = await built.ctx.metrics.sharedRateLimitFailures.get();
      expect(failures.values.reduce((sum, sample) => sum + sample.value, 0)).toBeGreaterThan(0);
    } finally {
      await built.app.close();
    }
  });

  it('keeps two different credentials on separate budgets', async () => {
    process.env['RATE_LIMIT_REDIS_PREFIX'] = uniquePrefix();
    const client = await readyRedis();
    try {
      const limiter = new SharedRateLimiter({
        store: createSharedCounter(client),
        prefix: process.env['RATE_LIMIT_REDIS_PREFIX'] as string,
        scope: 'auth',
        max: 2,
        timeWindowMs: 60_000,
      });
      expect((await limiter.charge('pz_credential_one')).allowed).toBe(true);
      expect((await limiter.charge('pz_credential_one')).allowed).toBe(true);
      // A different credential has an allowance of its own.
      expect((await limiter.charge('pz_credential_two')).allowed).toBe(true);
      // ...and the first one is still exhausted.
      expect((await limiter.charge('pz_credential_one')).allowed).toBe(false);
    } finally {
      client.disconnect();
      delete process.env['RATE_LIMIT_REDIS_PREFIX'];
    }
  });

  it('charges the credential rather than the address', async () => {
    process.env['RATE_LIMIT_REDIS_PREFIX'] = uniquePrefix();
    const built = await appWith({ redisUrl: REDIS_URL, rateLimitAuth: 2, rateLimitMax: 10_000 });
    try {
      // Two different credentials, one address. Under an address-keyed budget
      // the second one would be refused for the first one's spending, which is
      // how one tenant behind the edge proxy exhausts the allowance of all
      // the others.
      expect(await withCredential(built.app, fixture.agentToken)).toBe(200);
      expect(await withCredential(built.app, fixture.agentToken)).toBe(200);
      expect(await withCredential(built.app, fixture.ownerToken)).toBe(200);
      // The first credential is spent, though.
      expect(await withCredential(built.app, fixture.agentToken)).toBe(429);
    } finally {
      await built.app.close();
      delete process.env['RATE_LIMIT_REDIS_PREFIX'];
    }
  });

  it('shares the mutation budget across processes as well', async () => {
    process.env['RATE_LIMIT_REDIS_PREFIX'] = uniquePrefix();
    const first = await appWith({ redisUrl: REDIS_URL, rateLimitMutations: 1, rateLimitMax: 10_000 });
    const second = await appWith({ redisUrl: REDIS_URL, rateLimitMutations: 1, rateLimitMax: 10_000 });
    try {
      const body = JSON.stringify(
        intakeBody(fixture.agentId, {
          run_id: 'run_shared_mutation',
          idempotency_key: `shared-${randomBytes(4).toString('hex')}`,
        }),
      );
      const post = async (app: FastifyInstance): Promise<number> => {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/actions',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${fixture.agentToken}` },
          payload: body,
        });
        return res.statusCode;
      };
      expect(await post(first.app)).toBe(201);
      // The second process has a fresh local budget and is still refused: the
      // mutation budget is spent from the same pot.
      expect(await post(second.app)).toBe(429);
    } finally {
      await first.app.close();
      await second.app.close();
      delete process.env['RATE_LIMIT_REDIS_PREFIX'];
    }
  });
});

afterAll(async () => {
  await fixture?.app.close();
});
