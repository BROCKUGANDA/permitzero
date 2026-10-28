# Control evidence map

Generated-by-hand source of truth, machine-checked by `npm run compliance:gate`.
Every `evidence:` entry is a real file and line in this repository and every
`tests:` entry is a real test file; the gate fails when one stops being true, so a
control cannot be claimed here and then quietly rot.

**This is not a certification.** Nothing in this file says PermitZero has been
audited, attested, or certified against any framework. It maps each control the
project claims to the code and the test that enforces it, and records the gaps in
the same voice as the wins. Framework labels use a precise criterion id only where
it is well established; elsewhere the theme named in `README.md` and the PRD is
quoted instead, because inventing clause numbers would be worse than having none.

Statuses: `implemented` (control exists, is wired, and is tested), `partial`
(wired but with a stated hole), `absent` (not built — stated, not hidden).

---

### TENANT-ISOLATION — the database, not query discipline, separates tenant data

status: implemented
sources: SOC 2 CC6.1, CC6.6; OWASP Agentic (identity/privilege abuse); MAS SAFR (runtime authorization)
claim: Every tenant-bearing table is under RLS with `ENABLE`+`FORCE`, the runtime role is non-exempt, and the session context is transaction-local, so a query that forgets `WHERE tenant_id = ?` returns zero foreign rows rather than all of them.
evidence: infra/migrations/0006_row_level_security.sql:254 expect:CREATE POLICY tenant_isolation; infra/migrations/0006_row_level_security.sql:244 expect:FORCE ROW LEVEL SECURITY; packages/db/src/tenant.ts:44 expect:set_config('app.tenant_id'; packages/db/src/stores.ts:205 expect:withTenantTransaction(root
tests: packages/db/test/rls.test.ts; apps/api/test/tenant-isolation.test.ts
gap: —

### BLIND-WRITE-SCOPE — the escape hatch opens a READ, not a WRITE

status: implemented
sources: SOC 2 CC6.1, CC6.6; OWASP Agentic (identity/privilege abuse)
claim: The `pz.tenant_blind` flag opens SELECT on the five door tables and the delivery backlog, and nothing else. It cannot insert, update or delete a `users` row of any tenant, and it cannot change any column of an outbox row outside the three the cross-tenant claim moves.
evidence: infra/migrations/0007_rls_write_scope.sql:70 expect:CREATE POLICY tenant_membership ON public.users; infra/migrations/0007_rls_write_scope.sql:104 expect:CREATE POLICY dispatch_claim ON public.outbox_events; infra/migrations/0007_rls_write_scope.sql:125 expect:pz_outbox_events_claim_scope
tests: packages/db/test/rls.test.ts | the blind flag does NOT open the WRITE path on the door and delivery tables; packages/db/test/rls.test.ts | the blind flag may read, and may not write
note: `0006` gave the blind flag `FOR ALL` policies on `users` and `outbox_events`, which is a write grant rather than a read grant — a blind transaction could have rewritten another tenant's identity record. `0007` narrows both, and the column-level half of the rule is enforced by a trigger, because a row-level policy cannot express which COLUMNS a statement may change.

### ISOLATION-IS-ASSERTED — enforcement is asked of the database, never assumed from config

status: implemented
sources: SOC 2 CC6.1, CC7.1; ISO 27001 (monitoring review)
claim: `/health/ready`, `/v1/status` and the boot log read `pz_rls_coverage` and the runtime role's attributes through the pool that serves tenant traffic, so "RLS is configured" is never reported as "RLS applies to this connection".
evidence: packages/db/src/tenant.ts:113 expect:rlsEnforcementState; infra/migrations/0006_row_level_security.sql:456 expect:pz_rls_coverage; apps/api/src/routes/health.ts:97 expect:tenant_isolation: tenantIsolation
tests: apps/api/test/tenant-isolation.test.ts; packages/db/test/rls.test.ts
gap: —

### AUTHENTICATION — credentials resolve to a principal inside one tenant

status: implemented
sources: SOC 2 CC6.1; OWASP Agentic (identity abuse)
claim: A bearer token is looked up through the transaction-local tenant-blind escape hatch, then the principal is resolved inside that credential's tenant; no request path gets a cross-tenant principal.
evidence: apps/api/src/auth.ts:50 expect:authenticateToken; apps/api/src/auth.ts:63 expect:resolvePrincipal; packages/db/src/tenant.ts:59 expect:withTenantBlindTransaction
tests: apps/api/test/auth.test.ts; packages/db/test/rls.test.ts
note: Password/MFA flows are outside this build's scope: agents and service tokens authenticate, human users are seeded, not self-registering.

### LEAST-PRIVILEGE-ROLE — the app role cannot opt out of the boundary

status: implemented
sources: SOC 2 CC6.1, CC6.2; ISO 27001 (access control)
claim: `pz_app` is created NOSUPERUSER/NOBYPASSRLS/NOCREATEROLE/NOCREATEDB, the migration aborts if that has drifted, and the SECURITY DEFINER helpers are revoked from PUBLIC so the runtime role has no path into a superuser-owned function.
evidence: infra/migrations/0006_row_level_security.sql:110 expect:CREATE ROLE pz_app LOGIN NOSUPERUSER; infra/migrations/0006_row_level_security.sql:437 expect:REVOKE ALL ON FUNCTION
tests: packages/db/test/rls.test.ts
note: The migration role is exempt by design (it must own DDL); on managed Postgres the operator must grant it a BYPASSRLS admin role, which the preflight message names rather than assumes.

### AUDIT-TRAIL-INTEGRITY — decisions are recorded in a tamper-evident chain

status: implemented
sources: SOC 2 CC7.2, CC4.1; OWASP Agentic (records of decisions); MAS SAFR (record of decision)
claim: Each audit event hashes the canonical event plus the previous hash, its sequence is assigned under a per-tenant advisory lock, and the chain is verifiable end-to-end for a tenant.
evidence: infra/migrations/0002_triggers.sql:146 expect:hashtextextended('pz_audit_chain:; packages/db/src/repos/audit.ts:117 expect:appendAuditEvent; packages/db/src/repos/audit.ts:287 expect:verifyAuditChain
tests: packages/db/test/execution-stores.test.ts; packages/db/test/audit-concurrency.test.ts; apps/api/test/intake.test.ts
gap: —

### AUDIT-WRITE-UNDER-CONCURRENCY — contention waits, it does not 500

status: implemented
sources: SOC 2 CC7.2, A1.2 (resilience of evidence)
claim: The chain lock is taken before the head is read, so a concurrent writer blocks instead of aborting its own transaction, and a row that violates a real CHECK is reported as that violation rather than retried into a 25P02.
evidence: packages/db/src/repos/audit.ts:139 expect:pg_advisory_xact_lock; packages/db/src/repos/audit.ts:106 expect:isAuditChainCollision
tests: packages/db/test/audit-concurrency.test.ts | does not lose the second writer when the chain head moves underneath it; packages/db/test/audit-concurrency.test.ts | serves every writer when a burst of them appends at once; packages/db/test/audit-concurrency.test.ts | reports a row that breaks a CHECK
note: Per-tenant serialisation is the design and also the throughput ceiling; it is measured in docs/benchmarks/SCALING.md rather than assumed.

### IDEMPOTENCY — replay is not a second decision

status: implemented
sources: SOC 2 CC7.3; MAS SAFR (transaction control)
claim: Intake is keyed on (tenant, agent, idempotency key) with a unique constraint in the database, so a retried request answers from the completed record instead of evaluating policy twice.
evidence: infra/migrations/0001_init.sql:248 expect:uq_actions_idempotency; apps/api/src/intake.ts:335 expect:findIdempotencyRecord
tests: apps/api/test/intake.test.ts
gap: —

### DETERMINISTIC-ENFORCEMENT — the model advises, policy decides

status: implemented
sources: OWASP Agentic (goal hijacking, tool misuse); MAS SAFR (human oversight, model risk)
claim: Allow/deny/approve comes from `evaluatePolicy` over the pinned policy revision; provider risk hints are inputs to the deterministic rules and a null hint is treated as no signal, never as safe.
evidence: packages/policy/src/evaluate.ts:118 expect:evaluatePolicy; apps/api/src/intake.ts:484 expect:policyRevisionId
tests: packages/policy/test; apps/api/test/intake.test.ts; apps/api/test/model.test.ts
note: The policy library covers the shipped rule set (amounts, vendor state, velocity, budget, evidence); it is not a general-purpose policy language.

### APPROVAL-BOUNDED-TIME — a human decision is required, recorded and expires

status: implemented
sources: MAS SAFR (human oversight); OWASP Agentic (privilege abuse)
claim: Actions above threshold require independent approvals from distinct principals within a TTL, and the decision is written to the audit chain with the approver identity.
evidence: apps/api/src/quorum.ts:42 expect:approvalRequirementsFor; apps/api/src/approvals.ts:82 expect:decideApproval; apps/api/src/permits.ts:40 expect:collectPermit
tests: apps/api/test/approvals.test.ts; apps/api/test/execute.test.ts
gap: —

### FOUR-EYES — the requester cannot approve their own action

status: implemented
sources: SOC 2 CC6.2, CC6.3; MAS SAFR (human oversight, separation of duties); OWASP (privilege abuse)
claim: An approval whose approver is the actor who requested the action is refused at the point of decision, so the four-eyes property holds however the action came to exist. The requester's approval is also excluded from the quorum's distinct-approver count, so a quorum can never be closed by the party the control excludes.
evidence: apps/api/src/approvals.ts:157 expect:cannot approve an action you requested; apps/api/src/quorum.ts:116 expect:requesterActorId
tests: apps/api/test/approvals.test.ts | refuses an approval from the requester of the action; apps/api/test/approvals.test.ts | still reaches a quorum of two when the requester is one of the approvers
note: Distinct approvers were already enforced; independence FROM THE REQUESTER was not. A user holding an OWNER or APPROVER role could submit a payment and then be its only approver.

### MFA-STEP-UP — a step-up assertion is signed, not typed

status: partial
sources: SOC 2 CC6.1, CC6.2; MAS SAFR (human oversight); OWASP (authentication)
claim: `require_mfa` is satisfied only by a server-signed assertion bound to the tenant, the approver, the action and an expiry. A client-supplied string, an assertion signed with the wrong key, one issued for a different action or a different approver, and an expired one are all refused.
evidence: packages/policy/src/mfa.ts:118 expect:verifyMfaAssertion; packages/schemas/src/api.ts:316 expect:mfa_context_ref; apps/api/src/approvals.ts:32 expect:verifyMfaAssertion
tests: apps/api/test/approvals.test.ts | accepts an approval only with a verifiable step-up assertion; apps/api/test/approvals.test.ts | refuses a step-up assertion issued for a different approver; apps/api/test/approvals.test.ts | refuses every assertion when the server has no key to verify it with; packages/policy/test/policy.test.ts | mfa step-up assertions
gap: There is no step-up ENDPOINT in this build: the assertion is issued by the policy package, but nothing in the API hands one out after verifying a second factor. A policy with `require_mfa: true` is therefore unsatisfiable and fails closed — the safe direction, but not a working feature. The assertion key is derived from `AUDIT_HMAC_KEY` with domain separation rather than being its own secret.

### TRANSPORT-AND-HEADER-HARDENING — the HTTP surface is constrained

status: implemented
sources: SOC 2 CC6.6; OWASP (secure configuration)
claim: helmet is registered with an explicit CSP, HSTS with preload, `frameguard: deny`, `noSniff`, `no-referrer`, a body-size ceiling, an CORS allowlist rather than a reflected origin, and `trustProxy` limited to the named hops.
evidence: apps/api/src/app.ts:184 expect:helmet; apps/api/src/app.ts:199 expect:hsts; apps/api/src/app.ts:205 expect:frameguard; apps/api/src/app.ts:182 expect:buildCorsOriginCheck; apps/api/src/app.ts:171 expect:trustProxy
tests: apps/api/test/security.test.ts
note: TLS termination is the edge proxy's job (infra/caddy/Caddyfile); the app itself is plain HTTP behind it, which is documented rather than asserted.

### ABUSE-THROTTLING — limits that are actually applied

status: partial
sources: SOC 2 CC7.3 (availability)
claim: A global ceiling plus per-route mutation and auth budgets are wired into Fastify's rate limiter, keyed on the client address resolved through the trusted proxy list.
evidence: apps/api/src/app.ts:220 expect:rateLimit; apps/api/src/config.ts:117 expect:loadConfig
tests: apps/api/test/security.test.ts; apps/api/test/tenant-isolation.test.ts
gap: The limiter is per-process in this build; with several replicas each has its own budget until a shared store is configured.

### NO-LEAK-ERRORS — internal failures do not reach the caller

status: implemented
sources: SOC 2 CC6.1, CC7.2; OWASP (error handling)
claim: Every error passes through one mapper that emits the standard envelope with a trace id; SQL state becomes a bounded message, and no stack, SQL fragment or provider body is serialised into a response.
evidence: apps/api/src/errors.ts:39 expect:mapStorageError; apps/api/src/errors.ts:152 expect:toHttpError
tests: apps/api/test/security.test.ts; apps/api/test/resilience.test.ts
gap: —

### OPERATIONAL-LOGGING — the log the config claims exists

status: implemented
sources: SOC 2 CC7.2; ISO 27001 (logging)
claim: `LOG_LEVEL` is parsed, validated and handed to Fastify's logger; an unknown level fails boot naming the variable, and credential-shaped fields are redacted at the serializer.
evidence: apps/api/src/config.ts:161 expect:logLevelOf(env); apps/api/src/app.ts:164 expect:loggerOptions(deps.config)
tests: apps/api/test/logging.test.ts | is actually enabled, at the configured level
note: Correlation travels as an explicit `traceId` field on the calls that matter, not on every line: the pinned Fastify (5.2) has no `setLogContext`, and the attempt to use it 500'd every request before a test caught it.

### DEPENDENCY-TRANSPARENCY — the audit gate can fail

status: partial
sources: SOC 2 CC7.1, CC8.1; OWASP (supply chain)
claim: `npm audit` runs in CI against an explicit, dated exception list; a production finding that is not named, reasoned and in-date fails the build, and an exception whose advisory has cleared is reported so the list cannot only ever grow. The gate also refuses to pass when npm cannot produce a report at all, because an unavailable audit is not a clean audit.
evidence: scripts/audit-gate.mjs:26 expect:dependency-exceptions.json; scripts/audit-gate.mjs:62 expect:readAuditReport
tests: scripts/audit-gate.mjs
gap: Scope is `--omit=dev`, so advisories confined to devDependencies are outside the gate. npm currently reports four production advisories — zod, fastify-type-provider-zod, postcss and next — and the exceptions file is empty, so the gate FAILS until each is either fixed or named with a reason and a review date. The previous version of this file claimed the list was empty because npm reported nothing; that claim was produced by a run in which npm had failed with a configuration error and the gate had parsed the error envelope as an empty report. GitHub Dependabot reports a wider set under its own scope, and there is no provenance/SLSA attestation checking.

### SECRET-HYGIENE — no credential in the tree

status: partial
sources: SOC 2 CC6.1; OWASP (secrets management)
claim: Secrets come from the environment and fail fast naming the variable, the RLS role password is substituted from the environment into migration SQL behind a character-class guard, gitleaks runs in CI, and the demo credential file is gitignored with mode 0600.
evidence: apps/api/src/config.ts:68 expect:required; packages/db/src/client.ts:74 expect:PZ_RLS_ROLE_PASSWORD
tests: packages/db/test/root-env.test.ts
gap: No external secret manager or KMS integration; rotation is an operator procedure, and `DATABASE_URL_RUNTIME` carries the role password in the environment like every other setting here.

### RESILIENCE — provider outage degrades instead of halting

status: partial
sources: SOC 2 A1.2; OWASP Agentic (tool misuse under failure); MAS SAFR (resilience)
claim: The model provider is wrapped in bounded attempts, backoff and a circuit breaker, the deterministic path answers when it is unavailable, and the outbox keeps events through a crash with a lease, a DLQ and a redrive.
evidence: packages/provider-meta/src/client.ts:113 expect:breaker; packages/db/src/repos/outbox.ts:112 expect:claimOutboxEvents; packages/db/src/repos/outbox.ts:212 expect:redriveOutboxEvent
tests: apps/api/test/resilience.test.ts; packages/db/test/outbox-concurrency.test.ts | gives two simultaneous claimers disjoint rows, never the same row twice; packages/queue/test/dispatcher-resilience.test.ts; scripts/resilience-drill.ts
gap: The drill runs against local Postgres/Redis. No multi-region or provider-failover evidence exists. The queue's Redis calls are now bounded and guarded by a circuit breaker, so a Redis outage fails fast into the retry path instead of wedging the dispatcher silently — but there is still one Postgres and one Redis, so an outage of either is an outage of the deployment.

### SHUTDOWN-BOUNDED — deployment does not truncate in-flight work

status: implemented
sources: SOC 2 A1.2; OWASP (operational resilience)
claim: SIGTERM drains with a deadline and a failsafe; a handler that outruns the window is cut rather than hanging the process, and the report states the window it was given.
evidence: apps/api/src/shutdown.ts:50 expect:closeWithinDeadline
tests: apps/api/test/shutdown.test.ts | reports the window it was given so the log line is auditable
gap: —

### READINESS-HONEST — not ready answers 503

status: implemented
sources: SOC 2 A1.2; OWASP (secure configuration)
claim: `/health/ready` returns 503 when the database is unreachable or migrations are pending, so an orchestrator healthcheck keyed on `r.ok` cannot call a dead instance healthy.
evidence: apps/api/src/routes/health.ts:92 expect:not_ready
tests: apps/api/test/health.test.ts
note: Tenant-isolation posture is reported as a warning rather than a readiness gate, deliberately: a control that does not touch the request path should not pull a serving instance out of rotation.

### OBSERVABILITY-SLOS — objectives that can fail

status: partial
sources: SOC 2 CC7.2; MAS SAFR (monitoring)
claim: Decision latency, availability and outbox lag are exposed with a bucket at the SLO boundary, evaluated with multi-window multi-burn-rate logic, and shipped as Prometheus rules plus a dashboard; the report exits non-zero when an objective is breached OR when it measured nothing.
evidence: packages/observability/src/slos.ts:234 expect:SLOS; packages/observability/src/slos.ts:120 expect:burnRateForBudgetSpend; packages/observability/src/metrics.ts:32 expect:DECISION_BUCKETS_SECONDS; apps/api/src/observability.ts:215 expect:verifyAuditChains; apps/api/src/model.ts:85 expect:breakerStateValue
tests: packages/observability/test/observability.test.ts; packages/observability/test/alert-rules.test.ts; apps/api/test/observability.test.ts
gap: The alert rules evaluate and route through an Alertmanager, but the receiver is a webhook whose URL is deployment configuration — no PagerDuty or Slack integration is wired, and the webhook is unset by default, in which case alerts are evaluated and dropped. The `permit-single-use` objective is enforced by a conditional UPDATE and a unique constraint rather than by a scrapeable series, so it is reported as NOT_SCRAPEABLE instead of being turned into a permanently red gate.

### CHANGE-CONTROL — the gate is CI, not a promise

status: partial
sources: SOC 2 CC8.1
claim: CI is configured to run typecheck, lint, the full suite, build, format, the strict SLO report against a live stack, gitleaks, the dependency gate, the compliance evidence gate and the resilience drill on every push, and `main` is protected so a change cannot reach it without those checks passing.
evidence: .github/workflows/ci.yml:41 expect:verify; infra/migrations/0001_init.sql:26 expect:CREATE TABLE IF NOT EXISTS tenants; .github/workflows/auto-promote.yml:1 expect:Auto-promote; .github/workflows/deploy.yml:1 expect:Deploy
tests: scripts/verify.mjs
gap: The gates run on a SELF-HOSTED runner, because this account's hosted runners are refused with "your account is locked due to a billing issue" — a hosted-runner run would not start at all, so a hosted-only workflow would report green forever without running a step. That is an account billing state, not a repository setting, and it is the one thing here that only a person with payment access can clear. The runner is on the deploy host, which also runs the production stack and four other projects. Auto-promotion is limited to Dependabot's own dependency bumps: a human-authored change is merged by a human, because auto-merging one would let a push to a branch bypass review.

### ENCRYPTION-AT-REST — not built here

status: absent
sources: SOC 2 CC6.7; ISO 27001 (cryptography)
claim: Nothing in this repository encrypts data at rest.
evidence: infra/docker-compose.yml:32 expect:healthcheck
tests:
gap: Left to the database platform (managed Postgres volume encryption / TDE). No implementation, no configuration, no evidence. Stated rather than implied by "secure by default".

### BACKUP-AND-POINT-IN-TIME-RECOVERY — not built here

status: absent
sources: SOC 2 A1.2 (recovery)
claim: There is no backup job, no restore procedure and no RPO/RTO measurement in this build.
evidence: infra/migrations/0001_init.sql:26 expect:CREATE TABLE IF NOT EXISTS tenants
tests:
gap: `db:reset` truncates for development; it is not a recovery path. Real deployment needs PITR evidence before any availability claim is made.

### DATA-RETENTION-AND-DELETION — not built here

status: absent
sources: SOC 2 CC6.7, CC9.1; MAS SAFR (record retention)
claim: Nothing enforces a retention period or a tenant data-deletion path; rows live until deleted by hand.
evidence: infra/migrations/0001_init.sql:26 expect:CREATE TABLE IF NOT EXISTS tenants
tests:
gap: An append-only audit chain is in tension with erasure requests and the reconciliation (legal hold vs right to be forgotten) is unbuilt and unowned here.

### PENETRATION-TEST-AND-INDEPENDENT-REVIEW — not done

status: absent
sources: SOC 2 CC4.1, CC9.2
claim: No third-party assessment, penetration test or attestation has been performed on this code.
evidence: README.md:212 expect:Not certified
tests:
gap: Everything in this file is self-asserted against self-written tests. That is the honest boundary of a hackathon build, and the README says so.
