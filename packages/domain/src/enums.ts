/**
 * Domain enumerations and the validated action state machine.
 *
 * PRD §5.3 / Master Prompt §6: state is never an unconstrained string. Every
 * transition is checked against an explicit map, and anything not in the map is
 * rejected — an unknown transition is a bug, not a permissive default.
 */

/** PDP outcomes. INDETERMINATE is a *blocked* state, never a soft allow. */
export const Decision = {
  ALLOW: 'ALLOW',
  DENY: 'DENY',
  REQUIRE_APPROVAL: 'REQUIRE_APPROVAL',
  INDETERMINATE: 'INDETERMINATE',
} as const;
export type Decision = (typeof Decision)[keyof typeof Decision];

export const ActionState = {
  RECEIVED: 'RECEIVED',
  VALIDATING: 'VALIDATING',
  EVALUATING: 'EVALUATING',
  DENIED: 'DENIED',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  ALLOWED: 'ALLOWED',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  REVOKED: 'REVOKED',
  PERMIT_ISSUED: 'PERMIT_ISSUED',
  EXECUTION_PENDING: 'EXECUTION_PENDING',
  EXECUTING: 'EXECUTING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED_RETRYABLE: 'FAILED_RETRYABLE',
  FAILED_TERMINAL: 'FAILED_TERMINAL',
  UNKNOWN_OUTCOME: 'UNKNOWN_OUTCOME',
  RECONCILING: 'RECONCILING',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  QUARANTINED: 'QUARANTINED',
} as const;
export type ActionState = (typeof ActionState)[keyof typeof ActionState];

/** Terminal states: no further transition except an incident quarantine. */
export const TERMINAL_STATES: readonly ActionState[] = [
  ActionState.DENIED,
  ActionState.REJECTED,
  ActionState.EXPIRED,
  ActionState.REVOKED,
  ActionState.SUCCEEDED,
  ActionState.FAILED_TERMINAL,
  ActionState.MANUAL_REVIEW,
] as const;

/**
 * Allowed transitions. QUARANTINED is reachable from any non-terminal state
 * ("Any state may transition to QUARANTINED under a security incident where safe
 * and operationally meaningful" — PRD §5.3).
 */
const TRANSITIONS: Readonly<Record<ActionState, readonly ActionState[]>> = {
  RECEIVED: [ActionState.VALIDATING, ActionState.QUARANTINED],
  VALIDATING: [ActionState.EVALUATING, ActionState.DENIED, ActionState.QUARANTINED],
  EVALUATING: [
    ActionState.DENIED,
    ActionState.APPROVAL_REQUIRED,
    ActionState.ALLOWED,
    ActionState.QUARANTINED,
  ],
  DENIED: [],
  APPROVAL_REQUIRED: [
    ActionState.APPROVED,
    ActionState.REJECTED,
    ActionState.EXPIRED,
    ActionState.REVOKED,
    ActionState.QUARANTINED,
  ],
  ALLOWED: [ActionState.PERMIT_ISSUED, ActionState.REVOKED, ActionState.QUARANTINED],
  APPROVED: [ActionState.PERMIT_ISSUED, ActionState.REVOKED, ActionState.EXPIRED, ActionState.QUARANTINED],
  REJECTED: [],
  EXPIRED: [],
  REVOKED: [],
  PERMIT_ISSUED: [
    ActionState.EXECUTION_PENDING,
    ActionState.REVOKED,
    ActionState.EXPIRED,
    ActionState.QUARANTINED,
  ],
  EXECUTION_PENDING: [ActionState.EXECUTING, ActionState.REVOKED, ActionState.QUARANTINED],
  EXECUTING: [
    ActionState.SUCCEEDED,
    ActionState.FAILED_RETRYABLE,
    ActionState.FAILED_TERMINAL,
    ActionState.UNKNOWN_OUTCOME,
    ActionState.QUARANTINED,
  ],
  SUCCEEDED: [],
  FAILED_RETRYABLE: [
    ActionState.EXECUTION_PENDING,
    ActionState.FAILED_TERMINAL,
    ActionState.UNKNOWN_OUTCOME,
    ActionState.QUARANTINED,
  ],
  FAILED_TERMINAL: [],
  UNKNOWN_OUTCOME: [ActionState.RECONCILING, ActionState.MANUAL_REVIEW, ActionState.QUARANTINED],
  RECONCILING: [
    ActionState.SUCCEEDED,
    ActionState.FAILED_TERMINAL,
    ActionState.MANUAL_REVIEW,
    ActionState.QUARANTINED,
  ],
  MANUAL_REVIEW: [],
  // Quarantine is released by an authorized operator back into reconciliation or
  // a terminal state — never straight back into EXECUTING.
  QUARANTINED: [ActionState.MANUAL_REVIEW, ActionState.REVOKED, ActionState.RECONCILING],
};

