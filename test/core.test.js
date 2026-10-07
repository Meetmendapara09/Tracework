import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimHealth, createStore, decisionHealth, emptyWorkspace, exportMarkdown, validateWorkspace } from '../src/core.js';
import { sampleWorkspace } from '../src/sample.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tracework-core-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'nested', 'workspace.json');
  return { file, store: await createStore(file, emptyWorkspace()).init() };
}
function last(state, collection) { return state[collection].at(-1).id; }

test('fictional example is a valid, connected workspace', () => {
  const sample = sampleWorkspace();
  assert.equal(validateWorkspace(sample).links.length, 10);
  assert.equal(claimHealth(sample, 'c-friction').label, 'Contested');
  assert.equal(decisionHealth(sample, 'd-trail'), 'Evidence linked');
});

test('creates, updates, reloads, and cascades deleted connections', async t => {
  const { file, store } = await fixture(t);
  let state = await store.addNode(0, { type: 'source', title: '  Paper  ', url: 'https://example.org/study', body: 'notes' });
  assert.equal(state.nodes[0].title, 'Paper');
  const source = last(state, 'nodes');
  state = await store.addNode(state.revision, { type: 'claim', title: 'Hypothesis' });
  const claim = last(state, 'nodes');
  state = await store.addLink(state.revision, { from: source, to: claim, kind: 'supports' });
  assert.deepEqual(claimHealth(state, claim), { support: 1, challenge: 0, label: 'Supported' });
  state = await store.updateNode(state.revision, claim, { title: 'Revised hypothesis', status: 'reviewed' });
  assert.equal(state.nodes[1].status, 'reviewed');
  assert.equal((await createStore(file).init()).snapshot().revision, state.revision);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).links.length, 1);
  state = await store.deleteNode(state.revision, source);
  assert.equal(state.links.length, 0);
  assert.equal(claimHealth(state, claim).label, 'Unverified');
});

test('tags are validated, editable, and old backups migrate without losing data', async t => {
  const { file, store } = await fixture(t);
  let state = await store.addNode(0, { type: 'source', title: 'Tagged paper', tags: ['Methods', 'Phase 1'] });
  assert.deepEqual(state.nodes[0].tags, ['Methods', 'Phase 1']);
  await assert.rejects(store.updateNode(1, state.nodes[0].id, { tags: ['Methods', 'methods'] }), { status: 400 });
  state = await store.updateNode(1, state.nodes[0].id, { tags: ['Reviewed'] });
  assert.match(exportMarkdown(state), /Tags: Reviewed/);
  const legacy = structuredClone(state);
  for (const node of legacy.nodes) delete node.tags;
  state = await store.replace(state.revision, legacy);
  assert.deepEqual(state.nodes[0].tags, []);
  assert.deepEqual((await createStore(file).init()).snapshot().nodes[0].tags, []);
});

test('CSV batches are atomic and preserve existing links', async t => {
  const { store } = await fixture(t);
  const first = await store.addNode(0, { type: 'source', title: 'Existing', url: 'https://example.org' });
  const rows = [
    { line: 2, item: { type: 'source', title: 'Duplicate URL', url: 'https://example.org/' } },
    { line: 3, item: { type: 'claim', title: 'New claim', tags: ['Study'] } },
  ];
  let result = await store.importNodes(first.revision, rows);
  assert.deepEqual(result.report, { added: 1, skipped: 1 });
  assert.equal(result.workspace.nodes.length, 2);
  await assert.rejects(store.importNodes(result.workspace.revision, [...rows, { line: 4, item: { type: 'task', title: '' } }]), { status: 400 });
  assert.equal(store.snapshot().revision, result.workspace.revision);
  await assert.rejects(store.importNodes(first.revision, rows), { status: 409 });
});

