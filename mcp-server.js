// Tracework MCP server (stdio, no dependencies).
//
// Lets coding agents (Claude Code, OpenCode, Codex, and any MCP client)
// read and modify a local Tracework workspace with tools instead of HTTP.
// It speaks JSON-RPC 2.0 with Content-Length framing over stdio and calls
// the same backend modules as the web server.
//
// Configure the data file with TRACEWORK_DATA (defaults to
// ./data/workspace.json relative to the working directory).
//
// Example client configuration (Claude Code / Codex MCP):
// {
//   "mcpServers": {
//     "tracework": {
//       "command": "node",
//       "args": ["/path/to/tracework/mcp-server.js"],
//       "env": { "TRACEWORK_DATA": "/path/to/research/tracework.json" }
//     }
//   }
// }

import { resolve } from 'node:path';
import { dirname, join } from 'node:path';
import { AppError, exportMarkdown, planBatch } from './src/core.js';
import { parseItemsCsv } from './src/csv.js';
import { createAttachmentStore } from './src/attachments.js';
import { createHistory } from './src/history.js';
import { createProjectManager } from './src/projects.js';
import { createSearchIndex } from './src/search.js';

const VERSION = '1.0.0';
const dataFile = resolve(process.env.TRACEWORK_DATA || 'data/workspace.json');
const projects = await createProjectManager({ dataFile });
const attachments = await createAttachmentStore(join(dirname(dataFile), 'attachments'));
const histories = new Map();

async function historyFor(projectId) {
  if (!histories.has(projectId)) {
    histories.set(projectId, createHistory(`${projects.fileFor(projectId)}.history.json`).init());
  }
  return histories.get(projectId);
}

function projectArgument(value) {
  if (value === undefined) return projects.defaultId;
  if (typeof value !== 'string' || !value) throw new AppError(400, 'projectId must be a non-empty string');
  return value;
}

async function useProject(projectId) {
  return { projectId, store: await projects.getStore(projectId) };
}

function newId(before, after) {
  const known = new Set(before.map((entry) => entry.id));
  const created = after.find((entry) => !known.has(entry.id));
  return created ? created.id : null;
}

async function mutate(projectId, action, operation) {
  const { store } = await useProject(projectId);
  const before = store.snapshot();
  const result = await operation(store, before.revision);
  try {
    await (await historyFor(projectId)).record({ before, after: store.snapshot(), action });
  } catch (error) {
    console.error(`history record failed (${action}):`, error.message || error);
  }
  return { store, result };
}

function newNodeId(before, after) {
  return newId(before.nodes, after.nodes);
}

