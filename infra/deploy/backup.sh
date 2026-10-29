#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# PermitZero — base backup.
#
#   ./infra/deploy/backup.sh            take a base backup and prune the old ones
#   PZ_BACKUP_KEEP=14 ./infra/deploy/backup.sh
#
# What it takes: a `pg_basebackup` of the LIVE database, in tar format, with
# the WAL it generated streamed alongside it. Nothing is stopped, nothing is
# locked out, and the running database is not affected — pg_basebackup is an
# online operation and the archive keeps running throughout.
#
# Why tar format and not a plain directory: a plain-format backup is a
# directory that has to be restored file by file and is easy to restore
# INCOMPLETELY without noticing. A tarball is one file with one checksum, and
# `pg_verifybackup` can prove it.
#
# Why `-X stream`: the backup has to contain the WAL between its start and
# its end LSN, or the restored copy has no consistent starting point. The
# archive on disk covers the WAL after that, but the piece the backup itself
# depends on travels with the backup.
#
# Where it goes: a bind-mounted directory on the host, outside the compose
# project, so `docker compose down -v` cannot take it. The base backup is
# only half the recovery story — the WAL archive is the other half, and
# without it a backup restores to the moment it was taken and no later.
#
# The old backups are pruned, because a backup directory that only grows is a
# disk-full incident waiting for the night the disk is needed for something
# else. PZ_BACKUP_KEEP backups are kept (default 7 — a week of daily backups).
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"

# The env file may live outside the tree (PZ_STATE_DIR), the same rule the
# deployment script follows. A backup that reads the WRONG env file is a
# backup of the wrong database, or no backup at all.
STATE_DIR="${PZ_STATE_DIR:-}"
ENV_FILE="infra/deploy/permitzero.env"
if [ -n "$STATE_DIR" ]; then
  ENV_FILE="$STATE_DIR/permitzero.env"
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "backup: no env file at $ENV_FILE; nothing to back up." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

COMPOSE="docker compose --env-file $ENV_FILE -f infra/docker-compose.yml"

# Where the backups live. It has to be the SAME directory the compose file
# mounts, or the backup lands somewhere the restore cannot find it.
BACKUP_ROOT="${PZ_BACKUP_ROOT:-$ROOT/backups}"
export PZ_BACKUP_ROOT="$BACKUP_ROOT"

KEEP="${PZ_BACKUP_KEEP:-7}"
case "$KEEP" in
  ''|*[!0-9]*) echo "backup: PZ_BACKUP_KEEP must be a whole number." >&2; exit 1 ;;
esac
if [ "$KEEP" -lt 1 ]; then
  echo "backup: PZ_BACKUP_KEEP must be at least 1 (keeping none is not a backup)." >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="/var/lib/postgresql/base-backups/$STAMP"

echo "== base backup $STAMP (keeping $KEEP)"
started=$(date +%s)

# --user postgres: the backup must be owned by the container's postgres user,
# because that is the user the restore runs as and the one that has to write
# into the directory afterwards. A root-owned backup in a postgres-owned
# directory is a backup the restore cannot overwrite.
$COMPOSE exec -T --user postgres postgres pg_basebackup \
  -U "$PZ_PG_USER" \
  -D "$TARGET" \
  -Ft -z -X stream \
  --checkpoint=fast \
  --manifest-checksums=SHA256

finished=$(date +%s)
echo "   took $((finished - started))s"

# The name of the backup just taken, written where the restore drill and the
# operator can both find it. Inside the container, because the host directory
# belongs to the container's postgres user after the compose entrypoint
# chowns it — the unprivileged deploying user cannot write there.
$COMPOSE exec -T --user root postgres sh -c "echo '$STAMP' > /var/lib/postgresql/base-backups/LATEST"

# Prove the backup is readable before it is counted as a backup. A tarball
# that cannot be listed cannot be restored, and discovering that during an
# incident is the worst possible time to discover it.
$COMPOSE exec -T --user root postgres sh -c \
  "tar -tzf '$TARGET/base.tar.gz' > /dev/null && echo '   verified: the tarball lists'"

# Prune the old ones. The list is taken INSIDE the container because that is
# where the paths live and where the permissions to remove them are; on the
# host the directory belongs to the container's postgres user.
echo "== pruning (keeping the newest $KEEP)"
$COMPOSE exec -T --user root postgres sh -c \
  "ls -1dt /var/lib/postgresql/base-backups/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -rf"

remaining=$($COMPOSE exec -T --user root postgres sh -c \
  "ls -1d /var/lib/postgresql/base-backups/*/ 2>/dev/null | wc -l" | tr -d '[:space:]')
echo "   $remaining base backup(s) on disk"

# A retained base backup is the recovery floor: WAL before its START WAL
# location cannot be used by any retained backup. pg_archivecleanup removes
# only complete segments older than that floor; if the label cannot be read we
# deliberately keep the archive rather than risk making recovery incomplete.
echo "== pruning WAL before the oldest retained backup"
$COMPOSE exec -T --user root postgres sh -c '
  oldest=$(ls -1dt /var/lib/postgresql/base-backups/*/ 2>/dev/null | tail -n 1)
  [ -n "$oldest" ] || exit 0
  wal=$(tar -xOzf "$oldest/base.tar.gz" backup_label 2>/dev/null | sed -n "s/^START WAL LOCATION:.*(file \([^)]*\)).*/\1/p")
  [ -n "$wal" ] || { echo "   WAL kept: backup label unavailable"; exit 0; }
  pg_archivecleanup /var/lib/postgresql/wal-archive "$wal"
'

echo "backup: done."
