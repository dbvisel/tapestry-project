#!/usr/bin/env bash
#
# manage-tapestry-visibility.sh
#
# Interactively list tapestries and change a tapestry's visibility
# (private / link / public). A tapestry with visibility = public appears in the
# "Samples" list every client sees on startup. Default visibility is private.
#
# Runs against the Postgres "db" service via `docker compose exec` (the same way
# you'd reach it by hand). Run it with the repo directory as REPO_DIR (default:
# the current directory - i.e. run it from the repo directory itself, unless
# you point REPO_DIR elsewhere). The script file itself can live anywhere, e.g.
# a dedicated scripts/ directory one level below the repo (same convention as
# the sibling tapestry-frame-thumbnails, tapestry-thumbnail, and
# tapestry-backups skills):
#
#   cd my-tapestry-repo/scripts
#   REPO_DIR=.. ./manage-tapestry-visibility.sh wikimania
#
# Usage:
#   ./manage-tapestry-visibility.sh            # list everything, then pick one
#   ./manage-tapestry-visibility.sh <search>   # filter by title / slug / owner email
#   ./manage-tapestry-visibility.sh --help     # show this help
#
# Overridable via environment variables (defaults shown):
#   REPO_DIR=.
#   COMPOSE_FILE=docker-compose-fnf.yml
#   ENV_FILE=.env
#   DB_SERVICE=db   DB_USER=tapestries   DB_NAME=tapestries
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
    t.visibility,
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

# --- show current state of the chosen tapestry --------------------------------
CUR_TITLE="$(psql_exec -tAc "SELECT title FROM \"Tapestry\" WHERE id = '${ID}';")"
CUR_VIS="$(psql_exec -tAc "SELECT visibility FROM \"Tapestry\" WHERE id = '${ID}';")"
printf '\nSelected: %s%s%s\n' "$BOLD" "$CUR_TITLE" "$RESET"
printf '  id ........... %s\n' "$ID"
printf '  visibility ... %s%s%s\n' "$BOLD" "$CUR_VIS" "$RESET"

# --- choose new visibility ----------------------------------------------------
echo ""
echo "Set visibility to:"
echo "  1) private  ${DIM}(only the owner / invited users)${RESET}"
echo "  2) link     ${DIM}(anyone with the link)${RESET}"
echo "  3) public   ${DIM}(listed in Samples for everyone)${RESET}"
read -r -p "Choose [1-3] (or 'q' to quit): " vchoice
case "$vchoice" in
  1|private) NEW=private ;;
  2|link)    NEW=link ;;
  3|public)  NEW=public ;;
  q|Q|"")    echo "Cancelled."; exit 0 ;;
  *)         err "Invalid choice: $vchoice"; exit 1 ;;
esac

if [ "$NEW" = "$CUR_VIS" ]; then
  echo "Already '${NEW}'. Nothing to change."
  exit 0
fi

# --- confirm and apply --------------------------------------------------------
printf '\n%sChange visibility of "%s" from %s to %s?%s\n' "$YELLOW" "$CUR_TITLE" "$CUR_VIS" "$NEW" "$RESET"
read -r -p "Type 'yes' to confirm: " confirm
if [ "$confirm" != "yes" ]; then
  echo "Cancelled."
  exit 0
fi

psql_exec -v ON_ERROR_STOP=1 -c "UPDATE \"Tapestry\" SET visibility = '${NEW}' WHERE id = '${ID}';"

NOW="$(psql_exec -tAc "SELECT visibility FROM \"Tapestry\" WHERE id = '${ID}';")"
printf '%sDone — "%s" is now %s.%s\n' "$GREEN" "$CUR_TITLE" "$NOW" "$RESET"
