# PermitZero — Deployment Model

## 1. Components

- Caddy (TLS, security headers) at the edge.
- `apps/api` (Fastify) — intake, policy, approvals, permits, broker, health.
- `apps/worker` — outbox dispatcher, model-analysis consumer, reconciliation, sweeps, DLQ redrive.
- `apps/web` (Next.js) — operator console.
- PostgreSQL 17 (primary data store; RLS on `pz_app` role).
- Redis (queue / leases / DLQ).
- Meta Model API (optional, opt-in).

## 2. Runtime roles

- Admin role (`DATABASE_URL`) — migrations, seeds.
- Runtime role (`DATABASE_URL_RUNTIME` = `pz_app`) — tenant traffic; RLS-bound;
  non-exempt. Deploy script refuses to start without a runtime URL naming `pz_app`
  and verifies isolation against the live database after rollout.

## 3. Configuration

- `.env` from `.env.example` (names only, no values committed).
- Secrets (`PERMIT_SIGNING_KEY`, `AUDIT_HMAC_KEY`, `DATABASE_URL*`, model keys,
  connector creds) live in env/secret manager only; never in browser bundles or logs.
- `MODEL_ENABLED=false`, `MODEL_PROVIDER=disabled` by default.

## 4. Deployment flow

1. CI green on `main`.
2. Deploy workflow: build, migrate under advisory lock, health check, verify
   isolation from the database.
3. Triggers on CI completion rather than on push, so a commit whose gates are still
   running or have failed is never deployed.

## 5. Health checks

- `GET /health/live` — 200 when process is up.
- `GET /health/ready` — 200 with `{"status":"ready"}` only when DB reachable,
  migrations applied, and RLS enforced on the runtime role; 503 otherwise.
- `GET /v1/status` — tenant status; requires valid bearer token.

## 6. Resilience

- Single region; multi-region failover **absent** (disclosed in LIMITATIONS.md).
- Resilience drill: `npm run drill:resilience` (requires live stack).
- Outbox retains owed events; leased rows are not double-claimed.

## 7. Networking / ports

- API: 3100 (`API_PORT`) / 8080 (`PORT`).
- Web: 3000 (`WEB_PORT`).
- Postgres: 5432.
- Redis: 6379.

## 8. Data and backup

- Encryption at rest of what the application stores, backup with point-in-time
  recovery, and a retention window with legal hold are implemented and cited in
  `docs/compliance/EVIDENCE.md`.
- Synthetic demo data only; `db:seed` refuses to run when `APP_ENV=production`.

## 9. What is NOT deployed/verified here

- No deployment revision, tag, or release exists for this repository.
- The deployed-API claims in README and `docs/compliance/EVIDENCE.md` refer to a
  deployment the maintainer operates; not independently verified in this session.