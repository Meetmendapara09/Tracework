import MiniSearch from 'minisearch';
import { AppError, TYPES, claimHealth, decisionHealth } from './core.js';

const MAX_QUERY = 300;
const MAX_LIMIT = 100;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FILTER_PATTERN = /^(type|tag|status|is|before|after):("[^"]+"|\S+)$/;
const PHRASE_PATTERN = /"([^"]+)"/g;

// Operators: type:<source|claim|decision|task> tag:<tag> status:<status>
// is:<unverified|contested|gap> before:<YYYY-MM-DD> after:<YYYY-MM-DD>
// plus quoted phrases (AND). Unknown filters are rejected, never broadened.
export function parseSearchQuery(input) {
  if (typeof input !== 'string') throw new AppError(400, 'Search query must be text');
  const query = input.trim().slice(0, MAX_QUERY);
  const phrases = [];
  const withoutPhrases = query.replace(PHRASE_PATTERN, (_, phrase) => {
    if (phrase.trim()) phrases.push(phrase.trim().toLowerCase());
    return ' ';
  });
  const filters = {
    types: new Set(),
    tags: new Set(),
    statuses: new Set(),
    states: new Set(),
    before: null,
    after: null,
  };
  const terms = [];
  for (const token of withoutPhrases.split(/\s+/).filter(Boolean)) {
    const match = token.match(FILTER_PATTERN);
    if (!match) {
      terms.push(token.toLowerCase());
      continue;
    }
    const key = match[1];
    const value = match[2].replace(/^"|"$/g, '').toLowerCase();
    if (!value) throw new AppError(400, `Empty ${key} filter`);
    if (key === 'type') {
      if (!TYPES.includes(value)) throw new AppError(400, `Unknown type filter: ${value}`);
      filters.types.add(value);
    } else if (key === 'tag') {
      filters.tags.add(value);
    } else if (key === 'status') {
      filters.statuses.add(value);
    } else if (key === 'is') {
      if (!['unverified', 'contested', 'gap'].includes(value)) throw new AppError(400, `Unknown is filter: ${value}`);
      filters.states.add(value);
    } else {
      if (!DATE_PATTERN.test(value)) throw new AppError(400, `Use YYYY-MM-DD for ${key} filter`);
      filters[key] = value;
    }
  }
  return { terms, phrases, filters };
}

function stateOf(workspace, node) {
  if (node.type === 'claim') {
    const health = claimHealth(workspace, node.id);
    if (health.challenge) return 'contested';
    if (!health.support) return 'unverified';
    return 'supported';
  }
  if (node.type === 'decision') {
    const label = decisionHealth(workspace, node.id);
    if (label === 'Evidence gap' || label === 'No claims linked') return 'gap';
    if (label === 'Needs review') return 'contested';
    return 'supported';
  }
  return null;
}
function matchesFilters(workspace, node, filters) {
  if (filters.types.size && !filters.types.has(node.type)) return false;
  if (filters.tags.size) {
    const tags = new Set((node.tags || []).map((tag) => tag.toLowerCase()));
    if (![...filters.tags].every((tag) => tags.has(tag))) return false;
  }
  if (filters.statuses.size && !filters.statuses.has((node.status || '').toLowerCase())) return false;
  if (filters.states.size) {
    const state = stateOf(workspace, node);
    const wantsGap = filters.states.has('gap') && (state === 'gap' || state === 'unverified');
    if (!filters.states.has(state) && !wantsGap) return false;
  }
  if (filters.before && !((node.updatedAt || '').slice(0, 10) < filters.before)) return false;
  if (filters.after && !((node.updatedAt || '').slice(0, 10) > filters.after)) return false;
  return true;
}
function matchesPhrases(node, phrases) {
  if (!phrases.length) return true;
  const haystack = `${node.title} ${node.body} ${(node.tags || []).join(' ')} ${node.url}`.toLowerCase();
  return phrases.every((phrase) => haystack.includes(phrase));
}
function snippetFor(node, terms) {
  const text = node.body || node.title;
  if (!terms.length) return text.slice(0, 160);
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term.replace(/[~^]/g, ''));
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) return text.slice(0, 160);
  const start = Math.max(0, at - 60);
  return (start > 0 ? '...' : '') + text.slice(start, start + 160) + (start + 160 < text.length ? '...' : '');
}

// Prefix + fuzzy full-text ranking over title/body/tags/url/citation,
// then evidence-state and metadata filters. Empty query lists recent items.
export function createSearchIndex(workspace) {
  const nodes = workspace.nodes;
  const index = new MiniSearch({
    fields: ['title', 'body', 'tags', 'url', 'citation'],
    storeFields: ['id'],
    searchOptions: { prefix: true, fuzzy: 0.2, combineWith: 'AND' },
  });
  const documents = new Map();
  for (const node of nodes) {
    const citation = node.citation || {};
    const doc = {
      id: node.id,
      title: node.title,
      body: node.body,
      tags: (node.tags || []).join(' '),
      url: node.url,
      citation: [citation.doi, citation.authors, citation.year, citation.venue].filter(Boolean).join(' '),
    };
    documents.set(node.id, node);
    index.add(doc);
  }
  return {
    search(rawQuery, { limit = 50 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT)
        throw new AppError(400, `Limit must be 1-${MAX_LIMIT}`);
      const { terms, phrases, filters } = parseSearchQuery(rawQuery);
      let ranked;
      if (!terms.length) {
        ranked = [...nodes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((node) => ({ node, score: 0 }));
      } else {
        const hits = new Map();
        for (const result of index.search(terms.join(' '))) {
          const node = documents.get(result.id);
          if (node) hits.set(node.id, { node, score: result.score });
        }
        ranked = [...hits.values()].sort((a, b) => b.score - a.score);
      }
      const results = [];
      for (const { node, score } of ranked) {
        if (!matchesPhrases(node, phrases)) continue;
        if (!matchesFilters(workspace, node, filters)) continue;
        results.push({
          id: node.id,
          type: node.type,
          title: node.title,
          snippet: snippetFor(node, terms),
          score: Math.round(score * 1000) / 1000,
          tags: node.tags || [],
        });
        if (results.length >= limit) break;
      }
      return { total: results.length, results };
    },
  };
}
