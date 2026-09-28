import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, statfsSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { loadDeliveryConfig } from './config/deliveryConfig.js';
import {
  classifyRepositoryExactRange,
  createRepositoryDeliveryEvidence,
  createRepositoryStageAggregate,
  createRepositoryStageInput,
  createRepositoryStageReceipt,
  digestBytes,
  digestValue,
  assertRepositoryStageProof,
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
  type RepositoryStageInput,
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
  resources?: VerificationResourceSummary;
  schemaVersion: 'ai-delivery.run@1' | 'ai-delivery.run@2';
  stageReceipts: RepositoryStageReceipt[];
}

export interface VerificationResourceBounds {
  maxAggregateRssBytes: number;
  maxNewOutputBytes?: number;
  minFreeDiskBytes: number;
  outputRoots?: readonly string[];
}

const ResourceSummarySchema = z
  .strictObject({
    bounds: z.strictObject({
      maxAggregateRssBytes: z.number().int().positive().safe(),
      maxNewOutputBytes: z.number().int().positive().safe().optional(),
      minFreeDiskBytes: z.number().int().positive().safe(),
      outputRoots: z.array(z.string().min(1)).min(1).optional(),
    }),
    maxSampledAggregateRssBytes: z.number().int().nonnegative().safe().nullable(),
    maxSampledNewOutputBytes: z.number().int().nonnegative().safe().nullable(),
    minSampledFreeDiskBytes: z.number().int().nonnegative().safe().nullable(),
    observation: z.literal('sampled'),
    outputBaselineId: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .optional(),
    processCoverage: z.literal('observed-processes-only'),
    sampleCount: z.number().int().nonnegative().safe(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.maxSampledAggregateRssBytes !== null &&
        value.maxSampledAggregateRssBytes > value.bounds.maxAggregateRssBytes) ||
      (value.maxSampledNewOutputBytes !== null &&
        value.bounds.maxNewOutputBytes !== undefined &&
        value.maxSampledNewOutputBytes > value.bounds.maxNewOutputBytes) ||
      (value.minSampledFreeDiskBytes !== null && value.minSampledFreeDiskBytes < value.bounds.minFreeDiskBytes) ||
      (value.sampleCount > 0 &&
        (value.maxSampledAggregateRssBytes === null || value.minSampledFreeDiskBytes === null)) ||
      (value.bounds.maxNewOutputBytes !== undefined &&
        value.sampleCount > 0 &&
        value.maxSampledNewOutputBytes === null) ||
      (value.bounds.maxNewOutputBytes !== undefined) !== (value.outputBaselineId !== undefined)
    )
      ctx.addIssue({ code: 'custom', message: 'Resource samples do not satisfy their declared bounds.' });
  });
export type VerificationResourceSummary = z.infer<typeof ResourceSummarySchema>;

const ResourceStageCheckpointSchema = z.strictObject({
  checkpointId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  receipt: RepositoryStageReceiptSchema,
  resources: ResourceSummarySchema,
  schemaVersion: z.literal('ai-delivery.resource-stage@1'),
});

function resourceStagePath(common: string, stageInput: RepositoryStageInput): string {
  return join(common, 'ai-delivery', 'resource-stages@1', `${stageInput.inputId.slice(7)}.json`);
}

function loadResourceStageCheckpoint(
  common: string,
  repoRoot: string,
  stageInput: RepositoryStageInput,
  bounds: VerificationResourceSummary['bounds'],
  baselineId?: string,
): z.infer<typeof ResourceStageCheckpointSchema> | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resourceStagePath(common, stageInput), 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new DeliveryError('Resource stage checkpoint is corrupt.');
  }
  const checkpoint = ResourceStageCheckpointSchema.parse(raw);
  const { checkpointId, ...content } = checkpoint;
  if (
    checkpointId !== digestValue(content) ||
    checkpoint.receipt.input.inputId !== stageInput.inputId ||
    digestValue(checkpoint.resources.bounds) !== digestValue(bounds) ||
    checkpoint.resources.outputBaselineId !== baselineId ||
    checkpoint.resources.sampleCount === 0
  )
    throw new DeliveryError('Resource stage checkpoint is corrupt or belongs to another input.');
  assertRepositoryStageProof({ gitCommonDir: common, receipt: checkpoint.receipt, repoRoot });
  return checkpoint;
}

function writeResourceStageCheckpoint(
  common: string,
  receipt: RepositoryStageReceipt,
  resources: VerificationResourceSummary,
): void {
  if (resources.sampleCount === 0) throw new DeliveryError('Completed bounded stage lacks resource samples.');
  const content = {
    receipt,
    resources: ResourceSummarySchema.parse(resources),
    schemaVersion: 'ai-delivery.resource-stage@1' as const,
  };
  writePrivateJsonFileAtomically(resourceStagePath(common, receipt.input), {
    ...content,
    checkpointId: digestValue(content),
  });
}

