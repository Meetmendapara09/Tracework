# Tracework

**Make the thinking visible.** Tracework is a local-first evidence-to-action desk for research, project planning, investigations, design reviews, and any work where the *why* matters as much as the *what*. Collect sources, develop claims, record decisions, and follow through on tasks in one connected trail.

Your workspace is a JSON file on your machine. There is no account, API key, database server, build step, telemetry, or external asset/CDN. A few established libraries handle schema validation, CSV parsing, and CSV generation rather than reimplementing those error-prone jobs.

## What you can do

- **Trace reasoning:** sources *support* or *challenge* claims; claims *inform* decisions; decisions *advance* tasks. Open any card to navigate connections in both directions.
- **Review evidence:** the dashboard and **Review queue** surface unsupported or contested claims and decisions that need another look. The **Evidence matrix** shows sources against claims, with support, challenge, or both in each cell. Counterevidence is never averaged away.
- **Organize across projects:** add up to 12 tags per item; search and filter by tag, status, title, or notes. Manage task statuses and due dates.
- **Bring existing work in:** paste or upload CSV from a spreadsheet or reference list. Preview what will be added or skipped; duplicate URLs and titles are detected, and invalid rows cannot partly import. A downloadable template makes the columns clear.
- **Take work out:** export a Markdown research brief, a spreadsheet-friendly CSV of items, or a complete JSON workspace backup. **Only JSON preserves IDs and connections** and can restore the workspace exactly.
- **Explore safely:** first launch uses a clearly fictional example. Use “Start a blank workspace” when ready.

> **Evidence labels are prompts for human review, not scientific confidence scores or automated fact checks.** Tracework counts relationships; it cannot assess source quality or determine whether a claim is true.

## Quick start

**Option A — Node.js 20+** (recommended for development):

```bash
npm ci
npm start
# Open http://127.0.0.1:3000
```

**Option B — Docker Compose** (no Node installation needed):

```bash
docker compose up -d --build
# Open http://127.0.0.1:3000
# Stop with: docker compose down  (your named data volume is retained)
```

Both options keep the web server accessible only from your machine by default. Docker Compose stores data in a named volume; use the **Backup workspace** button to save a portable copy before removing volumes. **Do not run `docker compose down -v` unless you intend to erase that volume.** For Node, the example workspace is created at `data/workspace.json` (gitignored). To choose a different location or port:

```bash
PORT=4173 TRACEWORK_DATA="$HOME/research/tracework.json" npm start
```

`HOST` defaults to `127.0.0.1`. Do **not** expose the server publicly: it has **no authentication**. Setting `HOST=0.0.0.0` should only be done behind an authentication and TLS reverse proxy on a trusted network. Docker listens inside its container on `0.0.0.0`, but Compose publishes it to **host loopback only** (`127.0.0.1`).

### A five-minute workflow

1. Create a **source** (paper, interview, observation, artifact, or URL) and record the relevant passage and citation context in its notes. URLs are stored, not fetched.
2. Create a **claim**; connect sources as *supports* or *challenges*. Open the **Evidence matrix** to compare all linked sources at a glance.
3. Create a **decision** and connect the claims that informed it. Its evidence indicator updates automatically.
4. Add a **task**, connect it to the decision, and track its status. Tag related work across all four stages.
5. Share a **Markdown brief**, export a **CSV** for a spreadsheet, or create a **JSON backup** to move or restore editable work.

Press **N** to create an item in the current view, **/** to search, and **Esc** to close the inspector. On a narrow screen the inspector becomes a full-width panel.

### Import a CSV

Click **Import CSV**, select a file or paste text, then **Preview changes**. Only after previewing can you **Import items**. Download a template from the dialog or use:

```csv
type,title,body,url,status,due,tags
source,"Interview, participant 1","Context and excerpt",https://example.org,,,Fieldwork|Pilot
claim,Context is hard to recover,"Working hypothesis",,open,,Pilot
task,Schedule follow-up,"Talk to the team",,todo,2027-01-15,Pilot
```

- `title` is required. `type` defaults to `source` and can be `source`, `claim`, `decision`, or `task`. `notes` is accepted instead of `body`. Tags in CSV are separated by `|`; in the item form, separate tags with commas. Dates use `YYYY-MM-DD`.
- Up to **500 rows / 8 MiB** per import. Sources are deduplicated by normalized URL when one is present, otherwise by case-insensitive title; other types use case-insensitive title. Duplicate rows are skipped, not overwritten. A different URL can have the same source title. If any row is invalid, **nothing** from that file is imported.
- CSV exports contain items, **not connections or stable IDs**. To move a complete trail, use the JSON backup. Potential spreadsheet formulas are prefixed with an apostrophe in CSV exports to prevent execution; JSON and Markdown retain the original text.

## Data, safety, and reliability

- Writes are serialized in-process, revision-checked, written to a temporary file, then atomically renamed. A stale tab reloads the current revision rather than overwriting it. Deleting an item removes its links. A CSV preview is recalculated at commit time against the actual revision.
- Imports validate IDs, types, tags, dates, URLs, relationships, references, and duplicates. Old JSON backups without tags are accepted and upgraded in memory. Bad or corrupted saved data is **not** silently reset on startup. Request bodies are capped at 32 MiB, with at most 2,000 items and 6,000 connections per workspace.
- Work is persisted after every action; it is **not** stored in browser localStorage. Still back up the JSON before resets, imports, major edits, or upgrades. Use **one server process per data file**; the process-local queue cannot coordinate multiple servers.
- The UI escapes user text; source links must be HTTP(S); the server serves an explicit static-file allowlist, restricts cross-origin writes and loopback Host headers, and sets a strict Content Security Policy. These measures do **not** replace authentication if you expose the server remotely.
- The data file can contain sensitive research. Protect it with OS permissions and backups. New data files are created owner-only; existing file permissions are not modified. Exports are controlled by your browser/download directory.

## Development

```bash
npm ci
npm run dev    # restart server when server code changes
npm run check  # syntax checks + domain, API and browser-DOM tests
```

Node's test runner, temporary directories, and jsdom power the test suite; no external service is required. The Docker image runs as a non-root user with a read-only root filesystem and writes only to its data volume. See [docs/architecture.md](docs/architecture.md) for graph rules and operational trade-offs, and [docs/api.md](docs/api.md) for automation.

## Scope

Tracework is intentionally a single-user, inspectable tool. It does **not** verify sources, provide real-time collaboration or device sync, or protect a publicly exposed server. Those require identity, authorization, conflict resolution, and a different storage architecture. JSON remains the portable, documented format for complete workspaces.

MIT licensed. See [LICENSE](LICENSE).
