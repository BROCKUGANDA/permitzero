# Module contracts

These signatures are the integration surface between packages. Implement them
exactly — other packages and the test suite are written against them. If a
signature must change, change this file in the same commit and update callers.

Conventions:

- Every package is ESM (`"type": "module"`), TypeScript strict, and imports
  workspace packages by name (`@permitzero/domain`). Relative imports inside a
  package use an explicit `.js` extension (`./foo.js`) because `moduleResolution`
  is `bundler` with ESM output.
- `packages/domain` and `packages/schemas` are already implemented and typecheck
  clean. Do not edit them to suit a caller; adapt the caller.
- No package other than `@permitzero/db` touches the database. `@permitzero/policy`
  and `@permitzero/broker` are pure: they receive authoritative records and
  return decisions. This is what makes "policy store unavailable" a caller-side
  fail-closed path rather than a swallowed exception.
- Amounts are integer minor units everywhere. Never a float.
- Timestamps are `Date` in UTC.

---

## @permitzero/policy

Pure deterministic evaluation. No I/O, no clock reads except from the input.

```ts
export interface PinnedPolicyRevision {
  revisionId: string;        // polrev_…
  policyId: string;          // pol_…
  tenantId: string;
  revisionNumber: number;
  document: PolicyDocument;  // from @permitzero/schemas
  policyHash: string;        // sha256:… over the canonical document
  status: PolicyRevisionStatus;
  publishedAt: Date | null;
}

/** Canonical hash of a policy document. Must be deterministic across processes. */
export function hashPolicyDocument(document: PolicyDocument): string;

/**
 * Evaluate one action against one pinned revision.
 * MUST NOT throw for a policy-level problem — return DENY/INDETERMINATE with a
 * reason code instead. Only a programming error may throw.
 */
export function evaluatePolicy(
  input: PolicyEvaluationInput,   // @permitzero/domain
  revision: PinnedPolicyRevision,
): PolicyEvaluationResult;        // @permitzero/domain

/** Every field the engine knows how to resolve, with its resolved value. Used by
 * the decision drawer and the Replay Lab to explain a decision. */
export interface ResolvedField {
  field: PolicyField;
  resolved: boolean;
  value: string | number | boolean | null;
  detail: string;
}
export function resolveFields(input: PolicyEvaluationInput): ResolvedField[];

export function lintPolicy(document: PolicyDocument): PolicyLintFinding[];

/** True when a REPLAY/simulate call may run: replay must never reach a connector. */
export interface SimulateOptions {
  maxFixtures: number;
}
export function simulatePolicy(
  cases: ReadonlyArray<{ fixtureId: string; label: string; input: PolicyEvaluationInput }>,
  revision: PinnedPolicyRevision,
  options?: SimulateOptions,
): { fixtureId: string; label: string; result: PolicyEvaluationResult }[];
```

Hard requirements:

1. **Deny precedence is structural.** A matching `DENY` rule wins over any number
   of matching `ALLOW` rules regardless of `priority`. `priority` only orders
   rules within an effect class, for explanation stability.
2. **Default deny.** No matching allow rule ⇒ `DENY` with `NO_EXPLICIT_ALLOW`.
3. **Unresolvable field ⇒ the rule does not match, and if that leaves no allow
   path the decision is `INDETERMINATE`, never `ALLOW`.** A field that cannot be
   resolved from authoritative state is not `false`.
4. **Fail closed on unavailable state.** `input.policyStoreAvailable === false`
   ⇒ `INDETERMINATE` + `POLICY_EVALUATOR_UNAVAILABLE`. `enforcementMode` of
   `EMERGENCY_STOP`/`DEGRADED_READ_ONLY`/`QUARANTINE` on a side-effecting tool
   ⇒ `DENY` with the matching mode reason code.
5. **Model output can never produce ALLOW.** If a rule's `when` references any
   `model.*` field and its `effect` is `ALLOW`, `lintPolicy` reports
   `MODEL_FIELD_IN_ALLOW_RULE` at severity `ERROR` and `evaluatePolicy` refuses to
   let that rule contribute an allow. `requiredModelSignalUnavailable === true`
   with a policy that requires the signal ⇒ `REQUIRE_APPROVAL`
   (`REQUIRED_SIGNAL_UNAVAILABLE`) or `INDETERMINATE`, never allow.
