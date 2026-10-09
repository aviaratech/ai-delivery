import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as settings from './config/deliveryConfig.js';
import { digestValue } from './delivery/common.js';
import { executeTool } from './dispatch.js';
import * as issues from './issue.js';
import type { DeliveryContext } from './issue.js';
import { createAiDeliveryMcpServer } from './mcp/index.js';
import { prInfo, publishPr, startIssueBranch, submitFormalReview } from './pr.js';

const repo = 'example/widget';
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const tree = 'c'.repeat(40);
const pageInfo = { hasNextPage: false, endCursor: null };

function fixture(published = true) {
  const state = {
    published,
    linked: false,
    remoteHead: published ? head : base,
    headSha: head,
    headRef: 'issue/17',
    headRepo: repo,
    baseRepo: repo,
    baseSha: base,
    baseRef: 'main',
    nodeId: 'PR23',
    prAuthor: 'author',
    prState: 'open',
    merged: false as unknown,
    draft: true as unknown,
    remoteRef: 'refs/heads/issue/17',
    remoteType: 'commit',
    issueNumber: 17,
    associationRepo: repo,
    associationPr: 23,
    closingReadback: undefined as unknown,
    closingPages: [] as unknown[],
    closingPageIndex: 0,
    branchReadback: undefined as unknown,
    reviewerActor: 'reviewer[bot]',
    movedOnRead: 0,
    reads: 0,
    readHook: undefined as ((reads: number) => void) | undefined,
    matchReadback: undefined as unknown,
    promotionReadback: undefined as unknown,
    keepDraftOnPromotion: false,
    promotions: 0,
    creations: 0,
    expectedCreationDraft: true,
    events: [] as string[],
    reviews: [] as Array<{
      id: number;
      body: string;
      user: { login: string };
      state: string;
      commit_id: string;
      html_url: string;
    }>,
    submissions: 0,
  };
  const pr = () => ({
    number: 23,
    node_id: state.nodeId,
    changed_files: 1,
    title: 'Improve widget',
    body: 'Closes #17',
    html_url: `https://github.com/${repo}/pull/23`,
    state: state.prState,
    draft: state.draft,
    merged: state.merged,
    head: { sha: state.headSha, ref: state.headRef, repo: { full_name: state.headRepo } },
    base: { sha: state.baseSha, ref: state.baseRef, repo: { full_name: state.baseRepo } },
    user: { login: state.prAuthor },
  });
  const rest = {
    request: async () => ({ data: [] }),
    repos: { get: async () => ({ data: { node_id: 'REPO', full_name: repo, default_branch: 'main' } }) },
    issues: { get: async () => ({ data: { node_id: 'ISSUE17', number: 17, state: 'open', title: 'Improve widget' } }) },
    git: {
      getRef: async (input: { owner: string; repo: string; ref: string }) => {
        assert.equal(`${input.owner}/${input.repo}`, repo);
        return {
          data: {
            ref: input.ref === 'heads/main' ? 'refs/heads/main' : state.remoteRef,
            object: { type: state.remoteType, sha: input.ref === 'heads/main' ? base : state.remoteHead },
          },
        };
      },
      getCommit: async () => ({ data: { sha: head, tree: { sha: tree } } }),
    },
    pulls: {
      get: async () => {
        state.reads++;
        state.readHook?.(state.reads);
        if (state.movedOnRead && state.reads >= state.movedOnRead) state.headSha = 'd'.repeat(40);
        return { data: pr() };
      },
      list: async () => ({ data: state.matchReadback ?? (state.published ? [{ number: 23 }] : []) }),
      create: async (input: { draft: boolean; head: string }) => {
        assert.equal(input.draft, state.expectedCreationDraft);
        assert.equal(input.head, 'issue/17');
        state.creations++;
        state.draft = input.draft;
        state.published = true;
        state.linked = false;
        state.events.push('draft-publication-replaces-branch-link');
        return { data: pr() };
      },
      listFiles: async () => ({ data: [{ filename: 'change.ts' }] }),
      listReviews: async () => ({ data: state.reviews }),
      getReview: async () => ({ data: state.reviews[0] }),
      createReview: async (input: { commit_id: string; body: string; event: string }) => {
        assert.equal(input.commit_id, head);
        assert.equal(input.event, 'APPROVE');
        state.submissions++;
        const review = {
          id: 99,
          body: input.body,
          user: { login: state.reviewerActor },
          state: 'APPROVED',
          commit_id: head,
          html_url: `https://github.com/${repo}/pull/23#pullrequestreview-99`,
        };
        state.reviews.push(review);
        return { data: review };
      },
    },
  };
  const graphql = async (query: string) => {
    if (query.includes('DeliveryStartBranch')) {
      state.linked = true;
      state.events.push('native-start');
      return { createLinkedBranch: { linkedBranch: { ref: { name: 'issue/17', target: { oid: base } } } } };
    }
    if (query.includes('DeliveryIssueBranches'))
      return (
        state.branchReadback ?? {
          repository: {
            issue: {
              linkedBranches: {
                nodes: state.linked
                  ? [
                      {
                        ref: {
                          name: 'issue/17',
                          target: { oid: state.remoteHead },
                          repository: { nameWithOwner: repo },
                        },
                      },
                    ]
                  : [],
                pageInfo,
              },
            },
          },
        }
      );
    if (query.includes('DeliveryClosingIssues') && state.closingPages.length > 0)
      return state.closingPages[state.closingPageIndex++];
    if (query.includes('DeliveryClosingIssues'))
      return (
        state.closingReadback ?? {
          repository: {
            nameWithOwner: state.associationRepo,
            pullRequest: {
              number: state.associationPr,
              closingIssuesReferences: {
                nodes: [{ number: state.issueNumber, repository: { nameWithOwner: repo } }],
                pageInfo,
              },
            },
          },
        }
      );
    if (query.includes('DeliveryReadyPr')) {
      state.promotions++;
      if (!state.keepDraftOnPromotion) state.draft = false;
      return (
        state.promotionReadback ?? { markPullRequestReadyForReview: { pullRequest: { id: 'PR23', isDraft: false } } }
      );
    }
    throw new Error(`Unexpected synthetic query: ${query}`);
  };
  const reviewer = {
    role: 'reviewer',
    authSource: 'app',
    effectiveContentsPermission: 'write',
    appActorLogin: async () => state.reviewerActor,
    rest,
    graphql,
  };
  const context = {
    root: '/nonexistent-launch-directory',
    repo: { owner: 'example', repo: 'widget' },
    config: {
      schemaVersion: 'ai-delivery.github@1',
      repository: repo,
      roles: { author: { authSource: 'personal', identity: 'author' }, reviewer: { identity: 'reviewer' } },
    },
    clients: {
      role: 'author',
      authSource: 'personal',
      authenticatedAuthor: async () => ({ actorLogin: 'author', credentialIdentity: 'synthetic-author' }),
      rest,
      graphql,
    },
    reviewerClients: reviewer,
  } as unknown as DeliveryContext;
  const content = {
    schemaVersion: 'ai-delivery.review-artifact@1',
    authorIdentity: 'author',
    reviewerIdentity: 'reviewer',
    checks: ['Synthetic exact-head checks'],
    diffScopeHash: digestValue(['change.ts']),
    elapsedMs: 1,
    findings: [],
    head: { sha: head, tree },
    issueNumber: 17,
    prNumber: 23,
    readOnly: true,
    requestedEffort: 'xhigh',
    requestedModel: 'gpt-6-astra',
    effectiveEffort: 'unknown',
    effectiveModel: 'unknown',
    summary: 'Synthetic independent review.',
    verdict: 'approve',
  };
  const artifact = JSON.stringify({ ...content, artifactId: digestValue(content) });
  return { state, context, reviewerContext: { ...context, clients: reviewer } as unknown as DeliveryContext, artifact };
}

