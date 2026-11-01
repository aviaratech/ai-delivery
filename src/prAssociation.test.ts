import { syntheticDiscoveryClients, syntheticDiscoveryConfig } from './fixtures/discovery.js';
import { issueProjectItemsResponse } from './fixtures/issueProjectItems.js';
import { quietReadViewResponse } from './fixtures/readView.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as settings from './config/deliveryConfig.js';
import * as github from './github/client.js';
import { digestValue } from './delivery/common.js';
import { DeliveryError, setMachineRequestDiagnostics } from './errors.js';
import { executeTool } from './dispatch.js';
import * as issues from './issue.js';
import type { DeliveryContext } from './issue.js';
import { createAiDeliveryMcpServer } from './mcp/index.js';
import { preflightReviewRoute, prInfo, publishPr, startIssueBranch, submitFormalReview } from './pr.js';

const repo = 'example/widget';
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const tree = 'c'.repeat(40);
const pageInfo = { hasNextPage: false, endCursor: null };
const nonClosingCreation = {
  issueNumber: 17,
  nonClosing: true,
  body: `References ${repo}#17\n\nImprove widget.`,
};

function fixture(published = true, nonClosing = false) {
  const state = {
    published,
    nonClosing,
    body: nonClosing ? `References ${repo}#17\n\nImprove widget.` : 'Closes #17',
    title: 'Improve widget',
    issueBody: 'Four retained criteria',
    issueState: 'open',
    referenceReadback: undefined as unknown,
    referencePages: [] as unknown[],
    referencePageIndex: 0,
    commitReadback: undefined as unknown,
    comparisonReadback: undefined as unknown,
    commitMessage: 'Improve widget',
    referenceActor: 'author',
    referenceCloses: false as unknown,
    updates: 0,
    failCreateAck: false,
    failUpdateAck: false,
    linked: false,
    remoteHead: published ? head : base,
    headSha: head,
    headRef: 'issue/17',
    headRepo: repo,
    baseRepo: repo,
    baseSha: base,
    baseRef: 'main',
    remoteBase: { ref: 'refs/heads/main', object: { type: 'commit', sha: base } },
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
    closingOnCreate: false,
    manualClosing: false,
    manualReadback: undefined as unknown,
    manualPages: [] as unknown[],
    manualPageIndex: 0,
    removals: 0,
    failRemovalAck: false,
    removalReadback: undefined as unknown,
    keepClosingOnRemoval: false,
    removalHook: undefined as (() => void) | undefined,
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
    title: state.title,
    body: state.body,
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
    repos: {
      get: async () => ({ data: { node_id: 'REPO', full_name: repo, default_branch: 'main' } }),
      compareCommitsWithBasehead: async () => ({
        data: state.comparisonReadback ?? {
          base_commit: { sha: base },
          merge_base_commit: { sha: base },
          status: 'ahead',
          total_commits: 1,
          commits: [{ sha: head, commit: { message: state.commitMessage }, parents: [{ sha: base }] }],
        },
      }),
    },
    issues: {
      get: async () => ({
        data: {
          node_id: 'ISSUE17',
          number: 17,
          state: state.issueState,
          title: 'Improve widget',
          body: state.issueBody,
          html_url: `https://github.com/${repo}/issues/17`,
        },
      }),
    },
    git: {
      getRef: async (input: { owner: string; repo: string; ref: string }) => {
        assert.equal(`${input.owner}/${input.repo}`, repo);
        return {
          data:
            input.ref === 'heads/main'
              ? state.remoteBase
              : { ref: state.remoteRef, object: { type: state.remoteType, sha: state.remoteHead } },
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
      create: async (input: { draft: boolean; head: string; body: string }) => {
        assert.equal(input.draft, state.expectedCreationDraft);
        assert.equal(input.head, 'issue/17');
        state.creations++;
        state.body = input.body;
        if (state.closingOnCreate) {
          state.manualClosing = true;
          state.referenceCloses = true;
        }
        if (state.failCreateAck) {
          state.published = true;
          throw new Error('Transport lost after creation');
        }
        state.draft = input.draft;
        state.published = true;
        state.linked = false;
        state.events.push('draft-publication-replaces-branch-link');
        return { data: pr() };
      },
      update: async (input: { body: string }) => {
        state.updates++;
        state.body = input.body;
        state.nonClosing = input.body.startsWith('References ');
        if (state.failUpdateAck) throw new Error('Transport lost after body update');
        return { data: pr() };
      },
      listFiles: async () => ({ data: [{ filename: 'change.ts' }] }),
      listReviews: async () => ({ data: state.reviews }),
      getReview: async (input: { review_id: number }) => ({
        data: state.reviews.find((review) => review.id === input.review_id),
      }),
      createReview: async (input: { commit_id: string; body: string; event: string }) => {
        assert.equal(input.commit_id, head);
        assert.equal(input.event, 'APPROVE');
        state.submissions++;
        const review = {
          id: 98 + state.submissions,
          body: input.body,
          user: { login: state.reviewerActor },
          state: 'APPROVED',
          commit_id: head,
          html_url: `https://github.com/${repo}/pull/23#pullrequestreview-${98 + state.submissions}`,
        };
        state.reviews.push(review);
        return { data: review };
      },
    },
  };
  const graphql = async (query: string, variables: Record<string, unknown> = {}) => {
    if (query.includes('DeliveryRemoveClosingReference')) {
      assert.deepEqual(variables.issueId, 'ISSUE17');
      assert.deepEqual(variables.pullRequestIds, ['PR23']);
      assert.equal(typeof variables.clientMutationId, 'string');
      state.removals++;
      state.events.push('remove-exact-closing-pair');
      if (!state.keepClosingOnRemoval) {
        state.manualClosing = false;
        state.referenceCloses = false;
      }
      state.removalHook?.();
      if (state.failRemovalAck) throw new Error('Lost reference-removal acknowledgement');
      return state.removalReadback ?? { removeCloseIssueReferences: { issue: { id: 'ISSUE17' } } };
    }
    if (query.includes('DeliveryNonClosingReferences')) {
      if (state.referencePages.length) return state.referencePages[state.referencePageIndex++];
      return (
        state.referenceReadback ?? {
          repository: {
            id: 'REPO',
            nameWithOwner: repo,
            issue: {
              id: 'ISSUE17',
              number: 17,
              state: 'OPEN',
              timelineItems: {
                nodes: [
                  {
                    id: 'REFERENCE',
                    actor: { login: state.referenceActor },
                    isCrossRepository: false,
                    willCloseTarget: state.referenceCloses,
                    source: {
                      __typename: 'PullRequest',
                      id: 'PR23',
                      number: 23,
                      repository: { id: 'REPO', nameWithOwner: repo },
                    },
                    target: {
                      __typename: 'Issue',
                      id: 'ISSUE17',
                      number: 17,
                      repository: { id: 'REPO', nameWithOwner: repo },
                    },
                  },
                ],
                pageInfo,
              },
            },
          },
        }
      );
    }
    if (query.includes('DeliveryNonClosingCommits'))
      return (
        state.commitReadback ?? {
          repository: {
            nameWithOwner: repo,
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
                      message: state.commitMessage,
                      parents: { totalCount: 1, nodes: [{ oid: base }], pageInfo },
                    },
                  },
                ],
                pageInfo,
              },
            },
          },
        }
      );
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
    const manual = query.includes('userLinkedOnly');
    if (query.includes('DeliveryClosingIssues') && manual && state.manualPages.length > 0)
      return state.manualPages[state.manualPageIndex++ % state.manualPages.length];
    if (query.includes('DeliveryClosingIssues') && manual && state.manualReadback !== undefined)
      return state.manualReadback;
    if (query.includes('DeliveryClosingIssues') && !manual && state.closingPages.length > 0)
      return state.closingPages[state.closingPageIndex++];
    if (query.includes('DeliveryClosingIssues'))
      return (
        (manual ? undefined : state.closingReadback) ?? {
          repository: {
            nameWithOwner: state.associationRepo,
            pullRequest: {
              id: state.nodeId,
              number: state.associationPr,
              closingIssuesReferences: {
                nodes: (manual ? !state.manualClosing : state.nonClosing && !state.manualClosing)
                  ? []
                  : [
                      {
                        __typename: 'Issue',
                        id: 'ISSUE17',
                        number: state.issueNumber,
                        repository: { id: 'REPO', nameWithOwner: repo },
                      },
                    ],
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
    if (query.includes('ProjectDeliveryIssueItems')) return issueProjectItemsResponse(variables, []);
    if (query.includes('ProjectDeliveryConfiguration')) return syntheticDiscoveryClients().graphql(query, variables);
    const quiet = quietReadViewResponse(query, variables);
    if (quiet !== undefined) return quiet;
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
      native: syntheticDiscoveryConfig.native,
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

it('publishes a pushed canonical branch without native creation and preserves the open issue', async () => {
  const { context, state } = fixture(false, true);
  state.remoteHead = head;
  await publishPr(context, nonClosingCreation);
  assert.equal(state.creations, 1);
  assert.equal(state.issueState, 'open');
  state.issueState = 'closed';
  await assert.rejects(issues.issueBranch(context, 17), /open|OPEN/u);
  await assert.rejects(issues.issueBranch(context, 17, 'issue/18'), /Branch issue\/18 is not linked/u);
});

it('accepts a hyphenated close mention while refusing an actual closing directive', async () => {
  const { context, state } = fixture(true, true);
  state.title = 'absent-close (#3777)';
  await publishPr(context, { issueNumber: 17, nonClosing: true, prNumber: 23, draft: false });
  state.title = 'closes #3777';
  await assert.rejects(
    publishPr(context, { issueNumber: 17, nonClosing: true, prNumber: 23, draft: false }),
    /closing directives/u,
  );
});

describe('remote closing PR creation', () => {
  it('replays a plain-git head from a temporary non-git directory through the public tool', async () => {
    const { context, state } = fixture(false);
    state.remoteHead = head;
    state.issueBody =
      '## Outcome\n\nWidgets improve.\n\n## Acceptance criteria\n\n- [ ] Reject invalid widgets.\n  Verified by: A synthetic widget test.';
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'delivery-pr-open-')));
    vi.spyOn(settings, 'loadDeliverySettings').mockResolvedValue(
      context.config as unknown as Awaited<ReturnType<typeof settings.loadDeliverySettings>>,
    );
    vi.spyOn(issues, 'loadDeliveryContext').mockImplementation(async (input) => {
      assert.equal(input.repository, repo);
      assert.equal(input.repoRoot, root);
      return { ...context, root };
    });
    const branchLinks = vi
      .spyOn(issues, 'linkedIssueBranches')
      .mockRejectedValue(new Error('No ai-delivery branch lifecycle'));
    try {
      const result = await executeTool(
        'issue_pr_create',
        { repo, issueNumber: 17, head: 'issue/17', base: 'main' },
        { repoRoot: root },
      );
      assert.equal(state.creations, 1);
      assert.equal(branchLinks.mock.calls.length, 0);
      assert.equal(
        state.body,
        'Closes #17\n\n## Outcome\n\nWidgets improve.\n\n## Acceptance criteria\n\n- [ ] Reject invalid widgets.\n  Verified by: A synthetic widget test.\n\n<!-- ai-delivery:pr@1 -->',
      );
      assert.deepEqual(result, {
        prNumber: 23,
        url: 'https://github.com/example/widget/pull/23',
        headSha: head,
        state: 'draft',
      });
      expect(JSON.stringify(result)).toMatchInlineSnapshot(
        '"{"prNumber":23,"url":"https://github.com/example/widget/pull/23","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","state":"draft"}"',
      );
      assert.ok(JSON.stringify(result).length < 1000);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it('reuses an open PR for an unlinked remote head without changing its body', async () => {
    const { context, state } = fixture();
    state.body = 'Closes #17\n\nRetain the author explanation.';
    const result = await publishPr(context, { issueNumber: 17, headBranch: 'issue/17' });
    assert.equal(result.prNumber, 23);
    assert.equal(state.creations + state.updates, 0);
    assert.equal(state.body, 'Closes #17\n\nRetain the author explanation.');
  });

  it('restores a lost closing link once and reports the repair without replacing user content', async () => {
    const { context, state } = fixture();
    state.body = 'Retain the author explanation.';
    state.nonClosing = true;
    const input = { issueNumber: 17, headBranch: 'issue/17' };
    assert.deepEqual(await publishPr(context, input), {
      prNumber: 23,
      url: 'https://github.com/example/widget/pull/23',
      headSha: head,
      state: 'draft',
      closingLinkAdded: true,
    });
    assert.equal(state.body, 'Closes #17\n\nRetain the author explanation.');
    await publishPr(context, input);
    assert.equal(state.creations, 0);
    assert.equal(state.updates, 1);
  });

  it('previews a closing-link repair without a mutation', async () => {
    const { context, state } = fixture();
    state.body = 'Retain explanation';
    state.nonClosing = true;
    await publishPr(context, { issueNumber: 17, headBranch: 'issue/17', dryRun: true });
    assert.equal(state.updates + state.creations, 0);
  });

  it('refuses a conflicting association without rewriting the existing body', async () => {
    const { context, state } = fixture();
    state.body = 'Closes #18';
    state.issueNumber = 18;
    await assert.rejects(publishPr(context, { issueNumber: 17, headBranch: 'issue/17' }), /conflicting/u);
    assert.equal(state.updates + state.creations, 0);
  });

  it('refuses body drift during the final association read before repair', async () => {
    const { context, state } = fixture();
    state.body = 'Retain explanation';
    state.nonClosing = true;
    const graphql = context.clients.graphql;
    let associationReads = 0;
    vi.spyOn(context.clients, 'graphql').mockImplementation(async (query, variables) => {
      const result = await graphql(query, variables);
      if (String(query).includes('DeliveryClosingIssues') && ++associationReads === 2)
        state.body = 'Concurrent author edit';
      return result;
    });
    await assert.rejects(publishPr(context, { issueNumber: 17, headBranch: 'issue/17' }), /drifted/u);
    assert.equal(state.updates, 0);
    assert.equal(state.body, 'Concurrent author edit');
  });

  it('reconciles a lost repair acknowledgement without repeating the applied update', async () => {
    const { context, state } = fixture();
    state.body = 'Retain explanation';
    state.nonClosing = true;
    state.failUpdateAck = true;
    const input = { issueNumber: 17, headBranch: 'issue/17' };
    await assert.rejects(publishPr(context, input), /repair acknowledgement is uncertain/u);
    state.failUpdateAck = false;
    await publishPr(context, input);
    assert.equal(state.creations, 0);
    assert.equal(state.updates, 1);
  });

  it('names the missing closing line and exact repair call before independent review', async () => {
    const { reviewerContext, state, artifact } = fixture();
    state.body = 'Lost closing link';
    state.nonClosing = true;
    await assert.rejects(
      submitFormalReview(reviewerContext, { issueNumber: 17, prNumber: 23, artifact }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Missing `Closes #17`/u);
        assert.ok(
          error.message.includes('issue_pr_create({"repo":"example/widget","issueNumber":17,"head":"issue/17"})'),
        );
        assert.doesNotMatch(error.message, /association does not identify/u);
        return true;
      },
    );
    assert.equal(state.submissions + state.updates, 0);
  });
});

function rulesetOnlyFixture(published = true) {
  const current = fixture(published, true);
  const evidence = {
    deniedRoute: '',
    protectionError: { status: 404, response: { status: 404, data: { message: 'Branch not protected' } } } as unknown,
    protection: undefined as unknown,
    rules: {
      status: 200,
      headers: {},
      data: [
        {
          type: 'required_status_checks',
          ruleset_id: 41,
          ruleset_source_type: 'Repository',
          ruleset_source: repo,
          parameters: {
            strict_required_status_checks_policy: true,
            required_status_checks: [{ context: 'local-verify' }],
          },
        },
        {
          type: 'pull_request',
          ruleset_id: 42,
          ruleset_source_type: 'Organization',
          ruleset_source: 'example',
          parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true },
        },
      ],
    } as unknown,
    rulesets: {
      status: 200,
      headers: {},
      data: [
        { id: 41, source_type: 'Repository', source: repo, enforcement: 'active' },
        { id: 42, source_type: 'Organization', source: 'example', enforcement: 'active' },
      ],
    } as unknown,
    branch: { status: 200, data: { name: 'main', protected: true, protection: { enabled: true } } } as unknown,
    repository: { status: 200, data: { full_name: repo, permissions: { push: true } } } as unknown,
  };
  current.context.clients.rest.request = (async (route: string, input: Record<string, unknown>) => {
    assert.equal(input.owner, 'example');
    assert.equal(input.repo, 'widget');
    if (route === evidence.deniedRoute) throw { status: 403 };
    if (route.endsWith('/protection')) {
      if (evidence.protection !== undefined) return evidence.protection;
      throw evidence.protectionError;
    }
    if (route.endsWith('/rules/branches/{branch}')) return evidence.rules;
    if (route.endsWith('/rulesets')) {
      assert.equal(input.includes_parents, true);
      assert.equal(input.page, 1);
      assert.equal(input.per_page, 100);
      return evidence.rulesets;
    }
    if (route.endsWith('/branches/{branch}')) {
      assert.equal(input.branch, 'main');
      return evidence.branch;
    }
    if (route === 'GET /repos/{owner}/{repo}') return evidence.repository;
    throw new Error(`Unexpected fictional route ${route}`);
  }) as typeof current.context.clients.rest.request;
  return { ...current, evidence };
}

async function machineRulesetOnlyFixture(published = true) {
  const current = rulesetOnlyFixture(published);
  const { context, evidence } = current;
  const rest = context.clients.rest;
  const graphql = context.clients.graphql;
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-machine-protection-')));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const token = 'fictional_machine_protection_token';
  writeFileSync(
    join(bin, 'gh'),
    `#!${process.execPath}
const args=process.argv.slice(2);
if(JSON.stringify(args)===JSON.stringify(['auth','status','--hostname','github.com','--active','--json','hosts']))
 process.stdout.write(JSON.stringify({hosts:{'github.com':[{host:'github.com',active:true,state:'success',login:'author'}]}}));
else if(JSON.stringify(args)===JSON.stringify(['auth','token','--hostname','github.com','--user','author']))
 process.stdout.write(${JSON.stringify(token)}+'\\n');
else process.exit(91);
`,
    { mode: 0o755 },
  );
  const originalEnv = process.env;
  const restore = () => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    rmSync(home, { recursive: true });
  };
  process.env = { HOME: home, PATH: bin };
  context.config.roles.author = {
    authSource: 'personal',
    identity: context.config.roles.author.identity,
    credentialEnv: { token: 'GH_TOKEN' },
  };
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, 'https://api.github.com');
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    const body = (typeof init?.body === 'string' ? JSON.parse(init.body) : {}) as {
      query?: unknown;
      draft?: unknown;
      head?: unknown;
      body?: unknown;
    };
    let result: { status?: number; headers?: Record<string, string | number | undefined>; data: unknown };
    if (path === '/user') result = { data: { id: 42, login: 'author', type: 'User' } };
    else if (path === '/graphql') {
      assert.ok(typeof body.query === 'string');
      result = { data: { data: await graphql(body.query) } };
    } else {
      const prefix = '/repos/example/widget';
      assert.ok(path.startsWith(prefix));
      const suffix = path.slice(prefix.length);
      if (suffix === '') {
        const native = await rest.repos.get({ owner: 'example', repo: 'widget' });
        const visible = evidence.repository as { status: number; data: Record<string, unknown> };
        result = { status: visible.status, data: { ...native.data, ...visible.data } };
      } else if (suffix === '/branches/main/protection') {
        if (evidence.protection !== undefined) result = evidence.protection as typeof result;
        else {
          const error = evidence.protectionError as { status: number; response: { data: object } };
          result = {
            status: error.status,
            data: { ...error.response.data, private: token },
            headers: { 'x-private': token },
          };
        }
      } else if (suffix === '/rules/branches/main') result = evidence.rules as typeof result;
      else if (suffix === '/branches/main') result = evidence.branch as typeof result;
      else if (suffix === '/rulesets') {
        assert.equal(url.searchParams.get('includes_parents'), 'true');
        assert.equal(url.searchParams.get('per_page'), '100');
        assert.equal(url.searchParams.get('page'), '1');
        result = evidence.rulesets as typeof result;
      } else if (suffix === '/issues/17')
        result = await rest.issues.get({ owner: 'example', repo: 'widget', issue_number: 17 });
      else if (suffix.startsWith('/git/ref/'))
        result = await rest.git.getRef({
          owner: 'example',
          repo: 'widget',
          ref: decodeURIComponent(suffix.slice('/git/ref/'.length)),
        });
      else if (suffix.startsWith('/git/commits/'))
        result = await rest.git.getCommit({ owner: 'example', repo: 'widget', commit_sha: head });
      else if (suffix.startsWith('/compare/'))
        result = await rest.repos.compareCommitsWithBasehead({
          owner: 'example',
          repo: 'widget',
          basehead: `${base}...${head}`,
        });
      else if (suffix === '/pulls' && method === 'POST') {
        assert.ok(typeof body.draft === 'boolean' && typeof body.head === 'string' && typeof body.body === 'string');
        result = await rest.pulls.create({
          owner: 'example',
          repo: 'widget',
          title: 'Improve widget',
          base: 'main',
          draft: body.draft,
          head: body.head,
          body: body.body,
        });
      } else if (suffix === '/pulls') result = await rest.pulls.list({ owner: 'example', repo: 'widget' });
      else if (suffix === '/pulls/23')
        result = await rest.pulls.get({ owner: 'example', repo: 'widget', pull_number: 23 });
      else if (suffix === '/pulls/23/files')
        result = await rest.pulls.listFiles({ owner: 'example', repo: 'widget', pull_number: 23 });
      else if (suffix === '/pulls/23/reviews')
        result = await rest.pulls.listReviews({ owner: 'example', repo: 'widget', pull_number: 23 });
      else throw new Error(`Unexpected fictional machine route ${method} ${suffix}`);
      if (evidence.deniedRoute && suffix === evidence.deniedRoute) result = { status: 403, data: { message: token } };
    }
    const response = new Response(JSON.stringify(result.data), {
      status: result.status ?? 200,
      headers: {
        'content-type': 'application/json',
        ...Object.fromEntries(
          Object.entries(result.headers ?? {}).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        ),
      },
    });
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  });
  try {
    context.clients = await github.createDeliveryGitHubClients({
      config: context.config,
      role: 'author',
      identity: 'author',
      env: process.env,
    });
    github.retainMachineAuthorForConfiguration(context.config, context.clients);
    return { ...current, restore, token };
  } catch (error) {
    restore();
    throw error;
  }
}

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
    it(`accepts ${name} when the native PR closing association and head are current`, async () => {
      const { reviewerContext, state, artifact } = fixture();
      state.branchReadback = response;
      await submitFormalReview(reviewerContext, { issueNumber: 17, prNumber: 23, artifact });
      assert.equal(state.submissions, 1);
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

  it('submits a fresh valid artifact despite an older remapped App review', async () => {
    const { reviewerContext, state, artifact } = fixture();
    await submitFormalReview(reviewerContext, { issueNumber: 17, prNumber: 23, artifact });
    state.reviews[0]!.body = `<!-- ai-delivery-review-artifact: sha256:${'f'.repeat(64)} -->`;
    await submitFormalReview(reviewerContext, { issueNumber: 17, prNumber: 23, artifact });
    assert.equal(state.submissions, 2);
  });
});

