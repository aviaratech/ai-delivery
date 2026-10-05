import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import {
  cpSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, test, vi } from 'vitest';
import { syntheticDiscoveryClients, syntheticOverrides } from './fixtures/discovery.js';
import { Octokit } from '@octokit/rest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { AI_DELIVERY_MCP_TOOLS } from './mcp/tools.js';
import { createAiDeliveryMcpServer } from './mcp/index.js';
import { loadDeliveryConfig, parseDeliveryConfig } from './config/deliveryConfig.js';
import { digestValue, stableJson } from './delivery/index.js';
import { contextFor, executeTool, resumedIssueUpdate, startTrackedIssue } from './dispatch.js';
import { defaultBaseRef, gitCommonDir } from './git.js';
import * as githubClient from './github/client.js';
import * as atomicJson from './utils/atomicJson.js';
import {
  createIssue,
  developIssue,
  listIssueSubissues,
  readyCheck,
  resumeCreatedIssue,
  updateIssue,
  type DeliveryContext,
} from './issue.js';
import { checkoutPr, finishIssue, listPrs, mergePr, prChecks, prInfo, publishPr, submitFormalReview } from './pr.js';
import {
  addWorktreeEntry,
  assertNativeIssueTrackingAdmission,
  getIssueWorktreeStrict,
  removeWorktreeEntry,
  updateIssueWorktreeDelivery,
} from './services/worktreeRegistry.js';
import { assertDeliveryRuntimeAdmitted } from './services/deliveryAdmission.js';
import { getDeliveryRecords } from './services/deliveryRecordService.js';
import { createIssuePhaseEvidence, loadVerifiedRun, verifyIssue } from './verification.js';
import {
  cleanupNonIssueWorktree,
  prepareIssueWorktree,
  preparePrWorktree,
  prepareStandaloneWorktree,
} from './worktree.js';

const personalRoute = vi.hoisted(() => ({
  active: false,
  baseSha: '',
  headSha: '',
  reviews: [] as Array<{
    id: number;
    body: string;
    state: 'APPROVED';
    commit_id: string;
    user: { login: string };
    html_url: string;
  }>,
  submitted: 0,
  created: false,
  failCreate: false,
  ready: false,
  readyPromotions: 0,
}));

vi.mock('./github/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./github/client.js')>();
  return {
    ...actual,
    createDeliveryGitHubClients: async (input: Parameters<typeof actual.createDeliveryGitHubClients>[0]) => {
      if (personalRoute.active && input.config.roles.author.authSource === 'personal') {
        const pr = () => ({
          number: 23,
          node_id: 'PR-23',
          html_url: 'https://github.com/example/widget/pull/23',
          head: { sha: personalRoute.headSha, ref: 'issue/17' },
          base: { sha: personalRoute.baseSha, ref: 'main' },
          state: 'open',
          draft: !personalRoute.ready,
          user: { login: 'host-user' },
        });
        if (input.role === 'reviewer') {
          assert.equal(input.identity, 'synthetic-reviewer');
          return {
            ...syntheticDiscoveryClients(),
            authSource: 'app',
            credentialSource: 'app:reviewer',
            role: 'reviewer',
            appActorLogin: async () => 'synthetic-reviewer[bot]',
            rest: {
              repos: { get: async () => ({ data: { full_name: 'example/widget' } }) },
              pulls: {
                get: async () => ({ data: pr() }),
                listReviews: async () => ({ data: personalRoute.reviews }),
                createReview: async (request: { body: string; commit_id: string; event: string }) => {
                  assert.equal(request.event, 'APPROVE');
                  assert.equal(request.commit_id, personalRoute.headSha);
                  personalRoute.submitted += 1;
                  const review = {
                    id: 31,
                    body: request.body,
                    state: 'APPROVED' as const,
                    commit_id: personalRoute.headSha,
                    user: { login: 'synthetic-reviewer[bot]' },
                    html_url: 'https://github.com/example/widget/pull/23#pullrequestreview-31',
                  };
                  personalRoute.reviews.push(review);
                  return { data: review };
                },
              },
            },
            graphql: async (query: string, variables: Record<string, unknown>) => {
              if (query.includes('DeliveryReviewDecision')) {
                return {
                  repository: {
                    pullRequest: { headRefOid: personalRoute.headSha, reviewDecision: 'REVIEW_REQUIRED' },
                  },
                };
              }
              if (query.includes('DeliveryReviewAccess')) {
                return {
                  repository: {
                    pullRequest: {
                      reviews: {
                        nodes: personalRoute.reviews.map((review) => ({
                          fullDatabaseId: String(review.id),
                          author: { login: review.user.login.replace(/\[bot\]$/u, '') },
                          authorCanPushToRepository: false,
                          commit: { oid: review.commit_id },
                          state: review.state,
                        })),
                      },
                    },
                  },
                };
              }
              if (
                query.includes('DeliveryDiscovery') ||
                query.includes('DeliveryRepository') ||
                query.includes('ProjectDeliveryConfiguration')
              ) {
                throw Object.assign(new Error('Reviewer cannot discover author routing metadata'), { status: 403 });
              }
              return syntheticDiscoveryClients().graphql(query, variables);
            },
          };
        }
        assert.equal(input.identity, 'host-author');
        const clients = await actual.createDeliveryGitHubClients({
          ...input,
          env: { AUTHOR_TOKEN: 'selected-personal-token', GH_TOKEN: 'ambient-token' },
        });
        Object.assign(clients, {
          authenticatedAuthor: async () => ({ actorLogin: 'host-user', credentialIdentity: 'user:37' }),
          graphql: async (query: string, variables: Record<string, unknown>) => {
            if (query.includes('markPullRequestReadyForReview')) {
              personalRoute.ready = true;
              personalRoute.readyPromotions += 1;
              return { markPullRequestReadyForReview: { pullRequest: { id: 'PR-23', isDraft: false } } };
            }
            return syntheticDiscoveryClients().graphql(query, variables);
          },
          rest: {
            issues: { get: async () => ({ data: { title: 'Synthetic issue' } }) },
            git: { getRef: async () => ({ data: { object: { sha: personalRoute.baseSha } } }) },
            pulls: {
              list: async () => ({ data: personalRoute.created ? [pr()] : [] }),
              create: async () => {
                if (personalRoute.failCreate) {
                  personalRoute.failCreate = false;
                  throw new Error('Synthetic response lost after branch push');
                }
                personalRoute.created = true;
                return { data: pr() };
              },
              get: async () => ({ data: pr() }),
              listReviews: async () => ({ data: personalRoute.reviews }),
            },
            request: async () => Promise.reject(Object.assign(new Error('Rules unreadable'), { status: 403 })),
          },
        });
        return clients;
      }
      const rest = new Octokit({
        request: {
          fetch: async () => {
            throw new Error('Unexpected network request in synthetic lifecycle test.');
          },
        },
      });
      if (input.role === 'reviewer') {
        Object.assign(rest.repos, { get: async () => ({ data: { full_name: 'example/widget' } }) });
      }
      return {
        ...syntheticDiscoveryClients(),
        authSource: input.role === 'author' && input.config.roles.author.authSource === 'personal' ? 'personal' : 'app',
        role: input.role,
        ...(input.role === 'author'
          ? {
              authenticatedAuthor: async () => ({
                actorLogin: input.config.roles.author.authSource === 'personal' ? 'host-user' : 'synthetic-author[bot]',
                credentialIdentity: input.config.roles.author.authSource === 'personal' ? 'user:37' : 'app:201',
              }),
              credentialSource: input.config.roles.author.authSource === 'personal' ? 'env:AUTHOR_TOKEN' : 'app:author',
            }
          : {}),
        ...(input.role === 'reviewer'
          ? { appActorLogin: async () => 'synthetic-reviewer', credentialSource: 'app:reviewer' }
          : {}),
        rest,
      };
    },
  };
});

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function sha256(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function directoryHash(path: string): string {
  const entries: { path: string; sha256: string }[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const child = join(directory, entry.name);
      if (entry.isDirectory()) visit(child, relative);
      else if (entry.isFile()) entries.push({ path: relative, sha256: sha256(child) });
      else throw new Error('Synthetic backup contains an unsupported file type.');
    }
  };
  visit(path, '');
  return digestValue(entries);
}

async function fixture(
  options: {
    twoStages?: boolean;
    serialResourceStages?: boolean;
    remote?: string;
    divergentOrigin?: boolean;
    firstStageScript?: string;
    secondStageScript?: string;
    personalAuthor?: boolean;
    componentPolicy?: boolean;
    omitRuntimeAdmission?: boolean;
  } = {},
): Promise<{
  root: string;
  counter: string;
  secondCounter: string;
  thirdCounter: string;
  failSecond: string;
  runtimeEntryPath: string;
}> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-lifecycle-')));
  const remoteName = options.remote ?? 'origin';
  const counter = join(root, '.git', 'stage-count.txt');
  const secondCounter = join(root, '.git', 'second-stage-count.txt');
  const thirdCounter = join(root, '.git', 'third-stage-count.txt');
  const failSecond = join(root, '.git', 'fail-second-stage');
  try {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Synthetic Delivery');
    git(root, 'config', 'user.email', 'delivery@example.test');
    git(root, 'init', '--bare', '-q', join(root, '.git', 'remote.git'));
    git(root, 'remote', 'add', remoteName, join(root, '.git', 'remote.git'));
    writeFileSync(join(root, '.gitignore'), '.issue-cli/\n.worktrees/\n');
    writeFileSync(join(root, 'artifact.txt'), 'synthetic proof\n');
    if (options.componentPolicy) writeFileSync(join(root, 'component.txt'), 'second component\n');
    const config = {
      commandPolicy: {
        checks: { format: 'REQUIRED', gitClean: 'REQUIRED', lint: 'REQUIRED', test: 'REQUIRED', typecheck: 'REQUIRED' },
        timeoutsMs: { lint: 60000, test: 60000, typecheck: 60000 },
      },
      native: {
        issueTypes: ['Task'],
        milestones: 'repository',
        organization: 'example',
        points: { databaseId: '101', name: 'Estimate', values: ['1', '2', '4'] },
        priority: { databaseId: '102', name: 'Urgency', values: ['High', 'Low'] },
        project: {
          number: 1,
          statuses: { blocked: 'Waiting', done: 'Shipped', inProgress: 'Active', todo: 'Queued' },
          statusField: 'Flow',
          title: 'Delivery',
        },
        relationships: { blockedBy: 'native', parent: 'native' },
      },
      policy: { contract: 'RepositoryDeliveryPolicy@1', module: './policy.mjs' },
      repository: 'example/widget',
      roles: {
        author: options.personalAuthor
          ? { authSource: 'personal', credentialEnv: { token: 'AUTHOR_TOKEN' }, identity: 'host-author' }
          : {
              credentialEnv: {
                appId: 'AUTHOR_APP_ID',
                installationId: 'AUTHOR_INSTALLATION_ID',
                privateKeyPath: 'AUTHOR_KEY_PATH',
              },
              identity: 'synthetic-author',
            },
        reviewer: {
          credentialEnv: {
            appId: 'REVIEWER_APP_ID',
            installationId: 'REVIEWER_INSTALLATION_ID',
            privateKeyPath: 'REVIEWER_KEY_PATH',
          },
          identity: 'synthetic-reviewer',
        },
      },
      schemaVersion: 'ai-delivery.config@2',
    };
    writeFileSync(
      join(root, 'ai-delivery.config.json'),
      `${JSON.stringify({ ...syntheticOverrides(parseDeliveryConfig(config)), ...(options.divergentOrigin ? { remote: remoteName } : {}) })}\n`,
    );
    writeFileSync(
      join(root, 'policy.mjs'),
      `
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const stable = value => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
  : value !== null && typeof value === 'object'
    ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}'
    : JSON.stringify(value);
const digest = value => 'sha256:' + createHash('sha256').update(stable(value)).digest('hex');
const bytes = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const policyDigest = bytes(readFileSync(fileURLToPath(import.meta.url)));
export const deliverySettings = ${JSON.stringify({ roles: config.roles, commandPolicy: config.commandPolicy })};
export default {
  schemaVersion: '${options.componentPolicy ? 'RepositoryDeliveryPolicy@2' : 'RepositoryDeliveryPolicy@1'}',
  classifyExactRange(input) {
    const content = { artifacts: [{ digest: bytes(readFileSync(new URL('./artifact.txt', import.meta.url))),
      path: 'artifact.txt', producer: 'synthetic' }],
      base: { sha: input.baseSha, tree: input.baseTree }, configDigest: input.configDigest,
      head: { sha: input.headSha, tree: input.headTree }, opaquePayload: 'synthetic proof',
      policyDigest, producer: 'synthetic', repository: input.repository,
      schemaVersion: 'ai-delivery.policy-evidence@1' };
    return { policyDigest, policyEvidence: { ...content, evidenceId: digest(content) },
      requiredStages: [{ id: 'check', dependsOn: [], semanticInputKeys: ['source'],
        ${options.componentPolicy ? "semanticInputs: [{ key: 'source', digest: bytes(readFileSync(new URL('./artifact.txt', import.meta.url))) }]," : ''}
        resourceClass: 'source_only', commands: [{ label: 'count', argv: [process.execPath, '-e',
          ${JSON.stringify(options.firstStageScript ?? `const fs=require('fs');const p=${JSON.stringify(counter)};fs.writeFileSync(p,String(Number(fs.existsSync(p)?fs.readFileSync(p,'utf8'):0)+1));`)}] }] }${
            options.twoStages || options.serialResourceStages
              ? `, { id: 'second', dependsOn: ['check'], semanticInputKeys: ['source'],
        ${options.componentPolicy ? "semanticInputs: [{ key: 'source', digest: bytes(readFileSync(new URL('./component.txt', import.meta.url))) }]," : ''}
        resourceClass: '${options.serialResourceStages ? 'model' : 'source_only'}', commands: [{ label: 'retry', argv: [process.execPath, '-e',
          ${JSON.stringify(options.secondStageScript ?? `const fs=require('fs');const p=${JSON.stringify(secondCounter)};fs.writeFileSync(p,String(Number(fs.existsSync(p)?fs.readFileSync(p,'utf8'):0)+1));if(fs.existsSync(${JSON.stringify(failSecond)}))process.exit(7);`)}] }] }`
              : ''
          }${
            options.serialResourceStages
              ? `, { id: 'postgres', dependsOn: ['second'], semanticInputKeys: ['source'],
        ${options.componentPolicy ? "semanticInputs: [{ key: 'source', digest: bytes(readFileSync(new URL('./component.txt', import.meta.url))) }]," : ''}
        resourceClass: 'postgres_docker', commands: [{ label: 'count', argv: [process.execPath, '-e',
          ${JSON.stringify(`const fs=require('fs');const p=${JSON.stringify(thirdCounter)};fs.writeFileSync(p,String(Number(fs.existsSync(p)?fs.readFileSync(p,'utf8'):0)+1));`)}] }] }`
              : ''
          }],
      risk: 'standard' };
  },
  validateBoundary(input) {
    const content = { additionalConstraints: { exactBaseHeadLease: true, requiredAttestationIds: [] },
      classificationReceiptId: input.classificationReceiptId, configDigest: input.configDigest,
      currentBase: input.currentBase, currentHead: input.currentHead, phase: input.phase,
      policyEvidenceId: input.policyEvidence.evidenceId, schemaVersion: 'ai-delivery.policy-boundary@1',
      stageReceiptSetHash: digest(input.stageReceiptIds) };
    return { ...content, boundaryId: digest(content) };
  },
};
`,
    );
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'synthetic base');
    git(root, 'push', '-q', remoteName, 'main');
    git(root, 'fetch', '-q', remoteName, 'main');
    git(root, 'config', `url.${join(root, '.git', 'remote.git')}.insteadOf`, 'https://github.com/example/widget.git');
    git(root, 'remote', 'set-url', remoteName, 'https://github.com/example/widget.git');
    if (options.divergentOrigin) {
      git(root, 'remote', 'add', 'origin', 'https://github.com/other/unrelated.git');
      const unrelated = git(root, 'commit-tree', 'HEAD^{tree}', '-m', 'Unrelated origin root');
      git(root, 'update-ref', 'refs/remotes/origin/main', unrelated);
      git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    }
    const runtimeRoot = join(root, '.git', 'synthetic-runtime');
    const runtimeEntryPath = join(runtimeRoot, 'package', 'dist', 'cli.js');
    const packagePath = join(runtimeRoot, 'package', 'package.json');
    const mcpLauncherPath = join(runtimeRoot, 'plugin', 'dist', 'mcp-launcher.js');
    const pluginManifestPath = join(runtimeRoot, 'plugin', '.claude-plugin', 'plugin.json');
    for (const path of [runtimeEntryPath, packagePath, mcpLauncherPath, pluginManifestPath]) {
      mkdirSync(dirname(path), { recursive: true });
    }
    writeFileSync(runtimeEntryPath, 'synthetic CLI bytes\n');
    writeFileSync(
      packagePath,
      JSON.stringify({ name: '@aviaratech/ai-delivery', version: '0.1.0', bin: { 'ai-delivery': './dist/cli.js' } }),
    );
    writeFileSync(mcpLauncherPath, 'synthetic MCP launcher bytes\n');
    writeFileSync(
      pluginManifestPath,
      JSON.stringify({ name: 'ai-delivery', packageVersion: '0.1.0', deliveryCapabilityVersion: 2 }),
    );
    const content = {
      capability: { cli: 2, mcp: 2 },
      cliPath: runtimeEntryPath,
      cliSha256: sha256(runtimeEntryPath),
      configDigest: (await loadDeliveryConfig(root)).configDigest,
      mcpLauncherPath,
      mcpLauncherSha256: sha256(mcpLauncherPath),
      packageVersion: '0.1.0',
      packageDistSha256: digestValue([{ path: 'cli.js', sha256: sha256(runtimeEntryPath) }]),
      packageManifestSha256: sha256(packagePath),
      pluginManifestPath,
      pluginManifestSha256: sha256(pluginManifestPath),
      repository: 'example/widget',
      schemaVersion: 'ai-delivery.runtime-admission@2',
      sourceArchiveSha256: digestValue('synthetic archive'),
      sourceCommit: git(root, 'rev-parse', 'HEAD'),
    };
    const admissionPath = join(root, '.git', 'ai-delivery', 'runtime-admission.json');
    mkdirSync(dirname(admissionPath), { recursive: true });
    if (!options.omitRuntimeAdmission)
      writeFileSync(admissionPath, JSON.stringify({ ...content, admissionId: digestValue(content) }), { mode: 0o600 });
    return { root, counter, secondCounter, thirdCounter, failSecond, runtimeEntryPath };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

test('published package and bundled plugin agree on the admission version', () => {
  const packageManifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  const pluginManifest = JSON.parse(
    readFileSync(new URL('../plugins/ai-delivery/.claude-plugin/plugin.json', import.meta.url), 'utf8'),
  ) as { packageVersion: string };
  assert.equal(pluginManifest.packageVersion, packageManifest.version);
});

