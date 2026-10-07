const $ = (selector) => document.querySelector(selector);
const TYPES = ['source', 'claim', 'decision', 'task'];
const META = {
  source: { plural: 'Sources', label: 'SOURCE', icon: '◧', hint: 'What did you observe?' },
  claim: { plural: 'Claims', label: 'CLAIM', icon: '◇', hint: 'What does it suggest?' },
  decision: { plural: 'Decisions', label: 'DECISION', icon: '◈', hint: 'What will you do?' },
  task: { plural: 'Tasks', label: 'TASK', icon: '☑', hint: 'What happens next?' },
};
const RULES = {
  supports: ['source', 'claim'],
  challenges: ['source', 'claim'],
  informs: ['claim', 'decision'],
  advances: ['decision', 'task'],
};
const STATUSES = {
  source: [],
  claim: ['open', 'reviewed'],
  decision: ['proposed', 'accepted', 'rejected'],
  task: ['todo', 'doing', 'done'],
};
let workspace = { revision: 0, nodes: [], links: [] };
let projectId = 'default';
let projectsCache = [];
let view = 'all';
let selected = null;
let editing = null;
let toastTimer;
let previewedCsv = null;
const escapeHTML = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
const byId = (id) => workspace.nodes.find((node) => node.id === id);
const related = (id) => workspace.links.filter((link) => link.from === id || link.to === id);
const statusLabel = (status) =>
  ({
    todo: 'To do',
    doing: 'In progress',
    done: 'Done',
    open: 'Open',
    reviewed: 'Reviewed',
    proposed: 'Proposed',
    accepted: 'Accepted',
    rejected: 'Rejected',
  })[status] || status;
