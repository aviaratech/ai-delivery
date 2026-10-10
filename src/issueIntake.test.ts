import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { createIssue, updateIssue, canonicalIssueBody, type DeliveryContext } from './issue.js';
import { startTrackedIssue } from './dispatch.js';
import { digestValue } from './delivery/common.js';
import { getAiDeliveryMcpTool } from './mcp/tools.js';
import { IssueFields, ReadyIssue, renderIssueBody, parseIssueBody, ISSUE_BODY_MARKER } from './issueContract.js';
import { syntheticDiscoveryConfig } from './fixtures/discovery.js';

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
  };
  const branchWrites: Record<string, unknown>[] = [];
  const branches: { name: string; sha: string }[] = [];
  let points = 2;
  let status = 'Queued';
  const values = () => [
    { issue_field_id: 101, issue_field_name: 'Estimate', data_type: 'single_select', value: String(points) },
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
          return { createLinkedBranch: { linkedBranch: { ref: { name: fields.name, target: { oid: fields.oid } } } } };
        }
        if (query.includes('blockedBy(first:'))
          return {
            repository: {
              issue: { parent: null, blockedBy: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
            },
          };
        if (query.includes('ProjectDeliveryItems'))
          return {
            organization: {
              projectV2: {
                items: {
                  nodes: [
                    {
                      id: 'ITEM17',
                      isArchived: false,
                      content: { id: 'ISSUE17' },
                      fieldValueByName: { name: status, optionId: status === 'Queued' ? 'TODO' : 'ACTIVE' },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          };
        if (query.includes('UpdateProjectDeliveryStatus')) {
          status = input.optionId === 'TODO' ? 'Queued' : input.optionId === 'DONE' ? 'Shipped' : 'Active';
          return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'ITEM17' } } };
        }
        if (query.includes('ProjectDeliveryItemReadback'))
          return {
            node: {
              id: 'ITEM17',
              isArchived: false,
              project: { id: 'PROJECT', number: 1 },
              content: { id: 'ISSUE17' },
              fieldValueByName: { name: status, optionId: status === 'Queued' ? 'TODO' : 'ACTIVE' },
            },
          };
        throw new Error('Unexpected native query ' + query);
      },
    },
  } as unknown as DeliveryContext;
  return { context, live, writes, comments, controls, branchWrites, getStatus: () => status };
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
