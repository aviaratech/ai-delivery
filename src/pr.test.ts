import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { publishPr, mergePr, finishIssue } from './pr.js';
import type { DeliveryContext } from './issue.js';

const head = 'a'.repeat(40);
const merge = 'b'.repeat(40);

function fixture(
  state: string | null = 'clean',
  option: {
    baseMoved?: boolean;
    reviewMoved?: boolean;
    headMoved?: boolean;
    reviewDecision?: string;
    unrelatedBranch?: boolean;
    failedClose?: boolean;
    deletedAfterMerge?: boolean;
    wrongClosingIssue?: boolean;
    reviewCannotPush?: boolean;
    reviewAccessUnknown?: boolean;
  } = {},
) {
  let merged = false;
  let closes = 0;
  const merges: Record<string, unknown>[] = [];
  const pr = () => ({
    number: 23,
    title: 'Improve widget',
    body: 'Closes #17',
    html_url: 'https://github.com/example/widget/pull/23',
    state: merged ? 'closed' : 'open',
    draft: false,
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
    repos: { get: async () => ({ data: { default_branch: 'main', full_name: 'example/widget' } }) },
    git: {
      getRef: async ({ ref }: { ref: string }) => ({
        data: { object: { sha: ref === 'heads/main' ? (option.baseMoved ? 'e'.repeat(40) : 'c'.repeat(40)) : head } },
      }),
    },
    pulls: {
      get: async () => ({ data: { ...pr(), head: { ...pr().head, sha: option.headMoved ? 'f'.repeat(40) : head } } }),
      list: async () => ({ data: [] }),
      create: async (input: Record<string, unknown>) => {
        assert.equal(input.body, 'Plain explanation\n\nCloses #17');
        return { data: pr() };
      },
      getReview: async () => ({
        data: {
          id: 99,
          user: { login: 'reviewer[bot]' },
          state: option.reviewMoved ? 'DISMISSED' : 'APPROVED',
          commit_id: head,
          body: '<!-- ai-delivery-review-artifact: sha256:' + 'd'.repeat(64) + ' -->',
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
            body: '<!-- ai-delivery-review-artifact: sha256:' + 'd'.repeat(64) + ' -->',
          },
        ],
      }),
      merge: async (input: Record<string, unknown>) => {
        merges.push(input);
        merged = true;
        return { data: { merged: true, sha: merge } };
      },
    },
    issues: {
      get: async () => ({
        data: { number: 17, state: closes ? 'closed' : 'open', node_id: 'ISSUE', title: 'Improve widget', body: '' },
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
          pullRequest: {
            closingIssuesReferences: {
              nodes: [{ number: option.wrongClosingIssue ? 18 : 17, repository: { nameWithOwner: 'example/widget' } }],
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
