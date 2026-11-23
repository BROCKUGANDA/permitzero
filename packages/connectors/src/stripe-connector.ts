/**
 * Stripe Connect adapter — the second live finance provider behind the same
 * `FinanceConnector` seam. Users connect their own Stripe account through the
 * Connect OAuth flow; PermitZero never holds a provider API key.
 *
 * Money moves as Stripe Transfers (platform → connected account), which is the
 * primitive that maps to "pay a supplier": the platform holds funds and
 * transfers them to the supplier's connected account. The beneficiary
 * reference is `stripe:account:acct_...` — the connected account id.
 *
 * Honest outcomes: a 5xx/429/timeout is retryable; a 4xx is terminal; a
 * created transfer whose status is later reversed is reported as failed by
 * reconciliation, never as succeeded.
 */
import type {
  ConnectorCallResult,
  ConnectorDataStore,
  ConnectorExportRequest,
  ConnectorPaymentRequest,
  ConnectorReceipt,
  ConnectorVendorChangeRequest,
  FinanceConnector,
} from '@permitzero/broker';
import { canonicalHash } from '@permitzero/domain';

export const STRIPE_BENEFICIARY_PREFIX = 'stripe:account:';

export function parseStripeAccountRef(beneficiaryRef: string): string | null {
  if (!beneficiaryRef.startsWith(STRIPE_BENEFICIARY_PREFIX)) return null;
  const rest = beneficiaryRef.slice(STRIPE_BENEFICIARY_PREFIX.length);
  return /^acct_[A-Za-z0-9]{1,64}$/.test(rest) ? rest : null;
}

export interface StripeOAuthConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
  scopes: readonly string[];
}

export interface StripeTokenResponse {
  accessToken: string;
  refreshToken: string | null;
  stripeUserId: string;
  scope: string | null;
}

export class StripeOAuthError extends Error {
  readonly status: number;
  readonly providerCode: string | null;
  constructor(message: string, status: number, providerCode: string | null) {
    super(message);
    this.name = 'StripeOAuthError';
    this.status = status;
    this.providerCode = providerCode;
  }
}