afterEach(() => vi.restoreAllMocks());

describe('native exact PR association after publication', () => {
  it('replays native start, push, draft publication, empty branch links, author inspection and distinct App review', async () => {
    const { context, reviewerContext, state, artifact } = fixture(false);
    const started = await startIssueBranch(context, 17);
    assert.equal(started.reused, false);
    assert.equal(started.headSha, base);
    state.remoteHead = head;
    state.events.push('push');
    await publishPr(context, { issueNumber: 17, body: 'Improve widget', draft: true });
    assert.deepEqual(state.events, ['native-start', 'push', 'draft-publication-replaces-branch-link']);
    assert.equal(state.linked, false);
    assert.equal((await prInfo(context, { issueNumber: 17, prNumber: 23 })).headSha, head);
    assert.equal(
      (await submitFormalReview(reviewerContext, { issueNumber: 17, prNumber: 23, artifact, dryRun: true })).headSha,
      head,
    );
    assert.equal(state.submissions, 0);
    const submitted = await submitFormalReview(reviewerContext, { issueNumber: 17, prNumber: 23, artifact });
    const reused = await submitFormalReview(reviewerContext, { issueNumber: 17, prNumber: 23, artifact });
    assert.deepEqual(reused, submitted);
    assert.equal(state.submissions, 1);
  });

  it('gives an exact-PR next action for issue-only lookup with empty branch links', async () => {
    const { context } = fixture();
    await assert.rejects(prInfo(context, { issueNumber: 17 }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /exact issue and PR numbers.*--issue and --pr/u);
      assert.doesNotMatch(error.message, /zero or multiple PRs|start again|repeat.*start/u);
      return true;
    });
    assert.equal((await prInfo(context, { prNumber: 23 })).prNumber, 23);
  });

  it('verifies native association when issue-only lookup still has a linked branch', async () => {
    const { context, state } = fixture();
    state.linked = true;
    assert.equal((await prInfo(context, { issueNumber: 17 })).prNumber, 23);
    state.issueNumber = 18;
    await assert.rejects(prInfo(context, { issueNumber: 17 }), /association/u);
  });

  for (const [name, change] of [
    ['wrong closing issue', { issueNumber: 18 }],
    ['wrong PR repository', { headRepo: 'other/widget' }],
    ['wrong base repository', { baseRepo: 'other/widget' }],
    ['wrong native repository', { associationRepo: 'other/widget' }],
    ['wrong native PR', { associationPr: 24 }],
    ['remote head drift', { remoteHead: 'd'.repeat(40) }],
    ['remote ref mismatch', { remoteRef: 'refs/heads/other' }],
    ['incomplete remote ref', { remoteType: '' }],
    ['invalid head branch', { headRef: '../other' }],
    ['invalid PR head', { headSha: 'missing' }],
    ['incomplete PR state', { prState: '' }],
    ['incomplete merged state', { merged: undefined }],
    ['incomplete draft state', { draft: undefined }],
    ['conflicting merged state', { merged: true }],
  ] as const) {
    it(`refuses ${name} before inspection or review mutation`, async () => {
      const { context, reviewerContext, state, artifact } = fixture();
      Object.assign(state, change);
      await assert.rejects(prInfo(context, { issueNumber: 17, prNumber: 23 }));
      await assert.rejects(submitFormalReview(reviewerContext, { issueNumber: 17, prNumber: 23, artifact }));
      assert.equal(state.submissions, 0);
    });
  }

  for (const [name, response] of [
    ['missing connection', { repository: { nameWithOwner: repo, pullRequest: { number: 23 } } }],
    [
      'empty closing issues',
      {
        repository: {
          nameWithOwner: repo,
          pullRequest: { number: 23, closingIssuesReferences: { nodes: [], pageInfo } },
        },
      },
    ],
    [
      'foreign closing issue',
      {
        repository: {
          nameWithOwner: repo,
          pullRequest: {
            number: 23,
            closingIssuesReferences: {
              nodes: [{ number: 17, repository: { nameWithOwner: 'other/widget' } }],
              pageInfo,
            },
          },
        },
      },
    ],
    [
      'incomplete closing issue',
      {
        repository: {
          nameWithOwner: repo,
          pullRequest: { number: 23, closingIssuesReferences: { nodes: [null], pageInfo } },
        },
      },
    ],
    [
      'duplicate closing issue',
      {
        repository: {
          nameWithOwner: repo,
          pullRequest: {
            number: 23,
            closingIssuesReferences: {
              nodes: Array.from({ length: 2 }, () => ({ number: 17, repository: { nameWithOwner: repo } })),
              pageInfo,
            },
          },
        },
      },
    ],
    [
      'missing pagination',
      { repository: { nameWithOwner: repo, pullRequest: { number: 23, closingIssuesReferences: { nodes: [] } } } },
    ],
    [
      'nonadvancing pagination',
      {
        repository: {
          nameWithOwner: repo,
          pullRequest: {
            number: 23,
            closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } },
          },
        },
      },
    ],
  ] as const) {
    it(`refuses ${name} before App submission`, async () => {
      const { reviewerContext, state, artifact } = fixture();
      state.closingReadback = response;
      await assert.rejects(
        submitFormalReview(reviewerContext, { issueNumber: 17, prNumber: 23, artifact }),
        /association|identity|pagination/u,
      );
      assert.equal(state.submissions, 0);
    });
  }

  for (const [name, response] of [
    ['incomplete linked branches', { repository: { issue: { linkedBranches: { nodes: [], pageInfo: {} } } } }],
    [
      'conflicting linked branch',
      {
        repository: {
          issue: {
            linkedBranches: {
              nodes: [{ ref: { name: 'other', target: { oid: head }, repository: { nameWithOwner: repo } } }],
              pageInfo,
            },
          },
        },
      },
    ],
    [
      'stale linked head',
      {
        repository: {
          issue: {
            linkedBranches: {
              nodes: [{ ref: { name: 'issue/17', target: { oid: base }, repository: { nameWithOwner: repo } } }],
              pageInfo,
            },
          },
        },
      },
    ],
  ] as const) {
    it(`refuses ${name} despite a valid closing-issue association`, async () => {
      const { reviewerContext, state, artifact } = fixture();
      state.branchReadback = response;
      await assert.rejects(submitFormalReview(reviewerContext, { issueNumber: 17, prNumber: 23, artifact }));
      assert.equal(state.submissions, 0);
    });
  }

  it('refuses configured/selected repository disagreement', async () => {
    const { context } = fixture();
    context.repo = { owner: 'other', repo: 'widget' };
    await assert.rejects(prInfo(context, { issueNumber: 17, prNumber: 23 }), /repository identities/u);
  });

  it('reads the complete closing-issue connection before accepting a later-page association', async () => {
    const { context, state } = fixture();
    state.closingPages = [
      {
        repository: {
          nameWithOwner: repo,
          pullRequest: {
            number: 23,
            closingIssuesReferences: {
              nodes: [{ number: 18, repository: { nameWithOwner: repo } }],
              pageInfo: { hasNextPage: true, endCursor: 'NEXT' },
            },
          },
        },
      },
      {
        repository: {
          nameWithOwner: repo,
          pullRequest: {
            number: 23,
            closingIssuesReferences: {
              nodes: [{ number: 17, repository: { nameWithOwner: repo } }],
              pageInfo,
            },
          },
        },
      },
    ];
    assert.equal((await prInfo(context, { issueNumber: 17, prNumber: 23 })).headSha, head);
    assert.equal(state.closingPageIndex, 2);
  });

  it('refuses an incomplete later page even after finding the intended closing issue', async () => {
    const { reviewerContext, state, artifact } = fixture();
    state.closingPages = [
      {
        repository: {
          nameWithOwner: repo,
          pullRequest: {
            number: 23,
            closingIssuesReferences: {
              nodes: [{ number: 17, repository: { nameWithOwner: repo } }],
              pageInfo: { hasNextPage: true, endCursor: 'NEXT' },
            },
          },
        },
      },
      { repository: null },
    ];
    await assert.rejects(
      submitFormalReview(reviewerContext, { issueNumber: 17, prNumber: 23, artifact }),
      /association/u,
    );
    assert.equal(state.closingPageIndex, 2);
    assert.equal(state.submissions, 0);
  });

  it('preserves configured reviewer separation and stale artifact/head refusals', async () => {
    const { context, reviewerContext, state, artifact } = fixture();
    await assert.rejects(submitFormalReview(context, { issueNumber: 17, prNumber: 23, artifact }), /reviewer.*role/u);
    state.reviewerActor = 'author';
    await assert.rejects(submitFormalReview(reviewerContext, { issueNumber: 17, prNumber: 23, artifact }), /differ/u);
    state.reviewerActor = 'reviewer[bot]';
    state.movedOnRead = state.reads + 2;
    await assert.rejects(
      submitFormalReview(reviewerContext, { issueNumber: 17, prNumber: 23, artifact }),
      /head|moved/u,
    );
    assert.equal(state.submissions, 0);
  });

  it('rejects a conflicting existing App review instead of resubmitting', async () => {
    const { reviewerContext, state, artifact } = fixture();
    await submitFormalReview(reviewerContext, { issueNumber: 17, prNumber: 23, artifact });
    state.reviews[0]!.body = `<!-- ai-delivery-review-artifact: sha256:${'f'.repeat(64)} -->`;
    await assert.rejects(submitFormalReview(reviewerContext, { issueNumber: 17, prNumber: 23, artifact }), /conflict/u);
    assert.equal(state.submissions, 1);
  });
});

