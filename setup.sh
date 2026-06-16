#!/usr/bin/env bash
#
# setup.sh - Minimal interactive installer for the Tapestry MinIO stack.
#
# Collects a small set of values, generates secrets, writes a .env file
# (using .env.sample as the template for all other defaults), and then
# brings the stack up with docker compose.
#
# Usage:
#   ./setup.sh                 # interactive: configure, write .env, start stack
#   ./setup.sh --no-start      # configure and write .env, but don't start
#   ./setup.sh --output FILE   # write to FILE instead of .env (default: .env)
#
set -euo pipefail

# --- locate ourselves so the script works from any directory -----------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

TEMPLATE=".env.sample"
COMPOSE_FILE="docker-compose.minio.yml"
ENV_FILE=".env"
START=1

# --- pretty output ------------------------------------------------------------
if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); GREEN=$(printf '\033[32m')
  YELLOW=$(printf '\033[33m'); RED=$(printf '\033[31m'); RESET=$(printf '\033[0m')
else
  BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; RESET=""
fi
info()  { printf '%s\n' "$*"; }
ok()    { printf '%s%s%s\n' "$GREEN" "$*" "$RESET"; }
warn()  { printf '%s%s%s\n' "$YELLOW" "$*" "$RESET"; }
err()   { printf '%s%s%s\n' "$RED" "$*" "$RESET" >&2; }
hdr()   { printf '\n%s%s%s\n' "$BOLD" "$*" "$RESET"; }

# --- args ---------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --no-start)   START=0; shift ;;
    --output)     ENV_FILE="${2:?--output needs a path}"; shift 2 ;;
    -h|--help)    grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            err "Unknown argument: $1"; exit 2 ;;
  esac
done

# --- prerequisites ------------------------------------------------------------
need() { command -v "$1" >/dev/null 2>&1 || { err "Required command not found: $1"; exit 1; }; }
need openssl
need awk
need curl
if [ "$START" -eq 1 ]; then
  need docker
  docker compose version >/dev/null 2>&1 || { err "'docker compose' is not available."; exit 1; }
fi
[ -f "$TEMPLATE" ] || { err "Template $TEMPLATE not found (run from the repo root)."; exit 1; }

# --- helpers ------------------------------------------------------------------
# ask VAR "Prompt" "default"  -> prompts with default, stores answer in VAR.
# Long defaults (URLs, DSNs) are truncated in the display but applied in full.
ask() {
  local __var="$1" __prompt="$2" __default="${3:-}" __reply __shown
  if [ -n "$__default" ]; then
    if [ "${#__default}" -gt 60 ]; then __shown="${__default:0:57}..."; else __shown="$__default"; fi
    read -r -p "$__prompt ${DIM}[$__shown]${RESET}: " __reply || true
    __reply="${__reply:-$__default}"
  else
    read -r -p "$__prompt ${DIM}(optional, Enter to skip)${RESET}: " __reply || true
  fi
  printf -v "$__var" '%s' "$__reply"
}

# get_env KEY FILE  -> prints KEY's value from FILE (everything after the first
# '='), or nothing if absent. Preserves '=' and special chars in the value.
get_env() {
  local key="$1" file="$2" line
  [ -f "$file" ] || return 0
  line="$(grep -m1 "^${key}=" "$file" 2>/dev/null)" || true
  printf '%s' "${line#"${key}="}"
}

# set_env KEY VALUE  -> replace KEY's line in $ENV_FILE, or append if missing.
# Uses awk (not sed) so values containing / & : etc. are written literally.
set_env() {
  local key="$1" val="$2" tmp
  tmp="$(mktemp)"
  if grep -q "^${key}=" "$ENV_FILE"; then
    awk -v k="$key" -v v="$val" '
      $0 ~ "^" k "=" { print k "=" v; next }
      { print }
    ' "$ENV_FILE" > "$tmp"
  else
    cat "$ENV_FILE" > "$tmp"
    printf '%s=%s\n' "$key" "$val" >> "$tmp"
  fi
  mv "$tmp" "$ENV_FILE"
}

gen_secret() { openssl rand -hex 24; }   # 48 hex chars, URL- and shell-safe

# --- choose where defaults come from ------------------------------------------
# On a re-run we want the questions pre-filled from the values already saved to
# the existing .env (and the existing secrets kept untouched). On a first run
# there is no .env, so we fall back to the .env.sample template.
if [ -f "$ENV_FILE" ]; then
  SOURCE="$ENV_FILE"
  RERUN=1
else
  SOURCE="$TEMPLATE"
  RERUN=0
fi

hdr "Tapestry installer"
if [ "$RERUN" -eq 1 ]; then
  info "Existing ${BOLD}$ENV_FILE${RESET} found — its current values are the defaults below."
  info "Saved secrets will be kept as-is (so existing data volumes keep working)."
else
  info "No $ENV_FILE yet — starting from the $TEMPLATE sample."
