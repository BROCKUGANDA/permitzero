/**
 * API test harness: per-worker PostgreSQL database (same isolation scheme as
 * @permitzero/db tests), a fresh seed per test and an injected Fastify app.
 * No Redis, no network — the queue and model provider run in their honest
 * disabled/static modes.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { newId } from '@permitzero/domain';
import {
  closeDb,
  createAgent,
  createCredential,
  createDb,
  createMembership,
  createUser,
  ensureDatabaseExists,
  migrate,
  resetDb,
  seed,
  type Db,
  type SeedResult,
} from '@permitzero/db';
import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { createModelAdapter } from '../src/model.js';

const poolId = process.env['VITEST_POOL_ID'] ?? '1';
const workerId = process.env['VITEST_WORKER_ID'] ?? '1';
const BASE_URL = process.env['DATABASE_URL_TEST'] ?? 'postgres://postgres@127.0.0.1:5432/permitzero_test';

function workerUrl(): string {
  const url = new URL(BASE_URL);
  const baseName = url.pathname.replace(/^\//, '') || 'permitzero_test';
  url.pathname = `/${baseName}_${poolId}_${workerId}`;
  return url.toString();
}

/**
 * The same worker database, reached as the restricted `pz_app` role. This is what
 * makes the whole API suite an RLS test: every route reads and writes through it,
 * so a handler that loses its tenant context does not leak — it finds nothing,
 * and the assertion that expects to find something fails.
 */
function workerRuntimeUrl(): string {
  const url = new URL(workerUrl());
  url.username = 'pz_app';
  url.password = process.env['PZ_RLS_ROLE_PASSWORD'] ?? 'pz_app_dev';
  return url.toString();
}

let db: Db | null = null;
let runtimeDb: Db | null = null;

export async function testDb(): Promise<Db> {
  if (db) return db;
  const url = workerUrl();
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, '');
  if (!/test/i.test(name)) {
    throw new Error(`refusing to run api tests against non-test database "${name}"`);
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

/** The `pz_app` pool, after `testDb()` has created and migrated the database. */
export async function testRuntimeDb(): Promise<Db> {
  if (runtimeDb) return runtimeDb;
  await testDb();
  runtimeDb = createDb(workerRuntimeUrl(), { max: 5 });
  return runtimeDb;
}

export async function closeTestDb(): Promise<void> {
  if (db) {
    await closeDb(db);
    db = null;
  }
  if (runtimeDb) {
    await closeDb(runtimeDb);
    runtimeDb = null;
  }
}

export interface ApiFixture {
  app: FastifyInstance;
  /** Management pool (table owner, exempt from row-level security). Setup and assertions only. */
  db: Db;
  /** The `pz_app` pool the routes actually use. Proving isolation needs this one. */
  runtime: Db;
  seeded: SeedResult;
  tenantId: string;
  agentId: string;
  agentToken: string;
  ownerToken: string;
  approver1Token: string;
  approver2Token: string;
  operatorToken: string;
  auditorToken: string;
  serviceToken: string;
}

export function testConfig(): ApiConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    appEnv: 'test',
    version: '0.1.0-test',
    databaseUrl: workerUrl(),
    databaseRuntimeUrl: workerRuntimeUrl(),
    runtimePoolMax: 5,
    redisUrl: null,
    permitSigningKey: 'test-signing-key-0123456789abcdef',
    permitSigningKeyId: 'k-test',
    permitTtlSeconds: 300,
    modelProvider: 'disabled',
    auditHmacKey: null,
    rateLimitMax: 100000,
    rateLimitWindowMs: 60_000,
    maxBodyBytes: 1_048_576,
    // Set so the /metrics route exists under test: an endpoint that is only ever
    // exercised when someone remembers to configure it is an endpoint that is broken.
    metricsToken: 'test-metrics-token',
    // Short, so a test that shuts an app down does not wait on the
    // production grace window.
    shutdownGraceMs: 2_000,
  };
}

