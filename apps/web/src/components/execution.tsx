'use client';

import * as React from 'react';
import { Alert, Button, CopyButton, Input, Label } from '@permitzero/ui';
import { ApiError, useCollect, useExecute } from '@/lib/api';
import { formatDateTime, formatMoney, truncateMiddle } from '@/lib/format';
import type { ActionDto, ExecuteActionResponse, PermitDto } from '@permitzero/schemas';

export function RequestError({ error, onRetry }: { error: unknown; onRetry?: () => void }): React.JSX.Element | null {
  if (!error) return null;
  if (error instanceof ApiError) {
    return (
      <Alert variant={error.status >= 500 || error.retryable ? 'warning' : 'destructive'} title="Request failed">
        <p>{error.message}</p>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-xs opacity-80">
          <code className="font-mono">{error.code}</code>
          {error.traceId ? <code className="font-mono">trace {truncateMiddle(error.traceId, 8, 4)}</code> : null}
          {error.retryable ? <span>Safe to retry.</span> : null}
          {onRetry ? (
            <button type="button" className="underline underline-offset-2" onClick={onRetry}>
              Try again
            </button>
          ) : null}
        </p>
      </Alert>
    );
  }
  return (
    <Alert variant="destructive" title="Request failed">
      Something went wrong. Please try again.
      {onRetry ? (
        <p className="mt-1 text-xs">
          <button type="button" className="underline underline-offset-2" onClick={onRetry}>
            Try again
          </button>
        </p>
      ) : null}
    </Alert>
  );
}

function idempotencyKey(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `web-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * One-time permit reveal. The token is shown exactly once, right after
 * collection — the server never serves it again, so neither do we. Stays
 * mounted alongside the execute panel so the operator can copy the token
 * for use outside this console.
 */
export function PermitReveal({ permit }: { permit: PermitDto }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <Alert variant="warning" title="Copy this now — it will not be shown again">
        This token spends the permit exactly once. Anyone holding it can execute this action until it expires{' '}
        {formatDateTime(permit.expires_at)}.
      </Alert>
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 p-2 pl-3">
        <code className="flex-1 truncate font-mono text-xs">{permit.token}</code>
        <CopyButton value={permit.token} label="Copy token" />
      </div>
    </div>
  );
}

export function CollectPanel({
  action,
  onCollected,
}: {
  action: ActionDto;
  onCollected: (permit: PermitDto) => void;
}): React.JSX.Element {
  const collect = useCollect();
  const [permit, setPermit] = React.useState<PermitDto | null>(null);

  if (permit) {
    return <PermitReveal permit={permit} />;
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Approved and waiting. Collect the single-use token to authorize execution.
      </p>
      <div>
        <Button
          onClick={() =>
            collect.mutate(action.action_id, {
              onSuccess: (fresh) => {
                setPermit(fresh);
                onCollected(fresh);
              },
            })
          }
          disabled={collect.isPending}
        >
          {collect.isPending ? 'Collecting…' : 'Collect permit token'}
        </Button>
      </div>
      <RequestError error={collect.error} />
    </div>
  );
}

export function ExecutePanel({
  action,
  presetToken,
  onExecuted,
}: {
  action: ActionDto;
  presetToken: string | null;
  onExecuted: (response: ExecuteActionResponse) => void;
}): React.JSX.Element {
  const [token, setToken] = React.useState(presetToken ?? '');
  const execute = useExecute();

  React.useEffect(() => {
    if (presetToken) setToken(presetToken);
  }, [presetToken]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="permit-token">Permit token</Label>
        <Input
          id="permit-token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste the single-use permit token"
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-xs"
        />
      </div>
      <div>
        <Button
          onClick={() =>
            execute.mutate(
              { actionId: action.action_id, body: { permit_token: token.trim(), idempotency_key: idempotencyKey() } },
              { onSuccess: (response) => onExecuted(response) },
            )
          }
          disabled={execute.isPending || token.trim().length === 0}
        >
          {execute.isPending ? 'Executing…' : 'Execute now'}
        </Button>
      </div>
      <RequestError error={execute.error} />
    </div>
  );
}

export function ReceiptView({ response }: { response: ExecuteActionResponse }): React.JSX.Element {
  const receipt = response.receipt;
  if (!receipt) {
    return (
      <Alert variant="warning" title="Accepted — confirmation pending">
        The broker accepted this execution but no connector receipt has arrived yet. The outcome is unconfirmed; check
        back rather than resubmitting.
      </Alert>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <Alert variant="success" title="Executed with a verified receipt">
        The connector confirmed the effect{receipt.simulated ? ' in simulation — no real money moved' : ''}.
      </Alert>
      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground">Amount</dt>
          <dd className="font-mono font-semibold">{formatMoney(receipt.amount_minor, receipt.currency)}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground">Destination</dt>
          <dd className="font-mono">{receipt.beneficiary_ref}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground">Connector reference</dt>
          <dd className="font-mono text-xs">{receipt.external_reference}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground">Completed</dt>
          <dd>{formatDateTime(receipt.completed_at)}</dd>
        </div>
      </dl>
      <p className="font-mono text-[11px] text-muted-foreground">
        receipt {truncateMiddle(receipt.receipt_hash, 18, 8)}
      </p>
    </div>
  );
}
