import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { GitHubClients } from '../github/client.js';
import { syntheticDiscoveryClients } from './discovery.js';

export type EntrypointPolicy = 'tracked' | 'edited';
export type EntrypointRequest = {
  root: string;
  report: string;
  head: string;
  mode: 'cli' | 'mcp' | 'direct' | 'control';
  args: string[];
};
const digestBytes = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Read-only remote ports; unexpected operations fail rather than touching any service. */
export function entrypointClients(head: string) {
  const calls: { name: string; input: unknown }[] = [];
  const record = (name: string, input: unknown = null) => calls.push({ name, input });
  const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
  const issue = {
    number: 17,
    node_id: 'ISSUE17',
    title: 'Fictional widget',
    body: 'Consumer script-looking prose is data.',
    state: 'open',
    type: { name: 'Task' },
    html_url: 'https://github.com/example/widget/issues/17',
  };
  const pr = {
    number: 23,
    state: 'open',
    draft: false,
    merged: false,
    head: { sha: head, ref: 'issue/17', repo: { full_name: 'example/widget' } },
    base: { sha: head, ref: 'main', repo: { full_name: 'example/widget' } },
    html_url: 'https://github.com/example/widget/pull/23',
  };
  const item = {
    id: 'ITEM17',
    isArchived: false,
    content: { __typename: 'Issue', id: 'ISSUE17' },
    project: { id: 'PROJECT-1', number: 1 },
    fieldValueByName: {
      __typename: 'ProjectV2ItemFieldSingleSelectValue',
      optionId: 'STATUS-0',
      name: 'Queued',
      field: { id: 'STATUS-FIELD', name: 'Flow' },
    },
  };
  const request = async (route: string, input: unknown) => {
    record(route, input);
    if (route === 'GET /orgs/{org}/issue-fields')
      return {
        data: [
          { id: 101, name: 'Estimate', data_type: 'single_select' },
          { id: 102, name: 'Urgency', data_type: 'single_select' },
        ],
      };
    if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values')
      return {
        data: [
          {
            issue_field_id: 101,
            issue_field_name: 'Estimate',
            data_type: 'single_select',
            value: '2',
            single_select_option: { name: '2' },
          },
          {
            issue_field_id: 102,
            issue_field_name: 'Urgency',
            data_type: 'single_select',
            value: 'High',
            single_select_option: { name: 'High' },
          },
        ],
      };
    if (route === 'GET /repos/{owner}/{repo}/rules/branches/{branch}') return { data: [] };
    if (route === 'GET /repos/{owner}/{repo}/branches/{branch}/protection')
      return { data: { required_pull_request_reviews: { required_approving_review_count: 1 } } };
    throw new Error(`Unexpected fictional REST operation: ${route}`);
  };
  const listSubIssues = async (input: unknown) => {
    record('issues.listSubIssues', input);
    return { data: [{ number: 19 }, { number: 18 }] };
  };
  const listPulls = async (input: unknown) => {
    record('pulls.list', input);
    return { data: [pr] };
  };
  const rest = {
    request,
    issues: {
      get: async (input: unknown) => {
        record('issues.get', input);
        return { data: issue };
      },
      listSubIssues,
    },
    pulls: {
      get: async (input: unknown) => {
        record('pulls.get', input);
        return { data: pr };
      },
      list: listPulls,
    },
    repos: {
      get: async (input: unknown) => {
        record('repos.get', input);
        return { data: { full_name: 'example/widget', default_branch: 'main' } };
      },
      getCombinedStatusForRef: async (input: unknown) => {
        record('repos.getCombinedStatusForRef', input);
        return { data: { state: 'success' } };
      },
    },
    checks: {
      listForRef: async (input: unknown) => {
        record('checks.listForRef', input);
        return { data: { check_runs: [{ name: 'checks', status: 'completed', conclusion: 'success' }] } };
      },
    },
    paginate: async (method: (input: unknown) => Promise<{ data: unknown[] }>, input: unknown) => {
      assert.ok(method === listSubIssues || method === listPulls, 'Only selected read-only pagination is admitted');
      return (await method(input)).data;
    },
  };
  const graphql = async (query: string, input: Record<string, unknown> = {}) => {
    record(query.match(/(?:query|mutation)\s+(\w+)/u)?.[1] ?? 'relationships', input);
    if (query.includes('ProjectDeliveryItems'))
      return { organization: { projectV2: { id: 'PROJECT-1', items: page([item]) } } };
    if (query.includes('blockedBy(first:'))
      return {
        repository: {
          issue: {
            parent: { id: 'ISSUE11', number: 11, repository: { nameWithOwner: 'example/widget' } },
            blockedBy: page([
              {
                id: 'ISSUE13',
                number: 13,
                state: 'OPEN',
                title: 'Fictional prerequisite',
                repository: { nameWithOwner: 'example/widget' },
              },
            ]),
          },
        },
      };
    if (query.includes('DeliveryReviewDecision'))
      return { repository: { pullRequest: { headRefOid: head, reviewDecision: 'APPROVED' } } };
    return syntheticDiscoveryClients().graphql(query, input);
  };
  const create = async (input: { role: 'author' | 'reviewer'; identity: string }) => {
    assert.equal(input.identity, input.role);
    record('createDeliveryGitHubClients', { role: input.role, identity: input.identity });
    return {
      role: input.role,
      authSource: input.role === 'author' ? 'personal' : 'app',
      credentialSource: 'fictional-port',
      effectiveContentsPermission: 'write',
      rest,
      graphql,
      authenticatedAuthor: async () => {
        record('authenticatedAuthor');
        return { actorLogin: 'operator', credentialIdentity: 'user:42' };
      },
      appActorLogin: async () => {
        record('appActorLogin');
        return 'reviewer[bot]';
      },
    } as unknown as GitHubClients;
  };
  return { create, calls };
}

