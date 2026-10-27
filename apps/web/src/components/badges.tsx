'use client';

import { Badge } from '@permitzero/ui';
import { TOOL_META } from '@/lib/tools';
import type { SupportedTool } from '@permitzero/schemas';

const DECISIONS: Record<string, { label: string; variant: 'success' | 'destructive' | 'warning' | 'info' | 'secondary' }> = {
  ALLOW: { label: 'Allowed', variant: 'success' },
  DENY: { label: 'Denied', variant: 'destructive' },
  REQUIRE_APPROVAL: { label: 'Needs approval', variant: 'warning' },
  INDETERMINATE: { label: 'Undecided', variant: 'info' },
};

export function DecisionBadge({ decision }: { decision: string | null }): React.JSX.Element {
  if (!decision) return <Badge variant="secondary">Pending</Badge>;
  const known = DECISIONS[decision] ?? { label: decision, variant: 'secondary' as const };
  return <Badge variant={known.variant}>{known.label}</Badge>;
}

const STATES: Record<string, { label: string; variant: 'success' | 'destructive' | 'warning' | 'info' | 'secondary' | 'outline' }> = {
  RECEIVED: { label: 'Received', variant: 'secondary' },
  VALIDATING: { label: 'Validating', variant: 'info' },
  EVALUATING: { label: 'Deciding', variant: 'info' },
  DENIED: { label: 'Denied', variant: 'destructive' },
  APPROVAL_REQUIRED: { label: 'Awaiting approval', variant: 'warning' },
  APPROVED: { label: 'Approved', variant: 'success' },
  ALLOWED: { label: 'Authorized', variant: 'success' },
  PERMIT_ISSUED: { label: 'Permit ready', variant: 'success' },
  EXECUTION_PENDING: { label: 'Queued', variant: 'info' },
  EXECUTING: { label: 'Running', variant: 'info' },
  SUCCEEDED: { label: 'Done', variant: 'success' },
  FAILED_RETRYABLE: { label: 'Failed — can retry', variant: 'warning' },
  FAILED_TERMINAL: { label: 'Failed', variant: 'destructive' },
  UNKNOWN_OUTCOME: { label: 'Unknown outcome', variant: 'warning' },
  RECONCILING: { label: 'Reconciling', variant: 'info' },
  MANUAL_REVIEW: { label: 'Needs a human', variant: 'warning' },
  REJECTED: { label: 'Rejected', variant: 'destructive' },
  EXPIRED: { label: 'Expired', variant: 'secondary' },
  REVOKED: { label: 'Revoked', variant: 'secondary' },
  QUARANTINED: { label: 'Quarantined', variant: 'destructive' },
};

export function StateBadge({ state }: { state: string }): React.JSX.Element {
  const known = STATES[state] ?? { label: state, variant: 'outline' as const };
  return <Badge variant={known.variant}>{known.label}</Badge>;
}

export function ToolBadge({ tool }: { tool: string }): React.JSX.Element {
  const label = (TOOL_META as Record<string, { label: string }>)[tool]?.label ?? tool;
  return (
    <Badge variant="outline" title={tool}>
      {label}
    </Badge>
  );
}

const MODES: Record<string, { label: string; variant: 'success' | 'destructive' | 'warning' | 'info' | 'secondary' }> = {
  ENFORCED: { label: 'Enforcing', variant: 'success' },
  OBSERVE_ONLY: { label: 'Observe only', variant: 'info' },
  SIMULATION: { label: 'Simulation', variant: 'info' },
  DEGRADED_READ_ONLY: { label: 'Degraded — reads only', variant: 'warning' },
  QUARANTINE: { label: 'Quarantine', variant: 'destructive' },
  EMERGENCY_STOP: { label: 'Emergency stop', variant: 'destructive' },
};

export function ModeBadge({ mode }: { mode: string }): React.JSX.Element {
  const known = MODES[mode] ?? { label: mode, variant: 'secondary' as const };
  return <Badge variant={known.variant}>{known.label}</Badge>;
}

const SEVERITIES: Record<string, 'info' | 'secondary' | 'warning' | 'destructive'> = {
  INFO: 'info',
  LOW: 'secondary',
  MEDIUM: 'warning',
  HIGH: 'warning',
  CRITICAL: 'destructive',
};

export function SeverityBadge({ severity }: { severity: string }): React.JSX.Element {
  return <Badge variant={SEVERITIES[severity] ?? 'secondary'}>{severity.toLowerCase()}</Badge>;
}

export function toolLabel(tool: string): string {
  return (TOOL_META as Record<string, { label: string }>)[tool]?.label ?? tool;
}

export function isKnownTool(tool: string): tool is SupportedTool {
  return tool in TOOL_META;
}
