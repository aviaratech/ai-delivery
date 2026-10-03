import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  unlinkSync,
  lstatSync,
  mkdirSync,
  rmdirSync,
  renameSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  statfsSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { loadDeliveryConfig } from './config/deliveryConfig.js';
import { assertPrivateFile } from './delivery/common.js';
import {
  classifyRepositoryExactRange,
  assertRepositoryClassificationCurrent,
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
import { withLock } from './utils/lockfile.js';
import { ensurePrivateDirectoryDurably, writePrivateJsonFileAtomically } from './utils/atomicJson.js';

export interface VerificationRun {
  aggregate: RepositoryStageAggregate;
  classification: RepositoryClassificationReceipt;
  completedAt: string;
  manifestId: string;
  resources?: VerificationResourceSummary;
  schemaVersion: 'ai-delivery.run@1' | 'ai-delivery.run@2' | 'ai-delivery.run@3';
  writer?: { worktreeDigest: string; producerDigest: string };
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

const OUTPUT_GATE_ENV = 'AI_DELIVERY_OUTPUT_OBSERVATION_GATE';
const GateOwnerSchema = z.strictObject({ pid: z.number().int().positive(), identity: z.string().min(1) });
const OutputGateSchema = z.strictObject({ directory: z.string().min(1), id: z.uuid(), owner: GateOwnerSchema });
const GateClaimSchema = z.strictObject({
  gateId: z.uuid(),
  id: z.uuid(),
  kind: z.enum(['scan', 'fixture']),
  owner: GateOwnerSchema,
});
type OutputGate = z.infer<typeof OutputGateSchema>;
type GateClaim = z.infer<typeof GateClaimSchema>;

function gateOwner(): z.infer<typeof GateOwnerSchema> {
  const owner = processSnapshot().get(process.pid);
  if (!owner) throw new DeliveryError('Filesystem observation gate owner is unavailable.');
  return { pid: owner.pid, identity: owner.identity };
}

function assertGateDirectory(path: string): void {
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0 || realpathSync(path) !== path)
    throw new DeliveryError('Filesystem observation gate directory is invalid.');
}

function readOutputGate(value: string): OutputGate {
  try {
    const gate = OutputGateSchema.parse(JSON.parse(value) as unknown);
    assertOutputGate(gate);
    return gate;
  } catch (error) {
    throw new DeliveryError(
      'Filesystem observation gate capability is invalid or stale: ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

function gateOwnerAlive(owner: z.infer<typeof GateOwnerSchema>, snapshot = processSnapshot()): boolean {
  const current = snapshot.get(owner.pid);
  return current?.identity === owner.identity && !current.status.startsWith('Z');
}

function assertOutputGate(gate: OutputGate, abandoned = false): void {
  assertGateDirectory(gate.directory);
  const manifest = OutputGateSchema.parse(
    JSON.parse(assertPrivateFile(join(gate.directory, 'gate.json')).toString('utf8')) as unknown,
  );
  const snapshot = processSnapshot();
  let actor = snapshot.get(process.pid);
  const ancestors = new Set<number>();
  while (actor && actor.pid !== gate.owner.pid && !ancestors.has(actor.pid)) {
    ancestors.add(actor.pid);
    actor = snapshot.get(actor.ppid);
  }
  if (
    digestValue(manifest) !== digestValue(gate) ||
    (abandoned
      ? gateOwnerAlive(gate.owner, snapshot)
      : !gateOwnerAlive(gate.owner, snapshot) || actor?.identity !== gate.owner.identity)
  )
    throw new DeliveryError(
      'Filesystem observation gate ownership changed, was abandoned or is not an inherited ancestor.',
    );
}

function readGateClaim(gate: OutputGate, path: string): GateClaim {
  const claim = GateClaimSchema.parse(JSON.parse(assertPrivateFile(path).toString('utf8')) as unknown);
  if (claim.gateId !== gate.id) throw new DeliveryError('Filesystem observation gate claim belongs to another run.');
  return claim;
}

function gateScanRequests(gate: OutputGate): string[] {
  const directory = join(gate.directory, 'requests');
  assertGateDirectory(directory);
  const requests = readdirSync(directory);
  if (requests.length > 1024 || requests.some((name) => !/^[a-f0-9-]{36}\.json$/u.test(name)))
    throw new DeliveryError('Filesystem observation gate scan requests are invalid.');
  const live: string[] = [];
  const snapshot = processSnapshot();
  for (const name of requests) {
    let claim: GateClaim;
    try {
      claim = readGateClaim(gate, join(directory, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (claim.kind !== 'scan' || name !== claim.id + '.json' || !gateOwnerAlive(claim.owner, snapshot))
      throw new DeliveryError('Filesystem observation gate scan request was abandoned.');
    live.push(name);
  }
  return live;
}

function removeGateClaim(gate: OutputGate, path: string, claim: GateClaim): void {
  if (digestValue(readGateClaim(gate, path)) !== digestValue(claim))
    throw new DeliveryError('Filesystem observation gate claim changed before release.');
  unlinkSync(path);
}

async function withOutputGateLock<T>(
  gate: OutputGate | undefined,
  kind: 'scan' | 'fixture',
  operation: () => T | Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!gate) return operation();
  assertOutputGate(gate);
  const claim: GateClaim = { gateId: gate.id, id: randomUUID(), kind, owner: gateOwner() };
  const request = kind === 'scan' ? join(gate.directory, 'requests', claim.id + '.json') : undefined;
  const lock = join(gate.directory, 'held');
  const holder = join(lock, 'owner.json');
  if (request) {
    const staging = join(gate.directory, claim.id + '.pending');
    writePrivateJsonFileAtomically(staging, claim);
    renameSync(staging, request);
  }
  let acquired: { dev: number; ino: number } | undefined;
  let incompleteSince: number | undefined;
  let fixtureWait: { claimId: string; since: number } | undefined;
  const release = (): void => {
    if (!acquired) return;
    const metadata = lstatSync(lock);
    if (!metadata.isDirectory() || metadata.dev !== acquired.dev || metadata.ino !== acquired.ino)
      throw new DeliveryError('Filesystem observation gate lock changed before release.');
    if (readdirSync(lock).join(',') !== 'owner.json')
      throw new DeliveryError('Filesystem observation gate lock has unrelated metadata.');
    removeGateClaim(gate, holder, claim);
    rmdirSync(lock);
    acquired = undefined;
  };
  try {
    for (;;) {
      if (signal?.aborted) throw new DeliveryError('Filesystem observation gate wait cancelled.');
      assertOutputGate(gate);
      const requests = gateScanRequests(gate);
      if (kind === 'scan' || requests.length === 0) {
        let created = false;
        try {
          mkdirSync(lock, { mode: 0o700 });
          created = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        if (created) {
          const metadata = lstatSync(lock);
          acquired = { dev: metadata.dev, ino: metadata.ino };
          writePrivateJsonFileAtomically(holder, claim);
          // A scan may queue between the fixture's request check and atomic lock acquisition.
          if (kind === 'scan' || gateScanRequests(gate).length === 0) return await operation();
          release();
        }
      }
      if (existsSync(lock)) {
        try {
          assertGateDirectory(lock);
          const current = readGateClaim(gate, holder);
          incompleteSince = undefined;
          if (!gateOwnerAlive(current.owner))
            throw new DeliveryError('Filesystem observation gate fixture or scanner was abandoned.');
          if (kind === 'scan' && current.kind === 'fixture') {
            if (fixtureWait?.claimId !== current.id) fixtureWait = { claimId: current.id, since: Date.now() };
            // A negative reader that blocks prevents strict output observation; terminate this command, never steal its live lease.
            if (Date.now() - fixtureWait.since > 5000)
              throw new DeliveryError(
                'Filesystem-negative fixture did not release a waiting output scan within 5 seconds; reader or teardown is stalled.',
              );
          } else fixtureWait = undefined;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          incompleteSince ??= Date.now();
          // A concrete publication failure, never an elapsed fixture-work allowance or stale-lock takeover.
          if (Date.now() - incompleteSince > 2000)
            throw new DeliveryError('Filesystem observation gate owner publication is incomplete.');
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    try {
      release();
    } finally {
      if (request) removeGateClaim(gate, request, claim);
    }
  }
}

/** Run a real filesystem-negative fixture between strict scans; the callback must clean it up before returning. */
export async function withVerificationFilesystemFixture<T>(operation: () => T | Promise<T>): Promise<T> {
  const capability = process.env[OUTPUT_GATE_ENV];
  return withOutputGateLock(capability === undefined ? undefined : readOutputGate(capability), 'fixture', operation);
}

function retireOutputGate(gate: OutputGate, abandoned = false): void {
  assertOutputGate(gate, abandoned);
  const requests = join(gate.directory, 'requests');
  const held = join(gate.directory, 'held');
  if (readdirSync(gate.directory).some((name) => !['gate.json', 'requests', 'held'].includes(name)))
    throw new DeliveryError('Filesystem observation gate has unrelated or incomplete metadata.');
  if (existsSync(held)) {
    assertGateDirectory(held);
    if (readdirSync(held).join(',') !== 'owner.json')
      throw new DeliveryError('Filesystem observation gate lock has unrelated metadata.');
    const claim = readGateClaim(gate, join(held, 'owner.json'));
    if (gateOwnerAlive(claim.owner)) throw new DeliveryError('Filesystem observation gate still has a live holder.');
    removeGateClaim(gate, join(held, 'owner.json'), claim);
    rmdirSync(held);
  }
  for (const name of readdirSync(requests)) {
    if (!/^[a-f0-9-]{36}\.json$/u.test(name))
      throw new DeliveryError('Filesystem observation gate has unrelated metadata.');
    const path = join(requests, name);
    const claim = readGateClaim(gate, path);
    if (claim.kind !== 'scan' || name !== claim.id + '.json')
      throw new DeliveryError('Filesystem observation gate has unrelated scan metadata.');
    if (gateOwnerAlive(claim.owner))
      throw new DeliveryError('Filesystem observation gate still has a live scan request.');
    removeGateClaim(gate, path, claim);
  }
  rmdirSync(requests);
  if (
    digestValue(JSON.parse(assertPrivateFile(join(gate.directory, 'gate.json')).toString('utf8')) as unknown) !==
    digestValue(gate)
  )
    throw new DeliveryError('Filesystem observation gate changed before retirement.');
  unlinkSync(join(gate.directory, 'gate.json'));
  rmdirSync(gate.directory);
}

async function withOutputObservationGate<T>(
  root: string,
  enabled: boolean,
  operation: (gate: OutputGate | undefined) => Promise<T>,
): Promise<T> {
  const inherited = process.env[OUTPUT_GATE_ENV];
  if (inherited !== undefined) return operation(readOutputGate(inherited));
  if (!enabled) return operation(undefined);
  const id = randomUUID();
  const namespace = join(gitCommonDir(root), 'ai-delivery', 'output-observation', worktreeDigest(root).slice(7));
  ensurePrivateDirectoryDurably(namespace);
  // The existing writer has recovered and confirmed old command quiescence before this operation.
  for (const priorId of readdirSync(namespace)) {
    z.uuid().parse(priorId);
    const path = join(namespace, priorId);
    assertGateDirectory(path);
    const prior = OutputGateSchema.parse(
      JSON.parse(assertPrivateFile(join(path, 'gate.json')).toString('utf8')) as unknown,
    );
    if (prior.id !== priorId || prior.directory !== path || gateOwnerAlive(prior.owner))
      throw new DeliveryError('Prior filesystem observation gate is live or has conflicting ownership.');
    retireOutputGate(prior, true);
  }
  const directory = join(namespace, id);
  ensurePrivateDirectoryDurably(join(directory, 'requests'));
  const gate: OutputGate = { directory, id, owner: gateOwner() };
  writePrivateJsonFileAtomically(join(directory, 'gate.json'), gate);
  try {
    return await operation(gate);
  } finally {
    retireOutputGate(gate);
  }
}

interface OutputBaseline {
  gate?: OutputGate;
  baselineId: string;
  files: Map<string, number>;
  links: Map<string, { identity: string; target: string; missing: boolean }>;
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

class OutputObservationError extends DeliveryError {
  override readonly cause: unknown;
  readonly code: string | undefined;

  constructor(message: string, path: string, cause: unknown) {
    const code = (cause as NodeJS.ErrnoException).code;
    super(
      `${message} Path ${JSON.stringify(path)} (${code ?? 'unknown errno'}): ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.code = code;
    this.cause = cause;
  }
}

function scanOutputRoots(
  roots: readonly string[],
  links: OutputBaseline['links'],
  commandRunning = false,
  onMissingTarget?: (reason: string) => void,
): Map<string, number> {
  const files = new Map<string, number>();
  const observedLinks: OutputBaseline['links'] = new Map();
  const visit = (path: string): void => {
    let metadata;
    try {
      metadata = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new OutputObservationError('Filesystem output lstat failed.', path, error);
    }
    if (metadata.isSymbolicLink()) {
      let link: string;
      try {
        link = readlinkSync(path);
      } catch (error) {
        throw new OutputObservationError('Filesystem output readlink failed.', path, error);
      }
      const identity = digestValue({
        device: metadata.dev,
        inode: metadata.ino,
        changed: metadata.ctimeMs,
        modified: metadata.mtimeMs,
        link,
      });
      let target: string;
      let missing = false;
      try {
        target = realpathSync(path);
      } catch (error) {
        const failure = new OutputObservationError(
          'Filesystem output observation encountered a broken or cyclic symbolic link.',
          path,
          error,
        );
        const previous = links.get(path);
        if (previous !== undefined && previous.identity !== identity)
          throw new DeliveryError(`Filesystem output alias identity changed. Path ${JSON.stringify(path)}.`);
        if (!commandRunning || failure.code !== 'ENOENT' || previous?.identity !== identity) throw failure;
        // A validated alias contributes no physical file bytes. Resolve the missing suffix through
        // its current existing ancestor, so an ancestor retarget cannot hide an escaping output.
        const lexical = resolve(dirname(path), link);
        let ancestor = dirname(lexical);
        for (;;) {
          try {
            target = join(realpathSync(ancestor), lexical.slice(ancestor.length));
            break;
          } catch (ancestorError) {
            if ((ancestorError as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor)
              throw new OutputObservationError(
                'Filesystem output ancestor resolution failed.',
                ancestor,
                ancestorError,
              );
            ancestor = dirname(ancestor);
          }
        }
        if (target !== previous.target)
          throw new DeliveryError(`Filesystem output alias target identity changed. Path ${JSON.stringify(path)}.`);
        missing = true;
        onMissingTarget?.(failure.message);
      }
      const previous = links.get(path);
      if (previous?.missing && (previous.identity !== identity || previous.target !== target))
        throw new DeliveryError(
          `Filesystem output alias identity changed after target absence. Path ${JSON.stringify(path)}.`,
        );
      if (!roots.some((root) => target === root || target.startsWith(`${root}${sep}`))) {
        throw new DeliveryError(
          `Filesystem output observation encountered an escaping symbolic link. Path ${JSON.stringify(path)} resolves to ${JSON.stringify(target)}.`,
        );
      }
      let current;
      try {
        current = lstatSync(path);
      } catch (error) {
        throw new OutputObservationError('Filesystem output alias identity readback failed.', path, error);
      }
      if (
        !current.isSymbolicLink() ||
        current.dev !== metadata.dev ||
        current.ino !== metadata.ino ||
        current.ctimeMs !== metadata.ctimeMs ||
        current.mtimeMs !== metadata.mtimeMs
      )
        throw new DeliveryError(
          `Filesystem output alias identity changed during observation. Path ${JSON.stringify(path)}.`,
        );
      observedLinks.set(path, { identity, target, missing });
      // Observe physical targets through their declared root only, never traverse aliases.
      return;
    }
    if (metadata.isDirectory()) {
      let names: string[];
      try {
        names = readdirSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw new OutputObservationError('Filesystem output readdir failed.', path, error);
      }
      for (const name of names) visit(join(path, name));
      return;
    }
    if (!metadata.isFile() || !Number.isSafeInteger(metadata.size)) {
      throw new DeliveryError(
        `Filesystem output observation encountered an unsupported file. Path ${JSON.stringify(path)}.`,
      );
    }
    files.set(path, metadata.size);
    if (files.size > 1_000_000) throw new DeliveryError('Filesystem output observation exceeded its file limit.');
  };
  for (const root of roots) {
    if (existsSync(root) && realpathSync(root) !== root)
      throw new DeliveryError('Filesystem output roots must not be symbolic links.');
    visit(root);
  }
  // Publish alias identities only with the complete physical-file scan that validated them.
  links.clear();
  for (const [path, link] of observedLinks) links.set(path, link);
  return files;
}

async function outputBaseline(
  repoRoot: string,
  common: string,
  classificationReceiptId: string,
  bounds: VerificationResourceBounds,
  gate?: OutputGate,
  signal?: AbortSignal,
): Promise<OutputBaseline | undefined> {
  if (bounds.outputRoots === undefined) return undefined;
  const roots = bounds.outputRoots.map((path) => resolve(repoRoot, path)).sort();
  const links: OutputBaseline['links'] = new Map();
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
      files: [...(await withOutputGateLock(gate, 'scan', () => scanOutputRoots(roots, links), signal))].sort(
        ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
      ),
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
  return { baselineId, roots, files: new Map(checkpoint.files), links, ...(gate === undefined ? {} : { gate }) };
}

async function positiveNewOutputBytes(
  baseline: OutputBaseline,
  signal?: AbortSignal,
  commandRunning = false,
  onUnavailable?: (reason: string) => void,
): Promise<number> {
  let files: Map<string, number>;
  let firstFailure: OutputObservationError | undefined;
  let lastFailure: OutputObservationError | undefined;
  let firstFailureAt: number | undefined;
  const assertObservationWindow = (): void => {
    if (firstFailureAt !== undefined && Date.now() - firstFailureAt >= 1_000) {
      throw new DeliveryError(
        `Filesystem output observation remained unavailable for 1 second. First observation: ${firstFailure!.message} Last observation: ${lastFailure!.message}`,
      );
    }
  };
  for (;;) {
    if (signal?.aborted) throw new DeliveryError('Filesystem output observation cancelled.');
    assertObservationWindow();
    try {
      files = await withOutputGateLock(
        baseline.gate,
        'scan',
        () => scanOutputRoots(baseline.roots, baseline.links, commandRunning, onUnavailable),
        signal,
      );
      assertObservationWindow();
      break;
    } catch (error) {
      // Unvalidated aliases still prevent a complete scan. Retry only during a command,
      // with the stall window starting at the first failed scan, not before that scan.
      if (!commandRunning || !(error instanceof OutputObservationError) || error.code !== 'ENOENT') throw error;
      lastFailure = error;
      if (firstFailure === undefined) {
        firstFailureAt = Date.now();
        firstFailure = error;
        onUnavailable?.(error.message);
      }
      assertObservationWindow();
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
  let bytes = 0;
  for (const [path, size] of files) {
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
  newOutputBytes?: number,
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

/** Signal only birth identities established by this command, including observed detached children. */
function terminateOwnedProcesses(state: OwnedProcessState): void {
  if (!state.sampled || state.rootIdentity === undefined) throw new DeliveryError('Owned process identity is unknown.');
  const snapshot = processSnapshot();
  const root = snapshot.get(state.rootPid);
  if (root !== undefined && root.identity !== state.rootIdentity)
    throw new DeliveryError('Owned process group identity changed before cleanup.');
  const alive = [...state.tracked.values()].flatMap((previous) => {
    const current = snapshot.get(previous.pid);
    if (current === undefined || current.status.startsWith('Z')) return [];
    if (current.identity !== previous.identity)
      throw new DeliveryError('Tracked process identity changed before cleanup.');
    return [current];
  });
  const group = [...snapshot.values()].filter(
    (member) => member.pgid === state.rootPid && !member.status.startsWith('Z'),
  );
  if (group.length > 0 && !alive.some((member) => member.pgid === state.rootPid))
    throw new DeliveryError('Owned process group has no surviving recorded identity; cleanup is ambiguous.');
  const signal = (pid: number): void => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  if (group.length > 0) signal(-state.rootPid);
  for (const member of alive.reverse()) signal(member.pid);
}

const ProcessIdentitySchema = z.strictObject({ pid: z.number().int().positive(), identity: z.string().min(1) });
const WriterStateSchema = z
  .strictObject({
    schemaVersion: z.literal('ai-delivery.verification-writer@1'),
    writerId: z.uuid(),
    worktreeDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    owner: ProcessIdentitySchema,
    command: z.union([
      z.strictObject({ phase: z.literal('idle') }),
      z.strictObject({ phase: z.literal('starting') }),
      z.strictObject({
        phase: z.literal('running'),
        root: ProcessIdentitySchema,
        tracked: z.array(z.strictObject({ ...ProcessIdentitySchema.shape, pgid: z.number().int().positive() })),
      }),
    ]),
    stateId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  })
  .superRefine((state, ctx) => {
    const { stateId, ...content } = state;
    if (stateId !== digestValue(content)) ctx.addIssue({ code: 'custom', message: 'Writer state is corrupt.' });
  });
interface VerificationWriter {
  starting(): void;
  observed(state: OwnedProcessState): void;
  idle(): void;
  assertQuiescent(): void;
}

/** @internal Durable transition evidence must precede changes to the existing writer slot. */
export interface WorktreeTransitionWriterLeaseInput {
  repoRoot: string;
  worktreePath?: string;
  writerId: string;
  beforeClaim(input: {
    previousBytes: Buffer | undefined;
    owner: { pid: number; identity: string };
  }): void | Promise<void>;
  recordClaim(bytes: Buffer): void | Promise<void>;
  afterClaim?(bytes: Buffer): void | Promise<void>;
  recordRelease(bytes: Buffer): void | Promise<void>;
  afterRelease?(): void | Promise<void>;
}

/** @internal Read-only closure check shared by inspection and the locked transition lease. */
export function assertWorktreeTransitionWriterQuiescent(worktreePath: string, bytes: Buffer | undefined): void {
  if (bytes === undefined) return;
  const previous = WriterStateSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (previous.worktreeDigest !== worktreeDigest(worktreePath))
    throw new DeliveryError('Verification writer belongs to another worktree.');
  const snapshot = processSnapshot();
  const owner = snapshot.get(previous.owner.pid);
  if (owner?.identity === previous.owner.identity && !owner.status.startsWith('Z'))
    throw new DeliveryError('A live verification writer still owns this worktree.');
  if (previous.command.phase === 'starting')
    throw new DeliveryError('Interrupted writer has unknown command ownership; reconcile before retrying.');
  if (previous.command.phase === 'running') {
    const identities = [previous.command.root, ...previous.command.tracked];
    const groups = new Set([previous.command.root.pid, ...previous.command.tracked.map((member) => member.pgid)]);
    if (
      identities.some((member) => snapshot.has(member.pid)) ||
      [...snapshot.values()].some((member) => groups.has(member.pgid))
    )
      throw new DeliveryError('Transition requires identity-bound command and process-group absence.');
  }
}

async function withVerificationWriter<T>(
  root: string,
  operation: (writer: VerificationWriter) => Promise<T>,
  transition?: WorktreeTransitionWriterLeaseInput,
  commonDirectory?: string,
): Promise<T> {
  const digest = worktreeDigest(root);
  const path = join(commonDirectory ?? gitCommonDir(root), 'ai-delivery', 'writers@1', `${digest.slice(7)}.json`);
  ensurePrivateDirectoryDurably(dirname(path));
  return withLock(path, {
    projectRoot: root,
    timeout: 200,
    operation: async () => {
      const snapshot = processSnapshot();
      const owner = snapshot.get(process.pid);
      if (owner === undefined || owner.status.startsWith('Z'))
        throw new DeliveryError('Verification writer identity is unknown.');
      let previousBytes: Buffer | undefined;
      if (transition) {
        try {
          lstatSync(path);
          previousBytes = assertPrivateFile(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      } else if (existsSync(path)) previousBytes = assertPrivateFile(path);
      if (transition) assertWorktreeTransitionWriterQuiescent(root, previousBytes);
      if (previousBytes !== undefined && !transition) {
        const previous = WriterStateSchema.parse(JSON.parse(previousBytes.toString('utf8')));
        if (previous.worktreeDigest !== digest)
          throw new DeliveryError('Verification writer belongs to another worktree.');
        const priorOwner = snapshot.get(previous.owner.pid);
        if (priorOwner?.identity === previous.owner.identity && !priorOwner.status.startsWith('Z'))
          throw new DeliveryError('A live verification writer still owns this worktree.');
        if (previous.command.phase === 'starting')
          throw new DeliveryError('Interrupted writer has unknown command ownership; reconcile before retrying.');
        if (previous.command.phase === 'running') {
          const state: OwnedProcessState = {
            rootPid: previous.command.root.pid,
            rootIdentity: previous.command.root.identity,
            sampled: true,
            tracked: new Map(
              previous.command.tracked.map((member) => [member.pid, { ...member, ppid: 0, rssBytes: 0, status: '' }]),
            ),
          };
          terminateOwnedProcesses(state);
          await confirmOwnedCleanup(state);
          reportVerificationProgress({
            state: 'recovered',
            stageId: 'writer',
            completedStages: 0,
            reusedStages: 0,
            remainingStages: 0,
            elapsedMs: 0,
            reason: 'Recorded interrupted command cleanup confirmed; compatible completed stages remain available.',
          });
        }
      }
      if (transition) {
        await transition.beforeClaim({
          previousBytes: previousBytes === undefined ? undefined : Buffer.from(previousBytes),
          owner: { pid: owner.pid, identity: owner.identity },
        });
      }
      let state: Omit<z.infer<typeof WriterStateSchema>, 'stateId'> = {
        schemaVersion: 'ai-delivery.verification-writer@1',
        writerId: transition?.writerId ?? randomUUID(),
        worktreeDigest: digest,
        owner: { pid: owner.pid, identity: owner.identity },
        command: { phase: 'idle' },
      };
      const persist = (command: typeof state.command): void => {
        state = { ...state, command };
        writePrivateJsonFileAtomically(path, { ...state, stateId: digestValue(state) });
      };
      if (transition) {
        const bytes = Buffer.from(`${JSON.stringify({ ...state, stateId: digestValue(state) }, null, 2)}\n`);
        await transition.recordClaim(Buffer.from(bytes));
        let actual: Buffer | undefined;
        try {
          lstatSync(path);
          actual = assertPrivateFile(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (
          (actual === undefined) !== (previousBytes === undefined) ||
          (actual !== undefined && previousBytes !== undefined && !actual.equals(previousBytes))
        )
          throw new DeliveryError('Writer changed after transition intent preservation.');
      }
      persist({ phase: 'idle' });
      const writer: VerificationWriter = {
        starting: () => persist({ phase: 'starting' }),
        observed: (owned) => {
          if (owned.rootIdentity === undefined) throw new DeliveryError('Cannot persist an unknown command owner.');
          persist({
            phase: 'running',
            root: { pid: owned.rootPid, identity: owned.rootIdentity },
            tracked: [...owned.tracked.values()].map(({ pid, identity, pgid }) => ({ pid, identity, pgid })),
          });
        },
        idle: () => persist({ phase: 'idle' }),
        assertQuiescent: () => {
          const current = WriterStateSchema.parse(JSON.parse(assertPrivateFile(path).toString('utf8')));
          if (current.writerId !== state.writerId || current.command.phase !== 'idle')
            throw new DeliveryError('Verification writer command quiescence is not confirmed.');
        },
      };
      const releaseWriter = async (): Promise<void> => {
        const bytes = assertPrivateFile(path);
        const current = WriterStateSchema.parse(JSON.parse(bytes.toString('utf8')));
        if (current.writerId !== state.writerId) throw new DeliveryError('Verification writer ownership changed.');
        if (current.command.phase === 'idle') {
          if (transition) {
            await transition.recordRelease(Buffer.from(bytes));
            if (!assertPrivateFile(path).equals(bytes))
              throw new DeliveryError('Writer changed before recorded release.');
          }
          unlinkSync(path);
          if (transition) {
            const descriptor = openSync(dirname(path), 'r');
            try {
              fsyncSync(descriptor);
            } finally {
              closeSync(descriptor);
            }
            try {
              lstatSync(path);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              await transition.afterRelease?.();
              return;
            }
            throw new DeliveryError('Writer absence is not confirmed after recorded release.');
          }
        }
      };
      try {
        await transition?.afterClaim?.(Buffer.from(assertPrivateFile(path)));
        return await operation(writer);
      } finally {
        await releaseWriter();
      }
    },
  });
}

/** @internal Hold the existing writer lock while reading a sealed transition; never claim or recover its slot. */
export async function withWorktreeTransitionWriterAbsent<T>(
  repoRoot: string,
  worktreePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const path = join(
    gitCommonDir(repoRoot),
    'ai-delivery',
    'writers@1',
    `${worktreeDigest(worktreePath).slice(7)}.json`,
  );
  return withLock(path, {
    projectRoot: repoRoot,
    timeout: 200,
    operation: async () => {
      try {
        lstatSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return operation();
      }
      throw new DeliveryError('Sealed transition writer absence postcondition drifted.');
    },
  });
}

/** @internal Check-only lease for the explicit transition owner; never recovers or signals old commands. */
export async function withWorktreeTransitionWriterLease<T>(
  input: WorktreeTransitionWriterLeaseInput,
  operation: () => Promise<T>,
): Promise<T> {
  z.uuid().parse(input.writerId);
  const repository = gitRoot(input.repoRoot);
  const subject = input.worktreePath === undefined ? repository : resolve(input.worktreePath);
  return withVerificationWriter(
    subject,
    async (writer) => {
      writer.assertQuiescent();
      const result = await operation();
      writer.assertQuiescent();
      return result;
    },
    input,
    gitCommonDir(repository),
  );
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

function worktreeDigest(root: string): string {
  return digestValue(resolve(root));
}
function producerContent(root: string) {
  const code: { path: string; digest: string }[] = [];
  const collect = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.test.js'))
        code.push({ path: path.slice(root.length + 1), digest: digestBytes(readFileSync(path)) });
    }
  };
  collect(root);
  const dependencies = new Map<string, string>();
  const collectDependencies = (manifestPath: string): void => {
    if (dependencies.has(manifestPath)) return;
    const bytes = readFileSync(manifestPath);
    const manifest = z
      .object({ dependencies: z.record(z.string(), z.string()).optional() })
      .parse(JSON.parse(bytes.toString('utf8')));
    dependencies.set(manifestPath, digestBytes(bytes));
    const require = createRequire(manifestPath);
    for (const name of Object.keys(manifest.dependencies ?? {}).sort()) {
      let resolved: string;
      try {
        resolved = require.resolve(`${name}/package.json`);
      } catch {
        resolved = require.resolve(name);
      }
      let directory = dirname(resolved);
      for (;;) {
        const path = join(directory, 'package.json');
        if (existsSync(path)) {
          const candidate = z.object({ name: z.string().optional() }).parse(JSON.parse(readFileSync(path, 'utf8')));
          if (candidate.name === name) {
            collectDependencies(path);
            break;
          }
        }
        const parent = dirname(directory);
        if (parent === directory) throw new DeliveryError(`Producer dependency identity is unavailable for ${name}.`);
        directory = parent;
      }
    }
  };
  collectDependencies(join(dirname(root), 'package.json'));
  return { code, dependencies: [...dependencies].sort(([a], [b]) => a.localeCompare(b)) };
}

function producerDigest(root = dirname(fileURLToPath(import.meta.url))): string {
  return digestValue(producerContent(root));
}

/** @internal Retained public code is hashed as data; it is never imported or executed. */
export function retainedWorktreeTransitionProducerDigest(distDirectory: string): string {
  return producerDigest(realpathSync(distDirectory));
}

/** @internal Preserve the same dependency manifests that participate in the existing producer digest. */
export function retainedWorktreeTransitionDependencyManifests(
  distDirectory: string,
): { source: string; digest: string }[] {
  return producerContent(realpathSync(distDirectory)).dependencies.map(([source, digest]) => ({ source, digest }));
}

/** @internal Original manifests validate as history and cannot authorize current verification. */
export function readWorktreeTransitionRun(bytes: Buffer): VerificationRun {
  return parseRun(JSON.parse(bytes.toString('utf8')) as unknown);
}
function manifestPath(common: string, headSha: string, root?: string): string {
  return root === undefined
    ? join(common, 'ai-delivery', 'runs', `${headSha}.json`)
    : join(common, 'ai-delivery', 'runs@2', worktreeDigest(root).slice(7), `${headSha}.json`);
}

function parseRun(value: unknown): VerificationRun {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new DeliveryError('Invalid run manifest.');
  const input = value as Record<string, unknown>;
  const classification = RepositoryClassificationReceiptSchema.parse(input.classification);
  const aggregate = RepositoryStageAggregateSchema.parse(input.aggregate);
  const stageReceipts = RepositoryStageReceiptSchema.array().parse(input.stageReceipts);
  if (!['ai-delivery.run@1', 'ai-delivery.run@2', 'ai-delivery.run@3'].includes(String(input.schemaVersion)))
    throw new DeliveryError('Run manifest schema version is unsupported.');
  if (input.schemaVersion === 'ai-delivery.run@1' && input.resources !== undefined)
    throw new DeliveryError('Historical run manifest has unexpected resource evidence.');
  const resources = input.resources === undefined ? undefined : ResourceSummarySchema.parse(input.resources);
  if (input.schemaVersion === 'ai-delivery.run@2' && resources === undefined)
    throw new DeliveryError('Historical bounded run lacks resource evidence.');
  const writer =
    input.schemaVersion === 'ai-delivery.run@3'
      ? z
          .strictObject({
            worktreeDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
            producerDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
          })
          .parse(input.writer)
      : undefined;
  const content = {
    aggregate,
    classification,
    completedAt: input.completedAt,
    ...(resources === undefined ? {} : { resources }),
    ...(writer === undefined ? {} : { writer }),
    schemaVersion: input.schemaVersion,
    stageReceipts,
  };
  if (
    typeof input.completedAt !== 'string' ||
    input.manifestId !== digestValue(content) ||
    createRepositoryStageAggregate({ classification, receipts: stageReceipts }).aggregateId !== aggregate.aggregateId
  )
    throw new DeliveryError('Run manifest identity or aggregate is invalid.');
  return { ...content, completedAt: input.completedAt, manifestId: input.manifestId } as VerificationRun;
}

function loadRun(common: string, headSha: string, root: string, historical = false): VerificationRun {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath(common, headSha, root), 'utf8')) as unknown;
  } catch (error) {
    if (!historical || (error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new DeliveryError(
        'Exact-head worktree verification run is missing or corrupt; verify with the current producer.',
      );
    raw = JSON.parse(readFileSync(manifestPath(common, headSha), 'utf8')) as unknown;
  }
  const run = parseRun(raw);
  if (
    run.classification.head.sha !== headSha ||
    (run.writer !== undefined &&
      (run.writer.worktreeDigest !== worktreeDigest(root) ||
        (!historical && run.writer.producerDigest !== producerDigest()))) ||
    (!historical && run.writer === undefined)
  )
    throw new DeliveryError('Verification run belongs to another writer or producer.');
  const expectedEnvironment = historical ? undefined : verificationEnvironmentDigest(root, run.resources);
  if (
    expectedEnvironment !== undefined &&
    run.stageReceipts.some((receipt) => receipt.input.environmentDigest !== expectedEnvironment)
  )
    throw new DeliveryError('Verification stage environment belongs to a foreign worktree or producer.');
  return run;
}

function stageEnvironmentDigest(root: string, producer = producerDigest()): string {
  return digestValue({
    arch: process.arch,
    node: process.version,
    path: process.env.PATH ?? '',
    platform: process.platform,
    worktreeDigest: worktreeDigest(root),
    producerDigest: producer,
  });
}

function verificationEnvironmentDigest(
  root: string,
  resources?: Pick<VerificationResourceSummary, 'bounds' | 'outputBaselineId'>,
  producer = producerDigest(),
): string {
  const environment = stageEnvironmentDigest(root, producer);
  return resources === undefined
    ? environment
    : digestValue({
        environment,
        ...(resources.outputBaselineId === undefined ? {} : { outputBaselineId: resources.outputBaselineId }),
        resourceBounds: resources.bounds,
        resourceRunner: digestBytes(readFileSync(fileURLToPath(import.meta.url))),
      });
}

function reportVerificationProgress(input: {
  state: 'running' | 'reused' | 'completed' | 'failed' | 'recovered';
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
  completedCommands?: number;
  remainingCommands?: number;
  reusedCommands?: number;
  executedCommandsPerSecond?: number;
  lastCompletedWorkAgeMs?: number;
  commandElapsedMs?: number;
}): void {
  process.stderr.write(`ai-delivery.verify ${JSON.stringify(input)}\n`);
}

function runStageCommand(
  repoRoot: string,
  argv: readonly string[],
  abortSignal?: AbortSignal,
  onRunning?: (capturedOutputBytes: number, resource?: ResourceSample, reason?: string) => void,
  resourceBounds?: VerificationResourceBounds,
  baseline?: OutputBaseline,
  onResourceSample?: (sample: ResourceSample) => void,
  writer?: VerificationWriter,
): Promise<Buffer> {
  const [executable, ...args] = argv;
  if (!executable) throw new DeliveryError('Policy selected an empty stage command.');
  if (abortSignal?.aborted) throw new DeliveryError('Selected policy stage command cancelled.');
  writer?.starting();
  return new Promise((resolve, reject) => {
    // The shell waits for our ownership receipt, then exec preserves its PID, birth identity and process group.
    const child = spawn(
      '/bin/sh',
      [
        '-c',
        'IFS= read -r ready || exit 125; [ "$ready" = run ] || exit 125; exec "$@" </dev/null',
        'ai-delivery-command',
        executable,
        ...args,
      ],
      {
        cwd: repoRoot,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(baseline?.gate === undefined
          ? {}
          : { env: { ...process.env, [OUTPUT_GATE_ENV]: JSON.stringify(baseline.gate) } }),
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const owned: OwnedProcessState | undefined =
      process.platform === 'win32' || child.pid === undefined
        ? undefined
        : { rootPid: child.pid, sampled: false, tracked: new Map() };
    let outputBytes = 0;
    let failure: string | undefined;
    let cleanupFailure: string | undefined;
    let writerFailure: string | undefined;
    let closed = false;
    let settled = false;
    let commandReleased = false;
    let firstOutputObservationFailure: string | undefined;
    let lastOutputObservationFailure: string | undefined;
    let pendingOutput: Promise<void> | undefined;
    const scanCancellation = new AbortController();
    const failedOutput = (): string => {
      const observation =
        firstOutputObservationFailure === undefined
          ? ''
          : ` First filesystem observation: ${firstOutputObservationFailure} Last filesystem observation: ${lastOutputObservationFailure}`;
      try {
        const bytes = Buffer.concat([...stdout, ...stderr]);
        return ` Command output ${writeRepositoryCommandOutput({ bytes, gitCommonDir: gitCommonDir(repoRoot) })}.${observation}`;
      } catch (error) {
        return ` Command output persistence failed (${error instanceof Error ? error.message : String(error)}).${observation}`;
      }
    };
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
      if (owned?.sampled) {
        try {
          observeOwnedProcesses(owned, processSnapshot());
        } catch (error) {
          cleanupFailure ??= error instanceof Error ? error.message : String(error);
        }
        try {
          writer?.observed(owned);
        } catch (error) {
          writerFailure ??= error instanceof Error ? error.message : String(error);
        }
        // Durable state failure cannot prevent identity-checked termination of known-owned processes.
        try {
          terminateOwnedProcesses(owned);
        } catch (error) {
          cleanupFailure ??= error instanceof Error ? error.message : String(error);
        }
      } else {
        try {
          // The still-owned direct child is the only safe signal target before identity observation.
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          if (commandReleased) cleanupFailure ??= 'owned process identity was not observed before cleanup';
        } catch (error) {
          cleanupFailure ??= error instanceof Error ? error.message : String(error);
        }
      }
    };
    const stop = (reason: string): void => {
      if (failure !== undefined) return;
      failure = reason;
      scanCancellation.abort();
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
              `Selected policy stage command failed (${failure}).${failedOutput()}${writerFailure === undefined ? '' : ` Writer state persistence failed (${writerFailure}).`} Owned process cleanup failed (owned command pipes did not close; descendant cleanup could not be verified).`,
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
    child.stdin.once('error', (error) => stop(error.message));
    child.once('error', (error) => {
      if (child.pid === undefined) writer?.idle();
      stop(error.message);
    });
    child.once('exit', (code, signal) => {
      if (code !== 0 || signal !== null) stop(`exit ${String(code)}${signal === null ? '' : ` signal ${signal}`}`);
      else if (!closed) {
        exitPipeTimer = setTimeout(() => {
          if (!closed) stop('owned command pipes did not close after direct child exit');
        }, 1_000);
      }
    });
    child.once('spawn', () => {
      const sample = (): void => {
        if (failure !== undefined || child.pid === undefined) return;
        try {
          if (owned === undefined) throw new DeliveryError('Owned process identity is unavailable on this platform.');
          observeOwnedProcesses(owned, processSnapshot());
          writer?.observed(owned);
          if (resourceBounds !== undefined) {
            const result = sampleOwnedTree(owned, repoRoot, resourceBounds, baseline);
            onResourceSample?.(result);
            onRunning?.(outputBytes, result);
          }
          if (closed || pendingOutput !== undefined) return;
          pendingOutput = (async () => {
            if (resourceBounds !== undefined && baseline !== undefined) {
              const bytes = await positiveNewOutputBytes(
                baseline,
                scanCancellation.signal,
                commandReleased,
                (reason) => {
                  firstOutputObservationFailure ??= reason;
                  lastOutputObservationFailure = reason;
                  onRunning?.(outputBytes, undefined, reason);
                },
              );
              if (failure !== undefined) return;
              const result = sampleOwnedTree(owned, repoRoot, resourceBounds, baseline, bytes);
              onResourceSample?.(result);
              onRunning?.(outputBytes, result);
            }
            if (failure === undefined && !commandReleased) {
              commandReleased = true;
              child.stdin.end('run\n');
            }
          })()
            .catch((error: unknown) => stop(error instanceof Error ? error.message : String(error)))
            .finally(() => {
              pendingOutput = undefined;
            });
        } catch (error) {
          stop(error instanceof Error ? error.message : String(error));
        }
      };
      sample();
      resourceTimer = setInterval(sample, 1_000);
      resourceTimer.unref();
    });
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
      await pendingOutput;
      if (failure === undefined && owned !== undefined) {
        try {
          if (resourceBounds !== undefined) {
            const sample = sampleOwnedTree(
              owned,
              repoRoot,
              resourceBounds,
              baseline,
              baseline === undefined ? undefined : await positiveNewOutputBytes(baseline, scanCancellation.signal),
            );
            onResourceSample?.(sample);
            onRunning?.(outputBytes, sample);
          }
          if (!owned.sampled) throw new DeliveryError('Owned process resource observation was unavailable.');
          const remaining = observeOwnedProcesses(owned, processSnapshot());
          if (remaining.length > 0) throw new DeliveryError('A sampled owned descendant survived command exit.');
        } catch (error) {
          stop(error instanceof Error ? error.message : String(error));
        }
      }
      if (failure !== undefined || code !== 0 || signal !== null) {
        const reason = failure ?? `exit ${String(code)}${signal === null ? '' : ` signal ${signal}`}`;
        let cleanupConfirmed = child.pid === undefined || !commandReleased;
        if (owned !== undefined && owned.sampled) {
          try {
            await confirmOwnedCleanup(owned);
            cleanupConfirmed = true;
          } catch (error) {
            cleanupFailure ??= error instanceof Error ? error.message : String(error);
          }
        }
        if (cleanupConfirmed) {
          try {
            writer?.idle();
          } catch (error) {
            writerFailure ??= error instanceof Error ? error.message : String(error);
          }
        }
        settled = true;
        reject(
          new DeliveryError(
            `Selected policy stage command failed (${reason}). Command exit ${String(code)}${signal === null ? '' : ` signal ${signal}`}.${failedOutput()}${writerFailure === undefined ? '' : ` Writer state persistence failed (${writerFailure}).`}${cleanupFailure === undefined ? '' : ` Owned process cleanup failed (${cleanupFailure}).`}`,
          ),
        );
        return;
      }
      writer?.idle();
      settled = true;
      resolve(Buffer.concat([...stdout, ...stderr], outputBytes));
    };
    child.once('close', (code, signal) => {
      void handleClose(code, signal)
        .catch((error: unknown) => {
          settled = true;
          reject(error);
        })
        .finally(clearWatchers);
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
  const root = gitRoot(input.repoRoot);
  return withVerificationWriter(root, (writer) =>
    withOutputObservationGate(root, input.resourceBounds?.outputRoots !== undefined, (gate) =>
      verifyIssueOwned(input, writer, gate),
    ),
  );
}

async function verifyIssueOwned(
  input: Parameters<typeof verifyIssue>[0],
  writer: VerificationWriter,
  gate?: OutputGate,
): Promise<VerificationRun> {
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
      : await outputBaseline(root, common, classification.receiptId, input.resourceBounds, gate, input.signal);
  if (input.resourceBounds !== undefined) assertDiskHeadroom(root, input.resourceBounds, baseline);
  const receipts: RepositoryStageReceipt[] = [];
  const admitted = new Set(input.admittedResourceClasses ?? ['source_only']);
  const startedAtMs = Date.now();
  let reusedStages = 0;
  let completedCommands = 0;
  let reusedCommands = 0;
  let lastCompletedAtMs = startedAtMs;
  const totalCommands = classification.requiredStages.reduce((total, stage) => total + stage.commands.length, 0);
  const report = (progress: Parameters<typeof reportVerificationProgress>[0]): void => {
    const elapsedMs = Date.now() - startedAtMs;
    reportVerificationProgress({
      ...progress,
      completedCommands,
      remainingCommands: totalCommands - completedCommands,
      reusedCommands,
      executedCommandsPerSecond: elapsedMs === 0 ? 0 : ((completedCommands - reusedCommands) * 1000) / elapsedMs,
      lastCompletedWorkAgeMs: Date.now() - lastCompletedAtMs,
    });
  };
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
  const producer = producerDigest();
  const environmentDigest = verificationEnvironmentDigest(root, resources, producer);
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
    const stageInput = createRepositoryStageInput({
      classification,
      environmentDigest,
      semanticInputs:
        stage.semanticInputs ??
        stage.semanticInputKeys.map((key) => ({
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
      completedCommands += cached.commands.length;
      reusedCommands += cached.commands.length;
      lastCompletedAtMs = Date.now();
      report({
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
    if (!admitted.has(stage.resourceClass)) {
      throw new DeliveryError(`Stage '${stage.id}' requires explicit ${stage.resourceClass} admission.`);
    }
    stageResources = normalizedBounds === undefined ? undefined : emptyResources();
    const startedAt = new Date().toISOString();
    const commands: { exitCode: number; label: string; outputDigest: string }[] = [];
    for (const command of stage.commands) {
      const commandStartedAtMs = Date.now();
      if (input.resourceBounds !== undefined) assertDiskHeadroom(root, input.resourceBounds, baseline);
      const progress = (capturedOutputBytes: number, sample?: ResourceSample, reason?: string): void =>
        report({
          state: 'running',
          stageId: stage.id,
          commandLabel: command.label,
          completedStages: receipts.length,
          remainingStages: classification.requiredStages.length - receipts.length,
          reusedStages,
          elapsedMs: Date.now() - startedAtMs,
          capturedOutputBytes,
          ...(reason === undefined ? {} : { reason }),
          commandElapsedMs: Date.now() - commandStartedAtMs,
          ...(sample === undefined
            ? {}
            : {
                sampledAggregateRssBytes: sample.aggregateRssBytes,
                sampledFreeDiskBytes: sample.freeDiskBytes,
                ...(sample.newOutputBytes === undefined ? {} : { sampledNewOutputBytes: sample.newOutputBytes }),
                ownedProcessCount: sample.ownedProcessCount,
                ...(baseline !== undefined && sample.newOutputBytes === undefined
                  ? { reason: 'waiting for strict filesystem output scan' }
                  : {}),
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
          writer,
        );
      } catch (error) {
        report({
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
      completedCommands += 1;
      lastCompletedAtMs = Date.now();
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
    lastCompletedAtMs = Date.now();
    report({
      state: 'completed',
      stageId: stage.id,
      completedStages: receipts.length,
      remainingStages: classification.requiredStages.length - receipts.length,
      reusedStages,
      elapsedMs: Date.now() - startedAtMs,
    });
  }
  assertNotCancelled();
  if (baseline !== undefined && input.resourceBounds !== undefined) {
    const bytes = await positiveNewOutputBytes(baseline, input.signal);
    if (bytes > input.resourceBounds.maxNewOutputBytes!)
      throw new DeliveryError(
        'Positive new filesystem output ' + bytes + ' exceeded limit ' + input.resourceBounds.maxNewOutputBytes! + '.',
      );
    assertDiskHeadroom(root, input.resourceBounds, baseline);
    recordResourceSample({
      aggregateRssBytes: 0,
      freeDiskBytes: freeDiskBytes(root, baseline),
      newOutputBytes: bytes,
      ownedProcessCount: 0,
    });
  }
  assertNotCancelled();
  assertRepositoryClassificationCurrent({
    classification,
    configDigest: loaded.configDigest,
    policySourcePath: loaded.config.policy.module,
    repoRoot: root,
  });
  if (coordinate(root).sha !== head.sha || coordinate(root, defaultBaseRef(root, loaded.remote)).sha !== base.sha)
    throw new DeliveryError('Verification source changed during execution; classify and resume the current source.');
  if (producerDigest() !== producer) throw new DeliveryError('Verification producer changed during execution.');
  const aggregate = createRepositoryStageAggregate({ classification, receipts });
  writeRepositoryStageAggregate({ gitCommonDir: common, aggregate });
  const content = {
    aggregate,
    classification,
    completedAt: new Date().toISOString(),
    ...(resources === undefined ? {} : { resources: ResourceSummarySchema.parse(resources) }),
    schemaVersion: 'ai-delivery.run@3' as const,
    writer: { worktreeDigest: worktreeDigest(root), producerDigest: producer },
    stageReceipts: receipts,
  };
  const run: VerificationRun = { ...content, manifestId: digestValue(content) };
  writePrivateJsonFileAtomically(manifestPath(common, head.sha, root), run);
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
  const run = loadRun(gitCommonDir(root), coordinate(root).sha, root);
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
  const historical = getIssueWorktreeStrict(issueNumber, primaryRoot(root)).status === 'merged';
  return loadRun(gitCommonDir(root), coordinate(root).sha, root, historical);
}

/** Recover an exact merged run after worktree removal interrupted terminal recording. */
export function loadRemovedMergedRun(primaryRepoRoot: string, issueNumber: number): VerificationRun {
  const root = gitRoot(primaryRepoRoot);
  const row = getIssueWorktreeStrict(issueNumber, root);
  if (row.status !== 'merged' || row.path !== join(root, '.worktrees', `issue-${issueNumber}`)) {
    throw new DeliveryError('Removed-run recovery requires the exact registered merged issue.');
  }
  const headSha = git(root, 'rev-parse', `refs/heads/${row.branch}`);
  const run = loadRun(gitCommonDir(root), headSha, row.path, true);
  if (run.classification.head.sha !== headSha) {
    throw new DeliveryError('Recovered merged run disagrees with the registered branch.');
  }
  return run;
}

/** @internal Runtime setup shares the existing writer, ownership handshake and bounded command runner. */
export async function withRuntimeSetupWriter<T>(
  root: string,
  operation: (runner: {
    assertQuiescent(): void;
    run(argv: readonly string[], bounds: VerificationResourceBounds, signal?: AbortSignal): Promise<Buffer>;
  }) => Promise<T>,
): Promise<T> {
  return withVerificationWriter(root, async (writer) =>
    operation({
      assertQuiescent: () => writer.assertQuiescent(),
      run: async (argv, bounds, signal) => {
        assertResourceBounds(bounds);
        const roots = bounds.outputRoots?.map((path) => resolve(root, path)).sort();
        if (roots !== undefined) {
          for (let i = 1; i < roots.length; i++)
            if (roots[i] === roots[i - 1] || roots[i]!.startsWith(`${roots[i - 1]}${sep}`))
              throw new DeliveryError('Filesystem output roots must not overlap.');
        }
        return withOutputObservationGate(root, roots !== undefined, async (gate) => {
          const links: OutputBaseline['links'] = new Map();
          const files =
            roots === undefined
              ? undefined
              : await withOutputGateLock(gate, 'scan', () => scanOutputRoots(roots, links), signal);
          const baseline =
            roots === undefined || files === undefined
              ? undefined
              : {
                  roots,
                  files,
                  links,
                  baselineId: digestValue([...files]),
                  ...(gate === undefined ? {} : { gate }),
                };
          assertDiskHeadroom(root, bounds, baseline);
          const started = Date.now();
          const output = await runStageCommand(
            root,
            argv,
            signal,
            (capturedOutputBytes, sample, reason) =>
              reportVerificationProgress({
                state: 'running',
                stageId: 'runtime-setup',
                completedStages: 0,
                reusedStages: 0,
                remainingStages: 1,
                elapsedMs: Date.now() - started,
                capturedOutputBytes,
                ...(reason === undefined ? {} : { reason }),
                ...(sample === undefined
                  ? {}
                  : {
                      sampledAggregateRssBytes: sample.aggregateRssBytes,
                      sampledFreeDiskBytes: sample.freeDiskBytes,
                      sampledNewOutputBytes: sample.newOutputBytes,
                    }),
              }),
            bounds,
            baseline,
            undefined,
            writer,
          );
          if (signal?.aborted) throw new DeliveryError('Runtime setup cancelled.');
          reportVerificationProgress({
            state: 'completed',
            stageId: 'runtime-setup',
            completedStages: 1,
            reusedStages: 0,
            remainingStages: 0,
            elapsedMs: Date.now() - started,
          });
          return output;
        });
      },
    }),
  );
}
