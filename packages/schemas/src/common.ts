/**
 * Shared primitives: IDs, money, pagination, envelopes.
 */
import { z } from 'zod';
import {
  SUPPORTED_CURRENCIES,
  ID_PREFIX,
  type IdKind,
} from '@permitzero/domain';

/** A prefixed ULID, validated for both prefix and body shape. */
export function idSchema(kind: IdKind) {
  const prefix = ID_PREFIX[kind];
  return z
    .string()
    .regex(
      new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`),
      `expected a ${prefix}_ prefixed ULID`,
    );
}

export const tenantIdSchema = idSchema('tenant');
export const actionIdSchema = idSchema('action');
export const traceIdSchema = idSchema('trace');
export const policyIdSchema = idSchema('policy');
export const policyRevisionIdSchema = idSchema('policyRevision');
export const connectorIdSchema = idSchema('connector');
export const agentIdSchema = idSchema('agent');
export const runIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'run_id must be a conservative identifier');

/** Integer minor units. A decimal major amount is rejected outright rather than
 * silently scaled — see money.ts for why floats cannot represent money. */
export const amountMinorSchema = z
  .number()
  .int('amount_minor must be an integer number of minor units')
  .safe()
  .gte(0)
  .lte(999_999_999_999);

export const currencySchema = z.enum(SUPPORTED_CURRENCIES as [string, ...string[]]);

export const actionHashSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, 'expected a sha256:<hex> action hash');

/** Evidence references are `kind:identifier`. Everything behind one is untrusted
 * content (PRD FR-014); the ref itself is what a policy can require. */
export const evidenceRefSchema = z
  .string()
  .min(3)
  .max(256)
  .regex(
    /^[a-z][a-z0-9-]{1,32}:[A-Za-z0-9._\-:/]{1,200}$/,
    'evidence refs must be kind:identifier',
  );

export const toolNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/,
    'tool names must be dot-separated lowercase identifiers, e.g. payment.execute',
  );

/** Idempotency keys are caller-chosen but bounded; they are stored hashed
 * alongside the request hash. */
export const idempotencyKeySchema = z.string().min(8).max(200);

export const environmentSchema = z.enum(['DEMO', 'STAGING', 'PRODUCTION']);

export const paginationQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().max(256).optional(),
  })
  .strict();
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface PageMeta {
  limit: number;
  next_cursor: string | null;
  /** Present only when the collection was counted; cursored lists skip COUNT(*). */
  total?: number;
}

/**
 * Operational list responses use `{ data, meta }`. There is no `success` flag —
 * the HTTP status carries success, and a body-level boolean would be a second,
 * disagreeable source of truth.
 */
export function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    meta: z.object({
      limit: z.number().int(),
      next_cursor: z.string().nullable(),
      total: z.number().int().optional(),
    }),
  });
}

export const errorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        retryable: z.boolean(),
        trace_id: z.string().nullable(),
        details: z.record(z.unknown()).optional(),
      })
      .strict(),
  })
  .strict();
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/** Free-text fields an operator types (denial reasons, publish notes). Bounded
 * and control-character-stripped before storage (PRD FR-045). */
export const operatorTextSchema = z
  .string()
  .max(1000)
  .transform((s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim());
