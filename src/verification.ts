import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  openSync,
  unlinkSync,
  lstatSync,
  mkdirSync,
  rmdirSync,
  renameSync,
  readFileSync,
  readSync,
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
import { createDeliveryGitHubClients } from './github/client.js';
import { assertClean, changedPaths, coordinate, defaultBaseRef, git, gitCommonDir, gitRoot } from './git.js';
import { assertAiDeliveryWorktreeOwner, getIssueWorktreeStrict } from './services/worktreeRegistry.js';
import { assertDeliveryRuntimeAdmitted } from './services/deliveryAdmission.js';
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
        let lexical = resolve(dirname(path), link);
        let ancestor = lexical;
        const expanded = new Set([path]);
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
            let ancestorMetadata;
            try {
              ancestorMetadata = lstatSync(ancestor);
            } catch (metadataError) {
              if ((metadataError as NodeJS.ErrnoException).code !== 'ENOENT')
                throw new OutputObservationError('Filesystem output ancestor lstat failed.', ancestor, metadataError);
            }
            if (ancestorMetadata?.isSymbolicLink()) {
              let ancestorLink, currentAncestor;
              try {
                ancestorLink = readlinkSync(ancestor);
                currentAncestor = lstatSync(ancestor);
              } catch (aliasError) {
                throw new OutputObservationError('Filesystem output ancestor alias read failed.', ancestor, aliasError);
              }
              const ancestorIdentity = digestValue({
                device: ancestorMetadata.dev,
                inode: ancestorMetadata.ino,
                changed: ancestorMetadata.ctimeMs,
                modified: ancestorMetadata.mtimeMs,
                link: ancestorLink,
              });
              const previousAncestor = links.get(ancestor);
              if (previousAncestor === undefined) throw failure;
              if (
                expanded.has(ancestor) ||
                previousAncestor.identity !== ancestorIdentity ||
                !currentAncestor.isSymbolicLink() ||
                currentAncestor.dev !== ancestorMetadata.dev ||
                currentAncestor.ino !== ancestorMetadata.ino ||
                currentAncestor.ctimeMs !== ancestorMetadata.ctimeMs ||
                currentAncestor.mtimeMs !== ancestorMetadata.mtimeMs
              )
                throw new DeliveryError(
                  `Filesystem output ancestor alias identity changed. Path ${JSON.stringify(ancestor)}.`,
                );
              expanded.add(ancestor);
              lexical = join(resolve(dirname(ancestor), ancestorLink), lexical.slice(ancestor.length));
              ancestor = lexical;
              continue;
            }
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
        // A previously validated alias removed during this visit has no physical payload.
        // Continue the complete current scan, publishing no identity for the vanished alias.
        if (commandRunning && (error as NodeJS.ErrnoException).code === 'ENOENT' && previous?.identity === identity)
          return;
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
    if ((!metadata.isFile() && !metadata.isSocket()) || !Number.isSafeInteger(metadata.size)) {
      throw new DeliveryError(
        `Filesystem output observation encountered an unsupported file. Path ${JSON.stringify(path)}.`,
      );
    }
    // Unix IPC endpoints store no regular-file payload, but still count toward the scan's entry limit.
    files.set(path, metadata.isSocket() ? 0 : metadata.size);
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
  controllerRssBytes = 0,
  includeControllerTree = false,
): ResourceSample {
  const snapshot = processSnapshot();
  const owned = observeOwnedProcesses(state, snapshot);
  const controller = includeControllerTree
    ? controllerTreeRssBytes(snapshot, new Set(owned.map((member) => member.pid)))
    : controllerRssBytes;
  const rssBytes = owned.reduce((total, member) => total + member.rssBytes, controller);
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

/** Accounting includes the caller's tree; containment remains restricted to the recorded command. */
function controllerTreeRssBytes(snapshot = processSnapshot(), excluded = new Set<number>()): number {
  const controller = snapshot.get(process.pid);
  if (controller === undefined || controller.status.startsWith('Z'))
    throw new DeliveryError('Runtime setup controller resource observation is unavailable.');
  const selected = new Set([process.pid]);
  let bytes = process.memoryUsage().rss;
  for (const pid of selected)
    for (const member of snapshot.values())
      if (member.ppid === pid && !member.status.startsWith('Z') && !selected.has(member.pid)) {
        selected.add(member.pid);
        if (!excluded.has(member.pid)) bytes += member.rssBytes;
      }
  if (!Number.isSafeInteger(bytes)) throw new DeliveryError('Controller aggregate RSS observation overflowed.');
  return bytes;
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
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return;
      if (code !== 'EPERM') throw error;
      // macOS can return EPERM when the last group member exits after our snapshot.
      // Accept only fresh absence/zombie proof; a live target remains a cleanup failure.
      const readback = processSnapshot();
      if (pid < 0) {
        const currentRoot = readback.get(state.rootPid);
        if (currentRoot !== undefined && currentRoot.identity !== state.rootIdentity)
          throw new DeliveryError('Owned process group identity changed during cleanup signal readback.');
        if ([...readback.values()].some((member) => member.pgid === state.rootPid && !member.status.startsWith('Z')))
          throw error;
      } else {
        const current = readback.get(pid);
        if (current !== undefined && current.identity !== state.tracked.get(pid)?.identity)
          throw new DeliveryError('Tracked process identity changed during cleanup signal readback.');
        if (current !== undefined && !current.status.startsWith('Z')) throw error;
      }
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
  onLockReleaseError?: (error: unknown) => void;
  onLockCompromised?: (error: Error) => void;
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
  refuseUnresolvedSourcePhase = false,
): Promise<T> {
  const digest = worktreeDigest(root);
  const path = join(commonDirectory ?? gitCommonDir(root), 'ai-delivery', 'writers@1', `${digest.slice(7)}.json`);
  ensurePrivateDirectoryDurably(dirname(path));
  return withLock(path, {
    projectRoot: root,
    timeout: 200,
    ...(transition?.onLockReleaseError === undefined ? {} : { onReleaseError: transition.onLockReleaseError }),
    ...(transition?.onLockCompromised === undefined ? {} : { onCompromised: transition.onLockCompromised }),
    operation: async () => {
      await assertNoUnsealedSourcePhase(commonDirectory ?? gitCommonDir(root), digest, refuseUnresolvedSourcePhase);
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
      await assertNoUnsealedSourcePhase(gitCommonDir(repoRoot), worktreeDigest(worktreePath));
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
  execution?: {
    environment: NodeJS.ProcessEnv;
    cwd?: string;
    maxCapturedOutputBytes?: number;
    includeControllerTree?: boolean;
    onCaptured?(bytes: number): void;
    onCleanupFailure?(reason: string): void;
  },
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
        cwd: execution?.cwd ?? repoRoot,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(baseline?.gate === undefined && execution === undefined
          ? {}
          : {
              env: {
                ...(execution?.environment ?? process.env),
                ...(baseline?.gate === undefined ? {} : { [OUTPUT_GATE_ENV]: JSON.stringify(baseline.gate) }),
              },
            }),
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const owned: OwnedProcessState | undefined =
      process.platform === 'win32' || child.pid === undefined
        ? undefined
        : { rootPid: child.pid, sampled: false, tracked: new Map() };
    let outputBytes = 0;
    let retainedOutputBytes = 0;
    const outputLimit = execution?.maxCapturedOutputBytes ?? 8 * 1024 * 1024;
    let sampledOutputBytes = 0;
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
          execution?.onCleanupFailure?.('Owned command pipes did not close; descendant cleanup could not be verified.');
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
      execution?.onCaptured?.(outputBytes);
      if (
        execution !== undefined &&
        resourceBounds?.maxNewOutputBytes !== undefined &&
        outputBytes + sampledOutputBytes > resourceBounds.maxNewOutputBytes
      ) {
        stop('source-phase captured output exceeded remaining cumulative allowance');
        return;
      }
      if (outputBytes > outputLimit) {
        const remaining = outputLimit - retainedOutputBytes;
        if (remaining > 0) {
          chunks.push(Buffer.from(chunk.subarray(0, remaining)));
          retainedOutputBytes += Math.min(remaining, chunk.length);
        }
        stop(
          execution?.maxCapturedOutputBytes === undefined
            ? 'captured output exceeded 8 MiB'
            : `captured output exceeded ${outputLimit} bytes`,
        );
        return;
      }
      chunks.push(chunk);
      retainedOutputBytes += chunk.length;
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
            const result = sampleOwnedTree(
              owned,
              repoRoot,
              resourceBounds,
              baseline,
              undefined,
              execution === undefined ? 0 : process.memoryUsage().rss,
              execution?.includeControllerTree,
            );
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
              sampledOutputBytes = bytes;
              const result = sampleOwnedTree(
                owned,
                repoRoot,
                resourceBounds,
                baseline,
                bytes + (execution === undefined ? 0 : outputBytes),
                execution === undefined ? 0 : process.memoryUsage().rss,
                execution?.includeControllerTree,
              );
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
              baseline === undefined
                ? undefined
                : (await positiveNewOutputBytes(baseline, scanCancellation.signal)) +
                    (execution === undefined ? 0 : outputBytes),
              execution === undefined ? 0 : process.memoryUsage().rss,
              execution?.includeControllerTree,
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
        if (cleanupFailure !== undefined) execution?.onCleanupFailure?.(cleanupFailure);
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
  if (existsSync(join(common, 'ai-delivery', 'merges', String(input.issueNumber), `${coordinate(root).sha}.json`))) {
    throw new DeliveryError(
      'Commit continuation work before verifying an already-merged issue head; retain its receipts.',
    );
  }
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

/** @internal Preservation-only read; the continuation owner validates custody and terminal lineage. */
export function loadHistoricalMergedRun(
  repoRoot: string,
  headSha: string,
): {
  run: VerificationRun;
  path: string;
} {
  const root = gitRoot(repoRoot);
  const common = gitCommonDir(root);
  const run = loadRun(common, headSha, root, true);
  const current = manifestPath(common, headSha, root);
  return { run, path: existsSync(current) ? current : manifestPath(common, headSha) };
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

const SourceDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const SourceSha = z.string().regex(/^[a-f0-9]{40}$/u);
const SourceArtifactSchema = z.strictObject({ path: z.string().min(1), digest: SourceDigest });
const SourceFileSchema = SourceArtifactSchema.extend({
  device: z.number().int().nonnegative().safe(),
  inode: z.number().int().nonnegative().safe(),
  uid: z.number().int().nonnegative().safe(),
  mode: z.number().int().nonnegative().safe(),
});
const SourceCommandSchema = z.strictObject({
  argv: z.array(z.string()).min(1),
  cwd: z.string().min(1),
  executable: SourceFileSchema,
});
const SourceSnapshotSchema = z.strictObject({
  head: SourceSha,
  indexTree: SourceSha,
  branch: z.string().min(1),
  configDigest: SourceDigest,
  dirty: z.array(z.strictObject({ path: z.string().min(1), digest: SourceDigest.nullable() })),
});
const SourceBoundsSchema = z.strictObject({
  maxAggregateRssBytes: z.number().int().positive().safe(),
  maxNewOutputBytes: z.number().int().positive().safe(),
  minFreeDiskBytes: z.number().int().positive().safe(),
  outputRoots: z.array(z.string().min(1)).min(1),
});
const SourceReconciliationSchema = z.strictObject({
  phaseId: SourceDigest,
  recordId: SourceDigest,
  baselineId: SourceDigest.optional(),
  authorizationDigest: SourceDigest,
});
const IssueSourcePhaseInputSchema = z.strictObject({
  repoRoot: z.string().min(1),
  issueNumber: z.number().int().positive().safe(),
  identity: z.string().min(1),
  rowDigest: SourceDigest,
  controller: z.strictObject({
    head: SourceSha,
    configDigest: SourceDigest,
    admissionId: SourceDigest,
    runtimeEntryPath: z.string().min(1),
    packageVersion: z.string().min(1),
    archiveDigest: SourceDigest,
  }),
  source: SourceSnapshotSchema.extend({
    path: z.string().min(1),
    effect: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('preserve') }),
      z.strictObject({
        kind: z.literal('commitOnce'),
        parent: SourceSha,
        tree: SourceSha,
        configDigest: SourceDigest.optional(),
      }),
    ]),
  }),
  caller: SourceArtifactSchema,
  authorization: SourceArtifactSchema,
  inputs: z.array(SourceArtifactSchema),
  commands: z.array(SourceCommandSchema).min(1),
  commandGraphDigest: SourceDigest,
  environment: z.strictObject({ digest: SourceDigest, overrides: z.record(z.string(), z.string().nullable()) }),
  bounds: SourceBoundsSchema,
  completionArtifacts: z.array(z.string().min(1)),
  reconciliation: SourceReconciliationSchema.optional(),
});
const SourceBindingSchema = IssueSourcePhaseInputSchema.omit({ environment: true }).extend({
  environmentDigest: SourceDigest,
});
const SourcePhaseBaselineSchema = z.strictObject({
  roots: z.array(z.string().min(1)).min(1),
  files: z.array(z.tuple([z.string(), z.number().int().nonnegative().safe()])),
  links: z.array(
    z.tuple([z.string(), z.strictObject({ identity: z.string(), target: z.string(), missing: z.boolean() })]),
  ),
  baselineId: SourceDigest,
});
const SourcePhaseCommandResultSchema = z.strictObject({
  index: z.number().int().nonnegative().safe(),
  outputDigest: SourceDigest.nullable(),
  outputBytes: z.number().int().nonnegative().safe(),
  status: z.enum(['complete', 'failed']),
});
const SourcePhaseResultSchema = z.strictObject({
  source: SourceSnapshotSchema,
  artifacts: z.array(SourceFileSchema),
  newOutputBytes: z.number().int().nonnegative().safe(),
  writerReleased: z.literal(true),
  lockReleased: z.literal(true),
});
const SourcePhaseRecordSchema = z
  .strictObject({
    schemaVersion: z.literal('ai-delivery.source-phase@1'),
    phaseId: SourceDigest,
    recordId: SourceDigest,
    worktreeDigest: SourceDigest,
    bindingDigest: SourceDigest,
    authorizationDigest: SourceDigest,
    status: z.enum(['preparing', 'intent', 'complete', 'failed-quiescent', 'rejected-before-work', 'unresolved']),
    writerId: z.uuid(),
    binding: SourceBindingSchema.optional(),
    baseline: SourcePhaseBaselineSchema.optional(),
    allocation: SourceBoundsSchema.optional(),
    owner: z.strictObject({ pid: z.number().int().positive().safe(), identity: z.string().min(1) }),
    bootstrapFiles: z.array(z.tuple([z.string(), z.number().int().nonnegative().safe()])),
    bootstrapBytes: z.number().int().nonnegative().safe(),
    capturedBytes: z.number().int().nonnegative().safe(),
    nextCommandIndex: z.number().int().nonnegative().safe(),
    commands: z.array(SourcePhaseCommandResultSchema),
    claimDigest: SourceDigest.optional(),
    releaseDigest: SourceDigest.optional(),
    preparationArtifact: SourceFileSchema.optional(),
    writerArtifact: SourceFileSchema.optional(),
    producerDigest: SourceDigest.optional(),
    actor: z
      .strictObject({
        identity: z.string().min(1),
        actorLogin: z.string().min(1),
        credentialIdentity: z.string().min(1),
      })
      .optional(),
    retainedArtifacts: z.array(SourceFileSchema).optional(),
    retainedPredecessors: z.array(z.strictObject({ phaseId: SourceDigest, recordId: SourceDigest })),
    reconciliation: SourceReconciliationSchema.optional(),
    result: SourcePhaseResultSchema.optional(),
    failure: z
      .strictObject({
        operation: z.string().optional(),
        accounting: z.string().optional(),
        cleanup: z.string().optional(),
        writerRelease: z.string().optional(),
        lockRelease: z.string().optional(),
      })
      .optional(),
  })
  .superRefine((record, context) => {
    const { recordId, ...content } = record;
    if (recordId !== digestValue(content) || record.phaseId !== record.bindingDigest)
      context.addIssue({ code: 'custom', message: 'Source-phase record identity is invalid.' });
    if (record.binding !== undefined && digestValue(record.binding) !== record.bindingDigest)
      context.addIssue({ code: 'custom', message: 'Source-phase input binding is invalid.' });
    if (record.baseline !== undefined) {
      const { baselineId, ...baseline } = record.baseline;
      if (baselineId !== digestValue(baseline))
        context.addIssue({ code: 'custom', message: 'Source-phase baseline is invalid.' });
    }
    if (
      record.status === 'rejected-before-work' &&
      (record.commands.length !== 0 || record.nextCommandIndex !== 0 || record.capturedBytes !== 0)
    )
      context.addIssue({ code: 'custom', message: 'Rejected source-phase input cannot contain executed work.' });
    if (
      record.status === 'complete' &&
      (record.result === undefined ||
        record.baseline === undefined ||
        record.binding === undefined ||
        record.failure !== undefined)
    )
      context.addIssue({ code: 'custom', message: 'Source-phase completion is incomplete.' });
    if (
      record.status === 'complete' &&
      (record.commands.length !== record.binding?.commands.length ||
        record.nextCommandIndex !== record.commands.length ||
        record.commands.some((command, index) => command.index !== index || command.status !== 'complete'))
    )
      context.addIssue({
        code: 'custom',
        message: 'Source-phase completion does not contain its exact successful command graph.',
      });
  });

async function assertNoUnsealedSourcePhase(common: string, subject: string, refuseUnresolved = false): Promise<void> {
  const directory = join(common, 'ai-delivery', 'receipts', 'source-phase@1', subject.slice(7));
  let names: string[];
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new DeliveryError('Source-phase admission metadata is not a canonical directory.');
    names = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (names.length > 100_000) throw new DeliveryError('Source-phase admission exceeded its entry bound.');
  for (const name of names) {
    const record = SourcePhaseRecordSchema.parse(JSON.parse(assertPrivateFile(join(directory, name)).toString('utf8')));
    if (record.worktreeDigest !== subject || name !== `${record.phaseId.slice(7)}.json`)
      throw new DeliveryError('Source-phase admission record belongs to another input or worktree.');
    if (record.status === 'preparing' || record.status === 'intent')
      throw new DeliveryError('An unsealed source phase still excludes another worktree writer.');
    if (refuseUnresolved && record.status === 'unresolved')
      throw new DeliveryError('Unresolved source phase requires owning reconciliation before another attempt.');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export type IssueSourcePhaseInput = z.input<typeof IssueSourcePhaseInputSchema> & { signal?: AbortSignal };
export interface IssueSourcePhaseContext {
  readonly phaseId: string;
  readonly signal: AbortSignal;
  readonly source: Readonly<Omit<z.infer<typeof SourceSnapshotSchema>, 'dirty'>> & {
    readonly dirty: readonly Readonly<{ path: string; digest: string | null }>[];
  };
  readonly controller: Readonly<z.infer<typeof IssueSourcePhaseInputSchema>['controller']>;
  readonly actor: Readonly<{ identity: string; actorLogin: string; credentialIdentity: string }>;
  readonly inputs: readonly Readonly<z.infer<typeof SourceArtifactSchema>>[];
  readonly run: (index: number) => Promise<Buffer>;
}
const IssueSourcePhaseReceiptSchema = z.strictObject({
  status: z.literal('complete'),
  phaseId: SourceDigest,
  recordId: SourceDigest,
  source: SourceSnapshotSchema,
  commands: z.array(SourcePhaseCommandResultSchema),
});
export type IssueSourcePhaseReceipt = z.infer<typeof IssueSourcePhaseReceiptSchema>;

function sourceFile(path: string): z.infer<typeof SourceFileSchema> {
  const stat = lstatSync(path);
  if (!stat.isFile() || realpathSync(path) !== path)
    throw new DeliveryError('Source-phase artifact must be a canonical regular file.');
  const descriptor = openSync(path, 'r');
  const hash = createHash('sha256');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let bytes: number;
    while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
    const current = fstatSync(descriptor);
    const named = lstatSync(path);
    if (
      current.dev !== stat.dev ||
      current.ino !== stat.ino ||
      current.size !== stat.size ||
      current.mode !== stat.mode ||
      current.uid !== stat.uid ||
      current.mtimeMs !== stat.mtimeMs ||
      current.ctimeMs !== stat.ctimeMs ||
      named.dev !== current.dev ||
      named.ino !== current.ino ||
      realpathSync(path) !== path
    )
      throw new DeliveryError('Source-phase artifact changed during identity-bound hashing.');
  } finally {
    closeSync(descriptor);
  }
  return {
    path,
    digest: `sha256:${hash.digest('hex')}`,
    device: stat.dev,
    inode: stat.ino,
    uid: stat.uid,
    mode: stat.mode,
  };
}

function sourceDirty(root: string): z.infer<typeof SourceSnapshotSchema>['dirty'] {
  const paths = [
    ...new Set(
      [
        ...git(root, 'diff', '--cached', '--name-only', '-z').split('\0'),
        ...git(root, 'ls-files', '-m', '-o', '--exclude-standard', '-z').split('\0'),
      ].filter(Boolean),
    ),
  ].sort();
  return paths.map((path) => {
    const absolute = resolve(root, path);
    if (!absolute.startsWith(`${root}${sep}`)) throw new DeliveryError('Source-phase dirty path escapes the worktree.');
    try {
      lstatSync(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, digest: null };
      throw error;
    }
    return { path, digest: sourceFile(absolute).digest };
  });
}

function sourceReceipt(record: z.infer<typeof SourcePhaseRecordSchema>): IssueSourcePhaseReceipt {
  if (record.status !== 'complete' || record.result === undefined)
    throw new DeliveryError('Source phase is not complete.');
  return IssueSourcePhaseReceiptSchema.parse({
    status: 'complete',
    phaseId: record.phaseId,
    recordId: record.recordId,
    source: record.result.source,
    commands: record.commands,
  });
}

/** Run an authorized, frozen source graph under the registered issue's existing writer fence. */
export async function withIssueSourcePhase(
  supplied: IssueSourcePhaseInput,
  operation: (context: IssueSourcePhaseContext) => Promise<void>,
): Promise<IssueSourcePhaseReceipt> {
  const { signal, ...values } = supplied;
  const input = IssueSourcePhaseInputSchema.parse(values);
  assertResourceBounds(input.bounds);
  if (signal?.aborted) throw new DeliveryError('Source phase cancelled before preparation.');
  const root = gitRoot(input.repoRoot);
  if (
    root !== input.repoRoot ||
    root !== primaryRoot(root) ||
    realpathSync(input.source.path) !== input.source.path ||
    gitCommonDir(root) !== gitCommonDir(input.source.path)
  )
    throw new DeliveryError('Source phase requires canonical primary controller and issue worktree roots.');
  const row = getIssueWorktreeStrict(input.issueNumber, root);
  assertAiDeliveryWorktreeOwner(row, root);
  if (
    !row.identity ||
    row.path !== input.source.path ||
    row.branch !== input.source.branch ||
    !['active', 'pr-published'].includes(row.status) ||
    digestValue(row) !== input.rowDigest
  )
    throw new DeliveryError('Source phase disagrees with the exact registered issue owner.');
  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment[OUTPUT_GATE_ENV];
  for (const [name, value] of Object.entries(input.environment.overrides)) {
    if (name === OUTPUT_GATE_ENV) throw new DeliveryError('Source phase cannot supply an output observer capability.');
    if (value === null) delete environment[name];
    else environment[name] = value;
  }
  Object.freeze(environment);
  const { environment: _environment, ...bound } = input;
  const binding = SourceBindingSchema.parse({ ...bound, environmentDigest: input.environment.digest });
  const phaseId = digestValue(binding);
  const subject = worktreeDigest(row.path);
  const common = gitCommonDir(root);
  const directory = join(common, 'ai-delivery', 'receipts', 'source-phase@1', subject.slice(7));
  const path = join(directory, `${phaseId.slice(7)}.json`);
  const writerPath = join(common, 'ai-delivery', 'writers@1', `${subject.slice(7)}.json`);
  const roots = input.bounds.outputRoots.map((value) => resolve(root, value)).sort();
  if (
    roots.some(
      (value, index) => index > 0 && (value === roots[index - 1] || value.startsWith(`${roots[index - 1]}${sep}`)),
    )
  )
    throw new DeliveryError('Source-phase output roots must not overlap.');
  for (const required of [
    directory,
    writerPath,
    join(common, 'ai-delivery', 'receipts'),
    join(common, 'ai-delivery', 'output-observation', subject.slice(7)),
  ]) {
    if (!roots.some((value) => required === value || required.startsWith(`${value}${sep}`)))
      throw new DeliveryError('Source-phase roots must account for writer, observer and SDK receipt metadata.');
  }
  const cancelled = new AbortController();
  const combined = signal === undefined ? cancelled.signal : AbortSignal.any([signal, cancelled.signal]);
  type PhaseRecord = z.infer<typeof SourcePhaseRecordSchema>;
  let record: PhaseRecord | undefined;
  let baseline: OutputBaseline | undefined;
  let reused = false;
  let created = false;
  let entered = false;
  let startedCommand = false;
  let validated = false;
  let writerReleased = false;
  let lockFailure: string | undefined;
  let releaseFailure: string | undefined;
  let operationFailure: string | undefined;
  let accountingFailure: string | undefined;
  let cleanupFailure: string | undefined;
  let active: Promise<Buffer> | undefined;
  let expired = false;
  let captured = 0;
  let bootstrapCharge = 0;
  let previousBootstrap = 0;
  let writerBootstrap = 0;
  let predecessorChain: PhaseRecord[] = [];
  let accountingBounds = input.bounds;
  let protocolFailure: string | undefined;
  let commandFailure: string | undefined;
  const attempted = new Set<number>();
  let finalSource: z.infer<typeof SourceSnapshotSchema> | undefined;
  let artifacts: z.infer<typeof SourceFileSchema>[] = [];
  let newBytes = 0;
  const writerId = randomUUID();
  const started = Date.now();
  const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
  const persist = (): void => {
    if (record === undefined) throw new DeliveryError('Source-phase intent is unavailable.');
    const { recordId: _recordId, ...content } = record;
    record = SourcePhaseRecordSchema.parse({ ...content, recordId: digestValue(content) });
    writePrivateJsonFileAtomically(path, record);
  };
  const readRecord = (file: string): PhaseRecord => {
    const value = SourcePhaseRecordSchema.parse(JSON.parse(assertPrivateFile(file).toString('utf8')));
    if (value.worktreeDigest !== subject || basename(file) !== `${value.phaseId.slice(7)}.json`)
      throw new DeliveryError('Source-phase record belongs to another input or worktree.');
    return value;
  };
  const assertArtifact = (artifact: z.infer<typeof SourceArtifactSchema>): void => {
    if (sourceFile(artifact.path).digest !== artifact.digest)
      throw new DeliveryError('Frozen source-phase input artifact changed.');
  };
  const sourceState = async (allowFinal = false): Promise<z.infer<typeof SourceSnapshotSchema>> => {
    const head = git(row.path, 'rev-parse', 'HEAD');
    const branch = git(row.path, 'branch', '--show-current');
    const dirty = sourceDirty(row.path);
    const candidate = await loadDeliveryConfig(row.path);
    const configDigest =
      head === input.source.head || input.source.effect.kind !== 'commitOnce'
        ? input.source.configDigest
        : (input.source.effect.configDigest ?? input.source.configDigest);
    if (branch !== input.source.branch || candidate.configDigest !== configDigest)
      throw new DeliveryError('Source-phase candidate branch or configuration changed.');
    if (head === input.source.head) {
      if (
        git(row.path, 'diff', '--cached', '--name-only', input.source.indexTree) !== '' ||
        digestValue(dirty) !== digestValue(input.source.dirty)
      )
        throw new DeliveryError('Source-phase frozen index or dirty source changed.');
      return { head, branch, indexTree: input.source.indexTree, configDigest: candidate.configDigest, dirty };
    }
    if (!allowFinal) throw new DeliveryError('Source phase requires its exact initial source before new work.');
    if (
      input.source.effect.kind !== 'commitOnce' ||
      input.source.effect.parent !== input.source.head ||
      git(row.path, 'rev-list', '--parents', '-n', '1', head) !== `${head} ${input.source.effect.parent}` ||
      git(row.path, 'rev-parse', 'HEAD^{tree}') !== input.source.effect.tree ||
      git(row.path, 'diff', '--cached', '--name-only', head) !== '' ||
      dirty.length !== 0
    )
      throw new DeliveryError('Source-phase commit does not match its exact parent, tree and clean postconditions.');
    return { head, branch, indexTree: input.source.effect.tree, configDigest: candidate.configDigest, dirty };
  };
  let actor: z.infer<typeof SourcePhaseRecordSchema>['actor'];
  const validate = async (allowFinal = false): Promise<void> => {
    const currentRow = getIssueWorktreeStrict(input.issueNumber, root);
    assertAiDeliveryWorktreeOwner(currentRow, root);
    const configuration = await loadDeliveryConfig(root);
    const admission = await assertDeliveryRuntimeAdmitted({
      repoRoot: root,
      runtimeEntryPath: input.controller.runtimeEntryPath,
      configuration,
    });
    if (
      dirname(realpathSync(input.controller.runtimeEntryPath)) !== dirname(realpathSync(fileURLToPath(import.meta.url)))
    )
      throw new DeliveryError('Source-phase executing SDK installation is not the selected admitted runtime.');
    if (
      digestValue(currentRow) !== input.rowDigest ||
      currentRow.identity !== row.identity ||
      configuration.config.roles.author.identity !== input.identity ||
      git(root, 'rev-parse', 'HEAD') !== input.controller.head ||
      configuration.configDigest !== input.controller.configDigest ||
      admission.admissionId !== input.controller.admissionId ||
      admission.sourceArchiveSha256 !== input.controller.archiveDigest ||
      admission.packageVersion !== input.controller.packageVersion ||
      digestValue(environment) !== input.environment.digest ||
      digestValue(input.commands) !== input.commandGraphDigest
    )
      throw new DeliveryError(
        'Source-phase controller, selected runtime, actor or command environment binding changed.',
      );
    const clients = await createDeliveryGitHubClients({
      config: configuration.config,
      identity: input.identity,
      role: 'author',
      env: environment,
    });
    if (clients.role !== 'author' || clients.authenticatedAuthor === undefined)
      throw new DeliveryError('Source-phase configured author authentication is unavailable.');
    const authenticated = await clients.authenticatedAuthor();
    if (!authenticated.actorLogin || !authenticated.credentialIdentity)
      throw new DeliveryError('Source-phase configured author identity readback is incomplete.');
    const currentActor = { identity: input.identity, ...authenticated };
    if (actor !== undefined && digestValue(actor) !== digestValue(currentActor))
      throw new DeliveryError('Source-phase authenticated author changed.');
    actor = currentActor;
    for (const artifact of [input.caller, input.authorization, ...input.inputs]) assertArtifact(artifact);
    for (const command of input.commands) {
      if (
        command.cwd !== row.path ||
        command.argv[0] !== command.executable.path ||
        digestValue(sourceFile(command.executable.path)) !== digestValue(command.executable)
      )
        throw new DeliveryError('Source-phase command or executable identity changed.');
    }
    await sourceState(allowFinal);
  };
  const observe = async (finishing = false): Promise<void> => {
    if (baseline === undefined) throw new DeliveryError('Source-phase output baseline is unavailable.');
    assertDiskHeadroom(row.path, accountingBounds, baseline);
    newBytes = bootstrapCharge + captured + (await positiveNewOutputBytes(baseline, finishing ? undefined : combined));
    if (newBytes > accountingBounds.maxNewOutputBytes)
      throw new DeliveryError('Source-phase cumulative output exceeded its original allowance.');
    if (process.memoryUsage().rss > accountingBounds.maxAggregateRssBytes)
      throw new DeliveryError('Source-phase controller RSS exceeded its bound.');
  };
  try {
    await withVerificationWriter(
      row.path,
      async (writer) => {
        try {
          ensurePrivateDirectoryDurably(directory);
          if (created && record !== undefined) {
            record.binding = binding;
            record.allocation = input.bounds;
          }
          const names = readdirSync(directory);
          if (names.length > 100_000)
            throw new DeliveryError('Source-phase record observation exceeded its entry bound.');
          const history = names
            .map((name) => readRecord(join(directory, name)))
            .filter((value) => value.phaseId !== phaseId);
          if (history.some((value) => ['preparing', 'intent', 'unresolved'].includes(value.status)))
            throw new DeliveryError('Unresolved source phase requires owning reconciliation before another attempt.');
          const previous =
            input.reconciliation === undefined
              ? undefined
              : history.find(
                  (value) =>
                    value.phaseId === input.reconciliation?.phaseId && value.recordId === input.reconciliation.recordId,
                );
          const failed = history.filter(
            (value) =>
              ['failed-quiescent', 'rejected-before-work'].includes(value.status) &&
              !history.some((later) =>
                later.retainedPredecessors.some(
                  (retained) => retained.phaseId === value.phaseId && retained.recordId === value.recordId,
                ),
              ),
          );
          predecessorChain = [];
          const visiting = new Set<PhaseRecord>();
          const retained = new Set<PhaseRecord>();
          const retain = (value: PhaseRecord): void => {
            if (visiting.has(value)) throw new DeliveryError('Source-phase predecessor cycle is invalid.');
            if (retained.has(value)) return;
            visiting.add(value);
            predecessorChain.push(value);
            for (const link of value.retainedPredecessors) {
              const predecessor = history.find(
                (candidate) => candidate.phaseId === link.phaseId && candidate.recordId === link.recordId,
              );
              if (predecessor === undefined)
                throw new DeliveryError('Source-phase retained predecessor is unavailable.');
              retain(predecessor);
            }
            visiting.delete(value);
            retained.add(value);
          };
          for (const value of failed) retain(value);
          if (record !== undefined && created)
            record.retainedPredecessors = failed.map(({ phaseId: retainedPhaseId, recordId }) => ({
              phaseId: retainedPhaseId,
              recordId,
            }));
          previousBootstrap = predecessorChain.reduce((sum, value) => sum + value.bootstrapBytes, 0);
          captured = predecessorChain.reduce((sum, value) => sum + value.capturedBytes, 0);
          const allocations = predecessorChain.map((value) => {
            if (value.allocation === undefined)
              throw new DeliveryError('Source-phase retained predecessor lacks its original allocation.');
            return value.allocation;
          });
          const allocation = { ...(allocations[0] ?? input.bounds) };
          for (const value of allocations) {
            allocation.maxAggregateRssBytes = Math.min(allocation.maxAggregateRssBytes, value.maxAggregateRssBytes);
            allocation.maxNewOutputBytes = Math.min(allocation.maxNewOutputBytes, value.maxNewOutputBytes);
            allocation.minFreeDiskBytes = Math.max(allocation.minFreeDiskBytes, value.minFreeDiskBytes);
          }
          accountingBounds = {
            ...allocation,
            maxAggregateRssBytes: Math.min(allocation.maxAggregateRssBytes, input.bounds.maxAggregateRssBytes),
            maxNewOutputBytes: Math.min(allocation.maxNewOutputBytes, input.bounds.maxNewOutputBytes),
            minFreeDiskBytes: Math.max(allocation.minFreeDiskBytes, input.bounds.minFreeDiskBytes),
          };
          const priorBaselines = predecessorChain.flatMap((value) =>
            value.baseline === undefined ? [] : [value.baseline],
          );
          const prior = priorBaselines[0];
          if (created && record !== undefined) {
            record.allocation = allocation;
            if (prior !== undefined) {
              record.baseline = prior;
              baseline = {
                roots: prior.roots,
                files: new Map(prior.files),
                links: new Map(prior.links),
                baselineId: prior.baselineId,
              };
              for (const retained of [...predecessorChain, record])
                for (const [file, size] of retained.bootstrapFiles)
                  baseline.files.set(file, Math.max(baseline.files.get(file) ?? 0, size));
            }
            bootstrapCharge = previousBootstrap + record.bootstrapBytes;
          }
          if (allocations.some((value) => digestValue(value.outputRoots) !== digestValue(allocation.outputRoots))) {
            accountingFailure = 'Source-phase retained original output roots disagree.';
            throw new DeliveryError(accountingFailure);
          }
          if (
            input.bounds.maxNewOutputBytes > allocation.maxNewOutputBytes ||
            input.bounds.maxAggregateRssBytes > allocation.maxAggregateRssBytes ||
            input.bounds.minFreeDiskBytes < allocation.minFreeDiskBytes ||
            digestValue(input.bounds.outputRoots) !== digestValue(allocation.outputRoots)
          )
            throw new DeliveryError('Source-phase reconciliation cannot increase its original resource allowance.');
          if (
            failed.length > 0 &&
            (previous === undefined ||
              !predecessorChain.includes(previous) ||
              input.reconciliation?.authorizationDigest !== input.authorization.digest)
          )
            throw new DeliveryError('A failed source phase requires exact authorized retained-output reconciliation.');
          if (input.reconciliation !== undefined && (previous === undefined || !predecessorChain.includes(previous)))
            throw new DeliveryError('Source-phase reconciliation does not name its exact terminal predecessor.');
          if (
            prior !== undefined &&
            (priorBaselines.some((value) => value.baselineId !== prior.baselineId) ||
              input.reconciliation?.baselineId !== prior.baselineId ||
              digestValue(prior.roots) !== digestValue(roots))
          )
            throw new DeliveryError('Source-phase reconciliation cannot replace its original output baseline.');
          for (const retained of predecessorChain.filter((value) => value.status === 'failed-quiescent')) {
            const old = retained.binding;
            if (
              old === undefined ||
              digestValue(old.controller) !== digestValue(input.controller) ||
              digestValue(old.source) !== digestValue(input.source) ||
              old.repoRoot !== root ||
              old.issueNumber !== input.issueNumber ||
              old.rowDigest !== input.rowDigest ||
              old.identity !== input.identity ||
              old.inputs.some(
                (artifact) => !input.inputs.some((current) => digestValue(current) === digestValue(artifact)),
              )
            )
              throw new DeliveryError(
                'Source-phase reconciliation requires compatible source/runtime and retained frozen inputs.',
              );
            for (const artifact of [old.caller, old.authorization, ...old.inputs]) assertArtifact(artifact);
          }
          if (
            predecessorChain.some((retained) =>
              retained.retainedArtifacts?.some(
                (artifact) => digestValue(sourceFile(artifact.path)) !== digestValue(artifact),
              ),
            )
          )
            throw new DeliveryError('Source-phase retained output artifact identity changed before reconciliation.');
          await validate(!created);
          const executionProducer = producerDigest();
          if (
            predecessorChain.some(
              (value) =>
                value.status === 'failed-quiescent' &&
                (value.producerDigest !== executionProducer || digestValue(value.actor) !== digestValue(actor)),
            )
          )
            throw new DeliveryError(
              'Source-phase reconciliation requires its original authenticated actor and producer.',
            );
          if (!created) {
            record = readRecord(path);
            if (
              record.status !== 'complete' ||
              record.bindingDigest !== phaseId ||
              record.producerDigest !== executionProducer ||
              record.baseline === undefined ||
              record.result === undefined
            )
              throw new DeliveryError('Existing source phase is incomplete or belongs to another producer.');
            if (
              digestValue(actor) !== digestValue(record.actor) ||
              digestValue(await sourceState(true)) !== digestValue(record.result.source) ||
              record.result.artifacts.some(
                (artifact) => digestValue(sourceFile(artifact.path)) !== digestValue(artifact),
              )
            )
              throw new DeliveryError('Completed source-phase source or artifacts changed.');
            reused = true;
            return;
          }
          validated = true;
          if (record === undefined) throw new DeliveryError('Source phase lacks preparation intent.');
          record.binding = binding;
          record.producerDigest = executionProducer;
          record.actor = actor;
          await withOutputObservationGate(row.path, true, async (gate) => {
            const gatePath = gate === undefined ? undefined : join(gate.directory, 'gate.json');
            if (gatePath !== undefined) {
              const gateBytes = lstatSync(gatePath).size;
              record!.bootstrapBytes += gateBytes;
              record!.bootstrapFiles.push([gatePath, gateBytes]);
            }
            bootstrapCharge = previousBootstrap + record!.bootstrapBytes;
            const links: OutputBaseline['links'] = new Map();
            const files =
              prior === undefined
                ? await withOutputGateLock(gate, 'scan', () => scanOutputRoots(roots, links), combined)
                : new Map(prior.files);
            if (prior !== undefined) for (const [name, alias] of prior.links) links.set(name, alias);
            const content = { roots, files: [...files], links: [...links] };
            const persistedBaseline = prior ?? { ...content, baselineId: digestValue(content) };
            baseline = {
              roots,
              files,
              links,
              baselineId: persistedBaseline.baselineId,
              ...(gate === undefined ? {} : { gate }),
            };
            record!.baseline = persistedBaseline;
            for (const retained of [...predecessorChain, record!])
              for (const [file, size] of retained.bootstrapFiles)
                baseline.files.set(file, Math.max(baseline.files.get(file) ?? 0, size));
            record!.status = 'intent';
            persist();
            await observe();
            let callbackFailure: unknown;
            let callbackRejected = false;
            const run = (index: number): Promise<Buffer> => {
              if (expired) return Promise.reject(new DeliveryError('Source-phase command capability has expired.'));
              if (
                !Number.isSafeInteger(index) ||
                index !== record!.nextCommandIndex ||
                attempted.has(index) ||
                active !== undefined ||
                index >= input.commands.length
              ) {
                protocolFailure = 'Source-phase commands must be ordered, single-use and awaited.';
                cancelled.abort(new DeliveryError(protocolFailure));
                return Promise.reject(new DeliveryError(protocolFailure));
              }
              attempted.add(index);
              const command = input.commands[index]!;
              active = (async () => {
                let commandCaptured = 0;
                try {
                  await validate(true);
                  await observe();
                  writer.assertQuiescent();
                  startedCommand = true;
                  const output = await runStageCommand(
                    command.cwd,
                    command.argv,
                    combined,
                    (bytes, sample, reason) =>
                      reportVerificationProgress({
                        state: 'running',
                        stageId: 'source-phase',
                        completedStages: index,
                        remainingStages: input.commands.length - index,
                        reusedStages: 0,
                        elapsedMs: Date.now() - started,
                        capturedOutputBytes: bytes,
                        ...(sample === undefined ? {} : { sampledNewOutputBytes: sample.newOutputBytes }),
                        ...(reason === undefined ? {} : { reason }),
                      }),
                    { ...input.bounds, maxNewOutputBytes: input.bounds.maxNewOutputBytes - bootstrapCharge - captured },
                    baseline,
                    undefined,
                    writer,
                    {
                      environment,
                      onCaptured: (bytes) => {
                        commandCaptured = bytes;
                      },
                      onCleanupFailure: (reason) => {
                        cleanupFailure = reason;
                      },
                    },
                  );
                  record!.commands.push({
                    index,
                    outputDigest: digestBytes(output),
                    outputBytes: output.length,
                    status: 'complete',
                  });
                  record!.nextCommandIndex += 1;
                  return output;
                } catch (error) {
                  commandFailure = message(error);
                  record!.commands.push({ index, outputDigest: null, outputBytes: commandCaptured, status: 'failed' });
                  throw error;
                } finally {
                  captured += commandCaptured;
                  record!.capturedBytes += commandCaptured;
                  active = undefined;
                  persist();
                }
              })();
              return active;
            };
            entered = true;
            try {
              if (actor === undefined) throw new DeliveryError('Source-phase authenticated author is unavailable.');
              const source = await sourceState();
              await operation(
                Object.freeze({
                  phaseId,
                  signal: combined,
                  source: Object.freeze({
                    ...source,
                    dirty: Object.freeze(source.dirty.map((entry) => Object.freeze(entry))),
                  }),
                  controller: Object.freeze({ ...input.controller }),
                  actor: Object.freeze({ ...actor }),
                  inputs: Object.freeze(
                    [input.caller, input.authorization, ...input.inputs].map((artifact) =>
                      Object.freeze({ ...artifact }),
                    ),
                  ),
                  run,
                }),
              );
            } catch (error) {
              callbackRejected = true;
              callbackFailure = error;
            }
            expired = true;
            if (active !== undefined) {
              protocolFailure = 'Source-phase callback settled with an unawaited command.';
              cancelled.abort(new DeliveryError(protocolFailure));
              await active.catch(() => undefined);
            }
            if (callbackRejected) throw callbackFailure;
            if (protocolFailure !== undefined) throw new DeliveryError(protocolFailure);
            if (commandFailure !== undefined) throw new DeliveryError(commandFailure);
            if (combined.aborted) throw new DeliveryError('Source phase cancelled.');
            if (record!.nextCommandIndex !== input.commands.length)
              throw new DeliveryError('Source-phase callback did not complete its frozen graph.');
            await validate(true);
            finalSource = await sourceState(true);
            if (input.source.effect.kind === 'commitOnce' && finalSource.head === input.source.head)
              throw new DeliveryError('Source phase did not publish its required commit.');
            artifacts = input.completionArtifacts.map(sourceFile);
            writer.assertQuiescent();
            await observe();
          }).finally(() => {
            if (baseline !== undefined) delete baseline.gate;
          });
        } catch (error) {
          operationFailure = message(error);
        } finally {
          expired = true;
          if (active !== undefined) {
            cancelled.abort(new DeliveryError('Source phase is releasing its command capability.'));
            await active.catch((error) => {
              operationFailure ??= message(error);
            });
          }
          if (created && baseline !== undefined) {
            try {
              await observe(true);
            } catch (error) {
              accountingFailure = message(error);
            }
          }
        }
      },
      {
        repoRoot: root,
        worktreePath: row.path,
        writerId,
        beforeClaim: ({ previousBytes }) => {
          if (previousBytes !== undefined)
            throw new DeliveryError('Source phase requires an absent writer; it never recovers a prior command.');
        },
        recordClaim: (bytes) => {
          ensurePrivateDirectoryDurably(directory);
          if (existsSync(path)) return;
          created = true;
          writerBootstrap = bytes.length;
          const content = {
            schemaVersion: 'ai-delivery.source-phase@1' as const,
            phaseId,
            bindingDigest: phaseId,
            authorizationDigest: input.authorization.digest,
            worktreeDigest: subject,
            status: 'preparing' as const,
            writerId,
            bootstrapBytes: bytes.length,
            allocation: input.bounds,
            capturedBytes: 0,
            nextCommandIndex: 0,
            owner: (JSON.parse(bytes.toString('utf8')) as { owner: { pid: number; identity: string } }).owner,
            bootstrapFiles: [] as Array<[string, number]>,
            commands: [],
            retainedPredecessors: [],
            claimDigest: digestBytes(bytes),
            ...(input.reconciliation === undefined ? {} : { reconciliation: input.reconciliation }),
          };
          record = { ...content, recordId: digestValue(content) };
          persist();
          record.preparationArtifact = sourceFile(path);
          record.bootstrapFiles.push([path, lstatSync(path).size]);
          for (let index = 0; index < 4; index++) {
            const size = Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`);
            record.bootstrapFiles[0] = [path, size];
            record.bootstrapBytes = writerBootstrap + size;
          }
          persist();
        },
        afterClaim: () => {
          if (record !== undefined && created) record.writerArtifact = sourceFile(writerPath);
        },
        recordRelease: (bytes) => {
          if (record !== undefined && !reused) record.releaseDigest = digestBytes(bytes);
        },
        afterRelease: () => {
          writerReleased = true;
        },
        onLockReleaseError: (error) => {
          lockFailure = message(error);
        },
        onLockCompromised: (error) => {
          lockFailure = message(error);
          cancelled.abort(error);
        },
      },
      common,
      true,
    );
  } catch (error) {
    releaseFailure = message(error);
  }
  if (
    reused &&
    record !== undefined &&
    writerReleased &&
    lockFailure === undefined &&
    releaseFailure === undefined &&
    operationFailure === undefined
  )
    return sourceReceipt(record);
  if (record === undefined || !created)
    throw new DeliveryError(operationFailure ?? releaseFailure ?? 'Source-phase ownership could not be established.');
  const failures = {
    ...(operationFailure === undefined ? {} : { operation: operationFailure }),
    ...(accountingFailure === undefined ? {} : { accounting: accountingFailure }),
    ...(cleanupFailure === undefined ? {} : { cleanup: cleanupFailure }),
    ...(writerReleased && releaseFailure === undefined
      ? {}
      : { writerRelease: releaseFailure ?? 'Writer absence was not confirmed.' }),
    ...(lockFailure === undefined ? {} : { lockRelease: lockFailure }),
  };
  const quiescent =
    writerReleased && releaseFailure === undefined && lockFailure === undefined && cleanupFailure === undefined;
  let unchanged = false;
  if (validated) {
    try {
      await validate(finalSource !== undefined);
      unchanged = (await sourceState(finalSource !== undefined)).head === input.source.head;
      if (
        finalSource !== undefined &&
        (existsSync(writerPath) ||
          artifacts.some((artifact) => digestValue(sourceFile(artifact.path)) !== digestValue(artifact)))
      )
        throw new DeliveryError('Source-phase writer absence or completion artifact changed before sealing.');
    } catch (error) {
      unchanged = false;
      if (finalSource !== undefined) failures.operation ??= message(error);
    }
  }
  const successful = Object.keys(failures).length === 0 && finalSource !== undefined;
  record.status = successful
    ? 'complete'
    : !entered && !startedCommand && quiescent && accountingFailure === undefined
      ? 'rejected-before-work'
      : quiescent && unchanged && accountingFailure === undefined && baseline !== undefined
        ? 'failed-quiescent'
        : 'unresolved';
  if (successful && finalSource !== undefined)
    record.result = {
      source: finalSource,
      artifacts,
      newOutputBytes: newBytes,
      writerReleased: true,
      lockReleased: true,
    };
  else record.failure = failures;
  if (record.status === 'failed-quiescent' && baseline !== undefined) {
    try {
      const files = scanOutputRoots(baseline.roots, new Map());
      record.retainedArtifacts = [...files]
        .filter(([file, bytes]) => file !== path && bytes > (baseline!.files.get(file) ?? 0))
        .map(([file]) => sourceFile(file));
    } catch (error) {
      record.status = 'unresolved';
      record.failure = { ...failures, accounting: message(error) };
    }
  }
  if (baseline !== undefined) {
    try {
      await observe(true);
      const originalSize = baseline.files.get(path) ?? 0;
      const currentGrowth = Math.max(0, lstatSync(path).size - originalSize);
      const observed = newBytes;
      let projected = observed;
      for (let index = 0; index < 4; index++) {
        if (record.result !== undefined) record.result.newOutputBytes = projected;
        const { recordId: _recordId, ...content } = record;
        record.recordId = digestValue(content);
        projected =
          observed -
          currentGrowth +
          Math.max(0, Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`) - originalSize);
      }
      if (projected > accountingBounds.maxNewOutputBytes)
        throw new DeliveryError('Source-phase final receipt exceeds its original output allowance.');
      if (record.result !== undefined) record.result.newOutputBytes = projected;
    } catch (error) {
      record.status = 'unresolved';
      delete record.result;
      record.failure = { ...failures, accounting: message(error) };
    }
  } else {
    for (let index = 0; index < 4; index++) {
      const size = Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`);
      record.bootstrapFiles[0] = [path, size];
      record.bootstrapBytes =
        writerBootstrap + size + record.bootstrapFiles.slice(1).reduce((sum, [, bytes]) => sum + bytes, 0);
    }
    if (previousBootstrap + record.bootstrapBytes + captured > accountingBounds.maxNewOutputBytes) {
      record.status = 'unresolved';
      record.failure = {
        ...failures,
        accounting: 'Retained rejected bootstrap exceeded the original output allowance.',
      };
      for (let index = 0; index < 4; index++) {
        const size = Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`);
        record.bootstrapFiles[0] = [path, size];
        record.bootstrapBytes =
          writerBootstrap + size + record.bootstrapFiles.slice(1).reduce((sum, [, bytes]) => sum + bytes, 0);
      }
    }
  }
  persist();
  if (record.status !== 'complete')
    throw new DeliveryError(
      `Source phase ${record.status}: ${operationFailure ?? accountingFailure ?? releaseFailure ?? lockFailure ?? failures.operation ?? 'postconditions failed'}.`,
      path,
    );
  return sourceReceipt(record);
}

/** @internal Runtime setup shares the existing writer, ownership handshake and bounded command runner. */
export async function withRuntimeSetupWriter<T>(
  root: string,
  operation: (runner: {
    assertQuiescent(): void;
    checkResources: () => Promise<void>;
    signal: AbortSignal;
    run(
      argv: readonly string[],
      bounds: VerificationResourceBounds,
      signal?: AbortSignal,
      environment?: NodeJS.ProcessEnv,
      cwd?: string,
    ): Promise<Buffer>;
  }) => Promise<T>,
  scope?: { bounds: VerificationResourceBounds; maxCapturedOutputBytes: number; signal?: AbortSignal },
): Promise<T> {
  const cancellation = new AbortController();
  const signal =
    scope?.signal === undefined ? cancellation.signal : AbortSignal.any([scope.signal, cancellation.signal]);
  let failure: Error | undefined;
  let baseline: OutputBaseline | undefined;
  let captured = 0;
  const started = Date.now();
  const guard = (): number => {
    if (failure !== undefined) throw failure;
    if (signal.aborted) throw new DeliveryError('Runtime setup cancelled.');
    const rss = scope === undefined ? 0 : controllerTreeRssBytes();
    if (scope !== undefined) {
      if (rss > scope.bounds.maxAggregateRssBytes)
        throw new DeliveryError(`Controller aggregate RSS ${rss} exceeded limit ${scope.bounds.maxAggregateRssBytes}.`);
      assertDiskHeadroom(root, scope.bounds, baseline);
    }
    return rss;
  };
  if (scope !== undefined) {
    assertResourceBounds(scope.bounds);
    if (
      !Number.isSafeInteger(scope.maxCapturedOutputBytes) ||
      scope.maxCapturedOutputBytes <= 0 ||
      scope.maxCapturedOutputBytes > 8 * 1024 ** 2
    )
      throw new DeliveryError('Invalid runtime setup captured-output bound; maximum is 8 MiB.');
    guard();
  }
  root = gitRoot(root);
  return withVerificationWriter(root, async (writer) =>
    withOutputObservationGate(root, scope !== undefined, async (scopeGate) => {
      if (scope !== undefined) {
        const paths = [...(scope.bounds.outputRoots ?? []), join(gitCommonDir(root), 'ai-delivery')]
          .map((path) => resolve(root, path))
          .sort();
        const roots = paths.filter(
          (path, index) => !paths.slice(0, index).some((prior) => path === prior || path.startsWith(`${prior}${sep}`)),
        );
        const links: OutputBaseline['links'] = new Map();
        const files = await withOutputGateLock(scopeGate, 'scan', () => scanOutputRoots(roots, links), signal);
        baseline = {
          roots,
          links,
          files,
          baselineId: digestValue([...files]),
          ...(scopeGate === undefined ? {} : { gate: scopeGate }),
        };
      }
      const checkResources = async (): Promise<void> => {
        const rss = guard();
        if (scope === undefined || baseline === undefined) return;
        const newOutputBytes = captured + (await positiveNewOutputBytes(baseline, signal));
        guard();
        if (newOutputBytes > scope.bounds.maxNewOutputBytes!)
          throw new DeliveryError(
            `Runtime setup output ${newOutputBytes} exceeded limit ${scope.bounds.maxNewOutputBytes!}.`,
          );
        reportVerificationProgress({
          state: 'running',
          stageId: 'runtime-setup',
          completedStages: 0,
          reusedStages: 0,
          remainingStages: 1,
          elapsedMs: Date.now() - started,
          capturedOutputBytes: captured,
          sampledAggregateRssBytes: rss,
          sampledFreeDiskBytes: freeDiskBytes(root, baseline),
          sampledNewOutputBytes: newOutputBytes,
        });
      };
      await checkResources();
      const timer =
        scope === undefined
          ? undefined
          : setInterval(() => {
              try {
                guard();
              } catch (error) {
                failure ??= error instanceof Error ? error : new DeliveryError(String(error));
                cancellation.abort();
              }
            }, 1_000);
      timer?.unref();
      try {
        const result = await operation({
          assertQuiescent: () => writer.assertQuiescent(),
          checkResources,
          signal,
          run: async (argv, bounds, commandSignal, environment, cwd) => {
            await checkResources();
            assertResourceBounds(bounds);
            const roots = bounds.outputRoots?.map((path) => resolve(root, path)).sort();
            if (roots !== undefined) {
              for (let i = 1; i < roots.length; i++)
                if (roots[i] === roots[i - 1] || roots[i]!.startsWith(`${roots[i - 1]}${sep}`))
                  throw new DeliveryError('Filesystem output roots must not overlap.');
            }
            const run = async (gate: OutputGate | undefined): Promise<Buffer> => {
              const links: OutputBaseline['links'] = new Map();
              const files =
                roots === undefined
                  ? undefined
                  : await withOutputGateLock(gate, 'scan', () => scanOutputRoots(roots, links), signal);
              const commandBaseline =
                roots === undefined || files === undefined
                  ? undefined
                  : {
                      roots,
                      files,
                      links,
                      baselineId: digestValue([...files]),
                      ...(gate === undefined ? {} : { gate }),
                    };
              assertDiskHeadroom(root, bounds, commandBaseline);
              let commandCaptured = 0;
              const output = await runStageCommand(
                root,
                argv,
                commandSignal === undefined ? signal : AbortSignal.any([signal, commandSignal]),
                (capturedOutputBytes, sample, reason) =>
                  reportVerificationProgress({
                    state: 'running',
                    stageId: 'runtime-setup:install',
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
                commandBaseline,
                undefined,
                writer,
                scope === undefined && environment === undefined && cwd === undefined
                  ? undefined
                  : {
                      environment: environment ?? process.env,
                      ...(cwd === undefined ? {} : { cwd }),
                      ...(scope === undefined
                        ? {}
                        : { maxCapturedOutputBytes: scope.maxCapturedOutputBytes, includeControllerTree: true }),
                      onCaptured: (bytes) => {
                        captured += bytes - commandCaptured;
                        commandCaptured = bytes;
                      },
                    },
              );
              await checkResources();
              return output;
            };
            return scope === undefined ? withOutputObservationGate(root, roots !== undefined, run) : run(scopeGate);
          },
        });
        await checkResources();
        reportVerificationProgress({
          state: 'completed',
          stageId: 'runtime-setup',
          completedStages: 1,
          reusedStages: 0,
          remainingStages: 0,
          elapsedMs: Date.now() - started,
        });
        return result;
      } catch (error) {
        if (failure !== undefined)
          throw new DeliveryError(
            `${failure.message} Runtime setup operation failed (${error instanceof Error ? error.message : String(error)}).`,
          );
        if (signal.aborted)
          throw new DeliveryError(`Runtime setup cancelled. ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      } finally {
        if (timer !== undefined) clearInterval(timer);
      }
    }),
  );
}
