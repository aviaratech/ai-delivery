import assert from 'node:assert/strict';
import { test } from 'vitest';
import { fixtureFields, inertTarget, type PolicyState } from './fixtures/inertTarget.js';

const journal = {
  issueNumber: 17,
  kind: 'start',
  summary: 'Synthetic investigation starts.',
  status: 'In progress',
  outcome: 'Prove consumer policy remains inert.',
  nextStep: 'Inspect fixture',
  nextDate: null,
  keyNumbers: [],
  evidence: [],
};
type Route = {
  name: string;
  args: Record<string, unknown>;
  witness: string;
  before?: (f: ReturnType<typeof inertTarget>) => void;
  verify: (value: Record<string, unknown>, f: ReturnType<typeof inertTarget>) => void;
};
const routes: Route[] = [
  {
    name: 'issue_comment',
    args: journal,
    witness: 'issues.getComment',
    verify: (v, f) => {
      assert.equal(v.url, 'https://github.com/example/widget/issues/17#issuecomment-101');
      assert.equal(f.comments.length, 1);
    },
  },
  {
    name: 'issue_create',
    args: { ...fixtureFields, priority: 'High' },
    witness: 'issues.create',
    verify: (v, f) => {
      assert.equal((v.created as { number: number }).number, 17);
      assert.match(f.state.body, /ai-delivery:issue@1/u);
    },
  },
  {
    name: 'issue_start',
    args: { issueNumber: 17 },
    witness: 'DeliveryStartBranch',
    before: (f) => {
      f.state.linked = false;
    },
    verify: (v, f) => {
      assert.equal(v.issueNumber, 17);
      assert.equal(v.headSha, f.head);
      assert.equal(v.reused, false);
      assert.equal(f.comments.length, 1);
    },
  },
  {
    name: 'issue_list',
    args: { perPage: 1, page: 1 },
    witness: 'issues.listForRepo',
    verify: (v) => {
      assert.equal(v.nextPage, 2);
      assert.deepEqual(
        (v.issues as { fields: unknown; number: number }[]).map(({ number, fields }) => ({ number, fields })),
        [{ number: 17, fields: { Estimate: '2', Urgency: 'High' } }],
      );
    },
  },
  {
    name: 'issue_search',
    args: { query: 'widget', perPage: 1, page: 1 },
    witness: 'search.issuesAndPullRequests',
    verify: (v) => {
      assert.equal(v.nextPage, 2);
      assert.equal((v.issues as { number: number }[])[0]!.number, 17);
    },
  },
  {
    name: 'issue_update',
    args: {
      issueNumber: 17,
      title: 'Reject invalid widget IDs before any persistence call',
      preserveHistory: true,
      outcome: 'Invalid widget identifiers are rejected before the write boundary.',
    },
    witness: 'issues.update',
    verify: (_v, f) => {
      assert.match(f.state.body, /before the write boundary/u);
      assert.equal(f.state.issueState, 'open');
      assert.equal(f.comments.length, 1);
      assert.match(f.comments[0]!.body, /Previous issue title and body/u);
    },
  },
  {
    name: 'issue_info',
    args: { issueNumber: 17 },
    witness: 'issues.get',
    verify: (v) => {
      assert.equal(v.issueNumber, 17);
      assert.equal(v.points, 2);
      assert.equal(v.worktree, null);
    },
  },
  {
    name: 'issue_ready_check',
    args: { issueNumber: 17 },
    witness: 'GET /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values',
    verify: (v) => {
      assert.equal(v.ready, true);
      assert.deepEqual(v.failures, []);
    },
  },
  {
    name: 'issue_pr_create',
    args: { issueNumber: 17, title: 'Reject invalid widget identifiers', body: 'Plain explanation', draft: true },
    witness: 'pulls.create',
    before: (f) => {
      f.state.published = false;
    },
    verify: (_v, f) => {
      assert.equal(f.state.published, true);
      const input = f.calls.find((c) => c.name === 'pulls.create')!.input as { body: string; draft: boolean };
      assert.equal(input.body, 'Plain explanation\n\nCloses #17');
      assert.equal(input.draft, true);
    },
  },
  {
    name: 'issue_pr_info',
    args: { issueNumber: 17 },
    witness: 'DeliveryIssueBranches',
    verify: (v, f) => {
      assert.match(JSON.stringify(v), new RegExp(f.head, 'u'));
      assert.equal(
        f.calls.some((c) => c.name === 'pulls.merge'),
        false,
      );
    },
  },
  {
    name: 'issue_pr_review',
    args: { issueNumber: 17, prNumber: 23 },
    witness: 'pulls.createReview',
    before: (f) => {
      f.reviews.length = 0;
    },
    verify: (_v, f) => {
      assert.equal(f.reviews.length, 1);
      assert.equal(f.reviews[0]!.commit_id, f.head);
      assert.match(f.reviews[0]!.body, /ai-delivery-review-artifact-data/u);
    },
  },
  {
    name: 'issue_pr_merge',
    args: { issueNumber: 17, prNumber: 23 },
    witness: 'pulls.merge',
    verify: (_v, f) => {
      assert.equal(f.state.merged, true);
      assert.equal(f.state.closedCount, 0);
    },
  },
  {
    name: 'issue_finish',
    args: { issueNumber: 17, prNumber: 23 },
    witness: 'issues.update',
    verify: (_v, f) => {
      assert.equal(f.state.merged, true);
      assert.equal(f.state.closedCount, 1);
      assert.equal(f.state.issueState, 'closed');
    },
  },
];

