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
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { assertPrivateFile } from './delivery/common.js';
import { readRepositoryCommandOutput } from './delivery/stage.js';
import {
  createRepositoryStageAggregate,
  digestBytes,
  digestValue,
  RepositoryClassificationReceiptSchema,
  RepositoryStageAggregateSchema,
  RepositoryStageReceiptSchema,
  writeRepositoryCommandOutput,
  type RepositoryClassificationReceipt,
  type RepositoryStageAggregate,
  type RepositoryStageReceipt,
} from './delivery/legacy.js';
import { DeliveryError } from './errors.js';
import { gitCommonDir, gitRoot } from './git.js';
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

export interface OwnedProcessState {
  rootIdentity?: string;
  rootPid: number;
  sampled: boolean;
  tracked: Map<number, ObservedProcess>;
}

export function processSnapshot(): Map<number, ObservedProcess> {
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

export async function confirmOwnedCleanup(state: OwnedProcessState): Promise<void> {
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
export function terminateOwnedProcesses(state: OwnedProcessState): void {
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

export function runStageCommand(
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
    failedOutput?(bytes: Buffer): string;
    stdoutOnly?: boolean;
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
        if (execution?.failedOutput) return execution.failedOutput(bytes);
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
      resolve(execution?.stdoutOnly ? Buffer.concat(stdout) : Buffer.concat([...stdout, ...stderr], outputBytes));
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

const RuntimeOutputLedgerSchema = z
  .strictObject({
    schemaVersion: z.literal('ai-delivery.runtime-output@1'),
    stageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    worktreeDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    producerDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    limit: z
      .number()
      .int()
      .positive()
      .safe()
      .max(8 * 1024 ** 2),
    outputs: z
      .array(
        z.strictObject({
          digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
          bytes: z
            .number()
            .int()
            .nonnegative()
            .safe()
            .max(8 * 1024 ** 2),
          status: z.enum(['reserved', 'complete']),
        }),
      )
      .max(4096),
    contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  })
  .superRefine((value, context) => {
    const { contentDigest, ...content } = value;
    if (
      contentDigest !== digestValue(content) ||
      new Set(value.outputs.map((output) => output.digest)).size !== value.outputs.length ||
      value.outputs.reduce((total, output) => total + output.bytes, 0) > value.limit
    )
      context.addIssue({
        code: 'custom',
        message: 'Runtime retained-output ledger is corrupt.',
      });
  });

/** @internal Runtime setup shares the existing writer, ownership handshake and bounded command runner. */
export async function withRuntimeSetupWriter<T>(
  root: string,
  operation: (runner: {
    assertQuiescent(): void;
    bindCapturedOutput(stageId: string): void;
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
      let ledger: z.infer<typeof RuntimeOutputLedgerSchema> | undefined;
      let ledgerPath: string | undefined;
      const common = gitCommonDir(root);
      const saveLedger = (): void => {
        if (ledger === undefined || ledgerPath === undefined)
          throw new DeliveryError('Runtime output allowance is unbound.');
        const { contentDigest: _previous, ...content } = ledger;
        ledger = RuntimeOutputLedgerSchema.parse({
          ...content,
          contentDigest: digestValue(content),
        });
        if (Buffer.byteLength(JSON.stringify(ledger, null, 2)) > 1024 ** 2)
          throw new DeliveryError('Runtime retained-output ledger exceeds its evidence bound.');
        writePrivateJsonFileAtomically(ledgerPath, ledger);
      };
      const assertOutput = (output: z.infer<typeof RuntimeOutputLedgerSchema>['outputs'][number]): boolean => {
        try {
          const bytes = readRepositoryCommandOutput({
            gitCommonDir: common,
            digest: output.digest,
            expectedBytes: output.bytes,
          });
          if (bytes.length !== output.bytes) throw new DeliveryError('Runtime retained-output evidence size changed.');
          return true;
        } catch (error) {
          if (output.status === 'reserved' && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        }
      };
      const bindCapturedOutput = (stageId: string): void => {
        if (scope === undefined) return;
        if (ledger !== undefined) throw new DeliveryError('Runtime output allowance is already bound.');
        const identity = {
          stageId,
          worktreeDigest: worktreeDigest(root),
          producerDigest: producerDigest(),
          limit: scope.maxCapturedOutputBytes,
        };
        ledgerPath = join(
          common,
          'ai-delivery',
          'verification@1',
          'runtime-output',
          identity.worktreeDigest.slice(7),
          `${stageId.slice(7)}.json`,
        );
        let retained: Buffer | undefined;
        try {
          retained = assertPrivateFile(ledgerPath, { maxBytes: 1024 ** 2 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (retained !== undefined) {
          ledger = RuntimeOutputLedgerSchema.parse(JSON.parse(retained.toString('utf8')));
          if (
            ledger.stageId !== identity.stageId ||
            ledger.worktreeDigest !== identity.worktreeDigest ||
            ledger.producerDigest !== identity.producerDigest ||
            ledger.limit !== identity.limit
          )
            throw new DeliveryError('Runtime retained-output ledger belongs to an incompatible stage or controller.');
          let recovered = false;
          for (const output of ledger.outputs) {
            if (assertOutput(output) && output.status === 'reserved') {
              output.status = 'complete';
              recovered = true;
            }
          }
          if (recovered) saveLedger();
        } else {
          const content = {
            schemaVersion: 'ai-delivery.runtime-output@1' as const,
            ...identity,
            outputs: [],
          };
          ledger = RuntimeOutputLedgerSchema.parse({
            ...content,
            contentDigest: digestValue(content),
          });
          saveLedger();
        }
      };
      const remainingOutput = (): number => {
        if (scope === undefined) return 8 * 1024 ** 2;
        if (ledger === undefined) throw new DeliveryError('Runtime output allowance is unbound.');
        return ledger.limit - ledger.outputs.reduce((total, output) => total + output.bytes, 0);
      };
      const persistFailedOutput = (bytes: Buffer): string => {
        if (ledger === undefined) throw new DeliveryError('Runtime output allowance is unbound.');
        const digest = digestBytes(bytes);
        const prior = ledger.outputs.find((output) => output.digest === digest);
        if (prior !== undefined) {
          if (prior.bytes !== bytes.length || !assertOutput(prior))
            throw new DeliveryError(
              'Runtime retained-output reservation is unresolved; identical output cannot be rewritten.',
            );
          return ` Command output ${digest}.`;
        }
        if (bytes.length > remainingOutput()) throw new DeliveryError('Runtime retained-output allowance exceeded.');
        const output = {
          digest,
          bytes: bytes.length,
          status: 'reserved' as const,
        };
        ledger.outputs.push(output);
        saveLedger();
        writeRepositoryCommandOutput({ bytes, gitCommonDir: common });
        if (!assertOutput(output)) throw new DeliveryError('Runtime retained-output publication is unresolved.');
        ledger.outputs[ledger.outputs.length - 1]!.status = 'complete';
        saveLedger();
        return ` Command output ${digest}.`;
      };
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
          bindCapturedOutput,
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
              const remaining = remainingOutput();
              if (remaining <= 0)
                throw new DeliveryError('Runtime retained-output allowance is exhausted; installer was not started.');
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
                        : {
                            maxCapturedOutputBytes: remaining,
                            includeControllerTree: true,
                            failedOutput: persistFailedOutput,
                          }),
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
