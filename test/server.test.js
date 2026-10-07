import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createApp } from '../server.js';
import { emptyWorkspace } from '../src/core.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tracework-http-'));
  const server = await createApp({ dataFile: join(dir, 'workspace.json'), initial: emptyWorkspace() });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, method = 'GET', data, revision = 0, headers = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(method !== 'GET' ? { 'If-Match': String(revision) } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(data !== undefined ? { body: typeof data === 'string' ? data : JSON.stringify(data) } : {}) });
    return { response, body: await response.text() };
  };
  return { request, port: server.address().port };
}

test('serves a local-only app and constrains static routes', async t => {
  const { request } = await fixture(t);
  const page = await request('/');
  assert.equal(page.response.status, 200);
  assert.match(page.body, /Tracework/);
  assert.match(page.body, /data-view="review"/);
  assert.match(page.response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal((await request('/app.js')).response.status, 200);
  assert.equal((await request('/api/health')).response.status, 200);
  assert.equal((await request('/src/core.js')).response.status, 404);
  assert.equal((await request('/..%2Fserver.js')).response.status, 404);
});

test('API revision checks, CRUD, exports, and re-import round trip', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/api/workspace')).body, JSON.stringify(emptyWorkspace()));
  const missing = await request('/api/nodes', 'POST', { type: 'task', title: 'Check' }, 0, { 'If-Match': '' });
  assert.equal(missing.response.status, 428);
  let result = await request('/api/nodes', 'POST', { type: 'task', title: 'Check' });
  assert.equal(result.response.status, 200);
  let state = JSON.parse(result.body);
  assert.equal(state.revision, 1);
  assert.equal((await request('/api/nodes', 'POST', { type: 'task', title: 'stale' })).response.status, 409);
  const id = state.nodes[0].id;
  result = await request(`/api/nodes/${id}`, 'PATCH', { status: 'done' }, state.revision);
  state = JSON.parse(result.body);
  assert.equal(state.nodes[0].status, 'done');
  const json = await request('/api/export.json');
  assert.match(json.response.headers.get('content-disposition'), /attachment/);
  assert.deepEqual(JSON.parse(json.body), state);
  const md = await request('/api/export.md');
  assert.match(md.body, /### Check/);
  assert.match(md.body, /Status: done/);
  result = await request('/api/workspace', 'PUT', { nodes: [], links: [] }, state.revision);
  state = JSON.parse(result.body);
  assert.equal(state.nodes.length, 0);
  result = await request('/api/workspace', 'PUT', JSON.parse(json.body), state.revision);
  state = JSON.parse(result.body);
  assert.equal(state.nodes[0].title, 'Check');
  assert.equal(state.revision, 4);
});

test('preserves UTF-8 characters across split request chunks', async t => {
  const { port } = await fixture(t);
  const body = Buffer.from(JSON.stringify({ type: 'source', title: 'Résumé 🧪' }));
  const split = body.indexOf(Buffer.from('🧪')) + 2;
  const result = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/nodes', method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': '0' } }, res => {
      let text = '';
      res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({ status: res.statusCode, state: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.write(body.subarray(0, split));
    req.end(body.subarray(split));
  });
  assert.equal(result.status, 200);
  assert.equal(result.state.nodes[0].title, 'Résumé 🧪');
});

test('rejects malformed input and cross-origin writes', async t => {
  const { request, port } = await fixture(t);
  assert.equal((await request('/api/nodes', 'POST', { type: 'source', title: 'bad' }, 0, { Origin: 'https://attacker.example' })).response.status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/workspace', headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(hostStatus, 403);
  assert.equal((await request('/api/nodes', 'POST', '{broken')).response.status, 400);
  assert.equal((await request('/api/nodes', 'POST', '"text"')).response.status, 400);
  assert.equal((await request('/api/nodes', 'POST', { type: 'source', title: 'ok' }, 0, { 'Content-Type': 'text/plain' })).response.status, 415);
  assert.equal((await request('/api/workspace')).body, JSON.stringify(emptyWorkspace()));
});
