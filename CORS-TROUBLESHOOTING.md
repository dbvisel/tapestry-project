# Troubleshooting CORS errors on the deployed stack

A runbook for the intermittent CORS errors seen on the public deployment:

- client: `https://tapestries.archive.org`
- API (server + worker): `https://tapestries-api.archive.org`
- MinIO: `https://tapestries-server.archive.org`
- All behind an Nginx reverse proxy + WAF (Internet Archive edge).

Typical browser symptom:

```
Access to XMLHttpRequest at 'https://tapestries-api.archive.org/api/...'
from origin 'https://tapestries.archive.org' has been blocked by CORS policy:
No 'Access-Control-Allow-Origin' header is present on the requested resource.
AxiosError: Network Error (ERR_NETWORK)
```

## Key facts about this stack (so you don't chase the wrong layer)

1. **The app reflects every origin.** `server/src/index.ts` uses:
   ```js
   app.use(cors({
     credentials: true,
     origin: (origin, callback) => { callback(null, origin) },
   }))
   ```
   With `credentials: true`, the allowed origin **must be the specific origin**, never `*`.
   The `cors` package also auto-handles the `OPTIONS` preflight. So **whenever a
   request actually reaches Express, the ACAO header is present** — even on 4xx
   responses (the middleware runs before auth and before the routes).

2. **Therefore "No Access-Control-Allow-Origin header" almost never means the app.**
   It means the browser received a response that did **not** come from the app with
   its headers intact — something in front of it (WAF / rate limiter / cache /
   a bad replica) answered or altered the response.

3. **CSP is a separate gate from CORS.** `client/index.html` has a custom CSP. Its
   `connect-src` includes `https://tapestries-api.archive.org` and
   `wss://tapestries-api.archive.org`, so the browser is *allowed* to make the call.
   - CSP failure message: "Refused to connect to '…' because it violates … connect-src …"
   - CORS failure message: "blocked by CORS policy: No 'Access-Control-Allow-Origin' …"
   If you see the second one, CSP is not your problem.

4. **The WAF flags brackets in URLs** — `filter[id:in][]=` looks like an injection
   pattern to OWASP-style rules. This is a *plausible* cause but must be confirmed,
   not assumed (in our investigation it turned out **not** to be the cause — see below).

## Diagnostic ladder (run these from a terminal)

> Always pass `-g` (`--globoff`) so curl doesn't treat `[ ]` as a glob range,
> and single-quote the URL so the shell leaves it alone.

### 1. Does the bracketed GET reach the app with ACAO?

```sh
curl -g -i -H 'Origin: https://tapestries.archive.org' \
  'https://tapestries-api.archive.org/api/tapestry-create-jobs?filter[id:in][]=<some-uuid>'
```
- `access-control-allow-origin: https://tapestries.archive.org` + `x-powered-by: Express`
  → the request reached the app and CORS is fine on the GET path. (A `401
  InvalidAccessTokenError` here is expected — curl has no token. It does **not**
  indicate a CORS problem.)
- `403`/`406`/`501` with an HTML body and **no** `access-control-*` headers
  → the WAF is blocking the GET. Fix at the WAF (allow the bracket pattern on `/api`).

### 2. Same endpoint without brackets (isolates the bracket pattern)

```sh
curl -g -i -H 'Origin: https://tapestries.archive.org' \
  'https://tapestries-api.archive.org/api/tapestry-create-jobs'
```

### 3. The preflight the browser sends first (this is the one that matters for
credentialed/authorized requests)

```sh
# bracketed
curl -g -i -X OPTIONS \
  -H 'Origin: https://tapestries.archive.org' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization' \
  'https://tapestries-api.archive.org/api/tapestry-create-jobs?filter[id:in][]=<some-uuid>'

# non-bracketed (#3b) — same command without the ?filter... part
```
A healthy preflight is `204` with `access-control-allow-origin`,
`access-control-allow-credentials: true`, `access-control-allow-methods`, and
`access-control-allow-headers: authorization`.

> **Important:** CORS preflights are sent **without credentials** (no cookies, no
> `Authorization`) by spec. So the browser's preflight is essentially identical to
> what curl sends here. If curl's preflight succeeds but the browser's fails, the
> cause is **not** the request content — it's *when/how many* (load, cache, replica).

### 4. Burst test (rate-limiting / throttling under load)

```sh
seq 60 | xargs -P 60 -I{} curl -g -s -o /dev/null -w "%{http_code}\n" -X OPTIONS \
  -H 'Origin: https://tapestries.archive.org' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization' \
  'https://tapestries-api.archive.org/api/tapestry-create-jobs?filter[id:in][]=<some-uuid>' \
  | sort | uniq -c
```
- All `204` → no rate-limiting on preflights.
- A mix with `429`/`403` → the edge is throttling. Fix: raise/scope the edge rate
  limit for the API host, exempt `OPTIONS`, and make the limiter's error responses
  carry ACAO so throttles surface as real statuses instead of "CORS errors."

