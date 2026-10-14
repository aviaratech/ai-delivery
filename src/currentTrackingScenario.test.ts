import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { test, vi } from 'vitest';
import * as githubClients from './github/client.js';
import { syntheticDiscoveryClients, syntheticDiscoveryConfig } from './fixtures/discovery.js';
import { createAiDeliveryMcpServer } from './mcp/index.js';
import { canonicalIssueBody, type IssueInfo } from './issue.js';

type Input = Record<string, unknown>;
interface StoredIssue {
  number: number;
  id: number;
  node_id: string;
  title: string;
  body: string;
  state: string;
  type: { name: string };
  labels: string[];
  html_url: string;
  updated_at: string;
  parent: number | null;
  points?: number;
  priority?: string;
  status: string | null;
  reason: string | null;
}
interface Comment {
  id: number;
  body: string;
  html_url: string;
  issue_url: string;
  user: { login: string };
}

// Only the external GitHub/auth port is replaced. Reads reflect stored writes;
// unexpected endpoints and foreign targets fail instead of returning canned success.
function trackingRepository() {
  const issues = new Map<number, StoredIssue>();
  const comments: Comment[] = [];
  const events: string[] = [];
  let writes = 0;
  const add = (number: number, title: string, body: string, parent: number | null) => {
    const value: StoredIssue = {
      number,
      id: 100 + number,
      node_id: `ISSUE${String(number)}`,
      title,
      body,
      state: 'open',
      type: { name: 'Task' },
      labels: [],
      html_url: `https://github.com/example/widget/issues/${String(number)}`,
      updated_at: '2026-10-07T00:00:00Z',
      parent,
      status: parent === null ? null : 'Active',
      reason: null,
      ...(parent === null ? {} : { points: 2, priority: 'High' }),
    };
    issues.set(number, value);
    return value;
  };
  add(10, 'Original tracking parent', 'Original unsized parent', null);
  add(20, 'Replacement tracking parent', 'Replacement unsized parent', null);
  add(17, '  Legacy <tracking> & title\r\n', '\nLegacy & backlog <tag>\t \r\n', 10);
  add(
    18,
    'Second tracking issue',
    canonicalIssueBody({
      title: 'Second tracking issue',
      issueType: 'Task',
      points: 2,
      problem: 'A second executable issue needs a new parent.',
      outcome: 'The issue retains its contract when reparented.',
      acceptanceCriteria: [
        {
          behavior: 'A parent update returns the new native parent.',
          verifiedBy: 'The scenario checks persisted parent membership.',
        },
      ],
      outOfScope: ['Changing the executable work.'],
      openQuestions: [],
      draft: false,
    }),
    10,
  );
  const get = (number: unknown) => {
    assert.equal(typeof number, 'number');
    const issue = issues.get(number as number);
    assert.ok(issue, `Unknown synthetic issue ${String(number)}`);
    return issue;
  };
  const target = (input: Input) => {
    if ('owner' in input) assert.equal(input.owner, 'example');
    if ('repo' in input) assert.equal(input.repo, 'widget');
    if ('name' in input) assert.equal(input.name, 'widget');
    if ('org' in input) assert.equal(input.org, 'example');
  };
  const mutation = (event: string) => {
    writes += 1;
    events.push(event);
  };
  const values = (issue: StoredIssue) => [
    ...(issue.points === undefined
      ? []
      : [
          {
            issue_field_id: 101,
            issue_field_name: 'Estimate',
            data_type: 'single_select',
            value: String(issue.points),
            single_select_option: { name: String(issue.points) },
          },
        ]),
    ...(issue.priority === undefined
      ? []
      : [
          {
            issue_field_id: 102,
            issue_field_name: 'Urgency',
            data_type: 'single_select',
            value: issue.priority,
            single_select_option: { name: issue.priority },
          },
        ]),
  ];
  const listSubIssues = async (input: Input) => {
    target(input);
    get(input.issue_number);
    return { data: structuredClone([...issues.values()].filter((issue) => issue.parent === input.issue_number)) };
  };
  const rest = {
    issues: {
      get: async (input: Input) => {
        target(input);
        return { data: structuredClone(get(input.issue_number)) };
      },
      listForRepo: async (input: Input) => {
        target(input);
        assert.equal(input.page, 1);
        return {
          data: structuredClone(
            [...issues.values()].filter((issue) => input.state === 'all' || issue.state === input.state),
          ),
        };
      },
      listSubIssues,
      create: async (input: Input) => {
        target(input);
        assert.equal(issues.has(31), false, 'the scenario creates exactly one child');
        assert.equal(input.type, 'Task');
        const issue = add(31, input.title as string, input.body as string, null);
        mutation('issue:create:31');
        return { data: structuredClone(issue) };
      },
      update: async (input: Input) => {
        target(input);
        const issue = get(input.issue_number);
        for (const key of ['title', 'body', 'state'] as const)
          if (typeof input[key] === 'string') issue[key] = input[key];
        if (typeof input.type === 'string') issue.type = { name: input.type };
        if (typeof input.state_reason === 'string') issue.reason = input.state_reason.toUpperCase();
        mutation(`issue:update:${String(issue.number)}`);
        return { data: structuredClone(issue) };
      },
      addSubIssue: async (input: Input) => {
        target(input);
        const parent = get(input.issue_number);
        const child = [...issues.values()].find((issue) => issue.id === input.sub_issue_id);
        assert.ok(child);
        assert.equal(child.parent, null);
        child.parent = parent.number;
        mutation(`parent:add:${String(child.number)}:${String(parent.number)}`);
        return { data: structuredClone(child) };
      },
      removeSubIssue: async (input: Input) => {
        target(input);
        const child = [...issues.values()].find((issue) => issue.id === input.sub_issue_id);
        assert.ok(child);
        assert.equal(child.parent, input.issue_number);
        child.parent = null;
        mutation(`parent:remove:${String(child.number)}`);
        return { data: structuredClone(child) };
      },
      listComments: async (input: Input) => {
        target(input);
        const issue = get(input.issue_number);
        return {
          data: structuredClone(
            comments.filter((comment) => comment.issue_url.endsWith(`/issues/${String(issue.number)}`)),
          ),
        };
      },
      createComment: async (input: Input) => {
        target(input);
        const issue = get(input.issue_number);
        const id = 101 + comments.length;
        const comment = {
          id,
          body: input.body as string,
          html_url: `${issue.html_url}#issuecomment-${String(id)}`,
          issue_url: `https://api.github.com/repos/example/widget/issues/${String(issue.number)}`,
          user: { login: 'operator' },
        };
        comments.push(comment);
        mutation(`comment:create:${String(id)}`);
        return { data: structuredClone(comment) };
      },
      getComment: async (input: Input) => {
        target(input);
        const comment = comments.find((value) => value.id === input.comment_id);
        assert.ok(comment);
        events.push(`comment:read:${String(comment.id)}`);
        return { data: structuredClone(comment) };
      },
    },
    search: {
      issuesAndPullRequests: async (input: Input) => {
        assert.equal(input.page, 1);
        assert.equal(typeof input.q, 'string');
        const match = /^repo:example\/widget is:issue "(Legacy|Replacement)"$/u.exec(input.q as string);
        assert.ok(match, 'search must retain repository and literal text boundaries');
        const items = [...issues.values()].filter((issue) => `${issue.title}\n${issue.body}`.includes(match[1]!));
        return { data: { total_count: items.length, incomplete_results: false, items: structuredClone(items) } };
      },
    },
    paginate: async (method: typeof listSubIssues, input: Input) => {
      assert.equal(method, listSubIssues);
      return (await method(input)).data;
    },
    request: async (route: string, input: Input) => {
      target(input);
      if (route === 'GET /orgs/{org}/issue-fields')
        return {
          data: [
            {
              id: 101,
              name: 'Estimate',
              data_type: 'single_select',
              options: [{ name: '1' }, { name: '2' }, { name: '4' }],
            },
            { id: 102, name: 'Urgency', data_type: 'single_select', options: [{ name: 'High' }, { name: 'Low' }] },
          ],
        };
      const issue = get(input.issue_number);
      if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values') {
        for (const field of input.issue_field_values as { field_id: number; value: string }[]) {
          if (field.field_id === 101) issue.points = Number(field.value);
          else {
            assert.equal(field.field_id, 102);
            issue.priority = field.value;
          }
        }
        mutation(`fields:${String(issue.number)}`);
      } else assert.equal(route, 'GET /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values');
      return { data: values(issue) };
    },
  };
  const discovery = syntheticDiscoveryClients();
  const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
  const projectItem = (issue: StoredIssue) => ({
    id: `ITEM${String(issue.number)}`,
    isArchived: false,
    content: { id: issue.node_id },
    fieldValueByName: {
      name: issue.status,
      optionId: `STATUS-${String(['Queued', 'Active', 'Waiting', 'Shipped'].indexOf(issue.status!))}`,
    },
  });
  const graphql = async (query: string, input: Input) => {
    target(input);
    if (query.includes('blockedBy(first:')) {
      const issue = get(input.number);
      return {
        repository: {
          issue: {
            parent:
              issue.parent === null
                ? null
                : {
                    id: get(issue.parent).node_id,
                    number: issue.parent,
                    repository: { nameWithOwner: 'example/widget' },
                  },
            blockedBy: page([]),
          },
        },
      };
    }
    if (query.includes('IssueClosureReadback')) {
      const issue = get(input.number);
      return {
        repository: {
          issue: {
            number: issue.number,
            repository: { nameWithOwner: 'example/widget' },
            state: issue.state.toUpperCase(),
            stateReason: issue.reason,
            duplicateOf: null,
          },
        },
      };
    }
    if (query.includes('ProjectDeliveryItems'))
      return {
        organization: {
          projectV2: { items: page([...issues.values()].filter((issue) => issue.status !== null).map(projectItem)) },
        },
      };
    if (query.includes('AddProjectDeliveryItem')) {
      const issue = [...issues.values()].find((value) => value.node_id === input.contentId);
      assert.ok(issue);
      assert.equal(input.projectId, 'PROJECT-1');
      mutation(`project:add:${String(issue.number)}`);
      return { addProjectV2ItemById: { item: { id: `ITEM${String(issue.number)}` } } };
    }
    if (query.includes('UpdateProjectDeliveryStatus')) {
      const issue = get(Number(String(input.itemId).slice(4)));
      assert.equal(input.projectId, 'PROJECT-1');
      assert.equal(input.fieldId, 'STATUS-FIELD');
      const status = ['Queued', 'Active', 'Waiting', 'Shipped'][Number(String(input.optionId).slice(7))];
      assert.ok(status);
      issue.status = status;
      mutation(`project:status:${String(issue.number)}:${status}`);
      return { updateProjectV2ItemFieldValue: { projectV2Item: { id: input.itemId } } };
    }
    if (query.includes('ProjectDeliveryItemReadback')) {
      const issue = get(Number(String(input.itemId).slice(4)));
      return { node: { ...projectItem(issue), project: { id: 'PROJECT-1', number: 1 } } };
    }
    return discovery.graphql(query, input);
  };
  return {
    issues,
    comments,
    events,
    rest,
    graphql,
    snapshot: () => structuredClone({ issues: [...issues.values()], comments, writes }),
    writes: () => writes,
  };
}

