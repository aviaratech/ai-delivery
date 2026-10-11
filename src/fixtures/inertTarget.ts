import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import * as githubClients from '../github/client.js';
import { IssueFields, renderIssueBody } from '../issueContract.js';
import { digestBytes, digestValue } from '../delivery/common.js';
import { createAiDeliveryMcpServer } from '../mcp/index.js';
import type { ExecutionContext } from '../dispatch.js';
import { syntheticDiscoveryClients } from './discovery.js';

export type PolicyState = 'tracked' | 'edited';
export const fixtureFields = IssueFields.parse({
  title: 'Reject invalid widget identifiers before persistence',
  issueType: 'Task',
  points: 2,
  problem: 'Invalid widget identifiers currently reach persistence.',
  outcome: 'Reject invalid identifiers before any persistence call.',
  acceptanceCriteria: [
    {
      behavior: 'Invalid identifiers return an error with zero persistence calls.',
      verifiedBy:
        'Synthetic port regression test; node consumer-trap.cjs and npm run trap are inert verification prose.',
    },
  ],
  outOfScope: ['Storage format changes.'],
  context: { components: ['Widget validation'], files: [], evidence: [] },
});

/** All Git operations act on an owned fictional consumer and ignore host Git configuration. */
export function fixtureGit(root: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'credential.helper=', '-C', root, ...args],
    {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: tmpdir(),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: 'Fictional Operator',
        GIT_AUTHOR_EMAIL: 'operator@example.invalid',
        GIT_COMMITTER_NAME: 'Fictional Operator',
        GIT_COMMITTER_EMAIL: 'operator@example.invalid',
      },
    },
  ).trim();
}