6. **Approval quorum** = max `required_approvals` across matching
   `REQUIRE_APPROVAL` rules. `REQUIRE_APPROVAL` outranks `ALLOW`.
7. `rulesEvaluated` lists every rule that was in scope, matched or not, with its
   reason code and a one-line detail — the UI renders this verbatim.

---

## @permitzero/db

Drizzle + `postgres` (postgres.js). PostgreSQL is the system of record.

```ts
export * as schema from './schema.js';   // all tables
export interface Db { sql: postgres.Sql; /* drizzle instance */ }
export function createDb(url: string): Db;
export async function migrate(db: Db): Promise<void>;
export async function resetDb(db: Db): Promise<void>;
export async function seed(db: Db, options?: SeedOptions): Promise<SeedResult>;
export async function healthCheck(db: Db): Promise<boolean>;
export interface SeedOptions { tenants?: number; synthetic?: boolean; }
export interface SeedResult {
  tenantIds: string[]; userIds: Record<string, string>; agentIds: string[];
  policyIds: string[]; connectorIds: string[]; vendorIds: string[];
  invoiceIds: string[]; purchaseOrderIds: string[];
}
```

Tables (PRD §9.1, Master Prompt §7): `tenants`, `users`, `tenant_memberships`,
`agents`, `service_credentials`, `policies`, `policy_revisions`, `actions`,
`approvals`, `permits`, `executions`, `connectors`, `audit_events`,
`outbox_events`, `idempotency_records`, `model_evaluations`, `replay_sessions`,
`replay_results`, plus the simulated connector's authoritative business data:
`vendors`, `invoices`, `purchase_orders`, `connector_ledger`, `enforcement_modes`.

Requirements:

- Every tenant-owned table has `tenant_id` NOT NULL and a FK to `tenants`.
- `idempotency_records` unique on `(tenant_id, principal_id, idempotency_key)`.
- `actions` unique on `(tenant_id, agent_id, idempotency_key)`.
- `policy_revisions` unique on `(policy_id, revision_number)`; a DB trigger
  rejects UPDATE/DELETE of a `PUBLISHED` revision's `policy_json`/`policy_hash`.
- `audit_events` has `sequence` unique per tenant, `previous_hash`, `event_hash`,
  and no UPDATE/DELETE grant path (trigger-raised error).
- Money columns are `bigint`/`numeric` in minor units, never `double precision`.
- Optimistic concurrency `version` integer on `actions`, `policies`, `permits`.
- Indexes: `(tenant_id, created_at DESC)` on actions and audit_events;
  `(tenant_id, state, created_at)` on actions for the queue;
  `(tenant_id, action_id, event_time)` on audit_events.
- Migrations are plain SQL files under `infra/migrations`, applied in filename
  order and tracked in a `_migrations` table. `migrate()` is idempotent.
- Seed data is unambiguously synthetic: tenant slug `demo`, names prefixed
  `SYNTHETIC`, and the demo records from the PRD story — `VEN-017` (verified),
  `INV-2041` / `PO-882` for USD 3000.00 (300000 minor), and `INV-2042` for
  USD 75000.00 (7500000 minor) whose document text contains an instruction to
  change bank details.

---

## @permitzero/broker

