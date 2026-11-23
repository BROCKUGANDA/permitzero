/**
 * Yahoo Finance client tests (no network): parsing of the public chart API,
 * FX symbol construction, and the retryable/terminal failure split the cache
 * and the sweep depend on.
 */
import { describe, expect, it } from 'vitest';
import { YahooFinanceClient, YahooFinanceError, fxPairSymbol, isValidYahooSymbol } from '../src/yahoo-finance.js';

const META_BODY = {
  chart: {
    result: [
      {
        meta: {
          regularMarketPrice: 3.8721,
          currency: 'ILS',
          regularMarketTime: 1_760_000_000,
        },
      },
    ],
    error: null,
  },
};

function stubFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe('YahooFinanceClient', () => {
  it('reads a quote from the chart API', async () => {
    const client = new YahooFinanceClient({ fetchImpl: stubFetch(200, META_BODY), baseUrl: 'https://finance.test' });
    const quote = await client.getQuote('USDILS=X');
    expect(quote.symbol).toBe('USDILS=X');
    expect(quote.regularMarketPrice).toBeCloseTo(3.8721);
    expect(quote.currency).toBe('ILS');
    expect(quote.regularMarketTimeSeconds).toBe(1_760_000_000);
  });

  it('builds FX pair symbols and rejects non-currency codes', () => {
    expect(fxPairSymbol('usd', 'ils')).toBe('USDILS=X');
    expect(fxPairSymbol('EUR', 'JPY')).toBe('EURJPY=X');
    expect(() => fxPairSymbol('USDT', 'ILS')).toThrow(YahooFinanceError);
    expect(() => fxPairSymbol('US', 'ILS')).toThrow(YahooFinanceError);
  });

  it('validates quote symbols strictly', () => {
    expect(isValidYahooSymbol('USDILS=X')).toBe(true);
    expect(isValidYahooSymbol('AAPL')).toBe(true);
    expect(isValidYahooSymbol('^GSPC')).toBe(true);
    expect(isValidYahooSymbol('AAPL;DROP')).toBe(false);
    expect(isValidYahooSymbol('')).toBe(false);
  });

  it('classifies transport and 5xx failures as retryable and 4xx as terminal', async () => {
    const retryable = new YahooFinanceClient({ fetchImpl: stubFetch(429, {}), baseUrl: 'https://finance.test' });
    await expect(retryable.getQuote('AAPL')).rejects.toMatchObject({ retryable: true, status: 429 });

    const terminal = new YahooFinanceClient({
      fetchImpl: stubFetch(404, { chart: { result: [], error: { code: 'Not Found' } } }),
      baseUrl: 'https://finance.test',
    });
    await expect(terminal.getQuote('AAPL')).rejects.toMatchObject({ retryable: false, status: 404 });
  });

  it('rejects malformed bodies and unusable prices', async () => {
    const noMeta = new YahooFinanceClient({
      fetchImpl: stubFetch(200, { chart: { result: [{}], error: null } }),
      baseUrl: 'https://finance.test',
    });
    await expect(noMeta.getQuote('AAPL')).rejects.toBeInstanceOf(YahooFinanceError);

    const noPrice = new YahooFinanceClient({
      fetchImpl: stubFetch(200, { chart: { result: [{ meta: { currency: 'USD' } }], error: null } }),
      baseUrl: 'https://finance.test',
    });
    await expect(noPrice.getQuote('AAPL')).rejects.toMatchObject({ retryable: false });
  });

  it('treats a chart-level error on a 200 response as terminal', async () => {
    const client = new YahooFinanceClient({
      fetchImpl: stubFetch(200, { chart: { result: [], error: { code: 'Not Found' } } }),
      baseUrl: 'https://finance.test',
    });
    await expect(client.getQuote('NOPE')).rejects.toMatchObject({ retryable: false, symbol: 'NOPE' });
  });

  it('reports a missing market time as null rather than inventing one', async () => {
    const client = new YahooFinanceClient({
      fetchImpl: stubFetch(200, {
        chart: { result: [{ meta: { regularMarketPrice: 12.5, regularMarketTime: 'not a number' } }], error: null },
      }),
      baseUrl: 'https://finance.test',
    });
    const quote = await client.getQuote('AAPL');
    expect(quote.regularMarketTimeSeconds).toBeNull();
  });

  it('classifies a non-JSON body as terminal and a transport throw as retryable', async () => {
    const notJson = new YahooFinanceClient({
      fetchImpl: (async () => new Response('<html>', { status: 200 })) as typeof fetch,
      baseUrl: 'https://finance.test',
    });
    await expect(notJson.getQuote('AAPL')).rejects.toMatchObject({ retryable: false });

    const offline = new YahooFinanceClient({
      fetchImpl: (async () => {
        throw new Error('socket closed');
      }) as typeof fetch,
      baseUrl: 'https://finance.test',
    });
    await expect(offline.getQuote('AAPL')).rejects.toMatchObject({ retryable: true, status: null });
  });

  it('trims symbols but never lets whitespace through to the URL', async () => {
    let requested = '';
    const client = new YahooFinanceClient({
      baseUrl: 'https://finance.test',
      fetchImpl: (async (url: string) => {
        requested = url;
        return new Response(JSON.stringify(META_BODY), { status: 200 });
      }) as typeof fetch,
    });
    await client.getQuote('  aapl  ');
    expect(requested).toContain('/chart/aapl?');
    expect(requested).not.toMatch(/\s/);
  });
});