function claimHealth(id) {
  const links = workspace.links.filter((link) => link.to === id);
  const supports = links.filter((link) => link.kind === 'supports').length;
  const challenges = links.filter((link) => link.kind === 'challenges').length;
  return {
    supports,
    challenges,
    label: challenges ? 'Contested' : supports ? 'Supported' : 'Unverified',
    tone: challenges ? 'warning' : supports ? 'good' : 'muted',
  };
}
function decisionHealth(id) {
  const claims = workspace.links.filter((link) => link.to === id && link.kind === 'informs').map((link) => link.from);
  if (!claims.length) return { label: 'No claims linked', tone: 'muted' };
  if (claims.some((id) => claimHealth(id).challenges)) return { label: 'Needs review', tone: 'warning' };
  if (claims.some((id) => !claimHealth(id).supports)) return { label: 'Evidence gap', tone: 'warning' };
  return { label: 'Evidence linked', tone: 'good' };
}
function needsReview(node) {
  return node.type === 'claim'
    ? !claimHealth(node.id).supports || !!claimHealth(node.id).challenges
    : node.type === 'decision' && decisionHealth(node.id).label !== 'Evidence linked';
}
function health(node) {
  if (node.type === 'claim') return claimHealth(node.id);
  if (node.type === 'decision') return decisionHealth(node.id);
  if (node.type === 'task') return { label: statusLabel(node.status), tone: node.status === 'done' ? 'good' : 'muted' };
  return {
    label: related(node.id).length ? `${related(node.id).length} connections` : 'Not connected',
    tone: related(node.id).length ? 'good' : 'muted',
  };
}
function toast(message, error = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast visible ${error ? 'error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 4400);
}
async function api(path, method = 'GET', body) {
  const scoped =
    projectId === 'default' ? path : `${path}${path.includes('?') ? '&' : '?'}project=${encodeURIComponent(projectId)}`;
  const response = await fetch(scoped, {
    method,
    headers: {
      ...(method !== 'GET' ? { 'If-Match': String(workspace.revision) } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 409 && result.error?.startsWith('Workspace changed')) {
      workspace = await api('/api/workspace');
      render();
      throw new Error('The workspace changed in another tab. Latest changes loaded; please try again.');
    }
    throw new Error(result.error || 'Something went wrong');
  }
  return result;
}
async function change(path, method, body, message) {
  let saved = false;
  try {
    $('#sync-state').textContent = 'Saving…';
    workspace = await api(path, method, body);
    saved = true;
    render();
    toast(message);
  } catch (error) {
    toast(error.message, true);
  } finally {
    $('#sync-state').innerHTML = saved
      ? `<span class="sync-dot"></span> Saved · ${escapeHTML(message)} · ${new Date().toLocaleTimeString()}`
      : 'Not saved - retry';
  }
  return saved;
}
function downloadHref(path) {
  return projectId === 'default' ? path : `${path}?project=${encodeURIComponent(projectId)}`;
}
function refreshExportLinks() {
  const map = { 'export-md': '/api/export.md', 'export-json': '/api/export.json', 'export-csv': '/api/export.csv' };
  for (const [id, path] of Object.entries(map)) {
    const anchor = document.getElementById(id);
    if (anchor) anchor.href = downloadHref(path);
  }
  const template = document.querySelector('.csv-help a');
  if (template) template.href = '/api/template.csv';
}
function renderMetrics() {
  const claims = workspace.nodes.filter((n) => n.type === 'claim');
  const decisions = workspace.nodes.filter((n) => n.type === 'decision');
  const tasks = workspace.nodes.filter((n) => n.type === 'task');
  const gaps = claims.filter((n) => !claimHealth(n.id).supports).length;
  const contested = claims.filter((n) => claimHealth(n.id).challenges).length;
  const cards = [
    {
      number: workspace.nodes.length,
      label: 'Items in the trail',
      detail: `${workspace.links.length} connections made`,
      icon: '✳',
      style: 'ink',
    },
    {
      number: gaps,
      label: 'Evidence gaps',
      detail: 'Claims without support',
      icon: '◇',
      style: gaps ? 'amber' : 'green',
    },
    {
      number: contested,
      label: 'Points of tension',
      detail: 'Claims with counterevidence',
      icon: '◐',
      style: contested ? 'rose' : 'green',
    },
    {
      number: `${tasks.filter((n) => n.status === 'done').length}/${tasks.length}`,
      label: 'Actions completed',
      detail: `${decisions.length} decisions on record`,
      icon: '↗',
      style: 'green',
    },
  ];
  $('#metrics').innerHTML = cards
    .map(
      (card) =>
        `<article class="metric metric-${card.style}"><div class="metric-top"><span>${escapeHTML(card.label)}</span><span class="metric-icon">${card.icon}</span></div><strong>${card.number}</strong><small>${escapeHTML(card.detail)}</small></article>`,
    )
    .join('');
  for (const type of ['all', ...TYPES, 'review']) {
    const el = document.querySelector(`[data-count="${type}"]`);
    el.textContent =
      type === 'all'
        ? workspace.nodes.length
        : workspace.nodes.filter((node) => (type === 'review' ? needsReview(node) : node.type === type)).length;
  }
  const filter = $('#tag-filter');
  const previous = filter.value;
  const tags = new Map();
  for (const tag of workspace.nodes.flatMap((node) => node.tags || []))
    if (!tags.has(tag.toLocaleLowerCase())) tags.set(tag.toLocaleLowerCase(), tag);
  filter.innerHTML =
    '<option value="">All tags</option>' +
    [...tags]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([value, label]) => `<option value="${escapeHTML(value)}">${escapeHTML(label)}</option>`)
      .join('');
  filter.value = tags.has(previous) ? previous : '';
  const tagOptions = $('#tag-options');
  if (tagOptions)
    tagOptions.innerHTML = [...tags]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([, label]) => `<option value="${escapeHTML(label)}">`)
      .join('');
}
function tagChips(tags) {
  return tags?.length
    ? `<span class="tag-list">${tags.map((tag) => `<span class="tag-chip">${escapeHTML(tag)}</span>`).join('')}</span>`
    : '';
}
function stamp(value) {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return '';
  return new Date(time).toLocaleString();
}
function stampsLine(node) {
  const created = stamp(node.createdAt);
  const updated = stamp(node.updatedAt);
  if (!created && !updated) return '';
  return `<div class="detail-stamps"><span>Created ${escapeHTML(created)}</span><span>Updated ${escapeHTML(updated)}</span></div>`;
}
function dueLine(node) {
  if (node.type !== 'task' || !node.due) return '';
  const today = new Date().toLocaleDateString('en-CA');
  const overdue = node.status !== 'done' && node.due < today;
  return `<span class="card-due${overdue ? ' overdue' : ''}">${overdue ? 'Overdue ' : 'Due '}${escapeHTML(node.due)}</span>`;
}
function tickClock() {
  if (typeof document === 'undefined') return;
  const el = $('#clock');
  if (!el) return;
  const now = new Date();
  el.textContent = `${now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${now.toLocaleTimeString()}`;
  el.title = `Current local time: ${now.toLocaleString()}`;
}
function card(node) {
  const badge = health(node);
  const snippet =
    node.body || (node.type === 'source' ? node.url : 'Add notes to capture the context behind this item.');
  return `<button class="item-card ${selected === node.id ? 'selected' : ''}" data-open="${escapeHTML(node.id)}" aria-label="Open ${escapeHTML(node.type)}: ${escapeHTML(node.title)}"><span class="card-top"><span class="card-id">${META[node.type].icon} &nbsp; ${META[node.type].label}</span><span class="card-arrow" aria-hidden="true">↗</span></span><strong>${escapeHTML(node.title)}</strong><span class="card-snippet">${escapeHTML(snippet)}</span>${dueLine(node)}${tagChips(node.tags)}<span class="card-foot"><span class="badge ${badge.tone}"><span class="badge-dot"></span>${escapeHTML(badge.label)}</span><span class="connection-count" title="Connections">⌁ ${related(node.id).length}</span></span></button>`;
}
function renderMatrix(query, tag, sort) {
  const claims = workspace.nodes.filter(
    (node) =>
      node.type === 'claim' &&
      (!tag || (node.tags || []).some((value) => value.toLocaleLowerCase() === tag)) &&
      (!query || `${node.title} ${node.body} ${(node.tags || []).join(' ')}`.toLowerCase().includes(query)),
  );
  claims.sort((a, b) =>
    sort === 'title'
      ? a.title.localeCompare(b.title)
      : sort === 'oldest'
        ? a.createdAt.localeCompare(b.createdAt)
        : b.updatedAt.localeCompare(a.updatedAt),
  );
  const visible = claims.slice(0, 50);
  const ids = new Set(visible.map((node) => node.id));
  const relevance = new Map();
  const edge = new Map();
  for (const link of workspace.links) {
    if (!['supports', 'challenges'].includes(link.kind)) continue;
    if (ids.has(link.to)) relevance.set(link.from, (relevance.get(link.from) || 0) + 1);
    const key = `${link.to}:${link.from}`;
    if (!edge.has(key)) edge.set(key, new Set());
    edge.get(key).add(link.kind);
  }
  const sources = workspace.nodes.filter((node) => node.type === 'source');
  sources.sort((a, b) => (relevance.get(b.id) || 0) - (relevance.get(a.id) || 0) || a.title.localeCompare(b.title));
  const shown = sources.slice(0, 24);
  $('#result-count').textContent = `${claims.length} claim${claims.length === 1 ? '' : 's'}`;
  $('#board-title').firstChild.textContent = 'Map the evidence ';
  $('#board').classList.remove('single-view', 'review-view');
  $('#board').classList.add('matrix-view');
  if (!claims.length) {
    $('#board').innerHTML =
      '<div class="empty-state"><div class="empty-art">◇</div><h3>No claims to map yet.</h3><p>Add a claim, or adjust your search and tag filter.</p><button class="primary-button" data-add="claim" title="Add a claim to map">＋ Add a claim</button></div>';
    return;
  }
  const rows = visible
    .map(
      (claim) =>
        `<tr><th scope="row"><button data-open="${escapeHTML(claim.id)}">${escapeHTML(claim.title)}</button><small>${escapeHTML(claimHealth(claim.id).label)}</small></th>${
          shown
            .map((source) => {
              const kinds = edge.get(`${claim.id}:${source.id}`);
              if (!kinds) return '<td><span class="matrix-empty" aria-label="Not connected">·</span></td>';
              const tone = kinds.size === 2 ? 'mixed' : kinds.has('challenges') ? 'challenge' : 'support';
              const label =
                kinds.size === 2 ? 'Supports and challenges' : kinds.has('challenges') ? 'Challenges' : 'Supports';
              return `<td><button class="matrix-cell ${tone}" data-open="${escapeHTML(source.id)}" title="${label}: ${escapeHTML(source.title)}" aria-label="${label} ${escapeHTML(claim.title)}: ${escapeHTML(source.title)}">${kinds.size === 2 ? '±' : kinds.has('challenges') ? '−' : '+'}</button></td>`;
            })
            .join('') || '<td class="matrix-no-source">Add a source to start mapping evidence.</td>'
        }</tr>`,
    )
    .join('');
  $('#board').innerHTML =
    `<div class="matrix-panel"><div class="matrix-intro"><strong>${visible.filter((node) => claimHealth(node.id).supports).length}/${visible.length} claims have support</strong><span><i class="matrix-key support">+</i> Supports <i class="matrix-key challenge">−</i> Challenges <i class="matrix-key mixed">±</i> Both</span></div><div class="matrix-scroll"><table><thead><tr><th scope="col">CLAIM ↓ &nbsp; / &nbsp; SOURCE →</th>${shown.map((source) => `<th scope="col"><button data-open="${escapeHTML(source.id)}" title="${escapeHTML(source.title)}">${escapeHTML(source.title)}</button></th>`).join('') || '<th scope="col">SOURCES</th>'}</tr></thead><tbody>${rows}</tbody></table></div>${claims.length > 50 || sources.length > 24 ? `<p class="matrix-limit">Showing ${visible.length} of ${claims.length} claims and ${shown.length} of ${sources.length} sources. Search or filter to narrow claims; the most connected sources appear first. Indicators always use the full evidence trail.</p>` : '<p class="matrix-limit">Select a claim, source, or connection to explore its context. Indicators use the full evidence trail.</p>'}</div>`;
}
let searchTimer = null;
let searchSeq = 0;
async function renderSearchResults(query, tag) {
  const run = ++searchSeq;
  $('#board').classList.remove('single-view', 'review-view', 'matrix-view');
  $('#board-title').firstChild.textContent = 'Search every project ';
  $('#result-count').textContent = 'searching…';
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(query)}&project=*&limit=50`);
    if (run !== searchSeq) return;
    const results = tag
      ? data.results.filter((hit) => (hit.tags || []).some((value) => value.toLocaleLowerCase() === tag))
      : data.results;
    $('#result-count').textContent = `${results.length} result${results.length === 1 ? '' : 's'}`;
    $('#board').innerHTML = results.length
      ? `<div class="search-results">${results
          .map(
            (hit) =>
              `<button class="item-card search-hit" data-open="${escapeHTML(hit.id)}" data-open-project="${escapeHTML(hit.projectId)}" title="Open ${escapeHTML(hit.title)} in ${escapeHTML(hit.projectName)}"><span class="card-top"><span class="card-id">${META[hit.type].icon} &nbsp; ${META[hit.type].label}</span><span class="card-arrow" aria-hidden="true">↗</span></span><strong>${escapeHTML(hit.title)}</strong><span class="card-snippet">${escapeHTML(hit.snippet)}</span><span class="card-foot"><span class="badge muted"><span class="badge-dot"></span>${escapeHTML(hit.projectName)}</span></span></button>`,
          )
          .join('')}</div>`
      : '<div class="empty-state"><div class="empty-art">⌕</div><span class="section-kicker">NO MATCHES</span><h3>Nothing found anywhere.</h3><p>Try fewer words, another tag, or operators like type:, tag:, and is:.</p></div>';
  } catch (error) {
    if (run !== searchSeq) return;
    $('#result-count').textContent = '';
    $('#board').innerHTML =
      `<div class="empty-state"><div class="empty-art">⌕</div><h3>Search failed.</h3><p>${escapeHTML(error.message)}</p></div>`;
  }
}
function renderBoard() {
  const rawQuery = $('#search').value.trim();
  const query = rawQuery.toLowerCase();
  const tag = $('#tag-filter').value;
  const sort = $('#sort').value;
  if (rawQuery) {
    renderSearchResults(rawQuery, tag);
    return;
  }
  if (view === 'matrix') {
    renderMatrix(query, tag, sort);
    return;
  }
  $('#board').classList.remove('matrix-view');
  const matches = (node) =>
    (view === 'all' || (view === 'review' ? needsReview(node) : node.type === view)) &&
    (!tag || (node.tags || []).some((value) => value.toLocaleLowerCase() === tag)) &&
    (!query ||
      `${node.title} ${node.body} ${node.url} ${node.status} ${(node.tags || []).join(' ')}`
        .toLowerCase()
        .includes(query));
  const filtered = workspace.nodes.filter(matches);
  $('#result-count').textContent = `${filtered.length} item${filtered.length === 1 ? '' : 's'}`;
  $('#board-title').firstChild.textContent =
    view === 'all'
      ? 'Your work, connected '
      : view === 'review'
        ? 'Questions worth revisiting '
        : `${META[view].plural}, in context `;
  const sorted = (nodes) =>
    [...nodes].sort((a, b) =>
      sort === 'title'
        ? a.title.localeCompare(b.title)
        : sort === 'oldest'
          ? a.createdAt.localeCompare(b.createdAt)
          : b.updatedAt.localeCompare(a.updatedAt),
    );
  $('#board').classList.toggle('single-view', view !== 'all' && view !== 'review');
  $('#board').classList.toggle('review-view', view === 'review');
  $('#board').innerHTML = filtered.length
    ? TYPES.filter(
        (type) => view === 'all' || (view === 'review' && ['claim', 'decision'].includes(type)) || type === view,
      )
        .map((type) => {
          const nodes = sorted(filtered.filter((node) => node.type === type));
          return `<div class="lane lane-${type}"><div class="lane-head"><div><span class="lane-icon">${META[type].icon}</span><span class="lane-name">${META[type].plural}</span></div><span class="lane-total">${nodes.length.toString().padStart(2, '0')}</span></div><p class="lane-hint">${META[type].hint}</p><div class="lane-cards">${nodes.map(card).join('') || '<p class="lane-empty">Nothing here yet.</p>'}</div><button class="lane-add" data-add="${type}" title="Add a ${type} to this lane"><span>＋</span> Add ${type}</button></div>`;
        })
        .join('')
    : `<div class="empty-state"><div class="empty-art">✳</div><span class="section-kicker">${view === 'review' ? 'ALL CAUGHT UP' : 'A GOOD PLACE TO BEGIN'}</span><h3>${query ? 'No matching items.' : view === 'review' ? 'Nothing needs review.' : 'Every trail starts somewhere.'}</h3><p>${query ? 'Try a different search, or switch views.' : view === 'review' ? 'Every decision has linked evidence and every claim has support without counterevidence. Keep questioning as you go.' : 'Add a source, or load a fictional example to explore how the pieces fit together.'}</p>${!query && view !== 'review' ? `<div class="empty-actions"><button class="primary-button" data-add="${view === 'all' ? 'source' : view}">＋ Add ${view === 'all' ? 'a source' : 'an item'}</button>${!workspace.nodes.length ? '<button class="secondary-button" id="load-sample" title="Load a fictional example workspace">Explore an example</button>' : ''}</div>` : ''}</div>`;
}
function optionsFor(node) {
  const choices = [];
  for (const [kind, [fromType, toType]] of Object.entries(RULES)) {
    if (node.type !== fromType && node.type !== toType) continue;
    for (const other of workspace.nodes.filter((n) => n.type === (node.type === fromType ? toType : fromType))) {
      const from = node.type === fromType ? node.id : other.id;
      const to = node.type === fromType ? other.id : node.id;
      if (workspace.links.some((l) => l.from === from && l.to === to && l.kind === kind)) continue;
      choices.push({ kind, from, to, other });
    }
  }
  return choices;
}
function citationBlock(node) {
  if (node.type !== 'source') return '';
  const citation = node.citation || {};
  const rows = [];
  if (citation.doi)
    rows.push(
      `<p class="citation-line">DOI: <a class="source-url" href="https://doi.org/${escapeHTML(citation.doi)}" target="_blank" rel="noopener noreferrer">${escapeHTML(citation.doi)} ↗</a></p>`,
    );
  if (citation.authors) rows.push(`<p class="citation-line">By ${escapeHTML(citation.authors)}</p>`);
  if (citation.year || citation.venue)
    rows.push(
      `<p class="citation-line">${escapeHTML([citation.venue, citation.year].filter(Boolean).join(' · '))}</p>`,
    );
  return rows.length ? `<div class="citation-block">${rows.join('')}</div>` : '';
}
async function loadAttachments(nodeId) {
  const list = $('#attachment-list');
  if (!list) return;
  try {
    const data = await api(`/api/nodes/${encodeURIComponent(nodeId)}/attachments`);
    if (!list.isConnected || byId(selected)?.id !== nodeId) return;
    list.innerHTML = data.attachments.length
      ? data.attachments
          .map(
            (entry) =>
              `<div class="link-row"><a class="attachment-link" href="${downloadHref(`/api/nodes/${encodeURIComponent(nodeId)}/attachments/${encodeURIComponent(entry.id)}`)}" target="_blank" rel="noopener noreferrer" title="Open ${escapeHTML(entry.filename)}"><span class="link-direction">PDF</span><span class="link-text"><small>${escapeHTML(entry.size)} bytes · ${escapeHTML(entry.createdAt.slice(0, 10))}</small><strong>${escapeHTML(entry.filename)}</strong></span></a><button class="remove-link" data-remove-attachment="${escapeHTML(entry.id)}" aria-label="Remove ${escapeHTML(entry.filename)}">×</button></div>`,
          )
          .join('')
      : '<p class="detail-muted">No PDFs attached yet.</p>';
  } catch (error) {
    if (list.isConnected) list.innerHTML = `<p class="detail-muted">${escapeHTML(error.message)}</p>`;
  }
}
function renderInspector() {
  const panel = $('#inspector');
  const node = byId(selected);
  if (!node) {
    selected = null;
    panel.innerHTML =
      '<div class="inspector-placeholder"><div class="placeholder-art" aria-hidden="true">✳</div><span class="section-kicker">FOLLOW THE THREAD</span><h2>Every idea has<br>a history.</h2><p>Select a card to explore its context, connect it to other work, and see the evidence behind it.</p><div class="placeholder-keys"><kbd> N </kbd> new item <span>·</span> <kbd> / </kbd> search</div></div>';
    return;
  }
  const links = related(node.id);
  const badge = health(node);
  const choices = optionsFor(node);
  panel.innerHTML = `<div class="inspector-body"><div class="inspector-top"><span class="section-kicker">ITEM DETAILS / ${META[node.type].label}</span><button class="icon-button" data-close-inspector aria-label="Close details" title="Close details">✕</button></div><div class="detail-type detail-${node.type}"><span>${META[node.type].icon}</span> ${META[node.type].label}</div><h2>${escapeHTML(node.title)}</h2><div class="detail-meta"><span class="badge ${badge.tone}"><span class="badge-dot"></span>${escapeHTML(badge.label)}</span>${node.status ? `<span class="meta-status">${escapeHTML(statusLabel(node.status))}</span>` : ''}</div>${stampsLine(node)}${tagChips(node.tags)}<div class="detail-section"><div class="detail-label">CONTEXT</div><p class="detail-body">${escapeHTML(node.body || 'No notes yet. Add context to make this item more useful to your future self.')}</p>${node.url ? `<a class="source-url" href="${escapeHTML(node.url)}" target="_blank" rel="noopener noreferrer">Open source ↗</a>` : ''}${node.due ? `<p class="due-date">Due ${escapeHTML(node.due)}</p>` : ''}${citationBlock(node)}</div>${node.type === 'source' ? '<div class="detail-section"><div class="detail-label">PDF ATTACHMENTS</div><div id="attachment-list"><p class="detail-muted">Loading…</p></div><form id="attachment-form"><label class="attachment-upload"><span class="sr-only">Choose a PDF to attach</span><input type="file" id="attachment-file" accept="application/pdf,.pdf"></label><button class="secondary-button" type="submit" title="Attach this PDF to the source">Upload PDF</button></form><p class="detail-muted">PDFs only, up to 15 MiB. Files live next to the workspace, not inside JSON backups.</p></div>' : ''}<div class="detail-section"><div class="detail-label">CONNECTIONS <span>${links.length.toString().padStart(2, '0')}</span></div>${
    links.length
      ? links
          .map((link) => {
            const other = byId(link.from === node.id ? link.to : link.from);
            return `<div class="link-row"><button data-open="${escapeHTML(other.id)}" title="Open connected item"><span class="link-direction">${link.from === node.id ? '↗' : '↙'}</span><span class="link-text"><small>${escapeHTML(link.kind.toUpperCase())} · ${META[other.type].label}</small><strong>${escapeHTML(other.title)}</strong></span></button><button class="remove-link" data-remove-link="${escapeHTML(link.id)}" aria-label="Remove connection to ${escapeHTML(other.title)}">×</button></div>`;
          })
          .join('')
      : '<p class="detail-muted">No connections yet. Link this item to show how the work fits together.</p>'
  }</div><div class="detail-section"><div class="detail-label">CONNECT THE DOTS</div>${choices.length ? `<form id="link-form"><label class="sr-only" for="link-choice">Choose a connection</label><select id="link-choice" name="choice">${choices.map((c) => `<option value="${c.from}|${c.to}|${c.kind}">${escapeHTML(c.kind)} ${c.from === node.id ? '→' : '←'} ${escapeHTML(c.other.title)}</option>`).join('')}</select><button class="secondary-button" type="submit" title="Save this connection">＋ Add connection</button></form>` : '<p class="detail-muted">Add an item in a neighboring stage to connect it here.</p>'}</div><div class="inspector-actions"><button class="secondary-button" id="edit-item" title="Edit this item">Edit item</button><button class="delete-button" id="delete-item" title="Delete this item and all its connections">Delete</button></div></div>`;
  if (node?.type === 'source') loadAttachments(node.id);
}
function render() {
  $('#breadcrumb-view').textContent =
    view === 'all'
      ? 'Overview'
      : view === 'review'
        ? 'Review queue'
        : view === 'matrix'
          ? 'Evidence matrix'
          : META[view].plural;
  $('#page-title').innerHTML =
    view === 'all'
      ? 'Make the thinking <em>visible.</em>'
      : view === 'review'
        ? 'Stay curious. <em>Look closer.</em>'
        : view === 'matrix'
          ? 'See where ideas <em>meet evidence.</em>'
          : `${META[view].plural}, <em>in context.</em>`;
  $('#page-subtitle').textContent =
    view === 'all'
      ? 'From raw sources to considered decisions. Keep the why connected to what happens next.'
      : view === 'review'
        ? 'Unverified claims, counterevidence, and decisions that need a second look.'
        : view === 'matrix'
          ? 'Compare sources against claims, find missing links, and surface contradictions.'
          : META[view].hint + ' Connect it to the wider picture.';
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === view);
    button.setAttribute('aria-current', button.dataset.view === view ? 'page' : 'false');
  });
  refreshExportLinks();
  renderMetrics();
  renderBoard();
  renderInspector();
}
function openDialog(type = 'source', node = null) {
  editing = node?.id || null;
  const form = $('#item-form');
  form.reset();
  $('#field-type').disabled = !!node;
  $('#field-type').value = node?.type || type;
  form.elements.title.value = node?.title || '';
  form.elements.body.value = node?.body || '';
  form.elements.tags.value = (node?.tags || []).join(', ');
  form.elements.url.value = node?.url || '';
  for (const name of ['doi', 'authors', 'year', 'venue']) {
    if (form.elements[name]) form.elements[name].value = (node?.type === 'source' && node?.citation?.[name]) || '';
  }
  form.elements.due.value = node?.due || '';
  updateFields(node?.status);
  $('#dialog-title').textContent = node ? 'Edit item' : 'New item';
  $('#submit-item').innerHTML = node ? 'Save changes <span>↗</span>' : 'Create item <span>↗</span>';
  $('#item-dialog').showModal();
  form.elements.title.focus();
}
function updateFields(status) {
  const type = $('#field-type').value;
  document.querySelectorAll('.citation-field').forEach((el) => {
    el.hidden = type !== 'source';
  });
  $('.task-field').hidden = type !== 'task';
  $('.status-field').hidden = type === 'source';
  $('#field-status').innerHTML = STATUSES[type]
    .map((value) => `<option value="${value}" ${value === status ? 'selected' : ''}>${statusLabel(value)}</option>`)
    .join('');
}
$('#navigation').addEventListener('click', (event) => {
  const button = event.target.closest('[data-view]');
  if (button) {
    view = button.dataset.view;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});
$('#board').addEventListener('click', async (event) => {
  const add = event.target.closest('[data-add]');
  const open = event.target.closest('[data-open]');
  if (add) openDialog(add.dataset.add);
  else if (open) {
    if (open.dataset.openProject && open.dataset.openProject !== projectId) {
      $('#search').value = '';
      await switchProject(open.dataset.openProject);
    }
    selected = open.dataset.open;
    renderBoard();
    renderInspector();
  } else if (event.target.closest('#load-sample')) change('/api/sample', 'POST', undefined, 'Example workspace loaded');
});
$('#inspector').addEventListener('click', (event) => {
  const open = event.target.closest('[data-open]');
  const remove = event.target.closest('[data-remove-link]');
  const removeAttachment = event.target.closest('[data-remove-attachment]');
  if (open) {
    selected = open.dataset.open;
    renderBoard();
    renderInspector();
  } else if (remove)
    change(`/api/links/${encodeURIComponent(remove.dataset.removeLink)}`, 'DELETE', undefined, 'Connection removed');
  else if (removeAttachment) {
    const nodeId = selected;
    if (nodeId && confirm('Remove this PDF attachment? The file will be deleted.')) {
      api(
        `/api/nodes/${encodeURIComponent(nodeId)}/attachments/${encodeURIComponent(removeAttachment.dataset.removeAttachment)}`,
        'DELETE',
        undefined,
      )
        .then(() => {
          toast('Attachment removed');
          loadAttachments(nodeId);
        })
        .catch((error) => toast(error.message, true));
    }
  } else if (event.target.closest('[data-close-inspector]')) {
    selected = null;
    renderBoard();
    renderInspector();
  } else if (event.target.closest('#edit-item')) openDialog('source', byId(selected));
  else if (
    event.target.closest('#delete-item') &&
    confirm('Delete this item and all its connections? This cannot be undone.')
  ) {
    const id = selected;
    selected = null;
    change(`/api/nodes/${encodeURIComponent(id)}`, 'DELETE', undefined, 'Item deleted');
  }
});
$('#inspector').addEventListener('submit', (event) => {
  if (event.target.id === 'attachment-form') {
    event.preventDefault();
    const nodeId = selected;
    const input = $('#attachment-file');
    const file = input?.files?.[0];
    if (!nodeId || !file) return;
    if (file.size > 15 * 1024 * 1024) {
      toast('PDF must be under 15 MiB', true);
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const base64 = String(reader.result).split(',', 2)[1] || '';
        await api(`/api/nodes/${encodeURIComponent(nodeId)}/attachments`, 'POST', {
          filename: file.name,
          data: base64,
        });
        input.value = '';
        toast('PDF attached');
        loadAttachments(nodeId);
      } catch (error) {
        toast(error.message, true);
      }
    };
    reader.onerror = () => toast('Could not read this file', true);
    reader.readAsDataURL(file);
    return;
  }
  if (event.target.id !== 'link-form') return;
  event.preventDefault();
  const [from, to, kind] = new FormData(event.target).get('choice').split('|');
  change('/api/links', 'POST', { from, to, kind }, 'Connection added');
});
$('#new-item-top').addEventListener('click', () => openDialog(TYPES.includes(view) ? view : 'source'));
$('#undo-button').addEventListener('click', async () => {
  try {
    $('#sync-state').textContent = 'Undoing…';
    const result = await api('/api/undo', 'POST', undefined);
    workspace = result.workspace;
    selected = null;
    render();
    $('#sync-state').innerHTML =
      `<span class="sync-dot"></span> Saved · Undid ${escapeHTML(result.undone)} · ${new Date().toLocaleTimeString()}`;
    toast(`Undid: ${result.undone}`);
  } catch (error) {
    toast(error.message, true);
    $('#sync-state').innerHTML = '<span class="sync-dot"></span> Saved locally';
  }
});
$('#field-type').addEventListener('change', () => updateFields());
$('#close-dialog').addEventListener('click', () => $('#item-dialog').close());
$('#cancel-dialog').addEventListener('click', () => $('#item-dialog').close());
$('#item-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  if (!form.reportValidity()) return;
  const type = $('#field-type').value;
  const data = {
    title: form.elements.title.value,
    body: form.elements.body.value,
    tags: form.elements.tags.value
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean),
  };
  if (type === 'source') {
    data.url = form.elements.url.value;
    data.citation = {
      doi: form.elements.doi.value.trim(),
      authors: form.elements.authors.value.trim(),
      year: form.elements.year.value.trim(),
      venue: form.elements.venue.value.trim(),
    };
  }
  if (type === 'task') data.due = form.elements.due.value;
  if (type !== 'source') data.status = form.elements.status.value;
  if (!editing) data.type = type;
  const id = editing;
  const saved = await change(
    id ? `/api/nodes/${encodeURIComponent(id)}` : '/api/nodes',
    id ? 'PATCH' : 'POST',
    data,
    id ? 'Item updated' : 'Item added to the trail',
  );
  if (saved) $('#item-dialog').close();
});
$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderBoard, 250);
});
$('#sort').addEventListener('change', renderBoard);
$('#tag-filter').addEventListener('change', renderBoard);
$('#reset-button').addEventListener('click', async () => {
  if (!confirm('Start a blank workspace? Export a JSON backup first if you want to keep your current work.')) return;
  selected = null;
  view = 'all';
  $('#search').value = '';
  await change('/api/workspace', 'PUT', { nodes: [], links: [] }, 'Blank workspace ready');
});
function csvMessage(message, error = false) {
  const panel = $('#csv-preview');
  panel.classList.toggle('error', error);
  panel.textContent = message;
}
function invalidateCsvPreview() {
  previewedCsv = null;
  $('#commit-csv').disabled = true;
  csvMessage('Preview again to check this CSV against the current workspace.');
}
$('#csv-button').addEventListener('click', () => {
  invalidateCsvPreview();
  $('#csv-dialog').showModal();
});
$('#close-csv').addEventListener('click', () => $('#csv-dialog').close());
$('#csv-text').addEventListener('input', invalidateCsvPreview);
$('#csv-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  invalidateCsvPreview();
  if (file.size > 8 * 1024 * 1024) {
    csvMessage('CSV must be under 8 MB', true);
    return;
  }
  try {
    $('#csv-text').value = await file.text();
  } catch {
    csvMessage('Could not read this CSV file', true);
  }
});
$('#preview-csv').addEventListener('click', async () => {
  invalidateCsvPreview();
  const csv = $('#csv-text').value;
  csvMessage('Checking rows and existing items…');
  try {
    const plan = await api('/api/import/preview', 'POST', { csv });
    previewedCsv = csv;
    $('#commit-csv').disabled = plan.add === 0;
    $('#csv-preview').innerHTML =
      `<strong>${plan.add} to add · ${plan.skip} duplicate${plan.skip === 1 ? '' : 's'} to skip</strong><ul>${plan.entries
        .slice(0, 30)
        .map(
          (entry) =>
            `<li><span>Line ${entry.line} · ${escapeHTML(entry.action)} · ${escapeHTML(entry.type)}</span> ${escapeHTML(entry.title)}</li>`,
        )
        .join('')}</ul>${plan.entries.length > 30 ? `<p>And ${plan.entries.length - 30} more rows.</p>` : ''}`;
  } catch (error) {
    csvMessage(error.message, true);
  }
});
$('#commit-csv').addEventListener('click', async () => {
  if (!previewedCsv || previewedCsv !== $('#csv-text').value) return;
  $('#commit-csv').disabled = true;
  csvMessage('Importing…');
  try {
    const { workspace: imported, report } = await api('/api/import/csv', 'POST', { csv: previewedCsv });
    workspace = imported;
    selected = null;
    render();
    $('#csv-dialog').close();
    $('#csv-text').value = '';
    previewedCsv = null;
    $('#sync-state').innerHTML =
      `<span class="sync-dot"></span> Saved · Imported ${report.added} items · ${new Date().toLocaleTimeString()}`;
    toast(`Imported ${report.added} items; skipped ${report.skipped} duplicates`);
  } catch (error) {
    previewedCsv = null;
    csvMessage(error.message + ' Preview again before importing.', true);
  }
});
$('#import-button').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > 32 * 1024 * 1024) {
    toast('Backup must be under 32 MB', true);
    return;
  }
  try {
    const data = JSON.parse(await file.text());
    if (!confirm('Replace the current workspace with this backup? Export a backup first if needed.')) return;
    selected = null;
    await change('/api/workspace', 'PUT', data, 'Workspace imported');
  } catch {
    toast('This file is not valid JSON', true);
  }
});
async function loadProjects() {
  const select = $('#project-select');
  const data = await api('/api/projects');
  projectsCache = data.projects;
  const previous = select.value || projectId;
  select.innerHTML = data.projects
    .map(
      (item) =>
        `<option value="${escapeHTML(item.id)}">${escapeHTML(item.name)}${item.archived ? ' (archived)' : ''}</option>`,
    )
    .join('');
  select.value = data.projects.some((item) => item.id === previous) ? previous : data.defaultId;
  projectId = select.value;
  const archiveButton = $('#project-archive');
  if (archiveButton)
    archiveButton.textContent = data.projects.find((item) => item.id === projectId)?.archived ? 'Restore' : 'Archive';
}
async function switchProject(id) {
  projectId = id;
  selected = null;
  view = 'all';
  try {
    $('#sync-state').textContent = 'Loading…';
    workspace = await api('/api/workspace');
    render();
    await loadProjects();
    $('#sync-state').innerHTML = '<span class="sync-dot"></span> Saved locally';
  } catch (error) {
    toast(error.message, true);
    $('#sync-state').innerHTML = '<span class="sync-dot"></span> Saved locally';
  }
}
$('#project-select').addEventListener('change', (event) => switchProject(event.target.value));
$('#project-new').addEventListener('click', async () => {
  const name = prompt('Name the new project:');
  if (!name || !name.trim()) return;
  try {
    const project = await api('/api/projects', 'POST', { name: name.trim() });
    await switchProject(project.id);
    toast(`Project "${project.name}" created`);
  } catch (error) {
    toast(error.message, true);
  }
});
$('#project-rename').addEventListener('click', async () => {
  const current = projectsCache.find((item) => item.id === projectId);
  const name = prompt('Rename project:', current ? current.name : '');
  if (!name || !name.trim()) return;
  try {
    await api(`/api/projects/${encodeURIComponent(projectId)}`, 'PATCH', { name: name.trim() });
    await loadProjects();
    render();
    toast('Project renamed');
  } catch (error) {
    toast(error.message, true);
  }
});
$('#project-archive').addEventListener('click', async () => {
  const current = projectsCache.find((item) => item.id === projectId);
  const archiving = !current?.archived;
  if (
    !confirm(
      `${archiving ? 'Archive' : 'Restore'} this project?${archiving ? ' It stays accessible but is marked archived.' : ''}`,
    )
  )
    return;
  try {
    await api(`/api/projects/${encodeURIComponent(projectId)}`, 'PATCH', { archived: archiving });
    await loadProjects();
    render();
    toast(archiving ? 'Project archived' : 'Project restored');
  } catch (error) {
    toast(error.message, true);
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#item-dialog').open && !$('#csv-dialog').open && selected) {
    selected = null;
    renderBoard();
    renderInspector();
  }
  if (
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.target.closest('input,textarea,select,[contenteditable],dialog')
  )
    return;
  if (event.key === '/') {
    event.preventDefault();
    $('#search').focus();
  }
  if (event.key.toLowerCase() === 'n') {
    event.preventDefault();
    openDialog(TYPES.includes(view) ? view : 'source');
  }
});
try {
  await loadProjects();
  workspace = await api('/api/workspace');
  render();
} catch (error) {
  $('#board').innerHTML =
    `<div class="empty-state"><h3>Could not load the workspace.</h3><p>${escapeHTML(error.message)} Refresh to try again.</p></div>`;
  toast(error.message, true);
}
tickClock();
const clockTimer = setInterval(tickClock, 1000);
if (clockTimer && typeof clockTimer.unref === 'function') clockTimer.unref();
if (typeof globalThis !== 'undefined') globalThis.__traceworkClock = clockTimer;
