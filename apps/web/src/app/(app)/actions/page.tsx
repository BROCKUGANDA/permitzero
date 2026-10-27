'use client';

import * as React from 'react';
import Link from 'next/link';
import { PlusCircle } from 'lucide-react';
import { Button, buttonVariants, Input, Label } from '@permitzero/ui';
import { useActions, type ActionFilters } from '@/lib/api';
import { ActionTable, ActionTableSkeleton } from '@/components/action-table';
import { RequestError } from '@/components/execution';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SUPPORTED_TOOLS } from '@permitzero/schemas';
import { toolLabel } from '@/components/badges';

const STATE_OPTIONS = [
  'APPROVAL_REQUIRED',
  'PERMIT_ISSUED',
  'APPROVED',
  'ALLOWED',
  'EXECUTING',
  'SUCCEEDED',
  'DENIED',
  'REJECTED',
  'FAILED_TERMINAL',
  'UNKNOWN_OUTCOME',
  'MANUAL_REVIEW',
  'EXPIRED',
] as const;

export default function ActionsPage(): React.JSX.Element {
  const [filters, setFilters] = React.useState<ActionFilters>({});
  const [cursors, setCursors] = React.useState<Array<string | null>>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;
  const { page, error, isLoading } = useActions(filters, cursor);

  const setFilter = (key: keyof ActionFilters, value: string): void => {
    setFilters((prev) => {
      const next = { ...prev };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });
    setCursors([null]);
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Actions</h1>
          <p className="mt-1 text-sm text-muted-foreground">Every request agents and operators have made, newest activity first.</p>
        </div>
        <Link href="/actions/new" className={buttonVariants()}>
          <PlusCircle aria-hidden /> New request
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="filter-state">State</Label>
          <Select value={filters.state ?? ''} onValueChange={(v) => setFilter('state', v === 'ALL' ? '' : v)}>
            <SelectTrigger id="filter-state">
              <SelectValue placeholder="All states" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All states</SelectItem>
              {STATE_OPTIONS.map((s) => (
                <SelectItem key={s} value={s}>
                  {s.toLowerCase().replace(/_/g, ' ')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="filter-tool">Tool</Label>
          <Select value={filters.tool_name ?? ''} onValueChange={(v) => setFilter('tool_name', v === 'ALL' ? '' : v)}>
            <SelectTrigger id="filter-tool">
              <SelectValue placeholder="All tools" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All tools</SelectItem>
              {SUPPORTED_TOOLS.map((t) => (
                <SelectItem key={t} value={t}>
                  {toolLabel(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="filter-agent">Agent ID</Label>
          <Input
            id="filter-agent"
            value={filters.agent_id ?? ''}
            onChange={(e) => setFilter('agent_id', e.target.value.trim())}
            placeholder="agt_…"
            className="font-mono text-xs"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="filter-run">Run ID</Label>
          <Input
            id="filter-run"
            value={filters.run_id ?? ''}
            onChange={(e) => setFilter('run_id', e.target.value.trim())}
            placeholder="run_…"
            className="font-mono text-xs"
          />
        </div>
      </div>

      <RequestError error={error} />
      {isLoading && !page ? <ActionTableSkeleton /> : <ActionTable actions={page?.data ?? []} />}

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {page ? `Showing ${page.data.length} request${page.data.length === 1 ? '' : 's'}` : ''}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={cursors.length <= 1} onClick={() => setCursors((c) => c.slice(0, -1))}>
            Back
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!page?.meta.next_cursor}
            onClick={() => {
              const next = page?.meta.next_cursor;
              if (next) setCursors((c) => [...c, next]);
            }}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
