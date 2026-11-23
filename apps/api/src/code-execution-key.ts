/**
 * Idempotency for the code-execution controller.
 *
 * The connector dedupes on (tenant, idempotency key). A key derived from the
 * clock is not an idempotency key: a client retry a millisecond later runs the
 * snippet a second time. For an endpoint that executes arbitrary submitted
 * code, that is not a performance detail — it is the whole security boundary.
 *
 * Two sources are accepted, in order:
 *   1. An `Idempotency-Key` header supplied by the caller, scoped to the tenant
 *      so two tenants cannot collide by choosing the same string.
 *   2. A canonical hash of the request itself, so a client that does not send a
 *      header still gets stable retry semantics.
 */
import { canonicalHash } from '@permitzero/domain';

const MAX_HEADER_LENGTH = 128;
const SAFE_HEADER = /^[A-Za-z0-9._:-]+$/;

export function suppliedIdempotencyKey(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  if (key.length === 0 || key.length > MAX_HEADER_LENGTH) return null;
  if (!SAFE_HEADER.test(key)) return null;
  return key;
}

export function deriveCodeExecutionKey(input: {
  tenantId: string;
  actorId: string;
  code: string;
  language: string;
  args: readonly string[];
}): string {
  const digest = canonicalHash({
    actor_id: input.actorId,
    code: input.code,
    language: input.language,
    args: [...input.args],
  });
  return `code:${input.tenantId}:${digest}`;
}
