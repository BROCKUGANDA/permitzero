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

# The env file lives OUTSIDE the tree the deploy is run from, when the
# operator points PZ_STATE_DIR at a persistent location.
#
# The reason is the deployment workflow: it checks the repository out into
# the runner's workspace, and `actions/checkout` removes untracked and
# ignored files — which includes this env file and the `storage/` and `run/`
# directories. A later checkout would therefore erase the permit signing key
# and the audit HMAC key, and the script would generate NEW ones against the
# EXISTING database volume: every previously issued permit would stop
# verifying, and the existing audit chain would stop verifying.
#
# So the durable state has one home, outside the tree, and the tree is a
# copy of the verified commit rather than the place the state lives.
STATE_DIR="${PZ_STATE_DIR:-}"
if [ -n "$STATE_DIR" ]; then
  mkdir -p "$STATE_DIR"
  # Move any state that is still in the tree into its permanent home, once.
  if [ -f "$ENV_FILE" ] && [ ! -f "$STATE_DIR/permitzero.env" ]; then
    cp "$ENV_FILE" "$STATE_DIR/permitzero.env"
    chmod 600 "$STATE_DIR/permitzero.env"
    echo "== moved the env file to $STATE_DIR"
  fi
  if [ -d storage ] && [ ! -d "$STATE_DIR/storage" ]; then
    cp -a storage "$STATE_DIR/storage"
    echo "== moved the runtime state to $STATE_DIR"
  fi
  ENV_FILE="$STATE_DIR/permitzero.env"
  # The compose file reads the env file by this variable, so the services
  # receive the same file the script uses rather than a path relative to the
  # tree.
  export PZ_APP_ENV_FILE="$ENV_FILE"
  COMPOSE="docker compose --env-file $ENV_FILE -f infra/docker-compose.yml"
fi

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

