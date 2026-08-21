#!/usr/bin/env bash
#
# backup-tapestry.sh - Back up a Tapestry installation's Postgres database,
# and its MinIO object storage volume if the install has one.
#
# Meant to run both interactively and unattended (cron / systemd timer).
# Exits non-zero on any real failure so a scheduler can detect and alert on it.
#
# Runs against the Postgres/MinIO services via `docker compose exec`/`docker
# inspect` (the same way you'd reach them by hand). Run it with the project
# directory as REPO_DIR (default: the current directory), or pass
# --project-dir - same convention as the sibling tapestry-frame-thumbnails and
# tapestry-thumbnail skills, so this script's own location can be anywhere,
# e.g. a repo's own scripts/ directory:
#
#   cd my-tapestry-repo/scripts
#   REPO_DIR=.. ./backup-tapestry.sh
#
# Usage:
#   ./backup-tapestry.sh [options]
#
# Overridable via environment variables (defaults shown) — installs vary
# (docker-compose.yml, docker-compose.local.yml, docker-compose-fnf.yml,
# docker-compose.minio.yml, ...), so don't assume the default filename matches
# yours; set COMPOSE_FILE explicitly if it doesn't:
#   REPO_DIR=.
#   COMPOSE_FILE=docker-compose.yml
#   ENV_FILE=.env
#   DB_SERVICE=db   MINIO_SERVICE=minio
#   BACKUP_DIR=~/tapestry-backups   KEEP=14
#
# Options:
#   --project-dir DIR    Same as setting REPO_DIR (default: $REPO_DIR or cwd)
#   --compose-file FILE  Same as setting COMPOSE_FILE
#   --env-file FILE      Same as setting ENV_FILE
#   --db-service NAME    Same as setting DB_SERVICE
#   --minio-service NAME Same as setting MINIO_SERVICE
#   --backup-dir DIR     Same as setting BACKUP_DIR
#   --keep N             Same as setting KEEP
#   -h, --help           Show this help and exit
#
# Examples:
#   ./backup-tapestry.sh
#   COMPOSE_FILE=docker-compose.minio.yml ./backup-tapestry.sh --keep 30
#
set -euo pipefail

# --- pretty output (degrades to plain text when not a terminal, e.g. cron) ---
if [ -t 1 ]; then
  GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m')
  RED=$(printf '\033[31m'); RESET=$(printf '\033[0m')
else
  GREEN=""; YELLOW=""; RED=""; RESET=""
fi
ts()    { date '+%Y-%m-%d %H:%M:%S'; }
info()  { printf '[%s] %s\n' "$(ts)" "$*"; }
ok()    { printf '[%s] %s%s%s\n' "$(ts)" "$GREEN" "$*" "$RESET"; }
err()   { printf '[%s] %s%s%s\n' "$(ts)" "$RED" "$*" "$RESET" >&2; }

# --- defaults, overridable via env vars or flags (flags win) -------------------
PROJECT_DIR="${REPO_DIR:-.}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
ENV_FILE="${ENV_FILE:-.env}"
DB_SERVICE="${DB_SERVICE:-db}"
MINIO_SERVICE="${MINIO_SERVICE:-minio}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/tapestry-backups}"
KEEP="${KEEP:-14}"

while [ $# -gt 0 ]; do
  case "$1" in
    --project-dir)   PROJECT_DIR="${2:?--project-dir needs a path}"; shift 2 ;;
    --compose-file)  COMPOSE_FILE="${2:?--compose-file needs a filename}"; shift 2 ;;
    --env-file)      ENV_FILE="${2:?--env-file needs a filename}"; shift 2 ;;
    --db-service)    DB_SERVICE="${2:?--db-service needs a name}"; shift 2 ;;
    --minio-service) MINIO_SERVICE="${2:?--minio-service needs a name}"; shift 2 ;;
    --backup-dir)    BACKUP_DIR="${2:?--backup-dir needs a path}"; shift 2 ;;
    --keep)          KEEP="${2:?--keep needs a number}"; shift 2 ;;
    -h|--help)       grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)               err "Unknown argument: $1"; exit 2 ;;
  esac
done

cd "$PROJECT_DIR"

# --- prerequisites -------------------------------------------------------------
command -v docker >/dev/null 2>&1 || { err "docker not found"; exit 1; }
docker compose version >/dev/null 2>&1 || { err "'docker compose' is not available."; exit 1; }

# --- build the compose command (include --env-file only if it exists) ---------
COMPOSE=(docker compose -f "$COMPOSE_FILE")
[ -f "$ENV_FILE" ] && COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

