/**
 * The LIVE finance connector: real transfers through a tenant's own
 * OAuth-connected Wise account.
 *
 * It implements exactly the same `FinanceConnector` seam as the simulated
 * connector, under exactly the same broker enforcement (permits, approvals,
 * ledger idempotency, dispatch markers, honest unknown-outcome handling). What
 * changes is only what sits behind the seam: effects are real HTTPS calls to
 * Wise, money is real, and every receipt carries `simulated: false`.
 *
 * Invariants this class is responsible for:
 *
 *  1. Ledger first. A repeated idempotency key returns the ORIGINAL receipt and
 *     never creates a second transfer — this is the local half of duplicate
 *     defense; Wise's `customerTransactionId` is the provider half, derived
 *     deterministically from the same key.
 *  2. Dispatch marker before any provider call, with the provider's own id
 *     persisted the moment it exists, so a process dying mid-flight still
 *     leaves reconciliation a handle on the truth.
 *  3. Honest outcomes. A funded transfer that has not provably arrived is
 *     TIMEOUT_AFTER_DISPATCH (UNKNOWN_OUTCOME upstream, resolved later by
 *     reconciliation) — never an assumed failure, never a blind retry.
 *  4. Beneficiary identity stays a REFERENCE (`wise:recipient:<id>`). Raw bank
 *     details live only inside the user's Wise account; PermitZero stores and
 *     hashes the reference, and the vendor verification/cooling-period policy
 *     still governs every change.
 *
 * Token material is touched only here and only in memory: it enters through the
 * token manager and leaves in an Authorization header. It is never logged,
 * never returned, and never persisted by this class.
 */
import { createHash } from 'node:crypto';
import type {
  ConnectorCallResult,
  ConnectorDataStore,
  ConnectorExportRequest,
  ConnectorPaymentRequest,
  ConnectorReceipt,
  ConnectorVendorChangeRequest,
  FinanceConnector,
} from '@permitzero/broker';
import { canonicalHash, currencyExponent, money } from '@permitzero/domain';
import { uuidV5 } from './uuid.js';
import { TokenMissingError, TokenRevokedError } from './token-manager.js';
import type { WiseTokenManager } from './token-manager.js';
import { WiseApiError, WiseClient, classifyTransferStatus } from './wise-client.js';
import type { TransferResponse } from './wise-client.js';

/** The only beneficiary shape a live payment accepts. */
export const WISE_BENEFICIARY_PREFIX = 'wise:recipient:';

export function parseWiseRecipientRef(beneficiaryRef: string): number | null {
  if (!beneficiaryRef.startsWith(WISE_BENEFICIARY_PREFIX)) return null;
  const rest = beneficiaryRef.slice(WISE_BENEFICIARY_PREFIX.length);
  return /^\d{1,18}$/.test(rest) ? Number.parseInt(rest, 10) : null;
}

export interface WiseConnectorConfig {
  connectorId: string;
  connectedAccountId: string;
  tokenManager: WiseTokenManager;
  wiseClient: WiseClient;
  data: ConnectorDataStore;
  /**
   * Resolves the connected account's provider profile id (the Wise profile the
   * token acts on). Lives behind a port because it is authoritative data the
   * DB owns; fetching it lazily keeps construction synchronous like every
   * other connector.
   */
  profileResolver: (tenantId: string, connectedAccountId: string) => Promise<string>;
  clock?: () => Date;
  /** Status polls before declaring the outcome unknown. Default 5. */
  pollAttempts?: number;
  /** Milliseconds between polls. Default 1_000. */
  pollIntervalMs?: number;
}

type FailedOutcome = Extract<ConnectorCallResult, { status: 'FAILED_RETRYABLE' | 'FAILED_TERMINAL' }>;

export class WiseFinanceConnector implements FinanceConnector {
  private readonly config: WiseConnectorConfig;
  private readonly clock: () => Date;

  constructor(config: WiseConnectorConfig) {
    this.config = config;
    this.clock = config.clock ?? (() => new Date());
  }

