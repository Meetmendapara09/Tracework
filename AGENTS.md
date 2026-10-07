# AGENTS.md - instructions for coding agents working in this repo

Tracework is a local-first evidence-to-action workspace. Node.js 20+ only, no build step, no framework.

## Setup and checks

```bash
npm ci
npm run check   # prettier check + syntax checks + full test suite (must pass)
npm test        # tests only
npm start       # run the web app on http://127.0.0.1:3000
```

Node 20 and 24 are both tested in CI. Keep them working.

## Conventions (enforced by review)

- Plain hyphens only. Never introduce em dashes or en dashes in code, UI text, or docs.
- Run `npx prettier --write .` before committing; `npm run check` fails on unformatted files.
- Validate at the boundary with the Zod schemas in `src/core.js`; never trust caller input.
- Persistence: write a complete temp file with `wx` + mode `0o600`, then rename over the target. Never truncate live files.
- Every workspace mutation is revision-checked (`If-Match`) and records a history snapshot. History recording must never fail the mutation.
- All rendered user content goes through `escapeHTML` in `public/app.js`. Source URLs are HTTP(S) only.
- The server has no authentication. Never add network fetching of source URLs, CORS, or remote exposure without discussion.
- Backward compatibility: old JSON backups (missing `tags`/`citation`) must keep loading. CSV gains optional columns only.

## Architecture map

- `server.js` - HTTP API and static allowlist. Project scoping via `?project=` (default project when absent).
- `src/core.js` - graph model, validation, revisioned store, Markdown export.
- `src/projects.js` - multi-project index (`projects.json`) plus isolated workspace files.
- `src/history.js` - bounded per-project undo snapshots.
- `src/attachments.js` - PDF sidecar storage (never inside JSON backups).
- `src/search.js` - MiniSearch ranking with `type:`/`tag:`/`status:`/`is:`/`before:`/`after:`/phrase operators.
- `src/csv.js` - spreadsheet-safe CSV intake and export.
- `mcp-server.js` - stdio MCP bridge for coding agents. Keep it dependency-free.
- `public/app.js` - UI state. All API writes send `If-Match`; attachments and search preview do not mutate.

## Using Tracework as a tool (agents operating a workspace)

Prefer the MCP server (`node mcp-server.js` with `TRACEWORK_DATA` set) or the HTTP API
(`docs/api.md`, examples in `docs/automation.md`). To add a task: create the item,
then link it with `advances` from its decision. To record a finding: add a source,
add a claim, link `supports`/`challenges`. Never invent IDs; use the ones returned.
