import { DomainError, ErrorCode, toDomainError } from '@permitzero/domain';
import { QUEUE_NAMES, type QueueName } from './names.js';

/** Minimal structural view of ioredis, so tests can supply a real client and
 *  the health probe does not need the concrete class. */
export interface RedisLike {
  status: string;
  ping(): Promise<string>;
}

/**
 * A job as the queue ports expose it.
 *
 * `data` and `name` are here because the dead-letter sweep has to read what a
 * dead job was carrying: a redrive that cannot see the payload is a redrive
 * that publishes an empty job. Both are optional so a port implementation that
 * only tracks timing still satisfies the shape.
 */
export interface QueueJobSummary {
  id?: string;
  name?: string;
  timestamp?: number;
  addedOn?: number;
  data?: unknown;
}

/** Minimal structural view of a BullMQ queue. */
export interface QueueLike {
  name: string;
  /**
   * Add a job.
   *
   * A job id, when given, is the job's identity: a queue that treats job
   * ids as unique REFUSES a second job with an id it already holds instead
   * of publishing it twice (BullMQ does exactly this). That is what makes a
   * retry of an enqueue safe, so the id a caller passes has to be the
   * identity of the work and not a fresh value from the clock.
   */
  add(jobName: string, data: unknown, opts?: Record<string, unknown>): Promise<{ id?: string }>;
  getJobCounts(): Promise<Record<string, number>>;
  getJobs(statuses: ('waiting' | 'delayed' | 'active')[], start?: number, end?: number): Promise<QueueJobSummary[]>;
  /**
   * Remove a job by id, if the backend can.
   *
   * The dead-letter sweep needs this. A dead letter whose redrive has
   * finished is still eligible until something says otherwise, and the
   * something has to outlive the process: a queue's own retention model is
   * the only durable record of "this has been dealt with" that a restart
   * cannot lose. A port that cannot remove reports that it could not, and
   * the sweep falls back to the marker it writes into the queue.
   */
  remove?(jobId: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface QueueFactory {
  (name: QueueName): QueueLike;
  /**
   * False when the backend is known to be down.
   *
   * The dispatcher asks before it claims: a row that is claimed and cannot be
   * published burns one of its attempts per poll, and a Redis outage that lasts
   * longer than `maxAttempts` polls would park every committed event as DEAD.
   * Not knowing is not the same as knowing — an implementation that cannot tell
   * leaves this off, and the dispatcher assumes the backend is up.
   */
  available?(): boolean;
}

/**
 * A job payload carries identifiers and minimal metadata only — never secrets
 * and never large evidence bodies (Master Prompt §12.4). Handlers reload the
 * authoritative row before acting.
 */
export interface OutboxJobPayload {
  outboxId: string;
  tenantId: string;
  eventType: string;
  traceId: string | null;
  publishedAt: string;
}

export function outboxJobPayload(row: {
  id: string;
  tenantId: string;
  eventType: string;
  traceId: string | null;
}): OutboxJobPayload {
  return {
    outboxId: row.id,
    tenantId: row.tenantId,
    eventType: row.eventType,
    traceId: row.traceId,
    publishedAt: new Date().toISOString(),
  };
}

export class QueueUnavailableError extends DomainError {
  constructor(message = 'Queue backend unavailable.') {
    super(message, {
      code: ErrorCode.ENFORCEMENT_UNAVAILABLE,
      httpStatus: 503,
      retryable: true,
    });
    this.name = 'QueueUnavailableError';
  }
}

/**
 * The Redis circuit breaker is open: the backend was unreachable often enough
 * that asking it again is worse than waiting for the breaker's reset window.
 */
export class QueueCircuitOpenError extends QueueUnavailableError {
  constructor(message = 'Queue circuit breaker is open.') {
    super(message);
    this.name = 'QueueCircuitOpenError';
  }
}

/**
 * A queue command outlived its deadline.
 *
 * This is the failure the whole bounded-deadline design exists for. Without a
 * deadline, a command against a dead Redis never rejects — it waits on a
 * promise that will not settle — and the caller waits with it, forever.
 */
export class QueueTimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(`${label} did not complete within ${timeoutMs}ms.`);
    this.name = 'QueueTimeoutError';
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The outbox freeze trigger (`0005_credential_names_outbox_freeze.sql`)
 * refuses to update a PUBLISHED row and raises `feature_not_supported`
 * (SQLSTATE 0A000). That rejection is not a fault: it means a peer dispatcher
 * published the row first, so the row is no longer ours to move. It is
 * reported as `OUTBOX_ALREADY_CLAIMED` and treated as non-retryable, because
 * retrying a row somebody else already delivered is how one event becomes two.
 */
function isOutboxFreezeRejection(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth++) {
    const candidate = current as { code?: unknown; message?: unknown };
    if (candidate.code === '0A000') return true;
    if (typeof candidate.message === 'string' && candidate.message.includes('feature_not_supported')) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function classifyQueueError(err: unknown): { retryable: boolean; errorClass: string } {
  // Before the DomainError branch: these carry the queue's own vocabulary,
  // which is what an operator reads in the event stream.
  if (err instanceof QueueCircuitOpenError) {
    return { retryable: true, errorClass: 'QUEUE_CIRCUIT_OPEN' };
  }
  if (err instanceof QueueTimeoutError) {
    return { retryable: true, errorClass: 'QUEUE_TIMEOUT' };
  }
  if (err instanceof QueueUnavailableError) {
    return { retryable: true, errorClass: 'QUEUE_UNAVAILABLE' };
  }
  if (isOutboxFreezeRejection(err)) {
    return { retryable: false, errorClass: 'OUTBOX_ALREADY_CLAIMED' };
  }
  if (err instanceof DomainError) {
    return { retryable: err.retryable, errorClass: String(err.code) };
  }
  const domain = toDomainError(err);
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (message.includes('econnrefused') || message.includes('connection is closed')) {
    return { retryable: true, errorClass: 'QUEUE_CONNECTION_REFUSED' };
  }
  if (message.includes('timeout')) {
    return { retryable: true, errorClass: 'QUEUE_TIMEOUT' };
  }
  return {
    retryable: domain.retryable,
    errorClass: domain.code === ErrorCode.INTERNAL ? 'QUEUE_UNKNOWN_ERROR' : String(domain.code),
  };
}

export function isKnownQueue(name: string): name is QueueName {
  return (Object.values(QUEUE_NAMES) as string[]).includes(name);
}
