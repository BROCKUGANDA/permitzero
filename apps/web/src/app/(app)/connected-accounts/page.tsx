'use client';

import * as React from 'react';
import { FlaskConical, ShieldCheck } from 'lucide-react';

/**
 * The commercial release is simulation-only. This screen replaces the live
 * provider OAuth flow rather than leaving a dormant route or a dead Connect
 * button behind. Historical delivery evidence remains available elsewhere.
 */
export default function ConnectedAccountsPage(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-mono text-2xl font-semibold tracking-tight">Simulation accounts</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Provider connections are disabled in this release. PermitZero executes against its isolated simulated ledger.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-md border border-primary/30 bg-primary/5 p-5">
          <FlaskConical className="size-6 text-primary" aria-hidden />
          <h2 className="mt-3 font-mono text-sm font-semibold uppercase tracking-wider">Simulated by design</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Accounts, counterparties, transfers and reconciliation are deterministic fixtures. No live banking endpoint,
            payment credential or settlement rail is reachable from the runtime.
          </p>
        </section>
        <section className="rounded-md border border-border bg-card p-5">
          <ShieldCheck className="size-6 text-primary" aria-hidden />
          <h2 className="mt-3 font-mono text-sm font-semibold uppercase tracking-wider">Hard boundary</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Setting <code>LIVE_FINANCE_ENABLED</code> fails API and worker startup. The OAuth and inbound
            provider-webhook routes are not registered, so there is no hidden switch to turn live dispatch on.
          </p>
        </section>
      </div>
    </div>
  );
}