function mergeResourceSummary(target: VerificationResourceSummary, source: VerificationResourceSummary): void {
  target.sampleCount += source.sampleCount;
  if (!Number.isSafeInteger(target.sampleCount)) throw new DeliveryError('Resource sample count overflowed.');
  if (source.maxSampledAggregateRssBytes !== null) {
    target.maxSampledAggregateRssBytes = Math.max(
      target.maxSampledAggregateRssBytes ?? 0,
      source.maxSampledAggregateRssBytes,
    );
  }
  if (source.maxSampledNewOutputBytes !== null) {
    target.maxSampledNewOutputBytes = Math.max(target.maxSampledNewOutputBytes ?? 0, source.maxSampledNewOutputBytes);
  }
  if (source.minSampledFreeDiskBytes !== null) {
    target.minSampledFreeDiskBytes = Math.min(
      target.minSampledFreeDiskBytes ?? source.minSampledFreeDiskBytes,
      source.minSampledFreeDiskBytes,
    );
  }
}

interface ResourceSample {
  aggregateRssBytes: number;
  freeDiskBytes: number;
  newOutputBytes?: number;
  ownedProcessCount: number;
}

function assertResourceBounds(bounds: VerificationResourceBounds): void {
  const limits: [string, number][] = [
    ['maxAggregateRssBytes', bounds.maxAggregateRssBytes],
    ['minFreeDiskBytes', bounds.minFreeDiskBytes],
  ];
  if (bounds.maxNewOutputBytes !== undefined) limits.push(['maxNewOutputBytes', bounds.maxNewOutputBytes]);
  for (const [name, value] of limits) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new DeliveryError(`Invalid ${name} resource bound.`);
  }
  if ((bounds.maxNewOutputBytes === undefined) !== (bounds.outputRoots === undefined)) {
    throw new DeliveryError('Filesystem output limit and output roots must be supplied together.');
  }
  if (
    bounds.outputRoots !== undefined &&
    (bounds.outputRoots.length === 0 || bounds.outputRoots.some((path) => !path))
  ) {
    throw new DeliveryError('Filesystem output roots must be nonempty paths.');
  }
  if (process.platform === 'win32') throw new DeliveryError('Resource observation requires POSIX process support.');
}

interface OutputBaseline {
  baselineId: string;
  files: Map<string, number>;
  roots: string[];
}

const OutputBaselineCheckpointSchema = z.strictObject({
  baselineId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  files: z.array(z.tuple([z.string().min(1), z.number().int().nonnegative().safe()])),
  inputId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  roots: z.array(z.string().min(1)).min(1),
  schemaVersion: z.literal('ai-delivery.output-baseline@1'),
});
const OutputBaselineStateSchema = z.strictObject({
  baselineId: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/u)
    .optional(),
  inputId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  schemaVersion: z.literal('ai-delivery.output-baseline-state@1'),
  stateId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  status: z.enum(['preparing', 'complete']),
});

function scanOutputRoots(roots: readonly string[]): Map<string, number> {
  const files = new Map<string, number>();
  const visit = (path: string): void => {
    let metadata;
    try {
      metadata = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new DeliveryError('Filesystem output observation encountered a symbolic link.');
    }
    if (metadata.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name));
      return;
    }
    if (!metadata.isFile() || !Number.isSafeInteger(metadata.size)) {
      throw new DeliveryError('Filesystem output observation encountered an unsupported file.');
    }
    files.set(path, metadata.size);
    if (files.size > 1_000_000) throw new DeliveryError('Filesystem output observation exceeded its file limit.');
  };
  for (const root of roots) visit(root);
  return files;
}

