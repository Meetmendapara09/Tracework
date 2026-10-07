# HTTP API (v1)

The API is for the local web client and scripts on the **same trusted machine**, not a remotely exposed service. Base URL: `http://127.0.0.1:3000`. All routes return JSON except the static app and the Markdown export. No CORS is enabled. Mutating requests with an `Origin` header from another origin are rejected.

## Reads

| Method | Route | Response |
| --- | --- | --- |
| GET | `/api/health` | `{ "ok": true }` |
| GET | `/api/workspace` | Complete `{ revision, nodes, links }` |
| GET | `/api/export.json` | Complete workspace JSON with download header |
| GET | `/api/export.md` | Human-readable brief with download header |

## Writes

**All writes require** `If-Match: <revision>`, where `<revision>` is the unquoted integer returned by the most recent workspace read/write. Requests with bodies also require `Content-Type: application/json`. Every successful write returns the **complete, updated** workspace JSON with an incremented revision. Even deletes use the revision header.

| Method | Route | JSON body | Effect |
| --- | --- | --- | --- |
| POST | `/api/nodes` | `{ "type": "source", "title": "...", "body": "...", "url": "..." }` | Add an item |
| PATCH | `/api/nodes/:id` | Any subset of editable fields (`title`, `body`, `url`, `status`, `due`) | Update an item |
| DELETE | `/api/nodes/:id` | none | Delete item and adjacent links |
| POST | `/api/links` | `{ "from": "<source-id>", "to": "<claim-id>", "kind": "supports" }` | Add a connection |
| DELETE | `/api/links/:id` | none | Delete a connection |
| PUT | `/api/workspace` | `{ "nodes": [...], "links": [...] }` or an exported JSON workspace | Validate and replace the workspace |
| POST | `/api/sample` | none | Replace with fictional demonstration workspace |

New items require `type` and a nonempty `title`; `body` defaults to `""`, `status` defaults by type, `url` and `due` default to `""`. The server assigns IDs and timestamps. `type`, IDs, and timestamps cannot be edited. Title max length: 160 characters; notes: 10,000; URL: 2,048. See [architecture.md](architecture.md) for statuses and legal link directions.

### Example: add a source and connect it to a claim

```bash
curl -s http://127.0.0.1:3000/api/workspace
# Read revision (say 0); after each write, use the NEW revision from its response.
curl -s -X POST http://127.0.0.1:3000/api/nodes \
  -H 'Content-Type: application/json' -H 'If-Match: 0' \
  -d '{"type":"source","title":"Field notes","body":"Observation and context"}'
```

Use the returned source `id` and `revision` to create a claim, then the two IDs and the next revision to create a `supports` link. A stale revision never silently overwrites somebody else's changes.

## Errors and limits

Errors have the shape `{ "error": "human-readable message" }`:

- `400` malformed fields, invalid JSON, invalid import/graph, or full workspace
- `403` cross-origin write
- `404` unknown route or ID
- `409` stale revision or duplicate connection
- `413` request body exceeds 32 MiB
- `415` body is not marked as JSON
- `428` missing/invalid `If-Match`
- `500` unexpected server/storage error (details logged server-side)

An import failure leaves the existing workspace unchanged. A replacement increments the server's revision; the revision in an imported backup is informational and is **not** reused.
