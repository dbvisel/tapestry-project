#!/usr/bin/env bash
#
# check-site-activity.sh - Read-only snapshot of current site activity, to help
# decide whether now is a good time for a deploy that restarts client/server/worker.
# Doesn't touch anything - just reads container logs, Postgres, and docker stats.
#
# Same project-dir/compose-file/env-file convention as the sibling
# backup-tapestry.sh, so this script's own location can be anywhere, e.g. a
# repo's own scripts/ directory:
#
#   cd my-tapestry-repo/scripts
#   REPO_DIR=.. ./check-site-activity.sh
#
# Usage:
#   ./check-site-activity.sh [options]
#
# Overridable via environment variables (defaults shown) - installs vary
# (docker-compose.yml, docker-compose.local.yml, docker-compose-fnf.yml, ...), so
# don't assume the default filename matches yours; set COMPOSE_FILE explicitly
# if it doesn't:
#   REPO_DIR=.
#   COMPOSE_FILE=docker-compose.yml
#   ENV_FILE=.env
#   DB_SERVICE=db   CLIENT_SERVICE=client   SERVER_SERVICE=server
#   WINDOWS="5m 15m"
#
# Options:
#   --project-dir DIR     Same as setting REPO_DIR (default: $REPO_DIR or cwd)
#   --compose-file FILE   Same as setting COMPOSE_FILE
#   --env-file FILE       Same as setting ENV_FILE
#   --db-service NAME     Same as setting DB_SERVICE
#   --client-service NAME Same as setting CLIENT_SERVICE
#   --server-service NAME Same as setting SERVER_SERVICE
#   --windows "W1 W2 ..."  Same as setting WINDOWS (docker logs --since values)
#   -h, --help            Show this help and exit
#
# Examples:
#   ./check-site-activity.sh
#   COMPOSE_FILE=docker-compose-fnf.yml ./check-site-activity.sh
#
set -euo pipefail

# --- pretty output (degrades to plain text when not a terminal) ---
if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); RESET=$(printf '\033[0m')
else
  BOLD=""; RESET=""
fi
section() { printf '\n%s=== %s ===%s\n' "$BOLD" "$*" "$RESET"; }
err()     { printf '%s\n' "$*" >&2; }

# --- defaults, overridable via env vars or flags (flags win) -------------------
PROJECT_DIR="${REPO_DIR:-.}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
ENV_FILE="${ENV_FILE:-.env}"
DB_SERVICE="${DB_SERVICE:-db}"
CLIENT_SERVICE="${CLIENT_SERVICE:-client}"
SERVER_SERVICE="${SERVER_SERVICE:-server}"
WINDOWS="${WINDOWS:-5m 15m}"

while [ $# -gt 0 ]; do
  case "$1" in
    --project-dir)    PROJECT_DIR="${2:?--project-dir needs a path}"; shift 2 ;;
    --compose-file)   COMPOSE_FILE="${2:?--compose-file needs a filename}"; shift 2 ;;
    --env-file)       ENV_FILE="${2:?--env-file needs a filename}"; shift 2 ;;
    --db-service)     DB_SERVICE="${2:?--db-service needs a name}"; shift 2 ;;
    --client-service) CLIENT_SERVICE="${2:?--client-service needs a name}"; shift 2 ;;
    --server-service) SERVER_SERVICE="${2:?--server-service needs a name}"; shift 2 ;;
    --windows)        WINDOWS="${2:?--windows needs one or more docker logs --since values}"; shift 2 ;;
    -h|--help)        grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)                err "Unknown argument: $1"; exit 2 ;;
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

section "Recent HTTP traffic ($CLIENT_SERVICE - page/JS/CSS requests only; images/fonts aren't logged)"
for w in $WINDOWS; do
  logs=$("${COMPOSE[@]}" logs --since="$w" "$CLIENT_SERVICE" 2>/dev/null || true)
  count=$(grep -cE '"(GET|POST|PUT|PATCH|DELETE) ' <<<"$logs" || true)
  ips=$(grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' <<<"$logs" | sort -u | wc -l || true)
  printf '  last %s: %s requests, %s distinct IPv4 client addresses (IPv6 not counted here)\n' "$w" "$count" "$ips"
done

section "Recent HTTP traffic ($SERVER_SERVICE - API requests, morgan 'dev' log, no per-request IP)"
for w in $WINDOWS; do
  count=$("${COMPOSE[@]}" logs --since="$w" "$SERVER_SERVICE" 2>/dev/null | grep -cE '(GET|POST|PUT|PATCH|DELETE) /' || true)
  printf '  last %s: %s requests\n' "$w" "$count"
done

section "Postgres: active (non-idle) connections right now"
"${COMPOSE[@]}" exec -T "$DB_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -c \
  "SELECT state, count(*) FROM pg_stat_activity WHERE datname = current_database() GROUP BY state ORDER BY count(*) DESC;" 2>&1 || true

section "Authenticated tapestry viewing in the last 15 minutes (TapestryInteraction.lastSeen)"
"${COMPOSE[@]}" exec -T "$DB_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -c \
  "SELECT count(DISTINCT \"userId\") AS distinct_users, count(*) AS interactions FROM \"TapestryInteraction\" WHERE \"lastSeen\" > now() - interval '15 minutes';" 2>&1 || true

section "Container resource snapshot (context only, not a usage signal)"
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" 2>/dev/null || true

printf '\nNo established baseline yet for "quiet" vs "busy" on this deployment - these numbers are\n'
printf 'only meaningful relative to each other across a few runs, not against a fixed threshold.\n'
