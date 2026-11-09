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
  IssueValidationError,
} from './issueContract.js';
import { AI_DELIVERY_MCP_TOOLS } from './mcp/index.js';
import { builderReady } from './fixtures/builderReady.js';

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

test('body.length counts prose words in problem, outcome and criteria and warns strictly above 300', () => {
  for (const [words, warning] of [
    [299, false],
    [300, false],
    [301, true],
  ] as const) {
    const issue = validIssue();
    issue.problem = Array.from({ length: words - 2 }, () => 'w').join(' ');
    issue.outcome = 'one';
    issue.acceptanceCriteria[0]!.behavior = 'two';
    assert.equal(
      issueWarnings(issue).some((item) => item.code === 'body.length'),
      warning,
      String(words),
    );
  }
  const structured = validIssue();
  structured.context.evidence.push('A'.repeat(5000));
  assert.ok(!issueWarnings(structured).some((item) => item.code === 'body.length'));
});

test('multiline criteria keep nested bullets and verification attached to their own checkbox', () => {
  const issue = validIssue();
  issue.acceptanceCriteria = [
    {
      behavior: 'Reject malformed input:\n- Empty input\n  - Whitespace only\n- Invalid shape',
      verifiedBy: 'Regression cases:\n- Empty and malformed',
    },
    { behavior: 'A valid input is stored once.', verifiedBy: 'One observed write.' },
  ];
  const actual = renderIssueBody(issue).split('## Acceptance criteria\n\n')[1]!.split('\n\n## Out of scope')[0];
  assert.equal(
    actual,
    '- [ ] Reject malformed input:\n  - Empty input\n    - Whitespace only\n  - Invalid shape\n\n  Verified by: Regression cases:\n  - Empty and malformed\n- [ ] A valid input is stored once.\n  Verified by: One observed write.',
  );
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
  assert.deepEqual(ready.anyOf, [
    { properties: { epic: { const: true } }, required: ['epic'] },
    { required: ['points'] },
  ]);
  assert.ok(!ISSUE_JSON_SCHEMAS.draft.required?.includes('points'));
});

