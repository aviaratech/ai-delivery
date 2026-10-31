import { issueProjectItemsResponse } from './fixtures/issueProjectItems.js';
import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import * as issue from './issue.js';
import * as configuration from './config/deliveryConfig.js';
import { executeTool } from './dispatch.js';
import { getAiDeliveryMcpTool, type AiDeliveryMcpToolName } from './mcp/tools.js';
import { DeliveryError, getRateLimitDiagnostics } from './errors.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAiDeliveryMcpServer } from './mcp/index.js';
import { syntheticDiscoveryConfig } from './fixtures/discovery.js';
import { IssueFields, renderIssueBody } from './issueContract.js';
import { syncIssueProjectStatus } from './github/projectDelivery.js';

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
  const dateWrites: number[][] = [];
  const controls = {
    failAfterWrite: 0,
    failReadback: 0,
    driftOnRead: 0,
    rateLimited: 0,
    ignoreLabels: false,
    parentRepository: 'example/widget',
    parentNodeId: '',
    archived: false,
    archiveAfterWrite: false,
    loseProjectAck: false,
    projectUnavailableAfterDependency: false,
    nativeUnavailableAfterDependency: false,
    moveProjectToTodoAfterWrite: false,
    projectReadsAfterWrite: 0,
  };
  const reads = new Map<number, number>();
  const metadata = new Map<number, Record<string, string>>();
  const parents = new Map<number, number>();
  const blockers = new Map<number, number[]>();
  const reasons = new Map<number, string>();
  const duplicates = new Map<number, number>();
  const fieldValues = (number: number) =>
    Object.entries(metadata.get(number) ?? {}).map(([id, value]) => ({
      data_type: Number(id) >= 103 ? 'date' : 'single_select',
      issue_field_id: Number(id),
      issue_field_name:
        id === '101' ? 'Estimate' : id === '102' ? 'Urgency' : id === '103' ? 'Start date' : 'Target date',
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
      reviewOptionId: 'REVIEW',
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
            if (controls.nativeUnavailableAfterDependency && writes.includes('dependency'))
              throw new Error('PRIVATE_NATIVE_READ_FAILURE');
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
            if (controls.moveProjectToTodoAfterWrite) statuses.set(issue_number, 'Queued');
            if (controls.archiveAfterWrite) controls.archived = true;
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
              data: [
                ...Object.values(syntheticDiscoveryConfig.native)
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
                { id: 103, name: 'Start date', data_type: 'date' },
                { id: 104, name: 'Target date', data_type: 'date' },
              ],
            };
          if (route.startsWith('POST ')) {
            const dates = params.issue_field_values!.filter((value) => value.field_id >= 103);
            if (dates.length) dateWrites.push(dates.map((value) => value.field_id));
            writes.push('metadata');
            metadata.set(params.issue_number, {
              ...metadata.get(params.issue_number),
              ...Object.fromEntries(params.issue_field_values!.map((value) => [String(value.field_id), value.value])),
            });
          }
          if (route.startsWith('DELETE ')) {
            if (params.issue_field_id! >= 103) dateWrites.push([params.issue_field_id!]);
            writes.push('metadata');
            delete metadata.get(params.issue_number)![String(params.issue_field_id)];
          }
          return { data: fieldValues(params.issue_number) };
        },
      },
      graphql: async (query: string, variables: Record<string, unknown>) => {
        if (
          controls.moveProjectToTodoAfterWrite &&
          writes.includes('update:1') &&
          query.includes('ProjectDeliveryIssueItems') &&
          ++controls.projectReadsAfterWrite === 2
        )
          throw new Error('PRIVATE_SYNC_READ_FAILURE');
        if (
          controls.projectUnavailableAfterDependency &&
          writes.includes('dependency') &&
          query.includes('ProjectDelivery')
        )
          throw new Error('PRIVATE_PROJECT_READ_FAILURE');
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
                      id: controls.parentNodeId || `ISSUE${parents.get(number)}`,
                      number: parents.get(number),
                      repository: { nameWithOwner: controls.parentRepository },
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
        if (query.includes('ProjectDeliveryIssueItems'))
          return issueProjectItemsResponse(
            variables,
            [...rows.keys()]
              .filter((n) => `ISSUE${n}` === variables.issueNodeId)
              .map((n) => ({
                id: `ITEM${n}`,
                isArchived: controls.archived,
                content: { id: `ISSUE${n}` },
                fieldValueByName: {
                  name: statuses.get(n),
                  optionId:
                    statuses.get(n) === 'In Review'
                      ? 'REVIEW'
                      : statuses.get(n) === 'Active'
                        ? 'ACTIVE'
                        : statuses.get(n) === 'Shipped'
                          ? 'DONE'
                          : statuses.get(n) === 'Waiting'
                            ? 'BLOCKED'
                            : 'TODO',
                },
              })),
          );
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
          if (controls.loseProjectAck) {
            controls.loseProjectAck = false;
            throw new Error('PRIVATE_PROJECT_ACK');
          }
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
                  statuses.get(number) === 'In Review'
                    ? 'REVIEW'
                    : statuses.get(number) === 'Active'
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
  return { context, rows, writes, dateWrites, comments, controls, metadata, parents, blockers, statuses };
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

test.each([{}, { status: { nextMilestone: 'Run checks' } }, { blockedBy: [2] }])(
  'canonical-body retries with overrides %j preserve generated timestamps and history',
  async (overrides) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-17T00:00:00.000Z'));
    const f = batchFixture();
    const body = renderIssueBody(
      IssueFields.parse({ title: 'Synthetic item 1', draft: true, problem: 'Changed contract' }),
      {
        state: 'Draft',
        lastUpdated: '2026-01-01T00:00:00.000Z',
        nextMilestone: 'Not started',
        blockers: 'None',
        latestJournal: 'None yet',
      },
    );
    f.statuses.set(1, 'Queued');
    const input = { items: [{ issueNumber: 1, body, preserveHistory: true, ...overrides }] };
    const first = await runBatch(input);
    assert.equal(first.results[0]!.status, 'applied', JSON.stringify(first));
    const writtenBody = f.rows.get(1)!.body;
    const writes = [...f.writes];
    const comments = [...f.comments];
    clock.mockReturnValue(Date.parse('2026-10-17T00:01:00.000Z'));
    const retry = await runBatch(input);
    assert.equal(retry.results[0]!.status, 'unchanged', JSON.stringify(retry));
    assert.equal(f.rows.get(1)!.body, writtenBody);
    assert.deepEqual(f.writes, writes);
    assert.deepEqual(f.comments, comments);
    clock.mockReturnValue(Date.parse('2026-10-17T00:02:00.000Z'));
    assert.equal((await runBatch(input)).results[0]!.status, 'unchanged');
    assert.deepEqual(f.writes, writes);
    assert.deepEqual(f.comments, comments);
  },
);