export function buildStripeAuthorizeUrl(config: StripeOAuthConfig, state: string): string {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('scope', config.scopes.join(' ') || 'read_write');
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

export async function exchangeStripeCode(
  config: StripeOAuthConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StripeTokenResponse> {
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetchImpl(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_secret: config.clientSecret,
      }).toString(),
    });
  } catch (err) {
    throw new StripeOAuthError(
      `Stripe token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
      0,
      null,
    );
  }
  const body = (await response.json().catch(() => null)) as {
    access_token?: unknown;
    refresh_token?: unknown;
    stripe_user_id?: unknown;
    scope?: unknown;
    error?: unknown;
    error_description?: unknown;
  } | null;
  if (!response.ok || typeof body?.access_token !== 'string' || typeof body?.stripe_user_id !== 'string') {
    throw new StripeOAuthError(
      typeof body?.error_description === 'string' ? body.error_description : 'Stripe rejected the token request.',
      response.status,
      typeof body?.error === 'string' ? body.error : null,
    );
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    stripeUserId: body.stripe_user_id,
    scope: typeof body.scope === 'string' ? body.scope : null,
  };
}

export interface StripeClientConfig {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class StripeApiError extends Error {
  readonly status: number;
  readonly providerCode: string | null;
  readonly retryable: boolean;
  constructor(message: string, status: number, providerCode: string | null, retryable: boolean) {
    super(message);
    this.name = 'StripeApiError';
    this.status = status;
    this.providerCode = providerCode;
    this.retryable = retryable;
  }
}

export class StripeClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: StripeClientConfig = {}) {
    this.baseUrl = (config.baseUrl ?? 'https://api.stripe.com/v1').replace(/\/+$/, '');
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async createTransfer(
    token: string,
    body: { amount: number; currency: string; destination: string; idempotencyKey: string },
  ): Promise<{ id: string; amount: number; currency: string; destination: string; reversed: boolean }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/transfers`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': body.idempotencyKey,
        },
        body: new URLSearchParams({
          amount: String(body.amount),
          currency: body.currency.toLowerCase(),
          destination: body.destination,
        }).toString(),
        signal: controller.signal,
      });
    } catch (err) {
      throw new StripeApiError(
        `Stripe request failed: ${err instanceof Error ? err.message : String(err)}`,
        0,
        null,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const problem = (await response.json().catch(() => null)) as {
        error?: { code?: unknown; message?: unknown };
      } | null;
      throw new StripeApiError(
        typeof problem?.error?.message === 'string' ? problem.error.message : `Stripe returned ${response.status}.`,
        response.status,
        typeof problem?.error?.code === 'string' ? problem.error.code : null,
        response.status >= 500 || response.status === 429,
      );
    }
    const data = (await response.json()) as {
      id?: unknown;
      amount?: unknown;
      currency?: unknown;
      destination?: unknown;
      reversed?: unknown;
    };
    if (typeof data.id !== 'string')
      throw new StripeApiError('Stripe transfer response was malformed.', 200, null, false);
    return {
      id: data.id,
      amount: typeof data.amount === 'number' ? data.amount : body.amount,
      currency: typeof data.currency === 'string' ? data.currency.toUpperCase() : body.currency.toUpperCase(),
      destination: typeof data.destination === 'string' ? data.destination : body.destination,
      reversed: data.reversed === true,
    };
  }

  async retrieveTransfer(
    token: string,
    transferId: string,
  ): Promise<{ id: string; amount: number; currency: string; destination: string; reversed: boolean }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/transfers/${encodeURIComponent(transferId)}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
    } catch (err) {
      throw new StripeApiError(
        `Stripe request failed: ${err instanceof Error ? err.message : String(err)}`,
        0,
        null,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const problem = (await response.json().catch(() => null)) as {
        error?: { code?: unknown; message?: unknown };
      } | null;
      throw new StripeApiError(
        typeof problem?.error?.message === 'string' ? problem.error.message : `Stripe returned ${response.status}.`,
        response.status,
        typeof problem?.error?.code === 'string' ? problem.error.code : null,
        response.status >= 500 || response.status === 429,
      );
    }
    const data = (await response.json()) as {
      id?: unknown;
      amount?: unknown;
      currency?: unknown;
      destination?: unknown;
      reversed?: unknown;
    };
    if (typeof data.id !== 'string')
      throw new StripeApiError('Stripe transfer response was malformed.', 200, null, false);
    return {
      id: data.id,
      amount: typeof data.amount === 'number' ? data.amount : 0,
      currency: typeof data.currency === 'string' ? data.currency.toUpperCase() : 'USD',
      destination: typeof data.destination === 'string' ? data.destination : '',
      reversed: data.reversed === true,
    };
  }
}

export interface StripeConnectorConfig {
  connectorId: string;
  connectedAccountId: string;
  /** Resolves the connected account's restricted Stripe key. */
  tokenProvider: (tenantId: string, connectedAccountId: string) => Promise<string>;
  data: ConnectorDataStore;
  clock?: () => Date;
}

export class StripeFinanceConnector implements FinanceConnector {
  private readonly config: StripeConnectorConfig;
  private readonly clock: () => Date;
  private readonly client: StripeClient;

  constructor(config: StripeConnectorConfig & { client?: StripeClient }) {
    this.config = config;
    this.clock = config.clock ?? (() => new Date());
    this.client = config.client ?? new StripeClient();
  }

