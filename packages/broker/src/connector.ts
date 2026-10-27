/**
 * Deterministic simulated finance connector.
 *
 * The only connector in this build. It holds synthetic vendors, invoices and
 * purchase orders, and records every effect in a ledger keyed by the connector
 * idempotency key: a repeated key returns the ORIGINAL receipt and creates no
 * second effect. Reads never touch the ledger; every side-effecting method
 * records a dispatch marker before attempting the effect so reconciliation can
 * tell "definitely did not happen" from "lost mid-flight".
 *
 * Connector credentials live only here: this class accepts a secret-manager
 * reference it never dereferences for the simulator and never exposes.
 */
import { createHash } from 'node:crypto';
import { canonicalHash, money } from '@permitzero/domain';
import type { InvoiceRecord, PurchaseOrderRecord, VendorRecord } from '@permitzero/domain';
import { systemClock } from './ports.js';
import type { Clock, ConnectorDataStore, ConnectorReceipt } from './ports.js';

export interface ConnectorPaymentRequest {
  tenantId: string;
  connectorId: string;
  idempotencyKey: string;
  invoiceId: string;
  vendorId: string;
  amountMinor: number;
  currency: string;
  beneficiaryRef: string;
  actionId: string;
  executionId: string;
  traceId: string;
}

export interface ConnectorVendorChangeRequest {
  tenantId: string;
  connectorId: string;
  idempotencyKey: string;
  vendorId: string;
  newBeneficiaryRef: string;
  verificationRef: string | null;
  actionId: string;
  executionId: string;
  traceId: string;
}

export interface ConnectorExportRequest {
  tenantId: string;
  connectorId: string;
  idempotencyKey: string;
  vendorId: string | null;
  recordLimit: number;
  dataClassification: string;
  actionId: string;
  executionId: string;
  traceId: string;
}

export type ConnectorCallResult =
  | { status: 'SUCCEEDED'; receipt: ConnectorReceipt }
  | { status: 'FAILED_RETRYABLE'; errorClass: string }
  | { status: 'FAILED_TERMINAL'; errorClass: string }
  | { status: 'TIMEOUT_AFTER_DISPATCH' };

/** Fault injection, driven by tests and the demo. Never enabled in production. */
export interface ConnectorFaultProfile {
  timeoutAfterDispatch: boolean;
  failRetryable: boolean;
  failTerminal: boolean;
  latencyMs: number;
  duplicateDelivery: boolean;
}

const DEFAULT_FAULT_PROFILE: ConnectorFaultProfile = {
  timeoutAfterDispatch: false,
  failRetryable: false,
  failTerminal: false,
  latencyMs: 0,
  duplicateDelivery: false,
};

let faultProfile: ConnectorFaultProfile = { ...DEFAULT_FAULT_PROFILE };

export function setConnectorFaultProfile(profile: Partial<ConnectorFaultProfile>): void {
  if (process.env['APP_ENV'] === 'production') {
    throw new Error('Connector fault injection is refused in production.');
  }
  faultProfile = { ...faultProfile, ...profile };
}

export function clearConnectorFaultProfile(): void {
  faultProfile = { ...DEFAULT_FAULT_PROFILE };
}

export interface SimulatedConnectorConfig {
  connectorId: string;
  /** Secret-manager reference. Held, never dereferenced or exposed. */
  credentialRef: string;
  data: ConnectorDataStore;
  clock?: Clock;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha16(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16);
}

export class SimulatedFinanceConnector {
  private readonly connectorId: string;
  private readonly data: ConnectorDataStore;
  private readonly clock: Clock;
  /** Held so the type system proves nothing upstream can read it. */
  private readonly credentialRef: string;

  constructor(config: SimulatedConnectorConfig) {
    this.connectorId = config.connectorId;
    this.credentialRef = config.credentialRef;
    this.data = config.data;
    this.clock = config.clock ?? systemClock;
  }

  async readInvoice(tenantId: string, invoiceId: string): Promise<InvoiceRecord | null> {
    return this.data.getInvoice(tenantId, invoiceId);
  }

  async readPurchaseOrder(tenantId: string, poId: string): Promise<PurchaseOrderRecord | null> {
    return this.data.getPurchaseOrder(tenantId, poId);
  }

  async readVendor(tenantId: string, vendorId: string): Promise<VendorRecord | null> {
    return this.data.getVendor(tenantId, vendorId);
  }

  async lookupByIdempotencyKey(tenantId: string, key: string): Promise<ConnectorReceipt | null> {
    const entry = await this.data.getLedgerEntry(tenantId, key);
    return entry ? entry.receipt : null;
  }

