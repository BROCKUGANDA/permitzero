/**
 * Market reference data (Yahoo Finance): persisted snapshots.
 *
 * These tables are GLOBAL, not tenant-owned — quotes and FX rates are public
 * reference data. Callers write them through a plain transaction
 * (`withTransaction`), never a tenant scope. Reads are served behind
 * authentication and the caller decides staleness.
 */
import { eq } from 'drizzle-orm';
import type { DbExecutor } from '../client.js';
import { marketSnapshots } from '../schema.js';
import type { MarketSnapshotRow } from '../schema.js';

export interface MarketSnapshotInput {
  symbol: string;
  price: string;
  currency: string | null;
  marketTime: Date | null;
  fetchedAt: Date;
  raw: Record<string, unknown>;
}

export async function upsertMarketSnapshot(ex: DbExecutor, input: MarketSnapshotInput): Promise<MarketSnapshotRow> {
  const values = {
    symbol: input.symbol,
    price: input.price,
    currency: input.currency,
    source: 'yahoo_finance',
    marketTime: input.marketTime,
    fetchedAt: input.fetchedAt,
    rawJson: input.raw,
  };
  const [row] = await ex
    .insert(marketSnapshots)
    .values(values)
    .onConflictDoUpdate({ target: marketSnapshots.symbol, set: values })
    .returning();
  if (!row) throw new Error('market snapshot upsert returned no row');
  return row;
}

export async function getMarketSnapshot(ex: DbExecutor, symbol: string): Promise<MarketSnapshotRow | null> {
  const rows = await ex.select().from(marketSnapshots).where(eq(marketSnapshots.symbol, symbol)).limit(1);
  return rows[0] ?? null;
}
