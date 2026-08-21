#!/usr/bin/env bash
#
# manage-tapestry-frame-thumbnails.sh
#
# Interactively list tapestries (with a count of FRAMES missing a FRAME
# thumbnail), show a per-tapestry dashboard of every frame's thumbnail status,
# and schedule frame-thumbnail generation for a selected tapestry - the same
# generateThumbnails() the app itself calls on normal item creation and on zip
# import (as of commit 003243a). Useful for tapestries imported before that fix
# landed, whose frames never got a thumbnail and never will unless backfilled.
#
# IMPORTANT - two different "thumbnail" concepts, don't confuse them:
#   - FRAME thumbnail: the small preview image belonging to one object (an
#     "Item" row) placed on a tapestry's canvas - a poster, an image, a video,
#     etc. This is what this script inspects and backfills. Everything in its
#     output ("frames", "frame thumbnail", the per-tapestry dashboard) is about
#     this, one row per frame.
#   - TAPESTRY thumbnail: the single card-preview image of the *tapestry as a
#     whole* (the `Tapestry.thumbnail` column - what shows up in dashboards/
#     the Samples list). This script does NOT manage that directly and has no
#     UI for it. That said: the app's job pipeline regenerates it as a side
#     effect of the exact same job this script schedules (see
#     `generate-tapestry-thumbnails.ts` - it always retakes the whole-tapestry
#     screenshot first, before touching any frame), so running this script
#     WILL incidentally refresh the tapestry's own card thumbnail too. If you
#     want a script whose actual purpose is managing that (not just a side
#     effect), write a separate one - don't fold it into this one.
#
# Listing/selection runs against Postgres via `docker compose exec` (read-only,
# same as you'd do by hand). Scheduling generation actually runs the app's own
# code: this script copies the bundled run-generate-frame-thumbnails.ts into
# the EXEC_SERVICE container, runs it once via tsx, then removes it. Generation
# itself then happens asynchronously in the already-running worker service.
#
# Run it with the repo directory as REPO_DIR (default: the current directory -
# i.e. run it from the repo directory itself, unless you point REPO_DIR
# elsewhere). The script file itself can live anywhere, e.g. a dedicated
# scripts/ directory one level below the repo:
#
#   cd my-tapestry-repo/scripts
#   REPO_DIR=.. ./manage-tapestry-frame-thumbnails.sh wikimania
#
# Usage:
#   ./manage-tapestry-frame-thumbnails.sh            # list everything, then pick one
#   ./manage-tapestry-frame-thumbnails.sh <search>   # filter by title / slug / owner email
#   ./manage-tapestry-frame-thumbnails.sh --help     # show this help
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

# Where this script (and its sibling run-generate-frame-thumbnails.ts) live -
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

# Types that can have an inherently-generated FRAME thumbnail at all (mirrors
# ITEM_TYPES_WITH_INHERENT_THUMBNAIL in server/src/tasks/thumbnail-generators/index.ts).
# 'text' and 'actionButton' frames never get one and shouldn't count as "missing".
THUMBNAILABLE_TYPES="'image','video','pdf','webpage'"

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
    (SELECT COUNT(*) FROM \"Item\" i WHERE i.\"tapestryId\" = t.id) AS frames,
    (SELECT COUNT(*) FROM \"Item\" i
       WHERE i.\"tapestryId\" = t.id
         AND i.\"thumbnailId\" IS NULL
         AND i.type::text IN (${THUMBNAILABLE_TYPES})) AS missing_frame_thumbs,
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

# --- per-tapestry dashboard: every frame and its (frame) thumbnail status -----
# Not to be confused with the tapestry's own single card thumbnail - see the
# header comment. Every row below is one frame (Item) inside the tapestry.
CUR_TITLE="$(psql_exec -tAc "SELECT title FROM \"Tapestry\" WHERE id = '${ID}';")"
printf '\nSelected: %s%s%s\n' "$BOLD" "$CUR_TITLE" "$RESET"
printf '  id ... %s\n\n' "$ID"

printf '%sFrames and their frame thumbnails%s\n' "$BOLD" "$RESET"
psql_exec -P pager=off -c "
  SELECT
    row_number() OVER (ORDER BY i.\"createdAt\", i.id) AS \"#\",
    i.type,
    COALESCE(NULLIF(i.title, ''), '(untitled)') AS title,
    CASE
      WHEN i.\"thumbnailId\" IS NULL AND i.type::text NOT IN (${THUMBNAILABLE_TYPES}) THEN 'n/a'
      WHEN i.\"thumbnailId\" IS NULL THEN 'none'
      ELSE (SELECT COUNT(*) FROM \"ImageAssetRendition\" r WHERE r.\"assetId\" = i.\"thumbnailId\")::text || ' rendition(s)'
    END AS frame_thumbnail,
    COALESCE(i.\"scheduledThumbnailProcessing\"::text, '-') AS scheduled,
    i.id
  FROM \"Item\" i
  WHERE i.\"tapestryId\" = '${ID}'
  ORDER BY i.\"createdAt\", i.id;
"

MISSING="$(psql_exec -tAc "
  SELECT COUNT(*) FROM \"Item\" i
  WHERE i.\"tapestryId\" = '${ID}'
    AND i.\"thumbnailId\" IS NULL
    AND i.type::text IN (${THUMBNAILABLE_TYPES});
")"
TOTAL_CAPABLE="$(psql_exec -tAc "
  SELECT COUNT(*) FROM \"Item\" i
  WHERE i.\"tapestryId\" = '${ID}'
    AND i.type::text IN (${THUMBNAILABLE_TYPES});
")"
printf '\n%s%s of %s thumbnail-capable frames are missing a frame thumbnail.%s\n' \
  "$BOLD" "$MISSING" "$TOTAL_CAPABLE" "$RESET"

if [ "$MISSING" -eq 0 ]; then
  echo "Nothing to backfill."
  exit 0
fi

# --- confirm and schedule generation -------------------------------------------
echo ""
echo "This schedules FRAME thumbnail generation for every frame in this tapestry"
echo "(harmless for frames that already have one - only missing ones are actually"
echo "filled in). As a side effect of the app's shared job pipeline, the tapestry's"
echo "own single card thumbnail is also refreshed - that's not this script's"
echo "purpose, just an inherent side effect of how the app implements it."
read -r -p "Type 'yes' to schedule frame-thumbnail generation for \"${CUR_TITLE}\": " confirm
if [ "$confirm" != "yes" ]; then
  echo "Cancelled."
  exit 0
fi

RUNNER="run-generate-frame-thumbnails.ts"
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
  printf '\n%sScheduled.%s Generation runs asynchronously in the "%s" service.\n' "$GREEN" "$RESET" "$EXEC_SERVICE"
  echo "Re-run this script against the same tapestry in a bit to watch the dashboard fill in."
else
  err "Failed to schedule frame-thumbnail generation - see error above."
  exit 1
fi