function outputBaseline(
  repoRoot: string,
  common: string,
  classificationReceiptId: string,
  bounds: VerificationResourceBounds,
): OutputBaseline | undefined {
  if (bounds.outputRoots === undefined) return undefined;
  const roots = bounds.outputRoots.map((path) => resolve(repoRoot, path)).sort();
  for (let i = 1; i < roots.length; i++) {
    if (roots[i] === roots[i - 1] || roots[i]!.startsWith(`${roots[i - 1]}${sep}`)) {
      throw new DeliveryError('Filesystem output roots must not overlap.');
    }
  }
  const inputId = digestValue({
    bounds: { ...bounds, outputRoots: roots },
    classificationReceiptId,
    resourceRunner: digestBytes(readFileSync(fileURLToPath(import.meta.url))),
  });
  const path = join(common, 'ai-delivery', 'output-baselines@1', `${inputId.slice(7)}.json`);
  const statePath = join(common, 'ai-delivery', 'output-baselines@1', `${inputId.slice(7)}.state.json`);
  const writeState = (status: 'preparing' | 'complete', baselineId?: string): void => {
    const content = {
      inputId,
      schemaVersion: 'ai-delivery.output-baseline-state@1' as const,
      status,
      ...(baselineId === undefined ? {} : { baselineId }),
    };
    writePrivateJsonFileAtomically(statePath, { ...content, stateId: digestValue(content) });
  };
  let state: z.infer<typeof OutputBaselineStateSchema> | undefined;
  try {
    state = OutputBaselineStateSchema.parse(JSON.parse(readFileSync(statePath, 'utf8')) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new DeliveryError('Filesystem output baseline state is corrupt.');
    }
  }
  if (state === undefined) {
    if (existsSync(path)) throw new DeliveryError('Filesystem output baseline state is missing.');
    writeState('preparing');
  } else {
    const { stateId, ...content } = state;
    if (
      stateId !== digestValue(content) ||
      state.inputId !== inputId ||
      (state.status === 'complete') !== (state.baselineId !== undefined)
    )
      throw new DeliveryError('Filesystem output baseline state is corrupt.');
  }
  let checkpoint: z.infer<typeof OutputBaselineCheckpointSchema>;
  if (state?.status !== 'complete') {
    const content = {
      files: [...scanOutputRoots(roots)].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
      inputId,
      roots,
      schemaVersion: 'ai-delivery.output-baseline@1' as const,
    };
    checkpoint = { ...content, baselineId: digestValue(content) };
    writePrivateJsonFileAtomically(path, checkpoint);
    writeState('complete', checkpoint.baselineId);
  } else {
    try {
      checkpoint = OutputBaselineCheckpointSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
    } catch {
      throw new DeliveryError('Filesystem output baseline checkpoint is missing or corrupt.');
    }
  }
  const { baselineId, ...content } = checkpoint;
  if (
    baselineId !== digestValue(content) ||
    (state?.status === 'complete' && state.baselineId !== baselineId) ||
    checkpoint.inputId !== inputId ||
    digestValue(checkpoint.roots) !== digestValue(roots) ||
    checkpoint.files.some(
      ([file], index) =>
        (index > 0 && file <= checkpoint.files[index - 1]![0]) ||
        !roots.some((root) => file === root || file.startsWith(`${root}${sep}`)),
    )
  )
    throw new DeliveryError('Filesystem output baseline checkpoint is corrupt or belongs to another input.');
  return { baselineId, roots, files: new Map(checkpoint.files) };
}

function positiveNewOutputBytes(baseline: OutputBaseline): number {
  let bytes = 0;
  for (const [path, size] of scanOutputRoots(baseline.roots)) {
    bytes += Math.max(0, size - (baseline.files.get(path) ?? 0));
    if (!Number.isSafeInteger(bytes)) throw new DeliveryError('Filesystem output observation overflowed.');
  }
  return bytes;
}

function availableDiskBytes(path: string): bigint {
  let existing = path;
  for (;;) {
    try {
      const disk = statfsSync(existing, { bigint: true });
      return disk.bavail * disk.bsize;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(existing) === existing) throw error;
      existing = dirname(existing);
    }
  }
}

function freeDiskBytes(repoRoot: string, baseline?: OutputBaseline): number {
  const roots = baseline === undefined ? [repoRoot] : [repoRoot, ...baseline.roots];
  const minimum = roots.reduce((value, path) => {
    const available = availableDiskBytes(path);
    return available < value ? available : value;
  }, BigInt(Number.MAX_SAFE_INTEGER));
  if (minimum > BigInt(Number.MAX_SAFE_INTEGER)) throw new DeliveryError('Free disk observation overflowed.');
  return Number(minimum);
}

function assertDiskHeadroom(repoRoot: string, bounds: VerificationResourceBounds, baseline?: OutputBaseline): void {
  if (freeDiskBytes(repoRoot, baseline) < bounds.minFreeDiskBytes) {
    throw new DeliveryError(`Free disk fell below limit ${bounds.minFreeDiskBytes}.`);
  }
}

interface ObservedProcess {
  identity: string;
  pgid: number;
  pid: number;
  ppid: number;
  rssBytes: number;
  status: string;
}

interface OwnedProcessState {
  rootIdentity?: string;
  rootPid: number;
  sampled: boolean;
  tracked: Map<number, ObservedProcess>;
}

