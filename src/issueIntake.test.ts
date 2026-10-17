import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import {
  createIssue,
  updateIssue,
  canonicalIssueBody,
  renderIssueHistory,
  readyCheck,
  issueInfo,
  listIssues,
  type DeliveryContext,
} from './issue.js';
import { executeTool, startTrackedIssue } from './dispatch.js';
import { digestValue } from './delivery/common.js';
import { getAiDeliveryMcpTool } from './mcp/tools.js';
import { IssueFields, ReadyIssue, renderIssueBody, parseIssueBody, ISSUE_BODY_MARKER } from './issueContract.js';
import { syntheticDiscoveryConfig } from './fixtures/discovery.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test('create renders all five status fields with a UTC timestamp and optional milestone', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-16T20:30:00Z'));
  for (const draft of [false, true]) {
    const f = fixture();
    const input = { ...ready(), draft, status: { nextMilestone: 'Run checks' } };
    const result = await createIssue(f.context, input);
    const status = result.body.split('## Status\n\n')[1]!.split('\n\n## Problem')[0];
    assert.equal(
      status,
      `- **State:** ${draft ? 'Draft' : 'Ready'}\n- **Last updated:** 2026-10-16T20:30:00.000Z UTC\n- **Next milestone:** Run checks\n- **Blockers:** None\n- **Latest journal:** None yet`,
    );
  }
  const f = fixture();
  assert.match((await createIssue(f.context, ready())).body, /\*\*Next milestone:\*\* Not started/u);
});

