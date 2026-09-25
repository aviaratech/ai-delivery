import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { loadDeliveryConfig } from './config/deliveryConfig.js';
import {
  classifyRepositoryExactRange,
  createRepositoryDeliveryEvidence,
  createRepositoryStageAggregate,
  createRepositoryStageInput,
  createRepositoryStageReceipt,
  digestValue,
  loadRepositoryStageCheckpoint,
  loadSelectedRepositoryPolicy,
  RepositoryClassificationReceiptSchema,
  RepositoryStageAggregateSchema,
  RepositoryStageReceiptSchema,
  writeRepositoryCommandOutput,
  writeRepositoryDeliveryEvidence,
  writeRepositoryStageAggregate,
  writeRepositoryStageCheckpoint,
  type RepositoryApprovalBinding,
  type RepositoryClassificationReceipt,
  type RepositoryDeliveryEvidence,
  type RepositoryMergeReadback,
  type RepositoryStageAggregate,
  type RepositoryStageReceipt,
} from './delivery/index.js';
import { DeliveryError } from './errors.js';
import { assertClean, changedPaths, coordinate, defaultBaseRef, git, gitCommonDir, gitRoot } from './git.js';
import { getIssueWorktreeStrict } from './services/worktreeRegistry.js';
import { writePrivateJsonFileAtomically } from './utils/atomicJson.js';

export interface VerificationRun {
  aggregate: RepositoryStageAggregate;
  classification: RepositoryClassificationReceipt;
  completedAt: string;
  manifestId: string;
  schemaVersion: 'ai-delivery.run@1';
  stageReceipts: RepositoryStageReceipt[];
}

function primaryRoot(worktreeRoot: string): string {
  const common = gitCommonDir(worktreeRoot);
  if (basename(common) !== '.git') throw new DeliveryError('Expected a conventional non-bare Git repository.');
  return dirname(common);
}

function assertRegisteredIssue(worktreeRoot: string, issueNumber: number, allowMerged = false): void {
  const row = getIssueWorktreeStrict(issueNumber, primaryRoot(worktreeRoot));
  if (
    row.path !== worktreeRoot ||
    row.branch !== `issue/${issueNumber}` ||
    (row.status !== 'active' && row.status !== 'pr-published' && !(allowMerged && row.status === 'merged'))
  ) {
    throw new DeliveryError('Verification requires the exact registered issue worktree.');
  }
  assertClean(worktreeRoot);
}

function manifestPath(common: string, headSha: string): string {
  return join(common, 'ai-delivery', 'runs', `${headSha}.json`);
}

function parseRun(value: unknown): VerificationRun {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new DeliveryError('Invalid run manifest.');
  const input = value as Record<string, unknown>;
  const classification = RepositoryClassificationReceiptSchema.parse(input.classification);
  const aggregate = RepositoryStageAggregateSchema.parse(input.aggregate);
  const stageReceipts = RepositoryStageReceiptSchema.array().parse(input.stageReceipts);
  const content = {
    aggregate,
    classification,
    completedAt: input.completedAt,
    schemaVersion: input.schemaVersion,
    stageReceipts,
  };
  if (
    input.schemaVersion !== 'ai-delivery.run@1' ||
    typeof input.completedAt !== 'string' ||
    input.manifestId !== digestValue(content)
  )
    throw new DeliveryError('Run manifest identity is invalid.');
  return { ...content, completedAt: input.completedAt, manifestId: input.manifestId } as VerificationRun;
}

function loadRun(common: string, headSha: string): VerificationRun {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath(common, headSha), 'utf8')) as unknown;
  } catch {
    throw new DeliveryError('Exact-head verification run is missing or corrupt.');
  }
  return parseRun(raw);
}

function stageEnvironmentDigest(): string {
  return digestValue({
    arch: process.arch,
    node: process.version,
    path: process.env.PATH ?? '',
    platform: process.platform,
  });
}

