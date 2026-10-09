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
    node_id: 'PR23',
    changed_files: 1,
    title: 'Improve widget',
    body: 'Closes #17',
    html_url: `https://github.com/${repo}/pull/23`,
    state: state.prState,
    draft: state.draft,
    merged: state.merged,
    head: { sha: state.headSha, ref: state.headRef, repo: { full_name: state.headRepo } },
    base: { sha: base, ref: 'main', repo: { full_name: state.baseRepo } },
    user: { login: 'author' },
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
        if (state.movedOnRead && state.reads >= state.movedOnRead) state.headSha = 'd'.repeat(40);
        return { data: pr() };
      },
      list: async () => ({ data: state.published ? [{ number: 23 }] : [] }),
      create: async (input: { draft: boolean; head: string }) => {
        assert.equal(input.draft, true);
        assert.equal(input.head, 'issue/17');
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

describe('directory-independent exact-PR contract', () => {
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
