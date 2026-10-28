/**
 * The Redis circuit breaker.
 *
 * A connection that is known to be down should not be asked again on every
 * poll. Each attempt costs a deadline's worth of waiting and, in the
 * dispatcher's case, one of the row's remaining attempts: a queue outage that
 * outlasts `maxAttempts` polls would park every committed event as DEAD, which
 * is a worse outcome than the outage that caused it.
 *
 * The breaker therefore answers one question — "may I try?" — and nothing
 * else. It does not retry, does not schedule, and does not decide what
 * happens to a row: it only refuses attempts while it is open, and it opens
 * again after a reset window so a recovered Redis is noticed rather than
 * waited for.
 *
 * Three states:
 *
 *   closed     — everything is allowed.
 *   open       — nothing is allowed. The backend was unreachable often enough
 *                 in a row that trying again is the likely cause of the
 *                 damage.
 *   half_open  — exactly one attempt is allowed through, to find out whether
 *                 the backend came back. Success closes the breaker, failure
 *                 opens it again with a fresh window.
 */
import { QueueTimeoutError } from './types.js';

export type RedisCircuitState = 'closed' | 'open' | 'half_open';

export interface RedisCircuitBreakerOptions {
  /** Consecutive failures that open the breaker. */
  failureThreshold?: number;
  /** How long the breaker stays open before one probe is allowed through. */
  resetTimeoutMs?: number;
  /** Clock, injectable so the tests do not have to wait. */
  now?: () => number;
}

/**
 * True for the failures that mean "the backend is not reachable" as opposed to
 * "the backend answered and refused". A business error must not open the
 * breaker: a poison payload is one bad job, not a dead server.
 */
export function isTransportFailure(err: unknown): boolean {
  if (err instanceof QueueTimeoutError) return true;
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('connection is closed') ||
    message.includes("stream isn't writeable") ||
    message.includes('max retries per request') ||
    message.includes('command timed out') ||
    message.includes('connection timeout')
  );
}

export class RedisCircuitBreaker {
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly now: () => number;
  private failures = 0;
  private openedAt = 0;
  private probeInFlight = false;
  private currentState: RedisCircuitState = 'closed';

  constructor(opts: RedisCircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 10_000;
    this.now = opts.now ?? (() => Date.now());
  }

  get state(): RedisCircuitState {
    return this.currentState;
  }

  /** True while the breaker refuses everything. */
  isOpen(): boolean {
    return this.currentState === 'open';
  }

  /**
   * May the next attempt go through?
   *
   * An open breaker whose reset window has elapsed moves to half-open and lets
   * exactly one attempt through: the probe that decides whether the backend
   * is back. A half-open breaker that is already probing refuses the rest.
   */
  canAttempt(): boolean {
    if (this.currentState === 'closed') return true;
    if (this.currentState === 'open') {
      if (this.now() - this.openedAt < this.resetTimeoutMs) return false;
      this.currentState = 'half_open';
      this.probeInFlight = false;
    }
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.probeInFlight = false;
    this.currentState = 'closed';
  }

  /**
   * A transport failure. In half-open it reopens the breaker immediately — the
   * probe was the answer, and the answer was "still down". Otherwise it
   * counts towards the threshold.
   */
  recordFailure(): void {
    this.probeInFlight = false;
    this.failures += 1;
    if (this.currentState === 'half_open' || this.failures >= this.failureThreshold) {
      this.currentState = 'open';
      this.openedAt = this.now();
    }
  }
}