describe('authoritative existing PR promotion', () => {
  const input = { issueNumber: 17, headBranch: 'issue/17', draft: false };

  it('promotes after publication and exact-head review, then reuses authoritative ready readback', async () => {
    const { context, reviewerContext, state, artifact } = fixture();
    await submitFormalReview(reviewerContext, { issueNumber: 17, prNumber: 23, artifact });
    const preview = await publishPr(context, { ...input, dryRun: true });
    assert.equal(preview.prNumber, 23);
    assert.equal(preview.draft, true);
    assert.equal(state.promotions, 0);
    const promoted = await publishPr(context, input);
    const reused = await publishPr(context, input);
    assert.equal(promoted.prNumber, 23);
    assert.equal(promoted.draft, false);
    assert.deepEqual(reused, promoted);
    assert.equal(state.promotions, 1);
    assert.equal(state.creations, 0);
    assert.equal(state.submissions, 1);
    assert.equal(state.linked, false);
    assert.deepEqual(state.events, []);
  });

  for (const [name, change] of [
    ['wrong issue', { issueNumber: 18 }],
    ['foreign PR head repository', { headRepo: 'other/widget' }],
    ['foreign PR base repository', { baseRepo: 'other/widget' }],
    ['foreign native repository', { associationRepo: 'other/widget' }],
    ['wrong native PR', { associationPr: 24 }],
    ['wrong author', { prAuthor: 'collaborator' }],
    ['wrong head', { headSha: 'd'.repeat(40) }],
    ['moved remote head', { remoteHead: 'd'.repeat(40) }],
    ['wrong ref', { headRef: 'other' }],
    ['wrong base', { baseRef: 'release' }],
    ['closed PR', { prState: 'closed' }],
    ['missing node identity', { nodeId: '' }],
    ['incomplete draft state', { draft: undefined }],
    ['ambiguous matches', { matchReadback: [{ number: 23 }, { number: 24 }] }],
    ['incomplete match identity', { matchReadback: [{}] }],
    ['incomplete match connection', { matchReadback: {} }],
    ['incomplete association', { closingReadback: { repository: null } }],
    ['incomplete branch connection', { branchReadback: { repository: null } }],
  ] as const) {
    it(`refuses ${name} before promotion, including already-ready reuse`, async () => {
      for (const draft of [true, false]) {
        const { context, state } = fixture();
        state.draft = draft;
        Object.assign(state, change);
        await assert.rejects(publishPr(context, input));
        assert.equal(state.promotions, 0);
        assert.equal(state.creations, 0);
        assert.deepEqual(state.events, []);
      }
    });
  }

  for (const read of [2, 3]) {
    it(`refuses head drift on authoritative PR read ${read} before mutation`, async () => {
      const { context, state } = fixture();
      state.readHook = (count) => {
        if (count === read) state.headSha = state.remoteHead = 'd'.repeat(40);
      };
      await assert.rejects(publishPr(context, input), /drift/u);
      assert.equal(state.promotions, 0);
    });
  }

  it('refuses author and native node drift immediately before mutation', async () => {
    for (const field of ['prAuthor', 'nodeId'] as const) {
      const { context, state } = fixture();
      state.readHook = (count) => {
        if (count === 3) state[field] = 'changed';
      };
      await assert.rejects(publishPr(context, input), /drift/u);
      assert.equal(state.promotions, 0);
    }
  });

  for (const response of [
    {},
    { markPullRequestReadyForReview: null },
    { markPullRequestReadyForReview: { pullRequest: { id: 'PR24', isDraft: false } } },
    { markPullRequestReadyForReview: { pullRequest: { id: 'PR23' } } },
  ]) {
    it('refuses incomplete or conflicting mutation acknowledgement without retrying it', async () => {
      const { context, state } = fixture();
      state.promotionReadback = response;
      await assert.rejects(publishPr(context, input), /mutation readback/u);
      assert.equal(state.promotions, 1);
      assert.equal(state.creations, 0);
    });
  }

  it('refuses a still-draft authoritative readback after a ready acknowledgement', async () => {
    const { context, state } = fixture();
    state.keepDraftOnPromotion = true;
    await assert.rejects(publishPr(context, input), /still draft/u);
    assert.equal(state.promotions, 1);
  });

  it('refuses post-mutation head or association drift without another mutation', async () => {
    for (const kind of ['head', 'association']) {
      const { context, state } = fixture();
      state.readHook = (count) => {
        if (count === 4) {
          if (kind === 'head') state.headSha = state.remoteHead = 'd'.repeat(40);
          else state.closingReadback = { repository: null };
        }
      };
      await assert.rejects(publishPr(context, input), /drift|association/u);
      assert.equal(state.promotions, 1);
    }
  });

  it('requires explicit head and ready intent rather than guessing a post-publication branch', async () => {
    const { context, state } = fixture();
    await assert.rejects(publishPr(context, { issueNumber: 17, draft: false }), /linked/u);
    await assert.rejects(publishPr(context, { ...input, draft: true }), /linked/u);
    assert.equal(state.promotions, 0);
  });

  it('keeps new ready-PR creation behind native linked-branch authority', async () => {
    const { context, state } = fixture(false);
    await assert.rejects(publishPr(context, input), /linked/u);
    assert.equal(state.creations, 0);
    const started = await startIssueBranch(context, 17);
    assert.equal(started.headSha, base);
    state.remoteHead = head;
    state.expectedCreationDraft = false;
    const created = await publishPr(context, input);
    assert.equal(created.draft, false);
    assert.equal(state.creations, 1);
    assert.equal(state.promotions, 0);
  });

  it('keeps incomplete native branch readback behind the unchanged start gate', async () => {
    const { context, state } = fixture(false);
    state.branchReadback = { repository: null };
    await assert.rejects(startIssueBranch(context, 17), /Incomplete/u);
    assert.deepEqual(state.events, []);
  });

  it('retains configured author role and distinct App preflight before promotion', async () => {
    const { context, reviewerContext, state } = fixture();
    await assert.rejects(publishPr(reviewerContext, input), /author/u);
    state.reviewerActor = 'author';
    await assert.rejects(publishPr(context, input), /distinct/u);
    assert.equal(state.promotions, 0);
  });
});

