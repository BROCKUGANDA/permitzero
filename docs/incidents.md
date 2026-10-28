# Incident runbooks

Every alert in `infra/observability/prometheus/rules/permitzero-alerts.yml`
points here. A runbook that a paged engineer cannot follow is not a runbook,
so each section below answers the same three questions in the same order:
**what does this mean, what do I check first, what do I do about it.**

The commands assume you are on the deploy host with the compose project
running. `$COMPOSE` is `docker compose --env-file infra/deploy/permitzero.env
-f infra/docker-compose.yml`.

---

## decision-availability

**Fires:** `PermitZeroDecisionAvailabilityFastBurn` (page) and
`PermitZeroDecisionAvailabilitySlowBurn` (ticket). More than 0.144% of
requests are answering 5xx (fast burn) or 0.06% over six hours (slow burn).

**What it means:** the decision API is failing requests. Every failed request
is an agent that got no answer — which, on an authorization plane, is safer
than a wrong one, but is still an outage for the caller.

**Check first:**

```bash
$COMPOSE logs --tail=100 api | grep -i error
$COMPOSE ps                      # is anything restarting?
$COMPOSE exec postgres psql -U permitzero -d permitzero -c \
  "SELECT count(*) FROM pg_stat_activity WHERE state = 'active';"
```

The three usual causes, in order of how often they are the answer:

1. **The database is unreachable.** The API answers 503, not 500, in that
   case — the readiness probe turns into the honest signal.
2. **The connection pool is saturated.** `pg_stat_activity` shows many
   connections in `active` state. The per-tenant audit chain serialises
   appends by design, and at high concurrency the pool becomes the ceiling.
   `docs/benchmarks/SCALING.md` records the measured shape of this.
3. **A dependency timed out.** The model provider has a 30 s timeout and up
   to five attempts, so a sick provider can hold a request open for a long
   time. Check `pz_model_screenings_total{status!="OK"}`.

**What to do:**

- If the database is down: `cd infra/deploy && ./deploy-vps.sh --no-build`
  after the database is healthy. Note that a restart alone does not fix a
  database that is genuinely gone — the hosted Postgres has no replica, so
  this is a restore-from-backup situation, and there is no backup job in this
  build (see `docs/compliance/EVIDENCE.md`, BACKUP-AND-POINT-IN-TIME-RECOVERY).
- If the pool is saturated: reduce load first by raising `RUNTIME_POOL_MAX`
  only if `max_connections` allows it, and by lowering
  `RATE_LIMIT_MAX` to shed load deliberately. Fast 503s with `Retry-After`
  are better than timeouts.
- If the model provider is the cause: the deterministic path already answers
  correctly without it. Confirm `MODEL_PROVIDER=disabled` as an immediate
  mitigation — risk hints are advisory and the policy engine does not need
  them.

**What NOT to do:** do not raise the error budget to make the alert stop.
The budget is derived from the objective in `packages/observability/src/slos.ts`
and the alert thresholds are generated from it. Changing either to silence a
page defeats the only mechanism that would have told you.

---

## decision-latency

**Fires:** `PermitZeroDecisionLatencyBurn` (ticket). More than 13.44% of
decisions are exceeding the 1.5 s objective.

**What it means:** decisions are being answered, but slowly. The histogram
bucket at exactly 1.5 s exists so this is computed rather than interpolated.

**Check first:**

```bash
$COMPOSE logs --tail=200 api | grep decision_duration
$COMPOSE exec postgres psql -U permitzero -d permitzero -c \
  "SELECT state, count(*) FROM pg_stat_activity GROUP BY state;"
```

**What to do:**

- **Pool saturation first.** The policy evaluation is not usually the
  bottleneck; the tenant transaction that holds a connection is. Every tenant
  transaction holds one connection for the duration of the audit append, and
  the audit chain serialises per tenant.
- **Then the model provider.** With `MODEL_PROVIDER=meta` the decision timer
  includes the provider round trip. Set `MODEL_PROVIDER=disabled` to confirm
  whether the provider is the cause.
- **Then the policy revision.** A policy with many rules, or one with a
  large evidence list, evaluates slower. Check the published revision's rule
  count.

---

## tenant-isolation

**Fires:** `PermitZeroTenantIsolationNotEnforced` (page, fires immediately).
This is a zero-tolerance objective: there is no error budget, because a
single unisolated row is one breach, and a ratio would let one leak hide
inside a million clean requests.