test.each([
  ['foreign/repository', 'FOREIGN5'],
  ['example/widget', 'DIFFERENT5'],
])('same-number parent in %s with node %s cannot satisfy a batch retry', async (repository, nodeId) => {
  const f = batchFixture();
  const input = { items: [{ issueNumber: 1, parentIssueNumber: 5 }] };
  assert.equal((await runBatch(input)).results[0]!.status, 'applied');
  const writes = [...f.writes];
  f.controls.parentRepository = repository;
  f.controls.parentNodeId = nodeId;
  const result = await runBatch(input);
  assert.equal(result.results[0]!.status, 'failed', JSON.stringify(result));
  assert.deepEqual(f.writes, writes);
});

test('correctable local batch refusals retain distinct bounded reasons', async () => {
  const f = batchFixture();
  const result = await runBatch({
    items: [
      { issueNumber: 1, priority: 'Unsupported' },
      { issueNumber: 2, labels: ['unknown-label-private-content'] },
      { issueNumber: 3, blocks: [4] },
    ],
  });
  assert.deepEqual(
    result.results.map((item) => item.status),
    ['failed', 'failed', 'failed'],
  );
  assert.match(result.results[0]!.reason!, /configured Priority/u);
  assert.match(result.results[1]!.reason!, /labels.*selected repository/u);
  assert.match(result.results[2]!.reason!, /overrideReason/u);
  assert.equal(JSON.stringify(result).includes('unknown-label-private-content'), false);
  assert.deepEqual(f.writes, []);
});

