import test from 'node:test';
import assert from 'node:assert/strict';
import { createSearchIndex, parseSearchQuery } from '../src/search.js';
import { sampleWorkspace } from '../src/sample.js';

test('ranks title matches above body matches and supports prefixes', () => {
  const search = createSearchIndex(sampleWorkspace());
  const results = search.search('evidence trail');
  assert.ok(results.total >= 1);
  assert.match(results.results[0].title, /evidence/i);
  const prefix = search.search('evid');
  assert.ok(prefix.total >= 1);
});

test('filters by type, tag, status, evidence state, and dates', () => {
  const workspace = sampleWorkspace();
  const search = createSearchIndex(workspace);
  assert.ok(search.search('pilot type:claim').results.every((result) => result.type === 'claim'));
  const tagged = search.search('tag:pilot');
  assert.ok(tagged.total >= 3);
  assert.ok(tagged.results.every((result) => result.snippet !== undefined));
  const contested = search.search('is:contested');
  assert.ok(contested.results.some((result) => result.title.includes('slowing')));
  const gappy = {
    revision: 0,
    nodes: [
      {
        id: 'c1',
        type: 'claim',
        title: 'Lonely hypothesis',
        body: 'no sources yet',
        url: '',
        due: '',
        tags: [],
        status: 'open',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
      {
        id: 'd1',
        type: 'decision',
        title: 'Ungrounded choice',
        body: '',
        url: '',
        due: '',
        tags: [],
        status: 'proposed',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-03T00:00:00.000Z',
      },
    ],
    links: [],
  };
  const gaps = createSearchIndex(gappy).search('is:gap');
  assert.equal(gaps.total, 2);
  assert.equal(createSearchIndex(gappy).search('is:unverified').total, 1);
  const dated = search.search('after:2000-01-01');
  assert.equal(dated.total, workspace.nodes.length);
  assert.equal(search.search('before:2000-01-01').total, 0);
});

test('quoted phrases use AND semantics and empty query lists recent items', () => {
  const search = createSearchIndex(sampleWorkspace());
  const phrase = search.search('"project reviews"');
  assert.ok(
    phrase.results.every(
      (result) =>
        result.title.toLowerCase().includes('project reviews') ||
        result.snippet.toLowerCase().includes('project reviews'),
    ),
  );
  assert.equal(search.search('"no such phrase anywhere"').total, 0);
  const empty = search.search('   ');
  assert.equal(empty.total, sampleWorkspace().nodes.length);
  assert.ok(empty.results[0].score === 0);
});

test('rejects unknown filters, bad dates, and bad limits', () => {
  const search = createSearchIndex(sampleWorkspace());
  assert.throws(() => search.search('type:banana'), { status: 400 });
  assert.throws(() => search.search('is:maybe'), { status: 400 });
  assert.throws(() => search.search('before:yesterday'), { status: 400 });
  assert.throws(() => search.search('hello', { limit: 0 }), { status: 400 });
  assert.throws(() => search.search('hello', { limit: 500 }), { status: 400 });
  assert.throws(() => parseSearchQuery(null), { status: 400 });
});
