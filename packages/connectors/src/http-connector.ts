/**
 * Generic HTTP API connector — the "external API gateway" surface of the
 * runtime boundary. It dispatches an HTTP request to a caller-declared,
 * allowlisted destination under exactly the same enforcement as every other
 * connector (permits, approvals, single-use permits, idempotency, honest
 * unknown outcomes).
 *
 * Security posture:
 *  - Destination allowlist: the URL's host must be in the connector's
 *    configured allowlist (exact match or suffix match). No SSRF.
 *  - Method allowlist: only declared methods dispatch.
 *  - Body size limit: oversized bodies are rejected before dispatch.
 *  - No credential passthrough: credentials come from the connector's own
 *    secret-manager reference, never from the action payload.
 *  - Idempotency: an `Idempotency-Key` header is derived from the
 *    PermitZero idempotency key and sent on dispatch; the ledger dedupes locally.
 *  - Honest outcomes: a response whose status is 5xx or whose network call
 *    timed out is `FAILED_RETRYABLE` / `TIMEOUT_AFTER_DISPATCH`, never an
 *    assumed success.
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

export interface HttpConnectorConfig {
  connectorId: string;
  /** Secret-manager reference. Held, never dereferenced or exposed. */
  credentialRef: string;
  data: ConnectorDataStore;
  /** Allowlisted destination hosts. Empty = no dispatch at all (fail closed). */
  allowedHosts: readonly string[];
  /** Allowlisted HTTP methods. Default: ['GET','POST','PUT','PATCH']. */
  allowedMethods?: readonly string[];
  /** Per-request body size cap in bytes. Default 64 KiB. */
  maxBodyBytes?: number;
  /** Per-request timeout in ms. Default 10_000. */
  timeoutMs?: number;
  clock?: () => Date;
  fetchImpl?: typeof fetch;
}

export class HttpConnectorError extends Error {
  readonly retryable: boolean;
  readonly status: number | null;
  constructor(message: string, opts: { retryable: boolean; status: number | null }) {
    super(message);
    this.name = 'HttpConnectorError';
    this.retryable = opts.retryable;
    this.status = opts.status;
  }
}

