/**
 * Wise connector tests: the live path against a scripted fake provider — no
 * network. What they pin down is the live contract the broker relies on:
 * ledger-first idempotency, the provider reference persisted the moment it
 * exists, honest unknown outcomes, the beneficiary-reference rule, and the
 * token-refresh boundary.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryStores } from '@permitzero/broker';
import type { ConnectorPaymentRequest, ConnectorReceipt } from '@permitzero/broker';
import { WiseClient } from '../src/wise-client.js';
import { WiseTokenManager, TokenStore } from '../src/token-manager.js';
import type { ProviderToken } from '../src/token-manager.js';
import { WiseFinanceConnector } from '../src/wise-connector.js';
import type { WiseConnectorConfig } from '../src/wise-connector.js';

const TENANT = 'ten_test';

interface ProviderCall {
  method: string;
  path: string;
  body?: unknown;
}

interface FakeProviderState {
  calls: ProviderCall[];
  quoteId: string;
  transferId: number;
  transferStatus: string;
  balances: Array<{ id: number; currency: string; value: number }>;
  recipientExists: boolean;
  /** When set, the next transfer-status GET returns this status then reverts. */
  transientStatus?: string;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function makeFetch(state: FakeProviderState): typeof fetch {
  return (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    state.calls.push({ method, path, body });

    // OAuth endpoints
    if (path === '/oauth/token') {
      const params = new URLSearchParams(String(init?.body));
      const grant = params.get('grant_type');
      if (grant === 'refresh_token' && params.get('refresh_token') === 'expired') {
        return jsonResponse(400, { error: 'invalid_grant' });
      }
      return jsonResponse(200, {
        access_token: grant === 'refresh_token' ? 'access-2' : 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
      });
    }

    // Bearer check: everything below the OAuth endpoints is authenticated.
    const auth = new Headers(init?.headers).get('Authorization') ?? '';
    if (!auth.startsWith('Bearer access-')) return jsonResponse(401, { code: 'unauthorized' });

    if (method === 'POST' && path === '/v3/quotes') return jsonResponse(200, { id: state.quoteId });
    if (method === 'POST' && path === '/v1/transfers') {
      const request = body as { customerTransactionId?: string };
      return jsonResponse(200, {
        id: state.transferId,
        status: 'incoming_payment_waiting',
        sourceCurrency: 'USD',
        targetCurrency: 'USD',
        sourceValue: 250,
        targetValue: 250,
        targetAccount: 8692237,
        customerTransactionId: request?.customerTransactionId ?? null,
      });
    }
    if (method === 'GET' && path === `/v1/transfers/${state.transferId}`) {
      const status = state.transientStatus ?? state.transferStatus;
      return jsonResponse(200, {
        id: state.transferId,
        status,
        sourceCurrency: 'USD',
        targetCurrency: 'USD',
        sourceValue: 250,
        targetValue: 250,
        targetAccount: 8692237,
        customerTransactionId: null,
      });
    }
    if (method === 'GET' && path === '/v4/profiles/prof_1/balances') {
      return jsonResponse(
        200,
        state.balances.map((b) => ({
          id: b.id,
          currency: b.currency,
          amount: { value: b.value, currency: b.currency },
        })),
      );
    }
    if (method === 'POST' && path === `/v4/profiles/prof_1/balances/7/transfer-execute`) {
      return jsonResponse(200, { id: state.transferId, status: 'processing' });
    }
    if (method === 'GET' && path === '/v1/accounts/8692237') {
      return state.recipientExists
        ? jsonResponse(200, { id: 8692237, accountHolderName: 'Live Example Ltd', currency: 'USD', active: true })
        : jsonResponse(404, { code: 'not_found', message: 'recipient does not exist' });
    }
    return jsonResponse(404, { code: 'no_route' });
  }) as typeof fetch;
}

