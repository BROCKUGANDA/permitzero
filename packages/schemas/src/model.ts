/**
 * Strict schema for Meta Model API structured output (PRD §11.3, FR-070).
 *
 * `additionalProperties: false` everywhere, enums for categoricals, bounded
 * arrays and string lengths, explicit null semantics. Schema-valid output is
 * still only advisory: the deterministic PDP re-checks every extracted amount,
 * vendor id and destination against authoritative records.
 */
import { z } from 'zod';
import { RiskSignalKind } from '@permitzero/domain';

export const RISK_HINTS_SCHEMA_VERSION = 'risk-hints.v1';

export const injectionIndicatorSchema = z
  .object({
    kind: z.nativeEnum(RiskSignalKind),
    /** Must point at an evidence ref the action actually carries; the engine
     * drops indicators referencing unknown evidence. */
    evidence_ref: z.string().min(1).max(256),
    /** A model claim, not a calibrated probability. */
    confidence: z.number().min(0).max(1),
    detail: z.string().max(500).optional(),
  })
  .strict();

export const extractedFactsSchema = z
  .object({
    invoice_id: z.string().max(64).nullable(),
    vendor_id: z.string().max(64).nullable(),
    vendor_name: z.string().max(256).nullable(),
    claimed_amount_minor: z.number().int().safe().nonnegative().nullable(),
    currency: z.string().length(3).nullable(),
    purchase_order_id: z.string().max(64).nullable(),
    beneficiary_ref: z.string().max(128).nullable(),
    requested_bank_change: z.boolean().nullable(),
  })
  .strict();

export const riskHintsSchema = z
  .object({
    schema_version: z.literal(RISK_HINTS_SCHEMA_VERSION),
    instruction_injection_indicators: z.array(injectionIndicatorSchema).max(16),
    extracted_facts: extractedFactsSchema,
    missing_evidence: z.array(z.string().max(128)).max(16),
    summary: z.string().max(1200),
  })
  .strict();
export type RiskHintsDto = z.infer<typeof riskHintsSchema>;

/** JSON Schema form of the same contract, sent to the provider when it supports
 * schema-constrained output. Kept adjacent to the Zod schema so the two cannot
 * drift — the Zod schema remains the authority on what we accept. */
export const RISK_HINTS_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'instruction_injection_indicators',
    'extracted_facts',
    'missing_evidence',
    'summary',
  ],
  properties: {
    schema_version: { type: 'string', const: RISK_HINTS_SCHEMA_VERSION },
    instruction_injection_indicators: {
      type: 'array',
      maxItems: 16,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'evidence_ref', 'confidence'],
        properties: {
          kind: { type: 'string', enum: Object.values(RiskSignalKind) },
          evidence_ref: { type: 'string', minLength: 1, maxLength: 256 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          detail: { type: 'string', maxLength: 500 },
        },
      },
    },
    extracted_facts: {
      type: 'object',
      additionalProperties: false,
      required: [
        'invoice_id',
        'vendor_id',
        'vendor_name',
        'claimed_amount_minor',
        'currency',
        'purchase_order_id',
        'beneficiary_ref',
        'requested_bank_change',
      ],
      properties: {
        invoice_id: { type: ['string', 'null'], maxLength: 64 },
        vendor_id: { type: ['string', 'null'], maxLength: 64 },
        vendor_name: { type: ['string', 'null'], maxLength: 256 },
        claimed_amount_minor: { type: ['integer', 'null'], minimum: 0 },
        currency: { type: ['string', 'null'], minLength: 3, maxLength: 3 },
        purchase_order_id: { type: ['string', 'null'], maxLength: 64 },
        beneficiary_ref: { type: ['string', 'null'], maxLength: 128 },
        requested_bank_change: { type: ['boolean', 'null'] },
      },
    },
    missing_evidence: {
      type: 'array',
      maxItems: 16,
      items: { type: 'string', maxLength: 128 },
    },
    summary: { type: 'string', maxLength: 1200 },
  },
} as const;

/**
 * Semantic validation beyond shape. A model can emit a perfectly valid object
 * that is nonsense; these checks turn nonsense into "unavailable advisory"
 * rather than letting it influence a decision.
 */
export interface RiskHintsValidationIssue {
  path: string;
  message: string;
}

export function validateRiskHintsSemantics(
  hints: RiskHintsDto,
  knownEvidenceRefs: readonly string[],
): RiskHintsValidationIssue[] {
  const issues: RiskHintsValidationIssue[] = [];
  const known = new Set(knownEvidenceRefs);
  hints.instruction_injection_indicators.forEach((indicator, i) => {
    if (!known.has(indicator.evidence_ref)) {
      issues.push({
        path: `instruction_injection_indicators[${i}].evidence_ref`,
        message: `references evidence the action does not carry: ${indicator.evidence_ref}`,
      });
    }
  });
  const facts = hints.extracted_facts;
  if (facts.currency !== null && !/^[A-Z]{3}$/.test(facts.currency)) {
    issues.push({ path: 'extracted_facts.currency', message: 'not an uppercase ISO-4217 code' });
  }
  if (facts.claimed_amount_minor !== null && facts.currency === null) {
    issues.push({
      path: 'extracted_facts.currency',
      message: 'an amount without a currency is not usable evidence',
    });
  }
  return issues;
}