test('a conflicting closure reason explains the required explicit reopen without more writes', async () => {
  const f = batchFixture();
  assert.equal(
    (await runBatch({ items: [{ issueNumber: 1, state: 'closed', closeReason: 'not_planned' }] })).results[0]!.status,
    'applied',
  );
  const writes = [...f.writes];
  const comments = [...f.comments];
  const result = await runBatch({ items: [{ issueNumber: 1, state: 'closed', closeReason: 'completed' }] });
  assert.equal(result.results[0]!.status, 'failed');
  assert.match(result.results[0]!.reason!, /different closure evidence; reopen it explicitly/u);
  assert.deepEqual(f.writes, writes);
  assert.deepEqual(f.comments, comments);
});

test('unknown remote errors, message getters and proxies retain the generic safe batch failure', async () => {
  const f = batchFixture();
  let inspected = 0;
  const getter = Object.defineProperty(new DeliveryError(''), 'message', {
    get() {
      inspected++;
      throw new Error('PRIVATE_GETTER_CONTENT');
    },
  });
  const proxy = new Proxy(new DeliveryError('PRIVATE_PROXY_CONTENT'), {
    get() {
      inspected++;
      throw new Error('PRIVATE_PROXY_CONTENT');
    },
    getPrototypeOf() {
      inspected++;
      throw new Error('PRIVATE_PROXY_CONTENT');
    },
  });
  const get = vi.spyOn(f.context.clients.rest.issues, 'get');
  for (const error of [new DeliveryError('PRIVATE_REMOTE_CONTENT'), getter, proxy]) {
    get.mockRejectedValue(error);
    const result = await runBatch({ items: [{ issueNumber: 1, title: 'Requested update' }] });
    assert.equal(result.results[0]!.status, 'failed');
    assert.match(result.results[0]!.reason!, /preparation failed/u);
    assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  }
  assert.equal(inspected, 0);
  assert.deepEqual(f.writes, []);
});

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
  assert.equal(
    f.writes.filter((write) => write.startsWith('update:1')).length,
    1,
    'recovery must not replay the committed native update',
  );
  assert.deepEqual(
    (await runBatch(input)).results.map((item) => item.status),
    ['unchanged', 'unchanged'],
  );
});

test('archived partial closure resumes only Project work after separate restoration and then becomes a no-op', async () => {
  const f = batchFixture();
  const unrelated = structuredClone(f.rows.get(2));
  f.rows.get(1)!.labels.push('enhancement');
  f.controls.archiveAfterWrite = true;
  const input = {
    items: [
      {
        issueNumber: 1,
        title: 'Closed item',
        state: 'closed' as const,
        closeReason: 'not_planned' as const,
        preserveHistory: true,
      },
    ],
  };
  const first = await runBatch(input);
  assert.equal(first.summary.failed, 1);
  assert.equal(f.rows.get(1)!.state, 'closed');
  const nativeWrites = f.writes.filter((write) => write !== 'project');
  const comments = structuredClone(f.comments);
  const archived = await runBatch(input);
  assert.equal(archived.summary.failed, 1);
  assert.deepEqual(
    f.writes.filter((write) => write !== 'project'),
    nativeWrites,
  );
  assert.deepEqual(f.comments, comments);
  f.controls.archiveAfterWrite = false;
  f.controls.archived = false; // A separately authorized restoration, outside recovery.
  const resumed = await runBatch(input);
  assert.equal(resumed.summary.applied, 1);
  assert.equal(resumed.results[0]!.readback!.projectStatus, 'Done');
  assert.deepEqual(
    f.writes.filter((write) => write !== 'project'),
    nativeWrites,
  );
  assert.deepEqual(f.comments, comments);
  const count = f.writes.length;
  assert.equal((await runBatch(input)).summary.unchanged, 1);
  assert.equal(f.writes.length, count);
  assert.deepEqual(f.rows.get(1)!.labels, ['enhancement']);
  assert.deepEqual(f.rows.get(2), unrelated);
});

