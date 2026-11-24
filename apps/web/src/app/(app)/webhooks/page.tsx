'use client';

import * as React from 'react';
import { useAuth } from '@/lib/auth';

interface Delivery {
  provider: string;
  delivery_id: string;
  trace_id: string;
  outcome: string;
  resolved_tenant_id: string | null;
  resolved_action_id: string | null;
  provider_ref: string | null;
  received_at: string;
}

export default function WebhooksPage(): React.JSX.Element {
  const { token } = useAuth();
  const [deliveries, setDeliveries] = React.useState<Delivery[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/v1/webhooks/wise/deliveries', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { items: Delivery[] };
        if (!cancelled) setDeliveries(body.items);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load webhook deliveries.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-mono text-2xl font-semibold tracking-tight">Delivery evidence</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Historical provider-delivery records, scoped to your tenant. This release is simulation-only: the inbound Wise
          webhook route is not registered and no live provider callback is accepted.
        </p>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {deliveries === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : deliveries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No deliveries recorded yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Received</th>
                <th className="px-3 py-2 text-left font-medium">Outcome</th>
                <th className="px-3 py-2 text-left font-medium">Provider ref</th>
                <th className="px-3 py-2 text-left font-medium">Tenant</th>
                <th className="px-3 py-2 text-left font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.delivery_id} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">{d.received_at}</td>
                  <td className="px-3 py-2">{d.outcome}</td>
                  <td className="px-3 py-2 font-mono">{d.provider_ref ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs">{d.resolved_tenant_id ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs">{d.resolved_action_id ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