  async executePayment(request: ConnectorPaymentRequest): Promise<ConnectorCallResult> {
    try {
      money(request.amountMinor, request.currency);
    } catch {
      return { status: 'FAILED_TERMINAL', errorClass: 'INVALID_AMOUNT' };
    }
    if (request.amountMinor <= 0) return { status: 'FAILED_TERMINAL', errorClass: 'AMOUNT_NON_POSITIVE' };
    const recipientId = parseWiseRecipientRef(request.beneficiaryRef);
    if (recipientId === null) {
      // A live payment refuses any beneficiary that is not a registered Wise
      // recipient: raw bank details never travel through PermitZero, and an
      // unregistered destination never receives money.
      return { status: 'FAILED_TERMINAL', errorClass: 'RECIPIENT_NOT_REGISTERED' };
    }

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

    // 0. Token. Failing here provably reached no provider endpoint.
    const token = await this.call(() => this.accessToken(request), 'CONNECTED_ACCOUNT_TOKEN_INVALID');
    if ('failure' in token) return token.failure;

    // 1. Quote. Failing here provably created nothing: safe to retry.
    const quote = await this.call(
      () =>
        this.config.wiseClient.createQuote(token.value, {
          sourceCurrency: request.currency,
          targetCurrency: request.currency,
          targetAmount: WiseClient.majorAmount(request.amountMinor, request.currency),
        }),
      'PROVIDER_QUOTE_FAILED',
    );
    if ('failure' in quote) return quote.failure;

    // 2. Transfer. Wise dedupes on customerTransactionId (derived from OUR
    // idempotency key), so a retry can never create a second transfer.
    const transfer = await this.call(
      () =>
        this.config.wiseClient.createTransfer(token.value, {
          targetAccount: recipientId,
          quoteUuid: quote.value.id,
          customerTransactionId: uuidFromIdempotencyKey(request.idempotencyKey),
          details: { reference: request.actionId.slice(0, 10) },
        }),
      'PROVIDER_TRANSFER_FAILED',
    );
    if ('failure' in transfer) return transfer.failure;

    // From here a transfer object exists at Wise: persist its id immediately so
    // a crash before the receipt still leaves reconciliation a handle.
    await this.config.data.setDispatchProviderRef(request.tenantId, request.idempotencyKey, String(transfer.value.id));

    // 3. Fund from the connected account's balance. A funding failure leaves
    // the transfer unfunded (no money moved): retryable, not terminal.
    const funded = await this.fund(token.value, transfer.value, request);
    if ('failure' in funded) return funded.failure;

    // 4. Poll for the honest terminal truth.
    return this.pollToOutcome(request, token.value, transfer.value);
  }