test('archived date and parent updates resume only Project work without replaying committed native fields', async () => {
  const f = batchFixture();
  f.metadata.set(1, { '104': '2028-03-31' });
  f.controls.archiveAfterWrite = true;
  const input = {
    items: [
      {
        issueNumber: 1,
        title: 'Dated item',
        startDate: '2028-02-29',
        targetDate: null,
        parentIssueNumber: 5,
        preserveHistory: true,
      },
    ],
  };
  const first = await runBatch(input);
  assert.equal(first.summary.failed, 1);
  assert.equal(first.results[0]!.incomplete?.native.status, 'confirmed');
  assert.equal(first.results[0]!.incomplete?.native.readback?.startDate, '2028-02-29');
  assert.equal(first.results[0]!.incomplete?.native.readback?.targetDate, null);
  const nativeWrites = f.writes.filter((write) => write !== 'project');
  const comments = structuredClone(f.comments);
  assert.equal((await runBatch(input)).summary.failed, 1);
  assert.deepEqual(
    f.writes.filter((write) => write !== 'project'),
    nativeWrites,
  );
  f.controls.archiveAfterWrite = false;
  f.controls.archived = false; // Separately authorized restoration, outside recovery.
  const resumed = await runBatch(input);
  assert.equal(resumed.summary.applied, 1);
  assert.deepEqual(
    f.writes.filter((write) => write !== 'project'),
    nativeWrites,
  );
  assert.deepEqual(f.comments, comments);
  assert.deepEqual(f.dateWrites, [[103], [104]]);
  assert.equal(f.parents.get(1), 5);
  assert.equal((await runBatch(input)).summary.unchanged, 1);
});

for (const [committedId, pendingId] of [
  [103, 104],
  [104, 103],
]) {
  test(`mixed date retry writes only pending field ${pendingId} and preserves committed field ${committedId}`, async () => {
    const f = batchFixture();
    f.metadata.set(1, { [committedId!]: '2028-02-29', [pendingId!]: '2028-03-31' });
    const first = await runBatch({
      items: [
        {
          issueNumber: 1,
          startDate: committedId === 103 ? '2028-02-29' : null,
          targetDate: committedId === 104 ? '2028-02-29' : null,
        },
      ],
    });
    assert.equal(first.summary.applied, 1);
    assert.deepEqual(f.dateWrites, [[pendingId]]);
    assert.equal(f.metadata.get(1)![String(committedId)], '2028-02-29');
    assert.equal(f.metadata.get(1)![String(pendingId)], undefined);
  });
}

test('lost Project acknowledgement is incomplete until a read-only batch reconciliation proves a no-op', async () => {
  const f = batchFixture();
  f.controls.loseProjectAck = true;
  const input = { items: [{ issueNumber: 1, state: 'closed' as const, closeReason: 'completed' as const }] };
  const first = await runBatch(input);
  assert.equal(first.summary.failed, 1);
  assert.equal(first.results[0]!.incomplete?.native.status, 'confirmed');
  assert.equal(first.results[0]!.incomplete?.project.status, 'unknown');
  assert.equal(JSON.stringify(first).includes('PRIVATE_'), false);
  const writes = [...f.writes];
  const comments = structuredClone(f.comments);
  assert.equal((await runBatch(input)).summary.unchanged, 1);
  assert.deepEqual(f.writes, writes);
  assert.deepEqual(f.comments, comments);
});

test.each(['add', 'remove'] as const)(
  'remaining Project target reflects the committed %s blocker change after Project reads fail',
  async (action) => {
    const f = batchFixture();
    f.controls.projectUnavailableAfterDependency = true;
    f.statuses.set(1, action === 'remove' ? 'Waiting' : 'Queued');
    if (action === 'remove') f.blockers.set(1, [2]);
    const blockers = action === 'remove' ? [] : [2];
    const first = await runBatch({ items: [{ issueNumber: 1, blockedBy: blockers }] });
    const partial = first.results[0]!.incomplete;
    assert.equal(first.summary.failed, 1);
    assert.equal(partial?.native.status, 'confirmed');
    assert.deepEqual(partial?.native.readback?.blockedBy, blockers);
    assert.equal(partial?.project.desiredStatus, action === 'remove' ? 'Todo' : 'Blocked');
    assert.equal(JSON.stringify(first).includes('PRIVATE_'), false);
    const nativeWrites = f.writes.filter((write) => write !== 'project');
    f.controls.projectUnavailableAfterDependency = false;
    assert.equal((await runBatch({ items: [{ issueNumber: 1, blockedBy: blockers }] })).summary.applied, 1);
    assert.deepEqual(
      f.writes.filter((write) => write !== 'project'),
      nativeWrites,
    );
  },
);

