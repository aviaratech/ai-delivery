import assert from 'node:assert/strict';
import { test } from 'vitest';
import { z } from 'zod';
import {
  DraftIssue,
  ReadyIssue,
  IssueFields,
  IssueWriteSchema,
  ISSUE_JSON_SCHEMAS,
  ISSUE_BODY_MARKER,
  requireIssue,
  renderIssueBody,
  parseIssueBody,
  validateIssue,
  issueWarnings,
} from './issueContract.js';
import { AI_DELIVERY_MCP_TOOLS } from './mcp/index.js';

export const validIssue = () =>
  IssueFields.parse({
    title: 'Reject invalid widget identifiers before persistence',
    issueType: 'Feature',
    points: 2,
    problem: 'Malformed identifiers currently reach persistence.',
    outcome: 'Widget writes reject malformed identifiers before persistence.',
    acceptanceCriteria: [
      {
        behavior: 'An invalid widget identifier returns an error without a persistence call.',
        verifiedBy: 'A mocked persistence regression asserts the error and zero calls.',
      },
    ],
    outOfScope: ['Changing the storage engine.'],
    openQuestions: [],
    context: {
      components: ['widget intake'],
      files: ['src/widget.ts'],
      evidence: ['A portable synthetic identifier fixture.'],
    },
  });

test('MCP create/update fields derive from the canonical schema and patch omissions retain no defaults', () => {
  const create = AI_DELIVERY_MCP_TOOLS.find((t) => t.name === 'issue_create')!;
  const update = AI_DELIVERY_MCP_TOOLS.find((t) => t.name === 'issue_update')!;
  const shape = z.toJSONSchema(IssueWriteSchema).properties;
  for (const name of [
    'acceptanceCriteria',
    'context',
    'outOfScope',
    'openQuestions',
    'problem',
    'outcome',
    'bug',
    'draft',
  ]) {
    assert.deepEqual(z.toJSONSchema(create.inputSchema).properties?.[name], shape?.[name]);
    assert.deepEqual(z.toJSONSchema(update.inputSchema).properties?.[name], shape?.[name]);
  }
  assert.deepEqual(update.inputSchema.parse({ issueNumber: 17 }), { issueNumber: 17 });
  assert.ok('issueContract' in create);
  assert.deepEqual(
    create.issueContract,
    ISSUE_JSON_SCHEMAS,
    'portable output is reachable through the existing packaged MCP export',
  );
});

test('portable JSON Schema snapshot carries Ready bounds and distinguishes incomplete drafts', () => {
  const ready = ISSUE_JSON_SCHEMAS.ready;
  assert.deepEqual(
    {
      draft: ready.properties?.draft,
      points: ready.properties?.points,
      title: ready.properties?.title,
      openQuestions: ready.properties?.openQuestions,
    },
    {
      draft: { type: 'boolean', const: false, default: false },
      points: { type: 'integer', minimum: 1, maximum: 8 },
      title: { type: 'string', minLength: 10, maxLength: 80 },
      openQuestions: { default: [], type: 'array', items: { type: 'string' }, maxItems: 0 },
    },
  );
  assert.ok(ready.required?.includes('points'));
  assert.ok(!ISSUE_JSON_SCHEMAS.draft.required?.includes('points'));
});

test('canonical bodies round trip every typed field, multiline markup and comment delimiters', () => {
  const issue = validIssue();
  issue.context.evidence.push('Observed <!-- text -->\n## nested heading\n`code`');
  const body = renderIssueBody(issue);
  assert.ok(body.startsWith(ISSUE_BODY_MARKER + '\n\n## Status\n\nReady'));
  assert.deepEqual(parseIssueBody(body, { title: issue.title }).issue, issue);
  assert.equal(parseIssueBody(body, { title: issue.title }).legacy, false);
  assert.throws(
    () => parseIssueBody(body.replace('## Status\n\nReady', '## Status\n\nDraft'), { title: issue.title }),
    /body.canonical/u,
  );
  assert.throws(() => parseIssueBody(body, { title: 'Different native title' }), /body.canonical/u);
});

