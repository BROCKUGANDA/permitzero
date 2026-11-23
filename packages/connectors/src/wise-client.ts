/**
 * A minimal HTTP adapter for the Wise Platform API.
 *
 * This is the only file in the live path that knows Wise's URLs exist. It makes
 * no decisions and keeps no state: every call takes a bearer token handed to it
 * by the token manager, and every failure is classified as retryable (network,
 * 5xx, 429) or terminal (4xx) so the broker can apply its honest-outcome rules.
 * The injected `fetch` keeps the whole adapter testable without a network.
 *
 * Money leaves this package the same way it arrived: integer minor units. The
 * conversion to Wise's decimal major format happens exactly once, at the edge,
 * using the domain's currency exponents.
 */
import { currencyExponent } from '@permitzero/domain';
import type { FetchLike } from './oauth.js';

export interface WiseClientConfig {
  /** e.g. https://api.sandbox.transferwise.tech */
  baseUrl: string;
  fetchImpl?: FetchLike;
  clock?: () => Date;
  /** Per-request timeout in ms. Default 10_000. */
  timeoutMs?: number;
}

export class WiseApiError extends Error {
  readonly status: number;
  readonly providerCode: string | null;
  readonly retryable: boolean;

  constructor(message: string, status: number, providerCode: string | null, retryable: boolean) {
    super(message);
    this.name = 'WiseApiError';
    this.status = status;
    this.providerCode = providerCode;
    this.retryable = retryable;
  }
}

export interface QuoteResponse {
  id: string;
  sourceCurrency: string;
  targetCurrency: string;
}

export interface TransferResponse {
  id: number;
  status: string;
  sourceCurrency: string;
  targetCurrency: string;
  sourceValue: number;
  targetValue: number;
  targetAccount?: number | null;
  customerTransactionId: string | null;
}

export interface RecipientResponse {
  id: number;
  accountHolderName: string | null;
  currency: string | null;
  active: boolean | null;
}

export interface BalanceResponse {
  id: number;
  currency: string;
  amount: { value: number | string; currency: string } | number | string;
}

export type TransferOutcomeClass = 'SENT' | 'PENDING' | 'FAILED';

/** Wise transfer states bucketed into the three answers reconciliation needs. */
export function classifyTransferStatus(status: string): TransferOutcomeClass {
  switch (status) {
    // Money has provably left the account.
    case 'outgoing_payment_sent':
      return 'SENT';
    // In flight: created, converting, charged, awaiting pay-in. Not yet truth.
    case 'incoming_payment_waiting':
    case 'processing':
    case 'funds_converted':
    case 'funds_charged':
    case 'unknown':
      return 'PENDING';
    // Terminal failures. `bounce_back` means funds were returned: no completed
    // effect survives, so reconciliation treats it as failed, never as sent.
    case 'cancelled':
    case 'rejected':
    case 'bounce_back':
    case 'chargeback':
      return 'FAILED';
    default:
      // An unrecognized state is by definition unproven — never "sent".
      return 'PENDING';
  }
}

export class WiseClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(config: WiseClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async createQuote(
    token: string,
    body: { sourceCurrency: string; targetCurrency: string; targetAmount: string },
  ): Promise<QuoteResponse> {
    const data = await this.request<QuoteResponse>(token, 'POST', '/v3/quotes', body);
    if (typeof data.id !== 'string' || data.id.length === 0) {
      throw new WiseApiError('Wise quote response was malformed.', 200, null, false);
    }
    return data;
  }

  async createTransfer(
    token: string,
    body: {
      targetAccount: number;
      quoteUuid: string;
      customerTransactionId: string;
      details: { reference: string };
    },
  ): Promise<TransferResponse> {
    return this.request<TransferResponse>(token, 'POST', '/v1/transfers', body);
  }

  async getTransfer(token: string, transferId: string): Promise<TransferResponse> {
    return this.request<TransferResponse>(token, 'GET', `/v1/transfers/${encodeURIComponent(transferId)}`);
  }

  async getRecipient(token: string, recipientId: string): Promise<RecipientResponse> {
    return this.request<RecipientResponse>(token, 'GET', `/v1/accounts/${encodeURIComponent(recipientId)}`);
  }

  async listBalances(token: string, profileId: string): Promise<BalanceResponse[]> {
    const data = await this.request<BalanceResponse[]>(
      token,
      'GET',
      `/v4/profiles/${encodeURIComponent(profileId)}/balances?types=STANDARD`,
    );
    return Array.isArray(data) ? data : [];
  }

  /** Fund a transfer from one of the profile's balances (the connected account's money). */
  async fundTransfer(token: string, profileId: string, balanceId: number, transferId: string): Promise<void> {
    await this.request<unknown>(
      token,
      'POST',
      `/v4/profiles/${encodeURIComponent(profileId)}/balances/${balanceId}/transfer-execute`,
      { transferId },
    );
  }

  /**
   * Wise's decimal major-unit amount, derived exactly from minor units with the
   * domain's currency exponent — the conversion lives here and nowhere else.
   */
  static majorAmount(amountMinor: number, currency: string): string {
    const exponent = currencyExponent(currency);
    return (amountMinor / 10 ** exponent).toFixed(exponent);
  }

  private async request<T>(token: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      // A network failure can happen before OR after the provider processed the
      // request; the caller decides per endpoint whether that is a retry or an
      // unknown outcome. This adapter does not pretend to know.
      throw new WiseApiError(`Wise request failed: ${err instanceof Error ? err.message : String(err)}`, 0, null, true);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const retryable = response.status >= 500 || response.status === 429;
      const problem = (await response.json().catch(() => null)) as { code?: unknown; message?: unknown } | null;
      throw new WiseApiError(
        typeof problem?.message === 'string' ? problem.message : `Wise returned ${response.status}.`,
        response.status,
        typeof problem?.code === 'string' ? problem.code : null,
        retryable,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}
