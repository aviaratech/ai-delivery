import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';

import { assertPrivateFile, writeCreateOnly } from './delivery/common.js';
import { digestBytes, digestValue } from './delivery/index.js';
import { DeliveryError } from './errors.js';
import { assertClean, coordinate, gitCommonDir, gitRoot, primaryGitRoot } from './git.js';
import { evaluateCommandIdentityPolicy } from './github/commandIdentityPolicy.js';
import { loadDeliveryContext } from './issue.js';
import { preflightReviewRoute } from './pr.js';
import {
  buildRuntimeAdmission,
  RuntimeAdmissionSchema,
  validateRuntimeAdmission,
  type RuntimeAdmission,
} from './services/deliveryAdmission.js';
import { ensurePrivateDirectoryDurably, writePrivateJsonFileAtomically } from './utils/atomicJson.js';
import { withLock } from './utils/lockfile.js';
import { withRuntimeSetupWriter } from './verification.js';

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const StageBounds = z.strictObject({
  maxAggregateRssBytes: z.number().int().positive().safe(),
  minFreeDiskBytes: z.number().int().positive().safe(),
  maxNewOutputBytes: z.number().int().positive().safe(),
  maxCapturedOutputBytes: z
    .number()
    .int()
    .positive()
    .safe()
    .max(8 * 1024 ** 2),
});
const IntentSchema = z.strictObject({
  archivePath: z.string().min(1),
  archiveSha256: Digest,
  configDigest: Digest,
  packageVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
  repoRoot: z.string().min(1),
  repository: z.string().min(1),
  reviewRouteDigest: Digest,
  runtimeDirectory: z.string().min(1),
  nativePluginRoot: z.string().min(1).optional(),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  resourceBounds: StageBounds.optional(),
});
const StageSchema = z
  .strictObject({
    schemaVersion: z.literal('ai-delivery.runtime-stage@1'),
    stageId: Digest,
    intent: IntentSchema,
    directory: z.strictObject({ device: z.number().int(), inode: z.number().int() }),
    admission: RuntimeAdmissionSchema.optional(),
    status: z.enum(['incomplete', 'complete']),
    recordId: Digest,
  })
  .superRefine((value, context) => {
    const { recordId, ...content } = value;
    if (
      recordId !== digestValue(content) ||
      value.stageId !== digestValue(value.intent) ||
      (value.status === 'complete') !== (value.admission !== undefined) ||
      (value.admission !== undefined &&
        (value.admission.sourceCommit !== value.intent.sourceCommit ||
          value.admission.sourceArchiveSha256 !== value.intent.archiveSha256 ||
          value.admission.packageVersion !== value.intent.packageVersion ||
          value.admission.configDigest !== value.intent.configDigest ||
          value.admission.repository !== value.intent.repository ||
          value.admission.cliPath !==
            runtimePaths(value.intent.runtimeDirectory, value.intent.nativePluginRoot).cliPath ||
          value.admission.mcpLauncherPath !==
            runtimePaths(value.intent.runtimeDirectory, value.intent.nativePluginRoot).mcpLauncherPath ||
          value.admission.pluginManifestPath !==
            runtimePaths(value.intent.runtimeDirectory, value.intent.nativePluginRoot).pluginManifestPath))
    )
      context.addIssue({ code: 'custom', message: 'Runtime stage identity or completion is corrupt.' });
  });
type StageRecord = z.infer<typeof StageSchema>;

interface SetupControllerInput {
  repoRoot: string;
  identity: string;
  personalAuth?: boolean;
  expectedSourceCommit: string;
  expectedConfigDigest: string;
  runtimeDirectory: string;
}
export interface StageRuntimeInput extends SetupControllerInput {
  authority: 'runtime:stage';
  archivePath: string;
  expectedArchiveSha256: string;
  packageVersion: string;
  nativePluginRoot?: string;
  signal?: AbortSignal;
  resourceBounds?: {
    maxAggregateRssBytes: number;
    minFreeDiskBytes: number;
    maxNewOutputBytes: number;
    maxCapturedOutputBytes?: number;
  };
}
export interface AdmitRuntimeInput extends SetupControllerInput {
  authority: 'runtime:admit';
  stageId: string;
  expectedPriorAdmissionSha256: string | null;
}
export interface RuntimeStageResult {
  stageId: string;
  admission: RuntimeAdmission;
  reused: boolean;
  launch: { cli: { command: string; args: string[] }; mcp: { command: string; args: string[] } };
  reviewRoute: Awaited<ReturnType<typeof preflightReviewRoute>>;
}

