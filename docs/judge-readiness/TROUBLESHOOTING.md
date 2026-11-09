# PermitZero — Troubleshooting

Cross-OS guidance for the judge workflow in `REPRODUCIBILITY.md`. Only real,
documented failure modes are listed. A failure not listed here should be reported
with the exact command and exit code.

---

## 1. Node / npm

| Symptom | Cause | Fix |
| --- | --- | --- |
| `npm ci` fails on engine | Node < 20 or npm < 10 | Install Node ≥ 20 (nvm / fnm / scoop). |
| `npm ci` fails on lockfile | `package-lock.json` mismatched with working tree | Do not edit lockfile; run `npm install` only if you intend to update deps, then commit both. |
| `npm run typecheck` fails on a workspace | A dependency not installed | Re-run `npm ci` from the repo root. |

## 2. PostgreSQL

| Symptom | Cause | Fix |
| --- | --- | --- |
| `connection refused` on 5432 | Server not started | Start native service (`pg_ctl -D <data> start`) or `docker compose up -d postgres`. |
| `password authentication failed` | Wrong user/password in `DATABASE_URL` | Match `.env` to the seeded superuser; default example uses `permitzero`. |
| `database "permitzero" does not exist` | Migrations not applied on a fresh cluster | Run `npm run db:migrate` (creates schema); or `npm run db:reset` for a full reseed. |
| `npm run db:migrate` hangs | Advisory lock held by a crashed previous run | Wait for lock timeout, or restart Postgres to clear session locks. |
| Server crashes with `0xC0000142` on Windows | Known sandbox/AV interaction with the native Postgres 17 build | Use Docker Desktop (`docker compose up -d postgres`) or WSL2 Postgres. This is an environment limitation, not a repo defect (`INSPECTION.md` INSP-05). |
| Crash recovery runs for minutes | Unclean shutdown left WAL to replay | Let it finish, or `pg_resetwal` on a disposable cluster only. |

## 3. Redis

| Symptom | Cause | Fix |
| --- | --- | --- |
| `ECONNREFUSED 6379` | Redis not running | `redis-server` (native) or `docker compose up -d redis`. The API still serves decisions without Redis; the outbox dispatcher and workers are disabled. |
| `redis-cli` not found | Not installed | Install via scoop/chocolatey (Windows), brew (macOS), or apt (Linux). |

## 4. Ports

| Service | Default | If taken |
| --- | --- | --- |
| API | 3100 (`API_PORT`) / 8080 (`PORT`) | Set `PORT`/`API_PORT` in `.env` and `API_URL` for the demo. |
| Web | 3000 (`WEB_PORT`) | Set `WEB_PORT`. |
| Postgres | 5432 | Set `DATABASE_URL*`. |
| Redis | 6379 | Set `REDIS_URL`. |

Stop any stale process on the port before rerunning; `npm run dev` prints `EADDRINUSE` with the offending port.

## 5. Migrations and seed

| Symptom | Cause | Fix |
| --- | --- | --- |
| `db:seed` refuses to run | `APP_ENV=production` | Seed is blocked in production by design; use a non-production `APP_ENV`. |
| Duplicate seed rows | Seed not idempotent on an older migration set | `npm run db:reset` then `npm run db:seed`. |
| Missing `storage/demo-credentials.json` | Seed did not complete | Re-run `npm run db:seed`; the file is written at the end of seeding. |

## 6. Demo scenario

| Symptom | Cause | Fix |
| --- | --- | --- |
| `demo:scenario` exits non-zero on first step | API not reachable or unexpected decision | Check `API_URL`; ensure stack is up; read the printed step name and received body. |
| Token errors (`401`) | `storage/demo-credentials.json` stale | Re-run `npm run db:seed`. |
| `MODEL_*` errors | Meta provider enabled without credentials | Leave `MODEL_PROVIDER=disabled`, `MODEL_ENABLED=false` (default). |

## 7. Tests

| Symptom | Cause | Fix |
| --- | --- | --- |
| 96 `ECONNREFUSED 5432` failures | Postgres not running | Start Postgres; these are environmental, not assertion failures. |
| DB-dependent suites skipped | `DATABASE_URL_TEST` unset | Set it in `.env` (defaults to `DATABASE_URL` with `_test` suffix). |
| Playwright e2e fails to start | API/web not running | `npm run dev` first, then `npm run test:e2e`. |

## 8. Security / compliance gates

| Symptom | Cause | Fix |
| --- | --- | --- |
| `secret:scan` fails | A secret-shaped string committed | Remove it, rotate the credential, and re-run. |
| `compliance:gate` fails | A claimed control's evidence file/line or test no longer exists | Update `docs/compliance/EVIDENCE.md` to match reality; do not weaken the claim. |
| `audit:gate` fails | Evidence map drift | Regenerate/reconcile per `scripts/audit-gate.mjs`. |

## 9. Docker

| Symptom | Cause | Fix |
| --- | --- | --- |
| Docker daemon not responding | Docker Desktop not started | Start Docker Desktop; or use native Postgres/Redis. |
| `docker compose` not found | Old Docker CLI | Install Docker Compose v2 plugin. |

## 10. Workaround used in this session: PostgreSQL via WSL2

The native Windows PostgreSQL 17 build crashed in this sandbox with `0xC0000142`
after ~2 minutes, and Docker Desktop's daemon was not responding. The full
workflow was completed by installing PostgreSQL 18 + Redis in WSL2 (Ubuntu) and
reaching them over `127.0.0.1:5432` / `6379` via localhost forwarding:

```bash
wsl -d Ubuntu -u root -- bash -c "apt-get install -y postgresql postgresql-contrib redis-server"
wsl -d Ubuntu -u root -- bash -c "sed -i 's/scram-sha-256/trust/g' /etc/postgresql/18/main/pg_hba.conf; pg_ctlcluster 18 main reload"
wsl -d Ubuntu -u root -- bash -c "service redis-server start"
```

Then create role `pz_app` (password `pz_app_dev`) and databases `permitzero` /
`permitzero_test` (see `REPRODUCIBILITY.md`). This is a local workaround, not a
repository change; a judge with a stable native PostgreSQL 17 or Docker does not
need it.

## 11. Known environment limitation (historical, now resolved via workaround)

PostgreSQL 17 could not be stabilized in the sandbox used for this exercise
(`0xC0000142` after ~2 minutes; see `BASELINE.md` §4). Redis is running. Docker
Desktop daemon is not responding. Resolved for verification purposes via the WSL2
workaround in §10 above; all 606 tests, migrations, seed, stack, and demo now pass.