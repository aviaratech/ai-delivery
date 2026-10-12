import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAiDeliveryMcpServer } from './mcp/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { createIssue, updateIssue, canonicalIssueBody, type DeliveryContext } from './issue.js';
import { executeTool, startTrackedIssue } from './dispatch.js';
import { digestValue } from './delivery/common.js';
import { getAiDeliveryMcpTool } from './mcp/tools.js';
import { IssueFields, ReadyIssue, renderIssueBody, parseIssueBody, ISSUE_BODY_MARKER } from './issueContract.js';
import { syntheticDiscoveryConfig } from './fixtures/discovery.js';

afterEach(() => vi.restoreAllMocks());

const ready = () =>
  IssueFields.parse({
    title: 'Reject invalid widget identifiers before persistence',
    issueType: 'Task',
    points: 2,
    problem: 'Malformed identifiers reach persistence.',
    outcome: 'Reject malformed widget identifiers before persistence.',
    acceptanceCriteria: [
      {
        behavior: 'An invalid identifier returns an error with zero persistence calls.',
        verifiedBy: 'A portable mocked persistence regression test.',
      },
    ],
    outOfScope: ['Storage changes.'],
    context: { components: ['widget'], files: [], evidence: [] },
  });

function fixture() {
  const live = {
    number: 17,
    id: 117,
    node_id: 'ISSUE17',
    title: ready().title,
    body: renderIssueBody(ready()),
    state: 'open',
    created_at: '2026-01-01T00:00:00Z',
    type: { name: 'Task' },
    html_url: 'https://github.com/example/widget/issues/17',
  };
  const writes: Record<string, unknown>[] = [];
  const comments: { id: number; body: string; html_url: string; user: { login: string }; issue_url: string }[] = [];
  const controls = {
    role: 'author',
    ignoreBody: false,
    wrongCreateRepo: false,
    driftAfterHistory: false,
    created: true,
    blockers: false,
    trackingParent: false,
    livePoints: 2,
    projectMember: true,
    projectArchived: false,
    projectFailure: '' as '' | 'before' | 'after' | 'readback',
    journalFailure: false,
    branchFailure: false,
    closeAfterBranch: false,
    blockAfterBranch: false,
  };
  const branchWrites: Record<string, unknown>[] = [];
  const branches: { name: string; sha: string }[] = [];
  let points = 2;
  let status = 'Queued';
  const statusWrites: Record<string, unknown>[] = [];
  const membershipWrites: Record<string, unknown>[] = [];
  const optionId = () => ({ Queued: 'TODO', Active: 'ACTIVE', Waiting: 'BLOCKED', Shipped: 'DONE' })[status];
  const values = () => [
    {
      issue_field_id: 101,
      issue_field_name: 'Estimate',
      data_type: 'single_select',
      value: String(controls.livePoints),
    },
  ];
  const context = {
    root: '/synthetic-non-git',
    repo: { owner: 'example', repo: 'widget' },
    config: syntheticDiscoveryConfig,
    projectConfiguration: {
      projectId: 'PROJECT',
      projectNumber: 1,
      title: 'Delivery',
      writable: true,
      pointsFieldId: 'POINTS',
      priorityFieldId: 'PRIORITY',
      statusFieldId: 'STATUS',
      statusOptionIds: { Todo: 'TODO', 'In Progress': 'ACTIVE', Blocked: 'BLOCKED', Done: 'DONE' },
      settings: {
        number: 1,
        title: 'Delivery',
        statusField: 'Flow',
        statuses: { Todo: 'Queued', 'In Progress': 'Active', Blocked: 'Waiting', Done: 'Shipped' },
      },
    },
    clients: {
      get role() {
        return controls.role;
      },
      authenticatedAuthor: async () => ({ actorLogin: 'operator', credentialIdentity: 'user:1' }),
      rest: {
        issues: {
          listSubIssues: async () => ({ data: controls.trackingParent ? [{ number: 18 }] : [] }),
          get: async () => ({ data: { ...live } }),
          listForRepo: async () => ({ data: controls.created ? [{ ...live }] : [] }),
          create: async (input: Record<string, unknown>) => {
            writes.push(input);
            controls.created = true;
            live.title = String(input.title);
            live.body = String(input.body);
            live.type = { name: String(input.type) };
            return {
              data: {
                ...live,
                ...(controls.wrongCreateRepo ? { html_url: 'https://github.com/other/widget/issues/17' } : {}),
              },
            };
          },
          update: async (input: Record<string, unknown>) => {
            writes.push(input);
            if (!controls.ignoreBody && typeof input.body === 'string') live.body = input.body;
            if (typeof input.title === 'string') live.title = input.title;
            if (typeof input.type === 'string') live.type = { name: input.type };
            return { data: { ...live } };
          },
          listComments: async () => ({ data: comments }),
          createComment: async (input: { body: string }) => {
            const comment = {
              id: 91 + comments.length,
              body: input.body,
              html_url: 'https://github.com/example/widget/issues/17#issuecomment-' + String(91 + comments.length),
              user: { login: 'operator' },
              issue_url: 'https://api.github.com/repos/example/widget/issues/17',
            };
            comments.push(comment);
            if (controls.journalFailure) throw new Error('Lost journal response');
            return { data: comment };
          },
          getComment: async (input: { comment_id: number }) => {
            if (controls.driftAfterHistory) live.body = 'Concurrent owner content';
            return { data: comments.find((c) => c.id === input.comment_id) };
          },
        },
        repos: { get: async () => ({ data: { default_branch: 'main', node_id: 'REPOSITORY' } }) },
        git: { getRef: async () => ({ data: { object: { sha: 'a'.repeat(40) } } }) },
        request: async (route: string, input: Record<string, unknown>) => {
          if (route === 'GET /orgs/{org}/issue-fields')
            return {
              data: [
                {
                  id: 101,
                  name: 'Estimate',
                  data_type: 'single_select',
                  options: ['1', '2', '4'].map((name) => ({ name })),
                },
                {
                  id: 102,
                  name: 'Urgency',
                  data_type: 'single_select',
                  options: ['High', 'Low'].map((name) => ({ name })),
                },
              ],
            };
          if (route.startsWith('POST ')) {
            const fields = input.issue_field_values as { field_id: number; value: string }[];
            points = Number(fields.find((f) => f.field_id === 101)?.value ?? points);
            controls.livePoints = points;
            return { data: values() };
          }
          if (route.startsWith('GET ')) return { data: values() };
          throw new Error('Unexpected native request ' + route);
        },
      },
      graphql: async (query: string, input: Record<string, unknown>) => {
        if (query.includes('DeliveryIssueBranches'))
          return {
            repository: {
              issue: {
                linkedBranches: {
                  nodes: branches.map((branch) => ({
                    ref: {
                      name: branch.name,
                      target: { oid: branch.sha },
                      repository: { nameWithOwner: 'example/widget' },
                    },
                  })),
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          };
        if (query.includes('DeliveryStartBranch')) {
          const fields = input.input as Record<string, unknown>;
          branchWrites.push(fields);
          branches.push({ name: String(fields.name), sha: String(fields.oid) });
          if (controls.closeAfterBranch) live.state = 'closed';
          if (controls.blockAfterBranch) controls.blockers = true;
          if (controls.branchFailure) throw new Error('Lost branch response');
          return { createLinkedBranch: { linkedBranch: { ref: { name: fields.name, target: { oid: fields.oid } } } } };
        }
        if (query.includes('blockedBy(first:'))
          return {
            repository: {
              issue: {
                parent: null,
                blockedBy: {
                  nodes: controls.blockers
                    ? [
                        {
                          id: 'ISSUE18',
                          number: 18,
                          title: 'Resolve prerequisite',
                          state: 'OPEN',
                          repository: { nameWithOwner: 'example/widget' },
                        },
                      ]
                    : [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          };
        if (query.includes('ProjectDeliveryItems'))
          return {
            organization: {
              projectV2: {
                items: {
                  nodes: [
                    {
                      id: 'OTHER',
                      isArchived: false,
                      content: { id: 'OTHER-ISSUE' },
                      fieldValueByName: { name: 'Queued', optionId: 'TODO' },
                    },
                    ...(controls.projectMember
                      ? [
                          {
                            id: 'ITEM17',
                            isArchived: controls.projectArchived,
                            content: { id: 'ISSUE17' },
                            fieldValueByName: { name: status, optionId: optionId() },
                          },
                        ]
                      : []),
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          };
        if (query.includes('AddProjectDeliveryItem')) {
          membershipWrites.push(input);
          assert.equal(input.projectId, 'PROJECT');
          assert.equal(input.contentId, 'ISSUE17');
          controls.projectMember = true;
          return { addProjectV2ItemById: { item: { id: 'ITEM17' } } };
        }
        if (query.includes('UpdateProjectDeliveryStatus')) {
          statusWrites.push(input);
          assert.equal(input.projectId, 'PROJECT');
          assert.equal(input.itemId, 'ITEM17');
          assert.equal(input.fieldId, 'STATUS');
          if (input.optionId === 'ACTIVE' && controls.projectFailure === 'before')
            throw new Error('Project write failed');
          status = input.optionId === 'TODO' ? 'Queued' : input.optionId === 'DONE' ? 'Shipped' : 'Active';
          if (input.optionId === 'ACTIVE' && controls.projectFailure === 'after')
            throw new Error('Lost Project response');
          return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'ITEM17' } } };
        }
        if (query.includes('ProjectDeliveryItemReadback'))
          return {
            node: {
              id: 'ITEM17',
              isArchived: false,
              project: { id: 'PROJECT', number: 1 },
              content: {
                id: status === 'Active' && controls.projectFailure === 'readback' ? 'OTHER-ISSUE' : 'ISSUE17',
              },
              fieldValueByName: { name: status, optionId: optionId() },
            },
          };
        throw new Error('Unexpected native query ' + query);
      },
    },
  } as unknown as DeliveryContext;
  return {
    context,
    live,
    writes,
    comments,
    controls,
    branches,
    branchWrites,
    statusWrites,
    membershipWrites,
    getStatus: () => status,
    setStatus: (value: string) => {
      status = value;
    },
  };
}

test('native create validates first, writes canonical fields, reads back metadata and returns warnings', async () => {
  const f = fixture();
  await assert.rejects(createIssue(f.context, { ...ready(), openQuestions: ['Select behavior.'] }), /open-questions/u);
  assert.equal(f.writes.length, 0);
  const result = await createIssue(f.context, ready());
  assert.equal(f.writes.length, 1);
  assert.equal(result.body, renderIssueBody(ready()));
  assert.equal(parseIssueBody(result.body, { title: result.created.title }).issue.points, 2);
  assert.deepEqual(result.warnings, []);
  assert.equal(f.getStatus(), 'Queued');
});

test('incomplete drafts write parked; reviewer-role writes and wrong native repository readback are refused', async () => {
  const f = fixture();
  await createIssue(f.context, { title: 'Investigate invalid widget identifiers', draft: true });
  assert.equal(f.getStatus(), 'Queued');
  assert.match(f.live.body, /Draft — parked/u);
  f.controls.role = 'reviewer';
  await assert.rejects(createIssue(f.context, ready()), /author role/u);
  await assert.rejects(updateIssue(f.context, { issueNumber: 17, draft: true }), /author role/u);
  const bad = fixture();
  bad.controls.wrongCreateRepo = true;
  await assert.rejects(createIssue(bad.context, ready()), /created but native tracking did not complete/u);
  assert.equal(bad.writes.length, 1);
});

test('first legacy update retains exact history and full diff, then typed patches preserve unspecified fields', async () => {
  const f = fixture();
  const legacy =
    '## Problem\nMalformed identifiers reach persistence.\n## Outcome\nReject malformed identifiers.\n## Acceptance Criteria\n- [ ] Invalid identifiers return an error without persistence.\n## Verification\nA portable regression asserts no write.\n## Out of scope\n- Storage changes.\n## Scope\nwidget component\n';
  f.live.body = legacy;
  const result = await updateIssue(f.context, { issueNumber: 17 });
  assert.equal(f.comments.length, 1);
  assert.equal(result.conversion?.priorBody, legacy);
  assert.match(result.conversion!.diff, /^--- prior body\n\+\+\+ canonical body/u);
  assert.match(f.comments[0]!.body, /Malformed identifiers reach persistence/u);
  assert.equal(parseIssueBody(result.body, { title: result.title }).issue.legacyBody, legacy);
  const patched = await updateIssue(f.context, {
    issueNumber: 17,
    outcome: 'Reject malformed identifiers with a typed error.',
    preserveHistory: true,
  });
  assert.equal(parseIssueBody(patched.body, { title: patched.title }).issue.acceptanceCriteria.length, 1);
  assert.equal(patched.conversion, undefined);
  assert.equal(f.comments.length, 2);
});

test('legacy replacement updates preserve the actual previous body and diff for canonical and handwritten input', async () => {
  const original = 'Original native legacy bytes, including unclassified operator context.\n';
  for (const replacement of [renderIssueBody(ready()), 'Replacement handwritten context.\n']) {
    const f = fixture();
    f.live.body = original;
    const result = await updateIssue(f.context, { issueNumber: 17, body: replacement, ...ready() });
    assert.equal(f.comments.length, 1);
    assert.ok(f.comments[0]!.body.includes(original));
    assert.equal(result.conversion?.priorBody, original);
    assert.ok(result.conversion!.diff.includes('-' + original.trim()));
    const preserved = parseIssueBody(result.body, { title: result.title }).issue.legacyBody;
    assert.ok(preserved?.includes(original));
    if (!replacement.startsWith(ISSUE_BODY_MARKER)) assert.ok(preserved?.includes(replacement));
    assert.equal(result.conversion?.canonicalBody, result.body);
    const patch = await updateIssue(f.context, {
      issueNumber: 17,
      outcome: 'Reject invalid input before persistence.',
    });
    assert.equal(patch.conversion, undefined);
    assert.equal(f.comments.length, 1);
    assert.equal(parseIssueBody(patch.body, { title: patch.title }).issue.legacyBody, preserved);
  }
});

test('validation, history drift and corrupted native update readback fail without a fabricated success', async () => {
  const f = fixture();
  await assert.rejects(
    updateIssue(f.context, { issueNumber: 17, openQuestions: ['Choose a policy.'] }),
    /open-questions/u,
  );
  assert.equal(f.writes.length, 0);
  assert.equal(f.comments.length, 0);
  f.controls.driftAfterHistory = true;
  await assert.rejects(
    updateIssue(f.context, {
      issueNumber: 17,
      outcome: 'Reject malformed input before all writes.',
      preserveHistory: true,
    }),
    /content changed/u,
  );
  assert.equal(f.writes.length, 0);
  const bad = fixture();
  bad.controls.ignoreBody = true;
  await assert.rejects(
    updateIssue(bad.context, { issueNumber: 17, outcome: 'Reject malformed input before all writes.' }),
    /update readback disagrees/u,
  );
});

test('normal-start canonical retry body keeps exact intent markers through create/readiness', async () => {
  const issue = ready();
  const canonical = canonicalIssueBody(issue);
  const footer =
    '\n\n<!-- ai-delivery-start-intent: ' +
    digestValue({ intent: 'fixture' }) +
    ' -->\n<!-- ai-delivery-start: ' +
    digestValue({ request: 'fixture' }) +
    ' -->';
  const result = await createIssue(fixture().context, {
    title: issue.title,
    body: canonical + footer,
    points: 2,
    issueType: 'Task',
  });
  assert.equal(result.body, canonical + footer);
  assert.deepEqual(parseIssueBody(result.body, { title: issue.title }).issue, issue);
});

test('actual normal-start creation and retry reuse the exact canonical body, branch and authored journal', async () => {
  const f = fixture();
  f.controls.created = false;
  const request = getAiDeliveryMcpTool('issue_start')!.inputSchema.parse({
    title: ready().title,
    body: renderIssueBody(ready()),
    issueType: 'Task',
    points: 2,
    requestId: 'issue68-normal-start',
  });
  const first = await startTrackedIssue(f.context, request);
  assert.ok('issueNumber' in first);
  assert.equal(first.issueNumber, 17);
  assert.ok('reused' in first && first.reused === false);
  const body = f.live.body;
  assert.match(body, /ai-delivery-start-intent: sha256:[a-f0-9]{64}/u);
  assert.match(body, /ai-delivery-start: sha256:[a-f0-9]{64}/u);
  assert.deepEqual(parseIssueBody(body, { title: f.live.title }).issue, ready());
  assert.equal(f.branchWrites.length, 1);
  assert.equal(
    f.branchWrites[0]?.clientMutationId,
    digestValue({ repository: 'example/widget', issueNumber: 17, name: 'issue/17', base: 'a'.repeat(40) }),
  );
  assert.equal(f.comments.length, 1);
  const retry = await startTrackedIssue(f.context, request);
  assert.ok('reused' in retry && retry.reused === true);
  assert.equal(retry.issueNumber, 17);
  assert.equal(f.writes.filter((input) => !('issue_number' in input)).length, 1);
  assert.equal(f.branchWrites.length, 1);
  assert.equal(f.comments.length, 1);
  assert.equal(f.live.body, body);
  await assert.rejects(
    startTrackedIssue(f.context, {
      ...request,
      body: renderIssueBody({ ...ready(), outcome: 'A conflicting new outcome.' }),
    }),
    /conflicts/u,
  );
  assert.equal(f.branchWrites.length, 1);
});

test('a history rewrite refuses to republish secret-bearing prior text', async () => {
  const f = fixture();
  f.live.body = 'An accidental fixture ' + ['gh', 'p_'].join('') + 'A'.repeat(24);
  await assert.rejects(
    updateIssue(f.context, { issueNumber: 17, body: renderIssueBody(ready()), preserveHistory: true }),
    /secrets/u,
  );
  assert.equal(f.comments.length, 0);
  assert.equal(f.writes.length, 0);
});

test('ordinary start checks typed Draft, Points and live eligibility before branch or journal mutation', async () => {
  for (const [expected, change] of [
    [
      'draft',
      (f: ReturnType<typeof fixture>) => {
        f.live.body = renderIssueBody({ ...ready(), draft: true });
      },
    ],
    [
      'points.sync',
      (f: ReturnType<typeof fixture>) => {
        f.controls.livePoints = 4;
      },
    ],
    [
      'blocked',
      (f: ReturnType<typeof fixture>) => {
        f.controls.blockers = true;
      },
    ],
    [
      'tracking-parent',
      (f: ReturnType<typeof fixture>) => {
        f.controls.trackingParent = true;
      },
    ],
  ] as const) {
    const f = fixture();
    change(f);
    await assert.rejects(startTrackedIssue(f.context, { issueNumber: 17 }), (error: unknown) => {
      assert.ok(error instanceof Error);
      const diagnostics = JSON.parse(error.message) as { failures: { code: string; field: string; fixHint: string }[] };
      assert(diagnostics.failures.some((failure) => failure.code === expected && failure.field && failure.fixHint));
      return true;
    });
    assert.equal(f.branchWrites.length, 0);
    assert.equal(f.comments.length, 0);
    assert.equal(f.writes.length, 0);
  }
  const f = fixture();
  f.live.body = renderIssueBody({ ...ready(), outcome: 'Retain the Todo label when validation passes.' });
  const first = await startTrackedIssue(f.context, { issueNumber: 17 });
  assert.ok('reused' in first && first.reused === false);
  assert.ok('reused' in (await startTrackedIssue(f.context, { issueNumber: 17 })));
  assert.equal(f.branchWrites.length, 1);
  assert.equal(f.comments.length, 1);
});

test('joined MCP start modes preserve ordinary input and reject mixed investigation or foreign repository calls before configuration', async () => {
  const schema = getAiDeliveryMcpTool('issue_start')!.inputSchema;
  assert(schema.safeParse({ issueNumber: 17, repo: 'example/widget' }).success);
  assert(
    schema.safeParse({ body: renderIssueBody(ready()), title: ready().title, points: 2, issueType: 'Task' }).success,
  );
  for (const arguments_ of [
    { issueNumber: 17, expectedHeadSha: 'a'.repeat(40) },
    {
      issueNumber: 17,
      investigationWorktree: '/fictional/issue-17',
      expectedHeadSha: 'a'.repeat(40),
      body: renderIssueBody(ready()),
    },
  ])
    assert.equal(schema.safeParse(arguments_).success, false);
  await assert.rejects(
    executeTool(
      'issue_start',
      { repo: 'foreign/widget', issueNumber: 17 },
      { repo: 'example/widget', repoRoot: '/synthetic-non-git' },
    ),
    /selectors disagree/u,
  );
  const finish = getAiDeliveryMcpTool('issue_finish')!.inputSchema;
  assert(finish.safeParse({ issueNumber: 17, prNumber: 23 }).success);
  assert.equal(finish.safeParse({ issueNumber: 17 }).success, false);
  assert.equal(
    finish.safeParse({ issueNumber: 17, investigation: true, resultPath: '/fictional/result', prNumber: 23 }).success,
    false,
  );
});

test('created readiness refusal returns exact retry markers through safe resume and original request retry', async () => {
  const f = fixture();
  f.controls.created = false;
  f.controls.trackingParent = true;
  const schema = getAiDeliveryMcpTool('issue_start')!.inputSchema;
  const request = schema.parse({
    title: ready().title,
    body: renderIssueBody(ready()),
    issueType: 'Task',
    points: 2,
    requestId: 'issue68-readiness-recovery',
  });
  const interrupted = await startTrackedIssue(f.context, request);
  if (interrupted.status !== 'created-not-started') assert.fail('Expected a known-created readiness refusal.');
  assert.equal(interrupted.status, 'created-not-started');
  const nativeBody = f.live.body;
  assert.match(nativeBody, /ai-delivery-start-intent: sha256:[a-f0-9]{64}/u);
  assert.match(nativeBody, /ai-delivery-start: sha256:[a-f0-9]{64}/u);
  assert.equal(interrupted.safeResume.arguments.body, nativeBody);
  assert.equal(f.branchWrites.length, 0);
  assert.equal(f.comments.length, 0);
  assert.equal(f.writes.filter((write) => !('issue_number' in write)).length, 1);

  f.controls.trackingParent = false;
  const resumed = await startTrackedIssue(f.context, schema.parse(interrupted.safeResume.arguments));
  assert.ok('reused' in resumed && resumed.reused === false);
  assert.equal(f.live.body, nativeBody);
  const retry = await startTrackedIssue(f.context, request);
  assert.ok('reused' in retry && retry.reused === true);
  assert.equal(f.live.body, nativeBody);
  assert.equal(f.writes.filter((write) => !('issue_number' in write)).length, 1);
  assert.equal(f.branchWrites.length, 1);
  assert.equal(f.comments.length, 1);
});

test('actual compiled stdio MCP returns every Ready diagnostic before credentials and refuses a foreign caller repo', async () => {
  const root = mkdtempSync(join(tmpdir(), 'issue-contract-stdio-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/cli.js'), '--identity', 'host-author', '--repo', 'example/widget', 'mcp:serve'],
    cwd: root,
    stderr: 'pipe',
    env: {
      HOME: root,
      PATH: process.env.PATH ?? '',
      AI_DELIVERY_CONFIG: join(root, 'missing-config.json'),
      LANG: 'en_US.UTF-8',
    },
  });
  const client = new Client({ name: 'issue68-synthetic-client', version: '1.0.0' });
  let spawnedPid: number | null = null;
  let closeObserved = false;
  try {
    await client.connect(transport);
    spawnedPid = transport.pid;
    assert.ok(spawnedPid);
    const original = transport.onclose;
    transport.onclose = () => {
      closeObserved = true;
      original?.();
    };
    const listing = await client.listTools();
    assert.ok(listing.tools.find((t) => t.name === 'issue_create')?.inputSchema.properties?.acceptanceCriteria);
    const result = await client.callTool({
      name: 'issue_create',
      arguments: { ...ready(), points: 13, openQuestions: ['Select behavior.'] },
    });
    assert.equal(result.isError, true);
    const content = z.array(z.object({ type: z.literal('text'), text: z.string() })).parse(result.content);
    const diagnostic = z
      .object({
        contract: z.literal('ai-delivery.issue@1'),
        failures: z.array(z.object({ code: z.string(), field: z.string(), fixHint: z.string() })),
      })
      .parse(JSON.parse(content[0]!.text) as unknown);
    assert.deepEqual(diagnostic.failures.map((f) => f.code).sort(), ['open-questions', 'points']);
    assert.ok(diagnostic.failures.every((f) => f.field && f.fixHint));
    for (const name of ['issue_create', 'issue_update']) {
      const malformed = await client.callTool({
        name,
        arguments: {
          ...ready(),
          ...(name === 'issue_update' ? { issueNumber: 17 } : {}),
          acceptanceCriteria: [{ behavior: ready().acceptanceCriteria[0]!.behavior }],
          context: { components: 9 },
        },
      });
      assert.equal(malformed.isError, true);
      const blocks = z.array(z.object({ type: z.literal('text'), text: z.string() })).parse(malformed.content);
      const failure = z
        .object({
          contract: z.literal('ai-delivery.issue@1'),
          failures: z.array(z.object({ code: z.string(), field: z.string(), fixHint: z.string() })),
        })
        .parse(JSON.parse(blocks[0]!.text) as unknown);
      assert.deepEqual(failure.failures.map((f) => f.field).sort(), [
        'acceptanceCriteria.0.verifiedBy',
        'context.components',
      ]);
      assert.ok(failure.failures.every((f) => f.code && f.fixHint));
      assert.doesNotMatch(blocks[0]!.text, /missing-config/u);
      const unknown = await client.callTool({
        name,
        arguments: {
          ...ready(),
          ...(name === 'issue_update' ? { issueNumber: 17 } : {}),
          unexpectedField: 'Root field must be refused.',
          context: { ...ready().context, unexpectedField: 'Nested field must be refused.' },
          acceptanceCriteria: [{ ...ready().acceptanceCriteria[0]!, unexpectedField: 'Unknown criterion field.' }],
        },
      });
      assert.equal(unknown.isError, true);
      const unknownBlocks = z.array(z.object({ type: z.literal('text'), text: z.string() })).parse(unknown.content);
      const unknownFailure = z
        .object({
          contract: z.literal('ai-delivery.issue@1'),
          failures: z.array(z.object({ code: z.literal('field.unknown'), field: z.string(), fixHint: z.string() })),
        })
        .parse(JSON.parse(unknownBlocks[0]!.text) as unknown);
      assert.deepEqual(unknownFailure.failures.map((f) => f.field).sort(), [
        'acceptanceCriteria.0',
        'context',
        'issue',
      ]);
      assert.ok(unknownFailure.failures.every((f) => f.fixHint.length > 10));
      assert.doesNotMatch(
        unknownBlocks[0]!.text,
        /unexpectedField|Nested field|Unknown criterion/u,
        'Diagnostics do not echo untrusted keys or values.',
      );
    }
    const foreign = await client.callTool({ name: 'issue_create', arguments: { ...ready(), repo: 'other/widget' } });
    assert.equal(foreign.isError, true);
    assert.match(JSON.stringify(foreign.content), /repository selectors disagree/u);
  } finally {
    await client.close();
    assert.equal(closeObserved, true, 'SDK spawned-child close event was actually observed');
    rmSync(root, { recursive: true, force: true });
    console.info(
      JSON.stringify({
        fixture: 'issue68-compiled-stdio',
        spawnedPid,
        childCloseObserved: closeObserved,
        syntheticRootRemoved: true,
      }),
    );
  }
});

test('intake skill example is Ready and every CLI line has actual required options and an explicit identity', () => {
  const skill = readFileSync(resolve('plugins/ai-delivery/skills/intake-create/SKILL.md'), 'utf8');
  const json = /```json\n([\s\S]*?)\n```/u.exec(skill)?.[1];
  assert.ok(json);
  assert.ok(ReadyIssue.safeParse(JSON.parse(json) as unknown).success);
  const root = mkdtempSync(join(tmpdir(), 'intake-cli-'));
  try {
    const fields = join(root, 'issue.json');
    writeFileSync(fields, json);
    for (const line of skill.split('\n').filter((line) => line.startsWith('ai-delivery '))) {
      assert.match(line, /--identity host-author/u);
      assert.match(line, /--repo example\/widget/u);
      const argv = (line.match(/'[^']*'|[^\s]+/gu) ?? [])
        .slice(1)
        .map((token) => token.replace(/^'|'$/gu, ''))
        .map((token) => token.replace('/owned/issue.json', fields));
      const command = argv.find((token) => ['create', 'update', 'info', 'ready:check', 'start'].includes(token));
      assert.ok(command);
      assert.ok(argv.includes(command === 'create' ? '--title' : '--issue'));
      const result = spawnSync(process.execPath, [resolve('dist/cli.js'), ...argv], {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: root,
          AI_DELIVERY_CONFIG: join(root, 'missing-config.json'),
          LANG: 'en_US.UTF-8',
        },
        encoding: 'utf8',
      });
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stderr, /unknown option|unknown command|required option/u);
      assert.match(result.stderr, /missing-config|ENOENT|identity|configuration|config/iu);
    }
    const missing = spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), '--identity', 'host-author', '--repo', 'example/widget', 'create'],
      { cwd: root, env: { HOME: root, PATH: process.env.PATH ?? '' }, encoding: 'utf8' },
    );
    assert.match(missing.stderr, /required option.*--title/u);
    assert.ok(
      execFileSync(process.execPath, [resolve('dist/cli.js'), '--help'], {
        env: { HOME: root, PATH: process.env.PATH ?? '' },
        encoding: 'utf8',
      }).includes('create'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.ok(skill.includes(ISSUE_BODY_MARKER));
  assert.ok(!skill.includes('ai-delivery develop'));
});

test('explicit start changes Todo to the configured In Progress option and preserves unrelated items', async () => {
  const f = fixture();
  const result = await startTrackedIssue(f.context, { issueNumber: 17 });
  assert.ok('branch' in result);
  assert.equal(f.getStatus(), 'Active');
  assert.equal(f.statusWrites.length, 1);
  assert.deepEqual(f.statusWrites[0], {
    projectId: 'PROJECT',
    itemId: 'ITEM17',
    fieldId: 'STATUS',
    optionId: 'ACTIVE',
  });
  assert.equal(f.comments.length, 1);
  const retry = await startTrackedIssue(f.context, { issueNumber: 17 });
  assert.ok('reused' in retry && retry.reused);
  assert.equal(f.branchWrites.length, 1);
  assert.equal(f.statusWrites.length, 1);
  assert.equal(f.comments.length, 1);
});

test('explicit start adds missing membership only for its exact issue and accepts already active status', async () => {
  for (const member of [true, false]) {
    const f = fixture();
    f.controls.projectMember = member;
    if (member) f.setStatus('Active');
    assert.ok('branch' in (await startTrackedIssue(f.context, { issueNumber: 17 })));
    assert.equal(f.getStatus(), 'Active');
    assert.equal(f.membershipWrites.length, member ? 0 : 1);
    assert.equal(f.statusWrites.length, member ? 0 : 1);
  }
});

test.each(['before', 'after', 'readback'] as const)(
  'existing start returns known-issue recovery for Project %s failure',
  async (failure) => {
    const f = fixture();
    f.controls.projectFailure = failure;
    const result = await startTrackedIssue(f.context, { issueNumber: 17 });
    if (!('status' in result)) assert.fail('Project failure must not report successful start');
    assert.equal(result.status, 'start-incomplete');
    assert.equal(result.failure.phase, 'project-status');
    assert.equal(result.safeResume.arguments.issueNumber, 17);
    assert.equal(result.safeResume.arguments.repo, 'example/widget');
    assert.equal((result.safeResume.arguments as Record<string, unknown>).branch, 'issue/17');
    assert.equal(f.comments.length, 0);
    f.controls.projectFailure = '';
    const resumed = await startTrackedIssue(
      f.context,
      getAiDeliveryMcpTool('issue_start')!.inputSchema.parse(result.safeResume.arguments),
    );
    assert.ok('reused' in resumed && resumed.reused);
    assert.equal(f.getStatus(), 'Active');
    assert.equal(f.branchWrites.length, 1);
    assert.equal(f.comments.length, 1);
    assert.equal(f.writes.length, 0);
    assert.equal(f.statusWrites.length, failure === 'before' ? 2 : 1);
  },
);

test.each(['branch', 'journal'] as const)(
  'existing start reconciles a lost %s response without duplicate mutations',
  async (failure) => {
    const f = fixture();
    f.controls.branchFailure = failure === 'branch';
    f.controls.journalFailure = failure === 'journal';
    const result = await startTrackedIssue(f.context, { issueNumber: 17 });
    if (!('status' in result)) assert.fail('An uncertain start must retain recovery');
    assert.equal(result.status, 'start-incomplete');
    f.controls.branchFailure = false;
    f.controls.journalFailure = false;
    assert.ok('reused' in (await startTrackedIssue(f.context, result.safeResume.arguments)));
    assert.equal(f.branchWrites.length, 1);
    assert.equal(f.comments.length, 1);
    assert.equal(f.getStatus(), 'Active');
  },
);

test('created start retains its exact issue recovery when Project synchronization fails', async () => {
  const f = fixture();
  f.controls.created = false;
  f.controls.projectFailure = 'before';
  const request = {
    title: ready().title,
    body: renderIssueBody(ready()),
    issueType: 'Task',
    points: 2,
    requestId: 'project-recovery',
  };
  const result = await startTrackedIssue(f.context, request);
  if (!('status' in result)) assert.fail('Expected created recovery');
  assert.equal(result.status, 'created-not-started');
  assert.equal(result.failure.phase, 'project-status');
  f.controls.projectFailure = '';
  assert.ok('reused' in (await startTrackedIssue(f.context, result.safeResume.arguments)));
  assert.equal(f.branchWrites.length, 1);
  assert.equal(f.comments.length, 1);
  assert.equal(f.writes.filter((write) => !('issue_number' in write)).length, 1);
  assert.equal(f.getStatus(), 'Active');
});

test.each(['closed', 'blocked', 'parked', 'archived'] as const)(
  'start recovery refuses current %s truth before Project or journal writes',
  async (state) => {
    const f = fixture();
    f.controls.branchFailure = true;
    const result = await startTrackedIssue(f.context, { issueNumber: 17 });
    if (result.status !== 'start-incomplete') assert.fail('Expected recovery');
    f.controls.branchFailure = false;
    if (state === 'closed') f.live.state = 'closed';
    if (state === 'blocked') f.controls.blockers = true;
    if (state === 'parked') f.live.body = renderIssueBody({ ...ready(), draft: true });
    if (state === 'archived') f.controls.projectArchived = true;
    const retry = await startTrackedIssue(f.context, result.safeResume.arguments).catch((error: unknown) => {
      assert.ok(error instanceof Error);
      return undefined;
    });
    assert.ok(retry === undefined || 'status' in retry, 'Current refusal must not report success');
    assert.equal(f.branchWrites.length, 1);
    assert.equal(f.statusWrites.length, 0);
    assert.equal(f.comments.length, 0);
  },
);

test.each(['closeAfterBranch', 'blockAfterBranch'] as const)(
  'start rechecks live eligibility after %s before changing the board',
  async (control) => {
    const f = fixture();
    f.controls[control] = true;
    const result = await startTrackedIssue(f.context, { issueNumber: 17 });
    assert.ok('status' in result);
    assert.equal(f.statusWrites.length, 0);
    assert.equal(f.comments.length, 0);
  },
);

async function bindStartFixture(f: ReturnType<typeof fixture>) {
  const settings = await import('./config/deliveryConfig.js');
  const issues = await import('./issue.js');
  vi.spyOn(settings, 'loadDeliverySettings').mockResolvedValue({
    roles: { author: { identity: 'author', authSource: 'personal' }, reviewer: { identity: 'reviewer' } },
  } as unknown as Awaited<ReturnType<typeof settings.loadDeliverySettings>>);
  vi.spyOn(issues, 'loadDeliveryContext').mockResolvedValue(f.context);
}

test('MCP explicit start returns Project recovery and reuses the exact branch on retry', async () => {
  const f = fixture();
  await bindStartFixture(f);
  f.controls.projectFailure = 'after';
  const server = createAiDeliveryMcpServer({ repoRoot: '/unrelated' });
  const client = new Client({ name: 'fictional-start-project', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = async (arguments_: Record<string, unknown>) => {
      const reply = await client.callTool({ name: 'issue_start', arguments: arguments_ });
      assert.equal(reply.isError, undefined);
      return JSON.parse(
        z.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string() })) }).parse(reply).content[0]!
          .text,
      ) as {
        status?: string;
        issueNumber: number;
        branch?: string;
        safeResume?: { arguments: Record<string, unknown> };
      };
    };
    const interrupted = await call({ repo: 'example/widget', issueNumber: 17 });
    assert.equal(interrupted.status, 'start-incomplete');
    assert.ok(interrupted.safeResume);
    assert.equal(f.comments.length, 0);
    f.controls.projectFailure = '';
    const result = await call(interrupted.safeResume.arguments);
    assert.equal(result.branch, 'issue/17');
    assert.equal(result.issueNumber, 17);
    assert.equal(f.getStatus(), 'Active');
    assert.equal(f.statusWrites.length, 1);
    assert.equal(f.branchWrites.length, 1);
    assert.equal(f.comments.length, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test.each(['success', 'failure'] as const)(
  'CLI explicit start shares Project transition and %s output',
  async (mode) => {
    vi.resetModules();
    const f = fixture();
    await bindStartFixture(f);
    if (mode === 'failure') f.controls.projectFailure = 'before';
    const argv = process.argv;
    const exitCode = process.exitCode;
    let stdout = '';
    let completed: () => void = () => {};
    const output = new Promise<void>((resolve) => {
      completed = resolve;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((value) => {
      stdout += String(value);
      if (String(value).startsWith('{')) completed();
      return true;
    });
    try {
      process.exitCode = undefined;
      process.argv = [process.execPath, 'ai-delivery', '--repo', 'example/widget', 'start', '--issue', '17'];
      await import('./cli.js');
      await output;
      const result = JSON.parse(stdout) as {
        status?: string;
        branch?: string;
        safeResume?: { arguments: { issueNumber: number } };
      };
      if (mode === 'failure') {
        assert.equal(result.status, 'start-incomplete');
        assert.equal(result.safeResume?.arguments.issueNumber, 17);
        assert.equal(process.exitCode, 1);
        assert.equal(f.getStatus(), 'Queued');
        assert.equal(f.comments.length, 0);
      } else {
        assert.equal(result.branch, 'issue/17');
        assert.equal(process.exitCode, undefined);
        assert.equal(f.getStatus(), 'Active');
        assert.equal(f.comments.length, 1);
      }
      assert.equal(f.branchWrites.length, 1);
      assert.equal(f.statusWrites.length, 1);
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
    }
  },
);

test('info and unrelated body edits never imply explicit activation', async () => {
  const f = fixture();
  const { issueInfo } = await import('./issue.js');
  await issueInfo(f.context, 17);
  await updateIssue(f.context, {
    issueNumber: 17,
    outcome: 'Reject invalid widgets while retaining deferred execution.',
  });
  assert.equal(f.getStatus(), 'Queued');
  assert.equal(f.statusWrites.length, 0);
  assert.equal(f.branchWrites.length, 0);
  assert.equal(f.comments.length, 0);
});
