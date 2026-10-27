'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Alert, buttonVariants, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from '@permitzero/ui';
import { useAction, useMe } from '@/lib/api';
import { DecisionBadge, StateBadge, ToolBadge } from '@/components/badges';
import { ApprovalProgress, RiskSignalList } from '@/components/decision-evidence';
import { ApproveDialog, RejectDialog } from '@/components/approval-dialogs';
import { CollectPanel, ExecutePanel, PermitReveal, ReceiptView, RequestError } from '@/components/execution';
import { ReasonList } from '@/components/reason-list';
import { formatDateTime, formatMoney, shortHash, truncateMiddle } from '@/lib/format';
import { canApprove, canSpend } from '@/lib/permissions';
import type { ActionDto, ExecuteActionResponse, PermitDto } from '@permitzero/schemas';

function RedactedArguments({ action }: { action: ActionDto }): React.JSX.Element {
  const entries = Object.entries(action.arguments_redacted as Record<string, unknown>);
  if (entries.length === 0) return <p className="text-sm text-muted-foreground">No arguments recorded.</p>;
  return (
    <dl className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
      {entries.map(([key, value]) => {
        let display = typeof value === 'string' ? value : JSON.stringify(value);
        if (key === 'amount_minor' && typeof value === 'number') {
          const currency = typeof action.arguments_redacted['currency'] === 'string' ? String(action.arguments_redacted['currency']) : 'USD';
          display = formatMoney(value, currency);
        }
        return (
          <div key={key} className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">{key.replace(/_/g, ' ')}</dt>
            <dd className="truncate font-mono text-xs" title={display}>
              {display}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function YourMove({ action }: { action: ActionDto }): React.JSX.Element {
  const { me } = useMe();
  const [permit, setPermit] = React.useState<PermitDto | null>(null);
  const [receipt, setReceipt] = React.useState<ExecuteActionResponse | null>(null);

  const awaiting = action.state === 'APPROVAL_REQUIRED';
  const approvable = awaiting && canApprove(me);
  const spendable = canSpend(me, action);
  const collectible = action.state === 'APPROVED' && spendable;
  const executable =
    (action.state === 'PERMIT_ISSUED' || action.state === 'APPROVED' || action.state === 'EXECUTION_PENDING') &&
    spendable;

  if (receipt) return <ReceiptView response={receipt} />;

  // Just collected: keep the one-time reveal on screen next to the execute
  // panel (which it pre-fills) instead of swapping one for the other.
  if (permit) {
    return (
      <div className="flex flex-col gap-4">
        <PermitReveal permit={permit} />
        <ExecutePanel action={action} presetToken={permit.token} onExecuted={(res) => setReceipt(res)} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {awaiting ? (
        approvable ? (
          <div className="flex flex-wrap gap-2">
            <ApproveDialog action={action} />
            <RejectDialog action={action} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {me?.actor_type === 'USER'
              ? 'Waiting on someone with the approver role. You can watch, but your account cannot decide this one.'
              : 'Waiting on a human approver. Agents cannot approve their own requests.'}
          </p>
        )
      ) : null}

      {collectible ? (
        <CollectPanel action={action} onCollected={(fresh) => setPermit(fresh)} />
      ) : null}

      {!collectible && executable ? (
        <ExecutePanel action={action} presetToken={null} onExecuted={(res) => setReceipt(res)} />
      ) : null}

      {action.state === 'UNKNOWN_OUTCOME' ? (
        <Alert variant="warning" title="Outcome unknown — do not retry blindly">
          The request may or may not have taken effect. Reconciliation is checking with the connector; wait for it
          before submitting a replacement, or you may double-spend.
        </Alert>
      ) : null}

      {action.state === 'MANUAL_REVIEW' ? (
        <Alert title="Held for manual review">
          The system could not decide this safely on its own. An operator needs to resolve it outside this queue.
        </Alert>
      ) : null}

      {!awaiting && !collectible && !executable && !['UNKNOWN_OUTCOME', 'MANUAL_REVIEW'].includes(action.state) ? (
        <p className="text-sm text-muted-foreground">Nothing to do here — this request is settled.</p>
      ) : null}

      {action.state !== 'APPROVAL_REQUIRED' && (action.state === 'APPROVED' || action.state === 'PERMIT_ISSUED') && !spendable ? (
        <p className="text-sm text-muted-foreground">Approved. Only the owning agent or an operator can spend the permit.</p>
      ) : null}
    </div>
  );
}

export default function ActionDetailPage({ params }: { params: Promise<{ actionId: string }> }): React.JSX.Element {
  const { actionId } = React.use(params);
  const { action, error, isLoading, refetch } = useAction(actionId);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (error || !action) {
    return (
      <div className="flex flex-col gap-4">
        <RequestError error={error ?? new Error('Not found')} onRetry={refetch} />
        <Link href="/actions" className={buttonVariants({ variant: 'outline', size: 'sm', className: 'w-fit' })}>
          <ArrowLeft aria-hidden /> All actions
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Link href="/actions" className={buttonVariants({ variant: 'ghost', size: 'sm', className: '-ml-3 w-fit' })}>
        <ArrowLeft aria-hidden /> All actions
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="break-words text-2xl font-semibold tracking-tight">{action.task_purpose}</h1>
          <p className="mt-1 font-mono text-xs text-muted-foreground" title={action.action_id}>
            {truncateMiddle(action.action_id, 22, 8)} · requested {formatDateTime(action.requested_at)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ToolBadge tool={action.tool_name} />
          <StateBadge state={action.state} />
          <DecisionBadge decision={action.decision} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Request</CardTitle>
              <CardDescription>
                What was asked, word for word. Sensitive values stay masked here.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <RedactedArguments action={action} />
              <dl className="grid grid-cols-1 gap-2.5 border-t border-border pt-4 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-muted-foreground">Agent</dt>
                  <dd className="font-mono text-xs">{action.agent_id}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Run</dt>
                  <dd className="font-mono text-xs">{action.run_id}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Request fingerprint</dt>
                  <dd className="font-mono text-xs" title={action.action_hash}>
                    {shortHash(action.action_hash)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Policy</dt>
                  <dd className="text-xs">
                    {action.policy_revision_number !== null ? `revision ${action.policy_revision_number}` : 'no published policy yet'}
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Why this decision</CardTitle>
              <CardDescription>The policy reasons behind the outcome, in plain words.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <ReasonList codes={action.reason_codes} />
              {action.approval_progress ? (
                <div className="border-t border-border pt-4">
                  <ApprovalProgress progress={action.approval_progress} />
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Risk signals</CardTitle>
              <CardDescription>What the checks flagged while deciding.</CardDescription>
            </CardHeader>
            <CardContent>
              <RiskSignalList signals={action.risk_signals} />
            </CardContent>
          </Card>

          {action.execution ? (
            <Card>
              <CardHeader>
                <CardTitle>Execution</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-1 gap-2.5 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-muted-foreground">Attempt</dt>
                    <dd>#{action.execution.attempt_number}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Connector</dt>
                    <dd className="font-mono text-xs">{action.execution.connector_id ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Connector reference</dt>
                    <dd className="font-mono text-xs">{action.execution.external_reference ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Receipt</dt>
                    <dd className="font-mono text-xs">
                      {action.execution.receipt_hash ? truncateMiddle(action.execution.receipt_hash, 18, 8) : 'none yet'}
                    </dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Your move</CardTitle>
              <CardDescription>What you can do with this request right now.</CardDescription>
            </CardHeader>
            <CardContent>
              <YourMove action={action} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
