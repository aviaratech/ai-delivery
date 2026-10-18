import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { publishPr, mergePr, finishIssue, prChecks } from './pr.js';
import type { DeliveryContext } from './issue.js';
import { digestValue } from './delivery/common.js';

const head = 'a'.repeat(40);
const merge = 'b'.repeat(40);

function fixture(
  state: string | null = 'clean',
  option: {
    nativeChecks?: Array<{ name: string; required: boolean; status: string; conclusion: string | null }>;
    nativeStatuses?: Array<{ name: string; required: boolean; state: string }>;
    nativePage?: 'continuation' | 'malformed';
    baseMoved?: boolean;
    nonClosing?: boolean;
    commitMessage?: string;
    retainedIssueDrift?: boolean;
    mergeAckLost?: boolean;
    headMoved?: boolean;
    reviewDecision?: unknown;
    decisionUnavailable?: boolean;
    decisionHeadMoved?: boolean;
    baseChangedAfterDecision?: 'name' | 'sha';
    unrelatedBranch?: boolean;
    failedClose?: boolean;
    deletedAfterMerge?: boolean;
    wrongClosingIssue?: boolean;
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
  let decisionRead = false;
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
    mergeable: state === 'clean' || state === 'unstable' || state === 'has_hooks',
    mergeable_state: state,
    head: { sha: head, ref: 'issue/17', repo: { full_name: 'example/widget' } },
    base: {
      sha: decisionRead && option.baseChangedAfterDecision === 'sha' ? 'd'.repeat(40) : 'c'.repeat(40),
      ref: decisionRead && option.baseChangedAfterDecision === 'name' ? 'other' : 'main',
      repo: { full_name: 'example/widget' },
    },
    user: { login: 'author' },
  });
  const rest = {
    request: async () => ({ status: 200, headers: {}, data: [] }),
    checks: { listForRef: async () => ({ data: { check_runs: [] } }) },
    repos: {
      getCombinedStatusForRef: async () => ({ data: { state: 'success' } }),
      get: async () => ({ data: { node_id: 'REPO', default_branch: 'main', full_name: 'example/widget' } }),
    },
    git: {
      getCommit: async () => ({ data: { sha: head, tree: { sha: '0'.repeat(40) } } }),
      getRef: async ({ ref }: { ref: string }) => ({
        data: {
          ref: `refs/${ref}`,
          object: {
            type: 'commit',
            sha:
              ref === 'heads/main' || ref === 'heads/other'
                ? option.baseMoved
                  ? 'e'.repeat(40)
                  : 'c'.repeat(40)
                : head,
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
          state: 'APPROVED',
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
  const graphql = async (query: string, variables?: { cursor?: string | null }) => {
    if (query.includes('DeliveryRequiredChecks')) {
      const all = [
        ...(option.nativeChecks ?? []).map((check, i) => ({
          __typename: 'CheckRun',
          id: `CHECK${i}`,
          name: check.name,
          isRequired: check.required,
          status: check.status,
          conclusion: check.conclusion,
        })),
        ...(option.nativeStatuses ?? []).map((check, i) => ({
          __typename: 'StatusContext',
          id: `STATUS${i}`,
          context: check.name,
          isRequired: check.required,
          state: check.state,
        })),
      ];
      const offset = variables?.cursor === 'next' ? 100 : 0;
      const more = offset + 100 < all.length;
      return {
        repository: {
          object: {
            oid: head,
            statusCheckRollup: {
              contexts: {
                totalCount: all.length,
                nodes: all.slice(offset, offset + 100),
                pageInfo:
                  option.nativePage === 'malformed'
                    ? {}
                    : {
                        hasNextPage: more || option.nativePage === 'continuation',
                        endCursor: option.nativePage === 'continuation' ? 'same' : more ? 'next' : null,
                      },
              },
            },
          },
        },
      };
    }
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
    if (option.decisionUnavailable) throw new Error('Fictional review decision unavailable');
    decisionRead = true;
    return {
      repository: {
        pullRequest: {
          headRefOid: option.decisionHeadMoved ? 'd'.repeat(40) : head,
          reviewDecision: Object.hasOwn(option, 'reviewDecision') ? option.reviewDecision : 'APPROVED',
        },
      },
    };
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
  it('uses native eligibility without comparing historical artifact identity', async () => {
    const { context, merges } = fixture('clean', { reviewBinding: 'stale-head' });
    await mergePr(context, { issueNumber: 17, prNumber: 23, reviewedHeadSha: head });
    assert.equal(merges.length, 1);
    assert.equal(merges[0]?.sha, head);
  });
  it('accepts native PR association despite a superseded linked branch snapshot', async () => {
    const { context, merges } = fixture('clean', { unrelatedBranch: true });
    await mergePr(context, { issueNumber: 17, prNumber: 23 });
    assert.equal(merges.length, 1);
  });

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
    it(`defers ${reviewBinding} historical review eligibility to GitHub`, async () => {
      const { context, merges } = fixture('clean', { reviewBinding });
      context.clients.rest.pulls.listReviews = (async () => {
        throw new Error('Historical review comparison must not run');
      }) as unknown as typeof context.clients.rest.pulls.listReviews;
      context.clients.rest.git.getCommit = (async () => {
        throw new Error('Historical tree comparison must not run');
      }) as unknown as typeof context.clients.rest.git.getCommit;
      context.clients.rest.pulls.listFiles = (async () => {
        throw new Error('Historical diff comparison must not run');
      }) as unknown as typeof context.clients.rest.pulls.listFiles;
      await mergePr(context, { issueNumber: 17, prNumber: 23 });
      assert.equal(merges.length, 1);
    });
  }
  it('merges a native zero-review decision without requiring an extra App approval', async () => {
    const { context, merges } = fixture('clean', { reviewDecision: null });
    delete context.reviewerClients;
    context.clients.rest.pulls.listReviews = (async () => {
      throw new Error('Extra approval must not be required');
    }) as unknown as typeof context.clients.rest.pulls.listReviews;
    await mergePr(context, { issueNumber: 17, prNumber: 23 });
    assert.equal(merges.length, 1);
  });
  for (const [status, conclusion] of [
    ['IN_PROGRESS', null],
    ['COMPLETED', 'FAILURE'],
    ['COMPLETED', 'TIMED_OUT'],
  ] as const) {
    it(`names the required native money-path-review blocker ${status}/${conclusion}`, async () => {
      const { context, merges } = fixture('blocked', {
        nativeChecks: [{ name: 'money-path-review', required: true, status, conclusion }],
      });
      await assert.rejects(mergePr(context, { issueNumber: 17, prNumber: 23 }), /money-path-review/u);
      assert.equal(merges.length, 0);
    });
  }
  it('reports discovered required check names and permits a failed optional check', async () => {
    const { context, merges } = fixture('unstable', {
      nativeChecks: [
        { name: 'local-verify', required: true, status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'money-path-review', required: true, status: 'COMPLETED', conclusion: 'NEUTRAL' },
        { name: 'optional', required: false, status: 'COMPLETED', conclusion: 'FAILURE' },
      ],
    });
    const checks = await prChecks(context, 23);
    assert.deepEqual(
      (checks as unknown as { requiredChecks: Array<{ name: string }> }).requiredChecks.map((check) => check.name),
      ['local-verify', 'money-path-review'],
    );
    await mergePr(context, { issueNumber: 17, prNumber: 23 });
    assert.equal(merges.length, 1);
  });
  it('reads all native context pages including required legacy statuses', async () => {
    const { context, merges } = fixture('clean', {
      nativeChecks: Array.from({ length: 100 }, (_, i) => ({
        name: `optional${i}`,
        required: false,
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
      })),
      nativeStatuses: [{ name: 'legacy-required', required: true, state: 'SUCCESS' }],
    });
    const checks = await prChecks(context, 23);
    assert.deepEqual(
      checks.requiredChecks.map((check) => check.name),
      ['legacy-required'],
    );
    await mergePr(context, { issueNumber: 17, prNumber: 23 });
    assert.equal(merges.length, 1);
  });
  it('refuses a failing required legacy status even with an eligible aggregate state', async () => {
    const { context, merges } = fixture('clean', {
      nativeStatuses: [{ name: 'legacy-required', required: true, state: 'FAILURE' }],
    });
    await assert.rejects(mergePr(context, { issueNumber: 17, prNumber: 23 }), /legacy-required/u);
    assert.equal(merges.length, 0);
  });
  it('refuses unavailable review decision readback even when GitHub REST is clean', async () => {
    const { context, merges } = fixture('clean', { decisionUnavailable: true });
    await assert.rejects(mergePr(context, { issueNumber: 17, prNumber: 23 }));
    assert.equal(merges.length, 0);
  });
  for (const nativePage of ['continuation', 'malformed'] as const) {
    it(`refuses incomplete native check evidence ${nativePage}`, async () => {
      const { context, merges } = fixture('clean', { nativePage });
      await assert.rejects(mergePr(context, { issueNumber: 17, prNumber: 23 }), /pagination|incomplete|Incomplete/u);
      assert.equal(merges.length, 0);
    });
  }
  for (const reviewDecision of [undefined, 'UNKNOWN', false, 0, {}, 'REVIEW_REQUIRED', 'CHANGES_REQUESTED']) {
    it(`refuses unavailable or blocking native review decision ${JSON.stringify(reviewDecision)}`, async () => {
      const { context, merges } = fixture('clean', { reviewDecision });
      await assert.rejects(mergePr(context, { issueNumber: 17, prNumber: 23 }));
      assert.equal(merges.length, 0);
    });
  }
  for (const option of [
    { decisionHeadMoved: true },
    { baseChangedAfterDecision: 'name' },
    { baseChangedAfterDecision: 'sha' },
  ] as const) {
    it(`refuses native head/base decision drift ${JSON.stringify(option)}`, async () => {
      const { context, merges } = fixture('clean', option);
      await assert.rejects(mergePr(context, { issueNumber: 17, prNumber: 23 }));
      assert.equal(merges.length, 0);
    });
  }
  it('accepts GitHub passing eligibility with native pre-receive hooks', async () => {
    const { context, merges } = fixture('has_hooks');
    await mergePr(context, { issueNumber: 17, prNumber: 23 });
    assert.equal(merges.length, 1);
  });
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

  for (const state of ['blocked', 'behind', 'dirty', 'unknown', null]) {
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
    ['moved reviewed head', { headMoved: true }],
    ['unknown decision', { reviewDecision: 'UNKNOWN' }],
    ['required review', { reviewDecision: 'REVIEW_REQUIRED' }],
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