const TOOLS = [
  {
    name: 'list_projects',
    description: 'List all Tracework projects with their names and archived flags.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_project',
    description: 'Create a new empty project and return it.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'rename_project',
    description: 'Rename a project.',
    inputSchema: {
      type: 'object',
      required: ['projectId', 'name'],
      properties: { projectId: { type: 'string' }, name: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'archive_project',
    description: 'Archive or restore a project. Archived projects stay readable and writable.',
    inputSchema: {
      type: 'object',
      required: ['projectId', 'archived'],
      properties: { projectId: { type: 'string' }, archived: { type: 'boolean' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_workspace',
    description: 'Return the full workspace (revision, nodes, links) for a project.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: 'Project ID, defaults to the default project.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'add_item',
    description:
      'Add a source, claim, decision, or task. Sources accept url and citation {doi, authors, year, venue}. Tasks accept due (YYYY-MM-DD). Other types accept status.',
    inputSchema: {
      type: 'object',
      required: ['type', 'title'],
      properties: {
        projectId: { type: 'string' },
        type: { type: 'string', enum: ['source', 'claim', 'decision', 'task'] },
        title: { type: 'string' },
        body: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        url: { type: 'string' },
        status: { type: 'string' },
        due: { type: 'string' },
        citation: {
          type: 'object',
          properties: {
            doi: { type: 'string' },
            authors: { type: 'string' },
            year: { type: 'string' },
            venue: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'update_item',
    description: 'Update title, body, tags, url, status, due, or citation of an existing item.',
    inputSchema: {
      type: 'object',
      required: ['id', 'fields'],
      properties: {
        projectId: { type: 'string' },
        id: { type: 'string' },
        fields: { type: 'object' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'delete_item',
    description: 'Delete an item together with its connections.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { projectId: { type: 'string' }, id: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'add_link',
    description:
      'Connect two items. Kinds: supports and challenges (source to claim), informs (claim to decision), advances (decision to task).',
    inputSchema: {
      type: 'object',
      required: ['from', 'to', 'kind'],
      properties: {
        projectId: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        kind: { type: 'string', enum: ['supports', 'challenges', 'informs', 'advances'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search',
    description:
      'Ranked full-text search with prefix and fuzzy matching. Operators: type:, tag:, status:, is:unverified/contested/gap, before:, after: (YYYY-MM-DD), quoted phrases. Use projectId "*" to search every project.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        projectId: { type: 'string', description: 'Project ID or "*" for all projects.' },
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'undo',
    description: 'Restore the workspace to the state before the last change. Undoing an undo redoes.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'history',
    description: 'List undoable changes, newest first.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'export_brief',
    description: 'Render the workspace as a Markdown research brief with evidence states and connections.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'list_attachments',
    description: 'List PDF attachments on an item.',
    inputSchema: {
      type: 'object',
      required: ['nodeId'],
      properties: { projectId: { type: 'string' }, nodeId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'upload_attachment',
    description: 'Attach a PDF file (base64 data, at most 15 MiB) to an item.',
    inputSchema: {
      type: 'object',
      required: ['nodeId', 'filename', 'data'],
      properties: {
        projectId: { type: 'string' },
        nodeId: { type: 'string' },
        filename: { type: 'string' },
        data: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'delete_attachment',
    description: 'Delete a PDF attachment from an item.',
    inputSchema: {
      type: 'object',
      required: ['nodeId', 'attachmentId'],
      properties: { projectId: { type: 'string' }, nodeId: { type: 'string' }, attachmentId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'import_csv',
    description:
      'Import items from CSV text (columns: type,title,body,url,status,due,tags,doi,authors,year,venue). Duplicates are skipped; any invalid row aborts the whole import.',
    inputSchema: {
      type: 'object',
      required: ['csv'],
      properties: { projectId: { type: 'string' }, csv: { type: 'string' } },
      additionalProperties: false,
    },
  },
];

function requireString(value, name) {
  if (typeof value !== 'string' || !value) throw new AppError(400, `${name} is required`);
  return value;
}

function requireNode(store, id) {
  const node = store.snapshot().nodes.find((item) => item.id === id);
  if (!node) throw new AppError(404, 'Item not found');
  return node;
}

async function callTool(name, args = {}) {
  if (args !== null && typeof args !== 'object') throw new AppError(400, 'Tool arguments must be an object');
  switch (name) {
    case 'list_projects':
      return { defaultId: projects.defaultId, projects: projects.list() };
    case 'create_project':
      return projects.create(requireString(args.name, 'name'));
    case 'rename_project':
      return projects.rename(requireString(args.projectId, 'projectId'), requireString(args.name, 'name'));
    case 'archive_project': {
      if (typeof args.archived !== 'boolean') throw new AppError(400, 'archived must be true or false');
      return projects.archive(requireString(args.projectId, 'projectId'), args.archived);
    }
    case 'get_workspace': {
      const { store } = await useProject(projectArgument(args.projectId));
      return store.snapshot();
    }
    case 'add_item': {
      const projectId = projectArgument(args.projectId);
      const { type, title, body, tags, url, status, due, citation } = args;
      if (typeof type !== 'string' || typeof title !== 'string') throw new AppError(400, 'type and title are required');
      const input = { type, title };
      if (body !== undefined) input.body = body;
      if (tags !== undefined) input.tags = tags;
      if (url !== undefined) input.url = url;
      if (status !== undefined) input.status = status;
      if (due !== undefined) input.due = due;
      if (citation !== undefined) input.citation = citation;
      const before = (await useProject(projectId)).store.snapshot();
      const { result } = await mutate(projectId, 'Add item (agent)', (store, revision) =>
        store.addNode(revision, input),
      );
      return { id: newNodeId(before, result), revision: result.revision };
    }
    case 'update_item': {
      const projectId = projectArgument(args.projectId);
      const id = requireString(args.id, 'id');
      if (!args.fields || typeof args.fields !== 'object') throw new AppError(400, 'fields must be an object');
      const { result } = await mutate(projectId, 'Edit item (agent)', (store, revision) =>
        store.updateNode(revision, id, args.fields),
      );
      return { revision: result.revision };
    }
    case 'delete_item': {
      const projectId = projectArgument(args.projectId);
      const id = requireString(args.id, 'id');
      const { result } = await mutate(projectId, 'Delete item (agent)', (store, revision) =>
        store.deleteNode(revision, id),
      );
      for (const entry of await attachments.list(projectId, id).catch(() => [])) {
        await attachments.remove(projectId, id, entry.id).catch(() => {});
      }
      return { revision: result.revision };
    }
    case 'add_link': {
      const projectId = projectArgument(args.projectId);
      const from = requireString(args.from, 'from');
      const to = requireString(args.to, 'to');
      const kind = requireString(args.kind, 'kind');
      const before = (await useProject(projectId)).store.snapshot();
      const { result } = await mutate(projectId, 'Add connection (agent)', (store, revision) =>
        store.addLink(revision, { from, to, kind }),
      );
      const knownLinks = new Set(before.links.map((link) => link.id));
      const created = result.links.find((link) => !knownLinks.has(link.id));
      return { id: created ? created.id : null, revision: result.revision };
    }
    case 'search': {
      const query = requireString(args.query, 'query');
      const limit = args.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AppError(400, 'limit must be 1-100');
      if (args.projectId === '*') {
        const merged = [];
        for (const item of projects.list()) {
          const projectStore = await projects.getStore(item.id);
          for (const hit of createSearchIndex(projectStore.snapshot()).search(query, { limit }).results) {
            merged.push({ ...hit, projectId: item.id, projectName: item.name });
          }
        }
        merged.sort((a, b) => b.score - a.score);
        return { total: merged.length, results: merged.slice(0, limit) };
      }
      const { store } = await useProject(projectArgument(args.projectId));
      return createSearchIndex(store.snapshot()).search(query, { limit });
    }
    case 'undo': {
      const projectId = projectArgument(args.projectId);
      const { store } = await useProject(projectId);
      const history = await historyFor(projectId);
      const [latest] = history.list();
      if (!latest) throw new AppError(404, 'Nothing to undo');
      const current = store.snapshot();
      const result = await store.replace(current.revision, history.get(latest.id));
      try {
        await history.record({ before: current, after: result, action: `Undo ${latest.action}` });
      } catch (error) {
        console.error('history record failed (undo):', error.message || error);
      }
      return { undone: latest.action, revision: result.revision };
    }
    case 'history': {
      const projectId = projectArgument(args.projectId);
      const { store } = await useProject(projectId);
      return { revision: store.snapshot().revision, entries: (await historyFor(projectId)).list() };
    }
    case 'export_brief': {
      const { store } = await useProject(projectArgument(args.projectId));
      return { markdown: exportMarkdown(store.snapshot()) };
    }
    case 'list_attachments': {
      const projectId = projectArgument(args.projectId);
      const nodeId = requireString(args.nodeId, 'nodeId');
      const { store } = await useProject(projectId);
      requireNode(store, nodeId);
      return { attachments: await attachments.list(projectId, nodeId) };
    }
    case 'upload_attachment': {
      const projectId = projectArgument(args.projectId);
      const nodeId = requireString(args.nodeId, 'nodeId');
      const filename = requireString(args.filename, 'filename');
      if (typeof args.data !== 'string' || !args.data) throw new AppError(400, 'data must be base64 PDF content');
      if (args.data.length > 22 * 1024 * 1024) throw new AppError(413, 'PDF must be at most 15 MiB');
      const { store } = await useProject(projectId);
      requireNode(store, nodeId);
      return attachments.add(projectId, nodeId, { filename, bytes: Buffer.from(args.data, 'base64') });
    }
    case 'delete_attachment': {
      const projectId = projectArgument(args.projectId);
      const nodeId = requireString(args.nodeId, 'nodeId');
      const attachmentId = requireString(args.attachmentId, 'attachmentId');
      const { store } = await useProject(projectId);
      requireNode(store, nodeId);
      await attachments.remove(projectId, nodeId, attachmentId);
      return { ok: true };
    }
    case 'import_csv': {
      const projectId = projectArgument(args.projectId);
      const csv = requireString(args.csv, 'csv');
      const rows = parseItemsCsv(csv);
      const { result } = await mutate(projectId, 'Import CSV (agent)', (store, revision) =>
        store.importNodes(revision, rows),
      );
      return { added: result.report.added, skipped: result.report.skipped, revision: result.workspace.revision };
    }
    default:
      throw new AppError(404, `Unknown tool: ${name}`);
  }
}

function frame(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function reply(id, result) {
  frame({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  frame({ jsonrpc: '2.0', id, error: { code, message } });
}

async function dispatch(message) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || message.method === undefined) {
    if (message && message.id !== undefined) fail(message.id, -32600, 'Invalid request');
    return;
  }
  const { id, method, params } = message;
  try {
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'tracework', version: VERSION },
      });
    } else if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
      return;
    } else if (method === 'tools/list') {
      reply(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      const args = params?.arguments ?? {};
      try {
        const output = await callTool(params?.name, args);
        reply(id, { content: [{ type: 'text', text: JSON.stringify(output) }] });
      } catch (error) {
        reply(id, {
          content: [{ type: 'text', text: error.status ? error.message : 'Internal server error' }],
          isError: true,
        });
      }
    } else {
      fail(id, -32601, `Method not found: ${method}`);
    }
  } catch (error) {
    fail(id, -32603, error.message || 'Internal error');
  }
}

let buffer = Buffer.alloc(0);
let stdinEnded = false;
let inFlight = 0;
function maybeExit() {
  if (stdinEnded && inFlight === 0) process.exit(0);
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString('ascii');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    if (buffer.length < headerEnd + 4 + length) return;
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
    buffer = buffer.subarray(headerEnd + 4 + length);
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      // Malformed frame without an id cannot be answered; drop it.
      continue;
    }
    inFlight++;
    dispatch(message).finally(() => {
      inFlight--;
      maybeExit();
    });
  }
});
process.stdin.on('end', () => {
  stdinEnded = true;
  maybeExit();
});
process.stdin.resume();
