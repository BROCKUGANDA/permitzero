/**
 * Domain errors and the stable API error envelope (PRD §10.9).
 *
 * Every error that can reach an HTTP boundary is a DomainError carrying a stable
 * `code`, an HTTP status, and a `retryable` flag. Unknown programming errors are
 * mapped to a generic 500 with a trace ID — stack traces and provider bodies stay
 * server-side (Master Prompt §8, PRD §12.3).
 */

/** Stable envelope codes. Distinct from reason codes: these describe the failure
 * of the *request*, reason codes describe the outcome of a *decision*. */
export const ErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  MALFORMED_JSON: 'MALFORMED_JSON',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  CONFLICT: 'CONFLICT',
  STALE_REVISION: 'STALE_REVISION',
  IDEMPOTENCY_KEY_REUSE: 'IDEMPOTENCY_KEY_REUSE',
  APPROVAL_INVALIDATED: 'APPROVAL_INVALIDATED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
  CANONICALIZATION_FAILED: 'CANONICALIZATION_FAILED',
  ILLEGAL_STATE_TRANSITION: 'ILLEGAL_STATE_TRANSITION',
  PERMIT_INVALID: 'PERMIT_INVALID',
  POLICY_ENGINE_UNAVAILABLE: 'POLICY_ENGINE_UNAVAILABLE',
  AUDIT_WRITE_FAILED: 'AUDIT_WRITE_FAILED',
  ENFORCEMENT_UNAVAILABLE: 'ENFORCEMENT_UNAVAILABLE',
  EMERGENCY_STOP_ACTIVE: 'EMERGENCY_STOP_ACTIVE',
  MODEL_PROVIDER_ERROR: 'MODEL_PROVIDER_ERROR',
  CONNECTOR_ERROR: 'CONNECTOR_ERROR',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorDetail {
  [key: string]: string | number | boolean | null | undefined;
}

export interface ErrorEnvelope {
  error: {
    code: ErrorCode | string;
    message: string;
    retryable: boolean;
    trace_id: string | null;
    details?: Record<string, ErrorDetail | string | number | boolean | null>;
  };
}

export interface DomainErrorOptions {
  code?: ErrorCode | string;
  httpStatus?: number;
  retryable?: boolean;
  details?: Record<string, ErrorDetail | string | number | boolean | null>;
  cause?: unknown;
  /** Internal-only context. Logged, never returned to the client. */
  internal?: string;
}

export class DomainError extends Error {
  readonly code: ErrorCode | string;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details: Record<string, ErrorDetail | string | number | boolean | null> | undefined;
  readonly internal: string | undefined;

  constructor(message: string, options: DomainErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'DomainError';
    this.code = options.code ?? ErrorCode.INTERNAL;
    this.httpStatus = options.httpStatus ?? 500;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
    this.internal = options.internal;
  }

