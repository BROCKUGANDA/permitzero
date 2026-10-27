/**
 * E2E database bootstrap, run through tsx (workspace packages ship TS
 * source). Recreates permitzero_e2e from scratch: migrate, reset, seed,
 * plus the purchase orders and invoices the approval specs need.
 * Credentials land in test-results/e2e-auth.json (gitignored) only.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import {
  closeDb,
  createDb,
  ensureDatabaseExists,
  insertInvoice,
  insertPurchaseOrder,
  migrate,
  resetDb,
  seed,
} from '@permitzero/db';

const DATABASE_URL = process.env['E2E_DATABASE_URL'] ?? 'postgres://postgres@127.0.0.1:5432/permitzero_e2e';

if (!/e2e|test/i.test(new URL(DATABASE_URL).pathname)) {
  throw new Error(`refusing to seed e2e fixtures into non-test database ${DATABASE_URL}`);
}

async function main(): Promise<void> {
  const parsed = new URL(DATABASE_URL);
  const name = parsed.pathname.replace(/^\//, '');
  parsed.pathname = '/postgres';
  const admin = createDb(parsed.toString(), { max: 1 });
  try {
    await ensureDatabaseExists(admin, name);
  } finally {
    await closeDb(admin);
  }

  const db = createDb(DATABASE_URL, { max: 5 });
  try {
    await migrate(db);
    await resetDb(db);
    const seeded = await seed(db);
    const tenantId = seeded.tenantIds[0] ?? '';
    if (!tenantId) throw new Error('seed produced no tenant');

    // $30,000 PO-backed invoices: deterministic REQUIRE_APPROVAL territory
    // (one per approval spec so runs never share an action).
    for (const n of [1, 2]) {
      await insertPurchaseOrder(db.db, {
        purchaseOrderId: `PO-E2E-${n}`,
        tenantId,
        vendorId: 'VEN-017',
        amountMinor: 3000000n,
        currency: 'USD',
      });
      await insertInvoice(db.db, {
        invoiceId: `INV-E2E-${n}`,
        tenantId,
        vendorId: 'VEN-017',
        amountMinor: 3000000n,
        currency: 'USD',
        purchaseOrderId: `PO-E2E-${n}`,
      });
    }

    const agentId = seeded.agentIds[0] ?? '';
    const tokenFor = (label: string): string => seeded.userTokens[seeded.userIds[label] ?? ''] ?? '';
    const auth = {
      tenantId,
      agentId,
      agentToken: seeded.agentTokens[agentId] ?? '',
      ownerToken: tokenFor('owner'),
      approver1Token: tokenFor('approver1'),
      approver2Token: tokenFor('approver2'),
      operatorToken: tokenFor('operator'),
      auditorToken: tokenFor('auditor'),
    };
    for (const [key, value] of Object.entries(auth)) {
      if (!value) throw new Error(`seed produced no ${key}`);
    }
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/e2e-auth.json', `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
    console.log(`[e2e] seeded ${name} with tenant ${tenantId}`);
  } finally {
    await closeDb(db);
  }
}

await main();