```ts
export interface PermitIssueInput {
  tenantId: string; agentId: string; actionId: string; actionHash: string;
  policyRevisionId: string; audienceTool: string; ttlSeconds: number;
}
export interface IssuedPermit {
  permitId: string; token: string; nonceHash: string;
  issuedAt: Date; expiresAt: Date; signatureKeyId: string;
}
export class PermitService {
  constructor(config: { signingKey: string; signingKeyId: string; store: PermitStore });
  issue(input: PermitIssueInput): Promise<IssuedPermit>;
  /** Verify + consume atomically. Returns a typed rejection reason, never throws
   * for an invalid permit. */
  verifyAndConsume(token: string, context: PermitVerifyContext): Promise<PermitVerification>;
  revoke(permitId: string, tenantId: string, reason: string): Promise<void>;
  revokeByAction(actionId: string, tenantId: string, reason: string): Promise<void>;
}
export interface PermitVerifyContext {
  tenantId: string; actionId: string; actionHash: string;
  policyRevisionId: string; audienceTool: string; now: Date;
}
export type PermitVerification =
  | { ok: true; permit: PermitRecord; nonce: string }
  | { ok: false; reason: DenyReason; detail: string };

/** The only code path that can reach a side-effecting connector. */
export class Broker {
  execute(request: BrokerExecuteRequest): Promise<BrokerExecuteResult>;
  reconcile(actionId: string, tenantId: string): Promise<ReconciliationResult>;
}
export interface BrokerExecuteRequest {
  tenantId: string; actionId: string; permitToken: string;
  actorId: string; traceId: string;
  /** Caller deadline. On elapse *after* dispatch the broker records
   * UNKNOWN_OUTCOME instead of assuming failure. */
  deadlineMs?: number;
}
export type BrokerExecuteResult =
  | { outcome: 'SUCCEEDED'; execution: ExecutionRecord; receipt: ConnectorReceipt }
  | { outcome: 'UNKNOWN_OUTCOME'; execution: ExecutionRecord }
  | { outcome: 'FAILED_RETRYABLE' | 'FAILED_TERMINAL'; execution: ExecutionRecord; errorClass: string }
  | { outcome: 'REJECTED'; reason: DenyReason; detail: string };

export interface ConnectorReceipt {
  externalReference: string; receiptHash: string; amountMinor: number;
  currency: string; beneficiaryRef: string; completedAt: Date; simulated: true;
}

/** Simulated finance connector. Deterministic; ledger keyed by the connector
 * idempotency key so a repeated key returns the ORIGINAL receipt. */
export class SimulatedFinanceConnector {
  readInvoice(tenantId: string, invoiceId: string): Promise<InvoiceRecord | null>;
  readPurchaseOrder(tenantId: string, poId: string): Promise<PurchaseOrderRecord | null>;
  readVendor(tenantId: string, vendorId: string): Promise<VendorRecord | null>;
  executePayment(request: ConnectorPaymentRequest): Promise<ConnectorCallResult>;
  updateVendorBankDetails(request: ConnectorVendorChangeRequest): Promise<ConnectorCallResult>;
  exportVendors(request: ConnectorExportRequest): Promise<ConnectorCallResult>;
  /** Reconciliation lookup: did this idempotency key already produce an effect? */
  lookupByIdempotencyKey(tenantId: string, key: string): Promise<ConnectorReceipt | null>;
  healthCheck(): Promise<{ ok: boolean; latencyMs: number }>;
}
export type ConnectorCallResult =
  | { status: 'SUCCEEDED'; receipt: ConnectorReceipt }
  | { status: 'FAILED_RETRYABLE'; errorClass: string }
  | { status: 'FAILED_TERMINAL'; errorClass: string }
  | { status: 'TIMEOUT_AFTER_DISPATCH' };

/** Fault injection, driven by tests and the demo. Never enabled in production. */
export interface ConnectorFaultProfile {
  timeoutAfterDispatch: boolean; failRetryable: boolean; failTerminal: boolean;
  latencyMs: number; duplicateDelivery: boolean;
}
export function setConnectorFaultProfile(profile: Partial<ConnectorFaultProfile>): void;
export function clearConnectorFaultProfile(): void;
```

Requirements:

1. A durable **execution-intent** row is committed *before* dispatch (FR-035).
2. Permit consumption is atomic (single SQL statement with a `consumed_at IS NULL`
   predicate). Two concurrent workers consuming the same permit ⇒ exactly one
   succeeds (acceptance criterion 7).
3. The permit token is opaque and never logged or persisted in raw form; store
   `nonce_hash` and an HMAC of the token.
4. `TIMEOUT_AFTER_DISPATCH` ⇒ `UNKNOWN_OUTCOME`. `reconcile()` calls
   `lookupByIdempotencyKey` and resolves to `SUCCEEDED` (attaching the found
   receipt) or `MANUAL_REVIEW`. It must never dispatch a second payment.