**What it means:** a process is serving tenant traffic on a connection that
row-level security does not constrain. Tenant isolation has silently become
a code convention again, and the convention is not the control.

**This is the most serious page in this file.** Treat every tenant as
potentially able to see every other tenant's data.

**Check first:**

```bash
# What does the running API report?
curl -sk https://permitzero.svalley.tech:8450/health/ready | python3 -m json.tool

# What does the live database say about the role?
$COMPOSE exec postgres psql -U postgres -d permitzero -c \
  "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('permitzero','pz_app');"

# Is the runtime connection actually the restricted one?
$COMPOSE exec api printenv DATABASE_URL_RUNTIME
```

**What to do:**

1. **If `DATABASE_URL_RUNTIME` is unset or equals `DATABASE_URL`:** the API
   is running as the schema owner, which is RLS-exempt by construction. Set
   `DATABASE_URL_RUNTIME=postgres://pz_app:<password>@postgres:5432/permitzero`
   and `PZ_RLS_ROLE_PASSWORD` in `infra/deploy/permitzero.env`, then
   redeploy. The deployment script now refuses to start without these, so
   this specific omission cannot recur silently.
2. **If the role exists but is privileged:** `pz_app` must be
   `NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`. Migration 0006 asserts
   this and aborts if it has drifted. Re-run `npm run db:migrate`.
3. **If a table has lost its policy:** check
   `$COMPOSE exec postgres psql -U postgres -d permitzero -c "SELECT count(*) FROM pg_policies WHERE schemaname='public';"`.
   The DDL event trigger re-applies enforcement to tables created after the
   migration, so a low count means the migration itself did not run.

**Verify before standing down.** The deployment script performs a direct
check — as the runtime role, a query with no tenant context must see zero
rows — and fails the deploy if it does not. That check is the control, not
the configuration.

---

## audit-integrity

**Fires:** `PermitZeroAuditChainBroken` (page, fires immediately). Another
zero-tolerance objective.

**What it means:** the audit hash chain failed verification. Audit events are
the evidence product — the record of what was decided and why. A break means
one of:

- bytes changed after the event was appended,
- a sequence gap (an event is missing), or
- a keyed hash was verified without its key.

**Check first:**

```bash
$COMPOSE exec postgres psql -U permitzero -d permitzero -c \
  "SELECT hash_version, count(*) FROM audit_events GROUP BY 1;"
$COMPOSE exec api printenv AUDIT_HMAC_KEY | head -c 8
```

`hash_version` should be `pz-audit-hmac-v1` on any deployment that has the
key set. `pz-audit-v1` means the chain is hashed with plain SHA-256 rather
than a keyed HMAC — the chain is still internally consistent, but an attacker
who can write to the table can recompute it. That is a configuration
problem, not a break; set `AUDIT_HMAC_KEY` and record the reason.

**What to do:**

1. **Do not delete or repair the chain.** A chain with a break is evidence.
   Preserve it, export it, and explain it.
2. **Export the evidence before touching anything:**
   ```bash
   curl -sk -H "Authorization: Bearer $TOKEN" \
     https://permitzero.svalley.tech:8450/api/v1/evidence/bundle -o evidence.json
   ```
3. **Find the break.** `GET /v1/audit/verify` runs `verifyAuditChain` and
   reports the first sequence gap or hash mismatch, and the tenant it is in.
4. **If the break is a single event in one tenant:** the likely cause is a
   manual `UPDATE` or `DELETE` against `audit_events`. Migration 0002
   installs a trigger that refuses both — check whether it is still present.
5. **If the whole chain fails to verify:** check whether `AUDIT_HMAC_KEY`
   was rotated. A rotated key makes every historical event fail
   verification while the chain is in fact intact. This is why the deploy
   script never rotates that key.

---

## delivery-lag

**Fires:** `PermitZeroOutboxDeliveryStalled` (ticket). Outbox events are
waiting more than 60 s to reach the queue.

**What it means:** decisions are unaffected. This delays the dispatch of side
effects — an action was decided and recorded, but the connector has not been
told about it yet.

**Check first:**

```bash
# How much is waiting, and how old is the oldest?
$COMPOSE exec postgres psql -U permitzero -d permitzero -c \
  "SELECT status, count(*), min(created_at) FROM outbox_events GROUP BY status;"

# Is the worker alive?
$COMPOSE ps worker
$COMPOSE logs --tail=50 worker
```