  /** Read-only liveness probe. Must never perform a consequential write. */
  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    const started = Date.now();
    await this.data.listVendors('health-probe-no-such-tenant', 1);
    return { ok: true, latencyMs: Date.now() - started };
  }

  async executePayment(request: ConnectorPaymentRequest): Promise<ConnectorCallResult> {
    if (faultProfile.latencyMs > 0) await sleep(faultProfile.latencyMs);
    try {
      money(request.amountMinor, request.currency);
    } catch {
      return { status: 'FAILED_TERMINAL', errorClass: 'INVALID_AMOUNT' };
    }
    if (request.amountMinor <= 0) return { status: 'FAILED_TERMINAL', errorClass: 'AMOUNT_NON_POSITIVE' };
    if (request.beneficiaryRef.length === 0 || request.vendorId.length === 0) {
      return { status: 'FAILED_TERMINAL', errorClass: 'MISSING_REQUIRED_FIELD' };
    }

    const existing = await this.data.getLedgerEntry(request.tenantId, request.idempotencyKey);
    if (existing) return { status: 'SUCCEEDED', receipt: existing.receipt };

    const now = this.clock();
    await this.data.recordDispatch({
      tenantId: request.tenantId,
      connectorIdempotencyKey: request.idempotencyKey,
      operation: 'payment.execute',
      startedAt: now,
      completedAt: null,
      outcome: null,
    });

    if (faultProfile.failTerminal) {
      await this.complete(request, 'FAILED_TERMINAL');
      return { status: 'FAILED_TERMINAL', errorClass: 'SIMULATED_TERMINAL_FAULT' };
    }
    if (faultProfile.failRetryable) {
      await this.complete(request, 'FAILED_RETRYABLE');
      return { status: 'FAILED_RETRYABLE', errorClass: 'SIMULATED_RETRYABLE_FAULT' };
    }

    const receipt = this.buildReceipt(request.idempotencyKey, {
      amountMinor: request.amountMinor,
      currency: request.currency,
      beneficiaryRef: request.beneficiaryRef,
      completedAt: this.clock(),
    });
    const inserted = await this.data.putLedgerEntryIfAbsent({
      tenantId: request.tenantId,
      connectorId: this.connectorId,
      connectorIdempotencyKey: request.idempotencyKey,
      operation: 'payment.execute',
      externalReference: receipt.externalReference,
      receipt,
      detailRedacted: {
        invoice_id: request.invoiceId,
        vendor_id: request.vendorId,
        action_id: request.actionId,
        execution_id: request.executionId,
      },
      actionId: request.actionId,
      executionId: request.executionId,
      recordedAt: this.clock(),
    });
    if (!inserted.inserted) {
      // Lost a race with a concurrent identical call: the original wins.
      await this.complete(request, 'SUCCEEDED');
      return { status: 'SUCCEEDED', receipt: inserted.entry.receipt };
    }

    if (faultProfile.timeoutAfterDispatch) {
      // The effect is durable but the response is "lost": the dispatch marker
      // stays open so reconciliation reports the truth.
      return { status: 'TIMEOUT_AFTER_DISPATCH' };
    }
    if (faultProfile.duplicateDelivery) {
      // Deliver twice internally to prove the ledger guard holds.
      const second = await this.data.putLedgerEntryIfAbsent({
        tenantId: request.tenantId,
        connectorId: this.connectorId,
        connectorIdempotencyKey: request.idempotencyKey,
        operation: 'payment.execute',
        externalReference: receipt.externalReference,
        receipt,
        detailRedacted: {},
        actionId: request.actionId,
        executionId: request.executionId,
        recordedAt: this.clock(),
      });
      if (second.inserted || second.entry.receipt.receiptHash !== receipt.receiptHash) {
        throw new Error('ledger idempotency guard failed under duplicate delivery');
      }
    }
    await this.complete(request, 'SUCCEEDED');
    return { status: 'SUCCEEDED', receipt };
  }

  async updateVendorBankDetails(request: ConnectorVendorChangeRequest): Promise<ConnectorCallResult> {
    if (faultProfile.latencyMs > 0) await sleep(faultProfile.latencyMs);
    if (request.vendorId.length === 0 || request.newBeneficiaryRef.length === 0) {
      return { status: 'FAILED_TERMINAL', errorClass: 'MISSING_REQUIRED_FIELD' };
    }
    const vendor = await this.data.getVendor(request.tenantId, request.vendorId);
    if (!vendor) return { status: 'FAILED_TERMINAL', errorClass: 'VENDOR_UNKNOWN' };

    const existing = await this.data.getLedgerEntry(request.tenantId, request.idempotencyKey);
    if (existing) return { status: 'SUCCEEDED', receipt: existing.receipt };

    await this.data.recordDispatch({
      tenantId: request.tenantId,
      connectorIdempotencyKey: request.idempotencyKey,
      operation: 'vendor.update_bank_details',
      startedAt: this.clock(),
      completedAt: null,
      outcome: null,
    });

    if (faultProfile.failTerminal) {
      await this.complete(request, 'FAILED_TERMINAL');
      return { status: 'FAILED_TERMINAL', errorClass: 'SIMULATED_TERMINAL_FAULT' };
    }
    if (faultProfile.failRetryable) {
      await this.complete(request, 'FAILED_RETRYABLE');
      return { status: 'FAILED_RETRYABLE', errorClass: 'SIMULATED_RETRYABLE_FAULT' };
    }

    // The change stages as PENDING: activation needs out-of-band verification
    // plus the policy cooling period, which the connector never grants itself.
    await this.data.putVendor({
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
    const inserted = await this.data.putLedgerEntryIfAbsent({
      tenantId: request.tenantId,
      connectorId: this.connectorId,
      connectorIdempotencyKey: request.idempotencyKey,
      operation: 'vendor.update_bank_details',
      externalReference: receipt.externalReference,
      receipt,
      detailRedacted: {
        vendor_id: request.vendorId,
        verification_ref_present: request.verificationRef !== null,
        action_id: request.actionId,
        execution_id: request.executionId,
      },
      actionId: request.actionId,
      executionId: request.executionId,
      recordedAt: this.clock(),
    });
    if (!inserted.inserted) {
      await this.complete(request, 'SUCCEEDED');
      return { status: 'SUCCEEDED', receipt: inserted.entry.receipt };
    }
    if (faultProfile.timeoutAfterDispatch) return { status: 'TIMEOUT_AFTER_DISPATCH' };
    await this.complete(request, 'SUCCEEDED');
    return { status: 'SUCCEEDED', receipt };
  }

  async exportVendors(request: ConnectorExportRequest): Promise<ConnectorCallResult> {
    if (faultProfile.latencyMs > 0) await sleep(faultProfile.latencyMs);
    if (!Number.isSafeInteger(request.recordLimit) || request.recordLimit < 1 || request.recordLimit > 100000) {
      return { status: 'FAILED_TERMINAL', errorClass: 'INVALID_RECORD_LIMIT' };
    }
    if (request.dataClassification.length === 0) {
      return { status: 'FAILED_TERMINAL', errorClass: 'MISSING_REQUIRED_FIELD' };
    }
    const existing = await this.data.getLedgerEntry(request.tenantId, request.idempotencyKey);
    if (existing) return { status: 'SUCCEEDED', receipt: existing.receipt };

    await this.data.recordDispatch({
      tenantId: request.tenantId,
      connectorIdempotencyKey: request.idempotencyKey,
      operation: 'vendor.export',
      startedAt: this.clock(),
      completedAt: null,
      outcome: null,
    });
    if (faultProfile.failTerminal) {
      await this.complete(request, 'FAILED_TERMINAL');
      return { status: 'FAILED_TERMINAL', errorClass: 'SIMULATED_TERMINAL_FAULT' };
    }
    if (faultProfile.failRetryable) {
      await this.complete(request, 'FAILED_RETRYABLE');
      return { status: 'FAILED_RETRYABLE', errorClass: 'SIMULATED_RETRYABLE_FAULT' };
    }

    const vendors = await this.data.listVendors(request.tenantId, request.recordLimit);
    const scoped = request.vendorId ? vendors.filter((v) => v.vendorId === request.vendorId) : vendors;
    const receipt = this.buildReceipt(request.idempotencyKey, {
      amountMinor: 0,
      currency: 'XXX',
      beneficiaryRef: 'DATA_EXPORT',
      completedAt: this.clock(),
    });
    const inserted = await this.data.putLedgerEntryIfAbsent({
      tenantId: request.tenantId,
      connectorId: this.connectorId,
      connectorIdempotencyKey: request.idempotencyKey,
      operation: 'vendor.export',
      externalReference: receipt.externalReference,
      receipt,
      detailRedacted: { record_count: scoped.length, data_classification: request.dataClassification },
      actionId: request.actionId,
      executionId: request.executionId,
      recordedAt: this.clock(),
    });
    if (!inserted.inserted) {
      await this.complete(request, 'SUCCEEDED');
      return { status: 'SUCCEEDED', receipt: inserted.entry.receipt };
    }
    if (faultProfile.timeoutAfterDispatch) return { status: 'TIMEOUT_AFTER_DISPATCH' };
    await this.complete(request, 'SUCCEEDED');
    return { status: 'SUCCEEDED', receipt };
  }

  private buildReceipt(
    idempotencyKey: string,
    body: { amountMinor: number; currency: string; beneficiaryRef: string; completedAt: Date },
  ): ConnectorReceipt {
    const externalReference = `sim_${sha16(`${this.connectorId}:${idempotencyKey}`)}`;
    const receiptHash = canonicalHash({
      external_reference: externalReference,
      amount_minor: body.amountMinor,
      currency: body.currency,
      beneficiary_ref: body.beneficiaryRef,
      completed_at: body.completedAt.toISOString(),
      simulated: true,
    });
    return {
      externalReference,
      receiptHash,
      amountMinor: body.amountMinor,
      currency: body.currency,
      beneficiaryRef: body.beneficiaryRef,
      completedAt: body.completedAt,
      simulated: true,
    };
  }

  private async complete(request: { tenantId: string; idempotencyKey: string }, outcome: string): Promise<void> {
    await this.data.completeDispatch(request.tenantId, request.idempotencyKey, outcome, this.clock());
  }
}
