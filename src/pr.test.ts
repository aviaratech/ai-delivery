import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { publishPr, prChecks } from './pr.js';
import type { DeliveryContext } from './issue.js';
import { digestValue } from './delivery/common.js';
import * as prReaders from './pr.js';

it('PR markers require their exact canonical footer', () => {
  const bodyMarker = Reflect.get(prReaders, 'hasDeliveryPrMarker') as ((body: string) => boolean) | undefined;
  assert.equal(typeof bodyMarker, 'function');
  const marker = '<!-- ai-delivery:pr@1 -->';
  assert.equal(bodyMarker!(`Closes #17\n\nProof.\n\n${marker}`), true);
  assert.equal(bodyMarker!(`Closes #17\n\nDocument ai-delivery:pr@1 semantics.\n\n${marker}`), true);
  assert.equal(bodyMarker!(`Proof\n\n\`\`\`md\n${marker}\n\`\`\`\n\n${marker}`), true);
  assert.equal(bodyMarker!(`Proof\n\n> ${marker}\n\n${marker}`), true);
  for (const example of [
    `Proof\n\n    ${marker}`,
    `Proof\n\n\t${marker}`,
    `Proof\n\n~~~md\n${marker}\n~~~`,
    `Proof \`multiline\n    text ${marker}\ntext\`.`,
    `Escaped \\${marker} remains literal.`,
    `The literal marker is \`${marker}\`.`,
    `The literal marker is \`\`before \` ${marker}\`\`.`,
    `Example \`multiline\ntext ${marker}\ntext\`.`,
    'An unmatched backtick is literal: `',
  ])
    assert.equal(bodyMarker!(`Closes #17\n\n${example}\n\n${marker}`), true, example);
  assert.equal(bodyMarker!(`Closes #17\n\nEscaped \\\`${marker} remains active.\n\n${marker}`), false);
  for (const indent of ['', ' ', '  ', '   '])
    assert.equal(
      bodyMarker!(`Closes #17\n\nExample \`multiline\n${indent}${marker}\ntext\`.\n\n${marker}`),
      false,
      'A comment block interrupts the paragraph before inline code parsing',
    );
  for (const boundary of ['=', '--', '___'])
    assert.equal(bodyMarker!(`Proof \`open\n${boundary}\ntext ${marker}\nclose\`.\n\n${marker}`), false);
  for (const body of [
    `Proof\n\n<div>\n\`\`\`\n${marker}\n\`\`\`\n</div>\n\n${marker}`,
    `Proof\n\n<?instruction\n\n${marker}`,
    `Proof\n\n<![CDATA[\n\n${marker}`,
    `Proof \`multiline\n# Heading\ntext ${marker}\ntext\`.\n\n${marker}`,
    `Proof \`multiline\n- New block\ntext ${marker}\ntext\`.\n\n${marker}`,
    `Proof\n\n\`\`\`\`\n${marker}\n\`\`\`\n\n${marker}`,
    `Proof\n\n\`\`\`\n${marker}\n~~~\n\n${marker}`,
    `Proof\n\n<!-- outer comment\n\n${marker}`,
    `Proof\n\n<pre>\n\n${marker}`,
    `Proof\n    ${marker}\n\n${marker}`,
    `Proof\n\n- Container\n    ${marker}\n\n${marker}`,
    marker,
    `Proof\n${marker}`,
    `Proof\n\n> ${marker}`,
    `Proof\n\n\`\`\`\n${marker}\n\`\`\``,
    `Proof\n\n${marker}\nextra`,
    `Proof\n\n${marker}\n\n${marker}`,
    `Proof\n\n${marker}\n`,
  ])
    assert.equal(bodyMarker!(body), false, body);
});

