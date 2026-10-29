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

### TENANT-ISOLATION-IN-THE-DEPLOYMENT — the control is on in the running deployment, not only in development

status: implemented
sources: SOC 2 CC6.1, CC6.6; OWASP Agentic (identity/privilege abuse)
claim: The deployed API connects as the restricted `pz_app` role, not as the schema owner, so row-level security applies to the traffic that actually serves tenants. The deployment script refuses to start without a runtime URL that names `pz_app`, and verifies the property against the live database rather than the configuration: after the rollout, a query as the runtime role with no tenant context set must return zero rows.
evidence: infra/deploy/deploy-vps.sh:138 expect:DATABASE_URL_RUNTIME=postgres://pz_app:$RLS_PW@postgres:5432/permitzero; infra/deploy/deploy-vps.sh:535 expect:verifying tenant isolation in the running deployment
tests: packages/db/test/rls.test.ts; apps/api/test/tenant-isolation.test.ts
note: The first version of the deployment script wrote `DATABASE_URL` but not `DATABASE_URL_RUNTIME`, and the application falls back to the admin URL when the latter is unset — so the deployed API ran as the schema owner, which row-level security does not bind, and every tenant row was reachable without a tenant context. The deployment now generates a random password for the restricted role, points the runtime URL at it, refuses to start if the two do not agree, and checks the live database after the rollout. Verified on the running deployment: 31 policies, 22/22 tenant tables enforced, and a cross-tenant read as `pz_app` returns zero rows.

### TENANT-ISOLATION — the database, not query discipline, separates tenant data