test('serializes concurrent writes; rejects stale revisions without losing changes', async t => {
  const { store } = await fixture(t);
  const results = await Promise.allSettled([
    store.addNode(0, { type: 'task', title: 'First' }),
    store.addNode(0, { type: 'task', title: 'Second' }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected')[0].reason.status, 409);
  assert.equal(store.snapshot().nodes.length, 1);
  assert.equal(store.snapshot().revision, 1);
  await assert.rejects(store.addNode(0, { type: 'task', title: 'Stale' }), { status: 409 });
  assert.equal(store.snapshot().nodes.length, 1);
});

test('validates fields, URLs, dates, graph directions, and duplicate links', async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.addNode(0, { type: 'source', title: 'x', url: 'javascript:alert(1)' }), { status: 400 });
  await assert.rejects(store.addNode(0, { type: 'task', title: 'x', due: '2025-02-29' }), { status: 400 });
  await assert.rejects(store.addNode(0, { type: 'claim', title: 'x', unexpected: 1 }), { status: 400 });
  assert.equal(store.snapshot().revision, 0);
  let state = await store.addNode(0, { type: 'claim', title: 'A' });
  const claim = last(state, 'nodes');
  state = await store.addNode(state.revision, { type: 'source', title: 'B' });
  const source = last(state, 'nodes');
  await assert.rejects(store.addLink(state.revision, { from: claim, to: source, kind: 'supports' }), { status: 400 });
  state = await store.addLink(state.revision, { from: source, to: claim, kind: 'challenges' });
  assert.equal(claimHealth(state, claim).label, 'Contested');
  await assert.rejects(store.addLink(state.revision, { from: source, to: claim, kind: 'challenges' }), { status: 409 });
  await assert.rejects(store.updateNode(state.revision, claim, { url: 'https://example.com' }), { status: 400 });
});

test('import validates the entire backup atomically, including relationships', async t => {
  const { store } = await fixture(t);
  let state = await store.addNode(0, { type: 'source', title: 'Keep me' });
  const clean = structuredClone(state);
  const imported = await store.replace(state.revision, clean);
  assert.equal(imported.nodes[0].title, 'Keep me');
  const bad = structuredClone(clean);
  bad.links.push({ id: 'l1', from: bad.nodes[0].id, to: 'missing', kind: 'supports' });
  assert.throws(() => store.replace(imported.revision, bad), { status: 400 });
  assert.equal(store.snapshot().revision, imported.revision);
  bad.links = [];
  bad.nodes[0].url = 'file:///etc/passwd';
  assert.throws(() => store.replace(imported.revision, bad), { status: 400 });
  assert.equal(store.snapshot().nodes.length, 1);
  assert.deepEqual(validateWorkspace({ nodes: [], links: [] }), { nodes: [], links: [] });
});

test('decision readiness and Markdown brief expose evidence gaps and connections', async t => {
  const { store } = await fixture(t);
  let state = await store.addNode(0, { type: 'source', title: 'Interview' }); const source = last(state, 'nodes');
  state = await store.addNode(state.revision, { type: 'claim', title: 'Friction' }); const claim = last(state, 'nodes');
  state = await store.addNode(state.revision, { type: 'decision', title: 'Pilot' }); const decision = last(state, 'nodes');
  assert.equal(decisionHealth(state, decision), 'No claims linked');
  state = await store.addLink(state.revision, { from: claim, to: decision, kind: 'informs' });
  assert.equal(decisionHealth(state, decision), 'Evidence gap');
  state = await store.addLink(state.revision, { from: source, to: claim, kind: 'supports' });
  assert.equal(decisionHealth(state, decision), 'Evidence linked');
  state = await store.addLink(state.revision, { from: source, to: claim, kind: 'challenges' });
  assert.equal(decisionHealth(state, decision), 'Needs review');
  const markdown = exportMarkdown(state);
  assert.match(markdown, /Readiness: Needs review/);
  assert.match(markdown, /supports → Friction/);
  assert.match(markdown, /## Sources/);
});

test('Markdown titles are escaped and corrupt files fail closed', async t => {
  const { file, store } = await fixture(t);
  const state = await store.addNode(0, { type: 'source', title: '<script> *citation*' });
  assert.ok(exportMarkdown(state).includes('### \\<script\\> \\*citation\\*'));
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, '{broken');
  await assert.rejects(createStore(file).init(), SyntaxError);
});
