import type { DeliveryContext } from '../issue.js';
import { IssueFields, renderIssueBody } from '../issueContract.js';
import { syntheticDiscoveryConfig } from './discovery.js';
export function issue63Fixture() {
  const ready = IssueFields.parse({
    title: 'Guard active widget dependency additions',
    points: 2,
    problem: 'Unexplained blockers interrupt active work.',
    outcome: 'Require deliberate blocker additions.',
    acceptanceCriteria: [
      { behavior: 'Missing reasons refuse dependency writes.', verifiedBy: 'Native dependency regression fixture.' },
    ],
    outOfScope: ['Readiness changes.'],
  });
  const rows = new Map(
    [17, 18, 19].map((number) => [
      number,
      {
        number,
        id: 100 + number,
        node_id: `ISSUE${number}`,
        title: ready.title,
        body: renderIssueBody(ready),
        state: 'open',
        created_at: '2026-01-01T00:00:00Z',
        html_url: `https://github.com/example/widget/issues/${number}`,
        type: { name: 'Task' },
      },
    ]),
  );
  const edges = new Map<number, Set<number>>([
    [17, new Set()],
    [18, new Set()],
    [19, new Set()],
  ]);
  const statuses = new Map([
    [17, 'Active'],
    [18, 'Queued'],
    [19, 'Queued'],
  ]);
  const writes: string[] = [];
  const graphqlCalls: { query: string; variables: Record<string, unknown> }[] = [];
  const comments: { id: number; body: string; html_url: string; issue_url: string; user: { login: string } }[] = [];
  const history: Record<string, unknown>[] = [];
  const histories = new Map<number, Record<string, unknown>[]>();
  const controls = {
    timelineIncomplete: false,
    missingProjectIssue: undefined as number | undefined,
    missingProjectStatus: undefined as number | undefined,
    projectItemReadback: undefined as Record<string, unknown> | undefined,
    commentRace: undefined as (() => void) | undefined,
    actor: 'operator',
    corruptComment: false,
    failAdd: false,
    reads: 0,
    race: undefined as (() => void) | undefined,
  };
  const get = (n: number) => {
    const row = rows.get(n);
    if (!row) throw new Error('Unknown fixture issue');
    return row;
  };
  const configuration = {
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
      points: syntheticDiscoveryConfig.native.points,
      priority: syntheticDiscoveryConfig.native.priority,
    },
  };
  const context = {
    root: '/synthetic',
    repo: { owner: 'example', repo: 'widget' },
    config: syntheticDiscoveryConfig,
    projectConfiguration: configuration,
    clients: {
      role: 'author',
      authenticatedAuthor: async () => {
        if (!controls.actor) throw new Error('Author unavailable');
        return { actorLogin: controls.actor, credentialIdentity: 'user:1' };
      },
      rest: {
        issues: {
          get: async ({ issue_number }: { issue_number: number }) => ({ data: { ...get(issue_number) } }),
          update: async (input: { issue_number: number; body?: string; title?: string; type?: string }) => {
            writes.push('content');
            controls.race?.();
            controls.race = undefined;
            Object.assign(get(input.issue_number), input);
            if (input.type) get(input.issue_number).type = { name: input.type };
            return { data: get(input.issue_number) };
          },
          create: async (input: Record<string, unknown>) => {
            writes.push('create');
            const n = 20;
            rows.set(n, {
              ...get(18),
              ...input,
              number: n,
              id: 120,
              node_id: 'ISSUE20',
              html_url: 'https://github.com/example/widget/issues/20',
            } as ReturnType<typeof get>);
            edges.set(n, new Set());
            statuses.set(n, 'Queued');
            return { data: get(n) };
          },
          listForRepo: async () => ({ data: [...rows.values()] }),
          listComments: async ({ issue_number }: { issue_number: number }) => ({
            data: comments.filter((c) => c.issue_url.endsWith(`/issues/${issue_number}`)),
          }),
          createComment: async ({ body, issue_number }: { body: string; issue_number: number }) => {
            writes.push('comment');
            const c = {
              id: 91 + comments.length,
              body,
              html_url: `https://github.com/example/widget/issues/${issue_number}#issuecomment-${91 + comments.length}`,
              issue_url: `https://api.github.com/repos/example/widget/issues/${issue_number}`,
              user: { login: 'operator' },
            };
            comments.push(c);
            return { data: c };
          },
          getComment: async ({ comment_id }: { comment_id: number }) => {
            controls.commentRace?.();
            controls.commentRace = undefined;
            return {
              data: {
                ...comments.find((c) => c.id === comment_id),
                ...(controls.corruptComment ? { body: 'Wrong authority' } : {}),
              },
            };
          },
          listSubIssues: async () => ({ data: [] }),
        },
        request: async (route: string) => {
          if (!route.startsWith('GET')) writes.push('metadata');
          return {
            data: route.includes('/orgs/')
              ? [
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
                ]
              : [{ issue_field_id: 101, issue_field_name: 'Estimate', data_type: 'single_select', value: '2' }],
          };
        },
      },
      graphql: async (query: string, v: Record<string, unknown>) => {
        graphqlCalls.push({ query, variables: structuredClone(v) });
        if (query.includes('NativeIssueHistory'))
          return {
            repository: {
              nameWithOwner: 'example/widget',
              issue: {
                id: `ISSUE${String(v.number)}`,
                number: v.number,
                repository: { nameWithOwner: 'example/widget' },
                timelineItems: {
                  nodes: histories.get(Number(v.number)) ?? history,
                  pageInfo: {
                    hasNextPage: controls.timelineIncomplete,
                    endCursor: controls.timelineIncomplete ? 'repeat' : null,
                  },
                },
              },
            },
          };
        if (query.includes('blockedBy(first:')) {
          controls.reads++;
          return {
            repository: {
              issue: {
                parent: null,
                blockedBy: {
                  nodes: [...(edges.get(Number(v.number)) ?? [])].map((n) => ({
                    id: `ISSUE${n}`,
                    number: n,
                    title: 'Blocker',
                    state: 'OPEN',
                    repository: { nameWithOwner: 'example/widget' },
                  })),
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          };
        }
        if (query.includes('ProjectDeliveryItems'))
          return {
            organization: {
              projectV2: {
                items: {
                  nodes: [...rows.values()]
                    .filter((row) => row.number !== controls.missingProjectIssue)
                    .map((r) => ({
                      id: `ITEM${r.number}`,
                      isArchived: false,
                      content: { id: r.node_id },
                      fieldValueByName:
                        controls.missingProjectStatus === r.number
                          ? null
                          : {
                              name: statuses.get(r.number),
                              optionId:
                                statuses.get(r.number) === 'Active'
                                  ? 'ACTIVE'
                                  : statuses.get(r.number) === 'Waiting'
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
          const n = Number(String(v.itemId).replace('ITEM', ''));
          statuses.set(n, v.optionId === 'ACTIVE' ? 'Active' : v.optionId === 'BLOCKED' ? 'Waiting' : 'Queued');
          writes.push('status');
          return { updateProjectV2ItemFieldValue: { projectV2Item: { id: v.itemId } } };
        }
        if (query.includes('ProjectDeliveryItemReadback')) {
          const n = Number(String(v.itemId).replace('ITEM', ''));
          return {
            node: {
              id: v.itemId,
              isArchived: false,
              project: { id: 'PROJECT', number: 1 },
              content: { id: `ISSUE${n}` },
              fieldValueByName: {
                name: statuses.get(n),
                optionId: statuses.get(n) === 'Active' ? 'ACTIVE' : statuses.get(n) === 'Waiting' ? 'BLOCKED' : 'TODO',
              },
              ...controls.projectItemReadback,
            },
          };
        }
        if (query.includes('addBlockedBy')) {
          if (controls.failAdd) throw new Error('Native add failed');
          const n = Number(String(v.issue).replace('ISSUE', '')),
            b = Number(String(v.blocking).replace('ISSUE', ''));
          edges.get(n)!.add(b);
          writes.push('add');
          return { addBlockedBy: { issue: { number: n } } };
        }
        if (query.includes('removeBlockedBy')) {
          edges
            .get(Number(String(v.issue).replace('ISSUE', '')))!
            .delete(Number(String(v.blocking).replace('ISSUE', '')));
          writes.push('remove');
          return {};
        }
        throw new Error('Unexpected fixture query ' + query);
      },
    },
  } as unknown as DeliveryContext;
  return { context, ready, rows, edges, statuses, writes, graphqlCalls, comments, history, histories, controls };
}
