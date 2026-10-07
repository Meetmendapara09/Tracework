import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const TYPES = ['source', 'claim', 'decision', 'task'];
export const LINK_RULES = {
  supports: ['source', 'claim'],
  challenges: ['source', 'claim'],
  informs: ['claim', 'decision'],
  advances: ['decision', 'task'],
};
const STATUSES = { source: [''], claim: ['open', 'reviewed'], decision: ['proposed', 'accepted', 'rejected'], task: ['todo', 'doing', 'done'] };
const MAX_NODES = 2000;
const MAX_LINKS = 6000;

export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keysOnly(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new AppError(400, 'Invalid or unexpected fields');
}
function text(value, name, max, required = false) {
  if (typeof value !== 'string' || value.length > max) throw new AppError(400, `${name} must be text of at most ${max} characters`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new AppError(400, `${name} is required`);
  return trimmed;
}
function validDate(value) {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validateNodeFields(input, type, partial = false) {
  keysOnly(input, ['title', 'body', 'url', 'status', 'due']);
  if (!partial && !('title' in input)) throw new AppError(400, 'title is required');
  const out = {};
  if ('title' in input) out.title = text(input.title, 'title', 160, true);
  if ('body' in input) out.body = text(input.body, 'body', 10000);
  if ('url' in input) {
    if (type !== 'source') throw new AppError(400, 'Only sources can have URLs');
    out.url = text(input.url, 'url', 2048);
    if (out.url) {
      try {
        const url = new URL(out.url);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
      } catch { throw new AppError(400, 'url must be an http(s) URL'); }
    }
  }
  if ('status' in input) {
    if (!STATUSES[type].includes(input.status)) throw new AppError(400, `Invalid ${type} status`);
    out.status = input.status;
  }
  if ('due' in input) {
    if (type !== 'task') throw new AppError(400, 'Only tasks can have due dates');
    out.due = text(input.due, 'due', 10);
    if (!validDate(out.due)) throw new AppError(400, 'due must be a valid YYYY-MM-DD date');
  }
  return out;
}
function validateLink(input, nodes) {
  keysOnly(input, ['from', 'to', 'kind']);
  if (typeof input.from !== 'string' || typeof input.to !== 'string' || typeof input.kind !== 'string') throw new AppError(400, 'Invalid link');
  const source = nodes.find(node => node.id === input.from);
  const target = nodes.find(node => node.id === input.to);
  if (!source || !target || !LINK_RULES[input.kind] ||
      source.type !== LINK_RULES[input.kind][0] || target.type !== LINK_RULES[input.kind][1]) {
    throw new AppError(400, 'Link must connect compatible items');
  }
  return { from: input.from, to: input.to, kind: input.kind };
}
export function emptyWorkspace() { return { revision: 0, nodes: [], links: [] }; }

// Imports are validated as untrusted input, including identifiers and relationships.
export function validateWorkspace(input) {
  keysOnly(input, ['revision', 'nodes', 'links']);
  if (!Array.isArray(input.nodes) || !Array.isArray(input.links) || input.nodes.length > MAX_NODES || input.links.length > MAX_LINKS) throw new AppError(400, 'Invalid workspace size');
  const ids = new Set();
  const nodes = input.nodes.map(node => {
    keysOnly(node, ['id', 'type', 'title', 'body', 'url', 'status', 'due', 'createdAt', 'updatedAt']);
    if (typeof node.id !== 'string' || !/^[\w-]{1,80}$/.test(node.id) || ids.has(node.id) || !TYPES.includes(node.type)) throw new AppError(400, 'Invalid or duplicate node ID/type');
    ids.add(node.id);
    const validTime = value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
    if (!validTime(node.createdAt) || !validTime(node.updatedAt)) throw new AppError(400, 'Invalid timestamp');
    const fields = { title: node.title, body: node.body ?? '' };
    if (node.url !== undefined && (node.type === 'source' || node.url !== '')) fields.url = node.url;
    if (node.status !== undefined) fields.status = node.status;
    if (node.due !== undefined && (node.type === 'task' || node.due !== '')) fields.due = node.due;
    const clean = validateNodeFields(fields, node.type);
    return { id: node.id, type: node.type, body: '', url: '', due: '', status: STATUSES[node.type][0], ...clean, createdAt: node.createdAt, updatedAt: node.updatedAt };
  });
  const linkIds = new Set();
  const links = input.links.map(link => {
    keysOnly(link, ['id', 'from', 'to', 'kind']);
    if (typeof link.id !== 'string' || !/^[\w-]{1,80}$/.test(link.id) || linkIds.has(link.id) || ids.has(link.id)) throw new AppError(400, 'Invalid or duplicate link ID');
    linkIds.add(link.id);
    return { id: link.id, ...validateLink({ from: link.from, to: link.to, kind: link.kind }, nodes) };
  });
  if (new Set(links.map(link => `${link.from}:${link.to}:${link.kind}`)).size !== links.length) throw new AppError(400, 'Duplicate links');
  return { nodes, links };
}

export function createStore(file, initial = emptyWorkspace()) {
  let state;
  let queue = Promise.resolve();
  async function persist(next) {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
  async function init() {
    try {
      const loaded = JSON.parse(await readFile(file, 'utf8'));
      if (!Number.isSafeInteger(loaded.revision) || loaded.revision < 0) throw new Error('Invalid revision');
      state = { revision: loaded.revision, ...validateWorkspace(loaded) };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state = { revision: 0, ...validateWorkspace(initial) };
      await persist(state);
    }
    return store;
  }
  function snapshot() { return structuredClone(state); }
  function mutate(expected, change) {
    const operation = queue.then(async () => {
      if (!Number.isSafeInteger(expected) || expected !== state.revision) throw new AppError(409, 'Workspace changed. Refresh to see the latest version.');
      const next = snapshot();
      change(next);
      next.revision++;
      await persist(next);
      state = next;
      return snapshot();
    });
    queue = operation.catch(() => {});
    return operation;
  }
  const store = {
    init, snapshot,
    addNode(expected, input) {
      return mutate(expected, next => {
        keysOnly(input, ['type', 'title', 'body', 'url', 'status', 'due']);
        if (!TYPES.includes(input.type)) throw new AppError(400, 'Invalid item type');
        if (next.nodes.length >= MAX_NODES) throw new AppError(400, 'Workspace is full');
        const { type, ...fields } = input;
        const clean = validateNodeFields(fields, type);
        const now = new Date().toISOString();
        next.nodes.push({ id: randomUUID(), type, title: '', body: '', url: '', due: '', status: STATUSES[type][0], ...clean, createdAt: now, updatedAt: now });
      });
    },
    updateNode(expected, id, fields) {
      return mutate(expected, next => {
        const node = next.nodes.find(item => item.id === id);
        if (!node) throw new AppError(404, 'Item not found');
        Object.assign(node, validateNodeFields(fields, node.type, true), { updatedAt: new Date().toISOString() });
      });
    },
    deleteNode(expected, id) {
      return mutate(expected, next => {
        if (!next.nodes.some(node => node.id === id)) throw new AppError(404, 'Item not found');
        next.nodes = next.nodes.filter(node => node.id !== id);
        next.links = next.links.filter(link => link.from !== id && link.to !== id);
      });
    },
    addLink(expected, input) {
      return mutate(expected, next => {
        const link = validateLink(input, next.nodes);
        if (next.links.length >= MAX_LINKS) throw new AppError(400, 'Workspace is full');
        if (next.links.some(item => item.from === link.from && item.to === link.to && item.kind === link.kind)) throw new AppError(409, 'That connection already exists');
        next.links.push({ id: randomUUID(), ...link });
      });
    },
    deleteLink(expected, id) {
      return mutate(expected, next => {
        if (!next.links.some(link => link.id === id)) throw new AppError(404, 'Connection not found');
        next.links = next.links.filter(link => link.id !== id);
      });
    },
    replace(expected, input) {
      const clean = validateWorkspace(input);
      return mutate(expected, next => {
        next.nodes = clean.nodes;
        next.links = clean.links;
      });
    },
  };
  return store;
}

export function claimHealth(workspace, claimId) {
  const links = workspace.links.filter(link => link.to === claimId);
  const support = links.filter(link => link.kind === 'supports').length;
  const challenge = links.filter(link => link.kind === 'challenges').length;
  return { support, challenge, label: challenge ? 'Contested' : support ? 'Supported' : 'Unverified' };
}

export function decisionHealth(workspace, decisionId) {
  const claims = workspace.links.filter(link => link.to === decisionId && link.kind === 'informs').map(link => link.from);
  if (!claims.length) return 'No claims linked';
  if (claims.some(id => claimHealth(workspace, id).challenge)) return 'Needs review';
  if (claims.some(id => !claimHealth(workspace, id).support)) return 'Evidence gap';
  return 'Evidence linked';
}

function md(value) { return value.replace(/[\\*_`[\]<>]/g, '\\$&').replace(/\r/g, ''); }
export function exportMarkdown(workspace) {
  const lines = ['# Tracework research brief', '', `Exported: ${new Date().toISOString()}`, '', 'Evidence trail: sources → claims → decisions → tasks.', ''];
  for (const type of TYPES) {
    lines.push(`## ${type[0].toUpperCase() + type.slice(1)}s`, '');
    const nodes = workspace.nodes.filter(node => node.type === type);
    if (!nodes.length) lines.push('_None yet._', '');
    for (const node of nodes) {
      lines.push(`### ${md(node.title)}`, '', `ID: \`${node.id}\``);
      if (node.status) lines.push(`Status: ${node.status}`);
      if (node.due) lines.push(`Due: ${node.due}`);
      if (node.url) lines.push(`URL: ${node.url}`);
      if (type === 'claim') lines.push(`Evidence: ${claimHealth(workspace, node.id).label}`);
      if (type === 'decision') lines.push(`Readiness: ${decisionHealth(workspace, node.id)}`);
      if (node.body) lines.push('', ...node.body.split('\n').map(line => `> ${line}`));
      const related = workspace.links.filter(link => link.to === node.id || link.from === node.id);
      if (related.length) {
        lines.push('', 'Connections:');
        for (const link of related) {
          const other = workspace.nodes.find(item => item.id === (link.from === node.id ? link.to : link.from));
          lines.push(`- ${link.kind} ${link.from === node.id ? '→' : '←'} ${md(other.title)} (${other.id})`);
        }
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}