function freshState(): FakeProviderState {
  return {
    calls: [],
    quoteId: 'quote-uuid-1',
    transferId: 16521632,
    transferStatus: 'outgoing_payment_sent',
    balances: [{ id: 7, currency: 'USD', value: 500 }],
    recipientExists: true,
  };
}

const TOKEN_STORE: TokenStore = {
  load: async (_t, _id) => {
    const token: ProviderToken = {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: new Date(Date.now() + 3600_000),
      scope: null,
    };
    return token;
  },
  save: async () => undefined,
};

function makeConnector(
  data: ReturnType<typeof createMemoryStores>['data'],
  state: FakeProviderState,
  overrides: Partial<WiseConnectorConfig> = {},
): WiseFinanceConnector {
  const fetchImpl = makeFetch(state);
  return new WiseFinanceConnector({
    connectorId: 'con_wise_live',
    connectedAccountId: 'cac_test',
    tokenManager: new WiseTokenManager({
      oauth: {
        clientId: 'client',
        clientSecret: 'secret',
        authorizeUrl: 'https://wise.test/oauth/authorize',
        tokenUrl: 'https://wise.test/oauth/token',
        redirectUri: 'https://api.test/callback',
        scopes: ['global'],
      },
      tokenStore: TOKEN_STORE,
      fetchImpl,
    }),
    wiseClient: new WiseClient({ baseUrl: 'https://wise.test', fetchImpl, timeoutMs: 1000 }),
    data,
    profileResolver: async () => 'prof_1',
    pollAttempts: 3,
    pollIntervalMs: 1,
    ...overrides,
  });
}

function paymentRequest(idempotencyKey: string): ConnectorPaymentRequest {
  return {
    tenantId: TENANT,
    connectorId: 'con_wise_live',
    idempotencyKey,
    invoiceId: 'INV-2041',
    vendorId: 'VEN-017',
    amountMinor: 25000,
    currency: 'USD',
    beneficiaryRef: 'wise:recipient:8692237',
    actionId: 'act_test',
    executionId: 'exe_test',
    traceId: 'trc_test',
  };
}

