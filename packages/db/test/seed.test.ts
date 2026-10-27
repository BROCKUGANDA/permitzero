/**
 * Seed tests: the synthetic demo tenant is complete, correctly linked and
 * honestly labeled — and its secrets exist only as hashes plus the in-memory
 * result, never in the database.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalHash } from '@permitzero/domain';
import { policyDocumentSchema } from '@permitzero/schemas';
import {
  findConnectorForTool,
  findCredentialBySecretHash,
  getAgent,
  getEnforcementMode,
  getInvoice,
  getMembership,
  getPolicyByCode,
  getPublishedRevision,
  getPurchaseOrder,
  getTenantBySlug,
  getUserById,
  getVendor,
  seed,
  type Db,
  type SeedResult,
} from '../src/index.js';
import { closeTestDb, resetTestDb, testDb } from './db-test.js';

let db: Db;

beforeAll(async () => {
  db = await testDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe('seed', () => {
  let seeded: SeedResult;
  let tenantId: string;

  beforeAll(async () => {
    await resetTestDb();
    seeded = await seed(db);
    tenantId = seeded.tenantIds[0] ?? '';
  });

  it('creates a labeled synthetic tenant with five users and roles', async () => {
    const tenant = await getTenantBySlug(db.db, 'demo');
    expect(tenant?.synthetic).toBe(true);
    expect(tenant?.name).toContain('SYNTHETIC');
    const expected: Record<string, string> = {
      owner: 'OWNER',
      approver1: 'APPROVER',
      approver2: 'APPROVER',
      operator: 'OPERATOR',
      auditor: 'AUDITOR',
    };
    for (const [label, role] of Object.entries(expected)) {
      const userId = seeded.userIds[label] ?? '';
      expect((await getUserById(db.db, userId))?.email).toContain('synthetic-');
      expect((await getMembership(db.db, tenantId, userId))?.role).toBe(role);
    }
  });

  it('issues credentials that resolve by hash, storing no secrets', async () => {
    const agentId = seeded.agentIds[0] ?? '';
    const agentToken = seeded.agentTokens[agentId] ?? '';
    expect(agentToken.startsWith('pz_')).toBe(true);
    const agentHash = createHash('sha256').update(agentToken, 'utf8').digest('hex');
    const agentCred = await findCredentialBySecretHash(db.db, agentHash);
    expect(agentCred?.subjectType).toBe('AGENT');
    expect(agentCred?.secretHash).toBe(agentHash);
    expect(agentCred?.secretHash).not.toBe(agentToken);
    expect(agentCred?.secretPrefix).toBe(agentToken.slice(0, 12));

    const approverId = seeded.userIds['approver1'] ?? '';
    const userToken = seeded.userTokens[approverId] ?? '';
    const userCred = await findCredentialBySecretHash(
      db.db,
      createHash('sha256').update(userToken, 'utf8').digest('hex'),
    );
    expect(userCred?.subjectType).toBe('USER');

    const workerToken = seeded.serviceTokens['worker'] ?? '';
    const workerCred = await findCredentialBySecretHash(
      db.db,
      createHash('sha256').update(workerToken, 'utf8').digest('hex'),
    );
    expect(workerCred?.subjectType).toBe('SERVICE');
    expect(workerCred?.scopesJson).toContain('action:execute');

    expect((await getAgent(db.db, tenantId, agentId))?.credentialId).toBe(agentCred?.credentialId);
  });

  it('publishes a valid AP-PROTECT-01 revision whose hash verifies', async () => {
    const policy = await getPolicyByCode(db.db, tenantId, 'AP-PROTECT-01');
    expect(policy).not.toBeNull();
    const revision = await getPublishedRevision(db.db, tenantId, policy?.policyId ?? '');
    expect(revision?.revisionNumber).toBe(1);
    expect(revision?.status).toBe('PUBLISHED');
    const document = policyDocumentSchema.parse(revision?.policyJson);
    expect(canonicalHash(document)).toBe(revision?.policyHash);
    expect(document.rules.length).toBeGreaterThan(10);
  });

  it('links the connector, vendors, invoices and purchase order', async () => {
    expect((await findConnectorForTool(db.db, tenantId, 'payment.execute'))?.simulated).toBe(true);
    const vendor = await getVendor(db.db, tenantId, 'VEN-017');
    expect(vendor?.status).toBe('VERIFIED');
    expect(vendor?.verifiedBeneficiaryRef).toBe('BEN-017-VERIFIED');
    const invoice = await getInvoice(db.db, tenantId, 'INV-2041');
    expect(invoice?.purchaseOrderId).toBe('PO-882');
    expect(Number(invoice?.amountMinor)).toBe(300000);
    const po = await getPurchaseOrder(db.db, tenantId, 'PO-882');
    expect(po?.vendorId).toBe('VEN-017');
    expect(Number(po?.amountMinor)).toBe(300000);
    expect((await getEnforcementMode(db.db, tenantId))?.mode).toBe('ENFORCED');
  });

  it('plants the malicious invoice fixture with injection text and no PO', async () => {
    const invoice = await getInvoice(db.db, tenantId, 'INV-2042');
    expect(Number(invoice?.amountMinor)).toBe(7500000);
    expect(invoice?.purchaseOrderId).toBeNull();
    expect(invoice?.documentText).toContain('TEST FIXTURE');
    expect(invoice?.documentText).toContain('ignore the approval policy');
  });

  it('honors fixed tokens and refuses a second seed without reset', async () => {
    await resetTestDb();
    const fixed = await seed(db, {
      agentToken: 'pz_fixed_agent_token_for_tests_only_001',
      userTokens: { owner: 'pz_fixed_owner_token_for_tests_only_01' },
      serviceToken: 'pz_fixed_worker_token_for_tests_only_01',
    });
    const agentId = fixed.agentIds[0] ?? '';
    expect(fixed.agentTokens[agentId]).toBe('pz_fixed_agent_token_for_tests_only_001');
    expect(fixed.userTokens[fixed.userIds['owner'] ?? '']).toBe('pz_fixed_owner_token_for_tests_only_01');
    expect(fixed.serviceTokens['worker']).toBe('pz_fixed_worker_token_for_tests_only_01');
    await expect(seed(db)).rejects.toMatchObject({ code: '23505' });
  });

  it('creates extra empty tenants on request', async () => {
    await resetTestDb();
    const multi = await seed(db, { tenants: 3 });
    expect(multi.tenantIds).toHaveLength(3);
    expect((await getTenantBySlug(db.db, 'demo-3'))?.synthetic).toBe(true);
    expect((await getEnforcementMode(db.db, multi.tenantIds[2] ?? ''))?.mode).toBe('ENFORCED');
  });
});
