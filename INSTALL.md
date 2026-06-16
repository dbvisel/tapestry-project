# Installing Tapestry with the MinIO stack

`setup.sh` is a small interactive installer that configures and launches the
full Tapestry stack (client, API server, worker, PostgreSQL, Redis, MinIO, and
Vault) using Docker Compose. It asks a handful of questions, generates the
secrets for you, writes a `.env` file, and brings everything up.

## Prerequisites

- **Docker** with the **Docker Compose v2** plugin (`docker compose version`).
- **openssl**, **awk**, and **curl** (present by default on macOS and most Linux distros).
- This repository checked out locally. Run the installer from the repo root.

## Quick start

```sh
./setup.sh
```

Answer the prompts (press Enter to accept the shown default), wait for the
images to build, and open the URL it prints at the end — by default
<http://localhost:8080>.

## What it asks you

| Prompt | Default | Notes |
|---|---|---|
| **Host** | `localhost` | The hostname or IP a browser will use to reach the stack. Use your server's domain or IP for a remote install. |
| **Auth provider** | `ia` | `ia` = Internet Archive username/password login (no extra setup). `google` = "Sign in with Google". |
| **Google OAuth client ID** | — | Asked **only** if you chose `google`. See the [Google guide](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid). |
| **IA_ACCOUNT_ID / IA_SECRET** | empty | Optional. Only needed to enable archive.org shared-session auto-login when deploying under `*.archive.org`. Leave blank otherwise. |
| **Bug report form URL** | sample form | URL opened by the in-app "Report a bug" action. Leave blank to disable. |
| **Frontend Sentry DSN** | empty | Optional. Sentry DSN for the **browser app**'s crash reporting. Leave blank to disable. |
| **Backend Sentry DSN** | empty | Optional. Sentry DSN for the **API server**'s crash reporting (a separate Sentry project from the frontend). Leave blank to disable. |

On a first run, every prompt's default and all other values come from the
`.env.sample` template. On a re-run, they instead come from your existing `.env`
(see [Re-running](#re-running--starting-fresh) below).

## What it does for you

- **Generates secrets** — on a first run, `SECRET_KEY`, the database password
  (`DB_PASS`), and the MinIO/S3 secret (`AWS_SECRET_ACCESS_KEY`) are randomly
  generated. You never type a secret by hand, and the insecure placeholder
  values from the template are not used. On a re-run the existing secrets are
  preserved (see [Re-running](#re-running--starting-fresh)).
- **Derives the client URLs** from the host you entered (`VIEWER_URL`,
  `EXTERNAL_SERVER_URL`, `VITE_API_URL`) so they stay consistent.
- **Writes `.env`** by replacing only the relevant keys in the base file (the
  `.env.sample` template on a first run, or your existing `.env` on a re-run),
  leaving every other key untouched.
- **Keeps frontend/backend Sentry DSNs and the bug-report URL in sync** between
  their runtime keys and the `VITE_*` build-arg counterparts the client needs.
- **Fixes `VAULT_ADDR`** so the server reaches the Vault container on the
  Compose network (`http://vault:8200`).
- **Builds and starts** the stack with
  `docker compose --env-file .env -f docker-compose.minio.yml up -d --build`,
  then health-checks the client, API, and MinIO and prints the container status.

> **Why it always rebuilds the client:** the client is a static bundle and its
> `VITE_*` settings (API URL, auth provider, Google client ID) are baked in at
> **build time**. Rebuilding on every run guarantees the running client matches
> your `.env`. The server and worker read their config at runtime, so they only
> need a restart.

## Options

```sh
./setup.sh                 # configure, write .env, build and start (default)
./setup.sh --no-start      # only write .env; start later yourself
./setup.sh --output FILE   # write to FILE instead of .env
./setup.sh --help
```

To start later (after `--no-start`):

```sh
docker compose --env-file .env -f docker-compose.minio.yml up -d --build
```

## After installation

| Service | URL |
|---|---|
| Tapestry app (client) | <http://localhost:8080> |
| API server | <http://localhost:3000> |
| MinIO console | <http://localhost:9001> |
| MinIO S3 API | <http://localhost:9000> |

(Replace `localhost` with the host you configured.)

The asset bucket (`tabucket` by default) is created automatically by the `mc`
service on startup.

## Re-running / starting fresh

**Re-running is safe.** When an existing `.env` is found, the installer uses
*its* saved values as the prompt defaults (not the `.env.sample` template), so
you can press Enter through anything you don't want to change. Crucially, it
**keeps the existing secrets** (`SECRET_KEY`, `DB_PASS`, `AWS_SECRET_ACCESS_KEY`)
rather than regenerating them, so your existing database and asset volumes keep
working. This makes it convenient to, say, change the host or add a Sentry DSN
later — just re-run and update that one answer.

Secrets are generated **only** when they're missing — i.e. a true first run
(no `.env`), or a key that isn't present in the file yet.

**Starting completely fresh** (new secrets, empty database): remove the old
`.env` and data volumes first, then run the installer.

```sh
docker compose -f docker-compose.minio.yml down -v
rm -f .env
./setup.sh
```

## Troubleshooting

- **A service reports "not ready" at the end.** Check its logs:
  ```sh
  docker compose --env-file .env -f docker-compose.minio.yml logs <service>
  ```
  (`<service>` is one of `client`, `server`, `worker`, `db`, `redis`, `minio`, `mc`, `vault`.)
- **Postgres authentication errors after re-running.** You changed secrets but
  kept old volumes — see [Re-running / starting fresh](#re-running--starting-fresh).
- **Port already in use.** Another process is using 8080, 3000, 9000, 9001,
  5432, 6379, or 8200. Stop it, or change the published ports in
  `docker-compose.minio.yml` (the installer keeps these at their defaults).
- **Vault errors in the server log.** Vault is optional (used only for
  user-supplied AI API keys). The rest of the app works without it.
</content>