  async executePayment(request: ConnectorPaymentRequest): Promise<ConnectorCallResult> {
    const destination = parseStripeAccountRef(request.beneficiaryRef);
    if (!destination) return { status: 'FAILED_TERMINAL', errorClass: 'RECIPIENT_NOT_REGISTERED' };

    const existing = await this.config.data.getLedgerEntry(request.tenantId, request.idempotencyKey);
    if (existing) return { status: 'SUCCEEDED', receipt: existing.receipt };

    await this.config.data.recordDispatch({
      tenantId: request.tenantId,
      connectorIdempotencyKey: request.idempotencyKey,
      operation: 'payment.execute',
      startedAt: this.clock(),
      completedAt: null,
      outcome: null,
      providerRef: null,
    });

    let token: string;
    try {
      token = await this.config.tokenProvider(request.tenantId, this.config.connectedAccountId);
    } catch {
      await this.config.data.completeDispatch(
        request.tenantId,
        request.idempotencyKey,
        'FAILED_TERMINAL',
        this.clock(),
      );
      return { status: 'FAILED_TERMINAL', errorClass: 'CONNECTED_ACCOUNT_TOKEN_INVALID' };
    }

    let transfer;
    try {
      transfer = await this.client.createTransfer(token, {
        amount: request.amountMinor,
        currency: request.currency,
        destination,
        idempotencyKey: request.idempotencyKey,
      });
    } catch (err) {
      if (err instanceof StripeApiError) {
        await this.config.data.completeDispatch(
          request.tenantId,
          request.idempotencyKey,
          err.retryable ? 'FAILED_RETRYABLE' : 'FAILED_TERMINAL',
          this.clock(),
        );
        return err.retryable
          ? { status: 'FAILED_RETRYABLE', errorClass: 'PROVIDER_UNAVAILABLE' }
          : { status: 'FAILED_TERMINAL', errorClass: `PROVIDER_TRANSFER_FAILED:${err.providerCode ?? err.status}` };
      }
      throw err;
    }
    await this.config.data.setDispatchProviderRef(request.tenantId, request.idempotencyKey, transfer.id);

    const receipt: ConnectorReceipt = {
      externalReference: `stripe_${transfer.id}`,
      receiptHash: canonicalHash({
        external_reference: `stripe_${transfer.id}`,
        amount_minor: request.amountMinor,
        currency: request.currency,
        beneficiary_ref: request.beneficiaryRef,
        completed_at: this.clock().toISOString(),
        simulated: false,
      }),
      amountMinor: request.amountMinor,
      currency: request.currency,
      beneficiaryRef: request.beneficiaryRef,
      completedAt: this.clock(),
      simulated: false,
    };
    await this.config.data.putLedgerEntryIfAbsent({
      tenantId: request.tenantId,
      connectorId: this.config.connectorId,
      connectorIdempotencyKey: request.idempotencyKey,
      operation: 'payment.execute',
      externalReference: receipt.externalReference,
      receipt,
      detailRedacted: {
        provider_transfer_id: transfer.id,
        destination,
        action_id: request.actionId,
        execution_id: request.executionId,
      },
      actionId: request.actionId,
      executionId: request.executionId,
      recordedAt: this.clock(),
    });
    await this.config.data.completeDispatch(request.tenantId, request.idempotencyKey, 'SUCCEEDED', this.clock());
    return { status: 'SUCCEEDED', receipt };
  }