fi
info "Press Enter to accept the ${DIM}[default]${RESET}."

# ---- curated questions -------------------------------------------------------
hdr "Networking"
info "Hostname or IP where this stack will be reached from a browser."
info "Use 'localhost' for a local install, or the server's domain/IP otherwise."
ask HOST "Host" "$(get_env HOST "$SOURCE")"
HOST="${HOST:-localhost}"

hdr "Authentication"
info "'ia' = Internet Archive username/password login (no extra config)."
info "'google' = Sign in with Google (needs an OAuth client ID)."
while :; do
  ask AUTH_PROVIDER "Auth provider (ia/google)" "$(get_env AUTH_PROVIDER "$SOURCE")"
  AUTH_PROVIDER="${AUTH_PROVIDER:-ia}"
  case "$AUTH_PROVIDER" in ia|google) break ;; *) warn "Enter 'ia' or 'google'." ;; esac
done
GOOGLE_CLIENT_ID="$(get_env GOOGLE_CLIENT_ID "$SOURCE")"
if [ "$AUTH_PROVIDER" = "google" ]; then
  ask GOOGLE_CLIENT_ID "Google OAuth client ID" "$GOOGLE_CLIENT_ID"
fi

hdr "Internet Archive shared sessions (optional)"
info "Only needed if deploying under *.archive.org for auto-login. Leave blank to skip."
ask IA_ACCOUNT_ID "IA_ACCOUNT_ID" "$(get_env IA_ACCOUNT_ID "$SOURCE")"
ask IA_SECRET     "IA_SECRET"     "$(get_env IA_SECRET "$SOURCE")"

hdr "Bug report form"
info "URL of the form opened by the in-app 'Report a bug' action. Leave blank to disable."
ask BUG_REPORT_FORM_URL "Bug report form URL" "$(get_env BUG_REPORT_FORM_URL "$SOURCE")"

hdr "Sentry error reporting (optional)"
info "Sentry DSNs for crash reporting. Leave blank to disable. They are separate"
info "projects for the browser app and the API server."
ask SENTRY_DSN_CLIENT "Frontend (client) Sentry DSN" "$(get_env SENTRY_DSN_CLIENT "$SOURCE")"
ask SENTRY_DSN_SERVER "Backend (server) Sentry DSN"  "$(get_env SENTRY_DSN_SERVER "$SOURCE")"

# ---- derive dependent values -------------------------------------------------
# Ports are fixed by the compose file's published mappings (8080 client,
# 3000 API), so we only vary the host portion of the URLs.
VIEWER_URL="http://${HOST}:8080"
EXTERNAL_SERVER_URL="http://${HOST}:3000"
VITE_API_URL="http://${HOST}:3000/api"

# ---- secrets: keep existing ones on re-run, generate them on first run -------
if [ "$RERUN" -eq 1 ]; then
  SECRET_KEY="$(get_env SECRET_KEY "$SOURCE")"
  DB_PASS="$(get_env DB_PASS "$SOURCE")"
  AWS_SECRET_ACCESS_KEY="$(get_env AWS_SECRET_ACCESS_KEY "$SOURCE")"
  MINIO_CONSOLE_SECRET_KEY="$(get_env MINIO_CONSOLE_SECRET_KEY "$SOURCE")"
  VAULT_ROLE_ID="$(get_env VAULT_ROLE_ID "$SOURCE")"
  VAULT_SECRET_ID="$(get_env VAULT_SECRET_ID "$SOURCE")"
  SECRETS_NOTE="kept from existing $ENV_FILE"
fi
# Generate any that are missing (first run, or a key absent from the .env).
# VAULT_ROLE_ID/VAULT_SECRET_ID can be any consistent pair: the dev vault seeds
# its approle from these same values (see deployment/vault/start-dev.sh).
[ -n "${SECRET_KEY:-}" ]               || { SECRET_KEY="$(openssl rand -hex 32)"; SECRETS_NOTE="generated"; }
[ -n "${DB_PASS:-}" ]                  || { DB_PASS="$(gen_secret)"; SECRETS_NOTE="generated"; }
[ -n "${AWS_SECRET_ACCESS_KEY:-}" ]    || { AWS_SECRET_ACCESS_KEY="$(gen_secret)"; SECRETS_NOTE="generated"; }
[ -n "${MINIO_CONSOLE_SECRET_KEY:-}" ] || { MINIO_CONSOLE_SECRET_KEY="$(gen_secret)"; SECRETS_NOTE="generated"; }
[ -n "${VAULT_ROLE_ID:-}" ]            || { VAULT_ROLE_ID="$(gen_secret)"; SECRETS_NOTE="generated"; }
[ -n "${VAULT_SECRET_ID:-}" ]          || { VAULT_SECRET_ID="$(gen_secret)"; SECRETS_NOTE="generated"; }
: "${SECRETS_NOTE:=generated}"