function processSnapshot(): Map<number, ObservedProcess> {
  const psPath = existsSync('/usr/bin/ps') ? '/usr/bin/ps' : '/bin/ps';
  const result = spawnSync(psPath, ['-A', '-o', 'pid=,ppid=,pgid=,rss=,stat=,lstart='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 1_000,
  });
  if (result.status !== 0 || result.error || result.signal || !result.stdout.endsWith('\n')) {
    throw new DeliveryError('Owned process resource observation failed.');
  }
  const snapshot = new Map<number, ObservedProcess>();
  for (const line of result.stdout.trim().split('\n')) {
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u.exec(line.trim());
    if (!match) throw new DeliveryError('Owned process resource observation is ambiguous.');
    const observed = {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      rssBytes: Number(match[4]) * 1_024,
      status: match[5]!,
      identity: match[6]!,
    };
    if (
      !Number.isSafeInteger(observed.pid) ||
      observed.pid <= 0 ||
      !Number.isSafeInteger(observed.ppid) ||
      !Number.isSafeInteger(observed.pgid) ||
      !Number.isSafeInteger(observed.rssBytes) ||
      snapshot.has(observed.pid)
    )
      throw new DeliveryError('Owned process resource observation is ambiguous.');
    snapshot.set(observed.pid, observed);
  }
  return snapshot;
}

function observeOwnedProcesses(state: OwnedProcessState, snapshot: Map<number, ObservedProcess>): ObservedProcess[] {
  const root = snapshot.get(state.rootPid);
  if (state.rootIdentity === undefined) {
    if (root === undefined || root.status.startsWith('Z') || root.pgid !== state.rootPid) {
      throw new DeliveryError('Owned process identity could not be established before the command exited.');
    }
    state.rootIdentity = root.identity;
    state.tracked.set(root.pid, root);
  } else if (root !== undefined && root.identity !== state.rootIdentity) {
    throw new DeliveryError('Owned process identity changed during verification.');
  }
  const selected = new Map<number, ObservedProcess>();
  for (const [pid, previous] of state.tracked) {
    const current = snapshot.get(pid);
    if (current === undefined || current.status.startsWith('Z')) state.tracked.delete(pid);
    else if (current.identity !== previous.identity) {
      throw new DeliveryError('Tracked process identity changed during verification.');
    } else selected.set(pid, current);
  }
  for (const member of snapshot.values()) {
    if (!member.status.startsWith('Z') && member.pgid === state.rootPid) selected.set(member.pid, member);
  }
  const children = new Map<number, ObservedProcess[]>();
  for (const member of snapshot.values()) {
    const siblings = children.get(member.ppid) ?? [];
    siblings.push(member);
    children.set(member.ppid, siblings);
  }
  const pending = [...selected.values()];
  for (const parent of pending)
    for (const child of children.get(parent.pid) ?? []) {
      if (!child.status.startsWith('Z') && !selected.has(child.pid)) {
        selected.set(child.pid, child);
        pending.push(child);
      }
    }
  for (const member of selected.values()) state.tracked.set(member.pid, member);
  state.sampled = true;
  return [...selected.values()];
}

function sampleOwnedTree(
  state: OwnedProcessState,
  repoRoot: string,
  bounds: VerificationResourceBounds,
  baseline?: OutputBaseline,
): ResourceSample {
  const owned = observeOwnedProcesses(state, processSnapshot());
  const rssBytes = owned.reduce((total, member) => total + member.rssBytes, 0);
  if (!Number.isSafeInteger(rssBytes))
    throw new DeliveryError('Owned aggregate RSS is outside the safe integer range.');
  if (rssBytes > bounds.maxAggregateRssBytes) {
    throw new DeliveryError(`Owned aggregate RSS ${rssBytes} exceeded limit ${bounds.maxAggregateRssBytes}.`);
  }
  const available = freeDiskBytes(repoRoot, baseline);
  if (available < bounds.minFreeDiskBytes)
    throw new DeliveryError(`Free disk fell below limit ${bounds.minFreeDiskBytes}.`);
  const newOutputBytes = baseline === undefined ? undefined : positiveNewOutputBytes(baseline);
  if (newOutputBytes !== undefined && !Number.isSafeInteger(newOutputBytes)) {
    throw new DeliveryError('Filesystem output observation overflowed.');
  }
  if (baseline !== undefined && bounds.maxNewOutputBytes !== undefined) {
    if (newOutputBytes !== undefined && newOutputBytes > bounds.maxNewOutputBytes) {
      throw new DeliveryError(
        `Positive new filesystem output ${newOutputBytes} exceeded limit ${bounds.maxNewOutputBytes}.`,
      );
    }
  }
  return {
    aggregateRssBytes: rssBytes,
    freeDiskBytes: available,
    ...(newOutputBytes === undefined ? {} : { newOutputBytes }),
    ownedProcessCount: owned.length,
  };
}

