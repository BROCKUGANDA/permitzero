/**
 * Core domain types shared by the API, worker, policy engine and broker.
 */
import type {
  ActionState,
  ActorType,
  AgentStatus,
  ApprovalDecision,
  ConnectorStatus,
  Decision,
  EnforcementMode,
  Environment,
  ExecutionState,
  PolicyRevisionStatus,
  Role,
  VendorStatus,
} from './enums.js';
import type { ApprovalReason, DenyReason, IndeterminateReason, RiskSignalKind } from './reason-codes.js';

/** A resolved, authenticated caller. Tenant always comes from identity, never
 * from a request body field (Master Prompt §5.1). */
export interface Principal {
  actorType: ActorType;
  actorId: string;
  tenantId: string;
  /** Roles held *in this tenant*. Membership lives in tenant_memberships. */
  roles: readonly Role[];
  environment: Environment;
  displayName: string;
  /** For agents: the agent row id. For users: null. */
  agentId: string | null;
  /** Credential metadata id; the secret itself is never present. */
  credentialId: string | null;
  credentialExpiresAt: Date | null;
  /** Set when the caller has completed step-up authentication. */
  mfaVerifiedAt: Date | null;
}

export interface ToolScope {
  toolName: string;
  operations: readonly string[];
}

/** Authoritative records the PDP needs. Supplied by the API from PostgreSQL —
 * the policy package itself never touches the database, which keeps it pure and
 * testable and makes "policy store unavailable" a caller-side fail-closed path. */
export interface VendorRecord {
  vendorId: string;
  tenantId: string;
  name: string;
  status: VendorStatus;
  verifiedBeneficiaryRef: string | null;
  verifiedAt: Date | null;
  /** Last banking/beneficiary change; drives the cooling-period rule. */
  bankingChangedAt: Date | null;
  /** Out-of-band verification of the latest banking change. */
  bankingChangeVerifiedAt: Date | null;
  /** Staged beneficiary awaiting verification + cooling; never dispatched. */
  pendingBeneficiaryRef: string | null;
  allowedDestinationRefs: readonly string[];
  accountAgeDays: number;
  dataClassification: string;
}

export interface InvoiceRecord {
  invoiceId: string;
  tenantId: string;
  vendorId: string;
  amountMinor: number;
  currency: string;
  purchaseOrderId: string | null;
  status: string;
  /** Untrusted document text. Evidence, never an instruction (PRD FR-014). */
  documentText: string | null;
  untrusted: true;
}

export interface PurchaseOrderRecord {
  purchaseOrderId: string;
  tenantId: string;
  vendorId: string;
  amountMinor: number;
  currency: string;
  status: string;
  matchedInvoiceIds: readonly string[];
}

export interface AgentRecord {
  agentId: string;
  tenantId: string;
  name: string;
  framework: string;
  environment: Environment;
  status: AgentStatus;
  credentialId: string;
  credentialExpiresAt: Date | null;
  allowedTools: readonly ToolScope[];
  revokedAt: Date | null;
}

export interface ConnectorRecord {
  connectorId: string;
  tenantId: string;
  name: string;
  type: string;
  environment: Environment;
  status: ConnectorStatus;
  allowedTools: readonly string[];
  /** Reference into a secret store. Never the secret. */
  credentialRef: string;
  lastHealthCheckAt: Date | null;
  simulated: boolean;
}

/** Advisory output from the model provider. Structurally validated, semantically
 * untrusted, and never able to produce an ALLOW on its own. */
export interface RiskHints {
  schemaVersion: 'risk-hints.v1';
  instructionInjectionIndicators: ReadonlyArray<{
    kind: RiskSignalKind;
    evidenceRef: string;
    confidence: number;
  }>;
  extractedFacts: Record<string, string | number | null>;
  missingEvidence: readonly string[];
  summary: string;
}

/** A normalized risk signal persisted on the action and shown in the UI. */
export interface RiskSignal {
  kind: RiskSignalKind;
  source: 'DETERMINISTIC' | 'MODEL_ADVISORY';
  severity: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  reasonCode: string;
  evidenceRef: string | null;
  /** A model claim, not a calibrated probability (PRD §11.3). */
  confidence: number | null;
  detail: string;
}

export interface EvidenceRef {
  ref: string;
  kind: string;
  trusted: boolean;
}

