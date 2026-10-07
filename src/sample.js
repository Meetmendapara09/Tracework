// Fictional example data. Never presented as real research findings.
export function sampleWorkspace() {
  const now = new Date().toISOString();
  const node = (id, type, title, body, extra = {}) => ({
    id,
    type,
    title,
    body,
    url: '',
    due: '',
    tags: [],
    status: { source: '', claim: 'open', decision: 'proposed', task: 'todo' }[type],
    createdAt: now,
    updatedAt: now,
    ...extra,
  });
  return {
    revision: 0,
    nodes: [
      node(
        's-interviews',
        'source',
        'Interview synthesis · 12 participants',
        'Example notes: Participants described switching between documents to reconstruct why a decision was made. This is fictional demonstration data.',
        { tags: ['Interviews', 'Pilot'] },
      ),
      node(
        's-audit',
        'source',
        'Workflow audit · Q2',
        'Example observation: In a fictional audit, review teams found handoffs without a named owner.',
        { tags: ['Audit'] },
      ),
      node(
        's-counter',
        'source',
        'Counterpoint · lightweight teams',
        'Example counterpoint: Small teams reported that formal logging felt like overhead when decisions were reversible.',
      ),
      node(
        'c-context',
        'claim',
        'Decision context gets lost across handoffs',
        'Preserve the reasoning and the source material alongside the final choice.',
        { status: 'reviewed', tags: ['Pilot'] },
      ),
      node(
        'c-ownership',
        'claim',
        'Explicit owners reduce follow-up ambiguity',
        'Make the next action and its owner visible when a choice is made.',
      ),
      node(
        'c-friction',
        'claim',
        'Every extra step risks slowing small teams',
        'Test whether structure helps more than it interrupts. This claim is deliberately contested.',
      ),
      node(
        'd-trail',
        'decision',
        'Pilot an evidence trail for project reviews',
        'Start with a small, opt-in pilot. Measure time spent reconstructing context versus time spent recording it.',
        { status: 'accepted', tags: ['Pilot'] },
      ),
      node(
        'd-template',
        'decision',
        'Keep the capture template minimal',
        'Use short fields and optional context; revisit after the pilot.',
      ),
      node(
        't-prototype',
        'task',
        'Create a five-minute capture exercise',
        'Ask two teams to record one decision each. Compare the resulting trails.',
      ),
      node(
        't-interview',
        'task',
        'Interview reviewers after the pilot',
        'Find what was useful, what was missing, and what felt like overhead.',
        { status: 'doing' },
      ),
      node(
        't-measure',
        'task',
        'Define a context-recovery metric',
        'Time how long a new reviewer needs to explain a decision using its attached evidence.',
      ),
    ],
    links: [
      ['l1', 's-interviews', 'c-context', 'supports'],
      ['l2', 's-audit', 'c-ownership', 'supports'],
      ['l3', 's-interviews', 'c-friction', 'supports'],
      ['l4', 's-counter', 'c-friction', 'challenges'],
      ['l5', 'c-context', 'd-trail', 'informs'],
      ['l6', 'c-ownership', 'd-trail', 'informs'],
      ['l7', 'c-friction', 'd-template', 'informs'],
      ['l8', 'd-trail', 't-prototype', 'advances'],
      ['l9', 'd-trail', 't-interview', 'advances'],
      ['l10', 'd-template', 't-measure', 'advances'],
    ].map(([id, from, to, kind]) => ({ id, from, to, kind })),
  };
}
