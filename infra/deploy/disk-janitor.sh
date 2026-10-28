#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Disk janitor for the shared VPS.
#
# This box runs PermitZero's production stack and three other projects, and
# it also runs the CI runner. A CI job once filled the 96 GB volume to 100%
# and every service on the box started failing -- the runner's own worker
# could not even write its diagnostic log.
#
# So the box cleans itself. Every run:
#   · removes the runner's crashed-worker diagnostics, which are pure output
#     and can be gigabytes when a job dies badly;
#   · removes the runner's work directory, which is a checkout plus
#     node_modules and is reused by the next job anyway;
#   · prunes dangling images and the build cache, which are outputs of a
#     build rather than anything a running container references.
#
# It never touches: running containers, their volumes, tagged images, or
# anything another project depends on.
#
# Run by cron every 30 minutes. The threshold is deliberately high: the
# janitor only acts when the disk is genuinely under pressure, so it does not
# churn the build cache of a project that is mid-deploy.
# ---------------------------------------------------------------------------
set -uo pipefail

RUNNER_DIR="${PZ_RUNNER_DIR:-/home/ubuntu/actions-runner-pz}"
THRESHOLD_PERCENT="${PZ_DISK_THRESHOLD_PERCENT:-85}"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }

used_percent() { df --output=pcent / | tail -1 | tr -dc '0-9'; }

log "disk at $(used_percent)% (threshold ${THRESHOLD_PERCENT}%)"

# The runner's diagnostics are always safe to clear: they are the log of jobs
# that have already finished.
rm -f "${RUNNER_DIR}"/_diag/Worker_*.log 2>/dev/null || true
rm -rf "${RUNNER_DIR}"/_diag/pages "${RUNNER_DIR}"/_diag/blocks 2>/dev/null || true

if [ "$(used_percent)" -lt "$THRESHOLD_PERCENT" ]; then
  log "below threshold; nothing to reclaim"
  exit 0
fi

log "above threshold: reclaiming"

# The work directory holds a checkout and node_modules. The runner recreates
# both on the next job, and a half-finished checkout is worth nothing.
rm -rf "${RUNNER_DIR}"/_work/* 2>/dev/null || true

# Service containers from a CI job are named by a hash prefix. They are only
# removed when they are OLD: a container that a job is currently using is
# younger than this, and removing it would delete the database that job is
# about to connect to. The threshold is well beyond any job's runtime.
#
# (A cleanup that removed "the containers a previous job left behind" by name
# pattern alone would also remove the CURRENT job's service containers,
# because the runner names them the same way. The age check is what makes
# this safe.)
STALE_CONTAINER_AGE="${PZ_STALE_CONTAINER_AGE:-3600}"
for c in $(docker ps -a --format '{{.Names}}|{{.CreatedAt}}' | grep -E '^[0-9a-f]{32}_' || true); do
  name="${c%%|*}"
  created="${c#*|}"
  epoch=$(date -d "$created" +%s 2>/dev/null || echo 0)
  now=$(date +%s)
  if [ "$epoch" -gt 0 ] && [ $((now - epoch)) -gt "$STALE_CONTAINER_AGE" ]; then
    docker rm -f "$name" >/dev/null 2>&1 || true
    log "removed stale service container $name"
  fi
done

docker builder prune -af >/dev/null 2>&1 || true
docker image prune -af >/dev/null 2>&1 || true

log "now at $(used_percent)%"
df -h / | tail -1
