import test from 'node:test';
import assert from 'node:assert/strict';
import { parseItemsCsv, exportItemsCsv, CSV_TEMPLATE } from '../src/csv.js';
import { emptyWorkspace, planBatch } from '../src/core.js';

test('parses spreadsheet CSV with BOM, CRLF, quoted commas/newlines, tags, and default type', () => {
  const csv = '\ufefftitle,notes,url,tags\r\n"Interview, 01","line one\r\nline two",https://example.org,Research|Phase 1\r\nSecond,Short note,,\r\n';
  const rows = parseItemsCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].line, 4);
  assert.equal(rows[0].item.title, 'Interview, 01');
  assert.equal(rows[0].item.body, 'line one\r\nline two');
  assert.deepEqual(rows[0].item.tags, ['Research', 'Phase 1']);
  assert.equal(rows[1].item.type, 'source');
  assert.equal(planBatch(emptyWorkspace(), rows).add, 2);
});

test('preview skips repeated URL or title, but keeps different linked sources', () => {
  const rows = parseItemsCsv('type,title,url\nsource,One,https://example.org\nsource,Other,https://example.org/\nsource,One,https://elsewhere.org\nclaim,Reason,\nclaim,reason,');
  const plan = planBatch(emptyWorkspace(), rows);
  assert.equal(plan.add, 3);
  assert.equal(plan.skip, 2);
  assert.deepEqual(plan.entries.map(entry => entry.action), ['add', 'skip', 'add', 'add', 'skip']);
});

test('rejects unsupported columns, malformed records, invalid tags, and too many rows', () => {
  assert.throws(() => parseItemsCsv('bad\nvalue'), { status: 400 });
  assert.throws(() => parseItemsCsv('title,body,notes\na,b,c'), { status: 400 });
  assert.throws(() => parseItemsCsv('title,url\nA'), { status: 400 });
  assert.throws(() => parseItemsCsv('title\n"unterminated'), { status: 400 });
  assert.throws(() => parseItemsCsv('title\n' + 'A\n'.repeat(501)), { status: 400 });
  assert.throws(() => planBatch(emptyWorkspace(), parseItemsCsv('title,tags\nA,Same|same')), /Row 2: tags/);
});

test('citation columns round trip through CSV and appear in exports', () => {
  const rows = parseItemsCsv('type,title,doi,authors,year,venue\nsource,Paper,10.1234/example,"Last, First",2024,Journal of Tests');
  assert.deepEqual(rows[0].item.citation, { doi: '10.1234/example', authors: 'Last, First', year: '2024', venue: 'Journal of Tests' });
  assert.equal(planBatch(emptyWorkspace(), rows).add, 1);
  const workspace = { nodes: [{ type: 'source', title: 'Paper', body: '', url: '', status: '', due: '', tags: [], citation: rows[0].item.citation }] };
  const csv = exportItemsCsv(workspace);
  assert.match(csv, /10\.1234\/example/);
  assert.equal(parseItemsCsv(csv)[0].item.citation.doi, '10.1234/example');
});

test('CSV export quotes content and neutralizes spreadsheet formulas', () => {
  const workspace = { nodes: [{ type: 'source', title: '=2+2', body: '+COMMAND, "quoted"', url: 'https://example.org', status: '', due: '', tags: ['Research'] }] };
  const csv = exportItemsCsv(workspace);
  assert.match(csv, /"'\+COMMAND, ""quoted"""/);
  assert.equal(parseItemsCsv(csv)[0].item.title, "'=2+2");
  assert.equal(CSV_TEMPLATE.trim(), 'type,title,body,url,status,due,tags,doi,authors,year,venue');
});
