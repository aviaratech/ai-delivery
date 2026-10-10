import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { publishPr, mergePr, finishIssue } from './pr.js';
import type { DeliveryContext } from './issue.js';
import { digestValue } from './delivery/common.js';

const head = 'a'.repeat(40);
const merge = 'b'.repeat(40);

function fixture(
  state: string | null = 'clean',
  option: {
    baseMoved?: boolean;
    nonClosing?: boolean;
    commitMessage?: string;
    retainedIssueDrift?: boolean;
    mergeAckLost?: boolean;
    reviewMoved?: boolean;
    headMoved?: boolean;
    reviewDecision?: string;
    unrelatedBranch?: boolean;
    failedClose?: boolean;
    deletedAfterMerge?: boolean;
    wrongClosingIssue?: boolean;
    reviewCannotPush?: boolean;
    reviewAccessUnknown?: boolean;
    reviewBinding?:
      | 'stale-head'
      | 'wrong-tree'
      | 'wrong-scope'
      | 'invalid-digest'
      | 'marker-only'
      | 'wrong-issue'
      | 'wrong-pr'
      | 'wrong-role';
  } = {},
) {
  let merged = false;
  let closes = 0;
  let publicationBody: string | undefined;
  let publicationTitle: string | undefined;
  let publicationDraft: boolean | undefined;
  const merges: Record<string, unknown>[] = [];
  const artifactContent = {
    authorIdentity: option.reviewBinding === 'wrong-role' ? 'collaborator' : 'author',
    reviewerIdentity: 'reviewer',
    checks: ['retained checks'],
    diffScopeHash: digestValue([option.reviewBinding === 'wrong-scope' ? 'elsewhere.ts' : 'change.ts']),
    elapsedMs: 1,
    findings: [],
    head: {
      sha: option.reviewBinding === 'stale-head' ? 'e'.repeat(40) : head,
      tree: option.reviewBinding === 'wrong-tree' ? 'f'.repeat(40) : '0'.repeat(40),
    },
    issueNumber: option.reviewBinding === 'wrong-issue' ? 18 : 17,
    prNumber: option.reviewBinding === 'wrong-pr' ? 24 : 23,
    readOnly: true,
    requestedEffort: 'xhigh',
    requestedModel: 'gpt-6-astra',
    effectiveEffort: 'unknown',
    effectiveModel: 'unknown',
    schemaVersion: 'ai-delivery.review-artifact@1',
    summary: 'Independent review.',
    verdict: 'approve',
  };
  const artifact = {
    ...artifactContent,
    artifactId: option.reviewBinding === 'invalid-digest' ? `sha256:${'d'.repeat(64)}` : digestValue(artifactContent),
  };
  const marker = `<!-- ai-delivery-review-artifact: ${artifact.artifactId} -->`;
  const reviewBody =
    option.reviewBinding === 'marker-only'
      ? marker
      : `${artifact.summary}\n\n${marker}\n<!-- ai-delivery-review-artifact-data: ${Buffer.from(JSON.stringify(artifact)).toString('base64url')} -->`;
  const pr = () => ({
    number: 23,
    node_id: 'PR23',
    changed_files: 1,
    title: publicationTitle ?? 'Improve widget',
    body: publicationBody ?? (option.nonClosing ? 'References example/widget#17\n\nImprove widget.' : 'Closes #17'),
    html_url: 'https://github.com/example/widget/pull/23',
    state: merged ? 'closed' : 'open',
    draft: publicationDraft ?? false,
    merged,
    merge_commit_sha: merged ? merge : null,
    mergeable: state === 'clean',
    mergeable_state: state,
    head: { sha: head, ref: 'issue/17', repo: { full_name: 'example/widget' } },
    base: { sha: 'c'.repeat(40), ref: 'main', repo: { full_name: 'example/widget' } },
    user: { login: 'author' },
  });
  const rest = {
    request: async () => ({ data: [] }),
    repos: { get: async () => ({ data: { node_id: 'REPO', default_branch: 'main', full_name: 'example/widget' } }) },
    git: {
      getCommit: async () => ({ data: { sha: head, tree: { sha: '0'.repeat(40) } } }),
      getRef: async ({ ref }: { ref: string }) => ({
        data: {
          ref: `refs/${ref}`,
          object: {
            type: 'commit',
            sha: ref === 'heads/main' ? (option.baseMoved ? 'e'.repeat(40) : 'c'.repeat(40)) : head,
          },
        },
      }),
    },
    pulls: {
      get: async () => ({ data: { ...pr(), head: { ...pr().head, sha: option.headMoved ? 'f'.repeat(40) : head } } }),
      list: async () => ({ data: [] }),
      listFiles: async () => ({ data: [{ filename: 'change.ts' }] }),
      create: async (input: Record<string, unknown>) => {
        assert.equal(input.body, 'Plain explanation\n\nCloses #17');
        assert.equal(typeof input.title, 'string');
        assert.equal(typeof input.draft, 'boolean');
        publicationBody = input.body as string;
        publicationTitle = input.title as string;
        publicationDraft = input.draft as boolean;
        return { data: pr() };
      },
      getReview: async () => ({
        data: {
          id: 99,
          user: { login: 'reviewer[bot]' },
          state: option.reviewMoved ? 'DISMISSED' : 'APPROVED',
          commit_id: head,
          body: reviewBody,
          html_url: 'https://github.com/example/widget/pull/23#pullrequestreview-99',
        },
      }),
      listReviews: async () => ({
        data: [
          {
            id: 99,
            user: { login: 'reviewer[bot]' },
            state: 'APPROVED',
            commit_id: head,
            body: reviewBody,
          },
        ],
      }),
      merge: async (input: Record<string, unknown>) => {
        merges.push(input);
        merged = true;
        if (option.mergeAckLost) throw new Error('Merge acknowledgement lost');
        return { data: { merged: true, sha: merge } };
      },
    },
    issues: {
      get: async () => ({
        data: {
          number: 17,
          state: closes ? 'closed' : 'open',
          node_id: 'ISSUE',
          title: 'Improve widget',
          body: merged && option.retainedIssueDrift ? 'Changed criteria' : 'Retained criteria',
          html_url: 'https://github.com/example/widget/issues/17',
        },
      }),
      update: async (input: Record<string, unknown>) => {
        assert.equal(input.state, 'closed');
        if (option.failedClose && closes === 0) {
          closes++;
          throw new Error('Interrupted close');
        }
        closes++;
        return { data: { number: 17, state: 'closed' } };
      },
    },
  };
  const graphql = async (query: string) => {
    if (query.includes('DeliveryNonClosingReferences'))
      return {
        repository: {
          id: 'REPO',
          nameWithOwner: 'example/widget',
          issue: {
            id: 'ISSUE',
            number: 17,
            state: 'OPEN',
            timelineItems: {
              nodes: [
                {
                  id: 'REFERENCE',
                  actor: { login: 'author' },
                  isCrossRepository: false,
                  willCloseTarget: false,
                  source: {
                    __typename: 'PullRequest',
                    id: 'PR23',
                    number: 23,
                    repository: { id: 'REPO', nameWithOwner: 'example/widget' },
                  },
                  target: {
                    __typename: 'Issue',
                    id: 'ISSUE',
                    number: 17,
                    repository: { id: 'REPO', nameWithOwner: 'example/widget' },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      };
    if (query.includes('DeliveryNonClosingCommits'))
      return {
        repository: {
          nameWithOwner: 'example/widget',
          pullRequest: {
            id: 'PR23',
            number: 23,
            headRefOid: head,
            baseRefOid: 'c'.repeat(40),
            baseRefName: 'main',
            commits: {
              totalCount: 1,
              nodes: [
                {
                  commit: {
                    oid: head,
                    message: option.commitMessage ?? 'Improve widget',
                    parents: {
                      totalCount: 1,
                      nodes: [{ oid: 'c'.repeat(40) }],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      };
    if (query.includes('DeliveryReviewAccess'))
      return {
        repository: {
          pullRequest: {
            reviews: {
              nodes: option.reviewAccessUnknown
                ? []
                : [
                    {
                      fullDatabaseId: 99,
                      author: { login: 'reviewer' },
                      authorCanPushToRepository: option.reviewCannotPush !== true,
                      commit: { oid: head },
                      state: 'APPROVED',
                    },
                  ],
            },
          },
        },
      };
    if (query.includes('DeliveryClosingIssues'))
      return {
        repository: {
          nameWithOwner: 'example/widget',
          pullRequest: {
            id: 'PR23',
            number: 23,
            closingIssuesReferences: {
              nodes: option.nonClosing
                ? []
                : [{ number: option.wrongClosingIssue ? 18 : 17, repository: { nameWithOwner: 'example/widget' } }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      };
    if (option.deletedAfterMerge && merged && query.includes('DeliveryIssueBranches'))
      return {
        repository: { issue: { linkedBranches: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
      };
    if (query.includes('DeliveryIssueBranches'))
      return {
        repository: {
          issue: {
            linkedBranches: {
              nodes: [
                {
                  ref: {
                    name: option.unrelatedBranch ? 'other/17' : 'issue/17',
                    target: { oid: head },
                    repository: { nameWithOwner: 'example/widget' },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      };
    if (query.includes('blockedBy'))
      return {
        repository: {
          issue: { blockedBy: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }, parent: null },
        },
      };
    return { repository: { pullRequest: { headRefOid: head, reviewDecision: option.reviewDecision ?? 'APPROVED' } } };
  };
  const reviewer = { role: 'reviewer', authSource: 'app', appActorLogin: async () => 'reviewer[bot]', rest, graphql };
  const context = {
    root: '/nonexistent-launch-directory',
    repo: { owner: 'example', repo: 'widget' },
    config: {
      schemaVersion: 'ai-delivery.github@1',
      repository: 'example/widget',
      roles: { author: { authSource: 'personal', identity: 'author' }, reviewer: { identity: 'reviewer' } },
    },
    clients: {
      role: 'author',
      authSource: 'personal',
      authenticatedAuthor: async () => ({ actorLogin: 'author', credentialIdentity: 'user:1' }),
      rest,
      graphql,
    },
    reviewerClients: reviewer,
  } as unknown as DeliveryContext;
  return { context, merges, closes: () => closes };
}

describe('remote GitHub lifecycle', () => {
  for (const reviewBinding of [
    'stale-head',
    'wrong-tree',
    'wrong-scope',
    'invalid-digest',
    'marker-only',
    'wrong-issue',
    'wrong-pr',
    'wrong-role',
  ] as const) {
    it(`refuses ${reviewBinding} artifact binding despite remapped current API commit and CLEAN approval`, async () => {
      const { context, merges, closes } = fixture('clean', { reviewBinding });
      await assert.rejects(
        finishIssue(context, { issueNumber: 17, prNumber: 23 }),
        /artifact|binding|review|scope|tree/u,
      );
      assert.equal(merges.length, 0);
      assert.equal(closes(), 0);
    });
  }
  for (const option of [{ reviewCannotPush: true }, { reviewAccessUnknown: true }]) {
    it(`refuses an unqualified App review despite aggregate human approval: ${JSON.stringify(option)}`, async () => {
      const { context, merges } = fixture('clean', option);
      await assert.rejects(mergePr(context, { issueNumber: 17, prNumber: 23 }), /qualifying|count|eligible/u);
      assert.equal(merges.length, 0);
    });
  }
  it('refuses publication of a collaborator PR before promotion', async () => {
    const { context } = fixture();
    context.clients.rest.pulls.list = (async () => ({
      data: [{ number: 23 }],
    })) as typeof context.clients.rest.pulls.list;
    const get = context.clients.rest.pulls.get;
    context.clients.rest.pulls.get = (async (...args: Parameters<typeof get>) => {
      const response = await get(...args);
      return { ...response, data: { ...response.data, user: { ...response.data.user, login: 'collaborator' } } };
    }) as typeof get;
    await assert.rejects(publishPr(context, { issueNumber: 17, dryRun: true }), /author/u);
  });

  it('refuses a non-default PR base before publication', async () => {
    const { context } = fixture();
    await assert.rejects(publishPr(context, { issueNumber: 17, baseBranch: 'release' }), /default branch/u);
  });
  it('refuses conflicting prior PR metadata during dry-run before promotion', async () => {
    const { context } = fixture();
    context.clients.rest.pulls.list = (async () => ({
      data: [{ number: 23 }],
    })) as typeof context.clients.rest.pulls.list;
    await assert.rejects(publishPr(context, { issueNumber: 17, body: 'Different intent', dryRun: true }), /conflict/u);
  });

  it('reads every PR match page before refusing ambiguous branch publication', async () => {
    const { context } = fixture();
    context.clients.rest.pulls.list = (async (input: { page?: number }) => ({
      data: input.page === 2 ? [{ number: 24 }] : Array.from({ length: 100 }, () => ({ number: 23 })),
    })) as unknown as typeof context.clients.rest.pulls.list;
    await assert.rejects(publishPr(context, { issueNumber: 17, dryRun: true }), /conflict/u);
  });
  it('creates a PR from its remote issue branch with a plain body and no local evidence', async () => {
    const { context } = fixture();
    const result = await publishPr(context, {
      issueNumber: 17,
      title: 'Improve widget',
      body: 'Plain explanation',
      draft: false,
    });
    assert.equal((result as { prNumber: number }).prNumber, 23);
  });

  for (const state of ['blocked', 'behind', 'dirty', 'unstable', null]) {
    it(`refuses GitHub merge eligibility ${String(state)} without a local receipt fallback`, async () => {
      const { context, merges } = fixture(state);
      await assert.rejects(mergePr(context, { issueNumber: 17, prNumber: 23 }), /GitHub|mergeable|clean|CLEAN/u);
      assert.equal(merges.length, 0);
    });
  }

  it('uses the independent reviewed SHA as the server merge precondition', async () => {
    const { context, merges } = fixture();
    await mergePr(context, { issueNumber: 17, prNumber: 23 });
    assert.equal(merges.length, 1);
    assert.equal(merges[0]?.sha, head);
  });

  it('finishes remotely and reuses the merged PR on an interrupted close retry', async () => {
    const { context, merges, closes } = fixture();
    await finishIssue(context, { issueNumber: 17, prNumber: 23 });
    await finishIssue(context, { issueNumber: 17, prNumber: 23 });
    assert.equal(merges.length, 1);
    assert.equal(closes(), 1);
  });
  for (const [name, option] of [
    ['moved base', { baseMoved: true }],
    ['dismissed review readback', { reviewMoved: true }],
    ['moved reviewed head', { headMoved: true }],
    ['unknown decision', { reviewDecision: 'UNKNOWN' }],
    ['required review', { reviewDecision: 'REVIEW_REQUIRED' }],
    ['unrelated linked branch', { unrelatedBranch: true }],
  ] as const) {
    it(`refuses ${name} without merge or issue closure`, async () => {
      const { context, merges, closes } = fixture('clean', option);
      await assert.rejects(finishIssue(context, { issueNumber: 17, prNumber: 23 }));
      assert.equal(merges.length, 0);
      assert.equal(closes(), 0);
    });
  }

  it('finishes a merged PR after its issue branch was deleted', async () => {
    const { context, merges, closes } = fixture('clean', { deletedAfterMerge: true });
    await finishIssue(context, { issueNumber: 17, prNumber: 23 });
    await finishIssue(context, { issueNumber: 17, prNumber: 23 });
    assert.equal(merges.length, 1);
    assert.equal(closes(), 1);
  });
  it('never closes another issue after merged-PR association readback disagrees', async () => {
    const { context, closes, merges } = fixture('clean', { wrongClosingIssue: true });
    await assert.rejects(finishIssue(context, { issueNumber: 17, prNumber: 23 }));
    assert.equal(merges.length, 0);
    assert.equal(closes(), 0);
  });
});

describe('retained issue guarded squash delivery', () => {
  const input = { issueNumber: 17, prNumber: 23, reviewedHeadSha: head, nonClosing: true };
  it('sends explicit safe squash messages at the approved SHA and reuses merged readback without closing', async () => {
    const { context, merges, closes } = fixture('clean', { nonClosing: true });
    const preview = await mergePr(context, { ...input, dryRun: true });
    assert.ok('commit_title' in preview && 'commit_message' in preview);
    assert.equal(preview.commit_title, 'Improve widget');
    assert.equal(preview.commit_message, 'References example/widget#17\n\nDelivered by PR #23.');
    assert.equal(merges.length, 0);
    const result = await mergePr(context, input);
    assert.equal(result.mergeSha, merge);
    assert.equal(merges[0]!.sha, head);
    assert.equal(merges[0]!.merge_method, 'squash');
    assert.equal(merges[0]!.commit_title, preview.commit_title);
    assert.equal(merges[0]!.commit_message, preview.commit_message);
    assert.equal((await mergePr(context, input)).reused, true);
    assert.equal(merges.length, 1);
    assert.equal(closes(), 0);
  });

  for (const strategy of ['merge', 'rebase'] as const) {
    it(`refuses ${strategy} before any lifecycle mutation`, async () => {
      const { context, merges, closes } = fixture('clean', { nonClosing: true });
      await assert.rejects(mergePr(context, { ...input, strategy }), /squash/u);
      assert.equal(merges.length, 0);
      assert.equal(closes(), 0);
    });
  }
  it('refuses finish before even reading or merging the PR', async () => {
    const { context, merges, closes } = fixture('clean', { nonClosing: true });
    context.clients.rest.pulls.get = (() => {
      throw new Error('No lifecycle call allowed');
    }) as unknown as typeof context.clients.rest.pulls.get;
    await assert.rejects(finishIssue(context, input), /cannot finish/u);
    assert.equal(merges.length, 0);
    assert.equal(closes(), 0);
  });
  for (const option of [
    { reviewCannotPush: true },
    { reviewAccessUnknown: true },
    { reviewDecision: 'REVIEW_REQUIRED' },
    { baseMoved: true },
    { headMoved: true },
    { commitMessage: 'Fixes: other/repo#5' },
  ]) {
    it(`preserves fail-closed merge guards: ${JSON.stringify(option)}`, async () => {
      const { context, merges, closes } = fixture('clean', { ...option, nonClosing: true });
      await assert.rejects(mergePr(context, input));
      assert.equal(merges.length, 0);
      assert.equal(closes(), 0);
    });
  }
  it('reports post-merge issue criteria drift without reopening or replaying the merge', async () => {
    const { context, merges, closes } = fixture('clean', { nonClosing: true, retainedIssueDrift: true });
    await assert.rejects(mergePr(context, input), /criteria drifted/u);
    assert.equal(merges.length, 1);
    assert.equal(closes(), 0);
  });
  it('reconciles an uncertain merge acknowledgement through authoritative merged readback', async () => {
    const { context, merges, closes } = fixture('clean', { nonClosing: true, mergeAckLost: true });
    await assert.rejects(mergePr(context, input), /acknowledgement lost/u);
    assert.equal((await mergePr(context, input)).reused, true);
    assert.equal(merges.length, 1);
    assert.equal(closes(), 0);
  });
});