/** Only these external HTTP/authentication ports are replaced. No resolver or owner is mocked. */
export function inertTarget() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-inert-target-')));
  const owned = lstatSync(base);
  const observations: unknown[] = [];
  const root = join(base, 'consumer');
  const sentinel = join(base, 'policy-executed');
  mkdirSync(root);
  fixtureGit(root, 'init', '-q', '-b', 'main');
  fixtureGit(root, 'remote', 'add', 'origin', 'https://github.com/example/widget.git');
  writeFileSync(join(root, '.gitignore'), '.worktrees/\n.issue-cli/\n');
  writeFileSync(join(root, 'change.ts'), 'export const fictional = true;\n');
  const payload = (marker: string) =>
    `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(sentinel)},JSON.stringify({marker:${JSON.stringify(marker)},module:import.meta.url}),{flag:'wx'});export const deliverySettings={};\n`;
  const tracked = payload('tracked'),
    edited = payload('edited');
  writeFileSync(join(root, 'ai-delivery.policy.mjs'), tracked);
  fixtureGit(root, 'add', '.');
  fixtureGit(root, 'commit', '-qm', 'Owned inert consumer');
  const head = fixtureGit(root, 'rev-parse', 'HEAD');
  const tree = fixtureGit(root, 'rev-parse', 'HEAD^{tree}');
  fixtureGit(root, 'update-ref', 'refs/remotes/origin/main', head);
  const userPath = join(base, 'user.json');
  writeFileSync(
    userPath,
    JSON.stringify({
      schemaVersion: 'ai-delivery.user@1',
      roles: {
        author: { authSource: 'personal', identity: 'author', credentialEnv: { token: 'FICTIONAL_AUTHOR_TOKEN' } },
        reviewer: {
          identity: 'reviewer',
          credentialEnv: {
            appId: 'FICTIONAL_REVIEW_APP',
            installationId: 'FICTIONAL_REVIEW_INSTALL',
            privateKeyPath: 'FICTIONAL_REVIEW_KEY',
          },
        },
      },
      checkoutRoots: [base],
      project: 1,
      pointsField: 'Estimate',
      priorityField: 'Urgency',
      statusField: 'Flow',
      statuses: { blocked: 'Waiting', done: 'Shipped', inProgress: 'Active', todo: 'Queued' },
      issueTypes: ['Task'],
    }),
    { mode: 0o600 },
  );
  vi.stubEnv('AI_DELIVERY_CONFIG', userPath);

  const calls: { name: string; input: unknown }[] = [];
  const record = (name: string, input: unknown = null) => {
    calls.push({ name, input });
  };
  const state = {
    title: fixtureFields.title,
    body: renderIssueBody(fixtureFields),
    issueState: 'open',
    points: '2',
    priority: 'High',
    projectOption: 'STATUS-0',
    linked: true,
    published: true,
    draft: false,
    prTitle: 'Reject invalid widget identifiers',
    prBody: 'Closes #17',
    merged: false,
    closedCount: 0,
    reviewDecision: 'APPROVED',
    mergeAckLost: false,
  };
  const artifactContent = {
    authorIdentity: 'author',
    reviewerIdentity: 'reviewer',
    checks: ['Synthetic focused regression'],
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
    schemaVersion: 'ai-delivery.review-artifact@1',
    summary: 'Fictional independent review.',
    verdict: 'approve',
  };
  const artifact = { ...artifactContent, artifactId: digestValue(artifactContent) };
  const artifactPath = join(base, 'review.json');
  writeFileSync(artifactPath, JSON.stringify(artifact), { mode: 0o600 });
  const reviewBody = `${artifact.summary}\n\n<!-- ai-delivery-review-artifact: ${artifact.artifactId} -->\n<!-- ai-delivery-review-artifact-data: ${Buffer.from(JSON.stringify(artifact)).toString('base64url')} -->`;
  const review = {
    id: 99,
    user: { login: 'reviewer[bot]', id: 99, type: 'Bot' },
    state: 'APPROVED',
    commit_id: head,
    body: reviewBody,
    html_url: 'https://github.com/example/widget/pull/23#pullrequestreview-99',
  };
  const reviews = [review];
  const comments: {
    id: number;
    body: string;
    html_url: string;
    issue_url: string;
    created_at: string;
    user: { id: number; login: string; type: string };
  }[] = [];
  const addComment = (id: number, body: string, app = false) => {
    const comment = {
      id,
      body,
      html_url: `https://github.com/example/widget/issues/17#issuecomment-${id}`,
      issue_url: 'https://api.github.com/repos/example/widget/issues/17',
      created_at: new Date(Date.now() + 1000).toISOString(),
      user: app ? { id: 99, login: 'reviewer[bot]', type: 'Bot' } : { id: 42, login: 'operator', type: 'User' },
    };
    comments.push(comment);
    return comment;
  };
  const issue = (number = 17) => ({
    number,
    id: 100 + number,
    node_id: `ISSUE${number}`,
    title: state.title,
    body: state.body,
    state: state.issueState,
    state_reason: state.issueState === 'closed' ? 'completed' : null,
    html_url: `https://github.com/example/widget/issues/${number}`,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    labels: [],
    type: { name: 'Task' },
  });
  const pr = () => ({
    number: 23,
    node_id: 'PR23',
    changed_files: 1,
    title: state.prTitle,
    body: state.prBody,
    html_url: 'https://github.com/example/widget/pull/23',
    state: state.merged ? 'closed' : 'open',
    draft: state.draft,
    merged: state.merged,
    merge_commit_sha: state.merged ? 'c'.repeat(40) : null,
    mergeable: true,
    mergeable_state: 'clean',
    head: { sha: head, ref: 'issue/17', repo: { full_name: 'example/widget' } },
    base: { sha: head, ref: 'main', repo: { full_name: 'example/widget' } },
    user: { login: 'operator' },
  });
  const fields = () => [
    {
      issue_field_id: 101,
      issue_field_name: 'Estimate',
      data_type: 'single_select',
      value: state.points,
      single_select_option: { name: state.points },
    },
    {
      issue_field_id: 102,
      issue_field_name: 'Urgency',
      data_type: 'single_select',
      value: state.priority,
      single_select_option: { name: state.priority },
    },
  ];
  const item = () => ({
    id: 'ITEM17',
    isArchived: false,
    project: { id: 'PROJECT-1', number: 1 },
    content: { __typename: 'Issue', id: 'ISSUE17' },
    fieldValueByName: {
      __typename: 'ProjectV2ItemFieldSingleSelectValue',
      optionId: state.projectOption,
      name: ['Queued', 'Active', 'Waiting', 'Shipped'][Number(state.projectOption.slice(-1))],
      field: { id: 'STATUS-FIELD', name: 'Flow' },
    },
  });
  const rest = {
    request: async (route: string, input: Record<string, unknown> = {}) => {
      record(route, input);
      if (route === 'GET /orgs/{org}/issue-fields')
        return {
          data: [
            {
              id: 101,
              name: 'Estimate',
              data_type: 'single_select',
              options: ['1', '2', '4'].map((name) => ({ name })),
            },
            {
              id: 102,
              name: 'Urgency',
              data_type: 'single_select',
              options: ['High', 'Low'].map((name) => ({ name })),
            },
          ],
        };
      if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values') {
        const values = input.issue_field_values as { field_id: number; value: string }[];
        for (const value of values) {
          if (value.field_id === 101) state.points = value.value;
          if (value.field_id === 102) state.priority = value.value;
        }
        return { data: fields() };
      }
      if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values') return { data: fields() };
      if (route.includes('rules')) return { data: [] };
      throw new Error(`Unexpected synthetic REST route: ${route}`);
    },
    repos: {
      get: async (input: unknown) => {
        record('repos.get', input);
        return {
          data: { node_id: 'REPO', full_name: 'example/widget', default_branch: 'main', permissions: { push: true } },
        };
      },
    },
    git: {
      getRef: async (input: { ref: string }) => {
        record('git.getRef', input);
        return { data: { ref: `refs/${input.ref}`, object: { type: 'commit', sha: head } } };
      },
      getCommit: async (input: unknown) => {
        record('git.getCommit', input);
        return { data: { sha: head, tree: { sha: tree } } };
      },
    },
    issues: {
      get: async (input: unknown) => {
        record('issues.get', input);
        return { data: issue() };
      },
      create: async (input: { title: string; body: string }) => {
        record('issues.create', input);
        state.title = input.title;
        state.body = input.body;
        return { data: issue() };
      },
      update: async (input: { title?: string; body?: string; state?: string }) => {
        record('issues.update', input);
        if (input.title !== undefined) state.title = input.title;
        if (input.body !== undefined) state.body = input.body;
        if (input.state !== undefined) {
          state.issueState = input.state;
          if (input.state === 'closed') state.closedCount++;
        }
        return { data: issue() };
      },
      listForRepo: async (input: { page?: number }) => {
        record('issues.listForRepo', input);
        return { data: input.page === 2 ? [issue(18)] : input.page === 3 ? [] : [issue()] };
      },
      listLabelsForRepo: async () => ({ data: [] }),
      listSubIssues: async () => ({ data: [] }),
      listComments: async (input: unknown) => {
        record('issues.listComments', input);
        return { data: comments };
      },
      createComment: async (input: { body: string }) => {
        record('issues.createComment', input);
        return { data: addComment(101 + comments.length, input.body) };
      },
      getComment: async (input: { comment_id: number }) => {
        record('issues.getComment', input);
        return { data: comments.find((comment) => comment.id === input.comment_id) };
      },
    },
    search: {
      issuesAndPullRequests: async (input: { page?: number }) => {
        record('search.issuesAndPullRequests', input);
        return {
          data: {
            total_count: 2,
            incomplete_results: false,
            items: input.page === 2 ? [issue(18)] : input.page === 3 ? [] : [issue()],
          },
        };
      },
    },
    pulls: {
      get: async (input: unknown) => {
        record('pulls.get', input);
        return { data: pr() };
      },
      list: async (input: unknown) => {
        record('pulls.list', input);
        return { data: state.published ? [pr()] : [] };
      },
      listFiles: async (input: unknown) => {
        record('pulls.listFiles', input);
        return { data: [{ filename: 'change.ts' }] };
      },
      create: async (input: { draft: boolean; title: string; body: string }) => {
        record('pulls.create', input);
        state.published = true;
        state.draft = input.draft;
        state.prTitle = input.title;
        state.prBody = input.body;
        return { data: pr() };
      },
      update: async (input: { draft?: boolean }) => {
        record('pulls.update', input);
        if (input.draft !== undefined) state.draft = input.draft;
        return { data: pr() };
      },
      createReview: async (input: { body: string; commit_id: string }) => {
        record('pulls.createReview', input);
        assert.equal(input.commit_id, head);
        review.body = input.body;
        reviews.push(review);
        return { data: review };
      },
      listReviews: async (input: unknown) => {
        record('pulls.listReviews', input);
        return { data: reviews };
      },
      getReview: async (input: unknown) => {
        record('pulls.getReview', input);
        return { data: review };
      },
      merge: async (input: { sha: string }) => {
        record('pulls.merge', input);
        assert.equal(input.sha, head);
        state.merged = true;
        if (state.mergeAckLost) {
          state.mergeAckLost = false;
          throw new Error('Synthetic lost merge acknowledgement');
        }
        return { data: { merged: true, sha: 'c'.repeat(40) } };
      },
    },
  };
  const graphql = async (query: string, variables: Record<string, unknown> = {}): Promise<unknown> => {
    record(query.match(/(?:query|mutation)\s+(\w+)/u)?.[1] ?? 'relationships', variables);
    if (query.includes('ProjectDeliveryItems'))
      return {
        organization: {
          projectV2: { id: 'PROJECT-1', items: { nodes: [item()], pageInfo: { hasNextPage: false, endCursor: null } } },
        },
      };
    if (query.includes('UpdateProjectDeliveryStatus')) {
      state.projectOption = String(variables.optionId);
      return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'ITEM17' } } };
    }
    if (query.includes('ProjectDeliveryItemReadback')) return { node: item() };
    if (query.includes('DeliveryStartBranch')) {
      state.linked = true;
      return { createLinkedBranch: { linkedBranch: { ref: { name: 'issue/17', target: { oid: head } } } } };
    }
    if (query.includes('DeliveryIssueBranches'))
      return {
        repository: {
          issue: {
            linkedBranches: {
              nodes: state.linked
                ? [
                    {
                      ref: { name: 'issue/17', target: { oid: head }, repository: { nameWithOwner: 'example/widget' } },
                    },
                  ]
                : [],
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
              nodes: [{ number: 17, repository: { nameWithOwner: 'example/widget' } }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      };
    if (query.includes('DeliveryReviewAccess'))
      return {
        repository: {
          pullRequest: {
            headRefOid: head,
            reviews: {
              nodes: reviews.map((value) => ({
                id: String(value.id),
                fullDatabaseId: value.id,
                author: value.user,
                authorCanPushToRepository: true,
                commit: { oid: head },
                state: value.state,
              })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      };
    if (query.includes('DeliveryReviewDecision'))
      return { repository: { pullRequest: { headRefOid: head, reviewDecision: state.reviewDecision } } };
    if (query.includes('IssueClosureReadback'))
      return {
        repository: {
          issue: {
            number: 17,
            repository: { nameWithOwner: 'example/widget' },
            state: state.issueState.toUpperCase(),
            stateReason: state.issueState === 'closed' ? 'COMPLETED' : null,
            duplicateOf: null,
          },
        },
      };
    if (query.includes('blockedBy(first:'))
      return {
        repository: {
          issue: { parent: null, blockedBy: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        },
      };
    return syntheticDiscoveryClients().graphql(query, variables);
  };
  vi.spyOn(githubClients, 'createDeliveryGitHubClients').mockImplementation(
    async (input) =>
      ({
        role: input.role,
        authSource: input.role === 'author' ? 'personal' : 'app',
        authenticatedAuthor: async () => {
          record('authenticatedAuthor');
          return { actorLogin: 'operator', credentialIdentity: 'user:42' };
        },
        appActorLogin: async () => {
          record('appActorLogin');
          return 'reviewer[bot]';
        },
        rest,
        graphql,
      }) as unknown as githubClients.GitHubClients,
  );

  const target = join(root, '.worktrees', 'issue-17');
  const worktree = () => {
    fixtureGit(root, 'worktree', 'add', '-b', 'issue/17', target, head);
    mkdirSync(join(root, '.issue-cli'), { recursive: true });
    writeFileSync(join(root, '.issue-cli', 'worktrees.json'), JSON.stringify({ worktrees: [] }));
    state.published = false;
    return target;
  };
  const policy = (kind: PolicyState, selected = root) => {
    assert.equal(readFileSync(join(selected, 'ai-delivery.policy.mjs'), 'utf8'), tracked);
    assert.equal(fixtureGit(selected, 'show', 'HEAD:ai-delivery.policy.mjs'), tracked.trim());
    assert.equal(fixtureGit(selected, 'show', ':ai-delivery.policy.mjs'), tracked.trim());
    // Positive controls run the SAME payload as the target under the SAME environment in fresh children.
    for (const [name, bytes] of kind === 'tracked'
      ? [['tracked', tracked]]
      : [
          ['tracked', tracked],
          ['edited', edited],
        ]) {
      const control = join(base, `control-${name}.mjs`);
      writeFileSync(control, bytes!);
      execFileSync(process.execPath, [control], { env: process.env, timeout: 5_000, maxBuffer: 64 * 1024 });
      const readback = JSON.parse(readFileSync(sentinel, 'utf8')) as { marker: string; module: string };
      assert.deepEqual(readback, { marker: name, module: pathToFileURL(control).href });
      observations.push({ control: name, module: control, payloadDigest: digestBytes(bytes!), passed: true });
      unlinkSync(sentinel);
    }
    if (kind === 'edited') writeFileSync(join(selected, 'ai-delivery.policy.mjs'), edited);
    assert.equal(fixtureGit(selected, 'status', '--porcelain'), kind === 'edited' ? 'M ai-delivery.policy.mjs' : '');
    observations.push({
      policyState: kind,
      selected,
      indexedDigest: digestBytes(tracked),
      headDigest: digestBytes(tracked),
      worktreeDigest: digestBytes(kind === 'edited' ? edited : tracked),
    });
  };
  const assertInert = () => assert.equal(existsSync(sentinel), false, 'A public route imported consumer policy');
  const connect = async (extra: Partial<ExecutionContext> = {}) => {
    const server = createAiDeliveryMcpServer({ repoRoot: root, ...extra });
    const client = new Client({ name: 'inert-target-fixture', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: { repo: 'example/widget', ...args } });
      const text = (response.content as { text: string }[])[0]?.text ?? '';
      observations.push({ publicTool: name, arguments: args, isError: response.isError === true, text });
      assertInert();
      return { response, text, value: response.isError ? undefined : (JSON.parse(text) as Record<string, unknown>) };
    };
    return {
      call,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  };
  const cleanup = () => {
    const inert = !existsSync(sentinel);
    try {
      const current = lstatSync(base);
      assert.equal(current.isSymbolicLink(), false);
      assert.equal(realpathSync(base), base);
      assert.equal(current.dev, owned.dev);
      assert.equal(current.ino, owned.ino);
      assert.equal(fixtureGit(root, 'rev-parse', '--git-common-dir'), '.git');
      const worktrees = fixtureGit(root, 'worktree', 'list', '--porcelain')
        .split('\n')
        .filter((line) => line.startsWith('worktree '));
      assert.ok(
        worktrees.every((line) => line.slice(9).startsWith(`${base}/`)),
        'Cleanup requires owned worktrees',
      );
      rmSync(base, { recursive: true });
      assert.equal(existsSync(base), false);
      const evidence = process.env.AI_DELIVERY_INERT_EVIDENCE_DIR;
      if (evidence)
        writeFileSync(
          join(evidence, `${basename(base)}.json`),
          JSON.stringify({
            head,
            tree,
            observations,
            externalPortCalls: calls,
            policyInert: inert,
            ownedCleanup: true,
          }) + '\n',
          { flag: 'wx', mode: 0o600 },
        );
      assert.equal(inert, true, 'A public route imported consumer policy');
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  };
  return {
    base,
    root,
    head,
    tree,
    target,
    sentinel,
    artifact,
    artifactPath,
    state,
    calls,
    comments,
    reviews,
    rest,
    graphql,
    addComment,
    policy,
    worktree,
    connect,
    assertInert,
    cleanup,
    dispose: async (connection: { close(): Promise<void> } | undefined) => {
      try {
        await connection?.close();
      } finally {
        cleanup();
      }
    },
  };
}