test('installed CLI and MCP admission fails before a worktree mutation on source or capability drift', async () => {
  const { root, runtimeEntryPath } = await fixture();
  try {
    const input = { repoRoot: root, runtimeEntryPath, identity: 'synthetic-author' };
    const path = join(root, '.git', 'ai-delivery', 'runtime-admission.json');
    const original = readFileSync(path, 'utf8');
    assert.equal((await assertDeliveryRuntimeAdmitted(input)).capability.mcp, 2);
    const changedModule = join(dirname(runtimeEntryPath), 'mutated.js');
    writeFileSync(changedModule, 'unadmitted module bytes\n');
    await assert.rejects(assertDeliveryRuntimeAdmitted(input), /source, capability or repository admission/u);
    rmSync(changedModule);
    rmSync(path);
    await assert.rejects(
      executeTool('issue_worktree_create', { name: 'scratch-admission', branch: 'scratch/admission' }, input),
      /runtime admission/u,
    );
    assert.equal(existsSync(join(root, '.worktrees', 'scratch-admission')), false);
    writeFileSync(path, original, { mode: 0o600 });
    const launcherPath = join(root, '.git', 'synthetic-runtime', 'plugin', 'dist', 'mcp-launcher.js');
    writeFileSync(launcherPath, 'different MCP bytes\n');
    await assert.rejects(
      executeTool('issue_worktree_create', { name: 'scratch-admission', branch: 'scratch/admission' }, input),
      /source, capability or repository admission/u,
    );
    assert.equal(existsSync(join(root, '.worktrees', 'scratch-admission')), false);
    const admission = JSON.parse(original) as Record<string, unknown>;
    const { admissionId: _old, ...content } = admission;
    const mismatched = { ...content, mcpLauncherSha256: sha256(launcherPath), capability: { cli: 1, mcp: 2 } };
    writeFileSync(path, JSON.stringify({ ...mismatched, admissionId: digestValue(mismatched) }));
    await assert.rejects(assertDeliveryRuntimeAdmitted(input), /source, capability or repository admission/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('effective policy settings drift invalidates admission even when the policy wrapper is unchanged', async () => {
  const { root, runtimeEntryPath } = await fixture();
  const policyPath = join(root, 'policy.mjs');
  const authorEnv = 'AI_DELIVERY_TEST_DYNAMIC_AUTHOR';
  const checkEnv = 'AI_DELIVERY_TEST_DYNAMIC_CHECK';
  const previousAuthor = process.env[authorEnv];
  const previousCheck = process.env[checkEnv];
  try {
    delete process.env[authorEnv];
    delete process.env[checkEnv];
    writeFileSync(
      policyPath,
      readFileSync(policyPath, 'utf8') +
        `
Object.defineProperty(deliverySettings.roles.author, 'identity', { get: () => process.env.${authorEnv} ?? 'synthetic-author' });
Object.defineProperty(deliverySettings.commandPolicy.checks, 'test', { get: () => process.env.${checkEnv} ?? 'REQUIRED' });
`,
    );
    const admissionPath = join(root, '.git', 'ai-delivery', 'runtime-admission.json');
    const { admissionId: _id, ...content } = JSON.parse(readFileSync(admissionPath, 'utf8')) as Record<string, unknown>;
    const baseline = await loadDeliveryConfig(root);
    const admitted = { ...content, configDigest: baseline.configDigest };
    writeFileSync(admissionPath, JSON.stringify({ ...admitted, admissionId: digestValue(admitted) }));
    await assertDeliveryRuntimeAdmitted({ repoRoot: root, runtimeEntryPath });
    const originalBytes = readFileSync(policyPath, 'utf8');
    for (const [key, value] of [
      [authorEnv, 'changed-author'],
      [checkEnv, 'SKIP'],
    ] as const) {
      process.env[key] = value;
      assert.notEqual((await loadDeliveryConfig(root)).configDigest, baseline.configDigest);
      await assert.rejects(
        assertDeliveryRuntimeAdmitted({ repoRoot: root, runtimeEntryPath }),
        /source, capability or repository admission/u,
      );
      delete process.env[key];
    }
    assert.equal(readFileSync(policyPath, 'utf8'), originalBytes);
  } finally {
    if (previousAuthor === undefined) delete process.env[authorEnv];
    else process.env[authorEnv] = previousAuthor;
    if (previousCheck === undefined) delete process.env[checkEnv];
    else process.env[checkEnv] = previousCheck;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a changed discovered Project identity invalidates the installed admission', async () => {
  const { root, runtimeEntryPath } = await fixture();
  const base = syntheticDiscoveryClients();
  const graphql = async (query: string, variables: Record<string, unknown>): Promise<unknown> => {
    const result: unknown = await base.graphql(query, variables);
    if (query.includes('query ProjectDeliveryConfiguration')) {
      (result as { organization: { projectV2: { id: string } } }).organization.projectV2.id = 'REPLACED-PROJECT';
    }
    return result;
  };
  const mocked = vi.spyOn(githubClient, 'createDeliveryGitHubClients').mockResolvedValueOnce({
    authSource: 'app',
    role: 'author',
    rest: new Octokit(),
    graphql: graphql as typeof base.graphql,
  });
  try {
    await assert.rejects(
      assertDeliveryRuntimeAdmitted({ repoRoot: root, runtimeEntryPath }),
      /source, capability or repository admission/u,
    );
    assert.equal(existsSync(join(root, '.worktrees')), false);
  } finally {
    mocked.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI dispatch and MCP reject ambiguous discovery with the same error before mutation', async () => {
  const { root, runtimeEntryPath } = await fixture();
  const path = join(root, 'ai-delivery.config.json');
  const overrides = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  delete overrides.project;
  writeFileSync(path, JSON.stringify(overrides));
  const base = syntheticDiscoveryClients();
  const graphql = async (query: string, variables: Record<string, unknown>): Promise<unknown> => {
    if (query.includes('projectsV2(first:'))
      return { repository: { projectsV2: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
    return base.graphql(query, variables);
  };
  const mocked = vi.spyOn(githubClient, 'createDeliveryGitHubClients').mockResolvedValue({
    authSource: 'app',
    role: 'author',
    rest: new Octokit(),
    graphql: graphql as typeof base.graphql,
  });
  const execution = { repoRoot: root, runtimeEntryPath, identity: 'synthetic-author' };
  const server = createAiDeliveryMcpServer(execution);
  const client = new Client({ name: 'synthetic-discovery-client', version: '1.0.0' });
  try {
    await assert.rejects(
      executeTool('issue_create', { title: 'Ambiguous destination' }, execution),
      /Discovered 0 compatible linked Projects/u,
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: 'issue_create', arguments: { title: 'Ambiguous destination' } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /Discovered 0 compatible linked Projects/u);
    assert.equal(existsSync(join(root, '.worktrees')), false);
  } finally {
    await client.close();
    await server.close();
    mocked.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an old active issue remains pinned while a new row uses the same canonical registry', async () => {
  const { root } = await fixture();
  try {
    const oldPath = join(root, '.worktrees', 'issue-17');
    git(root, 'worktree', 'add', '-b', 'issue/17', oldPath, 'main');
    const old = {
      branch: 'issue/17',
      createdAt: '2026-01-01T00:00:00.000Z',
      identity: 'synthetic-author',
      issueNumber: 17,
      path: oldPath,
      status: 'active',
      type: 'issue',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const registryPath = join(root, '.issue-cli', 'worktrees.json');
    mkdirSync(dirname(registryPath), { recursive: true });
    const futureBytes = JSON.stringify({
      worktrees: [{ ...old, schemaVersion: 'future.registry-row@99', hold: 'unrecognized' }],
    });
    writeFileSync(registryPath, futureBytes);
    await assert.rejects(
      prepareStandaloneWorktree({
        branch: 'scratch/new',
        identity: 'synthetic-author',
        name: 'scratch-new',
        repoRoot: root,
      }),
      /unsupported fields/u,
    );
    assert.equal(readFileSync(registryPath, 'utf8'), futureBytes);
    assert.equal(existsSync(join(root, '.worktrees', 'scratch-new')), false);
    writeFileSync(registryPath, JSON.stringify({ worktrees: [old] }));
    assert.doesNotThrow(() => assertNativeIssueTrackingAdmission(17, root));
    const original = readFileSync(registryPath, 'utf8');
    writeFileSync(registryPath, JSON.stringify({ worktrees: [old, old] }));
    assert.throws(() => assertNativeIssueTrackingAdmission(17, root), /duplicate/u);
    writeFileSync(registryPath, futureBytes);
    assert.throws(() => assertNativeIssueTrackingAdmission(17, root), /unsupported fields/u);
    writeFileSync(registryPath, original);
    await assert.rejects(
      prepareIssueWorktree({ identity: 'synthetic-author', issueNumber: 17, repoRoot: root }),
      /ownership witness/u,
    );
    const row = await prepareStandaloneWorktree({
      branch: 'scratch/new',
      identity: 'synthetic-author',
      name: 'scratch-new',
      repoRoot: root,
    });
    await cleanupNonIssueWorktree({ name: 'scratch-new', repoRoot: root });
    assert.equal(existsSync(row.path), false);
    assert.deepEqual(JSON.parse(readFileSync(registryPath, 'utf8')) as unknown, { worktrees: [old] });
    assert.equal(existsSync(oldPath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(['current-blocker', 'new-blocker', 'current-parent', 'new-parent'] as const)(
  'tracking-only relationships preserve the related legacy worktree for %s',
  async (relationship) => {
    const { root } = await fixture();
    try {
      const legacyPath = join(root, '.worktrees', 'issue-17');
      git(root, 'worktree', 'add', '-b', 'issue/17', legacyPath, 'main');
      writeFileSync(join(legacyPath, 'artifact.txt'), 'legacy source remains untouched\n');
      const evidencePath = join(root, '.git', 'legacy-evidence');
      mkdirSync(evidencePath);
      writeFileSync(join(evidencePath, 'receipt.json'), '{"producer":"synthetic-legacy"}\n');
      const legacy = {
        branch: 'issue/17',
        createdAt: '2026-01-01T00:00:00.000Z',
        identity: 'synthetic-legacy',
        issueNumber: 17,
        path: legacyPath,
        status: 'active',
        type: 'issue',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      const registryPath = join(root, '.issue-cli', 'worktrees.json');
      mkdirSync(dirname(registryPath), { recursive: true });
      const registryBytes = JSON.stringify({ worktrees: [legacy] });
      writeFileSync(registryPath, registryBytes);
      const sourceBefore = directoryHash(legacyPath);
      const evidenceBefore = directoryHash(evidencePath);
      const loaded = await loadDeliveryConfig(root);
      const pageInfo = { endCursor: null, hasNextPage: false };
      let parent = relationship === 'current-parent' ? 17 : null;
      let blockers = relationship === 'current-blocker' ? [17] : [];
      let missingRelated = true;
      let malformedRelationships = false;
      let writes = 0;
      let projectOption = 'STATUS-0';
      const statuses = ['Queued', 'Active', 'Waiting', 'Shipped'];
      const projectItem = () => ({
        id: 'ITEM-19',
        isArchived: false,
        content: { id: 'ISSUE-19' },
        fieldValueByName: { name: statuses[Number(projectOption.slice(-1))], optionId: projectOption },
      });
      const context = {
        root,
        repo: { owner: 'example', repo: 'widget' },
        config: loaded.config,
        clients: {
          rest: {
            request: async (route: string, input: { owner: string; repo: string }) => {
              assert.equal(input.owner, 'example');
              assert.equal(input.repo, 'widget');
              assert.equal(route, 'GET /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values');
              return { data: [] };
            },
            issues: {
              get: async (input: { issue_number: number; owner: string; repo: string }) => {
                assert.equal(input.owner, 'example');
                assert.equal(input.repo, 'widget');
                if (input.issue_number === 17 && missingRelated) throw new Error('Synthetic issue not found');
                return {
                  data: {
                    id: input.issue_number * 10,
                    number: input.issue_number,
                    node_id: `ISSUE-${String(input.issue_number)}`,
                    title: 'Synthetic tracking issue',
                    state: 'open',
                    html_url: `https://example.test/issues/${String(input.issue_number)}`,
                  },
                };
              },
              update: async () => {
                writes += 1;
                return { data: {} };
              },
              removeSubIssue: async (input: { issue_number: number; sub_issue_id: number }) => {
                assert.equal(input.issue_number, 17);
                assert.equal(input.sub_issue_id, 190);
                writes += 1;
                parent = null;
                return { data: {} };
              },
              addSubIssue: async (input: { issue_number: number; sub_issue_id: number }) => {
                assert.equal(input.issue_number, 17);
                assert.equal(input.sub_issue_id, 190);
                writes += 1;
                parent = 17;
                return { data: {} };
              },
              listSubIssues: async () => ({ data: [] }),
            },
            paginate: async () => (parent === 17 ? [{ number: 19 }] : []),
          },
          graphql: async (query: string, variables: Record<string, unknown>) => {
            if (query.includes('blockedBy(first:')) {
              assert.equal(variables.owner, 'example');
              assert.equal(variables.name, 'widget');
              assert.equal(variables.number, 19);
              if (malformedRelationships) return { repository: null };
              return {
                repository: {
                  issue: {
                    parent: parent === null ? null : { id: 'ISSUE-17', number: parent },
                    blockedBy: {
                      nodes: blockers.map((number) => ({
                        id: `ISSUE-${String(number)}`,
                        number,
                        state: 'OPEN',
                        title: 'Synthetic blocker',
                      })),
                      pageInfo,
                    },
                  },
                },
              };
            }
            if (query.includes('removeBlockedBy') || query.includes('addBlockedBy')) {
              assert.equal(variables.issue, 'ISSUE-19');
              assert.equal(variables.blocking, 'ISSUE-17');
              writes += 1;
              blockers = query.includes('addBlockedBy') ? [17] : [];
              return {};
            }
            if (query.includes('ProjectDeliveryItems'))
              return { organization: { projectV2: { items: { nodes: [projectItem()], pageInfo } } } };
            if (query.includes('UpdateProjectDeliveryStatus')) {
              projectOption = String(variables.optionId);
              writes += 1;
              return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'ITEM-19' } } };
            }
            if (query.includes('ProjectDeliveryItemReadback'))
              return { node: { ...projectItem(), project: { id: 'PROJECT-1', number: 1 } } };
            return syntheticDiscoveryClients().graphql(query, variables);
          },
        },
      } as unknown as DeliveryContext;
      const input = relationship.endsWith('blocker')
        ? { issueNumber: 19, blockedBy: relationship === 'new-blocker' ? [17] : [] }
        : { issueNumber: 19, parentIssueNumber: relationship === 'new-parent' ? 17 : null };
      await assert.rejects(updateIssue(context, input), /Unable to resolve (?:blocker|parent) issue/u);
      assert.equal(writes, 0);
      missingRelated = false;
      malformedRelationships = true;
      await assert.rejects(updateIssue(context, input), /invalid blocked-by relationship evidence/u);
      assert.equal(writes, 0);
      malformedRelationships = false;
      await assert.rejects(updateIssue(context, { ...input, issueNumber: 17 }), /ownership witness/u);
      assert.equal(writes, 0);
      writeFileSync(registryPath, JSON.stringify({ worktrees: [{ ...legacy, schemaVersion: 'unknown@99' }] }));
      await assert.rejects(updateIssue(context, input), /unsupported fields/u);
      assert.equal(writes, 0);
      writeFileSync(registryPath, registryBytes);
      const transitionPath = join(root, '.git', 'ai-delivery', 'worktree-owners', 'issue-19.transition.json');
      mkdirSync(dirname(transitionPath), { recursive: true });
      writeFileSync(transitionPath, '{"schemaVersion":"unknown-transition@99"}', { mode: 0o600 });
      await assert.rejects(updateIssue(context, input), /transition is incomplete or unreadable/u);
      assert.equal(writes, 0);
      unlinkSync(transitionPath);
      const result = await updateIssue(context, input);
      assert.equal(result.worktree, null);
      assert.deepEqual(result.blockedBy, relationship === 'new-blocker' ? [17] : []);
      assert.equal(result.parentIssueNumber, relationship === 'new-parent' ? 17 : null);
      assert.equal(result.projectStatus, relationship === 'new-blocker' ? 'Blocked' : 'Todo');
      assert.ok(writes > 0);
      await assert.rejects(
        prepareIssueWorktree({ identity: 'synthetic-author', issueNumber: 17, repoRoot: root }),
        /ownership witness/u,
      );
      await assert.rejects(verifyIssue({ issueNumber: 17, repoRoot: legacyPath }), /ownership witness/u);
      assert.equal(readFileSync(registryPath, 'utf8'), registryBytes);
      assert.equal(directoryHash(legacyPath), sourceBefore);
      assert.equal(directoryHash(evidencePath), evidenceBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('synthetic cutover restores exact pre-write state and resumes an incomplete verification stage', async () => {
  const { root, counter, secondCounter, failSecond } = await fixture({ twoStages: true });
  const backup = mkdtempSync(join(tmpdir(), 'ai-delivery-cutover-backup-'));
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    writeFileSync(join(row.path, 'change.txt'), 'feature\n');
    git(row.path, 'add', 'change.txt');
    git(row.path, 'commit', '-qm', 'synthetic cutover source');
    const registryPath = join(root, '.issue-cli');
    const evidencePath = join(root, '.git', 'ai-delivery');
    const oldRelease = join(root, '.git', 'synthetic-runtime');
    const newRelease = join(root, '.git', 'unadmitted-runtime');
    const current = join(root, '.git', 'current-runtime');
    symlinkSync(oldRelease, current);
    cpSync(registryPath, join(backup, 'registry'), { recursive: true });
    cpSync(evidencePath, join(backup, 'evidence'), { recursive: true });
    const registryBefore = directoryHash(registryPath);
    const evidenceBefore = directoryHash(evidencePath);
    const pointerBefore = readlinkSync(current);
    const currentCli = join(current, 'package', 'dist', 'cli.js');
    assert.equal(
      (await assertDeliveryRuntimeAdmitted({ repoRoot: root, runtimeEntryPath: currentCli })).capability.cli,
      2,
    );

    cpSync(oldRelease, newRelease, { recursive: true });
    writeFileSync(join(newRelease, 'package', 'dist', 'cli.js'), 'unadmitted CLI bytes\n');
    unlinkSync(current);
    symlinkSync(newRelease, current);
    await assert.rejects(
      executeTool(
        'issue_worktree_create',
        { branch: 'scratch/cutover', name: 'scratch-cutover' },
        { repoRoot: root, runtimeEntryPath: currentCli, identity: 'synthetic-author' },
      ),
      /source, capability or repository admission/u,
    );
    assert.equal(existsSync(join(root, '.worktrees', 'scratch-cutover')), false);
    assert.equal(directoryHash(registryPath), registryBefore);
    assert.equal(directoryHash(evidencePath), evidenceBefore);
    unlinkSync(current);
    symlinkSync(pointerBefore, current);
    assert.equal(readlinkSync(current), pointerBefore);
    await assertDeliveryRuntimeAdmitted({ repoRoot: root, runtimeEntryPath: currentCli });

    const uninterrupted = await verifyIssue({ issueNumber: 17, repoRoot: row.path });
    assert.equal(readFileSync(counter, 'utf8'), '1');
    assert.equal(readFileSync(secondCounter, 'utf8'), '1');
    const semanticOutputs = uninterrupted.stageReceipts.map((receipt) => ({
      stageId: receipt.input.stageId,
      artifacts: receipt.artifacts,
      commands: receipt.commands.map((command) => ({ label: command.label, outputDigest: command.outputDigest })),
    }));

    rmSync(registryPath, { recursive: true });
    rmSync(evidencePath, { recursive: true });
    cpSync(join(backup, 'registry'), registryPath, { recursive: true });
    cpSync(join(backup, 'evidence'), evidencePath, { recursive: true });
    assert.equal(directoryHash(registryPath), registryBefore);
    assert.equal(directoryHash(evidencePath), evidenceBefore);
    assert.equal(readlinkSync(current), pointerBefore);
    rmSync(counter);
    rmSync(secondCounter);

    writeFileSync(failSecond, 'interrupt after first stage\n');
    await assert.rejects(verifyIssue({ issueNumber: 17, repoRoot: row.path }), /Selected policy stage command failed/u);
    assert.equal(readFileSync(counter, 'utf8'), '1');
    assert.equal(readFileSync(secondCounter, 'utf8'), '1');
    const firstStageDirectory = join(evidencePath, 'verification@1', 'stages', 'check');
    const checkpoint = join(firstStageDirectory, readdirSync(firstStageDirectory)[0]!);
    const completedCheckpointHash = sha256(checkpoint);
    rmSync(failSecond);
    const resumed = await verifyIssue({ issueNumber: 17, repoRoot: row.path });
    assert.equal(readFileSync(counter, 'utf8'), '1');
    assert.equal(readFileSync(secondCounter, 'utf8'), '2');
    assert.equal(sha256(checkpoint), completedCheckpointHash);
    assert.equal(resumed.classification.receiptId, uninterrupted.classification.receiptId);
    assert.equal(resumed.aggregate.result, uninterrupted.aggregate.result);
    assert.deepEqual(
      resumed.stageReceipts.map((receipt) => ({
        stageId: receipt.input.stageId,
        artifacts: receipt.artifacts,
        commands: receipt.commands.map((command) => ({ label: command.label, outputDigest: command.outputDigest })),
      })),
      semanticOutputs,
    );
    writeFileSync(checkpoint, 'corrupt checkpoint\n');
    await assert.rejects(verifyIssue({ issueNumber: 17, repoRoot: row.path }));
    assert.equal(readFileSync(counter, 'utf8'), '1');

    rmSync(registryPath, { recursive: true });
    rmSync(evidencePath, { recursive: true });
    cpSync(join(backup, 'registry'), registryPath, { recursive: true });
    cpSync(join(backup, 'evidence'), evidencePath, { recursive: true });
    assert.equal(directoryHash(registryPath), registryBefore);
    assert.equal(directoryHash(evidencePath), evidenceBefore);
    assert.equal(readlinkSync(current), pointerBefore);
    console.log(
      'SYNTHETIC_CUTOVER_RECEIPT',
      JSON.stringify({
        backupRegistrySha256: registryBefore,
        backupEvidenceSha256: evidenceBefore,
        completedCheckpointSha256: completedCheckpointHash,
        classificationReceiptId: resumed.classification.receiptId,
        semanticOutputSha256: digestValue(semanticOutputs),
      }),
    );
  } finally {
    rmSync(backup, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('immediate successful commands establish ownership and remain reusable', async () => {
  const { root } = await fixture();
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    const policyPath = join(row.path, 'policy.mjs');
    writeFileSync(
      policyPath,
      readFileSync(policyPath, 'utf8').replace("argv: [process.execPath, '-e',", "argv: ['/usr/bin/true',"),
    );
    git(row.path, 'add', 'policy.mjs');
    git(row.path, 'commit', '-qm', 'immediate stage');
    const first = await verifyIssue({ issueNumber: 17, repoRoot: row.path });
    const reused = await verifyIssue({ issueNumber: 17, repoRoot: row.path });
    assert.equal(first.stageReceipts[0]!.receiptId, reused.stageReceipts[0]!.receiptId);
    const bounded = await verifyIssue({
      issueNumber: 17,
      repoRoot: row.path,
      resourceBounds: { maxAggregateRssBytes: 1_000_000_000, minFreeDiskBytes: 1 },
    });
    assert.equal(bounded.aggregate.result, 'passed');
    assert.ok(bounded.resources!.sampleCount > 0);
    assert.deepEqual(readdirSync(join(root, '.git/ai-delivery/writers@1')), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('component verification recomposes current-source aggregates with only affected stage execution', async () => {
  const { root, counter, secondCounter } = await fixture({ twoStages: true, componentPolicy: true });
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    const resourceBounds = { maxAggregateRssBytes: 1_000_000_000, minFreeDiskBytes: 1 };
    const original = await verifyIssue({ issueNumber: 17, repoRoot: row.path, resourceBounds });
    writeFileSync(join(row.path, 'unrelated.txt'), 'documentation');
    git(row.path, 'add', '.');
    git(row.path, 'commit', '-qm', 'unrelated source');
    const current = await verifyIssue({ issueNumber: 17, repoRoot: row.path, resourceBounds });
    assert.notEqual(current.classification.receiptId, original.classification.receiptId);
    assert.deepEqual(
      current.stageReceipts.map((r) => r.receiptId),
      original.stageReceipts.map((r) => r.receiptId),
    );
    assert.equal(current.aggregate.classificationReceiptId, current.classification.receiptId);
    assert.equal(readFileSync(counter, 'utf8'), '1');
    assert.equal(readFileSync(secondCounter, 'utf8'), '1');
    writeFileSync(join(row.path, 'component.txt'), 'changed second component');
    git(row.path, 'add', '.');
    git(row.path, 'commit', '-qm', 'second component');
    const secondChanged = await verifyIssue({ issueNumber: 17, repoRoot: row.path, resourceBounds });
    assert.equal(secondChanged.stageReceipts[0]!.receiptId, original.stageReceipts[0]!.receiptId);
    assert.equal(readFileSync(counter, 'utf8'), '1');
    assert.equal(readFileSync(secondCounter, 'utf8'), '2');
    writeFileSync(join(row.path, 'artifact.txt'), 'changed upstream component');
    git(row.path, 'add', '.');
    git(row.path, 'commit', '-qm', 'upstream component');
    await verifyIssue({ issueNumber: 17, repoRoot: row.path, resourceBounds });
    assert.equal(readFileSync(counter, 'utf8'), '2');
    assert.equal(readFileSync(secondCounter, 'utf8'), '3');
    await createIssuePhaseEvidence({ issueNumber: 17, repoRoot: row.path, phase: 'verify' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quiet verification reports completion-based progress and remains cancellable', { timeout: 12_000 }, async () => {
  const { root } = await fixture({ firstStageScript: 'setInterval(()=>{},1000);' });
  const controller = new AbortController();
  const progress = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  let running: ReturnType<typeof verifyIssue> | undefined;
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    running = verifyIssue({ issueNumber: 17, repoRoot: row.path, signal: controller.signal });
    void running.catch(() => undefined);
    let status: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 350; attempt++) {
      const latest = progress.mock.calls
        .map(([chunk]) => String(chunk))
        .filter((line) => line.startsWith('ai-delivery.verify '))
        .at(-1);
      if (latest) status = JSON.parse(latest.slice('ai-delivery.verify '.length)) as Record<string, unknown>;
      if (Number(status?.elapsedMs) >= 5_000) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(status?.completedCommands, 0);
    assert.equal(status?.remainingCommands, 1);
    assert.equal(status?.completedStages, 0);
    assert.equal(status?.capturedOutputBytes, 0);
    assert.ok(Number(status?.lastCompletedWorkAgeMs) >= 5_000);
    controller.abort();
    await assert.rejects(running, /cancelled/u);
  } finally {
    controller.abort();
    await running?.catch(() => undefined);
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});

test('writer persistence failure retains recovery identity while cancellation cleans its owned command', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-delivery-writer-failure-'));
  const marker = join(directory, 'started');
  const { root } = await fixture({
    firstStageScript: `const fs=require('fs');fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`,
  });
  const controller = new AbortController();
  const original = atomicJson.writePrivateJsonFileAtomically;
  let failWrites = false;
  const persistence = vi.spyOn(atomicJson, 'writePrivateJsonFileAtomically').mockImplementation((path, value) => {
    if (failWrites && path.includes('/writers@1/')) throw new Error('ENOSPC: synthetic writer persistence failure');
    original(path, value);
  });
  let running: Promise<unknown> | undefined;
  let owner: { pid: number; identity: string } | undefined;
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    const writerPath = join(root, '.git/ai-delivery/writers@1', `${digestValue(row.path).slice(7)}.json`);
    running = verifyIssue({ issueNumber: 17, repoRoot: row.path, signal: controller.signal }).catch(
      (error: unknown) => error,
    );
    for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(existsSync(marker));
    const recorded = JSON.parse(readFileSync(writerPath, 'utf8')) as {
      command: { root: { pid: number; identity: string } };
    };
    owner = recorded.command.root;
    assert.equal(Number(readFileSync(marker, 'utf8')), owner.pid);
    failWrites = true;
    controller.abort();
    const failure = String(await running);
    assert.match(failure, /cancelled.*Writer state persistence failed.*ENOSPC/u);
    assert.doesNotMatch(failure, /Owned process cleanup failed/u);
    const remaining = spawnSync('ps', ['-p', String(owner.pid), '-o', 'stat='], { encoding: 'utf8' });
    assert.ok(remaining.status === 1 || remaining.stdout.trim().startsWith('Z'));
    assert.deepEqual((JSON.parse(readFileSync(writerPath, 'utf8')) as typeof recorded).command.root, owner);
    assert.equal(existsSync(`${writerPath}.lock`), false);
    failWrites = false;
    await assert.rejects(verifyIssue({ issueNumber: 17, repoRoot: row.path }), /live verification writer/u);
    assert.equal(existsSync(writerPath), true);
  } finally {
    controller.abort();
    await running;
    persistence.mockRestore();
    if (owner !== undefined) {
      const current = spawnSync('ps', ['-p', String(owner.pid), '-o', 'lstart='], { encoding: 'utf8' });
      if (current.status === 0 && current.stdout.trim() === owner.identity) process.kill(owner.pid, 'SIGKILL');
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test('verification excludes a second writer in the same worktree before command execution', async () => {
  const marker = join(tmpdir(), `ai-delivery-writer-${String(process.pid)}`);
  const { root } = await fixture({
    firstStageScript: `const fs=require('fs');fs.appendFileSync(${JSON.stringify(marker)},'started\\n');setInterval(()=>{},1000);`,
  });
  const controller = new AbortController();
  let running: Promise<unknown> | undefined;
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    running = verifyIssue({ issueNumber: 17, repoRoot: row.path, signal: controller.signal }).catch(
      (error: unknown) => error,
    );
    for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(existsSync(marker));
    const contender = new AbortController();
    const stopContender = setTimeout(() => contender.abort(), 500);
    try {
      await assert.rejects(
        verifyIssue({ issueNumber: 17, repoRoot: row.path, signal: contender.signal }),
        /writer|Lock acquisition/u,
      );
    } finally {
      clearTimeout(stopContender);
    }
    assert.equal(readFileSync(marker, 'utf8'), 'started\n');
    controller.abort();
    assert.match(String(await running), /cancelled/u);
  } finally {
    controller.abort();
    await running;
    rmSync(root, { recursive: true, force: true });
    rmSync(marker, { force: true });
  }
});

test('live or unknown writer state fails closed even after a file lease becomes stale', async () => {
  const { root, counter } = await fixture();
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    const writerDirectory = join(root, '.git/ai-delivery/writers@1');
    mkdirSync(writerDirectory, { recursive: true });
    const writerPath = join(writerDirectory, `${digestValue(row.path).slice(7)}.json`);
    const state = {
      schemaVersion: 'ai-delivery.verification-writer@1',
      writerId: '00000000-0000-4000-8000-000000000001',
      worktreeDigest: digestValue(row.path),
      owner: {
        pid: process.pid,
        identity: execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim(),
      },
      command: { phase: 'idle' },
    };
    writeFileSync(writerPath, JSON.stringify({ ...state, stateId: digestValue(state) }), { mode: 0o600 });
    await assert.rejects(verifyIssue({ issueNumber: 17, repoRoot: row.path }), /live verification writer/u);
    const unknown = {
      ...state,
      owner: { ...state.owner, identity: 'replaced historical process' },
      command: { phase: 'starting' },
    };
    writeFileSync(writerPath, JSON.stringify({ ...unknown, stateId: digestValue(unknown) }));
    await assert.rejects(verifyIssue({ issueNumber: 17, repoRoot: row.path }), /unknown command ownership/u);
    assert.equal(existsSync(counter), false);
    assert.equal(existsSync(writerPath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'same-head worktrees overlap with isolated checkpoints and cancellation preserves the peer',
  { timeout: 15_000 },
  async () => {
    const { root } = await fixture({
      firstStageScript: `const fs=require('fs');const cp=require('child_process');const path=require('path');const dir=cp.execFileSync('git',['rev-parse','--absolute-git-dir'],{encoding:'utf8'}).trim();const marker=path.join(dir,'peer-command');fs.writeFileSync(marker,'running');const wait=setInterval(()=>{if(fs.existsSync(marker+'.release')){clearInterval(wait);fs.writeFileSync(marker,'passed');}},20);`,
    });
    const cancel = new AbortController();
    const parallelCancel = new AbortController();
    let first: Promise<unknown> | undefined;
    let second: ReturnType<typeof verifyIssue> | undefined;
    let parallelRuns: ReturnType<typeof verifyIssue>[] = [];
    try {
      const a = await prepareIssueWorktree({
        baseRef: 'main',
        identity: 'synthetic-author',
        issueNumber: 17,
        repoRoot: root,
      });
      const b = await prepareIssueWorktree({
        baseRef: 'main',
        identity: 'synthetic-author',
        issueNumber: 18,
        repoRoot: root,
      });
      assert.equal(git(a.path, 'rev-parse', 'HEAD'), git(b.path, 'rev-parse', 'HEAD'));
      first = verifyIssue({ issueNumber: 17, repoRoot: a.path, signal: cancel.signal }).catch(
        (error: unknown) => error,
      );
      second = verifyIssue({ issueNumber: 18, repoRoot: b.path });
      void second.catch(() => undefined);
      const markerA = join(git(a.path, 'rev-parse', '--absolute-git-dir'), 'peer-command');
      const markerB = join(git(b.path, 'rev-parse', '--absolute-git-dir'), 'peer-command');
      for (let attempt = 0; attempt < 100 && !(existsSync(markerA) && existsSync(markerB)); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(readFileSync(markerA, 'utf8'), 'running');
      assert.equal(readFileSync(markerB, 'utf8'), 'running');
      cancel.abort();
      assert.match(String(await first), /cancelled/u);
      writeFileSync(`${markerB}.release`, 'ready');
      const peer = await second;
      writeFileSync(`${markerA}.release`, 'ready');
      const retried = await verifyIssue({ issueNumber: 17, repoRoot: a.path });
      assert.notEqual(peer.stageReceipts[0]!.input.inputId, retried.stageReceipts[0]!.input.inputId);
      assert.equal(loadVerifiedRun(b.path, 18).manifestId, peer.manifestId);
      assert.equal(loadVerifiedRun(a.path, 17).manifestId, retried.manifestId);
      assert.equal(readFileSync(markerA, 'utf8'), 'passed');
      assert.equal(readFileSync(markerB, 'utf8'), 'passed');
      assert.deepEqual(peer.stageReceipts[0]!.commands, retried.stageReceipts[0]!.commands);
      const resourceBounds = { maxAggregateRssBytes: 1_000_000_000, minFreeDiskBytes: 1 };
      const parallelStartedAt = Date.now();
      for (const marker of [markerA, markerB]) {
        rmSync(marker);
        rmSync(`${marker}.release`);
      }
      parallelRuns = [
        verifyIssue({ issueNumber: 17, repoRoot: a.path, resourceBounds, signal: parallelCancel.signal }),
        verifyIssue({ issueNumber: 18, repoRoot: b.path, resourceBounds, signal: parallelCancel.signal }),
      ];
      const parallelRun = Promise.all(parallelRuns);
      void parallelRun.catch(() => undefined);
      for (let attempt = 0; attempt < 200 && !(existsSync(markerA) && existsSync(markerB)); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(readFileSync(markerA, 'utf8'), 'running');
      assert.equal(readFileSync(markerB, 'utf8'), 'running');
      for (const marker of [markerA, markerB]) writeFileSync(`${marker}.release`, 'ready');
      const parallel = await parallelRun;
      const parallelElapsedMs = Date.now() - parallelStartedAt;
      assert.deepEqual(
        parallel.map((run) => run.stageReceipts[0]!.commands),
        [peer.stageReceipts[0]!.commands, retried.stageReceipts[0]!.commands],
      );
      assert.ok(parallel.every((run) => run.resources!.sampleCount > 0));
      const reused = await verifyIssue({ issueNumber: 18, repoRoot: b.path, resourceBounds });
      assert.equal(reused.stageReceipts[0]!.receiptId, parallel[1]!.stageReceipts[0]!.receiptId);
      const manifestA = join(
        root,
        '.git/ai-delivery/runs@2',
        digestValue(a.path).slice(7),
        `${peer.classification.head.sha}.json`,
      );
      const { manifestId: _foreignId, ...foreign } = parallel[1]!;
      const foreignContent = { ...foreign, writer: { ...foreign.writer!, worktreeDigest: digestValue(a.path) } };
      writeFileSync(manifestA, JSON.stringify({ ...foreignContent, manifestId: digestValue(foreignContent) }));
      assert.throws(() => loadVerifiedRun(a.path, 17), /environment|foreign/u);
      writeFileSync(manifestA, JSON.stringify(parallel[0]));
      console.log(
        'WRITER_ISOLATION_RECEIPT',
        JSON.stringify({
          sameHead: peer.classification.head.sha,
          peerManifest: peer.manifestId,
          retryManifest: retried.manifestId,
          peerReused: true,
          parallelElapsedMs,
          maxObservedRssBytes: Math.max(...parallel.map((run) => run.resources!.maxSampledAggregateRssBytes!)),
        }),
      );
    } finally {
      cancel.abort();
      parallelCancel.abort();
      await first;
      await second?.catch(() => undefined);
      await Promise.allSettled(parallelRuns);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('interruption child verification', { skip: !process.env.AI_DELIVERY_INTERRUPTION_WORKTREE }, async () => {
  await verifyIssue({ issueNumber: 17, repoRoot: process.env.AI_DELIVERY_INTERRUPTION_WORKTREE! });
});

test(
  'interrupted writer recovers only its recorded command and resumes completed checkpoints',
  { timeout: 30_000 },
  async () => {
    const { root, counter, secondCounter } = await fixture({
      twoStages: true,
      secondStageScript: `const fs=require('fs');const cp=require('child_process');const path=require('path');const dir=cp.execFileSync('git',['rev-parse','--git-common-dir'],{encoding:'utf8'}).trim();const count=path.join(dir,'second-stage-count.txt');fs.writeFileSync(count,String(Number(fs.existsSync(count)?fs.readFileSync(count,'utf8'):0)+1));if(!fs.existsSync(path.join(dir,'resume-interrupted')))setInterval(()=>{},1000);`,
    });
    let child: ReturnType<typeof spawn> | undefined;
    let workerPid: number | undefined;
    let ownedPid: number | undefined;
    let workerIdentity: string | undefined;
    let ownedIdentity: string | undefined;
    let peer: ReturnType<typeof spawn> | undefined;
    try {
      const row = await prepareIssueWorktree({
        baseRef: 'main',
        identity: 'synthetic-author',
        issueNumber: 17,
        repoRoot: root,
      });
      child = spawn(
        process.execPath,
        [
          join(process.cwd(), 'node_modules/vitest/vitest.mjs'),
          'run',
          'dist/lifecycle.test.js',
          '-t',
          '^interruption child verification$',
        ],
        {
          cwd: process.cwd(),
          stdio: 'ignore',
          env: { ...process.env, AI_DELIVERY_INTERRUPTION_WORKTREE: row.path },
        },
      );
      const childClosed = new Promise((resolve) => child!.once('close', resolve));
      const writerPath = join(root, '.git/ai-delivery/writers@1', `${digestValue(row.path).slice(7)}.json`);
      let recorded:
        | {
            owner: { pid: number; identity: string };
            command: { phase: string; root?: { pid: number; identity: string } };
          }
        | undefined;
      for (let attempt = 0; attempt < 200; attempt++) {
        if (existsSync(writerPath)) recorded = JSON.parse(readFileSync(writerPath, 'utf8')) as typeof recorded;
        if (recorded?.command.phase === 'running' && existsSync(secondCounter)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(readFileSync(counter, 'utf8'), '1');
      assert.equal(readFileSync(secondCounter, 'utf8'), '1');
      assert.equal(recorded?.command.phase, 'running');
      workerPid = recorded!.owner.pid;
      ownedPid = recorded!.command.root!.pid;
      workerIdentity = recorded!.owner.identity;
      ownedIdentity = recorded!.command.root!.identity;
      const completedDir = join(root, '.git/ai-delivery/verification@1/stages/check');
      const completedCheckpoint = join(completedDir, readdirSync(completedDir)[0]!);
      const completedDigest = sha256(completedCheckpoint);
      peer = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
      assert.equal(
        spawnSync('ps', ['-p', String(workerPid), '-o', 'lstart='], { encoding: 'utf8' }).stdout.trim(),
        workerIdentity,
      );
      process.kill(workerPid, 'SIGKILL');
      workerPid = undefined;
      await childClosed;
      process.kill(ownedPid, 0);
      // A stale file lease is not permission to forget the durable command owner.
      const stale = new Date(Date.now() - 20_000);
      utimesSync(`${writerPath}.lock`, stale, stale);
      writeFileSync(join(root, '.git/resume-interrupted'), 'ready');
      const recovered = await verifyIssue({ issueNumber: 17, repoRoot: row.path });
      assert.equal(readFileSync(counter, 'utf8'), '1');
      assert.equal(readFileSync(secondCounter, 'utf8'), '2');
      assert.equal(sha256(completedCheckpoint), completedDigest);
      assert.equal(recovered.aggregate.result, 'passed');
      process.kill(peer.pid!, 0);
      assert.equal(existsSync(writerPath), false);
      assert.equal(existsSync(`${writerPath}.lock`), false);
      const survivor = spawnSync('/bin/ps', ['-p', String(ownedPid), '-o', 'stat='], { encoding: 'utf8' });
      assert.ok(
        (survivor.status === 1 && !survivor.stdout.trim()) ||
          (survivor.status === 0 && survivor.stdout.trim().startsWith('Z')),
      );
      console.log(
        'INTERRUPTION_RESUME_RECEIPT',
        JSON.stringify({
          completedCheckpoint: completedDigest,
          firstStageExecutions: 1,
          interruptedStageExecutions: 2,
          peerPreserved: true,
          aggregateId: recovered.aggregate.aggregateId,
        }),
      );
      ownedPid = undefined;
    } finally {
      for (const [pid, identity] of [
        [workerPid, workerIdentity],
        [ownedPid, ownedIdentity],
      ] as const)
        if (pid !== undefined && identity !== undefined) {
          const current = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' });
          if (current.status !== 0 || current.stdout.trim() !== identity) continue;
          try {
            process.kill(pid, 'SIGKILL');
          } catch (error) {
            assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
          }
        }
      for (const processHandle of [peer, child])
        if (processHandle?.exitCode === null && processHandle.signalCode === null) processHandle.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('issue worktree verification resumes a completed stage and rejects changed inputs', async () => {
  const { root, counter, runtimeEntryPath } = await fixture();
  try {
    await assert.rejects(
      executeTool('issue_create', { title: 'Wrong repository', repo: 'other/widget' }, { repoRoot: root }),
      /Repository selector must match/u,
    );
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    const resumedRow = await prepareIssueWorktree({
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: row.path,
    });
    assert.equal(resumedRow.path, row.path);
    const scratch = await prepareStandaloneWorktree({
      branch: 'scratch/synthetic',
      identity: 'synthetic-author',
      name: 'scratch-synthetic',
      repoRoot: row.path,
    });
    assert.equal(scratch.path, join(dirname(row.path), 'scratch-synthetic'));
    const prHead = git(root, 'rev-parse', 'HEAD');
    const prRow = await preparePrWorktree({
      headSha: prHead,
      identity: 'synthetic-author',
      prNumber: 23,
      repoRoot: row.path,
    });
    assert.equal(prRow.type, 'pr');
    assert.equal(
      (await preparePrWorktree({ headSha: prHead, identity: 'synthetic-author', prNumber: 23, repoRoot: root })).path,
      prRow.path,
    );
    await assert.rejects(
      preparePrWorktree({ headSha: 'f'.repeat(40), identity: 'synthetic-author', prNumber: 23, repoRoot: root }),
      /head object is unavailable/u,
    );
    const status = JSON.parse(
      execFileSync(process.execPath, [join(process.cwd(), 'dist', 'cli.js'), '--repo-root', root, 'worktrees:status'], {
        encoding: 'utf8',
      }),
    ) as { type: string; present: boolean; clean: boolean }[];
    assert.equal(status.length, 3);
    assert.equal(status.find((entry) => entry.type === 'issue')?.present, true);
    await assert.rejects(cleanupNonIssueWorktree({ name: 'issue-17', repoRoot: root }), /no exact registry owner/u);
    writeFileSync(join(scratch.path, 'unpublished.txt'), 'unpublished synthetic work\n');
    git(scratch.path, 'add', 'unpublished.txt');
    git(scratch.path, 'commit', '-qm', 'Synthetic unpublished work');
    await assert.rejects(cleanupNonIssueWorktree({ name: 'scratch-synthetic', repoRoot: root }), /unpublished commit/u);
    assert.equal(existsSync(scratch.path), true);
    git(scratch.path, 'reset', '--hard', 'main');
    await cleanupNonIssueWorktree({ name: 'scratch-synthetic', repoRoot: root });
    await cleanupNonIssueWorktree({ prNumber: 23, repoRoot: root });
    assert.equal(existsSync(scratch.path), false);
    assert.equal(existsSync(prRow.path), false);
    const listed = JSON.parse(
      execFileSync(process.execPath, [join(process.cwd(), 'dist', 'cli.js'), '--repo-root', root, 'worktrees:list'], {
        encoding: 'utf8',
      }) as string,
    ) as unknown[];
    assert.equal(listed.length, 1);
    const reopenedPr = await preparePrWorktree({
      headSha: prHead,
      identity: 'synthetic-author',
      prNumber: 23,
      repoRoot: root,
    });
    assert.equal(reopenedPr.path, prRow.path);
    await cleanupNonIssueWorktree({ prNumber: 23, repoRoot: root });
    writeFileSync(join(row.path, 'change.txt'), 'feature\n');
    git(row.path, 'add', 'change.txt');
    git(row.path, 'commit', '-qm', 'synthetic change');
    git(root, 'branch', '-f', 'pr/23', git(row.path, 'rev-parse', 'HEAD'));
    await assert.rejects(
      preparePrWorktree({ headSha: prHead, identity: 'synthetic-author', prNumber: 23, repoRoot: root }),
      /Retained PR branch differs/u,
    );
    const first = await verifyIssue({ issueNumber: 17, repoRoot: row.path });
    assert.equal(readFileSync(counter, 'utf8'), '1');
    const second = await verifyIssue({ issueNumber: 17, repoRoot: row.path });
    assert.equal(second.stageReceipts[0]?.receiptId, first.stageReceipts[0]?.receiptId);
    assert.equal(readFileSync(counter, 'utf8'), '1');
    const dispatched = await executeTool('issue_verify', { issueNumber: 17 }, { repoRoot: row.path, runtimeEntryPath });
    assert.equal(
      (dispatched as { classificationReceiptId: string }).classificationReceiptId,
      first.classification.receiptId,
    );
    assert.equal(readFileSync(counter, 'utf8'), '1');
    const evidence = await createIssuePhaseEvidence({ issueNumber: 17, phase: 'verify', repoRoot: row.path });
    assert.equal(evidence.classificationReceiptId, first.classification.receiptId);
    writeFileSync(join(row.path, 'artifact.txt'), 'corrupt');
    await assert.rejects(verifyIssue({ issueNumber: 17, repoRoot: row.path }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a progressing stage remains observable beyond a former short deadline', async () => {
  const marker = join(tmpdir(), `ai-delivery-stage-start-${process.pid}-${Date.now()}`);
  const { root } = await fixture({
    firstStageScript: `const fs=require('fs');fs.writeFileSync(${JSON.stringify(marker)},'started');process.stdout.write('begin');setTimeout(()=>{process.stdout.write('end');},180);`,
  });
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    writeFileSync(join(row.path, 'change.txt'), 'feature\n');
    git(row.path, 'add', 'change.txt');
    git(row.path, 'commit', '-qm', 'synthetic progressing stage');
    const progressSpy = vi.spyOn(process.stderr, 'write');
    let completed = false;
    const run = verifyIssue({ issueNumber: 17, repoRoot: row.path }).then((value) => {
      completed = true;
      return value;
    });
    const markerDeadline = Date.now() + 2_000;
    while (!existsSync(marker) && Date.now() < markerDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(existsSync(marker), true);
    assert.equal(completed, false, 'stage must remain observable while its process runs');
    assert.ok(
      progressSpy.mock.calls.some(
        ([chunk]) => String(chunk).includes('"state":"running"') && String(chunk).includes('"stageId":"check"'),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(completed, false, 'useful work continues beyond the injected former deadline');
    const result = await run;
    assert.equal(result.stageReceipts.length, 1);
  } finally {
    vi.restoreAllMocks();
    rmSync(marker, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('cancelling verification stops its owned descendant and preserves an unrelated process', async () => {
  const marker = join(tmpdir(), `ai-delivery-stage-child-${process.pid}-${Date.now()}`);
  const heartbeat = `${marker}-heartbeat`;
  const unrelatedHeartbeat = `${marker}-unrelated`;
  const { root } = await fixture({
    firstStageScript: `const fs=require('fs');const {spawn}=require('child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),20);`)}],{stdio:'ignore'});child.unref();fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));setTimeout(()=>{},400);`,
  });
  let descendantPid: number | undefined;
  const unrelated = spawn(
    process.execPath,
    ['-e', `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(unrelatedHeartbeat)},'x'),20);`],
    {
      detached: true,
      stdio: 'ignore',
    },
  );
  unrelated.unref();
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    writeFileSync(join(row.path, 'change.txt'), 'feature\n');
    git(row.path, 'add', 'change.txt');
    git(row.path, 'commit', '-qm', 'synthetic cancellable stage');
    const controller = new AbortController();
    const run = verifyIssue({
      issueNumber: 17,
      repoRoot: row.path,
      signal: controller.signal,
    });
    const markerDeadline = Date.now() + 2_000;
    while (!existsSync(marker) && Date.now() < markerDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(existsSync(marker), true);
    descendantPid = Number(readFileSync(marker, 'utf8'));
    controller.abort();
    await assert.rejects(run, /cancelled/u);
    assert.equal(existsSync(join(root, '.git', 'ai-delivery', 'verification@1', 'stages', 'check')), false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const stoppedSize = existsSync(heartbeat) ? readFileSync(heartbeat).length : 0;
    const unrelatedSize = existsSync(unrelatedHeartbeat) ? readFileSync(unrelatedHeartbeat).length : 0;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(existsSync(heartbeat) ? readFileSync(heartbeat).length : 0, stoppedSize);
    assert.ok(readFileSync(unrelatedHeartbeat).length > unrelatedSize);
  } finally {
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, 'SIGKILL');
      } catch {
        /* already stopped */
      }
    }
    if (unrelated.pid !== undefined) {
      try {
        process.kill(unrelated.pid, 'SIGKILL');
      } catch {
        /* already stopped */
      }
    }
    rmSync(marker, { force: true });
    rmSync(heartbeat, { force: true });
    rmSync(unrelatedHeartbeat, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  { name: 'nonzero exit', terminate: 'process.exit(7)', expected: /exit 7/u },
  { name: 'signal', terminate: "process.kill(process.pid,'SIGTERM')", expected: /signal SIGTERM/u },
])('a stage $name stops descendants holding its output pipes open', async ({ terminate, expected }) => {
  const marker = join(tmpdir(), `ai-delivery-failed-stage-${process.pid}-${Date.now()}`);
  const heartbeat = `${marker}-heartbeat`;
  const { root } = await fixture({
    firstStageScript: `const fs=require('fs');const {spawn}=require('child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),20);`)}],{stdio:['ignore','inherit','inherit']});child.unref();fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));${terminate};`,
  });
  let descendantPid: number | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    writeFileSync(join(row.path, 'change.txt'), 'feature\n');
    git(row.path, 'add', 'change.txt');
    git(row.path, 'commit', '-qm', 'synthetic failing stage');
    const controller = new AbortController();
    const run = verifyIssue({ issueNumber: 17, repoRoot: row.path, signal: controller.signal });
    const rejection = assert.rejects(run, expected);
    const markerDeadline = Date.now() + 2_000;
    while (!existsSync(marker) && Date.now() < markerDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(existsSync(marker), true);
    descendantPid = Number(readFileSync(marker, 'utf8'));
    timeout = setTimeout(() => controller.abort(), 500);
    await rejection;
    assert.equal(existsSync(join(root, '.git', 'ai-delivery', 'verification@1', 'stages', 'check')), false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const stoppedSize = existsSync(heartbeat) ? readFileSync(heartbeat).length : 0;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(existsSync(heartbeat) ? readFileSync(heartbeat).length : 0, stoppedSize);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, 'SIGKILL');
      } catch {
        /* already stopped */
      }
    }
    rmSync(marker, { force: true });
    rmSync(heartbeat, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP request cancellation stops verification and leaves no stage receipt', async () => {
  const marker = join(tmpdir(), `ai-delivery-mcp-cancel-${process.pid}-${Date.now()}`);
  const heartbeat = `${marker}-heartbeat`;
  const { root, runtimeEntryPath } = await fixture({
    firstStageScript: `const fs=require('fs');const {spawn}=require('child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),20);`)}],{stdio:'ignore'});child.unref();fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));setTimeout(()=>{},1000);`,
  });
  const server = createAiDeliveryMcpServer({ repoRoot: root, runtimeEntryPath, identity: 'synthetic-author' });
  const client = new Client({ name: 'synthetic-cancelling-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let descendantPid: number | undefined;
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    writeFileSync(join(row.path, 'change.txt'), 'feature\n');
    git(row.path, 'add', 'change.txt');
    git(row.path, 'commit', '-qm', 'synthetic MCP cancellable stage');
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const controller = new AbortController();
    const call = client.callTool({ name: 'issue_verify', arguments: { issueNumber: 17 } }, undefined, {
      signal: controller.signal,
    });
    const markerDeadline = Date.now() + 2_000;
    while (!existsSync(marker) && Date.now() < markerDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(existsSync(marker), true);
    descendantPid = Number(readFileSync(marker, 'utf8'));
    controller.abort();
    await assert.rejects(call, /abort/iu);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stoppedSize = existsSync(heartbeat) ? readFileSync(heartbeat).length : 0;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(heartbeat) ? readFileSync(heartbeat).length : 0, stoppedSize);
    assert.equal(existsSync(join(root, '.git', 'ai-delivery', 'verification@1', 'stages', 'check')), false);
  } finally {
    await client.close();
    await server.close();
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, 'SIGKILL');
      } catch {
        /* already stopped */
      }
    }
    rmSync(marker, { force: true });
    rmSync(heartbeat, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP server shutdown cancellation waits for owned verification cleanup', async () => {
  const marker = join(tmpdir(), `ai-delivery-mcp-shutdown-${process.pid}-${Date.now()}`);
  const heartbeat = `${marker}-heartbeat`;
  const { root, runtimeEntryPath } = await fixture({
    firstStageScript: `const fs=require('fs');const {spawn}=require('child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),20);`)}],{stdio:'ignore'});child.unref();fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));setTimeout(()=>{},1000);`,
  });
  const shutdown = new AbortController();
  const server = createAiDeliveryMcpServer({
    repoRoot: root,
    runtimeEntryPath,
    identity: 'synthetic-author',
    signal: shutdown.signal,
  });
  const client = new Client({ name: 'synthetic-shutdown-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let descendantPid: number | undefined;
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    writeFileSync(join(row.path, 'change.txt'), 'shutdown\n');
    git(row.path, 'add', 'change.txt');
    git(row.path, 'commit', '-qm', 'synthetic MCP shutdown');
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = client.callTool({ name: 'issue_verify', arguments: { issueNumber: 17 } });
    const deadline = Date.now() + 2_000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(existsSync(marker), true);
    descendantPid = Number(readFileSync(marker, 'utf8'));
    shutdown.abort();
    const result = await call;
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /cancelled/u);
    const size = existsSync(heartbeat) ? readFileSync(heartbeat).length : 0;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(heartbeat) ? readFileSync(heartbeat).length : 0, size);
    assert.equal(existsSync(join(root, '.git', 'ai-delivery', 'verification@1', 'stages', 'check')), false);
  } finally {
    await client.close();
    await server.close();
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, 'SIGKILL');
      } catch {
        /* already stopped */
      }
    }
    rmSync(marker, { force: true });
    rmSync(heartbeat, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('the stage output bound covers both streams and publishes no checkpoint on overflow', async () => {
  const { root } = await fixture({
    firstStageScript: `process.stdout.write(Buffer.alloc(4*1024*1024));process.stderr.write(Buffer.alloc(4*1024*1024+1));`,
  });
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    writeFileSync(join(row.path, 'change.txt'), 'feature\n');
    git(row.path, 'add', 'change.txt');
    git(row.path, 'commit', '-qm', 'synthetic output bound');
    await assert.rejects(verifyIssue({ issueNumber: 17, repoRoot: row.path }), /captured output exceeded 8 MiB/u);
    assert.equal(existsSync(join(root, '.git', 'ai-delivery', 'verification@1', 'stages', 'check')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a consumer RSS ceiling stops a running stage before it can publish a checkpoint', async () => {
  const { root } = await fixture({
    firstStageScript:
      'const held=Buffer.alloc(32*1024*1024,1);setTimeout(()=>process.stdout.write(String(held.length)),500);',
  });
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    writeFileSync(join(row.path, 'change.txt'), 'bounded stage\n');
    git(row.path, 'add', 'change.txt');
    git(row.path, 'commit', '-qm', 'synthetic resource bound');
    await assert.rejects(
      verifyIssue({
        issueNumber: 17,
        repoRoot: row.path,
        resourceBounds: { maxAggregateRssBytes: 1, minFreeDiskBytes: 1 },
      } as Parameters<typeof verifyIssue>[0]),
      /aggregate RSS.*limit/u,
    );
    assert.equal(existsSync(join(root, '.git', 'ai-delivery', 'verification@1', 'stages', 'check')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a consumer filesystem-output ceiling measures new files apart from captured stdout', async () => {
  const { root } = await fixture({
    firstStageScript:
      "const fs=require('fs');fs.writeFileSync('generated.bin',Buffer.alloc(4096));setTimeout(()=>{},500);",
  });
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    writeFileSync(join(row.path, 'change.txt'), 'filesystem output\n');
    git(row.path, 'add', 'change.txt');
    git(row.path, 'commit', '-qm', 'synthetic filesystem output');
    await assert.rejects(
      verifyIssue({
        issueNumber: 17,
        repoRoot: row.path,
        resourceBounds: {
          maxAggregateRssBytes: 1_000_000_000,
          minFreeDiskBytes: 1,
          maxNewOutputBytes: 1_024,
          outputRoots: ['.'],
        },
      } as Parameters<typeof verifyIssue>[0]),
      /new filesystem output.*limit/u,
    );
    assert.equal(existsSync(join(root, '.git', 'ai-delivery', 'verification@1', 'stages', 'check')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('insufficient free disk refuses admission before starting a selected command', async () => {
  const { root } = await fixture({ firstStageScript: 'setTimeout(()=>{},500);' });
  const progress = vi.spyOn(process.stderr, 'write');
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    writeFileSync(join(row.path, 'change.txt'), 'disk admission\n');
    git(row.path, 'add', 'change.txt');
    git(row.path, 'commit', '-qm', 'synthetic disk admission');
    await assert.rejects(
      verifyIssue({
        issueNumber: 17,
        repoRoot: row.path,
        resourceBounds: { maxAggregateRssBytes: 1_000_000_000, minFreeDiskBytes: Number.MAX_SAFE_INTEGER },
      }),
      /Free disk fell below limit/u,
    );
    assert.equal(
      progress.mock.calls.some(([message]) => String(message).includes('"state":"running"')),
      false,
    );
  } finally {
    progress.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the issue_verify request forwards consumer resource limits to the maintained runner', async () => {
  const { root, runtimeEntryPath } = await fixture();
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    writeFileSync(join(row.path, 'change.txt'), 'request resource limits\n');
    git(row.path, 'add', 'change.txt');
    git(row.path, 'commit', '-qm', 'synthetic request resource limits');
    await assert.rejects(
      executeTool(
        'issue_verify',
        {
          issueNumber: 17,
          resourceBounds: { maxAggregateRssBytes: 1_000_000_000, minFreeDiskBytes: Number.MAX_SAFE_INTEGER },
        },
        { repoRoot: root, runtimeEntryPath, identity: 'synthetic-author' },
      ),
      /Free disk fell below limit/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a bounded passing run records measured resources in versioned evidence', async () => {
  const { root, runtimeEntryPath } = await fixture({
    firstStageScript: "setTimeout(()=>process.stdout.write('done'),500);",
  });
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    writeFileSync(join(row.path, 'change.txt'), 'resource evidence\n');
    git(row.path, 'add', 'change.txt');
    git(row.path, 'commit', '-qm', 'synthetic resource evidence');
    const run = await verifyIssue({
      issueNumber: 17,
      repoRoot: row.path,
      resourceBounds: { maxAggregateRssBytes: 1_000_000_000, minFreeDiskBytes: 1 },
    });
    assert.equal(run.schemaVersion, 'ai-delivery.run@3');
    const resources = run.resources;
    assert.ok(resources);
    assert.ok(resources.sampleCount > 0);
    assert.ok((resources.maxSampledAggregateRssBytes ?? 0) > 0);
    assert.ok((resources.minSampledFreeDiskBytes ?? 0) > 0);
    assert.equal(resources.observation, 'sampled');
    assert.equal(resources.processCoverage, 'observed-processes-only');
    const evidence = await createIssuePhaseEvidence({ issueNumber: 17, phase: 'verify', repoRoot: row.path });
    assert.equal(evidence.aggregateId, run.aggregate.aggregateId);
    const dispatched = (await executeTool(
      'issue_verify',
      {
        issueNumber: 17,
        resourceBounds: { maxAggregateRssBytes: 1_000_000_000, minFreeDiskBytes: 1 },
      },
      { repoRoot: root, runtimeEntryPath, identity: 'synthetic-author' },
    )) as { resources?: { processCoverage?: string } };
    assert.equal(dispatched.resources?.processCoverage, 'observed-processes-only');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  { bounded: false, componentPolicy: false },
  { bounded: true, componentPolicy: false },
  { bounded: true, componentPolicy: true },
])(
  'serial admission reuses complete stages with bounds $bounded and component policy $componentPolicy',
  async ({ bounded, componentPolicy }) => {
    const { root, counter, secondCounter, thirdCounter } = await fixture({
      serialResourceStages: true,
      componentPolicy,
    });
    try {
      const row = await prepareIssueWorktree({
        baseRef: 'main',
        identity: 'synthetic-author',
        issueNumber: 17,
        repoRoot: root,
      });
      const input = {
        issueNumber: 17,
        repoRoot: row.path,
        ...(bounded ? { resourceBounds: { maxAggregateRssBytes: 1_000_000_000, minFreeDiskBytes: 1 } } : {}),
      };
      await assert.rejects(
        verifyIssue({ ...input, admittedResourceClasses: ['source_only'] }),
        /Stage 'second' requires explicit model admission/u,
      );
      assert.equal(readFileSync(counter, 'utf8'), '1');
      assert.equal(existsSync(secondCounter), false);
      assert.equal(existsSync(thirdCounter), false);
      await assert.rejects(
        verifyIssue({ ...input, admittedResourceClasses: ['model'] }),
        /Stage 'postgres' requires explicit postgres_docker admission/u,
      );
      assert.equal(readFileSync(counter, 'utf8'), '1');
      assert.equal(readFileSync(secondCounter, 'utf8'), '1');
      assert.equal(existsSync(thirdCounter), false);
      const completed = await verifyIssue({ ...input, admittedResourceClasses: ['postgres_docker'] });
      const repeated = await verifyIssue({ ...input, admittedResourceClasses: [] });
      assert.deepEqual(repeated.stageReceipts, completed.stageReceipts);
      for (const path of [counter, secondCounter, thirdCounter]) assert.equal(readFileSync(path, 'utf8'), '1');
      if (bounded) {
        assert.deepEqual(repeated.resources, completed.resources);
        assert.ok((repeated.resources?.sampleCount ?? 0) > 0);
        const first = completed.stageReceipts[0]!;
        const stagePath = join(
          root,
          '.git',
          'ai-delivery',
          first.input.schemaVersion === 'ai-delivery.stage-input@2' ? 'verification@2' : 'verification@1',
          'stages',
          'check',
          `${first.input.inputId.slice(7)}.json`,
        );
        rmSync(stagePath);
        const repaired = await verifyIssue({ ...input, admittedResourceClasses: [] });
        assert.deepEqual(repaired.stageReceipts, completed.stageReceipts);
        assert.deepEqual(repaired.resources, completed.resources);
        assert.equal(existsSync(stagePath), true);
        assert.equal(readFileSync(counter, 'utf8'), '1');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.each(['missing', 'unmeasured', 'source', 'command', 'environment', 'runtime', 'producer', 'bounds'] as const)(
  'serial admission refuses execution after %s proof invalidation',
  async (changed) => {
    const { root, counter, secondCounter, thirdCounter } = await fixture({ serialResourceStages: true });
    const previousPath = process.env.PATH;
    const versionDescriptor = Object.getOwnPropertyDescriptor(process, 'version')!;
    const producerPath = join(import.meta.dirname, 'serial-producer-fixture.js');
    let producerOwned = false;
    try {
      const row = await prepareIssueWorktree({
        baseRef: 'main',
        identity: 'synthetic-author',
        issueNumber: 17,
        repoRoot: root,
      });
      const input = {
        issueNumber: 17,
        repoRoot: row.path,
        resourceBounds: { maxAggregateRssBytes: 1_000_000_000, minFreeDiskBytes: 1 },
      };
      const completed = await verifyIssue({
        ...(changed === 'unmeasured' ? { issueNumber: input.issueNumber, repoRoot: input.repoRoot } : input),
        admittedResourceClasses: ['source_only', 'model', 'postgres_docker'],
      });
      if (changed === 'missing') {
        const id = completed.stageReceipts[0]!.input.inputId.slice(7);
        rmSync(join(root, '.git', 'ai-delivery', 'verification@1', 'stages', 'check', `${id}.json`));
        rmSync(join(root, '.git', 'ai-delivery', 'resource-stages@1', `${id}.json`));
      } else if (changed === 'source' || changed === 'command') {
        const path = join(row.path, changed === 'source' ? 'change.txt' : 'policy.mjs');
        writeFileSync(
          path,
          changed === 'source'
            ? 'changed source\n'
            : readFileSync(path, 'utf8').replace("label: 'count'", "label: 'changed-count'"),
        );
        git(row.path, 'add', '.');
        git(row.path, 'commit', '-qm', 'synthetic checkpoint invalidation');
      } else if (changed === 'environment') process.env.PATH = `${previousPath ?? ''}:/synthetic-environment`;
      else if (changed === 'runtime') Object.defineProperty(process, 'version', { value: 'v0.0.0' });
      else if (changed === 'producer') {
        assert.equal(existsSync(producerPath), false);
        writeFileSync(producerPath, '// changed synthetic runner identity\n');
        producerOwned = true;
      } else if (changed === 'bounds') input.resourceBounds.maxAggregateRssBytes -= 1;
      await assert.rejects(
        verifyIssue({ ...input, admittedResourceClasses: ['postgres_docker'] }),
        /Stage 'check' requires explicit source_only admission/u,
      );
      for (const path of [counter, secondCounter, thirdCounter]) assert.equal(readFileSync(path, 'utf8'), '1');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      Object.defineProperty(process, 'version', versionDescriptor);
      if (producerOwned) rmSync(producerPath);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.each([
  'stage',
  'canonical',
  'artifact',
  'output',
  'resource',
  'resource-bounds',
  'resource-samples',
  'missing-resource',
  'baseline',
] as const)('serial admission rejects corrupt %s proof before considering execution', async (corrupt) => {
  const { root, counter, secondCounter, thirdCounter } = await fixture({ serialResourceStages: true });
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    mkdirSync(join(row.path, '.issue-cli'), { recursive: true });
    const input = {
      issueNumber: 17,
      repoRoot: row.path,
      resourceBounds: {
        maxAggregateRssBytes: 1_000_000_000,
        minFreeDiskBytes: 1,
        maxNewOutputBytes: 1_000_000,
        outputRoots: ['.issue-cli'],
      },
    };
    const completed = await verifyIssue({
      ...input,
      admittedResourceClasses: ['source_only', 'model', 'postgres_docker'],
    });
    const first = completed.stageReceipts[0]!;
    const common = join(root, '.git', 'ai-delivery');
    const id = first.input.inputId.slice(7);
    const stagePath = join(common, 'verification@1', 'stages', 'check', `${id}.json`);
    const resourcePath = join(common, 'resource-stages@1', `${id}.json`);
    if (corrupt === 'stage') writeFileSync(stagePath, 'corrupt stage proof\n');
    else if (corrupt === 'canonical') writeFileSync(stagePath, `${readFileSync(stagePath, 'utf8')}\n`);
    else if (corrupt === 'artifact') {
      const { receiptId: _receiptId, ...content } = first;
      const altered = { ...content, artifacts: [{ path: 'artifact.txt', digest: digestValue('corrupt artifact') }] };
      writeFileSync(stagePath, stableJson({ ...altered, receiptId: digestValue(altered) }));
    } else if (corrupt === 'output') {
      writeFileSync(
        join(common, 'verification@1', 'command-output', `${first.commands[0]!.outputDigest.slice(7)}.bin`),
        'corrupt output',
      );
    } else if (corrupt === 'resource') writeFileSync(resourcePath, 'corrupt resource proof\n');
    else if (corrupt === 'missing-resource') rmSync(resourcePath);
    else if (corrupt === 'baseline') {
      const directory = join(common, 'output-baselines@1');
      const file = readdirSync(directory).find((name) => name.endsWith('.json') && !name.endsWith('.state.json'))!;
      writeFileSync(join(directory, file), 'corrupt baseline proof\n');
    } else {
      const { checkpointId: _checkpointId, ...content } = JSON.parse(readFileSync(resourcePath, 'utf8')) as {
        checkpointId: string;
        resources: { bounds: { maxAggregateRssBytes: number }; sampleCount: number };
      };
      if (corrupt === 'resource-bounds') content.resources.bounds.maxAggregateRssBytes += 1;
      else content.resources.sampleCount = 0;
      writeFileSync(resourcePath, JSON.stringify({ ...content, checkpointId: digestValue(content) }));
    }
    await assert.rejects(
      verifyIssue({ ...input, admittedResourceClasses: ['postgres_docker'] }),
      (error: unknown) => error instanceof Error && !error.message.includes('admission'),
    );
    for (const path of [counter, secondCounter, thirdCounter]) assert.equal(readFileSync(path, 'utf8'), '1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('serial admission requires dependent execution after a real upstream rerun', async () => {
  const { root, counter, secondCounter, thirdCounter } = await fixture({ serialResourceStages: true });
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    const input = {
      issueNumber: 17,
      repoRoot: row.path,
      resourceBounds: { maxAggregateRssBytes: 1_000_000_000, minFreeDiskBytes: 1 },
    };
    const completed = await verifyIssue({
      ...input,
      admittedResourceClasses: ['source_only', 'model', 'postgres_docker'],
    });
    const id = completed.stageReceipts[0]!.input.inputId.slice(7);
    rmSync(join(root, '.git', 'ai-delivery', 'verification@1', 'stages', 'check', `${id}.json`));
    rmSync(join(root, '.git', 'ai-delivery', 'resource-stages@1', `${id}.json`));
    await assert.rejects(
      verifyIssue({ ...input, admittedResourceClasses: ['source_only'] }),
      /Stage 'second' requires explicit model admission/u,
    );
    assert.equal(readFileSync(counter, 'utf8'), '2');
    assert.equal(readFileSync(secondCounter, 'utf8'), '1');
    assert.equal(readFileSync(thirdCounter, 'utf8'), '1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bounded verification reruns unmeasured work and reuses only matching measured stages', async () => {
  const { root, counter, secondCounter, failSecond } = await fixture({ twoStages: true });
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    writeFileSync(join(row.path, 'change.txt'), 'resource resume\n');
    git(row.path, 'add', 'change.txt');
    git(row.path, 'commit', '-qm', 'synthetic resource resume');
    await verifyIssue({ issueNumber: 17, repoRoot: row.path });
    assert.equal(readFileSync(counter, 'utf8'), '1');
    assert.equal(readFileSync(secondCounter, 'utf8'), '1');
    const bounds = { maxAggregateRssBytes: 1_000_000_000, minFreeDiskBytes: 1 };
    writeFileSync(failSecond, 'fail once\n');
    await assert.rejects(verifyIssue({ issueNumber: 17, repoRoot: row.path, resourceBounds: bounds }), /exit 7/u);
    assert.equal(readFileSync(counter, 'utf8'), '2');
    assert.equal(readFileSync(secondCounter, 'utf8'), '2');
    rmSync(failSecond);
    const resumed = await verifyIssue({ issueNumber: 17, repoRoot: row.path, resourceBounds: bounds });
    assert.equal(readFileSync(counter, 'utf8'), '2');
    assert.equal(readFileSync(secondCounter, 'utf8'), '3');
    assert.ok((resumed.resources?.sampleCount ?? 0) > 0);
    const repeated = await verifyIssue({ issueNumber: 17, repoRoot: row.path, resourceBounds: bounds });
    assert.equal(readFileSync(counter, 'utf8'), '2');
    assert.equal(readFileSync(secondCounter, 'utf8'), '3');
    assert.ok((repeated.resources?.sampleCount ?? 0) > 0);
    const stageInputId = repeated.stageReceipts[0]!.input.inputId.slice(7);
    const stagePath = join(root, '.git', 'ai-delivery', 'verification@1', 'stages', 'check', `${stageInputId}.json`);
    rmSync(stagePath);
    await verifyIssue({ issueNumber: 17, repoRoot: row.path, resourceBounds: bounds });
    assert.equal(readFileSync(counter, 'utf8'), '2');
    assert.equal(existsSync(stagePath), true);
    await verifyIssue({
      issueNumber: 17,
      repoRoot: row.path,
      resourceBounds: { ...bounds, maxAggregateRssBytes: 900_000_000 },
    });
    assert.equal(readFileSync(counter, 'utf8'), '3');
    assert.equal(readFileSync(secondCounter, 'utf8'), '4');
    const sidecar = join(root, '.git', 'ai-delivery', 'resource-stages@1', `${stageInputId}.json`);
    writeFileSync(sidecar, 'corrupt\n');
    await assert.rejects(
      verifyIssue({ issueNumber: 17, repoRoot: row.path, resourceBounds: bounds }),
      /Resource stage checkpoint is corrupt/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('filesystem output already measured in a resumed stage counts toward the run limit', async () => {
  const { root } = await fixture({
    twoStages: true,
    firstStageScript:
      "const fs=require('fs');fs.mkdirSync('.issue-cli',{recursive:true});fs.writeFileSync('.issue-cli/a.bin',Buffer.alloc(700));const p='.issue-cli/count';fs.writeFileSync(p,String(Number(fs.existsSync(p)?fs.readFileSync(p,'utf8'):0)+1));setTimeout(()=>{},100);",
    secondStageScript:
      "const fs=require('fs');if(fs.existsSync('.issue-cli/fail'))process.exit(7);fs.writeFileSync('.issue-cli/b.bin',Buffer.alloc(700));setTimeout(()=>{},100);",
  });
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    writeFileSync(join(row.path, 'change.txt'), 'cumulative output\n');
    git(row.path, 'add', 'change.txt');
    git(row.path, 'commit', '-qm', 'synthetic cumulative output');
    mkdirSync(join(row.path, '.issue-cli'));
    writeFileSync(join(row.path, '.issue-cli', 'fail'), 'x');
    const resourceBounds = {
      maxAggregateRssBytes: 1_000_000_000,
      minFreeDiskBytes: 1,
      maxNewOutputBytes: 1_000,
      outputRoots: ['.issue-cli'],
    };
    await assert.rejects(verifyIssue({ issueNumber: 17, repoRoot: row.path, resourceBounds }), /exit 7/u);
    assert.equal(readFileSync(join(row.path, '.issue-cli', 'count'), 'utf8'), '1');
    rmSync(join(row.path, '.issue-cli', 'fail'));
    await assert.rejects(
      verifyIssue({ issueNumber: 17, repoRoot: row.path, resourceBounds }),
      /new filesystem output.*limit/u,
    );
    assert.equal(readFileSync(join(row.path, '.issue-cli', 'count'), 'utf8'), '1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed-stage filesystem output remains charged on retry', async () => {
  const { root } = await fixture({
    firstStageScript:
      "const fs=require('fs');fs.mkdirSync('.issue-cli',{recursive:true});fs.appendFileSync('.issue-cli/output.bin',Buffer.alloc(700));if(fs.existsSync('.issue-cli/fail'))process.exit(7);setTimeout(()=>{},100);",
  });
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    writeFileSync(join(row.path, 'change.txt'), 'failed output\n');
    git(row.path, 'add', 'change.txt');
    git(row.path, 'commit', '-qm', 'synthetic failed output');
    mkdirSync(join(row.path, '.issue-cli'));
    const fail = join(row.path, '.issue-cli', 'fail');
    writeFileSync(fail, 'x');
    const resourceBounds = {
      maxAggregateRssBytes: 1_000_000_000,
      minFreeDiskBytes: 1,
      maxNewOutputBytes: 1_000,
      outputRoots: ['.issue-cli'],
    };
    await assert.rejects(verifyIssue({ issueNumber: 17, repoRoot: row.path, resourceBounds }), /exit 7/u);
    assert.equal(readFileSync(join(row.path, '.issue-cli', 'output.bin')).length, 700);
    rmSync(fail);
    await assert.rejects(
      verifyIssue({ issueNumber: 17, repoRoot: row.path, resourceBounds }),
      /new filesystem output.*limit/u,
    );
    assert.equal(readFileSync(join(row.path, '.issue-cli', 'output.bin')).length, 1_400);
    assert.equal(existsSync(join(root, '.git', 'ai-delivery', 'verification@1', 'stages', 'check')), false);
    rmSync(join(row.path, '.issue-cli', 'output.bin'));
    const completed = await verifyIssue({ issueNumber: 17, repoRoot: row.path, resourceBounds });
    assert.equal(readFileSync(join(row.path, '.issue-cli', 'output.bin')).length, 700);
    assert.ok((completed.resources?.maxSampledNewOutputBytes ?? 0) < 1_000);
    const baselineDirectory = join(root, '.git', 'ai-delivery', 'output-baselines@1');
    const snapshot = readdirSync(baselineDirectory).find(
      (name) => name.endsWith('.json') && !name.endsWith('.state.json'),
    );
    assert.ok(snapshot);
    rmSync(join(baselineDirectory, snapshot));
    await assert.rejects(
      verifyIssue({ issueNumber: 17, repoRoot: row.path, resourceBounds }),
      /Filesystem output baseline checkpoint is missing or corrupt/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mixed-case output filenames round-trip through the durable baseline', async () => {
  const { root } = await fixture();
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    writeFileSync(join(row.path, 'change.txt'), 'mixed-case output\n');
    git(row.path, 'add', 'change.txt');
    git(row.path, 'commit', '-qm', 'synthetic mixed-case output');
    const output = join(row.path, '.issue-cli');
    mkdirSync(output);
    writeFileSync(join(output, 'a.bin'), 'a');
    writeFileSync(join(output, 'B.bin'), 'B');
    const run = await verifyIssue({
      issueNumber: 17,
      repoRoot: row.path,
      resourceBounds: {
        maxAggregateRssBytes: 1_000_000_000,
        minFreeDiskBytes: 1,
        maxNewOutputBytes: 1_000,
        outputRoots: ['.issue-cli'],
      },
    });
    assert.equal(run.resources?.maxSampledNewOutputBytes, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('aggregate RSS crossing stops three individually under-limit children', async () => {
  const marker = join(tmpdir(), `ai-delivery-rss-children-${process.pid}-${Date.now()}`);
  const limit = 200_000_000;
  const worker = `const fs=require('fs');const held=Buffer.alloc(32*1024*1024,1);fs.writeFileSync(${JSON.stringify(marker)}+'-'+process.pid,String(process.memoryUsage().rss));setInterval(()=>{void held[0]},1000);`;
  const { root } = await fixture({
    firstStageScript: `const {spawn}=require('child_process');for(let i=0;i<3;i++)spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:'ignore'});setTimeout(()=>{},3000);`,
  });
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    writeFileSync(join(row.path, 'change.txt'), 'aggregate RSS\n');
    git(row.path, 'add', 'change.txt');
    git(row.path, 'commit', '-qm', 'synthetic aggregate RSS');
    await assert.rejects(
      verifyIssue({
        issueNumber: 17,
        repoRoot: row.path,
        resourceBounds: { maxAggregateRssBytes: limit, minFreeDiskBytes: 1 },
      }),
      /aggregate RSS.*limit/u,
    );
    const rows = readdirSync(tmpdir()).filter((name) => name.startsWith(`${marker.split('/').at(-1)}-`));
    assert.equal(rows.length, 3);
    for (const name of rows) assert.ok(Number(readFileSync(join(tmpdir(), name), 'utf8')) < limit);
    assert.equal(existsSync(join(root, '.git', 'ai-delivery', 'verification@1', 'stages', 'check')), false);
  } finally {
    for (const name of readdirSync(tmpdir()).filter((value) => value.startsWith(`${marker.split('/').at(-1)}-`))) {
      const pid = Number(name.slice(name.lastIndexOf('-') + 1));
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already stopped */
      }
      rmSync(join(tmpdir(), name), { force: true });
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('filesystem output from a sampled detached child crosses its declared root limit', async () => {
  const marker = join(tmpdir(), `ai-delivery-detached-output-${process.pid}-${Date.now()}`);
  const heartbeat = `${marker}-heartbeat`;
  const worker = `const fs=require('fs');fs.writeFileSync('generated.bin',Buffer.alloc(4096));setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),20);`;
  const { root } = await fixture({
    firstStageScript: `const fs=require('fs');const {spawn}=require('child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(worker)}],{detached:true,stdio:'ignore'});child.unref();fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));setTimeout(()=>{},2500);`,
  });
  let descendantPid: number | undefined;
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    writeFileSync(join(row.path, 'change.txt'), 'detached output\n');
    git(row.path, 'add', 'change.txt');
    git(row.path, 'commit', '-qm', 'synthetic detached output');
    await assert.rejects(
      verifyIssue({
        issueNumber: 17,
        repoRoot: row.path,
        resourceBounds: {
          maxAggregateRssBytes: 1_000_000_000,
          minFreeDiskBytes: 1,
          maxNewOutputBytes: 1_024,
          outputRoots: ['.'],
        },
      }),
      /new filesystem output.*limit/u,
    );
    descendantPid = Number(readFileSync(marker, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const stoppedSize = existsSync(heartbeat) ? readFileSync(heartbeat).length : 0;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(heartbeat) ? readFileSync(heartbeat).length : 0, stoppedSize);
    assert.equal(existsSync(join(root, '.git', 'ai-delivery', 'verification@1', 'stages', 'check')), false);
  } finally {
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, 'SIGKILL');
      } catch {
        /* already stopped */
      }
    }
    rmSync(marker, { force: true });
    rmSync(heartbeat, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('contained npm bin aliases are counted once and target growth still enforces the output bound', async () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-contained-alias-')));
  const target = join(outside, 'output', 'actual');
  const { root } = await fixture({
    firstStageScript: `require('fs').appendFileSync(${JSON.stringify(target)},'x'.repeat(512));`,
  });
  try {
    mkdirSync(dirname(target));
    writeFileSync(target, 'baseline');
    symlinkSync('./actual', join(dirname(target), 'alias'));
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    const bounds = {
      maxAggregateRssBytes: 1_000_000_000,
      minFreeDiskBytes: 1,
      maxNewOutputBytes: 600,
      outputRoots: [dirname(target)],
    };
    const run = await verifyIssue({ issueNumber: 17, repoRoot: row.path, resourceBounds: bounds });
    assert.equal(run.resources?.maxSampledNewOutputBytes, 512);
    await assert.rejects(
      verifyIssue({ issueNumber: 17, repoRoot: row.path, resourceBounds: { ...bounds, maxNewOutputBytes: 100 } }),
      /filesystem output.*exceeded/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('a symbolic link in declared output roots fails before publishing sampled output evidence', async () => {
  const { root } = await fixture();
  const outside = mkdtempSync(join(tmpdir(), 'ai-delivery-output-link-'));
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    writeFileSync(join(row.path, 'change.txt'), 'linked output\n');
    git(row.path, 'add', 'change.txt');
    git(row.path, 'commit', '-qm', 'synthetic linked output');
    mkdirSync(join(outside, 'target'));
    symlinkSync(join(outside, 'target'), join(outside, 'declared'));
    await assert.rejects(
      verifyIssue({
        issueNumber: 17,
        repoRoot: row.path,
        resourceBounds: {
          maxAggregateRssBytes: 1_000_000_000,
          minFreeDiskBytes: 1,
          maxNewOutputBytes: 1_024,
          outputRoots: [join(outside, 'declared')],
        },
      }),
      /symbolic link/u,
    );
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unobserved detached pipe holder cannot keep a cancelled stage pending indefinitely', async () => {
  const marker = join(tmpdir(), `ai-delivery-escaped-pipe-${process.pid}-${Date.now()}`);
  const { root } = await fixture({
    firstStageScript: `const fs=require('fs');const {spawn}=require('child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','inherit','inherit']});child.unref();fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));process.exit(0);`,
  });
  let descendantPid: number | undefined;
  let run: Promise<unknown> | undefined;
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    writeFileSync(join(row.path, 'change.txt'), 'escaped pipe\n');
    git(row.path, 'add', 'change.txt');
    git(row.path, 'commit', '-qm', 'synthetic escaped pipe');
    const controller = new AbortController();
    run = verifyIssue({
      issueNumber: 17,
      repoRoot: row.path,
      signal: controller.signal,
      resourceBounds: { maxAggregateRssBytes: 1_000_000_000, minFreeDiskBytes: 1 },
    });
    const deadline = Date.now() + 2_000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(existsSync(marker), true);
    descendantPid = Number(readFileSync(marker, 'utf8'));
    controller.abort();
    await assert.rejects(
      Promise.race([
        run,
        new Promise((_, reject) => setTimeout(() => reject(new Error('cleanup remained pending')), 3_000)),
      ]),
      /owned command pipes did not close/u,
    );
    assert.equal(existsSync(join(root, '.git', 'ai-delivery', 'verification@1', 'stages', 'check')), false);
  } finally {
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, 'SIGKILL');
      } catch {
        /* already stopped */
      }
    }
    await run?.catch(() => undefined);
    rmSync(marker, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a direct child exit with inherited pipes still open fails within a bounded cleanup interval', async () => {
  const marker = join(tmpdir(), `ai-delivery-exited-pipe-${process.pid}-${Date.now()}`);
  const { root } = await fixture({
    firstStageScript: `const fs=require('fs');const {spawn}=require('child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','inherit','inherit']});child.unref();fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));process.exit(0);`,
  });
  let descendantPid: number | undefined;
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    writeFileSync(join(row.path, 'change.txt'), 'exited pipe\n');
    git(row.path, 'add', 'change.txt');
    git(row.path, 'commit', '-qm', 'synthetic exited pipe');
    const run = verifyIssue({
      issueNumber: 17,
      repoRoot: row.path,
      resourceBounds: { maxAggregateRssBytes: 1_000_000_000, minFreeDiskBytes: 1 },
    });
    const deadline = Date.now() + 2_000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(existsSync(marker), true);
    descendantPid = Number(readFileSync(marker, 'utf8'));
    await assert.rejects(
      Promise.race([
        run,
        new Promise((_, reject) => setTimeout(() => reject(new Error('stage remained pending')), 3_500)),
      ]),
      /owned command pipes did not close/u,
    );
    assert.equal(existsSync(join(root, '.git', 'ai-delivery', 'verification@1', 'stages', 'check')), false);
  } finally {
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, 'SIGKILL');
      } catch {
        /* already stopped */
      }
    }
    rmSync(marker, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('bounded cancellation cleans a sampled detached descendant and preserves an unrelated process', async () => {
  const marker = join(tmpdir(), `ai-delivery-detached-child-${process.pid}-${Date.now()}`);
  const heartbeat = `${marker}-heartbeat`;
  const unrelatedHeartbeat = `${marker}-unrelated`;
  const { root } = await fixture({
    firstStageScript: `const fs=require('fs');const {spawn}=require('child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),20);`)}],{detached:true,stdio:'ignore'});child.unref();fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));setTimeout(()=>{},2500);`,
  });
  const unrelated = spawn(
    process.execPath,
    ['-e', `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(unrelatedHeartbeat)},'x'),20);`],
    { detached: true, stdio: 'ignore' },
  );
  unrelated.unref();
  let descendantPid: number | undefined;
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    writeFileSync(join(row.path, 'change.txt'), 'detached child\n');
    git(row.path, 'add', 'change.txt');
    git(row.path, 'commit', '-qm', 'synthetic detached child');
    const controller = new AbortController();
    const run = verifyIssue({
      issueNumber: 17,
      repoRoot: row.path,
      signal: controller.signal,
      resourceBounds: { maxAggregateRssBytes: 1_000_000_000, minFreeDiskBytes: 1 },
    });
    const deadline = Date.now() + 2_000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(existsSync(marker), true);
    descendantPid = Number(readFileSync(marker, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    controller.abort();
    await assert.rejects(run, /cancelled/u);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const stoppedSize = existsSync(heartbeat) ? readFileSync(heartbeat).length : 0;
    const unrelatedSize = existsSync(unrelatedHeartbeat) ? readFileSync(unrelatedHeartbeat).length : 0;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(heartbeat) ? readFileSync(heartbeat).length : 0, stoppedSize);
    assert.ok(readFileSync(unrelatedHeartbeat).length > unrelatedSize);
  } finally {
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, 'SIGKILL');
      } catch {
        /* already stopped */
      }
    }
    if (unrelated.pid !== undefined) {
      try {
        process.kill(unrelated.pid, 'SIGKILL');
      } catch {
        /* already stopped */
      }
    }
    rmSync(marker, { force: true });
    rmSync(heartbeat, { force: true });
    rmSync(unrelatedHeartbeat, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('sampled evidence identifies the escape boundary for a detached pipe-free child', async () => {
  const marker = join(tmpdir(), `ai-delivery-late-detach-${process.pid}-${Date.now()}`);
  const heartbeat = `${marker}-heartbeat`;
  const trigger = `${marker}-trigger`;
  const { root } = await fixture({
    firstStageScript: `const fs=require('fs');const {spawn}=require('child_process');const wait=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(trigger)}))return;clearInterval(wait);setTimeout(()=>{const child=spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),20);`)}],{detached:true,stdio:'ignore'});child.unref();fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));},250);setTimeout(()=>process.exit(0),500);},5);`,
  });
  let descendantPid: number | undefined;
  const controller = new AbortController();
  const progress = vi.spyOn(process.stderr, 'write');
  let run: Promise<unknown> | undefined;
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    writeFileSync(join(row.path, 'change.txt'), 'late detach\n');
    git(row.path, 'add', 'change.txt');
    git(row.path, 'commit', '-qm', 'synthetic late detach');
    run = verifyIssue({
      issueNumber: 17,
      repoRoot: row.path,
      signal: controller.signal,
      resourceBounds: { maxAggregateRssBytes: 1_000_000_000, minFreeDiskBytes: 1 },
    });
    const deadline = Date.now() + 2_000;
    while (
      !progress.mock.calls.some(([message]) => String(message).includes('"sampledAggregateRssBytes"')) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(progress.mock.calls.some(([message]) => String(message).includes('"sampledAggregateRssBytes"')));
    writeFileSync(trigger, 'go');
    const result = await run;
    assert.equal(
      (result as Awaited<ReturnType<typeof verifyIssue>>).resources?.processCoverage,
      'observed-processes-only',
    );
    assert.equal((result as Awaited<ReturnType<typeof verifyIssue>>).aggregate.result, 'passed');
    descendantPid = Number(readFileSync(marker, 'utf8'));
    const size = existsSync(heartbeat) ? readFileSync(heartbeat).length : 0;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok((existsSync(heartbeat) ? readFileSync(heartbeat).length : 0) > size);
  } finally {
    controller.abort();
    await run?.catch(() => undefined);
    progress.mockRestore();
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, 'SIGKILL');
      } catch {
        /* already stopped */
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
      const stopped = existsSync(heartbeat) ? readFileSync(heartbeat).length : 0;
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(existsSync(heartbeat) ? readFileSync(heartbeat).length : 0, stopped);
    }
    rmSync(marker, { force: true });
    rmSync(heartbeat, { force: true });
    rmSync(trigger, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a successful command cannot publish while its sampled detached descendant survives', async () => {
  const marker = join(tmpdir(), `ai-delivery-left-behind-${process.pid}-${Date.now()}`);
  const heartbeat = `${marker}-heartbeat`;
  const { root } = await fixture({
    firstStageScript: `const fs=require('fs');const {spawn}=require('child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),20);`)}],{detached:true,stdio:'ignore'});child.unref();fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));setTimeout(()=>{},1400);`,
  });
  let descendantPid: number | undefined;
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    writeFileSync(join(row.path, 'change.txt'), 'left behind\n');
    git(row.path, 'add', 'change.txt');
    git(row.path, 'commit', '-qm', 'synthetic left behind descendant');
    await assert.rejects(
      verifyIssue({
        issueNumber: 17,
        repoRoot: row.path,
        resourceBounds: { maxAggregateRssBytes: 1_000_000_000, minFreeDiskBytes: 1 },
      }),
      /owned descendant survived/u,
    );
    descendantPid = Number(readFileSync(marker, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const stoppedSize = existsSync(heartbeat) ? readFileSync(heartbeat).length : 0;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(heartbeat) ? readFileSync(heartbeat).length : 0, stoppedSize);
    assert.equal(existsSync(join(root, '.git', 'ai-delivery', 'verification@1', 'stages', 'check')), false);
  } finally {
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, 'SIGKILL');
      } catch {
        /* already stopped */
      }
    }
    rmSync(marker, { force: true });
    rmSync(heartbeat, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
test('public PR dry run retains a configured host author and App reviewer', async () => {
  const { root } = await fixture({ personalAuthor: true });
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'host-author',
      issueNumber: 17,
      repoRoot: root,
    });
    writeFileSync(join(row.path, 'change.txt'), 'host author change\n');
    git(row.path, 'add', 'change.txt');
    git(row.path, 'commit', '-qm', 'synthetic host author change');
    await verifyIssue({ issueNumber: 17, repoRoot: row.path });
    const result = (await executeTool(
      'issue_pr_create',
      { issueNumber: 17, dryRun: true },
      { repoRoot: row.path, identity: 'host-author' },
    )) as {
      dryRun: boolean;
      reviewRoute: {
        author: { actorLogin: string; authSource: string; credentialSource: string };
        reviewer: { actorLogin: string };
        approvalEligibility: string;
      };
    };
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.reviewRoute.author, {
      actorLogin: 'host-user',
      authSource: 'personal',
      credentialSource: 'env:AUTHOR_TOKEN',
      identity: 'host-author',
    });
    assert.equal(result.reviewRoute.reviewer.actorLogin, 'synthetic-reviewer');
    assert.equal(result.reviewRoute.approvalEligibility, 'unknown');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test.each([
  { transition: false, entry: 'source', highRisk: false, mcp: false },
  { transition: true, entry: 'primary', highRisk: false, mcp: false },
  { transition: true, entry: 'source', highRisk: false, mcp: false },
  { transition: true, entry: 'primary', highRisk: true, mcp: false },
  { transition: true, entry: 'source', highRisk: true, mcp: false },
  { transition: true, entry: 'primary', highRisk: true, mcp: true },
])(
  'public dispatch publishes and reviews from $entry across policy transition $transition high risk $highRisk MCP $mcp',
  async ({ transition, entry, highRisk, mcp }) => {
    const { root, runtimeEntryPath } = await fixture({ personalAuthor: !transition });
    const originalPath = process.env.PATH;
    const driftEnv = 'AI_DELIVERY_TEST_CANDIDATE_CHECK';
    const previousDrift = process.env[driftEnv];
    delete process.env[driftEnv];
    let closeMcp: (() => Promise<void>) | undefined;
    try {
      const admissionPath = join(root, '.git', 'ai-delivery', 'runtime-admission.json');
      const admissionBefore = readFileSync(admissionPath, 'utf8');
      const primaryConfiguration = await loadDeliveryConfig(root);
      const row = await prepareIssueWorktree({
        baseRef: 'main',
        identity: transition ? 'synthetic-author' : 'host-author',
        issueNumber: 17,
        repoRoot: root,
      });
      if (transition) {
        const policyPath = join(row.path, 'policy.mjs');
        writeFileSync(
          policyPath,
          readFileSync(policyPath, 'utf8')
            .replace(
              JSON.stringify(primaryConfiguration.config.roles.author),
              JSON.stringify({
                authSource: 'personal',
                credentialEnv: { token: 'AUTHOR_TOKEN' },
                identity: 'host-author',
              }),
            )
            .replace("risk: 'standard'", `risk: '${highRisk ? 'high' : 'standard'}'`) +
            `
Object.defineProperty(deliverySettings.commandPolicy.checks, 'test', { get: () => process.env.${driftEnv} ?? 'REQUIRED' });
`,
        );
      }
      writeFileSync(join(row.path, 'change.txt'), 'host author publication\n');
      git(row.path, 'add', '.');
      git(row.path, 'commit', '-qm', 'synthetic host publication');
      const realGit = (originalPath ?? '')
        .split(':')
        .map((directory) => join(directory, 'git'))
        .find(existsSync);
      if (!realGit) throw new Error('Git executable unavailable for public transport test.');
      git(root, 'config', '--local', '--unset', `url.${join(root, '.git', 'remote.git')}.insteadOf`);
      const shimDir = join(root, '.git', 'git-shim');
      const pushMarker = join(root, '.git', 'selected-host-push');
      mkdirSync(shimDir);
      const shim = join(shimDir, 'git');
      writeFileSync(
        shim,
        `#!/bin/sh
if [ "$1" = -c ] && [ "$2" = credential.helper= ] && [ "$3" = push ]; then
  [ "$AI_DELIVERY_GIT_TOKEN" = selected-personal-token ] || exit 91
  [ "$("$GIT_ASKPASS" Password)" = selected-personal-token ] || exit 92
  : > "${pushMarker}"
  exit 0
fi
exec "${realGit}" "$@"
`,
      );
      chmodSync(shim, 0o700);
      process.env.PATH = `${shimDir}:${originalPath ?? ''}`;
      const execution = { repoRoot: entry === 'primary' ? root : row.path, runtimeEntryPath, identity: 'host-author' };
      let call = (name: Parameters<typeof executeTool>[0], args: Record<string, unknown>) =>
        executeTool(name, args, execution);
      if (mcp) {
        const server = createAiDeliveryMcpServer(execution);
        const client = new Client({ name: 'policy-transition-test', version: '1.0.0' });
        closeMcp = async () => {
          await client.close();
          await server.close();
        };
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        call = async (name, args) => {
          const result = await client.callTool({ name, arguments: args });
          const text = (result.content as Array<{ type: string; text: string }>).find(
            (block) => block.type === 'text',
          )!.text;
          if (result.isError) throw new Error(text);
          return JSON.parse(text) as unknown;
        };
      }
      const classified = await verifyIssue({ issueNumber: 17, repoRoot: row.path });
      const reviewContent = {
        authorIdentity: 'host-author',
        checks: ['verified exact diff'],
        diffScopeHash: digestValue(classified.classification.changedPaths),
        elapsedMs: 1,
        findings: [],
        head: classified.classification.head,
        issueNumber: 17,
        prNumber: null,
        readOnly: true,
        requestedEffort: 'xhigh',
        requestedModel: 'gpt-6-astra',
        effectiveEffort: 'xhigh',
        effectiveModel: 'gpt-6-astra',
        reviewerIdentity: 'synthetic-reviewer',
        schemaVersion: 'ai-delivery.review-artifact@1',
        summary: 'Independent exact-head review',
        verdict: 'approve',
      };
      const prepublicationReview = join(root, '.git', 'prepublication-review.json');
      if (highRisk) {
        await assert.rejects(call('issue_verify', { issueNumber: 17 }), /independent exact-head approval/u);
        writeFileSync(
          prepublicationReview,
          JSON.stringify({ ...reviewContent, artifactId: digestValue(reviewContent) }),
        );
      }
      const verified = (await call('issue_verify', {
        issueNumber: 17,
        ...(highRisk ? { prepublicationReview } : {}),
      })) as { evidenceId: string };
      const run = loadVerifiedRun(row.path, 17);
      const candidateConfiguration = await loadDeliveryConfig(row.path);
      assert.equal(run.classification.configDigest, candidateConfiguration.configDigest);
      assert.equal(run.classification.policyDigest, sha256(join(row.path, 'policy.mjs')));
      if (transition) assert.notEqual(run.classification.configDigest, primaryConfiguration.configDigest);
      assert.equal(readFileSync(admissionPath, 'utf8'), admissionBefore);
      const phaseEvidence = JSON.parse(
        readFileSync(
          join(
            root,
            '.git',
            'ai-delivery',
            'receipts',
            'delivery@1',
            run.classification.head.sha,
            `${verified.evidenceId.slice(7)}.json`,
          ),
          'utf8',
        ),
      ) as {
        configDigest: string;
        aggregateId: string;
        approval: { authorIdentity: string; reviewerIdentity: string } | null;
      };
      assert.equal(phaseEvidence.configDigest, candidateConfiguration.configDigest);
      assert.equal(phaseEvidence.aggregateId, run.aggregate.aggregateId);
      if (highRisk) {
        assert.equal(phaseEvidence.approval?.authorIdentity, 'host-author');
        assert.equal(phaseEvidence.approval?.reviewerIdentity, 'synthetic-reviewer');
      }
      personalRoute.baseSha = run.classification.base.sha;
      personalRoute.headSha = run.classification.head.sha;
      personalRoute.reviews.length = 0;
      personalRoute.submitted = 0;
      personalRoute.created = false;
      personalRoute.failCreate = false;
      personalRoute.ready = false;
      personalRoute.readyPromotions = 0;
      personalRoute.active = true;

      if (transition) {
        await assert.rejects(
          executeTool('issue_pr_create', { issueNumber: 17 }, { ...execution, identity: 'synthetic-author' }),
          /configured author identity/u,
        );
        writeFileSync(join(row.path, 'dirty.txt'), 'unverified');
        await assert.rejects(executeTool('issue_pr_create', { issueNumber: 17 }, execution), /clean worktree/u);
        rmSync(join(row.path, 'dirty.txt'));
        git(row.path, 'commit', '--allow-empty', '-qm', 'unverified head');
        await assert.rejects(executeTool('issue_pr_create', { issueNumber: 17 }, execution));
        assert.equal(existsSync(pushMarker), false);
        git(row.path, 'reset', '--hard', run.classification.head.sha);
        personalRoute.baseSha = 'f'.repeat(40);
        await assert.rejects(call('issue_pr_create', { issueNumber: 17 }), /Remote base changed/u);
        assert.equal(existsSync(pushMarker), false);
        personalRoute.baseSha = run.classification.base.sha;
        personalRoute.failCreate = true;
        await assert.rejects(call('issue_pr_create', { issueNumber: 17 }), /response lost after branch push/u);
        assert.equal(existsSync(pushMarker), true);
        assert.equal(personalRoute.created, false);
      }
      const published = (await call('issue_pr_create', { issueNumber: 17 })) as {
        prNumber: number;
        reviewRoute: { author: { actorLogin: string; credentialSource: string }; reviewer: { actorLogin: string } };
      };
      assert.equal(published.prNumber, 23);
      assert.equal(existsSync(pushMarker), true);
      assert.equal(published.reviewRoute.author.actorLogin, 'host-user');
      assert.equal(published.reviewRoute.author.credentialSource, 'env:AUTHOR_TOKEN');
      assert.equal(published.reviewRoute.reviewer.actorLogin, 'synthetic-reviewer[bot]');
      const info = (await call('issue_pr_info', { issueNumber: 17, prNumber: 23 })) as { authorLogin: string };
      assert.equal(info.authorLogin, 'host-user');
      assert.equal(readFileSync(admissionPath, 'utf8'), admissionBefore);

      const artifactContent = { ...reviewContent, prNumber: 23 };
      const artifact = JSON.stringify({ ...artifactContent, artifactId: digestValue(artifactContent) });
      const reviewInput = { issueNumber: 17, prNumber: 23, identity: 'synthetic-reviewer', artifact };
      if (transition) {
        personalRoute.headSha = 'b'.repeat(40);
        await assert.rejects(call('issue_pr_review', reviewInput), /head/u);
        assert.equal(personalRoute.submitted, 0);
        personalRoute.headSha = run.classification.head.sha;
      }
      if (transition && entry === 'source') {
        process.env[driftEnv] = 'SKIP';
        assert.notEqual((await loadDeliveryConfig(row.path)).configDigest, candidateConfiguration.configDigest);
        assert.equal((await loadDeliveryConfig(root)).configDigest, primaryConfiguration.configDigest);
        await assert.rejects(call('issue_pr_review', reviewInput), /classification is stale against config/u);
        assert.equal(personalRoute.submitted, 0);
        delete process.env[driftEnv];
      }
      const first = (await call('issue_pr_review', reviewInput)) as {
        receiptId: string;
        reviewState: { status: string; submittedReviewAuthorCanPushToRepository: boolean | null };
      };
      assert.equal(first.reviewState.status, 'still-required');
      assert.equal(first.reviewState.submittedReviewAuthorCanPushToRepository, false);
      assert.equal(personalRoute.submitted, 1);
      if (transition && entry === 'primary') {
        process.env[driftEnv] = 'SKIP';
        assert.notEqual((await loadDeliveryConfig(row.path)).configDigest, candidateConfiguration.configDigest);
        assert.equal((await loadDeliveryConfig(root)).configDigest, primaryConfiguration.configDigest);
        await assert.rejects(
          call('issue_pr_create', { issueNumber: 17, draft: false }),
          /classification is stale against config/u,
        );
        assert.equal(personalRoute.readyPromotions, 0);
        delete process.env[driftEnv];
        await call('issue_pr_create', { issueNumber: 17, draft: false });
        assert.equal(personalRoute.readyPromotions, 1);
      }
      const second = (await call('issue_pr_review', reviewInput)) as { receiptId: string };
      assert.equal(second.receiptId, first.receiptId);
      assert.equal(personalRoute.submitted, 1);
    } finally {
      await closeMcp?.();
      personalRoute.active = false;
      personalRoute.created = false;
      personalRoute.failCreate = false;
      personalRoute.reviews.length = 0;
      personalRoute.ready = false;
      personalRoute.readyPromotions = 0;
      if (previousDrift === undefined) delete process.env[driftEnv];
      else process.env[driftEnv] = previousDrift;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  },
  15_000,
);

test.each(['runtime', 'primary-policy', 'witness', 'sibling', 'foreign-repository', 'missing-source'])(
  'source-bound dispatch rejects invalid %s before running candidate stages',
  async (invalid) => {
    const { root, runtimeEntryPath, counter } = await fixture();
    let foreignRoot: string | undefined;
    try {
      const row = await prepareIssueWorktree({
        baseRef: 'main',
        identity: 'synthetic-author',
        issueNumber: 17,
        repoRoot: root,
      });
      let requestedRoot = root;
      const expected = {
        runtime: /source, capability or repository admission/u,
        'primary-policy': /source, capability or repository admission/u,
        witness: /ownership witness/u,
        sibling: /primary or exact registered issue checkout/u,
        'foreign-repository': /primary Git repository/u,
        'missing-source': /git rev-parse failed/u,
      }[invalid]!;
      if (invalid === 'runtime') writeFileSync(join(dirname(runtimeEntryPath), 'changed.js'), 'unadmitted');
      if (invalid === 'primary-policy')
        writeFileSync(
          join(root, 'policy.mjs'),
          `${readFileSync(join(root, 'policy.mjs'), 'utf8')}\n// unadmitted controller policy\n`,
        );
      if (invalid === 'witness') rmSync(join(root, '.git', 'ai-delivery', 'worktree-owners'), { recursive: true });
      if (invalid === 'sibling')
        requestedRoot = (
          await prepareStandaloneWorktree({
            name: 'sibling',
            branch: 'scratch/sibling',
            identity: 'synthetic-author',
            repoRoot: root,
          })
        ).path;
      if (invalid === 'foreign-repository') {
        foreignRoot = (await fixture()).root;
        const foreign = await prepareIssueWorktree({
          baseRef: 'main',
          identity: 'synthetic-author',
          issueNumber: 17,
          repoRoot: foreignRoot,
        });
        await removeWorktreeEntry(row.path, root);
        await addWorktreeEntry(foreign, root);
      }
      if (invalid === 'missing-source') git(root, 'worktree', 'remove', row.path);
      await assert.rejects(
        executeTool('issue_verify', { issueNumber: 17 }, { repoRoot: requestedRoot, runtimeEntryPath }),
        expected,
      );
      assert.equal(existsSync(counter), false);
    } finally {
      if (foreignRoot !== undefined) rmSync(foreignRoot, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('source-bound publication preserves rejection of a legacy personal override for an App author', async () => {
  const { root, runtimeEntryPath } = await fixture();
  let restore: (() => void) | undefined;
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    const run = await verifyIssue({ issueNumber: 17, repoRoot: row.path });
    const factory = githubClient.createDeliveryGitHubClients;
    const selected = vi.spyOn(githubClient, 'createDeliveryGitHubClients').mockImplementation(async (input) => {
      const clients = await factory(input);
      if (input.role !== 'author') return clients;
      Object.assign(clients.rest.issues, { get: async () => ({ data: { title: 'Synthetic issue' } }) });
      Object.assign(clients.rest.git, {
        getRef: async () => ({ data: { object: { sha: run.classification.base.sha } } }),
      });
      return { ...clients, authSource: 'personal', credentialSource: 'legacy:personal' };
    });
    restore = () => selected.mockRestore();
    await assert.rejects(
      executeTool(
        'issue_pr_create',
        { issueNumber: 17 },
        {
          repoRoot: root,
          runtimeEntryPath,
          identity: 'personal',
          personalAuth: true,
        },
      ),
      /requires the configured author credential/u,
    );
    assert.equal(
      git(join(root, '.git', 'remote.git'), 'for-each-ref', '--format=%(refname)', 'refs/heads/issue/17'),
      '',
    );
  } finally {
    restore?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test('scratch start derives safe names and reports the requested worktree', async () => {
  const { root, runtimeEntryPath } = await fixture();
  try {
    const first = (await executeTool(
      'issue_start',
      { scratch: true, request: 'Investigate button layout' },
      { repoRoot: root, runtimeEntryPath, identity: 'synthetic-author' },
    )) as { mode: string; title: string; branch: string; worktreePath: string };
    assert.equal(first.mode, 'scratch');
    assert.equal(first.title, 'Investigate button layout');
    assert.equal(first.branch, 'scratch/investigate-button-layout');
    assert.ok(first.worktreePath.endsWith('/.worktrees/scratch-investigate-button-layout'));
    const overridden = (await executeTool(
      'issue_start',
      { scratch: true, request: 'Work on parser', branch: 'scratch/custom/parser' },
      { repoRoot: root, runtimeEntryPath, identity: 'synthetic-author' },
    )) as { mode: string; branch: string; worktreePath: string };
    assert.equal(overridden.branch, 'scratch/custom/parser');
    assert.equal(overridden.worktreePath, join(dirname(first.worktreePath), 'scratch-scratch-custom-parser'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(['direct-develop', 'direct-start', 'develop', 'existing-start', 'new-start', 'scratch', 'standalone'])(
  'development access preflight rejects absent reviewer credentials before %s preparation',
  async (entry) => {
    const { root, runtimeEntryPath } = await fixture();
    const admissionPath = join(root, '.git', 'ai-delivery', 'runtime-admission.json');
    const admissionBefore = readFileSync(admissionPath, 'utf8');
    const syntheticClients = githubClient.createDeliveryGitHubClients;
    const actual = await vi.importActual<typeof githubClient>('./github/client.js');
    const mocked = vi
      .spyOn(githubClient, 'createDeliveryGitHubClients')
      .mockImplementation((input) =>
        input.role === 'reviewer' ? actual.createDeliveryGitHubClients({ ...input, env: {} }) : syntheticClients(input),
      );
    const execution = { repoRoot: root, runtimeEntryPath, identity: 'synthetic-author' };
    const tracking = {
      title: 'Synthetic change',
      body: '## Outcome\nDeliver a verified change.\n\n## Scope\n- `artifact.txt`\n\n## Acceptance Criteria\n- [ ] Change is verified\n- [ ] Review is recorded\n\n## Verification\nRun `node --version`.',
      points: 2,
      develop: true,
    };
    try {
      const run = async () => {
        if (entry === 'direct-develop' || entry === 'direct-start') {
          const context = await contextFor(execution, 'develop');
          return entry === 'direct-develop' ? developIssue(context, 17) : startTrackedIssue(context, tracking);
        }
        if (entry === 'develop') return executeTool('issue_develop', { issueNumber: 17 }, execution);
        if (entry === 'existing-start') return executeTool('issue_start', { issueNumber: 17 }, execution);
        if (entry === 'new-start') return executeTool('issue_start', tracking, execution);
        if (entry === 'scratch')
          return executeTool('issue_start', { scratch: true, request: 'Inspect parser' }, execution);
        return executeTool('issue_worktree_create', { name: 'scratch-access', branch: 'scratch/access' }, execution);
      };
      await assert.rejects(run(), /Missing GitHub App credentials for reviewer role/u);
      assert.equal(existsSync(join(root, '.worktrees')), false);
      assert.equal(existsSync(join(root, '.issue-cli', 'worktrees.json')), false);
      assert.equal(readFileSync(admissionPath, 'utf8'), admissionBefore);
    } finally {
      mocked.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.each(['author-source', 'author-readback', 'same-actor', 'reviewer-repository'])(
  'development access preflight rejects a mismatched %s route before issue reads or writes',
  async (failure) => {
    const { root, runtimeEntryPath } = await fixture({ personalAuthor: true });
    const syntheticClients = githubClient.createDeliveryGitHubClients;
    const mocked = vi.spyOn(githubClient, 'createDeliveryGitHubClients').mockImplementation(async (input) => {
      const clients = await syntheticClients(input);
      if (input.role === 'author' && failure === 'author-source') return { ...clients, authSource: 'app' };
      if (input.role === 'author' && failure === 'author-readback')
        return { ...clients, authenticatedAuthor: async () => ({ actorLogin: '', credentialIdentity: '' }) };
      if (input.role === 'reviewer' && failure === 'same-actor')
        return { ...clients, appActorLogin: async () => 'host-user' };
      if (input.role === 'reviewer' && failure === 'reviewer-repository')
        Object.assign(clients.rest.repos, { get: async () => ({ data: { full_name: 'example/other' } }) });
      return clients;
    });
    try {
      const context = await contextFor({ repoRoot: root, runtimeEntryPath, identity: 'host-author' }, 'develop');
      await assert.rejects(
        developIssue(context, 17),
        {
          'author-source': /requires the configured author credential/u,
          'author-readback': /Author GitHub identity readback is incomplete/u,
          'same-actor': /same GitHub actor/u,
          'reviewer-repository': /repository readback disagrees/u,
        }[failure]!,
      );
      assert.equal(existsSync(join(root, '.worktrees')), false);
      assert.equal(existsSync(join(root, '.git', 'ai-delivery', 'issue-info')), false);
    } finally {
      mocked.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('development access preflight permits the configured host author and independent App with unreadable rules', async () => {
  const { root, runtimeEntryPath } = await fixture({ personalAuthor: true });
  const admissionPath = join(root, '.git', 'ai-delivery', 'runtime-admission.json');
  const admissionBefore = readFileSync(admissionPath, 'utf8');
  try {
    const row = (await executeTool(
      'issue_worktree_create',
      { name: 'scratch-host', branch: 'scratch/host' },
      { repoRoot: root, runtimeEntryPath, identity: 'host-author' },
    )) as { path: string; identity: string };
    assert.equal(row.identity, 'host-author');
    assert.equal(row.path, join(root, '.worktrees', 'scratch-host'));
    assert.equal(existsSync(row.path), true);
    assert.equal(readFileSync(admissionPath, 'utf8'), admissionBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  'direct-develop',
  'direct-start',
  'develop',
  'existing-start',
  'new-start',
  'scratch',
  'standalone',
  'config-resolve',
])('development access preflight preserves the explicit personal override for %s', async (entry) => {
  const { root, runtimeEntryPath } = await fixture();
  const admissionPath = join(root, '.git', 'ai-delivery', 'runtime-admission.json');
  const admissionBefore = readFileSync(admissionPath, 'utf8');
  const factory = githubClient.createDeliveryGitHubClients;
  const actual = await vi.importActual<typeof githubClient>('./github/client.js');
  const downstream = new Error('Reached the downstream issue API with the selected author');
  const selected = vi.spyOn(githubClient, 'createDeliveryGitHubClients').mockImplementation(async (input) => {
    const clients = await factory(input);
    if (input.role !== 'author' || input.personalAuth === undefined) return clients;
    const personal = await actual.createDeliveryGitHubClients({
      ...input,
      env: { GH_TOKEN: 'synthetic-development-token' },
    });
    Object.assign(clients.rest.issues, {
      get: async () => {
        throw downstream;
      },
      create: async () => {
        throw downstream;
      },
    });
    Object.assign(clients.rest, { request: async () => Promise.reject(new Error('Rules unavailable')) });
    return {
      ...personal,
      graphql: clients.graphql,
      rest: clients.rest,
      authenticatedAuthor: async () => ({ actorLogin: 'host-user', credentialIdentity: 'user:37' }),
    };
  });
  const execution = { repoRoot: root, runtimeEntryPath, identity: 'personal', personalAuth: true };
  const tracking = {
    title: 'Synthetic change',
    body: '## Outcome\nDeliver a verified change.\n\n## Scope\n- `artifact.txt`\n\n## Acceptance Criteria\n- [ ] Change is verified\n- [ ] Review is recorded\n\n## Verification\nRun `node --version`.',
    points: 2,
    develop: true,
  };
  try {
    if (entry === 'config-resolve') {
      // The prescribed CLI read must inspect this development selection without admission.
      rmSync(admissionPath);
      const originalArgv = process.argv;
      const originalExitCode = process.exitCode;
      let stdout = '';
      let stderr = '';
      let completed: () => void = () => {};
      const output = new Promise<void>((resolve) => {
        completed = resolve;
      });
      const out = vi.spyOn(process.stdout, 'write').mockImplementation((value) => {
        stdout += String(value);
        completed();
        return true;
      });
      const err = vi.spyOn(process.stderr, 'write').mockImplementation((value) => {
        stderr += String(value);
        completed();
        return true;
      });
      try {
        process.argv = [
          process.execPath,
          'ai-delivery',
          '--repo-root',
          root,
          '--identity',
          'personal',
          '--personal-auth',
          'config:resolve',
        ];
        await import('./cli.js');
        await output;
        assert.equal(stderr, '');
        const resolved = JSON.parse(stdout) as {
          reviewRoute: {
            author: { identity: string; authSource: string; actorLogin: string };
            approvalEligibility: string;
            rules: { visibility: string };
          };
        };
        assert.equal(resolved.reviewRoute.author.identity, 'personal');
        assert.equal(resolved.reviewRoute.author.authSource, 'personal');
        assert.equal(resolved.reviewRoute.author.actorLogin, 'host-user');
        assert.equal(resolved.reviewRoute.approvalEligibility, 'unknown');
        assert.equal(resolved.reviewRoute.rules.visibility, 'unknown');
        assert.equal(existsSync(admissionPath), false);
        assert.equal(existsSync(join(root, '.worktrees')), false);
      } finally {
        out.mockRestore();
        err.mockRestore();
        process.argv = originalArgv;
        process.exitCode = originalExitCode;
      }
    } else if (entry === 'scratch' || entry === 'standalone') {
      const row = (
        entry === 'scratch'
          ? await executeTool('issue_start', { scratch: true, request: 'Inspect parser' }, execution)
          : await executeTool(
              'issue_worktree_create',
              { name: 'scratch-override', branch: 'scratch/override' },
              execution,
            )
      ) as { path: string; worktreePath: string; identity: string };
      if (entry === 'standalone') assert.equal(row.identity, 'personal');
      assert.equal(existsSync(entry === 'scratch' ? row.worktreePath : row.path), true);
    } else {
      const run = async () => {
        if (entry === 'direct-develop' || entry === 'direct-start') {
          const context = await contextFor(execution, 'develop');
          return entry === 'direct-develop' ? developIssue(context, 17) : startTrackedIssue(context, tracking);
        }
        if (entry === 'develop') return executeTool('issue_develop', { issueNumber: 17 }, execution);
        if (entry === 'existing-start') return executeTool('issue_start', { issueNumber: 17 }, execution);
        return executeTool('issue_start', tracking, execution);
      };
      await assert.rejects(run(), (error) => error === downstream);
      assert.equal(existsSync(join(root, '.worktrees')), false);
    }
    if (entry !== 'config-resolve') assert.equal(readFileSync(admissionPath, 'utf8'), admissionBefore);
  } finally {
    selected.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP exposes one implementation surface for native lifecycle commands', () => {
  assert.deepEqual(
    AI_DELIVERY_MCP_TOOLS.map((tool) => tool.name),
    [
      'runtime_stage',
      'runtime_admit',
      'issue_create',
      'issue_start',
      'issue_update',
      'issue_info',
      'issue_ready_check',
      'issue_develop',
      'issue_verify',
      'issue_pr_create',
      'issue_pr_info',
      'issue_pr_review',
      'issue_pr_merge',
      'issue_finish',
      'issue_worktree_create',
      'issue_worktree_transition_inspect',
      'issue_worktree_transition_apply',
    ],
  );
  const validInputs = {
    issue_create: { title: 'Synthetic tracking parent' },
    issue_update: { issueNumber: 17, park: true },
    issue_ready_check: { issueNumber: 17 },
    issue_develop: { issueNumber: 17 },
    issue_verify: { issueNumber: 17 },
    issue_pr_create: { issueNumber: 17, draft: true },
    issue_pr_review: { issueNumber: 17, prNumber: 23, artifact: '{}' },
    issue_pr_merge: { issueNumber: 17, prNumber: 23, strategy: 'merge' },
    issue_finish: { issueNumber: 17, prNumber: 23, strategy: 'merge' },
    issue_worktree_transition_inspect: { issueNumber: 17, purpose: 'active-resume' },
    issue_worktree_transition_apply: {
      authority: 'worktree:transition',
      planPath: '/synthetic/plan.json',
      expectedPlanId: `sha256:${'a'.repeat(64)}`,
      relinquishmentCommentId: 101,
      acceptanceCommentId: 102,
    },
  };
  const updateTool = AI_DELIVERY_MCP_TOOLS.find((tool) => tool.name === 'issue_update')!;
  assert.equal(updateTool.inputSchema.safeParse({ issueNumber: 17, park: false }).success, false);
  for (const [name, input] of Object.entries(validInputs)) {
    const tool = AI_DELIVERY_MCP_TOOLS.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} has an MCP definition`);
    assert.equal(tool.inputSchema.safeParse(input).success, true, `${name} accepts its lifecycle input`);
    assert.equal(
      tool.inputSchema.safeParse({ ...input, unexpected: true }).success,
      false,
      `${name} rejects unrelated fields`,
    );
  }
});

test('MCP request rejects unsupported legacy options before lifecycle dispatch', async () => {
  const server = createAiDeliveryMcpServer({ repoRoot: '/missing-synthetic-repository' });
  const client = new Client({ name: 'synthetic-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: 'issue_create',
      arguments: {
        body: 'tracked work',
        issueType: 'Task',
        points: 1,
        priority: 'High',
        title: 'Synthetic change',
        unsupportedLegacyOption: true,
      },
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /unsupportedLegacyOption/u);
  } finally {
    await client.close();
    await server.close();
  }
});

async function syntheticLifecycle(routing: {
  remote: string;
  divergentOrigin: boolean;
  producerOnboarding?: boolean;
  mergedContinuation?: boolean;
  legacyNativeMetadata?: boolean;
}): Promise<void> {
  const created = await fixture({ ...routing, omitRuntimeAdmission: routing.producerOnboarding === true });
  const root = created.root;
  let runtimeEntryPath = created.runtimeEntryPath;
  const originalPath = process.env.PATH;
  let restoreTransport: (() => void) | undefined;
  const remoteName = routing.remote;
  assert.equal(defaultBaseRef(root, remoteName), `refs/remotes/${remoteName}/main`);
  const remote = join(root, '.git', 'remote.git');
  const configuration = await loadDeliveryConfig(root);
  const config = configuration.config;
  const baseSha = git(root, 'rev-parse', 'main');
  const issueNumber = 17;
  const prNumber = 23;
  const issue = {
    id: 170,
    number: issueNumber,
    node_id: 'ISSUE-17',
    title: 'Synthetic change',
    body: `## Outcome\nDeliver a verified synthetic change to the local repository.\n\n## Scope\n- \`artifact.txt\`\n\n## Acceptance Criteria\n- [ ] Change is verified\n- [ ] Review and merge are recorded\n\n## Verification\nRun \`node --version\`.`,
    state: 'open',
    html_url: 'https://example.test/issues/17',
    type: { name: 'Task' },
  };
  let issuePoints: number | undefined;
  let parentPoints: number | undefined = 1;
  let parentIssueNumber: number | null = null;
  let parentChildren: number[] = [];
  let issuePriority: string | undefined;
  let projectStatus: string | null = null;
  let blockerOpen = false;
  let trackingParent = false;
  let failFirstBlockerLink = true;
  let failNextProjectSync = false;
  let interruptNextStatusUpdate = false;
  let conflictNextStatusReadback = false;
  let projectStatusWrites = 0;
  let checksPassed = true;
  let prDraft = true;
  let prState = 'open';
  let mergedAt = '';
  let headSha = '';
  let mergeSha = '';
  let stalePrReadbacks = 0;
  let review: Record<string, unknown> | null = null;
  let reviewDecision: 'APPROVED' | 'REVIEW_REQUIRED' = 'REVIEW_REQUIRED';
  const calls: string[] = [];
  const createPayloads: Record<string, unknown>[] = [];
  const statuses = { Queued: 'STATUS-0', Active: 'STATUS-1', Waiting: 'STATUS-2', Shipped: 'STATUS-3' };
  const statusName = (option: string) => Object.entries(statuses).find(([, id]) => id === option)?.[0];
  const pageInfo = { endCursor: null, hasNextPage: false };
  const issueFieldValues = (number = issueNumber) => [
    ...((number === 11 ? parentPoints : issuePoints) === undefined
      ? []
      : [
          {
            data_type: 'single_select',
            issue_field_id: 101,
            issue_field_name: 'Estimate',
            value: String(number === 11 ? parentPoints : issuePoints),
          },
        ]),
    ...(issuePriority === undefined
      ? []
      : [{ data_type: 'single_select', issue_field_id: 102, issue_field_name: 'Urgency', value: issuePriority }]),
  ];
  const pr = (stale = false) => ({
    number: prNumber,
    node_id: 'PR-23',
    title: 'Synthetic change',
    html_url: 'https://example.test/pulls/23',
    state: stale ? 'open' : prState,
    draft: prDraft,
    merged_at: !stale && prState === 'closed' ? mergedAt : null,
    merge_commit_sha: mergeSha || null,
    mergeable: true,
    mergeable_state: 'clean',
    user: { login: 'synthetic-author[bot]' },
    head: { sha: headSha, ref: 'issue/17' },
    base: { sha: baseSha, ref: 'main' },
  });
  const graphql = async (query: string, variables: Record<string, unknown> = {}): Promise<unknown> => {
    if (query.includes('DeliveryReviewDecision'))
      return { repository: { pullRequest: { headRefOid: headSha, reviewDecision } } };
    if (query.includes('ProjectDeliveryConfiguration'))
      return {
        organization: {
          projectV2: {
            id: 'PROJECT-1',
            number: 1,
            title: 'Delivery',
            viewerCanUpdate: true,
            fields: {
              nodes: [
                {
                  __typename: 'ProjectV2SingleSelectField',
                  id: 'FIELD-FLOW',
                  name: 'Flow',
                  isIssueField: false,
                  options: Object.entries(statuses).map(([name, id]) => ({ id, name })),
                },
                {
                  __typename: 'ProjectV2SingleSelectField',
                  id: 'FIELD-POINTS',
                  name: 'Estimate',
                  isIssueField: true,
                  options: [],
                  issueField: {
                    __typename: 'IssueFieldSingleSelect',
                    id: 'ISSUE-FIELD-101',
                    fullDatabaseId: '101',
                    name: 'Estimate',
                    options: ['1', '2', '4'].map((name) => ({ id: name, name })),
                  },
                },
                {
                  __typename: 'ProjectV2SingleSelectField',
                  id: 'FIELD-PRIORITY',
                  name: 'Urgency',
                  isIssueField: true,
                  options: [],
                  issueField: {
                    __typename: 'IssueFieldSingleSelect',
                    id: 'ISSUE-FIELD-102',
                    fullDatabaseId: '102',
                    name: 'Urgency',
                    options: ['High', 'Low'].map((name) => ({ id: name, name })),
                  },
                },
              ],
              pageInfo,
            },
          },
        },
      };
    if (query.includes('ProjectDeliveryItems'))
      return {
        organization: {
          projectV2: {
            items: {
              nodes:
                projectStatus === null
                  ? []
                  : [
                      {
                        id: 'UNRELATED-ITEM',
                        isArchived: false,
                        content: { id: 'UNRELATED-ISSUE' },
                        fieldValueByName: { name: 'Active', optionId: 'STATUS-1' },
                      },
                      {
                        id: 'ITEM-17',
                        isArchived: false,
                        content: { id: issue.node_id },
                        fieldValueByName: {
                          name: projectStatus,
                          optionId: statuses[projectStatus as keyof typeof statuses],
                        },
                      },
                    ],
              pageInfo,
            },
          },
        },
      };
    if (query.includes('AddProjectDeliveryItem')) {
      if (failNextProjectSync) {
        failNextProjectSync = false;
        throw new Error('synthetic Project interruption');
      }
      return { addProjectV2ItemById: { item: { id: 'ITEM-17' } } };
    }
    if (query.includes('UpdateProjectDeliveryStatus')) {
      assert.equal(variables.projectId, 'PROJECT-1');
      assert.equal(variables.itemId, 'ITEM-17');
      projectStatusWrites += 1;
      projectStatus = statusName(String(variables.optionId)) ?? null;
      if (interruptNextStatusUpdate) {
        interruptNextStatusUpdate = false;
        throw new Error('synthetic ambiguous status write');
      }
      return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'ITEM-17' } } };
    }
    if (query.includes('ProjectDeliveryItemReadback')) {
      const contentId = conflictNextStatusReadback ? 'UNRELATED-ISSUE' : issue.node_id;
      conflictNextStatusReadback = false;
      return {
        node: {
          id: 'ITEM-17',
          isArchived: false,
          project: { id: 'PROJECT-1', number: 1 },
          content: { id: contentId },
          fieldValueByName: { name: projectStatus, optionId: statuses[projectStatus as keyof typeof statuses] },
        },
      };
    }
    if (query.includes('blockedBy(first:'))
      return {
        repository: {
          issue: {
            parent: parentIssueNumber === null ? null : { id: 'PARENT-11', number: parentIssueNumber },
            blockedBy: {
              nodes: blockerOpen ? [{ id: 'BLOCKER-9', number: 9, state: 'OPEN', title: 'Blocker' }] : [],
              pageInfo,
            },
          },
        },
      };
    if (query.includes('addBlockedBy')) {
      if (failFirstBlockerLink) {
        failFirstBlockerLink = false;
        throw new Error('synthetic interruption');
      }
      blockerOpen = true;
      return { addBlockedBy: { issue: { number: issueNumber } } };
    }
    if (query.includes('removeBlockedBy')) {
      blockerOpen = false;
      return { removeBlockedBy: { issue: { number: issueNumber } } };
    }
    if (query.includes('RepositoryId')) return { repository: { id: 'REPO-1' } };
    if (query.includes('UpdateExactRefs')) {
      const input = variables.input as { clientMutationId: string; refUpdates: { afterOid: string }[] };
      assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), baseSha);
      git(remote, 'update-ref', 'refs/heads/main', input.refUpdates[0]!.afterOid, baseSha);
      prState = 'closed';
      mergedAt = new Date().toISOString();
      stalePrReadbacks = 2;
      return { updateRefs: { clientMutationId: input.clientMutationId } };
    }
    if (query.includes('markPullRequestReadyForReview')) {
      prDraft = false;
      return { markPullRequestReadyForReview: { pullRequest: { id: 'PR-23', isDraft: false } } };
    }
    throw new Error(`Unexpected GraphQL call: ${query.slice(0, 100)}`);
  };
  const rest = {
    request: async (route: string, parameters: Record<string, unknown>) => {
      if (route === 'GET /repos/{owner}/{repo}/rules/branches/{branch}')
        return { data: [{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }] };
      if (route === 'GET /repos/{owner}/{repo}/branches/{branch}/protection')
        throw Object.assign(new Error('Synthetic protected branch visibility unavailable'), { status: 403 });
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
        for (const value of parameters.issue_field_values as { field_id: number; value: string }[]) {
          if (value.field_id === 101) issuePoints = Number(value.value);
          if (value.field_id === 102) issuePriority = value.value;
        }
        return { data: issueFieldValues() };
      }
      if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values') {
        return { data: issueFieldValues(Number(parameters.issue_number)) };
      }
      if (route === 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values/{issue_field_id}') {
        assert.equal(parameters.issue_number, 11);
        assert.equal(parameters.issue_field_id, 101);
        parentPoints = undefined;
        return { data: null };
      }
      throw new Error(`Unexpected REST route: ${route}`);
    },
    issues: {
      create: async (input: Record<string, unknown>) => {
        calls.push('issue:create');
        createPayloads.push(input);
        return { data: issue };
      },
      get: async (input: { issue_number: number }) => ({
        data:
          input.issue_number === 9
            ? { number: 9, node_id: 'BLOCKER-9', state: 'open', title: 'Blocker' }
            : input.issue_number === 11
              ? { id: 110, number: 11, node_id: 'PARENT-11', state: 'open', title: 'Parent' }
              : issue,
      }),
      listSubIssues: async (input: { issue_number: number }) => ({
        data:
          input.issue_number === 11
            ? parentChildren.map((number) => ({ number }))
            : trackingParent
              ? [{ number: 18 }]
              : [],
      }),
      addSubIssue: async (input: { issue_number: number; sub_issue_id: number }) => {
        assert.equal(input.issue_number, 11);
        assert.equal(input.sub_issue_id, 170);
        parentChildren = [issueNumber];
        parentIssueNumber = 11;
        return { data: {} };
      },
      update: async (input: { state?: 'open' | 'closed' }) => {
        if (input.state !== undefined) issue.state = input.state;
        return { data: issue };
      },
    },
    paginate: async (_method: unknown, input: { issue_number?: number; state?: string }) =>
      input.state !== undefined
        ? [pr()]
        : input.issue_number === 11
          ? parentChildren.map((number) => ({ number }))
          : trackingParent
            ? [{ number: 18 }]
            : [],
    pulls: {
      get: async () => {
        const stale = stalePrReadbacks > 0;
        if (stale) stalePrReadbacks -= 1;
        return { data: pr(stale) };
      },
      list: async () => ({ data: [pr()] }),
      listReviews: async () => ({ data: review ? [review] : [] }),
      createReview: async (input: { body: string; commit_id: string; event: string }) => {
        calls.push('review:create');
        assert.equal(input.event, 'APPROVE');
        review = {
          id: 31,
          body: input.body,
          state: 'APPROVED',
          commit_id: input.commit_id,
          user: { login: 'synthetic-reviewer' },
          html_url: 'https://example.test/pulls/23#review-31',
        };
        return { data: review };
      },
    },
    git: {
      getRef: async (input: { ref: string }) => ({
        data: { object: { sha: git(remote, 'rev-parse', `refs/${input.ref}`) } },
      }),
      createCommit: async (input: { parents: string[]; tree: string; message: string }) => {
        calls.push('git:createCommit');
        mergeSha = git(
          root,
          'commit-tree',
          input.tree,
          '-p',
          input.parents[0]!,
          '-p',
          input.parents[1]!,
          '-m',
          input.message,
        );
        git(root, 'push', '-q', remoteName, `${mergeSha}:refs/heads/merge-object`);
        return { data: { sha: mergeSha } };
      },
      getCommit: async () => ({
        data: {
          sha: mergeSha,
          tree: { sha: git(root, 'rev-parse', `${mergeSha}^{tree}`) },
          parents: [{ sha: baseSha }, { sha: headSha }],
        },
      }),
    },
    checks: {
      listForRef: async () => ({
        data: {
          total_count: 1,
          check_runs: [
            { status: checksPassed ? 'completed' : 'in_progress', conclusion: checksPassed ? 'success' : null },
          ],
        },
      }),
    },
    repos: {
      get: async () => ({ data: { full_name: 'example/widget' } }),
      getCombinedStatusForRef: async () => ({ data: { statuses: [], state: 'success' } }),
    },
  };
  let authenticatedAuthor = 'synthetic-author[bot]';
  const context = {
    root,
    repo: { owner: 'example', repo: 'widget' },
    config,
    configuration,
    clients: {
      authSource: 'app',
      role: 'author',
      graphql,
      rest,
      authenticatedAuthor: async () => ({
        actorLogin: authenticatedAuthor,
        credentialIdentity: 'app:201:installation:301',
      }),
    },
  } as unknown as DeliveryContext;
  let restoreDispatchClient: (() => void) | undefined;
  const enableDispatch = () => {
    const dispatchClient = vi.spyOn(githubClient, 'createDeliveryGitHubClients').mockImplementation(async (input) => ({
      ...context.clients,
      ...(input.role === 'reviewer'
        ? {
            role: 'reviewer' as const,
            appActorLogin: async () => 'synthetic-reviewer[bot]',
          }
        : {}),
      graphql: (async (query: string, variables: Record<string, unknown>) =>
        query.includes('DeliveryDiscovery') ||
        query.includes('DeliveryRepository') ||
        query.includes('ProjectDeliveryConfiguration')
          ? syntheticDiscoveryClients().graphql(query, variables)
          : graphql(query, variables)) as typeof context.clients.graphql,
    }));
    restoreDispatchClient = () => dispatchClient.mockRestore();
    return dispatchClient;
  };
  const execution = { repoRoot: root, runtimeEntryPath, identity: 'synthetic-author' };
  try {
    if (routing.legacyNativeMetadata) {
      enableDispatch();
      const legacyPath = join(root, '.worktrees', 'issue-17');
      git(root, 'worktree', 'add', '-b', 'issue/17', legacyPath, 'main');
      writeFileSync(join(legacyPath, 'artifact.txt'), 'unadopted legacy source\n');
      const receiptRoot = join(root, '.git', 'legacy-receipts');
      mkdirSync(receiptRoot);
      writeFileSync(join(receiptRoot, 'run.json'), '{"producer":"synthetic-legacy"}\n');
      const registryPath = join(root, '.issue-cli', 'worktrees.json');
      mkdirSync(dirname(registryPath), { recursive: true });
      const legacy = {
        branch: 'issue/17',
        createdAt: '2026-01-01T00:00:00.000Z',
        identity: 'synthetic-legacy',
        issueNumber,
        path: legacyPath,
        status: 'active',
        type: 'issue',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      const registryBytes = JSON.stringify({ worktrees: [legacy] });
      writeFileSync(registryPath, registryBytes);
      const source = directoryHash(legacyPath);
      const receipts = directoryHash(receiptRoot);
      await assert.rejects(
        executeTool(
          'issue_update',
          { issueNumber, points: 2 },
          {
            ...execution,
            identity: 'synthetic-reviewer',
          },
        ),
        /identity|author|permitted|allowed/u,
      );
      const updated = (await executeTool(
        'issue_update',
        {
          issueNumber,
          parentIssueNumber: 11,
          points: 2,
          priority: 'High',
        },
        execution,
      )) as { points: number; priority: string; parentIssueNumber: number };
      assert.equal(updated.points, 2);
      assert.equal(updated.priority, 'High');
      assert.equal(parentIssueNumber, 11);
      assert.equal(parentPoints, undefined);
      await assert.rejects(executeTool('issue_develop', { issueNumber }, execution), /ownership witness/u);
      assert.equal(readFileSync(registryPath, 'utf8'), registryBytes);
      assert.equal(directoryHash(legacyPath), source);
      assert.equal(directoryHash(receiptRoot), receipts);
      assert.equal(existsSync(join(gitCommonDir(root), 'ai-delivery/worktree-owners')), false);
      return;
    }
    if (routing.producerOnboarding) {
      assert.equal(existsSync(join(root, 'AGENTS.md')), false);
      const archiveBase = join(root, '.git', 'producer-fixture');
      const packageSource = join(archiveBase, 'package');
      mkdirSync(archiveBase);
      cpSync(dirname(dirname(created.runtimeEntryPath)), packageSource, { recursive: true });
      cpSync(join(root, '.git/synthetic-runtime/plugin'), join(packageSource, 'plugins/ai-delivery'), {
        recursive: true,
      });
      const archive = join(archiveBase, 'reviewed.tgz');
      execFileSync('tar', ['-czf', archive, '-C', archiveBase, 'package']);
      const shimDir = join(archiveBase, 'bin');
      mkdirSync(shimDir);
      const npmShim = join(shimDir, 'npm');
      // Only installer and GitHub transports are synthetic; the public producer and validator are real.
      writeFileSync(
        npmShim,
        `#!${process.execPath}\nconst fs=require('fs'),path=require('path');const args=process.argv.slice(2);if(args[0]!=='install'||!['--omit=dev','--ignore-scripts','--no-audit','--no-fund'].every(x=>args.includes(x)))process.exit(91);const target=path.join(args[args.indexOf('--prefix')+1],'node_modules/@aviaratech/ai-delivery');fs.mkdirSync(path.dirname(target),{recursive:true});fs.cpSync(${JSON.stringify(packageSource)},target,{recursive:true});\n`,
      );
      chmodSync(npmShim, 0o700);
      process.env.PATH = `${shimDir}:${originalPath ?? ''}`;
      const server = createAiDeliveryMcpServer({ repoRoot: root, identity: 'synthetic-author' });
      const client = new Client({ name: 'unrelated-public-onboarding', version: '1.0.0' });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st);
      await client.connect(ct);
      const setup = {
        expectedSourceCommit: baseSha,
        expectedConfigDigest: configuration.configDigest,
        runtimeDirectory: join(root, '.git', 'public-runtime-stage'),
      };
      try {
        const stageResponse = await client.callTool({
          name: 'runtime_stage',
          arguments: {
            ...setup,
            authority: 'runtime:stage',
            archivePath: archive,
            expectedArchiveSha256: sha256(archive),
            packageVersion: '0.1.0',
          },
        });
        assert.equal(stageResponse.isError, undefined);
        const stage = JSON.parse((stageResponse.content as Array<{ text: string }>)[0]!.text) as {
          stageId: string;
          admission: { cliPath: string };
        };
        const admitted = await client.callTool({
          name: 'runtime_admit',
          arguments: {
            ...setup,
            authority: 'runtime:admit',
            stageId: stage.stageId,
            expectedPriorAdmissionSha256: null,
          },
        });
        assert.equal(admitted.isError, undefined);
        runtimeEntryPath = stage.admission.cliPath;
      } finally {
        await client.close();
        await server.close();
      }
      await assertDeliveryRuntimeAdmitted({ repoRoot: root, runtimeEntryPath });
    }
    await assert.rejects(
      startTrackedIssue(context, { request: 'Unready task', develop: true }),
      /New issue is not ready/u,
    );
    assert.equal(calls.filter((call) => call === 'issue:create').length, 0);
    const unsized = await createIssue(context, { title: 'Synthetic child', parentIssueNumber: 11 });
    assert.equal(unsized.created.number, issueNumber);
    assert.equal(createPayloads[0]?.body, '');
    assert.equal('type' in createPayloads[0]!, false);
    assert.equal(parentPoints, undefined);
    assert.equal(issuePoints, undefined);
    assert.equal(parentIssueNumber, 11);
    assert.deepEqual(await listIssueSubissues(context, 11), [issueNumber]);
    parentPoints = 1;
    parentChildren = [];
    parentIssueNumber = null;
    await updateIssue(context, { issueNumber, parentIssueNumber: 11 });
    assert.equal(parentPoints, undefined);
    parentPoints = 1;
    parentChildren = [];
    parentIssueNumber = null;
    projectStatus = null;
    calls.length = 0;
    await assert.rejects(
      startTrackedIssue(context, { issueNumber, resumeCreated: true }),
      /requires issueNumber and develop=true/u,
    );
    await assert.rejects(
      createIssue(context, {
        body: issue.body,
        blockedBy: [9],
        issueType: 'Task',
        points: 1,
        priority: 'High',
        title: issue.title,
      }),
      /created but native tracking did not complete/u,
    );
    assert.equal(calls.filter((call) => call === 'issue:create').length, 1);
    const resumedInput = resumedIssueUpdate({
      issueNumber,
      body: issue.body,
      blockedBy: [9],
      issueType: 'Task',
      labels: ['area:delivery'],
      milestone: 1,
      points: 1,
      priority: 'High',
      title: issue.title,
    });
    assert.deepEqual(resumedInput.blockedBy, [9]);
    assert.deepEqual(resumedInput.labels, ['area:delivery']);
    assert.equal(resumedInput.milestone, 1);
    assert.equal(resumedIssueUpdate({ issueNumber, parentIssueNumber: 11 }).parentIssueNumber, 11);
    const resumed = await resumeCreatedIssue(context, resumedInput);
    assert.deepEqual(resumed.blockedBy, [9]);
    assert.equal(projectStatus, 'Waiting');
    assert.equal((await readyCheck(context, issueNumber)).ready, false);
    await assert.rejects(developIssue(context, issueNumber), /not ready/);
    blockerOpen = false;
    trackingParent = true;
    assert.equal((await readyCheck(context, issueNumber)).ready, false);
    await assert.rejects(developIssue(context, issueNumber), /tracking parent/u);
    trackingParent = false;
    issue.state = 'closed';
    await assert.rejects(developIssue(context, issueNumber), /closed/u);
    issue.state = 'open';
    assert.equal((await readyCheck(context, issueNumber)).ready, true);
    const started = await startTrackedIssue(context, { issueNumber });
    assert.equal(started.mode, 'existing-issue');
    assert.equal(started.issueNumber, issueNumber);
    assert.equal(started.title, issue.title);
    const row = started as unknown as { path: string; branch: string };
    assert.equal(projectStatus, 'Active');
    const parked = await updateIssue(context, { issueNumber, park: true });
    assert.equal(parked.projectStatus, 'Todo');
    assert.equal(existsSync(row.path), true);
    assert.equal((await updateIssue(context, { issueNumber, title: issue.title })).projectStatus, 'Todo');
    await developIssue(context, issueNumber);
    assert.equal(projectStatus, 'Active');
    const blockedUpdate = await updateIssue(context, { issueNumber, blockedBy: [9] });
    assert.deepEqual(blockedUpdate.blockedBy, [9]);
    assert.equal(blockedUpdate.projectStatus, 'Blocked');
    assert.equal(projectStatus, 'Waiting');
    const blockedWrites = projectStatusWrites;
    assert.equal((await updateIssue(context, { issueNumber, blockedBy: [9] })).projectStatus, 'Blocked');
    assert.equal(projectStatusWrites, blockedWrites);
    assert.equal((await updateIssue(context, { issueNumber, park: true })).projectStatus, 'Blocked');
    await assert.rejects(developIssue(context, issueNumber), /not ready/u);
    interruptNextStatusUpdate = true;
    await assert.rejects(updateIssue(context, { issueNumber, blockedBy: [] }), /ambiguous status write/u);
    assert.equal(blockerOpen, false);
    assert.equal(projectStatus, 'Queued');
    const interruptedWrites = projectStatusWrites;
    const unblockedUpdate = await updateIssue(context, { issueNumber, blockedBy: [] });
    assert.equal(projectStatusWrites, interruptedWrites);
    assert.deepEqual(unblockedUpdate.blockedBy, []);
    assert.equal(unblockedUpdate.projectStatus, 'Todo');
    conflictNextStatusReadback = true;
    await assert.rejects(updateIssue(context, { issueNumber, blockedBy: [9] }), /exact issue item/u);
    assert.equal(blockerOpen, true);
    assert.equal((await updateIssue(context, { issueNumber, blockedBy: [9] })).projectStatus, 'Blocked');
    assert.equal((await updateIssue(context, { issueNumber, state: 'closed' })).projectStatus, 'Done');
    assert.equal((await updateIssue(context, { issueNumber, park: true })).projectStatus, 'Done');
    assert.equal((await resumeCreatedIssue(context, { issueNumber })).projectStatus, 'Done');
    assert.equal((await updateIssue(context, { issueNumber, state: 'open', blockedBy: [] })).projectStatus, 'Done');
    assert.equal(existsSync(row.path), true);
    await developIssue(context, issueNumber);
    assert.equal(projectStatus, 'Active');
    writeFileSync(join(row.path, 'change.txt'), 'feature\n');
    git(row.path, 'add', 'change.txt');
    git(row.path, 'commit', '-qm', 'synthetic change');
    headSha = git(row.path, 'rev-parse', 'HEAD');
    const run = await verifyIssue({ issueNumber, repoRoot: row.path });
    await assert.rejects(publishPr(context, { issueNumber, body: 'Closes #17' }), /Delivery Impact/);
    if (routing.producerOnboarding) {
      const realGit = execFileSync('/usr/bin/which', ['git'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: originalPath },
      }).trim();
      const shimDir = join(root, '.git/producer-fixture/bin');
      git(root, 'config', '--unset', `url.${remote}.insteadOf`);
      const gitShim = join(shimDir, 'git');
      writeFileSync(
        gitShim,
        `#!/bin/sh
if [ "$1" = -c ] && [ "$2" = credential.helper= ]; then
  [ "$AI_DELIVERY_GIT_TOKEN" = synthetic-selected-author-token ] || exit 92
  shift 2
  operation="$1"; shift
  [ "$1" = https://github.com/example/widget.git ] || exit 93
  shift
  exec "${realGit}" -c credential.helper= "$operation" "${remote}" "$@"
fi
if [ "$1" = push ] && [ "$2" = -q ] && [ "$3" = "${remoteName}" ]; then
  shift 3
  exec "${realGit}" push -q "${remote}" "$@"
fi
exec "${realGit}" "$@"
`,
      );
      chmodSync(gitShim, 0o700);
      const transport = vi.spyOn(githubClient, 'withAuthorGitToken').mockImplementation(async (clients, callback) => {
        assert.equal(clients.role, 'author');
        return callback('synthetic-selected-author-token');
      });
      restoreTransport = () => transport.mockRestore();
      const published = await publishPr(context, { issueNumber });
      assert.equal(published.prNumber, prNumber);
      assert.equal(published.reviewRoute?.author.actorLogin, 'synthetic-author[bot]');
      assert.equal(published.reviewRoute?.approvalEligibility, 'unknown');
    } else {
      await assert.rejects(
        publishPr(context, { issueNumber }),
        /Git push requires the selected author credential token/,
      );
      // The public push requires a real author App installation token. Bind a synthetic
      // publication at that external boundary so the remaining public phases run offline.
      git(row.path, 'push', '-q', remoteName, `${headSha}:refs/heads/issue/17`);
      const publishEvidence = await createIssuePhaseEvidence({ issueNumber, phase: 'publish', repoRoot: row.path });
      const publicationContent = {
        baseSha,
        evidenceId: publishEvidence.evidenceId,
        headSha,
        issueNumber,
        prNumber,
        schemaVersion: 'ai-delivery.publication@1' as const,
      };
      const publicationPath = join(
        gitCommonDir(row.path),
        'ai-delivery',
        'publications',
        String(issueNumber),
        `${headSha}.json`,
      );
      mkdirSync(dirname(publicationPath), { recursive: true });
      writeFileSync(
        publicationPath,
        JSON.stringify({ ...publicationContent, publicationId: digestValue(publicationContent) }),
        { mode: 0o600 },
      );
      await updateIssueWorktreeDelivery({
        branch: row.branch,
        issueNumber,
        path: row.path,
        prNumber,
        projectRoot: root,
        status: 'pr-published',
      });
    }
    assert.equal((await listPrs(context)).pullRequests[0]?.number, prNumber);
    assert.equal((await prInfo(context, { prNumber })).authorLogin, 'synthetic-author[bot]');
    assert.equal((await prChecks(context, prNumber)).combinedStatus, 'success');
    assert.equal((await prChecks(context, prNumber)).reviewState.status, 'still-required');
    await assert.rejects(checkoutPr(context, prNumber), /open in-repository branch/u);
    assert.equal(git(remote, 'rev-parse', 'refs/heads/issue/17'), headSha);
    await assert.rejects(mergePr(context, { issueNumber, prNumber }), /submitted independent review/);
    const artifactContent = {
      authorIdentity: 'synthetic-author',
      checks: ['verified exact diff'],
      diffScopeHash: digestValue(run.classification.changedPaths),
      elapsedMs: 100,
      findings: [],
      head: run.classification.head,
      issueNumber,
      prNumber,
      readOnly: true as const,
      requestedEffort: 'xhigh',
      requestedModel: 'gpt-6-astra',
      effectiveEffort: 'xhigh',
      effectiveModel: 'gpt-6-astra',
      reviewerIdentity: 'synthetic-reviewer',
      schemaVersion: 'ai-delivery.review-artifact@1' as const,
      summary: 'Independent approval',
      verdict: 'approve' as const,
    };
    const artifact = JSON.stringify({ ...artifactContent, artifactId: digestValue(artifactContent) });
    const reviewer = {
      ...context,
      clients: { ...context.clients, role: 'reviewer', appActorLogin: async () => 'synthetic-reviewer' },
    } as DeliveryContext;
    const personalReviewer = {
      ...reviewer,
      clients: { ...reviewer.clients, authSource: 'personal' },
    } as DeliveryContext;
    await assert.rejects(
      submitFormalReview(personalReviewer, { artifact, issueNumber, prNumber }),
      /reviewer GitHub App role/,
    );
    const reviewResult = await submitFormalReview(reviewer, { artifact, issueNumber, prNumber });
    assert.equal(reviewResult.githubReviewId, 31);
    assert.equal(reviewResult.reviewState.status, 'still-required');
    await publishPr(context, { issueNumber, draft: false });
    assert.equal(prDraft, false);
    await assert.rejects(mergePr(context, { issueNumber, prNumber }), /submitted APPROVED review.*still requires/u);
    reviewDecision = 'APPROVED';
    checksPassed = false;
    await assert.rejects(mergePr(context, { issueNumber, prNumber }), /failed or pending checks/);
    checksPassed = true;
    blockerOpen = true;
    await assert.rejects(mergePr(context, { issueNumber, prNumber }), /unresolved native blockers/);
    blockerOpen = false;
    issuePoints = 4;
    await assert.rejects(
      finishIssue(context, { issueNumber, prNumber, strategy: 'merge' }),
      /did not report the exact merge commit/u,
    );
    assert.equal(calls.filter((call) => call === 'git:createCommit').length, 1);
    const attemptPath = join(
      gitCommonDir(root),
      'ai-delivery',
      'merge-attempts',
      String(issueNumber),
      `${headSha}.json`,
    );
    const attempt = JSON.parse(readFileSync(attemptPath, 'utf8')) as Record<string, unknown>;
    assert.equal(attempt.operation, 'updateRefs');
    assert.equal(attempt.actor, 'synthetic-author');
    assert.equal(attempt.actorLogin, 'synthetic-author[bot]');
    authenticatedAuthor = 'different-author[bot]';
    await assert.rejects(
      finishIssue(context, { issueNumber, prNumber, strategy: 'merge' }),
      /Merge attempt disagrees with its exact source, operation or author/u,
    );
    authenticatedAuthor = 'synthetic-author[bot]';
    assert.equal(calls.filter((call) => call === 'git:createCommit').length, 1);
    await assert.rejects(finishIssue(context, { issueNumber, prNumber, strategy: 'merge' }), /readback is unresolved/u);
    assert.equal(calls.filter((call) => call === 'git:createCommit').length, 1);
    const resultPath = join(gitCommonDir(root), 'ai-delivery', 'merge-results', String(issueNumber), `${headSha}.json`);
    const originalResult = readFileSync(resultPath, 'utf8');
    const result = JSON.parse(originalResult) as Record<string, unknown>;
    const { resultId: _resultId, ...resultContent } = result;
    const wrongResult = { ...resultContent, mergeSha: 'a'.repeat(40) };
    writeFileSync(resultPath, JSON.stringify({ ...wrongResult, resultId: digestValue(wrongResult) }), {
      mode: 0o600,
    });
    await assert.rejects(
      finishIssue(context, { issueNumber, prNumber, strategy: 'merge' }),
      /exact prepared merge intent/u,
    );
    writeFileSync(resultPath, originalResult, { mode: 0o600 });
    const reviewedHead = headSha;
    headSha = 'b'.repeat(40);
    await assert.rejects(
      finishIssue(context, { issueNumber, prNumber, strategy: 'merge' }),
      /exact prepared merge intent/u,
    );
    headSha = reviewedHead;
    assert.equal(calls.filter((call) => call === 'git:createCommit').length, 1);
    if (routing.mergedContinuation) {
      enableDispatch();
      const terminal = await executeTool('issue_pr_merge', { issueNumber, prNumber, strategy: 'merge' }, execution);
      assert.equal((terminal as { mergeSha: string }).mergeSha, mergeSha);
      assert.equal(issue.state, 'open');
      const previous = getIssueWorktreeStrict(issueNumber, root);
      assert.equal(previous.status, 'merged');
      const registryPath = join(root, '.issue-cli', 'worktrees.json');
      const registryBytes = readFileSync(registryPath);
      const custody = [
        'runs@2',
        'publications',
        'reviews',
        'merge-intents',
        'merge-attempts',
        'merge-results',
        'merges',
      ];
      const oldReceipts: { path: string; bytes: Buffer }[] = [];
      const saveReceipts = (path: string) => {
        if (!existsSync(path)) return;
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          const child = join(path, entry.name);
          if (entry.isDirectory()) saveReceipts(child);
          else oldReceipts.push({ path: child, bytes: readFileSync(child) });
        }
      };
      for (const name of custody) saveReceipts(join(gitCommonDir(root), 'ai-delivery', name));
      const ownerPath = join(gitCommonDir(root), 'ai-delivery/worktree-owners');
      const ownerHash = directoryHash(ownerPath);
      await assert.rejects(
        developIssue(
          {
            ...context,
            config: {
              ...config,
              roles: {
                ...config.roles,
                author: { ...config.roles.author, identity: 'other-owner' },
              },
            },
          },
          issueNumber,
        ),
        /same preparing owner/u,
      );
      issue.state = 'closed';
      await assert.rejects(executeTool('issue_develop', { issueNumber }, execution), /closed/u);
      issue.state = 'open';
      headSha = 'b'.repeat(40);
      await assert.rejects(executeTool('issue_develop', { issueNumber }, execution), /terminal receipt/u);
      headSha = reviewedHead;
      const mergePath = join(gitCommonDir(root), 'ai-delivery/merges', String(issueNumber), `${headSha}.json`);
      const mergeBytes = readFileSync(mergePath);
      unlinkSync(mergePath);
      await assert.rejects(executeTool('issue_develop', { issueNumber }, execution), /exact terminal merge receipt/u);
      writeFileSync(mergePath, mergeBytes, { mode: 0o600 });
      assert.deepEqual(readFileSync(registryPath), registryBytes);
      projectStatus = null;
      failNextProjectSync = true;
      await assert.rejects(executeTool('issue_develop', { issueNumber }, execution), /synthetic Project interruption/u);
      const reactivated = getIssueWorktreeStrict(issueNumber, root);
      assert.equal(reactivated.status, 'active');
      assert.equal(reactivated.prNumber, undefined);
      assert.equal(reactivated.identity, previous.identity);
      assert.equal(reactivated.createdAt, previous.createdAt);
      const resumed = await executeTool('issue_develop', { issueNumber }, execution);
      assert.deepEqual(resumed, { path: previous.path, branch: previous.branch });
      assert.equal(projectStatus, 'Active');
      await assert.rejects(verifyIssue({ issueNumber, repoRoot: row.path }), /already-merged issue head/u);
      for (const saved of oldReceipts) {
        assert.deepEqual(readFileSync(saved.path), saved.bytes);
      }
      assert.equal(directoryHash(ownerPath), ownerHash);
      // A fresh commit produces new verification slots while the complete prior head remains immutable.
      writeFileSync(join(row.path, 'change.txt'), 'continued feature\n');
      git(row.path, 'add', 'change.txt');
      git(row.path, 'commit', '-qm', 'continue unfinished synthetic issue');
      const continued = await verifyIssue({ issueNumber, repoRoot: row.path });
      assert.notEqual(continued.classification.head.sha, reviewedHead);
      for (const saved of oldReceipts) assert.deepEqual(readFileSync(saved.path), saved.bytes);
      assert.equal(directoryHash(ownerPath), ownerHash);
      assert.equal(calls.filter((call) => call === 'git:createCommit').length, 1);
      return;
    }
    const blockedRecordPath = join(gitCommonDir(root), 'ai-delivery', 'deliveries.json');
    mkdirSync(blockedRecordPath);
    await assert.rejects(
      finishIssue(context, { issueNumber, prNumber, strategy: 'merge' }),
      /Delivery record store is invalid/u,
    );
    assert.equal(existsSync(row.path), false);
    rmSync(blockedRecordPath, { recursive: true });
    const dispatchClient = enableDispatch();
    execution.runtimeEntryPath = runtimeEntryPath;
    const terminalMerge = (await executeTool(
      'issue_pr_merge',
      { issueNumber, prNumber, strategy: 'merge' },
      execution,
    )) as { mergeSha: string };
    assert.equal(terminalMerge.mergeSha, git(remote, 'rev-parse', 'refs/heads/main'));
    const finished = (await executeTool('issue_finish', { issueNumber, prNumber, strategy: 'merge' }, execution)) as {
      mergeSha: string;
      issueClosed: true;
      cleaned: true;
    };
    assert.equal(finished.issueClosed, true);
    assert.equal(finished.cleaned, true);
    assert.equal(projectStatus, 'Shipped');
    assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), finished.mergeSha);
    assert.equal(existsSync(row.path), false);
    assert.equal(getDeliveryRecords(root).length, 1);
    assert.equal(getDeliveryRecords(root)[0]?.points, 4);
    assert.deepEqual(calls, ['issue:create', 'review:create', 'git:createCommit']);
    assert.deepEqual(
      await executeTool('issue_finish', { issueNumber, prNumber, strategy: 'merge' }, execution),
      finished,
    );
    await assert.rejects(
      executeTool('issue_finish', { issueNumber, prNumber: 24 }, execution),
      /exact terminal merge receipts/u,
    );
    dispatchClient.mockRestore();
    assert.equal(getDeliveryRecords(root).length, 1);
    await assert.rejects(finishIssue(context, { issueNumber, prNumber: 24 }), /exact terminal merge receipts/u);
    const newlyStarted = await startTrackedIssue(context, { request: 'New synthetic task' });
    assert.equal(newlyStarted.mode, 'created-issue');
    assert.equal(newlyStarted.issueNumber, issueNumber);
    assert.equal(createPayloads.at(-1)?.body, 'New synthetic task');
    assert.equal(issuePoints, 2);
    issue.state = 'closed';
    const beforeDevelopment = calls.filter((call) => call === 'issue:create').length;
    const developmentFailure = (await startTrackedIssue(context, {
      title: issue.title,
      body: issue.body,
      points: 2,
      develop: true,
    })) as { status: string; failure: { phase: string }; safeResume: { arguments: Record<string, unknown> } };
    assert.equal(developmentFailure.status, 'created-not-started');
    assert.equal(developmentFailure.failure.phase, 'development');
    assert.equal(calls.filter((call) => call === 'issue:create').length, beforeDevelopment + 1);
    issue.state = 'open';
    const resumedDevelopment = await startTrackedIssue(context, developmentFailure.safeResume.arguments);
    assert.equal(resumedDevelopment.status, 'started');
    assert.equal(calls.filter((call) => call === 'issue:create').length, beforeDevelopment + 1);
    projectStatus = null;
    failNextProjectSync = true;
    const beforeTracking = calls.filter((call) => call === 'issue:create').length;
    const trackingFailure = (await startTrackedIssue(context, {
      title: issue.title,
      body: issue.body,
      points: 2,
      develop: true,
    })) as { status: string; failure: { phase: string }; safeResume: { arguments: Record<string, unknown> } };
    assert.equal(trackingFailure.status, 'created-not-started');
    assert.equal(trackingFailure.failure.phase, 'tracking');
    const resumedTracking = await startTrackedIssue(context, trackingFailure.safeResume.arguments);
    assert.equal(resumedTracking.status, 'started');
    assert.equal(calls.filter((call) => call === 'issue:create').length, beforeTracking + 1);
  } finally {
    restoreTransport?.();
    process.env.PATH = originalPath;
    restoreDispatchClient?.();
    rmSync(root, { recursive: true, force: true });
  }
}

test.each([
  { remote: 'origin', divergentOrigin: false },
  { remote: 'upstream', divergentOrigin: false },
  { remote: 'upstream', divergentOrigin: true },
])(
  'synthetic lifecycle finishes with remote $remote and divergent origin $divergentOrigin',
  syntheticLifecycle,
  15_000,
);

test(
  'supported develop resumes an open merged issue under the same owner and preserves prior receipts',
  { timeout: 0 },
  async () => syntheticLifecycle({ remote: 'origin', divergentOrigin: false, mergedContinuation: true }),
);

test(
  'supported native metadata updates a legacy target without adopting its source or receipts',
  { timeout: 0 },
  async () => syntheticLifecycle({ remote: 'origin', divergentOrigin: false, legacyNativeMetadata: true }),
);

test(
  'an unrelated consumer uses public MCP setup through verified configured-author publication, counted review readback, merge and cleanup',
  { timeout: 0 },
  async () => {
    await syntheticLifecycle({ remote: 'origin', divergentOrigin: false, producerOnboarding: true });
  },
);

function ordinaryCliRebuildScript(
  output: string,
  mode: 'pass' | 'absent' | 'limit' | 'cancel' = 'pass',
  target = join(output, 'cli.js'),
): string {
  return `(async () => {
    const fs = require('node:fs');
    const trace = event => fs.appendFileSync(${JSON.stringify(join(output, 'events'))}, event + '\\n');
    trace('command-started'); fs.unlinkSync(${JSON.stringify(target)}); trace('target-removed');
    if (${JSON.stringify(dirname(target))} !== ${JSON.stringify(output)}) fs.rmdirSync(${JSON.stringify(dirname(target))});
    if (${JSON.stringify(mode)} === 'limit') fs.writeFileSync(${JSON.stringify(join(output, 'oversized'))}, 'x'.repeat(4096));
    for (let unit = 0; unit < 32; unit++) {
      fs.appendFileSync(${JSON.stringify(join(output, 'compiled'))}, 'build-unit\\n');
      trace('build-unit-' + unit);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (${JSON.stringify(mode)} !== 'absent') {
      fs.mkdirSync(${JSON.stringify(dirname(target))}, { recursive: true });
      fs.writeFileSync(${JSON.stringify(target)}, 'rebuilt CLI'); trace('target-restored');
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });`;
}

test.each(['direct', 'chain', 'directory'] as const)(
  'ordinary bounded rebuild restores its %s CLI target after observable build work',
  async (shape) => {
    const output = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-cli-rebuild-')));
    const { root } = await fixture();
    const target = shape === 'directory' ? join(output, 'dist', 'cli.js') : join(output, 'cli.js');
    const alias = join(output, 'cli');
    const events = join(output, 'events');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'original CLI');
    writeFileSync(join(output, 'unrelated'), 'preserved');
    if (shape === 'direct') symlinkSync('./cli.js', alias);
    else {
      symlinkSync(shape === 'chain' ? './cli.js' : './dist', join(output, 'intermediate'));
      symlinkSync(shape === 'chain' ? './intermediate' : './intermediate/cli.js', alias);
    }
    const observations: string[] = [];
    const duringAbsence: { sampledNewOutputBytes?: number; sampledAggregateRssBytes?: number }[] = [];
    const progress = vi.spyOn(process.stderr, 'write').mockImplementation((line) => {
      observations.push(String(line));
      if (!existsSync(target) && String(line).includes('sampledNewOutputBytes'))
        duringAbsence.push(JSON.parse(String(line).slice(String(line).indexOf('{'))) as (typeof duringAbsence)[number]);
      return true;
    });
    const script = ordinaryCliRebuildScript(output, 'pass', target);
    try {
      const { withRuntimeSetupWriter } = await import('./verification.js');
      await withRuntimeSetupWriter(root, (runner) =>
        runner.run([process.execPath, '-e', script], {
          maxAggregateRssBytes: 1_000_000_000,
          minFreeDiskBytes: 1,
          maxNewOutputBytes: 8192,
          outputRoots: [output],
        }),
      );
      assert.equal(readFileSync(target, 'utf8'), 'rebuilt CLI');
      assert.equal(readFileSync(join(output, 'compiled'), 'utf8').split('\n').length, 33);
      assert.equal(readFileSync(join(output, 'unrelated'), 'utf8'), 'preserved');
      assert.ok(duringAbsence.some((sample) => (sample.sampledNewOutputBytes ?? 0) > 0));
      assert.ok(duringAbsence.every((sample) => (sample.sampledAggregateRssBytes ?? 0) > 0));
    } finally {
      console.log(
        JSON.stringify({
          scenario: 'ordinary-cli-rebuild',
          shape,
          firstObservation: observations.find((line) => line.includes('ENOENT')),
          events: readFileSync(events, 'utf8').trim().split('\n'),
          targetRestored: existsSync(target),
          unrelatedPreserved: readFileSync(join(output, 'unrelated'), 'utf8') === 'preserved',
        }),
      );
      progress.mockRestore();
      rmSync(root, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true });
    }
  },
);

test.each([
  'bytes',
  'rss',
  'disk',
  'fifo',
  'permission',
  'identity',
  'ancestor',
  'cycle',
  'chain-identity',
  'directory-identity',
  'chain-cycle',
] as const)('a missing validated target retains complete scan and %s rejection across roots', async (mode) => {
  const output = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-rebuild-boundary-')));
  const { root } = await fixture();
  const first = join(output, 'first'),
    second = join(output, 'second');
  mkdirSync(first);
  mkdirSync(second);
  const directory = join(first, 'dist'),
    target = join(directory, 'cli.js'),
    alias = join(first, 'cli');
  mkdirSync(directory);
  writeFileSync(target, 'CLI');
  const intermediate = join(first, 'intermediate');
  if (mode === 'chain-identity' || mode === 'chain-cycle') {
    symlinkSync('./dist/cli.js', intermediate);
    symlinkSync('./intermediate', alias);
  } else if (mode === 'directory-identity') {
    symlinkSync('./dist', intermediate);
    symlinkSync('./intermediate/cli.js', alias);
  } else symlinkSync('./dist/cli.js', alias);
  writeFileSync(join(second, 'unrelated'), 'preserved');
  const released = join(second, 'released');
  const observations: string[] = [];
  const progress = vi.spyOn(process.stderr, 'write').mockImplementation((line) => {
    observations.push(String(line));
    if (String(line).includes('ENOENT')) writeFileSync(released, 'observed');
    return true;
  });
  const script = `(async () => {
      const fs = require('node:fs'), cp = require('node:child_process');
      fs.unlinkSync(${JSON.stringify(target)});
      while (!fs.existsSync(${JSON.stringify(released)})) await new Promise(resolve => setTimeout(resolve, 10));
      if (${JSON.stringify(mode)} === 'bytes') fs.writeFileSync(${JSON.stringify(join(second, 'oversized'))}, 'x'.repeat(4096));
      if (${JSON.stringify(mode)} === 'rss') globalThis.retainedBuildMemory = Buffer.alloc(200 * 1024 * 1024, 1);
      if (${JSON.stringify(mode)} === 'disk') fs.writeFileSync(${JSON.stringify(join(second, 'disk-output'))}, Buffer.alloc(64 * 1024 * 1024, 1));
      if (${JSON.stringify(mode)} === 'fifo') cp.execFileSync('mkfifo', [${JSON.stringify(join(second, 'unsupported'))}]);
      if (${JSON.stringify(mode)} === 'permission') {
        fs.mkdirSync(${JSON.stringify(join(second, 'denied'))});
        fs.chmodSync(${JSON.stringify(join(second, 'denied'))}, 0);
      }
      if (${JSON.stringify(mode)} === 'identity') {
        fs.unlinkSync(${JSON.stringify(alias)}); fs.writeFileSync(${JSON.stringify(join(first, 'other'))}, 'other');
        fs.symlinkSync('./other', ${JSON.stringify(alias)});
      }
      if (${JSON.stringify(mode)} === 'ancestor') {
        fs.rmdirSync(${JSON.stringify(directory)}); fs.symlinkSync(${JSON.stringify(second)}, ${JSON.stringify(directory)});
      }
      if (${JSON.stringify(mode)} === 'cycle') fs.symlinkSync('./cli.js', ${JSON.stringify(target)});
      if (${JSON.stringify(mode)} === 'chain-identity') {
        fs.unlinkSync(${JSON.stringify(intermediate)}); fs.writeFileSync(${JSON.stringify(join(first, 'other'))}, 'other');
        fs.symlinkSync('./other', ${JSON.stringify(intermediate)});
      }
      if (${JSON.stringify(mode)} === 'directory-identity') {
        fs.unlinkSync(${JSON.stringify(intermediate)}); fs.mkdirSync(${JSON.stringify(join(first, 'other'))});
        fs.writeFileSync(${JSON.stringify(join(first, 'other', 'cli.js'))}, 'other');
        fs.symlinkSync('./other', ${JSON.stringify(intermediate)});
      }
      if (${JSON.stringify(mode)} === 'chain-cycle') {
        fs.unlinkSync(${JSON.stringify(intermediate)}); fs.symlinkSync('./cli', ${JSON.stringify(intermediate)});
      }
      for (let unit = 0; unit < 32; unit++) {
        fs.appendFileSync(${JSON.stringify(join(second, 'work'))}, 'unit\\n');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      fs.writeFileSync(${JSON.stringify(target)}, 'rebuilt CLI');
    })().catch(error => { console.error(error); process.exitCode = 1; });`;
  try {
    const { withRuntimeSetupWriter } = await import('./verification.js');
    const disk = (await import('node:fs')).statfsSync(output);
    await assert.rejects(
      withRuntimeSetupWriter(root, (runner) =>
        runner.run([process.execPath, '-e', script], {
          maxAggregateRssBytes: mode === 'rss' ? 128 * 1024 * 1024 : 1_000_000_000,
          minFreeDiskBytes: mode === 'disk' ? disk.bavail * disk.bsize - 32 * 1024 * 1024 : 1,
          maxNewOutputBytes: mode === 'disk' ? 128 * 1024 * 1024 : 1024,
          outputRoots: [first, second],
        }),
      ),
      (error) => {
        const message = String(error);
        assert.match(
          message,
          mode === 'bytes'
            ? /filesystem output.*exceeded/u
            : mode === 'rss'
              ? /aggregate RSS.*exceeded/u
              : mode === 'disk'
                ? /Free disk fell below/u
                : mode === 'fifo'
                  ? /unsupported file/u
                  : mode === 'permission'
                    ? /readdir failed.*EACCES/u
                    : mode === 'cycle' || mode === 'chain-cycle'
                      ? /ELOOP/u
                      : /identity changed/u,
        );
        assert.match(message, /First filesystem observation:.*ENOENT.*Last filesystem observation:/u);
        assert.doesNotMatch(message, /cleanup failed/u);
        return true;
      },
    );
    assert.ok(observations.some((line) => line.includes('ENOENT')));
    assert.equal(
      observations.some((line) => line.includes('"state":"completed"')),
      false,
    );
    assert.equal(readFileSync(join(second, 'unrelated'), 'utf8'), 'preserved');
  } finally {
    const denied = join(second, 'denied');
    if (existsSync(denied)) chmodSync(denied, 0o700);
    progress.mockRestore();
    rmSync(root, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

test.each(['pass', 'chain-pass', 'command-error', 'cancel', 'persistent', 'limit'] as const)(
  'ordinary owned symlink teardown preserves observation and %s command evidence',
  async (mode) => {
    const output = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-ordinary-teardown-')));
    const { root } = await fixture();
    const controller = new AbortController();
    const events = join(output, 'events');
    const ready = join(output, 'ready');
    const release = join(output, 'release');
    writeFileSync(join(output, 'unrelated'), 'preserved');
    writeFileSync(join(output, 'target'), 'x'.repeat(128));
    if (mode === 'chain-pass') symlinkSync('./target', join(output, 'intermediate'));
    symlinkSync(mode === 'chain-pass' ? './intermediate' : './target', join(output, 'alias'));
    let observedGap = false;
    const observations: string[] = [];
    let releaseTimer: NodeJS.Timeout | undefined;
    const progress = vi.spyOn(process.stderr, 'write').mockImplementation((line) => {
      if (String(line).includes('ENOENT')) observations.push(String(line));
      if (!observedGap && existsSync(ready) && String(line).includes('sampledAggregateRssBytes')) {
        observedGap = true;
        // Synchronize real removal with the sample preceding the synchronous filesystem scan.
        releaseTimer = setTimeout(() => {
          if (mode === 'cancel') controller.abort();
          else writeFileSync(release, 'continue');
        }, 100);
      }
      return true;
    });
    const script = `
(async () => {
  const fs = require('node:fs');
  const trace = value => fs.appendFileSync(${JSON.stringify(events)}, value + '\\n');
  trace('command-started');
  if (['command-error', 'persistent'].includes(${JSON.stringify(mode)})) console.error('synthetic buffered preparation failure');
  fs.unlinkSync(${JSON.stringify(join(output, 'target'))});
  trace('target-removed'); fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
  if (${JSON.stringify(mode)} === 'limit') fs.writeFileSync(${JSON.stringify(join(output, 'retained'))}, 'x'.repeat(512));
  while (!fs.existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 10));
  if (${JSON.stringify(mode)} !== 'persistent') {
    fs.unlinkSync(${JSON.stringify(join(output, 'alias'))}); trace('alias-removed');
    if (${JSON.stringify(mode)} === 'chain-pass') fs.unlinkSync(${JSON.stringify(join(output, 'intermediate'))});
  }
  process.exitCode = ${mode === 'command-error' ? 7 : 0};
})().catch(error => { console.error(error); process.exitCode = 1; });`;
    try {
      const { withRuntimeSetupWriter } = await import('./verification.js');
      const run = withRuntimeSetupWriter(root, (runner) =>
        runner.run(
          [process.execPath, '-e', script],
          {
            maxAggregateRssBytes: 1_000_000_000,
            minFreeDiskBytes: 1,
            maxNewOutputBytes: mode === 'limit' ? 256 : 4096,
            outputRoots: [output],
          },
          controller.signal,
        ),
      );
      if (mode === 'pass' || mode === 'chain-pass') await run;
      else
        await assert.rejects(run, (error: unknown) => {
          const message = String(error);
          assert.match(
            message,
            mode === 'cancel'
              ? /cancelled/u
              : mode === 'persistent'
                ? /broken or cyclic symbolic link.*ENOENT/u
                : mode === 'limit'
                  ? /filesystem output.*exceeded/u
                  : /exit 7/u,
          );
          assert.doesNotMatch(message, /cleanup failed/u);
          assert.ok(message.includes(join(output, 'alias')));
          assert.match(message, /ENOENT/u);
          if (mode === 'command-error' || mode === 'persistent') {
            const digest = /Command output (sha256:[a-f0-9]{64})/u.exec(message)?.[1];
            assert.ok(digest);
            assert.match(
              readFileSync(
                join(root, '.git', 'ai-delivery', 'verification@1', 'command-output', `${digest.slice(7)}.bin`),
                'utf8',
              ),
              /synthetic buffered preparation failure/u,
            );
          }
          return true;
        });
      assert.ok(observedGap);
      assert.ok(
        observations.some((line) => {
          const observation = JSON.parse(line.slice(line.indexOf('{'))) as { reason: string };
          return observation.reason.includes(join(output, 'alias'));
        }),
      );
      assert.equal(readFileSync(join(output, 'unrelated'), 'utf8'), 'preserved');
      console.log(
        JSON.stringify({
          scenario: 'ordinary-owned-symlink-teardown',
          mode,
          firstObservation: (JSON.parse(observations[0]!.slice(observations[0]!.indexOf('{'))) as { reason: string })
            .reason,
          events: readFileSync(events, 'utf8').trim().split('\n'),
          unrelatedPreserved: true,
          aliasRetained: readdirSync(output).includes('alias'),
        }),
      );
      assert.deepEqual(
        readFileSync(events, 'utf8').trim().split('\n'),
        mode === 'cancel' || mode === 'persistent' || mode === 'limit'
          ? ['command-started', 'target-removed']
          : ['command-started', 'target-removed', 'alias-removed'],
      );
      if (mode === 'cancel' || mode === 'persistent') {
        await assert.rejects(
          withRuntimeSetupWriter(root, (runner) =>
            runner.run([process.execPath, '-e', ''], {
              maxAggregateRssBytes: 1_000_000_000,
              minFreeDiskBytes: 1,
              maxNewOutputBytes: 4096,
              outputRoots: [output],
            }),
          ),
          (error: unknown) => {
            assert.ok(String(error).includes(join(output, 'alias')));
            assert.match(String(error), /ENOENT/u);
            return true;
          },
        );
      }
    } finally {
      controller.abort();
      if (releaseTimer !== undefined) clearTimeout(releaseTimer);
      progress.mockRestore();
      rmSync(root, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true });
    }
  },
);

test('injected first failed scan duration does not consume the subsequent observation stall window', async () => {
  const output = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-scan-duration-')));
  const { root } = await fixture();
  const target = join(output, 'target'),
    alias = join(output, 'alias'),
    release = join(output, 'release');
  writeFileSync(target, 'target');
  const fs = (await import('node:fs')).default;
  const actualRealpath = fs.realpathSync;
  const now = Date.now.bind(Date);
  let offset = 0,
    delayed = false,
    firstObservation: string | undefined;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + offset);
  const scan = vi.spyOn(fs, 'realpathSync').mockImplementation((path, options) => {
    try {
      return actualRealpath(path, options);
    } catch (error) {
      if (path === alias && !delayed) {
        delayed = true;
        offset = 1500;
      }
      throw error;
    }
  });
  syncBuiltinESMExports();
  const progress = vi.spyOn(process.stderr, 'write').mockImplementation((line) => {
    if (firstObservation === undefined && String(line).includes('ENOENT')) {
      firstObservation = String(line);
      unlinkSync(alias);
      writeFileSync(release, 'finish');
    }
    return true;
  });
  const script = `(async () => {
    const fs = require('node:fs'); fs.unlinkSync(${JSON.stringify(target)});
    fs.symlinkSync('./target', ${JSON.stringify(alias)});
    while (!fs.existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 10));
  })().catch(error => { console.error(error); process.exitCode = 1; });`;
  try {
    const { withRuntimeSetupWriter } = await import('./verification.js');
    await withRuntimeSetupWriter(root, (runner) =>
      runner.run([process.execPath, '-e', script], {
        maxAggregateRssBytes: 1_000_000_000,
        minFreeDiskBytes: 1,
        maxNewOutputBytes: 4096,
        outputRoots: [output],
      }),
    );
    assert.ok(delayed);
    assert.ok(firstObservation);
    assert.equal(existsSync(alias), false);
  } finally {
    progress.mockRestore();
    scan.mockRestore();
    syncBuiltinESMExports();
    clock.mockRestore();
    rmSync(root, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

test('injected observation stall rejects a late complete retry for an unvalidated alias', async () => {
  const output = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-observation-deadline-')));
  const { root } = await fixture();
  const target = join(output, 'target'),
    alias = join(output, 'alias'),
    release = join(output, 'release');
  writeFileSync(target, 'target');
  const now = Date.now.bind(Date);
  let offset = 0;
  let firstObservation: string | undefined;
  let advance: NodeJS.Timeout | undefined;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + offset);
  const progress = vi.spyOn(process.stderr, 'write').mockImplementation((line) => {
    if (firstObservation === undefined && String(line).includes('ENOENT')) {
      firstObservation = String(line);
      advance = setTimeout(() => {
        // This test injects only the deadline. Alias removal and the subsequent complete scan are real.
        unlinkSync(alias);
        offset = 1100;
        writeFileSync(release, 'finish');
      }, 0);
    }
    return true;
  });
  const script = `(async () => {
    const fs = require('node:fs'); fs.unlinkSync(${JSON.stringify(target)});
    fs.symlinkSync('./target', ${JSON.stringify(alias)});
    while (!fs.existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 10));
  })().catch(error => { console.error(error); process.exitCode = 1; });`;
  try {
    const { withRuntimeSetupWriter } = await import('./verification.js');
    await assert.rejects(
      withRuntimeSetupWriter(root, (runner) =>
        runner.run([process.execPath, '-e', script], {
          maxAggregateRssBytes: 1_000_000_000,
          minFreeDiskBytes: 1,
          maxNewOutputBytes: 4096,
          outputRoots: [output],
        }),
      ),
      (error: unknown) => {
        assert.match(String(error), /remained unavailable for 1 second/u);
        assert.ok(String(error).includes(alias));
        assert.match(String(error), /ENOENT/u);
        assert.doesNotMatch(String(error), /cleanup failed/u);
        return true;
      },
    );
    assert.ok(firstObservation);
    assert.equal(readdirSync(output).includes('alias'), false);
  } finally {
    if (advance !== undefined) clearTimeout(advance);
    progress.mockRestore();
    clock.mockRestore();
    rmSync(root, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

test.each(['escape', 'broken', 'cycle'] as const)(
  'output observation rejects %s aliases without running policy commands',
  async (kind) => {
    const { root, counter } = await fixture();
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-output-alias-')));
    try {
      const output = join(base, 'output');
      mkdirSync(output);
      if (kind === 'escape') {
        writeFileSync(join(base, 'outside'), 'outside');
        symlinkSync('../outside', join(output, 'alias'));
      }
      if (kind === 'broken') symlinkSync('./absent', join(output, 'alias'));
      if (kind === 'cycle') {
        symlinkSync('./other', join(output, 'alias'));
        symlinkSync('./alias', join(output, 'other'));
      }
      const row = await prepareIssueWorktree({
        baseRef: 'main',
        identity: 'synthetic-author',
        issueNumber: 17,
        repoRoot: root,
      });
      await assert.rejects(
        verifyIssue({
          issueNumber: 17,
          repoRoot: row.path,
          resourceBounds: {
            maxAggregateRssBytes: 1_000_000_000,
            minFreeDiskBytes: 1,
            maxNewOutputBytes: 1024,
            outputRoots: [output],
          },
        }),
        /escaping|broken|cyclic/u,
      );
      assert.equal(existsSync(counter), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  },
);

test('fully cached bounded verification still rejects a newly leaked FIFO', async () => {
  const { root, counter } = await fixture();
  const output = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-cached-fifo-')));
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    const bounds = {
      maxAggregateRssBytes: 1_000_000_000,
      minFreeDiskBytes: 1,
      maxNewOutputBytes: 1024,
      outputRoots: [output],
    };
    await verifyIssue({ issueNumber: 17, repoRoot: row.path, resourceBounds: bounds });
    assert.equal(readFileSync(counter, 'utf8'), '1');
    execFileSync('mkfifo', [join(output, 'leaked')]);
    await assert.rejects(
      verifyIssue({ issueNumber: 17, repoRoot: row.path, resourceBounds: bounds }),
      /unsupported file/u,
    );
    assert.equal(readFileSync(counter, 'utf8'), '1');
  } finally {
    rmSync(output, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

let node26Package: { executable: string; root: string; temporary: string } | undefined;

function packedNode26Consumer(): { executable: string; root: string; temporary: string } {
  if (node26Package !== undefined) return node26Package;
  assert.equal(process.version, 'v24.21.0', 'canonical verification controller must remain Node 24.21.0');
  const executable = process.env['AI_DELIVERY_NODE26_EXECUTABLE'];
  assert.ok(executable, 'set AI_DELIVERY_NODE26_EXECUTABLE to the actual Node 26.2.0 executable');
  assert.equal(execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim(), 'v26.2.0');
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-node26-')));
  try {
    const source = fileURLToPath(new URL('../', import.meta.url));
    const pack = JSON.parse(
      execFileSync('npm', ['pack', '--json', '--pack-destination', temporary], {
        cwd: source,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      }),
    ) as [{ filename: string }];
    execFileSync('tar', ['-xzf', join(temporary, pack[0].filename), '-C', temporary]);
    const root = join(temporary, 'package');
    symlinkSync(join(source, 'node_modules'), join(root, 'node_modules'), 'dir');
    process.stderr.write(
      `ai-delivery.node26-consumer ${JSON.stringify({
        controller: process.version,
        consumer: 'v26.2.0',
        archiveSha256: createHash('sha256')
          .update(readFileSync(join(temporary, pack[0].filename)))
          .digest('hex'),
        manifestSha256: createHash('sha256')
          .update(readFileSync(join(root, 'package.json')))
          .digest('hex'),
      })}\n`,
    );
    node26Package = { executable: realpathSync(executable), root, temporary };
    return node26Package;
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

afterAll(() => {
  if (node26Package !== undefined) rmSync(node26Package.temporary, { recursive: true, force: true });
});

function node26ConsumerScript(script: string): string {
  const consumer = packedNode26Consumer();
  return `
require('node:assert/strict').equal(process.version, 'v24.21.0');
const child = require('node:child_process').spawnSync(${JSON.stringify(consumer.executable)}, ['-e', ${JSON.stringify(script)}], { cwd: ${JSON.stringify(consumer.root)}, stdio: 'inherit' });
if (child.error) throw child.error;
process.exit(child.status ?? 1);`;
}

test.each(['pass', 'absent', 'limit', 'cancel'] as const)(
  'Node 26 packed public verification preserves CLI rebuild %s behavior',
  async (mode) => {
    const output = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-packed-rebuild-')));
    const target = join(output, 'cli.js');
    writeFileSync(target, 'original CLI');
    symlinkSync('./cli.js', join(output, 'cli'));
    writeFileSync(join(output, 'unrelated'), 'preserved');
    const { root } = await fixture({ personalAuthor: true, firstStageScript: ordinaryCliRebuildScript(output, mode) });
    try {
      const row = await prepareIssueWorktree({
        baseRef: 'main',
        identity: 'host-author',
        issueNumber: 17,
        repoRoot: root,
      });
      const clients = syntheticDiscoveryClients();
      const replies: { fragment: string; data: unknown }[] = [];
      for (const fragment of [
        'query DeliveryRepository',
        'query ProjectDeliveryConfiguration',
        'issueFields(first:',
        'issueTypes(first:',
      ])
        replies.push({ fragment, data: await clients.graphql(fragment) });
      const consumer = packedNode26Consumer();
      const result = execFileSync(
        consumer.executable,
        [
          '-e',
          `(async () => {
        const assert = require('node:assert/strict'), fs = require('node:fs');
        assert.equal(process.version, 'v26.2.0');
        const replies = ${JSON.stringify(replies)};
        // Only GitHub discovery transport is synthetic; package, writer, scanner and child filesystem are real.
        globalThis.fetch = async (url, options) => {
          assert.equal(String(url), 'https://api.github.com/graphql');
          const query = JSON.parse(options.body).query;
          const reply = replies.find(reply => query.includes(reply.fragment));
          assert.ok(reply, 'unexpected synthetic discovery query');
          return new Response(JSON.stringify({ data: reply.data }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
        process.env.AUTHOR_TOKEN = 'synthetic-author-token';
        const { verifyIssue } = await import('@aviaratech/ai-delivery/agent');
        const controller = new AbortController();
        const observations = []; const write = process.stderr.write.bind(process.stderr);
        process.stderr.write = line => {
          observations.push(String(line));
          if (${JSON.stringify(mode)} === 'cancel' && String(line).includes('ENOENT')) controller.abort();
          return true;
        };
        try {
          const running = verifyIssue({ issueNumber: 17, repoRoot: ${JSON.stringify(row.path)}, signal: controller.signal,
            resourceBounds: { maxAggregateRssBytes: 1000000000, minFreeDiskBytes: 1,
              maxNewOutputBytes: ${mode === 'limit' ? 1024 : 8192}, outputRoots: [${JSON.stringify(output)}] } });
          if (${JSON.stringify(mode)} === 'pass') {
            const run = await running;
            assert.ok(run.resources.sampleCount > 0); assert.ok(run.resources.maxSampledNewOutputBytes > 0);
            assert.equal(fs.readFileSync(${JSON.stringify(target)}, 'utf8'), 'rebuilt CLI');
            // Compatible completed proof is reused, but the current final filesystem is still strictly scanned.
            fs.unlinkSync(${JSON.stringify(target)});
            await assert.rejects(verifyIssue({ issueNumber: 17, repoRoot: ${JSON.stringify(row.path)},
              resourceBounds: { maxAggregateRssBytes: 1000000000, minFreeDiskBytes: 1, maxNewOutputBytes: 8192,
                outputRoots: [${JSON.stringify(output)}] } }), /broken or cyclic symbolic link/);
          } else {
            await assert.rejects(running, error => {
              assert.match(String(error), ${mode === 'cancel' ? '/cancelled/' : mode === 'limit' ? '/filesystem output.*exceeded/' : '/broken or cyclic symbolic link/'});
              assert.doesNotMatch(String(error), /cleanup failed/); return true;
            });
          }
          assert.ok(observations.some(line => line.includes('ENOENT')));
          assert.equal(fs.readFileSync(${JSON.stringify(join(output, 'unrelated'))}, 'utf8'), 'preserved');
          console.log(JSON.stringify({ scenario: 'packed-node26-cli-rebuild', mode: ${JSON.stringify(mode)},
            firstObservation: observations.find(line => line.includes('ENOENT')), events: fs.readFileSync(${JSON.stringify(join(output, 'events'))}, 'utf8').trim().split('\\n') }));
        } finally { controller.abort(); process.stderr.write = write; }
      })().catch(error => { console.error(error); process.exitCode = 1; });`,
        ],
        {
          cwd: consumer.root,
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
        },
      );
      console.log(result.trim());
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true });
    }
  },
);

function filesystemFixtureScript(
  output: string,
  mode: 'pass' | 'assertion' | 'abrupt' | 'block' | 'cancel',
  runtime: 'node24' | 'node26' = 'node24',
): string {
  const script = `
(async () => {
  const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path'), assert = require('node:assert/strict');
  assert.equal(process.version, ${JSON.stringify(runtime === 'node26' ? 'v26.2.0' : 'v24.21.0')});
  const { withVerificationFilesystemFixture } = await import(${JSON.stringify(runtime === 'node26' ? '@aviaratech/ai-delivery/agent' : new URL('./agent.js', import.meta.url).href)});
  const { loadValidRepositoryDeliveryEvidence } = await import(${JSON.stringify(runtime === 'node26' ? '@aviaratech/ai-delivery/delivery' : new URL('./delivery/index.js', import.meta.url).href)});
  const output = ${JSON.stringify(output)}, fifo = path.join(output, 'fifo'), events = path.join(output, 'events');
  const evidenceId = 'sha256:' + 'a'.repeat(64), currentHead = { sha: 'b'.repeat(40), tree: 'c'.repeat(40) };
  const evidence = path.join(output, 'ai-delivery', 'receipts', 'delivery@1', currentHead.sha, evidenceId.slice(7) + '.json');
  fs.mkdirSync(path.dirname(evidence), { recursive: true });
  const rejectPrivateFile = file => {
    fs.renameSync(file, evidence);
    try { assert.throws(() => loadValidRepositoryDeliveryEvidence({ createInput: { gitCommonDir: output, currentHead }, evidenceId }), /private regular file/); }
    finally { fs.renameSync(evidence, file); }
  };
  const gate = JSON.parse(process.env.AI_DELIVERY_OUTPUT_OBSERVATION_GATE);
  const trace = value => fs.appendFileSync(events, value + '\\n');
  await withVerificationFilesystemFixture(async () => {
    cp.execFileSync('mkfifo', ['-m', '600', fifo]);
    fs.writeFileSync(path.join(output, 'capability'), JSON.stringify(gate));
    trace('created');
    try {
      if (${JSON.stringify(mode)} === 'abrupt') process.exit(9);
      if (${JSON.stringify(mode)} === 'cancel') await new Promise(() => { setInterval(() => {}, 1000); });
      if (${JSON.stringify(mode)} === 'block') fs.readFileSync(fifo);
      while (fs.readdirSync(path.join(gate.directory, 'requests')).length === 0) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(fs.existsSync(fifo)); trace('scan-queued');
      rejectPrivateFile(fifo); trace('reader-rejected');
      const regular = path.join(output, 'regular'), hard = path.join(output, 'hard'), alias = path.join(output, 'alias');
      fs.writeFileSync(regular, 'x'.repeat(128), { mode: 0o600 });
      fs.linkSync(regular, hard); rejectPrivateFile(hard); fs.unlinkSync(hard);
      fs.symlinkSync('./regular', alias); rejectPrivateFile(alias); fs.unlinkSync(alias);
      if (${JSON.stringify(mode)} === 'assertion') throw new Error('synthetic reader assertion failure');
    } finally { fs.unlinkSync(fifo); trace('cleaned'); }
  });
  trace('released');
})().catch(error => { console.error(error.message); process.exitCode = 1; });`;
  return runtime === 'node26' ? node26ConsumerScript(script) : script;
}

test.each([
  ['pass', 'node24'],
  ['assertion', 'node24'],
  ['pass', 'node26'],
  ['assertion', 'node26'],
] as const)(
  'filesystem fixture gate deterministically queues a scan through reader rejection and %s teardown on %s',
  async (mode, runtime) => {
    const output = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-fixture-gate-')));
    const { root } = await fixture({ firstStageScript: filesystemFixtureScript(output, mode, runtime) });
    try {
      const row = await prepareIssueWorktree({
        baseRef: 'main',
        identity: 'synthetic-author',
        issueNumber: 17,
        repoRoot: root,
      });
      const run = verifyIssue({
        issueNumber: 17,
        repoRoot: row.path,
        resourceBounds: {
          maxAggregateRssBytes: 1_000_000_000,
          minFreeDiskBytes: 1,
          maxNewOutputBytes: 2048,
          outputRoots: [output],
        },
      });
      if (mode === 'assertion') await assert.rejects(run, /exit 1/u);
      else assert.ok((await run).resources!.maxSampledNewOutputBytes! >= 128);
      assert.equal(existsSync(join(output, 'fifo')), false);
      const events = readFileSync(join(output, 'events'), 'utf8').trim().split('\n');
      assert.deepEqual(
        events,
        mode === 'pass'
          ? ['created', 'scan-queued', 'reader-rejected', 'cleaned', 'released']
          : ['created', 'scan-queued', 'reader-rejected', 'cleaned'],
      );
      const capability = JSON.parse(readFileSync(join(output, 'capability'), 'utf8')) as { directory: string };
      assert.equal(existsSync(capability.directory), false);
      assert.equal(readFileSync(join(output, 'regular'), 'utf8').length, 128);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true });
    }
  },
);

test.each([
  ['abrupt', 'node24'],
  ['block', 'node24'],
  ['cancel', 'node24'],
  ['abrupt', 'node26'],
  ['block', 'node26'],
  ['cancel', 'node26'],
] as const)(
  'filesystem fixture gate preserves leaked FIFO and unrelated files after %s on %s',
  async (mode, runtime) => {
    const output = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-fixture-failure-')));
    writeFileSync(join(output, 'unrelated'), 'preserved');
    const { root } = await fixture({ firstStageScript: filesystemFixtureScript(output, mode, runtime) });
    const controller = new AbortController();
    let running: Promise<unknown> | undefined;
    const progress = vi.spyOn(process.stderr, 'write');
    try {
      const row = await prepareIssueWorktree({
        baseRef: 'main',
        identity: 'synthetic-author',
        issueNumber: 17,
        repoRoot: root,
      });
      const bounds = {
        maxAggregateRssBytes: 1_000_000_000,
        minFreeDiskBytes: 1,
        maxNewOutputBytes: 2048,
        outputRoots: [output],
      };
      running = verifyIssue({
        issueNumber: 17,
        repoRoot: row.path,
        resourceBounds: bounds,
        signal: controller.signal,
      }).catch((error: unknown) => error);
      if (mode === 'cancel') {
        for (let attempt = 0; attempt < 300 && !existsSync(join(output, 'capability')); attempt++)
          await new Promise((resolve) => setTimeout(resolve, 20));
        assert.ok(existsSync(join(output, 'capability')));
        const cap = JSON.parse(readFileSync(join(output, 'capability'), 'utf8')) as { directory: string };
        for (let attempt = 0; attempt < 300 && readdirSync(join(cap.directory, 'requests')).length === 0; attempt++)
          await new Promise((resolve) => setTimeout(resolve, 20));
        assert.ok(readdirSync(join(cap.directory, 'requests')).length > 0);
        controller.abort();
      }
      const failure = String(await running);
      assert.match(
        failure,
        mode === 'abrupt' ? /exit 9/u : mode === 'block' ? /reader or teardown is stalled/u : /cancelled/u,
      );
      assert.doesNotMatch(failure, /cleanup failed|live holder/u);
      const capability = JSON.parse(readFileSync(join(output, 'capability'), 'utf8')) as { directory: string };
      assert.equal(existsSync(capability.directory), false);
      assert.ok(existsSync(join(output, 'fifo')));
      assert.equal(readFileSync(join(output, 'unrelated'), 'utf8'), 'preserved');
      if (mode !== 'abrupt')
        assert.ok(progress.mock.calls.filter(([line]) => String(line).includes('sampledAggregateRssBytes')).length > 2);
      await assert.rejects(
        verifyIssue({ issueNumber: 17, repoRoot: row.path, resourceBounds: bounds }),
        /unsupported file/u,
      );
    } finally {
      controller.abort();
      await running;
      progress.mockRestore();
      rmSync(root, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true });
    }
  },
);

test.each(['node24', 'node26'] as const)(
  'filesystem fixture gate still enforces positive byte limits after deterministic contention on %s',
  async (runtime) => {
    const output = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-fixture-limit-')));
    const { root } = await fixture({ firstStageScript: filesystemFixtureScript(output, 'pass', runtime) });
    try {
      const row = await prepareIssueWorktree({
        baseRef: 'main',
        identity: 'synthetic-author',
        issueNumber: 17,
        repoRoot: root,
      });
      await assert.rejects(
        verifyIssue({
          issueNumber: 17,
          repoRoot: row.path,
          resourceBounds: {
            maxAggregateRssBytes: 1_000_000_000,
            minFreeDiskBytes: 1,
            maxNewOutputBytes: 64,
            outputRoots: [output],
          },
        }),
        /filesystem output.*exceeded/u,
      );
      assert.equal(existsSync(join(output, 'fifo')), false);
      assert.equal(readFileSync(join(output, 'regular'), 'utf8').length, 128);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true });
    }
  },
);

test.each(['verification', 'runtime'] as const)(
  'filesystem fixture gate preserves observation and cancellation after direct %s command closure',
  async (mode) => {
    const output = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-fixture-close-')));
    writeFileSync(join(output, 'unrelated'), 'preserved');
    const script = `
(async () => {
  const fs = require('node:fs'), cp = require('node:child_process');
  const child = cp.spawn(process.execPath, ['-e', ${JSON.stringify(filesystemFixtureScript(output, 'cancel'))}], { stdio: 'ignore' });
  child.unref();
  fs.writeFileSync(${JSON.stringify(join(output, 'pids'))}, JSON.stringify({ root: process.pid, descendant: child.pid }));
  while (!fs.existsSync(${JSON.stringify(join(output, 'exit-parent'))})) await new Promise(resolve => setTimeout(resolve, 10));
  process.exit(0);
})().catch(error => { console.error(error.message); process.exitCode = 1; });`;
    const { root } = await fixture({ firstStageScript: script });
    const controller = new AbortController();
    const progress = vi.spyOn(process.stderr, 'write');
    let running: Promise<unknown> | undefined;
    try {
      const row = await prepareIssueWorktree({
        baseRef: 'main',
        identity: 'synthetic-author',
        issueNumber: 17,
        repoRoot: root,
      });
      const bounds = {
        maxAggregateRssBytes: 1_000_000_000,
        minFreeDiskBytes: 1,
        maxNewOutputBytes: 4096,
        outputRoots: [output],
      };
      const { withRuntimeSetupWriter } = await import('./verification.js');
      running = (
        mode === 'verification'
          ? verifyIssue({ issueNumber: 17, repoRoot: row.path, resourceBounds: bounds, signal: controller.signal })
          : withRuntimeSetupWriter(row.path, (runner) =>
              runner.run([process.execPath, '-e', script], bounds, controller.signal),
            )
      ).catch((error: unknown) => error);
      for (let attempt = 0; attempt < 300 && !existsSync(join(output, 'capability')); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(existsSync(join(output, 'capability')));
      const cap = JSON.parse(readFileSync(join(output, 'capability'), 'utf8')) as { directory: string };
      const pids = JSON.parse(readFileSync(join(output, 'pids'), 'utf8')) as { root: number; descendant: number };
      const writerPath = join(root, '.git', 'ai-delivery', 'writers@1', digestValue(row.path).slice(7) + '.json');
      const descendantObserved = (): boolean => {
        const state = JSON.parse(readFileSync(writerPath, 'utf8')) as { command: { tracked?: { pid: number }[] } };
        return state.command.tracked?.some((member) => member.pid === pids.descendant) === true;
      };
      for (
        let attempt = 0;
        attempt < 300 && (!descendantObserved() || readdirSync(join(cap.directory, 'requests')).length === 0);
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(descendantObserved());
      assert.ok(readdirSync(join(cap.directory, 'requests')).length > 0);
      writeFileSync(join(output, 'exit-parent'), 'exit');
      const parentAlive = (): boolean =>
        spawnSync('ps', ['-p', String(pids.root), '-o', 'stat='], { encoding: 'utf8' }).stdout.trim().length > 0;
      for (let attempt = 0; attempt < 100 && parentAlive(); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(parentAlive(), false);
      const samples = (): number =>
        progress.mock.calls.filter(([line]) => String(line).includes('sampledAggregateRssBytes')).length;
      const afterExit = samples();
      for (let attempt = 0; attempt < 100 && samples() === afterExit; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      const observedAfterExit = samples() > afterExit;
      controller.abort();
      const failure = String(await running);
      assert.match(failure, /cancelled/u);
      assert.doesNotMatch(failure, /cleanup failed|live holder/u);
      assert.ok(observedAfterExit, 'RSS and disk observation continues while the closed command awaits its scan');
      assert.equal(existsSync(cap.directory), false);
      assert.ok(existsSync(join(output, 'fifo')));
      assert.equal(readFileSync(join(output, 'unrelated'), 'utf8'), 'preserved');
      assert.equal(
        spawnSync('ps', ['-p', String(pids.descendant), '-o', 'stat='], { encoding: 'utf8' }).stdout.trim().length,
        0,
      );
      assert.equal(
        progress.mock.calls.some(([line]) => String(line).includes('"state":"completed"')),
        false,
      );
    } finally {
      controller.abort();
      await running;
      progress.mockRestore();
      rmSync(root, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true });
    }
  },
);

test('Node 26 packed public exports preserve standalone and malformed-capability behavior', () => {
  const consumer = packedNode26Consumer();
  execFileSync(
    consumer.executable,
    [
      '-e',
      `
(async () => {
  const assert = require('node:assert/strict');
  assert.equal(process.version, 'v26.2.0');
  const [root, agent, delivery, mcp] = await Promise.all([
    import('@aviaratech/ai-delivery'), import('@aviaratech/ai-delivery/agent'),
    import('@aviaratech/ai-delivery/delivery'), import('@aviaratech/ai-delivery/mcp'),
  ]);
  assert.equal(root.withVerificationFilesystemFixture, agent.withVerificationFilesystemFixture);
  assert.equal(typeof agent.verifyIssue, 'function');
  assert.equal(typeof delivery.loadValidRepositoryDeliveryEvidence, 'function');
  assert.equal(typeof mcp.createAiDeliveryMcpServer, 'function');
  const manifest = JSON.parse(require('node:fs').readFileSync('package.json', 'utf8'));
  assert.deepEqual(Object.keys(manifest.exports).sort(), ['.', './agent', './delivery', './mcp']);
  const prior = process.env.AI_DELIVERY_OUTPUT_OBSERVATION_GATE;
  delete process.env.AI_DELIVERY_OUTPUT_OBSERVATION_GATE;
  assert.equal(await agent.withVerificationFilesystemFixture(() => 'standalone'), 'standalone');
  process.env.AI_DELIVERY_OUTPUT_OBSERVATION_GATE = '{}';
  let executed = false;
  await assert.rejects(agent.withVerificationFilesystemFixture(() => { executed = true; }), /invalid or stale/);
  assert.equal(executed, false);
  if (prior === undefined) delete process.env.AI_DELIVERY_OUTPUT_OBSERVATION_GATE;
  else process.env.AI_DELIVERY_OUTPUT_OBSERVATION_GATE = prior;
})().catch(error => { console.error(error); process.exitCode = 1; });
`,
    ],
    { cwd: consumer.root, stdio: 'pipe' },
  );
});

test('filesystem fixture helper runs standalone and fails closed on malformed capability', async () => {
  const { withVerificationFilesystemFixture } = await import('./agent.js');
  assert.equal(await withVerificationFilesystemFixture(() => 'standalone'), 'standalone');
  const prior = process.env['AI_DELIVERY_OUTPUT_OBSERVATION_GATE'];
  try {
    process.env['AI_DELIVERY_OUTPUT_OBSERVATION_GATE'] = '{}';
    let executed = false;
    await assert.rejects(
      withVerificationFilesystemFixture(() => {
        executed = true;
      }),
      /invalid or stale/u,
    );
    assert.equal(executed, false);
  } finally {
    if (prior === undefined) delete process.env['AI_DELIVERY_OUTPUT_OBSERVATION_GATE'];
    else process.env['AI_DELIVERY_OUTPUT_OBSERVATION_GATE'] = prior;
  }
});

test('nested runtime setup inherits the outer gate for its baseline and child command', async () => {
  const output = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-nested-fixture-')));
  const inner = await fixture();
  const worker = filesystemFixtureScript(output, 'pass');
  const { root } = await fixture({
    firstStageScript: `
(async () => {
  const fs = require('node:fs'), cp = require('node:child_process'), assert = require('node:assert/strict');
  const { withRuntimeSetupWriter } = await import(${JSON.stringify(new URL('./verification.js', import.meta.url).href)});
  const capability = process.env.AI_DELIVERY_OUTPUT_OBSERVATION_GATE;
  const child = cp.spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], { stdio: ['ignore', 'inherit', 'inherit'] });
  const closed = new Promise((resolve, reject) => child.once('exit', code => code === 0 ? resolve() : reject(new Error('fixture child exit ' + code))));
  while (!fs.existsSync(${JSON.stringify(join(output, 'capability'))})) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fs.readFileSync(${JSON.stringify(join(output, 'capability'))}, 'utf8'), capability);
  await withRuntimeSetupWriter(${JSON.stringify(inner.root)}, async runner => {
    await runner.run([process.execPath, '-e', 'require("node:assert/strict").equal(process.env.AI_DELIVERY_OUTPUT_OBSERVATION_GATE, ' + JSON.stringify(capability) + ')'], { maxAggregateRssBytes: 1000000000, minFreeDiskBytes: 1, maxNewOutputBytes: 2048, outputRoots: [${JSON.stringify(output)}] });
  });
  await closed;
})().catch(error => { console.error(error.message); process.exitCode = 1; });`,
  });
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    await verifyIssue({
      issueNumber: 17,
      repoRoot: row.path,
      resourceBounds: {
        maxAggregateRssBytes: 1_000_000_000,
        minFreeDiskBytes: 1,
        maxNewOutputBytes: 2048,
        outputRoots: [output],
      },
    });
    assert.deepEqual(readFileSync(join(output, 'events'), 'utf8').trim().split('\n'), [
      'created',
      'scan-queued',
      'reader-rejected',
      'cleaned',
      'released',
    ]);
    assert.equal(existsSync(join(inner.root, '.git', 'ai-delivery', 'output-observation')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(inner.root, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

test('interrupted fixture owner recovers its gate, preserves completed work and rejects a leaked FIFO before resume', async () => {
  const output = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-fixture-recovery-')));
  const marker = join(output, 'capability');
  const { root, counter, secondCounter, failSecond } = await fixture({ twoStages: true });
  let child: ReturnType<typeof spawn> | undefined;
  let childOutput = '';
  try {
    const row = await prepareIssueWorktree({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    const bounds = {
      maxAggregateRssBytes: 1_000_000_000,
      minFreeDiskBytes: 1,
      maxNewOutputBytes: 2048,
      outputRoots: [output],
    };
    writeFileSync(failSecond, 'fail once');
    await assert.rejects(verifyIssue({ issueNumber: 17, repoRoot: row.path, resourceBounds: bounds }), /exit 7/u);
    assert.equal(readFileSync(counter, 'utf8'), '1');
    child = spawn(
      process.execPath,
      [
        '-e',
        `(async () => {
      const { withRuntimeSetupWriter } = await import(${JSON.stringify(new URL('./verification.js', import.meta.url).href)});
      await withRuntimeSetupWriter(${JSON.stringify(row.path)}, runner => runner.run([process.execPath, '-e', ${JSON.stringify(filesystemFixtureScript(output, 'cancel'))}], ${JSON.stringify(bounds)}));
    })().catch(error => { console.error(error.message); process.exitCode = 1; });`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const capture = (chunk: Buffer): void => {
      childOutput += chunk.toString();
      if (childOutput.length > 1024 * 1024) child!.kill('SIGKILL');
    };
    child.stdout!.on('data', capture);
    child.stderr!.on('data', capture);
    const closed = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    for (let attempt = 0; attempt < 500 && !existsSync(marker); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(existsSync(marker), childOutput);
    const priorGate = JSON.parse(readFileSync(marker, 'utf8')) as { directory: string };
    child.kill('SIGKILL');
    await closed;
    assert.equal(child.signalCode, 'SIGKILL');
    // Exercise the existing writer's stale-file recovery after the exact parent has exited.
    const writerPath = join(root, '.git', 'ai-delivery', 'writers@1', digestValue(row.path).slice(7) + '.json');
    const stale = new Date(Date.now() - 20_000);
    utimesSync(writerPath + '.lock', stale, stale);
    await assert.rejects(
      verifyIssue({ issueNumber: 17, repoRoot: row.path, resourceBounds: bounds }),
      /unsupported file/u,
    );
    assert.equal(existsSync(priorGate.directory), false);
    assert.ok(existsSync(join(output, 'fifo')));
    assert.equal(readFileSync(counter, 'utf8'), '1');
    unlinkSync(join(output, 'fifo'));
    unlinkSync(failSecond);
    const resumed = await verifyIssue({ issueNumber: 17, repoRoot: row.path, resourceBounds: bounds });
    assert.equal(resumed.stageReceipts.length, 2);
    assert.equal(readFileSync(counter, 'utf8'), '1');
    assert.equal(readFileSync(secondCounter, 'utf8'), '2');
    assert.ok(resumed.stageReceipts.every((receipt) => receipt.commands.every((command) => command.exitCode === 0)));
    const cached = await verifyIssue({ issueNumber: 17, repoRoot: row.path, resourceBounds: bounds });
    assert.deepEqual(
      cached.stageReceipts.map((receipt) => receipt.receiptId),
      resumed.stageReceipts.map((receipt) => receipt.receiptId),
    );
    await verifyIssue({ issueNumber: 17, repoRoot: row.path, resourceBounds: { ...bounds, maxNewOutputBytes: 4096 } });
    assert.equal(readFileSync(counter, 'utf8'), '2');
  } finally {
    child?.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});