  /** Build the client-safe envelope. `internal` and `cause` are excluded. */
  toEnvelope(traceId: string | null): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        trace_id: traceId,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export class BadRequestError extends DomainError {
  constructor(message = 'Malformed request.', details?: DomainErrorOptions['details']) {
    super(message, { code: ErrorCode.BAD_REQUEST, httpStatus: 400, details });
    this.name = 'BadRequestError';
  }
}

export class ValidationError extends DomainError {
  constructor(message = 'Request validation failed.', details?: DomainErrorOptions['details']) {
    super(message, { code: ErrorCode.VALIDATION_FAILED, httpStatus: 422, details });
    this.name = 'ValidationError';
  }
}

export class UnauthenticatedError extends DomainError {
  constructor(message = 'Authentication required.') {
    super(message, { code: ErrorCode.UNAUTHENTICATED, httpStatus: 401 });
    this.name = 'UnauthenticatedError';
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'You do not have access to this resource.') {
    super(message, { code: ErrorCode.FORBIDDEN, httpStatus: 403 });
    this.name = 'ForbiddenError';
  }
}

/**
 * Cross-tenant access always surfaces as 404, never 403: a 403 confirms the
 * resource exists in another tenant (PRD §7.5, Master Prompt §8).
 */
export class NotFoundError extends DomainError {
  constructor(message = 'Resource not found or not accessible.') {
    super(message, { code: ErrorCode.NOT_FOUND, httpStatus: 404 });
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends DomainError {
  constructor(
    message = 'State conflict.',
    details?: DomainErrorOptions['details'],
    code: ErrorCode | string = ErrorCode.CONFLICT,
  ) {
    super(message, { code, httpStatus: 409, retryable: false, details });
    this.name = 'ConflictError';
  }
}

export class IdempotencyReuseError extends ConflictError {
  constructor(resourceId?: string) {
    super(
      'Idempotency key was already used with a different request payload.',
      resourceId ? { resource_id: resourceId } : undefined,
      ErrorCode.IDEMPOTENCY_KEY_REUSE,
    );
    this.name = 'IdempotencyReuseError';
  }
}

export class StaleRevisionError extends ConflictError {
  constructor(expected: number | string, actual: number | string) {
    super(
      'The resource changed since it was loaded. Reload and retry.',
      { expected_revision: String(expected), current_revision: String(actual) },
      ErrorCode.STALE_REVISION,
    );
    this.name = 'StaleRevisionError';
  }
}

export class ApprovalInvalidatedError extends ConflictError {
  constructor(reason: string) {
    super(
      `Approval invalidated: ${reason}. The action must be reviewed again.`,
      { invalidation_reason: reason },
      ErrorCode.APPROVAL_INVALIDATED,
    );
    this.name = 'ApprovalInvalidatedError';
  }
}

export class PayloadTooLargeError extends DomainError {
  constructor(message = 'Request payload exceeds the configured size limit.') {
    super(message, { code: ErrorCode.PAYLOAD_TOO_LARGE, httpStatus: 413 });
    this.name = 'PayloadTooLargeError';
  }
}

export class RateLimitedError extends DomainError {
  constructor(retryAfterSeconds?: number) {
    super('Rate limit exceeded.', {
      code: ErrorCode.RATE_LIMITED,
      httpStatus: 429,
      retryable: true,
      details: retryAfterSeconds ? { retry_after_seconds: retryAfterSeconds } : undefined,
    });
    this.name = 'RateLimitedError';
  }
}

/** Fail-closed errors: these must never be converted into an ALLOW upstream. */
export class EnforcementUnavailableError extends DomainError {
  constructor(
    message = 'Enforcement dependencies unavailable; protected writes are blocked.',
    code: ErrorCode | string = ErrorCode.ENFORCEMENT_UNAVAILABLE,
  ) {
    super(message, { code, httpStatus: 503, retryable: true });
    this.name = 'EnforcementUnavailableError';
  }
}

export class PolicyEngineUnavailableError extends EnforcementUnavailableError {
  constructor(message = 'Policy engine unavailable; failing closed for protected writes.') {
    super(message, ErrorCode.POLICY_ENGINE_UNAVAILABLE);
    this.name = 'PolicyEngineUnavailableError';
  }
}

export class AuditWriteFailedError extends EnforcementUnavailableError {
  constructor(message = 'Durable audit write failed; protected writes are blocked.') {
    super(message, ErrorCode.AUDIT_WRITE_FAILED);
    this.name = 'AuditWriteFailedError';
  }
}

export class EmergencyStopActiveError extends DomainError {
  constructor(message = 'Emergency stop is active; new protected writes are rejected.') {
    super(message, {
      code: ErrorCode.EMERGENCY_STOP_ACTIVE,
      httpStatus: 423,
      retryable: false,
    });
    this.name = 'EmergencyStopActiveError';
  }
}

export class PermitInvalidError extends DomainError {
  constructor(reason: string, details?: DomainErrorOptions['details']) {
    super(`Permit rejected: ${reason}.`, {
      code: ErrorCode.PERMIT_INVALID,
      httpStatus: 403,
      retryable: false,
      details,
    });
    this.name = 'PermitInvalidError';
  }
}

export class UnknownOutcomeError extends DomainError {
  constructor(actionId: string, executionId: string) {
    super('The connector may have completed this action. Reconcile before retrying.', {
      code: 'UNKNOWN_OUTCOME',
      httpStatus: 409,
      retryable: false,
      details: { action_id: actionId, execution_id: executionId },
    });
    this.name = 'UnknownOutcomeError';
  }
}

/**
 * Normalize any thrown value into a client-safe DomainError. Unknown programming
 * errors become a generic 500 whose real message is kept in `internal` for logs
 * only — stack traces never reach a response body (PRD §12.3).
 */
export function toDomainError(err: unknown): DomainError {
  if (err instanceof DomainError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new DomainError('Internal error.', {
    code: ErrorCode.INTERNAL,
    httpStatus: 500,
    retryable: false,
    internal: message,
    cause: err,
  });
}
