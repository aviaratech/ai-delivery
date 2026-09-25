import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { AI_DELIVERY_MCP_TOOLS } from './mcp/tools.js';
import { createAiDeliveryMcpServer } from './mcp/index.js';
import { loadDeliveryConfig } from './config/deliveryConfig.js';
import { digestValue } from './delivery/index.js';
import { executeTool, resumedIssueUpdate, startTrackedIssue } from './dispatch.js';
import { gitCommonDir } from './git.js';
import {
  createIssue,
  developIssue,
  listIssueSubissues,
  readyCheck,
  resumeCreatedIssue,
  updateIssue,
  type DeliveryContext,
} from './issue.js';
import { checkoutPr, finishIssue, listPrs, mergePr, prChecks, publishPr, submitFormalReview } from './pr.js';
import { updateIssueWorktreeDelivery } from './services/worktreeRegistry.js';
import { assertDeliveryRuntimeAdmitted } from './services/deliveryAdmission.js';
import { getDeliveryRecords } from './services/deliveryRecordService.js';
import { createIssuePhaseEvidence, verifyIssue } from './verification.js';
import {
  cleanupNonIssueWorktree,
  prepareIssueWorktree,
  preparePrWorktree,
  prepareStandaloneWorktree,
} from './worktree.js';

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