describe('authoritative existing PR promotion', () => {
  const input = { issueNumber: 17, headBranch: 'issue/17', draft: false };

  it('promotes after publication and exact-head review, then reuses authoritative ready readback', async () => {
    const { context, reviewerContext, state, artifact } = fixture();
    await submitFormalReview(reviewerContext, { issueNumber: 17, prNumber: 23, artifact });
    const preview = await publishPr(context, { ...input, dryRun: true });
    assert.equal(preview.prNumber, 23);
    assert.ok('dryRun' in preview);
    assert.equal(preview.draft, true);
    assert.equal(state.promotions, 0);
    const promoted = await publishPr(context, input);
    const reused = await publishPr(context, input);
    assert.equal(promoted.prNumber, 23);
    assert.ok('state' in promoted);
    assert.equal(promoted.state, 'open');
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

  it('requires an explicit head after branch links disappear and preserves draft on reuse', async () => {
    const { context, state } = fixture();
    await assert.rejects(publishPr(context, { issueNumber: 17, draft: false }), /linked/u);
    await publishPr(context, { ...input, draft: true });
    assert.equal(state.promotions, 0);
  });

  it('creates a ready PR directly from a pushed remote head without native branch setup', async () => {
    const { context, state } = fixture(false);
    state.remoteHead = head;
    state.expectedCreationDraft = false;
    const created = await publishPr(context, input);
    assert.ok('state' in created);
    assert.equal(created.state, 'open');
    assert.equal(state.creations, 1);
    assert.equal(state.promotions, 0);
    assert.equal(state.events.includes('native-start'), false);
  });

  it('keeps incomplete native branch readback behind the unchanged start gate', async () => {
    const { context, state } = fixture(false);
    state.branchReadback = { repository: null };
    await assert.rejects(startIssueBranch(context, 17), /Incomplete/u);
    assert.deepEqual(state.events, []);
  });

  it('retains the configured author role before promotion', async () => {
    const { reviewerContext, state } = fixture();
    await assert.rejects(publishPr(reviewerContext, input), /author/u);
    assert.equal(state.promotions, 0);
  });
});

describe('canonical publication footer and exact-body recovery', () => {
  const footer = '\n\n<!-- ai-delivery:pr@1 -->';
  const substantive = 'Original intent.\r\nKeep trailing spaces.  \n\n';

  for (const ready of [false, true]) {
    it(`marks new closing publication once and reuses original unmarked input (${ready ? 'ready' : 'draft'})`, async () => {
      const { context, state } = fixture(false);
      state.linked = true;
      state.remoteHead = head;
      state.expectedCreationDraft = !ready;
      const input = { issueNumber: 17, headBranch: 'issue/17', body: substantive, draft: !ready };
      const expected = `Closes #17\n\n${substantive}${footer}`;
      const preview = await publishPr(context, { ...input, dryRun: true });
      assert.equal(Reflect.get(preview, 'body'), expected);
      assert.equal(state.creations + state.updates + state.promotions, 0);
      await publishPr(context, input);
      assert.equal(state.body, expected);
      await publishPr(context, input);
      await publishPr(context, { ...input, draft: false });
      await publishPr(context, { ...input, body: expected, draft: false });
      assert.equal(state.body, expected);
      assert.equal(state.creations, 1);
      assert.equal(state.updates, 0);
      assert.equal(state.promotions, ready ? 0 : 1);
    });
  }

  it('marks admitted non-closing creation and continues with original unmarked intent', async () => {
    const { context, state } = fixture(false, true);
    state.linked = true;
    state.remoteHead = head;
    const input = { ...nonClosingCreation, body: `References ${repo}#17\n\n${substantive}` };
    const preview = await publishPr(context, { ...input, dryRun: true });
    assert.equal(Reflect.get(preview, 'body'), input.body + footer);
    await publishPr(context, input);
    await publishPr(context, { ...input, prNumber: 23 });
    await publishPr(context, { issueNumber: 17, prNumber: 23, nonClosing: true, body: input.body, draft: false });
    assert.equal(state.body, input.body + footer);
    assert.equal(state.creations, 1);
    assert.equal(state.updates, 0);
    assert.equal(state.promotions, 1);
    assert.equal(state.issueState, 'open');
  });

  for (const nonClosing of [false, true]) {
    it(`reconciles lost creation acknowledgement with original body without another mutation (${nonClosing})`, async () => {
      const { context, state } = fixture(false, nonClosing);
      state.linked = true;
      state.remoteHead = head;
      state.failCreateAck = true;
      const input = nonClosing ? nonClosingCreation : { issueNumber: 17, body: substantive };
      await assert.rejects(publishPr(context, input), /acknowledgement is uncertain/u);
      const expected = nonClosing ? nonClosingCreation.body : `Closes #17\n\n${substantive}`;
      assert.equal(state.body, expected + footer);
      state.failCreateAck = false;
      await publishPr(context, { ...input, prNumber: 23 });
      assert.equal(state.creations, 1);
      assert.equal(state.updates, 0);
      assert.equal(state.body, expected + footer);
    });

    it(`does not backfill a historical unmarked PR or permit a marker-only transition (${nonClosing})`, async () => {
      const { context, state } = fixture(true, nonClosing);
      const original = state.body;
      const input = { issueNumber: 17, prNumber: 23, nonClosing, body: original };
      await publishPr(context, input);
      assert.equal(state.body, original);
      await assert.rejects(publishPr(context, { ...input, body: original + footer }), /marker|footer|conflict/iu);
      assert.equal(state.body, original);
      assert.equal(state.creations + state.updates + state.promotions, 0);
    });
  }

  for (const malformed of [
    'Closes #17\n\n<!-- ai-delivery:pr@2 -->',
    `Closes #17${footer}\n`,
    `Closes #17${footer}${footer}`,
    `Closes #17${footer}\n\nLater text.`,
    `Closes #17\n\n<div>\n${footer}\n</div>`,
  ]) {
    for (const published of [false, true]) {
      it(`refuses malformed or ambiguous publication markers without repair (${published}, ${JSON.stringify(malformed)})`, async () => {
        const { context, state } = fixture(published);
        state.linked = true;
        state.remoteHead = head;
        if (published) state.body = malformed;
        await assert.rejects(publishPr(context, { issueNumber: 17, body: malformed }), /marker|footer|conflict/iu);
        assert.equal(state.creations + state.updates + state.promotions, 0);
      });
    }
  }

  it('preserves quoted marker examples and substantive bytes while adding one active footer', async () => {
    const { context, state } = fixture(false);
    state.linked = true;
    state.remoteHead = head;
    const body = 'Closes #17\n\nExample:\n\n```md\n<!-- ai-delivery:pr@1 -->\n```\n\nText.  \r\n';
    await publishPr(context, { issueNumber: 17, body });
    await publishPr(context, { issueNumber: 17, prNumber: 23, body });
    assert.equal(state.body, body + footer);
    assert.equal(state.creations, 1);
    assert.equal(state.updates, 0);
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
      assert.equal(info.isError, undefined, JSON.stringify(info.content));
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

  it(
    'documents explicit issue/PR selection in actual CLI help without credentials or a checkout',
    { tags: ['release'] },
    () => {
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
        assert.match(creationHelp, /Create or reuse an issue-closing PR from a pushed --head, from any directory/u);
        assert.match(creationHelp, /--base <branch>/u);
        assert.match(creationHelp, /Pushed remote head/u);
        assert.match(creationHelp, /--pr <number>/u);
        assert.match(creationHelp, /--expected-head <sha>/u);
        for (const command of ['pr:create', 'pr:info', 'pr:review']) {
          const modeHelp = execFileSync(process.execPath, [resolve('dist/cli.js'), command, '--help'], {
            cwd: root,
            env: { HOME: root, PATH: process.env.PATH },
            encoding: 'utf8',
          });
          assert.match(modeHelp, /--non-closing/u);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe('explicit native non-closing reference delivery', () => {
  const input = { issueNumber: 17, prNumber: 23, nonClosing: true };

  it.each(['ruleset-only', 'ruleset-only with disabled protection summary', 'confirmed-unprotected'])(
    'creates and reviews %s protection through the real machine client and sanitizer',
    async (mode) => {
      const { context, reviewerContext, state, artifact, evidence, restore, token } =
        await machineRulesetOnlyFixture(false);
      try {
        if (mode === 'ruleset-only with disabled protection summary')
          evidence.branch = { status: 200, data: { name: 'main', protected: true, protection: { enabled: false } } };
        if (mode === 'confirmed-unprotected') {
          evidence.rules = { status: 200, headers: {}, data: [] };
          evidence.rulesets = { status: 200, headers: {}, data: [] };
          evidence.branch = { status: 200, data: { name: 'main', protected: false, protection: { enabled: false } } };
        }
        await startIssueBranch(context, 17);
        state.remoteHead = head;
        const preview = await publishPr(context, { ...nonClosingCreation, dryRun: true });
        assert.equal(state.creations, 0);
        const created = await publishPr(context, nonClosingCreation);
        assert.equal(state.creations, 1);
        const route = await preflightReviewRoute(context, 'main');
        assert.equal(route.rules.visibility, 'complete');
        assert.equal(route.rules.observedRequiredApprovals, mode === 'confirmed-unprotected' ? 0 : 1);
        const reviewPreview = await submitFormalReview(reviewerContext, { ...input, artifact, dryRun: true });
        assert.equal(state.submissions, 0);
        const reviewed = await submitFormalReview(reviewerContext, { ...input, artifact });
        assert.equal(state.submissions, 1);
        assert.equal(state.reviews[0]?.commit_id, head);
        assert.equal(state.reviews[0]?.user.login, 'reviewer[bot]');
        assert.equal(state.issueState, 'open');
        assert.equal(state.issueBody, 'Four retained criteria');
        assert.equal(state.updates, 0);
        assert.equal(JSON.stringify([preview, created, reviewPreview, reviewed]).includes(token), false);
      } finally {
        restore();
      }
    },
  );

  for (const [name, change] of [
    ['generic protection 404', { protectionError: { status: 404, response: { data: { message: 'Not Found' } } } }],
    [
      'denied protection',
      { protectionError: { status: 403, response: { data: { message: 'Branch not protected' } } } },
    ],
    ['denied applicable rules', { deniedRoute: '/rules/branches/main' }],
    [
      'denied repository',
      { deniedRoute: '', repository: { status: 403, data: { full_name: repo, permissions: { push: true } } } },
    ],
    ['denied parent rulesets', { deniedRoute: '/rulesets' }],
    [
      'incomplete rules',
      { rules: { status: 200, headers: { link: '<https://api.github.com/next>; rel="next"' }, data: [] } },
    ],
  ] as const) {
    it(`refuses ${name} through real machine sanitization before publication or review`, async () => {
      const { context, reviewerContext, state, artifact, evidence, restore, token } =
        await machineRulesetOnlyFixture(false);
      try {
        evidence.branch = { status: 200, data: { name: 'main', protected: true, protection: { enabled: false } } };
        await startIssueBranch(context, 17);
        state.remoteHead = head;
        Object.assign(evidence, change);
        for (const operation of [
          () => publishPr(context, nonClosingCreation),
          () => {
            state.published = true;
            return submitFormalReview(reviewerContext, { ...input, artifact });
          },
        ])
          await assert.rejects(operation(), (error: unknown) => {
            assert.ok(error instanceof DeliveryError);
            assert.equal(JSON.stringify(error).includes(token), false);
            return true;
          });
        assert.equal(state.creations, 0);
        assert.equal(state.submissions, 0);
        assert.equal(state.updates, 0);
      } finally {
        restore();
      }
    });
  }

  it.each([true, false])(
    'creates and independently reviews a non-closing PR with corroborated rulesets and protection summary %s',
    async (enabled) => {
      const { context, reviewerContext, state, artifact, evidence } = rulesetOnlyFixture(false);
      evidence.branch = { status: 200, data: { name: 'main', protected: true, protection: { enabled } } };
      vi.spyOn(github, 'createDeliveryGitHubClients').mockResolvedValue(context.clients);
      await startIssueBranch(context, 17);
      state.remoteHead = head;
      const preview = await publishPr(context, { ...nonClosingCreation, dryRun: true });
      assert.equal(preview.nonClosing, true);
      assert.equal(state.creations, 0);
      await publishPr(context, nonClosingCreation);
      assert.equal(state.creations, 1);
      assert.equal(state.issueState, 'open');
      assert.equal(state.issueBody, 'Four retained criteria');
      await submitFormalReview(reviewerContext, { ...input, artifact, dryRun: true });
      assert.equal(state.submissions, 0);
      await submitFormalReview(reviewerContext, { ...input, artifact });
      assert.equal(state.submissions, 1);
      assert.equal(state.reviews[0]?.commit_id, head);
      assert.equal(state.reviews[0]?.user.login, 'reviewer[bot]');
      assert.equal(state.updates, 0);
    },
  );

  for (const [name, change] of [
    ['generic 404', { protectionError: { status: 404, response: { status: 404, data: { message: 'Not Found' } } } }],
    [
      'permission 404',
      { protectionError: { status: 404, response: { status: 403, data: { message: 'Branch not protected' } } } },
    ],
    ['denied protection', { deniedRoute: 'GET /repos/{owner}/{repo}/branches/{branch}/protection' }],
    ['denied applicable rules', { deniedRoute: 'GET /repos/{owner}/{repo}/rules/branches/{branch}' }],
    ['denied repository', { deniedRoute: 'GET /repos/{owner}/{repo}' }],
    ['denied branch', { deniedRoute: 'GET /repos/{owner}/{repo}/branches/{branch}' }],
    ['denied parent rulesets', { deniedRoute: 'GET /repos/{owner}/{repo}/rulesets' }],
    [
      'foreign repository',
      { repository: { status: 200, data: { full_name: 'other/widget', permissions: { push: true } } } },
    ],
    ['unknown author write access', { repository: { status: 200, data: { full_name: repo, permissions: {} } } }],
    [
      'foreign branch',
      { branch: { status: 200, data: { name: 'other', protected: true, protection: { enabled: true } } } },
    ],
    [
      'conflicting branch protection',
      { branch: { status: 200, data: { name: 'main', protected: false, protection: { enabled: true } } } },
    ],
    [
      'unprotected branch with active rulesets',
      { branch: { status: 200, data: { name: 'main', protected: false, protection: { enabled: false } } } },
    ],
    ['missing protected branch summary', { branch: { status: 200, data: { name: 'main', protected: true } } }],
    ['missing enabled summary', { branch: { status: 200, data: { name: 'main', protected: true, protection: {} } } }],
    [
      'null enabled summary',
      { branch: { status: 200, data: { name: 'main', protected: true, protection: { enabled: null } } } },
    ],
    [
      'string enabled summary',
      { branch: { status: 200, data: { name: 'main', protected: true, protection: { enabled: 'false' } } } },
    ],
    [
      'numeric enabled summary',
      { branch: { status: 200, data: { name: 'main', protected: true, protection: { enabled: 0 } } } },
    ],
    ['missing ruleset page headers', { rulesets: { status: 200, data: [] } }],
    [
      'incomplete parent ruleset page',
      { rulesets: { status: 200, headers: { link: '<https://api.github.com/next>; rel="next"' }, data: [] } },
    ],
    ['malformed parent rulesets', { rulesets: { status: 200, headers: {}, data: null } }],
    ['uncorroborated rulesets', { rulesets: { status: 200, headers: {}, data: [] } }],
    [
      'inactive applicable ruleset',
      {
        rulesets: {
          status: 200,
          headers: {},
          data: [
            { id: 41, source_type: 'Repository', source: repo, enforcement: 'evaluate' },
            { id: 42, source_type: 'Organization', source: 'example', enforcement: 'active' },
          ],
        },
      },
    ],
    [
      'conflicting source identity',
      {
        rulesets: {
          status: 200,
          headers: {},
          data: [
            { id: 41, source_type: 'Repository', source: 'other/widget', enforcement: 'active' },
            { id: 42, source_type: 'Organization', source: 'example', enforcement: 'active' },
          ],
        },
      },
    ],
  ] as const) {
    it(`refuses non-closing creation and review with ruleset-only ${name} without mutation`, async () => {
      const { context, reviewerContext, state, artifact, evidence } = rulesetOnlyFixture(false);
      vi.spyOn(github, 'createDeliveryGitHubClients').mockResolvedValue(context.clients);
      Object.assign(evidence, change);
      await startIssueBranch(context, 17);
      state.remoteHead = head;
      await assert.rejects(publishPr(context, nonClosingCreation), /complete native rule visibility/u);
      assert.equal(state.creations, 0);
      state.published = true;
      await assert.rejects(
        submitFormalReview(reviewerContext, { ...input, artifact }),
        /complete native rule visibility/u,
      );
      assert.equal(state.submissions, 0);
      assert.equal(state.promotions, 0);
      assert.equal(state.updates, 0);
      assert.equal(state.issueState, 'open');
    });
  }

  it('keeps reviewer permission, distinct-actor and exact-head guards with complete ruleset-only protection', async () => {
    const { context, reviewerContext, state, artifact } = rulesetOnlyFixture();
    vi.spyOn(github, 'createDeliveryGitHubClients').mockResolvedValue(context.clients);
    context.reviewerClients!.effectiveContentsPermission = 'read';
    await assert.rejects(
      submitFormalReview(reviewerContext, { ...input, artifact }),
      /complete native rule visibility/u,
    );
    context.reviewerClients!.effectiveContentsPermission = 'write';
    state.reviewerActor = 'author';
    await assert.rejects(submitFormalReview(reviewerContext, { ...input, artifact }), /differ|same GitHub actor/u);
    state.reviewerActor = 'reviewer[bot]';
    state.headSha = 'd'.repeat(40);
    await assert.rejects(submitFormalReview(reviewerContext, { ...input, artifact }), /head|artifact/u);
    assert.equal(state.submissions, 0);
    assert.equal(state.creations, 0);
    assert.equal(state.updates, 0);
  });

  it('does not treat a sanitized machine-session 404 as proof of absent classic protection', async () => {
    const { context, reviewerContext, state, artifact, evidence } = rulesetOnlyFixture();
    vi.spyOn(github, 'createDeliveryGitHubClients').mockResolvedValue(context.clients);
    const error = Object.assign(new DeliveryError('Machine GitHub session cannot access the selected operation.'), {
      status: 404,
    });
    setMachineRequestDiagnostics(error, {
      phase: 'rest.request',
      endpoint: 'UNKNOWN',
      status: 404,
      code: undefined,
      requestId: undefined,
    });
    evidence.protectionError = error;
    await assert.rejects(publishPr(context, { ...input, draft: false }), /complete native rule visibility/u);
    await assert.rejects(
      submitFormalReview(reviewerContext, { ...input, artifact }),
      /complete native rule visibility/u,
    );
    assert.equal(state.promotions, 0);
    assert.equal(state.submissions, 0);
    assert.equal(state.updates, 0);
  });

  for (const name of [
    'incomplete applicable page',
    'incomplete parent page',
    'missing applicable headers',
    'non-success applicable response',
    'malformed applicable rules',
    'missing applicable ruleset identity',
    'malformed approval count',
    'duplicate corroborating ruleset',
    'protected branch with empty rules',
  ]) {
    it(`refuses ${name} despite observed ruleset-only protection without mutation`, async () => {
      const { context, reviewerContext, state, artifact, evidence } = rulesetOnlyFixture();
      vi.spyOn(github, 'createDeliveryGitHubClients').mockResolvedValue(context.clients);
      const rules = evidence.rules as { status: number; headers?: { link?: string }; data: unknown };
      const rulesets = evidence.rulesets as { headers: { link?: string }; data: unknown[] };
      switch (name) {
        case 'incomplete applicable page':
          rules.headers = { link: '<https://api.github.com/next>; rel="next"' };
          break;
        case 'incomplete parent page':
          rulesets.headers = { link: '<https://api.github.com/next>; rel="next"' };
          break;
        case 'missing applicable headers':
          delete rules.headers;
          break;
        case 'non-success applicable response':
          rules.status = 206;
          break;
        case 'malformed applicable rules':
          rules.data = [null];
          break;
        case 'missing applicable ruleset identity':
          rules.data = [{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }];
          break;
        case 'malformed approval count':
          rules.data = [
            {
              type: 'pull_request',
              ruleset_id: 42,
              ruleset_source_type: 'Organization',
              ruleset_source: 'example',
              parameters: { required_approving_review_count: '1' },
            },
          ];
          break;
        case 'duplicate corroborating ruleset':
          rulesets.data.push(rulesets.data[0]);
          break;
        case 'protected branch with empty rules':
          rules.data = [];
          rulesets.data = [];
          break;
      }
      await assert.rejects(publishPr(context, { ...input, draft: false }), /complete native rule visibility/u);
      await assert.rejects(
        submitFormalReview(reviewerContext, { ...input, artifact }),
        /complete native rule visibility/u,
      );
      assert.equal(state.creations, 0);
      assert.equal(state.submissions, 0);
      assert.equal(state.promotions, 0);
      assert.equal(state.updates, 0);
    });
  }

  it('preserves non-closing publication and exact-head review with readable classic protection', async () => {
    const { context, reviewerContext, state, artifact, evidence } = rulesetOnlyFixture();
    vi.spyOn(github, 'createDeliveryGitHubClients').mockResolvedValue(context.clients);
    evidence.protection = {
      status: 200,
      data: { required_pull_request_reviews: { required_approving_review_count: 2 } },
    };
    await publishPr(context, { ...input, draft: false });
    await submitFormalReview(reviewerContext, { ...input, artifact });
    assert.equal(state.promotions, 1);
    assert.equal(state.submissions, 1);
    assert.equal(state.reviews[0]?.commit_id, head);
    assert.equal(state.issueState, 'open');
  });

  it('submits confirmed-unprotected exact-head review while preserving distinct reviewer and stale-head guards', async () => {
    const { context, reviewerContext, state, artifact } = fixture(true, true);
    vi.spyOn(github, 'createDeliveryGitHubClients').mockResolvedValue(context.clients);
    let protectionMessage = 'Branch not protected';
    const request = async (route: string) => {
      if (route.endsWith('/protection'))
        throw { status: 404, response: { status: 404, data: { message: protectionMessage } } };
      if (route.endsWith('/rules/branches/{branch}') || route.endsWith('/rulesets'))
        return { status: 200, headers: {}, data: [] };
      if (route.endsWith('/branches/{branch}'))
        return { status: 200, data: { name: 'main', protected: false, protection: { enabled: false } } };
      if (route === 'GET /repos/{owner}/{repo}')
        return { status: 200, data: { full_name: repo, permissions: { push: true } } };
      throw new Error(`Unexpected fictional route ${route}`);
    };
    context.clients.rest.request = request as typeof context.clients.rest.request;
    await submitFormalReview(reviewerContext, { ...input, artifact, dryRun: true });
    assert.equal(state.submissions, 0);
    protectionMessage = 'Not Found';
    await assert.rejects(
      submitFormalReview(reviewerContext, { ...input, artifact }),
      /complete native rule visibility/u,
    );
    protectionMessage = 'Branch not protected';
    state.reviewerActor = 'author';
    await assert.rejects(submitFormalReview(reviewerContext, { ...input, artifact }), /differ|same GitHub actor/u);
    state.reviewerActor = 'reviewer[bot]';
    state.headSha = 'd'.repeat(40);
    await assert.rejects(submitFormalReview(reviewerContext, { ...input, artifact }), /head|artifact/u);
    state.headSha = head;
    await submitFormalReview(reviewerContext, { ...input, artifact });
    assert.equal(state.submissions, 1);
    assert.equal(state.reviews[0]?.commit_id, head);
  });

  it('accepts the exact native historical reference with empty branch/closing connections', async () => {
    const { context, state } = fixture(true, true);
    assert.equal((await prInfo(context, input)).headSha, head);
    const preview = await publishPr(context, { ...input, draft: false, dryRun: true });
    assert.equal(preview.prNumber, 23);
    assert.equal(preview.nonClosing, true);
    await publishPr(context, { ...input, draft: false });
    await publishPr(context, { ...input, draft: false });
    assert.equal(state.promotions, 1);
    assert.equal(state.updates, 0);
    assert.equal(state.creations, 0);
    assert.equal(state.issueState, 'open');
    assert.equal(state.issueBody, 'Four retained criteria');
  });

  it('transitions only an exact selected author PR, then reuses the verified body without another update', async () => {
    const { context, state } = fixture();
    const transition = { ...input, body: 'Deliver widget while retaining its issue.' };
    const preview = await publishPr(context, { ...transition, dryRun: true });
    assert.ok('bodyTransition' in preview);
    assert.equal(preview.bodyTransition, true);
    assert.equal(state.updates, 0);
    await publishPr(context, transition);
    await publishPr(context, transition);
    assert.equal(state.body, `References ${repo}#17\n\nDeliver widget while retaining its issue.`);
    assert.equal(state.updates, 1);
    assert.equal(state.creations, 0);
  });

  it('keeps new PR publication behind the exact pushed head and checks introduced messages first', async () => {
    const { context, state } = fixture(false, true);
    await assert.rejects(publishPr(context, { ...nonClosingCreation, expectedHeadSha: head }), /not expectedHeadSha/u);
    state.linked = true;
    state.remoteHead = head;
    state.commitMessage = 'Fixes: example/widget#99';
    await assert.rejects(publishPr(context, nonClosingCreation), /closing directives/u);
    assert.equal(state.creations, 0);
    state.commitMessage = 'Improve widget';
    await publishPr(context, nonClosingCreation);
    assert.equal(state.creations, 1);
    assert.equal(state.linked, false);
    assert.equal(state.issueState, 'open');
  });

  it('submits exact non-closing review after the default base advances and refuses invalid refs', async () => {
    const { context, reviewerContext, state, artifact } = fixture(true, true);
    vi.spyOn(github, 'createDeliveryGitHubClients').mockResolvedValue(context.clients);
    state.remoteBase.object.sha = 'd'.repeat(40);
    await submitFormalReview(reviewerContext, { ...input, artifact, dryRun: true });
    assert.equal(state.submissions, 0);
    await submitFormalReview(reviewerContext, { ...input, artifact });
    await submitFormalReview(reviewerContext, { ...input, artifact });
    assert.equal(state.submissions, 1);
    assert.equal(state.issueState, 'open');
    for (const ref of [
      { ref: '', object: { type: 'commit', sha: base } },
      { ref: 'refs/heads/other', object: { type: 'commit', sha: base } },
      { ref: 'refs/heads/main', object: { type: 'tag', sha: base } },
      { ref: 'refs/heads/main', object: { type: 'commit', sha: '' } },
      { ref: 'refs/heads/main', object: { type: 'commit', sha: 'not-a-sha' } },
    ]) {
      state.remoteBase = ref;
      await assert.rejects(submitFormalReview(reviewerContext, { ...input, artifact }));
      assert.equal(state.submissions, 1);
    }
  });

  for (const directive of [
    'Closes #17',
    'CLOSE: #17, #18',
    'closed example/widget#17',
    'Fixes: other_owner/other_repo#9',
    'fixed https://github.com/example/widget/issues/17',
    'Resolves: https://github.com/example/widget/pull/23',
    'Resolved **#17**',
    'Fixes [the issue](https://github.com/example/widget/issues/17)',
    'Closes \\#17',
  ]) {
    it(`refuses closure syntax in introduced messages: ${directive}`, async () => {
      const { context, state } = fixture(true, true);
      state.commitMessage = directive;
      await assert.rejects(publishPr(context, { ...input, draft: false }), /closing directives/u);
      assert.equal(state.promotions, 0);
      assert.equal(state.updates, 0);
    });
  }

  for (const [name, change] of [
    [
      'removed current intent',
      (state: ReturnType<typeof fixture>['state']) => {
        state.body = 'Improve widget';
      },
    ],
    [
      'changed intended issue',
      (state: ReturnType<typeof fixture>['state']) => {
        state.body = `References ${repo}#18`;
      },
    ],
    [
      'conflicting intent declarations',
      (state: ReturnType<typeof fixture>['state']) => {
        state.body += `\nReferences ${repo}#18`;
      },
    ],
    [
      'body closure',
      (state: ReturnType<typeof fixture>['state']) => {
        state.body += '\nFixes #18';
      },
    ],
    [
      'title closure',
      (state: ReturnType<typeof fixture>['state']) => {
        state.title = 'Fixes #17';
      },
    ],
    [
      'closing native event',
      (state: ReturnType<typeof fixture>['state']) => {
        state.referenceCloses = true;
      },
    ],
    [
      'unknown native event intent',
      (state: ReturnType<typeof fixture>['state']) => {
        state.referenceCloses = null;
      },
    ],
    [
      'unauthorized reference actor',
      (state: ReturnType<typeof fixture>['state']) => {
        state.referenceActor = 'collaborator';
      },
    ],
    [
      'wrong PR author',
      (state: ReturnType<typeof fixture>['state']) => {
        state.prAuthor = 'collaborator';
      },
    ],
    [
      'closed issue',
      (state: ReturnType<typeof fixture>['state']) => {
        state.issueState = 'closed';
      },
    ],
    [
      'foreign PR repository',
      (state: ReturnType<typeof fixture>['state']) => {
        state.headRepo = 'other/widget';
      },
    ],
    [
      'moved default base',
      (state: ReturnType<typeof fixture>['state']) => {
        state.baseSha = 'd'.repeat(40);
      },
    ],
    [
      'incomplete commits',
      (state: ReturnType<typeof fixture>['state']) => {
        state.commitReadback = { repository: null };
      },
    ],
    [
      'missing native reference',
      (state: ReturnType<typeof fixture>['state']) => {
        state.referenceReadback = {
          repository: {
            id: 'REPO',
            nameWithOwner: repo,
            issue: { id: 'ISSUE17', number: 17, state: 'OPEN', timelineItems: { nodes: [], pageInfo } },
          },
        };
      },
    ],
  ] as const) {
    it(`refuses ${name} without mutation`, async () => {
      const { context, state } = fixture(true, true);
      change(state);
      await assert.rejects(publishPr(context, { ...input, draft: false }));
      assert.equal(state.promotions + state.creations + state.updates, 0);
    });
  }

  it('requires complete empty closing associations including later pages', async () => {
    const { context, state } = fixture(true, true);
    state.closingPages = [
      {
        repository: {
          nameWithOwner: repo,
          pullRequest: {
            id: 'PR23',
            number: 23,
            closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'NEXT' } },
          },
        },
      },
      {
        repository: {
          nameWithOwner: repo,
          pullRequest: {
            id: 'PR23',
            number: 23,
            closingIssuesReferences: { nodes: [{ number: 99, repository: { nameWithOwner: repo } }], pageInfo },
          },
        },
      },
    ];
    await assert.rejects(publishPr(context, { ...input, draft: false }), /closing association/u);
    assert.equal(state.promotions, 0);
  });

  it('accepts equivalent duplicate native events without duplicating authority, but refuses conflicts', async () => {
    const { context, state } = fixture(true, true);
    const native = (await context.clients.graphql('DeliveryNonClosingReferences', {})) as {
      repository: { issue: { timelineItems: { nodes: Array<{ willCloseTarget: boolean }> } } };
    };
    const event = native.repository.issue.timelineItems.nodes[0]!;
    native.repository.issue.timelineItems.nodes.push({ ...event });
    state.referenceReadback = native;
    await prInfo(context, input);
    native.repository.issue.timelineItems.nodes[1]!.willCloseTarget = true;
    await assert.rejects(prInfo(context, input), /Conflicting/u);
  });

  it('refuses incomplete reference pagination after a matching observation', async () => {
    const { context, state } = fixture(true, true);
    const native = (await context.clients.graphql('DeliveryNonClosingReferences', {})) as {
      repository: { issue: { timelineItems: { pageInfo: { hasNextPage: boolean; endCursor: string | null } } } };
    };
    native.repository.issue.timelineItems.pageInfo = { hasNextPage: true, endCursor: 'NEXT' };
    state.referencePages = [native, { repository: null }];
    await assert.rejects(publishPr(context, { ...input, draft: false }), /Incomplete/u);
    assert.equal(state.promotions, 0);
  });

  it('does not create again after a server-created draft fails association verification', async () => {
    const { context, state } = fixture(false);
    state.linked = true;
    state.remoteHead = head;
    state.closingReadback = { repository: null };
    await assert.rejects(
      publishPr(context, { issueNumber: 17 }),
      /created PR #23.*post-publication association\/identity verification is unresolved/u,
    );
    assert.equal((await prInfo(context, { prNumber: 23 })).prNumber, 23);
    await assert.rejects(publishPr(context, { issueNumber: 17 }));
    assert.equal(state.creations, 1);
    assert.equal(state.published, true);
  });

  it('preserves uncertain create/update acknowledgements and reconciles without another mutation', async () => {
    const { context, state } = fixture(false);
    state.linked = true;
    state.remoteHead = head;
    state.failCreateAck = true;
    await assert.rejects(publishPr(context, { issueNumber: 17 }), /acknowledgement is uncertain/u);
    assert.equal((await prInfo(context, { prNumber: 23 })).prNumber, 23);
    state.failCreateAck = false;
    await publishPr(context, { issueNumber: 17, prNumber: 23 });
    assert.equal(state.creations, 1);
    state.failUpdateAck = true;
    const transition = { ...input, body: 'Keep the issue open.' };
    await assert.rejects(publishPr(context, transition), /Transport lost after body update/u);
    state.failUpdateAck = false;
    await publishPr(context, transition);
    assert.equal(state.updates, 1);
  });

  it('refuses explicit ambiguity and requires exact numbers for non-closing inspection', async () => {
    const { context, state } = fixture(true, true);
    await assert.rejects(prInfo(context, { issueNumber: 17, nonClosing: true }), /explicit/u);
    state.matchReadback = [{ number: 23 }, { number: 24 }];
    await assert.rejects(publishPr(context, { ...input, draft: false }), /conflicting/u);
    assert.equal(state.promotions, 0);
  });
});

describe('non-closing complete native graph and mutation drift', () => {
  const input = { issueNumber: 17, prNumber: 23, nonClosing: true };
  it('checks earlier introduced commits rather than only the safe head message', async () => {
    const { context, state } = fixture(true, true);
    const graph = (await context.clients.graphql('DeliveryNonClosingCommits', {})) as {
      repository: {
        pullRequest: {
          commits: {
            totalCount: number;
            nodes: Array<{
              commit: {
                oid: string;
                message: string;
                parents: { totalCount: number; nodes: Array<{ oid: string }>; pageInfo: typeof pageInfo };
              };
            }>;
          };
        };
      };
    };
    graph.repository.pullRequest.commits.totalCount = 2;
    graph.repository.pullRequest.commits.nodes.unshift({
      commit: {
        oid: 'e'.repeat(40),
        message: 'Closes: #999',
        parents: { totalCount: 1, nodes: [{ oid: base }], pageInfo },
      },
    });
    state.commitReadback = graph;
    await assert.rejects(publishPr(context, { ...input, draft: false }), /closing directives/u);
    assert.equal(state.promotions, 0);
    graph.repository.pullRequest.commits.nodes[0]!.commit.message = 'Earlier improvement';
    await prInfo(context, input);
    graph.repository.pullRequest.commits.totalCount = 3;
    await assert.rejects(prInfo(context, input), /count\/head is incomplete/u);
  });

  for (const kind of [
    'source-node',
    'source-number',
    'source-repository',
    'source-type',
    'target-node',
    'target-number',
    'target-repository',
    'cross-repository',
    'missing-actor',
    'wrong-pr-node',
  ] as const) {
    it(`refuses conflicting native identity ${kind}`, async () => {
      const { context, state } = fixture(true, true);
      type Subject = {
        __typename: string;
        id: string;
        number: number;
        repository: { id: string; nameWithOwner: string };
      };
      const native = (await context.clients.graphql('DeliveryNonClosingReferences', {})) as {
        repository: {
          issue: {
            timelineItems: {
              nodes: Array<{
                source: Subject;
                target: Subject;
                isCrossRepository: boolean;
                actor: { login: string } | null;
              }>;
            };
          };
        };
      };
      const event = native.repository.issue.timelineItems.nodes[0]!;
      if (kind === 'source-node') event.source.id = 'PROTHER';
      if (kind === 'source-number') event.source.number = 24;
      if (kind === 'source-repository') event.source.repository.nameWithOwner = 'other/widget';
      if (kind === 'source-type') event.source.__typename = 'Issue';
      if (kind === 'target-node') event.target.id = 'ISSUEOTHER';
      if (kind === 'target-number') event.target.number = 18;
      if (kind === 'target-repository') event.target.repository.id = 'OTHER';
      if (kind === 'cross-repository') event.isCrossRepository = true;
      if (kind === 'missing-actor') event.actor = null;
      if (kind === 'wrong-pr-node') state.nodeId = 'OTHER';
      state.referenceReadback = native;
      await assert.rejects(publishPr(context, { ...input, draft: false }));
      assert.equal(state.promotions + state.creations + state.updates, 0);
    });
  }

  it('refuses changed issue criteria on promotion readback without another ready mutation', async () => {
    const { context, state } = fixture(true, true);
    state.readHook = () => {
      if (state.promotions) state.issueBody = 'External changed criteria';
    };
    await assert.rejects(publishPr(context, { ...input, draft: false }), /criteria drifted/u);
    assert.equal(state.promotions, 1);
    assert.equal(state.issueState, 'open');
  });

  it('refuses changed body during formal review readback without a duplicate review', async () => {
    const { context, reviewerContext, state, artifact } = fixture(true, true);
    vi.spyOn(github, 'createDeliveryGitHubClients').mockResolvedValue(context.clients);
    state.readHook = () => {
      if (state.submissions) state.body = 'External removed reference';
    };
    await assert.rejects(submitFormalReview(reviewerContext, { ...input, artifact }), /References line/u);
    assert.equal(state.submissions, 1);
    assert.equal(state.issueState, 'open');
  });
});

describe('exact created intent and native reader bounds', () => {
  for (const drift of ['body', 'title', 'draft', 'closed', 'base'] as const) {
    it(`reports created identity but refuses post-publication ${drift} drift without a replacement`, async () => {
      const { context, state } = fixture(false, true);
      state.linked = true;
      state.remoteHead = head;
      state.readHook = () => {
        if (!state.creations) return;
        if (drift === 'body') state.body = `References ${repo}#17\n\nOther safe intent`;
        if (drift === 'title') state.title = 'Other safe title';
        if (drift === 'draft') state.draft = false;
        if (drift === 'closed') state.prState = 'closed';
        if (drift === 'base') state.baseSha = 'd'.repeat(40);
      };
      await assert.rejects(publishPr(context, nonClosingCreation), /created PR #23.*differs from publication intent/u);
      assert.equal(state.creations, 1);
      const retry = await publishPr(context, nonClosingCreation).then(
        () => 'reused',
        () => 'refused',
      );
      assert.equal(retry, drift === 'title' || drift === 'draft' ? 'reused' : 'refused');
      assert.equal(state.creations, 1);
    });
  }
  for (const id of [1, true, {}, null, '', ' ']) {
    it(`refuses malformed native event ID ${JSON.stringify(id)} before ready`, async () => {
      const { context, state } = fixture(true, true);
      const native = (await context.clients.graphql('DeliveryNonClosingReferences', {})) as {
        repository: { issue: { timelineItems: { nodes: Array<{ id: unknown }> } } };
      };
      native.repository.issue.timelineItems.nodes[0]!.id = id;
      state.referenceReadback = native;
      await assert.rejects(
        publishPr(context, { issueNumber: 17, prNumber: 23, nonClosing: true, draft: false }),
        /event identity/u,
      );
      assert.equal(state.promotions + state.updates + state.creations, 0);
    });
  }
  it('refuses an oversized reference page despite equivalent observations', async () => {
    const { context, state } = fixture(true, true);
    const native = (await context.clients.graphql('DeliveryNonClosingReferences', {})) as {
      repository: { issue: { timelineItems: { nodes: unknown[] } } };
    };
    native.repository.issue.timelineItems.nodes = Array.from(
      { length: 101 },
      () => native.repository.issue.timelineItems.nodes[0],
    );
    state.referenceReadback = native;
    await assert.rejects(
      publishPr(context, { issueNumber: 17, prNumber: 23, nonClosing: true, draft: false }),
      /Incomplete/u,
    );
    assert.equal(state.promotions, 0);
  });
  it('refuses oversized introduced commit and parent pages', async () => {
    for (const kind of ['commits', 'parents']) {
      const { context, state } = fixture(true, true);
      type Commit = { oid: string; parents: { nodes: Array<{ oid: string }>; totalCount: number } };
      const native = (await context.clients.graphql('DeliveryNonClosingCommits', {})) as {
        repository: { pullRequest: { commits: { nodes: Array<{ commit: Commit }>; totalCount: number } } };
      };
      const commits = native.repository.pullRequest.commits;
      if (kind === 'commits') {
        commits.nodes = Array.from({ length: 101 }, () => commits.nodes[0]!);
        commits.totalCount = 101;
      } else {
        commits.nodes[0]!.commit.parents.nodes = Array.from({ length: 101 }, () => ({ oid: base }));
        commits.nodes[0]!.commit.parents.totalCount = 101;
      }
      state.commitReadback = native;
      await assert.rejects(
        publishPr(context, { issueNumber: 17, prNumber: 23, nonClosing: true, draft: false }),
        /Incomplete/u,
      );
      assert.equal(state.promotions, 0);
    }
  });
  it('refuses body-transition draft drift before promotion, with no second body mutation', async () => {
    const { context, state } = fixture();
    state.readHook = () => {
      if (state.updates) state.draft = false;
    };
    await assert.rejects(
      publishPr(context, {
        issueNumber: 17,
        prNumber: 23,
        nonClosing: true,
        body: 'Safe partial intent',
        draft: false,
      }),
      /drifted/u,
    );
    assert.equal(state.updates, 1);
    assert.equal(state.promotions, 0);
    assert.equal(state.creations, 0);
  });
  it('does not use the closing-transition exception for stale body with empty closing associations', async () => {
    const { context, state } = fixture(true, true);
    state.body = 'Stale intent with removed References line';
    await assert.rejects(
      publishPr(context, { issueNumber: 17, prNumber: 23, nonClosing: true, body: 'New safe intent' }),
      /closing-issue association/u,
    );
    assert.equal(state.updates + state.creations + state.promotions, 0);
  });
});

describe('explicit metadata transition typed authority', () => {
  for (const closing of [
    { number: 17, repository: { nameWithOwner: repo } },
    { __typename: 'PullRequest', id: 'ISSUE17', number: 17, repository: { id: 'REPO', nameWithOwner: repo } },
    { __typename: 'Issue', id: 'OTHER', number: 17, repository: { id: 'REPO', nameWithOwner: repo } },
    { __typename: 'Issue', id: 'ISSUE17', number: 17, repository: { id: 'OTHER', nameWithOwner: repo } },
  ]) {
    it(`refuses incomplete/foreign typed closing identity ${JSON.stringify(closing)}`, async () => {
      const { context, state } = fixture();
      state.closingReadback = {
        repository: {
          nameWithOwner: repo,
          pullRequest: { id: 'PR23', number: 23, closingIssuesReferences: { nodes: [closing], pageInfo } },
        },
      };
      await assert.rejects(
        publishPr(context, { issueNumber: 17, prNumber: 23, nonClosing: true, body: 'Safe partial intent' }),
        /typed closing/u,
      );
      assert.equal(state.updates + state.creations + state.promotions, 0);
    });
  }
});

describe('explicit closing-reference reconciliation', () => {
  function pending(published = false) {
    const f = fixture(published, true);
    f.state.linked = !published;
    f.state.remoteHead = head;
    f.state.closingOnCreate = true;
    if (published) {
      f.state.manualClosing = true;
      f.state.referenceCloses = true;
    }
    return f;
  }
  for (const published of [false, true]) {
    it(`refuses a reviewer-context library mutation before publication/removal; existing PR ${published}`, async () => {
      const { context, reviewerContext, state } = pending(published);
      vi.spyOn(github, 'createDeliveryGitHubClients').mockResolvedValue(context.clients);
      await assert.rejects(
        publishPr(reviewerContext, { ...nonClosingCreation, ...(published ? { prNumber: 23 } : {}) }),
        /configured author credentials/u,
      );
      assert.equal(state.creations + state.removals + state.promotions + state.updates, 0);
    });
  }
  it('refuses the wrong credential source on the direct library mutation', async () => {
    const { context, state } = pending(true);
    const wrongSource = { ...context, clients: { ...context.clients, authSource: 'app' as const } };
    await assert.rejects(publishPr(wrongSource, { ...nonClosingCreation, prNumber: 23 }), /configured.*author/u);
    assert.equal(state.creations + state.removals + state.promotions + state.updates, 0);
  });
  it('opens a bare nonClosing draft with the default reference body and removes the branch closing link', async () => {
    const { context, state } = pending();
    await publishPr(context, { issueNumber: 17, nonClosing: true });
    assert.equal(state.body, `References ${repo}#17\n\n<!-- ai-delivery:pr@1 -->`);
    assert.equal(state.creations, 1);
    assert.equal(state.removals, 1);
  });
  it('creates one draft and removes only the exact manual closing pair before strict success', async () => {
    const { context, state } = pending();
    const preview = await publishPr(context, { ...nonClosingCreation, dryRun: true });
    assert.ok('nonClosingVerified' in preview);
    assert.equal(preview.nonClosingVerified, false);
    assert.equal(state.creations + state.removals, 0);
    const result = await publishPr(context, nonClosingCreation);
    assert.equal(result.prNumber, 23);
    assert.ok('nonClosingVerified' in result);
    assert.equal(result.nonClosingVerified, true);
    assert.deepEqual(state.events, ['draft-publication-replaces-branch-link', 'remove-exact-closing-pair']);
    assert.equal(state.creations, 1);
    assert.equal(state.removals, 1);
    assert.equal(state.updates + state.promotions + state.submissions, 0);
    assert.equal(state.issueState, 'open');
    assert.equal(state.issueBody, 'Four retained criteria');
    await prInfo(context, { issueNumber: 17, prNumber: 23, nonClosing: true });
  });
  it('skips removal when the new draft already satisfies the complete non-closing graph', async () => {
    const { context, state } = pending();
    state.closingOnCreate = false;
    await publishPr(context, nonClosingCreation);
    assert.equal(state.creations, 1);
    assert.equal(state.removals, 0);
  });
  for (const change of [
    { draft: false },
    { expectedHeadSha: 'd'.repeat(40) },
    { expectedHeadSha: 'bad' },
    { body: 'Closes #17' },
  ]) {
    it(`refuses incompatible action ${JSON.stringify(change)} before publication`, async () => {
      const { context, state } = pending();
      await assert.rejects(publishPr(context, Object.assign({ ...nonClosingCreation }, change)));
      assert.equal(state.creations + state.removals + state.updates + state.promotions, 0);
    });
  }
  it('removes the branch closing link from an implicitly matched draft without creating another', async () => {
    const { context, state } = pending(true);
    state.linked = true;
    await publishPr(context, nonClosingCreation);
    assert.equal(state.creations, 0);
    assert.equal(state.removals, 1);
  });
  it('continues a caller-admitted exact pending PR without creating another', async () => {
    const { context, state } = pending(true);
    await publishPr(context, { ...nonClosingCreation, prNumber: 23 });
    assert.equal(state.creations, 0);
    assert.equal(state.removals, 1);
  });
  it('reads the complete manual connection before acting and checks both connections afterward', async () => {
    const { context, state } = pending(true);
    const first = structuredClone(await context.clients.graphql('DeliveryClosingIssues', {})) as {
      repository: {
        pullRequest: {
          closingIssuesReferences: { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
        };
      };
    };
    const last = structuredClone(first);
    first.repository.pullRequest.closingIssuesReferences.nodes = [];
    first.repository.pullRequest.closingIssuesReferences.pageInfo = { hasNextPage: true, endCursor: 'manual-next' };
    state.manualPages = [first, last];
    state.removalHook = () => {
      state.manualPages = [];
    };
    await publishPr(context, { ...nonClosingCreation, prNumber: 23 });
    assert.ok(state.manualPageIndex >= 4);
    assert.equal(state.removals, 1);
    assert.equal(state.creations, 0);
    await prInfo(context, { issueNumber: 17, prNumber: 23, nonClosing: true });
  });
  for (const kind of [
    'foreign-later',
    'duplicate-later',
    'missing-node',
    'wrong-pr',
    'wrong-repo',
    'incomplete-page',
  ] as const) {
    it(`refuses manual graph ${kind} before removal`, async () => {
      const { context, state } = pending(true);
      const graph = structuredClone(await context.clients.graphql('DeliveryClosingIssues', {})) as {
        repository: {
          nameWithOwner: string;
          pullRequest: {
            id: string;
            closingIssuesReferences: {
              nodes: Array<{ id: string; number: number }>;
              pageInfo?: { hasNextPage: boolean; endCursor: string | null };
            };
          };
        };
      };
      if (kind === 'missing-node') graph.repository.pullRequest.closingIssuesReferences.nodes[0]!.id = '';
      if (kind === 'wrong-pr') graph.repository.pullRequest.id = 'FOREIGN';
      if (kind === 'wrong-repo') graph.repository.nameWithOwner = 'other/widget';
      if (kind === 'incomplete-page') delete graph.repository.pullRequest.closingIssuesReferences.pageInfo;
      state.manualReadback = graph;
      if (kind.endsWith('-later')) {
        const next = structuredClone(graph);
        if (kind === 'foreign-later') next.repository.pullRequest.closingIssuesReferences.nodes[0]!.number = 18;
        graph.repository.pullRequest.closingIssuesReferences.pageInfo = { hasNextPage: true, endCursor: 'next' };
        state.manualReadback = undefined;
        state.manualPages = [graph, next];
      }
      await assert.rejects(publishPr(context, { ...nonClosingCreation, prNumber: 23 }));
      assert.equal(state.removals + state.creations, 0);
    });
  }
  it('treats malformed removal acknowledgement as uncertain and does not retry even after the edge disappeared', async () => {
    const { context, state } = pending();
    state.removalReadback = { removeCloseIssueReferences: { issue: { id: 'OTHER' } } };
    await assert.rejects(publishPr(context, nonClosingCreation), /removal.*uncertain/u);
    await publishPr(context, { issueNumber: 17, prNumber: 23, nonClosing: true });
    assert.equal(state.removals, 1);
    assert.equal(state.creations, 1);
  });
  for (const kind of [
    'auto-only',
    'foreign',
    'duplicate',
    'truncated',
    'cursor',
    'actor',
    'crossref',
    'keyword',
  ] as const) {
    it(`refuses ${kind} graph without removing any pair`, async () => {
      const { context, state } = pending(true);
      const graph = structuredClone(await context.clients.graphql('DeliveryClosingIssues', {})) as {
        repository: {
          pullRequest: {
            closingIssuesReferences: {
              nodes: Array<{
                __typename: string;
                id: string;
                number: number;
                repository: { id: string; nameWithOwner: string };
              }>;
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
            };
          };
        };
      };
      if (kind === 'auto-only') {
        state.closingReadback = graph;
        state.manualClosing = false;
      }
      if (kind === 'foreign')
        graph.repository.pullRequest.closingIssuesReferences.nodes.push({
          __typename: 'Issue',
          id: 'OTHER',
          number: 18,
          repository: { id: 'REPO', nameWithOwner: repo },
        });
      if (kind === 'duplicate')
        graph.repository.pullRequest.closingIssuesReferences.nodes.push(
          graph.repository.pullRequest.closingIssuesReferences.nodes[0]!,
        );
      if (kind === 'truncated') graph.repository.pullRequest.closingIssuesReferences.pageInfo.hasNextPage = true;
      if (kind === 'cursor')
        graph.repository.pullRequest.closingIssuesReferences.pageInfo = { hasNextPage: true, endCursor: 'same' };
      if (['foreign', 'duplicate', 'truncated', 'cursor'].includes(kind)) state.closingReadback = graph;
      if (kind === 'actor') state.referenceActor = 'other';
      if (kind === 'crossref') state.referenceCloses = false;
      if (kind === 'keyword') state.commitMessage = 'Fixes #18';
      await assert.rejects(publishPr(context, { ...nonClosingCreation, prNumber: 23 }));
      assert.equal(state.creations + state.removals + state.promotions + state.updates, 0);
    });
  }
  for (const remains of [false, true]) {
    it(`reports uncertain removal once and permits only read-only reconciliation; edge remains ${remains}`, async () => {
      const { context, state } = pending();
      state.failRemovalAck = true;
      state.keepClosingOnRemoval = remains;
      await assert.rejects(publishPr(context, nonClosingCreation), /PR #23.*removal.*uncertain/u);
      assert.equal(state.removals, 1);
      assert.equal(state.creations, 1);
      // An unresolved receipt does not authorize the trusted caller to request another removal.
      if (remains) await assert.rejects(prInfo(context, { issueNumber: 17, prNumber: 23, nonClosing: true }));
      else await publishPr(context, { issueNumber: 17, prNumber: 23, nonClosing: true });
      assert.equal(state.removals, 1);
      assert.equal(state.creations, 1);
    });
  }
  it('recovers a proven pre-action non-attempt with caller-admitted continuation on the same PR', async () => {
    const { context, state } = pending();
    state.referenceActor = 'other';
    await assert.rejects(publishPr(context, nonClosingCreation), /removal not attempted/u);
    assert.equal(state.removals, 0);
    state.referenceActor = 'author';
    await publishPr(context, { ...nonClosingCreation, prNumber: 23 });
    assert.equal(state.creations, 1);
    assert.equal(state.removals, 1);
  });
  it('does not remove anything after uncertain create acknowledgement or create again on read-only inspection', async () => {
    const { context, state } = pending();
    state.failCreateAck = true;
    await assert.rejects(publishPr(context, nonClosingCreation), /acknowledgement is uncertain/u);
    await assert.rejects(prInfo(context, { issueNumber: 17, prNumber: 23, nonClosing: true }));
    assert.equal(state.creations, 1);
    assert.equal(state.removals, 0);
  });
  it('refuses post-removal drift without rollback, promotion or another attempt', async () => {
    const { context, state } = pending();
    state.removalHook = () => {
      state.draft = false;
    };
    await assert.rejects(publishPr(context, nonClosingCreation), /unresolved/u);
    assert.equal(state.removals, 1);
    assert.equal(state.creations, 1);
    assert.equal(state.updates + state.promotions, 0);
  });
});

describe('later-read publication and pre-creation parent bound', () => {
  for (const drift of ['body', 'title', 'draft', 'closed', 'merged', 'base'] as const) {
    it(`refuses later ${drift} drift after the first correct created PR read`, async () => {
      const { context, state } = fixture(false, true);
      state.linked = true;
      state.remoteHead = head;
      state.readHook = (count) => {
        if (!state.creations || count < 2) return;
        if (drift === 'body') state.body = `References ${repo}#17\n\nOther safe intent`;
        if (drift === 'title') state.title = 'Other safe title';
        if (drift === 'draft') state.draft = false;
        if (drift === 'closed') state.prState = 'closed';
        if (drift === 'merged') {
          state.prState = 'closed';
          state.merged = true;
        }
        if (drift === 'base') state.baseSha = 'd'.repeat(40);
      };
      await assert.rejects(publishPr(context, nonClosingCreation), /created PR #23.*unresolved/u);
      assert.equal(state.creations, 1);
    });
  }
  it('rejects state drift observed only by the verifier final internal PR read', async () => {
    const { context, state } = fixture(true, true);
    state.readHook = (count) => {
      if (count === 3) state.draft = false;
    };
    await assert.rejects(
      publishPr(context, { issueNumber: 17, prNumber: 23, nonClosing: true }),
      /state\/draft\/merged/u,
    );
    assert.equal(state.updates + state.promotions + state.creations, 0);
  });
  it('refuses oversized REST parent arrays before creating any PR', async () => {
    const { context, state } = fixture(false, true);
    state.linked = true;
    state.remoteHead = head;
    state.comparisonReadback = {
      base_commit: { sha: base },
      merge_base_commit: { sha: base },
      status: 'ahead',
      total_commits: 1,
      commits: [
        { sha: head, commit: { message: 'Safe message' }, parents: Array.from({ length: 101 }, () => ({ sha: base })) },
      ],
    };
    await assert.rejects(publishPr(context, nonClosingCreation), /Incomplete/u);
    assert.equal(state.creations, 0);
  });
});

// Recorded Oct 24–31 (aviaratech/ai-delivery#239): issue_pr_create failed 35 of 42 calls.
describe('first-call PR creation', () => {
  const recorded = { issueNumber: 17, headBranch: 'issue/17' };

  it('opens a closing PR with only the author identity configured', async () => {
    const { context, state } = fixture(false);
    Reflect.deleteProperty(context, 'reviewerClients');
    vi.spyOn(github, 'createDeliveryGitHubClients').mockRejectedValue(
      new DeliveryError('Missing GitHub App credentials for reviewer role. Set GH_APP_ID_GPT_REVIEWER.'),
    );
    state.remoteHead = head;
    assert.equal((await publishPr(context, recorded)).prNumber, 23);
    assert.equal(state.creations, 1);
  });

  it('returns the created PR with a warning while GitHub has not yet listed its closing link', async () => {
    const { context, state } = fixture(false);
    state.remoteHead = head;
    state.closingReadback = {
      repository: {
        nameWithOwner: repo,
        pullRequest: { id: 'PR23', number: 23, closingIssuesReferences: { nodes: [], pageInfo } },
      },
    };
    const created = await publishPr(context, recorded);
    assert.equal(created.prNumber, 23);
    assert.match(String(Reflect.get(created, 'warnings')), /not yet listed PR #23 as closing #17/u);
    state.closingReadback = undefined;
    assert.equal((await publishPr(context, recorded)).prNumber, 23);
    assert.equal(state.creations, 1);
  });

  it('names an unlinked worktree branch and the step that publishes it', async () => {
    const { context, state } = fixture(false, true);
    await assert.rejects(
      publishPr(context, { ...nonClosingCreation, headBranch: 'claude/17-widget' }),
      /Branch claude\/17-widget is not linked to issue #17 \(GitHub-linked: none\); push the work as issue\/17\./u,
    );
    assert.equal(state.creations, 0);
  });
});

// aviaratech/ai-delivery#238: PR #237 referenced #236 without closing it, and a body update was refused.
describe('non-closing body update', () => {
  it('updates an already non-closing PR body and keeps its issue open', async () => {
    const { context, state } = fixture(true, true);
    const update = { issueNumber: 17, prNumber: 23, nonClosing: true, body: 'Revised widget scope.' };
    await publishPr(context, update);
    assert.equal(state.body, `References ${repo}#17\n\nRevised widget scope.`);
    await publishPr(context, update);
    assert.equal(state.updates, 1);
    assert.equal(state.issueState, 'open');
    await assert.rejects(publishPr(context, { ...update, body: 'Closes #17' }), /closing directives/u);
    assert.equal(state.updates, 1);
  });
});

// Recorded issue_pr_create calls that failed on 0.3.37/0.3.38 hosts (#239). Repo, issue, branch,
// SHA and body text are redacted to the fixture; keys, flags and body shape are as recorded.
describe('recorded issue_pr_create failures open on the first call', () => {
  async function callCreate(context: DeliveryContext, args: Record<string, unknown>) {
    const root = mkdtempSync(join(tmpdir(), 'delivery-pr-replay-'));
    vi.spyOn(settings, 'loadDeliverySettings').mockResolvedValue(
      context.config as unknown as Awaited<ReturnType<typeof settings.loadDeliverySettings>>,
    );
    vi.spyOn(issues, 'loadDeliveryContext').mockResolvedValue(context);
    const server = createAiDeliveryMcpServer({ repoRoot: root });
    const client = new Client({ name: 'replay-fixture', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({ name: 'issue_pr_create', arguments: { repo, ...args } });
      return { isError: result.isError === true, text: JSON.stringify(result.content) };
    } catch (error) {
      return { isError: true, text: error instanceof Error ? error.message : String(error) };
    } finally {
      await client.close();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
  const closing = [
    ['ai-delivery#257 Oct 31', { headBranch: 'issue/17', body: 'Closes #17.\n\nRedacted.' }],
    ['ai#3889 Oct 31', { headBranch: 'issue/17', base: 'main', body: `Fixes ${repo}#17\n\nRedacted.` }],
    ['ai#3894 Nov 1 (twice)', { headBranch: 'issue/17', body: `Fixes ${repo}#17\nRedacted.` }],
    ['ai#3901 Nov 1', { headBranch: 'issue/17', body: `Fixes ${repo}#17\nRedacted.` }],
    ['ai#3907 Nov 1', { headBranch: 'issue/17', body: `Fixes ${repo}#17\n\nRedacted.` }],
  ] as const;
  for (const [name, args] of closing)
    it(`opens the closing PR from ${name} that pinned expectedHeadSha`, async () => {
      const { context, state } = fixture(false);
      state.remoteHead = head;
      const result = await callCreate(context, {
        issueNumber: 17,
        title: 'Improve widget',
        expectedHeadSha: head,
        ...args,
      });
      assert.equal(result.isError, false, result.text);
      assert.equal(state.creations, 1);
    });

  const nonClosing = [
    ['ai#3907 Nov 1 after merged #3908', 'merged', { body: `Refs ${repo}#17 (stays open until the readout)` }],
    ['ai-delivery#240 Nov 1 after closed #245', 'closed', { body: 'Refs #17 (AC1 and AC2). Leaves #17 open.' }],
    ['ai#3700 Oct 26 with no earlier PR', 'none', { body: 'Redacted.' }],
  ] as const;
  for (const [name, earlier, args] of nonClosing)
    it(`opens the non-closing draft from ${name} and keeps the issue open`, async () => {
      const { context, state } = fixture(false, true);
      state.linked = true;
      state.remoteHead = head;
      state.closingOnCreate = true;
      if (earlier !== 'none') {
        const old = {
          ...(await context.clients.rest.pulls.get({ ...context.repo, pull_number: 23 })).data,
          number: 22,
          node_id: 'PR22',
          html_url: `https://github.com/${repo}/pull/22`,
          state: 'closed',
          draft: false,
          merged: earlier === 'merged',
          body: 'Closes #17',
        };
        const { get } = context.clients.rest.pulls;
        Object.assign(context.clients.rest.pulls, {
          list: async (input: { state: string }) => ({
            data: [...(input.state === 'open' ? [] : [{ number: 22 }]), ...(state.published ? [{ number: 23 }] : [])],
          }),
          get: async (input: { pull_number: number }) =>
            input.pull_number === 22 ? { data: old } : get(input as never),
        });
      }
      const result = await callCreate(context, {
        issueNumber: 17,
        headBranch: 'issue/17',
        nonClosing: true,
        title: 'Improve widget',
        ...args,
      });
      assert.equal(result.isError, false, result.text);
      assert.equal(state.creations, 1);
      assert.equal(state.removals, 1);
      assert.equal(state.draft, true);
      assert.equal(state.manualClosing, false);
      assert.equal(state.issueState, 'open');
    });
});
