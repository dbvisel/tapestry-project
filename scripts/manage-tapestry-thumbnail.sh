#!/usr/bin/env bash
#
# manage-tapestry-thumbnail.sh
#
# Interactively list tapestries (with their current TAPESTRY thumbnail status)
# and remake a selected tapestry's own single card thumbnail -
# scheduleTapestryThumbnailGeneration(), the same function the app itself calls
# whenever a tapestry is edited. Unlike the sibling tapestry-frame-thumbnails
# skill, this never touches any individual frame's thumbnail.
#
# IMPORTANT - two different "thumbnail" concepts, don't confuse them:
#   - TAPESTRY thumbnail (what THIS script is about): the single card-preview
#     image of the tapestry *as a whole* (the `Tapestry.thumbnail` column -
#     what shows up in dashboards/the Samples list).
#   - FRAME thumbnail (NOT what this script is about): the small preview image
#     belonging to one object ("frame"/Item) placed on a tapestry's canvas.
#     See the separate tapestry-frame-thumbnails skill for that.
# The app's job pipeline (generate-tapestry-thumbnails.ts) always retakes the
# whole-tapestry screenshot first, before touching any frame - so the
# frame-thumbnails skill incidentally refreshes the tapestry thumbnail too, as
# a side effect. This script is the inverse: called with no frames marked for
# processing, it touches *only* the tapestry thumbnail, nothing per-frame.
#
# Listing/selection runs against Postgres via `docker compose exec` (read-only,
# same as you'd do by hand). Remaking the thumbnail actually runs the app's own
# code: this script copies the bundled run-generate-tapestry-thumbnail.ts into
# the EXEC_SERVICE container's /tmp, runs it once via tsx (with REPO_DIR set so
# its import resolves), then removes it. Generation itself then happens
# asynchronously in the already-running worker service (skipping the app's
# normal debounce delay, since this is a deliberate one-off action).
#
# Run it with the repo directory as REPO_DIR (default: the current directory -
# i.e. run it from the repo directory itself, unless you point REPO_DIR
# elsewhere). The script file itself can live anywhere, e.g. a dedicated
# scripts/ directory one level below the repo:
#
#   cd my-tapestry-repo/scripts
#   REPO_DIR=.. ./manage-tapestry-thumbnail.sh wikimania
#
# Usage:
#   ./manage-tapestry-thumbnail.sh            # list everything, then pick one
#   ./manage-tapestry-thumbnail.sh <search>   # filter by title / slug / owner email
#   ./manage-tapestry-thumbnail.sh --help     # show this help
#
# Overridable via environment variables (defaults shown):
#   REPO_DIR=.
#   COMPOSE_FILE=docker-compose-fnf.yml
#   ENV_FILE=.env
#   DB_SERVICE=db   DB_USER=tapestries   DB_NAME=tapestries
#   EXEC_SERVICE=worker
#
set -euo pipefail

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  grep '^#' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

# Where this script (and its sibling run-generate-tapestry-thumbnail.ts) live -
# NOT necessarily the repo directory (see REPO_DIR below). Used only to locate
# the runner file that gets copied into the container.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
EXEC_SERVICE="${EXEC_SERVICE:-worker}"
FILTER="${1:-}"

if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); GREEN=$(printf '\033[32m')
  YELLOW=$(printf '\033[33m'); RED=$(printf '\033[31m'); RESET=$(printf '\033[0m')
else
  BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; RESET=""
fi
err() { printf '%s%s%s\n' "$RED" "$*" "$RESET" >&2; }

# --- build the compose command (include --env-file only if it exists) ---------
command -v docker >/dev/null 2>&1 || { err "docker not found"; exit 1; }
COMPOSE=(docker compose -f "$COMPOSE_FILE")
[ -f "$ENV_FILE" ] && COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

# psql_exec <psql-args...> : run psql inside the db container, no TTY.
# stdin is redirected from /dev/null so `docker compose exec` can't drain the
# script's own stdin (which the interactive prompts below read from).
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

# --- load the ids in display order (same ORDER BY as the table below) ---------
IDS=()
while IFS= read -r line; do
  [ -n "$line" ] && IDS+=("$line")