test('status-only patches preserve every outside-Status byte including canonical data and start markers', async () => {
  const f = fixture();
  const created = await createIssue(f.context, ready());
  f.live.body =
    created.body +
    '\n\n<!-- ai-delivery-start-intent: sha256:' +
    'a'.repeat(64) +
    ' -->\n<!-- ai-delivery-start: sha256:' +
    'b'.repeat(64) +
    ' -->';
  const before = f.live.body;
  const patch = { issueNumber: 17, status: { nextMilestone: 'Await review', blockers: 'None' } };
  const result = await updateIssue(f.context, patch);
  const outside = (body: string) => body.replace(/(## Status\n\n)[\s\S]*?(\n\n## Problem)/u, '$1$2');
  assert.match(result.body, /\*\*Next milestone:\*\* Await review/u);
  assert.equal(outside(result.body), outside(before));
  assert.equal((await updateIssue(f.context, patch)).body, result.body);
  assert.equal(f.comments.length, 0);
});

test('legacy rendering drops only by explicit retention choice or verified history and does not grow on repeat', async () => {
  const legacy = 'Retired criterion: accept every invalid identifier.\n';
  for (const preserveHistory of [undefined, false, true]) {
    const f = fixture();
    f.live.body = renderIssueBody({ ...ready(), legacyBody: legacy });
    const before = f.live.body;
    const result = await updateIssue(f.context, {
      issueNumber: 17,
      ...(preserveHistory === undefined ? {} : { preserveHistory }),
    });
    const readable = result.body.split('<!-- ai-delivery:issue-data@1 ')[0]!;
    assert.equal(readable.includes(legacy), preserveHistory === false);
    assert.equal(f.comments.length, preserveHistory === false ? 0 : 1);
    if (preserveHistory !== false) {
      const retained = f.comments[0]!.body.match(/Body:\n<pre>([\s\S]*)<\/pre>/u)![1]!
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&amp;', '&');
      assert.equal(retained, before);
    }
    const again = await updateIssue(f.context, {
      issueNumber: 17,
      ...(preserveHistory === undefined ? {} : { preserveHistory }),
    });
    assert.equal(again.body, result.body);
    assert.equal(f.comments.length, preserveHistory === false ? 0 : 1);
  }
  const f = fixture();
  f.live.body = renderIssueBody({ ...ready(), legacyBody: legacy });
  const drop = { issueNumber: 17, preserveHistory: false, retainLegacyBody: false };
  const result = await updateIssue(f.context, drop);
  assert.ok(!result.body.split('<!-- ai-delivery:issue-data@1 ')[0]!.includes(legacy));
  assert.equal(f.comments.length, 0);
});

test('replacement legacy text remains visible until those incoming bytes have native history', async () => {
  const f = fixture();
  f.live.body = 'Original operator text.\n';
  const incoming = 'New operator text that was never in the previous body.\n';
  const result = await updateIssue(f.context, { issueNumber: 17, body: incoming, ...ready(), preserveHistory: true });
  assert.ok(result.body.split('<!-- ai-delivery:issue-data@1 ')[0]!.includes(incoming));
  assert.ok(!f.comments[0]!.body.includes(incoming));
});

test('default render omission reuses an existing exact authored history snapshot', async () => {
  const f = fixture();
  f.live.body = renderIssueBody({ ...ready(), legacyBody: 'Retired synthetic criterion.\n' });
  const before = f.live.body;
  const history = renderIssueHistory(f.live.title, before);
  f.comments.push({
    id: 91,
    body: history,
    html_url: 'https://github.com/example/widget/issues/17#issuecomment-91',
    user: { login: 'operator' },
    issue_url: 'https://api.github.com/repos/example/widget/issues/17',
  });
  const result = await updateIssue(f.context, { issueNumber: 17 });
  assert.equal(result.historyComment?.reused, true);
  assert.equal(f.comments.length, 1);
  assert.equal(f.comments[0]!.body, history);
  assert.ok(!result.body.split('<!-- ai-delivery:issue-data@1 ')[0]!.includes('Retired synthetic criterion.'));
});

test('normal-start recovery preserves legacy rendering across repeated exact retries', async () => {
  const f = fixture();
  f.controls.created = false;
  const request = getAiDeliveryMcpTool('issue_start')!.inputSchema.parse({
    title: ready().title,
    body: renderIssueBody({ ...ready(), legacyBody: 'Original operator context.\n' }),
    issueType: 'Task',
    points: 2,
    requestId: 'legacy-status-retry',
  });
  await startTrackedIssue(f.context, request);
  const before = f.live.body;
  for (let retry = 0; retry < 2; retry++) {
    const result = await startTrackedIssue(f.context, request);
    assert.ok('reused' in result && result.reused);
    assert.equal(f.live.body, before);
  }
  assert.equal(f.writes.filter((input) => !('issue_number' in input)).length, 1);
  assert.equal(f.comments.length, 1);
});

test.each([{ points: 4 }, { issueType: 'Feature' }])(
  'normal-start retry refuses changed contract metadata %j before native writes',
  async (patch) => {
    const f = fixture();
    f.controls.created = false;
    f.context.config = { ...f.context.config, native: { ...f.context.config.native, issueTypes: ['Task', 'Feature'] } };
    const request = getAiDeliveryMcpTool('issue_start')!.inputSchema.parse({
      title: ready().title,
      body: renderIssueBody(ready()),
      issueType: 'Task',
      points: 2,
      requestId: 'contract-metadata-retry',
    });
    await startTrackedIssue(f.context, request);
    await updateIssue(f.context, { issueNumber: 17, ...patch });
    const before = f.live.body;
    const writes = f.writes.length;
    const comments = f.comments.length;
    await assert.rejects(startTrackedIssue(f.context, request), /conflicts/u);
    assert.equal(f.live.body, before);
    assert.equal(f.writes.length, writes);
    assert.equal(f.comments.length, comments);
  },
);

test('default legacy omission refuses drift between preparation and the history snapshot', async () => {
  const f = fixture();
  f.live.body = renderIssueBody({ ...ready(), legacyBody: 'Original unpreserved legacy bytes.\n' });
  f.controls.driftBeforeUpdate = true;
  await assert.rejects(updateIssue(f.context, { issueNumber: 17 }), /content changed/u);
  assert.equal(f.live.body, 'Concurrent operator edit');
  assert.equal(f.comments.length, 0);
  assert.equal(f.writes.length, 0);
});

test('status-only updates preserve embedded metadata and old formatting despite different native metadata', async () => {
  const f = fixture();
  const data = {
    ...ready(),
    acceptanceCriteria: [{ behavior: 'Reject malformed input:\n- Empty input', verifiedBy: 'Regression test.' }],
  };
  f.live.body =
    renderIssueBody(data).replace('  - Empty input\n\n  Verified', '- Empty input\n  Verified') +
    '\n\n<!-- ai-delivery-start-intent: sha256:' +
    'a'.repeat(64) +
    ' -->\n<!-- ai-delivery-start: sha256:' +
    'b'.repeat(64) +
    ' -->';
  f.controls.livePoints = 4;
  f.live.type.name = 'Feature';
  const before = f.live.body;
  const patch = { issueNumber: 17, status: { nextMilestone: 'Await review' } };
  const result = await updateIssue(f.context, patch);
  const outside = (body: string) => body.replace(/(## Status\n\n)[\s\S]*?(\n\n## Problem)/u, '$1$2');
  assert.equal(outside(result.body), outside(before));
  assert.equal(f.controls.livePoints, 4);
  assert.equal(f.live.type.name, 'Feature');
  assert.equal(f.writes.length, 1);
  assert.deepEqual(Object.keys(f.writes[0]!).sort(), ['body', 'issue_number', 'owner', 'repo']);
});

test('status patches reject secrets, multiline and unknown fields without native writes', async () => {
  for (const status of [
    { nextMilestone: 'password=' + 'X'.repeat(16) },
    { nextMilestone: 'Next\n## Problem' },
    { unknown: 'unexpected' },
  ]) {
    const f = fixture();
    const patch = { issueNumber: 17, status };
    await assert.rejects(updateIssue(f.context, patch));
    assert.equal(f.writes.length, 0);
    assert.equal(f.comments.length, 0);
  }
});

test('status-only patches refuse concurrent native body drift before overwriting it', async () => {
  const f = fixture();
  f.controls.driftBeforeUpdate = true;
  const patch = { issueNumber: 17, status: { nextMilestone: 'Await review' } };
  await assert.rejects(updateIssue(f.context, patch), /content changed/u);
  assert.equal(f.live.body, 'Concurrent operator edit');
  assert.equal(f.writes.length, 0);
});

test('CLI typed field files reach status privacy validation before configuration', () => {
  const root = mkdtempSync(join(tmpdir(), 'delivery130-status-'));
  try {
    const file = join(root, 'fields.json');
    writeFileSync(file, JSON.stringify({ ...ready(), status: { nextMilestone: 'password=' + 'X'.repeat(16) } }));
    const result = spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), '--repo', 'example/widget', 'create', '--title', ready().title, '--fields-file', file],
      { encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Remove credentials and private keys from public status fields/u);
    assert.ok(!result.stderr.includes('X'.repeat(16)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status updates retain old multiline canonical formatting and reject ambiguous status blocks', async () => {
  const f = fixture();
  const data = {
    ...ready(),
    acceptanceCriteria: [{ behavior: 'Reject malformed input:\n- Empty input', verifiedBy: 'Regression test.' }],
  };
  f.live.body = renderIssueBody(data).replace('  - Empty input\n\n  Verified', '- Empty input\n  Verified');
  const before = f.live.body.split('\n\n## Problem')[1];
  const patch = { issueNumber: 17, status: { nextMilestone: '<literal> *text* [link]' } };
  const result = await updateIssue(f.context, patch);
  assert.equal(result.body.split('\n\n## Problem')[1], before);
  assert.match(result.body, /&lt;literal&gt; \\\*text\\\* \\\[link\\\]/u);
  f.live.body = result.body.replace('- **Blockers:** None', '- **Blockers:** None\n- **Blockers:** Other');
  const writes = f.writes.length;
  await assert.rejects(updateIssue(f.context, patch), /unambiguous status/u);
  assert.equal(f.writes.length, writes);
});

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
    updated_at: '2026-01-01T00:00:00Z',
    labels: [] as string[],
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
    driftBeforeUpdate: false,
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
    capacityMode: false,
    growAfterBranch: false,
    incompleteCapacity: false,
    corruptCapacityComment: false,
    capacityPageSize: 0,
  };
  const capacity: { number: number; label: string; value: string; status: string }[] = [];
  const branchWrites: Record<string, unknown>[] = [];
  const branches: { name: string; sha: string }[] = [];
  let points = 2;
  let status = 'Queued';
  const statusWrites: Record<string, unknown>[] = [];
  const membershipWrites: Record<string, unknown>[] = [];
  let issueReads = 0;
  const optionId = () => ({ Queued: 'TODO', Active: 'ACTIVE', Waiting: 'BLOCKED', Shipped: 'DONE' })[status];
  const values = (number = 17) => [
    {
      issue_field_id: 101,
      issue_field_name: 'Estimate',
      data_type: 'single_select',
      value: String(controls.livePoints),
      single_select_option: { name: String(controls.livePoints) },
    },
    ...(controls.capacityMode
      ? [
          {
            issue_field_id: 102,
            issue_field_name: 'Urgency',
            data_type: 'single_select',
            single_select_option: {
              name: number === 17 ? 'High' : (capacity.find((x) => x.number === number)?.value ?? 'Low'),
            },
          },
          {
            issue_field_id: 103,
            issue_field_name: 'Tags',
            data_type: 'multi_select',
            multi_select_options: [{ name: '0' }],
          },
        ]
      : []),
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
          get: async (input: { issue_number: number }) => {
            if (controls.driftBeforeUpdate && ++issueReads > 1) live.body = 'Concurrent operator edit';
            if (controls.capacityMode && input.issue_number !== 17) {
              const row = capacity.find((x) => x.number === input.issue_number)!;
              return {
                data: {
                  ...live,
                  number: row.number,
                  node_id: 'ISSUE' + String(row.number),
                  labels: [row.label],
                  html_url: 'https://github.com/example/widget/issues/' + String(row.number),
                },
              };
            }
            return { data: { ...live } };
          },
          listLabelsForRepo: async () => ({ data: [{ name: 'critical' }, { name: 'other' }] }),
          listForRepo: async (input: { page?: number; per_page?: number }) => ({
            headers:
              controls.capacityPageSize && (input.page ?? 1) === 1
                ? { link: '<https://api.github.com/repos/example/widget/issues?page=2&per_page=100>; rel="next"' }
                : {},
            data: controls.capacityMode
              ? (controls.incompleteCapacity
                  ? []
                  : [
                      { ...live },
                      ...capacity.map((x) => ({
                        ...live,
                        number: x.number,
                        node_id: 'ISSUE' + String(x.number),
                        labels: [x.label],
                        html_url: 'https://github.com/example/widget/issues/' + String(x.number),
                      })),
                    ]
                ).slice(
                  ((input.page ?? 1) - 1) * (controls.capacityPageSize || input.per_page || 100),
                  (input.page ?? 1) * (controls.capacityPageSize || input.per_page || 100),
                )
              : controls.created
                ? [{ ...live }]
                : [],
          }),
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
            const found = comments.find((c) => c.id === input.comment_id);
            return {
              data: controls.corruptCapacityComment && found ? { ...found, user: { login: 'foreign-writer' } } : found,
            };
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
                ...(controls.capacityMode ? [{ id: 103, name: 'Tags', data_type: 'multi_select' }] : []),
              ],
            };
          if (route.startsWith('POST ')) {
            const fields = input.issue_field_values as { field_id: number; value: string }[];
            points = Number(fields.find((f) => f.field_id === 101)?.value ?? points);
            controls.livePoints = points;
            return { data: values() };
          }
          if (route.startsWith('GET ')) return { data: values(Number(input.issue_number ?? 17)) };
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
          if (controls.growAfterBranch)
            capacity.push({ number: 99, label: 'critical', value: 'High', status: 'Active' });
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
                id: 'PROJECT',
                number: 1,
                items: {
                  nodes: [
                    ...capacity.map((x) => ({
                      id: 'ITEM' + String(x.number),
                      isArchived: false,
                      content: { id: 'ISSUE' + String(x.number) },
                      fieldValueByName:
                        x.status === 'Unset'
                          ? null
                          : x.status === 'Missing'
                            ? undefined
                            : { name: x.status, optionId: x.status === 'Active' ? 'ACTIVE' : 'TODO' },
                    })),
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
        if (query.includes('ProjectDeliveryItemReadback')) {
          const number = Number(String(input.itemId).replace('ITEM', ''));
          const selected = number === 17 ? status : capacity.find((x) => x.number === number)?.status;
          return {
            node: {
              id: input.itemId,
              isArchived: false,
              project: { id: 'PROJECT', number: 1 },
              content: {
                id:
                  status === 'Active' && controls.projectFailure === 'readback'
                    ? 'OTHER-ISSUE'
                    : 'ISSUE' + String(number),
              },
              fieldValueByName:
                selected === 'Unset'
                  ? null
                  : selected === 'Missing'
                    ? undefined
                    : {
                        name: selected,
                        optionId: number === 17 ? optionId() : selected === 'Active' ? 'ACTIVE' : 'TODO',
                      },
            },
          };
        }
        throw new Error('Unexpected native query ' + query);
      },
    },
  } as unknown as DeliveryContext;
  return {
    context,
    capacity,
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

test('manual deferral survives other updates and past dates, appears in reads, and blocks all start writes', async () => {
  const f = fixture();
  const footer =
    '\n\n<!-- ai-delivery-start-intent: sha256:' +
    'a'.repeat(64) +
    ' -->\n<!-- ai-delivery-start: sha256:' +
    'b'.repeat(64) +
    ' -->';
  f.live.body += footer;
  const condition = { until: '2020-01-01', trigger: 'Upstream ships the prerequisite.' };
  const patch = getAiDeliveryMcpTool('issue_update')!.inputSchema.parse({ issueNumber: 17, defer: condition });
  const deferred = await updateIssue(f.context, patch as unknown as Parameters<typeof updateIssue>[1]);
  assert.deepEqual(Reflect.get(deferred, 'deferred'), condition);
  assert.deepEqual(Reflect.get(await issueInfo(f.context, 17), 'deferred'), condition);
  assert.deepEqual(Reflect.get((await listIssues(f.context, {})).issues[0]!, 'deferred'), condition);
  const saved = parseIssueBody(deferred.body, { title: f.live.title }).issue;
  assert.ok(deferred.body.endsWith(footer));
  assert.deepEqual(Reflect.get(saved, 'deferral'), condition);
  assert.match(deferred.body, /Deferred/u);
  assert.equal((await readyCheck(f.context, 17)).ready, false);
  await updateIssue(f.context, { issueNumber: 17, status: { nextMilestone: 'Wait for upstream' } });
  assert.deepEqual(Reflect.get(await issueInfo(f.context, 17), 'deferred'), condition);
  assert.ok(f.live.body.endsWith(footer));
  const writes = f.writes.length;
  const comments = f.comments.length;
  await assert.rejects(startTrackedIssue(f.context, { issueNumber: 17 }), /deferred|undefer/iu);
  assert.equal(f.branchWrites.length, 0);
  assert.equal(f.statusWrites.filter((x) => x.optionId === 'ACTIVE').length, 0);
  assert.equal(f.writes.length, writes);
  assert.equal(f.comments.length, comments);
  const clear = { issueNumber: 17, undefer: true as const };
  const resumed = await updateIssue(f.context, clear);
  assert.equal(Reflect.get(resumed, 'deferred'), null);
  assert.ok(resumed.body.endsWith(footer));
  assert.deepEqual(
    parseIssueBody(resumed.body, { title: f.live.title }).issue.acceptanceCriteria,
    saved.acceptanceCriteria,
  );
  assert.equal((await readyCheck(f.context, 17)).ready, true);
  await startTrackedIssue(f.context, { issueNumber: 17 });
  assert.equal(f.branchWrites.length, 1);
  assert.equal(f.getStatus(), 'Active');
});

test('canonical new-start intent preserves supplied deferral rather than silently resuming it', async () => {
  const deferred = renderIssueBody(IssueFields.parse({ ...ready(), deferral: { trigger: 'Explicit undefer' } }));
  const canonical = canonicalIssueBody({ ...ready(), body: deferred });
  assert.deepEqual(Reflect.get(parseIssueBody(canonical, { title: ready().title }).issue, 'deferral'), {
    trigger: 'Explicit undefer',
  });
  const f = fixture();
  f.controls.created = false;
  const request = { ...ready(), body: deferred };
  const first = await startTrackedIssue(f.context, request);
  assert.equal(Reflect.get(first, 'status'), 'created-not-started');
  assert.deepEqual(Reflect.get(parseIssueBody(f.live.body, { title: f.live.title }).issue, 'deferral'), {
    trigger: 'Explicit undefer',
  });
  await startTrackedIssue(f.context, request);
  assert.equal(f.writes.filter((write) => !Object.hasOwn(write, 'issue_number')).length, 1);
  assert.equal(f.branchWrites.length, 0);
});

test('WIP partial Project acknowledgment preserves the exact reason and reuses its authored comment', async () => {
  const f = fixture();
  f.controls.capacityMode = true;
  f.live.labels = ['critical'];
  f.context.config = {
    ...f.context.config,
    wipLimits: [{ repository: 'example/widget', name: 'Critical work', match: { label: 'critical' }, limit: 0 }],
  };
  f.controls.projectFailure = 'after';
  const result = await startTrackedIssue(f.context, {
    issueNumber: 17,
    overrideReason: 'Approved synthetic exception.',
  });
  assert.equal(Reflect.get(result, 'status'), 'start-incomplete');
  const recovery = result as { safeResume?: { arguments: Record<string, unknown> } };
  assert.ok(recovery.safeResume);
  const resume = recovery.safeResume.arguments;
  assert.equal(resume.overrideReason, 'Approved synthetic exception.');
  assert.equal(f.comments.length, 1);
  f.controls.projectFailure = '';
  await startTrackedIssue(f.context, resume);
  assert.equal(f.branchWrites.length, 1);
  assert.equal(f.statusWrites.length, 1);
  assert.equal(f.comments.length, 2);
});

test('deferral remains orthogonal to park and only explicit undefer clears it', async () => {
  const f = fixture();
  const patch = { issueNumber: 17, defer: {} };
  await updateIssue(f.context, patch);
  const parked = await updateIssue(f.context, { issueNumber: 17, park: true });
  assert.deepEqual(Reflect.get(parked, 'deferred'), {});
  assert.equal(parseIssueBody(parked.body, { title: parked.title }).issue.draft, true);
  const clear = { issueNumber: 17, undefer: true as const };
  const cleared = await updateIssue(f.context, clear);
  assert.equal(Reflect.get(cleared, 'deferred'), null);
  assert.equal(parseIssueBody(cleared.body, { title: cleared.title }).issue.draft, true);
  assert.equal((await readyCheck(f.context, 17)).ready, false);
});

test('deferral inputs reject invalid dates, empty reasons, conflicts and direct canonical bypass before writes', async () => {
  const schema = getAiDeliveryMcpTool('issue_update')!.inputSchema;
  assert.doesNotThrow(() => schema.parse({ issueNumber: 17, defer: { until: '2026-10-17' } }));
  for (const input of [
    { defer: { until: '2026-02-30' } },
    { defer: { until: 'tomorrow' } },
    { defer: { trigger: ' ' } },
    { defer: {}, undefer: true },
    { deferral: {} },
    { undefer: false },
  ])
    assert.throws(() => schema.parse({ issueNumber: 17, ...input }));
  const f = fixture();
  const conflicting = { issueNumber: 17, defer: {}, undefer: true as const };
  await assert.rejects(updateIssue(f.context, conflicting));
  assert.equal(f.writes.length, 0);
  assert.equal(f.comments.length, 0);
});

test('WIP label and field lanes reject full capacity before creating a branch or journal', async () => {
  for (const match of [{ label: 'critical' }, { field: 'Urgency', value: 'High' }]) {
    const f = fixture();
    f.controls.capacityMode = true;
    f.live.labels = ['critical'];
    f.context.config = {
      ...f.context.config,
      wipLimits: [{ repository: 'example/widget', name: 'Critical work', match, limit: 1 }],
    } as unknown as DeliveryContext['config'];
    f.capacity.push({ number: 18, label: 'critical', value: 'High', status: 'Active' });
    await assert.rejects(startTrackedIssue(f.context, { issueNumber: 17 }), /WIP|capacity|limit/u);
    assert.equal(f.branchWrites.length, 0);
    assert.equal(f.statusWrites.length, 0);
    assert.equal(f.comments.length, 0);
  }
});

test('WIP rechecks after branch creation, retains that identity, and only admits a recorded capacity override', async () => {
  const f = fixture();
  f.controls.capacityMode = true;
  f.controls.growAfterBranch = true;
  f.live.labels = ['critical'];
  f.context.config = {
    ...f.context.config,
    wipLimits: [{ repository: 'example/widget', name: 'Critical work', match: { label: 'critical' }, limit: 1 }],
  } as unknown as DeliveryContext['config'];
  const refused = await startTrackedIssue(f.context, { issueNumber: 17 });
  assert.equal(Reflect.get(refused, 'status'), 'start-incomplete');
  assert.equal(f.branchWrites.length, 1);
  assert.equal(f.statusWrites.length, 0);
  assert.equal(f.comments.length, 0);
  f.controls.growAfterBranch = false;
  await startTrackedIssue(f.context, {
    issueNumber: 17,
    overrideReason: 'Operator authorizes this synthetic capacity exception.',
  });
  assert.equal(f.branchWrites.length, 1);
  assert.equal(f.getStatus(), 'Active');
  assert.equal(f.comments.length, 2);
  assert.match(f.comments[0]!.body, /Operator authorizes this synthetic capacity exception/u);
  assert.match(f.comments[0]!.body, /"count": 1/u);
  assert.match(f.comments[0]!.body, /"limit": 1/u);
  await startTrackedIssue(f.context, { issueNumber: 17 });
  assert.equal(f.comments.length, 2);
});

test('WIP capacity override refuses a mismatched native comment author and reconciles lost comment responses', async () => {
  for (const failure of ['author', 'response'] as const) {
    const f = fixture();
    f.controls.capacityMode = true;
    f.live.labels = ['critical'];
    f.context.config = {
      ...f.context.config,
      wipLimits: [{ repository: 'example/widget', name: 'Critical work', match: { label: 'critical' }, limit: 0 }],
    } as unknown as DeliveryContext['config'];
    f.controls.corruptCapacityComment = failure === 'author';
    f.controls.journalFailure = failure === 'response';
    const input = { issueNumber: 17, overrideReason: 'Explicit synthetic capacity authorization.' };
    const refused = await startTrackedIssue(f.context, input);
    assert.equal(Reflect.get(refused, 'status'), 'start-incomplete');
    assert.equal(f.getStatus(), 'Queued');
    assert.equal(f.statusWrites.length, 0);
    assert.equal(f.comments.length, 1);
    f.controls.corruptCapacityComment = false;
    f.controls.journalFailure = false;
    await startTrackedIssue(f.context, input);
    assert.equal(f.getStatus(), 'Active');
    assert.equal(f.comments.length, 2);
    assert.equal(f.branchWrites.length, 1);
  }
});

test.each(['edited', 'exact-and-edited'] as const)(
  'WIP override retry refuses %s authored evidence with the same operation marker',
  async (mode) => {
    const f = fixture();
    f.controls.capacityMode = true;
    f.live.labels = ['critical'];
    f.context.config = {
      ...f.context.config,
      wipLimits: [{ repository: 'example/widget', name: 'Critical work', match: { label: 'critical' }, limit: 0 }],
    };
    f.controls.journalFailure = true;
    const input = { issueNumber: 17, overrideReason: 'Explicit synthetic capacity authorization.' };
    assert.equal(Reflect.get(await startTrackedIssue(f.context, input), 'status'), 'start-incomplete');
    assert.equal(f.comments.length, 1);
    const original = f.comments[0]!;
    const edited = original.body.replace('WIP capacity override.', 'Edited capacity override.');
    if (mode === 'edited') original.body = edited;
    else
      f.comments.push({
        ...original,
        id: 92,
        html_url: 'https://github.com/example/widget/issues/17#issuecomment-92',
        body: edited,
      });
    const before = structuredClone(f.comments);
    f.controls.journalFailure = false;
    const result = await startTrackedIssue(f.context, input);
    assert.equal(Reflect.get(result, 'status'), 'start-incomplete');
    assert.match(Reflect.get(result, 'failure')!.message, /conflict|duplicate|override/iu);
    assert.deepEqual(f.comments, before);
    assert.equal(f.branchWrites.length, 1);
    assert.equal(f.statusWrites.length, 0);
    assert.equal(f.getStatus(), 'Queued');
  },
);

test.each(
  (['text', 'number', 'date', 'single_select', 'multi_select'] as const).flatMap((type) =>
    [17, 18].map((number) => ({ type, number })),
  ),
)('WIP refuses omitted $type payload on issue $number even with an override reason', async ({ type, number }) => {
  const f = fixture();
  f.controls.capacityMode = true;
  f.capacity.push({ number: 18, label: 'other', value: 'High', status: 'Active' });
  const value = type === 'number' ? 1 : type === 'date' ? '2026-10-17' : 'High';
  f.context.config = {
    ...f.context.config,
    wipLimits: [{ repository: 'example/widget', name: 'Urgent work', match: { field: 'Urgency', value }, limit: 1 }],
  };
  let capacityReadStarted = false;
  const list = f.context.clients.rest.issues.listForRepo;
  f.context.clients.rest.issues.listForRepo = (async (input) => {
    capacityReadStarted = true;
    return list(input);
  }) as typeof list;
  const request = f.context.clients.rest.request;
  f.context.clients.rest.request = (async (route, input) => {
    const response = await request(route, input);
    if (!capacityReadStarted || typeof route !== 'string' || !route.startsWith('GET ')) return response;
    const rows = z.array(z.record(z.string(), z.unknown())).parse(response.data);
    const catalog = route === 'GET /orgs/{org}/issue-fields';
    return {
      ...response,
      data: rows.map((row) => {
        if ((catalog ? row.id : row.issue_field_id) !== 102) return row;
        if (catalog) return { ...row, data_type: type };
        return {
          issue_field_id: 102,
          issue_field_name: 'Urgency',
          data_type: type,
          ...(input?.issue_number === number
            ? {}
            : type === 'single_select'
              ? { single_select_option: { name: value } }
              : type === 'multi_select'
                ? { multi_select_options: [{ name: value }] }
                : { value }),
        };
      }),
    };
  }) as typeof request;
  await assert.rejects(
    startTrackedIssue(f.context, { issueNumber: 17, overrideReason: 'Capacity cannot override missing evidence.' }),
    /capacity|payload|field/iu,
  );
  assert.equal(f.branchWrites.length, 0);
  assert.equal(f.statusWrites.length, 0);
  assert.equal(f.membershipWrites.length, 0);
  assert.equal(f.comments.length, 0);
});

test.each(['absent', 'null', 'empty-multi'] as const)(
  'WIP accepts complete native %s peer values as nonmatching',
  async (mode) => {
    const f = fixture();
    f.controls.capacityMode = true;
    f.capacity.push({ number: 18, label: 'other', value: 'High', status: 'Active' });
    const multi = mode === 'empty-multi';
    f.context.config = {
      ...f.context.config,
      wipLimits: [
        {
          repository: 'example/widget',
          name: 'Urgent work',
          match: { field: multi ? 'Tags' : 'Urgency', value: multi ? '0' : 'High' },
          limit: 1,
        },
      ],
    };
    const request = f.context.clients.rest.request;
    f.context.clients.rest.request = (async (route, input) => {
      const response = await request(route, input);
      if (typeof route !== 'string' || !route.endsWith('/issue-field-values') || input?.issue_number !== 18)
        return response;
      const rows = z.array(z.record(z.string(), z.unknown())).parse(response.data);
      return {
        ...response,
        data: rows.flatMap((row) =>
          row.issue_field_id !== (multi ? 103 : 102)
            ? [row]
            : mode === 'absent'
              ? []
              : [
                  {
                    issue_field_id: row.issue_field_id,
                    issue_field_name: row.issue_field_name,
                    data_type: row.data_type,
                    ...(multi ? { multi_select_options: [] } : { value: null }),
                  },
                ],
        ),
      };
    }) as typeof request;
    await startTrackedIssue(f.context, { issueNumber: 17 });
    assert.equal(f.getStatus(), 'Active');
    assert.equal(f.branchWrites.length, 1);
    assert.equal(f.comments.length, 1);
  },
);

test('WIP missing target and unknown native field evidence refuse rather than counting zero', async () => {
  for (const failure of ['target', 'field'] as const) {
    const f = fixture();
    f.controls.capacityMode = true;
    f.controls.incompleteCapacity = failure === 'target';
    f.context.config = {
      ...f.context.config,
      wipLimits: [
        {
          repository: 'example/widget',
          name: 'Urgent work',
          match: { field: failure === 'field' ? 'Nonexistent lane field' : 'Urgency', value: 'High' },
          limit: 2,
        },
      ],
    } as unknown as DeliveryContext['config'];
    await assert.rejects(
      startTrackedIssue(f.context, { issueNumber: 17, overrideReason: 'Cannot authorize missing evidence.' }),
      /capacity|field|target|WIP/iu,
    );
    assert.equal(f.branchWrites.length, 0);
    assert.equal(f.comments.length, 0);
  }
});

test('WIP follows native continuation evidence even when a page is short', async () => {
  const f = fixture();
  f.controls.capacityMode = true;
  f.controls.capacityPageSize = 1;
  f.live.labels = ['critical'];
  f.context.config = {
    ...f.context.config,
    wipLimits: [{ repository: 'example/widget', name: 'Critical work', match: { label: 'critical' }, limit: 1 }],
  } as unknown as DeliveryContext['config'];
  f.capacity.push({ number: 18, label: 'critical', value: 'High', status: 'Active' });
  await assert.rejects(startTrackedIssue(f.context, { issueNumber: 17 }), /WIP capacity limit/u);
  assert.equal(f.branchWrites.length, 0);
});

test('WIP rejects malformed continuation remnants instead of treating a short page as complete', async () => {
  const f = fixture();
  f.controls.capacityMode = true;
  f.controls.capacityPageSize = 1;
  f.live.labels = ['critical'];
  f.context.config = {
    ...f.context.config,
    wipLimits: [{ repository: 'example/widget', name: 'Critical work', match: { label: 'critical' }, limit: 1 }],
  };
  f.capacity.push({ number: 18, label: 'critical', value: 'High', status: 'Active' });
  const list = f.context.clients.rest.issues.listForRepo;
  f.context.clients.rest.issues.listForRepo = (async (input) => ({
    ...(await list(input)),
    headers: {
      link: '<https://api.github.com/repos/example/widget/issues?page=1&per_page=100>; rel="prev", broken next continuation',
    },
  })) as typeof list;
  await assert.rejects(startTrackedIssue(f.context, { issueNumber: 17 }), /capacity.*pagination/iu);
  assert.equal(f.branchWrites.length, 0);
});

test('WIP rejects a native page larger than its requested window', async () => {
  const f = fixture();
  f.controls.capacityMode = true;
  f.live.labels = ['critical'];
  f.context.config = {
    ...f.context.config,
    wipLimits: [{ repository: 'example/widget', name: 'Critical work', match: { label: 'critical' }, limit: 1 }],
  };
  const list = f.context.clients.rest.issues.listForRepo;
  f.context.clients.rest.issues.listForRepo = (async (input) => ({
    headers: {},
    data: [
      ...(await list(input)).data,
      ...Array.from({ length: 100 }, (_, index) => ({ number: 1000 + index, pull_request: {} })),
    ],
  })) as typeof list;
  await assert.rejects(startTrackedIssue(f.context, { issueNumber: 17 }), /WIP capacity pagination/u);
  assert.equal(f.branchWrites.length, 0);
});

test('WIP evaluates every matching lane and capacity overrides cannot resume a deferred or blocked issue', async () => {
  const f = fixture();
  f.controls.capacityMode = true;
  f.live.labels = ['critical'];
  f.context.config = {
    ...f.context.config,
    wipLimits: [
      { repository: 'example/widget', name: 'Labels allow', match: { label: 'critical' }, limit: 1 },
      { repository: 'example/widget', name: 'Field is full', match: { field: 'Urgency', value: 'High' }, limit: 1 },
    ],
  } as unknown as DeliveryContext['config'];
  f.capacity.push({ number: 18, label: 'other', value: 'High', status: 'Active' });
  await assert.rejects(startTrackedIssue(f.context, { issueNumber: 17 }), /Field is full/u);
  const deferred = { issueNumber: 17, defer: { trigger: 'Manual approval' } };
  await updateIssue(f.context, deferred);
  await assert.rejects(
    startTrackedIssue(f.context, { issueNumber: 17, overrideReason: 'Capacity only.' }),
    /deferred/u,
  );
  await updateIssue(f.context, { issueNumber: 17, undefer: true });
  f.controls.blockers = true;
  await assert.rejects(startTrackedIssue(f.context, { issueNumber: 17, overrideReason: 'Capacity only.' }), /blocked/u);
  assert.equal(f.branchWrites.length, 0);
  assert.equal(f.comments.length, 0);
});

test('WIP distinguishes an explicitly unset native Status from omitted Status evidence', async () => {
  for (const status of ['Unset', 'Missing']) {
    const f = fixture();
    f.controls.capacityMode = true;
    f.live.labels = ['critical'];
    f.context.config = {
      ...f.context.config,
      wipLimits: [{ repository: 'example/widget', name: 'Critical work', match: { label: 'critical' }, limit: 1 }],
    };
    f.capacity.push({ number: 18, label: 'critical', value: 'High', status });
    if (status === 'Unset') {
      await startTrackedIssue(f.context, { issueNumber: 17 });
      assert.equal(f.getStatus(), 'Active');
    } else {
      await assert.rejects(startTrackedIssue(f.context, { issueNumber: 17 }), /WIP|capacity/u);
      assert.equal(f.branchWrites.length, 0);
    }
  }
});

test('WIP evaluates distinct lanes using case aliases of the same native label', async () => {
  const f = fixture();
  f.controls.capacityMode = true;
  f.live.labels = ['critical'];
  f.context.config = {
    ...f.context.config,
    wipLimits: [
      { repository: 'example/widget', name: 'Available', match: { label: 'critical' }, limit: 1 },
      { repository: 'EXAMPLE/WIDGET', name: 'Hold lane', match: { label: 'CRITICAL' }, limit: 0 },
    ],
  };
  await assert.rejects(startTrackedIssue(f.context, { issueNumber: 17 }), /Hold lane/u);
  assert.equal(f.branchWrites.length, 0);
});

test('WIP field matching preserves value types for multi-select member names', async () => {
  for (const value of [0, ' 0 ', '0']) {
    const f = fixture();
    f.controls.capacityMode = true;
    f.context.config = {
      ...f.context.config,
      wipLimits: [{ repository: 'example/widget', name: 'Tagged work', match: { field: 'Tags', value }, limit: 0 }],
    };
    if (typeof value === 'number' || value === ' 0 ') {
      await startTrackedIssue(f.context, { issueNumber: 17 });
      assert.equal(f.getStatus(), 'Active');
    } else {
      await assert.rejects(startTrackedIssue(f.context, { issueNumber: 17 }), /Tagged work/u);
      assert.equal(f.branchWrites.length, 0);
    }
  }
});

test.each(['project', 'pagination', 'status', 'archive', 'unreadable'] as const)(
  'WIP refuses changed or incomplete native %s evidence after healthy readiness',
  async (failure) => {
    const f = fixture();
    f.controls.capacityMode = true;
    f.live.labels = ['critical'];
    f.context.config = {
      ...f.context.config,
      wipLimits: [{ repository: 'example/widget', name: 'Critical work', match: { label: 'critical' }, limit: 1 }],
    };
    const graphql = f.context.clients.graphql;
    let projectReads = 0;
    f.context.clients.graphql = (async (query: string, variables: Record<string, unknown>) => {
      const value = await graphql(query, variables);
      if (query.includes('ProjectDeliveryItems') && ++projectReads > 1) {
        const project = (
          value as {
            organization: {
              projectV2: { id: string; items: { nodes: Record<string, unknown>[]; pageInfo: Record<string, unknown> } };
            };
          }
        ).organization.projectV2;
        if (failure === 'project') project.id = 'FOREIGN';
        if (failure === 'pagination') delete project.items.pageInfo.hasNextPage;
        if (failure === 'status') delete project.items.nodes[0]!.fieldValueByName;
        if (failure === 'archive') delete project.items.nodes[0]!.isArchived;
        if (failure === 'unreadable')
          project.items.nodes.push({ id: 'UNKNOWN', isArchived: false, content: null, fieldValueByName: null });
      }
      return value;
    }) as typeof graphql;
    await assert.rejects(
      startTrackedIssue(f.context, { issueNumber: 17, overrideReason: 'Capacity only.' }),
      /WIP|capacity/u,
    );
    assert.equal(f.branchWrites.length, 0);
    assert.equal(f.comments.length, 0);
  },
);

test('WIP refuses observation drift after recording an override and preserves that attempt for reconciliation', async () => {
  const f = fixture();
  f.controls.capacityMode = true;
  f.live.labels = ['critical'];
  f.context.config = {
    ...f.context.config,
    wipLimits: [{ repository: 'example/widget', name: 'Critical work', match: { label: 'critical' }, limit: 0 }],
  };
  const createComment = f.context.clients.rest.issues.createComment;
  let drift = true;
  f.context.clients.rest.issues.createComment = (async (input) => {
    const result = await createComment(input);
    if (drift) {
      drift = false;
      f.capacity.push({ number: 18, label: 'critical', value: 'High', status: 'Active' });
    }
    return result;
  }) as typeof createComment;
  const input = { issueNumber: 17, overrideReason: 'Explicit synthetic capacity exception.' };
  const result = await startTrackedIssue(f.context, input);
  assert.match(Reflect.get(result, 'failure')!.message, /capacity changed/u);
  assert.equal(f.getStatus(), 'Queued');
  assert.equal(f.comments.length, 1);
  await startTrackedIssue(f.context, input);
  assert.equal(f.getStatus(), 'Active');
  assert.equal(f.comments.length, 3, 'two distinct native capacity observations and one start journal');
  assert.equal(f.branchWrites.length, 1);
});

test('native create validates first, writes canonical fields, reads back metadata and returns warnings', async () => {
  const f = fixture();
  await assert.rejects(createIssue(f.context, { ...ready(), openQuestions: ['Select behavior.'] }), /open-questions/u);
  assert.equal(f.writes.length, 0);
  const result = await createIssue(f.context, ready());
  assert.equal(f.writes.length, 1);
  assert.equal(canonicalIssueBody({ ...ready(), body: result.body }), renderIssueBody(ready()));
  assert.equal(parseIssueBody(result.body, { title: result.created.title }).issue.points, 2);
  assert.deepEqual(result.warnings, []);
  assert.equal(f.getStatus(), 'Queued');
});

test('incomplete drafts write parked; reviewer-role writes and wrong native repository readback are refused', async () => {
  const f = fixture();
  await createIssue(f.context, { title: 'Investigate invalid widget identifiers', draft: true });
  assert.equal(f.getStatus(), 'Queued');
  assert.match(f.live.body, /\*\*State:\*\* Draft/u);
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
    assert.equal(f.comments.length, replacement.startsWith(ISSUE_BODY_MARKER) ? 1 : 2);
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
  assert.equal(canonicalIssueBody({ ...issue, body: result.body }), canonical + footer);
  assert.deepEqual(parseIssueBody(result.body, { title: issue.title }).issue, issue);
});

test('actual normal-start creation and retry reuse the exact canonical body, branch and authored journal', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-16T20:30:00Z'));
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
  clock.mockReturnValue(Date.parse('2026-10-17T20:30:00Z'));
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
  assert.equal(interrupted.safeResume.arguments.resumeCreated, undefined);
  assert.equal('body' in interrupted.safeResume.arguments, false);
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
  const examples = [...skill.matchAll(/```json\n([\s\S]*?)\n```/gu)].map((match) => {
    const json = match[1] ?? '';
    return { json, value: JSON.parse(json) as unknown };
  });
  const readTool = getAiDeliveryMcpTool('issue_info');
  assert.ok(readTool?.name === 'issue_info');
  const readSchema = readTool.inputSchema;
  for (const example of examples) {
    assert.ok(
      ReadyIssue.safeParse(example.value).success || readSchema.safeParse(example.value).success,
      'each documented JSON example must satisfy its supported contract',
    );
  }
  const readExample = examples.find((example) => readSchema.safeParse(example.value).success);
  assert.ok(readExample, 'the read-first example must use the actual MCP schema');
  const readArguments = readSchema.parse(readExample.value);
  assert.equal(readArguments.repo, 'example/widget');
  assert.equal(readArguments.issueNumber, 17);
  const createExample = examples.find((example) => ReadyIssue.safeParse(example.value).success);
  assert.ok(createExample, 'the creation example must remain Ready');
  const json = createExample.json;
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
  vi.stubEnv('AI_DELIVERY_CONFIG', '/synthetic-unconfigured-delivery-settings.json');
  const settings = await import('./config/deliveryConfig.js');
  const issues = await import('./issue.js');
  vi.spyOn(settings, 'loadDeliverySettings').mockResolvedValue({
    roles: { author: { identity: 'author', authSource: 'personal' }, reviewer: { identity: 'reviewer' } },
  } as unknown as Awaited<ReturnType<typeof settings.loadDeliverySettings>>);
  vi.spyOn(issues, 'loadDeliveryContext').mockResolvedValue(f.context);
}

test.each(['flags', 'file', 'undefer'] as const)(
  'CLI update %s changes explicit deferral through current dispatch',
  async (mode) => {
    vi.resetModules();
    const f = fixture();
    if (mode === 'undefer')
      f.live.body = renderIssueBody(IssueFields.parse({ ...ready(), deferral: { trigger: 'Prior condition' } }));
    await bindStartFixture(f);
    const root = mkdtempSync(join(tmpdir(), 'deferral-cli-'));
    const fieldsFile = join(root, 'patch.json');
    const condition = { until: '2020-01-01', trigger: 'CLI upstream condition' };
    writeFileSync(fieldsFile, JSON.stringify({ defer: condition }));
    const argv = process.argv;
    const exitCode = process.exitCode;
    let stdout = '';
    let complete: () => void = () => {};
    const output = new Promise<void>((resolve) => {
      complete = resolve;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((value) => {
      stdout += String(value);
      if (String(value).startsWith('{')) complete();
      return true;
    });
    try {
      process.exitCode = undefined;
      process.argv = [
        process.execPath,
        'ai-delivery',
        '--repo',
        'example/widget',
        'update',
        '--issue',
        '17',
        ...(mode === 'undefer'
          ? ['--undefer']
          : mode === 'file'
            ? ['--fields-file', fieldsFile]
            : ['--defer-until', condition.until, '--defer-trigger', condition.trigger]),
      ];
      await import('./cli.js');
      await output;
      const result = z.object({ deferred: z.record(z.string(), z.string()).nullable() }).parse(JSON.parse(stdout));
      assert.deepEqual(result.deferred, mode === 'undefer' ? null : condition);
      assert.equal(f.writes.length, 1);
      assert.equal(process.exitCode, undefined);
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('MCP explicit start returns Project recovery and reuses the exact branch on retry', async () => {
  const f = fixture();
  await bindStartFixture(f);
  f.controls.projectFailure = 'after';
  const server = (await import('./mcp/index.js')).createAiDeliveryMcpServer({ repoRoot: '/unrelated' });
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

test('current MCP update/read/list/start routes enforce deferral and recorded WIP capacity override', async () => {
  const f = fixture();
  await bindStartFixture(f);
  const server = (await import('./mcp/index.js')).createAiDeliveryMcpServer({ repoRoot: '/unrelated' });
  const client = new Client({ name: 'synthetic-deferral-wip', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const call = async (name: string, args: Record<string, unknown>, error = false): Promise<unknown> => {
    const result = await client.callTool({ name, arguments: { repo: 'example/widget', ...args } });
    assert.equal(Boolean(result.isError), error, JSON.stringify(result.content));
    const content = result.content as { type: string; text: string }[];
    const value: unknown = error ? content[0]!.text : JSON.parse(content[0]!.text);
    return value;
  };
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const condition = { until: '2020-01-01', trigger: 'Upstream ships' };
    const readback = z.object({ deferred: z.record(z.string(), z.string()).nullable() });
    assert.deepEqual(
      readback.parse(await call('issue_update', { issueNumber: 17, defer: condition })).deferred,
      condition,
    );
    assert.deepEqual(readback.parse(await call('issue_info', { issueNumber: 17 })).deferred, condition);
    assert.deepEqual(
      z.object({ issues: z.array(readback) }).parse(await call('issue_list', {})).issues[0]!.deferred,
      condition,
    );
    assert.match(
      z.string().parse(await call('issue_start', { issueNumber: 17, overrideReason: 'Capacity only.' }, true)),
      /deferred/u,
    );
    await call('issue_update', { issueNumber: 17, undefer: true });
    f.controls.capacityMode = true;
    f.live.labels = ['critical'];
    f.context.config = {
      ...f.context.config,
      wipLimits: [{ repository: 'example/widget', name: 'Critical work', match: { label: 'critical' }, limit: 0 }],
    };
    assert.match(z.string().parse(await call('issue_start', { issueNumber: 17 }, true)), /WIP/u);
    assert.equal(f.branchWrites.length, 0);
    await call('issue_start', { issueNumber: 17, overrideReason: 'Explicit synthetic capacity exception.' });
    assert.equal(f.getStatus(), 'Active');
    assert.equal(f.comments.length, 2);
    await call('issue_start', { issueNumber: 17 });
    assert.equal(f.comments.length, 2);
  } finally {
    await client.close();
    await server.close();
  }
});

test.each(['success', 'failure', 'capacity', 'deferred', 'capacity-override'] as const)(
  'CLI explicit start shares Project transition and %s output',
  async (mode) => {
    vi.resetModules();
    const f = fixture();
    await bindStartFixture(f);
    if (mode === 'failure') f.controls.projectFailure = 'before';
    if (mode === 'deferred') await updateIssue(f.context, { issueNumber: 17, defer: {} });
    if (mode === 'capacity' || mode === 'capacity-override') {
      f.controls.capacityMode = true;
      f.live.labels = ['critical'];
      f.context.config = {
        ...f.context.config,
        wipLimits: [{ repository: 'example/widget', name: 'Critical work', match: { label: 'critical' }, limit: 0 }],
      };
    }
    const argv = process.argv;
    const exitCode = process.exitCode;
    let stdout = '';
    let stderr = '';
    let completed: () => void = () => {};
    const output = new Promise<void>((resolve) => {
      completed = resolve;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((value) => {
      stdout += String(value);
      if (String(value).startsWith('{')) completed();
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((value) => {
      stderr += String(value);
      completed();
      return true;
    });
    try {
      process.exitCode = undefined;
      process.argv = [process.execPath, 'ai-delivery', '--repo', 'example/widget', 'start', '--issue', '17'];
      if (mode === 'capacity-override')
        process.argv.push('--override-reason', 'Explicit synthetic capacity exception.');
      await import('./cli.js');
      await output;
      if (mode === 'deferred' || mode === 'capacity') {
        assert.match(stderr, mode === 'deferred' ? /deferred/u : /WIP/u);
        assert.equal(process.exitCode, 1);
        assert.equal(f.branchWrites.length, 0);
        assert.equal(f.statusWrites.filter((x) => x.optionId === 'ACTIVE').length, 0);
        return;
      }
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
        assert.equal(f.comments.length, mode === 'capacity-override' ? 2 : 1);
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

test.each(['project-status', 'journal'] as const)(
  'created recovery after %s preserves a subsequent native park',
  async (phase) => {
    const f = fixture();
    f.controls.created = false;
    f.controls.projectFailure = phase === 'project-status' ? 'before' : '';
    f.controls.journalFailure = phase === 'journal';
    const result = await startTrackedIssue(f.context, {
      title: ready().title,
      body: renderIssueBody(ready()),
      issueType: 'Task',
      points: 2,
      requestId: 'parked-created-' + phase,
    });
    if (result.status !== 'created-not-started') assert.fail('Expected known-created recovery');
    assert.equal(result.failure.phase, phase);
    f.controls.projectFailure = '';
    f.controls.journalFailure = false;
    await updateIssue(f.context, { issueNumber: 17, park: true });
    const parkedBody = f.live.body;
    const writesBeforeRetry = f.writes.length;
    const statusWritesBeforeRetry = f.statusWrites.length;
    const commentsBeforeRetry = f.comments.length;
    const retry = await startTrackedIssue(
      f.context,
      getAiDeliveryMcpTool('issue_start')!.inputSchema.parse(result.safeResume.arguments),
    ).catch((error: unknown) => {
      assert.ok(error instanceof Error);
      return undefined;
    });
    assert.equal(f.live.body, parkedBody);
    assert.equal(parseIssueBody(f.live.body, { title: f.live.title }).issue.draft, true);
    assert.equal(f.getStatus(), 'Queued');
    assert.ok(retry === undefined || retry.status !== undefined, 'Parked recovery must not succeed');
    assert.equal(f.writes.length, writesBeforeRetry);
    assert.equal(f.statusWrites.length, statusWritesBeforeRetry);
    assert.equal(f.comments.length, commentsBeforeRetry);
    assert.equal(f.branchWrites.length, 1);
  },
);

test('created post-tracking recovery preserves later ready content without replaying tracking writes', async () => {
  const f = fixture();
  f.controls.created = false;
  f.controls.projectFailure = 'before';
  const result = await startTrackedIssue(f.context, {
    title: ready().title,
    body: renderIssueBody(ready()),
    issueType: 'Task',
    points: 2,
    requestId: 'edited-created-recovery',
  });
  if (result.status !== 'created-not-started') assert.fail('Expected known-created recovery');
  f.controls.projectFailure = '';
  await updateIssue(f.context, { issueNumber: 17, outcome: 'Deliver the revised current acceptance evidence.' });
  const revised = f.live.body;
  const writes = f.writes.length;
  assert.ok(
    'reused' in
      (await startTrackedIssue(
        f.context,
        getAiDeliveryMcpTool('issue_start')!.inputSchema.parse(result.safeResume.arguments),
      )),
  );
  assert.equal(f.live.body, revised);
  assert.equal(f.writes.length, writes);
  assert.equal(f.branchWrites.length, 1);
  assert.equal(f.getStatus(), 'Active');
});
