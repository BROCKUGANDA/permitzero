/**
 * Market reference data (Yahoo Finance). Read-only, authenticated.
 *
 * Honesty rules baked in:
 *  - every price carries `source: 'yahoo_finance'`, a fetch timestamp and the
 *    provider's own market time when available;
 *  - a persisted snapshot is served only while fresh (`MARKET_SNAPSHOT_MAX_AGE_MS`,
 *    default 5 minutes); otherwise the API re-fetches live;
 *  - if the live fetch fails Yahoo throws a typed error; we serve the stale
 *    snapshot clearly labelled `stale: true`, or fail with 502 — never a
 *    silently flat line.
 *
 * This is reference data for displays and decisions; it authorizes nothing and
 * moves no money. It is authenticated like every other route here.
 */
import { YahooFinanceClient, YahooFinanceError, fxPairSymbol, isValidYahooSymbol } from '@permitzero/connectors';
import { getMarketSnapshot, upsertMarketSnapshot, withTransaction } from '@permitzero/db';
import { DomainError, ErrorCode, UnauthenticatedError, BadRequestError } from '@permitzero/domain';
import type { AppContext, ZodFastifyInstance } from '../app.js';
import { authenticateToken } from '../auth.js';

const PRICE_PATTERN = /^[A-Za-z0-9.^=_-]{1,32}$/;

export async function marketRoutes(app: ZodFastifyInstance, ctx: AppContext): Promise<void> {
  const client = new YahooFinanceClient();

  async function serveSnapshot(symbol: string): Promise<Record<string, unknown>> {
    const maxAgeMs = ctx.config.marketSnapshotMaxAgeMs;
    const snapshot = await withTransaction(ctx.runtime, (tx) => getMarketSnapshot(tx, symbol));
    if (snapshot && Date.now() - snapshot.fetchedAt.getTime() <= maxAgeMs) {
      return {
        symbol,
        price: snapshot.price,
        currency: snapshot.currency,
        market_time: snapshot.marketTime?.toISOString() ?? null,
        fetched_at: snapshot.fetchedAt.toISOString(),
        stale: false,
        source: snapshot.source,
      };
    }
    try {
      const quote = await client.getQuote(symbol);
      await withTransaction(ctx.runtime, (tx) =>
        upsertMarketSnapshot(tx, {
          symbol: quote.symbol,
          price: String(quote.regularMarketPrice),
          currency: quote.currency,
          marketTime: quote.regularMarketTimeSeconds ? new Date(quote.regularMarketTimeSeconds * 1000) : null,
          fetchedAt: new Date(),
          raw: {
            regularMarketPrice: quote.regularMarketPrice,
            currency: quote.currency,
            regularMarketTimeSeconds: quote.regularMarketTimeSeconds,
          },
        }),
      );
      return {
        symbol,
        price: String(quote.regularMarketPrice),
        currency: quote.currency,
        market_time: quote.regularMarketTimeSeconds
          ? new Date(quote.regularMarketTimeSeconds * 1000).toISOString()
          : null,
        fetched_at: new Date().toISOString(),
        stale: false,
        source: 'yahoo_finance',
      };
    } catch (err) {
      if (snapshot) {
        // Serve stale, but say it is stale.
        return {
          symbol,
          price: snapshot.price,
          currency: snapshot.currency,
          market_time: snapshot.marketTime?.toISOString() ?? null,
          fetched_at: snapshot.fetchedAt.toISOString(),
          stale: true,
          source: snapshot.source,
        };
      }
      const retryable = err instanceof YahooFinanceError ? err.retryable : true;
      throw new DomainError('Market reference data is unavailable right now.', {
        code: ErrorCode.CONNECTOR_ERROR,
        httpStatus: 502,
        retryable,
      });
    }
  }

  app.get('/market-data/quote', async (request) => {
    const principal = await authenticateToken(ctx.runtime, request.headers.authorization, new Date());
    if (!principal) throw new UnauthenticatedError();
    const { symbol } = request.query as { symbol?: string };
    if (typeof symbol !== 'string' || !isValidYahooSymbol(symbol)) {
      throw new BadRequestError(`symbol must match ${PRICE_PATTERN}`);
    }
    return serveSnapshot(symbol.trim());
  });

  app.get('/market-data/fx', async (request) => {
    const principal = await authenticateToken(ctx.runtime, request.headers.authorization, new Date());
    if (!principal) throw new UnauthenticatedError();
    const { from, to } = request.query as { from?: string; to?: string };
    if (typeof from !== 'string' || typeof to !== 'string') {
      throw new BadRequestError('from and to are required (three-letter currency codes).');
    }
    let symbol: string;
    try {
      symbol = fxPairSymbol(from, to);
    } catch {
      throw new BadRequestError('from and to must be three-letter currency codes.');
    }
    const snapshot = await serveSnapshot(symbol);
    return { ...snapshot, base: from.trim().toUpperCase(), quote: to.trim().toUpperCase() };
  });
}