describe('WiseFinanceConnector', () => {
  it('executes a real transfer end to end: quote, transfer, fund, receipt', async () => {
    const state = freshState();
    const stores = createMemoryStores({ clock: () => new Date('2026-10-26T12:00:00Z') });
    const connector = makeConnector(stores.data, state);

    const result = await connector.executePayment(paymentRequest('v1:act_test:abc'));
    expect(result.status).toBe('SUCCEEDED');
    if (result.status !== 'SUCCEEDED') return;
    expect(result.receipt.simulated).toBe(false);
    expect(result.receipt.externalReference).toMatch(/^wise_/);
    expect(result.receipt.amountMinor).toBe(25000);

    const paths = state.calls.map((c) => `${c.method} ${c.path}`);
    expect(paths).toEqual([
      'POST /v3/quotes',
      'POST /v1/transfers',
      'GET /v4/profiles/prof_1/balances',
      'POST /v4/profiles/prof_1/balances/7/transfer-execute',
      'GET /v1/transfers/16521632',
    ]);
    // The provider idempotency id is a UUID derived from OUR key.
    const transferBody = state.calls.find((c) => c.path === '/v1/transfers')?.body as {
      customerTransactionId: string;
      quoteUuid: string;
      targetAccount: number;
    };
    expect(transferBody.customerTransactionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(transferBody.quoteUuid).toBe('quote-uuid-1');
    expect(transferBody.targetAccount).toBe(8692237);

    // Ledger discipline: one entry, dispatch closed with the provider ref.
    const ledger = await stores.data.listLedger(TENANT);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.receipt.simulated).toBe(false);
    const dispatches = await stores.data.listDispatches(TENANT, 'v1:act_test:abc');
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.providerRef).toBe('16521632');
    expect(dispatches[0]?.outcome).toBe('SUCCEEDED');
  });

  it('returns the ORIGINAL receipt for a repeated idempotency key with no new provider calls', async () => {
    const state = freshState();
    const stores = createMemoryStores({ clock: () => new Date() });
    const connector = makeConnector(stores.data, state);

    const first = await connector.executePayment(paymentRequest('v1:act_test:abc'));
    expect(first.status).toBe('SUCCEEDED');
    const callsAfterFirst = state.calls.length;

    const second = await connector.executePayment(paymentRequest('v1:act_test:abc'));
    expect(second.status).toBe('SUCCEEDED');
    if (second.status !== 'SUCCEEDED' || first.status !== 'SUCCEEDED') return;
    expect(second.receipt.receiptHash).toBe(first.receipt.receiptHash);
    expect(state.calls.length).toBe(callsAfterFirst); // Nothing new left the process.
  });

  it('refuses to pay an unregistered beneficiary without touching the provider', async () => {
    const state = freshState();
    const stores = createMemoryStores({ clock: () => new Date() });
    const connector = makeConnector(stores.data, state);

    const result = await connector.executePayment({
      ...paymentRequest('v1:act_test:raw'),
      beneficiaryRef: 'BEN-017-VERIFIED',
    });
    expect(result).toEqual({ status: 'FAILED_TERMINAL', errorClass: 'RECIPIENT_NOT_REGISTERED' });
    expect(state.calls).toHaveLength(0);
  });

  it('fails terminally when the connected account cannot cover the transfer', async () => {
    const state = freshState();
    state.balances = [{ id: 7, currency: 'USD', value: 10 }];
    const stores = createMemoryStores({ clock: () => new Date() });
    const connector = makeConnector(stores.data, state);

    const result = await connector.executePayment(paymentRequest('v1:act_test:broke'));
    expect(result).toEqual({ status: 'FAILED_TERMINAL', errorClass: 'INSUFFICIENT_PROVIDER_BALANCE' });
    // The transfer object may exist at Wise, but no money moved and nothing
    // is recorded as an effect.
    expect(await stores.data.listLedger(TENANT)).toHaveLength(0);
    const dispatches = await stores.data.listDispatches(TENANT, 'v1:act_test:broke');
    expect(dispatches[0]?.outcome).toBe(null); // closed? no: still open — reconciliation's call.
  });

  it('reports an honest UNKNOWN when the transfer stays pending, then reconciles to sent', async () => {
    const state = freshState();
    state.transferStatus = 'processing';
    const stores = createMemoryStores({ clock: () => new Date() });
    const connector = makeConnector(stores.data, state);

    const result = await connector.executePayment(paymentRequest('v1:act_test:slow'));
    expect(result).toEqual({ status: 'TIMEOUT_AFTER_DISPATCH' });
    expect(await stores.data.listLedger(TENANT)).toHaveLength(0);

    // Later, the provider reports the truth. lookupByIdempotencyKey resolves
    // through the persisted provider ref — the exact path reconciliation uses.
    state.transferStatus = 'outgoing_payment_sent';
    const receipt: ConnectorReceipt | null = await connector.lookupByIdempotencyKey(TENANT, 'v1:act_test:slow');
    expect(receipt?.simulated).toBe(false);
    expect(receipt?.amountMinor).toBe(25000);
    const ledger = await stores.data.listLedger(TENANT);
    expect(ledger).toHaveLength(1);
    const dispatches = await stores.data.listDispatches(TENANT, 'v1:act_test:slow');
    expect(dispatches[0]?.outcome).toBe('SUCCEEDED');
  });

  it('stages a beneficiary change only after the provider confirms the recipient exists', async () => {
    const state = freshState();
    const stores = createMemoryStores({ clock: () => new Date('2026-10-26T12:00:00Z') });
    await stores.data.putVendor({
      vendorId: 'VEN-017',
      tenantId: TENANT,
      name: 'Live Example Ltd',
      status: 'VERIFIED',
      verifiedBeneficiaryRef: 'wise:recipient:111',
      verifiedAt: new Date('2026-01-15T00:00:00Z'),
      bankingChangedAt: null,
      bankingChangeVerifiedAt: null,
      pendingBeneficiaryRef: null,
      allowedDestinationRefs: ['wise:recipient:111'],
      accountAgeDays: 400,
      dataClassification: 'INTERNAL',
    });
    const connector = makeConnector(stores.data, state);

    const result = await connector.updateVendorBankDetails({
      tenantId: TENANT,
      connectorId: 'con_wise_live',
      idempotencyKey: 'v1:act_bank:abc',
      vendorId: 'VEN-017',
      newBeneficiaryRef: 'wise:recipient:8692237',
      verificationRef: null,
      actionId: 'act_bank',
      executionId: 'exe_bank',
      traceId: 'trc_bank',
    });
    expect(result.status).toBe('SUCCEEDED');
    if (result.status !== 'SUCCEEDED') return;
    expect(result.receipt.amountMinor).toBe(0); // Non-monetary effect.
    const vendor = await stores.data.getVendor(TENANT, 'VEN-017');
    expect(vendor?.pendingBeneficiaryRef).toBe('wise:recipient:8692237');
    expect(vendor?.bankingChangeVerifiedAt).toBe(null); // Staged, never self-activated.

    // A recipient the provider does not know is staged nowhere.
    state.recipientExists = false;
    const refused = await connector.updateVendorBankDetails({
      tenantId: TENANT,
      connectorId: 'con_wise_live',
      idempotencyKey: 'v1:act_bank:def',
      vendorId: 'VEN-017',
      newBeneficiaryRef: 'wise:recipient:999999',
      verificationRef: null,
      actionId: 'act_bank2',
      executionId: 'exe_bank2',
      traceId: 'trc_bank2',
    });
    expect(refused.status).toBe('FAILED_TERMINAL');
    const vendorAfter = await stores.data.getVendor(TENANT, 'VEN-017');
    expect(vendorAfter?.pendingBeneficiaryRef).toBe('wise:recipient:8692237'); // Unchanged.
  });

  it('fails closed when the OAuth grant is dead', async () => {
    const state = freshState();
    const stores = createMemoryStores({ clock: () => new Date() });
    const deadStore: TokenStore = {
      load: async () => null,
      save: async () => undefined,
    };
    const fetchImpl = makeFetch(state);
    const connector = new WiseFinanceConnector({
      connectorId: 'con_wise_live',
      connectedAccountId: 'cac_test',
      tokenManager: new WiseTokenManager({
        oauth: {
          clientId: 'client',
          clientSecret: 'secret',
          authorizeUrl: '',
          tokenUrl: 'https://wise.test/oauth/token',
          redirectUri: '',
          scopes: [],
        },
        tokenStore: deadStore,
        fetchImpl,
      }),
      wiseClient: new WiseClient({ baseUrl: 'https://wise.test', fetchImpl }),
      data: stores.data,
      profileResolver: async () => 'prof_1',
      pollAttempts: 1,
      pollIntervalMs: 1,
    });

    const result = await connector.executePayment(paymentRequest('v1:act_test:dead'));
    expect(result.status).toBe('FAILED_TERMINAL');
    if (result.status !== 'FAILED_TERMINAL') return;
    expect(result.errorClass).toBe('CONNECTED_ACCOUNT_TOKEN_INVALID');
    expect(state.calls).toHaveLength(0); // Nothing left the process unauthenticated.
  });

  it('classifies Wise statuses honestly', async () => {
    const { classifyTransferStatus } = await import('../src/wise-client.js');
    expect(classifyTransferStatus('outgoing_payment_sent')).toBe('SENT');
    expect(classifyTransferStatus('processing')).toBe('PENDING');
    expect(classifyTransferStatus('funds_converted')).toBe('PENDING');
    expect(classifyTransferStatus('something_new_from_wise')).toBe('PENDING');
    expect(classifyTransferStatus('cancelled')).toBe('FAILED');
    expect(classifyTransferStatus('bounce_back')).toBe('FAILED');
  });
});
