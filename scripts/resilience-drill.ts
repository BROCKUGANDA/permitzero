#!/usr/bin/env tsx
/**
 * Resilience drill — a re-runnable outage drill that leaves evidence.
 *
 * Why a script and not only the test suite: the tests prove the behaviour, but
 * someone asking "what happens when the database dies?" wants a dated artefact
 * saying what actually happened on this build. This runs the scenarios for real,
 * in-process, against a PostgreSQL it migrates itself, and writes
 * `storage/resilience-drill.json`.
 *
 * It drives a real Fastify over a real socket rather than `app.inject()`, because
 * the properties under test — a status code a load balancer acts on, work that is
 * or is not committed — are socket and transaction properties.
 *
 * The outage is produced by pointing a second instance at a port where nothing
 * listens, NOT by stopping the shared PostgreSQL: that server hosts other
 * projects on this machine, and stopping it would be an outage someone else
 * discovers. The same substitute is not possible for the queue without a broker,
 * so the queue scenario asserts what a dead broker actually costs — nothing on
 * the decision path — using the retained outbox as the evidence.
 *
 * Exit code is non-zero if any expectation fails, so this can be a gate. A
 * scenario that could not be set up is recorded as a failure, never a pass.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claimOutboxEvents,
  closeDb,
  createDb,
  createRevision,
  ensureDatabaseExists,
  loadRootEnv,
  migrate,
  publishRevision,
  resetDb,
  rlsEnforcementState,
  seed,
  type Db,
} from '@permitzero/db';
import { canonicalHash, newId } from '@permitzero/domain';
import { ruleReferencesModel } from '@permitzero/policy';
import { MetaProviderClient } from '@permitzero/provider-meta';
import type { MetaProviderConfig } from '@permitzero/provider-meta';
import type { PolicyDocument } from '@permitzero/schemas';
import { buildApp } from '../apps/api/src/app.js';
import { breakerStateValue, createModelAdapter } from '../apps/api/src/model.js';
import { loadConfig } from '../apps/api/src/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

loadRootEnv();

interface DrillResult {
  scenario: string;
  expectation: string;
  ok: boolean;
  detail: unknown;
}

const results: DrillResult[] = [];
let failures = 0;

function record(scenario: string, expectation: string, ok: boolean, detail: unknown = {}): void {
  results.push({ scenario, expectation, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${scenario} — ${expectation}  ${JSON.stringify(detail)}`);
}

/** The invoice the shipped demo policy allows at $3,000. */
const ALLOWED_ARGS = {
  invoice_id: 'INV-2041',
  vendor_id: 'VEN-017',
  amount_minor: 300000,
  currency: 'USD',
  beneficiary_ref: 'BEN-017-VERIFIED',
};

interface SubmitOutcome {
  status: number;
  body: unknown;
  error?: string;
}