function runStageCommand(repoRoot: string, argv: readonly string[]): Buffer {
  const [executable, ...args] = argv;
  if (!executable) throw new DeliveryError('Policy selected an empty stage command.');
  const result = spawnSync(executable, args, {
    cwd: repoRoot,
    encoding: 'buffer',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 600_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = Buffer.concat([Buffer.from(result.stdout ?? ''), Buffer.from(result.stderr ?? '')]);
  if (result.error || result.status !== 0 || output.length > 8 * 1024 * 1024) {
    const reason = result.error?.message ?? `exit ${String(result.status)}`;
    throw new DeliveryError(`Selected policy stage command failed (${reason}).`);
  }
  return output;
}

export async function verifyIssue(input: {
  admittedResourceClasses?: readonly string[];
  issueNumber: number;
  repoRoot: string;
}): Promise<VerificationRun> {
  const root = gitRoot(input.repoRoot);
  assertRegisteredIssue(root, input.issueNumber);
  const common = gitCommonDir(root);
  const loaded = loadDeliveryConfig(root);
  const selected = await loadSelectedRepositoryPolicy({
    repoRoot: root,
    policySourcePath: loaded.config.policy.module,
  });
  const base = coordinate(root, defaultBaseRef(root));
  const head = coordinate(root);
  const classification = classifyRepositoryExactRange({
    base,
    changedPaths: changedPaths(root, base.sha, head.sha),
    configDigest: loaded.configDigest,
    head,
    policy: selected.policy,
    policySourcePath: loaded.config.policy.module,
    repoRoot: root,
    repository: loaded.config.repository,
  });
  const receipts: RepositoryStageReceipt[] = [];
  const admitted = new Set(input.admittedResourceClasses ?? ['source_only']);
  const environmentDigest = stageEnvironmentDigest();
  for (const stage of classification.requiredStages) {
    if (!admitted.has(stage.resourceClass)) {
      throw new DeliveryError(`Stage '${stage.id}' requires explicit ${stage.resourceClass} admission.`);
    }
    const stageInput = createRepositoryStageInput({
      classification,
      environmentDigest,
      semanticInputs: stage.semanticInputKeys.map((key) => ({
        digest: digestValue({ key, evidenceId: classification.policyEvidence.evidenceId }),
        key,
      })),
      stageId: stage.id,
      upstream: stage.dependsOn.map((stageId) => {
        const receipt = receipts.find((value) => value.input.stageId === stageId);
        if (!receipt) throw new DeliveryError(`Missing upstream stage '${stageId}'.`);
        return { receiptId: receipt.receiptId, stageId };
      }),
    });
    const cached = loadRepositoryStageCheckpoint({
      classification,
      configDigest: loaded.configDigest,
      gitCommonDir: common,
      policySourcePath: loaded.config.policy.module,
      repoRoot: root,
      stageInput,
    });
    if (cached) {
      receipts.push(cached);
      continue;
    }
    const startedAt = new Date().toISOString();
    const commands = stage.commands.map((command) => ({
      exitCode: 0,
      label: command.label,
      outputDigest: writeRepositoryCommandOutput({ bytes: runStageCommand(root, command.argv), gitCommonDir: common }),
    }));
    const artifacts =
      stage.attestationKey === undefined
        ? []
        : classification.policyEvidence.artifacts
            .filter((artifact) => artifact.path === stage.attestationKey)
            .map((artifact) => ({ digest: artifact.digest, path: artifact.path }));
    if (stage.attestationKey !== undefined && artifacts.length === 0) {
      throw new DeliveryError(`Selected attestation '${stage.attestationKey}' lacks a bound artifact.`);
    }
    const receipt = createRepositoryStageReceipt({
      artifacts,
      classification,
      commands,
      completedAt: new Date().toISOString(),
      stageInput,
      startedAt,
    });
    writeRepositoryStageCheckpoint({ gitCommonDir: common, receipt, repoRoot: root });
    receipts.push(receipt);
  }
  const aggregate = createRepositoryStageAggregate({ classification, receipts });
  writeRepositoryStageAggregate({ gitCommonDir: common, aggregate });
  const content = {
    aggregate,
    classification,
    completedAt: new Date().toISOString(),
    schemaVersion: 'ai-delivery.run@1' as const,
    stageReceipts: receipts,
  };
  const run: VerificationRun = { ...content, manifestId: digestValue(content) };
  writePrivateJsonFileAtomically(manifestPath(common, head.sha), run);
  return run;
}

export async function createIssuePhaseEvidence(input: {
  approval?: RepositoryApprovalBinding;
  issueNumber: number;
  mergeReadback?: RepositoryMergeReadback;
  phase: 'verify' | 'publish' | 'merge';
  repoRoot: string;
}): Promise<RepositoryDeliveryEvidence> {
  const root = gitRoot(input.repoRoot);
  assertRegisteredIssue(root, input.issueNumber);
  const loaded = loadDeliveryConfig(root);
  const selected = await loadSelectedRepositoryPolicy({
    repoRoot: root,
    policySourcePath: loaded.config.policy.module,
  });
  const run = loadRun(gitCommonDir(root), coordinate(root).sha);
  const evidence = createRepositoryDeliveryEvidence({
    aggregate: run.aggregate,
    ...(input.approval === undefined ? {} : { approval: input.approval }),
    approvalRoles: {
      authorIdentity: loaded.config.roles.author.identity,
      reviewerIdentity: loaded.config.roles.reviewer.identity,
    },
    classification: run.classification,
    configDigest: loaded.configDigest,
    currentBase: coordinate(root, run.classification.base.sha),
    currentHead: coordinate(root),
    gitCommonDir: gitCommonDir(root),
    ...(input.mergeReadback === undefined ? {} : { mergeReadback: input.mergeReadback }),
    phase: input.phase,
    policy: selected.policy,
    policySourcePath: loaded.config.policy.module,
    repoRoot: root,
    stageReceipts: run.stageReceipts,
  });
  writeRepositoryDeliveryEvidence({ evidence, gitCommonDir: gitCommonDir(root) });
  return evidence;
}

export function loadVerifiedRun(repoRoot: string, issueNumber: number): VerificationRun {
  const root = gitRoot(repoRoot);
  assertRegisteredIssue(root, issueNumber, true);
  return loadRun(gitCommonDir(root), coordinate(root).sha);
}

/** Recover an exact merged run after worktree removal interrupted terminal recording. */
export function loadRemovedMergedRun(primaryRepoRoot: string, issueNumber: number): VerificationRun {
  const root = gitRoot(primaryRepoRoot);
  const row = getIssueWorktreeStrict(issueNumber, root);
  if (row.status !== 'merged' || row.path !== join(root, '.worktrees', `issue-${issueNumber}`)) {
    throw new DeliveryError('Removed-run recovery requires the exact registered merged issue.');
  }
  const headSha = git(root, 'rev-parse', `refs/heads/${row.branch}`);
  const run = loadRun(gitCommonDir(root), headSha);
  if (run.classification.head.sha !== headSha) {
    throw new DeliveryError('Recovered merged run disagrees with the registered branch.');
  }
  return run;
}