function fixture(options: { twoStages?: boolean } = {}): {
  root: string;
  counter: string;
  secondCounter: string;
  failSecond: string;
  runtimeEntryPath: string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-lifecycle-')));
  const counter = join(root, '.git', 'stage-count.txt');
  const secondCounter = join(root, '.git', 'second-stage-count.txt');
  const failSecond = join(root, '.git', 'fail-second-stage');
  try {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Synthetic Delivery');
    git(root, 'config', 'user.email', 'delivery@example.test');
    git(root, 'init', '--bare', '-q', join(root, '.git', 'remote.git'));
    git(root, 'remote', 'add', 'origin', join(root, '.git', 'remote.git'));
    writeFileSync(join(root, '.gitignore'), '.issue-cli/\n.worktrees/\n');
    writeFileSync(join(root, 'artifact.txt'), 'synthetic proof\n');
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
        author: {
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
      schemaVersion: 'ai-delivery.config@1',
    };
    writeFileSync(join(root, 'ai-delivery.config.json'), `${JSON.stringify(config)}\n`);
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
export default {
  schemaVersion: 'RepositoryDeliveryPolicy@1',
  classifyExactRange(input) {
    const content = { artifacts: [{ digest: bytes(readFileSync(new URL('./artifact.txt', import.meta.url))),
      path: 'artifact.txt', producer: 'synthetic' }],
      base: { sha: input.baseSha, tree: input.baseTree }, configDigest: input.configDigest,
      head: { sha: input.headSha, tree: input.headTree }, opaquePayload: 'synthetic proof',
      policyDigest, producer: 'synthetic', repository: input.repository,
      schemaVersion: 'ai-delivery.policy-evidence@1' };
    return { policyDigest, policyEvidence: { ...content, evidenceId: digest(content) },
      requiredStages: [{ id: 'check', dependsOn: [], semanticInputKeys: ['source'],
        resourceClass: 'source_only', commands: [{ label: 'count', argv: [process.execPath, '-e',
          ${JSON.stringify(`const fs=require('fs');const p=${JSON.stringify(counter)};fs.writeFileSync(p,String(Number(fs.existsSync(p)?fs.readFileSync(p,'utf8'):0)+1));`)}] }] }${
            options.twoStages
              ? `, { id: 'second', dependsOn: ['check'], semanticInputKeys: ['source'],
        resourceClass: 'source_only', commands: [{ label: 'retry', argv: [process.execPath, '-e',
          ${JSON.stringify(`const fs=require('fs');const p=${JSON.stringify(secondCounter)};fs.writeFileSync(p,String(Number(fs.existsSync(p)?fs.readFileSync(p,'utf8'):0)+1));if(fs.existsSync(${JSON.stringify(failSecond)}))process.exit(7);`)}] }] }`
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
    git(root, 'push', '-q', 'origin', 'main');
    git(root, 'fetch', '-q', 'origin', 'main');
    const runtimeRoot = join(root, '.git', 'synthetic-runtime');
    const runtimeEntryPath = join(runtimeRoot, 'package', 'dist', 'cli.js');
    const packagePath = join(runtimeRoot, 'package', 'package.json');
    const mcpLauncherPath = join(runtimeRoot, 'plugin', 'dist', 'mcp-launcher.js');
    const pluginManifestPath = join(runtimeRoot, 'plugin', '.claude-plugin', 'plugin.json');
    for (const path of [runtimeEntryPath, packagePath, mcpLauncherPath, pluginManifestPath]) {
      mkdirSync(dirname(path), { recursive: true });
    }
    writeFileSync(runtimeEntryPath, 'synthetic CLI bytes\n');
    writeFileSync(packagePath, JSON.stringify({ name: '@aviaratech/ai-delivery', version: '0.1.0' }));
    writeFileSync(mcpLauncherPath, 'synthetic MCP launcher bytes\n');
    writeFileSync(
      pluginManifestPath,
      JSON.stringify({ name: 'ai-delivery', packageVersion: '0.1.0', deliveryCapabilityVersion: 1 }),
    );
    const content = {
      capability: { cli: 1, mcp: 1 },
      cliPath: runtimeEntryPath,
      cliSha256: sha256(runtimeEntryPath),
      configDigest: loadDeliveryConfig(root).configDigest,
      mcpLauncherPath,
      mcpLauncherSha256: sha256(mcpLauncherPath),
      packageVersion: '0.1.0',
      packageDistSha256: digestValue([{ path: 'cli.js', sha256: sha256(runtimeEntryPath) }]),
      packageManifestSha256: sha256(packagePath),
      pluginManifestPath,
      pluginManifestSha256: sha256(pluginManifestPath),
      repository: 'example/widget',
      schemaVersion: 'ai-delivery.runtime-admission@1',
      sourceArchiveSha256: digestValue('synthetic archive'),
      sourceCommit: git(root, 'rev-parse', 'HEAD'),
    };
    const admissionPath = join(root, '.git', 'ai-delivery', 'runtime-admission.json');
    mkdirSync(dirname(admissionPath), { recursive: true });
    writeFileSync(admissionPath, JSON.stringify({ ...content, admissionId: digestValue(content) }), { mode: 0o600 });
    return { root, counter, secondCounter, failSecond, runtimeEntryPath };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

test('installed CLI and MCP admission fails before a worktree mutation on source or capability drift', async () => {
  const { root, runtimeEntryPath } = fixture();
  try {
    const input = { repoRoot: root, runtimeEntryPath };
    const path = join(root, '.git', 'ai-delivery', 'runtime-admission.json');
    const original = readFileSync(path, 'utf8');
    assert.equal(assertDeliveryRuntimeAdmitted(input).capability.mcp, 1);
    const changedModule = join(dirname(runtimeEntryPath), 'mutated.js');
    writeFileSync(changedModule, 'unadmitted module bytes\n');
    assert.throws(() => assertDeliveryRuntimeAdmitted(input), /source, capability or repository admission/u);
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
    assert.throws(() => assertDeliveryRuntimeAdmitted(input), /source, capability or repository admission/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an old active issue remains pinned while a new row uses the same canonical registry', async () => {
  const { root } = fixture();
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
    let issueWrites = 0;
    const relationshipContext = {
      root,
      repo: { owner: 'example', repo: 'widget' },
      config: loadDeliveryConfig(root).config,
      clients: {
        rest: {
          issues: {
            get: async () => ({ data: { id: 17, number: 17, node_id: 'PARENT-17', state: 'open' } }),
            create: async () => {
              issueWrites += 1;
              return { data: {} };
            },
            update: async () => {
              issueWrites += 1;
              return { data: {} };
            },
          },
        },
        graphql: async () => ({
          repository: {
            issue: {
              parent: { id: 'PARENT-17', number: 17 },
              blockedBy: { nodes: [], pageInfo: { endCursor: null, hasNextPage: false } },
            },
          },
        }),
      },
    } as unknown as DeliveryContext;
    await assert.rejects(
      createIssue(relationshipContext, { title: 'Synthetic child', parentIssueNumber: 17 }),
      /ownership witness/u,
    );
    await assert.rejects(
      updateIssue(relationshipContext, { issueNumber: 19, parentIssueNumber: null }),
      /ownership witness/u,
    );
    assert.equal(issueWrites, 0);
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

test('synthetic cutover restores exact pre-write state and resumes an incomplete verification stage', async () => {
  const { root, counter, secondCounter, failSecond } = fixture({ twoStages: true });
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
    assert.equal(assertDeliveryRuntimeAdmitted({ repoRoot: root, runtimeEntryPath: currentCli }).capability.cli, 1);

    cpSync(oldRelease, newRelease, { recursive: true });
    writeFileSync(join(newRelease, 'package', 'dist', 'cli.js'), 'unadmitted CLI bytes\n');
    unlinkSync(current);
    symlinkSync(newRelease, current);
    await assert.rejects(
      executeTool(
        'issue_worktree_create',
        { branch: 'scratch/cutover', name: 'scratch-cutover' },
        { repoRoot: root, runtimeEntryPath: currentCli },
      ),
      /source, capability or repository admission/u,
    );
    assert.equal(existsSync(join(root, '.worktrees', 'scratch-cutover')), false);
    assert.equal(directoryHash(registryPath), registryBefore);
    assert.equal(directoryHash(evidencePath), evidenceBefore);
    unlinkSync(current);
    symlinkSync(pointerBefore, current);
    assert.equal(readlinkSync(current), pointerBefore);
    assertDeliveryRuntimeAdmitted({ repoRoot: root, runtimeEntryPath: currentCli });

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

test('issue worktree verification resumes a completed stage and rejects changed inputs', async () => {
  const { root, counter, runtimeEntryPath } = fixture();
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

test('scratch start derives safe names and reports the requested worktree', async () => {
  const { root, runtimeEntryPath } = fixture();
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

test('MCP exposes one implementation surface for native lifecycle commands', () => {
  assert.deepEqual(
    AI_DELIVERY_MCP_TOOLS.map((tool) => tool.name),
    [
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
    ],
  );
  const validInputs = {
    issue_create: { title: 'Synthetic tracking parent' },
    issue_ready_check: { issueNumber: 17 },
    issue_develop: { issueNumber: 17 },
    issue_verify: { issueNumber: 17 },
    issue_pr_create: { issueNumber: 17, draft: true },
    issue_pr_review: { issueNumber: 17, prNumber: 23, artifact: '{}' },
    issue_pr_merge: { issueNumber: 17, prNumber: 23, strategy: 'merge' },
    issue_finish: { issueNumber: 17, prNumber: 23, strategy: 'merge' },
  };
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

test('synthetic issue traverses native intake, readiness, receipt-bound App review, exact merge and finish', async () => {
  const { root } = fixture();
  const remote = join(root, '.git', 'remote.git');
  const config = loadDeliveryConfig(root).config;
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
  let checksPassed = true;
  let prDraft = true;
  let prState = 'open';
  let mergedAt = '';
  let headSha = '';
  let mergeSha = '';
  let stalePrReadbacks = 0;
  let review: Record<string, unknown> | null = null;
  const calls: string[] = [];
  const createPayloads: Record<string, unknown>[] = [];
  const statuses = { Queued: 'todo', Active: 'active', Waiting: 'blocked', Shipped: 'done' };
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
    user: { login: 'synthetic-author' },
    head: { sha: headSha, ref: 'issue/17' },
    base: { sha: baseSha, ref: 'main' },
  });
  const graphql = async (query: string, variables: Record<string, unknown> = {}): Promise<unknown> => {
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
      projectStatus = statusName(String(variables.optionId)) ?? null;
      return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'ITEM-17' } } };
    }
    if (query.includes('ProjectDeliveryItemReadback'))
      return {
        node: {
          id: 'ITEM-17',
          isArchived: false,
          project: { id: 'PROJECT-1', number: 1 },
          content: { id: issue.node_id },
          fieldValueByName: { name: projectStatus, optionId: statuses[projectStatus as keyof typeof statuses] },
        },
      };
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
        git(root, 'push', '-q', 'origin', `${mergeSha}:refs/heads/merge-object`);
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
    repos: { getCombinedStatusForRef: async () => ({ data: { statuses: [], state: 'success' } }) },
  };
  let authenticatedAuthor = 'synthetic-author[bot]';
  const context = {
    root,
    repo: { owner: 'example', repo: 'widget' },
    config,
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
  try {
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
    writeFileSync(join(row.path, 'change.txt'), 'feature\n');
    git(row.path, 'add', 'change.txt');
    git(row.path, 'commit', '-qm', 'synthetic change');
    headSha = git(row.path, 'rev-parse', 'HEAD');
    const run = await verifyIssue({ issueNumber, repoRoot: row.path });
    await assert.rejects(publishPr(context, { issueNumber, body: 'Closes #17' }), /Delivery Impact/);
    await assert.rejects(
      publishPr(context, { issueNumber }),
      /Git push requires the selected author GitHub App installation token/,
    );
    // The public push requires a real author App installation token. Bind a synthetic
    // publication at that external boundary so the remaining public phases run offline.
    git(row.path, 'push', '-q', 'origin', `${headSha}:refs/heads/issue/17`);
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
    assert.equal((await listPrs(context)).pullRequests[0]?.number, prNumber);
    assert.equal((await prChecks(context, prNumber)).combinedStatus, 'success');
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
    await publishPr(context, { issueNumber, draft: false });
    assert.equal(prDraft, false);
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
    writeFileSync(resultPath, JSON.stringify({ ...wrongResult, resultId: digestValue(wrongResult) }), { mode: 0o600 });
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
    const blockedRecordPath = join(gitCommonDir(root), 'ai-delivery', 'deliveries.json');
    mkdirSync(blockedRecordPath);
    await assert.rejects(
      finishIssue(context, { issueNumber, prNumber, strategy: 'merge' }),
      /Delivery record store is invalid/u,
    );
    assert.equal(existsSync(row.path), false);
    rmSync(blockedRecordPath, { recursive: true });
    const finished = await finishIssue(context, { issueNumber, prNumber, strategy: 'merge' });
    assert.equal(finished.issueClosed, true);
    assert.equal(finished.cleaned, true);
    assert.equal(projectStatus, 'Shipped');
    assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), finished.mergeSha);
    assert.equal(existsSync(row.path), false);
    assert.equal(getDeliveryRecords(root).length, 1);
    assert.equal(getDeliveryRecords(root)[0]?.points, 4);
    assert.deepEqual(calls, ['issue:create', 'review:create', 'git:createCommit']);
    assert.deepEqual(await finishIssue(context, { issueNumber, prNumber, strategy: 'merge' }), finished);
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
    rmSync(root, { recursive: true, force: true });
  }
});
