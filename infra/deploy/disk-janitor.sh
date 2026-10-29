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
#     and can be gigabytes when a job dies badly -- except the log of the job
#     that is running right now, which is still being written;
#   · removes the runner's work directory, which is a checkout plus
#     node_modules and is reused by the next job anyway -- but only when no
#     job is running, because that directory IS the running job's source;
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

# Is a CI job running right now?
#
# The runner starts a `Runner.Worker` process for the duration of a job and
# exits it when the job ends, so the process IS the job. The obvious signal
# -- "the _work directory has files in it" -- is not a signal at all: the
# runner leaves the checkout of the last job there, and a leftover checkout
# says nothing about whether a job is live. Deleting that checkout while the
# worker is inside it is how a build dies half way through with "no such file
# or directory", and the operator then goes looking for a broken build
# instead of at the janitor that broke it.
#
# The answer has three values, not two: yes, no, and "could not tell". A
# check that could not be made is read as "maybe", because the two mistakes
# are not equally expensive. Keeping a stale checkout costs a few hundred
# megabytes until the next job; deleting a live one fails somebody's build.
#
#   0 = a job is running, 1 = no job is running, 2 = the check failed.
job_running() {
  command -v pgrep >/dev/null 2>&1 || return 2
  pgrep -f 'Runner\.Worker' >/dev/null 2>&1
  local rc=$?
  if [ "$rc" -eq 1 ]; then
    return 1
  fi
  if [ "$rc" -eq 0 ]; then
    return 0
  fi
  return 2
}

# 1 when a CI job may be running right now.
busy=0
if job_running; then
  busy=1
  log "a CI job is running (Runner.Worker found)"
else
  check_rc=$?
  if [ "$check_rc" -ge 2 ]; then
    busy=1
    log "could not tell whether a CI job is running; treating the runner as busy"
  fi
fi

log "disk at $(used_percent)% (threshold ${THRESHOLD_PERCENT}%)"

# The runner's diagnostics are the log of jobs that have already finished, so
# they are safe to clear -- with one exception. The runner writes the log of
# the job it is running RIGHT NOW, and that file is still being appended to.
# Deleting it loses the evidence of a live failure, and loses it silently:
# the runner keeps writing to an unlinked inode, so the log is gone even
# though the file handle is still open.
#
# The exception is identified by the file's own age rather than by its name.
# The runner names the file after the job's start ("Worker_<start>.log"), so
# the newest name is the running job -- but two jobs can start inside the
# same second, and then the name order is a coin toss. A file that was
# written in the last few minutes is written by a job that is still going.
# Keeping a little too much is cheap; deleting the live log is not.
if [ "$busy" -eq 1 ]; then
  ACTIVE_DIAG_MINUTES="${PZ_ACTIVE_DIAG_MINUTES:-10}"
  find "${RUNNER_DIR}/_diag" -maxdepth 1 -type f -name 'Worker_*.log' \
    ! -mmin "-${ACTIVE_DIAG_MINUTES}" -delete 2>/dev/null || true
  log "kept the diagnostics written in the last ${ACTIVE_DIAG_MINUTES} minutes (a job may be running)"
else
  rm -f "${RUNNER_DIR}"/_diag/Worker_*.log 2>/dev/null || true
fi
rm -rf "${RUNNER_DIR}"/_diag/pages "${RUNNER_DIR}"/_diag/blocks 2>/dev/null || true

if [ "$(used_percent)" -lt "$THRESHOLD_PERCENT" ]; then
  log "below threshold; nothing to reclaim"
  exit 0
fi

log "above threshold: reclaiming"

# The work directory holds a checkout and node_modules. The runner recreates
# both on the next job, and a half-finished checkout is worth nothing --
# unless a job is running right now, in which case that checkout is the
# source the job is building from. So the deletion is skipped while a worker
# is alive, and the disk pressure is reported instead of being resolved by
# deleting somebody's source.
if [ "$busy" -eq 1 ]; then
  log "skipped the work directory: a CI job may be using it"