test('concrete domain wording remains Ready while generic completion claims fail', () => {
  for (const behavior of [
    'The independently reviewed head SHA is sent as the merge guard.',
    'A failed request leaves the Project Done column unchanged.',
    'A verified token grants access only to its repository.',
    'The adapter works with a missing local checkout and returns the selected repository.',
  ]) {
    const issue = validIssue();
    issue.acceptanceCriteria[0]!.behavior = behavior;
    assert.deepEqual(validateIssue(issue).failures, [], behavior);
  }
  for (const behavior of [
    'The widget works correctly.',
    'The change is reviewed.',
    'The request is done.',
    'The interface is user friendly.',
  ]) {
    const issue = validIssue();
    issue.acceptanceCriteria[0]!.behavior = behavior;
    assert.ok(
      validateIssue(issue).failures.some((f) => f.code === 'acceptance-criteria.vague'),
      behavior,
    );
  }
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
      i.problem = Array.from({ length: 301 }, () => 'word').join(' ');
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

const builderFields = {
  builder: { tier: 'frontier' as const, reason: 'state-machine' as const },
  extends: ['src/widget.ts saveWidget (the one widget write path)'],
  decisions: ['Valid id: ^w-[0-9a-f]{8}$. Refuse with InvalidWidgetId.'],
  surface: [
    {
      path: 'src/widget.ts',
      change: 'edit' as const,
      signatures: ['export function saveWidget(w: Widget): void'],
    },
    { path: 'src/old.ts', change: 'delete' as const },
  ],
  fences: ['src/store.ts (storage owner)'],
  proof: ['npx vitest run src/widget.test.ts'],
};

test('every builder-ready field renders in order and parses back equal', () => {
  const issue = IssueFields.parse({
    ...validIssue(),
    ...builderFields,
    acceptanceCriteria: [
      {
        behavior: 'An invalid widget identifier returns an error without a persistence call.',
        verifiedBy: 'src/widget.test.ts',
        examples: [
          { input: "id 'w-0a1b2c3d'", expected: 'one store.put' },
          {
            input: "id ' w-0A1B2C3D'",
            expected: 'InvalidWidgetId',
            failure: true,
          },
        ],
      },
    ],
  });
  const body = renderIssueBody(issue);
  const at = (heading: string) => body.indexOf(`\n## ${heading}\n`);
  assert.ok(at('Outcome') < at('Builder') && at('Builder') < at('Extends') && at('Extends') < at('Decisions'));
  assert.ok(at('Decisions') < at('Acceptance criteria') && at('Acceptance criteria') < at('Surface'));
  assert.ok(at('Surface') < at('Fences') && at('Fences') < at('Proof') && at('Proof') < at('Out of scope'));
  assert.ok(body.includes('## Builder\n\nfrontier: state-machine\n'));
  assert.ok(
    body.includes(
      "  Example: id 'w-0a1b2c3d' → one store.put\n  Example: id ' w-0A1B2C3D' → InvalidWidgetId (failure)\n",
    ),
  );
  assert.ok(
    body.includes('- edit `src/widget.ts`\n  export function saveWidget(w: Widget): void\n- delete `src/old.ts`\n'),
  );
  const parsed = parseIssueBody(body, { title: issue.title });
  assert.equal(parsed.legacy, false);
  assert.deepEqual(parsed.issue, issue);
  assert.deepEqual(validateIssue(issue).failures, []);
});

test('bodies without builder-ready fields re-render byte for byte with no new data keys', () => {
  const body = renderIssueBody(validIssue());
  assert.ok(!/\n## (?:Builder|Extends|Decisions|Surface|Fences|Proof)\n/u.test(body));
  const data = body.split('<!-- ai-delivery:issue-data@1 ')[1]!;
  for (const key of ['builder', 'extends', 'decisions', 'surface', 'fences', 'proof', 'examples'])
    assert.ok(!data.includes(`"${key}"`), key);
  const parsed = parseIssueBody(body, { title: validIssue().title });
  assert.equal(renderIssueBody(parsed.issue), body);
  assert.equal(
    body.split('\n\n## Acceptance criteria\n\n')[1]!.split('\n\n## Out of scope')[0],
    '- [ ] An invalid widget identifier returns an error without a persistence call.\n  Verified by: A mocked persistence regression asserts the error and zero calls.',
  );
});

test('malformed builder-ready fields fail at their own field', () => {
  const fails = (extra: object, field: string) => {
    const result = validateIssue({ ...validIssue(), ...extra }, false);
    assert.ok(
      result.failures.some((failure) => failure.field.startsWith(field)),
      field,
    );
  };
  fails({ builder: { tier: 'frontier' } }, 'builder');
  fails({ builder: { tier: 'frontier', reason: 'because' } }, 'builder');
  fails({ builder: { tier: 'standard', reason: 'state-machine' } }, 'builder');
  fails({ surface: [{ path: 'src/a.ts', change: 'move' }] }, 'surface');
});

test('create and update tools and the portable Ready schema expose the six top-level keys', () => {
  const shape = z.toJSONSchema(IssueWriteSchema).properties;
  for (const tool of ['issue_create', 'issue_update']) {
    const schema = AI_DELIVERY_MCP_TOOLS.find((t) => t.name === tool)!.inputSchema;
    for (const key of ['builder', 'extends', 'decisions', 'surface', 'fences', 'proof'])
      assert.deepEqual(z.toJSONSchema(schema).properties?.[key], shape?.[key], `${tool} ${key}`);
  }
  for (const key of ['builder', 'extends', 'decisions', 'surface', 'fences', 'proof'])
    assert.ok(key in ISSUE_JSON_SCHEMAS.ready.properties!, key);
  assert.ok(!ISSUE_JSON_SCHEMAS.ready.required?.includes('builder'));
});

test('builderReady has no failures and no warnings', () => {
  assert.deepEqual(validateIssue(builderReady()).failures, []);
  assert.deepEqual(issueWarnings(builderReady()), []);
});

const refusalCases: [string, (i: ReturnType<typeof builderReady>) => void, string][] = [
  ['no decisions', (i) => void (i.decisions = []), 'decisions'],
  ['blank decision', (i) => void (i.decisions = [' ']), 'decisions'],
  ['no surface', (i) => void (i.surface = []), 'surface'],
  ['blank surface path', (i) => void (i.surface = [{ path: ' ', change: 'edit' }]), 'surface'],
  [
    'no examples',
    (i) => {
      delete i.acceptanceCriteria[0]!.examples;
    },
    'examples',
  ],
  [
    'no failure example',
    (i) => {
      i.acceptanceCriteria[0]!.examples = [{ input: 'a', expected: 'b' }];
    },
    'examples.failure',
  ],
  ['no proof', (i) => void (i.proof = []), 'proof'],
];
for (const [name, mutate, code] of refusalCases)
  test('Ready with builder refuses ' + name, () => {
    const issue = builderReady();
    mutate(issue);
    const failures = validateIssue(issue).failures;
    assert.ok(
      failures.some((f) => f.code === code && f.fixHint.endsWith('See ai-delivery:ticket-design.')),
      code,
    );
  });

test('builder fields are required only with builder, and never for epics or drafts', () => {
  assert.deepEqual(validateIssue(validIssue()).failures, []);
  const bare = { ...builderReady(), decisions: undefined, surface: undefined, proof: undefined, epic: true as const };
  assert.deepEqual(validateIssue(bare).failures, []);
  assert.deepEqual(validateIssue({ ...bare, epic: undefined, draft: true }, false).failures, []);
});

test('requireBuilder refuses a Ready non-epic issue without builder and offers draft', () => {
  assert.throws(
    () => requireIssue(validIssue(), { requireBuilder: true }),
    (error: unknown) =>
      error instanceof IssueValidationError &&
      error.failures.some((f) => f.code === 'builder.missing' && f.fixHint.includes('draft: true')),
  );
  assert.ok(requireIssue(validIssue()));
  assert.ok(requireIssue(builderReady(), { requireBuilder: true }));
  assert.ok(requireIssue({ ...validIssue(), draft: true }, { requireBuilder: true }));
  assert.ok(requireIssue({ ...validIssue(), epic: true }, { requireBuilder: true }));
});

const judgmentCases: [string, (i: ReturnType<typeof builderReady>) => void, string][] = [
  ['8 points', (i) => void (i.points = 8), 'size.points'],
  [
    'seven surface paths',
    (i) =>
      void (i.surface = Array.from({ length: 7 }, (_, n) => ({ path: `src/a${n}.ts`, change: 'delete' as const }))),
    'size.surface',
  ],
  [
    'a criterion without examples',
    (i) => {
      i.acceptanceCriteria.push({ behavior: 'saveWidget stores a valid id', verifiedBy: 'src/widget.test.ts' });
    },
    'examples.ac',
  ],
  [
    'a code path without signatures',
    (i) => void (i.surface = [{ path: 'src/widget.ts', change: 'edit' }]),
    'surface.signature',
  ],
  ['no fences', (i) => void (i.fences = []), 'fences'],
  ['blank extends', (i) => void (i.extends = [' ']), 'extends'],
];
for (const [name, mutate, code] of judgmentCases)
  test('Ready with builder warns, never refuses, for ' + name, () => {
    const issue = builderReady();
    mutate(issue);
    assert.deepEqual(validateIssue(issue).failures, []);
    assert.ok(
      issueWarnings(issue).some((w) => w.code === code && w.fixHint.endsWith('See ai-delivery:ticket-design.')),
    );
  });

test('surface.signature skips deleted paths, tests and non-code files', () => {
  const issue = builderReady();
  issue.surface = [
    { path: 'src/gone.ts', change: 'delete' },
    { path: 'src/widget.test.ts', change: 'edit' },
    { path: 'README.md', change: 'edit' },
  ];
  assert.ok(!issueWarnings(issue).some((w) => w.code === 'surface.signature'));
});

test('a legacy Ready issue warns builder.unset and skips builder-only warnings; edge-case and context drop with builder', () => {
  const codes = (issue: Parameters<typeof issueWarnings>[0]) => issueWarnings(issue).map((w) => w.code);
  assert.ok(codes(validIssue()).includes('builder.unset'));
  assert.ok(!codes({ ...validIssue(), draft: true }).includes('builder.unset'));
  assert.ok(!codes({ ...validIssue(), epic: true }).includes('builder.unset'));
  assert.ok(!codes(validIssue()).some((code) => code.startsWith('size.') || code === 'fences' || code === 'extends'));
  const noCopy = builderReady();
  noCopy.acceptanceCriteria[0]!.behavior = 'saveWidget stores valid ids';
  noCopy.context = { components: [], files: [], evidence: [] };
  assert.ok(!codes(noCopy).some((code) => code === 'edge-case' || code === 'context'));
});
