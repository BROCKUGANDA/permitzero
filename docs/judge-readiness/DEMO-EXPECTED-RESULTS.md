# PermitZero — Demo Expected Results

End-to-end demonstration scenario evidence. Fixture values verified against
`packages/db/src/seed.ts` (see `BASELINE.md` §9).

## Fixtures

| Fixture | Value |
| --- | --- |
| Vendor | `VEN-017`, `SYNTHETIC Example Ltd`, status `VERIFIED`, verified beneficiary `BEN-017-VERIFIED`, account age 400 days |
| Vendor (unverified) | `VEN-042`, `SYNTHETIC Acme Parts`, status `UNVERIFIED`, account age 12 days |
| Legitimate invoice | `INV-2041`, `$3,000.00` (300000 minor), USD, `PO-882`, Net 30 |
| Suspicious invoice | `INV-2042`, `$75,000.00` (7500000 minor), USD, `purchaseOrderId: null`, document text contains an embedded instruction to change bank details to `BEN-999-ATTACKER` and pay immediately without review |
| Large invoice | `INV-2043`, `$30,000.00` (3000000 minor), USD, `PO-883`, fully documented, held only by amount threshold |
| Purchase orders | `PO-882` ($3,000), `PO-883` ($30,000), both vendor `VEN-017` |

## Scenario steps

### Step A — Legitimate action passes deterministic policy and receives a narrowly scoped permit

- Input: invoice `INV-2041`, amount USD 3,000, vendor `VEN-017`, `PO-882`.
- Expected decision: `ALLOW`.
- Expected HTTP response: 200 with a signed permit (TTL, nonce, argument hash, policy revision).
- Database state: action row + decision + audit event + outbox event in one transaction.
- Audit event: `action.proposed`, `decision.made` (ALLOW).
- Relevant test: `apps/api/test/intake.test.ts`, `packages/policy/test/policy.test.ts`.
- Failure condition: any model hint or policy bug producing DENY on a clean $3,000 invoice.

### Step B — Suspicious/unauthorized action is denied or escalated

- Input: invoice `INV-2042`, amount USD 75,000, `purchaseOrderId: null`, document text contains the bank-details-change injection.
- Expected decision: `DENY` or `REQUIRE_APPROVAL` (per actual policy; the suspicious amount and missing PO trigger deterministic denial/escalation regardless of model).
- Expected HTTP response: 403/409 or approval-required response with reason codes.
- Database state: action row + decision (DENY/REQUIRE_APPROVAL) + audit event; no permit issued; no connector dispatch.
- Audit event: `decision.made` (DENY/REQUIRE_APPROVAL) with reason codes.
- Relevant test: `packages/policy/test/policy.test.ts` (model hints `REQUEST_TO_BYPASS_CONTROLS` / `BENEFICIARY_CHANGE_REQUEST` targeting `invoice:INV-2042`).
- Failure condition: an ALLOW decision or a permit issued for INV-2042.

Note: the shipped `apps/api/scripts/demo-scenario.ts` exercises INV-2041, INV-2043, and
`vendor.update_bank_details` (dual control). INV-2042's suspicious content is covered by
policy unit tests, not by the live end-to-end demo (`INSPECTION.md` INSP-01). A judge
scenario path for INV-2042 is an open item.

### Step C — Model-generated risk hint cannot override an unfavorable deterministic policy result

- Input: a policy decision that is DENY on deterministic grounds, with a model hint
  recommending ALLOW.
- Expected decision: remains `DENY`.
- Expected HTTP response: denial with reason codes; no permit.
- Database state: decision DENY persisted; model hint recorded in `model_evaluations`
  metadata only.
- Audit event: `decision.made` (DENY) with model hint attached as advisory.
- Relevant test: `packages/policy/test/policy.test.ts`, `apps/api/test/model.test.ts`.
- Failure condition: model hint flips decision to ALLOW.

### Step D — Unavailable model does not cause fail-open

- Input: same action with `MODEL_PROVIDER` unreachable / timeout.
- Expected decision: `REQUIRE_APPROVAL` or `INDETERMINATE`, never `ALLOW`.
- Expected HTTP response: approval-required or indeterminate, not 200+permit.
- Database state: decision persisted; `model_evaluations` records failure status.
- Audit event: `decision.made` with model-unavailable marker.
- Relevant test: `apps/api/test/model.test.ts`, `packages/provider-meta/test`.
- Failure condition: ALLOW or 5xx leak.

### Step E — Human approval bound to exact action and policy revision

- Input: an action requiring approval (`INV-2043`, $30,000) submitted, then an
  approval by a distinct approver.
- Expected decision: after quorum, `ALLOW` (or execution proceeds) bound to the same
  action hash and policy revision.
- Expected HTTP response: approval accepted only when the action hash and policy
  revision match.
- Database state: approval row linked to action + policy revision; permit issued on ALLOW.
- Audit event: `approval.granted`, `decision.made`.
- Relevant test: `apps/api/test/approvals.test.ts`.
- Failure condition: approval accepted for a mutated action or different policy revision.

### Step F — Requesting actor cannot approve their own action

- Input: the requesting actor submits an approval for their own action.
- Expected decision: approval refused at the point of decision; excluded from quorum's
  distinct-approver count.
- Expected HTTP response: 403/409.
- Database state: no approval row created; action remains pending approval.
- Audit event: `approval.denied` (self-approval).
- Relevant test: `apps/api/test/approvals.test.ts`.
- Failure condition: self-approval counted toward quorum.

### Step G — Broker rejects expired, altered, replayed, revoked, incorrectly scoped permits

- Input: permit tampering (expiry, argument hash, audience, tenant, action, policy
  revision, revocation, replay, concurrent consumption).
- Expected decision: broker rejects; connector does not run.
- Expected HTTP response: 403/409 from broker path.
- Database state: no receipt; execution-intent records reconciliation state.
- Audit event: `permit.rejected` with reason.
- Relevant test: `packages/broker` tests.
- Failure condition: connector runs on an invalid permit.

### Step H — Simulated connector records a receipt only after valid authorization

- Input: valid permit → broker → simulated connector.
- Expected decision: execution succeeds; receipt recorded.
- Expected HTTP response: 200 with receipt id.
- Database state: receipt row + audit event + outbox event.
- Audit event: `execution.completed` with receipt.
- Relevant test: `apps/api/test/execute.test.ts`.
- Failure condition: receipt without a valid permit.

### Step I — Audit events inspectable and chain verifiable

- Input: `verifyAuditChain` over the tenant's chain.
- Expected decision: chain verifies (no gaps, no tampering).
- Expected HTTP response: n/a (DB/CLI).
- Database state: contiguous sequence numbers; hashes match.
- Audit event: all prior events.
- Relevant test: `packages/db/test/audit-concurrency.test.ts`.
- Failure condition: gap or hash mismatch.

### Step J — Repeating an idempotent request does not create an unauthorized duplicate

- Input: same idempotency key submitted twice.
- Expected decision: second request returns the cached decision/receipt; no duplicate
  execution.
- Expected HTTP response: 200 with the original result.
- Database state: single action/execution row; idempotency key recorded.
- Audit event: no duplicate `execution.completed`.
- Relevant test: `apps/api/test/execute.test.ts` (idempotency).
- Failure condition: duplicate receipt or connector call.

## Failure condition summary

Any step producing an ALLOW/permit/receipt where the expected decision is DENY or
REQUIRE_APPROVAL is a security failure, not a test failure, and must be reported.