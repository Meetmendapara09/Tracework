# Architecture and data model

Tracework consists of a small Node HTTP server (`server.js`), a dependency-free browser interface (`public/`), and a file-backed domain layer (`src/core.js`). There is no build pipeline. `src/sample.js` contains **fictional** demonstration data; it is not a research dataset.

## The graph

A workspace is `{ revision, nodes, links }`. All identifiers are stable strings. Every node has `id`, `type`, `title`, `body`, `url`, `due`, `status`, `createdAt`, and `updatedAt`. Unused optional fields are empty strings. The four node types are:

| Type | Meaning | Status values | Extra field |
| --- | --- | --- | --- |
| `source` | Reference, observation, interview, artifact | `""` | HTTP(S) `url` |
| `claim` | Interpretation or hypothesis | `open`, `reviewed` | — |
| `decision` | Chosen direction and rationale | `proposed`, `accepted`, `rejected` | — |
| `task` | Follow-up action | `todo`, `doing`, `done` | ISO calendar `due` date (`YYYY-MM-DD`) |

Links have `{ id, from, to, kind }`. Legal edges are `source → claim` (`supports`, `challenges`), `claim → decision` (`informs`), and `decision → task` (`advances`). The same pair can have both `supports` and `challenges` links; duplicate **identical** edges are prohibited. Deleting a node removes all adjacent edges.

The UI and Markdown export compute these signals from the graph rather than storing a stale derived field:

- **Claim:** `Contested` if it has one or more challenges, otherwise `Supported` if it has one or more supports, otherwise `Unverified`.
- **Decision:** `No claims linked` if no claims inform it; `Needs review` if any informing claim is contested; `Evidence gap` if any informing claim is unverified; otherwise `Evidence linked`.
- **Dashboard:** evidence gaps count claims with *zero supports* (including contested claims with no support); points of tension count claims with *at least one challenge*. These counts are not mutually exclusive.

These rules highlight where a human should review reasoning; they do not measure truth or statistical confidence.

## Mutation lifecycle

1. The browser fetches the full workspace and tracks `revision`.
2. Every write includes that revision in `If-Match`. The server validates the command, queues the mutation, checks the revision against its current in-memory state, and applies the change to a copy.
3. The server writes the complete new workspace to a unique temporary file, then renames it over the data file. **Only after a successful rename** does the in-memory copy become current and the revision advance.
4. The server returns the new workspace. On stale revisions the client reloads and prompts for retry; it does not silently replay a stale edit.

Startup validates the file rather than silently resetting corrupted or unrecognized data. Import validates the entire candidate workspace before committing it. API errors are JSON objects with an `error` message.

## Limits and trade-offs

- One server process per data file. The revision queue is in memory; multiple processes could overwrite each other. For collaboration, move the state to a transactional database and add authorization.
- Each mutation rewrites the file. This is simple and auditable for a personal workspace but not suitable for very large datasets. Limits: 2,000 nodes, 6,000 links, 32 MiB request body. Exports can be larger than a browser's available memory on low-end devices.
- The browser fetches and renders the whole workspace. As the graph grows, filtering and card rendering become more expensive; server-side pagination would be needed for larger limits.
- Atomic rename protects against partial replacement, **not** against all power-loss scenarios (there is no explicit file/directory `fsync`), accidental deletion, malware, or hardware failure. Back up the JSON export or data file regularly.
- URLs are references only. The server never fetches them. No AI calls, telemetry, external CDNs, cookies, or external fonts are used.

## Project layout

```text
server.js              HTTP API, static file allowlist, security headers
src/core.js            validation, graph logic, revisioned persistence, export
src/sample.js          clearly fictional starting workspace
public/index.html      semantic UI structure
public/app.js          UI state and interaction handlers
public/styles.css      responsive visual design
public/favicon.svg     local icon
test/                  domain and HTTP integration tests
```
