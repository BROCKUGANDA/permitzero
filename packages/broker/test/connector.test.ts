/**
 * SimulatedFinanceConnector tests: ledger idempotency, staged vendor changes,
 * read-only health checks and the fault-injection profile.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { VendorRecord } from '@permitzero/domain';
import { createMemoryStores, stagingFor } from '../src/memory-stores.js';
import { SimulatedFinanceConnector, clearConnectorFaultProfile, setConnectorFaultProfile } from '../src/connector.js';

const TENANT = 'ten_test';

function vendor(overrides: Partial<VendorRecord> = {}): VendorRecord {
  return {
    vendorId: 'VEN-017',
    tenantId: TENANT,
    name: 'SYNTHETIC Example Ltd',
    status: 'VERIFIED',
    verifiedBeneficiaryRef: 'BEN-017-VERIFIED',
    verifiedAt: new Date('2026-01-15T00:00:00Z'),
    bankingChangedAt: null,
    bankingChangeVerifiedAt: null,
    pendingBeneficiaryRef: null,
    allowedDestinationRefs: ['BEN-017-VERIFIED'],
    accountAgeDays: 400,
    dataClassification: 'INTERNAL',
    ...overrides,
  };
}

function setup() {
  const now = { t: new Date('2026-10-26T12:00:00Z').getTime() };
  const clock = () => new Date(now.t);
  const stores = createMemoryStores({ clock });
  const connector = new SimulatedFinanceConnector({
    connectorId: 'con_sim',
    credentialRef: 'secret://sim/test',
    data: stores.data,
    clock,
  });
  return { stores, connector };
}

afterEach(() => {
  clearConnectorFaultProfile();
});

describe('SimulatedFinanceConnector', () => {
  it('executes a payment and records the receipt in the ledger', async () => {
    const { stores, connector } = setup();
    const result = await connector.executePayment({
      tenantId: TENANT,
      connectorId: 'con_sim',
      idempotencyKey: 'key-1',
      invoiceId: 'INV-2041',
      vendorId: 'VEN-017',
      amountMinor: 300000,
      currency: 'USD',
      beneficiaryRef: 'BEN-017-VERIFIED',
      actionId: 'act_1',
      executionId: 'exe_1',
      traceId: 'trc_1',
    });
    expect(result.status).toBe('SUCCEEDED');
    if (result.status !== 'SUCCEEDED') return;
    expect(Object.keys(result.receipt).sort()).toEqual([
      'amountMinor',
      'beneficiaryRef',
      'completedAt',
      'currency',
      'externalReference',
      'receiptHash',
      'simulated',
    ]);
    expect(result.receipt.simulated).toBe(true);
    expect(result.receipt.receiptHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await stores.data.getLedgerEntry(TENANT, 'key-1')).not.toBeNull();
    expect(await connector.lookupByIdempotencyKey(TENANT, 'key-1')).toEqual(result.receipt);
  });

  it('returns the original receipt when the key repeats', async () => {
    const { stores, connector } = setup();
    const base = {
      tenantId: TENANT,
      connectorId: 'con_sim',
      idempotencyKey: 'key-dup',
      invoiceId: 'INV-2041',
      vendorId: 'VEN-017',
      amountMinor: 300000,
      currency: 'USD',
      beneficiaryRef: 'BEN-017-VERIFIED',
      actionId: 'act_1',
      executionId: 'exe_1',
      traceId: 'trc_1',
    };
    const first = await connector.executePayment(base);
    const second = await connector.executePayment({ ...base, executionId: 'exe_2' });
    expect(first.status).toBe('SUCCEEDED');
    expect(second).toEqual(first);
    expect(await stores.data.listLedger(TENANT)).toHaveLength(1);
  });

  it('stages vendor bank changes as pending, never verified', async () => {
    const { stores, connector } = setup();
    await stores.data.putVendor(vendor());
    const result = await connector.updateVendorBankDetails({
      tenantId: TENANT,
      connectorId: 'con_sim',
      idempotencyKey: 'key-vc-1',
      vendorId: 'VEN-017',
      newBeneficiaryRef: 'BEN-999-NEW',
      verificationRef: null,
      actionId: 'act_2',
      executionId: 'exe_2',
      traceId: 'trc_2',
    });
    expect(result.status).toBe('SUCCEEDED');
    const updated = await stores.data.getVendor(TENANT, 'VEN-017');
    expect(updated?.pendingBeneficiaryRef).toBe('BEN-999-NEW');
    expect(updated?.bankingChangedAt).not.toBeNull();
    expect(updated?.bankingChangeVerifiedAt).toBeNull();
    expect(updated?.verifiedBeneficiaryRef).toBe('BEN-017-VERIFIED');
  });

  it('terminally fails unknown vendors and invalid amounts', async () => {
    const { connector } = setup();
    const change = await connector.updateVendorBankDetails({
      tenantId: TENANT,
      connectorId: 'con_sim',
      idempotencyKey: 'key-vc-2',
      vendorId: 'VEN-NOPE',
      newBeneficiaryRef: 'BEN-X',
      verificationRef: null,
      actionId: 'a',
      executionId: 'e',
      traceId: 't',
    });
    expect(change).toMatchObject({ status: 'FAILED_TERMINAL', errorClass: 'VENDOR_UNKNOWN' });

    const zero = await connector.executePayment({
      tenantId: TENANT,
      connectorId: 'con_sim',
      idempotencyKey: 'key-zero',
      invoiceId: 'INV-1',
      vendorId: 'VEN-017',
      amountMinor: 0,
      currency: 'USD',
      beneficiaryRef: 'BEN-017-VERIFIED',
      actionId: 'a',
      executionId: 'e',
      traceId: 't',
    });
    expect(zero).toMatchObject({ status: 'FAILED_TERMINAL', errorClass: 'AMOUNT_NON_POSITIVE' });

    const badExport = await connector.exportVendors({
      tenantId: TENANT,
      connectorId: 'con_sim',
      idempotencyKey: 'key-exp-bad',
      vendorId: null,
      recordLimit: 0,
      dataClassification: 'INTERNAL',
      actionId: 'a',
      executionId: 'e',
      traceId: 't',
    });
    expect(badExport).toMatchObject({ status: 'FAILED_TERMINAL', errorClass: 'INVALID_RECORD_LIMIT' });
  });

  it('exports vendors and records the access in the ledger', async () => {
    const { stores, connector } = setup();
    await stores.data.putVendor(vendor());
    const result = await connector.exportVendors({
      tenantId: TENANT,
      connectorId: 'con_sim',
      idempotencyKey: 'key-exp-1',
      vendorId: null,
      recordLimit: 100,
      dataClassification: 'INTERNAL',
      actionId: 'a',
      executionId: 'e',
      traceId: 't',
    });
    expect(result.status).toBe('SUCCEEDED');
    const entry = await stores.data.getLedgerEntry(TENANT, 'key-exp-1');
    expect(entry?.operation).toBe('vendor.export');
    expect(entry?.detailRedacted).toMatchObject({ record_count: 1 });
  });

  it('applies the fault profile and leaves timed-out dispatches open', async () => {
    const { stores, connector } = setup();
    setConnectorFaultProfile({ failRetryable: true });
    await expect(
      connector.executePayment({
        tenantId: TENANT,
        connectorId: 'con_sim',
        idempotencyKey: 'key-fr',
        invoiceId: 'INV-1',
        vendorId: 'VEN-017',
        amountMinor: 100,
        currency: 'USD',
        beneficiaryRef: 'BEN-017-VERIFIED',
        actionId: 'a',
        executionId: 'e',
        traceId: 't',
      }),
    ).resolves.toMatchObject({ status: 'FAILED_RETRYABLE' });
    expect(await stores.data.getLedgerEntry(TENANT, 'key-fr')).toBeNull();

    setConnectorFaultProfile({ failRetryable: false, timeoutAfterDispatch: true });
    await expect(
      connector.executePayment({
        tenantId: TENANT,
        connectorId: 'con_sim',
        idempotencyKey: 'key-to',
        invoiceId: 'INV-1',
        vendorId: 'VEN-017',
        amountMinor: 100,
        currency: 'USD',
        beneficiaryRef: 'BEN-017-VERIFIED',
        actionId: 'a',
        executionId: 'e',
        traceId: 't',
      }),
    ).resolves.toMatchObject({ status: 'TIMEOUT_AFTER_DISPATCH' });
    // Effect durable, response lost, dispatch marker open.
    expect(await stores.data.getLedgerEntry(TENANT, 'key-to')).not.toBeNull();
    const dispatches = await stores.data.listDispatches(TENANT, 'key-to');
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.completedAt).toBeNull();
  });

  it('survives duplicate delivery with a single ledger entry', async () => {
    const { stores, connector } = setup();
    setConnectorFaultProfile({ duplicateDelivery: true });
    const result = await connector.executePayment({
      tenantId: TENANT,
      connectorId: 'con_sim',
      idempotencyKey: 'key-dd',
      invoiceId: 'INV-1',
      vendorId: 'VEN-017',
      amountMinor: 100,
      currency: 'USD',
      beneficiaryRef: 'BEN-017-VERIFIED',
      actionId: 'a',
      executionId: 'e',
      traceId: 't',
    });
    expect(result.status).toBe('SUCCEEDED');
    expect(await stores.data.listLedger(TENANT)).toHaveLength(1);
  });

  it('refuses fault injection in production', async () => {
    const prev = process.env['APP_ENV'];
    process.env['APP_ENV'] = 'production';
    try {
      expect(() => setConnectorFaultProfile({ failTerminal: true })).toThrow();
    } finally {
      if (prev === undefined) delete process.env['APP_ENV'];
      else process.env['APP_ENV'] = prev;
    }
  });

  it('answers reads and health checks without writing', async () => {
    const { stores, connector } = setup();
    await stores.data.putVendor(vendor());
    stagingFor(stores.data).putInvoice({
      invoiceId: 'INV-2041',
      tenantId: TENANT,
      vendorId: 'VEN-017',
      amountMinor: 300000,
      currency: 'USD',
      purchaseOrderId: 'PO-882',
      status: 'OPEN',
      documentText: null,
      untrusted: true,
    });
    expect(await connector.readVendor(TENANT, 'VEN-017')).not.toBeNull();
    expect(await connector.readVendor(TENANT, 'VEN-NOPE')).toBeNull();
    expect(await connector.readInvoice(TENANT, 'INV-2041')).not.toBeNull();
    expect(await connector.readPurchaseOrder(TENANT, 'PO-NOPE')).toBeNull();
    await expect(connector.healthCheck()).resolves.toMatchObject({ ok: true });
    expect(await stores.data.listLedger(TENANT)).toHaveLength(0);
  });
});