function fixture(
  state: string | null = 'clean',
  option: {
    headSha?: string;
    headTree?: string;
    mergeSha?: string;
    remoteBaseSha?: string;
    baseSha?: string;
    configuredRequiredChecks?: string[];
    requirementsViaClassic?: boolean;
    requirementsUnavailable?: boolean;
    nativeChecks?: Array<{ name: string; required: boolean; status: string; conclusion: string | null }>;
    nativeStatuses?: Array<{ name: string; required: boolean; state: string }>;
    baseMoved?: boolean;
    nonClosing?: boolean;
    commitMessage?: string;
    prBody?: string;
    messageChangedAfterDecision?: 'title' | 'body';
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
  const head = option.headSha ?? 'a'.repeat(40);
  const merge = option.mergeSha ?? 'b'.repeat(40);
  const base = option.baseSha ?? 'c'.repeat(40);
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
      tree: option.reviewBinding === 'wrong-tree' ? 'f'.repeat(40) : (option.headTree ?? '0'.repeat(40)),
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
    title:
      decisionRead && option.messageChangedAfterDecision === 'title'
        ? 'Edited title'
        : (publicationTitle ?? 'Improve widget'),
    body:
      publicationBody ??
      (decisionRead && option.messageChangedAfterDecision === 'body' ? 'Closes #17\n\nEdited body.' : option.prBody) ??
      (option.nonClosing ? 'References example/widget#17\n\nImprove widget.' : 'Closes #17'),
    html_url: 'https://github.com/example/widget/pull/23',
    state: merged ? 'closed' : 'open',
    draft: publicationDraft ?? false,
    merged,
    merge_commit_sha: merged ? merge : null,
    mergeable: state === 'clean' || state === 'unstable' || state === 'has_hooks',
    mergeable_state: state,
    head: { sha: head, ref: 'issue/17', repo: { full_name: 'example/widget' } },
    base: {
      sha: decisionRead && option.baseChangedAfterDecision === 'sha' ? 'd'.repeat(40) : base,
      ref: decisionRead && option.baseChangedAfterDecision === 'name' ? 'other' : 'main',
      repo: { full_name: 'example/widget' },
    },
    user: { login: 'author' },
  });
  const rest = {
    request: async (route: string) => {
      if (option.requirementsUnavailable) throw { status: 403 };
      if (route.endsWith('/rules/branches/{branch}'))
        return {
          status: 200,
          headers: {},
          data: option.requirementsViaClassic
            ? []
            : [
                {
                  type: 'required_status_checks',
                  parameters: {
                    required_status_checks: (
                      option.configuredRequiredChecks ??
                      [
                        ...(option.nativeChecks ?? []).filter((check) => check.required),
                        ...(option.nativeStatuses ?? []).filter((check) => check.required),
                      ].map((check) => check.name)
                    ).map((context) => ({ context })),
                  },
                },
              ],
        };
      return {
        status: 200,
        headers: {},
        data: {
          required_pull_request_reviews: { required_approving_review_count: 0 },
          required_status_checks: option.requirementsViaClassic
            ? { contexts: option.configuredRequiredChecks ?? [] }
            : null,
        },
      };
    },
    checks: {
      listForRef: async () => ({
        data: {
          total_count: (option.nativeChecks ?? []).length,
          check_runs: (option.nativeChecks ?? []).slice(0, 100).map((check) => ({
            name: check.name,
            status: check.status.toLowerCase(),
            conclusion: check.conclusion?.toLowerCase() ?? null,
          })),
        },
      }),
    },
    repos: {
      getCombinedStatusForRef: async () => ({
        data: {
          state: (option.nativeStatuses ?? []).some((check) => ['FAILURE', 'ERROR'].includes(check.state))
            ? 'failure'
            : 'success',
          total_count: (option.nativeStatuses ?? []).length,
          statuses: (option.nativeStatuses ?? [])
            .slice(0, 100)
            .map((check) => ({ context: check.name, state: check.state.toLowerCase() })),
        },
      }),
      get: async () => ({ data: { node_id: 'REPO', default_branch: 'main', full_name: 'example/widget' } }),
    },
    git: {
      getCommit: async () => ({ data: { sha: head, tree: { sha: option.headTree ?? '0'.repeat(40) } } }),
      getRef: async ({ ref }: { ref: string }) => ({
        data: {
          ref: `refs/${ref}`,
          object: {
            type: 'commit',
            sha:
              ref === 'heads/main' || ref === 'heads/other'
                ? option.baseMoved
                  ? 'e'.repeat(40)
                  : merged
                    ? (option.remoteBaseSha ?? base)
                    : base
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
        assert.equal(input.body, 'Closes #17\n\nPlain explanation\n\n<!-- ai-delivery:pr@1 -->');
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
            baseRefOid: base,
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
                      nodes: [{ oid: base }],
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
  it('retains configured requirements without relying on a check rollup', async () => {
    const { context } = fixture('blocked', { configuredRequiredChecks: ['money-path-review'] });
    const read = context.clients.graphql;
    context.clients.graphql = (async (query: string, variables: unknown) => {
      assert.ok(!query.includes('statusCheckRollup'));
      return read(query, variables as never);
    }) as typeof context.clients.graphql;
    const checks = await prChecks(context, 23);
    assert.deepEqual(checks.requiredChecks, [{ name: 'money-path-review', headState: 'not-reported' }]);
  });
  it('discovers an unreported classic-protection requirement', async () => {
    const { context } = fixture('blocked', {
      requirementsViaClassic: true,
      configuredRequiredChecks: ['classic-required'],
    });
    const checks = await prChecks(context, 23);
    assert.deepEqual(checks.requiredChecks, [{ name: 'classic-required', headState: 'not-reported' }]);
    assert.equal(checks.requiredCheckDiscovery, 'complete');
  });
  it('declares requirement discovery partial when native rule reads are unavailable', async () => {
    const { context } = fixture('blocked', { requirementsUnavailable: true });
    const checks = await prChecks(context, 23);
    assert.equal((checks as unknown as { requiredCheckDiscovery: string }).requiredCheckDiscovery, 'partial');
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
});
