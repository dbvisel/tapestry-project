# MediaWiki Login

Tapestries can authenticate users with [MediaWiki](https://www.mediawiki.org) (including Wikimedia
wikis such as Wikipedia/Meta) as an alternative to Internet Archive or Google. It uses MediaWiki's
[OAuth 2.0](https://www.mediawiki.org/wiki/OAuth/For_Developers) authorization-code flow.

## How the flow works

1. The client shows a **Sign in with MediaWiki** button. Clicking it redirects the whole window to
   the wiki's `oauth2/authorize` endpoint (`client/src/auth/mediawiki/service.ts`).
2. The user authorizes the application on the wiki, which redirects back to the configured
   **redirect URI** with a `?code=...` authorization code.
3. On load, the client reads that `code` from the URL and posts it to the Tapestries server. The
   server exchanges it at the wiki's `oauth2/access_token` endpoint for an access token, then calls
   `oauth2/resource/profile` with that token to fetch the authenticated user's profile
   (`server/src/auth/providers/mediawiki.ts`).
4. A Tapestries session is created and the OAuth params are stripped from the URL.

Unlike ORCID — whose token endpoint returns the identity directly — MediaWiki requires the separate
profile call in step 3. The profile returns the stable central user id (`sub`), the wiki
`username`, and (only when the user has a confirmed address and the consumer was granted access to
it) their `email`. Tapestries keys the account on the central user id, stored in the new
`User.mediawikiId` column (migration `20260629000000_add_mediawiki_id_to_user`). When the profile
includes no confirmed email, Tapestries synthesizes a stable placeholder (`<sub>@mediawiki.invalid`)
to satisfy the `User` model.

## Registering a MediaWiki OAuth consumer

1. On your wiki, go to `Special:OAuthConsumerRegistration/propose` (for Wikimedia wikis this lives on
   Meta: <https://meta.wikimedia.org/wiki/Special:OAuthConsumerRegistration/propose>).
2. Choose **OAuth 2.0** as the protocol and register it as a **confidential** client (Tapestries
   exchanges the code server-side using a client secret).
3. Set the **callback/redirect URL** to match what the app sends, including the trailing slash (see
   the gotcha below). It can be marked as a prefix or exact match.
4. Grant the consumer at least the **basic** user-identity rights so the `oauth2/resource/profile`
   endpoint returns the username and central id. If you want the user's email, grant the email
   right too (and note the user must have a confirmed email).
5. Note the generated **client application key** (client ID) and **client application secret**. On
   Wikimedia wikis a newly proposed consumer may require admin approval before it works against all
   users; you can use it immediately as its own author for testing.

> **Gotcha — the REST endpoint path varies.** `MEDIAWIKI_BASE_URL` must be the wiki's REST endpoint,
> and the OAuth paths are appended to it (`/oauth2/authorize`, `/oauth2/access_token`,
> `/oauth2/resource/profile`). For Wikimedia wikis that is `https://meta.wikimedia.org/w/rest.php`.
> A vanilla MediaWiki install may expose it at `https://your.wiki/rest.php` (no `/w`). Check by
> opening `<MEDIAWIKI_BASE_URL>/oauth2/authorize` in a browser — it should render an OAuth error
> page rather than a 404.

## Configuration

Set these in `.env` (the installer `./setup.sh` will also prompt for them when you choose the
`mediawiki` auth provider).

| Variable | Side | Purpose |
| --- | --- | --- |
| `AUTH_PROVIDER=mediawiki` | both | Selects MediaWiki. Mapped to the client as `VITE_AUTH_PROVIDER`. |
| `MEDIAWIKI_CLIENT_ID` | server + client | OAuth 2.0 client ID. Mapped to the client as `VITE_MEDIAWIKI_CLIENT_ID`. |
| `MEDIAWIKI_CLIENT_SECRET` | server | OAuth 2.0 client secret. **Server only** — never sent to the client. |
| `MEDIAWIKI_BASE_URL` | server + client | The wiki's REST endpoint, e.g. `https://meta.wikimedia.org/w/rest.php` (default). Mapped as `VITE_MEDIAWIKI_BASE_URL`. |
| `MEDIAWIKI_REDIRECT_URI` | server + client | Optional. Blank = the client app's own origin + `/`. Set it to pin the value (e.g. `http://localhost:8080/`). Mapped as `VITE_MEDIAWIKI_REDIRECT_URI`. |

Example block:

```dotenv
AUTH_PROVIDER=mediawiki
MEDIAWIKI_CLIENT_ID=0123456789abcdef0123456789abcdef
MEDIAWIKI_CLIENT_SECRET=fedcba9876543210fedcba9876543210fedcba98
MEDIAWIKI_BASE_URL=https://meta.wikimedia.org/w/rest.php
MEDIAWIKI_REDIRECT_URI=http://localhost:8080/
```

> **Gotcha — the client ID is baked in at build time.** `VITE_MEDIAWIKI_CLIENT_ID`,
> `VITE_MEDIAWIKI_BASE_URL`, and `VITE_MEDIAWIKI_REDIRECT_URI` are **Docker build args**, compiled
> into the client bundle. Changing them in `.env` and merely restarting the containers will *not*
> take effect — you must **rebuild the client image**. (The server, by contrast, reads its MediaWiki
> variables at runtime.)

## Running it

After setting the variables, rebuild and recreate the client and server. For the MinIO stack:

```bash
docker compose --env-file .env -f docker-compose.minio.yml up -d --build client server
```

The `mediawikiId` migration is applied automatically on server startup (`start:api` runs
`prisma migrate deploy`).

Then open the app at the host matching your redirect URI and click **Sign in with MediaWiki**.
Hard-refresh (Cmd/Ctrl-Shift-R) if the browser has an old bundle cached.

## Troubleshooting

- **`invalid_client` / `invalid_request` on the wiki's authorize page** — the client bundle still
  has an old/placeholder client ID baked in. Rebuild the client image (see the build-arg gotcha)
  and hard-refresh.
- **Redirect-mismatch error on the wiki before returning to the app** — the redirect URI the client
  sent isn't registered verbatim. Check the trailing slash and the host (`localhost` vs `127.0.0.1`
  vs a domain).
- **`Error while performing MediaWiki authentication` in the server logs** — the code-for-token
  exchange or the profile fetch failed (`server/src/auth/providers/mediawiki.ts`). Most often a
  wrong `MEDIAWIKI_CLIENT_SECRET`, a `MEDIAWIKI_BASE_URL` that points at the wrong REST path, or a
  `redirect_uri` that differs between the authorize and token steps. Tail with:
  ```bash
  docker compose --env-file .env -f docker-compose.minio.yml logs -f server
  ```
- **User logs in but has a `@mediawiki.invalid` email** — expected when the consumer wasn't granted
  the email right, or the user has no confirmed email on the wiki. Grant the email right on the
  consumer and have the user confirm their address.
