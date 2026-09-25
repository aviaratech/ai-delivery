import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import type { DeliveryConfig } from './config/deliveryConfig.js';
import { digestValue, type RepositoryClassificationReceipt } from './delivery/index.js';
import { createDeliveryGitHubClients, withAuthorGitToken } from './github/client.js';
import type { DeliveryContext } from './issue.js';
import { runAuthorGit } from './pr.js';
import { ReviewArtifactSchema, submitReview } from './review.js';

const head = { sha: 'a'.repeat(40), tree: 'b'.repeat(40) };
const publicationEvidenceId = `sha256:${'c'.repeat(64)}`;
const marker = (id: string) => `<!-- ai-delivery-review-artifact: ${id} -->`;

function fixture(input: { authorLogin?: string | null; existingReview?: boolean; reviewLogin?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ai-delivery-review-'));
  execFileSync('git', ['init', '-q', root]);
  const artifactContent = {
    authorIdentity: 'synthetic-author',
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
    body: marker(artifact.artifactId),
  };
  const reviews = input.existingReview ? [review] : [];
  let created = 0;
  let actorLookups = 0;
  let currentPrHead = head.sha;
  const context = {
    root,
    repo: { owner: 'example', repo: 'repo' },
    config: {
      roles: { author: { identity: 'synthetic-author' }, reviewer: { identity: 'synthetic-reviewer' } },
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
        pulls: {
          get: async () => ({
            data: {
              head: { sha: currentPrHead },
              state: 'open',
              user: { login: input.authorLogin === undefined ? 'synthetic-author[bot]' : input.authorLogin },
            },
          }),
          listReviews: async () => ({ data: reviews }),
          createReview: async () => {
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
    const second = await state.submit();
    assert.equal(second.receiptId, first.receiptId);
    assert.equal(state.created, 1);
    assert.equal(state.actorLookups, 2);
    state.setPrHead('d'.repeat(40));
    await assert.rejects(state.submit(), /PR head changed/u);
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

test('reviewer App rejects self review and a foreign marker actor', async () => {
  const self = fixture({ authorLogin: 'synthetic-reviewer[bot]' });
  const unknownAuthor = fixture({ authorLogin: null });
  const foreign = fixture({ existingReview: true, reviewLogin: 'another-app[bot]' });
  try {
    await assert.rejects(self.submit(), /must differ from PR author/u);
    await assert.rejects(unknownAuthor.submit(), /must differ from PR author/u);
    await assert.rejects(foreign.submit(), /does not match exact approval/u);
    assert.equal(self.created, 0);
    assert.equal(unknownAuthor.created, 0);
    assert.equal(foreign.created, 0);
  } finally {
    rmSync(self.root, { recursive: true, force: true });
    rmSync(unknownAuthor.root, { recursive: true, force: true });
    rmSync(foreign.root, { recursive: true, force: true });
  }
});

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
          : { contents: 'read', pull_requests: 'write' },
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
    assert.deepEqual(requests, ['POST /app/installations/202/access_tokens', 'GET /app']);
    await assert.rejects(
      withAuthorGitToken(clients, () => undefined),
      /selected author GitHub App/u,
    );
    const author = await createDeliveryGitHubClients({ config, env, identity: 'synthetic-author', role: 'author' });
    assert.equal(await withAuthorGitToken(author, (token) => token), 'ghs_synthetic_author');
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
    const shimDir = join(root, 'shim');
    const marker = join(root, 'app-git-used');
    mkdirSync(shimDir);
    const shim = join(shimDir, 'git');
    writeFileSync(
      shim,
      `#!/bin/sh
if [ "$1" = config ]; then exec "${realGit}" "$@"; fi
if [ "$1" = -c ] && [ "$2" = credential.helper= ] && [ "$3" = push ] &&
   [ "$GIT_CONFIG_GLOBAL" = /dev/null ] && [ "$GIT_CONFIG_NOSYSTEM" = 1 ] &&
   [ -z "$GIT_SSH_COMMAND" ] && [ -z "$GIT_CONFIG" ] && [ -z "$GIT_TRACE" ] &&
   [ -z "$GH_TOKEN" ] && [ "$AI_DELIVERY_GIT_TOKEN" = ghs_synthetic_author ] &&
   [ "$("$GIT_ASKPASS" Username)" = x-access-token ] &&
   [ "$("$GIT_ASKPASS" Password)" = ghs_synthetic_author ]; then
  : > "${marker}"
  exit 0
fi
exit 97
`,
    );
    chmodSync(shim, 0o700);
    process.env.PATH = `${shimDir}:${originalPath ?? ''}`;
    process.env.GIT_SSH_COMMAND = 'ambient-ssh-identity';
    process.env.GIT_CONFIG = '/dev/null';
    process.env.GIT_TRACE = '1';
    process.env.GH_TOKEN = 'synthetic-ambient-token';
    const authorContext = { root, repo: { owner: 'example', repo: 'repo' }, clients: author } as DeliveryContext;
    await runAuthorGit(
      authorContext,
      root,
      ['push', 'https://github.com/example/repo.git', 'HEAD:refs/heads/issue/17'],
      'push',
    );
    assert.equal(existsSync(marker), true);
    delete process.env.GIT_CONFIG;
    delete process.env.GIT_TRACE;
    delete process.env.GH_TOKEN;
    execFileSync(realGit, ['config', '--local', 'url.ssh://git@github.com/.pushInsteadOf', 'https://github.com/'], {
      cwd: root,
    });
    process.env.GIT_CONFIG = '/dev/null';
    await assert.rejects(
      runAuthorGit(
        authorContext,
        root,
        ['push', 'https://github.com/example/repo.git', 'HEAD:refs/heads/issue/17'],
        'push',
      ),
      /transport configuration/u,
    );
    delete process.env.GIT_CONFIG;
    execFileSync(realGit, ['config', '--local', '--unset', 'url.ssh://git@github.com/.pushInsteadOf'], { cwd: root });
    execFileSync(realGit, ['config', '--local', 'http.extraHeader', 'Authorization: Basic synthetic'], { cwd: root });
    await assert.rejects(
      runAuthorGit(
        authorContext,
        root,
        ['push', 'https://github.com/example/repo.git', 'HEAD:refs/heads/issue/17'],
        'push',
      ),
      /transport configuration/u,
    );
    execFileSync(realGit, ['config', '--local', '--unset', 'http.extraHeader'], { cwd: root });
    execFileSync(realGit, ['config', '--local', 'extensions.worktreeConfig', 'true'], { cwd: root });
    execFileSync(realGit, ['config', '--worktree', 'url.ssh://git@github.com/.pushInsteadOf', 'https://github.com/'], {
      cwd: root,
    });
    await assert.rejects(
      runAuthorGit(
        authorContext,
        root,
        ['push', 'https://github.com/example/repo.git', 'HEAD:refs/heads/issue/17'],
        'push',
      ),
      /transport configuration/u,
    );
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