# get_env KEY FILE -> KEY's value from FILE (everything after the first '='),
# or nothing if the file or key is absent.
get_env() {
  local key="$1" file="$2" line
  [ -f "$file" ] || return 0
  line="$(grep -m1 "^${key}=" "$file" 2>/dev/null)" || true
  printf '%s' "${line#"${key}="}"
}

DB_NAME="$(get_env DB_NAME "$ENV_FILE")"; DB_NAME="${DB_NAME:-tapestries}"
DB_USER="$(get_env DB_USER "$ENV_FILE")"; DB_USER="${DB_USER:-tapestries}"

# --- preflight: can we reach the database? ------------------------------------
if ! "${COMPOSE[@]}" exec -T "$DB_SERVICE" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
  err "Could not reach Postgres via:"
  err "  ${COMPOSE[*]} exec $DB_SERVICE pg_isready -U $DB_USER -d $DB_NAME"
  err "Is the stack running, and is REPO_DIR ('${REPO_DIR:-.}', resolved to '$(pwd)') the project directory?"
  exit 1
fi

mkdir -p "$BACKUP_DIR"
TIMESTAMP="$(date +%Y%m%dT%H%M%S)"
rc=0

# prune KIND PATTERN -> delete all but the newest $KEEP files matching
# PATTERN (glob, relative to $BACKUP_DIR), newest-first by mtime.
prune() {
  local kind="$1" pattern="$2" old
  old="$(cd "$BACKUP_DIR" && ls -1t $pattern 2>/dev/null | tail -n "+$((KEEP + 1))")" || true
  if [ -n "$old" ]; then
    info "Pruning $(printf '%s' "$old" | wc -l) old $kind backup(s), keeping newest $KEEP"
    (cd "$BACKUP_DIR" && printf '%s\n' "$old" | xargs -r rm -f --)
  fi
}

# --- Postgres ------------------------------------------------------------------
info "Backing up Postgres ($DB_SERVICE, database '$DB_NAME')..."
PG_FILE="$BACKUP_DIR/pg_${DB_NAME}_${TIMESTAMP}.dump"
# -T disables pseudo-TTY allocation: pg_dump -F c writes a binary archive to
# stdout, and a TTY would mangle it. Streaming straight to a host file avoids
# the extra dump-inside-container-then-copy-out dance entirely.
if "${COMPOSE[@]}" exec -T "$DB_SERVICE" \
     pg_dump -U "$DB_USER" -d "$DB_NAME" -F c > "$PG_FILE"; then
  SIZE="$(wc -c < "$PG_FILE" | tr -d ' ')"
  if [ "$SIZE" -gt 0 ]; then
    ok "Postgres backup OK: $PG_FILE ($SIZE bytes)"
  else
    err "Postgres backup is empty: $PG_FILE"
    rm -f "$PG_FILE"
    rc=1
  fi
else
  err "pg_dump failed"
  rm -f "$PG_FILE"
  rc=1
fi

# --- MinIO (only if this install actually has one running) --------------------
MINIO_CID="$("${COMPOSE[@]}" ps -q "$MINIO_SERVICE" 2>/dev/null || true)"
if [ -z "$MINIO_CID" ]; then
  info "No running '$MINIO_SERVICE' service (not part of this install, or S3 backend is real AWS) — skipping MinIO backup"
else
  info "Backing up MinIO data volume..."
  # Discover the volume backing /data by inspecting the running container,
  # rather than assuming a volume name — Compose derives volume names from
  # the project name (checkout directory), which varies between installs.
  MINIO_VOLUME="$(docker inspect "$MINIO_CID" \
    --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')"
  if [ -z "$MINIO_VOLUME" ]; then
    err "Could not determine MinIO's /data volume from container $MINIO_CID"
    rc=1
  else
    MINIO_FILE="$BACKUP_DIR/minio_${TIMESTAMP}.tar.gz"
    if docker run --rm -v "${MINIO_VOLUME}:/data:ro" -v "$BACKUP_DIR:/backup" alpine \
         tar czf "/backup/$(basename "$MINIO_FILE")" -C /data . ; then
      SIZE="$(wc -c < "$MINIO_FILE" | tr -d ' ')"
      if [ "$SIZE" -gt 0 ]; then
        ok "MinIO backup OK: $MINIO_FILE ($SIZE bytes)"
      else
        err "MinIO backup is empty: $MINIO_FILE"
        rm -f "$MINIO_FILE"
        rc=1
      fi
    else
      err "MinIO volume backup failed"
      rm -f "$MINIO_FILE"
      rc=1
    fi
  fi
fi

# --- retention ------------------------------------------------------------------
prune "Postgres" "pg_${DB_NAME}_*.dump"
prune "MinIO" "minio_*.tar.gz"

if [ "$rc" -eq 0 ]; then
  ok "Backup complete."
else
  err "Backup finished with errors — see above."
fi
exit "$rc"
