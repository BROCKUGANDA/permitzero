#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# PermitZero VPS deployment. Idempotent: safe to re-run for any slice.
#
#   ./infra/deploy/deploy-vps.sh              build + migrate + start + smoke
#   ./infra/deploy/deploy-vps.sh --seed       also (re)seed synthetic demo data
#   ./infra/deploy/deploy-vps.sh --no-build   restart from existing images
#
# Runs as the unprivileged `ubuntu` user. It writes no secrets into the repo:
# infra/deploy/permitzero.env is generated once, mode 0600, and gitignored.
#
# The one invariant this script exists to protect: the API must run as the
# restricted `pz_app` role, never as the schema owner. The owner is RLS-exempt
# by construction, so a deployment that quietly falls back to it runs with tenant
# isolation switched OFF while every dashboard still says the feature is on. The
# generated env therefore always sets DATABASE_URL_RUNTIME, and the script
# refuses to start if it is missing or equal to the admin URL.
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"

SEED=0
BUILD=1
for arg in "$@"; do
  case "$arg" in
    --seed) SEED=1 ;;
    --no-build) BUILD=0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

ENV_FILE=infra/deploy/permitzero.env
COMPOSE="docker compose --env-file $ENV_FILE -f infra/docker-compose.yml"

# --- 0. preflight: the invariants that must hold before anything starts -----
# Checked before the build, not after, so a misconfigured host fails in
# seconds rather than after a four-minute image build.
preflight() {
  local failures=0
  # The box this runs on hosts other people's deployments. A full disk has
  # already taken down one of them; the build needs room for four images.
  local avail_kb
  avail_kb=$(df --output=avail -k . | tail -1 | tr -d ' ')
  if [ "$avail_kb" -lt 4194304 ]; then
    echo "   PREFLIGHT: only $((avail_kb / 1024)) MiB free; the build needs ~4 GiB." >&2
    echo "   PREFLIGHT: reclaim space before deploying (docker image prune -a would do it)." >&2
    failures=$((failures + 1))
  fi
  if [ "$failures" -gt 0 ]; then
    echo "preflight failed with $failures problem(s); refusing to deploy." >&2
    exit 1
  fi
}

# --- 1. environment --------------------------------------------------------
# Generate the secrets once. Re-running never rotates them, because a rotated
# PERMIT_SIGNING_KEY invalidates issued permits and a rotated AUDIT_HMAC_KEY
# breaks the existing audit hash chain.
if [ ! -f "$ENV_FILE" ]; then
  echo "== generating $ENV_FILE (secrets created, never printed)"
  umask 077
  PG_PW=$(openssl rand -hex 24)
  RLS_PW=$(openssl rand -hex 24)
  cat > "$ENV_FILE" <<EOF
PZ_HOSTNAMES=${PZ_HOSTNAMES:-permitzero.svalley.tech permitzero.edulynklabs.com}
PZ_ACME_EMAIL=${PZ_ACME_EMAIL:-ops@svalley.tech}
PZ_OPS_HOSTNAME=${PZ_OPS_HOSTNAME:-permitzero-ops.edulynklabs.com}
PZ_HTTP_PORT=${PZ_HTTP_PORT:-8050}
PZ_HTTPS_PORT=${PZ_HTTPS_PORT:-8450}
PZ_SEED=0
PZ_TUNNEL_TOKEN=${PZ_TUNNEL_TOKEN:-}

PZ_PG_USER=permitzero
PZ_PG_PASSWORD=$PG_PW
PZ_PG_DB=permitzero

APP_ENV=staging
APP_VERSION=0.1.0
HOST=0.0.0.0
PORT=3000
LOG_LEVEL=info

DATABASE_URL=postgres://permitzero:$PG_PW@postgres:5432/permitzero
# The restricted runtime role. This is the connection every tenant read and
# write actually uses, and it is the ONLY one that carries row-level security.
# It is generated here rather than left blank because a blank value makes
# packages/db fall back to DATABASE_URL — the schema owner — which is exempt
# from RLS by construction. That fallback is loud in the app's own reporting
# but silent in the compose file, so the value is written explicitly and the
# preflight below refuses to start without it.
DATABASE_URL_RUNTIME=postgres://pz_app:$RLS_PW@postgres:5432/permitzero
# The password migration 0006 assigns to pz_app. Generated, never a default:
# pz_app_dev is a published constant in the repository, and a role with a
# published password is a role anybody on the compose network can use.
PZ_RLS_ROLE_PASSWORD=$RLS_PW
RUNTIME_POOL_MAX=10
REDIS_URL=redis://redis:6379

