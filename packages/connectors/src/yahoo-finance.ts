/**
 * Yahoo Finance market-data client (the same endpoints the `yfinance` library
 * scrapes: the public chart API on query1.finance.yahoo.com).
 *
 * Why this exists: PermitZero's live finance path occasionally needs market
 * reference data (an FX rate next to a quote, a price for a risk display).
 * This is READ-ONLY public reference data — it moves no money and authorizes
 * nothing. It is deliberately honest about being Yahoo: every value carries
 * the source, the provider's own market time, and a fetch timestamp, and the
 * caller decides how stale is too stale.
 *
 * What this client will not do: scrape HTML, fabricate a quote, or retry a
 * terminal failure. Every failure is classified retryable (network, 429,
 * 5xx) or terminal (everything else), so the caller can fall back to a stale
 * snapshot or fail visibly.
 */
export interface YahooChartMeta {
  symbol: string;
  regularMarketPrice: number;
  currency: string | null;
  /** Provider's own epoch-seconds market time, or null when absent. */
  regularMarketTimeSeconds: number | null;
}

export class YahooFinanceError extends Error {
  readonly retryable: boolean;
  readonly status: number | null;
  readonly symbol: string | null;

  constructor(message: string, opts: { retryable: boolean; status: number | null; symbol?: string | null }) {
    super(message);
    this.name = 'YahooFinanceError';
    this.retryable = opts.retryable;
    this.status = opts.status;
    this.symbol = opts.symbol ?? null;
  }
}

export interface YahooFinanceClientOptions {
  /** e.g. https://query1.finance.yahoo.com (override for tests/mocks). */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** A UA is required by Yahoo; keep the default boring and honest. */
  userAgent?: string;
}

const DEFAULT_BASE = 'https://query1.finance.yahoo.com';
const SYMBOL_PATTERN = /^[A-Za-z0-9.^=_-]{1,32}$/;
/** ISO 4217-ish codes: three letters. */
const CURRENCY_PATTERN = /^[A-Za-z]{3}$/;

export function isValidYahooSymbol(symbol: string): boolean {
  return SYMBOL_PATTERN.test(symbol);
}

/** Yahoo FX pairs: USDILS as `USDILS=X`. */
export function fxPairSymbol(fromCurrency: string, toCurrency: string): string {
  const from = fromCurrency.trim().toUpperCase();
  const to = toCurrency.trim().toUpperCase();
  if (!CURRENCY_PATTERN.test(from) || !CURRENCY_PATTERN.test(to)) {
    throw new YahooFinanceError('FX currencies must be three-letter codes.', {
      retryable: false,
      status: null,
    });
  }
  if (from === to) return `${from}${to}=X`; // Yahoo reports parity pairs too.
  return `${from}${to}=X`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseChartMeta(raw: unknown, symbol: string): YahooChartMeta {
  if (!isObject(raw)) {
    throw new YahooFinanceError('Yahoo returned a malformed chart body.', { retryable: false, status: null, symbol });
  }
  const chart = raw['chart'];
  if (!isObject(chart)) {
    throw new YahooFinanceError('Yahoo returned no chart object.', { retryable: false, status: null, symbol });
  }
  const error = chart['error'];
  if (isObject(error) && error['code'] !== null && error['code'] !== undefined) {
    throw new YahooFinanceError(`Yahoo rejected the symbol: ${String(error['code'])}`, {
      retryable: false,
      status: null,
      symbol,
    });
  }
  const result = chart['result'];
  if (!Array.isArray(result) || result.length === 0) {
    throw new YahooFinanceError('Yahoo returned no chart result.', { retryable: false, status: null, symbol });
  }
  const meta = isObject(result[0]) ? result[0]['meta'] : undefined;
  if (!isObject(meta)) {
    throw new YahooFinanceError('Yahoo returned no chart meta.', { retryable: false, status: null, symbol });
  }
  const price = meta['regularMarketPrice'];
  if (typeof price !== 'number' || !Number.isFinite(price)) {
    throw new YahooFinanceError('Yahoo returned no usable price for this symbol.', {
      retryable: false,
      status: null,
      symbol,
    });
  }
  const currency = typeof meta['currency'] === 'string' && meta['currency'].length > 0 ? meta['currency'] : null;
  const regularMarketTime = meta['regularMarketTime'];
  return {
    symbol,
    regularMarketPrice: price,
    currency,
    regularMarketTimeSeconds:
      typeof regularMarketTime === 'number' && Number.isFinite(regularMarketTime) ? regularMarketTime : null,
  };
}

export class YahooFinanceClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: YahooFinanceClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.userAgent = options.userAgent ?? 'PermitZero/0.1 (+market-data)';
  }

  async getQuote(symbol: string): Promise<YahooChartMeta> {
    const normalized = symbol.trim();
    if (!isValidYahooSymbol(normalized)) {
      throw new YahooFinanceError(`Symbol ${JSON.stringify(symbol)} is not a valid Yahoo Finance symbol.`, {
        retryable: false,
        status: null,
        symbol,
      });
    }
    const url = `${this.baseUrl}/v8/finance/chart/${encodeURIComponent(normalized)}?interval=1d&range=5d`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (err) {
      // Network failure or our own timeout: possibly transient. The caller decides.
      throw new YahooFinanceError(`Yahoo request failed: ${err instanceof Error ? err.message : String(err)}`, {
        retryable: true,
        status: null,
        symbol: normalized,
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 429 || response.status >= 500) {
      throw new YahooFinanceError(`Yahoo returned ${response.status}.`, {
        retryable: true,
        status: response.status,
        symbol: normalized,
      });
    }
    if (!response.ok) {
      throw new YahooFinanceError(`Yahoo returned ${response.status}.`, {
        retryable: false,
        status: response.status,
        symbol: normalized,
      });
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new YahooFinanceError('Yahoo returned a non-JSON body.', {
        retryable: false,
        status: response.status,
        symbol: normalized,
      });
    }
    return parseChartMeta(body, normalized);
  }

  async getFxRate(fromCurrency: string, toCurrency: string): Promise<YahooChartMeta> {
    return this.getQuote(fxPairSymbol(fromCurrency, toCurrency));
  }
}
