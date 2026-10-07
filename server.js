import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { AppError, exportMarkdown, planBatch } from './src/core.js';
import { CSV_TEMPLATE, exportItemsCsv, parseItemsCsv } from './src/csv.js';
import { createHistory } from './src/history.js';
import { createProjectManager } from './src/projects.js';
import { createAttachmentStore, MAX_PDF_BYTES } from './src/attachments.js';
import { createSearchIndex } from './src/search.js';
import { sampleWorkspace } from './src/sample.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public');
const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Cache-Control': 'no-store',
};
function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { ...securityHeaders, 'Content-Type': type, ...extra });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
async function jsonBody(req) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new AppError(415, 'Expected application/json');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 32 * 1024 * 1024) throw new AppError(413, 'Request body too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError(400, 'Invalid JSON'); }
}
function revision(req) {
  if (!/^(0|[1-9]\d*)$/.test(req.headers['if-match'] ?? '') || !Number.isSafeInteger(Number(req.headers['if-match']))) throw new AppError(428, 'Send the current revision in If-Match');
  return Number(req.headers['if-match']);
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) throw new AppError(403, 'Cross-origin writes are not allowed');
}

export async function createApp({ dataFile = resolve('data/workspace.json'), initial = sampleWorkspace(), loopbackOnly = true } = {}) {
  const projects = await createProjectManager({ dataFile, initial });
  const attachments = await createAttachmentStore(join(dirname(resolve(dataFile)), 'attachments'));
  const histories = new Map();
  async function historyFor(projectId) {
    if (!histories.has(projectId)) {
      histories.set(projectId, createHistory(`${projects.fileFor(projectId)}.history.json`).init());
    }
    return histories.get(projectId);
  }
  // History is a safety net, never a reason to fail a save that already worked.
  async function withHistory(projectId, store, action, operation) {
    const before = store.snapshot();
    const result = await operation();
    try {
      await (await historyFor(projectId)).record({ before, after: store.snapshot(), action });
    } catch (error) {
      console.error(`history record failed (${action}):`, error.message || error);
    }
    return result;
  }
  const server = http.createServer(async (req, res) => {
    try {
      // A loopback listener must not accept arbitrary Host values (DNS rebinding).
      if (loopbackOnly && !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(req.headers.host || '')) throw new AppError(403, 'Invalid Host header');
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (req.method === 'GET' && staticFiles[path]) {
        const [file, type] = staticFiles[path];
        send(res, 200, await readFile(join(publicDir, file)), type);
        return;
      }
      if (req.method === 'GET' && path === '/api/health') { send(res, 200, { ok: true }); return; }
      if (req.method === 'GET' && path === '/api/health') { send(res, 200, { ok: true }); return; }
      if (req.method === 'GET' && path === '/api/projects') {
        send(res, 200, { defaultId: projects.defaultId, projects: projects.list() });
        return;
      }
      async function useProject() {
        const projectId = url.searchParams.get('project') || projects.defaultId;
        return { projectId, store: await projects.getStore(projectId) };
      }
      const attachmentRoute = path.match(/^\/api\/nodes\/([\w-]+)\/attachments(?:\/([\w-]+))?$/);
      if (req.method === 'GET' && path === '/api/search') {
        const { store } = await useProject();
        const rawLimit = url.searchParams.get('limit');
        const options = rawLimit === null ? {} : { limit: Number(rawLimit) };
        if (rawLimit !== null && (!Number.isSafeInteger(options.limit) || options.limit < 1)) throw new AppError(400, 'Limit must be a positive integer');
        send(res, 200, createSearchIndex(store.snapshot()).search(url.searchParams.get('q') ?? '', options));
        return;
      }
      if (req.method === 'GET' && path === '/api/workspace') { send(res, 200, (await useProject()).store.snapshot()); return; }
      if (req.method === 'GET' && path === '/api/history') {
        const { projectId, store } = await useProject();
        send(res, 200, { revision: store.snapshot().revision, entries: (await historyFor(projectId)).list() });
        return;
      }
      if (req.method === 'GET' && path === '/api/export.md') {
        send(res, 200, exportMarkdown((await useProject()).store.snapshot()), 'text/markdown; charset=utf-8', { 'Content-Disposition': 'attachment; filename="tracework-brief.md"' });
        return;
      }
      if (req.method === 'GET' && path === '/api/export.json') {
        send(res, 200, (await useProject()).store.snapshot(), 'application/json; charset=utf-8', { 'Content-Disposition': 'attachment; filename="tracework-workspace.json"' });
        return;
      }
      if (req.method === 'GET' && (path === '/api/export.csv' || path === '/api/template.csv')) {
        send(res, 200, path === '/api/template.csv' ? CSV_TEMPLATE : exportItemsCsv((await useProject()).store.snapshot()), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="tracework-${path === '/api/template.csv' ? 'template' : 'items'}.csv"` });
        return;
      }
      if (req.method === 'GET' && attachmentRoute && !attachmentRoute[2]) {
        const { projectId, store } = await useProject();
        if (!store.snapshot().nodes.some(node => node.id === attachmentRoute[1])) throw new AppError(404, 'Item not found');
        send(res, 200, { attachments: await attachments.list(projectId, attachmentRoute[1]) });
        return;
      }
      if (req.method === 'GET' && attachmentRoute?.[2]) {
        const { projectId, store } = await useProject();
        if (!store.snapshot().nodes.some(node => node.id === attachmentRoute[1])) throw new AppError(404, 'Item not found');
        const { descriptor, bytes } = await attachments.read(projectId, attachmentRoute[1], attachmentRoute[2]);
        send(res, 200, bytes, 'application/pdf', { 'Content-Disposition': `inline; filename="${descriptor.filename.replace(/"/g, '')}"` });
        return;
      }
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
        sameOrigin(req);
        if (req.method === 'POST' && path === '/api/projects') {
          const body = await jsonBody(req);
          if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.name !== 'string') throw new AppError(400, 'Expected { name: "..." }');
          const project = await projects.create(body.name);
          res.writeHead(201, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(project));
          return;
        }
        const projectRoute = path.match(/^\/api\/projects\/([\w-]+)$/);
        if (req.method === 'PATCH' && projectRoute) {
          const body = await jsonBody(req);
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'Invalid project update');
          const allowed = ['name', 'archived'];
          if (Object.keys(body).some(key => !allowed.includes(key)) || Object.keys(body).length === 0) throw new AppError(400, 'Update name and/or archived');
          let project = projects.list().find(item => item.id === projectRoute[1]);
          if (!project) throw new AppError(404, 'Project not found');
          if (body.name !== undefined) project = await projects.rename(project.id, body.name);
          if (body.archived !== undefined) {
            if (typeof body.archived !== 'boolean') throw new AppError(400, 'archived must be true or false');
            project = await projects.archive(project.id, body.archived);
          }
          send(res, 200, project);
          return;
        }
        // Attachments ride alongside the workspace but never bump its revision.
        if (attachmentRoute && !attachmentRoute[2]) {
          if (req.method === 'POST') {
            const { projectId, store } = await useProject();
            if (!store.snapshot().nodes.some(node => node.id === attachmentRoute[1])) throw new AppError(404, 'Item not found');
            const body = await jsonBody(req);
            if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.filename !== 'string' || typeof body.data !== 'string') throw new AppError(400, 'Expected { filename: "...pdf", data: "<base64>" }');
            if (body.data.length > 22 * 1024 * 1024) throw new AppError(413, 'PDF must be at most 15 MiB');
            let bytes;
            try { bytes = Buffer.from(body.data, 'base64'); } catch { throw new AppError(400, 'Attachment data must be base64'); }
            if (!bytes.length) throw new AppError(400, 'Attachment data must be base64');
            send(res, 200, await attachments.add(projectId, attachmentRoute[1], { filename: body.filename, bytes }));
            return;
          }
        } else if (attachmentRoute?.[2] && req.method === 'DELETE') {
          const { projectId, store } = await useProject();
          if (!store.snapshot().nodes.some(node => node.id === attachmentRoute[1])) throw new AppError(404, 'Item not found');
          await attachments.remove(projectId, attachmentRoute[1], attachmentRoute[2]);
          send(res, 200, { ok: true });
          return;
        }
        const expected = revision(req);
        const { projectId, store } = await useProject();
        if (req.method === 'POST' && (path === '/api/import/preview' || path === '/api/import/csv')) {
          const body = await jsonBody(req);
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'csv')) throw new AppError(400, 'Expected { csv: "..." }');
          const rows = parseItemsCsv(body.csv);
          if (path === '/api/import/preview') {
            const current = store.snapshot();
            if (expected !== current.revision) throw new AppError(409, 'Workspace changed. Refresh to see the latest version.');
            const { entries, add, skip } = planBatch(current, rows);
            send(res, 200, { revision: current.revision, entries, add, skip });
          } else {
            const { workspace, report } = await withHistory(projectId, store, `Import ${rows.length} CSV rows`, () => store.importNodes(expected, rows));
            send(res, 200, { workspace, report });
          }
          return;
        }
        if (req.method === 'POST' && path === '/api/undo') {
          const history = await historyFor(projectId);
          const [latest] = history.list();
          if (!latest) throw new AppError(404, 'Nothing to undo');
          const undone = latest.action;
          const current = store.snapshot();
          const result = await store.replace(expected, history.get(latest.id));
          // Undoing an undo restores the newer state, which gives redo for free.
          try {
            await history.record({ before: current, after: result, action: `Undo ${undone}` });
          } catch (error) {
            console.error('history record failed (undo):', error.message || error);
          }
          send(res, 200, { workspace: result, undone });
          return;
        }
        let result;
        const node = path.match(/^\/api\/nodes\/([\w-]+)$/);
        const link = path.match(/^\/api\/links\/([\w-]+)$/);
        const run = {
          addNode: body => withHistory(projectId, store, 'Add item', () => store.addNode(expected, body)),
          updateNode: (id, body) => withHistory(projectId, store, 'Edit item', () => store.updateNode(expected, id, body)),
          deleteNode: id => withHistory(projectId, store, 'Delete item', () => store.deleteNode(expected, id)),
          addLink: body => withHistory(projectId, store, 'Add connection', () => store.addLink(expected, body)),
          deleteLink: id => withHistory(projectId, store, 'Remove connection', () => store.deleteLink(expected, id)),
          replace: (body, label) => withHistory(projectId, store, label, () => store.replace(expected, body)),
        };
        if (req.method === 'POST' && path === '/api/nodes') result = await run.addNode(await jsonBody(req));
        else if (req.method === 'PATCH' && node) result = await run.updateNode(node[1], await jsonBody(req));
        else if (req.method === 'DELETE' && node) {
          result = await run.deleteNode(node[1]);
          for (const entry of await attachments.list(projectId, node[1]).catch(() => [])) {
            await attachments.remove(projectId, node[1], entry.id).catch(() => {});
          }
        }
        else if (req.method === 'POST' && path === '/api/links') result = await run.addLink(await jsonBody(req));
        else if (req.method === 'DELETE' && link) result = await run.deleteLink(link[1]);
        else if (req.method === 'PUT' && path === '/api/workspace') result = await run.replace(await jsonBody(req), 'Replace workspace');
        else if (req.method === 'POST' && path === '/api/sample') result = await run.replace(sampleWorkspace(), 'Load example');
        else throw new AppError(404, 'Route not found');
        send(res, 200, result);
        return;
      }
      throw new AppError(404, 'Route not found');
    } catch (error) {
      if (!(error instanceof AppError)) console.error(error);
      if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'Internal server error' });
    }
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be between 0 and 65535');
  const server = await createApp({ dataFile: resolve(process.env.TRACEWORK_DATA || 'data/workspace.json'), loopbackOnly: ['127.0.0.1', 'localhost', '::1'].includes(host) });
  server.listen(port, host, () => console.log(`Tracework running at http://${host}:${server.address().port}`));
}
