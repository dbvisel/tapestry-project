# Updating the archive.org deployment

This VM (`tapestries.archive.org`) runs a customized checkout of
[asteasolutions/tapestry-project](https://github.com/asteasolutions/tapestry-project).
The customizations exist as commits on top of upstream `main` rather than as a
separate long-lived fork, because the goal is to keep pulling upstream
improvements over time. This doc is the repeatable process for doing that.

## Why it's structured this way

- You don't have push access to `asteasolutions/tapestry-project`, so all work
  happens against a personal fork: `dbvisel/tapestry-project`.
- The VM's own customizations (Minio-based deployment config, IA-specific
  auth/UX tweaks, CSP headers, cache-control headers, etc.) live as commits on
  a branch called `archive-version` (and its successors, e.g.
  `archive-version-updated`), not on `main`.
- Some customization files don't exist upstream at all — `docker-compose-fnf.yml`,
  `Dockerfile.client-fnf`, `manage-tapestry-visibility.sh` — so they never
  conflict during a merge; they just carry forward automatically.
- `.env` is gitignored and lives only on the VM. It's never part of any of
  this and doesn't need special handling beyond "don't delete it."

## One-time facts worth knowing

- Docker Compose project name for this stack is `tapestry-project`, derived
  from the checkout directory name (`docker-compose-fnf.yml` sets no explicit
  `name:`). This determines the actual volume names: `tapestry-project_pgdata`,
  `tapestry-project_vault-data`, `tapestry-project_minio-data`. **Don't rename
  the checkout directory or add a `-p`/`name:` override** without deliberately
  migrating those volumes, or `docker compose up` will silently create fresh,
  empty volumes instead of reusing the real data.
- `server`'s `start:api` script runs `prisma migrate deploy` automatically on
  boot, so pulling in upstream schema migrations and restarting the `server`
  container is enough to apply them — no separate migration step needed. This
  also means you should check incoming migrations for anything destructive
  before updating (see below).

## The update process

### 1. Back up before touching anything

```bash
cd ~/tapestries/tapestry-project
docker compose -f docker-compose-fnf.yml exec db pg_dump -U tapestries -d tapestries -F c -f /tmp/backup.dump
docker compose -f docker-compose-fnf.yml cp db:/tmp/backup.dump ./tapestries_pg_backup_$(date +%F).dump

docker run --rm -v tapestry-project_minio-data:/data -v $(pwd):/backup alpine \
  tar czf /backup/minio_backup_$(date +%F).tar.gz -C /data .
```

Copy both files off the VM if possible. These are untracked/gitignored and
safe to leave in the checkout directory otherwise.

### 2. Get the VM's current customizations into a branch, and merge upstream elsewhere

Because the VM has no direct access from your dev machine (and no push access
to upstream), the merge happens in a separate clone, not on the VM:

On the VM — commit whatever's currently uncommitted and push it:

```bash
git add -A
git commit -m "Archive.org VM deployment customizations"
git remote add dbvisel https://github.com/dbvisel/tapestry-project.git   # if not already added
git push dbvisel archive-version   # or whatever the current branch is named
```

Elsewhere (a normal dev clone with push access to `dbvisel/tapestry-project`):

```bash
git remote add dbvisel https://github.com/dbvisel/tapestry-project.git   # if not already added
git fetch dbvisel
git fetch origin main
git checkout -b archive-version-updated dbvisel/archive-version
git merge origin/main
# resolve conflicts, keeping the VM customization's *intent* — check what
# each side actually changed relative to the merge base before choosing:
#   git diff <merge-base> archive-version -- <file>
#   git diff <merge-base> origin/main -- <file>
```

After resolving conflicts:

```bash
npm ci
npm run -w server prisma:generate   # needed before `npm run lint` will typecheck the server
npm run lint   # runs tsc --build + eslint + prettier --check across every workspace
```

Fix any Prettier complaints with `npx prettier --write <file>` inside the
relevant workspace — hand-edited files on the VM often aren't pre-formatted.
Check any new Prisma migrations under `server/prisma/migrations/` for
destructive changes (dropped columns/tables, non-nullable columns without a
default) before proceeding — those need a manual data-safe migration plan
instead of a blind `up -d`.

Once `npm run lint` is clean:

```bash
git push dbvisel archive-version-updated
```

### 3. Pull the merged branch onto the VM

```bash
git remote add dbvisel https://github.com/dbvisel/tapestry-project.git   # if not already added
git fetch dbvisel
git checkout -b archive-version-updated dbvisel/archive-version-updated
ls -la .env   # sanity check it's still there — git never touches it
```

### 4. Rebuild and restart

```bash
docker compose -f docker-compose-fnf.yml build
docker compose -f docker-compose-fnf.yml up -d
```

Because the project name and volume names are unchanged, `pgdata`,
`vault-data`, and `minio-data` are reused — only containers get recreated.

### 5. Verify

```bash
docker compose -f docker-compose-fnf.yml ps
docker compose -f docker-compose-fnf.yml logs server --tail 50
docker compose -f docker-compose-fnf.yml logs worker --tail 50
```

Then check the live site: login works, an existing tapestry with items still
loads and renders correctly, and thumbnail/webpage-screenshot generation still
works (exercises Minio + Puppeteer + Vault together).

### 6. Rollback if something's wrong

Data is never at risk from this process (volumes aren't touched either way),
so rollback is just:

```bash
git checkout archive-version   # or whatever the previous working branch was
docker compose -f docker-compose-fnf.yml up -d --build
```

Restore `tapestries_pg_backup_*.dump` only if a migration actually corrupted
data, which additive migrations (the common case) won't do.