# ---- write the env file ------------------------------------------------------
hdr "Writing $ENV_FILE"
# Start from the source: the template on first run, or the existing .env on a
# re-run (so manual edits and untouched keys are preserved). When the source is
# already the target file we edit it in place.
[ "$SOURCE" = "$ENV_FILE" ] || cp "$SOURCE" "$ENV_FILE"

# runtime (server / worker) values
set_env HOST                  "$HOST"
set_env VIEWER_URL            "$VIEWER_URL"
set_env EXTERNAL_SERVER_URL   "$EXTERNAL_SERVER_URL"
set_env AUTH_PROVIDER         "$AUTH_PROVIDER"
set_env GOOGLE_CLIENT_ID      "$GOOGLE_CLIENT_ID"
set_env IA_ACCOUNT_ID         "$IA_ACCOUNT_ID"
set_env IA_SECRET             "$IA_SECRET"
set_env BUG_REPORT_FORM_URL   "$BUG_REPORT_FORM_URL"
set_env SENTRY_DSN_CLIENT     "$SENTRY_DSN_CLIENT"
set_env SENTRY_DSN_SERVER     "$SENTRY_DSN_SERVER"
set_env SECRET_KEY               "$SECRET_KEY"
set_env DB_PASS                  "$DB_PASS"
set_env AWS_SECRET_ACCESS_KEY    "$AWS_SECRET_ACCESS_KEY"
set_env MINIO_CONSOLE_SECRET_KEY "$MINIO_CONSOLE_SECRET_KEY"
set_env VAULT_ROLE_ID            "$VAULT_ROLE_ID"
set_env VAULT_SECRET_ID          "$VAULT_SECRET_ID"
# Inside the compose network the vault service is reachable as 'vault',
# not localhost; the sample already sets this, but enforce it for older .env files.
set_env VAULT_ADDR               "http://vault:8200"

# build-time (client) values — baked into the client image, kept in sync with
# their runtime counterparts above.
set_env VITE_API_URL              "$VITE_API_URL"
set_env VITE_AUTH_PROVIDER        "$AUTH_PROVIDER"
set_env VITE_GOOGLE_CLIENT_ID     "$GOOGLE_CLIENT_ID"
set_env VITE_BUG_REPORT_FORM_URL  "$BUG_REPORT_FORM_URL"
set_env VITE_SENTRY_DSN_CLIENT    "$SENTRY_DSN_CLIENT"

ok "Wrote $ENV_FILE"
info "  Host ............ $HOST"
info "  Client URL ...... $VIEWER_URL"
info "  API URL ......... $EXTERNAL_SERVER_URL"
info "  Auth provider ... $AUTH_PROVIDER"
info "  Bug report URL .. ${BUG_REPORT_FORM_URL:-(none)}"
info "  Frontend Sentry . ${SENTRY_DSN_CLIENT:-(none)}"
info "  Backend Sentry .. ${SENTRY_DSN_SERVER:-(none)}"
info "  Secrets ......... $SECRETS_NOTE (SECRET_KEY, DB_PASS, AWS/MinIO + Vault creds)"

# --- start the stack ----------------------------------------------------------
if [ "$START" -eq 0 ]; then
  hdr "Done (config only)"
  info "Start later with:"
  info "  docker compose --env-file $ENV_FILE -f $COMPOSE_FILE up -d --build"
  exit 0
fi

hdr "Starting the stack"
if [ "$SECRETS_NOTE" = "generated" ]; then
  warn "Note: new secrets were generated. If a previous install left data volumes,"
  warn "they won't match — run 'docker compose -f $COMPOSE_FILE down -v' first."
fi
info "Building images and starting containers (this can take a while)..."
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --build

# --- health checks ------------------------------------------------------------
hdr "Waiting for services"
check() { # check NAME URL EXPECTED_CODE
  local name="$1" url="$2" want="$3" code i
  for i in $(seq 1 60); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)"
    if [ "$code" = "$want" ]; then ok "  $name OK ($url)"; return 0; fi
    sleep 2
  done
  err "  $name not ready (last HTTP $code at $url)"; return 1
}

rc=0
check "MinIO " "http://${HOST}:9000/minio/health/live" "200" || rc=1
check "Client" "http://${HOST}:8080/"                  "200" || rc=1
# server's root is unrouted; a real API route confirms migrations + DB are up
check "Server" "http://${HOST}:3000/api/tapestries"    "200" || rc=1

hdr "Status"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps

if [ "$rc" -eq 0 ]; then
  ok "\nTapestry is up. Open ${VIEWER_URL:-http://${HOST}:8080}"
  info "MinIO console: http://${HOST}:9001"
else
  err "\nSome services did not come up. Inspect logs with:"
  info "  docker compose --env-file $ENV_FILE -f $COMPOSE_FILE logs <service>"
  exit 1
fi