async function confirmOwnedCleanup(state: OwnedProcessState): Promise<void> {
  if (!state.sampled || state.rootIdentity === undefined) {
    throw new DeliveryError('Owned process cleanup cannot be verified without a root identity.');
  }
  const deadline = Date.now() + 2_000;
  for (;;) {
    const snapshot = processSnapshot();
    const root = snapshot.get(state.rootPid);
    if (root !== undefined && root.identity !== state.rootIdentity) {
      throw new DeliveryError('Owned process group identity changed before cleanup readback.');
    }
    const groupAlive = [...snapshot.values()].some(
      (member) => member.pgid === state.rootPid && !member.status.startsWith('Z'),
    );
    const trackedAlive = [...state.tracked.values()].some((previous) => {
      const current = snapshot.get(previous.pid);
      if (current === undefined || current.status.startsWith('Z')) return false;
      if (current.identity !== previous.identity)
        throw new DeliveryError('Tracked process identity changed before cleanup readback.');
      return true;
    });
    if (!groupAlive && !trackedAlive) return;
    if (Date.now() >= deadline) throw new DeliveryError('Owned process cleanup did not release every sampled process.');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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
  if (input.schemaVersion !== 'ai-delivery.run@1' && input.schemaVersion !== 'ai-delivery.run@2') {
    throw new DeliveryError('Run manifest schema version is unsupported.');
  }
  if (input.schemaVersion === 'ai-delivery.run@1' && input.resources !== undefined) {
    throw new DeliveryError('Historical run manifest has unexpected resource evidence.');
  }
  const resources =
    input.schemaVersion === 'ai-delivery.run@2' ? ResourceSummarySchema.parse(input.resources) : undefined;
  const content = {
    aggregate,
    classification,
    completedAt: input.completedAt,
    ...(resources === undefined ? {} : { resources }),
    schemaVersion: input.schemaVersion,
    stageReceipts,
  };
  if (typeof input.completedAt !== 'string' || input.manifestId !== digestValue(content))
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

function reportVerificationProgress(input: {
  state: 'running' | 'reused' | 'completed' | 'failed';
  stageId: string;
  commandLabel?: string;
  completedStages: number;
  remainingStages: number;
  reusedStages: number;
  elapsedMs: number;
  capturedOutputBytes?: number;
  sampledAggregateRssBytes?: number;
  sampledFreeDiskBytes?: number;
  sampledNewOutputBytes?: number;
  ownedProcessCount?: number;
  reason?: string;
}): void {
  process.stderr.write(`ai-delivery.verify ${JSON.stringify(input)}\n`);
}

function runStageCommand(
  repoRoot: string,
  argv: readonly string[],
  abortSignal?: AbortSignal,
  onRunning?: (capturedOutputBytes: number, resource?: ResourceSample) => void,
  resourceBounds?: VerificationResourceBounds,
  baseline?: OutputBaseline,
  onResourceSample?: (sample: ResourceSample) => void,
): Promise<Buffer> {
  const [executable, ...args] = argv;
  if (!executable) throw new DeliveryError('Policy selected an empty stage command.');
  if (abortSignal?.aborted) throw new DeliveryError('Selected policy stage command cancelled.');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: repoRoot,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const owned: OwnedProcessState | undefined =
      resourceBounds === undefined || child.pid === undefined
        ? undefined
        : { rootPid: child.pid, sampled: false, tracked: new Map() };
    let outputBytes = 0;
    let failure: string | undefined;
    let cleanupFailure: string | undefined;
    let closed = false;
    let settled = false;
    let closeTimer: NodeJS.Timeout | undefined;
    let exitPipeTimer: NodeJS.Timeout | undefined;
    let resourceTimer: NodeJS.Timeout | undefined;
    const clearWatchers = (): void => {
      clearInterval(progressTimer);
      if (resourceTimer !== undefined) clearInterval(resourceTimer);
      if (closeTimer !== undefined) clearTimeout(closeTimer);
      if (exitPipeTimer !== undefined) clearTimeout(exitPipeTimer);
      abortSignal?.removeEventListener('abort', onAbort);
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    };
    const killOwned = (): void => {
      if (child.pid === undefined) return;
      if (process.platform === 'win32') {
        if (!child.kill('SIGKILL') && child.exitCode === null && child.signalCode === null)
          cleanupFailure ??= 'could not signal the owned child';
        return;
      }
      let groupIsOwned = resourceBounds === undefined;
      if (owned?.sampled) {
        try {
          const snapshot = processSnapshot();
          const root = snapshot.get(owned.rootPid);
          if (root !== undefined && root.identity !== owned.rootIdentity) {
            cleanupFailure ??= 'owned process group identity changed before cleanup';
          } else {
            groupIsOwned = [...snapshot.values()].some(
              (member) => member.pgid === owned.rootPid && !member.status.startsWith('Z'),
            );
          }
          for (const previous of [...owned.tracked.values()].reverse()) {
            const current = snapshot.get(previous.pid);
            if (current === undefined || current.status.startsWith('Z')) continue;
            if (current.identity !== previous.identity) {
              cleanupFailure ??= 'tracked process identity changed before cleanup';
              continue;
            }
            try {
              process.kill(previous.pid, 'SIGKILL');
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
                cleanupFailure ??= error instanceof Error ? error.message : String(error);
              }
            }
          }
        } catch (error) {
          cleanupFailure ??= error instanceof Error ? error.message : String(error);
          groupIsOwned = child.exitCode === null && child.signalCode === null;
        }
      } else if (resourceBounds !== undefined) {
        groupIsOwned = child.exitCode === null && child.signalCode === null;
        cleanupFailure ??= 'owned process identity was not observed before cleanup';
      }
      if (groupIsOwned) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            cleanupFailure ??= error instanceof Error ? error.message : String(error);
          }
        }
      }
    };
    const stop = (reason: string): void => {
      if (failure !== undefined) return;
      failure = reason;
      killOwned();
      if (!closed) {
        closeTimer = setTimeout(() => {
          if (settled || closed) return;
          settled = true;
          clearWatchers();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          reject(
            new DeliveryError(
              `Selected policy stage command failed (${failure}). Owned process cleanup failed (owned command pipes did not close; descendant cleanup could not be verified).`,
            ),
          );
        }, 2_000);
      }
    };
    const capture = (chunks: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > 8 * 1024 * 1024) {
        stop('captured output exceeded 8 MiB');
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk));
    child.stdout.once('error', (error) => stop(error.message));
    child.stderr.once('error', (error) => stop(error.message));
    child.once('error', (error) => stop(error.message));
    child.once('exit', (code, signal) => {
      if (code !== 0 || signal !== null) stop(`exit ${String(code)}${signal === null ? '' : ` signal ${signal}`}`);
      else if (!closed) {
        exitPipeTimer = setTimeout(() => {
          if (!closed) stop('owned command pipes did not close after direct child exit');
        }, 1_000);
      }
    });
    if (resourceBounds !== undefined) {
      child.once('spawn', () => {
        const sample = (): void => {
          if (failure !== undefined || child.pid === undefined) return;
          try {
            if (owned === undefined) throw new DeliveryError('Owned process identity is unavailable.');
            const result = sampleOwnedTree(owned, repoRoot, resourceBounds, baseline);
            onResourceSample?.(result);
            onRunning?.(outputBytes, result);
          } catch (error) {
            stop(error instanceof Error ? error.message : String(error));
          }
        };
        sample();
        resourceTimer = setInterval(sample, 1_000);
        resourceTimer.unref();
      });
    }
    const progressTimer = setInterval(() => onRunning?.(outputBytes), 5_000);
    progressTimer.unref();
    const onAbort = (): void => stop('cancelled');
    const onSigint = (): void => stop('cancelled by SIGINT');
    const onSigterm = (): void => stop('cancelled by SIGTERM');
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    if (abortSignal?.aborted) onAbort();
    const handleClose = async (code: number | null, signal: NodeJS.Signals | null): Promise<void> => {
      closed = true;
      if (settled) return;
      clearWatchers();
      if (failure === undefined && owned !== undefined) {
        try {
          if (!owned.sampled) throw new DeliveryError('Owned process resource observation was unavailable.');
          if (resourceBounds !== undefined) {
            const result = sampleOwnedTree(owned, repoRoot, resourceBounds, baseline);
            onResourceSample?.(result);
          }
          const remaining = observeOwnedProcesses(owned, processSnapshot());
          if (remaining.length > 0) throw new DeliveryError('A sampled owned descendant survived command exit.');
        } catch (error) {
          stop(error instanceof Error ? error.message : String(error));
        }
      }
      if (failure !== undefined || code !== 0 || signal !== null) {
        const reason = failure ?? `exit ${String(code)}${signal === null ? '' : ` signal ${signal}`}`;
        if (owned !== undefined) {
          try {
            await confirmOwnedCleanup(owned);
          } catch (error) {
            cleanupFailure ??= error instanceof Error ? error.message : String(error);
          }
        }
        settled = true;
        reject(
          new DeliveryError(
            `Selected policy stage command failed (${reason}).${cleanupFailure === undefined ? '' : ` Owned process cleanup failed (${cleanupFailure}).`}`,
          ),
        );
        return;
      }
      settled = true;
      resolve(Buffer.concat([...stdout, ...stderr], outputBytes));
    };
    child.once('close', (code, signal) => {
      void handleClose(code, signal).catch((error: unknown) => {
        settled = true;
        reject(error);
      });
    });
  });
}

