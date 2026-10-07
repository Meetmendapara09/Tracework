import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { sampleWorkspace } from '../src/sample.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('browser UI renders safely, filters tags, maps evidence, and previews CSV before import', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:3000/' });
  const { window } = dom;
  window.scrollTo = () => {};
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.FormData = window.FormData;
  globalThis.confirm = () => true;
  const originalFetch = globalThis.fetch;
  let workspace = sampleWorkspace();
  const requests = [];
  globalThis.fetch = async (path, options = {}) => {
    requests.push({ path, options });
    let body;
    if (path === '/api/workspace') body = workspace;
    else if (path === '/api/import/preview') body = { revision: workspace.revision, add: 1, skip: 1, entries: [{ line: 2, title: '<script>not markup</script>', type: 'source', action: 'add' }] };
    else if (path === '/api/import/csv') {
      workspace = { ...workspace, revision: workspace.revision + 1 };
      body = { workspace, report: { added: 1, skipped: 1 } };
    } else throw new Error(`Unexpected request ${path}`);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const click = selector => window.document.querySelector(selector).click();
  try {
    await import('../public/app.js');
    assert.equal(window.document.querySelector('[data-count="all"]').textContent, '11');
    assert.ok(window.document.querySelector('#tag-filter option[value="pilot"]'));
    const tagFilter = window.document.querySelector('#tag-filter');
    tagFilter.value = 'pilot';
    tagFilter.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.match(window.document.querySelector('#result-count').textContent, /3 items/);
    tagFilter.value = '';
    tagFilter.dispatchEvent(new window.Event('change', { bubbles: true }));
    click('[data-view="matrix"]');
    assert.match(window.document.querySelector('#board').textContent, /Supports/);
    assert.ok(window.document.querySelector('.matrix-cell.challenge'));
    click('.matrix-cell.challenge');
    assert.match(window.document.querySelector('#inspector').textContent, /CONNECTIONS/);
    click('#csv-button');
    assert.ok(window.document.querySelector('#csv-dialog').open);
    const textarea = window.document.querySelector('#csv-text');
    textarea.value = 'title\nA new source';
    textarea.dispatchEvent(new window.Event('input'));
    assert.ok(window.document.querySelector('#commit-csv').disabled);
    click('#preview-csv');
    await tick();
    assert.equal(window.document.querySelector('#commit-csv').disabled, false);
    assert.equal(window.document.querySelector('#csv-preview script'), null);
    assert.match(window.document.querySelector('#csv-preview').textContent, /<script>not markup<\/script>/);
    click('#commit-csv');
    await tick();
    assert.equal(window.document.querySelector('#csv-dialog').open, false);
    assert.equal(requests.find(request => request.path === '/api/import/csv').options.headers['If-Match'], '0');
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.FormData;
    delete globalThis.confirm;
    dom.window.close();
  }
});