done < <(psql_exec -tAc "SELECT t.id ${FROM} ORDER BY t.title, t.id;")

if [ "${#IDS[@]}" -eq 0 ]; then
  if [ -n "$FILTER" ]; then echo "No tapestries match '${FILTER}'."; else echo "No tapestries found."; fi
  exit 0
fi

# --- show the numbered table --------------------------------------------------
printf '\n%sTapestries%s' "$BOLD" "$RESET"
[ -n "$FILTER" ] && printf ' %s(filter: %s)%s' "$DIM" "$FILTER" "$RESET"
printf '\n'
psql_exec -P pager=off -c "
  SELECT
    row_number() OVER (ORDER BY t.title, t.id) AS \"#\",
    t.title,
    COALESCE(u.email, t.\"ownerId\") AS owner,
    t.slug,
    CASE WHEN t.thumbnail IS NULL THEN 'none' ELSE 'set' END AS tapestry_thumbnail,
    t.\"updatedAt\"::date AS last_updated,
    t.id
  ${FROM}
  ORDER BY t.title, t.id;
"

# --- pick one -----------------------------------------------------------------
read -r -p "Select a tapestry by # (or 'q' to quit): " choice
case "$choice" in
  q|Q|"") echo "Cancelled."; exit 0 ;;
esac
if ! printf '%s' "$choice" | grep -qE '^[0-9]+$' || [ "$choice" -lt 1 ] || [ "$choice" -gt "${#IDS[@]}" ]; then
  err "Invalid selection: $choice"
  exit 1
fi
ID="${IDS[$((choice - 1))]}"

# --- show current state --------------------------------------------------------
CUR_TITLE="$(psql_exec -tAc "SELECT title FROM \"Tapestry\" WHERE id = '${ID}';")"
CUR_THUMB="$(psql_exec -tAc "SELECT COALESCE(thumbnail, '(none)') FROM \"Tapestry\" WHERE id = '${ID}';")"
printf '\nSelected: %s%s%s\n' "$BOLD" "$CUR_TITLE" "$RESET"
printf '  id ................. %s\n' "$ID"
printf '  current thumbnail .. %s\n' "$CUR_THUMB"

# --- confirm and schedule regeneration -----------------------------------------
echo ""
echo "This remakes ONLY this tapestry's own card thumbnail (not any frame's"
echo "thumbnail) - a fresh screenshot always replaces whatever's there now."
read -r -p "Type 'yes' to remake the thumbnail for \"${CUR_TITLE}\": " confirm
if [ "$confirm" != "yes" ]; then
  echo "Cancelled."
  exit 0
fi

RUNNER="run-generate-tapestry-thumbnail.ts"
REMOTE_PATH="/tmp/${RUNNER}"
# Where the runner's own import should look for server/ once *inside* the container - not the same value as
# this script's own REPO_DIR (that one's a host path to docker-compose-fnf.yml; this one's a container path
# to the app source, fixed by Dockerfile.server's `WORKDIR /app/server`). Passed to the runner via
# `-e REPO_DIR=...` below so it can resolve its import the same way regardless of where it physically sits.
CONTAINER_REPO_DIR="/app"

"${COMPOSE[@]}" cp "$SCRIPT_DIR/$RUNNER" "${EXEC_SERVICE}:${REMOTE_PATH}"
cleanup() { "${COMPOSE[@]}" exec -T "$EXEC_SERVICE" rm -f "$REMOTE_PATH" >/dev/null 2>&1 || true; }
trap cleanup EXIT

if "${COMPOSE[@]}" exec -T -e REPO_DIR="$CONTAINER_REPO_DIR" "$EXEC_SERVICE" npx tsx "$REMOTE_PATH" "$ID"; then
  printf '\n%sScheduled.%s Generation runs asynchronously in the "%s" service (no debounce delay).\n' \
    "$GREEN" "$RESET" "$EXEC_SERVICE"
  echo "Re-run this script against the same tapestry in a bit to confirm the thumbnail changed."
else
  err "Failed to schedule tapestry-thumbnail regeneration - see error above."
  exit 1
fi
