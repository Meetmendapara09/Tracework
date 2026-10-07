import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'mcp-server.js');

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

async function session(t, dataFile) {
  const child = spawn('node', [SERVER], {
    env: { ...process.env, TRACEWORK_DATA: dataFile },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let buffer = Buffer.alloc(0);
  const pending = new Map();
  let nextId = 1;
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const header = buffer.subarray(0, end).toString('ascii');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = buffer.subarray(end + 4);
        continue;
      }
      const length = Number(match[1]);
      if (buffer.length < end + 4 + length) return;
      const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString('utf8'));
      buffer = buffer.subarray(end + 4 + length);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const errors = [];
  child.stderr.on('data', (chunk) => errors.push(chunk.toString()));
  t.after(() => {
    if (errors.length) console.error('mcp stderr:', errors.join('').slice(0, 500));
  });
  async function request(method, params = {}) {
    const id = nextId++;
    child.stdin.write(frame({ jsonrpc: '2.0', id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No response for ${method}`)), 10000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }
  const initialized = await request('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(initialized.result.serverInfo.name, 'tracework');
  return { request };
}

function text(message) {
  assert.ok(!message.error, `Unexpected error: ${JSON.stringify(message.error)}`);
  return message.result;
}

test('MCP server lists tools and manages items end to end', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tracework-mcp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { request } = await session(t, join(dir, 'workspace.json'));

  const tools = text(await request('tools/list')).tools.map((tool) => tool.name);
  for (const name of [
    'list_projects',
    'get_workspace',
    'add_item',
    'update_item',
    'delete_item',
    'add_link',
    'search',
    'undo',
    'history',
    'export_brief',
    'import_csv',
  ]) {
    assert.ok(tools.includes(name), `missing tool ${name}`);
  }

  const added = JSON.parse(
    text(
      await request('tools/call', {
        name: 'add_item',
        arguments: { type: 'task', title: 'Agent task', tags: ['MCP'] },
      }),
    ).content[0].text,
  );
  assert.ok(added.id);
  assert.equal(added.revision, 1);

  const found = JSON.parse(
    text(await request('tools/call', { name: 'search', arguments: { query: 'agent' } })).content[0].text,
  );
  assert.equal(found.total, 1);
  assert.equal(found.results[0].title, 'Agent task');

  const brief = JSON.parse(text(await request('tools/call', { name: 'export_brief', arguments: {} })).content[0].text);
  assert.match(brief.markdown, /Agent task/);

  const undone = JSON.parse(text(await request('tools/call', { name: 'undo', arguments: {} })).content[0].text);
  assert.equal(undone.undone, 'Add item (agent)');
  const empty = JSON.parse(text(await request('tools/call', { name: 'get_workspace', arguments: {} })).content[0].text);
  assert.equal(empty.nodes.length, 0);
});

test('MCP server reports tool errors without crashing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tracework-mcp-err-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { request } = await session(t, join(dir, 'workspace.json'));

  const bad = await request('tools/call', { name: 'add_item', arguments: { type: 'task' } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /title/);

  const unknown = await request('tools/call', { name: 'nope', arguments: {} });
  assert.equal(unknown.result.isError, true);

  const missing = await request('no/such/method', {});
  assert.equal(missing.error.code, -32601);

  const again = JSON.parse(text(await request('tools/call', { name: 'list_projects', arguments: {} })).content[0].text);
  assert.equal(again.projects.length, 1);
});

test('MCP server manages projects and PDF attachments', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tracework-mcp-proj-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { request } = await session(t, join(dir, 'workspace.json'));
  const call = async (name, args) =>
    JSON.parse(text(await request('tools/call', { name, arguments: args })).content[0].text);

  const created = await call('create_project', { name: 'Agent research' });
  assert.ok(created.id);
  const renamed = await call('rename_project', { projectId: created.id, name: 'Renamed research' });
  assert.equal(renamed.name, 'Renamed research');
  const archived = await call('archive_project', { projectId: created.id, archived: true });
  assert.equal(archived.archived, true);

  const item = await call('add_item', { projectId: created.id, type: 'source', title: 'Paper with PDF' });
  const pdf = Buffer.from('%PDF-1.4 agent attachment').toString('base64');
  const uploaded = await call('upload_attachment', {
    projectId: created.id,
    nodeId: item.id,
    filename: 'paper.pdf',
    data: pdf,
  });
  assert.equal(uploaded.contentType, 'application/pdf');
  const listed = await call('list_attachments', { projectId: created.id, nodeId: item.id });
  assert.equal(listed.attachments.length, 1);

  await call('delete_item', { projectId: created.id, id: item.id });
  const gone = await request('tools/call', {
    name: 'list_attachments',
    arguments: { projectId: created.id, nodeId: item.id },
  });
  assert.equal(gone.result.isError, true);
  assert.match(gone.result.content[0].text, /Item not found/);
  const leftovers = [];
  async function sweep(current) {
    const { readdir, stat } = await import('node:fs/promises');
    for (const entry of await readdir(current)) {
      const full = join(current, entry);
      if ((await stat(full)).isDirectory()) await sweep(full);
      else if (entry.endsWith('.pdf')) leftovers.push(full);
    }
  }
  await sweep(join(dir, 'attachments'));
  assert.deepEqual(leftovers, []);
  const workspace = await call('get_workspace', { projectId: created.id });
  assert.equal(workspace.nodes.length, 0);
});