  async updateVendorBankDetails(request: ConnectorVendorChangeRequest): Promise<ConnectorCallResult> {
    const recipientId = parseWiseRecipientRef(request.newBeneficiaryRef);
    if (request.vendorId.length === 0 || recipientId === null) {
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

    // Verify the referenced recipient actually exists at the provider BEFORE
    // anything is staged: a beneficiary change is only real if the destination
    // is real. No money moves in this operation.
    const token = await this.call(() => this.accessToken(request), 'CONNECTED_ACCOUNT_TOKEN_INVALID');
    if ('failure' in token) return token.failure;
    const recipient = await this.call(
      () => this.config.wiseClient.getRecipient(token.value, String(recipientId)),
      'PROVIDER_RECIPIENT_CHECK_FAILED',
    );
    if ('failure' in recipient) return recipient.failure;

    // The change stages as PENDING exactly like the simulated connector:
    // activation needs out-of-band verification plus the policy cooling period,
    // which this connector never grants itself.
    await this.config.data.putVendor({
      ...vendor,
      pendingBeneficiaryRef: request.newBeneficiaryRef,
      bankingChangedAt: this.clock(),
      bankingChangeVerifiedAt: null,
    });
    const receipt = this.buildReceipt(request.idempotencyKey, {
      // Non-monetary effect: zero amount with the ISO "no currency" code.
      amountMinor: 0,
      currency: 'XXX',
      beneficiaryRef: request.newBeneficiaryRef,
      completedAt: this.clock(),
    });
    return this.commitReceipt(request, receipt, 'vendor.update_bank_details', {
      vendor_id: request.vendorId,
      verification_ref_present: request.verificationRef !== null,
      recipient_id: recipientId,
      action_id: request.actionId,
      execution_id: request.executionId,
    });
  }

  /**
   * A live connector never serves data exports: vendor records belong to the
   * simulated ledger only, and the connector's allowedTools denies the tool
   * upstream anyway. This is the belt to that suspenders.
   */
  async exportVendors(_request: ConnectorExportRequest): Promise<ConnectorCallResult> {
    return { status: 'FAILED_TERMINAL', errorClass: 'OPERATION_NOT_ALLOWED' };
  }

  async lookupByIdempotencyKey(tenantId: string, connectorIdempotencyKey: string): Promise<ConnectorReceipt | null> {
    const entry = await this.config.data.getLedgerEntry(tenantId, connectorIdempotencyKey);
    if (entry) return entry.receipt;

    const dispatches = await this.config.data.listDispatches(tenantId, connectorIdempotencyKey);
    const providerRef = dispatches.find((d) => d.providerRef !== null)?.providerRef ?? null;
    if (providerRef === null) return null; // Nothing provably dispatched: "not proven".

    let token: string;
    try {
      token = await this.config.tokenManager.accessToken(tenantId, this.config.connectedAccountId);
    } catch {
      return null; // Cannot authenticate the truth check: not proven, never failed.
    }
    let transfer: TransferResponse;
    try {
      transfer = await this.config.wiseClient.getTransfer(token, providerRef);
    } catch {
      return null; // Provider unreachable: not proven.
    }
    switch (classifyTransferStatus(transfer.status)) {
      case 'SENT': {
        const receipt = this.buildReceipt(connectorIdempotencyKey, {
          amountMinor: minorFromMajor(transfer.sourceValue, transfer.sourceCurrency),
          currency: transfer.sourceCurrency,
          beneficiaryRef:
            transfer.targetAccount !== undefined && transfer.targetAccount !== null
              ? `${WISE_BENEFICIARY_PREFIX}${transfer.targetAccount}`
              : 'UNKNOWN_RECIPIENT',
          completedAt: this.clock(),
        });
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
      }
      case 'PENDING':
        return null; // Still in flight: the dispatch marker stays open on purpose.
      case 'FAILED': {
        await this.config.data.completeDispatch(tenantId, connectorIdempotencyKey, 'FAILED_TERMINAL', this.clock());
        return null; // Broker reads closed dispatches + no receipt => failed.
      }
    }
  }

  // -- internals -------------------------------------------------------------

  private accessToken(request: { tenantId: string }): Promise<string> {
    return this.config.tokenManager.accessToken(request.tenantId, this.config.connectedAccountId);
  }

  /** Run a provider call, mapping failures onto honest connector outcomes. */
  private async call<T>(
    fn: () => Promise<T>,
    terminalClass: string,
  ): Promise<{ value: T } | { failure: FailedOutcome }> {
    try {
      return { value: await fn() };
    } catch (err) {
      if (err instanceof TokenMissingError || err instanceof TokenRevokedError) {
        return { failure: { status: 'FAILED_TERMINAL', errorClass: 'CONNECTED_ACCOUNT_TOKEN_INVALID' } };
      }
      if (err instanceof WiseApiError) {
        return err.retryable
          ? { failure: { status: 'FAILED_RETRYABLE', errorClass: 'PROVIDER_UNAVAILABLE' } }
          : {
              failure: { status: 'FAILED_TERMINAL', errorClass: `${terminalClass}:${err.providerCode ?? err.status}` },
            };
      }
      // Unknown programming failure inside the live path: the provider may have
      // processed the request, so the honest outcome is unknown, never failed.
      throw err;
    }
  }

  private async fund(
    token: string,
    transfer: TransferResponse,
    request: ConnectorPaymentRequest,
  ): Promise<{ value: true } | { failure: FailedOutcome }> {
    let profileId: string;
    try {
      profileId = await this.config.profileResolver(request.tenantId, this.config.connectedAccountId);
    } catch {
      return { failure: { status: 'FAILED_RETRYABLE', errorClass: 'CONNECTED_ACCOUNT_PROFILE_UNRESOLVED' } };
    }
    let balances;
    try {
      balances = await this.config.wiseClient.listBalances(token, profileId);
    } catch (err) {
      if (err instanceof WiseApiError && !err.retryable) {
        return { failure: { status: 'FAILED_TERMINAL', errorClass: 'PROVIDER_BALANCE_LOOKUP_FAILED' } };
      }
      return { failure: { status: 'FAILED_RETRYABLE', errorClass: 'PROVIDER_UNAVAILABLE' } };
    }
    const major = Number(WiseClient.majorAmount(request.amountMinor, request.currency));
    const balance = balances.find((b) => b.currency === request.currency && Number(balanceValue(b.amount)) >= major);
    if (!balance) {
      // No money moved — the transfer object stays unfunded and expires.
      return { failure: { status: 'FAILED_TERMINAL', errorClass: 'INSUFFICIENT_PROVIDER_BALANCE' } };
    }
    try {
      await this.config.wiseClient.fundTransfer(token, profileId, balance.id, String(transfer.id));
      return { value: true };
    } catch (err) {
      if (err instanceof WiseApiError && !err.retryable) {
        return { failure: { status: 'FAILED_TERMINAL', errorClass: 'PROVIDER_FUNDING_REJECTED' } };
      }
      // Funding may or may not have applied; the transfer is unfunded or
      // in-flight either way — retrying re-funds the SAME transfer (Wise keeps
      // it addressable by id), so a retry is safe.
      return { failure: { status: 'FAILED_RETRYABLE', errorClass: 'PROVIDER_FUNDING_FAILED' } };
    }
  }

  private async pollToOutcome(
    request: ConnectorPaymentRequest,
    token: string,
    transfer: TransferResponse,
  ): Promise<ConnectorCallResult> {
    const attempts = this.config.pollAttempts ?? 5;
    const intervalMs = this.config.pollIntervalMs ?? 1_000;
    let latest = transfer;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(intervalMs);
      let status: TransferResponse;
      try {
        status = await this.config.wiseClient.getTransfer(token, String(latest.id));
        latest = status;
      } catch {
        // A poll failure is not a transfer failure: stop polling and let
        // reconciliation resolve against the provider later.
        return { status: 'TIMEOUT_AFTER_DISPATCH' };
      }
      switch (classifyTransferStatus(status.status)) {
        case 'SENT': {
          const receipt = this.buildReceipt(request.idempotencyKey, {
            amountMinor: minorFromMajor(status.sourceValue, status.sourceCurrency),
            currency: status.sourceCurrency,
            beneficiaryRef: request.beneficiaryRef,
            completedAt: this.clock(),
          });
          return this.commitReceipt(request, receipt, 'payment.execute', {
            invoice_id: request.invoiceId,
            vendor_id: request.vendorId,
            provider_transfer_id: String(status.id),
            provider_status: status.status,
            action_id: request.actionId,
            execution_id: request.executionId,
          });
        }
        case 'FAILED': {
          await this.config.data.completeDispatch(
            request.tenantId,
            request.idempotencyKey,
            'FAILED_TERMINAL',
            this.clock(),
          );
          return { status: 'FAILED_TERMINAL', errorClass: `TRANSFER_${status.status.toUpperCase()}` };
        }
        case 'PENDING':
          break;
      }
    }
    // Still in flight after the poll window: the provider holds the truth, and
    // the reconciliation sweep will resolve it. Never guess.
    return { status: 'TIMEOUT_AFTER_DISPATCH' };
  }