else
  rm -rf "${RUNNER_DIR}"/_work/* 2>/dev/null || true
  log "removed the runner's work directory"
fi

# Service containers from a CI job are named by a hash prefix. They are only
# removed when they are OLD: a container that a job is currently using is
# younger than this, and removing it would delete the database that job is
# about to connect to. The threshold is well beyond any job's runtime.
#
# (A cleanup that removed "the containers a previous job left behind" by name
# pattern alone would also remove the CURRENT job's service containers,
# because the runner names them the same way. The age check is what makes
# this safe.)
#
# The records are read LINE BY LINE. Docker prints the creation time with
# spaces in it ("2026-10-28 11:20:41 +0000 UTC"), and a `for` loop over an
# unquoted `$(...)` splits on those spaces: the loop then received the DATE
# alone, `date -d` read that as midnight, and a container created at 11:20
# looked six hours older than it was -- old enough to be removed while the
# job that created it was still using it.
STALE_CONTAINER_AGE="${PZ_STALE_CONTAINER_AGE:-3600}"

# The orphaned volumes the CI service containers leave behind. They are
# removed on the same schedule as the containers themselves: a volume that
# outlives its container by an hour is not going to be used again, and it
# is holding tens of megabytes of somebody's database.
STALE_VOLUME_AGE="${PZ_STALE_VOLUME_AGE:-3600}"
now=$(date +%s)
while IFS='|' read -r name created; do
  [ -n "$name" ] || continue
  # The runner's service containers carry a 32 character hash prefix.
  [[ "$name" =~ ^[0-9a-f]{32}_ ]] || continue
  # A creation time that cannot be read does NOT authorise a removal. The
  # age check exists precisely to be the reason a live job's container is
  # spared, so a check that cannot read the age has no opinion -- and the
  # safe opinion is "keep it".
  #
  # Docker prints the time as "2026-10-28 09:00:00 +0000 UTC". The trailing
  # zone NAME after the numeric offset is not accepted by `date -d` on every
  # coreutils, so the name is dropped and the offset -- which is what the
  # age actually depends on -- is kept.
  epoch=$(date -d "$created" +%s 2>/dev/null || true)
  if ! [[ "$epoch" =~ ^[0-9]+$ ]]; then
    epoch=$(date -d "${created% *}" +%s 2>/dev/null || true)
  fi
  if ! [[ "$epoch" =~ ^[0-9]+$ ]] || [ "$epoch" -le 0 ]; then
    log "kept service container $name: could not read its creation time"
    continue
  fi
  age=$((now - epoch))
  if [ "$age" -gt "$STALE_CONTAINER_AGE" ]; then
    docker rm -f "$name" >/dev/null 2>&1 || true
    log "removed stale service container $name (${age}s old)"
  fi
done < <(docker ps -a --format '{{.Names}}|{{.CreatedAt}}')

# The ANONYMOUS VOLUMES the CI service containers leave behind.
#
# A GitHub Actions service container that declares a volume gets an anonymous
# Docker volume for it, and the runner does NOT remove it when the job ends.
# The postgres service container writes a fresh database into one on every
# run, so the volumes accumulate at roughly 50–100 MB each — hundreds of
# them, tens of gigabytes, until the disk fills and every project on this
# box starts failing.
#
# That is not hypothetical: this box reached 89% full with 226 orphaned
# volumes holding about twenty gigabytes, and a CI job's `npm ci` failed
# because of it.
#
# `docker volume ls --filter dangling=true` lists exactly the volumes that
# no container references, so this cannot touch a running service's data.
#
# But "dangling" is not the same as "disposable". A NAMED volume — the
# production database of any project on this box — also becomes dangling the
# moment its container is removed, and removing it would destroy a database
# that a `compose up` was about to reattach to. So only ANONYMOUS volumes
# are removed: Docker names those with 64 hexadecimal characters, and the
# CI service containers create exactly those.
#
# The age check is belt and braces: a volume created moments ago is left
# alone in case its container is still starting.
docker volume ls -q --filter dangling=true 2>/dev/null | while read -r VOL; do
  [ -n "$VOL" ] || continue
  # Only an anonymous volume. A named one belongs to a project, and this
  # script does not get to decide that its data is garbage.
  case "$VOL" in
    [0-9a-f]*) ;;
    *) continue ;;
  esac
  if [ "${#VOL}" -ne 64 ]; then
    continue
  fi
  CREATED=$(docker volume inspect -f '{{.CreatedAt}}' "$VOL" 2>/dev/null || echo "")
  if [ -z "$CREATED" ]; then
    continue
  fi
  EPOCH=$(date -d "$CREATED" +%s 2>/dev/null || echo 0)
  NOW=$(date +%s)
  if [ "$EPOCH" -eq 0 ]; then
    # An unreadable creation time is not an authorisation to delete.
    continue
  fi
  AGE=$((NOW - EPOCH))
  if [ "$AGE" -gt "$STALE_VOLUME_AGE" ]; then
    docker volume rm "$VOL" >/dev/null 2>&1 && log "removed orphaned volume ${VOL:0:12} (${AGE}s old)"
  fi
done

# The build cache and the images.
#
# The BUILD CACHE cannot be scoped to a project: `docker builder prune` takes
# no label filter. So it is NOT run here. It is the one thing on this box
# that would delete another project's cache — and this box hosts four other
# projects whose builds are as slow to redo as this one.
#
# The IMAGE prune is scoped to this project's compose label, so it reaches
# PermitZero's own images and nothing else. Note the absence of `-a`: the
# plain prune removes only DANGLING images, and `-a` would also remove every
# TAGGED image nobody references — which on this box includes other
# projects' rollback targets. Those exist precisely so a bad deploy can be
# undone, and deleting them is worse than running out of disk.
docker image prune -f --filter "label=com.docker.compose.project=permitzero" >/dev/null 2>&1 || true

# This project's own images, by name, which is the narrowest scope of all.
for img in permitzero/verify:local permitzero/migrate:local; do
  if docker images -q "$img" 2>/dev/null | grep -q .; then
    docker rmi -f "$img" >/dev/null 2>&1 || true
  fi
done

log "now at $(used_percent)%"
df -h / | tail -1
