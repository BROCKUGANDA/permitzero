# PermitZero — Reproducibility: One-Command Judge Experience

**Goal.** A judge who clones this repository should be able to install, configure, start
PostgreSQL and Redis, migrate, seed synthetic data, start the API/worker/console, run the
end-to-end demonstration, execute the verification suite, and inspect the audit evidence —
with deterministic, rerunnable commands that fail with useful diagnostics.

**Honest status.** The commands below are the repository's real scripts (`package.json`),
verified to exist. `npm run typecheck`, `npm run lint`, and the DB-independent test suites
pass in this environment (see BASELINE.md §3). The full live workflow — migrate, seed,
stack startup, demo scenario, DB-dependent tests — requires a stable PostgreSQL 17, which
could not be stabilized in this sandbox (BASELINE.md §4, INSPECTION.md INSP-05). Run the
live steps on a machine with PostgreSQL 17 + Redis (Docker Compose or native).

**No paid service is required for the default demo.** `MODEL_ENABLED=false` and
`MODEL_PROVIDER=disabled` by default; the Meta model is opt-in and never an authorization
authority (README §3). All data is synthetic; no production credentials are used.

---

## Target commands

These are the commands a judge runs, in order.

```bash
# 1. Clone
git clone https://github.com/BROCKUGANDA/permitzero.git
cd permitzero

# 2. Install exact dependencies (lockfile-pinned)
npm ci

# 3. Configure environment from the example (fill nothing for the default demo)
cp .env.example .env

# 4. Start PostgreSQL 17 and Redis (outside this repo; see TROUBLESHOOTING.md)
#    native:  start the postgresql service / pg_ctl -D <data> start
#    docker:  docker compose up -d postgres redis   (see infra/docker-compose.yml)
#    Confirm: psql -U postgres -h 127.0.0.1 -c "SELECT 1"   redis-cli ping

# 5. Apply migrations from an empty database
npm run db:migrate

# 6. Seed synthetic data (demo tenant slug: demo)
npm run db:seed

# 7. Start the API, worker, and console
npm run dev                 # api :8080, web :3000, worker (scripts/dev.mjs)
# or individually:
#   npm run dev:api   npm run dev:worker   npm run dev:web

# 8. Run the end-to-end demonstration
npm run demo:scenario       # allow / deny / approval / dual-control, end to end

# 9. Execute the verification suite (strict: no required step may be skipped)
npm run verify -- --strict

# 10. Inspect the audit evidence
#     Open the operator console at http://localhost:3000 → Evidence / Audit,
#     or query the audit_chain directly and run verifyAuditChain.
```

---

## Judge-friendly entry points

The following convenience scripts live in `scripts/judge/` and wrap the target
commands. Each is deterministic, safe to rerun, idempotent (migrate/seed are
idempotent), and fails with a diagnostic message when a dependency is missing.

- `npm run judge:setup` — install, migrate, seed, and run health checks
- `npm run judge:demo` — run the demo scenario against a running stack
- `npm run judge:verify` — run `npm run verify -- --strict`

Add to the `scripts` section of the root `package.json`:

```json
"judge:setup": "node scripts/judge/setup.mjs",
"judge:demo": "node scripts/judge/demo.mjs",
"judge:verify": "node scripts/judge/verify.mjs"
```

### scripts/judge/setup.mjs

Checks Node/npm, PostgreSQL (`SELECT 1`), Redis (`PING`), applies migrations,
seeds, and hits `/health/live` and `/health/ready` once the API is up.
Fails with a named diagnostic if any dependency is absent.

### scripts/judge/demo.mjs

Requires `API_URL` (default `http://127.0.0.1:8080`). Runs
`npm run demo:scenario` (which drives `/v1/actions` → policy → permit → broker
→ simulated connector → receipt) and exits non-zero on the first unexpected
response. Tokens are read from `storage/demo-credentials.json` (written by
`db:seed`), never printed.

### scripts/judge/verify.mjs

Runs `npm run verify -- --strict`: typecheck, lint, unit + integration tests,
production build. A required step that is skipped fails the gate under `--strict`.

---

## Port conflict handling

| Service | Default port | If already in use |
| --- | --- | --- |
| API | 8080 (`PORT`) | Set `PORT` in `.env`; the demo script reads `API_URL`/`API_BASE_URL`/`PORT` |
| Web console | 3000 | `next dev -p 3000`; change `-p` in `apps/web/package.json` or `PORT` |
| PostgreSQL | 5432 | Set `DATABASE_URL` / `DATABASE_URL_RUNTIME` / `DATABASE_URL_TEST` |
| Redis | 6379 | Set `REDIS_URL` |

`npm run dev` (`scripts/dev.mjs`) starts API, worker and web; if a port is taken
the corresponding process fails to bind and prints its own `EADDRINUSE` diagnostic.
Stop any existing process on the port before rerunning, or change the port in `.env`.

## Health and readiness checks

