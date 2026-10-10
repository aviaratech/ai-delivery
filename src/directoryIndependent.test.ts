import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, unlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, vi } from 'vitest';

import { loadDeliveryConfig, loadDeliverySettings } from './config/deliveryConfig.js';
import * as githubClients from './github/client.js';
import * as repository from './github/repo.js';
import * as gitCommands from './git.js';
import { executeTool } from './dispatch.js';
import { createAiDeliveryMcpServer, AI_DELIVERY_MCP_TOOLS } from './mcp/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { syntheticDiscoveryClients, syntheticDiscoveryConfig } from './fixtures/discovery.js';

const userSettings = {
  schemaVersion: 'ai-delivery.user@1',
  roles: {
    author: { authSource: 'personal', identity: 'host-author', credentialEnv: { token: 'SYNTHETIC_TOKEN' } },
    reviewer: {
      identity: 'app-reviewer',
      credentialEnv: { appId: 'APP_ID', installationId: 'INSTALLATION_ID', privateKeyPath: 'KEY_PATH' },
    },
  },
  project: 1,
  checkoutRoots: [],
  pointsField: 'Estimate',
  priorityField: 'Urgency',
  statusField: 'Flow',
  statuses: { blocked: 'Waiting', done: 'Shipped', inProgress: 'Active', todo: 'Queued' },
};

