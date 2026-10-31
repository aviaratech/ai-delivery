import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import type { DeliveryConfig } from './config/deliveryConfig.js';
import { recordedReassociation, recordedZeroApproval } from './fixtures/recordedGitHubFlows.js';
import { digestValue, type RepositoryClassificationReceipt } from './delivery/legacy.js';
import { createDeliveryGitHubClients, withAuthorGitToken } from './github/client.js';
import type { DeliveryContext } from './issue.js';
import { preflightReviewRoute } from './pr.js';
import {
  buildReviewArtifact,
  parseReviewVerdict,
  readRequiredReviewState,
  ReviewArtifactSchema,
  submitReview,
} from './review.js';

const head = { sha: 'a'.repeat(40), tree: 'b'.repeat(40) };
const publicationEvidenceId = `sha256:${'c'.repeat(64)}`;
const marker = (id: string) => `<!-- ai-delivery-review-artifact: ${id} -->`;

const verdictInput = () => ({
  schemaVersion: 'ai-delivery.review-verdict@1',
  verdict: 'approve',
  summary: 'Reviewed changes.',
  issueNumber: 17,
  scope: { headSha: head.sha, headTree: head.tree, changedPaths: ['change.ts'] },
  verificationReproduced: ['Required checks passed.'],
  requestedModel: 'gpt-6-astra',
  effectiveModel: 'gpt-6-astra',
  elapsedMs: 1,
  findings: [],
  readOnly: true,
});

test('a verdict without an effort override truthfully records inherited effort', () => {
  const verdict = parseReviewVerdict(verdictInput());
  assert.equal(verdict.requestedEffort, 'inherited');
  assert.equal(verdict.effectiveEffort, 'inherited');
  assert.equal(parseReviewVerdict({ ...verdictInput(), effectiveEffort: 'xhigh' }).effectiveEffort, 'xhigh');
});

