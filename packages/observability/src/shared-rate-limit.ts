/**
 * A rate-limit budget that every replica of the API shares.
 *
 * The limiter that ships with Fastify keeps its counters in the process that
 * runs it, so a deployment with N replicas enforces N times the intended rate.
 * The control is real — it is just N times too generous, and nobody notices
 * until the abuse it was meant to stop actually happens. A cleverer in-process
 * counter does not fix that; the counter has to live outside the process, and
 * the only thing outside the process that every replica already depends on is
 * Redis.
 *
 * What the budget is charged against is the CREDENTIAL, not the client
 * address. Two reasons, and the first one is the important one:
 *
 *   · Behind the edge proxy every tenant of every customer shares one address.
 *     An address-keyed budget is therefore a budget one tenant can exhaust on
 *     behalf of all the others — an availability hole wearing the clothes of a
 *     security control, which is the failure this whole mechanism exists to
 *     stop.
 *   · The address is also the part of the request an attacker most wants to
 *     change. It is only trustworthy because the proxy is trusted, and that
 *     trust is a deployment fact rather than a property of the credential.
 *
 * The credential's hash is the key: the same credential is the same caller from
 * every address and from every replica, and two different credentials never
 * share a budget. The hash, not the credential, because the key lives in Redis
 * where anybody with read access to it learns a list of active credentials.
 *
 * The window is a fixed one, and the key carries the window it belongs to, so
 * the counter resets on a boundary rather than sliding: a request that arrives
 * just before the boundary is charged to the window it arrived in, and the
 * next request starts a fresh allowance. The expiry is set when the counter is
 * created and never refreshed, so a counter for a window that has passed
 * disappears instead of accumulating in Redis forever.
 *
 * Fail OPEN when the counter cannot be read. An outage of the limiter must not
 * take the authorization API down with it: the limiter is a defence against
 * abuse, not the control that decides whether an action is allowed, and a plane
 * that refuses every decision because its rate limiter is unreachable has
 * turned a defence into an outage. The local (per-process) limit is kept as
 * the floor for exactly this case — a request that could not be counted is
 * still subject to the local budget — and every failure is reported, so a
 * limiter that is quietly not enforcing anything is visible rather than
 * silent.
 */
import { createHash } from 'node:crypto';

/**
 * The Redis commands this module needs, and nothing else.
 *
 * A structural type rather than the ioredis import: this package is
 * framework-free on purpose, and a Redis client is just as much a framework
 * as a web framework. The application's own client satisfies this shape.
 */
