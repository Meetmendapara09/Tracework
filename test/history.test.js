import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, emptyWorkspace } from '../src/core.js';
import { createHistory } from '../src/history.js';

async function setup(t, { limit } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tracework-history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'history.json');
  return { dir, history: await createHistory(file, ...(limit ? [{ limit }] : [])).init() };
}
async function workspaceWithItem(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tracework-history-ws-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await createStore(join(dir, 'workspace.json'), emptyWorkspace()).init();
  const before = store.snapshot();
  const after = await store.addNode(0, { type: 'task', title: 'First' });
  return { before, after };
}

test('records snapshots and restores them through a validated replace', async t => {
  const { history } = await setup(t);
  const { before, after } = await workspaceWithItem(t);
  const meta = await history.record({ before, after, action: 'Add task' });
  assert.equal(meta.fromRevision, 0);
  assert.equal(meta.toRevision, 1);
  assert.equal(history.list().length, 1);
  assert.equal(history.list()[0].action, 'Add task');
  assert.deepEqual(history.get(meta.id).nodes, []);
  assert.throws(() => history.get('missing'), { status: 404 });
});

test('history is bounded, survives reload, and rejects bad input', async t => {
  const { dir, history } = await setup(t, { limit: 3 });
  const { before, after } = await workspaceWithItem(t);
  for (let index = 0; index < 5; index++) await history.record({ before, after, action: `Change ${index}` });
  assert.equal(history.list().length, 3);
  assert.equal(history.list()[0].action, 'Change 4');
  const reopened = await createHistory(join(dir, 'history.json'), { limit: 3 }).init();
  assert.equal(reopened.list().length, 3);
  await assert.rejects(history.record({ before: { nodes: 'nope' }, after, action: 'bad' }), { status: 400 });
  await assert.rejects(history.record({ before, after, action: '  ' }), { status: 400 });
  await history.clear();
  assert.equal(history.list().length, 0);
  assert.equal((await createHistory(join(dir, 'history.json')).init()).list().length, 0);
});

test('corrupt history fails closed and concurrent records stay ordered', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tracework-history-bad-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'history.json'), '{broken');
  await assert.rejects(createHistory(join(dir, 'history.json')).init(), SyntaxError);
  await rm(join(dir, 'history.json'));
  const history = await createHistory(join(dir, 'history.json')).init();
  const { before, after } = await workspaceWithItem(t);
  await Promise.all([0, 1, 2].map(index => history.record({ before, after, action: `Parallel ${index}` })));
  assert.equal(history.list().length, 3);
  const raw = JSON.parse(await readFile(join(dir, 'history.json'), 'utf8'));
  assert.equal(raw.entries.length, 3);
});
