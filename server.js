import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { AppError, createStore, exportMarkdown, planBatch } from './src/core.js';
import { CSV_TEMPLATE, exportItemsCsv, parseItemsCsv } from './src/csv.js';
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
  const store = await createStore(dataFile, initial).init();
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
      if (req.method === 'GET' && path === '/api/workspace') { send(res, 200, store.snapshot()); return; }
      if (req.method === 'GET' && path === '/api/export.md') {
        send(res, 200, exportMarkdown(store.snapshot()), 'text/markdown; charset=utf-8', { 'Content-Disposition': 'attachment; filename="tracework-brief.md"' });
        return;
      }
      if (req.method === 'GET' && path === '/api/export.json') {
        send(res, 200, store.snapshot(), 'application/json; charset=utf-8', { 'Content-Disposition': 'attachment; filename="tracework-workspace.json"' });
        return;
      }
      if (req.method === 'GET' && (path === '/api/export.csv' || path === '/api/template.csv')) {
        send(res, 200, path === '/api/template.csv' ? CSV_TEMPLATE : exportItemsCsv(store.snapshot()), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="tracework-${path === '/api/template.csv' ? 'template' : 'items'}.csv"` });
        return;
      }
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
        sameOrigin(req);
        const expected = revision(req);
        if (req.method === 'POST' && (path === '/api/import/preview' || path === '/api/import/csv')) {
          const body = await jsonBody(req);
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'csv')) throw new AppError(400, 'Expected { csv: "..." }');
          const rows = parseItemsCsv(body.csv);
          if (path === '/api/import/preview') {
            const current = store.snapshot();
            if (expected !== current.revision) throw new AppError(409, 'Workspace changed. Refresh to see the latest version.');
            const { entries, add, skip } = planBatch(current, rows);
            send(res, 200, { revision: current.revision, entries, add, skip });
          } else send(res, 200, await store.importNodes(expected, rows));
          return;
        }
        let result;
        const node = path.match(/^\/api\/nodes\/([\w-]+)$/);
        const link = path.match(/^\/api\/links\/([\w-]+)$/);
        if (req.method === 'POST' && path === '/api/nodes') result = await store.addNode(expected, await jsonBody(req));
        else if (req.method === 'PATCH' && node) result = await store.updateNode(expected, node[1], await jsonBody(req));
        else if (req.method === 'DELETE' && node) result = await store.deleteNode(expected, node[1]);
        else if (req.method === 'POST' && path === '/api/links') result = await store.addLink(expected, await jsonBody(req));
        else if (req.method === 'DELETE' && link) result = await store.deleteLink(expected, link[1]);
        else if (req.method === 'PUT' && path === '/api/workspace') result = await store.replace(expected, await jsonBody(req));
        else if (req.method === 'POST' && path === '/api/sample') result = await store.replace(expected, sampleWorkspace());
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