# The env file is sourced by ABSOLUTE path.
#
# It used to be sourced as `"./$ENV_FILE"`, which only works while ENV_FILE is
# relative to the tree. Once PZ_STATE_DIR points the file outside the tree —
# which the deployment workflow always does — that prefix turns an absolute
# path into a relative one, the source fails, and the whole deploy aborts
# under `set -e` before it has built or migrated anything.
ENV_FILE_ABSOLUTE="$ROOT/$ENV_FILE"
case "$ENV_FILE" in
  /*) ENV_FILE_ABSOLUTE="$ENV_FILE" ;;
esac

# shellcheck disable=SC1090
set -a; . "$ENV_FILE_ABSOLUTE"; set +a
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
# The file stays mode 0600 and owned by the deploying user: the containers
# that need it read a COPY staged into a named volume by a one-shot container
# that runs as root inside its own namespace. See the `observability-secrets`
# service in infra/docker-compose.yml for why a bind mount cannot carry these
# permissions into a container that runs as `nobody`.
chmod 600 run/pz_metrics_token
echo "== rendered run/pz_metrics_token ($(wc -c < run/pz_metrics_token) bytes)"

if [ -n "${PZ_ALERT_WEBHOOK_URL:-}" ]; then
  # The URL is substituted into a sed REPLACEMENT, where `&` means "the text
  # that matched" and `\` escapes the next character. A webhook URL
  # containing either would corrupt the rendered config — or make sed fail
  # and take the deployment down with it. So the replacement metacharacters
  # are escaped first.
  #
  # The `|` delimiter is escaped too, because an unescaped `|` would end the
  # sed expression early.
  WEBHOOK_ESCAPED=$(printf '%s' "$PZ_ALERT_WEBHOOK_URL" | sed -e 's/[\\&|]/\\&/g')
  sed "s|__PZ_ALERT_WEBHOOK_URL__|${WEBHOOK_ESCAPED}|g" \
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
  # ONLY this project's own images. The box hosts other people's deployments
  # and their rollback images are not ours to delete — a global
  # `docker image prune -a` would remove every unreferenced image on the
  # daemon, including another project's rollback target, and a global
  # `docker builder prune` would delete every project's build cache.
  #
  # The compose label is what makes the scoping possible: images built by
  # compose carry `com.docker.compose.project`, so the prune below reaches
  # this project and nothing else.
  docker image prune -f --filter "label=com.docker.compose.project=permitzero" >/dev/null 2>&1 || true
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

# --- 3a. the runtime role's password must be the one on the database -------
# The env file names a password for the restricted runtime role. If the role
# ALREADY EXISTS in the database — which is the case on any host that has run
# a previous deploy, and always the case after the upgrade path above wrote a
# fresh password — then the env file and the database disagree, and the API
# cannot log in at all.
#
# Migration 0006 does not repair this: it only alters the role when its
# ATTRIBUTES have drifted, and it runs once, so a password that was set
# correctly at creation is never revisited. The symptom is a readiness check
# that never passes, with the reason buried in the API's log.
#
# So the password is applied explicitly, here, where the database is running.
# This is the one cluster-wide write the deploy performs, and it is
# deliberate: the runtime role's password is a secret this deployment owns,
# and it has to be the one the API presents.
if [ -n "${PZ_RLS_ROLE_PASSWORD:-}" ]; then
  echo "== applying the runtime role's password to the database"
  PW="$PZ_RLS_ROLE_PASSWORD"
  # The character class is the one the migration runner enforces, because the
  # value is substituted into SQL text.
  case "$PW" in
    *[!A-Za-z0-9_.-]*)
      echo "   FAIL: PZ_RLS_ROLE_PASSWORD must match [A-Za-z0-9_.-] (it is substituted into SQL)." >&2
      exit 1
      ;;
  esac
  # format('%L') quotes the value as a SQL literal, so the substitution is
  # safe regardless of the password's content.
  #
  # The failure is FATAL, and it is retried while Postgres finishes starting.
  # This step used to end in `|| true` followed by an unconditional "ok", so a
  # wrong database name, a wrong admin user, or a Postgres that had not yet
  # accepted connections all printed success — and the only symptom was the
  # API failing to log in minutes later. That is exactly the failure this
  # step exists to prevent, so it now reports what actually happened.
  PW_APPLIED=0
  for attempt in 1 2 3 4 5; do
    if $COMPOSE exec -T postgres psql -U "$PZ_PG_USER" -d "$PZ_PG_DB" -v ON_ERROR_STOP=1 -c \
      "DO \$\$ BEGIN
         IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pz_app') THEN
           EXECUTE format('ALTER ROLE pz_app WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD %L', '$PW');
         END IF;
       END \$\$;" 2>&1 | sed 's/^/   /'; then
      PW_APPLIED=1
      break
    fi
    echo "   attempt $attempt: could not reach the database as $PZ_PG_USER; retrying" >&2
    sleep 3
  done
  if [ "$PW_APPLIED" -ne 1 ]; then
    echo "   FAIL: could not apply the runtime role's password." >&2
    echo "         The API would present a password the database does not accept," >&2
    echo "         and would fail to start. Fix the database connection or the" >&2
    echo "         admin credentials before deploying." >&2
    exit 1
  fi
  echo "   ok"
fi

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

# The observability stack is started in the same breath as the config it
# reads. Rendering the Alertmanager configuration and Prometheus scrape token
# and then not starting the containers that consume them leaves the alerting
# path inert while the repository claims it works — which is the state this
# deployment was in before.
#
# It is a compose PROFILE, so it does not start with the core services; it is
# started explicitly here, and only when the deployment has the configuration
# those containers need.
if [ -f run/alertmanager.yml ] && [ -f run/pz_metrics_token ]; then
  echo "== starting the observability stack (prometheus, alertmanager)"
  # The secrets are staged into a named volume FIRST, by a one-shot container
  # that runs as root inside its own namespace. Prometheus and Alertmanager
  # both run as `nobody`, and a bind mount carries the host's ownership into
  # the container — so a file that is mode 0600 and owned by the deploying
  # user is unreadable to them. The deploying user cannot chown it either
  # (it is unprivileged), so the copy is what makes the files readable.
  $COMPOSE --profile observability up -d observability-secrets
  $COMPOSE --profile observability run --rm observability-secrets 2>&1 | sed 's/^/   /'
  $COMPOSE --profile observability up -d prometheus alertmanager
  sleep 8
  $COMPOSE --profile observability ps prometheus alertmanager
  # A container that is restarting has not started. Prometheus and
  # Alertmanager both crash-looped once because their configuration was
  # unreadable, and a crash loop looks like "running" in a status column.
  for svc in prometheus alertmanager; do
    state=$($COMPOSE --profile observability ps -q "$svc" | head -1)
    if [ -n "$state" ]; then
      restarts=$($COMPOSE --profile observability ps --format '{{.Status}}' "$svc" 2>/dev/null | head -1)
      case "$restarts" in
        *Restarting*)
          echo "   FAIL: $svc is crash-looping." >&2
          $COMPOSE --profile observability logs --tail=10 "$svc" 2>&1 | sed 's/^/     /' >&2
          exit 1
          ;;
      esac
    fi
  done
else
  echo "== observability configuration was not rendered; skipping prometheus/alertmanager" >&2
fi

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
#
# FIRST the check must be MEANINGFUL. A deployment that has never served a
# request has an EMPTY audit_events table, and "the runtime role sees zero
# rows" is then trivially true — it proves nothing, because there was nothing
# to hide. So the probe first establishes that there IS a row the role must
# not see: the ADMIN role has to see at least one. Only then does a zero
# count from the runtime role mean anything.
#
# The output is captured WITHOUT piping through `tr` and WITHOUT `|| echo
# "error"`, because under `set -o pipefail` that construction captured the
# whitespace-stripped error TEXT with "error" appended to it — so the error
# branch was unreachable and a connection failure was reported as
# "pz_app sees psql:error:...error audit rows", which is a misleading
# message about row-level security when the real problem was a bad password.
#
# Step 1: is there anything to hide? The admin role is exempt from row-level
# security, so it sees every row. If IT sees none, then "the runtime role
# sees none" is vacuous and the check below would be reporting a pass that
# proves nothing.
ADMIN_VISIBLE=$($COMPOSE exec -T postgres psql -U "$PZ_PG_USER" -d "$PZ_PG_DB" -t -A -c \
  "SELECT count(*) FROM audit_events;" 2>/dev/null | tr -d '[:space:]' || echo "")
if printf '%s' "$ADMIN_VISIBLE" | grep -Eq '^[0-9]+$' && [ "$ADMIN_VISIBLE" -gt 0 ]; then
  echo "   the database holds $ADMIN_VISIBLE audit row(s), so a zero count below is meaningful"
else
  echo "   NOTE: the database holds no audit rows yet, so the zero count below" >&2
  echo "         shows only that there is nothing to leak. Isolation is still" >&2
  echo "         enforced by the policies; this probe cannot prove it until" >&2
  echo "         there is traffic." >&2
fi

# Step 2: the actual probe. The output is captured WITHOUT piping through `tr`
# and WITHOUT `|| echo "error"`, because under `set -o pipefail` that
# construction captured the whitespace-stripped error TEXT with "error"
# appended to it — so the error branch was unreachable and a connection
# failure was reported as "pz_app sees psql:error:...error audit rows", which
# is a misleading message about row-level security when the real problem was a
# bad password.
#
# So the exit status decides the branch, and the value is checked for being a
# number before it is compared to zero.
#
# A probe that CANNOT RUN is a failure, not a warning. The script's contract
# is that it fails the deploy unless it has measured the property — so a
# deploy that could not reach the database must not report success while
# having measured nothing. That is the same reason the workflow's own
# verification step exits non-zero when its probe fails.
if ISOLATION_OUT=$($COMPOSE exec -T postgres psql -U pz_app -d "$PZ_PG_DB" -t -A -c \
  "SELECT count(*) FROM audit_events;" 2>&1); then
  ISOLATION_CHECK=$(printf '%s' "$ISOLATION_OUT" | tr -d '[:space:]')
else
  echo "   FAIL: could not run the isolation probe against the live database" >&2
  printf '         %s\n' "$(printf '%s' "$ISOLATION_OUT" | head -c 300)" >&2
  echo "         This is a connection or authentication problem, NOT a row-level" >&2
  echo "         security failure. Check that pz_app's password matches" >&2
  echo "         PZ_RLS_ROLE_PASSWORD in the env file." >&2
  exit 1
fi

if ! printf '%s' "$ISOLATION_CHECK" | grep -Eq '^[0-9]+$'; then
  echo "   FAIL: the isolation probe returned something that is not a count" >&2
  printf '         %s\n' "$(printf '%s' "$ISOLATION_OUT" | head -c 300)" >&2
  exit 1
fi

if [ "$ISOLATION_CHECK" = "0" ]; then
  echo "   ok: the pz_app role sees 0 audit rows with no tenant context"
else
  echo "   FAIL: the pz_app role sees $ISOLATION_CHECK audit rows with no tenant context." >&2
  echo "         Row-level security is NOT applied to the runtime role." >&2
  exit 1
fi

echo
echo "== api log tail"
$COMPOSE logs --tail=15 api | sed 's/^/   /'
echo "done."