describe('directory-independent exact-PR contract', () => {
  it('uses the existing MCP selector for author dry-run, promotion and ready reuse outside a checkout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'delivery-pr-promotion-'));
    const { context, state } = fixture();
    vi.spyOn(settings, 'loadDeliverySettings').mockResolvedValue(
      context.config as unknown as Awaited<ReturnType<typeof settings.loadDeliverySettings>>,
    );
    vi.spyOn(issues, 'loadDeliveryContext').mockImplementation(async (input) => {
      assert.equal(input.repository, repo);
      assert.equal(input.repoRoot, root);
      assert.equal(input.role, 'author');
      return context;
    });
    const server = createAiDeliveryMcpServer({ repoRoot: root });
    const client = new Client({ name: 'promotion-fixture', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const input = { repo, issueNumber: 17, headBranch: 'issue/17', draft: false };
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const preview = await client.callTool({ name: 'issue_pr_create', arguments: { ...input, dryRun: true } });
      assert.equal(preview.isError, undefined);
      assert.equal(state.promotions, 0);
      for (let call = 0; call < 2; call++) {
        const result = await client.callTool({ name: 'issue_pr_create', arguments: input });
        assert.equal(result.isError, undefined);
      }
      assert.equal(state.promotions, 1);
      assert.equal(state.creations, 0);
      assert.equal(state.draft, false);
      assert.equal(state.linked, false);
    } finally {
      await client.close();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('dispatches native inspection and App dry-run through MCP from a non-Git directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'delivery-pr-association-'));
    const { context, reviewerContext, state, artifact } = fixture();
    vi.spyOn(settings, 'loadDeliverySettings').mockResolvedValue(
      context.config as unknown as Awaited<ReturnType<typeof settings.loadDeliverySettings>>,
    );
    const loader = vi.spyOn(issues, 'loadDeliveryContext').mockImplementation(async (input) => {
      assert.equal(input.repository, repo);
      assert.equal(input.repoRoot, root);
      return input.role === 'reviewer' ? reviewerContext : context;
    });
    const server = createAiDeliveryMcpServer({ repoRoot: root });
    const client = new Client({ name: 'exact-pr-fixture', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const info = await client.callTool({ name: 'issue_pr_info', arguments: { repo, issueNumber: 17, prNumber: 23 } });
      assert.equal(info.isError, undefined);
      const review = await client.callTool({
        name: 'issue_pr_review',
        arguments: { repo, issueNumber: 17, prNumber: 23, artifact, dryRun: true },
      });
      assert.equal(review.isError, undefined);
      state.issueNumber = 18;
      await assert.rejects(
        executeTool('issue_pr_info', { repo, issueNumber: 17, prNumber: 23 }, { repoRoot: root }),
        /association/u,
      );
      assert.deepEqual(
        loader.mock.calls.map(([input]) => input.role),
        ['author', 'reviewer', 'author'],
      );
      assert.equal(state.submissions, 0);
    } finally {
      await client.close();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('documents explicit issue/PR selection in actual CLI help without credentials or a checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'delivery-pr-help-'));
    try {
      const help = execFileSync(process.execPath, [resolve('dist/cli.js'), 'pr:info', '--help'], {
        cwd: root,
        env: { HOME: root, PATH: process.env.PATH },
        encoding: 'utf8',
      });
      assert.match(help, /combine --issue and --pr/u);
      assert.match(help, /issue-only lookup requires a GitHub-linked\s+branch/u);
      const creationHelp = execFileSync(process.execPath, [resolve('dist/cli.js'), 'pr:create', '--help'], {
        cwd: root,
        env: { HOME: root, PATH: process.env.PATH },
        encoding: 'utf8',
      }).replace(/\s+/gu, ' ');
      assert.match(creationHelp, /promote an existing associated PR with --head and --ready/u);
      assert.match(creationHelp, /Explicit remote head/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
