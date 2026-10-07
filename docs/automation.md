# Automation: driving Tracework from scripts and agents

Tracework is script-friendly by design: a stable local HTTP API, a file format
you can read directly, and an MCP server for coding agents. No tokens, no SDK.

## Option A - MCP server (Claude Code, OpenCode, Codex, any MCP client)

The stdio bridge needs no dependencies beyond Node itself:

```bash
TRACEWORK_DATA="$HOME/research/tracework.json" node mcp-server.js
```

Register it once per client (paths are examples):

```json
{
  "mcpServers": {
    "tracework": {
      "command": "node",
      "args": ["/path/to/tracework/mcp-server.js"],
      "env": { "TRACEWORK_DATA": "/path/to/research/tracework.json" }
    }
  }
}
```

Available tools: `list_projects`, `get_workspace`, `add_item`, `update_item`,
`delete_item`, `add_link`, `search` (use `projectId: "*"` for every project),
`undo`, `history`, `export_brief`, `import_csv`. Every mutation is validated and
undoable, exactly like the web UI.

## Option B - HTTP API with curl

The server runs on loopback only: `npm start`, then `http://127.0.0.1:3000`.
Every workspace write needs the current revision in `If-Match`; read it from
`/api/workspace` (or the previous write response) first.

```bash
BASE=http://127.0.0.1:3000
REV=$(curl -s $BASE/api/workspace | python3 -c 'import json,sys; print(json.load(sys.stdin)["revision"])')

# Add a task and capture its ID
TASK=$(curl -s -X POST $BASE/api/nodes \
  -H 'Content-Type: application/json' -H "If-Match: $REV" \
  -d '{"type":"task","title":"Write the summary","tags":["Sprint 3"]}')
echo "$TASK" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["nodes"][-1]["id"], d["revision"])'

# Link it to a decision (decisions advance into tasks)
curl -s -X POST $BASE/api/links \
  -H 'Content-Type: application/json' -H "If-Match: <new-revision>" \
  -d '{"from":"<decision-id>","to":"<task-id>","kind":"advances"}'

# Ranked search with operators
curl -s "$BASE/api/search?q=tag:%22Sprint%203%22%20is:gap" | python3 -m json.tool | head -30

# Undo the last change
curl -s -X POST $BASE/api/undo -H "If-Match: <revision>"
```

Link kinds: `supports`/`challenges` (source to claim), `informs` (claim to
decision), `advances` (decision to task). A `409` means the revision is stale:
re-read the workspace and retry. Full reference: [api.md](api.md).

## Option C - read the files directly

The workspace is plain JSON (`{ revision, nodes, links }`) plus sidecars:

```text
tracework.json              # default project workspace
tracework.json.history.json # undo snapshots (latest 50)
projects.json               # project index
projects/<id>.json          # other project workspaces
attachments/<project>/      # PDFs with a manifest.json
```

Read freely. For writes, prefer the API or MCP server so validation, revision
checks, history, and atomic renames all apply.
