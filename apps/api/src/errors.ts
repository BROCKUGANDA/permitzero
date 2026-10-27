/**
 * Error mapping for the HTTP boundary. Domain errors carry their own status
 * and envelope; everything else is normalized here so no stack trace, SQL
 * fragment or provider body ever reaches a response (PRD §12.3).
 */
import {
  BadRequestError,
  ConflictError,
  DomainError,
  ErrorCode,
  RateLimitedError,
  ValidationError,
  toDomainError,
} from '@permitzero/domain';
import type { ErrorEnvelope } from '@permitzero/domain';
import { ZodError } from 'zod';

export interface HttpError {
  status: number;
  envelope: ErrorEnvelope;
}

/** True for postgres driver errors (both `postgres` and `pg` shape this way). */
export function pgCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * Map storage errors to request failures. Returns null when the error is not
 * a recognized storage conflict and must surface as a 500 instead.
 */
export function mapStorageError(err: unknown): DomainError | null {
  switch (pgCode(err)) {
    case '23505':
      return new ConflictError('This request conflicts with existing data. Retry with a fresh idempotency key.');
    case '23514':
      return new ValidationError('The request violates a data constraint.');
    case '23503':
      return new ValidationError('The request references a resource that does not exist.');
    case '0A000':
      return new ConflictError('This record is frozen and cannot be modified.');
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'ETIMEDOUT':
      return new DomainError('A backing service is unreachable.', {
        code: ErrorCode.ENFORCEMENT_UNAVAILABLE,
        httpStatus: 503,
        retryable: true,
      });
    default:
      return null;
  }
}

/** Zod failures become a 422 with capped per-field detail. */
export function zodError(message: string, err: ZodError): ValidationError {
  const details: Record<string, string> = {};
  for (const issue of err.issues.slice(0, 10)) {
    const path = issue.path.length > 0 ? issue.path.join('.') : 'body';
    if (!(path in details)) details[path] = issue.message;
  }
  return new ValidationError(message, details);
}

function fastifyError(err: {
  code?: string;
  message?: string;
  statusCode?: number;
  issues?: unknown;
}): DomainError | null {
  switch (err.code) {
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return new BadRequestError('Request body must be JSON.');
    case 'FST_ERR_CTP_INVALID_JSON':
      return new DomainError('Request body is not valid JSON.', {
        code: ErrorCode.MALFORMED_JSON,
        httpStatus: 400,
      });
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return new DomainError('Request payload exceeds the configured size limit.', {
        code: ErrorCode.PAYLOAD_TOO_LARGE,
        httpStatus: 413,
      });
    case 'FST_ERR_VALIDATION': {
      const details = zodIssues(err);
      return new ValidationError('Request validation failed.', details ?? undefined);
    }
    case 'FST_TOO_MANY_REQUESTS':
      return new RateLimitedError();
    default:
      return null;
  }
}

/** fastify-type-provider-zod attaches the raw zod issues to validation errors. */
function zodIssues(err: { issues?: unknown }): Record<string, string> | null {
  if (!Array.isArray(err.issues)) return null;
  const details: Record<string, string> = {};
  for (const issue of err.issues.slice(0, 10)) {
    if (typeof issue !== 'object' || issue === null || !('message' in issue)) continue;
    const record = issue as { path?: unknown; message: unknown };
    const path = Array.isArray(record.path) && record.path.length > 0 ? record.path.join('.') : 'body';
    if (!(path in details)) details[path] = String(record.message);
  }
  return details;
}

export function toHttpError(err: unknown, traceId: string | null): HttpError {
  if (err instanceof ZodError) {
    const mapped = zodError('Request validation failed.', err);
    return { status: mapped.httpStatus, envelope: mapped.toEnvelope(traceId) };
  }
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const fastifyMapped = fastifyError(err as { code?: string; message?: string; statusCode?: number });
    if (fastifyMapped) {
      return { status: fastifyMapped.httpStatus, envelope: fastifyMapped.toEnvelope(traceId) };
    }
  }
  const storageMapped = mapStorageError(err);
  if (storageMapped) {
    return { status: storageMapped.httpStatus, envelope: storageMapped.toEnvelope(traceId) };
  }
  const domain = toDomainError(err);
  return { status: domain.httpStatus, envelope: domain.toEnvelope(traceId) };
}