### 5. Edge page-cache poisoning (the prime suspect when curl can't reproduce it)

The edge has a page cache — responses carry `x-page-cache: HIT|MISS`. The app sends
`Vary: Origin`, but **if the edge cache ignores `Vary: Origin`**, a copy of a GET
stored without an `Origin` (e.g. a same-origin / server-side / health-check fetch)
gets served to the browser later — missing ACAO. Intermittent by nature, and
invisible to curl.

```sh
# Watch x-page-cache flip MISS -> HIT, and whether a HIT ever lacks ACAO.
for i in $(seq 6); do
  curl -g -s -D - -o /dev/null -H 'Origin: https://tapestries.archive.org' \
    'https://tapestries-api.archive.org/api/tapestries' \
    | grep -iE 'x-page-cache|access-control-allow-origin|x-dport|x-who'
  echo ---
done
```
A `HIT` block with **no** `access-control-allow-origin` is the smoking gun.

## The single most decisive data point

When it fails **in the browser**, open the Network tab, click the failed request
(and its `OPTIONS` preflight entry), and record:

| What to read | What it tells you |
|---|---|
| `OPTIONS` status code | did the preflight die? (`403`/`429` = edge; no response = dropped) |
| `access-control-allow-origin` present? | confirms whether the failing response carried CORS at all |
| `x-page-cache: HIT` with no ACAO | **cache poisoning** (edge cache ignoring `Vary: Origin`) |
| `x-dport` / `x-who` differ from the good ones (`3201` / `tapestries-api.archive.org`) | a **stale/misconfigured backend replica** serving ~1/N requests |
| `x-rl` / `x-na` differ from `1` / `0` on the good responses | edge **rate-limiting** |
| request is a big `filter[id:in][]` with many entries | a **WAF size/complexity** rule on long query strings |

## What we ruled out in the last investigation (2026-06-17)

- Bracketed GET (#1): `401` **with** `access-control-allow-origin` and `x-powered-by:
  Express` → reached the app, CORS correct. **Brackets not blocked.**
- Bracketed + non-bracketed preflights (#3 / #3b): clean `204` with full CORS headers.
  **OPTIONS not blocked.**
- Burst of 60 preflights: `60 204`, three times. **No rate-limiting.**

Conclusion: everything reproducible from curl is healthy → the failure is
**intermittent / conditional**. Leading hypotheses, in order:
1. **Edge page-cache not honoring `Vary: Origin`** (poisoned cache entry without ACAO).
2. **Stale/misconfigured backend replica** (note: "a few things were modified in
   this installation").

## Fixes

### App-side (in this repo — `server/src/index.ts`)

1. **Stop the edge from caching API responses** (prevents cache poisoning at the
   source). The API currently sends no `Cache-Control` header, so the edge applies
   its own default caching:
   ```js
   // before the /api routes
   app.use('/api', (req, res, next) => {
     res.set('Cache-Control', 'no-store')
     next()
   })
   ```
2. **Cut preflight volume** so fewer `OPTIONS` hit the edge (helps if throttling is
   ever involved):
   ```js
   app.use(cors({
     credentials: true,
     maxAge: 86400,          // browsers cache the preflight (Chrome clamps to 2h, FF 24h)
     origin: (origin, callback) => { callback(null, origin) },
   }))
   ```

### Edge-side (Nginx / WAF — Internet Archive infra, outside this repo)

- **Don't page-cache `/api`** (correct for a dynamic, authenticated API), or at least
  make the cache key include `Origin` / honor `Vary: Origin`.
- If a WAF rule is confirmed blocking (step 1/3 returns 4xx without ACAO): add an
  exception for the `filter[...]` bracket pattern / long query strings on `/api`,
  scoped to `tapestries-api.archive.org`.
- If throttling is confirmed (step 4): raise/scope the rate limit, exempt `OPTIONS`.
- **Never** "fix" CORS by adding headers at the proxy:
  - the app already sends them → duplicate ACAO = browser rejects ("multiple values");
  - `credentials: true` forbids `Access-Control-Allow-Origin: *` — it must mirror the
    specific origin.
- Make any edge error response (WAF block, rate limit) include `Access-Control-Allow-Origin`
  so genuine failures show their real status instead of a misleading CORS error.

## Related config to keep consistent

- `client/index.html` CSP `connect-src` must include the API host over both `https`
  and `wss` (socket.io), plus the MinIO host for assets.
- The socket.io server uses a **separate** CORS config bound to `VIEWER_URL`
  (`server/src/socket/index.ts`). If WebSocket connections fail (but HTTP works),
  check that `VIEWER_URL` exactly equals `https://tapestries.archive.org`.
