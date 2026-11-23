'use client';

import * as React from 'react';

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
  const [deliveries, setDeliveries] = React.useState<Delivery[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    (async () => {
      try {
        const response = await fetch('/api/v1/webhooks/wise/deliveries', { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { items: Delivery[] };
        setDeliveries(body.items);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load webhook deliveries.');
      }
    })();
  }, []);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Webhooks</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Provider webhook deliveries (Wise <code>transfers#state-change</code>). Each delivery is recorded before any
          work happens; the tenant is resolved by the provider&apos;s own reference, and the existing reconciliation
          consumer settles the action against provider truth. Webhooks never flip money state themselves.
        </p>
      </div>

      <div className="rounded-md border p-4 text-sm">
        <p className="font-medium">Endpoint to register with the provider</p>
        <code className="mt-1 block break-all font-mono text-xs">
          {typeof window !== 'undefined' ? `${window.location.origin}/api/v1/webhooks/wise` : '/api/v1/webhooks/wise'}
        </code>
        <p className="mt-2 text-xs text-muted-foreground">
          Requires <code>WISE_WEBHOOK_PUBLIC_KEY</code> (PEM) to be configured; otherwise the route is not registered
          (fail closed). Wise signs the raw body with RSA-SHA256 in <code>X-Signature-SHA256</code> and sends
          <code>X-Delivery-Id</code> for dedupe.
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