for (const kind of ['tracked', 'edited'] satisfies PolicyState[]) {
  const { outcome: _outcome, ...commonJournal } = journal;
  for (const variant of [
    {
      kind: 'progress',
      done: ['Validated fictional widget'],
      decisionNeeded: 'None',
      evidence: ['https://github.com/example/widget/pull/23'],
    },
    { kind: 'decision', decision: 'Keep consumer policy inert', rationale: 'Configuration belongs to the operator.' },
    { kind: 'blocker', blocker: 'Fictional reviewer unavailable', resolution: 'Wait for independent review.' },
    {
      kind: 'closeout',
      acceptance: [
        {
          criterion: 'Invalid widgets are rejected before persistence.',
          evidence: 'https://github.com/example/widget/pull/23',
        },
      ],
      followUps: [],
    },
  ]) {
    test(`public MCP ${variant.kind} journal remains typed and reuses readback with ${kind} policy`, async ({
      signal,
    }) => {
      const f = inertTarget(signal);
      let connection: Awaited<ReturnType<typeof f.connect>> | undefined;
      try {
        f.policy(kind);
        connection = await f.connect();
        const args = { ...commonJournal, ...variant };
        const first = await connection.call('issue_comment', args);
        assert.notEqual(first.response.isError, true, first.text);
        const second = await connection.call('issue_comment', args);
        assert.notEqual(second.response.isError, true, second.text);
        assert.equal(second.value!.reused, true);
        assert.equal(f.comments.length, 1);
        assert.equal(f.calls.filter((call) => call.name === 'issues.createComment').length, 1);
      } finally {
        await f.dispose(connection);
      }
    }, 5_000);
  }
  for (const route of routes) {
    test(`public MCP ${route.name} succeeds with ${kind} consumer policy (tracked HEAD/index)`, async ({ signal }) => {
      const f = inertTarget(signal);
      let connection: Awaited<ReturnType<typeof f.connect>> | undefined;
      try {
        f.policy(kind);
        route.before?.(f);
        connection = await f.connect();
        const result = await connection.call(route.name, {
          ...route.args,
          ...(route.name === 'issue_pr_review' ? { artifact: JSON.stringify(f.artifact) } : {}),
        });
        assert.notEqual(result.response.isError, true, result.text);
        assert.ok(
          f.calls.some((call) => call.name === route.witness),
          `Owner reachability witness missing: ${route.witness}`,
        );
        route.verify(result.value!, f);
      } finally {
        await f.dispose(connection);
      }
    }, 5_000);
  }

  test(`public MCP retries reuse journal, branch and formal App review with ${kind} consumer policy`, async ({
    signal,
  }) => {
    const f = inertTarget(signal);
    let connection: Awaited<ReturnType<typeof f.connect>> | undefined;
    try {
      f.policy(kind);
      f.state.linked = false;
      f.reviews.length = 0;
      connection = await f.connect();
      for (const [name, args] of [
        ['issue_comment', journal],
        ['issue_start', { issueNumber: 17 }],
        ['issue_pr_review', { issueNumber: 17, prNumber: 23, artifact: JSON.stringify(f.artifact) }],
      ] as const) {
        const first = await connection.call(name, args);
        assert.notEqual(first.response.isError, true, first.text);
        const writes = f.calls.filter((c) =>
          ['issues.createComment', 'DeliveryStartBranch', 'pulls.createReview'].includes(c.name),
        ).length;
        const again = await connection.call(name, args);
        assert.notEqual(again.response.isError, true, again.text);
        assert.equal(
          f.calls.filter((c) => ['issues.createComment', 'DeliveryStartBranch', 'pulls.createReview'].includes(c.name))
            .length,
          writes,
          `${name} repeated a write`,
        );
      }
    } finally {
      await f.dispose(connection);
    }
  }, 5_000);

  test(`public MCP pagination and refused merge preserve policy and issue with ${kind} consumer policy`, async ({
    signal,
  }) => {
    const f = inertTarget(signal);
    let connection: Awaited<ReturnType<typeof f.connect>> | undefined;
    try {
      f.policy(kind);
      connection = await f.connect();
      for (const name of ['issue_list', 'issue_search']) {
        const args = { perPage: 1, ...(name === 'issue_search' ? { query: 'widget' } : {}) };
        const first = await connection.call(name, { ...args, page: 1 });
        assert.notEqual(first.response.isError, true, first.text);
        assert.equal(first.value!.nextPage, 2);
        const next = await connection.call(name, { ...args, page: first.value!.nextPage });
        assert.notEqual(next.response.isError, true, next.text);
        assert.deepEqual(
          (next.value!.issues as { number: number }[]).map((issue) => issue.number),
          [18],
        );
        const empty = await connection.call(name, { ...args, page: 3 });
        assert.notEqual(empty.response.isError, true, empty.text);
        assert.deepEqual(empty.value!.issues, []);
        assert.equal(empty.value!.nextPage, null);
        const operation = name === 'issue_list' ? 'issues.listForRepo' : 'search.issuesAndPullRequests';
        assert.deepEqual(
          f.calls.filter((call) => call.name === operation).map((call) => (call.input as { page: number }).page),
          [1, 2, 3],
        );
      }
      f.state.reviewDecision = 'REVIEW_REQUIRED';
      const refused = await connection.call('issue_pr_merge', { issueNumber: 17, prNumber: 23 });
      assert.equal(refused.response.isError, true);
      assert.match(refused.text, /qualifying|review|approval/u);
      assert.ok(f.calls.some((c) => c.name === 'DeliveryReviewDecision'));
      assert.equal(
        f.calls.some((c) => c.name === 'pulls.merge'),
        false,
      );
      assert.equal(f.state.closedCount, 0);
    } finally {
      await f.dispose(connection);
    }
  }, 5_000);
}

test('one long-lived public MCP server keeps T then E consumer policy inert', async ({ signal }) => {
  const f = inertTarget(signal);
  let connection: Awaited<ReturnType<typeof f.connect>> | undefined;
  try {
    f.policy('tracked');
    connection = await f.connect();
    const tracked = await connection.call('issue_info', { issueNumber: 17 });
    assert.notEqual(tracked.response.isError, true, tracked.text);
    f.policy('edited');
    const edited = await connection.call('issue_info', { issueNumber: 17 });
    assert.notEqual(edited.response.isError, true, edited.text);
    assert.deepEqual(edited.value, tracked.value);
    assert.equal(f.calls.filter((call) => call.name === 'issues.get').length, 2);
  } finally {
    await f.dispose(connection);
  }
}, 5_000);
