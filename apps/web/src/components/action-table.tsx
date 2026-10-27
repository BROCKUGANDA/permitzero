'use client';

import Link from 'next/link';
import { Inbox } from 'lucide-react';
import { EmptyState, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@permitzero/ui';
import { formatDateTime, formatMoney } from '@/lib/format';
import { DecisionBadge, StateBadge, ToolBadge } from './badges';
import type { ActionDto } from '@permitzero/schemas';

function summaryOf(action: ActionDto): string {
  const args = action.arguments_redacted as Record<string, unknown>;
  const amount = typeof args['amount_minor'] === 'number' ? (args['amount_minor'] as number) : null;
  const currency = typeof args['currency'] === 'string' ? (args['currency'] as string) : 'USD';
  switch (action.tool_name) {
    case 'payment.execute':
    case 'payment.propose':
      return `${amount !== null ? formatMoney(amount, currency) : '—'} → ${String(args['vendor_id'] ?? '—')}`;
    case 'vendor.update_bank_details':
      return `${String(args['vendor_id'] ?? '—')} → ${String(args['new_beneficiary_ref'] ?? '—')}`;
    case 'vendor.export':
      return `limit ${String(args['record_limit'] ?? '—')}`;
    case 'invoice.read':
      return String(args['invoice_id'] ?? '—');
    case 'purchase_order.read':
      return String(args['purchase_order_id'] ?? '—');
    case 'vendor.read':
      return String(args['vendor_id'] ?? '—');
    default:
      return action.task_purpose;
  }
}

export function ActionTableSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2" aria-label="Loading actions">
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

export function ActionTable({ actions }: { actions: ActionDto[] }): React.JSX.Element {
  if (actions.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="No actions here"
        description="Nothing matches these filters yet. New requests from agents and operators will land here."
      />
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Request</TableHead>
          <TableHead>Tool</TableHead>
          <TableHead>State</TableHead>
          <TableHead>Decision</TableHead>
          <TableHead>Requested</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {actions.map((action) => (
          <TableRow key={action.action_id} className="cursor-pointer">
            <TableCell>
              <Link href={`/actions/${action.action_id}`} className="flex flex-col gap-0.5 hover:underline">
                <span className="font-medium">{summaryOf(action)}</span>
                <span className="max-w-md truncate text-xs text-muted-foreground">{action.task_purpose}</span>
              </Link>
            </TableCell>
            <TableCell>
              <ToolBadge tool={action.tool_name} />
            </TableCell>
            <TableCell>
              <StateBadge state={action.state} />
            </TableCell>
            <TableCell>
              <DecisionBadge decision={action.decision} />
            </TableCell>
            <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(action.requested_at)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