export async function freshApp(opts?: {
  model?: 'disabled' | 'static';
  adapter?: Parameters<typeof buildApp>[0]['model'];
}): Promise<ApiFixture> {
  const database = await testDb();
  const runtime = await testRuntimeDb();
  await resetDb(database);
  const seeded = await seed(database);
  const tenantId = seeded.tenantIds[0] ?? '';
  const agentId = seeded.agentIds[0] ?? '';
  const tokenFor = (label: string): string => seeded.userTokens[seeded.userIds[label] ?? ''] ?? '';
  const config = { ...testConfig(), modelProvider: opts?.model ?? 'disabled' };
  const model = opts?.adapter ?? createModelAdapter(config.modelProvider);
  const { app } = await buildApp({ db: database, dbRuntime: runtime, config, model });
  return {
    app,
    db: database,
    runtime,
    seeded,
    tenantId,
    agentId,
    agentToken: seeded.agentTokens[agentId] ?? '',
    ownerToken: tokenFor('owner'),
    approver1Token: tokenFor('approver1'),
    approver2Token: tokenFor('approver2'),
    operatorToken: tokenFor('operator'),
    auditorToken: tokenFor('auditor'),
    serviceToken: seeded.serviceTokens['worker'] ?? '',
  };
}

export async function closeApp(fixture: ApiFixture): Promise<void> {
  await fixture.app.close();
}

export function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

let keyCounter = 0;
export function uniqueKey(prefix = 'key'): string {
  keyCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${keyCounter}-${randomBytes(4).toString('hex')}`;
}

export function paymentArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    invoice_id: 'INV-2041',
    vendor_id: 'VEN-017',
    amount_minor: 300000,
    currency: 'USD',
    beneficiary_ref: 'BEN-017-VERIFIED',
    ...overrides,
  };
}

export function intakeBody(agentId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { arguments: args, ...rest } = overrides;
  return {
    agent_id: agentId,
    run_id: 'run_e2e_1',
    task_purpose: 'Pay a verified invoice',
    tool_name: 'payment.execute',
    arguments: (args as Record<string, unknown> | undefined) ?? paymentArgs(),
    evidence_refs: [],
    idempotency_key: uniqueKey('intake'),
    environment: 'DEMO',
    ...rest,
  };
}

function sha256hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** A second agent with its own credential, for ownership and scope tests. */
export async function makeAgent(
  database: Db,
  tenantId: string,
  opts: { name: string; allowedTools?: Array<{ toolName: string; operations: string[] }> },
): Promise<{ agentId: string; token: string }> {
  const token = `pz_${randomBytes(24).toString('base64url')}`;
  const credentialId = newId('credential');
  const agentId = newId('agent');
  await createCredential(database.db, {
    id: credentialId,
    tenantId,
    name: `agent-${opts.name}`,
    subjectType: 'AGENT',
    subjectId: agentId,
    credentialRef: `secret://test/${tenantId}/${opts.name}`,
    secretHash: sha256hex(token),
    secretPrefix: token.slice(0, 12),
    scopes: [],
  });
  await createAgent(database.db, {
    agentId,
    tenantId,
    name: opts.name,
    framework: 'test-harness',
    environment: 'DEMO',
    credentialId,
    allowedTools: opts.allowedTools ?? [{ toolName: 'payment.execute', operations: ['execute'] }],
  });
  return { agentId, token };
}

/** A user with a tenant membership, for role tests. */
export async function makeUser(
  database: Db,
  tenantId: string,
  opts: { label: string; role: 'OWNER' | 'APPROVER' | 'OPERATOR' | 'AUDITOR' },
): Promise<{ userId: string; token: string }> {
  const token = `pz_${randomBytes(24).toString('base64url')}`;
  const user = await createUser(database.db, {
    id: newId('user'),
    email: `test-${opts.label}@example.invalid`,
    displayName: `Test ${opts.label}`,
  });
  await createMembership(database.db, { id: newId('membership'), tenantId, userId: user.id, role: opts.role });
  await createCredential(database.db, {
    id: newId('credential'),
    tenantId,
    name: `user-${opts.label}`,
    subjectType: 'USER',
    subjectId: user.id,
    credentialRef: `secret://test/${tenantId}/${opts.label}`,
    secretHash: sha256hex(token),
    secretPrefix: token.slice(0, 12),
    scopes: [],
  });
  return { userId: user.id, token };
}

export async function postJson(
  fixture: ApiFixture,
  url: string,
  token: string | null,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fixture.app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...(token ? auth(token) : {}) },
    payload: JSON.stringify(body),
  });
  return { status: res.statusCode, json: res.json() as unknown };
}

export async function getJson(
  fixture: ApiFixture,
  url: string,
  token: string | null,
): Promise<{ status: number; json: unknown }> {
  const res = await fixture.app.inject({
    method: 'GET',
    url,
    headers: { ...(token ? auth(token) : {}) },
  });
  return { status: res.statusCode, json: res.json() as unknown };
}
