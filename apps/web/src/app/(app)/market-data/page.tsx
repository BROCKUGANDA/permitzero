'use client';

import * as React from 'react';
import { Button, Input, Label } from '@permitzero/ui';

interface Quote {
  symbol: string;
  price: string;
  currency: string | null;
  market_time: string | null;
  fetched_at: string;
  stale: boolean;
  source: string;
}

export default function MarketDataPage(): React.JSX.Element {
  const [symbol, setSymbol] = React.useState('USDILS=X');
  const [from, setFrom] = React.useState('USD');
  const [to, setTo] = React.useState('ILS');
  const [quote, setQuote] = React.useState<Quote | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const fetchQuote = async (s: string) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/market-data/quote?symbol=${encodeURIComponent(s)}`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setQuote((await response.json()) as Quote);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch the quote.');
    } finally {
      setBusy(false);
    }
  };

  const fetchFx = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/market-data/fx?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setQuote((await response.json()) as Quote);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch the FX rate.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Market data</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Yahoo Finance reference data. Every value carries its source, provider market time and fetch timestamp; a
          stale snapshot is labelled <code>stale: true</code>. Reference data only — it authorizes nothing.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="symbol">Symbol</Label>
          <div className="flex gap-2">
            <Input id="symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} />
            <Button variant="secondary" disabled={busy} onClick={() => fetchQuote(symbol)}>
              Get quote
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>FX pair</Label>
          <div className="flex gap-2">
            <Input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="USD" />
            <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="ILS" />
            <Button variant="secondary" disabled={busy} onClick={fetchFx}>
              Get rate
            </Button>
          </div>
        </div>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {quote ? (
        <div className="rounded-md border p-4 text-sm">
          <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Symbol</dt>
              <dd className="font-mono font-semibold">{quote.symbol}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Price</dt>
              <dd className="font-mono font-semibold">
                {quote.price} {quote.currency ?? ''}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Market time</dt>
              <dd className="font-mono">{quote.market_time ?? 'unknown'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Fetched</dt>
              <dd className="font-mono">{quote.fetched_at}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Stale</dt>
              <dd className="font-mono">{quote.stale ? 'yes' : 'no'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Source</dt>
              <dd className="font-mono">{quote.source}</dd>
            </div>
          </dl>
        </div>
      ) : null}
    </div>
  );
}
