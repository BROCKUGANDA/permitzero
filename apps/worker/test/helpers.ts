/**
 * Worker test harness: per-worker PostgreSQL database, a fresh seed per
 * test, and builders that walk actions into the states the handlers and
 * sweeps consume. Queues are always fakes here; the BullMQ driver is
 * exercised by the live proof, not by unit tests.
 */
import type { Broker, PersistedExecution } from '@permitzero/broker';
import { HASH_VERSION, canonicalHash, newId } from '@permitzero/domain';
import {
  closeDb,
  createAction,
  createBroker,
  createDb,
  ensureDatabaseExists,
  findConnectorForTool,
  getAction,
  loadRootEnv,
  migrate,
  resetDb,
  seed,
  transitionAction,
  type Db,
  type DbStores,
  type SeedResult,
} from '@permitzero/db';
import type { WorkerConfig } from '../src/config.js';

// The root `.env` is loaded before the URLs are read.
//
// The harness used to read `process.env` alone, which worked on a developer
// machine — where `postgres://postgres@127.0.0.1` authenticates by trust — and
// failed in CI, where the service container has a real password and the URL
// without one is refused.
//
// CI writes DATABASE_URL_TEST into `.env` precisely because that is where
// every other command in this repository reads it from, via `loadRootEnv`.
// An explicit environment still wins: `loadRootEnv` never overwrites a value
// that is already set.
loadRootEnv();

const poolId = process.env['VITEST_POOL_ID'] ?? '1';
const workerId = process.env['VITEST_WORKER_ID'] ?? '1';
const BASE_URL = process.env['DATABASE_URL_TEST'] ?? 'postgres://postgres@127.0.0.1:5432/permitzero_test';

/**
 * The `worker` segment keeps this harness from colliding with the other two
 * that compute a name the same way (`packages/db/test/db-test.ts` and
 * `apps/api/test/helpers.ts`). Vitest's pool and worker ids are per process,
 * not per file, so without a namespace two suites in different packages that
 * landed on the same worker id shared one database and truncated each other's
 * rows mid-test.
 */
const DB_NAMESPACE = 'worker';

function workerUrl(): string {
  const url = new URL(BASE_URL);
  const baseName = url.pathname.replace(/^\//, '') || 'permitzero_test';
  url.pathname = `/${baseName}_${DB_NAMESPACE}_${poolId}_${workerId}`;
  return url.toString();
}

/**
 * Same worker database, reached as the restricted `pz_app` role. The worker's
 * sweeps and consumers run against this pool in production, so the tests follow
 * it: a pass that forgot its tenant context finds nothing and fails its own
 * assertion instead of silently scanning every tenant.
 */
function workerRuntimeUrl(): string {
  const url = new URL(workerUrl());
  url.username = 'pz_app';
  url.password = process.env['PZ_RLS_ROLE_PASSWORD'] ?? 'pz_app_dev';
  return url.toString();
}

let db: Db | null = null;

export async function testDb(): Promise<Db> {
  if (db) return db;
  const url = workerUrl();
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, '');
  if (!/test/i.test(name)) {
    throw new Error(`refusing to run worker tests against non-test database "${name}"`);
  }
  const auth = parsed.username ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@` : '';
  const admin = createDb(`${parsed.protocol}//${auth}${parsed.host}/postgres`, { max: 1 });
  try {
    await ensureDatabaseExists(admin, name);
  } finally {
    await closeDb(admin);
  }
  db = createDb(url, { max: 5 });
  await migrate(db);
  // One clean database per test file: a vitest worker slot is reused across
  // files and its database outlives the process, so a file must not inherit the
  // rows its predecessor left behind.
  await resetDb(db);
  return db;
}

export async function closeTestDb(): Promise<void> {
  if (db) {
    await closeDb(db);
    db = null;
  }
}

export interface WorkerFixture {
  db: Db;
  seeded: SeedResult;
  tenantId: string;
  agentId: string;
  revisionId: string;
  broker: Broker;
  stores: DbStores;
}

export function testWorkerConfig(): WorkerConfig {
  return {
    appEnv: 'test',
    databaseUrl: workerUrl(),
    databaseRuntimeUrl: workerRuntimeUrl(),
    runtimePoolMax: 5,
    shutdownGraceMs: 2_000,
    redisUrl: null,
    permitSigningKey: 'test-signing-key-0123456789abcdef',
    permitSigningKeyId: 'k-test',
    auditHmacKey: null,
    dispatchPollMs: 50,
    sweepIntervalMs: 60_000,
    dispatchBatchSize: 50,
    sweepBatchSize: 100,
    jobAttempts: 5,
    workerConcurrency: 5,
    reconcileGraceMs: 30_000,
  };
}

