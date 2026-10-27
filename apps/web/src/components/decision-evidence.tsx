'use client';

import { Badge } from '@permitzero/ui';
import { formatRelative } from '@/lib/format';
import { reasonLabel } from '@/lib/reason-codes';
import { SeverityBadge } from './badges';
import { Tooltip } from './ui/primitives';
import type { ActionDto } from '@permitzero/schemas';

type RiskSignal = ActionDto['risk_signals'][number];

export function RiskSignalList({ signals }: { signals: RiskSignal[] }): React.JSX.Element {
  if (signals.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing flagged.</p>;
  }
  return (
    <ul className="flex flex-col gap-3">
      {signals.map((signal, index) => (
        <li key={`${signal.kind}-${index}`} className="flex flex-col gap-1.5 rounded-md border border-border p-3">
          <span className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={signal.severity} />
            <Badge variant="outline">{signal.source === 'MODEL_ADVISORY' ? 'Screening' : 'Rules'}</Badge>
            {signal.confidence !== null && signal.confidence !== undefined ? (
              <span className="text-xs text-muted-foreground">{Math.round(signal.confidence * 100)}% confidence</span>
            ) : null}
          </span>
          <p className="text-sm font-medium">{reasonLabel(signal.kind)}</p>
          <p className="text-sm text-muted-foreground">{signal.detail}</p>
          {signal.evidence_ref ? (
            <p className="font-mono text-[11px] text-muted-foreground">from {signal.evidence_ref}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function ApprovalProgress({
  progress,
}: {
  progress: NonNullable<ActionDto['approval_progress']>;
}): React.JSX.Element {
  const pct =
    progress.required_approvals > 0
      ? Math.min(100, (progress.distinct_approvers / progress.required_approvals) * 100)
      : 0;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium">
          {progress.distinct_approvers} of {progress.required_approvals} approvals
        </span>
        {progress.expires_at ? (
          <Tooltip label={`Window closes ${new Date(progress.expires_at).toLocaleString()}`}>
            <span className="cursor-help text-muted-foreground">closes {formatRelative(progress.expires_at)}</span>
          </Tooltip>
        ) : null}
      </div>
      <div
        role="progressbar"
        aria-valuenow={progress.distinct_approvers}
        aria-valuemin={0}
        aria-valuemax={progress.required_approvals}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
      <ul className="flex flex-col gap-1.5 text-sm">
        {progress.requires_independent_verification ? (
          <li className="flex items-center gap-2">
            <span aria-hidden>{progress.independent_verification_present ? '✓' : '○'}</span>
            <span className={progress.independent_verification_present ? '' : 'text-muted-foreground'}>
              Verified outside the system
              {!progress.independent_verification_present ? ' — still needed' : ''}
            </span>
          </li>
        ) : null}
        {progress.requires_mfa ? (
          <li className="flex items-center gap-2">
            <span aria-hidden>○</span>
            <span className="text-muted-foreground">Step-up authentication required from approvers</span>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