export interface PolicyEvaluationInput {
  tenantId: string;
  environment: Environment;
  agent: AgentRecord;
  principal: Principal;
  toolName: string;
  operation: string;
  taskPurpose: string;
  arguments: Record<string, unknown>;
  evidenceRefs: readonly EvidenceRef[];
  requestedAt: Date;
  runId: string;
  actionCountInRun: number;
  /** Authoritative lookups performed by the caller. Absent means "unavailable",
   * which the engine treats as fail-closed, never as "not required". */
  vendor: VendorRecord | null | undefined;
  invoice: InvoiceRecord | null | undefined;
  purchaseOrder: PurchaseOrderRecord | null | undefined;
  connector: ConnectorRecord | null | undefined;
  /** Advisory model output; null when disabled or unavailable. */
  riskHints: RiskHints | null;
  /** True when policy requires a model signal and none could be produced. */
  requiredModelSignalUnavailable: boolean;
  /** Spend already committed in the current budget window, minor units. */
  budgetSpendMinor: number;
  /** Actions executed by this agent in the current velocity window. */
  velocityCount: number;
  velocityWindowStartedAt: Date | null;
  enforcementMode: EnforcementMode;
  /** True when the policy store could not be read authoritatively. */
  policyStoreAvailable: boolean;
}

export interface PolicyEvaluationResult {
  decision: Decision;
  reasonCodes: readonly string[];
  /** Deny reasons, separated so the UI can show why without parsing strings. */
  denyReasons: readonly DenyReason[];
  approvalReasons: readonly ApprovalReason[];
  indeterminateReasons: readonly IndeterminateReason[];
  requiredApprovals: number;
  /** Rules that actually fired, for the decision explanation and Replay Lab. */
  rulesEvaluated: readonly EvaluatedRule[];
  riskSignals: readonly RiskSignal[];
  policyRevisionId: string;
  policyRevisionNumber: number;
  policyHash: string;
  /** True when the result came from a cached immutable snapshot. */
  fromCache: boolean;
  evaluatedAt: Date;
}

export interface EvaluatedRule {
  ruleId: string;
  effect: 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';
  matched: boolean;
  reasonCode: string;
  detail: string;
}

export interface ActionRecord {
  actionId: string;
  tenantId: string;
  agentId: string;
  runId: string;
  toolName: string;
  operation: string;
  taskPurpose: string;
  argumentsRedacted: Record<string, unknown>;
  argumentsHash: string;
  hashVersion: string;
  evidenceRefs: readonly EvidenceRef[];
  idempotencyKey: string;
  state: ActionState;
  decision: Decision | null;
  decisionReasonCodes: readonly string[];
  policyRevisionId: string | null;
  riskSignals: readonly RiskSignal[];
  requestedAt: Date;
  expiresAt: Date | null;
  version: number;
  environment: Environment;
  requiredApprovals: number;
  traceId: string;
  createdByActorId: string;
  createdByActorType: ActorType;
}

export interface PermitRecord {
  permitId: string;
  tenantId: string;
  actionId: string;
  actionHash: string;
  policyRevisionId: string;
  audienceTool: string;
  nonceHash: string;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
  signatureKeyId: string;
}

export interface ApprovalRecord {
  approvalId: string;
  tenantId: string;
  actionId: string;
  actionHash: string;
  policyRevisionId: string;
  approverUserId: string;
  decision: ApprovalDecision;
  reasonCode: string;
  reasonTextRedacted: string | null;
  approvedAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  mfaContextRef: string | null;
}

export interface ExecutionRecord {
  executionId: string;
  tenantId: string;
  actionId: string;
  connectorId: string;
  attemptNumber: number;
  connectorIdempotencyKey: string;
  state: ExecutionState;
  dispatchStartedAt: Date | null;
  resultReceivedAt: Date | null;
  externalReference: string | null;
  receiptHash: string | null;
  errorClass: string | null;
  retryAfterAt: Date | null;
}

export interface AuditEventRecord {
  eventId: string;
  tenantId: string;
  actionId: string | null;
  runId: string | null;
  actorType: ActorType;
  actorId: string;
  eventType: string;
  eventTime: Date;
  traceId: string;
  policyRevisionId: string | null;
  payloadRedacted: Record<string, unknown>;
  previousHash: string | null;
  eventHash: string;
  hashVersion: string;
  sequence: number;
}

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'unavailable';
  database: 'up' | 'down';
  redis: 'up' | 'down' | 'disabled';
  queue: { depth: number; oldestJobAgeMs: number | null; status: 'ok' | 'degraded' | 'down' };
  modelProvider: { enabled: boolean; status: 'ok' | 'degraded' | 'down' | 'disabled'; breaker: string };
  connectors: { total: number; healthy: number; degraded: number };
  enforcementMode: EnforcementMode;
  /** A service may be alive but not ready for protected writes (PRD §10.8). */
  protectedWritesAllowed: boolean;
  checkedAt: Date;
}

export type { PolicyRevisionStatus };