5. Connector credentials live only here. Nothing upstream can read them.

---

## @permitzero/provider-meta

```ts
export interface ModelAdapterConfig {
  enabled: boolean; apiKey: string | null; baseUrl: string; modelId: string | null;
  timeoutMs: number; maxAttempts: number; maxConcurrency: number;
  retryBaseMs: number; retryCapMs: number;
  promptVersion: string; schemaVersion: string;
}
export function createModelAdapter(config: ModelAdapterConfig): ModelAdapter;
export interface ModelAdapter {
  /** Advisory only. Returns null when disabled or unavailable — callers must
   * treat null as "no signal", never as "safe". */
  analyzeUntrustedText(input: AnalyzeInput): Promise<ModelAnalysisOutcome>;
  discoverModels(): Promise<{ ok: boolean; models: string[]; error?: string }>;
  health(): Promise<{ status: 'ok' | 'degraded' | 'down' | 'disabled'; breaker: BreakerState }>;
  readonly breakerState: BreakerState;
}
export type ModelAnalysisOutcome =
  | { status: 'OK'; hints: RiskHints; evaluation: ModelEvaluationRecord }
  | { status: 'DISABLED' }
  | { status: 'UNAVAILABLE'; errorClass: string; evaluation: ModelEvaluationRecord }
  | { status: 'INVALID_OUTPUT'; issues: string[]; evaluation: ModelEvaluationRecord };

export class CircuitBreaker { /* closed → open → half-open, bounded probes */ }
export function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T>;
export function classifyError(error: unknown): { retryable: boolean; retryAfterMs?: number; errorClass: string };
```

Requirements:

1. Full jitter: `random(0, min(cap, base * 2^attempt))`; honour `Retry-After`
   without capping it downward; respect a global deadline.
2. Retry 429/5xx/network/timeout only. Never retry 400/401/403/404 unchanged.
3. Never wrap a non-idempotent external finance write in this loop.
4. Bounded concurrency (bulkhead) so a slow provider cannot exhaust policy or
   broker capacity.
5. Validate output against `riskHintsSchema` *and* `validateRiskHintsSemantics`.
   Schema-valid-but-nonsense ⇒ `INVALID_OUTPUT`, treated as unavailable.
6. Redact before sending: no credentials, no full bank details, no unnecessary
   PII. Record `model_evaluations` with model id, prompt/schema version, input
   hash, latency, token usage and error class — not raw prompts.
7. Do not invent model IDs. If `MODEL_ID` is empty the adapter reports
   `disabled`/`unavailable`, it does not guess one.

---

## @permitzero/queue

```ts
export const QUEUE_NAMES = {
  outbox: 'pz.outbox', modelAnalysis: 'pz.model-analysis',
  reconciliation: 'pz.reconciliation', replay: 'pz.replay',
  deadLetter: 'pz.dlq',
} as const;
export function createOutboxDispatcher(deps: OutboxDispatcherDeps): OutboxDispatcher;
export function createWorkers(deps: WorkerDeps): Workers;
export interface QueueHealth {
  status: 'ok' | 'degraded' | 'down' | 'disabled';
  depth: number; oldestJobAgeMs: number | null;
  outboxPending: number; outboxDead: number;
}
export function queueHealth(redis: Redis | null, db: Db): Promise<QueueHealth>;
```

Requirements: the outbox row is committed in the **same transaction** as the
state change; the dispatcher publishes and marks published only after queue
acknowledgement; handlers are idempotent and re-check current state; a Redis
outage leaves outbox rows pending and reports `degraded` without losing committed
intent or issuing an unenforceable permit; reconciliation jobs take priority over
repeat attempts; poison jobs move to the DLQ with an audited manual redrive.

---

## Error and response conventions (all packages)

- Throw `DomainError` subclasses from `@permitzero/domain`. Never a bare `Error`
  across a package boundary.
- Never convert a caught error into an ALLOW, an empty policy, or a
  success-shaped placeholder.
- Operational list responses are `{ data, meta }`. No `success` boolean; the HTTP
  status carries that.
- Cross-tenant access is always `404`, never `403` — a 403 confirms the row
  exists in another tenant.