test('formal review normalizes unsorted duplicate and canonical rename-old paths', async () => {
  const state = fixture();
  try {
    state.context.clients.rest.pulls.listFiles = (async () => ({
      data: [{ filename: 'change.ts', previous_filename: 'old.ts', status: 'renamed' }],
    })) as typeof state.context.clients.rest.pulls.listFiles;
    const make = (changedPaths: string[]) =>
      buildReviewArtifact({
        verdict: parseReviewVerdict({
          ...verdictInput(),
          requestedEffort: 'high',
          effectiveEffort: 'high',
          scope: { ...verdictInput().scope, changedPaths },
        }),
        verdictFileSha256: `sha256:${'d'.repeat(64)}`,
        identity: 'synthetic-reviewer',
        provider: 'openai',
        expectedHead: head.sha,
        prNumber: 19,
        authorIdentity: 'synthetic-author',
      });
    await submitReview({
      context: state.context,
      artifact: make(['old.ts', 'change.ts', 'change.ts']),
      issueNumber: 17,
      prNumber: 19,
      dryRun: true,
    });
    for (const paths of [['old.ts'], ['change.ts', 'unknown.ts']])
      await assert.rejects(
        submitReview({ context: state.context, artifact: make(paths), issueNumber: 17, prNumber: 19, dryRun: true }),
        /scope/u,
      );
    assert.equal(state.created, 0);
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

for (const scenario of [
  'clean',
  'base-touch',
  'reverted-touch',
  'late-base-touch',
  'changed-hunk',
  'failed-verify',
  'focused-verify',
  'unfinalized-verify',
  'legacy',
  'dismissed-original',
  'foreign-commit',
] as const) {
  test(`clean-rebase submission eligibility: ${scenario}`, async () => {
    const state = fixture();
    const proof = mkdtempSync(join(tmpdir(), 'review-reuse-proof-'));
    try {
      const g = (...args: string[]) =>
        execFileSync(
          'git',
          [
            '-c',
            'user.name=Fixture',
            '-c',
            'user.email=fixture@example.invalid',
            '-c',
            'commit.gpgsign=false',
            '-c',
            'core.hooksPath=/dev/null',
            ...args,
          ],
          { cwd: state.root, encoding: 'utf8' },
        ).trim();
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
      writeFileSync(join(state.root, 'change.ts'), lines.join('\n') + '\n');
      g('add', '.');
      g('commit', '-qm', 'Original base');
      const oldBase = g('rev-parse', 'HEAD');
      lines[50] = 'reviewed change';
      writeFileSync(join(state.root, 'change.ts'), lines.join('\n') + '\n');
      g('commit', '-qam', 'Reviewed patch');
      const oldHead = g('rev-parse', 'HEAD');
      const oldTree = g('rev-parse', 'HEAD^{tree}');
      g('checkout', '-qb', 'advanced', oldBase);
      writeFileSync(join(state.root, 'other.ts'), 'Unrelated base change\n');
      if (scenario === 'base-touch' || scenario === 'reverted-touch') {
        const baseLines = [...lines];
        baseLines[50] = 'line 50';
        baseLines[5] = 'base touched';
        writeFileSync(join(state.root, 'change.ts'), baseLines.join('\n') + '\n');
      }
      g('add', '.');
      g('commit', '-qm', 'Advance base');
      if (scenario === 'reverted-touch') {
        const restored = [...lines];
        restored[50] = 'line 50';
        writeFileSync(join(state.root, 'change.ts'), restored.join('\n') + '\n');
        g('commit', '-qam', 'Revert base touch');
      }
      const newBase = g('rev-parse', 'HEAD');
      g('cherry-pick', oldHead);
      if (scenario === 'changed-hunk') {
        lines[50] = 'different patch';
        writeFileSync(join(state.root, 'change.ts'), lines.join('\n') + '\n');
        g('commit', '-qam', 'Change reviewed hunk');
      }
      const newHead = { sha: g('rev-parse', 'HEAD'), tree: g('rev-parse', 'HEAD^{tree}') };
      let currentBase = newBase;
      if (scenario === 'late-base-touch') {
        g('checkout', '-qb', 'later-base', newBase);
        const later = [...lines];
        later[50] = 'line 50';
        later[5] = 'late base touch';
        writeFileSync(join(state.root, 'change.ts'), later.join('\n') + '\n');
        g('commit', '-qam', 'Touch reviewed path after rebase');
        later[5] = 'line 5';
        writeFileSync(join(state.root, 'change.ts'), later.join('\n') + '\n');
        g('commit', '-qam', 'Revert late base touch');
        currentBase = g('rev-parse', 'HEAD');
        g('checkout', '-q', newHead.sha);
      }
      const seal = (content: object) => ({ ...content, artifactId: digestValue(content) }) as typeof state.artifact;
      const { artifactId: _id, ...original } = state.artifact;
      const oldArtifact = seal({
        ...original,
        head: { sha: oldHead, tree: oldTree },
        ...(scenario === 'legacy' ? {} : { reviewBase: { baseSha: oldBase, mergeBaseSha: oldBase } }),
      });
      const oldBody = `${marker(oldArtifact.artifactId)}\n<!-- ai-delivery-review-artifact-data: ${Buffer.from(JSON.stringify(oldArtifact)).toString('base64url')} -->`;
      const reviews = [
        {
          id: 41,
          state: scenario === 'dismissed-original' ? 'DISMISSED' : 'APPROVED',
          // An approval belongs to the head it reviewed; a foreign commit must not carry it.
          commit_id: scenario === 'foreign-commit' ? newBase : oldHead,
          user: { login: 'synthetic-reviewer[bot]' },
          html_url: 'https://github.com/example/repo/pull/19#pullrequestreview-41',
          body: oldBody,
        },
      ];
      const resultPath = join(proof, scenario === 'unfinalized-verify' ? 'result.json.tmp' : 'result.json');
      writeFileSync(
        resultPath,
        JSON.stringify({
          schemaVersion: 'contributor-checks@1',
          scope: scenario === 'focused-verify' ? 'focused' : 'full',
          status: scenario === 'failed-verify' ? 'failed' : 'passed',
          exitCode: scenario === 'failed-verify' ? 1 : 0,
          fullSuccess: true,
          omitted: [],
          gates: ['format', 'lint', 'types', 'build', 'tests', 'inventory'],
          verifiedHead: newHead,
          completedAt: new Date().toISOString(),
          commands: ['format', 'lint', 'types', 'build', 'tests', 'inventory'].map((stage) => ({
            stage,
            status: 'passed',
            exitCode: 0,
            cleanupConfirmed: true,
          })),
        }),
        { mode: 0o600 },
      );
      const artifact = seal({
        ...original,
        head: newHead,
        reviewBase: { baseSha: currentBase, mergeBaseSha: newBase },
        reuse: { fromReviewId: 41, verificationResultPath: resultPath },
      });
      const rest = state.context.clients.rest;
      const context = {
        ...state.context,
        clients: {
          ...state.context.clients,
          rest: Object.assign({}, rest, {
            git: {
              ...rest.git,
              getCommit: async ({ commit_sha }: { commit_sha: string }) => ({
                data: { sha: commit_sha, tree: { sha: g('rev-parse', `${commit_sha}^{tree}`) } },
              }),
            },
            repos: { compareCommitsWithBasehead: async () => ({ data: { merge_base_commit: { sha: newBase } } }) },
            pulls: {
              ...rest.pulls,
              get: async () => ({
                data: {
                  number: 19,
                  state: 'open',
                  changed_files: 1,
                  base: { sha: currentBase, repo: { full_name: 'example/repo' } },
                  head: { sha: newHead.sha, repo: { full_name: 'example/repo' } },
                  user: { login: 'author' },
                },
              }),
              listReviews: async () => ({ data: reviews }),
              getReview: async ({ review_id }: { review_id: number }) => ({
                data: reviews.find((x) => x.id === review_id),
              }),
              createReview: async ({ body, commit_id }: { body: string; commit_id: string }) => {
                assert.equal(commit_id, newHead.sha);
                const created = {
                  ...reviews[0]!,
                  id: 42,
                  body,
                  commit_id,
                  html_url: 'https://github.com/example/repo/pull/19#pullrequestreview-42',
                };
                reviews.push(created);
                return { data: created };
              },
            },
          }),
        },
      } as unknown as DeliveryContext;
      const action = () => submitReview({ context, artifact, issueNumber: 17, prNumber: 19 });
      if (scenario === 'clean') {
        const result = await action();
        assert.equal(result.githubReviewId, 42);
        assert.equal(result.artifact.head.sha, newHead.sha);
        const reused = result.artifact.reusedFrom;
        assert.equal(reused?.oldHead, oldHead);
        assert.equal(reused?.newHead, newHead.sha);
        assert.equal(reused?.reviewId, 41);
        assert.ok(!reviews[1]!.body.includes(resultPath));
      } else await assert.rejects(action(), /fresh review/u);
      assert.equal(reviews.length, scenario === 'clean' ? 2 : 1);
      assert.equal(reviews[0]!.body, oldBody);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
      rmSync(proof, { recursive: true, force: true });
    }
  });
}

function fixture(
  input: {
    authorLogin?: string | null;
    existingReview?: boolean;
    personalAuthor?: boolean;
    reviewLogin?: string;
    head?: typeof head;
    verdict?: 'approve' | 'request-changes';
  } = {},
) {
  const fixtureHead = input.head ?? head;
  const root = mkdtempSync(join(tmpdir(), 'ai-delivery-review-'));
  execFileSync('git', ['init', '-q', root]);
  const artifactContent = {
    authorIdentity: input.personalAuthor ? 'host-author' : 'synthetic-author',
    checks: ['build'],
    diffScopeHash: digestValue(['change.ts']),
    elapsedMs: 1,
    findings: [],
    head: fixtureHead,
    issueNumber: 17,
    prNumber: 19,
    readOnly: true as const,
    requestedEffort: 'xhigh',
    requestedModel: 'gpt-6-astra',
    effectiveEffort: 'xhigh',
    effectiveModel: 'gpt-6-astra',
    reviewerIdentity: 'synthetic-reviewer',
    schemaVersion: 'ai-delivery.review-artifact@1' as const,
    summary: 'Reviewed exact changes.',
    verdict: input.verdict ?? 'approve',
  };
  const artifact = ReviewArtifactSchema.parse({ ...artifactContent, artifactId: digestValue(artifactContent) });
  const review = {
    id: 41,
    state: input.verdict === 'request-changes' ? 'CHANGES_REQUESTED' : 'APPROVED',
    commit_id: fixtureHead.sha,
    user: { login: input.reviewLogin ?? 'synthetic-reviewer[bot]' },
    html_url: 'https://github.com/example/repo/pull/19#pullrequestreview-41',
    body: `${artifact.summary}\n\n${marker(artifact.artifactId)}\n<!-- ai-delivery-review-artifact-data: ${Buffer.from(JSON.stringify(artifact)).toString('base64url')} -->`,
  };
  const reviews = input.existingReview ? [review] : [];
  let created = 0;
  let actorLookups = 0;
  let currentPrHead = fixtureHead.sha;
  const events: string[] = [];
  const context = {
    root,
    repo: { owner: 'example', repo: 'repo' },
    config: {
      repository: 'example/repo',
      roles: {
        author: input.personalAuthor
          ? { authSource: 'personal', identity: 'host-author' }
          : { identity: 'synthetic-author' },
        reviewer: { identity: 'synthetic-reviewer' },
      },
    } as DeliveryConfig,
    clients: {
      authSource: 'app',
      role: 'reviewer',
      appActorLogin: async () => {
        actorLookups += 1;
        return 'synthetic-reviewer[bot]';
      },
      rest: {
        users: {
          getAuthenticated: () => {
            throw new Error('installation token cannot call GET /user');
          },
        },
        git: { getCommit: async () => ({ data: { sha: fixtureHead.sha, tree: { sha: fixtureHead.tree } } }) },
        pulls: {
          get: async () => ({
            data: {
              number: 19,
              changed_files: 1,
              base: { sha: 'c'.repeat(40), repo: { full_name: 'example/repo' } },
              head: { sha: currentPrHead, repo: { full_name: 'example/repo' } },
              state: 'open',
              user: { login: input.authorLogin === undefined ? 'synthetic-author[bot]' : input.authorLogin },
            },
          }),
          listFiles: async () => ({ data: [{ filename: 'change.ts' }] }),
          getReview: async () => ({ data: review }),
          listReviews: async () => ({ data: reviews }),
          createReview: async (input: { body: string; event?: string }) => {
            events.push(input.event ?? 'missing');
            review.body = input.body;
            created += 1;
            reviews.push(review);
            return { data: review };
          },
        },
      },
    },
  } as unknown as DeliveryContext;
  const classification = { head: fixtureHead, changedPaths: ['change.ts'] } as RepositoryClassificationReceipt;
  const submit = () =>
    submitReview({ artifact, classification, context, issueNumber: 17, prNumber: 19, publicationEvidenceId });
  return {
    root,
    context,
    artifact,
    reviews,
    events,
    submit,
    setPrHead(sha: string) {
      currentPrHead = sha;
    },
    get created() {
      return created;
    },
    get actorLookups() {
      return actorLookups;
    },
  };
}

test('request-changes posts its own event and reuses only its exact rejection receipt', async () => {
  const state = fixture({ verdict: 'request-changes' });
  try {
    const result = await state.submit();
    assert.equal(result.state, 'CHANGES_REQUESTED');
    assert.deepEqual(state.events, ['REQUEST_CHANGES']);
    assert.equal((await state.submit()).receiptId, result.receiptId);
    assert.equal(state.created, 1);
    state.setPrHead('f'.repeat(40));
    await assert.rejects(state.submit(), /head changed/u);
    assert.equal(state.created, 1);
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test('reviewer App bot submits and reuses an exact-head approval without GET /user', async () => {
  const state = fixture();
  try {
    const first = await state.submit();
    assert.equal(first.login, 'synthetic-reviewer[bot]');
    assert.equal(state.created, 1);
    const encoded = state.reviews[0]!.body.match(/<!-- ai-delivery-review-artifact-data: ([A-Za-z0-9_-]+) -->/u)?.[1];
    assert.ok(encoded, 'App review must retain its independently hash-verifiable artifact binding');
    assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')), state.artifact);
    const second = await state.submit();
    assert.equal(second.receiptId, first.receiptId);
    assert.equal(state.created, 1);
    assert.equal(state.actorLookups, 2);
    state.setPrHead('d'.repeat(40));
    await assert.rejects(state.submit(), /head changed/u);
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test('configured App reviewer approves a host-authored PR once at the exact head', async () => {
  const state = fixture({ authorLogin: 'host-user', personalAuthor: true });
  try {
    const first = await state.submit();
    assert.equal(first.login, 'synthetic-reviewer[bot]');
    assert.equal(state.created, 1);
    assert.equal((await state.submit()).receiptId, first.receiptId);
    assert.equal(state.created, 1);
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test('reviewer App bot recovers a matching remote marker without another review', async () => {
  const state = fixture({ existingReview: true });
  try {
    const receipt = await state.submit();
    assert.equal(receipt.githubReviewId, 41);
    assert.equal(state.created, 0);
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test('reviewer submits a fresh exact-head artifact despite a historical remapped approval', async () => {
  const state = fixture({ existingReview: true });
  try {
    const { artifactId: _artifactId, ...original } = state.artifact;
    const oldContent = { ...original, head: { sha: 'e'.repeat(40), tree: 'f'.repeat(40) } };
    const oldArtifact = ReviewArtifactSchema.parse({ ...oldContent, artifactId: digestValue(oldContent) });
    state.reviews[0]!.body = `${marker(oldArtifact.artifactId)}\n<!-- ai-delivery-review-artifact-data: ${Buffer.from(JSON.stringify(oldArtifact)).toString('base64url')} -->`;
    assert.equal(state.reviews[0]!.commit_id, state.artifact.head.sha);
    await state.submit();
    assert.equal(state.created, 1);
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test('reviewer App rejects self review and a foreign marker actor', async () => {
  const self = fixture({ authorLogin: 'synthetic-reviewer[bot]' });
  const unknownAuthor = fixture({ authorLogin: null });
  const foreign = fixture({ existingReview: true, reviewLogin: 'another-app[bot]' });
  try {
    await assert.rejects(self.submit(), /must differ from PR author/u);
    await assert.rejects(unknownAuthor.submit(), /must differ from PR author/u);
    await assert.rejects(foreign.submit(), /conflicts with exact-head approval/u);
    assert.equal(self.created, 0);
    assert.equal(unknownAuthor.created, 0);
    assert.equal(foreign.created, 0);
  } finally {
    rmSync(self.root, { recursive: true, force: true });
    rmSync(unknownAuthor.root, { recursive: true, force: true });
    rmSync(foreign.root, { recursive: true, force: true });
  }
});

for (const reviewDecision of [undefined, 'UNKNOWN', false, 0, {}]) {
  test(`missing or malformed review decision ${JSON.stringify(reviewDecision)} cannot carry qualifying review evidence`, async () => {
    let accessReads = 0;
    const context = {
      repo: { owner: 'example', repo: 'repo' },
      clients: {
        graphql: async (query: string) => {
          if (query.includes('DeliveryReviewAccess')) {
            accessReads++;
            return {
              repository: {
                pullRequest: {
                  reviews: {
                    nodes: [
                      {
                        fullDatabaseId: 41,
                        author: { login: 'reviewer' },
                        commit: { oid: head.sha },
                        state: 'APPROVED',
                        authorCanPushToRepository: true,
                      },
                    ],
                  },
                },
              },
            };
          }
          return { repository: { pullRequest: { headRefOid: head.sha, reviewDecision } } };
        },
      },
    } as unknown as DeliveryContext;
    const result = await readRequiredReviewState(context, 19, head.sha, { id: 41, login: 'reviewer[bot]' });
    assert.equal(result.reviewDecision, null);
    assert.equal(result.status, 'unknown');
    assert.equal(result.submittedReviewAuthorCanPushToRepository, null);
    assert.equal(accessReads, 0);
  });
}

test('live GitHub review decision distinguishes a submitted review from a satisfied requirement', async () => {
  const state = fixture();
  try {
    const context = {
      root: state.root,
      repo: { owner: 'example', repo: 'repo' },
      clients: {
        graphql: async () => ({
          repository: { pullRequest: { headRefOid: head.sha, reviewDecision: 'REVIEW_REQUIRED' } },
        }),
      },
    } as unknown as DeliveryContext;
    const pending = await readRequiredReviewState(context, 19, head.sha);
    assert.equal(pending.status, 'still-required');
    assert.equal(pending.reviewDecision, 'REVIEW_REQUIRED');
    assert.match(pending.nextAction, /eligible independent reviewer/u);
    assert.doesNotMatch(pending.nextAction, /submitted APPROVED review/u);
    context.clients.graphql = (async () => ({
      repository: { pullRequest: { headRefOid: head.sha, reviewDecision: 'APPROVED' } },
    })) as never;
    const satisfied = await readRequiredReviewState(context, 19, head.sha);
    assert.equal(satisfied.status, 'satisfied');
    context.clients.graphql = (async () => {
      throw new Error('Repository rules unreadable');
    }) as never;
    const unknown = await readRequiredReviewState(context, 19, head.sha);
    assert.equal(unknown.status, 'unknown');
    assert.match(unknown.nextAction, /inspect the PR review requirement/iu);
    context.clients.graphql = (async () => ({ repository: null })) as never;
    assert.equal((await readRequiredReviewState(context, 19, head.sha)).status, 'unknown');
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test('post-review readback reports exact App review push access without overriding GitHub decision', async () => {
  let reviewDecision: 'APPROVED' | 'REVIEW_REQUIRED' = 'REVIEW_REQUIRED';
  let reviewId = '41';
  let reviewAuthor = 'reviewer-app';
  let reviewCommit = head.sha;
  let authorCanPushToRepository = false;
  const context = {
    repo: { owner: 'example', repo: 'repo' },
    clients: {
      graphql: async (query: string) =>
        query.includes('DeliveryReviewAccess')
          ? {
              repository: {
                pullRequest: {
                  reviews: {
                    nodes: [
                      {
                        fullDatabaseId: reviewId,
                        author: { login: reviewAuthor },
                        commit: { oid: reviewCommit },
                        state: 'APPROVED',
                        authorCanPushToRepository,
                      },
                    ],
                  },
                },
              },
            }
          : { repository: { pullRequest: { headRefOid: head.sha, reviewDecision } } },
    },
  } as unknown as DeliveryContext;
  const submittedReview = { id: 41, login: 'reviewer-app[bot]' };
  const insufficient = await readRequiredReviewState(context, 19, head.sha, submittedReview);
  assert.equal(insufficient.status, 'still-required');
  assert.equal(insufficient.submittedReviewAuthorCanPushToRepository, false);
  assert.match(insufficient.nextAction, /reviewer App.*write access/iu);

  authorCanPushToRepository = true;
  const writeCapable = await readRequiredReviewState(context, 19, head.sha, submittedReview);
  assert.equal(writeCapable.status, 'still-required');
  assert.equal(writeCapable.submittedReviewAuthorCanPushToRepository, true);

  reviewAuthor = 'unrelated-reviewer[bot]';
  assert.equal(
    (await readRequiredReviewState(context, 19, head.sha, submittedReview)).submittedReviewAuthorCanPushToRepository,
    null,
  );
  reviewAuthor = 'reviewer-app';
  reviewId = '42';
  assert.equal(
    (await readRequiredReviewState(context, 19, head.sha, submittedReview)).submittedReviewAuthorCanPushToRepository,
    null,
  );
  reviewId = '41';
  reviewCommit = 'd'.repeat(40);
  assert.equal(
    (await readRequiredReviewState(context, 19, head.sha, submittedReview)).submittedReviewAuthorCanPushToRepository,
    null,
  );
  reviewCommit = head.sha;
  authorCanPushToRepository = false;
  reviewDecision = 'APPROVED';
  const satisfied = await readRequiredReviewState(context, 19, head.sha, submittedReview);
  assert.equal(satisfied.status, 'satisfied');
  assert.equal(satisfied.submittedReviewAuthorCanPushToRepository, false);
});

function unprotectedRouteFixture() {
  const state = {
    deniedRoute: '',
    protectionError: { status: 404, response: { status: 404, data: { message: 'Branch not protected' } } } as unknown,
    rules: { status: 200, headers: {}, data: [] } as unknown,
    rulesets: { status: 200, headers: {}, data: [] } as unknown,
    branch: { status: 200, data: { name: 'main', protected: false, protection: { enabled: false } } } as unknown,
    repository: {
      status: 200,
      data: { full_name: 'example/repo', permissions: { push: true, admin: true } },
    } as unknown,
  };
  const reviewer = {
    authSource: 'app',
    role: 'reviewer',
    effectiveContentsPermission: 'read',
    appActorLogin: async () => 'reviewer-app[bot]',
    rest: { repos: { get: async () => ({ data: { full_name: 'example/repo' } }) } },
  };
  const context = {
    repo: { owner: 'example', repo: 'repo' },
    config: { roles: { author: { authSource: 'personal', identity: 'author' }, reviewer: { identity: 'reviewer' } } },
    clients: {
      authSource: 'personal',
      role: 'author',
      authenticatedAuthor: async () => ({ actorLogin: 'host-user', credentialIdentity: 'user:37' }),
      rest: {
        request: async (route: string, input: Record<string, unknown>) => {
          assert.equal(input.owner, 'example');
          assert.equal(input.repo, 'repo');
          if (route === state.deniedRoute) throw Object.assign(new Error('Denied'), { status: 403 });
          if (route.endsWith('/rules/branches/{branch}')) return state.rules;
          if (route.endsWith('/branches/{branch}/protection')) throw state.protectionError;
          if (route.endsWith('/branches/{branch}')) {
            assert.equal(input.branch, 'main');
            return state.branch;
          }
          if (route.endsWith('/rulesets')) {
            assert.equal(input.includes_parents, true);
            assert.equal(input.page, 1);
            assert.equal(input.per_page, 100);
            return state.rulesets;
          }
          if (route === 'GET /repos/{owner}/{repo}') return state.repository;
          throw new Error(`Unexpected fictional route ${route}`);
        },
      },
    },
  } as unknown as DeliveryContext;
  return { state, read: () => preflightReviewRoute(context, 'main', reviewer as never) };
}

test('confirmed unprotected branch has complete visibility without asserting reviewer eligibility', async () => {
  const { read } = unprotectedRouteFixture();
  const route = await read();
  assert.deepEqual(route.rules, { visibility: 'complete', observedRequiredApprovals: 0 });
  assert.equal(route.approvalEligibility, 'unknown');
  assert.equal(route.reviewer.actorLogin, 'reviewer-app[bot]');
});

for (const [name, change] of [
  ['generic 404', { protectionError: { status: 404, response: { status: 404, data: { message: 'Not Found' } } } }],
  [
    'permission denial',
    { protectionError: { status: 403, response: { status: 403, data: { message: 'Branch not protected' } } } },
  ],
  ['unstructured error', { protectionError: Object.assign(new Error('Branch not protected'), { status: 404 }) }],
  [
    'conflicting error status',
    { protectionError: { status: 404, response: { status: 403, data: { message: 'Branch not protected' } } } },
  ],
  [
    'incomplete applicable rules',
    { rules: { status: 200, data: [], headers: { link: '<https://api.github.com/next>; rel="next"' } } },
  ],
  [
    'incomplete rulesets',
    { rulesets: { status: 200, data: [], headers: { link: '<https://api.github.com/next>; rel="next"' } } },
  ],
  [
    'inherited ruleset',
    { rulesets: { status: 200, headers: {}, data: [{ source_type: 'Organization', enforcement: 'active' }] } },
  ],
  [
    'inherited active rule',
    {
      rules: {
        status: 200,
        headers: {},
        data: [{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }],
      },
    },
  ],
  ['malformed rules', { rules: { status: 200, headers: {}, data: {} } }],
  ['malformed rulesets', { rulesets: { status: 200, headers: {}, data: null } }],
  ['missing pagination headers', { rulesets: { status: 200, data: [] } }],
  ['null pagination headers', { rulesets: { status: 200, headers: null, data: [] } }],
  [
    'malformed repository identity',
    { repository: { status: 200, data: { full_name: 37, permissions: { push: true } } } },
  ],
  ['denied branch read', { deniedRoute: 'GET /repos/{owner}/{repo}/branches/{branch}' }],
  ['denied repository read', { deniedRoute: 'GET /repos/{owner}/{repo}' }],
  ['denied ruleset read', { deniedRoute: 'GET /repos/{owner}/{repo}/rulesets' }],
  [
    'no write permission',
    { repository: { status: 200, data: { full_name: 'example/repo', permissions: { push: false, admin: false } } } },
  ],
  [
    'foreign repository',
    { repository: { status: 200, data: { full_name: 'other/repo', permissions: { admin: true } } } },
  ],
  [
    'protected branch',
    { branch: { status: 200, data: { name: 'main', protected: true, protection: { enabled: false } } } },
  ],
  [
    'enabled protection',
    { branch: { status: 200, data: { name: 'main', protected: false, protection: { enabled: true } } } },
  ],
  [
    'foreign branch',
    { branch: { status: 200, data: { name: 'other', protected: false, protection: { enabled: false } } } },
  ],
] as const) {
  test(`unprotected classification refuses ${name}`, async () => {
    const { state, read } = unprotectedRouteFixture();
    Object.assign(state, change);
    assert.notEqual((await read()).rules.visibility, 'complete');
  });
}

test('prepublication review route reports selected actors and unknown approval eligibility', async () => {
  const author = {
    authSource: 'personal',
    credentialSource: 'env:AUTHOR_TOKEN',
    role: 'author',
    authenticatedAuthor: async () => ({ actorLogin: 'host-user', credentialIdentity: 'user:37' }),
    rest: {
      request: async (route: string) => {
        if (route === 'GET /repos/{owner}/{repo}/rules/branches/{branch}')
          return { data: [{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }] };
        if (route === 'GET /repos/{owner}/{repo}/branches/{branch}/protection')
          throw Object.assign(new Error('not visible'), { status: 403 });
        throw new Error(`Unexpected route ${route}`);
      },
    },
  };
  const reviewer = {
    authSource: 'app',
    credentialSource: 'app:102:installation:202',
    effectiveContentsPermission: 'read',
    role: 'reviewer',
    appActorLogin: async () => 'reviewer-app[bot]',
    rest: { repos: { get: async () => ({ data: { full_name: 'example/repo' } }) } },
  };
  const context = {
    repo: { owner: 'example', repo: 'repo' },
    config: {
      roles: { author: { authSource: 'personal', identity: 'host-author' }, reviewer: { identity: 'reviewer-app' } },
    },
    clients: author,
  } as unknown as DeliveryContext;
  const route = await preflightReviewRoute(context, 'main', reviewer as never);
  assert.equal(route.author.actorLogin, 'host-user');
  assert.equal(route.author.credentialSource, 'env:AUTHOR_TOKEN');
  assert.equal(route.reviewer.actorLogin, 'reviewer-app[bot]');
  assert.equal(route.reviewer.repositoryAccess, 'readable');
  assert.equal(route.rules.visibility, 'partial');
  assert.equal(route.rules.observedRequiredApprovals, 1);
  assert.equal(route.approvalEligibility, 'insufficient-permission');
  assert.match(route.nextAction, /Contents: write/u);
  const writeCapable = await preflightReviewRoute(context, 'main', {
    ...reviewer,
    effectiveContentsPermission: 'write',
  } as never);
  assert.equal(writeCapable.approvalEligibility, 'unknown');
  assert.match(writeCapable.nextAction, /confirm whether the reviewer approval counts/u);
  const missingGrant = await preflightReviewRoute(context, 'main', {
    ...reviewer,
    effectiveContentsPermission: undefined,
  } as never);
  assert.equal(missingGrant.approvalEligibility, 'unknown');
  const unreadable = await preflightReviewRoute(
    {
      ...context,
      clients: {
        ...author,
        rest: { request: async () => Promise.reject(new Error('Rules unavailable')) },
      },
    } as unknown as DeliveryContext,
    'main',
    reviewer as never,
  );
  assert.equal(unreadable.rules.visibility, 'unknown');
  assert.equal(unreadable.rules.observedRequiredApprovals, null);
  assert.equal(unreadable.approvalEligibility, 'unknown');
  const noRequiredReview = await preflightReviewRoute(
    {
      ...context,
      clients: {
        ...author,
        rest: {
          request: async (route: string) =>
            route === 'GET /repos/{owner}/{repo}/rules/branches/{branch}'
              ? { data: [] }
              : { data: { required_pull_request_reviews: null } },
        },
      },
    } as unknown as DeliveryContext,
    'main',
    reviewer as never,
  );
  assert.equal(noRequiredReview.rules.visibility, 'complete');
  assert.equal(noRequiredReview.rules.observedRequiredApprovals, null);
  assert.equal(noRequiredReview.approvalEligibility, 'unknown');
  assert.match(noRequiredReview.nextAction, /No required approving review was observed/u);
  assert.doesNotMatch(noRequiredReview.nextAction, /Contents: write/u);
  const appRoute = await preflightReviewRoute(
    {
      ...context,
      config: { roles: { author: { identity: 'author-app' }, reviewer: { identity: 'reviewer-app' } } },
      clients: {
        ...author,
        authSource: 'app',
        credentialSource: 'app:101:installation:201',
        authenticatedAuthor: async () => ({
          actorLogin: 'author-app[bot]',
          credentialIdentity: 'app:101:installation:201',
        }),
      },
    } as unknown as DeliveryContext,
    'main',
    reviewer as never,
  );
  assert.equal(appRoute.author.actorLogin, 'author-app[bot]');
  assert.equal(appRoute.author.authSource, 'app');
  await assert.rejects(
    preflightReviewRoute(context, 'main', { ...reviewer, appActorLogin: async () => 'host-user' } as never),
    /same GitHub actor/u,
  );
  await assert.rejects(
    preflightReviewRoute(
      {
        ...context,
        config: { roles: { author: { identity: 'app-author' }, reviewer: { identity: 'reviewer-app' } } },
      } as unknown as DeliveryContext,
      'main',
      reviewer as never,
    ),
    /configure the personal author role/u,
  );
});

test.each([
  'available',
  'missing-reviewer',
  'reviewer-permission',
  'author-readback',
  'same-actor',
  'wrong-repository',
])(
  'development personal override uses the real reviewer factory with unused author App credentials absent: %s',
  async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), 'ai-delivery-personal-preflight-'));
    const originalFetch = globalThis.fetch;
    const keyPath = join(root, 'reviewer.pem');
    const config = {
      roles: {
        author: {
          identity: 'unused-author-app',
          credentialEnv: {
            appId: 'PREFLIGHT_UNUSED_AUTHOR_APP_ID',
            installationId: 'PREFLIGHT_UNUSED_AUTHOR_INSTALLATION_ID',
            privateKeyPath: 'PREFLIGHT_UNUSED_AUTHOR_KEY_PATH',
          },
        },
        reviewer: {
          identity: 'reviewer-app',
          credentialEnv: {
            appId: 'PREFLIGHT_REVIEWER_APP_ID',
            installationId: 'PREFLIGHT_REVIEWER_INSTALLATION_ID',
            privateKeyPath: 'PREFLIGHT_REVIEWER_KEY_PATH',
          },
        },
      },
    } as DeliveryConfig;
    const reviewerEnv = {
      PREFLIGHT_REVIEWER_APP_ID: '102',
      PREFLIGHT_REVIEWER_INSTALLATION_ID: '202',
      PREFLIGHT_REVIEWER_KEY_PATH: keyPath,
    };
    assert.ok('credentialEnv' in config.roles.author);
    const envNames = [...Object.values(config.roles.author.credentialEnv), ...Object.keys(reviewerEnv)];
    const savedEnv = new Map(envNames.map((name) => [name, process.env[name]]));
    const requests: string[] = [];
    try {
      writeFileSync(
        keyPath,
        generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }),
      );
      for (const name of envNames) delete process.env[name];
      if (scenario !== 'missing-reviewer') Object.assign(process.env, reviewerEnv);
      globalThis.fetch = async (url, init) => {
        const pathname = new URL(url instanceof Request ? url.url : String(url)).pathname;
        const authorization = new Headers(init?.headers).get('authorization') ?? '';
        requests.push(`${init?.method ?? 'GET'} ${pathname}`);
        const response = (data: unknown, status = 200) =>
          new Response(JSON.stringify(data), {
            status,
            headers: { 'content-type': 'application/json' },
          });
        if (pathname === '/user') {
          assert.equal(authorization, 'token synthetic-development-author');
          return response({
            id: 37,
            login: scenario === 'author-readback' ? '' : scenario === 'same-actor' ? 'reviewer-app[bot]' : 'host-user',
          });
        }
        if (pathname === '/app' || pathname === '/app/installations/202/access_tokens') {
          assert.match(authorization, /^bearer [^.]+\.[^.]+\.[^.]+$/u);
          const jwt = JSON.parse(Buffer.from(authorization.split('.')[1]!, 'base64url').toString()) as { iss: string };
          assert.equal(String(jwt.iss), '102');
          if (pathname === '/app') return response({ id: 102, slug: 'reviewer-app' });
          return response(
            {
              token: 'ghs_synthetic_reviewer',
              expires_at: new Date(Date.now() + 3600000).toISOString(),
              permissions: {
                contents: 'read',
                ...(scenario === 'reviewer-permission' ? {} : { pull_requests: 'write' }),
              },
              repository_selection: 'all',
            },
            201,
          );
        }
        if (pathname === '/repos/example/repo') {
          assert.equal(authorization, 'token ghs_synthetic_reviewer');
          return response({ full_name: scenario === 'wrong-repository' ? 'example/other' : 'example/repo' });
        }
        assert.ok(
          ['/repos/example/repo/rules/branches/main', '/repos/example/repo/branches/main/protection'].includes(
            pathname,
          ),
        );
        assert.equal(authorization, 'token synthetic-development-author');
        return response({ message: 'Rules unavailable' }, 403);
      };
      const author = await createDeliveryGitHubClients({
        config,
        env: {},
        identity: 'personal',
        personalAuth: { enabled: true, token: 'synthetic-development-author' },
        role: 'author',
      });
      const context = { root, repo: { owner: 'example', repo: 'repo' }, config, clients: author } as DeliveryContext;
      if (scenario === 'available') {
        const route = await preflightReviewRoute(context, 'main', undefined, 'development');
        assert.equal(route.author.actorLogin, 'host-user');
        assert.equal(route.author.identity, 'personal');
        assert.equal(route.reviewer.actorLogin, 'reviewer-app[bot]');
        assert.equal(route.reviewer.repositoryAccess, 'readable');
        assert.equal(route.reviewer.effectiveContentsPermission, 'read');
        assert.equal(route.rules.visibility, 'unknown');
        assert.equal(route.approvalEligibility, 'unknown');
        assert.deepEqual(requests, [
          'GET /user',
          'POST /app/installations/202/access_tokens',
          'GET /app',
          'GET /repos/example/repo',
          'GET /repos/example/repo/rules/branches/main',
          'GET /repos/example/repo/branches/main/protection',
        ]);
        await assert.rejects(preflightReviewRoute(context, 'main'), /requires the configured author credential/u);
        // Ordinary configured App/App factory calls still require the author App and distinct credentials.
        await assert.rejects(
          createDeliveryGitHubClients({ config, env: reviewerEnv, identity: 'reviewer-app', role: 'reviewer' }),
          /Missing GitHub App credentials for author role/u,
        );
        await assert.rejects(
          createDeliveryGitHubClients({
            config,
            env: {
              ...reviewerEnv,
              PREFLIGHT_UNUSED_AUTHOR_APP_ID: '102',
              PREFLIGHT_UNUSED_AUTHOR_INSTALLATION_ID: '201',
              PREFLIGHT_UNUSED_AUTHOR_KEY_PATH: join(root, 'unused-author.pem'),
            },
            identity: 'reviewer-app',
            role: 'reviewer',
          }),
          /distinct GitHub App credentials/u,
        );
      } else {
        await assert.rejects(
          preflightReviewRoute(context, 'main', undefined, 'development'),
          {
            'missing-reviewer': /Missing GitHub App credentials for reviewer role/u,
            'reviewer-permission': /reviewer role lacks required pull_requests:write/u,
            'author-readback': /Personal author identity readback is incomplete/u,
            'same-actor': /same GitHub actor/u,
            'wrong-repository': /repository readback disagrees/u,
          }[scenario]!,
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
      for (const [name, value] of savedEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('App client resolves its bot from JWT GET /app and keeps author token scoped', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-delivery-app-auth-'));
  const originalFetch = globalThis.fetch;
  const originalPath = process.env.PATH;
  const originalSsh = process.env.GIT_SSH_COMMAND;
  const originalGitConfig = process.env.GIT_CONFIG;
  const originalGitTrace = process.env.GIT_TRACE;
  const originalGhToken = process.env.GH_TOKEN;
  const realGit = (originalPath ?? '')
    .split(':')
    .map((directory) => join(directory, 'git'))
    .find(existsSync);
  if (!realGit) throw new Error('Git executable is unavailable for transport test.');
  execFileSync(realGit, ['init', '-q', root]);
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    format: 'pem',
    type: 'pkcs8',
  });
  const authorKeyPath = join(root, 'author.pem');
  const reviewerKeyPath = join(root, 'reviewer.pem');
  writeFileSync(authorKeyPath, privateKey);
  writeFileSync(reviewerKeyPath, privateKey);
  const env = {
    AUTHOR_APP_ID: '101',
    AUTHOR_INSTALLATION_ID: '201',
    AUTHOR_KEY_PATH: authorKeyPath,
    REVIEWER_APP_ID: '102',
    REVIEWER_INSTALLATION_ID: '202',
    REVIEWER_KEY_PATH: reviewerKeyPath,
  };
  const config = {
    roles: {
      author: {
        identity: 'synthetic-author',
        credentialEnv: {
          appId: 'AUTHOR_APP_ID',
          installationId: 'AUTHOR_INSTALLATION_ID',
          privateKeyPath: 'AUTHOR_KEY_PATH',
        },
      },
      reviewer: {
        identity: 'synthetic-reviewer',
        credentialEnv: {
          appId: 'REVIEWER_APP_ID',
          installationId: 'REVIEWER_INSTALLATION_ID',
          privateKeyPath: 'REVIEWER_KEY_PATH',
        },
      },
    },
  } as DeliveryConfig;
  const requests: string[] = [];
  let appReadbackOverride: number | null = null;
  let reviewerContentsPermission: 'read' | 'write' = 'read';
  globalThis.fetch = async (url, init) => {
    const requestUrl = new URL(url instanceof Request ? url.url : String(url));
    const authorization = new Headers(init?.headers).get('authorization') ?? '';
    requests.push(`${init?.method ?? 'GET'} ${requestUrl.pathname}`);
    assert.match(authorization, /^bearer [^.]+\.[^.]+\.[^.]+$/u);
    if (requestUrl.pathname === '/app') {
      const payload = JSON.parse(Buffer.from(authorization.split('.')[1]!, 'base64url').toString()) as { iss: string };
      const id = appReadbackOverride ?? Number(payload.iss);
      return new Response(JSON.stringify({ id, slug: id === 101 ? 'synthetic-author' : 'synthetic-reviewer' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    assert.ok(
      ['/app/installations/201/access_tokens', '/app/installations/202/access_tokens'].includes(requestUrl.pathname),
    );
    const isAuthor = requestUrl.pathname.includes('/201/');
    return new Response(
      JSON.stringify({
        token: isAuthor ? 'ghs_synthetic_author' : 'ghs_synthetic_reviewer',
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: isAuthor
          ? { contents: 'write', issues: 'write', organization_projects: 'write', pull_requests: 'write' }
          : { contents: reviewerContentsPermission, pull_requests: 'write' },
        repository_selection: 'all',
      }),
      {
        status: 201,
        headers: { 'content-type': 'application/json' },
      },
    );
  };
  try {
    const clients = await createDeliveryGitHubClients({
      config,
      env,
      identity: 'synthetic-reviewer',
      role: 'reviewer',
    });
    assert.equal(await clients.appActorLogin?.(), 'synthetic-reviewer[bot]');
    assert.equal(clients.effectiveContentsPermission, 'read');
    assert.deepEqual(requests, ['POST /app/installations/202/access_tokens', 'GET /app']);
    await assert.rejects(
      withAuthorGitToken(clients, () => undefined),
      /selected author credential token/u,
    );
    const author = await createDeliveryGitHubClients({ config, env, identity: 'synthetic-author', role: 'author' });
    assert.equal(await withAuthorGitToken(author, (token) => token), 'ghs_synthetic_author');
    await assert.rejects(
      createDeliveryGitHubClients({
        config,
        env: {
          REVIEWER_APP_ID: env.REVIEWER_APP_ID,
          REVIEWER_INSTALLATION_ID: env.REVIEWER_INSTALLATION_ID,
          REVIEWER_KEY_PATH: env.REVIEWER_KEY_PATH,
        },
        identity: 'synthetic-reviewer',
        role: 'reviewer',
        selectedAuthor: author,
      }),
      /Missing GitHub App credentials for author role/u,
    );
    await assert.rejects(
      createDeliveryGitHubClients({
        config,
        env: { ...env, REVIEWER_APP_ID: env.AUTHOR_APP_ID },
        identity: 'synthetic-reviewer',
        role: 'reviewer',
        selectedAuthor: author,
      }),
      /distinct GitHub App credentials/u,
    );
    assert.deepEqual(requests, [
      'POST /app/installations/202/access_tokens',
      'GET /app',
      'POST /app/installations/201/access_tokens',
    ]);
    assert.deepEqual(await author.authenticatedAuthor?.(), {
      actorLogin: 'synthetic-author[bot]',
      credentialIdentity: 'app:101:installation:201',
    });
    if (!author.authenticatedAuthor) throw new Error('Author identity readback is unavailable.');
    appReadbackOverride = 102;
    await assert.rejects(author.authenticatedAuthor(), /Author GitHub App identity did not match/u);
    appReadbackOverride = null;
    reviewerContentsPermission = 'write';
    const writeCapableReviewer = await createDeliveryGitHubClients({
      config,
      env,
      identity: 'synthetic-reviewer',
      role: 'reviewer',
    });
    assert.equal(writeCapableReviewer.effectiveContentsPermission, 'write');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalSsh === undefined) delete process.env.GIT_SSH_COMMAND;
    else process.env.GIT_SSH_COMMAND = originalSsh;
    if (originalGitConfig === undefined) delete process.env.GIT_CONFIG;
    else process.env.GIT_CONFIG = originalGitConfig;
    if (originalGitTrace === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = originalGitTrace;
    if (originalGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalGhToken;
    rmSync(root, { recursive: true, force: true });
  }
});

test('recorded public draft null remains observed while synthetic missing decision is unknown', async () => {
  const state = fixture();
  try {
    const response = structuredClone(recordedZeroApproval);
    state.context.clients.graphql = (async () => response) as never;
    const observed = await readRequiredReviewState(state.context, 55, '4b54bd4b663a32957e4571e2af112f828fbc0a58');
    assert.equal(observed.observed, true);
    assert.equal(observed.reviewDecision, null);
    // Synthetic omission keeps the same envelope and head, never coerced to null.
    const { reviewDecision: _decision, ...missing } = response.repository.pullRequest;
    state.context.clients.graphql = (async () => ({ repository: { pullRequest: missing } })) as never;
    const unavailable = await readRequiredReviewState(state.context, 55, '4b54bd4b663a32957e4571e2af112f828fbc0a58');
    assert.equal(unavailable.observed, false);
    assert.equal(unavailable.status, 'unknown');
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test('recorded reassociation submits a fresh artifact and retry reuses only that artifact', async () => {
  const state = fixture({ head: recordedReassociation.currentArtifact.head });
  const events: string[] = [];
  const oldContent = { ...state.artifact, head: recordedReassociation.historicalArtifact.head };
  const { artifactId: _oldId, ...oldFields } = oldContent;
  // Only the observed head/tree discrepancy and REST review identities are retained.
  // Roles, issue/PR/scope, summary and encoded artifact digest are synthetic aliases.
  const oldArtifact = { ...oldFields, artifactId: digestValue(oldFields) };
  const encode = (artifact: typeof state.artifact) =>
    `${marker(artifact.artifactId)}\n<!-- ai-delivery-review-artifact-data: ${Buffer.from(JSON.stringify(artifact)).toString('base64url')} -->`;
  const oldReview = {
    ...recordedReassociation.historicalReview,
    user: { login: 'synthetic-reviewer[bot]' },
    body: encode(oldArtifact),
  };
  const freshReview = {
    ...recordedReassociation.currentReview,
    user: { login: 'synthetic-reviewer[bot]' },
    body: encode(state.artifact),
  };
  const history: Array<typeof oldReview | typeof freshReview> = [oldReview];
  const rest = state.context.clients.rest;
  const get = rest.pulls.get;
  rest.pulls.get = (async (...args: Parameters<typeof get>) => {
    assert.deepEqual(args[0], { owner: 'example', repo: 'repo', pull_number: 19 });
    events.push('pr');
    return get(...args);
  }) as typeof get;
  const getCommit = rest.git.getCommit;
  rest.git.getCommit = (async (...args: Parameters<typeof getCommit>) => {
    events.push('commit');
    assert.equal(args[0]?.commit_sha, 'aec1b0caa0d6acb44c025cdb4247d43b401e2166');
    return getCommit(...args);
  }) as typeof getCommit;
  rest.pulls.listFiles = (async (input: { pull_number: number; page: number; per_page: number }) => {
    events.push('files');
    assert.equal(input.pull_number, 19);
    assert.equal(input.page, 1);
    assert.equal(input.per_page, 100);
    return { data: [{ filename: 'change.ts' }] };
  }) as unknown as typeof rest.pulls.listFiles;
  rest.pulls.listReviews = (async (input: { pull_number: number; page: number; per_page: number }) => {
    events.push('reviews');
    assert.equal(input.pull_number, 19);
    assert.equal(input.page, 1);
    assert.equal(input.per_page, 100);
    return { data: history };
  }) as unknown as typeof rest.pulls.listReviews;
  rest.pulls.createReview = (async (input: { commit_id: string; event: string; body: string; pull_number: number }) => {
    events.push('create');
    assert.equal(input.pull_number, 19);
    assert.equal(input.commit_id, 'aec1b0caa0d6acb44c025cdb4247d43b401e2166');
    assert.equal(input.event, 'APPROVE');
    assert.ok(input.body.includes(marker(state.artifact.artifactId)));
    assert.ok(!input.body.includes(marker(oldArtifact.artifactId)));
    freshReview.body = input.body;
    history.push(freshReview);
    return { data: freshReview };
  }) as unknown as typeof rest.pulls.createReview;
  rest.pulls.getReview = (async (input: { review_id: number; pull_number: number }) => {
    events.push('readback');
    assert.equal(input.pull_number, 19);
    assert.equal(input.review_id, 5607508810);
    return { data: freshReview };
  }) as unknown as typeof rest.pulls.getReview;
  try {
    const receipt = await state.submit();
    assert.equal(receipt.githubReviewId, 5607508810);
    assert.equal(receipt.headSha, 'aec1b0caa0d6acb44c025cdb4247d43b401e2166');
    assert.deepEqual(receipt.artifact.head, {
      sha: 'aec1b0caa0d6acb44c025cdb4247d43b401e2166',
      tree: '2cd3b7f0fcfdf853e4f04ece00367c24df786570',
    });
    assert.equal(oldReview.commit_id, 'aec1b0caa0d6acb44c025cdb4247d43b401e2166');
    assert.equal(oldArtifact.head.sha, '6534bdad0e431f966b541092df5c0881f3bbd3f9');
    assert.deepEqual(events, ['pr', 'commit', 'files', 'reviews', 'pr', 'create', 'readback', 'pr']);
    events.length = 0;
    const retry = await state.submit();
    assert.equal(retry.githubReviewId, 5607508810);
    assert.equal(history.length, 2);
    assert.deepEqual(events, ['pr', 'commit', 'files', 'reviews', 'pr', 'readback', 'pr']);
    assert.equal(oldReview.body, encode(oldArtifact));
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});