/** No inherited authentication environment, host home or consumer executables. */
export function freshEntrypointFixture(kind: EntrypointPolicy) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-entrypoint-')));
  const identity = lstatSync(base);
  try {
    const root = join(base, 'consumer'),
      home = join(base, 'home'),
      temp = join(base, 'tmp');
    for (const path of [root, home, temp]) mkdirSync(path, { mode: 0o700 });
    const sentinel = join(base, 'policy-executed');
    const payload = (marker: EntrypointPolicy) =>
      `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(sentinel)},JSON.stringify({marker:${JSON.stringify(marker)},module:import.meta.url}),{flag:'wx'});export const deliverySettings={};\n`;
    const tracked = payload('tracked'),
      edited = payload('edited');
    const selected = kind === 'tracked' ? tracked : edited;
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
    const env = {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      TMPDIR: temp,
      AI_DELIVERY_CONFIG: userPath,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Fictional Operator',
      GIT_AUTHOR_EMAIL: 'operator@example.invalid',
      GIT_COMMITTER_NAME: 'Fictional Operator',
      GIT_COMMITTER_EMAIL: 'operator@example.invalid',
    };
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          '-c',
          'credential.helper=',
          '-C',
          root,
          ...args,
        ],
        { env, encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
      ).trim();
    const policy = join(root, 'ai-delivery.policy.mjs');
    writeFileSync(policy, tracked);
    git('init', '-q', '-b', 'main');
    git('remote', 'add', 'origin', 'https://github.com/example/widget.git');
    git('add', '.');
    git('commit', '-qm', 'Fictional consumer policy');
    const head = git('rev-parse', 'HEAD');
    if (kind === 'edited') writeFileSync(policy, edited);
    assert.equal(git('show', 'HEAD:ai-delivery.policy.mjs'), tracked.trim());
    assert.equal(git('show', ':ai-delivery.policy.mjs'), tracked.trim());
    assert.equal(readFileSync(policy, 'utf8'), selected);
    assert.equal(git('status', '--porcelain'), kind === 'edited' ? 'M ai-delivery.policy.mjs' : '');
    const assertInert = () =>
      assert.equal(existsSync(sentinel), false, 'Consumer policy was executed by a public entrypoint');
    const assertBound = () => {
      assert.equal(git('rev-parse', 'HEAD'), head);
      assert.equal(git('show', 'HEAD:ai-delivery.policy.mjs'), tracked.trim());
      assert.equal(git('show', ':ai-delivery.policy.mjs'), tracked.trim());
      assert.equal(readFileSync(policy, 'utf8'), selected);
    };
    const cleanup = () => {
      const current = lstatSync(base);
      assert.equal(realpathSync(base), base);
      assert.equal(current.isSymbolicLink(), false);
      assert.equal(current.dev, identity.dev);
      assert.equal(current.ino, identity.ino);
      rmSync(base, { recursive: true });
      assert.equal(existsSync(base), false);
    };
    return {
      base,
      root,
      home,
      head,
      env,
      sentinel,
      policy,
      tracked,
      selected,
      assertInert,
      assertBound,
      cleanup,
      payloadSha256: digestBytes(Buffer.from(selected)),
      indexedSha256: digestBytes(Buffer.from(tracked)),
    };
  } catch (error) {
    const current = lstatSync(base);
    assert.equal(current.dev, identity.dev);
    assert.equal(current.ino, identity.ino);
    assert.equal(current.isSymbolicLink(), false);
    rmSync(base, { recursive: true });
    throw error;
  }
}
