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

# print_s3_setup : print the manual AWS-side steps needed before uploads work.
# Reads AWS_S3_BUCKET_NAME / AWS_REGION / VIEWER_URL (globals) at call time.
print_s3_setup() {
  printf '\n%s== Amazon S3 setup (do this in your AWS account) ==%s\n' "$BOLD" "$RESET"
  printf 'Bucket "%s" in region "%s" must exist and be configured as below before uploads work.\n' \
    "$AWS_S3_BUCKET_NAME" "$AWS_REGION"

  printf '\n%s1) CORS%s — browser uploads/downloads use presigned URLs (cross-origin).\n' "$BOLD" "$RESET"
  printf '   Save as cors.json, then:\n'
  printf '     aws s3api put-bucket-cors --bucket %s --cors-configuration file://cors.json\n' "$AWS_S3_BUCKET_NAME"
  cat <<EOF
{
  "CORSRules": [
    {
      "AllowedOrigins": ["${VIEWER_URL}"],
      "AllowedMethods": ["GET", "PUT", "POST", "HEAD"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"]
    }
  ]
}
EOF

  printf '\n%s2) IAM%s — the credentials (or instance role) need these permissions:\n' "$BOLD" "$RESET"
  cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::${AWS_S3_BUCKET_NAME}",
        "arn:aws:s3:::${AWS_S3_BUCKET_NAME}/*"
      ]
    }
  ]
}
EOF
  printf '\n%s3)%s If you left the credentials blank, the server uses the default AWS\n' "$BOLD" "$RESET"
  printf '   credential chain (EC2 instance role / ~/.aws / AWS_* env on the host).\n'
}

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
[ -n "${MINIO_CONSOLE_SECRET_KEY:-}" ] || { MINIO_CONSOLE_SECRET_KEY="$(gen_secret)"; SECRETS_NOTE="generated"; }
[ -n "${VAULT_ROLE_ID:-}" ]            || { VAULT_ROLE_ID="$(gen_secret)"; SECRETS_NOTE="generated"; }
[ -n "${VAULT_SECRET_ID:-}" ]          || { VAULT_SECRET_ID="$(gen_secret)"; SECRETS_NOTE="generated"; }
: "${SECRETS_NOTE:=generated}"

# ---- storage backend: bundled MinIO or the user's own AWS S3 -----------------
hdr "Storage backend"
info "Where to store tapestry assets (uploaded images, generated thumbnails)."
info "  minio - bundled, self-hosted S3 (no AWS account needed)"
info "  aws   - your own Amazon S3 bucket"
# Default to the previous choice on re-run (an empty AWS_ENDPOINT_URL == real AWS).
if [ "$RERUN" -eq 1 ] && [ -z "$(get_env AWS_ENDPOINT_URL "$SOURCE")" ]; then
  DEF_STORAGE=aws
else
  DEF_STORAGE=minio
fi
while :; do
  ask STORAGE "Storage backend (minio/aws)" "$DEF_STORAGE"
  STORAGE="${STORAGE:-minio}"
  case "$STORAGE" in minio|aws) break ;; *) warn "Enter 'minio' or 'aws'." ;; esac
done

if [ "$STORAGE" = "aws" ]; then
  info "Configure your Amazon S3 bucket (setup steps are printed at the end)."
  ask AWS_REGION         "AWS region"      "$(get_env AWS_REGION "$SOURCE")"
  AWS_REGION="${AWS_REGION:-us-east-1}"
  ask AWS_S3_BUCKET_NAME "S3 bucket name"  "$(get_env AWS_S3_BUCKET_NAME "$SOURCE")"
  info "Credentials: leave BOTH blank to use the host's default AWS credential chain"
  info "(EC2 instance role / ~/.aws / AWS_* env on the server)."
  ask AWS_ACCESS_KEY_ID     "AWS access key ID"     "$(get_env AWS_ACCESS_KEY_ID "$SOURCE")"
  ask AWS_SECRET_ACCESS_KEY "AWS secret access key" "$(get_env AWS_SECRET_ACCESS_KEY "$SOURCE")"
  # Empty endpoint => the SDK talks to real AWS; virtual-hosted style.
  AWS_ENDPOINT_URL=""
  # Real AWS is reachable the same way from the server/worker containers as from the browser.
  AWS_INTERNAL_ENDPOINT_URL=""
  AWS_S3_FORCE_PATH_STYLE="false"
  COMPOSE_PROFILES_PREFIX=""
  export COMPOSE_PROFILES=""
