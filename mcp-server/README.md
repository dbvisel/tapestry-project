# tapestry-mcp-server

**Proof of concept.** An MCP server that lets an agent create and read [Tapestries](../README.md)
on behalf of a logged-in Internet Archive account.

## Why this is a proof of concept, not a finished integration

Tapestry has no personal-access-token/API-key concept for third-party clients today - only
interactive Google/IA-cookie login, or Internet Archive username+password, which is the only login
path usable without a browser. This server logs in with real IA credentials (via
`TAPESTRY_IA_EMAIL`/`TAPESTRY_IA_PASSWORD`) and manages the resulting short-lived session itself.
That means:

- The credentials given to this server are as sensitive as the account's real password - there's no
  scoped, revocable token to hand out instead.
- "Downloading" a tapestry returns its data as JSON (title, items, rels), not a re-importable
  `.zip` - Tapestry's zip export format is only implemented client-side in the browser
  (`client/src/services/tapestry-exporter.ts`), there's no server endpoint that produces one yet.
- `add_item` only supports plain text, an embedded webpage (iframed), and a direct image URL. The
  richer URL-classification logic that turns a pasted link into a Wikipedia/Commons/Openverse/IIIF
  item lives client-side in `client/src/stage/item-factories.ts` and isn't reimplemented here.

A real integration would want a proper API-key/OAuth story on the server side before handing this
to more than one trusted user.

## Setup

```bash
cd mcp-server
cp .env.sample .env   # fill in TAPESTRY_IA_EMAIL / TAPESTRY_IA_PASSWORD
npm install
```

Point an MCP client at it, e.g. in Claude Desktop's config:

```json
{
  "mcpServers": {
    "tapestry": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/tapestry-project/mcp-server/src/index.ts"],
      "env": {
        "TAPESTRY_API_URL": "http://localhost:3000/api",
        "TAPESTRY_VIEWER_URL": "http://localhost:8080",
        "TAPESTRY_IA_EMAIL": "you@example.com",
        "TAPESTRY_IA_PASSWORD": "..."
      }
    }
  }
}
```

## Tools

| Tool | Does |
|---|---|
| `list_tapestries` | Lists tapestries owned by the logged-in account. |
| `get_tapestry` | Fetches one tapestry's title/items/rels as JSON. |
| `create_tapestry` | Creates a new, empty tapestry. |
| `add_item` | Adds a text, webpage, or image item to a tapestry. |
