import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { emptyWorkspace } from '../src/core.js';

const PDF_BASE64 = Buffer.from('%PDF-1.4 minimal test file').toString('base64');

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tracework-api2-'));
  const server = await createApp({ dataFile: join(dir, 'workspace.json'), initial: emptyWorkspace() });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, method = 'GET', data, revision) => {
    const headers = {};
    if (method !== 'GET' && revision !== undefined) headers['If-Match'] = String(revision);
    if (data !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + path, { method, headers, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* binary payload */ }
    return { response, json, text };
  };
  const workspace = async (project) => (await call(`/api/workspace${project ? `?project=${project}` : ''}`)).json;
  return { call, workspace };
}

test('projects are isolated, validated, and manageable', async t => {
  const { call, workspace } = await setup(t);
  const initial = await call('/api/projects');
  assert.equal(initial.response.status, 200);
  assert.equal(initial.json.defaultId, 'default');
  assert.equal(initial.json.projects.length, 1);
  assert.equal((await call('/api/projects', 'POST', {})).response.status, 400);
  const created = await call('/api/projects', 'POST', { name: '  Field study  ' });
  assert.equal(created.response.status, 201);
  assert.equal(created.json.name, 'Field study');
  const other = created.json.id;
  assert.equal((await workspace(other)).nodes.length, 0);
  const added = await call('/api/nodes', 'POST', { type: 'task', title: 'Only here' });
  assert.equal(added.response.status, 428);
  const addedDefault = await call('/api/nodes', 'POST', { type: 'task', title: 'Only here' }, 0);
  assert.equal(addedDefault.json.nodes.length, 1);
  assert.equal((await workspace(other)).nodes.length, 0);
  const addedOther = await call(`/api/nodes?project=${other}`, 'POST', { type: 'task', title: 'Other side' }, 0);
  assert.equal(addedOther.json.nodes[0].title, 'Other side');
  assert.equal((await workspace()).nodes.length, 1);
  assert.equal((await call('/api/workspace?project=nope')).response.status, 400);
  assert.equal((await call('/api/workspace?project=123e4567-e89b-42d3-a456-426614174000')).response.status, 404);
  const renamed = await call(`/api/projects/${other}`, 'PATCH', { name: 'Renamed', archived: true });
  assert.equal(renamed.json.name, 'Renamed');
  assert.equal(renamed.json.archived, true);
  assert.equal((await call(`/api/projects/${other}`, 'PATCH', { archived: 'yes' })).response.status, 400);
  assert.equal((await call('/api/projects/nope', 'PATCH', { name: 'x' })).response.status, 404);
  assert.equal((await call(`/api/nodes?project=${other}`, 'POST', { type: 'task', title: 'archived still works' }, 1)).response.status, 200);
});

test('undo restores the previous state and supports redo', async t => {
  const { call, workspace } = await setup(t);
  assert.equal((await call('/api/undo', 'POST', undefined, 0)).response.status, 404);
  const added = await call('/api/nodes', 'POST', { type: 'claim', title: 'Temporary' }, 0);
  assert.equal(added.json.nodes.length, 1);
  const history = await call('/api/history');
  assert.equal(history.json.revision, 1);
  assert.equal(history.json.entries[0].action, 'Add item');
  const undone = await call('/api/undo', 'POST', undefined, 1);
  assert.equal(undone.response.status, 200);
  assert.equal(undone.json.undone, 'Add item');
  assert.equal(undone.json.workspace.nodes.length, 0);
  assert.equal((await workspace()).nodes.length, 0);
  const redone = await call('/api/undo', 'POST', undefined, undone.json.workspace.revision);
  assert.equal(redone.json.workspace.nodes.length, 1);
  assert.equal((await call('/api/undo', 'POST', undefined, 0)).response.status, 409);
});

test('PDF attachments upload, list, download, and clean up with nodes', async t => {
  const { call } = await setup(t);
  const added = await call('/api/nodes', 'POST', { type: 'source', title: 'Paper' }, 0);
  const id = added.json.nodes[0].id;
  const revision = added.json.revision;
  assert.equal((await call(`/api/nodes/${id}/attachments`)).json.attachments.length, 0);
  assert.equal((await call(`/api/nodes/${id}/attachments`, 'POST', { filename: 'evil.exe', data: PDF_BASE64 })).response.status, 400);
  assert.equal((await call(`/api/nodes/${id}/attachments`, 'POST', { filename: 'note.pdf', data: 'bm90IGEgcGRm' })).response.status, 400);
  assert.equal((await call('/api/nodes/nope/attachments', 'POST', { filename: 'a.pdf', data: PDF_BASE64 })).response.status, 404);
  const uploaded = await call(`/api/nodes/${id}/attachments`, 'POST', { filename: 'My Paper.PDF', data: PDF_BASE64 });
  assert.equal(uploaded.response.status, 200);
  assert.equal(uploaded.json.contentType, 'application/pdf');
  const listed = await call(`/api/nodes/${id}/attachments`);
  assert.equal(listed.json.attachments.length, 1);
  assert.equal(listed.json.attachments[0].filename, 'My Paper.pdf');
  const removed = await call(`/api/nodes/${id}/attachments/${uploaded.json.id}`, 'DELETE');
  assert.equal(removed.json.ok, true);
  assert.equal((await call(`/api/nodes/${id}/attachments`)).json.attachments.length, 0);
  const again = await call(`/api/nodes/${id}/attachments`, 'POST', { filename: 'a.pdf', data: PDF_BASE64 });
  await call(`/api/nodes/${id}`, 'DELETE', undefined, revision);
  assert.equal((await call(`/api/nodes/${id}/attachments`)).response.status, 404);
  assert.ok(again.json.id);
});

test('attachment download returns the exact PDF bytes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tracework-dl-'));
  const server = await createApp({ dataFile: join(dir, 'workspace.json'), initial: emptyWorkspace() });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const added = await (await fetch(`${base}/api/nodes`, { method: 'POST', headers: { 'If-Match': '0', 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'source', title: 'S' }) })).json();
  const id = added.nodes[0].id;
  const uploaded = await (await fetch(`${base}/api/nodes/${id}/attachments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: 'doc.pdf', data: PDF_BASE64 }) })).json();
  const download = await fetch(`${base}/api/nodes/${id}/attachments/${uploaded.id}`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type'), /application\/pdf/);
  assert.equal(Buffer.from(await download.arrayBuffer()).toString('base64'), PDF_BASE64);
});

test('search endpoint ranks, filters, and validates', async t => {
  const { call } = await setup(t);
  const added = await call('/api/nodes', 'POST', { type: 'source', title: 'Field notes on rivers', body: 'Water flow observations' }, 0);
  const id = added.json.nodes[0].id;
  assert.ok(id);
  const found = await call('/api/search?q=rivers');
  assert.equal(found.response.status, 200);
  assert.equal(found.json.total, 1);
  assert.equal(found.json.results[0].title, 'Field notes on rivers');
  assert.equal((await call('/api/search?q=type:banana')).response.status, 400);
  assert.equal((await call('/api/search?q=x&limit=500')).response.status, 400);
  assert.equal((await call('/api/search')).json.total, 1);
});
