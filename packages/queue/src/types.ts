import { DomainError, ErrorCode, toDomainError } from '@permitzero/domain';
import { QUEUE_NAMES, type QueueName } from './names.js';

/** Minimal structural view of ioredis, so tests can supply a real client and
 * the health probe does not need the concrete class. */
export interface RedisLike {
  status: string;
  ping(): Promise<string>;
}

/** Minimal structural view of a BullMQ queue. */
export interface QueueLike {
  name: string;
  add(jobName: string, data: unknown, opts?: Record<string, unknown>): Promise<{ id?: string }>;
  getJobCounts(): Promise<Record<string, number>>;
  getJobs(status: ('waiting' | 'delayed' | 'active')[], start?: number, end?: number): Promise<
    { timestamp?: number; addedOn?: number }[]
  >;
  close(): Promise<void>;
}

export interface QueueFactory {
  (name: QueueName): QueueLike;
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

export function classifyQueueError(err: unknown): { retryable: boolean; errorClass: string } {
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