export class IllegalTransitionError extends Error {
  readonly code = 'ILLEGAL_STATE_TRANSITION';
  constructor(
    readonly from: ActionState,
    readonly to: ActionState,
  ) {
    super(`Illegal action state transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition(from: ActionState, to: ActionState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: ActionState): readonly ActionState[] {
  return TRANSITIONS[from];
}

/**
 * Validate a transition or throw. Callers persist the result of this — the
 * guard runs before any side effect, never after.
 */
export function assertTransition(from: ActionState, to: ActionState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export function isTerminal(state: ActionState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** Execution states in which a side effect may already have reached the connector. */
export const SIDE_EFFECT_POSSIBLE: readonly ActionState[] = [
  ActionState.EXECUTING,
  ActionState.UNKNOWN_OUTCOME,
  ActionState.RECONCILING,
  ActionState.SUCCEEDED,
] as const;

export function sideEffectMayHaveOccurred(state: ActionState): boolean {
  return SIDE_EFFECT_POSSIBLE.includes(state);
}

/** Roles (PRD FR-002). Authorization is always resolved server-side. */
export const Role = {
  OWNER: 'OWNER',
  POLICY_ADMIN: 'POLICY_ADMIN',
  APPROVER: 'APPROVER',
  OPERATOR: 'OPERATOR',
  AUDITOR: 'AUDITOR',
  SERVICE_AGENT: 'SERVICE_AGENT',
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const ALL_ROLES: readonly Role[] = [
  Role.OWNER,
  Role.POLICY_ADMIN,
  Role.APPROVER,
  Role.OPERATOR,
  Role.AUDITOR,
  Role.SERVICE_AGENT,
] as const;

/**
 * Capabilities, not a role ladder. PRD FR-004: an agent credential cannot edit
 * policies, approve its own action, or read unrelated tenants. A ladder would
 * silently grant everything above a rank, so each capability is listed per role
 * explicitly and absence is denial.
 */
export const Capability = {
  ACTION_SUBMIT: 'action:submit',
  ACTION_READ: 'action:read',
  ACTION_APPROVE: 'action:approve',
  ACTION_EXECUTE: 'action:execute',
  POLICY_READ: 'policy:read',
  POLICY_WRITE: 'policy:write',
  POLICY_PUBLISH: 'policy:publish',
  POLICY_SIMULATE: 'policy:simulate',
  CONNECTOR_READ: 'connector:read',
  CONNECTOR_MANAGE: 'connector:manage',
  AUDIT_READ: 'audit:read',
  AUDIT_EXPORT: 'audit:export',
  EVIDENCE_READ: 'evidence:read',
  SETTINGS_READ: 'settings:read',
  SETTINGS_WRITE: 'settings:write',
  MODE_CHANGE: 'mode:change',
  QUARANTINE_RELEASE: 'quarantine:release',
  REPLAY_RUN: 'replay:run',
} as const;
export type Capability = (typeof Capability)[keyof typeof Capability];

const ROLE_CAPABILITIES: Readonly<Record<Role, readonly Capability[]>> = {
  OWNER: [
    Capability.ACTION_READ,
    Capability.ACTION_APPROVE,
    Capability.POLICY_READ,
    Capability.POLICY_WRITE,
    Capability.POLICY_PUBLISH,
    Capability.POLICY_SIMULATE,
    Capability.CONNECTOR_READ,
    Capability.CONNECTOR_MANAGE,
    Capability.AUDIT_READ,
    Capability.AUDIT_EXPORT,
    Capability.EVIDENCE_READ,
    Capability.SETTINGS_READ,
    Capability.SETTINGS_WRITE,
    Capability.MODE_CHANGE,
    Capability.QUARANTINE_RELEASE,
    Capability.REPLAY_RUN,
  ],
  POLICY_ADMIN: [
    Capability.ACTION_READ,
    Capability.POLICY_READ,
    Capability.POLICY_WRITE,
    Capability.POLICY_PUBLISH,
    Capability.POLICY_SIMULATE,
    Capability.CONNECTOR_READ,
    Capability.AUDIT_READ,
    Capability.EVIDENCE_READ,
    Capability.SETTINGS_READ,
    Capability.REPLAY_RUN,
  ],
  APPROVER: [
    Capability.ACTION_READ,
    Capability.ACTION_APPROVE,
    Capability.POLICY_READ,
    Capability.CONNECTOR_READ,
    Capability.AUDIT_READ,
    Capability.EVIDENCE_READ,
    Capability.SETTINGS_READ,
  ],
  OPERATOR: [
    Capability.ACTION_READ,
    Capability.POLICY_READ,
    Capability.CONNECTOR_READ,
    Capability.AUDIT_READ,
    Capability.EVIDENCE_READ,
    Capability.SETTINGS_READ,
    Capability.REPLAY_RUN,
  ],
  AUDITOR: [
    Capability.ACTION_READ,
    Capability.POLICY_READ,
    Capability.CONNECTOR_READ,
    Capability.AUDIT_READ,
    Capability.AUDIT_EXPORT,
    Capability.EVIDENCE_READ,
    Capability.SETTINGS_READ,
  ],
  // A service agent may only submit proposals and read the actions it created.
  // It can never approve, publish policy, or touch connector management.
  SERVICE_AGENT: [Capability.ACTION_SUBMIT, Capability.ACTION_READ],
};

export function capabilitiesFor(role: Role): readonly Capability[] {
  return ROLE_CAPABILITIES[role];
}

export function roleHasCapability(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

/** Enforcement / operating modes (PRD §6.3). Every non-ENFORCED mode is banner-worthy. */
export const EnforcementMode = {
  ENFORCED: 'ENFORCED',
  OBSERVE_ONLY: 'OBSERVE_ONLY',
  SIMULATION: 'SIMULATION',
  DEGRADED_READ_ONLY: 'DEGRADED_READ_ONLY',
  EMERGENCY_STOP: 'EMERGENCY_STOP',
  QUARANTINE: 'QUARANTINE',
} as const;
export type EnforcementMode = (typeof EnforcementMode)[keyof typeof EnforcementMode];

export const NON_ENFORCING_MODES: readonly EnforcementMode[] = [
  EnforcementMode.OBSERVE_ONLY,
  EnforcementMode.SIMULATION,
  EnforcementMode.DEGRADED_READ_ONLY,
  EnforcementMode.EMERGENCY_STOP,
  EnforcementMode.QUARANTINE,
] as const;

export function isEnforcing(mode: EnforcementMode): boolean {
  return mode === EnforcementMode.ENFORCED;
}

/** Environments. Demo data must never be mistaken for production (PRD §7.2). */
export const Environment = {
  DEMO: 'DEMO',
  STAGING: 'STAGING',
  PRODUCTION: 'PRODUCTION',
} as const;
export type Environment = (typeof Environment)[keyof typeof Environment];

export const ActorType = {
  USER: 'USER',
  AGENT: 'AGENT',
  SYSTEM: 'SYSTEM',
  WORKER: 'WORKER',
} as const;
export type ActorType = (typeof ActorType)[keyof typeof ActorType];

/** Execution lifecycle, tracked separately from the action state machine. */
export const ExecutionState = {
  INTENT_RECORDED: 'INTENT_RECORDED',
  DISPATCHING: 'DISPATCHING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED_RETRYABLE: 'FAILED_RETRYABLE',
  FAILED_TERMINAL: 'FAILED_TERMINAL',
  UNKNOWN_OUTCOME: 'UNKNOWN_OUTCOME',
  RECONCILED_SUCCEEDED: 'RECONCILED_SUCCEEDED',
  RECONCILED_FAILED: 'RECONCILED_FAILED',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
} as const;
export type ExecutionState = (typeof ExecutionState)[keyof typeof ExecutionState];

export const ApprovalDecision = {
  APPROVE: 'APPROVE',
  REJECT: 'REJECT',
} as const;
export type ApprovalDecision = (typeof ApprovalDecision)[keyof typeof ApprovalDecision];

export const PolicyRevisionStatus = {
  DRAFT: 'DRAFT',
  SIMULATING: 'SIMULATING',
  READY: 'READY',
  PUBLISHED: 'PUBLISHED',
  ROLLED_BACK: 'ROLLED_BACK',
} as const;
export type PolicyRevisionStatus = (typeof PolicyRevisionStatus)[keyof typeof PolicyRevisionStatus];

export const ConnectorStatus = {
  ENABLED: 'ENABLED',
  DISABLED: 'DISABLED',
  DEGRADED: 'DEGRADED',
  QUARANTINED: 'QUARANTINED',
} as const;
export type ConnectorStatus = (typeof ConnectorStatus)[keyof typeof ConnectorStatus];

export const AgentStatus = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  REVOKED: 'REVOKED',
} as const;
export type AgentStatus = (typeof AgentStatus)[keyof typeof AgentStatus];

export const VendorStatus = {
  VERIFIED: 'VERIFIED',
  PENDING_VERIFICATION: 'PENDING_VERIFICATION',
  UNVERIFIED: 'UNVERIFIED',
  BLOCKED: 'BLOCKED',
} as const;
export type VendorStatus = (typeof VendorStatus)[keyof typeof VendorStatus];

/** Circuit breaker states (PRD §12.8). */
export const BreakerState = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
} as const;
export type BreakerState = (typeof BreakerState)[keyof typeof BreakerState];

export const OutboxStatus = {
  PENDING: 'PENDING',
  PUBLISHED: 'PUBLISHED',
  FAILED: 'FAILED',
  DEAD: 'DEAD',
} as const;
export type OutboxStatus = (typeof OutboxStatus)[keyof typeof OutboxStatus];