async function submit(baseUrl: string, token: string, agentId: string, runId: string): Promise<SubmitOutcome> {
  try {
    const res = await fetch(`${baseUrl}/v1/actions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        // undici keeps sockets alive; without this the instance's close() waits
        // on idle connections long after every request has been answered.
        connection: 'close',
      },
      body: JSON.stringify({
        agent_id: agentId,
        run_id: runId,
        task_purpose: 'Pay a verified invoice',
        tool_name: 'payment.execute',
        arguments: ALLOWED_ARGS,
        evidence_refs: [],
        idempotency_key: `drill-${runId}-${Date.now()}`,
        environment: 'DEMO',
      }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (err) {
    return { status: 0, body: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { headers: { connection: 'close' } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function main(): Promise<void> {
  const envConfig = loadConfig();
  const testUrl = process.env.DATABASE_URL_TEST ?? 'postgres://postgres@127.0.0.1:5432/permitzero_test';
  const parsed = new URL(testUrl);
  const credentials = `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}`;
  const dbName = `permitzero_drill_${Date.now().toString(36)}`;

  const adminConn = createDb(`${parsed.protocol}//${credentials}@${parsed.host}/postgres`, { max: 1 });
  await ensureDatabaseExists(adminConn, dbName);
  await closeDb(adminConn);

  const dbUrl = `${parsed.protocol}//${credentials}@${parsed.host}/${dbName}`;
  const runtimeUrl = `${parsed.protocol}//pz_app:${process.env.PZ_RLS_ROLE_PASSWORD ?? 'pz_app_dev'}@${parsed.host}/${dbName}`;

  const admin: Db = createDb(dbUrl, { max: 5 });
  await migrate(admin);
  await resetDb(admin);
  const seeded = await seed(admin, { tenants: 1 });
  const agentId = seeded.agentIds[0] ?? '';
  const agentToken = seeded.agentTokens[agentId] ?? '';

  console.log(`drill database ${dbName}; seeded tenant ${seeded.tenantIds[0] ?? '(none)'}\n`);

  // ---------------------------------------------------------------------
  // 1. Baseline. Without it, every outage result below would be
  //    indistinguishable from a build that never worked.
  // ---------------------------------------------------------------------
  const runtime = createDb(runtimeUrl, { max: 5 });
  const isolation = await rlsEnforcementState(runtime);
  record('baseline', 'runtime pool is bound by row-level security', isolation.enforced, {
    role: isolation.role,
    tables: `${isolation.tablesEnforced}/${isolation.tablesTotal}`,
  });

  const healthy = await buildApp({
    db: admin,
    dbRuntime: runtime,
    config: envConfig,
    model: createModelAdapter('disabled'),
  });
  const healthyUrl = await healthy.app.listen({ port: 0, host: '127.0.0.1' });

  const ready = await getJson(`${healthyUrl}/health/ready`);
  record('baseline', 'readiness answers 200 when the platform is healthy', ready.status === 200, {
    status: ready.status,
  });

  const paid = await submit(healthyUrl, agentToken, agentId, 'drill-baseline');
  record('baseline', 'an authorized payment is accepted', paid.status === 201, { status: paid.status });

  // ---------------------------------------------------------------------
  // 2. Database unreachable.
  // ---------------------------------------------------------------------
  const deadUrl = 'postgres://postgres@127.0.0.1:5499/permitzero_down';
  const deadAdmin = createDb(deadUrl, { max: 2 });
  const deadRuntime = createDb(deadUrl, { max: 2 });
  const broken = await buildApp({
    db: deadAdmin,
    dbRuntime: deadRuntime,
    config: { ...envConfig, databaseUrl: deadUrl, databaseRuntimeUrl: deadUrl },
    model: createModelAdapter('disabled'),
  });
  const brokenUrl = await broken.app.listen({ port: 0, host: '127.0.0.1' });

  const brokenReady = await getJson(`${brokenUrl}/health/ready`);
  record('database unreachable', 'readiness answers 503 so a load balancer can act on it', brokenReady.status === 503, {
    status: brokenReady.status,
  });

  const brokenLive = await getJson(`${brokenUrl}/health/live`);
  record(
    'database unreachable',
    'liveness stays green so the process is not killed over a dependency',
    brokenLive.status === 200,
    { status: brokenLive.status },
  );

  const brokenSubmit = await submit(brokenUrl, agentToken, agentId, 'drill-outage');
  record('database unreachable', 'a decision request answers 503, never 500', brokenSubmit.status === 503, {
    status: brokenSubmit.status,
    retryable: (brokenSubmit.body as { error?: { retryable?: boolean } } | null)?.error?.retryable,
  });
  record(
    'database unreachable',
    'the response leaks no driver detail, host or stack frame',
    !JSON.stringify(brokenSubmit.body ?? '').match(/ECONNREFUSED|5499|permitzero_down|at .*\.js:/),
    {},
  );

  const orphaned = await admin.sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM actions WHERE run_id = 'drill-outage'`;
  record('database unreachable', 'the failed request left no half-written action', orphaned[0]?.n === '0', {
    rows: orphaned[0]?.n,
  });

  await broken.app.close();
  await closeDb(deadAdmin).catch(() => undefined);
  await closeDb(deadRuntime).catch(() => undefined);

  // ---------------------------------------------------------------------
  // 3. Delivery owed while the decision path still has to work. A decision
  //    reached with the event retained is what makes a broker outage a delivery
  //    delay rather than an authorization loss.
  // ---------------------------------------------------------------------
  const beforePending = await admin.sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM outbox_events WHERE status IN ('PENDING','FAILED')`;
  const afterDecision = await submit(healthyUrl, agentToken, agentId, 'drill-queue-down');
  const afterPending = await admin.sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM outbox_events WHERE status IN ('PENDING','FAILED')`;
  record('delivery delayed', 'a decision is still reached and recorded', afterDecision.status === 201, {
    status: afterDecision.status,
  });
  record(
    'delivery delayed',
    'the owed event is retained for a later attempt, not dropped',
    Number(afterPending[0]?.n ?? 0) >= Number(beforePending[0]?.n ?? 0) && Number(afterPending[0]?.n ?? 0) > 0,
    { before: beforePending[0]?.n, after: afterPending[0]?.n },
  );

  // ---------------------------------------------------------------------
  // 4. Publisher crash. Claim, then never publish: the row must be re-claimable
  //    once its lease expires, and must not be handed out inside the window.
  // ---------------------------------------------------------------------
  const claimNow = new Date();
  const claimedRows = await claimOutboxEvents(admin.db, 5, claimNow);
  const insideLease = await claimOutboxEvents(admin.db, 5, new Date(claimNow.getTime() + 30_000));
  const afterLease = await claimOutboxEvents(admin.db, 5, new Date(claimNow.getTime() + 120_000));
  record(
    'publisher crash',
    'a claimed row is not handed to a second worker inside its lease',
    claimedRows.length > 0 && insideLease.length === 0,
    { claimed: claimedRows.length, requeuedInsideLease: insideLease.length },
  );
  record(
    'publisher crash',
    'the row becomes claimable again after the lease expires',
    afterLease.length === claimedRows.length,
    {
      reclaimedAfterLease: afterLease.length,
    },
  );
  const publishedAnyway = await admin.sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM outbox_events WHERE status = 'PUBLISHED'`;
  record('publisher crash', 'nothing was marked published that was never published', publishedAnyway[0]?.n === '0', {
    published: publishedAnyway[0]?.n,
  });

  // ---------------------------------------------------------------------
  // 5. Recovery. A 503 marked retryable is a promise; this is where it is kept.
  // ---------------------------------------------------------------------
  const retry = await submit(healthyUrl, agentToken, agentId, 'drill-recovery');
  record('recovery', 'the same request shape that failed during the outage now succeeds', retry.status === 201, {
    status: retry.status,
  });

  await healthy.app.close();

  // ---------------------------------------------------------------------
  // 6. The model provider is down.
  //
  //    The database outage above is a dependency the decision path CANNOT
  //    work without: losing it has to stop the decision. The provider is the
  //    other kind — one the policy MAY read, and which must never be able to
  //    turn a missing signal into an allow.
  //
  //    Two provider outages are exercised, because they fail differently:
  //
  //    · a port where nothing listens — the call fails immediately with a
  //      transport error;
  //    · a socket that ACCEPTS the connection and then never answers — the
  //      call has to be cut off by the timeout, and the point of the
  //      assertion is that the request comes back anyway. A provider that
  //      hangs is worse than a provider that is down: the first breaks the
  //      decision, the second holds a request open until something else
  //      gives.
  //
  //    Nothing here touches a shared service. The dead port is a port
  //    nothing listens on, and the hanging socket is one this script opens
  //    and closes itself.
  // ---------------------------------------------------------------------

  // A provider pointed at a port where nothing listens.
  const DEAD_PORT = 5498;
  const deadProviderConfig: MetaProviderConfig = {
    apiKey: 'drill-not-a-real-key',
    baseUrl: `http://127.0.0.1:${DEAD_PORT}/v1`,
    modelId: 'drill-model',
    timeoutMs: 2_000,
    // One attempt: the retry budget is the provider's business, and a drill
    // that waits out five backoffs is a drill nobody runs.
    maxAttempts: 1,
    maxConcurrency: 1,
    retryBaseMs: 50,
    retryCapMs: 100,
    promptVersion: 'risk-hints-prompt-v1',
    // Open the breaker on the first failure, so "the breaker opened" is
    // observable in one request rather than after a threshold nobody can
    // wait for.
    breakerThreshold: 1,
    breakerCooldownMs: 60_000,
  };
  const deadProvider = new MetaProviderClient(deadProviderConfig);
  const deadModel = createModelAdapter('meta', { meta: deadProvider });

  const providerDown = await buildApp({
    db: admin,
    dbRuntime: runtime,
    config: envConfig,
    model: deadModel,
  });
  const providerDownUrl = await providerDown.app.listen({ port: 0, host: '127.0.0.1' });

  // The seeded policy READS the model (an advisory escalation rule), so this
  // decision needs a signal it cannot get.
  const downStarted = Date.now();
  const degraded = await submit(providerDownUrl, agentToken, agentId, 'drill-provider-down');
  const downElapsed = Date.now() - downStarted;
  const degradedDecision = (degraded.body as { decision?: string } | null)?.decision ?? null;

  record(
    'provider unreachable',
    'a decision whose policy reads the model does not ALLOW without the signal',
    degraded.status === 201 && degradedDecision !== 'ALLOW',
    { status: degraded.status, decision: degradedDecision },
  );
  record(
    'provider unreachable',
    'it escalates to a human instead',
    degraded.status === 201 && degradedDecision === 'REQUIRE_APPROVAL',
    { status: degraded.status, decision: degradedDecision },
  );
  record(
    'provider unreachable',
    'the request does not hang past the provider timeout',
    downElapsed < deadProviderConfig.timeoutMs + 2_000,
    { elapsed_ms: downElapsed, timeout_ms: deadProviderConfig.timeoutMs },
  );

  const breaker = deadModel.status();
  record('provider unreachable', 'the provider circuit breaker opens', breaker.breaker === 'OPEN', {
    breaker: breaker.breaker,
    provider_status: breaker.status,
  });
  record(
    'provider unreachable',
    'the breaker is observable as the gauge the alert rule reads',
    breakerStateValue(breaker.breaker) === 2,
    { gauge: breakerStateValue(breaker.breaker) },
  );

  // A policy that does not consult the model at all. The deterministic path
  // must not depend on a provider that is down: a decision that never
  // needed the signal must still be reached.
  const tenantId = seeded.tenantIds[0] ?? '';
  const published = await admin.sql<{ revision_id: string; policy_id: string; policy_json: unknown }[]>`
    SELECT revision_id, policy_id, policy_json
      FROM policy_revisions
     WHERE tenant_id = ${tenantId}
       AND status = 'PUBLISHED'
     ORDER BY revision_number DESC
     LIMIT 1
  `;
  const currentHead = published[0];
  let modelFreeRevisionId: string | null = null;
  if (currentHead) {
    const document = currentHead.policy_json as PolicyDocument;
    const modelFree: PolicyDocument = {
      ...document,
      rules: document.rules.filter((rule) => !ruleReferencesModel(rule.when)),
    };
    modelFreeRevisionId = await admin.db.transaction(async (tx) => {
      const revision = await createRevision(tx, {
        id: newId('policyRevision'),
        tenantId,
        policyId: currentHead.policy_id,
        document: modelFree,
        policyHash: canonicalHash(modelFree),
        changeReason: 'drill: a revision whose rules do not consult the model',
      });
      await publishRevision(tx, {
        tenantId,
        policyId: currentHead.policy_id,
        revisionId: revision.revisionId,
        expectedCurrentRevisionId: currentHead.revision_id,
      });
      return revision.revisionId;
    });

    const deterministic = await submit(providerDownUrl, agentToken, agentId, 'drill-provider-deterministic');
    const deterministicDecision = (deterministic.body as { decision?: string } | null)?.decision ?? null;
    record(
      'provider unreachable',
      'a policy that never reads the model still decides on the deterministic path',
      deterministic.status === 201 && deterministicDecision === 'ALLOW',
      { status: deterministic.status, decision: deterministicDecision, revision: modelFreeRevisionId },
    );
    record(
      'provider unreachable',
      'the breaker is still open — the decision did not need the provider',
      deadModel.status().breaker === 'OPEN',
      { breaker: deadModel.status().breaker },
    );
  }

  await providerDown.app.close();

  // A provider that ACCEPTS the connection and never answers.
  //
  // The sockets are tracked and destroyed explicitly: a server with an open
  // connection keeps the drill's process alive after the assertions are done,
  // and a drill that hangs at the end is a drill that gets killed and
  // reported as a failure.
  const openSockets = new Set<net.Socket>();
  const blackhole = net.createServer((socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
    // Deliberately no response, ever.
  });
  await new Promise<void>((resolve) => blackhole.listen(0, '127.0.0.1', () => resolve()));
  const blackholePort = (blackhole.address() as net.AddressInfo).port;

  const hangingProviderConfig: MetaProviderConfig = {
    ...deadProviderConfig,
    baseUrl: `http://127.0.0.1:${blackholePort}/v1`,
    timeoutMs: 1_500,
  };
  const hangingProvider = new MetaProviderClient(hangingProviderConfig);
  const hangingModel = createModelAdapter('meta', { meta: hangingProvider });
  const providerHanging = await buildApp({
    db: admin,
    dbRuntime: runtime,
    config: envConfig,
    model: hangingModel,
  });
  const providerHangingUrl = await providerHanging.app.listen({ port: 0, host: '127.0.0.1' });

  const hangStarted = Date.now();
  const hung = await submit(providerHangingUrl, agentToken, agentId, 'drill-provider-hanging');
  const hangElapsed = Date.now() - hangStarted;
  const hungDecision = (hung.body as { decision?: string } | null)?.decision ?? null;

  record(
    'provider hanging',
    'the decision comes back instead of waiting for the provider forever',
    hung.status === 201,
    { status: hung.status, decision: hungDecision },
  );
  record(
    'provider hanging',
    'the request is bounded by the provider timeout',
    hangElapsed < hangingProviderConfig.timeoutMs + 3_000,
    { elapsed_ms: hangElapsed, timeout_ms: hangingProviderConfig.timeoutMs },
  );
  record('provider hanging', 'the breaker opens on a timeout as well', hangingModel.status().breaker === 'OPEN', {
    breaker: hangingModel.status().breaker,
  });

  await providerHanging.app.close();
  for (const socket of openSockets) socket.destroy();
  await new Promise<void>((resolve) => blackhole.close(() => resolve()));

  // The model-free revision is published above to prove the deterministic
  // path; the seeded policy is what a real tenant runs, so the drill ends
  // with the model-requiring revision back in place.
  if (currentHead && modelFreeRevisionId) {
    await admin.db.transaction(async (tx) => {
      const revision = await createRevision(tx, {
        id: newId('policyRevision'),
        tenantId,
        policyId: currentHead.policy_id,
        document: currentHead.policy_json as PolicyDocument,
        policyHash: canonicalHash(currentHead.policy_json as PolicyDocument),
        changeReason: 'drill: back to the model-reading revision',
      });
      await publishRevision(tx, {
        tenantId,
        policyId: currentHead.policy_id,
        revisionId: revision.revisionId,
        expectedCurrentRevisionId: modelFreeRevisionId,
      });
    });
  }

  await closeDb(runtime);
  await closeDb(admin);

  // The drill makes a database per run so it never disturbs the demo or the test
  // schema, and drops it afterwards so repeated runs do not litter the cluster.
  // `IF EXISTS ... WITH (FORCE)` because a connection left in the pool would
  // otherwise hold the drop off until it timed out.
  const janitor = createDb(`${parsed.protocol}//${credentials}@${parsed.host}/postgres`, { max: 1 });
  await janitor.sql.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await closeDb(janitor);

  const outDir = path.join(root, 'storage');
  await mkdir(outDir, { recursive: true });
  const evidence = {
    ran_at: new Date().toISOString(),
    drill_database: dbName,
    node: process.version,
    checks: results.length,
    failures,
    results,
  };
  const outFile = path.join(outDir, 'resilience-drill.json');
  await writeFile(outFile, JSON.stringify(evidence, null, 2), 'utf8');
  console.log(
    `\n${failures === 0 ? 'DRILL PASSED' : `DRILL FAILED (${failures} of ${results.length})`} — evidence: ${path.relative(root, outFile)}`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error('drill crashed:', err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