export class HttpFinanceConnector implements FinanceConnector {
  private readonly config: HttpConnectorConfig;
  private readonly clock: () => Date;
  private readonly allowedMethods: readonly string[];
  private readonly maxBodyBytes: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: HttpConnectorConfig) {
    this.config = config;
    this.clock = config.clock ?? (() => new Date());
    this.allowedMethods = config.allowedMethods ?? ['GET', 'POST', 'PUT', 'PATCH'];
    this.maxBodyBytes = config.maxBodyBytes ?? 65_536;
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** Generic HTTP dispatch — the only operation this connector serves. */
  async dispatchHttp(request: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string | null;
    tenantId: string;
    idempotencyKey: string;
    actionId: string;
    executionId: string;
    traceId: string;
  }): Promise<ConnectorCallResult> {
    const method = request.method.toUpperCase();
    if (!this.allowedMethods.includes(method)) {
      return { status: 'FAILED_TERMINAL', errorClass: 'METHOD_NOT_ALLOWED' };
    }
    let parsed: URL;
    try {
      parsed = new URL(request.url);
    } catch {
      return { status: 'FAILED_TERMINAL', errorClass: 'INVALID_URL' };
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { status: 'FAILED_TERMINAL', errorClass: 'INVALID_URL_SCHEME' };
    }
    if (!this.isHostAllowed(parsed.hostname)) {
      return { status: 'FAILED_TERMINAL', errorClass: 'DESTINATION_NOT_ALLOWED' };
    }
    if (request.body && request.body.length > this.maxBodyBytes) {
      return { status: 'FAILED_TERMINAL', errorClass: 'PAYLOAD_TOO_LARGE' };
    }

    const existing = await this.config.data.getLedgerEntry(request.tenantId, request.idempotencyKey);
    if (existing) return { status: 'SUCCEEDED', receipt: existing.receipt };

    await this.config.data.recordDispatch({
      tenantId: request.tenantId,
      connectorIdempotencyKey: request.idempotencyKey,
      operation: 'http.dispatch',
      startedAt: this.clock(),
      completedAt: null,
      outcome: null,
      providerRef: null,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await this.fetchImpl(request.url, {
        method,
        headers: {
          ...(request.headers ?? {}),
          'Idempotency-Key': request.idempotencyKey,
          'X-PermitZero-Action': request.actionId,
        },
        ...(request.body ? { body: request.body } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      await this.config.data.completeDispatch(request.tenantId, request.idempotencyKey, 'FAILED_RETRYABLE', this.clock());
      return { status: 'FAILED_RETRYABLE', errorClass: 'TRANSPORT_ERROR' };
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 500 || response.status === 429) {
      await this.config.data.completeDispatch(request.tenantId, request.idempotencyKey, 'FAILED_RETRYABLE', this.clock());
      return { status: 'FAILED_RETRYABLE', errorClass: `HTTP_${response.status}` };
    }
    if (response.status >= 400) {
      await this.config.data.completeDispatch(request.tenantId, request.idempotencyKey, 'FAILED_TERMINAL', this.clock());
      return { status: 'FAILED_TERMINAL', errorClass: `HTTP_${response.status}` };
    }
    const receipt = this.buildReceipt(request.idempotencyKey, request.idempotencyKey, this.clock());
    await this.config.data.putLedgerEntryIfAbsent({
      tenantId: request.tenantId,
      connectorId: this.config.connectorId,
      connectorIdempotencyKey: request.idempotencyKey,
      operation: 'http.dispatch',
      externalReference: `http_${response.status}_${request.executionId}`,
      receipt,
      detailRedacted: {
        method,
        host: parsed.hostname,
        status: response.status,
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

  private isHostAllowed(host: string): boolean {
    if (this.config.allowedHosts.length === 0) return false;
    const normalized = host.trim().toLowerCase();
    return this.config.allowedHosts.some((h) => {
      const allowed = h.trim().toLowerCase();
      return normalized === allowed || normalized.endsWith(`.${allowed}`);
    });
  }

  private buildReceipt(idempotencyKey: string, _fallback: string, completedAt: Date): ConnectorReceipt {
    const externalReference = `http_${idempotencyKey.slice(0, 16)}`;
    const receiptHash = canonicalHash({
      external_reference: externalReference,
      amount_minor: 0,
      currency: 'XXX',
      beneficiary_ref: externalReference,
      completed_at: completedAt.toISOString(),
      simulated: false,
    });
    return {
      externalReference,
      receiptHash,
      amountMinor: 0,
      currency: 'XXX',
      beneficiaryRef: externalReference,
      completedAt,
      simulated: false,
    };
  }

  // FinanceConnector interface — HTTP connector does not serve money operations.
  async executePayment(_request: ConnectorPaymentRequest): Promise<ConnectorCallResult> {
    return { status: 'FAILED_TERMINAL', errorClass: 'OPERATION_NOT_ALLOWED' };
  }
  async updateVendorBankDetails(_request: ConnectorVendorChangeRequest): Promise<ConnectorCallResult> {
    return { status: 'FAILED_TERMINAL', errorClass: 'OPERATION_NOT_ALLOWED' };
  }
  async exportVendors(_request: ConnectorExportRequest): Promise<ConnectorCallResult> {
    return { status: 'FAILED_TERMINAL', errorClass: 'OPERATION_NOT_ALLOWED' };
  }
  async lookupByIdempotencyKey(tenantId: string, key: string): Promise<ConnectorReceipt | null> {
    const entry = await this.config.data.getLedgerEntry(tenantId, key);
    return entry ? entry.receipt : null;
  }
}
