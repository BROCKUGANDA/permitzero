#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# PermitZero — restore drill.
#
#   ./infra/deploy/restore-drill.sh
#
# A backup that has never been restored is not a backup. It is a file that
# looks like a safety net, and the difference between the two is only
# discovered at the moment somebody needs it. This script is that difference,
# made routine:
#
#   1. take a fresh base backup of the LIVE database;
#   2. write a MARKER into a scratch table and note when;
#   3. force a WAL switch and wait for the segment to reach the archive;
#   4. restore the backup into a SEPARATE, TEMPORARY container, replaying the
#      archived WAL up to a recovery target AFTER the marker;
#   5. assert the restored database contains the marker — which is only
#      possible if the restore really did replay the WAL past the point the
#      marker was written — and that its schema and row counts are sane;
#   6. tear the temporary container down and exit non-zero if anything failed.
#
# It NEVER touches the production container: the restore runs in its own
# container, with its own name, its own data directory and its own port. The
# production database is only READ from, plus the one marker row the drill
# writes and then removes.
#
# The marker is the whole point. A restore that merely comes up proves that
# the files were readable; it does not prove that the WAL was replayed, and a
# backup whose WAL cannot be replayed recovers to the moment the backup was
# taken and no later. The marker is written AFTER the backup, so its presence
# in the restored copy can only come from replayed WAL.
#
# Exit code is non-zero if any step fails, so this can be a gate and a cron
# job that pages somebody.
#
#   drill: restore the backup into a temporary container
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"

STATE_DIR="${PZ_STATE_DIR:-}"
ENV_FILE="infra/deploy/permitzero.env"
if [ -n "$STATE_DIR" ]; then
  ENV_FILE="$STATE_DIR/permitzero.env"
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "drill: no env file at $ENV_FILE; there is nothing to restore." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

COMPOSE="docker compose --env-file $ENV_FILE -f infra/docker-compose.yml"
BACKUP_ROOT="${PZ_BACKUP_ROOT:-$ROOT/backups}"
export PZ_BACKUP_ROOT="$BACKUP_ROOT"

# The temporary container. A name of its own, a port of its own, a data
# directory of its own — so that nothing the drill does can be mistaken for
# something the deployment did, and nothing the deployment does can be
# mistaken for something the drill did.
DRILL_NAME="pz-restore-drill-$$"
DRILL_PORT="${PZ_RESTORE_DRILL_PORT:-55432}"
DRILL_DATA=""
MARKER="restore-drill-$(date -u +%Y%m%dT%H%M%SZ)-$$"