test('lenient legacy conversion retains all bytes, portable verification and marker descriptions', () => {
  const body =
    '## Problem\nA literal ' +
    ISSUE_BODY_MARKER +
    ' is documentation.\n## Outcome\nReject malformed identifiers.\n## Acceptance Criteria\n- [ ] Invalid identifiers return an error before persistence.\n## Verification\nRun the synthetic identifier tests.\n## Out of scope\n- Storage engine changes.\n## Scope\nsrc/missing-in-this-checkout.ts\nUnclassified historical text.\n';
  const parsed = parseIssueBody(body, { title: validIssue().title, points: 2, issueType: 'Feature' });
  assert.equal(parsed.legacy, true);
  assert.equal(parsed.issue.legacyBody, body);
  assert.equal(parsed.issue.acceptanceCriteria[0]?.verifiedBy, 'Run the synthetic identifier tests.');
  const ready = requireIssue(parsed.issue);
  assert.deepEqual(parseIssueBody(renderIssueBody(ready), { title: ready.title }).issue, ready);
});

test('legacy conversion never fabricates missing verification or bug evidence', () => {
  const body =
    '## Problem\nA failure.\n## Outcome\nReject invalid widgets.\n## Acceptance Criteria\n- [ ] Invalid widgets are rejected before persistence.\n## Out of scope\n- Storage changes.\n';
  const parsed = parseIssueBody(body, { title: validIssue().title, points: 2, issueType: 'Bug' });
  const codes = validateIssue(parsed.issue).failures.map((f) => f.code);
  assert.ok(codes.includes('acceptance-criteria.fields'));
  assert.ok(codes.includes('bug.steps'));
  assert.ok(codes.includes('bug.environment'));
});

const blockingCases: [string, (issue: ReturnType<typeof validIssue>) => void, string][] = [
  [
    'Points13',
    (i) => {
      i.points = 13;
    },
    'points',
  ],
  [
    'Points0',
    (i) => {
      i.points = 0;
    },
    'points',
  ],
  [
    'Points9',
    (i) => {
      i.points = 9;
    },
    'points',
  ],
  [
    'missing behavior',
    (i) => {
      i.acceptanceCriteria[0]!.behavior = '';
    },
    'acceptance-criteria.fields',
  ],
  [
    'missing verifiedBy',
    (i) => {
      i.acceptanceCriteria[0]!.verifiedBy = '';
    },
    'acceptance-criteria.fields',
  ],
  [
    'vague AC',
    (i) => {
      i.acceptanceCriteria[0]!.behavior = 'The widget works correctly.';
    },
    'acceptance-criteria.vague',
  ],
  [
    'no non-goal',
    (i) => {
      i.outOfScope = [];
    },
    'out-of-scope',
  ],
  [
    'open question',
    (i) => {
      i.openQuestions = ['Choose the persistence behavior.'];
    },
    'open-questions',
  ],
  [
    'vague title',
    (i) => {
      i.title = 'Fix things';
    },
    'title.specific',
  ],
  [
    'long title',
    (i) => {
      i.title = 'x'.repeat(81);
    },
    'title.length',
  ],
  [
    'type prefix',
    (i) => {
      i.title = 'Bug: Reject invalid widget identifiers';
    },
    'title.prefix',
  ],
  [
    'bug fields',
    (i) => {
      i.issueType = 'Bug';
    },
    'bug',
  ],
  [
    'secret',
    (i) => {
      i.problem = 'A fixture contains ' + ['gh', 'p_'].join('') + 'A'.repeat(24);
    },
    'secrets',
  ],
];
for (const [name, mutate, code] of blockingCases)
  test('Ready blocks ' + name + ' with a field and actionable fix hint', () => {
    const issue = validIssue();
    mutate(issue);
    const failures = validateIssue(issue).failures;
    assert.ok(
      failures.some((f) => f.code === code),
      JSON.stringify(failures),
    );
    assert.ok(failures.every((f) => f.field.length > 0 && f.fixHint.length > 10));
  });