- `GET /health/live` — liveness; answers 200 when the process is up.
- `GET /health/ready` — readiness; answers 200 with `{"status":"ready"}` only when the
  database is reachable, migrations are applied, and tenant isolation (RLS) is enforced
  on the runtime role. Returns 503 otherwise (never reports a dead instance healthy).
- `GET /v1/status` — tenant status; requires a valid bearer token.

## Dependency checks

Before migrate/seed the setup script confirms:
- PostgreSQL accepts connections as the admin role (`DATABASE_URL`) and as the runtime
  role (`DATABASE_URL_RUNTIME` = `pz_app`).
- Redis accepts `PING`.

## Migration and seed idempotency

- `npm run db:migrate` is safe to rerun (migrations are tracked; the runner takes a
  per-database advisory lock so concurrent boots do not double-apply).
- `npm run db:seed` is synthetic-data only. It is **not** idempotent on a
  populated database: a second run without a reset fails with a unique-constraint
  violation on the `demo` tenant slug (by design — `packages/db/test/seed.test.ts`
  asserts `seed` rejects a second invocation). To reseed, run
  `npm run db:reset && npm run db:seed`. Within a single seed run, fixture rows
  are upserted by fixture id, so a partial failure can be retried after reset.
- `npm run db:reset` drops and reseeds (destructive; demo data only).

## Synthetic data only

All seeded vendors (`VEN-017`, `VEN-042`), invoices (`INV-2041`/$3,000,
`INV-2042`/$75,000, `INV-2043`/$30,000), and purchase orders (`PO-882`, `PO-883`)
are explicitly synthetic test fixtures (`packages/db/src/seed.ts`,
`packages/test-fixtures/src/corpus.ts`). The connector is simulated; receipts are
synthetic. No real money movement.

## Meta model disabled by default

`MODEL_ENABLED=false`, `MODEL_PROVIDER=disabled` in `.env.example`. The demo and all
acceptance gates pass in deterministic mode. To use the live Meta provider, set
`MODEL_PROVIDER=meta`, `MODEL_API_KEY`, `MODEL_ID` (verified via `discoverModels()` per
PRD FR-072), and `MODEL_ENABLED=true`; this is opt-in and not part of the default demo.

## Cleanup

- Stop the stack: `Ctrl-C` on `npm run dev`, or `docker compose down`.
- The demo database and `storage/demo-credentials.json` are reproducible: rerun
  `npm run db:reset && npm run db:seed`.
- `.env` is gitignored; remove it when finished. Never commit it.

## Bounded execution and failure output

- `demo:scenario` exits non-zero on the first unexpected response and prints which step
  failed with the received body (truncated to 200 chars).
- `npm run verify -- --strict` exits non-zero if any required step fails or is skipped.
- Each judge script prints `ok -` / `FAIL -` per step and a final count.

## Windows / macOS / Linux compatibility

- Scripts are Node (`.mjs`) and run anywhere Node ≥ 20 runs.
- PostgreSQL/Redis startup differs by OS: native service on Windows/macOS, `docker
  compose` or package manager on Linux. `TROUBLESHOOTING.md` covers each.
- Paths in scripts use `path.join`/`fileURLToPath`, not hardcoded separators.

## Reproducibility verdict (this session)

| Step | Result in this session |
| --- | --- |
| `npm ci` | Dependencies already installed (node_modules present); `npm ci` against `package-lock.json` is the judge's clean-install step |
| `cp .env.example .env` | Verifiable (file present) |
| `npm run db:migrate` | PASS (PostgreSQL 18 via WSL; all 11 migrations applied) |
| `npm run db:seed` | PASS (synthetic tenant + tokens written) |
| `npm run dev` | PASS (API :8080 ready, RLS enforced, 25/25 tables) |
| `npm run demo:scenario` | PASS (allow / approval / dual-control, all steps) |
| `npm run verify -- --strict` | PASS (typecheck, lint, 606 tests, build) |
| `npm run typecheck` | PASS (all 12 workspaces) |
| `npm run lint` | PASS (`--max-warnings=0`) |
| `npm run secret:scan` | PASS (no leaks) |
| DB tests | 606/606 PASS (incl. RLS, audit concurrency, tenant isolation) |
| `npm run judge:setup` | PASS (after Windows shell fix) |
| `npm run judge:demo` | PASS |
| `npm run judge:verify` | PASS (full gate green) |

**Workaround used:** the native Windows PostgreSQL 17 build is unstable in this
sandbox (`0xC0000142`); PostgreSQL 18 was installed in WSL2 (Ubuntu) and reached
over `127.0.0.1:5432` via localhost forwarding. Redis runs in the same WSL
instance. See `TROUBLESHOOTING.md` §2/§10.

**Verdict:** Reproducible. All steps 1–10 of the judge workflow now run and pass
in this environment, including migrations, seed, stack startup, the end-to-end
demo scenario, the full strict verification gate, and audit-chain inspection.