export async function verifyIssue(input: {
  personalAuth?: boolean;
  admittedResourceClasses?: readonly string[];
  issueNumber: number;
  repoRoot: string;
  resourceBounds?: VerificationResourceBounds;
  signal?: AbortSignal;
}): Promise<VerificationRun> {
  const assertNotCancelled = (): void => {
    if (input.signal?.aborted) throw new DeliveryError('Verification cancelled.');
  };
  assertNotCancelled();
  const root = gitRoot(input.repoRoot);
  if (input.resourceBounds !== undefined) assertResourceBounds(input.resourceBounds);
  assertRegisteredIssue(root, input.issueNumber);
  const common = gitCommonDir(root);
  const loaded = await loadDeliveryConfig(
    root,
    input.personalAuth === undefined ? {} : { personalAuth: input.personalAuth },
  );
  const selected = await loadSelectedRepositoryPolicy({
    repoRoot: root,
    policySourcePath: loaded.config.policy.module,
  });
  const base = coordinate(root, defaultBaseRef(root, loaded.remote));
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
  const baseline =
    input.resourceBounds === undefined
      ? undefined
      : outputBaseline(root, common, classification.receiptId, input.resourceBounds);
  if (input.resourceBounds !== undefined) assertDiskHeadroom(root, input.resourceBounds, baseline);
  const receipts: RepositoryStageReceipt[] = [];
  const admitted = new Set(input.admittedResourceClasses ?? ['source_only']);
  const startedAtMs = Date.now();
  let reusedStages = 0;
  const normalizedBounds: VerificationResourceSummary['bounds'] | undefined =
    input.resourceBounds === undefined
      ? undefined
      : {
          maxAggregateRssBytes: input.resourceBounds.maxAggregateRssBytes,
          minFreeDiskBytes: input.resourceBounds.minFreeDiskBytes,
          ...(input.resourceBounds.maxNewOutputBytes === undefined
            ? {}
            : { maxNewOutputBytes: input.resourceBounds.maxNewOutputBytes }),
          ...(baseline === undefined ? {} : { outputRoots: baseline.roots }),
        };
  const emptyResources = (): VerificationResourceSummary => ({
    bounds: normalizedBounds!,
    maxSampledAggregateRssBytes: null,
    maxSampledNewOutputBytes: null,
    minSampledFreeDiskBytes: null,
    observation: 'sampled',
    ...(baseline === undefined ? {} : { outputBaselineId: baseline.baselineId }),
    processCoverage: 'observed-processes-only',
    sampleCount: 0,
  });
  const resources = normalizedBounds === undefined ? undefined : emptyResources();
  const environmentDigest =
    normalizedBounds === undefined
      ? stageEnvironmentDigest()
      : digestValue({
          environment: stageEnvironmentDigest(),
          ...(baseline === undefined ? {} : { outputBaselineId: baseline.baselineId }),
          resourceBounds: normalizedBounds,
          resourceRunner: digestBytes(readFileSync(fileURLToPath(import.meta.url))),
        });
  let stageResources: VerificationResourceSummary | undefined;
  const recordResourceSample = (sample: ResourceSample): void => {
    if (resources === undefined) return;
    const measured = {
      ...emptyResources(),
      sampleCount: 1,
      maxSampledAggregateRssBytes: sample.aggregateRssBytes,
      maxSampledNewOutputBytes: sample.newOutputBytes ?? null,
      minSampledFreeDiskBytes: sample.freeDiskBytes,
    };
    mergeResourceSummary(resources, measured);
    if (stageResources !== undefined) mergeResourceSummary(stageResources, measured);
  };
  for (const stage of classification.requiredStages) {
    assertNotCancelled();
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
    let cached = loadRepositoryStageCheckpoint({
      classification,
      configDigest: loaded.configDigest,
      gitCommonDir: common,
      policySourcePath: loaded.config.policy.module,
      repoRoot: root,
      stageInput,
    });
    if (normalizedBounds !== undefined) {
      const measured = loadResourceStageCheckpoint(common, root, stageInput, normalizedBounds, baseline?.baselineId);
      if (measured !== undefined) {
        if (cached === undefined) {
          writeRepositoryStageCheckpoint({ gitCommonDir: common, receipt: measured.receipt, repoRoot: root });
          cached = loadRepositoryStageCheckpoint({
            classification,
            configDigest: loaded.configDigest,
            gitCommonDir: common,
            policySourcePath: loaded.config.policy.module,
            repoRoot: root,
            stageInput,
          });
        }
        if (cached?.receiptId !== measured.receipt.receiptId) {
          throw new DeliveryError('Resource stage checkpoint disagrees with its stage receipt.');
        }
        mergeResourceSummary(resources!, measured.resources);
      } else if (cached !== undefined) {
        throw new DeliveryError('Bounded stage receipt lacks its resource checkpoint.');
      }
    }
    if (cached) {
      receipts.push(cached);
      reusedStages += 1;
      reportVerificationProgress({
        state: 'reused',
        stageId: stage.id,
        completedStages: receipts.length,
        remainingStages: classification.requiredStages.length - receipts.length,
        reusedStages,
        elapsedMs: Date.now() - startedAtMs,
      });
      continue;
    }
    assertNotCancelled();
    stageResources = normalizedBounds === undefined ? undefined : emptyResources();
    const startedAt = new Date().toISOString();
    const commands: { exitCode: number; label: string; outputDigest: string }[] = [];
    for (const command of stage.commands) {
      if (input.resourceBounds !== undefined) assertDiskHeadroom(root, input.resourceBounds, baseline);
      const progress = (capturedOutputBytes: number, sample?: ResourceSample): void =>
        reportVerificationProgress({
          state: 'running',
          stageId: stage.id,
          commandLabel: command.label,
          completedStages: receipts.length,
          remainingStages: classification.requiredStages.length - receipts.length,
          reusedStages,
          elapsedMs: Date.now() - startedAtMs,
          capturedOutputBytes,
          ...(sample === undefined
            ? {}
            : {
                sampledAggregateRssBytes: sample.aggregateRssBytes,
                sampledFreeDiskBytes: sample.freeDiskBytes,
                ...(sample.newOutputBytes === undefined ? {} : { sampledNewOutputBytes: sample.newOutputBytes }),
                ownedProcessCount: sample.ownedProcessCount,
              }),
        });
      progress(0);
      let bytes: Buffer;
      try {
        bytes = await runStageCommand(
          root,
          command.argv,
          input.signal,
          progress,
          input.resourceBounds,
          baseline,
          recordResourceSample,
        );
      } catch (error) {
        reportVerificationProgress({
          state: 'failed',
          stageId: stage.id,
          commandLabel: command.label,
          completedStages: receipts.length,
          remainingStages: classification.requiredStages.length - receipts.length,
          reusedStages,
          elapsedMs: Date.now() - startedAtMs,
          reason: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      assertNotCancelled();
      commands.push({
        exitCode: 0,
        label: command.label,
        outputDigest: writeRepositoryCommandOutput({ bytes, gitCommonDir: common }),
      });
    }
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
    assertNotCancelled();
    if (stageResources !== undefined) writeResourceStageCheckpoint(common, receipt, stageResources);
    writeRepositoryStageCheckpoint({ gitCommonDir: common, receipt, repoRoot: root });
    stageResources = undefined;
    receipts.push(receipt);
    reportVerificationProgress({
      state: 'completed',
      stageId: stage.id,
      completedStages: receipts.length,
      remainingStages: classification.requiredStages.length - receipts.length,
      reusedStages,
      elapsedMs: Date.now() - startedAtMs,
    });
  }
  assertNotCancelled();
  const aggregate = createRepositoryStageAggregate({ classification, receipts });
  writeRepositoryStageAggregate({ gitCommonDir: common, aggregate });
  const content = {
    aggregate,
    classification,
    completedAt: new Date().toISOString(),
    ...(resources === undefined ? {} : { resources: ResourceSummarySchema.parse(resources) }),
    schemaVersion: resources === undefined ? ('ai-delivery.run@1' as const) : ('ai-delivery.run@2' as const),
    stageReceipts: receipts,
  };
  const run: VerificationRun = { ...content, manifestId: digestValue(content) };
  writePrivateJsonFileAtomically(manifestPath(common, head.sha), run);
  return run;
}

export async function createIssuePhaseEvidence(input: {
  personalAuth?: boolean;
  approval?: RepositoryApprovalBinding;
  issueNumber: number;
  mergeReadback?: RepositoryMergeReadback;
  phase: 'verify' | 'publish' | 'merge';
  repoRoot: string;
}): Promise<RepositoryDeliveryEvidence> {
  const root = gitRoot(input.repoRoot);
  assertRegisteredIssue(root, input.issueNumber);
  const loaded = await loadDeliveryConfig(
    root,
    input.personalAuth === undefined ? {} : { personalAuth: input.personalAuth },
  );
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