for (const field of ['steps', 'expected', 'actual', 'reproducibility', 'environment'] as const)
  test('Bug requires ' + field, () => {
    const issue = validIssue();
    issue.issueType = 'Bug';
    issue.bug = {
      steps: ['Submit an invalid identifier.'],
      expected: 'No write.',
      actual: 'A write occurs.',
      reproducibility: 'Every invalid input.',
      environment: 'Synthetic server, Node24.',
    };
    if (field === 'steps') issue.bug.steps = [];
    else issue.bug[field] = '';
    assert.ok(validateIssue(issue).failures.some((f) => f.code === 'bug.' + field));
  });

test('Ready is the default; explicit drafts park incomplete requirements without permitting secrets', () => {
  assert.equal(requireIssue(validIssue()).draft, false);
  assert.equal(ReadyIssue.safeParse({ title: 'Investigate invalid widget identifiers', draft: true }).success, false);
  const draft = requireIssue({ title: 'Investigate invalid widget identifiers', draft: true });
  assert.equal(draft.draft, true);
  assert.match(renderIssueBody(draft), /Draft — parked/u);
  assert.equal(DraftIssue.safeParse({ ...draft, problem: 'password=' + 'X'.repeat(16) }).success, false);
});

test('independent Ready failures remain actionable together when native Points are missing', () => {
  const failures = validateIssue({
    title: 'Investigate malformed widget identifiers',
    issueType: 'Bug',
    problem: 'A malformed identifier reaches storage.',
    outcome: 'Reject malformed identifiers.',
    acceptanceCriteria: [],
    outOfScope: [],
    openQuestions: ['Choose the return shape.'],
  }).failures;
  for (const code of ['points', 'bug', 'acceptance-criteria', 'out-of-scope', 'open-questions'])
    assert.ok(failures.some((f) => f.code === code));
  assert.equal(new Set(failures.map((f) => f.code + ':' + f.field)).size, failures.length);
});

const warningCases: [string, (issue: ReturnType<typeof validIssue>) => void, string][] = [
  [
    'many criteria',
    (i) => {
      i.acceptanceCriteria = Array.from({ length: 8 }, () => ({ ...i.acceptanceCriteria[0]! }));
    },
    'many-criteria',
  ],
  [
    'no edge case',
    (i) => {
      i.acceptanceCriteria[0]!.behavior = 'A valid identifier produces exactly one persisted widget.';
    },
    'edge-case',
  ],
  [
    'Bug without regression',
    (i) => {
      i.issueType = 'Bug';
      i.bug = {
        steps: ['Submit an invalid identifier.'],
        expected: 'No write.',
        actual: 'A write occurs.',
        reproducibility: 'Every input.',
        environment: 'Synthetic server.',
      };
      i.acceptanceCriteria[0]!.verifiedBy = 'A mock asserts zero persistence calls.';
    },
    'bug.regression',
  ],
  [
    'no context',
    (i) => {
      i.context = { files: [], components: [], evidence: [] };
    },
    'context',
  ],
  [
    'only local evidence',
    (i) => {
      i.context.evidence = ['/synthetic/machine/proof.txt'];
      i.acceptanceCriteria[0]!.verifiedBy = '/synthetic/machine/test.ts';
    },
    'local-evidence',
  ],
  [
    'long body',
    (i) => {
      i.context.evidence.push('A'.repeat(3100));
    },
    'body.length',
  ],
];
for (const [name, mutate, code] of warningCases)
  test('Warning does not block ' + name, () => {
    const issue = validIssue();
    mutate(issue);
    assert.equal(validateIssue(issue).failures.length, 0);
    assert.ok(issueWarnings(issue).some((w) => w.code === code));
  });