/** Paths are explicit canonical locations; setup never traverses host aliases or current links. */
function canonicalPath(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw new DeliveryError('Runtime setup paths must be absolute and canonical.');
  const parts = path.split(sep).filter(Boolean);
  let parent: string = sep;
  for (const part of parts) {
    parent = join(parent, part);
    try {
      if (lstatSync(parent).isSymbolicLink()) throw new DeliveryError('Runtime setup path contains a symbolic link.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return path;
}
function runtimePaths(directory: string, nativePluginRoot?: string) {
  const packageRoot = join(directory, 'node_modules', '@aviaratech', 'ai-delivery');
  const pluginRoot = nativePluginRoot ?? join(packageRoot, 'plugins', 'ai-delivery');
  return {
    cliPath: nativePluginRoot ? join(pluginRoot, 'runtime', 'dist', 'cli.js') : join(packageRoot, 'dist', 'cli.js'),
    mcpLauncherPath: join(pluginRoot, 'dist', 'mcp-launcher.js'),
    pluginManifestPath: join(pluginRoot, '.claude-plugin', 'plugin.json'),
  };
}
function assertNativeLocation(directory: string, nativePluginRoot?: string): void {
  if (nativePluginRoot === undefined) return;
  canonicalPath(nativePluginRoot);
  if (
    nativePluginRoot === directory ||
    nativePluginRoot.startsWith(`${directory}${sep}`) ||
    directory.startsWith(`${nativePluginRoot}${sep}`)
  )
    throw new DeliveryError('Native plugin cache and owned runtime stage paths must not overlap.');
}
/** A cache is read-only: every built file must match the reviewed archive's installed plugin. */
function assertNativePlugin(intent: StageRecord['intent']): void {
  if (intent.nativePluginRoot === undefined) return;
  assertNativeLocation(intent.runtimeDirectory, intent.nativePluginRoot);
  const source = canonicalPath(
    join(intent.runtimeDirectory, 'node_modules/@aviaratech/ai-delivery/plugins/ai-delivery'),
  );
  let entries = 0;
  const compare = (reviewed: string, selected: string, depth: number): void => {
    if (depth > 16 || ++entries > 4096)
      throw new DeliveryError('Native plugin inventory exceeds the reviewed layout bound.');
    const expected = lstatSync(reviewed);
    const actual = lstatSync(selected);
    if (expected.isDirectory() && actual.isDirectory()) {
      const names = readdirSync(reviewed).sort();
      if (JSON.stringify(names) !== JSON.stringify(readdirSync(selected).sort()))
        throw new DeliveryError('Selected native plugin inventory disagrees with reviewed archive bytes.');
      for (const name of names) compare(join(reviewed, name), join(selected, name), depth + 1);
    } else if (
      !expected.isFile() ||
      !actual.isFile() ||
      expected.nlink !== 1 ||
      actual.nlink !== 1 ||
      expected.size !== actual.size ||
      !readFileSync(reviewed).equals(readFileSync(selected))
    )
      throw new DeliveryError('Selected native plugin files disagree with reviewed archive bytes.');
  };
  try {
    compare(source, intent.nativePluginRoot, 0);
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    throw new DeliveryError('Selected native plugin cannot be matched to reviewed archive bytes.');
  }
}
function assertArchive(path: string, expected: string): Buffer {
  canonicalPath(path);
  Digest.parse(expected);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.nlink !== 1)
    throw new DeliveryError('Reviewed runtime archive bytes do not match the expected digest.');
  const bytes = readFileSync(path);
  if (digestBytes(bytes) !== expected)
    throw new DeliveryError('Reviewed runtime archive bytes do not match the expected digest.');
  return bytes;
}
function assertArchiveSnapshot(intent: StageRecord['intent']): string {
  const path = canonicalPath(join(intent.runtimeDirectory, 'reviewed-archive.tgz'));
  if (digestBytes(assertPrivateFile(path)) !== intent.archiveSha256)
    throw new DeliveryError('Runtime stage archive snapshot bytes changed.');
  return path;
}
async function controller(
  input: SetupControllerInput,
  command: 'runtime:stage' | 'runtime:admit',
  checkResources?: () => Promise<void>,
  signal?: AbortSignal,
) {
  await checkResources?.();
  if (typeof input.identity !== 'string' || !input.identity.trim())
    throw new DeliveryError('Runtime setup requires an explicit configured author identity.');
  const root = gitRoot(input.repoRoot);
  if (root !== primaryGitRoot(root))
    throw new DeliveryError('Runtime setup requires the primary consumer controller checkout.');
  assertClean(root);
  if (coordinate(root).sha !== input.expectedSourceCommit)
    throw new DeliveryError('Primary controller source commit changed.');
  canonicalPath(input.runtimeDirectory);
  const context = await loadDeliveryContext({
    identity: input.identity,
    repoRoot: root,
    role: 'author',
    ...(signal === undefined ? {} : { signal }),
    ...(input.personalAuth === undefined ? {} : { personalAuth: input.personalAuth }),
  });
  await checkResources?.();
  const policy = evaluateCommandIdentityPolicy({
    commandName: command,
    deliveryConfig: context.config,
    identity: input.identity,
    ...(input.personalAuth === undefined ? {} : { personalAuth: input.personalAuth }),
  });
  if (policy.error) throw new DeliveryError(policy.error);
  if (!context.configuration || context.configuration.configDigest !== input.expectedConfigDigest)
    throw new DeliveryError('Primary controller resolver config digest changed.');
  const reviewRoute = await preflightReviewRoute(
    context,
    undefined,
    undefined,
    'publication',
    checkResources === undefined || signal === undefined ? undefined : { signal, checkResources },
  );
  await checkResources?.();
  // Publication preflight requires the actual configured author credential, not a development override.
  assertClean(root);
  if (coordinate(root).sha !== input.expectedSourceCommit)
    throw new DeliveryError('Primary controller source commit changed during preflight.');
  return { root, configuration: context.configuration, reviewRoute };
}
function readStage(directory: string): StageRecord {
  canonicalPath(directory);
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || (metadata.mode & 0o777) !== 0o700)
    throw new DeliveryError('Runtime stage directory must be private and owned.');
  let record: StageRecord;
  try {
    record = StageSchema.parse(JSON.parse(assertPrivateFile(join(directory, 'runtime-stage.json')).toString('utf8')));
  } catch {
    throw new DeliveryError('Runtime stage is unowned, incompatible or corrupt.');
  }
  if (
    record.intent.runtimeDirectory !== directory ||
    metadata.dev !== record.directory.device ||
    metadata.ino !== record.directory.inode
  )
    throw new DeliveryError('Runtime stage directory ownership changed.');
  if (record.status === 'complete') {
    assertArchiveSnapshot(record.intent);
    assertNativePlugin(record.intent);
  }
  return record;
}
function writeStage(directory: string, content: Omit<StageRecord, 'recordId'>): StageRecord {
  const record = StageSchema.parse({ ...content, recordId: digestValue(content) });
  writePrivateJsonFileAtomically(join(directory, 'runtime-stage.json'), record);
  const readback = readStage(directory);
  if (readback.recordId !== record.recordId) throw new DeliveryError('Runtime stage completion readback changed.');
  return readback;
}
function syncDirectory(directory: string): void {
  const descriptor = openSync(directory, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
function durability(path: string): void {
  const bytes = assertPrivateFile(path);
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(dirname(path));
  if (!assertPrivateFile(path).equals(bytes))
    throw new DeliveryError('Runtime admission third-party replacement conflict.');
}
function stageResult(
  record: StageRecord,
  reviewRoute: RuntimeStageResult['reviewRoute'],
  reused: boolean,
): RuntimeStageResult {
  if (!record.admission) throw new DeliveryError('Runtime stage completion is missing.');
  return {
    stageId: record.stageId,
    admission: record.admission,
    reused,
    reviewRoute,
    launch: {
      cli: { command: process.execPath, args: [record.admission.cliPath] },
      mcp: { command: process.execPath, args: [record.admission.mcpLauncherPath] },
    },
  };
}
function assertStageController(
  record: StageRecord,
  current: Awaited<ReturnType<typeof controller>>,
  input: SetupControllerInput,
): void {
  if (
    record.intent.repoRoot !== current.root ||
    record.intent.repository !== current.configuration.config.repository ||
    record.intent.sourceCommit !== input.expectedSourceCommit ||
    record.intent.configDigest !== input.expectedConfigDigest
  )
    throw new DeliveryError('Runtime stage primary controller source or configuration changed.');
  if (record.intent.reviewRouteDigest !== digestValue(current.reviewRoute))
    throw new DeliveryError('Runtime stage configured actors or review route changed.');
}

/** Stage one reviewed local archive without activating host references or issuing admission. */
export async function stageRuntime(input: StageRuntimeInput): Promise<RuntimeStageResult> {
  if (input.authority !== 'runtime:stage') throw new DeliveryError('Explicit runtime:stage authority is required.');
  const bounds = StageBounds.parse({
    maxAggregateRssBytes: 1024 ** 3,
    minFreeDiskBytes: 256 * 1024 ** 2,
    maxNewOutputBytes: 512 * 1024 ** 2,
    maxCapturedOutputBytes: 1024 ** 2,
    ...input.resourceBounds,
  });
  canonicalPath(input.runtimeDirectory);
  assertNativeLocation(input.runtimeDirectory, input.nativePluginRoot);
  return withRuntimeSetupWriter(
    input.repoRoot,
    async (runner) => {
      const current = await controller(input, 'runtime:stage', runner.checkResources, runner.signal);
      assertArchive(input.archivePath, input.expectedArchiveSha256);
      const intent = IntentSchema.parse({
        archivePath: input.archivePath,
        archiveSha256: input.expectedArchiveSha256,
        configDigest: input.expectedConfigDigest,
        sourceCommit: input.expectedSourceCommit,
        packageVersion: input.packageVersion,
        repoRoot: current.root,
        repository: current.configuration.config.repository,
        reviewRouteDigest: digestValue(current.reviewRoute),
        runtimeDirectory: input.runtimeDirectory,
        resourceBounds: bounds,
        ...(input.nativePluginRoot === undefined ? {} : { nativePluginRoot: input.nativePluginRoot }),
      });
      const stageId = digestValue(intent);
      runner.bindCapturedOutput(stageId);
      if (existsSync(input.runtimeDirectory)) {
        const prior = readStage(input.runtimeDirectory);
        if (prior.stageId !== stageId)
          throw new DeliveryError('Runtime stage belongs to an incompatible setup intent.');
        if (prior.status === 'complete') {
          const reread = await controller(input, 'runtime:stage', runner.checkResources, runner.signal);
          assertStageController(prior, reread, input);
          assertArchive(intent.archivePath, intent.archiveSha256);
          durability(join(input.runtimeDirectory, 'reviewed-archive.tgz'));
          assertArchiveSnapshot(intent);
          validateRuntimeAdmission(prior.admission!, reread.configuration, prior.admission!.cliPath);
          durability(join(input.runtimeDirectory, 'runtime-stage.json'));
          syncDirectory(dirname(input.runtimeDirectory));
          await runner.checkResources();
          return stageResult(prior, reread.reviewRoute, true);
        }
        runner.assertQuiescent();
        rmSync(input.runtimeDirectory, { recursive: true });
      }
      ensurePrivateDirectoryDurably(dirname(input.runtimeDirectory));
      mkdirSync(input.runtimeDirectory, { mode: 0o700 });
      const directory = lstatSync(input.runtimeDirectory);
      const content: Omit<StageRecord, 'recordId'> = {
        schemaVersion: 'ai-delivery.runtime-stage@1',
        stageId,
        intent,
        directory: { device: directory.dev, inode: directory.ino },
        status: 'incomplete',
      };
      let owned = false;
      try {
        syncDirectory(dirname(input.runtimeDirectory));
        writeStage(input.runtimeDirectory, content);
        owned = true;
        if (input.signal?.aborted) throw new DeliveryError('Runtime stage cancelled.');
        // Hash and persist the same captured bytes. npm must never reopen the mutable transport pathname.
        const archiveBytes = assertArchive(input.archivePath, input.expectedArchiveSha256);
        if (!Number.isSafeInteger(bounds.maxNewOutputBytes) || archiveBytes.length >= bounds.maxNewOutputBytes)
          throw new DeliveryError('Reviewed archive snapshot exceeds the stage output limit.');
        writeCreateOnly(join(input.runtimeDirectory, 'reviewed-archive.tgz'), archiveBytes);
        const snapshot = assertArchiveSnapshot(intent);
        const npmRoot = join(input.runtimeDirectory, '.npm');
        const cache = join(npmRoot, 'cache');
        const logs = join(npmRoot, 'logs');
        const temporary = join(npmRoot, 'tmp');
        for (const path of [cache, logs, temporary]) ensurePrivateDirectoryDurably(path);
        const userconfig = join(npmRoot, 'user.npmrc');
        const globalconfig = join(npmRoot, 'global.npmrc');
        writeCreateOnly(userconfig, Buffer.alloc(0));
        writeCreateOnly(globalconfig, Buffer.alloc(0));
        await runner.checkResources();
        await runner.run(
          [
            'npm',
            'install',
            '--prefix',
            input.runtimeDirectory,
            '--omit=dev',
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
            '--package-lock=false',
            '--cache',
            cache,
            '--logs-dir',
            logs,
            // Command capture owns the entire retained-log allowance.
            '--logs-max',
            '0',
            '--userconfig',
            userconfig,
            '--globalconfig',
            globalconfig,
            snapshot,
          ],
          {
            ...bounds,
            maxNewOutputBytes: bounds.maxNewOutputBytes - archiveBytes.length,
            outputRoots: [input.runtimeDirectory],
          },
          input.signal,
          { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary },
          input.runtimeDirectory,
        );
        const reread = await controller(input, 'runtime:stage', runner.checkResources, runner.signal);
        assertStageController({ ...content, recordId: digestValue(content) }, reread, input);
        assertArchive(input.archivePath, input.expectedArchiveSha256);
        assertArchiveSnapshot(intent);
        assertNativePlugin(intent);
        const admission = buildRuntimeAdmission({
          ...runtimePaths(input.runtimeDirectory, input.nativePluginRoot),
          packageVersion: input.packageVersion,
          sourceArchiveSha256: input.expectedArchiveSha256,
          sourceCommit: input.expectedSourceCommit,
          configuration: reread.configuration,
        });
        assertNativePlugin(intent);
        if (input.signal?.aborted) throw new DeliveryError('Runtime stage cancelled.');
        runner.assertQuiescent();
        validateRuntimeAdmission(admission, reread.configuration, admission.cliPath);
        await runner.checkResources();
        const complete = writeStage(input.runtimeDirectory, { ...content, status: 'complete', admission });
        validateRuntimeAdmission(complete.admission!, reread.configuration, complete.admission!.cliPath);
        return stageResult(complete, reread.reviewRoute, false);
      } catch (error) {
        // Completion is a durable unit. Never prune it after a lost write response.
        if (!owned) {
          runner.assertQuiescent();
          const retained = lstatSync(input.runtimeDirectory);
          if (retained.dev !== directory.dev || retained.ino !== directory.ino || retained.isSymbolicLink())
            throw new DeliveryError('Runtime stage cleanup ownership changed.');
          rmSync(input.runtimeDirectory, { recursive: true });
        } else {
          runner.assertQuiescent();
          const retained = readStage(input.runtimeDirectory);
          if (retained.stageId !== stageId) throw new DeliveryError('Runtime stage cleanup ownership changed.');
          if (retained.status === 'incomplete') rmSync(input.runtimeDirectory, { recursive: true });
          else {
            const final = await controller(input, 'runtime:stage', runner.checkResources, runner.signal);
            assertStageController(retained, final, input);
            assertArchive(intent.archivePath, intent.archiveSha256);
            durability(join(input.runtimeDirectory, 'reviewed-archive.tgz'));
            assertArchiveSnapshot(intent);
            validateRuntimeAdmission(retained.admission!, final.configuration, retained.admission!.cliPath);
            durability(join(input.runtimeDirectory, 'runtime-stage.json'));
            syncDirectory(dirname(input.runtimeDirectory));
            return stageResult(retained, final.reviewRoute, true);
          }
        }
        throw error;
      }
    },
    {
      bounds: { ...bounds, outputRoots: [input.runtimeDirectory] },
      maxCapturedOutputBytes: bounds.maxCapturedOutputBytes,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
  );
}

export class RuntimeAdmissionCommitUnknownError extends DeliveryError {
  readonly status = 'commit-status-unknown';
  constructor(
    readonly admissionId: string,
    readonly stageId: string,
  ) {
    super(
      `Runtime admission commit-status-unknown for ${admissionId}; retry runtime:admit with the same stage ${stageId} to reconcile durability.`,
    );
  }
}

/** Explicit final binding, with prior-byte compare-and-swap and same-stage ambiguous-commit reconciliation. */
export async function admitRuntime(
  input: AdmitRuntimeInput,
): Promise<{ admission: RuntimeAdmission; reused: boolean }> {
  if (input.authority !== 'runtime:admit') throw new DeliveryError('Explicit runtime:admit authority is required.');
  Digest.parse(input.stageId);
  if (input.expectedPriorAdmissionSha256 !== null) Digest.parse(input.expectedPriorAdmissionSha256);
  const initial = await controller(input, 'runtime:admit');
  const path = join(gitCommonDir(initial.root), 'ai-delivery', 'runtime-admission.json');
  canonicalPath(path);
  ensurePrivateDirectoryDurably(dirname(path));
  return withLock(path, {
    projectRoot: initial.root,
    timeout: 200,
    operation: async () => {
      const record = readStage(input.runtimeDirectory);
      if (record.stageId !== input.stageId || record.status !== 'complete' || !record.admission)
        throw new DeliveryError('Exact completed runtime stage identity is required.');
      const current = await controller(input, 'runtime:admit');
      assertStageController(record, current, input);
      assertArchive(record.intent.archivePath, record.intent.archiveSha256);
      assertArchiveSnapshot(record.intent);
      validateRuntimeAdmission(record.admission, current.configuration, record.admission.cliPath);
      const desired = Buffer.from(`${JSON.stringify(record.admission, null, 2)}\n`);
      canonicalPath(path);
      const existing = existsSync(path) ? assertPrivateFile(path) : undefined;
      const reconcile = (): { admission: RuntimeAdmission; reused: boolean } => {
        canonicalPath(path);
        assertArchiveSnapshot(record.intent);
        validateRuntimeAdmission(record.admission!, current.configuration, record.admission!.cliPath);
        if (!existsSync(path) || !assertPrivateFile(path).equals(desired))
          throw new DeliveryError('Runtime admission third-party replacement conflict; current bytes preserved.');
        try {
          durability(path);
        } catch {
          if (!existsSync(path) || !assertPrivateFile(path).equals(desired))
            throw new DeliveryError('Runtime admission third-party replacement conflict; current bytes preserved.');
          throw new RuntimeAdmissionCommitUnknownError(record.admission!.admissionId, record.stageId);
        }
        return { admission: record.admission!, reused: true };
      };
      if (existing?.equals(desired)) return reconcile();
      if ((existing === undefined ? null : digestBytes(existing)) !== input.expectedPriorAdmissionSha256)
        throw new DeliveryError('Runtime admission prior-byte compare-and-swap conflict; current bytes preserved.');
      // Recheck exact staged/source/config/actor bindings immediately before the sole publication write.
      const final = await controller(input, 'runtime:admit');
      assertStageController(record, final, input);
      assertArchive(record.intent.archivePath, record.intent.archiveSha256);
      assertArchiveSnapshot(record.intent);
      validateRuntimeAdmission(record.admission, final.configuration, record.admission.cliPath);
      canonicalPath(path);
      const priorNow = existsSync(path) ? assertPrivateFile(path) : undefined;
      if ((priorNow === undefined ? null : digestBytes(priorNow)) !== input.expectedPriorAdmissionSha256)
        throw new DeliveryError('Runtime admission prior-byte compare-and-swap conflict; current bytes preserved.');
      try {
        writePrivateJsonFileAtomically(path, record.admission);
      } catch (error) {
        const after = existsSync(path) ? assertPrivateFile(path) : undefined;
        if (after?.equals(desired)) return reconcile();
        if ((after === undefined ? null : digestBytes(after)) !== input.expectedPriorAdmissionSha256)
          throw new DeliveryError('Runtime admission third-party replacement conflict; current bytes preserved.');
        throw error;
      }
      reconcile();
      return { admission: record.admission, reused: false };
    },
  });
}
