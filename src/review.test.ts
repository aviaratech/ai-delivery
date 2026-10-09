import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import type { DeliveryConfig } from './config/deliveryConfig.js';
import { digestValue, type RepositoryClassificationReceipt } from './delivery/legacy.js';
import { createDeliveryGitHubClients, withAuthorGitToken } from './github/client.js';
import type { DeliveryContext } from './issue.js';
import { preflightReviewRoute } from './pr.js';
import { readRequiredReviewState, ReviewArtifactSchema, submitReview } from './review.js';

const head = { sha: 'a'.repeat(40), tree: 'b'.repeat(40) };
const publicationEvidenceId = `sha256:${'c'.repeat(64)}`;
const marker = (id: string) => `<!-- ai-delivery-review-artifact: ${id} -->`;

function fixture(
  input: { authorLogin?: string | null; existingReview?: boolean; personalAuthor?: boolean; reviewLogin?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'ai-delivery-review-'));
  execFileSync('git', ['init', '-q', root]);
  const artifactContent = {
    authorIdentity: input.personalAuthor ? 'host-author' : 'synthetic-author',
    checks: ['build'],
    diffScopeHash: digestValue(['change.ts']),
    elapsedMs: 1,
    findings: [],
    head,
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
    verdict: 'approve' as const,
  };
  const artifact = ReviewArtifactSchema.parse({ ...artifactContent, artifactId: digestValue(artifactContent) });
  const review = {
    id: 41,
    state: 'APPROVED',
    commit_id: head.sha,
    user: { login: input.reviewLogin ?? 'synthetic-reviewer[bot]' },
    html_url: 'https://github.com/example/repo/pull/19#pullrequestreview-41',
    body: `${artifact.summary}\n\n${marker(artifact.artifactId)}\n<!-- ai-delivery-review-artifact-data: ${Buffer.from(JSON.stringify(artifact)).toString('base64url')} -->`,
  };
  const reviews = input.existingReview ? [review] : [];
  let created = 0;
  let actorLookups = 0;
  let currentPrHead = head.sha;
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
        git: { getCommit: async () => ({ data: { sha: head.sha, tree: { sha: head.tree } } }) },
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
          createReview: async (input: { body: string }) => {
            review.body = input.body;
            created += 1;
            reviews.push(review);
            return { data: review };
          },
        },
      },
    },
  } as unknown as DeliveryContext;
  const classification = { head, changedPaths: ['change.ts'] } as RepositoryClassificationReceipt;
  const submit = () =>
    submitReview({ artifact, classification, context, issueNumber: 17, prNumber: 19, publicationEvidenceId });
  return {
    root,
    artifact,
    reviews,
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

test('reviewer refuses another exact-head artifact before creating a conflicting approval', async () => {
  const state = fixture({ existingReview: true });
  try {
    state.reviews[0]!.body = marker(`sha256:${'e'.repeat(64)}`);
    await assert.rejects(state.submit(), /conflict/u);
    assert.equal(state.created, 0);
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