status: implemented
sources: SOC 2 CC6.1, CC6.6; OWASP Agentic (identity/privilege abuse); MAS SAFR (runtime authorization)
claim: Every tenant-bearing table is under RLS with `ENABLE`+`FORCE`, the runtime role is non-exempt, and the session context is transaction-local, so a query that forgets `WHERE tenant_id = ?` returns zero foreign rows rather than all of them.
evidence: infra/migrations/0006_row_level_security.sql:254 expect:CREATE POLICY tenant_isolation; infra/migrations/0006_row_level_security.sql:244 expect:FORCE ROW LEVEL SECURITY; packages/db/src/tenant.ts:44 expect:set_config('app.tenant_id'; packages/db/src/stores.ts:205 expect:withTenantTransaction(root
tests: packages/db/test/rls.test.ts; apps/api/test/tenant-isolation.test.ts
gap: —

### BLIND-WRITE-SCOPE — the escape hatch opens a READ, and one bounded WRITE

status: implemented
sources: SOC 2 CC6.1, CC6.6; OWASP Agentic (identity/privilege abuse)
claim: The `pz.tenant_blind` flag opens SELECT on the five door tables and the delivery backlog, and one bounded UPDATE: the three claim columns of an outbox row, which the cross-tenant claim genuinely needs. It cannot insert, update or delete a `users` row of any tenant, and it cannot change any other column of an outbox row.
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
evidence: infra/migrations/0002_triggers.sql:146 expect:hashtextextended('pz_audit_chain:; packages/db/src/repos/audit.ts:297 expect:export async function appendAuditEvent; packages/db/src/repos/audit.ts:493 expect:verifyAuditChain
tests: packages/db/test/execution-stores.test.ts; packages/db/test/audit-concurrency.test.ts; apps/api/test/intake.test.ts
gap: —

### AUDIT-WRITE-UNDER-CONCURRENCY — contention waits, it does not 500

status: implemented
sources: SOC 2 CC7.2, A1.2 (resilience of evidence)
claim: The chain lock is taken before the head is read, so a concurrent writer blocks instead of aborting its own transaction, and a row that violates a real CHECK is reported as that violation rather than retried into a 25P02.
evidence: packages/db/src/repos/audit.ts:325 expect:SELECT pg_advisory_xact_lock; packages/db/src/repos/audit.ts:286 expect:export function isAuditChainCollision
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

### MFA-STEP-UP — a step-up assertion is signed, and there is an endpoint that issues one

status: implemented
sources: SOC 2 CC6.1, CC6.2; MAS SAFR (human oversight); OWASP (authentication)
claim: `require_mfa` is satisfied only by a server-signed assertion bound to the tenant, the approver, the action and an expiry, and there is now an endpoint that issues one after a real second factor. The second factor is a TOTP (RFC 6238) code verified against the user's own encrypted secret; the secret is stored under AES-256-GCM with a key derived from the server's master secret, and a spent code is fingerprinted so it cannot be presented twice. A client-supplied string, an assertion signed with the wrong key, one issued for a different action or a different approver, an expired one, and one presented by an approver who has since removed their second factor are all refused.
evidence: packages/policy/src/mfa.ts:129 expect:verifyMfaAssertion; packages/schemas/src/api.ts:316 expect:mfa_context_ref; apps/api/src/approvals.ts:32 expect:verifyMfaAssertion; apps/api/src/routes/me.ts:428 expect:export async function meRoutes; apps/api/src/routes/actions.ts:222 expect:/actions/:id/step-up; infra/migrations/0008_mfa_totp.sql:66 expect:CREATE TABLE IF NOT EXISTS public.mfa_secrets
tests: apps/api/test/mfa-step-up.test.ts | accepts a code generated for the current time and refuses a wrong one; apps/api/test/mfa-step-up.test.ts | enrolment and confirmation set mfa_enrolled_at; apps/api/test/mfa-step-up.test.ts | issues an assertion after a recent verification, and it verifies for that action; apps/api/test/mfa-step-up.test.ts | binds the assertion to the action it was issued for; apps/api/test/approvals.test.ts | refuses a step-up assertion from an approver with no second factor enrolled; packages/policy/test/policy.test.ts | mfa step-up assertions
note: The assertion key is derived from `AUDIT_HMAC_KEY` with domain separation rather than being its own secret, and the enrolment is per user rather than per tenant. The check that the approver still has a second factor enrolled happens inside the tenant transaction, because the runtime role's row-level policy hides the user row from a read outside a tenant context.

### TRANSPORT-AND-HEADER-HARDENING — the HTTP surface is constrained

status: implemented
sources: SOC 2 CC6.6; OWASP (secure configuration)
claim: helmet is registered with an explicit CSP, HSTS with preload, `frameguard: deny`, `noSniff`, `no-referrer`, a body-size ceiling, an CORS allowlist rather than a reflected origin, and `trustProxy` limited to the named hops.
evidence: apps/api/src/app.ts:196 expect:await app.register(helmet; apps/api/src/app.ts:214 expect:hsts; apps/api/src/app.ts:220 expect:frameguard; apps/api/src/app.ts:194 expect:origin: buildCorsOriginCheck(deps.config.corsOrigins); apps/api/src/app.ts:186 expect:trustProxy
tests: apps/api/test/security.test.ts
note: TLS termination is the edge proxy's job (infra/caddy/Caddyfile); the app itself is plain HTTP behind it, which is documented rather than asserted.

### ABUSE-THROTTLING — limits that are actually applied, and shared across replicas

status: implemented
sources: SOC 2 CC7.3 (availability); OWASP (brute force)
claim: A global ceiling plus per-route mutation and credential budgets are wired into Fastify's rate limiter, and the credential and mutation budgets are counted in Redis so they are the SAME allowance on every replica rather than one per process. The budget is charged against the presented credential, hashed — not the client address, because a brute-force attempt presents a different token each time and an address-keyed bucket is bypassed by walking around it, and because every tenant behind the edge proxy would otherwise share one bucket. When Redis cannot be reached the local limit still applies, so a limiter outage cannot grant an unlimited budget, and the fallback is counted and published as a metric rather than left to be discovered.
evidence: apps/api/src/app.ts:268 expect:createSharedBudgets; apps/api/src/app.ts:220 expect:rateLimit; apps/api/src/config.ts:161 expect:export function loadConfig(env: NodeJS.ProcessEnv = process.env); packages/observability/src/shared-rate-limit.ts:182 expect:export class SharedRateLimiter
tests: apps/api/test/rate-limit.test.ts; apps/api/test/security.test.ts; apps/api/test/tenant-isolation.test.ts
note: The shared counter fails OPEN onto the local limit rather than closed. A limiter is a defence against abuse; it is not the control that decides whether an action is allowed, and an outage of it must not take the authorization API down with it. The failure is counted and exported so a permanently degraded limiter is visible.

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
evidence: apps/api/src/config.ts:205 expect:logLevelOf(env); apps/api/src/app.ts:178 expect:loggerOptions(deps.config)
tests: apps/api/test/logging.test.ts | is actually enabled, at the configured level
note: Correlation travels as an explicit `traceId` field on the calls that matter, not on every line: the pinned Fastify (5.2) has no `setLogContext`, and the attempt to use it 500'd every request before a test caught it.

### DEPENDENCY-TRANSPARENCY — the audit gate can fail, and covers the whole tree

status: implemented
sources: SOC 2 CC7.1, CC8.1; OWASP (supply chain)
claim: `npm audit` runs in CI against the WHOLE dependency tree against an explicit, dated exception list; a finding that is not named, reasoned and in-date fails the build, and an exception whose advisory has cleared is reported so the list cannot only ever grow. The gate also refuses to pass when npm cannot produce a report at all, because an unavailable audit is not a clean audit — which is the defect that had retired four real advisories in the first place.
evidence: scripts/audit-gate.mjs:42 expect:const EXCEPTIONS_FILE = path.join(root; scripts/audit-gate.mjs:75 expect:function readAuditReport(stdout, failure); infra/security/dependency-exceptions.json:1 expect:exceptions
tests: scripts/audit-gate.mjs
note: The scope used to be `--omit=dev`, so a build-time advisory could hide outside the gate; the tree is now audited whole, and every advisory it reports — twenty at the time of writing — is named in the exceptions file with a reason, a compensating control and a review date. There is still no provenance or SLSA attestation checking, and Dependabot reports a wider set under its own scope.

### SECRET-HYGIENE — no credential in the tree, and rotation is a procedure that works

status: implemented
sources: SOC 2 CC6.1; OWASP (secrets management)
claim: Secrets come from the environment and fail fast naming the variable, the RLS role password is substituted from the environment into migration SQL behind a character-class guard, gitleaks runs in CI over the history, and the demo credential file is gitignored with mode 0600. The master key can be ROTATED without losing the ability to verify the audit chain: the environment carries a keyRING, the first entry current and the rest accepted for verification, so a new key is added before it becomes current and the old one is retired afterwards.
evidence: apps/api/src/config.ts:103 expect:function required(env: NodeJS.ProcessEnv, name: string); packages/db/src/client.ts:74 expect:PZ_RLS_ROLE_PASSWORD; packages/db/src/crypto.ts:117 expect:export function deriveKey
tests: packages/db/test/root-env.test.ts; packages/db/test/rotation.test.ts
note: The keyring is an environment variable rather than an external secret manager, so the rotation window is an operator decision and the procedure is a script with a documented order. Rotation is deliberately not automated: how long a retired key stays acceptable is a risk decision, and a cron job cannot make it.

### RESILIENCE — provider outage degrades instead of halting

status: implemented
sources: SOC 2 A1.2; OWASP Agentic (tool misuse under failure); MAS SAFR (resilience)
claim: The model provider is wrapped in bounded attempts, backoff and a circuit breaker, the deterministic path answers when it is unavailable, and the outbox keeps events through a crash with a lease, a DLQ and a redrive. The provider outage is DRILLED: an API instance is pointed at an unreachable provider, and the drill asserts that a decision still succeeds on the deterministic path or escalates to REQUIRE_APPROVAL when the policy requires the model signal — and that it NEVER yields ALLOW on the strength of a missing signal — that the breaker opens and is observable, and that the request does not hang past the timeout.
evidence: packages/provider-meta/src/client.ts:113 expect:breaker; packages/db/src/repos/outbox.ts:151 expect:claimOutboxEvents; packages/db/src/repos/outbox.ts:256 expect:redriveOutboxEvent; scripts/resilience-drill.ts:45 expect:provider
tests: apps/api/test/resilience.test.ts; packages/db/test/outbox-concurrency.test.ts | gives two simultaneous claimers disjoint rows, never the same row twice; packages/queue/test/dispatcher-resilience.test.ts; scripts/resilience-drill.ts
note: The drill runs against local Postgres and Redis. The queue's Redis calls are bounded and guarded by a circuit breaker, so a Redis outage fails fast into the retry path instead of wedging the dispatcher silently — but there is still one Postgres and one Redis, so an outage of either is an outage of the deployment. That is a separate control, below: MULTI-REGION-FAILOVER.

### MULTI-REGION-FAILOVER — one region, one Postgres, one Redis

status: absent
sources: SOC 2 A1.2 (recovery); MAS SAFR (continuity)
claim: The deployment survives the loss of a region, a database node or a broker without a manual restore.
evidence: README.md:251 expect:Not certified
tests:
gap: There is one Postgres and one Redis, in one region, on one host. The drill proves the failure modes DEGRADE rather than halt — an unreachable database answers 503 and leaves no half-written action, an unreachable provider escalates rather than allowing — but a lost region is an outage of the deployment. Active-active would need a second region with its own data, which is an architecture and a budget decision rather than a configuration one.

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

### OBSERVABILITY-SLOS — objectives that can fail, and alerts that arrive somewhere

status: implemented
sources: SOC 2 CC7.2; MAS SAFR (monitoring)
claim: Decision latency, availability and outbox lag are exposed with a bucket at the SLO boundary, evaluated with multi-window multi-burn-rate logic, and shipped as Prometheus rules plus a dashboard; the report exits non-zero when an objective is breached OR when it measured nothing. The rules are loaded by a Prometheus that the deployment starts and confirms is scraping, and the notifications reach an ALERT SINK in the API itself: a webhook endpoint that authenticates the sender, records what arrived and counts it. An alert is therefore never evaluated and then silently dropped.
evidence: packages/observability/src/slos.ts:234 expect:SLOS; packages/observability/src/slos.ts:120 expect:burnRateForBudgetSpend; packages/observability/src/metrics.ts:32 expect:DECISION_BUCKETS_SECONDS; apps/api/src/observability.ts:215 expect:verifyAuditChains; apps/api/src/model.ts:85 expect:breakerStateValue; apps/api/src/routes/alerts.ts:156 expect:export async function
tests: packages/observability/test/observability.test.ts; packages/observability/test/alert-rules.test.ts; apps/api/test/observability.test.ts; apps/api/test/alerts.test.ts
note: The receiver is a webhook the operator can point elsewhere, and the API's own sink is the default so that the path is exercised whether or not a paging integration is configured. The `permit-single-use` objective is enforced by a conditional UPDATE and a unique constraint rather than by a scrapeable series, so it is reported as NOT_SCRAPEABLE instead of being turned into a permanently red gate.

### CHANGE-CONTROL — the gate is CI, not a promise

status: implemented
sources: SOC 2 CC8.1
claim: CI is configured to run typecheck, lint, the full suite, build, format, the strict SLO report against a live stack, gitleaks, the dependency gate, the compliance evidence gate and the resilience drill on every push, and `main` is protected so a change cannot reach it without those checks passing.
evidence: .github/workflows/ci.yml:255 expect:verify -- --strict; infra/migrations/0001_init.sql:26 expect:CREATE TABLE IF NOT EXISTS tenants; .github/workflows/auto-promote.yml:1 expect:Auto-promote; .github/workflows/deploy.yml:1 expect:Deploy; .github/workflows/main-gate.yml:1 expect:Main gate
tests: scripts/verify.mjs
note: Auto-promotion is limited to Dependabot's own dependency bumps: a human-authored change is merged by a human, because auto-merging one would let a push to a branch bypass review. Two properties of the promotion are worth stating because they are not obvious. First, a merge made with the workflow's own GITHUB_TOKEN does not trigger a push workflow, so the merged commit would reach main with nothing verifying it; the promotion therefore dispatches CI on the merge commit explicitly, and a scheduled reconciliation workflow (.github/workflows/main-gate.yml) covers a merge that lands after the promotion has finished waiting. Second, the required status checks are configured with `strict: false`: main now advances continuously through auto-merges, so requiring a pull request to be up to date with main would make every human pull request permanently stale and unmergeable. The gate that actually matters is the Deploy workflow's own check, which requires the three checks to have succeeded on the exact commit being shipped. Where the CI runner itself is concerned — an account state and a shared host — see CI-RUNNER-ISOLATION below, which is a different concern with a different owner.

### CI-RUNNER-ISOLATION — the runner that executes the code is not isolated from production

status: partial
sources: SOC 2 CC6.1, CC6.8; OWASP (supply chain)
claim: The runner that executes repository code is isolated from the production deployment it serves, so that code running in CI cannot reach production's data or its credentials.
evidence: .github/workflows/ci.yml:20 expect:fork; .github/workflows/ci.yml:67 expect:github.event.pull_request.head.repo.fork
tests:
gap: A pull request from a FORK never reaches the self-hosted runner — it is directed to a hosted runner — so a stranger cannot get code execution on the machine that holds the deployment credentials and Docker access. That is the part that mattered most, and it is closed. What is not closed is the runner's own placement: it is on the deploy host, which also runs the production stack and four other projects, and it shares their disk. The reason is an account state, not a repository setting — this account's hosted runners are refused with "your account is locked due to a billing issue", so a hosted-runner workflow would report green forever without running a step. That is the one thing here only a person with payment access can clear, and the fix is a separate CI host.

### ENCRYPTION-AT-REST — the application's own stored data is encrypted before it is written

status: implemented
sources: SOC 2 CC6.7; ISO 27001 (cryptography)
claim: Every payload this application writes that can contain personal data or secret material — the audit event payload, the outbox payload, the execution payload and the stored secret material — is encrypted with AES-256-GCM before it reaches the database, under a key derived from the server's master secret with a distinct domain-separation label per purpose. The stored bytes are ciphertext: a test reads the column directly and asserts the plaintext is not there. The audit chain is unaffected: the hash is computed over the CANONICAL PLAINTEXT and the ciphertext is written afterwards, so the chain still detects tampering — and a tampered ciphertext now fails twice over, the GCM authentication tag and the hash.
evidence: packages/db/src/crypto.ts:139 expect:export function encrypt; packages/db/src/crypto.ts:117 expect:export function deriveKey; packages/db/src/repos/audit.ts:117 expect:decryptedAuditRow; infra/migrations/0009_encryption_at_rest.sql:20 expect:encrypted
tests: packages/db/test/encryption.test.ts | stores the audit payload as ciphertext, not as the payload; packages/db/test/encryption.test.ts | fails verification when the stored ciphertext is altered; packages/db/test/encryption.test.ts | reads a payload written before encryption was enabled
note: This is APPLICATION-level encryption: what the application stores is encrypted, and the database cannot read it. The VOLUME is not encrypted — that is the host platform's responsibility, and this host's disk is not encrypted. The two are different controls and only the first is claimed here.

### BACKUP-AND-POINT-IN-TIME-RECOVERY — a base backup, WAL archiving, and a drill that restores

status: implemented
sources: SOC 2 A1.2 (recovery)
claim: The database is configured to archive its write-ahead log outside the data volume and to take periodic base backups, and a DRILL proves recovery works: it takes a base backup, writes a marker, restores into a SEPARATE temporary container with WAL replay, and asserts that the restored database contains the marker and that its schema and row counts are sane. The drill never touches the production container.
evidence: infra/deploy/backup.sh:8 expect:pg_basebackup; infra/deploy/restore-drill.sh:3 expect:restore; infra/docker-compose.yml:114 expect:archive_mode
tests: infra/deploy/restore-drill.sh | drill: restore the backup into a temporary container
note: The backups and the WAL archive live outside the compose project, so `compose down -v` cannot destroy them, and the drill runs on a schedule rather than on every deploy - a restore takes time and disk. The drill is what makes this a control rather than a configuration: a backup that has never been restored is not a backup. It was run against the live deployment, and it found five defects in itself that no review of the script would have found - the backup directory is mode 0700 owned by postgres, so the host cannot see it; the recovery target was not a timestamp; the drill could not delete what it made, and left a copy of the production database in /tmp on every run; it aimed the target at a point in time the WAL had not reached; and it connected as a role the production cluster does not have. Each was a failure the drill reported honestly rather than one it hid, and each is fixed in the same script.

### DATA-RETENTION-AND-DELETION — a window that is enforced, and a hold that stops it

status: implemented
sources: SOC 2 CC6.7, CC9.1; MAS SAFR (record retention)
claim: A retention window is enforced by a sweep that ages the audit and outbox rows out, and a LEGAL HOLD stops it: a tenant under a hold is left exactly as it is, and the sweep says so rather than failing silently. Every pass records what it did — how many rows were purged, how many were relinked, whether a hold stopped it, and the chain hashes at the boundary — because a deletion that leaves no record is a deletion nobody can be asked about. The audit chain stays VERIFIABLE across a purge: the survivors are re-sequenced and re-linked, so the trail does not report itself as tampered because the retention sweep did its job.
evidence: apps/worker/src/retention.ts:602 expect:export async function runRetentionSweep; infra/migrations/0010_retention_and_legal_hold.sql:152 expect:CREATE TABLE IF NOT EXISTS public.legal_holds
tests: apps/worker/test/retention.test.ts | leaves the audit chain verifiable after a purge; apps/worker/test/retention.test.ts | removes nothing for a tenant under a legal hold, and says so; apps/worker/test/retention.test.ts | records what it purged
note: A purge cannot remove the chain's last event without re-anchoring the chain, so the retention window and the chain's integrity are reconciled by relinking rather than by leaving a hole. The window itself is a deployment configuration, and the hold is per tenant with a named operator and a release reason. The re-anchor reproduces each row's EXISTING hash to discover the key that wrote it, and re-hashes over the plaintext: hashing the stored column with the configured key instead produces a chain that no verifier can check, which is the signal that is supposed to mean somebody altered the record coming to mean the retention sweep ran. That defect was real, and it was invisible locally because it only appears in a deployment WITH a key - the CI environment has one and a developer machine often does not. The sweep's own marker row is stored encrypted like every other row.

### ADVERSARIAL-SECURITY-REVIEW — a review was performed, and what it found is recorded

status: implemented
sources: SOC 2 CC4.1, CC7.2; OWASP (design review)
claim: An adversarial review of the whole build was performed during the hardening work, every finding was reproduced before it was fixed, and the register of findings — with severities, resolutions and the commits that closed them — is committed alongside the code. Thirty-two findings, including four that disabled a control the repository claimed: the deployment ran as the role that row-level security does not bind, the blind escape hatch was a write grant on two tables, the quorum did not exclude the requester, and a merge made with the workflow's own token reached `main` with nothing verifying it.
evidence: docs/security-review.md:1 expect:Security review; docs/security-review.md:52 expect:Thirty-two findings; docs/security-review.md:114 expect:Residual and accepted risks
tests: docs/security-review.md
note: The review was performed by an automated code reviewer running inside this repository, and the triage was done by the author. It is worth something and it is not the same thing as an independent review — see the next control, which is separate precisely so that the two are not conflated.

### INDEPENDENT-THIRD-PARTY-REVIEW — not done

status: absent
sources: SOC 2 CC4.1, CC9.2
claim: No third-party assessment, penetration test or attestation has been performed on this code.
evidence: README.md:259 expect:Not certified
tests:
gap: An internal review by the author of the code cannot stand in for an external one, and this repository does not pretend otherwise. What an external reviewer would need to cover is listed in docs/security-review.md section 4: the authorization path itself, the key-derivation and encryption scheme, the deployment as an operator sees it, and whether the audit chain has a second way to reconstruct one that verifies. That work needs a party who did not write this code and a budget to pay them; until then it is absent rather than implied.