**What to do:**

- **Redis unreachable.** The dispatcher is bounded now — a dead Redis fails
  fast into the retry path rather than hanging — but it still cannot
  deliver. `redis-cli ping` inside the compose network.
- **The worker is wedged.** Check for a job that never completes. The
  worker's shutdown is bounded, but a stuck job holds the lease.
- **The lease is being exceeded.** A publish that takes longer than the
  60 s lease lets a peer claim the same row, which duplicates the event.
  Check `pz_outbox_events` for the same id appearing twice in the queue.

**Note:** this alert measures the age of the oldest _unpublished outbox row_
in the database. It deliberately does not measure the age of a job in the
queue, because a wedged dispatcher leaves the database rows unpublished
while the queue stays empty — a queue-age signal reads zero exactly when
the problem is worst.

---

## dead-letter

**Fires:** `PermitZeroDeadLetteredEvents` (ticket). An outbox event exhausted
its retries.

**What it means:** nothing will deliver this event automatically. The
decision it represents was recorded, but its side effect never happened.

**Check first:**

```bash
$COMPOSE exec postgres psql -U permitzero -d permitzero -c \
  "SELECT id, event_type, attempts, last_error FROM outbox_events WHERE status='DEAD' ORDER BY created_at DESC LIMIT 20;"
```

**What to do:**

1. **Read `last_error`.** It is the actual failure, not a symptom of one.
2. **Fix the downstream cause first.** Redriving into a broken dependency
   just dead-letters it again and burns the retry budget.
3. **Then redrive.** The worker now calls `redriveFromDlq` on its periodic
   sweep, so an event whose cause has been fixed is picked up
   automatically. For a specific event, use the operator redrive path.

**What NOT to do:** do not mark a DEAD row as PUBLISHED to make the alert
stop. That is a lie in the record of what happened, and it is the one thing
the audit chain exists to make detectable.

---

## model-provider

**Fires:** `PermitZeroModelProviderDegraded` (ticket). Meta Model API
screening is failing or timing out.

**What it means:** the advisory risk-hint signal is unavailable. This is
**degraded advice, not lost authority**. A policy that requires a model
signal returns `REQUIRE_APPROVAL` or `INDETERMINATE` when the signal is
missing — never `ALLOW`. The deterministic core is unaffected.

**Check first:**

```bash
$COMPOSE logs --tail=50 api | grep -i 'model\|breaker'
curl -s http://<api>:3000/metrics | grep pz_model_screenings_total
```

**What to do:**

- **Check the breaker state.** `pz_circuit_breaker_state` reports it. An
  OPEN breaker means the client has already stopped trying and is failing
  fast — which is the correct behaviour, and the fix is below.
- **Check for rate limiting.** A 429 from the provider is retried with
  `Retry-After` and jittered backoff. Sustained 429s mean the key's quota
  is exhausted.
- **Confirm authority is intact.** While the provider is down, decisions
  that need a model signal should be escalating to approval. If you see
  `ALLOW` where a `model.*` rule was required, that is a policy-engine
  defect and a page, not a ticket.

**Why this is only a ticket:** the model advises; the policy decides. A
provider outage must not be able to change what the system authorises.

---

## circuit-breaker

**Fires:** `PermitZeroCircuitBreakerOpen` (ticket). A dependency's circuit
breaker is open.

**What it means:** a dependency has failed enough times that the client has
stopped calling it and is failing fast instead. This is the system working
as designed — the alternative is a slow failure that holds requests open.

**Check first:**

```bash
curl -s http://<api>:3000/metrics | grep pz_circuit_breaker_state
$COMPOSE logs --tail=50 api | grep -i breaker
```

The gauge carries a `dependency` label identifying which one.

**What to do:**

- **Model provider:** see [model-provider](#model-provider).
- **Redis:** the outbox dispatcher cannot deliver. See
  [delivery-lag](#delivery-lag).
- **Postgres:** requests will fail fast rather than hang. See
  [decision-availability](#decision-availability).

**What to do when the dependency recovers:** the breaker transitions
OPEN → HALF_OPEN after its cooldown and closes on the first success, so
there is nothing to reset. If the breaker stays open well past the
cooldown, the client is not being allowed to probe — check the retry
budget and the cooldown configuration.
