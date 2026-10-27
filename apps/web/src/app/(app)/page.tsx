'use client';

import Link from 'next/link';
import { Activity, ArrowRight, PlugZap, ShieldCheck } from 'lucide-react';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from '@permitzero/ui';
import { ApiError, useActions, useMe, useStatus } from '@/lib/api';
import { canApprove } from '@/lib/permissions';
import { ModeBadge, StateBadge, ToolBadge } from '@/components/badges';
import { RequestError } from '@/components/execution';
import type { StatusResponse } from '@permitzero/schemas';

function StatusDot({ value }: { value: 'up' | 'down' | 'disabled' | 'ok' | 'degraded' | 'down' | 'disabled' }): React.JSX.Element {
  const color =
    value === 'up' || value === 'ok'
      ? 'bg-emerald-500'
      : value === 'degraded'
        ? 'bg-amber-500'
        : value === 'disabled'
          ? 'bg-muted-foreground/40'
          : 'bg-destructive';
  return (
    <span className="flex items-center gap-2 text-sm">
      <span className={`size-2 rounded-full ${color}`} aria-hidden />
      <span className="capitalize">{value}</span>
    </span>
  );
}

function DependencyRows({ status }: { status: StatusResponse }): React.JSX.Element {
  const rows: Array<[string, React.ReactNode, string?]> = [
    ['Database', <StatusDot key="db" value={status.dependencies.database} />],
    ['Cache', <StatusDot key="redis" value={status.dependencies.redis} />],
    [
      'Background queue',
      <StatusDot key="q" value={status.dependencies.queue.status} />,
      `${status.dependencies.queue.depth} waiting · ${status.dependencies.queue.outbox_pending} unpublished · ${status.dependencies.queue.outbox_dead} dead-lettered`,
    ],
    [
      'Screening provider',
      <StatusDot key="m" value={status.dependencies.model_provider.status} />,
      status.dependencies.model_provider.enabled
        ? `model ${status.dependencies.model_provider.model_id ?? 'unknown'} · breaker ${status.dependencies.model_provider.breaker}`
        : 'deterministic checks only',
    ],
    [
      'Connectors',
      <span key="c" className="text-sm">
        {status.connectors.healthy} of {status.connectors.total} healthy
      </span>,
      status.connectors.degraded + status.connectors.quarantined > 0
        ? `${status.connectors.degraded} degraded · ${status.connectors.quarantined} quarantined`
        : undefined,
    ],
  ];
  return (
    <dl className="flex flex-col divide-y divide-border">
      {rows.map(([label, value, note]) => (
        <div key={label} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
          <dt className="text-sm font-medium">{label}</dt>
          <dd className="flex flex-col items-end gap-0.5">
            {value}
            {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function DecisionQueue(): React.JSX.Element {
  const { me } = useMe();
  const { page, error, isLoading } = useActions({ state: 'APPROVAL_REQUIRED' }, null);
  if (!canApprove(me)) return <></>;
  if (error) return <RequestError error={error} />;
  const items = page?.data.slice(0, 5) ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-primary" aria-hidden />
          Needs your decision
        </CardTitle>
        <CardDescription>Requests waiting on a human. Oldest first.</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing waiting. New approval requests will appear here.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {items.map((action) => (
              <li key={action.action_id}>
                <Link href={`/actions/${action.action_id}`} className="group flex items-center gap-3 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium group-hover:underline">{action.task_purpose}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-2">
                      <ToolBadge tool={action.tool_name} />
                      <StateBadge state={action.state} />
                    </span>
                  </span>
                  <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default function OverviewPage(): React.JSX.Element {
  const { me } = useMe();
  const { status, error, isLoading } = useStatus();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {me ? `Good to see you, ${me.display_name.split(' ')[0]}.` : 'Overview'}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            How enforcement is running, and what needs a human right now.
          </p>
        </div>
        {status ? <ModeBadge mode={status.enforcement_mode} /> : null}
      </div>

      {error ? (
        <RequestError
          error={error}
          onRetry={error instanceof ApiError && error.retryable ? () => window.location.reload() : undefined}
        />
      ) : null}

      {isLoading || !status ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity className="size-5 text-primary" aria-hidden />
                Enforcement health
              </CardTitle>
              <CardDescription>
                {status.app_env} · version {status.version}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DependencyRows status={status} />
            </CardContent>
          </Card>
          <DecisionQueue />
        </div>
      )}

      {status?.enforcement_mode === 'EMERGENCY_STOP' ? (
        <Alert variant="destructive" title="Emergency stop is in force">
          New protected writes are being refused. Reads still work. Lift the stop from operations when ready.
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PlugZap className="size-5 text-primary" aria-hidden />
            How this console works
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 text-sm leading-relaxed text-muted-foreground sm:grid-cols-3">
          <p>
            <strong className="font-semibold text-foreground">Agents ask first.</strong> Every request is checked
            against policy before anything happens — allowed ones run, risky ones wait here.
          </p>
          <p>
            <strong className="font-semibold text-foreground">Humans decide in plain words.</strong> Approvals show what
            was asked and why it needs you. One rejection stops a request for good.
          </p>
          <p>
            <strong className="font-semibold text-foreground">Everything is proven.</strong> Effects only count with a
            verified receipt; ambiguous outcomes reconcile instead of guessing.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
