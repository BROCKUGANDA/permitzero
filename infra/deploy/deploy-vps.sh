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

# --- 1. environment --------------------------------------------------------
# Generate the secrets once. Re-running never rotates them, because a rotated
# PERMIT_SIGNING_KEY invalidates issued permits and a rotated AUDIT_HMAC_KEY
# breaks the existing audit hash chain.
if [ ! -f "$ENV_FILE" ]; then
  echo "== generating $ENV_FILE (secrets created, never printed)"
  umask 077
  PG_PW=$(openssl rand -hex 24)
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
REDIS_URL=redis://redis:6379

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

# shellcheck disable=SC1090
set -a; . "./$ENV_FILE"; set +a
HOSTNAME_PZ=$(echo "${PZ_HOSTNAMES}" | cut -d" " -f1)

# --- 2. images -------------------------------------------------------------
if [ "$BUILD" = "1" ]; then
  echo "== building images (api, worker, web, migrate)"
  $COMPOSE build api worker web migrate
fi

# --- 3. data tier + migrations --------------------------------------------
echo "== starting postgres + redis"
$COMPOSE up -d postgres redis
$COMPOSE ps postgres redis

echo "== migrations${SEED:+ + seed}"
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

echo
echo "== api log tail"
$COMPOSE logs --tail=15 api | sed 's/^/   /'
echo "done."
