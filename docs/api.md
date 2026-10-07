# HTTP API (v1)

The API is for the local web client and scripts on the **same trusted machine**, not a remotely exposed service. Base URL: `http://127.0.0.1:3000`. All routes return JSON except the static app, Markdown/CSV downloads, and PDF files. No CORS is enabled; writes with a foreign `Origin` are rejected.

Most routes accept an optional `?project=<id>` query parameter. Without it, they operate on the default project. Unknown project IDs return `404`; malformed IDs return `400`. Project management lives under `/api/projects`.

## Reads and downloads

| Method | Route                             | Response                                                                       |
| ------ | --------------------------------- | ------------------------------------------------------------------------------ |
| GET    | `/api/health`                     | `{ "ok": true }`                                                               |
| GET    | `/api/projects`                   | `{ "defaultId": "default", "projects": [...] }`                                |
| GET    | `/api/workspace`                  | Complete `{ revision, nodes, links }`                                          |
| GET    | `/api/history`                    | `{ "revision": n, "entries": [{ id, action, at, fromRevision, toRevision }] }` |
| GET    | `/api/search?q=...&limit=...`     | `{ "total": n, "results": [{ id, type, title, snippet, score }] }`             |
| GET    | `/api/export.json`                | Complete workspace JSON (restorable)                                           |
| GET    | `/api/export.md`                  | Human-readable brief, including tags, citations, and connections               |
| GET    | `/api/export.csv`                 | Spreadsheet-safe items (no links/IDs; **not** a backup)                        |
| GET    | `/api/template.csv`               | CSV column headers for import                                                  |
| GET    | `/api/nodes/:id/attachments`      | `{ "attachments": [{ id, filename, size, contentType, createdAt }] }`          |
| GET    | `/api/nodes/:id/attachments/:aid` | The PDF file (`application/pdf`)                                               |

Search supports full-text ranking with prefix and fuzzy matching plus operators: `type:`, `tag:`, `status:`, `is:` (`unverified`, `contested`, `gap`), `before:`/`after:` (`YYYY-MM-DD`), and quoted phrases. An empty query returns recently updated items. Unknown filters are rejected with `400`.

## Writes and preview

**Workspace writes require** `If-Match: <revision>`, the unquoted integer from the most recent workspace response. Body-bearing requests require `Content-Type: application/json`. Successful mutations return the **complete updated workspace**, except `/api/import/csv` (returns `{ workspace, report }`) and `/api/undo` (returns `{ workspace, undone }`). Revisions increment on successful writes, including an import of only duplicates. A preview does **not** mutate or increment the revision. Every mutation records an undo snapshot automatically.

| Method | Route                             | JSON body                                                                                                                                                           | Effect                                                                  |
| ------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| POST   | `/api/nodes`                      | `{ "type": "source", "title": "...", "body": "...", "url": "...", "tags": ["..."], "citation": { "doi": "...", "authors": "...", "year": "...", "venue": "..." } }` | Add an item                                                             |
| PATCH  | `/api/nodes/:id`                  | Any subset of `title`, `body`, `url`, `status`, `due`, `tags`, `citation`                                                                                           | Update an item                                                          |
| DELETE | `/api/nodes/:id`                  | none                                                                                                                                                                | Delete item, adjacent links, and its PDF attachments                    |
| POST   | `/api/links`                      | `{ "from": "<source-id>", "to": "<claim-id>", "kind": "supports" }`                                                                                                 | Add a connection                                                        |
| DELETE | `/api/links/:id`                  | none                                                                                                                                                                | Delete a connection                                                     |
| PUT    | `/api/workspace`                  | `{ "nodes": [...], "links": [...] }` or exported JSON                                                                                                               | Validate and replace workspace                                          |
| POST   | `/api/import/preview`             | `{ "csv": "title,...\n..." }`                                                                                                                                       | Validate and preview CSV without changes                                |
| POST   | `/api/import/csv`                 | `{ "csv": "title,...\n..." }`                                                                                                                                       | Atomically add nonduplicate items                                       |
| POST   | `/api/undo`                       | none                                                                                                                                                                | Restore the state before the last change (undoes an undo, so it redoes) |
| POST   | `/api/sample`                     | none                                                                                                                                                                | Replace with fictional example                                          |
| POST   | `/api/projects`                   | `{ "name": "..." }`                                                                                                                                                 | Create a project (returns `201`)                                        |
| PATCH  | `/api/projects/:id`               | `{ "name": "..." }` and/or `{ "archived": true }`                                                                                                                   | Rename, archive, or restore a project                                   |
| POST   | `/api/nodes/:id/attachments`      | `{ "filename": "...pdf", "data": "<base64>" }`                                                                                                                      | Attach a PDF (no revision bump)                                         |
| DELETE | `/api/nodes/:id/attachments/:aid` | none                                                                                                                                                                | Delete a PDF attachment                                                 |

