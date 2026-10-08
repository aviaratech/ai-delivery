import assert from 'node:assert/strict';
import { test } from 'vitest';
import * as issue from './issue.js';
import { getAiDeliveryMcpTool } from './mcp/tools.js';
import { syntheticDiscoveryConfig } from './fixtures/discovery.js';
import type { DeliveryContext } from './issue.js';

const listIssues = (
  issue as unknown as {
    listIssues: (context: DeliveryContext, input: unknown) => Promise<{ issues: unknown[]; nextPage: number | null }>;
  }
).listIssues;

function listingFixture(
  options: {
    foreign?: boolean;
    incomplete?: boolean;
    invalidField?: boolean;
    foreignParent?: boolean;
    missingOption?: boolean;
    dualBlockers?: boolean;
    missingMulti?: boolean;
  } = {},
) {
  const requests: Record<string, unknown>[] = [];
  const context = {
    root: '/synthetic',
    repo: { owner: 'example', repo: 'widget' },
    config: syntheticDiscoveryConfig,
    projectConfiguration: {
      projectId: 'PROJECT',
      projectNumber: 1,
      title: 'Delivery',
      writable: false,
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
      rest: {
        issues: {
          listForRepo: async (params: Record<string, unknown>) => {
            requests.push(params);
            return {
              data: [
                {
                  number: 17,
                  node_id: 'ISSUE17',
                  title: 'Repair widget',
                  state: 'open',
                  labels: [{ name: 'area:widget' }],
                  type: { name: 'Task' },
                  html_url: options.foreign
                    ? 'https://github.com/elsewhere/widget/issues/17'
                    : 'https://github.com/example/widget/issues/17',
                  updated_at: '2026-10-07T00:00:00Z',
                },
                { number: 18, pull_request: {} },
              ],
            };
          },
        },
        search: {
          issuesAndPullRequests: async (params: Record<string, unknown>) => {
            requests.push(params);
            return { data: { total_count: 0, incomplete_results: options.incomplete ?? false, items: [] } };
          },
        },
        request: async (route: string, params: Record<string, unknown>) => {
          requests.push({ route, ...params });
          if (route.includes('/orgs/'))
            return {
              data: [
                { id: 101, name: 'Estimate', data_type: 'single_select' },
                { id: 102, name: 'Urgency', data_type: 'single_select' },
                { id: 103, name: 'Start date', data_type: 'date' },
                ...(options.missingMulti ? [{ id: 104, name: 'Tags', data_type: 'multi_select' }] : []),
              ],
            };
          return {
            data: [
              {
                issue_field_id: 101,
                issue_field_name: options.invalidField ? 'Foreign estimate' : 'Estimate',
                data_type: 'single_select',
                value: 44,
                ...(options.missingOption ? {} : { single_select_option: { id: 44, name: '4' } }),
              },
              { issue_field_id: 103, issue_field_name: 'Start date', data_type: 'date', value: '2026-10-07' },
              ...(options.missingMulti
                ? [{ issue_field_id: 104, issue_field_name: 'Tags', data_type: 'multi_select', value: 'one' }]
                : []),
            ],
          };
        },
      },
      graphql: async (query: string) => {
        if (query.includes('blockedBy(first:'))
          return {
            repository: {
              issue: {
                parent: {
                  id: 'PARENT9',
                  number: 9,
                  repository: { nameWithOwner: options.foreignParent ? 'example/other' : 'example/widget' },
                },
                blockedBy: {
                  nodes: [
                    {
                      id: 'BLOCKER8',
                      number: 8,
                      title: 'Prerequisite',
                      state: 'CLOSED',
                      repository: { nameWithOwner: 'example/widget' },
                    },
                    ...(options.dualBlockers
                      ? [
                          {
                            id: 'FOREIGN8',
                            number: 8,
                            title: 'Other prerequisite',
                            state: 'OPEN',
                            repository: { nameWithOwner: 'example/other' },
                          },
                        ]
                      : []),
                  ],
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
                      id: 'ITEM17',
                      isArchived: false,
                      content: { id: 'ISSUE17' },
                      fieldValueByName: { name: 'Active', optionId: 'ACTIVE' },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          };
        throw new Error('Unexpected query');
      },
    },
  } as unknown as DeliveryContext;
  return { context, requests };
}

test('typed listing filters stay repository-bound and expose named fields without identifiers', async () => {
  const tool = getAiDeliveryMcpTool('issue_list');
  assert.ok(tool, 'issue_list is registered');
  const input = tool.inputSchema.parse({
    state: 'open',
    labels: ['area:widget'],
    parentIssueNumber: 9,
    issueType: 'Task',
    projectStatus: 'In Progress',
    updatedSince: '2026-10-01T00:00:00Z',
    perPage: 2,
  });
  const { context, requests } = listingFixture();
  const result = await listIssues(context, input);
  assert.equal(result.nextPage, 2);
  assert.deepEqual(result.issues, [
    {
      number: 17,
      title: 'Repair widget',
      state: 'open',
      labels: ['area:widget'],
      issueType: 'Task',
      parentIssueNumber: 9,
      parent: { repository: 'example/widget', number: 9 },
      blockers: [{ repository: 'example/widget', number: 8, title: 'Prerequisite', state: 'CLOSED' }],
      projectStatus: 'In Progress',
      fields: { Estimate: '4', Urgency: null, 'Start date': '2026-10-07' },
      url: 'https://github.com/example/widget/issues/17',
      updatedAt: '2026-10-07T00:00:00Z',
    },
  ]);
  assert.equal(requests[0]?.owner, 'example');
  assert.equal(requests[0]?.since, '2026-10-01T00:00:00Z');
  assert.equal(JSON.stringify(result).includes('BLOCKER8'), false);
});

test('search quotes user text so it cannot change the selected repository', async () => {
  const tool = getAiDeliveryMcpTool('issue_search');
  assert.ok(tool, 'issue_search is registered');
  const input = tool.inputSchema.parse({ query: 'repo:elsewhere/project', page: 2, perPage: 10 });
  const { context, requests } = listingFixture();
  const result = await listIssues(context, input);
  assert.equal(result.nextPage, null);
  assert.equal(requests[0]?.q, 'repo:example/widget is:issue "repo:elsewhere/project"');
});

test('update accepts history and reasoned closure while rejecting incoherent requests', () => {
  const tool = getAiDeliveryMcpTool('issue_update');
  assert.ok(tool);
  assert.equal(tool.inputSchema.safeParse({ issueNumber: 17, body: 'new body', preserveHistory: true }).success, true);
  assert.equal(
    tool.inputSchema.safeParse({ issueNumber: 17, state: 'closed', closeReason: 'duplicate', supersededBy: 9 }).success,
    true,
  );
  assert.equal(tool.inputSchema.safeParse({ issueNumber: 17, state: 'open', closeReason: 'completed' }).success, false);
});

test('local filters retain pagination when the current GitHub page has no matching issue', async () => {
  const { context } = listingFixture();
  const result = await listIssues(context, { parentIssueNumber: null, perPage: 2 });
  assert.deepEqual(result.issues, []);
  assert.equal(result.nextPage, 2);
});

test('foreign issue identity and mismatched organization fields fail rather than returning false readback', async () => {
  await assert.rejects(listIssues(listingFixture({ foreign: true }).context, {}), /foreign repository/u);
  await assert.rejects(listIssues(listingFixture({ invalidField: true }).context, {}), /conflicts with its catalog/u);
});

test('search refuses incomplete upstream results and invalid literal text', async () => {
  await assert.rejects(
    listIssues(listingFixture({ incomplete: true }).context, { query: 'widget' }),
    /incomplete results/u,
  );
  await assert.rejects(listIssues(listingFixture().context, { query: '" repo:elsewhere/widget' }), /literal text/u);
  assert.equal(getAiDeliveryMcpTool('issue_list')?.inputSchema.safeParse({ perPage: 101 }).success, false);
});

test('a foreign parent with the same issue number cannot satisfy a local parent filter', async () => {
  const { context } = listingFixture({ foreignParent: true });
  assert.deepEqual((await listIssues(context, { parentIssueNumber: 9 })).issues, []);
});

test('label filters preserve GitHub case-insensitive label identity', async () => {
  const { context } = listingFixture();
  assert.equal((await listIssues(context, { labels: ['AREA:Widget'] })).issues.length, 1);
});

test('a set select field without its named option fails rather than reporting unset', async () => {
  await assert.rejects(listIssues(listingFixture({ missingOption: true }).context, {}), /option/u);
});

test('same-number blockers in different repositories retain both qualified identities', async () => {
  const { context } = listingFixture({ dualBlockers: true });
  const result = await issue.listIssues(context, {});
  assert.deepEqual(result.issues[0]?.blockers, [
    { repository: 'example/widget', number: 8, title: 'Prerequisite', state: 'CLOSED' },
    { repository: 'example/other', number: 8, title: 'Other prerequisite', state: 'OPEN' },
  ]);
});

test('a set multi-select field without named options cannot be reported unset', async () => {
  await assert.rejects(listIssues(listingFixture({ missingMulti: true }).context, {}), /option/u);
});

test('history rendering preserves whitespace and escapes content that could end the collapsed section', () => {
  const render = (issue as unknown as { renderIssueHistory: (title: string, body: string) => string })
    .renderIssueHistory;
  assert.equal(typeof render, 'function');
  const body = '  old body\n</pre></details><script>x</script> & text  ';
  const result = render('Old <title> & name', body);
  assert.equal(
    result,
    '<details>\n<summary>Previous issue title and body</summary>\n\nTitle:\n<pre>Old &lt;title&gt; &amp; name</pre>\n\nBody:\n<pre>  old body\n&lt;/pre&gt;&lt;/details&gt;&lt;script&gt;x&lt;/script&gt; &amp; text  </pre>\n\n</details>',
  );
});

test('closure evidence reads native reason and preserves qualified duplicate identity', async () => {
  const { context } = listingFixture();
  context.clients.graphql = (async () => ({
    repository: {
      issue: {
        number: 17,
        repository: { nameWithOwner: 'example/widget' },
        state: 'CLOSED',
        stateReason: 'DUPLICATE',
        duplicateOf: { number: 9, repository: { nameWithOwner: 'example/other' } },
      },
    },
  })) as unknown as typeof context.clients.graphql;
  const read = (
    issue as unknown as { readIssueClosure: (context: DeliveryContext, issueNumber: number) => Promise<unknown> }
  ).readIssueClosure;
  assert.equal(typeof read, 'function');
  assert.deepEqual(await read(context, 17), {
    state: 'closed',
    closeReason: 'duplicate',
    duplicateOf: { number: 9, repository: 'example/other' },
  });
});

test('native field catalog and values both paginate through the last named field', async () => {
  const { context } = listingFixture();
  const requests: { route: string; page: unknown }[] = [];
  context.clients.rest.request = (async (route: string, params: Record<string, unknown>) => {
    requests.push({ route, page: params.page });
    const catalog = route.includes('/orgs/');
    if (params.page === 2)
      return {
        data: catalog
          ? [{ id: 201, name: 'Late date', data_type: 'date' }]
          : [{ issue_field_id: 201, issue_field_name: 'Late date', data_type: 'date', value: '2026-10-09' }],
      };
    return {
      data: catalog
        ? [
            { id: 101, name: 'Estimate', data_type: 'single_select' },
            { id: 102, name: 'Urgency', data_type: 'single_select' },
            ...Array.from({ length: 98 }, (_, index) => ({
              id: index + 103,
              name: `Custom ${String(index)}`,
              data_type: 'text',
            })),
          ]
        : [
            {
              issue_field_id: 101,
              issue_field_name: 'Estimate',
              data_type: 'single_select',
              value: 44,
              single_select_option: { name: '4' },
            },
            { issue_field_id: 102, issue_field_name: 'Urgency', data_type: 'single_select', value: null },
            ...Array.from({ length: 98 }, (_, index) => ({
              issue_field_id: index + 103,
              issue_field_name: `Custom ${String(index)}`,
              data_type: 'text',
              value: 'retained',
            })),
          ],
    };
  }) as unknown as typeof context.clients.rest.request;
  const result = await issue.listIssues(context, {});
  assert.equal(result.issues[0]?.fields['Late date'], '2026-10-09');
  assert.equal(result.issues[0]?.fields.Urgency, null);
  assert.deepEqual(
    requests.map((request) => request.page),
    [1, 2, 1, 2],
  );
});

test('native field pagination fails closed on a repeated nonadvancing page', async () => {
  const { context } = listingFixture();
  context.clients.rest.request = (async () => ({
    data: Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: `Field ${String(index)}`,
      data_type: 'text',
    })),
  })) as unknown as typeof context.clients.rest.request;
  await assert.rejects(issue.listIssues(context, {}), /repeated a pagination page/u);
});

test('search applies the same case-insensitive label filter to authoritative result rows', async () => {
  const { context } = listingFixture();
  context.clients.rest.search.issuesAndPullRequests = (async () => ({
    data: {
      total_count: 1,
      incomplete_results: false,
      items: [
        {
          number: 17,
          node_id: 'ISSUE17',
          title: 'Repair widget',
          state: 'open',
          labels: [{ name: 'area:widget' }],
          type: { name: 'Task' },
          html_url: 'https://github.com/example/widget/issues/17',
          updated_at: '2026-10-07T00:00:00Z',
        },
      ],
    },
  })) as unknown as typeof context.clients.rest.search.issuesAndPullRequests;
  const result = await issue.listIssues(context, { query: 'widget', labels: ['AREA:Widget'] });
  assert.equal(result.issues.length, 1);
  assert.equal(result.nextPage, null);
});
