#!/usr/bin/env bash
#
# list-tapestries.sh
#
# Print a read-only report of every tapestry on the installation: title, owner,
# last updated, and its view URL (built from the owner's username and the
# tapestry's slug — the real route is /u/:username/:slug, see
# client/src/utils/paths.ts). No picking, no mutation — for that, see the
# sibling tapestry-visibility skill's manage-tapestry-visibility.sh, which
# shares this same connection harness.
#
# Runs against the Postgres "db" service via `docker compose exec` (the same
# way you'd reach it by hand). Run it with the repo directory as REPO_DIR
# (default: the current directory - i.e. run it from the repo directory
# itself, unless you point REPO_DIR elsewhere). The script file itself can
# live anywhere, e.g. a dedicated scripts/ directory one level below the repo
# (same convention as tapestry-visibility/tapestry-backups/etc.):
#
#   cd my-tapestry-repo/scripts
#   REPO_DIR=.. ./list-tapestries.sh
#
# Usage:
#   ./list-tapestries.sh            # list everything, sorted by most recently updated
#   ./list-tapestries.sh <search>   # filter by title / slug / owner email
#   ./list-tapestries.sh --help     # show this help
#
# Overridable via environment variables (defaults shown):
#   REPO_DIR=.
#   COMPOSE_FILE=docker-compose-fnf.yml
#   ENV_FILE=.env
#   DB_SERVICE=db   DB_USER=tapestries   DB_NAME=tapestries
#   BASE_URL=                 # e.g. https://tapestries.archive.org — prefixed
#                              # onto each URL; left unset, URLs are shown as
#                              # the bare /u/username/slug path instead.
#
set -euo pipefail

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  grep '^#' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

# Where docker-compose-fnf.yml / .env live. Defaults to the current directory,
# matching "run this from the repo directory" - override (or cd elsewhere and
# set this) if the script itself lives somewhere else, e.g. a repo's scripts/.
REPO_DIR="${REPO_DIR:-.}"
cd "$REPO_DIR"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose-fnf.yml}"
ENV_FILE="${ENV_FILE:-.env}"
DB_SERVICE="${DB_SERVICE:-db}"
DB_USER="${DB_USER:-tapestries}"
DB_NAME="${DB_NAME:-tapestries}"
BASE_URL="${BASE_URL:-}"
FILTER="${1:-}"

if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RED=$(printf '\033[31m')
  RESET=$(printf '\033[0m')
else
  BOLD=""; DIM=""; RED=""; RESET=""
fi
err() { printf '%s%s%s\n' "$RED" "$*" "$RESET" >&2; }

# --- build the compose command (include --env-file only if it exists) ---------
command -v docker >/dev/null 2>&1 || { err "docker not found"; exit 1; }
COMPOSE=(docker compose -f "$COMPOSE_FILE")
[ -f "$ENV_FILE" ] && COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

# psql_exec <psql-args...> : run psql inside the db container, no TTY.
psql_exec() {
  "${COMPOSE[@]}" exec -T "$DB_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" "$@" </dev/null
}

# --- preflight: can we reach the database? ------------------------------------
if ! psql_exec -tAc 'SELECT 1;' >/dev/null 2>&1; then
  err "Could not connect to the database via:"
  err "  ${COMPOSE[*]} exec $DB_SERVICE psql -U $DB_USER -d $DB_NAME"
  err "Is the stack running, and is REPO_DIR ('${REPO_DIR}', resolved to '$(pwd)') the repo directory?"
  exit 1
fi

# --- build an optional, injection-safe WHERE clause ---------------------------
WHERE=""
if [ -n "$FILTER" ]; then
  esc="${FILTER//\'/\'\'}"   # double any single quotes
  WHERE="WHERE t.title ILIKE '%${esc}%' OR t.slug ILIKE '%${esc}%' OR u.email ILIKE '%${esc}%'"
fi

FROM="FROM \"Tapestry\" t LEFT JOIN \"User\" u ON u.id = t.\"ownerId\" ${WHERE}"

# --- preflight: anything to show? ----------------------------------------------
COUNT="$(psql_exec -tAc "SELECT count(*) ${FROM};")"
if [ "${COUNT:-0}" -eq 0 ]; then
  if [ -n "$FILTER" ]; then echo "No tapestries match '${FILTER}'."; else echo "No tapestries found."; fi
  exit 0
fi

# --- print the report -----------------------------------------------------------
# Sorted most-recently-updated first - this is a status report, not a picker,
# so "what's been active lately" is a more useful default than alphabetical.
printf '\n%sTapestries%s' "$BOLD" "$RESET"
[ -n "$FILTER" ] && printf ' %s(filter: %s)%s' "$DIM" "$FILTER" "$RESET"
printf '\n'
psql_exec -P pager=off -c "
  SELECT
    CASE WHEN length(t.title) > 40 THEN left(t.title, 40) || '…' ELSE t.title END AS title,
    COALESCE(u.email, t.\"ownerId\") AS owner,
    to_char(t.\"updatedAt\", 'YYYY-MM-DD HH24:MI') AS last_updated,
    CASE WHEN u.username IS NOT NULL
      THEN concat('${BASE_URL}', '/u/', u.username, '/', t.slug)
      ELSE NULL
    END AS url
  ${FROM}
  ORDER BY t.\"updatedAt\" DESC;
"