Attachments accept PDF files up to 15 MiB, verified by file signature. They are stored next to the workspace, outside the JSON file, so JSON backups never contain PDF bytes. Attachment routes do not use `If-Match`; the item must exist or they return `404`.

Preview returns `{ revision, add, skip, entries }`, with each entry `{ line, title, type, action, reason? }`. A CSV commit recomputes duplicates against the exact revision it writes. If another tab changes the workspace, it returns `409` rather than silently importing into a different state.

New items require `type` and a nonempty `title`. `body` defaults to `""`; `status` defaults by type; `url`/`due` default to `""`; `tags` defaults to `[]`; `citation` defaults to empty on sources. The server assigns IDs and ISO timestamps. `type`, IDs, and timestamps cannot be edited. Title max length: 160 characters; notes: 10,000; URL: 2,048; tags: 12 per item, each 1-32 characters. Tag values are case-preserving but unique case-insensitively and cannot contain `,` or `|` (CSV delimiters). Citations accept an optional DOI (`10.xxxx/...`, DOI URLs are normalized), authors (500 chars), a four-digit year, and venue (200 chars). See [architecture.md](architecture.md) for statuses and legal link directions. Older JSON backups without tags or citations remain valid.

### CSV format

The first row contains column names: `type,title,body,url,status,due,tags,doi,authors,year,venue`. `title` is mandatory; all other columns optional. `notes` may replace `body`. Blank `type` means `source`; case-insensitive types and statuses are accepted. Tags use `|` within a CSV cell. Citation columns apply to sources (other types reject them). Quoted cells may contain commas and newlines. Max **500 data rows / 8 MiB** per import. The entire import fails on any invalid row, with no partial saves. Existing sources are matched by normalized HTTP(S) URL when present, otherwise title; other types by case-insensitive title. Duplicate rows are skipped, not overwritten. Links are not generated by CSV.

CSV exports prefix cells beginning with a spreadsheet-formula trigger (`=`, `+`, `-`, `@`, or leading whitespace followed by one) with an apostrophe. **This can alter text if re-imported**; use JSON for lossless backups.

### Example: add a source

```bash
curl -s http://127.0.0.1:3000/api/workspace
# Read revision (say 0); after each write, use the NEW revision from its response.
curl -s -X POST http://127.0.0.1:3000/api/nodes \
  -H 'Content-Type: application/json' -H 'If-Match: 0' \
  -d '{"type":"source","title":"Field notes","body":"Observation and context","tags":["Pilot"],"citation":{"doi":"10.1234/example"}}'
```

Use `?project=<id>` on any route to work in another project. Use the returned ID and revision to create a claim, then connect the source to that claim as `supports` or `challenges`. A stale revision never silently overwrites another tab's changes.

## Errors and limits

Errors have the shape `{ "error": "human-readable message" }`:

- `400` malformed fields/CSV/JSON, invalid graph, unknown filter, or size/count limit
- `403` cross-origin write or invalid loopback Host header
- `404` unknown route, ID, project, history entry, or nothing to undo
- `409` stale revision or duplicate connection
- `413` request body exceeds 32 MiB, or PDF exceeds 15 MiB
- `415` body is not marked as JSON
- `428` missing/invalid `If-Match`
- `500` unexpected server/storage error (details logged server-side)

A failed import leaves the existing workspace unchanged. A JSON replacement increments the server's revision; the revision in the imported backup is informational and is **not** reused.