describe('directory-independent user configuration', () => {
  it('resolves an explicit repository in a non-Git directory without repository policy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'delivery-directory-'));
    const previous = process.env.AI_DELIVERY_CONFIG;
    try {
      process.env.AI_DELIVERY_CONFIG = join(root, 'user.json');
      writeFileSync(process.env.AI_DELIVERY_CONFIG, JSON.stringify(userSettings));
      const loaded = await loadDeliveryConfig(root, {
        repository: 'example/widget',
        clients: syntheticDiscoveryClients(syntheticDiscoveryConfig),
      } as never);
      assert.equal(loaded.config.repository, 'example/widget');
      assert.equal(loaded.config.roles.author.identity, 'host-author');
      assert.equal(loaded.configPath, process.env.AI_DELIVERY_CONFIG);
      assert.equal('policy' in loaded.config, false);
    } finally {
      if (previous === undefined) delete process.env.AI_DELIVERY_CONFIG;
      else process.env.AI_DELIVERY_CONFIG = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never imports a tracked hostile policy while resolving a local checkout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'delivery-hostile-'));
    const previous = process.env.AI_DELIVERY_CONFIG;
    const sentinel = join(root, 'executed');
    try {
      execFileSync('git', ['init', '--quiet', root]);
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/widget.git'], { cwd: root });
      writeFileSync(
        join(root, 'ai-delivery.policy.mjs'),
        `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(sentinel)},'executed');export const deliverySettings={};`,
      );
      execFileSync('git', ['add', 'ai-delivery.policy.mjs'], { cwd: root });
      process.env.AI_DELIVERY_CONFIG = join(root, 'user.json');
      writeFileSync(process.env.AI_DELIVERY_CONFIG, JSON.stringify(userSettings));
      await loadDeliverySettings(root);
      for (const body of ['tracked', 'edited']) {
        writeFileSync(
          join(root, 'ai-delivery.policy.mjs'),
          `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(sentinel)},${JSON.stringify(body)});export const deliverySettings={};`,
        );
        await loadDeliveryConfig(root, {
          repository: 'example/widget',
          clients: syntheticDiscoveryClients(syntheticDiscoveryConfig),
        });
      }
      assert.equal(existsSync(sentinel), false);
    } finally {
      if (previous === undefined) delete process.env.AI_DELIVERY_CONFIG;
      else process.env.AI_DELIVERY_CONFIG = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('names a missing user setting before accessing Git or credentials', async () => {
    const root = mkdtempSync(join(tmpdir(), 'delivery-setting-'));
    const previous = process.env.AI_DELIVERY_CONFIG;
    try {
      process.env.AI_DELIVERY_CONFIG = join(root, 'user.json');
      writeFileSync(process.env.AI_DELIVERY_CONFIG, JSON.stringify({ ...userSettings, roles: {} }));
      await assert.rejects(loadDeliverySettings(root), /roles.author/u);
    } finally {
      if (previous === undefined) delete process.env.AI_DELIVERY_CONFIG;
      else process.env.AI_DELIVERY_CONFIG = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

for (const path of [
  'schemaVersion',
  'roles.author',
  'roles.reviewer',
  'roles.author.identity',
  'roles.reviewer.identity',
  'roles.author.credentialEnv',
  'roles.reviewer.credentialEnv',
  'project',
  'checkoutRoots',
  'roles.author.credentialEnv.token',
  'roles.reviewer.credentialEnv.appId',
  'roles.reviewer.credentialEnv.installationId',
  'roles.reviewer.credentialEnv.privateKeyPath',
]) {
  it(`names missing ${path} in operator settings`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'delivery-required-'));
    vi.stubEnv('AI_DELIVERY_CONFIG', join(root, 'user.json'));
    const settings = structuredClone(userSettings) as unknown as Record<string, unknown>;
    const keys = path.split('.');
    let target = settings;
    for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
    delete target[keys.at(-1)!];
    writeFileSync(process.env.AI_DELIVERY_CONFIG!, JSON.stringify(settings));
    try {
      await assert.rejects(
        loadDeliverySettings(root),
        (error) => error instanceof Error && error.message.includes(path),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('per-call repository selection', () => {
  it('selects matching origins A → B → A, prefers a matching current checkout and refuses ambiguous clones', () => {
    const root = mkdtempSync(join(tmpdir(), 'delivery-checkouts-'));
    const clone = (name: string, repo: string) => {
      const path = join(root, name);
      execFileSync('git', ['init', '-q', path]);
      execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${repo}.git`], { cwd: path });
      return path;
    };
    try {
      const a = clone('a', 'example/a'),
        b = clone('b', 'example/b');
      const input = { launchDirectory: root, checkoutRoots: [root] };
      assert.equal(repository.resolveCheckout({ ...input, repository: 'example/a' }), a);
      assert.equal(repository.resolveCheckout({ ...input, repository: 'example/b' }), b);
      assert.equal(repository.resolveCheckout({ ...input, repository: 'example/a' }), a);
      clone('a-duplicate', 'example/a');
      assert.throws(() => repository.resolveCheckout({ ...input, repository: 'example/a' }), /ambiguous/u);
      assert.equal(repository.resolveCheckout({ ...input, repository: 'example/a', launchDirectory: a }), a);
      assert.throws(() => repository.resolveCheckout({ ...input, repository: 'example/missing' }), /no matching/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not execute checkout filters or fsmonitor during local Git probes', () => {
    const root = mkdtempSync(join(tmpdir(), 'delivery-hostile-git-'));
    const sentinel = join(root, 'executed');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root });
    try {
      git('init', '-q');
      git('config', 'user.name', 'Synthetic');
      git('config', 'user.email', 'synthetic@example.test');
      writeFileSync(join(root, '.gitattributes'), '*.txt filter=hostile\n');
      writeFileSync(join(root, 'change.txt'), 'original');
      git('add', '.');
      git('commit', '-qm', 'fixture');
      const script = join(root, 'hostile.cjs');
      writeFileSync(
        script,
        `require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'executed');process.stdin.pipe(process.stdout);`,
      );
      git('config', 'filter.hostile.clean', `${process.execPath} ${script}`);
      git('config', 'filter.hostile.smudge', `${process.execPath} ${script}`);
      git('config', 'core.fsmonitor', `${process.execPath} ${script}`);
      mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
      writeFileSync(join(root, 'change.txt'), 'changed');
      git('hash-object', '--path', 'change.txt', 'change.txt');
      assert.equal(existsSync(sentinel), true, 'fixture filter must be executable before the protected probe');
      unlinkSync(sentinel);
      gitCommands.git(root, 'hash-object', '--path', 'change.txt', 'change.txt');
      assert.throws(() => gitCommands.assertClean(root));
      assert.equal(existsSync(sentinel), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('routes PRs and journals through one MCP server A → B → A without launch Git or identity environment', async () => {
    const root = mkdtempSync(join(tmpdir(), 'delivery-mcp-routing-'));
    const visited: string[] = [];
    const journalTargets: string[] = [];
    const stored: { id: number; body: string; html_url: string; issue_url: string; user: { login: string } }[] = [];
    let authorCalls = 0;
    vi.stubEnv('AI_DELIVERY_CONFIG', join(root, 'user.json'));
    vi.stubEnv('AI_DELIVERY_IDENTITY', '');
    writeFileSync(process.env.AI_DELIVERY_CONFIG!, JSON.stringify(userSettings));
    vi.spyOn(repository, 'resolveRepoFromRemote').mockImplementation(() => {
      throw new Error('launch Git must never run');
    });
    vi.spyOn(gitCommands, 'git').mockImplementation(() => {
      throw new Error('launch Git must never run');
    });
    vi.spyOn(githubClients, 'createDeliveryGitHubClients').mockImplementation(
      async (input) =>
        ({
          role: input.role,
          authSource: 'personal',
          authenticatedAuthor: async () => {
            authorCalls += 1;
            return { actorLogin: 'operator', credentialIdentity: 'user:1' };
          },
          graphql: (async (query: string, variables: Record<string, unknown>) => {
            const repo = typeof variables.repo === 'string' ? variables.repo : 'a';
            return syntheticDiscoveryClients({ ...syntheticDiscoveryConfig, repository: `example/${repo}` }).graphql(
              query,
              variables,
            );
          }) as githubClients.GitHubClients['graphql'],
          rest: {
            issues: {
              get: async (input: { owner: string; repo: string; issue_number: number }) => {
                journalTargets.push(`${input.owner}/${input.repo}`);
                return { data: { number: input.issue_number } };
              },
              listComments: async (input: { owner: string; repo: string; issue_number: number }) => ({
                data: stored.filter(
                  (comment) =>
                    comment.issue_url ===
                    `https://api.github.com/repos/${input.owner}/${input.repo}/issues/${String(input.issue_number)}`,
                ),
              }),
              createComment: async (input: { owner: string; repo: string; issue_number: number; body: string }) => {
                const id = 101 + stored.length;
                const data = {
                  id,
                  body: input.body,
                  html_url: `https://github.com/${input.owner}/${input.repo}/issues/${String(input.issue_number)}#issuecomment-${String(id)}`,
                  issue_url: `https://api.github.com/repos/${input.owner}/${input.repo}/issues/${String(input.issue_number)}`,
                  user: { login: 'operator' },
                };
                stored.push(data);
                return { data };
              },
              getComment: async (input: { owner: string; repo: string; comment_id: number }) => ({
                data: stored.find(
                  (comment) =>
                    comment.id === input.comment_id &&
                    comment.issue_url === `https://api.github.com/repos/${input.owner}/${input.repo}/issues/17`,
                ),
              }),
            },
            pulls: {
              get: async (input: { owner: string; repo: string; pull_number: number }) => {
                visited.push(`${input.owner}/${input.repo}`);
                return {
                  data: {
                    number: input.pull_number,
                    head: { sha: 'a'.repeat(40), ref: 'issue/17', repo: { full_name: `${input.owner}/${input.repo}` } },
                    base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: `${input.owner}/${input.repo}` } },
                    state: 'open',
                    merged: false,
                    draft: true,
                    html_url: `https://github.com/${input.owner}/${input.repo}/pull/23`,
                  },
                };
              },
            },
          },
        }) as unknown as githubClients.GitHubClients,
    );
    const server = createAiDeliveryMcpServer({ repoRoot: root });
    const client = new Client({ name: 'directory-fixture', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const journal = {
      issueNumber: 17,
      kind: 'progress',
      summary: 'Validation is implemented.',
      status: 'In progress',
      done: ['Added validation'],
      decisionNeeded: 'None',
      keyNumbers: [],
      evidence: ['https://github.com/example/widget/pull/23'],
      nextStep: 'Review',
      nextDate: '2026-10-09',
    };
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      for (const repo of ['example/a', 'example/b', 'example/a']) {
        const response = await client.callTool({ name: 'issue_pr_info', arguments: { repo, prNumber: 23 } });
        assert.equal(response.isError, undefined);
        const comment = await client.callTool({ name: 'issue_comment', arguments: { ...journal, repo } });
        assert.equal(comment.isError, undefined, JSON.stringify(comment));
        assert.match(
          JSON.stringify(comment),
          new RegExp(`https://github.com/${repo}/issues/17#issuecomment-10[12]`, 'u'),
        );
      }
      await executeTool('issue_pr_info', { repo: 'example/b', prNumber: 23 }, { repoRoot: root });
      assert.deepEqual(visited, ['example/a', 'example/b', 'example/a', 'example/b']);
      assert.deepEqual(journalTargets, ['example/a', 'example/b', 'example/a']);
      assert.equal(stored.length, 2, 'A retry reuses its own journal, without leaking repository B');
      const beforeInvalid = vi.mocked(githubClients.createDeliveryGitHubClients).mock.calls.length;
      const beforeInvalidAuthor = authorCalls;
      for (const invalid of [
        { ...journal, repo: 'example/a', unknown: true },
        { ...journal, repo: 'example/a', outcome: 'Wrong variant' },
        { ...journal, repo: 'example/a', kind: 'unsupported' },
        { ...journal, repo: 'example/a', nextDate: '2026-02-30' },
        { ...journal, repo: 'invalid' },
      ]) {
        const refused = await client.callTool({ name: 'issue_comment', arguments: invalid }).then(
          (result) => result.isError === true,
          () => true,
        );
        assert.equal(refused, true);
      }
      const fixedServer = createAiDeliveryMcpServer({ repoRoot: root, repo: 'example/a' });
      const fixedClient = new Client({ name: 'fixed-repository-fixture', version: '1' });
      const [fixedClientTransport, fixedServerTransport] = InMemoryTransport.createLinkedPair();
      try {
        await fixedServer.connect(fixedServerTransport);
        await fixedClient.connect(fixedClientTransport);
        const conflict = await fixedClient.callTool({
          name: 'issue_comment',
          arguments: { ...journal, repo: 'example/b' },
        });
        assert.equal(conflict.isError, true);
        assert.match(JSON.stringify(conflict), /selectors disagree/u);
        assert.equal(vi.mocked(githubClients.createDeliveryGitHubClients).mock.calls.length, beforeInvalid);
        assert.equal(authorCalls, beforeInvalidAuthor, 'refusals precede authentication');
        assert.equal(stored.length, 2, 'refusals do not write');
        assert.deepEqual(journalTargets, ['example/a', 'example/b', 'example/a'], 'refusals do not read a target');
        const inherited = await fixedClient.callTool({ name: 'issue_comment', arguments: journal });
        assert.equal(inherited.isError, undefined, JSON.stringify(inherited));
        const readback = JSON.parse((inherited.content as { text: string }[])[0]!.text) as {
          url: string;
          reused: boolean;
        };
        assert.equal(readback.url, 'https://github.com/example/a/issues/17#issuecomment-101');
        assert.equal(readback.reused, true, 'omitting repo uses the fixed server selector');
      } finally {
        await fixedClient.close();
        await fixedServer.close();
      }
      assert.equal(stored.length, 2, 'inheriting the server selector reuses repository A');
      assert.deepEqual(journalTargets, ['example/a', 'example/b', 'example/a', 'example/a']);
      assert.equal(vi.mocked(repository.resolveRepoFromRemote).mock.calls.length, 0);
      const names = AI_DELIVERY_MCP_TOOLS.map((tool) => tool.name as string);
      for (const removed of ['issue_develop', 'issue_verify', 'issue_worktree_create'])
        assert.equal(names.includes(removed), false);
      for (const retained of [
        'runtime_stage',
        'runtime_admit',
        'issue_worktree_transition_inspect',
        'issue_worktree_transition_apply',
      ])
        assert.equal(names.includes(retained), true);
    } finally {
      await client.close();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