export async function freshWorker(): Promise<WorkerFixture> {
  const database = await testDb();
  await resetDb(database);
  const seeded = await seed(database);
  const tenantId = seeded.tenantIds[0] ?? '';
  const { broker, stores } = createBroker(database, {
    signingKey: 'test-signing-key-0123456789abcdef',
    signingKeyId: 'k-test',
  });
  return {
    db: database,
    seeded,
    tenantId,
    agentId: seeded.agentIds[0] ?? '',
    revisionId: seeded.policyRevisionIds[0] ?? '',
    broker,
    stores,
  };
}

const PAYMENT_ARGS = {
  invoice_id: 'INV-2041',
  vendor_id: 'VEN-017',
  amount_minor: 300000,
  currency: 'USD',
  beneficiary_ref: 'BEN-017-VERIFIED',
};

export async function walkTo(
  fixture: WorkerFixture,
  actionId: string,
  states: Array<
    | 'VALIDATING'
    | 'EVALUATING'
    | 'ALLOWED'
    | 'PERMIT_ISSUED'
    | 'EXECUTION_PENDING'
    | 'EXECUTING'
    | 'UNKNOWN_OUTCOME'
    | 'APPROVAL_REQUIRED'
  >,
  now = new Date(),
): Promise<void> {
  for (const to of states) {
    const current = await getAction(fixture.db.db, fixture.tenantId, actionId);
    const moved = await transitionAction(fixture.db.db, {
      tenantId: fixture.tenantId,
      actionId,
      to,
      expectedVersion: current?.version ?? 0,
      now,
      ...(to === 'ALLOWED' || to === 'APPROVAL_REQUIRED'
        ? {
            patch: {
              decision: to === 'ALLOWED' ? ('ALLOW' as const) : ('REQUIRE_APPROVAL' as const),
              decisionReasonCodes: ['WITHIN_LIMIT'],
              policyRevisionId: fixture.revisionId,
            },
          }
        : {}),
    });
    if (!moved.ok) throw new Error(`walk to ${to} failed: ${moved.reason} (${moved.detail})`);
  }
}

export async function makeAction(fixture: WorkerFixture, idempotencyKey: string): Promise<string> {
  const actionId = newId('action');
  await createAction(fixture.db.db, {
    actionId,
    tenantId: fixture.tenantId,
    agentId: fixture.agentId,
    runId: 'run_worker_tests',
    toolName: 'payment.execute',
    operation: 'execute',
    taskPurpose: 'Worker test payment',
    argumentsRedacted: { ...PAYMENT_ARGS },
    argumentsHash: canonicalHash(PAYMENT_ARGS),
    hashVersion: HASH_VERSION,
    evidenceRefs: [],
    idempotencyKey,
    requestedAt: new Date(),
    environment: 'DEMO',
    traceId: newId('trace'),
    createdByActorId: fixture.agentId,
    createdByActorType: 'AGENT',
  });
  return actionId;
}

/** An action holding a live permit, ready for broker.execute. */
export async function permitIssuedAction(
  fixture: WorkerFixture,
  key: string,
): Promise<{ actionId: string; token: string }> {
  const actionId = await makeAction(fixture, key);
  await walkTo(fixture, actionId, ['VALIDATING', 'EVALUATING', 'ALLOWED']);
  const action = await getAction(fixture.db.db, fixture.tenantId, actionId);
  const { permits } = createBroker(fixture.db, {
    signingKey: 'test-signing-key-0123456789abcdef',
    signingKeyId: 'k-test',
  });
  const fresh = await permits.issue({
    tenantId: fixture.tenantId,
    agentId: fixture.agentId,
    actionId,
    actionHash: action?.argumentsHash ?? '',
    policyRevisionId: fixture.revisionId,
    audienceTool: 'payment.execute',
    ttlSeconds: 300,
  });
  await walkTo(fixture, actionId, ['PERMIT_ISSUED']);
  return { actionId, token: fresh.token };
}

export async function connectorIdForTool(fixture: WorkerFixture, tool = 'payment.execute'): Promise<string> {
  const row = await findConnectorForTool(fixture.db.db, fixture.tenantId, tool);
  if (!row) throw new Error(`no connector claims ${tool}`);
  return row.connectorId;
}

export function executionRecord(
  fixture: WorkerFixture,
  actionId: string,
  connectorId: string,
  overrides: Partial<PersistedExecution> = {},
): PersistedExecution {
  const now = new Date();
  return {
    executionId: newId('execution'),
    tenantId: fixture.tenantId,
    actionId,
    connectorId,
    attemptNumber: 1,
    connectorIdempotencyKey: `pay:${actionId}:1`,
    state: 'UNKNOWN_OUTCOME',
    dispatchStartedAt: now,
    resultReceivedAt: null,
    externalReference: null,
    receiptHash: null,
    errorClass: null,
    retryAfterAt: null,
    permitId: null,
    permitNonceHash: null,
    actorId: fixture.agentId,
    traceId: newId('trace'),
    receipt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