export interface SharedCounterClient {
  /** 'ready' when the connection can serve commands. */
  readonly status: string;
  /**
   * Run a script on the server.
   *
   * A script rather than two commands because Redis runs a script atomically,
   * and "increment, and set the expiry only if this is the first request in
   * this window" is two steps. Done as two round trips, a crash between them
   * leaves a counter with no expiry — and a credential that is then locked out
   * for the lifetime of the deployment, which is a self-inflicted denial of
   * service on the tenant whose credential it was.
   */
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

/**
 * Increment the counter and set its expiry only when the counter is created.
 *
 * The expiry is deliberately not refreshed on every request: a counter whose
 * TTL slides forward with every request never ends while traffic continues,
 * and the window would stop being a window.
 */
export const SHARED_COUNTER_SCRIPT = [
  "local count = redis.call('INCR', KEYS[1])",
  'if count == 1 then',
  "  redis.call('EXPIRE', KEYS[1], ARGV[1])",
  'end',
  'return count',
].join('\n');

/**
 * The counter, as the limiter sees it.
 *
 * `null` means the counter could not be read — not zero. Zero would say "this
 * credential has spent nothing", which is a claim; null says "nobody knows",
 * which is the truth.
 */
export interface SharedCounterStore {
  /** The count after this increment, or null when the counter was unreachable. */
  increment(key: string, windowSeconds: number): Promise<number | null>;
}

export interface SharedCounterOptions {
  /** Called when a command fails. The failure is not fatal: the caller fails open. */
  onError?: (err: unknown) => void;
}

/**
 * A Redis-backed counter.
 *
 * The readiness check is not an optimisation. A command issued while the
 * connection is still being established is refused by the client rather than
 * queued behind the handshake, and a queued command is a request waiting for a
 * Redis that may never answer. The budget is simply not enforced for that
 * request, which the caller counts.
 */
export function createSharedCounter(client: SharedCounterClient, opts: SharedCounterOptions = {}): SharedCounterStore {
  return {
    async increment(key: string, windowSeconds: number): Promise<number | null> {
      if (client.status !== 'ready') return null;
      try {
        const value = await client.eval(SHARED_COUNTER_SCRIPT, 1, key, Math.max(1, Math.ceil(windowSeconds)));
        const count = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(count) ? count : null;
      } catch (err) {
        opts.onError?.(err);
        return null;
      }
    },
  };
}

/**
 * The identity a budget is charged against: the presented credential, hashed.
 *
 * SHA-256 rather than a fast hash, because the input is a low-entropy secret
 * and a fast hash would be a rainbow table away from the credential itself.
 */
export function credentialFingerprint(credential: string): string {
  return createHash('sha256').update(credential, 'utf8').digest('hex');
}

export interface SharedRateLimiterOptions {
  store: SharedCounterStore;
  /**
   * Namespace for the counter keys.
   *
   * Two deployments that share a Redis must not share a budget, so the prefix
   * is part of the environment rather than a constant: a staging and a
   * production deployment pointed at one Redis would otherwise spend each
   * other's allowance.
   */
  prefix: string;
  /** Requests allowed per window. */
  max: number;
  /** Window length in milliseconds. */
  timeWindowMs: number;
  /**
   * What the budget is for — 'auth', 'mutation'.
   *
   * Part of the key, so the two budgets never interfere: a credential that is
   * allowed a hundred reads a minute is not thereby allowed a hundred writes.
   */
  scope: string;
  /** Clock, injectable so the window boundary can be tested. */
  now?: () => number;
}

export interface SharedBudgetDecision {
  /** False when the shared budget is exhausted. */
  allowed: boolean;
  /** The count after this request; null when the counter could not be read. */
  count: number | null;
  /** True when the counter could not be read: the budget was NOT enforced. */
  unavailable: boolean;
  /** Seconds until the current window ends. */
  retryAfterSeconds: number;
}

/**
 * One budget, charged against one credential.
 *
 * The class holds no state of its own: the count lives in Redis, which is the
 * entire point. Two instances with the same prefix and scope are the same
 * budget, in the same process or in two different ones.
 */
export class SharedRateLimiter {
  private readonly now: () => number;

  constructor(private readonly opts: SharedRateLimiterOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** The counter key this limiter charges. Exposed for tests and for operators. */
  keyFor(credential: string, nowMs: number = this.now()): string {
    const bucket = Math.floor(nowMs / this.opts.timeWindowMs);
    return `${this.opts.prefix}:${this.opts.scope}:${credentialFingerprint(credential)}:${bucket}`;
  }

  /**
   * Charge one request against the budget.
   *
   * The count is the number of requests INCLUDING this one, so the allowance
   * of `max` means the first `max` requests pass and the next one does not.
   */
  async charge(credential: string): Promise<SharedBudgetDecision> {
    const nowMs = this.now();
    const bucket = Math.floor(nowMs / this.opts.timeWindowMs);
    const key = this.keyFor(credential, nowMs);
    const count = await this.opts.store.increment(key, this.opts.timeWindowMs / 1000);
    const retryAfterSeconds = Math.max(1, Math.ceil(((bucket + 1) * this.opts.timeWindowMs - nowMs) / 1000));
    if (count === null) {
      // Fail open. The caller keeps the local limit as the floor and counts
      // this, so the outage is visible in the metrics rather than in the
      // incident channel.
      return { allowed: true, count: null, unavailable: true, retryAfterSeconds };
    }
    return {
      allowed: count <= this.opts.max,
      count,
      unavailable: false,
      retryAfterSeconds,
    };
  }
}