  async updateVendorBankDetails(request: ConnectorVendorChangeRequest): Promise<ConnectorCallResult> {
    const accountId = parseStripeAccountRef(request.newBeneficiaryRef);
    if (!accountId || request.vendorId.length === 0) {
      return { status: 'FAILED_TERMINAL', errorClass: 'MISSING_REQUIRED_FIELD' };
    }
    const vendor = await this.config.data.getVendor(request.tenantId, request.vendorId);
    if (!vendor) return { status: 'FAILED_TERMINAL', errorClass: 'VENDOR_UNKNOWN' };

    const existing = await this.config.data.getLedgerEntry(request.tenantId, request.idempotencyKey);
    if (existing) return { status: 'SUCCEEDED', receipt: existing.receipt };

    await this.config.data.recordDispatch({
      tenantId: request.tenantId,
      connectorIdempotencyKey: request.idempotencyKey,
      operation: 'vendor.update_bank_details',
      startedAt: this.clock(),
      completedAt: null,
      outcome: null,
      providerRef: null,
    });
    // Stripe external-account creation needs the connected account's secret;
    // PermitZero stores only the reference, so the change stages as PENDING
    // exactly like the simulated connector — activation needs verification.
    await this.config.data.putVendor({
      ...vendor,
      pendingBeneficiaryRef: request.newBeneficiaryRef,
      bankingChangedAt: this.clock(),
      bankingChangeVerifiedAt: null,
    });
    const receipt: ConnectorReceipt = {
      externalReference: `stripe_acct_${accountId}`,
      receiptHash: canonicalHash({
        external_reference: `stripe_acct_${accountId}`,
        amount_minor: 0,
        currency: 'XXX',
        beneficiary_ref: request.newBeneficiaryRef,
        completed_at: this.clock().toISOString(),
        simulated: false,
      }),
      amountMinor: 0,
      currency: 'XXX',
      beneficiaryRef: request.newBeneficiaryRef,
      completedAt: this.clock(),
      simulated: false,
    };
    await this.config.data.putLedgerEntryIfAbsent({
      tenantId: request.tenantId,
      connectorId: this.config.connectorId,
      connectorIdempotencyKey: request.idempotencyKey,
      operation: 'vendor.update_bank_details',
      externalReference: receipt.externalReference,
      receipt,
      detailRedacted: {
        vendor_id: request.vendorId,
        account_id: accountId,
        action_id: request.actionId,
        execution_id: request.executionId,
      },
      actionId: request.actionId,
      executionId: request.executionId,
      recordedAt: this.clock(),
    });
    await this.config.data.completeDispatch(request.tenantId, request.idempotencyKey, 'SUCCEEDED', this.clock());
    return { status: 'SUCCEEDED', receipt };
  }

  async exportVendors(_request: ConnectorExportRequest): Promise<ConnectorCallResult> {
    return { status: 'FAILED_TERMINAL', errorClass: 'OPERATION_NOT_ALLOWED' };
  }

  async lookupByIdempotencyKey(tenantId: string, connectorIdempotencyKey: string): Promise<ConnectorReceipt | null> {
    const entry = await this.config.data.getLedgerEntry(tenantId, connectorIdempotencyKey);
    if (entry) return entry.receipt;
    const dispatches = await this.config.data.listDispatches(tenantId, connectorIdempotencyKey);
    const providerRef = dispatches.find((d) => d.providerRef !== null)?.providerRef ?? null;
    if (!providerRef) return null;
    let token: string;
    try {
      token = await this.config.tokenProvider(tenantId, this.config.connectedAccountId);
    } catch {
      return null;
    }
    try {
      const transfer = await this.client.retrieveTransfer(token, providerRef);
      if (transfer.reversed) {
        await this.config.data.completeDispatch(tenantId, connectorIdempotencyKey, 'FAILED_TERMINAL', this.clock());
        return null;
      }
      const receipt: ConnectorReceipt = {
        externalReference: `stripe_${transfer.id}`,
        receiptHash: canonicalHash({
          external_reference: `stripe_${transfer.id}`,
          amount_minor: transfer.amount,
          currency: transfer.currency,
          beneficiary_ref: `${STRIPE_BENEFICIARY_PREFIX}${transfer.destination}`,
          completed_at: this.clock().toISOString(),
          simulated: false,
        }),
        amountMinor: transfer.amount,
        currency: transfer.currency,
        beneficiaryRef: `${STRIPE_BENEFICIARY_PREFIX}${transfer.destination}`,
        completedAt: this.clock(),
        simulated: false,
      };
      await this.config.data.putLedgerEntryIfAbsent({
        tenantId,
        connectorId: this.config.connectorId,
        connectorIdempotencyKey,
        operation: 'payment.execute',
        externalReference: receipt.externalReference,
        receipt,
        detailRedacted: { provider_transfer_id: providerRef, resolved_by: 'reconciliation' },
        actionId: null,
        executionId: null,
        recordedAt: this.clock(),
      });
      await this.config.data.completeDispatch(tenantId, connectorIdempotencyKey, 'SUCCEEDED', this.clock());
      return receipt;
    } catch {
      return null;
    }
  }
}
