/**
 * Demo scenario: walks the full loop against a running API to prove the
 * deployment works end to end — a payment that sails through, one that needs
 * a human, and a bank-detail change under dual control.
 *
 * Prerequisites: the API is listening and the database was seeded
 * (`npm run db:seed`, which writes storage/demo-credentials.json).
 * Reads API_URL (default http://127.0.0.1:3000). Exits non-zero on the first
 * unexpected response. Tokens are read from disk, never printed.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const API_URL = process.env['API_URL'] ?? 'http://127.0.0.1:3000';

interface DemoCredentials {
  tenantIds: string[];
  userIds: Record<string, string>;
  agentIds: string[];
  agentTokens: Record<string, string>;
  userTokens: Record<string, string>;
  serviceTokens: Record<string, string>;
}

let failures = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ok — ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL — ${name}${detail ? `: ${detail}` : ''}`);
  }
}

async function call(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as unknown;
  return { status: res.status, json };
}

function field(json: unknown, name: string): unknown {
  return (json as Record<string, unknown>)[name];
}

async function main(): Promise<void> {
  const credsPath = fileURLToPath(new URL('../../../storage/demo-credentials.json', import.meta.url));
  const creds = JSON.parse(await readFile(credsPath, 'utf8')) as DemoCredentials;
  const agentId = creds.agentIds[0] ?? '';
  const agentToken = creds.agentTokens[agentId] ?? '';
  const approver1 = creds.userTokens[creds.userIds['approver1'] ?? ''] ?? '';
  const approver2 = creds.userTokens[creds.userIds['approver2'] ?? ''] ?? '';
  const owner = creds.userTokens[creds.userIds['owner'] ?? ''] ?? '';
  if (!agentToken || !approver1 || !approver2 || !owner) {
    console.error('demo credentials are incomplete; re-run npm run db:seed first.');
    process.exit(2);
  }
  const stamp = Date.now().toString(36);

  console.log(`Demo against ${API_URL}\n`);

  console.log('1. Service health');
  const live = await call('GET', '/health/live', null);
  check('liveness probe answers', live.status === 200);
  const ready = await call('GET', '/health/ready', null);
  check('readiness probe answers', ready.status === 200 && field(ready.json, 'status') === 'ready');
  const status = await call('GET', '/v1/status', agentToken);
  check('tenant status answers', status.status === 200);
  console.log();

  console.log('2. Verified $3,000 payment: straight through to a receipt');
  const small = await call('POST', '/v1/actions', agentToken, {
    agent_id: agentId,
    run_id: 'run_demo_small',
    task_purpose: 'Demo: pay a verified invoice',
    tool_name: 'payment.execute',
    arguments: {
      invoice_id: 'INV-2041',
      vendor_id: 'VEN-017',
      amount_minor: 300000,
      currency: 'USD',
      beneficiary_ref: 'BEN-017-VERIFIED',
    },
    evidence_refs: [],
    idempotency_key: `demo-small-${stamp}`,
    environment: 'DEMO',
  });
  check('intake allows with a permit', small.status === 201 && field(small.json, 'decision') === 'ALLOW');
  const smallBody = small.json as { action_id: string; permit: { token: string } | null };
  const smallExec = await call('POST', `/v1/actions/${smallBody.action_id}/execute`, agentToken, {
    permit_token: smallBody.permit?.token ?? '',
    idempotency_key: `demo-small-exec-${stamp}`,
  });
  check(
    'execution returns a receipt',
    smallExec.status === 200 &&
      (smallExec.json as { receipt: { amount_minor: number } }).receipt?.amount_minor === 300000,
    JSON.stringify(smallExec.json).slice(0, 200),
  );
  console.log();

  console.log('3. $30,000 payment: human approval, then a receipt');
  const large = await call('POST', '/v1/actions', agentToken, {
    agent_id: agentId,
    run_id: 'run_demo_large',
    task_purpose: 'Demo: large payment needing review',
    tool_name: 'payment.execute',
    arguments: {
      invoice_id: 'INV-2043',
      vendor_id: 'VEN-017',
      amount_minor: 3000000,
      currency: 'USD',
      beneficiary_ref: 'BEN-017-VERIFIED',
    },
    evidence_refs: ['invoice:INV-2043', 'purchase-order:PO-883'],
    idempotency_key: `demo-large-${stamp}`,
    environment: 'DEMO',
  });
  // INV-2043 is a real $30,000 invoice matched to PO-883, so every deterministic
  // check passes — and the amount threshold still routes it to a human instead
  // of allowing it silently. The hold is the point, not a data defect.
  check('intake asks for approval', large.status === 201 && field(large.json, 'decision') === 'REQUIRE_APPROVAL');
  const largeBody = large.json as { action_id: string; action_hash: string; policy_revision: { id: string } };
  const approved = await call('POST', `/v1/actions/${largeBody.action_id}/approve`, approver1, {
    decision: 'APPROVE',
    reason_code: 'EVIDENCE_REVIEWED',
    idempotency_key: `demo-large-apr-${stamp}`,
    action_hash: largeBody.action_hash,
    policy_revision_id: largeBody.policy_revision.id,
  });
  check('approver decision lands', approved.status === 200 && field(approved.json, 'state') === 'APPROVED');
  const permit = await call('POST', `/v1/actions/${largeBody.action_id}/permit`, agentToken, {});
  check('agent collects the permit', permit.status === 201);
  const largeExec = await call('POST', `/v1/actions/${largeBody.action_id}/execute`, agentToken, {
    permit_token: (permit.json as { token: string }).token ?? '',
    idempotency_key: `demo-large-exec-${stamp}`,
  });
  check('execution returns a receipt', largeExec.status === 200 && field(largeExec.json, 'state') === 'SUCCEEDED');
  console.log();

  console.log('4. Bank-detail change: dual control plus out-of-band verification');
  const change = await call('POST', '/v1/actions', agentToken, {
    agent_id: agentId,
    run_id: 'run_demo_bank',
    task_purpose: 'Demo: rotate the vendor payout account',
    tool_name: 'vendor.update_bank_details',
    arguments: {
      vendor_id: 'VEN-017',
      new_beneficiary_ref: 'BEN-017-DEMO',
      reason: 'Demo rotation',
      verification_ref: null,
    },
    evidence_refs: [],
    idempotency_key: `demo-bank-${stamp}`,
    environment: 'DEMO',
  });
  check(
    'intake asks for two approvals',
    change.status === 201 && field(change.json, 'decision') === 'REQUIRE_APPROVAL',
  );
  const changeBody = change.json as { action_id: string; action_hash: string; policy_revision: { id: string } };
  const approve = (token: string, reason: string, key: string) =>
    call('POST', `/v1/actions/${changeBody.action_id}/approve`, token, {
      decision: 'APPROVE',
      reason_code: reason,
      idempotency_key: key,
      action_hash: changeBody.action_hash,
      policy_revision_id: changeBody.policy_revision.id,
    });
  await approve(approver1, 'EVIDENCE_REVIEWED', `demo-bank-a1-${stamp}`);
  await approve(approver2, 'PO_CONFIRMED', `demo-bank-a2-${stamp}`);
  const quorum = await approve(owner, 'VENDOR_VERIFIED_OUT_OF_BAND', `demo-bank-own-${stamp}`);
  check('quorum completes after verification', quorum.status === 200 && field(quorum.json, 'state') === 'APPROVED');
  console.log();

  if (failures > 0) {
    console.log(`Demo finished with ${failures} failure(s).`);
    process.exit(1);
  }
  console.log('Demo finished: every step behaved as promised.');
}

main().catch((err: unknown) => {
  console.error(`demo failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