else
  # Bundled MinIO: keep the known-good local values; its secret is generated
  # (or kept on re-run) like the other secrets.
  AWS_REGION="$(get_env AWS_REGION "$SOURCE")";                 AWS_REGION="${AWS_REGION:-us-east-1}"
  AWS_S3_BUCKET_NAME="$(get_env AWS_S3_BUCKET_NAME "$SOURCE")"; AWS_S3_BUCKET_NAME="${AWS_S3_BUCKET_NAME:-tabucket}"
  AWS_ACCESS_KEY_ID="$(get_env AWS_ACCESS_KEY_ID "$SOURCE")";   AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-tapestries}"
  AWS_ENDPOINT_URL="$(get_env AWS_ENDPOINT_URL "$SOURCE")";     AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:9000}"
  # The browser reaches MinIO via the published port on $HOST, but the server/worker
  # containers can't resolve $HOST that way — they must reach it as the 'minio' service
  # on the Compose network instead.
  AWS_INTERNAL_ENDPOINT_URL="http://minio:9000"
  AWS_S3_FORCE_PATH_STYLE="true"
  [ "$RERUN" -eq 1 ] && AWS_SECRET_ACCESS_KEY="$(get_env AWS_SECRET_ACCESS_KEY "$SOURCE")"
  [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] || { AWS_SECRET_ACCESS_KEY="$(gen_secret)"; SECRETS_NOTE="generated"; }
  # The minio + mc services live behind the 'minio' compose profile.
  COMPOSE_PROFILES_PREFIX="COMPOSE_PROFILES=minio "
  export COMPOSE_PROFILES="minio"
fi

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
set_env MINIO_CONSOLE_SECRET_KEY "$MINIO_CONSOLE_SECRET_KEY"
# storage (MinIO or AWS S3) — values differ per backend, see the section above
set_env AWS_ENDPOINT_URL          "$AWS_ENDPOINT_URL"
set_env AWS_INTERNAL_ENDPOINT_URL "$AWS_INTERNAL_ENDPOINT_URL"
set_env AWS_S3_FORCE_PATH_STYLE  "$AWS_S3_FORCE_PATH_STYLE"
set_env AWS_REGION               "$AWS_REGION"
set_env AWS_S3_BUCKET_NAME       "$AWS_S3_BUCKET_NAME"
set_env AWS_ACCESS_KEY_ID        "$AWS_ACCESS_KEY_ID"
set_env AWS_SECRET_ACCESS_KEY    "$AWS_SECRET_ACCESS_KEY"
set_env VAULT_ROLE_ID            "$VAULT_ROLE_ID"
set_env VAULT_SECRET_ID          "$VAULT_SECRET_ID"
# Inside the compose network the vault service is reachable as 'vault',
# not localhost; the sample already sets this, but enforce it for older .env files.
set_env VAULT_ADDR               "http://vault:8200"

# VITE_API_URL is the only VITE_-prefixed key the compose file reads directly.
# The client's other build args (VITE_AUTH_PROVIDER, VITE_BUG_REPORT_FORM_URL,
# VITE_SENTRY_DSN, ...) are mapped by docker-compose.minio.yml from the non-VITE
# keys set above, so there's nothing else to write here.
set_env VITE_API_URL              "$VITE_API_URL"

ok "Wrote $ENV_FILE"
info "  Host ............ $HOST"
info "  Client URL ...... $VIEWER_URL"
info "  API URL ......... $EXTERNAL_SERVER_URL"
info "  Auth provider ... $AUTH_PROVIDER"
if [ "$STORAGE" = "aws" ]; then
  info "  Storage ......... AWS S3 (bucket '${AWS_S3_BUCKET_NAME}', region ${AWS_REGION})"
else
  info "  Storage ......... bundled MinIO (bucket '${AWS_S3_BUCKET_NAME}')"
fi
info "  Bug report URL .. ${BUG_REPORT_FORM_URL:-(none)}"
info "  Frontend Sentry . ${SENTRY_DSN_CLIENT:-(none)}"
info "  Backend Sentry .. ${SENTRY_DSN_SERVER:-(none)}"
info "  Secrets ......... $SECRETS_NOTE (SECRET_KEY, DB_PASS, AWS/MinIO + Vault creds)"

# --- start the stack ----------------------------------------------------------
# COMPOSE_PROFILES (exported in the storage section) controls whether the
# minio + mc services start: "minio" for the bundled backend, "" for AWS S3.
if [ "$START" -eq 0 ]; then
  hdr "Done (config only)"
  info "Start later with:"
  info "  ${COMPOSE_PROFILES_PREFIX}docker compose --env-file $ENV_FILE -f $COMPOSE_FILE up -d --build"
  [ "$STORAGE" = "aws" ] && print_s3_setup
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
# MinIO only runs for the bundled backend.
[ "$STORAGE" = "minio" ] && { check "MinIO " "http://${HOST}:9000/minio/health/live" "200" || rc=1; }
check "Client" "http://${HOST}:8080/"                  "200" || rc=1
# server's root is unrouted; a real API route confirms migrations + DB are up
check "Server" "http://${HOST}:3000/api/tapestries"    "200" || rc=1

hdr "Status"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps

if [ "$rc" -eq 0 ]; then
  ok "\nTapestry is up. Open ${VIEWER_URL:-http://${HOST}:8080}"
  [ "$STORAGE" = "minio" ] && info "MinIO console: http://${HOST}:9001"
  [ "$STORAGE" = "aws" ] && print_s3_setup
  exit 0
else
  err "\nSome services did not come up. Inspect logs with:"
  info "  docker compose --env-file $ENV_FILE -f $COMPOSE_FILE logs <service>"
  exit 1
fi
