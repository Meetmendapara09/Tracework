# Tracework

**Make the thinking visible.** Tracework is a local-first evidence-to-action desk for research, project planning, investigations, design reviews, and other work where the *why* matters as much as the *what*. Collect sources, develop claims, record decisions, and follow through on tasks in one connected trail.

No account, API key, database server, build step, external assets, or runtime dependencies. Your workspace is a JSON file on your own machine.

## What makes it useful

- **Follow an explicit trail:** sources **support** or **challenge** claims; claims **inform** decisions; decisions **advance** tasks. Open any card to navigate its connections in either direction.
- **Spot weak reasoning:** the dashboard flags claims without supporting sources and contested claims. A dedicated **Review queue** collects those claims and decisions with missing or disputed evidence. A challenge is intentionally not averaged away by a supporting source.
- **Work through the whole lifecycle:** search, sort, create, edit, connect, review, and track status/due dates in a responsive workspace.
- **Take your work with you:** export a readable Markdown brief or a complete JSON backup; import a backup to restore or move your workspace. Both include the full evidence graph. The brief is a snapshot; JSON is the round-trippable format.
- **Start with an example:** a clearly fictional project-review scenario is included on first launch. Replace it with a blank workspace using the footer action; load the example again from an empty workspace.

> **Important:** Evidence labels are structural cues, not scientific confidence estimates or automated fact checks. Tracework counts linked sources; it cannot determine whether a source is trustworthy or a conclusion is true.

## Quick start

Requires **Node.js 20+**. No install is necessary to run the app:

```bash
node server.js
# Open http://127.0.0.1:3000
```

Or run `npm start`. To use a different port or location for the data file:

```bash
PORT=4173 TRACEWORK_DATA="$HOME/research/tracework.json" npm start
```

`HOST` defaults to `127.0.0.1` (only your machine). Set `HOST=0.0.0.0` **only** on a trusted network behind your own authentication and TLS reverse proxy. Tracework itself has **no authentication** and is not intended to be exposed to the public internet. The example workspace is created at `data/workspace.json` on first launch. This directory is gitignored.

### A five-minute workflow

1. Create a **source** (a paper, interview, observation, URL, or other reference). Put the relevant passage and citation details in its notes; Tracework stores the URL but does not scrape external pages.
2. Add a **claim** and connect the source as *supports* or *challenges*. An unsupported claim appears as an evidence gap; counterevidence remains visible.
3. Add a **decision**, connect the claims that informed it, and record the reasoning. Its evidence indicator updates with the connected claims.
4. Add a **task**, connect it to the decision, and mark progress with its status.
5. Export a **Markdown brief** to share the reasoning, or **JSON** to back up the editable workspace.

Press **N** to create an item in the current view, **/** to search, and **Esc** to close the inspector. On a narrow screen, selecting an item opens its inspector as a full-width panel.

## Data and reliability

- Files are written to a temporary file in the same directory and atomically renamed, so a failed write does not partially overwrite the previous workspace. Writes are serialized in-process and checked against a monotonically increasing revision. If another tab changed the workspace, the UI reloads the latest revision and asks you to retry. Deleting an item also deletes its connections.
- Import validates IDs, types, fields, dates, URLs, link direction, references, and duplicates *before* replacing anything. Invalid imports leave the workspace unchanged. Request size is limited to 32 MiB; the workspace is limited to 2,000 items and 6,000 connections.
- Changes are persisted on the server after each action, not in browser localStorage. JSON backup is still recommended before resets, imports, major edits, or upgrades. The app is designed for a **single local process** and a **single workspace file**. Do not run multiple Tracework servers against the same file; process-local serialization cannot coordinate them.
- The interface escapes user content, restricts source links to HTTP(S), does not load external resources, sets a restrictive Content Security Policy, does not enable CORS, checks cross-origin writes, and serves only an explicit list of static assets. These controls do not replace authentication when the server is made remotely reachable.
- The data file is plain JSON and can contain sensitive research. Protect it with your OS permissions and backups. The server creates new data files with owner-only permissions; existing file permissions are not changed. Exported files are controlled by your browser/download directory.

## Development

```bash
npm ci        # optional; verifies the lockfile (there are no runtime packages)
npm run dev   # restart server when source files change
npm run check # syntax checks + unit and HTTP integration tests
```

The tests use Node's built-in test runner and isolated temporary directories. No external services are needed. See [docs/architecture.md](docs/architecture.md) for the data model, invariants, and operational notes, and [docs/api.md](docs/api.md) for the HTTP API.

## Scope

Tracework is intentionally a small, inspectable, single-user tool. It does **not** claim to verify sources, offer real-time multi-user collaboration, synchronize devices, or protect data on an exposed public server. Those would require identity, authorization, conflict resolution, and a different storage architecture. The workspace is nevertheless portable: JSON is human-readable and its shape is documented.