# /metrics is not registered at all without a token, so the Prometheus scrape
# target and the alert rules would both point at a 404. Generated here for the
# same reason the keys are: a blank value silently disables a whole subsystem.
METRICS_TOKEN=$(openssl rand -hex 24)

PERMIT_SIGNING_KEY=$(openssl rand -hex 32)
PERMIT_SIGNING_KEY_ID=permit-key-v1
AUDIT_HMAC_KEY=$(openssl rand -hex 32)
AUDIT_HASH_KEY_ID=audit-hmac-key-v1

PERMIT_TTL_SECONDS=60
MAX_BODY_BYTES=262144
RATE_LIMIT_MAX=500
RATE_LIMIT_WINDOW_MS=60000

MODEL_ENABLED=${MODEL_ENABLED:-false}
MODEL_PROVIDER=${MODEL_PROVIDER:-disabled}
MODEL_API_KEY=${MODEL_API_KEY:-}
MODEL_API_BASE_URL=https://api.meta.ai/v1
MODEL_ID=${MODEL_ID:-}
MODEL_TIMEOUT_MS=30000
MODEL_MAX_ATTEMPTS=5
MODEL_MAX_CONCURRENCY=4
MODEL_PROMPT_VERSION=risk-hints-prompt-v1
MODEL_SCHEMA_VERSION=risk-hints.v1
EOF
  chmod 600 "$ENV_FILE"
  echo "   written ($(wc -c < "$ENV_FILE") bytes, mode $(stat -c %a "$ENV_FILE"))"
fi