test('composes shipped tracking through one non-Git MCP session with persisted readbacks and inert refusals', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delivery-tracking-scenario-'));
  const fixture = trackingRepository();
  vi.stubEnv('AI_DELIVERY_CONFIG', join(root, 'operator.json'));
  writeFileSync(
    join(root, 'operator.json'),
    JSON.stringify({
      schemaVersion: 'ai-delivery.user@1',
      roles: {
        author: { authSource: 'personal', identity: 'host-author', credentialEnv: { token: 'SYNTHETIC_TOKEN' } },
        reviewer: {
          identity: 'app-reviewer',
          credentialEnv: { appId: 'APP_ID', installationId: 'INSTALLATION_ID', privateKeyPath: 'KEY_PATH' },
        },
      },
      project: 1,
      checkoutRoots: [],
      pointsField: 'Estimate',
      priorityField: 'Urgency',
      statusField: 'Flow',
      statuses: syntheticDiscoveryConfig.native.project.statuses,
    }),
  );
  vi.spyOn(githubClients, 'createDeliveryGitHubClients').mockImplementation(async (input) => {
    assert.equal(input.role, 'author');
    return {
      role: 'author',
      authSource: 'personal',
      authenticatedAuthor: async () => ({ actorLogin: 'operator', credentialIdentity: 'user:1' }),
      rest: fixture.rest,
      graphql: fixture.graphql,
    } as unknown as githubClients.GitHubClients;
  });
  const server = createAiDeliveryMcpServer({ repoRoot: root });
  const client = new Client({ name: 'tracking-scenario', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  async function call<T>(name: string, args: Input): Promise<T> {
    const result = await client.callTool({ name, arguments: { repo: 'example/widget', ...args } });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    return JSON.parse((result.content as { text: string }[])[0]!.text) as T;
  }
  async function refuse(name: string, args: Input) {
    const before = fixture.snapshot();
    const refused = await client.callTool({ name, arguments: { repo: 'example/widget', ...args } }).then(
      (result) => result.isError === true,
      () => true,
    );
    assert.equal(refused, true, name);
    assert.deepEqual(fixture.snapshot(), before, `${name} must not mutate stored native state or write count`);
  }
  const fields = {
    issueType: 'Task',
    points: 2,
    problem: 'Legacy tracking needs a portable replacement.',
    outcome: 'Replacement tracking has an explicit native readback.',
    acceptanceCriteria: [
      {
        behavior: 'Invalid tracking requests leave native state unchanged.',
        verifiedBy: 'The synthetic MCP scenario compares stored state and writes.',
      },
    ],
    outOfScope: ['Implementing batch or deferral.'],
    openQuestions: [],
    context: {
      files: ['src/currentTrackingScenario.test.ts'],
      evidence: ['https://github.com/example/widget/issues/17'],
    },
    draft: false,
  };
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.equal(existsSync(join(root, '.git')), false);
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of ['issue_list', 'issue_search', 'issue_update', 'issue_create', 'issue_comment', 'issue_info'])
      assert.ok(tools.includes(name));
    const original = await call<{ issues: { number: number }[] }>('issue_list', {
      parentIssueNumber: 10,
      state: 'all',
    });
    assert.deepEqual(
      original.issues.map((issue) => issue.number),
      [17, 18],
    );
    const found = await call<{ issues: { number: number }[] }>('issue_search', { query: 'Legacy', state: 'all' });
    assert.deepEqual(
      found.issues.map((issue) => issue.number),
      [17],
    );
    await refuse('issue_update', { issueNumber: 17, points: 'two' });
    const rewritten = await call<IssueInfo & { historyComment: { commentId: number; body: string } }>('issue_update', {
      ...fields,
      issueNumber: 17,
      title: 'Replacement tracking issue',
      preserveHistory: true,
    });
    const expectedHistory =
      '<details>\n<summary>Previous issue title and body</summary>\n\nTitle:\n<pre>  Legacy &lt;tracking&gt; &amp; title\r\n</pre>\n\nBody:\n<pre>\nLegacy &amp; backlog &lt;tag&gt;\t \r\n</pre>\n\n</details>';
    assert.equal(rewritten.historyComment.body, expectedHistory);
    assert.equal(fixture.comments[0]!.body, expectedHistory);
    assert.equal(fixture.comments[0]!.user.login, 'operator');
    const historyRead = fixture.events.indexOf('comment:read:101');
    assert.ok(historyRead >= 0 && historyRead < fixture.events.indexOf('issue:update:17'));
    assert.equal(rewritten.title, fixture.issues.get(17)!.title);
    assert.equal(rewritten.body, fixture.issues.get(17)!.body);
    const created = await call<{ created: { number: number; url: string } }>('issue_create', {
      ...fields,
      title: 'Replacement sized child',
      priority: 'High',
      parentIssueNumber: 20,
    });
    assert.equal(created.created.number, 31);
    const child = await call<IssueInfo>('issue_info', { issueNumber: created.created.number });
    assert.equal(child.points, 2);
    assert.equal(child.priority, 'High');
    assert.equal(child.issueType, 'Task');
    assert.equal(child.parentIssueNumber, 20);
    assert.equal(child.projectStatus, 'Todo');
    assert.equal(fixture.issues.get(31)!.parent, 20);
    await refuse('issue_batch', { issues: [17, 18], parentIssueNumber: 20 });
    for (const issueNumber of [17, 18]) {
      const moved = await call<IssueInfo>('issue_update', { issueNumber, parentIssueNumber: 20 });
      assert.equal(moved.parentIssueNumber, 20);
      assert.equal(fixture.issues.get(issueNumber)!.parent, 20);
    }
    assert.deepEqual(
      (await call<{ issues: { number: number }[] }>('issue_list', { parentIssueNumber: 10, state: 'all' })).issues,
      [],
    );
    assert.deepEqual(
      (await call<{ issues: { number: number }[] }>('issue_list', { parentIssueNumber: 20, state: 'all' })).issues.map(
        (issue) => issue.number,
      ),
      [17, 18, 31],
    );
    for (const number of [10, 20])
      assert.equal((await call<IssueInfo>('issue_info', { issueNumber: number })).points, undefined);
    const journal = await call<{ commentId: number; body: string; url: string }>('issue_comment', {
      issueNumber: 31,
      kind: 'progress',
      summary: 'Tracking replay is verified.',
      status: 'In progress',
      done: ['Reparented two issues individually.'],
      decisionNeeded: 'None',
      keyNumbers: [],
      evidence: [created.created.url],
      nextStep: 'Review',
      nextDate: '2026-10-09',
    });
    const storedJournal = fixture.comments.find((comment) => comment.id === journal.commentId)!;
    assert.equal(storedJournal.body, journal.body);
    assert.equal(storedJournal.html_url, journal.url);
    assert.equal(storedJournal.user.login, 'operator');
    assert.match(journal.body, /Tracking replay is verified/u);
    await refuse('issue_defer', { issueNumber: 17, trigger: 'After review' });
    await refuse('issue_update', { issueNumber: 17, defer: { trigger: 'After review' } });
    const closed = await call<
      IssueInfo & {
        closure: {
          state: string;
          closeReason: string;
          supersededBy: number;
          comment: { commentId: number; body: string };
        };
      }
    >('issue_update', { issueNumber: 17, state: 'closed', closeReason: 'not_planned', supersededBy: 31 });
    assert.equal(closed.closure.state, 'closed');
    assert.equal(closed.closure.closeReason, 'not_planned');
    assert.equal(closed.closure.supersededBy, 31);
    assert.equal(closed.projectStatus, 'Done');
    assert.equal(fixture.issues.get(17)!.reason, 'NOT_PLANNED');
    assert.equal(fixture.issues.get(17)!.status, 'Shipped');
    assert.equal(
      fixture.comments.find((comment) => comment.id === closed.closure.comment.commentId)!.body,
      'Requested closure reason: not_planned.\nSuperseded by example/widget#31.',
    );
    const final = await call<IssueInfo>('issue_info', { issueNumber: 17 });
    assert.equal(final.state, 'closed');
    assert.equal(final.parentIssueNumber, 20);
    assert.equal(final.projectStatus, 'Done');
    const finalSearch = await call<{ issues: { number: number; state: string }[] }>('issue_search', {
      query: 'Replacement',
      state: 'all',
    });
    assert.deepEqual(
      finalSearch.issues.map(({ number, state }) => ({ number, state })),
      [
        { number: 20, state: 'open' },
        { number: 17, state: 'closed' },
        { number: 31, state: 'open' },
      ],
    );
    assert.ok(fixture.writes() > 0);
    assert.equal(existsSync(join(root, '.git')), false);
  } finally {
    await client.close();
    await server.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
