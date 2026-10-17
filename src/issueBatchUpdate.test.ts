import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import * as issue from './issue.js';
import * as configuration from './config/deliveryConfig.js';
import { executeTool } from './dispatch.js';
import { getAiDeliveryMcpTool, type AiDeliveryMcpToolName } from './mcp/tools.js';
import { getRateLimitDiagnostics } from './errors.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAiDeliveryMcpServer } from './mcp/index.js';
import { syntheticDiscoveryConfig } from './fixtures/discovery.js';
import { IssueFields, renderIssueBody } from './issueContract.js';

function batchFixture() {
  const rows = new Map(
    Array.from({ length: 5 }, (_, index) => {
      const number = index + 1;
      return [
        number,
        {
          number,
          id: number + 100,
          node_id: `ISSUE${number}`,
          title: `Synthetic item ${number}`,
          body: renderIssueBody(IssueFields.parse({ title: `Synthetic item ${number}`, draft: true })),
          state: 'open',
          type: { name: 'Task' },
          labels: [] as string[],
          milestone: null,
          html_url: `https://github.com/example/widget/issues/${number}`,
        },
      ];
    }),
  );
  const writes: string[] = [];
  const controls = { failAfterWrite: 0, failReadback: 0, driftOnRead: 0, rateLimited: 0, ignoreLabels: false };
  const reads = new Map<number, number>();
  const metadata = new Map<number, Record<string, string>>();
  const parents = new Map<number, number>();
  const blockers = new Map<number, number[]>();
  const reasons = new Map<number, string>();
  const duplicates = new Map<number, number>();
  const fieldValues = (number: number) =>
    Object.entries(metadata.get(number) ?? {}).map(([id, value]) => ({
      data_type: 'single_select',
      issue_field_id: Number(id),
      issue_field_name: id === '101' ? 'Estimate' : 'Urgency',
      value,
    }));
  const comments: { id: number; body: string; html_url: string; user: { login: string }; issue_url: string }[] = [];
  const statuses = new Map(Array.from(rows.keys(), (number) => [number, 'Active']));
  const context = {
    root: '/synthetic',
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
      role: 'author',
      authenticatedAuthor: async () => ({ actorLogin: 'operator', credentialIdentity: 'user:1' }),
      rest: {
        issues: {
          get: async ({ issue_number }: { issue_number: number }) => {
            reads.set(issue_number, (reads.get(issue_number) ?? 0) + 1);
            if (controls.failReadback === issue_number && writes.includes(`update:${issue_number}`))
              throw new Error('Synthetic readback transport failure');
            const row = rows.get(issue_number);
            if (row && controls.driftOnRead === issue_number && reads.get(issue_number) === 2)
              row.body = 'Concurrent operator edit';
            if (!row) throw new Error('Synthetic issue unavailable');
            return { data: structuredClone(row) };
          },
          listComments: async ({ issue_number }: { issue_number: number }) => ({
            data: comments.filter((comment) => comment.issue_url.endsWith('/' + String(issue_number))),
          }),
          listLabelsForRepo: async () => ({ data: [{ name: 'enhancement' }] }),
          listSubIssues: async () => ({ data: [] }),
          addSubIssue: async ({ issue_number, sub_issue_id }: { issue_number: number; sub_issue_id: number }) => {
            writes.push('parent');
            parents.set(sub_issue_id - 100, issue_number);
            return { data: {} };
          },
          removeSubIssue: async ({ sub_issue_id }: { sub_issue_id: number }) => {
            writes.push('parent');
            parents.delete(sub_issue_id - 100);
            return { data: {} };
          },
          createComment: async ({ issue_number, body }: { issue_number: number; body: string }) => {
            writes.push('comment');
            const comment = {
              id: comments.length + 1000,
              body,
              html_url: `https://github.com/example/widget/issues/${issue_number}#issuecomment-${comments.length + 1000}`,
              user: { login: 'operator' },
              issue_url: `https://api.github.com/repos/example/widget/issues/${issue_number}`,
            };
            comments.push(comment);
            return { data: comment };
          },
          getComment: async ({ comment_id }: { comment_id: number }) => ({
            data: comments.find((comment) => comment.id === comment_id),
          }),
          update: async ({ issue_number, ...patch }: { issue_number: number; [key: string]: unknown }) => {
            writes.push(`update:${issue_number}`);
            if (controls.rateLimited === issue_number)
              throw Object.assign(new Error('PRIVATE_REMOTE_CONTENT'), {
                status: 429,
                response: {
                  headers: {
                    'retry-after': '60',
                    'x-ratelimit-remaining': '0',
                    'x-ratelimit-reset': '1900000000',
                    authorization: 'PRIVATE_TOKEN',
                  },
                },
              });
            const row = rows.get(issue_number)!;
            if (typeof patch.title === 'string') row.title = patch.title;
            if (typeof patch.body === 'string') row.body = patch.body;
            if (typeof patch.type === 'string') row.type = { name: patch.type };
            if (Array.isArray(patch.labels) && !controls.ignoreLabels)
              row.labels = (patch.labels as string[]).map((label) => label.toLowerCase());
            if (patch.milestone !== undefined)
              Object.assign(row, { milestone: patch.milestone === null ? null : { number: patch.milestone } });
            if (typeof patch.state === 'string') {
              row.state = patch.state;
              reasons.set(
                issue_number,
                patch.state === 'closed'
                  ? (typeof patch.state_reason === 'string' ? patch.state_reason : 'completed').toUpperCase()
                  : 'REOPENED',
              );
            }
            if (typeof patch.duplicate_issue_id === 'number')
              duplicates.set(issue_number, patch.duplicate_issue_id - 100);
            if (controls.failAfterWrite === issue_number) {
              controls.failAfterWrite = 0;
              throw new Error('Synthetic acknowledgement lost');
            }
            return { data: rows.get(issue_number) };
          },
        },
        paginate: async (_method: unknown, { issue_number }: { issue_number: number }) =>
          [...parents].filter(([, parent]) => parent === issue_number).map(([number]) => rows.get(number)),
        request: async (
          route: string,
          params: {
            issue_number: number;
            issue_field_id?: number;
            issue_field_values?: { field_id: number; value: string }[];
          },
        ) => {
          if (route.startsWith('GET /orgs'))
            return {
              data: Object.values(syntheticDiscoveryConfig.native)
                .filter(
                  (field): field is typeof syntheticDiscoveryConfig.native.points =>
                    typeof field === 'object' && field !== null && 'databaseId' in field,
                )
                .map((field) => ({
                  id: Number(field.databaseId),
                  name: field.name,
                  data_type: 'single_select',
                  options: field.values.map((name) => ({ name })),
                })),
            };
          if (route.startsWith('POST ')) {
            writes.push('metadata');
            metadata.set(params.issue_number, {
              ...metadata.get(params.issue_number),
              ...Object.fromEntries(params.issue_field_values!.map((value) => [String(value.field_id), value.value])),
            });
          }
          if (route.startsWith('DELETE ')) {
            writes.push('metadata');
            delete metadata.get(params.issue_number)![String(params.issue_field_id)];
          }
          return { data: fieldValues(params.issue_number) };
        },
      },
      graphql: async (query: string, variables: Record<string, unknown>) => {
        const numeric = variables.number ?? variables.issueNumber;
        const nodeId = variables.issueNodeId ?? variables.itemId ?? '1';
        const number =
          typeof numeric === 'number' ? numeric : typeof nodeId === 'string' ? Number(nodeId.replace(/\D/gu, '')) : NaN;
        if (query.includes('IssueClosureReadback'))
          return {
            repository: {
              issue: {
                number,
                repository: { nameWithOwner: 'example/widget' },
                state: rows.get(number)!.state.toUpperCase(),
                stateReason: reasons.get(number) ?? null,
                duplicateOf: duplicates.has(number)
                  ? { number: duplicates.get(number), repository: { nameWithOwner: 'example/widget' } }
                  : null,
              },
            },
          };
        if (query.includes('blockedBy(first:'))
          return {
            repository: {
              issue: {
                parent: parents.has(number)
                  ? {
                      id: `ISSUE${parents.get(number)}`,
                      number: parents.get(number),
                      repository: { nameWithOwner: 'example/widget' },
                    }
                  : null,
                blockedBy: {
                  nodes: (blockers.get(number) ?? []).map((n) => ({
                    id: `ISSUE${n}`,
                    number: n,
                    state: rows.get(n)!.state.toUpperCase(),
                    title: rows.get(n)!.title,
                    repository: { nameWithOwner: 'example/widget' },
                  })),
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          };
        if (query.includes('mutation') && (query.includes('addBlockedBy') || query.includes('removeBlockedBy'))) {
          writes.push('dependency');
          const dependent = Number(String(variables.issue).replace(/\D/gu, ''));
          const blocker = Number(String(variables.blocking).replace(/\D/gu, ''));
          blockers.set(
            dependent,
            query.includes('addBlockedBy')
              ? [...new Set([...(blockers.get(dependent) ?? []), blocker])]
              : (blockers.get(dependent) ?? []).filter((n) => n !== blocker),
          );
          return {};
        }
        if (query.includes('ProjectDeliveryItems'))
          return {
            organization: {
              projectV2: {
                items: {
                  nodes: [...rows.keys()].map((n) => ({
                    id: `ITEM${n}`,
                    isArchived: false,
                    content: { id: `ISSUE${n}` },
                    fieldValueByName: {
                      name: statuses.get(n),
                      optionId:
                        statuses.get(n) === 'Active'
                          ? 'ACTIVE'
                          : statuses.get(n) === 'Shipped'
                            ? 'DONE'
                            : statuses.get(n) === 'Waiting'
                              ? 'BLOCKED'
                              : 'TODO',
                    },
                  })),
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          };
        if (query.includes('UpdateProjectDeliveryStatus')) {
          writes.push('project');
          statuses.set(
            number,
            variables.optionId === 'DONE'
              ? 'Shipped'
              : variables.optionId === 'BLOCKED'
                ? 'Waiting'
                : variables.optionId === 'ACTIVE'
                  ? 'Active'
                  : 'Queued',
          );
          return { updateProjectV2ItemFieldValue: { projectV2Item: { id: `ITEM${number}` } } };
        }
        if (query.includes('ProjectDeliveryItemReadback'))
          return {
            node: {
              id: `ITEM${number}`,
              isArchived: false,
              project: { id: 'PROJECT', number: 1 },
              content: { id: `ISSUE${number}` },
              fieldValueByName: {
                name: statuses.get(number),
                optionId:
                  statuses.get(number) === 'Active'
                    ? 'ACTIVE'
                    : statuses.get(number) === 'Shipped'
                      ? 'DONE'
                      : statuses.get(number) === 'Waiting'
                        ? 'BLOCKED'
                        : 'TODO',
              },
            },
          };
        throw new Error('Unexpected synthetic native query');
      },
    },
  } as unknown as issue.DeliveryContext;
  vi.spyOn(configuration, 'loadDeliverySettings').mockResolvedValue({
    roles: { author: { identity: 'host-author', authSource: 'personal' }, reviewer: { identity: 'app-reviewer' } },
  } as never);
  vi.spyOn(issue, 'loadDeliveryContext').mockResolvedValue(context);
  return { context, rows, writes, comments, controls, metadata, parents, blockers, statuses };
}

afterEach(() => vi.restoreAllMocks());

test('batch dry run returns each planned title change without native writes', async () => {
  const f = batchFixture();
  const result = (await executeTool(
    'issue_batch_update' as AiDeliveryMcpToolName,
    {
      repo: 'example/widget',
      dryRun: true,
      items: [
        { issueNumber: 1, title: 'First requested title' },
        { issueNumber: 2, title: 'Second requested title' },
      ],
    },
    { repoRoot: '/synthetic', identity: 'host-author' },
  )) as {
    dryRun: boolean;
    results: { issueNumber: number; changes: Record<string, unknown>; readback: issue.IssueInfo }[];
  };
  assert.equal(result.dryRun, true);
  assert.deepEqual(
    result.results.map((item) => [item.issueNumber, item.changes.title, item.readback.title]),
    [
      [1, 'First requested title', 'Synthetic item 1'],
      [2, 'Second requested title', 'Synthetic item 2'],
    ],
  );
  assert.deepEqual(f.writes, []);
  assert.equal(f.rows.get(1)!.title, 'Synthetic item 1');
});

async function runBatch(input: issue.BatchUpdateIssueInput) {
  return executeTool(
    'issue_batch_update',
    { repo: 'example/widget', ...input },
    { repoRoot: '/synthetic', identity: 'host-author' },
  ) as Promise<Awaited<ReturnType<typeof issue.batchUpdateIssues>>>;
}

test('mixed failures retain later results and a rerun reports unchanged native outcomes', async () => {
  const f = batchFixture();
  const input = {
    items: [
      { issueNumber: 1, title: 'Changed title' },
      { issueNumber: 99, title: 'Missing target' },
      { issueNumber: 2, defer: { trigger: 'Review next sprint' } },
    ],
  };
  const first = await runBatch(input);
  assert.deepEqual(
    first.results.map((item) => item.status),
    ['applied', 'failed', 'applied'],
  );
  assert.equal(first.results[0]!.readback!.title, 'Changed title');
  assert.match(first.results[1]!.reason!, /preparation failed/u);
  assert.match(first.results[1]!.readbackError!, /unavailable/u);
  assert.deepEqual(first.results[2]!.readback!.deferred, { trigger: 'Review next sprint' });
  const writes = f.writes.length;
  const second = await runBatch(input);
  assert.deepEqual(
    second.results.map((item) => item.status),
    ['unchanged', 'failed', 'unchanged'],
  );
  assert.equal(f.writes.length, writes);
});

test('lost acknowledgement exposes partial state and a rerun completes remaining Project work', async () => {
  const f = batchFixture();
  f.controls.failAfterWrite = 1;
  const input = {
    items: [
      { issueNumber: 1, title: 'Acknowledgement lost', preserveHistory: true },
      { issueNumber: 2, title: 'Later item proceeds' },
    ],
  };
  const first = await runBatch(input);
  assert.deepEqual(
    first.results.map((item) => item.status),
    ['failed', 'applied'],
  );
  assert.equal(first.results[0]!.readback!.title, 'Acknowledgement lost');
  assert.equal(first.results[0]!.readback!.projectStatus, 'In Progress');
  const historyCount = f.comments.length;
  const second = await runBatch(input);
  assert.deepEqual(
    second.results.map((item) => item.status),
    ['applied', 'unchanged'],
  );
  assert.equal(second.results[0]!.readback!.projectStatus, 'Todo');
  assert.equal(f.comments.length, historyCount);
  assert.deepEqual(
    (await runBatch(input)).results.map((item) => item.status),
    ['unchanged', 'unchanged'],
  );
});

test('dry run plans close, defer, metadata, parent Points and dependency side effects without writes', async () => {
  const f = batchFixture();
  f.metadata.set(5, { '101': '4' });
  f.statuses.set(4, 'Queued');
  const result = await runBatch({
    dryRun: true,
    items: [
      { issueNumber: 1, state: 'closed', closeReason: 'duplicate', supersededBy: 5 },
      { issueNumber: 2, defer: { until: '2026-12-01' }, preserveHistory: true },
      { issueNumber: 3, labels: ['enhancement'], milestone: 1, points: 2, priority: 'High', parentIssueNumber: 5 },
      { issueNumber: 4, blockedBy: [2] },
    ],
  });
  assert.deepEqual(
    result.results.map((item) => item.status),
    ['planned', 'planned', 'planned', 'planned'],
  );
  assert.deepEqual(result.results[2]!.changes!.parentPoints, { issueNumber: 5, points: null });
  assert.deepEqual(result.results[3]!.changes!.blockedBy, [2]);
  assert.equal(result.results[0]!.changes!.closureComment, true);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.metadata.get(5), { '101': '4' });
  assert.equal(f.rows.get(1)!.state, 'open');
});

test('unchanged includes labels, metadata, native parent Points and blocker relationships', async () => {
  const f = batchFixture();
  f.metadata.set(5, { '101': '4' });
  f.statuses.set(3, 'Queued');
  const input = {
    items: [
      {
        issueNumber: 3,
        labels: ['enhancement'],
        milestone: 1,
        points: 2,
        priority: 'High',
        parentIssueNumber: 5,
        blockedBy: [2],
      },
    ],
  };
  const first = await runBatch(input);
  assert.equal(first.results[0]!.status, 'applied', JSON.stringify(first));
  assert.deepEqual(first.results[0]!.readback!.labels, ['enhancement']);
  assert.equal(first.results[0]!.readback!.milestone, 1);
  assert.equal(first.results[0]!.readback!.points, 2);
  assert.equal(first.results[0]!.readback!.priority, 'High');
  assert.equal(f.parents.get(3), 5);
  assert.equal(f.metadata.get(5)!['101'], undefined);
  assert.deepEqual(f.blockers.get(3), [2]);
  assert.equal((await runBatch(input)).results[0]!.status, 'unchanged');
  f.metadata.set(5, { '101': '4' });
  assert.equal(
    (await runBatch(input)).results[0]!.status,
    'applied',
    'Parent Points repair cannot be classified unchanged',
  );
});

test('readback disagreement and unavailable readback remain failures while later items proceed', async () => {
  const f = batchFixture();
  f.controls.ignoreLabels = true;
  const result = await runBatch({
    items: [
      { issueNumber: 1, labels: ['enhancement'] },
      { issueNumber: 2, title: 'Later title' },
    ],
  });
  assert.deepEqual(
    result.results.map((item) => item.status),
    ['failed', 'applied'],
  );
  assert.deepEqual(result.results[0]!.readback!.labels, []);
  f.controls.failReadback = 3;
  const unavailable = await runBatch({
    items: [
      { issueNumber: 3, title: 'Written before transport failure' },
      { issueNumber: 4, title: 'Still executed' },
    ],
  });
  assert.deepEqual(
    unavailable.results.map((item) => item.status),
    ['failed', 'applied'],
  );
  assert.equal(unavailable.results[0]!.readback, null);
  assert.match(unavailable.results[0]!.readbackError!, /unavailable/u);
});

test('content drift after preparation refuses the stale write and preserves the operator edit', async () => {
  const f = batchFixture();
  f.controls.driftOnRead = 1;
  const result = await runBatch({
    items: [
      { issueNumber: 1, title: 'Stale prepared update' },
      { issueNumber: 2, title: 'Independent update' },
    ],
  });
  assert.deepEqual(
    result.results.map((item) => item.status),
    ['failed', 'applied'],
  );
  assert.equal(f.rows.get(1)!.body, 'Concurrent operator edit');
  assert.equal(f.rows.get(1)!.title, 'Synthetic item 1');
});

test('positive rate exhaustion suppresses remaining calls and exposes only numeric rate diagnostics', async () => {
  const f = batchFixture();
  f.controls.rateLimited = 1;
  const result = await runBatch({
    items: [
      { issueNumber: 1, title: 'Rate limited' },
      { issueNumber: 2, title: 'Not attempted' },
    ],
  });
  assert.deepEqual(
    result.results.map((item) => item.status),
    ['failed', 'failed'],
  );
  assert.deepEqual(result.summary.rateLimits, [{ retryAfterSeconds: 60, resetAtSeconds: 1900000000, remaining: 0 }]);
  assert.match(result.results[1]!.reason!, /Not attempted/u);
  assert.equal(f.rows.get(2)!.title, 'Synthetic item 2');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_REMOTE_CONTENT|PRIVATE_TOKEN|authorization/u);
  assert.equal(
    getRateLimitDiagnostics({ status: 403, response: { headers: { 'x-ratelimit-remaining': '2' } } }),
    undefined,
  );
  let getterRead = false;
  assert.equal(
    getRateLimitDiagnostics({
      get status() {
        getterRead = true;
        return 429;
      },
    }),
    undefined,
  );
  assert.equal(getterRead, false);
});

test('a wrapped native rate error still suppresses later batch writes', async () => {
  const f = batchFixture();
  let observation: { remaining: number } | undefined;
  Object.assign(f.context.clients, { rateLimitObservation: () => observation });
  f.context.clients.rest.issues.update = (async () => {
    observation = { remaining: 0 };
    throw new Error('Dependency helper wrapped the original failure');
  }) as never;
  const result = await runBatch({
    items: [
      { issueNumber: 1, title: 'Wrapped rate failure' },
      { issueNumber: 2, title: 'Must stay unchanged' },
    ],
  });
  assert.equal(result.results[1]!.reason, 'Not attempted: GitHub rate limit exhausted.');
  assert.deepEqual(result.summary.rateLimits, [{ remaining: 0 }]);
  assert.equal(f.rows.get(2)!.title, 'Synthetic item 2');
});

test('schema, selected repository and author refusals perform no writes; cancellation returns every item', async () => {
  const f = batchFixture();
  for (const input of [
    { items: [] },
    { items: Array.from({ length: 51 }, () => ({ issueNumber: 1 })) },
    { items: [{ issueNumber: 1, undefer: true, defer: {} }] },
    { items: [{ issueNumber: 1, closeReason: 'completed' }] },
    { items: [{ issueNumber: 1, privateUnknown: 'HIDDEN_PROPERTY' }] },
    { items: [{ issueNumber: 1, repo: 'other/repository' }] },
  ])
    await assert.rejects(runBatch(input as issue.BatchUpdateIssueInput));
  await assert.rejects(
    executeTool(
      'issue_batch_update',
      { repo: 'example/widget', items: [{ issueNumber: 1 }] },
      { repoRoot: '/synthetic', identity: 'app-reviewer' },
    ),
    /author/u,
  );
  const abort = new AbortController();
  abort.abort();
  const cancelled = await issue.batchUpdateIssues(
    f.context,
    { items: [{ issueNumber: 1 }, { issueNumber: 2 }] },
    abort.signal,
  );
  assert.deepEqual(
    cancelled.results.map((item) => item.status),
    ['failed', 'failed'],
  );
  assert.deepEqual(f.writes, []);
  const shape = getAiDeliveryMcpTool('issue_update')!.inputSchema;
  const complete = {
    issueNumber: 1,
    draft: true,
    retainLegacyBody: true,
    status: { latestJournal: 'Checked' },
    labels: [],
    milestone: null,
    parentIssueNumber: null,
    blocks: [],
    blockedBy: [],
    undefer: true,
    preserveHistory: false,
  };
  assert.equal(shape.safeParse(complete).success, true);
  assert.equal(getAiDeliveryMcpTool('issue_batch_update')!.inputSchema.safeParse({ items: [complete] }).success, true);
});

test('close journals, duplicate reason and explicit undefer are idempotent through the batch path', async () => {
  const f = batchFixture();
  const input = {
    items: [
      { issueNumber: 1, state: 'closed' as const, closeReason: 'duplicate' as const, supersededBy: 5 },
      { issueNumber: 2, defer: { trigger: 'Quarterly review' } },
    ],
  };
  const first = await runBatch(input);
  assert.deepEqual(
    first.results.map((item) => item.status),
    ['applied', 'applied'],
  );
  assert.equal(first.results[0]!.readback!.state, 'closed');
  assert.equal(first.results[0]!.relatedReadback!.closeReason, 'duplicate');
  const count = f.comments.length;
  assert.deepEqual(
    (await runBatch(input)).results.map((item) => item.status),
    ['unchanged', 'unchanged'],
  );
  assert.equal(f.comments.length, count);
  const resumed = await runBatch({ items: [{ issueNumber: 2, undefer: true }] });
  assert.equal(resumed.results[0]!.status, 'applied');
  assert.equal(resumed.results[0]!.readback!.deferred, null);
  assert.equal((await runBatch({ items: [{ issueNumber: 2, undefer: true }] })).results[0]!.status, 'unchanged');
});

test('public MCP and dispatch expose the same read-only per-item plan contract', async () => {
  const f = batchFixture();
  const server = createAiDeliveryMcpServer({ repoRoot: '/synthetic', identity: 'host-author' });
  const client = new Client({ name: 'batch-synthetic', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const input = { repo: 'example/widget', dryRun: true, items: [{ issueNumber: 1, title: 'MCP planned title' }] };
    const result = await client.callTool({ name: 'issue_batch_update', arguments: input });
    assert.notEqual(result.isError, true);
    const content = result.content as { type: string; text: string }[];
    const parsed = JSON.parse(content[0]!.text) as Awaited<ReturnType<typeof issue.batchUpdateIssues>>;
    assert.equal(parsed.results[0]!.changes!.title, 'MCP planned title');
    assert.equal(parsed.results[0]!.status, 'planned');
    assert.equal(parsed.summary.planned, 1);
    assert.equal(parsed.results[0]!.readback!.title, 'Synthetic item 1');
    const direct = await runBatch(input);
    assert.deepEqual(direct.summary, parsed.summary);
    assert.equal(direct.results[0]!.changes!.title, parsed.results[0]!.changes!.title);
    assert.deepEqual(f.writes, []);
  } finally {
    await client.close();
    await server.close();
  }
});

test('the documented fifty-item boundary returns every read-only plan', async () => {
  const f = batchFixture();
  const result = await runBatch({
    dryRun: true,
    items: Array.from({ length: 50 }, () => ({ issueNumber: 1, title: 'Planned repeated item' })),
  });
  assert.equal(result.results.length, 50);
  assert.equal(result.summary.planned, 50);
  assert.deepEqual(f.writes, []);
});

test('native label casing preserves the existing case-insensitive update intent', async () => {
  const f = batchFixture();
  const input = { items: [{ issueNumber: 1, labels: ['ENHANCEMENT'] }] };
  const first = await runBatch(input);
  assert.equal(first.results[0]!.status, 'applied');
  assert.deepEqual(f.rows.get(1)!.labels, ['enhancement']);
  assert.equal((await runBatch(input)).results[0]!.status, 'unchanged');
});

test('rate exhaustion during fallback readback stops later writes and appears in the summary', async () => {
  const f = batchFixture();
  f.controls.failAfterWrite = 1;
  const get = f.context.clients.rest.issues.get;
  f.context.clients.rest.issues.get = (async (params: { issue_number: number }) => {
    if (params.issue_number === 1 && f.writes.includes('update:1'))
      throw Object.assign(new Error('Private readback error'), { status: 429, headers: { 'retry-after': '10' } });
    return get({ ...f.context.repo, ...params });
  }) as never;
  const result = await runBatch({
    items: [
      { issueNumber: 1, title: 'Partial item' },
      { issueNumber: 2, title: 'No later write' },
    ],
  });
  assert.deepEqual(
    result.results.map((item) => item.status),
    ['failed', 'failed'],
  );
  assert.match(result.results[1]!.reason!, /Not attempted/u);
  assert.deepEqual(result.summary.rateLimits, [{ retryAfterSeconds: 10 }]);
  assert.equal(f.rows.get(2)!.title, 'Synthetic item 2');
});

test('closure reuse refuses duplicate authored journals and corrupted authoritative comment readback', async () => {
  for (const mode of ['duplicate', 'corrupt'] as const) {
    const f = batchFixture();
    const input = { items: [{ issueNumber: 1, state: 'closed' as const, closeReason: 'completed' as const }] };
    assert.equal((await runBatch(input)).results[0]!.status, 'applied');
    const existing = f.comments.find((comment) => comment.body === 'Requested closure reason: completed.')!;
    if (mode === 'duplicate') f.comments.push({ ...existing, id: 9999 });
    else
      f.context.clients.rest.issues.getComment = (async () => ({
        data: { ...existing, body: 'Corrupted journal readback' },
      })) as never;
    const writes = f.writes.length;
    assert.equal((await runBatch(input)).results[0]!.status, 'failed', mode);
    assert.equal(f.writes.length, writes);
  }
});