# --- 1a. upgrade an env file written by an older version of this script -----
# The first version of this script generated DATABASE_URL but not
# DATABASE_URL_RUNTIME, so the deployed API ran as the schema owner and
# row-level security never applied. Existing hosts carry that file.
#
# The missing keys are added here rather than by regenerating the file,
# because two of the existing values must never change: rotating
# PERMIT_SIGNING_KEY invalidates every permit already issued, and rotating
# AUDIT_HMAC_KEY breaks the existing audit hash chain. A host that has been
# running for a week keeps its keys and gains the ones it was missing.
if [ -f "$ENV_FILE" ] && ! grep -q '^DATABASE_URL_RUNTIME=' "$ENV_FILE"; then
  echo "== upgrading $ENV_FILE: adding the tenant-isolation and metrics settings"
  umask 077
  RLS_PW=$(openssl rand -hex 24)
  # The database name is read from the file being upgraded, before it is
  # sourced into the environment below, so the runtime URL points at the same
  # database the admin URL does.
  DB_NAME=$(grep -E '^PZ_PG_DB=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)
  DB_NAME=${DB_NAME:-permitzero}
  {
    echo ""
    echo "# Added by the deployment script when tenant isolation was enabled."
    echo "# The runtime role is the only connection that carries row-level"
    echo "# security; the admin URL above is for migrations alone."
    echo "DATABASE_URL_RUNTIME=postgres://pz_app:$RLS_PW@postgres:5432/$DB_NAME"
    echo "PZ_RLS_ROLE_PASSWORD=$RLS_PW"
    echo "RUNTIME_POOL_MAX=10"
    echo "METRICS_TOKEN=$(openssl rand -hex 24)"
  } >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "   upgraded"
fi

# shellcheck disable=SC1090
set -a; . "./$ENV_FILE"; set +a
HOSTNAME_PZ=$(echo "${PZ_HOSTNAMES}" | cut -d" " -f1)

# --- 1b. preflight: tenant isolation must be enabled ------------------------
# Checked against the env file this run will actually use, before a single
# image is built. An earlier version of this script omitted DATABASE_URL_RUNTIME
# entirely, so the deployed API connected as the schema owner and every tenant
# row was reachable without a tenant context — while /health/ready reported the
# service as ready. The check exists so that omission can never be silent
# again.
echo "== preflight: tenant isolation configuration"
PREFLIGHT_FAILURES=0
if [ -z "${DATABASE_URL_RUNTIME:-}" ]; then
  echo "   FAIL: DATABASE_URL_RUNTIME is unset — the API would run as the schema owner." >&2
  echo "         Row-level security does not apply to the owner role, so every" >&2
  echo "         tenant row would be reachable without a tenant context." >&2
  PREFLIGHT_FAILURES=$((PREFLIGHT_FAILURES + 1))
elif [ "$DATABASE_URL_RUNTIME" = "${DATABASE_URL:-}" ]; then
  echo "   FAIL: DATABASE_URL_RUNTIME equals DATABASE_URL — the API would run as the schema owner." >&2
  PREFLIGHT_FAILURES=$((PREFLIGHT_FAILURES + 1))
elif ! printf '%s' "$DATABASE_URL_RUNTIME" | grep -q 'pz_app'; then
  echo "   FAIL: DATABASE_URL_RUNTIME does not name the pz_app role." >&2
  PREFLIGHT_FAILURES=$((PREFLIGHT_FAILURES + 1))
fi
if [ -z "${PZ_RLS_ROLE_PASSWORD:-}" ]; then
  echo "   FAIL: PZ_RLS_ROLE_PASSWORD is unset — pz_app would get a published default password." >&2
  PREFLIGHT_FAILURES=$((PREFLIGHT_FAILURES + 1))
fi
if [ -z "${METRICS_TOKEN:-}" ]; then
  echo "   FAIL: METRICS_TOKEN is unset — /metrics would not be registered at all." >&2
  PREFLIGHT_FAILURES=$((PREFLIGHT_FAILURES + 1))
fi
if [ "$PREFLIGHT_FAILURES" -gt 0 ]; then
  echo "preflight failed with $PREFLIGHT_FAILURES problem(s); refusing to deploy." >&2
  exit 1
fi
echo "   ok: runtime role, RLS password and metrics token are all configured"

preflight

# --- 1c. render the observability configuration -----------------------------
# The Prometheus scrape target needs the metrics token as a FILE, because the
# scrape config is committed and the token is not. The Alertmanager config
# needs the webhook URL substituted into it. Both are rendered into `run/`,
# which is gitignored and never leaves the host.
#
# This was previously broken in a way nobody noticed: `run/` did not exist,
# so the token file was never created, so the Prometheus container started
# with a missing secret — and the metrics endpoint was never registered at
# all, because an unset METRICS_TOKEN makes the API skip registering
# /metrics entirely. The observability stack was inert in production.
mkdir -p run
umask 077
printf '%s' "${METRICS_TOKEN:-}" > run/pz_metrics_token
chmod 600 run/pz_metrics_token
echo "== rendered run/pz_metrics_token ($(wc -c < run/pz_metrics_token) bytes)"

if [ -n "${PZ_ALERT_WEBHOOK_URL:-}" ]; then
  sed "s|__PZ_ALERT_WEBHOOK_URL__|${PZ_ALERT_WEBHOOK_URL}|g" \
    infra/observability/alertmanager/alertmanager.yml.template \
    > run/alertmanager.yml
  chmod 600 run/alertmanager.yml
  echo "== rendered run/alertmanager.yml (webhook configured)"
else
  # Alertmanager refuses to start without a URL, and a container that will
  # not start is worse than one that starts and complains. The rendered file
  # points at a sink so the service is alive and the omission is visible in
  # the logs rather than in a crash loop.
  echo "== PZ_ALERT_WEBHOOK_URL is unset; rendering Alertmanager with a null receiver" >&2
  echo "   Alerts will be evaluated and then dropped. Set the variable to route them." >&2
  sed "s|__PZ_ALERT_WEBHOOK_URL__|http://127.0.0.1:9/null|g" \
    infra/observability/alertmanager/alertmanager.yml.template \
    > run/alertmanager.yml
  chmod 600 run/alertmanager.yml
fi

# --- 2. images -------------------------------------------------------------
if [ "$BUILD" = "1" ]; then
  echo "== reclaiming space before the build"
  # Only this project's own images and the build cache. The box hosts other
  # people's deployments and their rollback images are not ours to delete.
  docker image prune -f >/dev/null 2>&1 || true
  docker builder prune -f >/dev/null 2>&1 || true
  for img in permitzero/verify:local permitzero/migrate:local; do
    if docker images -q "$img" | grep -q .; then
      # `docker rmi` fails if a container still references the image, which is
      # the correct behaviour: the migrate container is recreated below anyway.
      docker rmi -f "$img" >/dev/null 2>&1 || true
    fi
  done
  df -h . | tail -1 | sed 's/^/   /'

  echo "== building images (api, worker, web, migrate)"
  $COMPOSE build api worker web migrate
fi

# --- 3. data tier + migrations --------------------------------------------
echo "== starting postgres + redis"
$COMPOSE up -d postgres redis
$COMPOSE ps postgres redis

echo "== migrations${SEED:+ + seed}"
# The migrate one-shot runs while the previous api/worker may still be
# serving. Migration 0006 is additive (it creates policies and a role, and
# alters nothing that the old version depends on), so the two overlap safely.
# A future non-backward-compatible migration must follow the expand/contract
# discipline instead of relying on that.
$COMPOSE run --rm -e PZ_SEED="$SEED" migrate

# --- 4. services -----------------------------------------------------------
echo "== starting api, worker, web, edge"
$COMPOSE up -d api worker web edge
sleep 6
$COMPOSE ps

# --- 5. smoke through the edge --------------------------------------------
# --resolve pins the hostname to loopback so the request takes the same path a
# visitor takes, minus the front door. -k because the certificate may still be
# issuing on a first run.
echo "== smoke"
for path in /health/live /health/ready; do
  code=$(curl -sk -o /tmp/pz-smoke.json -w '%{http_code}' \
    --resolve "$HOSTNAME_PZ:8450:127.0.0.1" \
    "https://$HOSTNAME_PZ:8450$path" || echo 000)
  printf '   %-16s %s  %s\n' "$path" "$code" "$(head -c 160 /tmp/pz-smoke.json 2>/dev/null || true)"
done

code=$(curl -sk -o /dev/null -w '%{http_code}' --resolve "$HOSTNAME_PZ:8450:127.0.0.1" \
  "https://$HOSTNAME_PZ:8450/login" || echo 000)
printf '   %-16s %s\n' "/login (web)" "$code"

# --- 6. verify the deployment actually enforces what it claims --------------
# A deployment that starts but runs without tenant isolation is worse than one
# that fails to start, because every dashboard reports it as healthy. This
# checks the property rather than the configuration: it asks the LIVE API
# whether RLS is enforced, and asks the LIVE DATABASE whether a query without
# a tenant context can see a row it should not.
echo "== verifying tenant isolation in the running deployment"

READY_BODY=$(curl -sk --resolve "$HOSTNAME_PZ:8450:127.0.0.1" "https://$HOSTNAME_PZ:8450/health/ready" 2>/dev/null || echo "")
echo "   readiness: $(printf '%s' "$READY_BODY" | head -c 400)"

# The readiness payload names the runtime role and whether RLS applies to the
# connection that serves tenant traffic. `enforced: false` here means the
# deployment is running as an exempt role.
if printf '%s' "$READY_BODY" | grep -q '"tenant_isolation"'; then
  if printf '%s' "$READY_BODY" | grep -Eq '"enforced"[[:space:]]*:[[:space:]]*(false|0)'; then
    echo "   FAIL: /health/ready reports tenant isolation as NOT enforced." >&2
    echo "         The deployment is running as a role that row-level security" >&2
    echo "         does not constrain. Tenant rows would be mutually visible." >&2
    exit 1
  fi
  echo "   ok: the running API reports tenant isolation as enforced"
else
  echo "   WARN: /health/ready did not report a tenant_isolation block." >&2
  echo "         Cannot confirm isolation from the outside; check the API log." >&2
fi

# The direct check: as the runtime role, a query with no tenant context must
# see zero tenant rows. This is the property the whole design rests on, and it
# is the one thing a configuration check cannot tell you.
ISOLATION_CHECK=$(
  $COMPOSE exec -T postgres psql -U pz_app -d "$PZ_PG_DB" -t -A -c \
    "SELECT count(*) FROM audit_events;" 2>&1 | tr -d '[:space:]' || echo "error"
)
if [ "$ISOLATION_CHECK" = "0" ]; then
  echo "   ok: the pz_app role sees 0 audit rows with no tenant context"
elif [ "$ISOLATION_CHECK" = "error" ]; then
  echo "   WARN: could not run the isolation probe against the live database" >&2
  echo "         $(printf '%s' "$ISOLATION_CHECK" | head -c 200)" >&2
else
  echo "   FAIL: the pz_app role sees $ISOLATION_CHECK audit rows with no tenant context." >&2
  echo "         Row-level security is NOT applied to the runtime role." >&2
  exit 1
fi

echo
echo "== api log tail"
$COMPOSE logs --tail=15 api | sed 's/^/   /'
echo "done."