log() { printf 'drill: %s\n' "$*"; }
fail() {
  printf 'drill: FAIL: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  status=$?
  # The container first: a restored database left running is a database
  # somebody could connect to.
  docker rm -f "$DRILL_NAME" >/dev/null 2>&1 || true
  if [ -n "$DRILL_DATA" ] && [ -d "$DRILL_DATA" ]; then
    rm -rf "$DRILL_DATA" || true
  fi
  # The scratch table. The marker is evidence DURING the drill; afterwards it
  # is litter in the production schema.
  $COMPOSE exec -T postgres psql -U "$PZ_PG_USER" -d "$PZ_PG_DB" -q \
    -c 'DROP TABLE IF EXISTS pz_restore_drill_marker' >/dev/null 2>&1 || true
  if [ "$status" -ne 0 ]; then
    printf 'drill: FAILED (exit %s)\n' "$status" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

# --- 0. preflight ----------------------------------------------------------
log "preflight"
$COMPOSE ps postgres >/dev/null 2>&1 || fail "the postgres service is not running; start the stack first."
if ! $COMPOSE exec -T postgres pg_isready -U "$PZ_PG_USER" -d "$PZ_PG_DB" >/dev/null 2>&1; then
  fail "the database is not accepting connections."
fi
[ -d "$BACKUP_ROOT/wal" ] || fail "no WAL archive at $BACKUP_ROOT/wal."
[ -d "$BACKUP_ROOT/base" ] || fail "no base backup directory at $BACKUP_ROOT/base."

# The archive has to be actually archiving, or the drill would "prove" a
# recovery that only ever replayed the WAL bundled inside the backup.
ARCHIVE_COUNT=$(find "$BACKUP_ROOT/wal" -maxdepth 1 -name '0*' -type f 2>/dev/null | wc -l | tr -d '[:space:]')
log "   $ARCHIVE_COUNT archived WAL segment(s)"

# --- 1. a fresh base backup ------------------------------------------------
log "taking a base backup"
"$ROOT/infra/deploy/backup.sh"

STAMP=$($COMPOSE exec -T --user root postgres sh -c 'cat /var/lib/postgresql/base-backups/LATEST' | tr -d '[:space:]')
[ -n "$STAMP" ] || fail "the backup script did not record which backup it took."
BACKUP_DIR="$BACKUP_ROOT/base/$STAMP"
[ -f "$BACKUP_DIR/base.tar.gz" ] || fail "no base.tar.gz in $BACKUP_DIR."
log "   backup $STAMP"

# The counts the restored copy is compared against. Taken now, so the
# comparison is "the restored copy holds at least what the backup held, and
# no more than the live database holds" — a range, not a single number.
PROD_AUDIT_NOW=$($COMPOSE exec -T postgres psql -U "$PZ_PG_USER" -d "$PZ_PG_DB" -tAc \
  'SELECT count(*) FROM audit_events' | tr -d '[:space:]')
PROD_TABLES_NOW=$($COMPOSE exec -T postgres psql -U "$PZ_PG_USER" -d "$PZ_PG_DB" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" | tr -d '[:space:]')
log "   live database: $PROD_AUDIT_NOW audit row(s), $PROD_TABLES_NOW table(s)"

# --- 2. the marker ---------------------------------------------------------
# Written AFTER the backup, so it can only be in the restored copy if the
# archived WAL was replayed.
log "writing the marker"
$COMPOSE exec -T postgres psql -U "$PZ_PG_USER" -d "$PZ_PG_DB" -v ON_ERROR_STOP=1 -q <<SQL
CREATE TABLE IF NOT EXISTS pz_restore_drill_marker (
  marker     text PRIMARY KEY,
  written_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO pz_restore_drill_marker (marker) VALUES ('$MARKER');
SQL

MARKER_TIME=$($COMPOSE exec -T postgres psql -U "$PZ_PG_USER" -d "$PZ_PG_DB" -tAc \
  "SELECT to_char(written_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') || '+00'
     FROM pz_restore_drill_marker WHERE marker = '$MARKER'" | tr -d '[:space:]')
[ -n "$MARKER_TIME" ] || fail "the marker row was not written."

# The recovery target is AFTER the marker's commit time, so the recovery
# replays past it and the marker is inside the restored copy. Two seconds of
# margin: the marker's `written_at` is taken when the row is written and the
# commit happens after it.
TARGET_TIME="$(date -u -d "$MARKER_TIME +2 seconds" '+%Y-%m-%d %H:%M:%S.%3N+00' 2>/dev/null || echo "$MARKER_TIME")"
log "   marker written at $MARKER_TIME; recovery target $TARGET_TIME"

# --- 3. the WAL, forced and archived ---------------------------------------
# A segment is only archived when it fills up, so an idle database would
# leave the marker sitting in a WAL nobody had written down yet. Switching
# forces the segment out.
SEGMENT=$($COMPOSE exec -T postgres psql -U "$PZ_PG_USER" -d "$PZ_PG_DB" -tAc \
  'SELECT pg_walfile_name(pg_switch_wal())' | tr -d '[:space:]')
log "   switched WAL; waiting for $SEGMENT to reach the archive"
for _ in $(seq 1 60); do
  if [ -f "$BACKUP_ROOT/wal/$SEGMENT" ]; then
    break
  fi
  sleep 1
done
[ -f "$BACKUP_ROOT/wal/$SEGMENT" ] || fail "the WAL segment $SEGMENT never reached the archive."

# --- 4. the restore --------------------------------------------------------
log "restoring into a temporary container"
DRILL_DATA="$(mktemp -d "${TMPDIR:-/tmp}/pz-restore-drill.XXXXXX")"

# Lay the backup down. Root inside the container, because the tarball's
# contents belong to the postgres user and the entrypoint of the NEXT
# container is what fixes the ownership.
docker run --rm --network none \
  -v "$DRILL_DATA:/var/lib/postgresql/data" \
  -v "$BACKUP_DIR:/backup:ro" \
  postgres:16-alpine \
  sh -c 'set -e
    tar -xzf /backup/base.tar.gz -C /var/lib/postgresql/data
    if [ -f /backup/pg_wal.tar.gz ]; then
      tar -xzf /backup/pg_wal.tar.gz -C /var/lib/postgresql/data/pg_wal
    fi
    rm -f /var/lib/postgresql/data/postgresql.auto.conf
  ' || fail "could not unpack the backup."

# The recovery configuration. Written from the host, because the host is the
# only place the target time and the archive path are known; the file is
# removed first because the backup carries its own copy, owned by root.
cat > "$DRILL_DATA/postgresql.auto.conf" <<CONF
restore_command = 'cp /wal-archive/%f %p'
recovery_target_time = '$TARGET_TIME'
recovery_target_inclusive = on
recovery_target_action = 'promote'
CONF
touch "$DRILL_DATA/recovery.signal"

docker run -d --name "$DRILL_NAME" \
  -p "127.0.0.1:${DRILL_PORT}:5432" \
  -v "$DRILL_DATA:/var/lib/postgresql/data" \
  -v "$BACKUP_ROOT/wal:/wal-archive:ro" \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=drill \
  postgres:16-alpine >/dev/null || fail "the temporary container would not start."

# Wait for the recovery to finish. `pg_is_in_recovery()` is the honest
# question: it is false only once the server has left recovery and promoted.
recovered=0
for _ in $(seq 1 180); do
  state=$(docker exec "$DRILL_NAME" psql -U postgres -d "$PZ_PG_DB" -tAc \
    'SELECT pg_is_in_recovery()' 2>/dev/null | tr -d '[:space:]' || true)
  if [ "$state" = "f" ]; then
    recovered=1
    break
  fi
  sleep 1
done
if [ "$recovered" -ne 1 ]; then
  docker logs --tail=40 "$DRILL_NAME" >&2 || true
  fail "the restored database never finished recovery."
fi
log "   recovery finished"

# --- 5. the assertions -----------------------------------------------------
q() { docker exec "$DRILL_NAME" psql -U postgres -d "$PZ_PG_DB" -tAc "$1" | tr -d '[:space:]'; }

MARKER_COUNT=$(q "SELECT count(*) FROM pz_restore_drill_marker WHERE marker = '$MARKER'")
[ "$MARKER_COUNT" = "1" ] || fail "the restored database does not contain the marker (found $MARKER_COUNT). It restored to a point BEFORE the marker, so the WAL was not replayed."
log "   the marker is present: the WAL really was replayed"

RESTORED_TABLES=$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
[ "${RESTORED_TABLES:-0}" -ge 20 ] || fail "the restored database has only $RESTORED_TABLES table(s) — that is not the application schema."
[ "$RESTORED_TABLES" -le "$PROD_TABLES_NOW" ] || fail "the restored database has MORE tables than the live one ($RESTORED_TABLES > $PROD_TABLES_NOW)."

RESTORED_MIGRATIONS=$(q "SELECT count(*) FROM _migrations")
[ "${RESTORED_MIGRATIONS:-0}" -ge 1 ] || fail "the restored database has no migration records."

RESTORED_AUDIT=$(q "SELECT count(*) FROM audit_events")
[ "${RESTORED_AUDIT:-0}" -ge 1 ] || fail "the restored database has no audit rows."
[ "$RESTORED_AUDIT" -le "$PROD_AUDIT_NOW" ] || fail "the restored database has more audit rows than the live one ($RESTORED_AUDIT > $PROD_AUDIT_NOW) — it cannot be from the past."

# The chain must be contiguous in the restored copy: the sequence is per
# tenant and gapless, and a restore that lost rows would show a gap.
GAPS=$(q "SELECT count(*) FROM (SELECT tenant_id, max(sequence) AS m, count(*) AS c FROM audit_events GROUP BY tenant_id) s WHERE m <> c")
[ "${GAPS:-1}" = "0" ] || fail "the restored audit chain has $GAPS tenant(s) with a sequence gap."

log "   $RESTORED_TABLES table(s), $RESTORED_MIGRATIONS migration(s), $RESTORED_AUDIT audit row(s), chain contiguous"

# --- 6. done ---------------------------------------------------------------
log "PASS: the database was restored from $STAMP and replayed to $TARGET_TIME"
