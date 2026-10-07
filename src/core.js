import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

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
export const MAX_IMPORT_ROWS = 500;

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
function validDate(value) {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
const tagsSchema = z.array(z.string().trim().min(1).max(32).regex(/^[^,|\x00-\x1f]+$/, 'Avoid commas, pipes, and control characters in tags'))
  .max(12).superRefine((tags, context) => {
    if (new Set(tags.map(tag => tag.toLocaleLowerCase())).size !== tags.length) context.addIssue({ code: 'custom', message: 'Tags must be unique (case-insensitive)' });
  });
const urlSchema = z.string().trim().max(2048).refine(value => {
  if (!value) return true;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); }
  catch { return false; }
}, 'URL must be an http(s) URL');
const dateSchema = z.string().trim().max(10).refine(validDate, 'Due must be a valid YYYY-MM-DD date');
export const EMPTY_CITATION = Object.freeze({ doi: '', authors: '', year: '', venue: '' });
const citationSchema = z.strictObject({
  doi: z.string().trim().max(200)
    .transform(value => value.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').trim().toLowerCase())
    .refine(value => !value || /^10\.\d{4,9}\/\S+$/i.test(value), 'Use a valid DOI, e.g. 10.1234/example')
    .optional(),
  authors: z.string().trim().max(500).optional(),
  year: z.string().trim().regex(/^(?:\d{4})?$/, 'Use a four-digit year').optional(),
  venue: z.string().trim().max(200).optional(),
});
const schemas = Object.fromEntries(TYPES.map(type => [type, z.strictObject({
  title: z.string().trim().min(1, 'Title is required').max(160),
  body: z.string().trim().max(10000).optional(),
  tags: tagsSchema.optional(),
  status: z.enum(STATUSES[type]).optional(),
  ...(type === 'source' ? {
    url: urlSchema.optional(),
    citation: citationSchema.optional(),
  } : {}),
  ...(type === 'task' ? { due: dateSchema.optional() } : {}),
})]));
export function normalizeCitation(input = {}) {
  const parsed = citationSchema.safeParse(input ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError(400, `citation.${issue.path.join('.')}: ${issue.message}`);
  }
  return { ...EMPTY_CITATION, ...parsed.data };
}

export function validateNodeFields(input, type, partial = false) {
  if (!TYPES.includes(type)) throw new AppError(400, 'Invalid item type');
  const parsed = (partial ? schemas[type].partial() : schemas[type]).safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError(400, `${issue.path.join('.') || 'item'}: ${issue.message}`);
  }
  const clean = parsed.data;
  if (clean.citation) clean.citation = normalizeCitation(clean.citation);
  return clean;
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
    keysOnly(node, ['id', 'type', 'title', 'body', 'url', 'status', 'due', 'tags', 'citation', 'createdAt', 'updatedAt']);
    if (typeof node.id !== 'string' || !/^[\w-]{1,80}$/.test(node.id) || ids.has(node.id) || !TYPES.includes(node.type)) throw new AppError(400, 'Invalid or duplicate node ID/type');
    ids.add(node.id);
    const validTime = value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
    if (!validTime(node.createdAt) || !validTime(node.updatedAt)) throw new AppError(400, 'Invalid timestamp');
    const fields = { title: node.title, body: node.body ?? '', tags: node.tags === undefined ? [] : node.tags };
    if (node.type === 'source') fields.citation = node.citation ?? {};
    if (node.url !== undefined && (node.type === 'source' || node.url !== '')) fields.url = node.url;
    if (node.status !== undefined) fields.status = node.status;
    if (node.due !== undefined && (node.type === 'task' || node.due !== '')) fields.due = node.due;
    const clean = validateNodeFields(fields, node.type);
    return { id: node.id, type: node.type, body: '', url: '', due: '', tags: [], status: STATUSES[node.type][0], ...clean, createdAt: node.createdAt, updatedAt: node.updatedAt };
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

// The same plan is used for previews and for the queued commit, so duplicates
// are recalculated against the actual revision being written.
export function planBatch(workspace, rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_IMPORT_ROWS) throw new AppError(400, `Import 1-${MAX_IMPORT_ROWS} rows at a time`);
  const identity = node => node.type === 'source' && node.url
    ? `source:url:${new URL(node.url).href}`
    : `${node.type}:title:${node.title.toLocaleLowerCase()}`;
  const seen = new Set(workspace.nodes.map(identity));
  const entries = [];
  const additions = [];
  for (const row of rows) {
    try {
      const { type, ...fields } = row.item;
      const clean = validateNodeFields(fields, type);
      const item = { type, body: '', url: '', due: '', tags: [], status: STATUSES[type][0], ...clean };
      const key = identity(item);
      const action = seen.has(key) ? 'skip' : 'add';
      entries.push({ line: row.line, title: item.title, type, action, ...(action === 'skip' ? { reason: 'Already in workspace or this file' } : {}) });
      if (action === 'add') { seen.add(key); additions.push(item); }
    } catch (error) {
      if (error instanceof AppError) throw new AppError(400, `Row ${row.line}: ${error.message}`);
      throw error;
    }
  }
  if (workspace.nodes.length + additions.length > MAX_NODES) throw new AppError(400, 'Import exceeds workspace capacity');
  return { entries, additions, add: additions.length, skip: rows.length - additions.length };
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
        keysOnly(input, ['type', 'title', 'body', 'url', 'status', 'due', 'tags', 'citation']);
        if (!TYPES.includes(input.type)) throw new AppError(400, 'Invalid item type');
        if (next.nodes.length >= MAX_NODES) throw new AppError(400, 'Workspace is full');
        const { type, ...fields } = input;
        if (type === 'source' && !('citation' in fields)) fields.citation = {};
        const clean = validateNodeFields(fields, type);
        const now = new Date().toISOString();
        next.nodes.push({ id: randomUUID(), type, title: '', body: '', url: '', due: '', tags: [], status: STATUSES[type][0], ...clean, createdAt: now, updatedAt: now, ...(type === 'source' ? { citation: clean.citation ?? { ...EMPTY_CITATION } } : {}) });
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
    importNodes(expected, rows) {
      let report;
      return mutate(expected, next => {
        const plan = planBatch(next, rows);
        const now = new Date().toISOString();
        next.nodes.push(...plan.additions.map(item => ({ id: randomUUID(), ...item, createdAt: now, updatedAt: now })));
        report = { added: plan.add, skipped: plan.skip };
      }).then(workspace => ({ workspace, report }));
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
      if (node.tags?.length) lines.push(`Tags: ${node.tags.map(md).join(', ')}`);
      if (node.url) lines.push(`URL: ${node.url}`);
      if (node.citation?.doi) lines.push(`DOI: ${node.citation.doi}`);
      if (node.citation?.authors) lines.push(`Authors: ${md(node.citation.authors)}`);
      if (node.citation?.year || node.citation?.venue) lines.push(`Published: ${md([node.citation.venue, node.citation.year].filter(Boolean).join(', '))}`);
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
