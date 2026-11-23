'use client';

import * as React from 'react';
import { Button, buttonVariants } from '@permitzero/ui';

interface ConnectedAccount {
  connected_account_id: string;
  provider: string;
  display_name: string;
  external_profile_id: string;
  status: 'ACTIVE' | 'REVOKED';
  connected_by: string;
  created_at: Date;
  updated_at: Date;
}

export default function ConnectedAccountsPage(): React.JSX.Element {
  const [accounts, setAccounts] = React.useState<ConnectedAccount[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const response = await fetch('/api/v1/connected-accounts', { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { items: ConnectedAccount[] };
      setAccounts(body.items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load connected accounts.');
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (id: string) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/connected-accounts/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke the connected account.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Connected accounts</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Payment-provider accounts tenants authorise PermitZero against, via OAuth. PermitZero never holds a provider
            API key; tokens are encrypted at rest and decrypted only inside the connector.
          </p>
        </div>
        <a href="/api/v1/connect/wise/start" className={buttonVariants()}>
          Connect a Wise account
        </a>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {accounts === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No connected accounts yet. Connect one to enable live dispatch.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Provider</th>
                <th className="px-3 py-2 text-left font-medium">Display name</th>
                <th className="px-3 py-2 text-left font-medium">Profile</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-left font-medium">Connected</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.connected_account_id} className="border-t">
                  <td className="px-3 py-2 font-mono">{account.provider}</td>
                  <td className="px-3 py-2">{account.display_name}</td>
                  <td className="px-3 py-2 font-mono">{account.external_profile_id}</td>
                  <td className="px-3 py-2">{account.status}</td>
                  <td className="px-3 py-2">
                    {account.created_at instanceof Date
                      ? account.created_at.toLocaleString()
                      : String(account.created_at)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {account.status === 'ACTIVE' ? (
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={busy}
                        onClick={() => revoke(account.connected_account_id)}
                      >
                        Revoke
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Live dispatch is gated by <code>LIVE_FINANCE_ENABLED</code>, the connected account and the
        <code>LIVE_MAX_AMOUNT_MINOR</code> ceiling — see docs/judge-readiness/LIVE-FINANCE.md.
      </p>
    </div>
  );
}