test('unknown native blocker evidence does not claim a stale remaining Project target', async () => {
  const f = batchFixture();
  f.blockers.set(1, [2]);
  f.statuses.set(1, 'Waiting');
  f.controls.nativeUnavailableAfterDependency = true;
  const first = await runBatch({ items: [{ issueNumber: 1, blockedBy: [] }] });
  const partial = first.results[0]!.incomplete;
  assert.equal(partial?.native.status, 'unknown');
  assert.equal(partial?.project.desiredStatus, null);
  assert.equal(JSON.stringify(first).includes('PRIVATE_'), false);
});

test('a successful newer Project observation is retained when the subsequent synchronization fails', async () => {
  const f = batchFixture();
  f.controls.moveProjectToTodoAfterWrite = true;
  const input = { items: [{ issueNumber: 1, status: { latestJournal: 'Native journal updated' } }] };
  const first = await runBatch(input);
  assert.equal(first.summary.failed, 1);
  const partial = first.results[0]!.incomplete;
  assert.equal(partial?.native.status, 'confirmed');
  assert.equal(partial?.project.desiredStatus, 'Todo');
  assert.equal(JSON.stringify(first).includes('PRIVATE_'), false);
  const writes = [...f.writes];
  assert.equal((await runBatch(input)).summary.unchanged, 1);
  assert.deepEqual(f.writes, writes);
});

test('MCP serializes the actual incomplete update payload with error semantics', async () => {
  const f = batchFixture();
  f.controls.loseProjectAck = true;
  const server = createAiDeliveryMcpServer({ repoRoot: '/synthetic', identity: 'host-author' });
  const client = new Client({ name: 'partial-update-synthetic', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: 'issue_update',
      arguments: { repo: 'example/widget', issueNumber: 1, state: 'closed', closeReason: 'completed' },
    });
    assert.equal(result.isError, true);
    const content = result.content as { type: string; text: string }[];
    const partial = JSON.parse(content[0]!.text) as {
      status: string;
      native: { status: string; readback: issue.IssueInfo };
      project: { desiredStatus: string };
    };
    assert.equal(partial.status, 'update-incomplete');
    assert.equal(partial.native.status, 'confirmed');
    assert.equal(partial.native.readback.state, 'closed');
    assert.equal(partial.project.desiredStatus, 'Done');
  } finally {
    await client.close();
    await server.close();
  }
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

// Recorded Oct 31 (aviaratech/ai-delivery#240): closing #171 and #178 reported "failed", although GitHub
// closed both and their archived Project items already showed Done.
test('closing an issue whose archived Project item already shows Done reports applied', async () => {
  const f = batchFixture();
  f.controls.archived = true;
  f.statuses.set(1, 'Shipped');
  const result = await runBatch({ items: [{ issueNumber: 1, state: 'closed', closeReason: 'not_planned' }] });
  assert.equal(f.rows.get(1)!.state, 'closed');
  assert.deepEqual(result.summary, { total: 1, applied: 1, planned: 0, unchanged: 0, failed: 0, rateLimits: [] });
});

// #65: GitHub's PR-linked workflow may move an issue to Project #4's optional In Review option.
test('an In Review item reads as active work, survives In Progress and moves to Done on close', async () => {
  const f = batchFixture();
  f.statuses.set(1, 'In Review');
  const info = await issue.issueInfo(f.context, 1);
  assert.equal(info.projectStatus, 'In Progress');
  assert.equal(info.inReview, true);
  await syncIssueProjectStatus({
    configuration: f.context.projectConfiguration!,
    graphql: f.context.clients.graphql,
    issueNodeId: 'ISSUE1',
    org: 'example',
    status: 'In Progress',
  });
  assert.equal(f.statuses.get(1), 'In Review');
  await runBatch({ items: [{ issueNumber: 1, state: 'closed', closeReason: 'completed' }] });
  assert.equal(f.statuses.get(1), 'Shipped');
});
