import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { AppError, MAX_IMPORT_ROWS } from './core.js';

export const CSV_COLUMNS = ['type', 'title', 'body', 'url', 'status', 'due', 'tags', 'doi', 'authors', 'year', 'venue'];
const allowed = new Set([...CSV_COLUMNS, 'notes']);
const MAX_CSV_BYTES = 8 * 1024 * 1024;

// A real CSV parser matters here: quoted newlines, commas, BOMs and CRLFs
// are common in exports from spreadsheets and reference managers.
export function parseItemsCsv(csv) {
  if (typeof csv !== 'string' || Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES) throw new AppError(400, 'CSV must be text under 8 MB');
  let records;
  let count = 0;
  try {
    records = parse(csv, {
      bom: true, skip_empty_lines: true, info: true, max_record_size: 20000,
      on_record(record) {
        if (++count > MAX_IMPORT_ROWS + 1) throw new AppError(400, `Import at most ${MAX_IMPORT_ROWS} rows at a time`);
        return record;
      },
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, `Invalid CSV: ${error.message}`);
  }
  if (!records.length) throw new AppError(400, 'CSV needs a header row and at least one item');
  if (records.length - 1 > MAX_IMPORT_ROWS) throw new AppError(400, `Import at most ${MAX_IMPORT_ROWS} rows at a time`);
  const headers = records[0].record.map(value => value.trim().toLowerCase());
  if (!headers.includes('title') || headers.some(header => !allowed.has(header)) || new Set(headers).size !== headers.length || (headers.includes('body') && headers.includes('notes'))) {
    throw new AppError(400, 'CSV needs a title column and unique, supported headers: type,title,body,url,status,due,tags,doi,authors,year,venue (notes can replace body)');
  }
  if (records.length === 1) throw new AppError(400, 'CSV has no items');
  return records.slice(1).map(({ record, info }) => {
    if (record.length !== headers.length) throw new AppError(400, `Line ${info.lines}: expected ${headers.length} columns, got ${record.length}`);
    const values = Object.fromEntries(headers.map((key, index) => [key, record[index].trim()]));
    const type = (values.type || 'source').toLowerCase();
    const item = { type, title: values.title, body: values.body ?? values.notes ?? '' };
    if (values.url) item.url = values.url;
    if (values.status) item.status = values.status.toLowerCase();
    if (values.due) item.due = values.due;
    if (values.tags) item.tags = values.tags.split('|').map(tag => tag.trim());
    const citation = {};
    if (values.doi) citation.doi = values.doi;
    if (values.authors) citation.authors = values.authors;
    if (values.year) citation.year = values.year;
    if (values.venue) citation.venue = values.venue;
    if (Object.keys(citation).length) item.citation = citation;
    return { line: info.lines, item };
  });
}

// Prefix spreadsheet formulas to prevent execution when a CSV is opened in
// Excel or Sheets. CSV is intentionally a lossy interchange, not a backup.
function safeCell(value) {
  const text = String(value ?? '');
  return /^[\s]*[=+@\-\t\r]/.test(text) ? `'${text}` : text;
}
export function exportItemsCsv(workspace) {
  return stringify([
    CSV_COLUMNS,
    ...workspace.nodes.map(node => [node.type, node.title, node.body, node.url, node.status, node.due, (node.tags || []).join('|'), node.citation?.doi || '', node.citation?.authors || '', node.citation?.year || '', node.citation?.venue || ''].map(safeCell)),
  ], { bom: true });
}
export const CSV_TEMPLATE = stringify([CSV_COLUMNS]);