  private async commitReceipt(
    request: { tenantId: string; idempotencyKey: string; actionId: string; executionId: string },
    receipt: ConnectorReceipt,
    operation: string,
    detailRedacted: Record<string, unknown>,
  ): Promise<ConnectorCallResult> {
    const inserted = await this.config.data.putLedgerEntryIfAbsent({
      tenantId: request.tenantId,
      connectorId: this.config.connectorId,
      connectorIdempotencyKey: request.idempotencyKey,
      operation,
      externalReference: receipt.externalReference,
      receipt,
      detailRedacted,
      actionId: request.actionId,
      executionId: request.executionId,
      recordedAt: this.clock(),
    });
    await this.config.data.completeDispatch(request.tenantId, request.idempotencyKey, 'SUCCEEDED', this.clock());
    // Lost a race with a concurrent identical call: the original receipt wins.
    return { status: 'SUCCEEDED', receipt: inserted.inserted ? receipt : inserted.entry.receipt };
  }

  private buildReceipt(
    idempotencyKey: string,
    body: { amountMinor: number; currency: string; beneficiaryRef: string; completedAt: Date },
  ): ConnectorReceipt {
    const externalReference = `wise_${sha16(`${this.config.connectorId}:${idempotencyKey}`)}`;
    const receiptHash = canonicalHash({
      external_reference: externalReference,
      amount_minor: body.amountMinor,
      currency: body.currency,
      beneficiary_ref: body.beneficiaryRef,
      completed_at: body.completedAt.toISOString(),
      simulated: false,
    });
    return {
      externalReference,
      receiptHash,
      amountMinor: body.amountMinor,
      currency: body.currency,
      beneficiaryRef: body.beneficiaryRef,
      completedAt: body.completedAt,
      simulated: false,
    };
  }
}

function sha16(input: string): string {
  // Matches the simulated connector's reference scheme; the prefix, not the
  // hash, tells the two apart.
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16);
}

/** Deterministic provider idempotency id: one logical action, one transfer. */
function uuidFromIdempotencyKey(idempotencyKey: string): string {
  return uuidV5(`permitzero:connector:${idempotencyKey}`);
}

/** Wise reports balances in `{value, currency}` or bare numbers; accept both. */
function balanceValue(amount: number | string | { value: number | string } | undefined): number | string {
  if (amount === undefined) return Number.NaN;
  if (typeof amount === 'number' || typeof amount === 'string') return amount;
  return amount.value;
}

function minorFromMajor(value: number, currency: string): number {
  try {
    return Math.round(value * 10 ** currencyExponent(currency));
  } catch {
    return Math.round(value * 100); // Defensive: an unknown currency has no proven effect anyway.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
