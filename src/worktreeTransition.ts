import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  assertPrivateFile,
  DigestSchema,
  digestBytes,
  digestValue,
  ShaSchema,
  stableJson,
  writeCreateOnly,
} from './delivery/common.js';
import { DeliveryError } from './errors.js';
import { assertClean, defaultBaseRef, git, gitCommonDir, gitExitCode, gitRoot, primaryGitRoot } from './git.js';
import { createDeliveryGitHubClients } from './github/client.js';
import type { LoadedDeliveryConfig } from './config/deliveryConfig.js';
import type { DeliveryContext } from './issue.js';
import {
  assertDeliveryRuntimeAdmitted,
  RuntimeAdmissionSchema,
  validateRuntimeAdmission,
} from './services/deliveryAdmission.js';
import {
  assertWorktreeTransitionWriterQuiescent,
  readWorktreeTransitionRun,
  retainedWorktreeTransitionProducerDigest,
  retainedWorktreeTransitionDependencyManifests,
} from './verification.js';
import {
  assertTransitionOwnerWitness,
  listWorktreesStrict,
  withWorktreeTransitionRegistry,
} from './services/worktreeRegistry.js';
import { withWorktreeTransitionWriterAbsent, withWorktreeTransitionWriterLease } from './verification.js';
import { removeMergedSourceForTransition } from './worktree.js';
import type { WorktreeEntry } from './services/worktreeRegistry.js';

export interface TransitionEvidenceFile {
  path: string;
  source: string;
  digest: string;
  size: number;
}

const EvidenceFileSchema = z.strictObject({
  path: z.string().min(1),
  source: z.string().min(1),
  digest: DigestSchema,
  size: z.number().int().nonnegative().safe(),
});
const RowSchema = z.strictObject({
  branch: z.string().min(1),
  createdAt: z.string().min(1),
  identity: z.string().min(1),
  issueNumber: z.number().int().positive(),
  path: z.string().min(1),
  prNumber: z.number().int().positive().optional(),
  status: z.enum(['active', 'error', 'merged', 'pr-published', 'stale']),
  type: z.literal('issue'),
  updatedAt: z.string().min(1),
});
const NativePrSchema = z.strictObject({
  prNumber: z.number().int().positive(),
  headSha: ShaSchema,
  headBranch: z.string().min(1),
  baseSha: ShaSchema,
  baseBranch: z.string().min(1),
  mergeSha: ShaSchema.nullable(),
  merged: z.boolean(),
  authorLogin: z.string().min(1),
});
export const WorktreeTransitionPlanSchema = z
  .strictObject({
    schemaVersion: z.literal('ai-delivery.worktree-transition-plan@1'),
    planId: DigestSchema,
    repository: z.string().min(1),
    repoRoot: z.string().min(1),
    row: RowSchema,
    purpose: z.enum(['active-resume', 'merged-cleanup']),
    disposition: z.enum(['retain', 'remove']),
    head: z.strictObject({ sha: ShaSchema, tree: ShaSchema }),
    terminalPrNumber: z.number().int().positive().nullable(),
    lineage: z.array(NativePrSchema),
    retainedHoldCommentIds: z.array(z.number().int().positive()),
    remoteRefs: z.strictObject({ headSha: ShaSchema.nullable(), baseSha: ShaSchema }).nullable(),
    holdEvidence: z.array(z.strictObject({ commentId: z.number().int().positive(), digest: DigestSchema })),
    inventory: z.array(EvidenceFileSchema),
    inventoryId: DigestSchema,
    historicalProducer: z.literal('UNKNOWN'),
    closure: z.strictObject({
      family: z.literal('public-ai-delivery-0.3.5-posix@1'),
      admissionPath: z.string().min(1),
      archivePath: z.string().min(1),
      admission: RuntimeAdmissionSchema,
      admissionBytesDigest: DigestSchema,
      producerDigest: DigestSchema,
      runManifestIds: z.array(DigestSchema).min(1),
    }),
    currentRuntime: RuntimeAdmissionSchema,
    policyDigest: DigestSchema,
    operator: z.strictObject({
      actorLogin: z.string().min(1),
      credentialIdentity: z.string().regex(/^user:[1-9]\d*$/u),
    }),
    reviewerActor: z.string().min(1),
  })
  .superRefine((plan, context) => {
    const { planId, ...content } = plan;
    if (
      planId !== digestValue(content) ||
      plan.inventoryId !== digestValue(plan.inventory) ||
      (plan.disposition === 'remove' &&
        (plan.purpose !== 'merged-cleanup' || plan.retainedHoldCommentIds.length !== 0)) ||
      (plan.purpose === 'active-resume' && plan.terminalPrNumber !== null) ||
      (plan.purpose === 'merged-cleanup' && plan.terminalPrNumber === null) ||
      (plan.disposition === 'remove' && plan.remoteRefs === null)
    )
      context.addIssue({ code: 'custom', message: 'Transition plan identity or disposition is invalid.' });
  });
export type WorktreeTransitionPlan = z.infer<typeof WorktreeTransitionPlanSchema>;

export interface InspectWorktreeTransitionInput {
  issueNumber: number;
  purpose: 'active-resume' | 'merged-cleanup';
  disposition?: 'retain' | 'remove';
  terminalPrNumber?: number;
  retainedHoldCommentIds?: number[];
  retainedAdmissionPath?: string;
  retainedArchivePath?: string;
  runtimeEntryPath?: string;
}

// A finite, audited producer family. An arbitrary caller-supplied hash never expands this allowlist.
const PUBLIC_PRODUCER_ARCHIVE = 'sha256:c561a94b7727ad5dfc520cbdcad803b9eaddfd49d334ccbc9253edeede26994e';

function retainedProducer(context: DeliveryContext, admissionPath: string, archivePath: string) {
  if (!context.configuration) throw new DeliveryError('Transition requires the current repository configuration.');
  const bytes = assertPrivateFile(admissionPath);
  const admission = RuntimeAdmissionSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
  if (admission.packageVersion !== '0.3.5' || admission.sourceArchiveSha256 !== PUBLIC_PRODUCER_ARCHIVE)
    throw new DeliveryError('Retained operational producer is outside the supported public 0.3.5 family.');
  validateRuntimeAdmission(
    admission,
    { ...context.configuration, configDigest: admission.configDigest },
    admission.cliPath,
  );
  const archive = evidenceBytes(archivePath);
  if (digestBytes(archive) !== PUBLIC_PRODUCER_ARCHIVE)
    throw new DeliveryError('Retained official public archive bytes disagree.');
  // The archive is authenticated by the fixed distribution digest before its finite regular-file tar inventory is read.
  const tar = gunzipSync(archive, { maxOutputLength: 8 * 1024 * 1024 });
  const packageRoot = dirname(dirname(admission.cliPath));
  const inventory: TransitionEvidenceFile[] = [];
  const record = (source: string, path: string) => {
    const bytes = evidenceBytes(source);
    inventory.push({ source, path, digest: digestBytes(bytes), size: bytes.length });
  };
  let count = 0;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/su, '');
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/su, '').trim(), 8);
    if (
      header[156] !== 48 ||
      !/^package\/(?!.*(?:^|\/)\.\.\/)[A-Za-z0-9_./-]+$/u.test(name) ||
      !Number.isSafeInteger(size) ||
      size < 0
    )
      throw new DeliveryError('Retained public archive inventory is unsupported.');
    const archived = tar.subarray(offset + 512, offset + 512 + size);
    const installedPath = resolve(packageRoot, name.slice('package/'.length));
    const installed = evidenceBytes(installedPath);
    if (archived.length !== size || !installed.equals(archived))
      throw new DeliveryError(`Retained producer bytes drifted: ${name}`);
    count += 1;
    record(installedPath, `retained/${name}`);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (count !== 155) throw new DeliveryError('Retained public producer inventory is incomplete.');
  record(admissionPath, 'retained/admission.json');
  record(archivePath, 'retained/public-archive.tar.gz');
  const dependencies = retainedWorktreeTransitionDependencyManifests(dirname(admission.cliPath));
  for (const file of dependencies)
    record(file.source, `retained/dependency-manifests/${digestValue(file.source).slice(7)}.json`);
  inventory.sort((left, right) => left.path.localeCompare(right.path));
  return {
    admissionPath,
    archivePath,
    admission,
    admissionBytesDigest: digestBytes(bytes),
    producerDigest: retainedWorktreeTransitionProducerDigest(dirname(admission.cliPath)),
    inventory,
  };
}

function requireSupportedRunClosure(
  root: string,
  row: WorktreeEntry,
  inventory: readonly TransitionEvidenceFile[],
  producerDigest: string,
  head: { sha: string; tree: string },
): string[] {
  const runs = inventory
    .filter((file) => file.path.startsWith('git/ai-delivery/runs@2/'))
    .map((file) => readWorktreeTransitionRun(evidenceBytes(file.source)));
  if (
    runs.length === 0 ||
    !runs.some((run) => run.classification.head.sha === head.sha && run.classification.head.tree === head.tree) ||
    runs.some(
      (run) =>
        run.schemaVersion !== 'ai-delivery.run@3' ||
        run.writer?.worktreeDigest !== digestValue(row.path) ||
        run.writer.producerDigest !== producerDigest ||
        run.classification.repository === '' ||
        run.classification.requiredStages.some(
          (stage) => !['source_only', 'focused_node', 'canonical_verify'].includes(stage.resourceClass),
        ) ||
        (run.classification.requiredStages.some((stage) => stage.commands.length > 0) && run.resources === undefined),
    )
  )
    throw new DeliveryError(
      'Complete operational run inventory lacks supported producer-bound closure for the exact retained source head/tree.',
    );
  for (const run of runs)
    for (const receipt of run.stageReceipts) {
      const version = receipt.input.schemaVersion === 'ai-delivery.stage-input@2' ? 2 : 1;
      const checkpoint = join(
        gitCommonDir(root),
        'ai-delivery',
        `verification@${String(version)}`,
        'stages',
        receipt.input.stageId,
        `${receipt.input.inputId.slice(7)}.json`,
      );
      if (stableJson(JSON.parse(assertPrivateFile(checkpoint).toString('utf8')) as unknown) !== stableJson(receipt))
        throw new DeliveryError('Operational run inventory has a missing or conflicting stage checkpoint.');
    }
  return runs.map((run) => run.manifestId).sort();
}

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function evidenceBytes(path: string): Buffer {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || realpathSync(path) !== path)
    throw new DeliveryError('Historical evidence requires canonical regular files without links.');
  return readFileSync(path);
}

/** Read-only, deterministic inventory. Unknown historical schemas remain opaque bytes. */
export function inventoryTransitionEvidence(
  root: string,
  row: WorktreeEntry,
  removed = false,
): TransitionEvidenceFile[] {
  const common = gitCommonDir(root);
  const files = new Map<string, TransitionEvidenceFile>();
  const heads = new Set<string>();
  if (present(row.path)) heads.add(git(row.path, 'rev-parse', 'HEAD'));
  else if (removed) heads.add(git(root, 'rev-parse', row.branch));
  const collect = (path: string, label: string): void => {
    if (!present(path)) return;
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || realpathSync(path) !== path)
      throw new DeliveryError('Historical evidence inventory contains a noncanonical path.');
    if (metadata.isDirectory()) {
      for (const name of readdirSync(path).sort()) collect(join(path, name), `${label}/${name}`);
      return;
    }
    const bytes = evidenceBytes(path);
    files.set(label, { path: label, source: path, digest: digestBytes(bytes), size: bytes.length });
    if (label.endsWith('.json')) {
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
      } catch {
        return;
      }
      if (value && typeof value.headSha === 'string' && /^[a-f0-9]{40}$/u.test(value.headSha)) heads.add(value.headSha);
      if (value?.schemaVersion === 'issue-cli.terminal-evidence@1') {
        if (!Array.isArray(value.files))
          throw new DeliveryError('Historical terminal evidence manifest is incomplete.');
        for (const raw of value.files as Record<string, unknown>[]) {
          if (typeof raw.name !== 'string' || !/^[A-Za-z0-9_.-]+$/u.test(raw.name) || typeof raw.sha256 !== 'string')
            throw new DeliveryError('Historical terminal evidence inventory is invalid.');
          const original = evidenceBytes(join(dirname(path), raw.name));
          if (original.length !== raw.size || digestBytes(original) !== `sha256:${raw.sha256}`)
            throw new DeliveryError('Historical terminal evidence manifest disagrees with original bytes.');
        }
      }
      if (label.startsWith(`git/ai-delivery/runs@2/`) && value?.schemaVersion === 'ai-delivery.run@3') {
        const run = readWorktreeTransitionRun(bytes);
        const head = run.classification.head.sha;
        heads.add(head);
        for (const receipt of run.stageReceipts) {
          const version = receipt.input.schemaVersion === 'ai-delivery.stage-input@2' ? 2 : 1;
          const checkpoint = `ai-delivery/verification@${String(version)}/stages/${receipt.input.stageId}/${receipt.input.inputId.slice(7)}.json`;
          collect(join(common, checkpoint), `git/${checkpoint}`);
          const resource = `ai-delivery/resource-stages@1/${receipt.input.inputId.slice(7)}.json`;
          collect(join(common, resource), `git/${resource}`);
          for (const command of receipt.commands) {
            const output = `ai-delivery/verification@1/command-output/${command.outputDigest.slice(7)}.bin`;
            const outputBytes = evidenceBytes(join(common, output));
            if (digestBytes(outputBytes) !== command.outputDigest)
              throw new DeliveryError('Historical command output is corrupt.');
            collect(join(common, output), `git/${output}`);
          }
          for (const artifact of receipt.artifacts) {
            if (removed) continue;
            const path = resolve(row.path, artifact.path);
            if (relative(row.path, path).startsWith('..') || digestBytes(evidenceBytes(path)) !== artifact.digest)
              throw new DeliveryError('Historical stage artifact is missing or corrupt.');
            collect(path, `worktree/${artifact.path}`);
          }
        }
        if (run.resources?.outputBaselineId) {
          const baseline = `ai-delivery/output-baselines@1/${run.resources.outputBaselineId.slice(7)}`;
          collect(join(common, `${baseline}.json`), `git/${baseline}.json`);
          collect(join(common, `${baseline}.state.json`), `git/${baseline}.state.json`);
        }
      }
    }
  };
  collect(
    join(root, '.issue-cli', 'issues', String(row.issueNumber)),
    `repository/.issue-cli/issues/${String(row.issueNumber)}`,
  );
  if (!removed) collect(join(row.path, '.issue-cli'), 'worktree/.issue-cli');
  const worktreeId = digestValue(resolve(row.path)).slice(7);
  collect(join(common, 'ai-delivery', 'runs@2', worktreeId), `git/ai-delivery/runs@2/${worktreeId}`);
  collect(
    join(common, 'ai-delivery', 'writers@1', `${worktreeId}.json`),
    `git/ai-delivery/writers@1/${worktreeId}.json`,
  );
  // Legacy receipts are selected by their original exact-head filenames, never rewritten as current proof.
  const receipts = join(root, '.issue-cli', 'receipts');
  const collectReceipts = (path: string): void => {
    if (!present(path)) return;
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) throw new DeliveryError('Historical receipt inventory contains a link.');
    if (metadata.isDirectory()) {
      for (const name of readdirSync(path).sort()) collectReceipts(join(path, name));
    } else if ([...heads].some((head) => path.includes(head))) collect(path, `repository/${relative(root, path)}`);
  };
  collectReceipts(receipts);
  for (const family of ['publications', 'reviews', 'merges', 'merge-intents', 'merge-attempts', 'merge-results'])
    collect(
      join(common, 'ai-delivery', family, String(row.issueNumber)),
      `git/ai-delivery/${family}/${String(row.issueNumber)}`,
    );
  for (const head of [...heads].sort())
    collect(join(common, 'ai-delivery', 'runs', `${head}.json`), `git/ai-delivery/runs/${head}.json`);
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

const TransitionIntentSchema = z
  .strictObject({
    schemaVersion: z.literal('ai-delivery.worktree-transition-intent@1'),
    intentId: DigestSchema,
    plan: WorktreeTransitionPlanSchema,
    relinquishmentCommentId: z.number().int().positive(),
    acceptanceCommentId: z.number().int().positive(),
    originalRegistryDigest: DigestSchema,
    originalWriterDigest: DigestSchema.nullable(),
  })
  .superRefine((intent, context) => {
    const { intentId, ...content } = intent;
    if (intentId !== digestValue(content))
      context.addIssue({ code: 'custom', message: 'Transition intent is corrupt.' });
  });
type TransitionIntent = z.infer<typeof TransitionIntentSchema>;
const TransitionStepSchema = z.strictObject({
  schemaVersion: z.literal('ai-delivery.worktree-transition-step@1'),
  planId: DigestSchema,
  intentId: DigestSchema,
  attemptId: z.uuid(),
  event: z.enum(['authority', 'claim', 'claimed', 'release', 'released', 'row', 'owner', 'removal-intent', 'removed']),
  sequence: z.number().int().positive().safe(),
  predecessorId: DigestSchema.nullable(),
  data: z.record(z.string(), z.unknown()),
  stepId: DigestSchema,
});
type TransitionStep = z.infer<typeof TransitionStepSchema>;
const TransitionCompletionSchema = z
  .strictObject({
    schemaVersion: z.literal('ai-delivery.worktree-transition-completion@1'),
    completionId: DigestSchema,
    planId: DigestSchema,
    intentId: DigestSchema,
    completed: z.literal(true),
    writerReleased: z.literal(true),
    result: z.enum(['active-resumed', 'retained', 'removed']),
    rowAfter: RowSchema.nullable(),
    inventoryId: DigestSchema,
    attempts: z.array(DigestSchema).min(1),
    completedAt: z.iso.datetime(),
  })
  .superRefine((completion, context) => {
    const { completionId, ...content } = completion;
    if (completionId !== digestValue(content))
      context.addIssue({ code: 'custom', message: 'Transition completion is corrupt.' });
  });

function transitionLocations(plan: WorktreeTransitionPlan) {
  const intent = join(
    gitCommonDir(plan.repoRoot),
    'ai-delivery',
    'worktree-owners',
    `issue-${String(plan.row.issueNumber)}.transition.json`,
  );
  return { intent, directory: `${intent}.evidence`, blobs: join(`${intent}.evidence`, 'bytes') };
}

function immutableJson(path: string, value: unknown): void {
  writeCreateOnly(path, Buffer.from(stableJson(value)));
}

function preserveBytes(directory: string, bytes: Buffer): string {
  const digest = digestBytes(bytes);
  writeCreateOnly(join(directory, `${digest.slice(7)}.bin`), bytes, digest);
  return digest;
}

function requirePreservedBytes(directory: string, digest: string): Buffer {
  const bytes = assertPrivateFile(join(directory, `${DigestSchema.parse(digest).slice(7)}.bin`));
  if (digestBytes(bytes) !== digest) throw new DeliveryError('Preserved transition evidence is corrupt.');
  return bytes;
}

function transitionWriterId(plan: WorktreeTransitionPlan): string {
  const id = digestValue({ planId: plan.planId, purpose: 'transition-writer' }).slice(7);
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-5${id.slice(13, 16)}-8${id.slice(17, 20)}-${id.slice(20, 32)}`;
}

function readSteps(directory: string, intent: TransitionIntent) {
  if (!present(directory)) return [];
  let predecessorId: string | null = null;
  return readdirSync(directory)
    .sort((left, right) => Number(left.split('.')[0]) - Number(right.split('.')[0]))
    .map((name, index) => {
      if (
        !/^[1-9]\d*\.[a-f0-9-]{36}\.(?:authority|claim|claimed|release|released|row|owner|removal-intent|removed)\.json$/u.test(
          name,
        )
      )
        throw new DeliveryError('Transition attempt inventory contains an unsupported record.');
      const step = TransitionStepSchema.parse(
        JSON.parse(assertPrivateFile(join(directory, name)).toString('utf8')) as unknown,
      );
      const { stepId, ...content } = step;
      if (
        stepId !== digestValue(content) ||
        step.intentId !== intent.intentId ||
        step.planId !== intent.plan.planId ||
        step.sequence !== index + 1 ||
        step.predecessorId !== predecessorId ||
        name !== `${String(step.sequence)}.${step.attemptId}.${step.event}.json`
      )
        throw new DeliveryError('Transition attempt record is corrupt or belongs to another intent.');
      predecessorId = stepId;
      return step;
    });
}

function permittedWriterStates(intent: TransitionIntent, steps: readonly TransitionStep[]): (string | null)[] {
  let permitted: (string | null)[] = [intent.originalWriterDigest];
  let claim: { attemptId: string; bytesDigest: string } | undefined;
  let releaseAttempt: string | undefined;
  for (const step of steps) {
    if (step.event === 'claim') {
      const bytesDigest = DigestSchema.parse(step.data.bytesDigest);
      const previous =
        step.data.previousBytesDigest === null ? null : DigestSchema.parse(step.data.previousBytesDigest);
      if (!permitted.includes(previous))
        throw new DeliveryError('Transition claim predecessor is outside its exact writer lineage.');
      permitted = [previous, bytesDigest];
      claim = { attemptId: step.attemptId, bytesDigest };
      releaseAttempt = undefined;
    } else if (step.event === 'claimed' || step.event === 'release') {
      if (!claim || step.attemptId !== claim.attemptId || step.data.bytesDigest !== claim.bytesDigest)
        throw new DeliveryError('Transition claim/release acknowledgement belongs to another writer lineage.');
      permitted = step.event === 'claimed' ? [claim.bytesDigest] : [claim.bytesDigest, null];
      if (step.event === 'release') releaseAttempt = step.attemptId;
    } else if (step.event === 'released') {
      if (releaseAttempt !== step.attemptId || step.data.absent !== true)
        throw new DeliveryError('Transition absence lacks its exact latest release intent.');
      permitted = [null];
    }
  }
  return permitted;
}

function requireAttemptBytes(directory: string, intent: TransitionIntent, steps: readonly TransitionStep[]): void {
  if (intent.originalWriterDigest !== null) requirePreservedBytes(directory, intent.originalWriterDigest);
  for (const step of steps) {
    if (['authority', 'claim', 'claimed', 'release'].includes(step.event))
      requirePreservedBytes(directory, DigestSchema.parse(step.data.bytesDigest));
  }
}

async function revalidateTransition(
  context: DeliveryContext,
  plan: WorktreeTransitionPlan,
  originalInventory: boolean,
  removalAuthorized: boolean,
  runtimeEntryPath?: string,
) {
  if (!context.configuration || context.root !== plan.repoRoot || context.config.repository !== plan.repository)
    throw new DeliveryError('Transition repository or current configuration drifted.');
  const admitted = await assertDeliveryRuntimeAdmitted({
    repoRoot: plan.repoRoot,
    configuration: context.configuration,
    ...(runtimeEntryPath === undefined ? {} : { runtimeEntryPath }),
  });
  if (
    stableJson(admitted) !== stableJson(plan.currentRuntime) ||
    digestBytes(evidenceBytes(historicalConfiguration(context).policyModulePath)) !== plan.policyDigest
  )
    throw new DeliveryError('Transition current runtime/configuration/policy drifted.');
  const { inventory: producerInventory, ...producer } = retainedProducer(
    context,
    plan.closure.admissionPath,
    plan.closure.archivePath,
  );
  const { family: _family, runManifestIds: _runs, ...expectedProducer } = plan.closure;
  if (stableJson(producer) !== stableJson(expectedProducer))
    throw new DeliveryError('Retained operational producer drifted.');
  for (const family of ['v1', 'v2'])
    if (present(join(gitCommonDir(plan.repoRoot), 'issue-cli', 'verification-stages', family)))
      throw new DeliveryError(
        `Unsupported operative issue-cli verification-stages/${family}; supported closure is missing.`,
      );
  const removed = !present(plan.row.path);
  if (removed && (!removalAuthorized || plan.disposition !== 'remove'))
    throw new DeliveryError('Transition source disappeared without recorded removal intent.');
  if (!removed) {
    if (
      gitRoot(plan.row.path) !== plan.row.path ||
      gitCommonDir(plan.row.path) !== gitCommonDir(plan.repoRoot) ||
      git(plan.row.path, 'branch', '--show-current') !== plan.row.branch
    )
      throw new DeliveryError('Transition worktree ownership or branch drifted.');
    assertClean(plan.row.path);
  }
  const source = removed ? plan.repoRoot : plan.row.path;
  const ref = removed ? plan.row.branch : 'HEAD';
  if (git(source, 'rev-parse', ref) !== plan.head.sha || git(source, 'rev-parse', `${ref}^{tree}`) !== plan.head.tree)
    throw new DeliveryError('Transition exact source coordinates drifted.');
  const lineage = await readTransitionLineage(context, plan.row as WorktreeEntry, plan.terminalPrNumber);
  if (stableJson(lineage) !== stableJson(plan.lineage))
    throw new DeliveryError('Transition authenticated native PR lineage or complete PR set drifted.');
  if (plan.disposition === 'remove') {
    const terminal = plan.lineage.find((pr) => pr.prNumber === plan.terminalPrNumber);
    if (
      !terminal ||
      stableJson(await nativeRemoteRefs(context, plan.row.branch, terminal.baseBranch)) !==
        stableJson(plan.remoteRefs) ||
      git(plan.repoRoot, 'rev-parse', defaultBaseRef(plan.repoRoot, historicalConfiguration(context).remote)) !==
        plan.remoteRefs?.baseSha
    )
      throw new DeliveryError('Transition native remote branch readback or local retaining ref drifted.');
    if (
      producerInventory.some((file) => {
        const rel = relative(plan.row.path, file.source);
        return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
      })
    )
      throw new DeliveryError('Retained operational producer must remain outside the source selected for removal.');
  }
  const issue = (await context.clients.rest.issues.get({ ...context.repo, issue_number: plan.row.issueNumber })).data;
  if (issue.state !== (plan.purpose === 'merged-cleanup' ? 'closed' : 'open'))
    throw new DeliveryError('Transition native issue state drifted.');
  for (const hold of plan.holdEvidence) {
    const comment = (await context.clients.rest.issues.getComment({ ...context.repo, comment_id: hold.commentId }))
      .data;
    if (digestBytes(Buffer.from(stableJson(comment))) !== hold.digest)
      throw new DeliveryError('Retained native hold evidence drifted.');
  }
  const actual = [
    ...inventoryTransitionEvidence(plan.repoRoot, plan.row as WorktreeEntry, removed),
    ...producerInventory,
  ].sort((left, right) => left.path.localeCompare(right.path));
  assertTransitionPurpose(
    plan.repoRoot,
    plan.row as WorktreeEntry,
    plan.purpose,
    plan.terminalPrNumber,
    plan.head,
    lineage,
    issue.state,
    actual,
  );
  const runManifestIds = requireSupportedRunClosure(
    plan.repoRoot,
    plan.row as WorktreeEntry,
    actual,
    producer.producerDigest,
    plan.head,
  );
  if (stableJson(runManifestIds) !== stableJson(plan.closure.runManifestIds))
    throw new DeliveryError('Operational run inventory IDs drifted.');
  if (
    actual
      .filter((file) => file.path.startsWith('git/ai-delivery/runs@2/'))
      .some(
        (file) => readWorktreeTransitionRun(evidenceBytes(file.source)).classification.repository !== plan.repository,
      )
  )
    throw new DeliveryError('Operational run inventory belongs to another repository.');
  const exclude = (files: readonly TransitionEvidenceFile[]) =>
    files.filter(
      (file) => !file.path.startsWith('git/ai-delivery/writers@1/') && !(removed && file.path.startsWith('worktree/')),
    );
  if (stableJson(exclude(actual)) !== stableJson(exclude(plan.inventory)))
    throw new DeliveryError('Transition complete historical writer/run/stage inventory drifted.');
  if (
    originalInventory &&
    actual.some(
      (file) =>
        file.path.startsWith('git/ai-delivery/writers@1/') &&
        !plan.inventory.some((expected) => stableJson(expected) === stableJson(file)),
    )
  )
    throw new DeliveryError('Original transition writer evidence drifted.');
}

export async function applyWorktreeTransition(
  context: DeliveryContext,
  input: {
    authority: 'worktree:transition';
    planPath: string;
    expectedPlanId: string;
    relinquishmentCommentId: number;
    acceptanceCommentId: number;
    runtimeEntryPath?: string;
  },
): Promise<{
  planId: string;
  result: 'active-resumed' | 'retained' | 'removed';
  replayed: boolean;
  receiptPath: string;
}> {
  if (input.authority !== 'worktree:transition')
    throw new DeliveryError('Explicit exact-plan worktree transition authority is required.');
  const plan = WorktreeTransitionPlanSchema.parse(
    JSON.parse(evidenceBytes(realpathSync(input.planPath)).toString('utf8')) as unknown,
  );
  if (plan.planId !== input.expectedPlanId) throw new DeliveryError('Transition expected plan identity disagrees.');
  const locations = transitionLocations(plan);
  const completionPath = join(locations.directory, 'completion.json');
  const stepsDirectory = join(locations.directory, 'attempts');
  let intent: TransitionIntent | undefined;
  if (present(locations.intent)) {
    intent = TransitionIntentSchema.parse(JSON.parse(assertPrivateFile(locations.intent).toString('utf8')) as unknown);
    if (
      stableJson(intent.plan) !== stableJson(plan) ||
      intent.relinquishmentCommentId !== input.relinquishmentCommentId ||
      intent.acceptanceCommentId !== input.acceptanceCommentId
    )
      throw new DeliveryError('Pending transition requires its original exact plan and native authority IDs.');
  }
  const result =
    plan.purpose === 'active-resume' ? 'active-resumed' : plan.disposition === 'retain' ? 'retained' : 'removed';
  if (present(completionPath)) {
    if (!intent) throw new DeliveryError('Transition completion lacks its durable intent.');
    const completion = TransitionCompletionSchema.parse(
      JSON.parse(assertPrivateFile(completionPath).toString('utf8')) as unknown,
    );
    const attempts = readSteps(stepsDirectory, intent);
    if (
      completion.planId !== plan.planId ||
      completion.intentId !== intent.intentId ||
      completion.result !== result ||
      completion.inventoryId !== plan.inventoryId ||
      stableJson(completion.attempts) !== stableJson(attempts.map((record) => record.stepId)) ||
      stableJson(permittedWriterStates(intent, attempts)) !== stableJson([null])
    )
      throw new DeliveryError('Transition completion is corrupt.');
    for (const file of plan.inventory) requirePreservedBytes(locations.blobs, file.digest);
    requirePreservedBytes(locations.blobs, intent.originalRegistryDigest);
    requireAttemptBytes(locations.blobs, intent, attempts);
    for (const hold of plan.holdEvidence) requirePreservedBytes(locations.blobs, hold.digest);
    await revalidateTransition(
      context,
      plan,
      false,
      readSteps(stepsDirectory, intent).some((record) => record.event === 'removal-intent'),
      input.runtimeEntryPath,
    );
    await assertWorktreeTransitionNativeAuthority(context, plan, input);
    await withWorktreeTransitionWriterAbsent(plan.repoRoot, plan.row.path, () =>
      withWorktreeTransitionRegistry(plan, async ({ current }) => {
        if (stableJson(current ?? null) !== stableJson(completion.rowAfter))
          throw new DeliveryError('Sealed transition registry postcondition drifted.');
        assertTransitionOwnerWitness(plan);
        if (result === 'removed') {
          if (present(plan.row.path) || current !== undefined)
            throw new DeliveryError('Removed transition source was recreated; terminal absence postcondition drifted.');
        } else {
          if (!current || !present(plan.row.path))
            throw new DeliveryError('Sealed transition source or owner witness disappeared.');
        }
      }),
    );
    return { planId: plan.planId, result, replayed: true, receiptPath: completionPath };
  }
  const attemptId = randomUUID();
  let steps = intent === undefined ? [] : readSteps(stepsDirectory, intent);
  const step = (event: TransitionStep['event'], data: Record<string, unknown>) => {
    if (!intent) throw new DeliveryError('Transition step lacks durable intent.');
    const content = {
      schemaVersion: 'ai-delivery.worktree-transition-step@1' as const,
      planId: plan.planId,
      intentId: intent.intentId,
      attemptId,
      event,
      data,
      sequence: steps.length + 1,
      predecessorId: steps.at(-1)?.stepId ?? null,
    };
    const record = TransitionStepSchema.parse({ ...content, stepId: digestValue(content) });
    permittedWriterStates(intent, [...steps, record]);
    immutableJson(join(stepsDirectory, `${String(record.sequence)}.${attemptId}.${event}.json`), record);
    steps.push(record);
  };
  const priorSteps = [...steps];
  let previousBytesDigest: string | null = null;
  let claimedBytesDigest: string | undefined;
  let operationComplete = false;
  let rowAfter: WorktreeEntry | null = null;
  await withWorktreeTransitionWriterLease(
    {
      repoRoot: plan.repoRoot,
      worktreePath: plan.row.path,
      writerId: transitionWriterId(plan),
      beforeClaim: async ({ previousBytes }) => {
        await withWorktreeTransitionRegistry(plan, async ({ current }) => {
          if (intent !== undefined) steps = readSteps(stepsDirectory, intent);
          const removalAuthorized = priorSteps.some((record) => record.event === 'removal-intent');
          if (current === undefined && !removalAuthorized)
            throw new DeliveryError('Transition row disappeared without recorded removal intent.');
          await revalidateTransition(context, plan, intent === undefined, removalAuthorized, input.runtimeEntryPath);
          const authority = await assertWorktreeTransitionNativeAuthority(context, plan, input);
          if (intent === undefined) {
            const writerFile = plan.inventory.find((file) => file.path.startsWith('git/ai-delivery/writers@1/'));
            if (
              (previousBytes === undefined) !== (writerFile === undefined) ||
              (previousBytes !== undefined && digestBytes(previousBytes) !== writerFile?.digest)
            )
              throw new DeliveryError('Original transition writer bytes or absence drifted.');
            const originalRegistryDigest = preserveBytes(
              locations.blobs,
              evidenceBytes(join(plan.repoRoot, '.issue-cli', 'worktrees.json')),
            );
            const content = {
              schemaVersion: 'ai-delivery.worktree-transition-intent@1' as const,
              plan,
              relinquishmentCommentId: input.relinquishmentCommentId,
              acceptanceCommentId: input.acceptanceCommentId,
              originalRegistryDigest,
              originalWriterDigest: previousBytes === undefined ? null : digestBytes(previousBytes),
            };
            intent = TransitionIntentSchema.parse({ ...content, intentId: digestValue(content) });
            immutableJson(locations.intent, intent);
            preserveTransitionEvidence(locations.blobs, plan.inventory);
          } else {
            for (const file of plan.inventory) {
              const preserved = join(locations.blobs, `${file.digest.slice(7)}.bin`);
              if (!present(preserved)) {
                if (file.path.startsWith('git/ai-delivery/writers@1/')) {
                  if (previousBytes === undefined || digestBytes(previousBytes) !== file.digest)
                    throw new DeliveryError('Original writer was lost before preservation.');
                  preserveBytes(locations.blobs, previousBytes);
                } else preserveTransitionEvidence(locations.blobs, [file]);
              }
              requirePreservedBytes(locations.blobs, file.digest);
            }
            const actualDigest = previousBytes === undefined ? null : digestBytes(previousBytes);
            if (!permittedWriterStates(intent, steps).includes(actualDigest))
              throw new DeliveryError(
                'Writer bytes/absence are outside the latest exact transition claim/release lineage.',
              );
            if (actualDigest !== null) requirePreservedBytes(locations.blobs, actualDigest);
          }
          previousBytesDigest = previousBytes === undefined ? null : digestBytes(previousBytes);
          requirePreservedBytes(locations.blobs, intent.originalRegistryDigest);
          requireAttemptBytes(locations.blobs, intent, steps);
          step('authority', {
            bytesDigest: preserveBytes(locations.blobs, Buffer.from(stableJson(authority))),
            relinquishmentCommentId: input.relinquishmentCommentId,
            acceptanceCommentId: input.acceptanceCommentId,
          });
          for (const hold of plan.holdEvidence) {
            const comment = (
              await context.clients.rest.issues.getComment({ ...context.repo, comment_id: hold.commentId })
            ).data;
            if (preserveBytes(locations.blobs, Buffer.from(stableJson(comment))) !== hold.digest)
              throw new DeliveryError('Retained hold changed during preservation.');
          }
        });
      },
      recordClaim: (bytes) => {
        claimedBytesDigest = preserveBytes(locations.blobs, bytes);
        step('claim', { bytesDigest: claimedBytesDigest, previousBytesDigest });
      },
      afterClaim: (bytes) => {
        if (digestBytes(bytes) !== claimedBytesDigest)
          throw new DeliveryError('Actual writer claim bytes disagree with their recorded intent.');
        step('claimed', { bytesDigest: claimedBytesDigest });
      },
      recordRelease: (bytes) => {
        if (digestBytes(bytes) !== claimedBytesDigest)
          throw new DeliveryError('Writer changed before its exact recorded release.');
        step('release', { bytesDigest: preserveBytes(locations.blobs, bytes) });
      },
      afterRelease: async () => {
        step('released', { absent: true });
        if (!operationComplete || !intent) return;
        await withWorktreeTransitionRegistry(plan, async ({ current }) => {
          if (stableJson(current ?? null) !== stableJson(rowAfter))
            throw new DeliveryError('Transition row changed before completion sealing.');
          for (const file of plan.inventory) requirePreservedBytes(locations.blobs, file.digest);
          const attempts = readSteps(stepsDirectory, intent!);
          requireAttemptBytes(locations.blobs, intent!, attempts);
          const content = {
            schemaVersion: 'ai-delivery.worktree-transition-completion@1',
            planId: plan.planId,
            intentId: intent!.intentId,
            completed: true,
            writerReleased: true,
            result,
            rowAfter,
            inventoryId: plan.inventoryId,
            attempts: attempts.map((record) => record.stepId),
            completedAt: new Date().toISOString(),
          };
          immutableJson(completionPath, { ...content, completionId: digestValue(content) });
        });
      },
    },
    async () => {
      await withWorktreeTransitionRegistry(plan, async ({ current, writeOwner, commitRow, removeRow }) => {
        const removalAuthorized = priorSteps.some((record) => record.event === 'removal-intent');
        await revalidateTransition(context, plan, false, removalAuthorized, input.runtimeEntryPath);
        await assertWorktreeTransitionNativeAuthority(context, plan, input);
        if (current !== undefined) {
          writeOwner();
          step('owner', { exactWitness: true });
          rowAfter = commitRow();
          step('row', { rowDigest: digestValue(rowAfter) });
        }
        if (plan.disposition === 'remove') {
          step('removal-intent', { head: plan.head, path: plan.row.path });
          removeMergedSourceForTransition(plan, historicalConfiguration(context).remote);
          if (present(plan.row.path)) throw new DeliveryError('Terminal source removal readback is not absent.');
          step('removed', { absent: true });
          removeRow();
          rowAfter = null;
        }
        operationComplete = true;
      });
    },
  );
  return { planId: plan.planId, result, replayed: priorSteps.length > 0, receiptPath: completionPath };
}

/** @internal Shared personal-operator and distinct configured App authority. */
export async function authenticatedWorktreeActors(context: DeliveryContext) {
  if (
    context.clients.authSource !== 'personal' ||
    context.clients.role !== 'author' ||
    !context.clients.authenticatedAuthor
  )
    throw new DeliveryError('Worktree relinquishment requires the configured authenticated personal operator.');
  const operator = await context.clients.authenticatedAuthor();
  if (!/^user:[1-9]\d*$/u.test(operator.credentialIdentity))
    throw new DeliveryError('Operator user identity is unavailable.');
  const reviewer = await createDeliveryGitHubClients({
    config: context.config,
    identity: context.config.roles.reviewer.identity,
    role: 'reviewer',
    selectedAuthor: context.clients,
  });
  if (reviewer.authSource !== 'app' || !reviewer.appActorLogin)
    throw new DeliveryError('Configured reviewer App identity is unavailable.');
  const reviewerActor = await reviewer.appActorLogin();
  if (reviewerActor.toLowerCase() === operator.actorLogin.toLowerCase())
    throw new DeliveryError('Transition acceptance requires a distinct configured reviewer App.');
  return { operator, reviewerActor, reviewer };
}

export function worktreeRelinquishmentBody(plan: WorktreeTransitionPlan): string {
  return stableJson({
    schemaVersion: 'ai-delivery.worktree-relinquishment@1',
    plan: nativeCommentPlan(plan),
    acceptedScope: 'the-complete-content-addressed-plan-and-every-original-in-its-inventory',
    authority: 'relinquish-only-the-inventoried-public-posix-writers',
    operationalClosure:
      'the-inventory-is-the-complete-remaining-launcher-writer-and-managed-process-set-all-are-quiescent-no-unknown-resources',
    maintainedExclusion:
      'all-old-launchers-and-writers-remain-excluded-through-apply-including-interruption-and-exact-plan-replay',
    historicalAuthority: 'preservation-only-no-current-verification-review-or-retirement-authority',
    sourceDisposition:
      plan.disposition === 'remove'
        ? 'no-outstanding-holds-remove-only-clean-merged-source'
        : 'retain-source-and-all-outstanding-holds',
    exclusions: [
      'private-adoption',
      'hold-release',
      'launcher-changes',
      'shared-runtime-admission',
      'legacy-protocol-retirement',
    ],
  });
}

export function worktreeAcceptanceBody(plan: WorktreeTransitionPlan, relinquishmentCommentId: number): string {
  return stableJson({
    schemaVersion: 'ai-delivery.worktree-transition-acceptance@1',
    plan: nativeCommentPlan(plan),
    acceptedScope:
      'independent-acceptance-of-the-complete-content-addressed-plan-and-inventory-including-complete-launcher-set-and-maintained-exclusion',
    relinquishmentCommentId,
    relinquishmentDigest: digestBytes(Buffer.from(worktreeRelinquishmentBody(plan))),
    result: 'approved',
  });
}

function nativeCommentPlan(raw: WorktreeTransitionPlan) {
  const plan = WorktreeTransitionPlanSchema.parse(raw);
  return {
    planId: plan.planId,
    inventoryId: plan.inventoryId,
    repository: plan.repository,
    repoRoot: plan.repoRoot,
    row: plan.row,
    head: plan.head,
    purpose: plan.purpose,
    disposition: plan.disposition,
    terminalPrNumber: plan.terminalPrNumber,
    lineage: plan.lineage,
    remoteRefs: plan.remoteRefs,
    holdEvidence: plan.holdEvidence,
    closure: plan.closure,
    currentRuntimeId: plan.currentRuntime.admissionId,
    currentConfigDigest: plan.currentRuntime.configDigest,
    policyDigest: plan.policyDigest,
    operator: plan.operator,
    reviewerActor: plan.reviewerActor,
    historicalProducer: plan.historicalProducer,
  };
}

/** Whole native bodies and the configured live actors are authority; local digests alone are not. */
export async function assertWorktreeTransitionNativeAuthority(
  context: DeliveryContext,
  plan: WorktreeTransitionPlan,
  ids: {
    relinquishmentCommentId: number;
    acceptanceCommentId: number;
  },
): Promise<{ relinquishment: unknown; acceptance: unknown }> {
  const actors = await authenticatedWorktreeActors(context);
  if (stableJson(actors.operator) !== stableJson(plan.operator) || actors.reviewerActor !== plan.reviewerActor)
    throw new DeliveryError('Configured transition authority identities drifted.');
  if (plan.lineage.some((pr) => pr.authorLogin.toLowerCase() === actors.reviewerActor.toLowerCase()))
    throw new DeliveryError('Configured transition reviewer App is also the native PR author.');
  const subject = plan.terminalPrNumber ?? plan.row.issueNumber;
  return assertNativeWorktreeAcceptance(context, {
    repository: plan.repository,
    subject,
    operator: plan.operator,
    reviewerActor: plan.reviewerActor,
    authorityCommentId: ids.relinquishmentCommentId,
    acceptanceCommentId: ids.acceptanceCommentId,
    operatorBody: worktreeRelinquishmentBody(plan),
    reviewerBody: worktreeAcceptanceBody(plan, ids.relinquishmentCommentId),
    revokedBody: stableJson({
      schemaVersion: 'ai-delivery.worktree-relinquishment-revocation@1',
      planId: plan.planId,
      relinquishmentCommentId: ids.relinquishmentCommentId,
    }),
  });
}

/** @internal Whole native comments are checked afresh by both preservation transitions. */
export async function assertNativeWorktreeAcceptance(
  context: DeliveryContext,
  input: {
    repository: string;
    subject: number;
    operator: { actorLogin: string; credentialIdentity: string };
    reviewerActor: string;
    authorityCommentId: number;
    acceptanceCommentId: number;
    operatorBody: string;
    reviewerBody: string;
    revokedBody: string;
  },
): Promise<{ relinquishment: unknown; acceptance: unknown }> {
  const actors = await authenticatedWorktreeActors(context);
  if (stableJson(actors.operator) !== stableJson(input.operator) || actors.reviewerActor !== input.reviewerActor)
    throw new DeliveryError('Configured transition authority identities drifted.');
  const subject = input.subject;
  const issueUrl = `https://api.github.com/repos/${input.repository}/issues/${String(subject)}`;
  const relinquishment = (
    await context.clients.rest.issues.getComment({ ...context.repo, comment_id: input.authorityCommentId })
  ).data;
  const acceptance = (
    await actors.reviewer.rest.issues.getComment({ ...context.repo, comment_id: input.acceptanceCommentId })
  ).data;
  if (
    relinquishment?.id !== input.authorityCommentId ||
    relinquishment.issue_url?.toLowerCase() !== issueUrl.toLowerCase() ||
    relinquishment.user?.type !== 'User' ||
    relinquishment.user?.login.toLowerCase() !== actors.operator.actorLogin.toLowerCase() ||
    `user:${String(relinquishment.user?.id)}` !== actors.operator.credentialIdentity ||
    relinquishment.body !== input.operatorBody
  )
    throw new DeliveryError('Native operator relinquishment is missing, changed or belongs to another subject.');
  if (
    acceptance?.id !== input.acceptanceCommentId ||
    acceptance.issue_url?.toLowerCase() !== issueUrl.toLowerCase() ||
    acceptance.user?.type !== 'Bot' ||
    acceptance.user.login.toLowerCase() !== actors.reviewerActor.toLowerCase() ||
    acceptance.body !== input.reviewerBody
  )
    throw new DeliveryError('Native configured reviewer-App exact-plan acceptance is missing or changed.');
  for (let page = 1; ; page += 1) {
    const comments = (
      await context.clients.rest.issues.listComments({ ...context.repo, issue_number: subject, per_page: 100, page })
    ).data;
    if (
      comments.some(
        (comment) =>
          comment.body === input.revokedBody &&
          comment.user?.login.toLowerCase() === actors.operator.actorLogin.toLowerCase() &&
          `user:${String(comment.user.id)}` === actors.operator.credentialIdentity,
      )
    )
      throw new DeliveryError('Native operator relinquishment has been revoked.');
    if (comments.length < 100) break;
  }
  return { relinquishment, acceptance };
}

/** @internal The native repository and closing-issue relationship must match historical custody. */
export async function readNativeWorktreePrLineage(context: DeliveryContext, issueNumber: number, prNumber: number) {
  const pr = (await context.clients.rest.pulls.get({ ...context.repo, pull_number: prNumber })).data;
  const result = await context.clients.graphql<{
    repository: {
      pullRequest: {
        closingIssuesReferences: {
          nodes: { number: number; repository: { nameWithOwner: string } }[];
          pageInfo: { hasNextPage: boolean };
        };
      } | null;
    };
  }>(
    `query WorktreeTransitionLineage($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
      closingIssuesReferences(first: 100) { nodes { number repository { nameWithOwner } } pageInfo { hasNextPage } }
    } }
  }`,
    { ...context.repo, number: prNumber },
  );
  const closing = result.repository.pullRequest?.closingIssuesReferences;
  if (
    pr.number !== prNumber ||
    pr.head.repo?.full_name.toLowerCase() !== context.config.repository.toLowerCase() ||
    pr.base.repo.full_name.toLowerCase() !== context.config.repository.toLowerCase() ||
    !closing ||
    closing.pageInfo.hasNextPage ||
    !closing.nodes.some(
      (issue) =>
        issue.number === issueNumber &&
        issue.repository.nameWithOwner.toLowerCase() === context.config.repository.toLowerCase(),
    )
  )
    throw new DeliveryError('Native PR lineage does not establish the exact repository and closing issue.');
  return NativePrSchema.parse({
    prNumber,
    headSha: pr.head.sha,
    headBranch: pr.head.ref,
    baseSha: pr.base.sha,
    baseBranch: pr.base.ref,
    mergeSha: pr.merge_commit_sha,
    merged: pr.merged,
    authorLogin: pr.user?.login,
  });
}

async function readTransitionLineage(context: DeliveryContext, row: WorktreeEntry, terminalPrNumber: number | null) {
  const numbers = [
    ...new Set(
      [row.prNumber, terminalPrNumber].filter((number): number is number => number !== undefined && number !== null),
    ),
  ];
  return Promise.all(numbers.map((number) => readNativeWorktreePrLineage(context, row.issueNumber!, number)));
}

function assertTransitionPurpose(
  root: string,
  row: WorktreeEntry,
  purpose: WorktreeTransitionPlan['purpose'],
  terminalPrNumber: number | null,
  head: WorktreeTransitionPlan['head'],
  lineage: WorktreeTransitionPlan['lineage'],
  issueState: string,
  inventory: readonly TransitionEvidenceFile[],
): void {
  if (purpose === 'active-resume') {
    if (
      !['active', 'pr-published'].includes(row.status) ||
      issueState !== 'open' ||
      lineage.some((pr) => pr.merged || pr.headSha !== head.sha || pr.headBranch !== row.branch)
    )
      throw new DeliveryError('Active resume requires the exact open issue and unmerged source lineage.');
    if (
      inventory.some((file) =>
        /^git\/ai-delivery\/(?:publications|reviews|merges|merge-intents|merge-attempts|merge-results)\//u.test(
          file.path,
        ),
      )
    )
      throw new DeliveryError(
        'Existing current publication/review/merge slots require separate authority reconciliation; active resume cannot overwrite them.',
      );
  } else {
    const terminal = lineage.find((pr) => pr.prNumber === terminalPrNumber);
    if (
      !terminal ||
      issueState !== 'closed' ||
      !terminal.merged ||
      terminal.headSha !== head.sha ||
      terminal.headBranch !== row.branch ||
      lineage.some(
        (pr) =>
          !pr.merged ||
          !pr.mergeSha ||
          pr.headBranch !== row.branch ||
          pr.baseBranch !== terminal.baseBranch ||
          gitExitCode(
            root,
            'merge-base',
            '--is-ancestor',
            pr.mergeSha,
            pr.prNumber === terminal.prNumber ? terminal.mergeSha! : head.sha,
          ) !== 0,
      )
    )
      throw new DeliveryError(
        'Terminal native PR lineage or merged-result ancestry does not bind the retained exact source.',
      );
  }
}

async function nativeRemoteRefs(context: DeliveryContext, headBranch: string, baseBranch: string) {
  const read = async (branch: string) => {
    try {
      const result = (await context.clients.rest.repos.getBranch({ ...context.repo, branch })).data;
      if (result.name !== branch) throw new DeliveryError('Native branch readback belongs to another ref.');
      return ShaSchema.parse(result.commit.sha);
    } catch (error) {
      if ((error as { status?: number }).status === 404) return null;
      throw error;
    }
  };
  const headSha = await read(headBranch);
  const baseSha = await read(baseBranch);
  if (baseSha === null) throw new DeliveryError('Native retaining base branch is missing.');
  return { headSha, baseSha };
}

export async function inspectWorktreeTransition(
  context: DeliveryContext,
  input: InspectWorktreeTransitionInput,
): Promise<{
  ready: boolean;
  blockers: string[];
  plan: WorktreeTransitionPlan | null;
  inventory: TransitionEvidenceFile[];
  relinquishmentBody?: string;
}> {
  const blockers: string[] = [];
  const root = primaryGitRoot(context.root);
  const matching = listWorktreesStrict(root).filter(
    (row) => row.type === 'issue' && row.issueNumber === input.issueNumber,
  );
  if (matching.length !== 1)
    return { ready: false, blockers: ['Expected one canonical legacy issue row.'], plan: null, inventory: [] };
  const inventory: TransitionEvidenceFile[] = [];
  try {
    const row = RowSchema.parse(matching[0]) as WorktreeTransitionPlan['row'] & WorktreeEntry;
    inventory.push(...inventoryTransitionEvidence(root, row));
    if (!context.configuration || context.config.repository !== `${context.repo.owner}/${context.repo.repo}`)
      throw new DeliveryError('Transition requires exact current repository configuration.');
    if (
      row.path !== join(root, '.worktrees', `issue-${String(row.issueNumber)}`) ||
      row.branch !== `issue/${String(row.issueNumber)}` ||
      gitRoot(row.path) !== realpathSync(row.path) ||
      gitCommonDir(row.path) !== gitCommonDir(root) ||
      git(row.path, 'branch', '--show-current') !== row.branch
    )
      throw new DeliveryError('Legacy row path, branch or Git ownership disagrees.');
    assertClean(row.path);
    for (const family of ['v1', 'v2']) {
      if (present(join(gitCommonDir(root), 'issue-cli', 'verification-stages', family)))
        blockers.push(
          `Unsupported operative issue-cli verification-stages/${family}; no authenticated supported operational closure is available.`,
        );
    }
    if (!input.retainedAdmissionPath || !input.retainedArchivePath)
      blockers.push(
        'Missing retained supported public producer admission/archive and operational closure. Historical UNKNOWN is preservation-only.',
      );
    if (blockers.length > 0) return { ready: false, blockers, plan: null, inventory };
    const currentRuntime = await assertDeliveryRuntimeAdmitted({
      repoRoot: root,
      configuration: context.configuration,
      ...(input.runtimeEntryPath === undefined ? {} : { runtimeEntryPath: input.runtimeEntryPath }),
    });
    const { inventory: producerInventory, ...producer } = retainedProducer(
      context,
      realpathSync(input.retainedAdmissionPath!),
      realpathSync(input.retainedArchivePath!),
    );
    inventory.push(...producerInventory);
    const head = { sha: git(row.path, 'rev-parse', 'HEAD'), tree: git(row.path, 'rev-parse', 'HEAD^{tree}') };
    const runManifestIds = requireSupportedRunClosure(root, row, inventory, producer.producerDigest, head);
    if (
      inventory
        .filter((file) => file.path.startsWith('git/ai-delivery/runs@2/'))
        .some(
          (file) =>
            readWorktreeTransitionRun(evidenceBytes(file.source)).classification.repository !==
            context.config.repository,
        )
    )
      throw new DeliveryError('Operational run inventory belongs to another repository.');
    if (
      input.disposition === 'remove' &&
      producerInventory.some((file) => {
        const rel = relative(row.path, file.source);
        return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
      })
    )
      throw new DeliveryError('Retained operational producer must remain outside the source selected for removal.');
    const writer = inventory.find((file) => file.path.startsWith('git/ai-delivery/writers@1/'));
    assertWorktreeTransitionWriterQuiescent(row.path, writer === undefined ? undefined : evidenceBytes(writer.source));
    const terminalPrNumber =
      input.purpose === 'merged-cleanup' ? (input.terminalPrNumber ?? row.prNumber ?? null) : null;
    const lineage = await readTransitionLineage(context, row, terminalPrNumber);
    const issue = (await context.clients.rest.issues.get({ ...context.repo, issue_number: row.issueNumber })).data;
    assertTransitionPurpose(root, row, input.purpose, terminalPrNumber, head, lineage, issue.state, inventory);
    const actors = await authenticatedWorktreeActors(context);
    if (lineage.some((pr) => pr.authorLogin.toLowerCase() === actors.reviewerActor.toLowerCase()))
      throw new DeliveryError('Configured transition reviewer App is also the native PR author.');
    const remoteRefs =
      input.disposition === 'remove'
        ? await nativeRemoteRefs(
            context,
            row.branch,
            lineage.find((pr) => pr.prNumber === terminalPrNumber)!.baseBranch,
          )
        : null;
    if (
      remoteRefs &&
      ((remoteRefs.headSha !== null && remoteRefs.headSha !== head.sha) ||
        git(root, 'rev-parse', defaultBaseRef(root, historicalConfiguration(context).remote)) !== remoteRefs.baseSha)
    )
      throw new DeliveryError('Native remote branch readback disagrees with exact source or local retaining ref.');
    const retainedHoldCommentIds = [...(input.retainedHoldCommentIds ?? [])].sort((a, b) => a - b);
    if (new Set(retainedHoldCommentIds).size !== retainedHoldCommentIds.length)
      throw new DeliveryError('Retained hold inventory has duplicates.');
    const holdEvidence = [];
    for (const id of retainedHoldCommentIds) {
      const comment = (await context.clients.rest.issues.getComment({ ...context.repo, comment_id: id })).data;
      if (
        !comment.body ||
        comment.issue_url?.toLowerCase() !==
          `https://api.github.com/repos/${context.config.repository}/issues/${String(terminalPrNumber ?? row.issueNumber)}`.toLowerCase()
      )
        throw new DeliveryError('Retained hold comment belongs to another subject or is unavailable.');
      const bytes = Buffer.from(stableJson(comment));
      holdEvidence.push({ commentId: id, digest: digestBytes(bytes) });
    }
    inventory.sort((left, right) => left.path.localeCompare(right.path));
    const content = {
      schemaVersion: 'ai-delivery.worktree-transition-plan@1' as const,
      repository: context.config.repository,
      repoRoot: root,
      row,
      purpose: input.purpose,
      disposition: input.disposition ?? 'retain',
      head,
      terminalPrNumber,
      lineage,
      remoteRefs,
      retainedHoldCommentIds,
      holdEvidence,
      inventory,
      inventoryId: digestValue(inventory),
      historicalProducer: 'UNKNOWN' as const,
      closure: { family: 'public-ai-delivery-0.3.5-posix@1' as const, ...producer, runManifestIds },
      currentRuntime,
      policyDigest: digestBytes(evidenceBytes(historicalConfiguration(context).policyModulePath)),
      operator: actors.operator,
      reviewerActor: actors.reviewerActor,
    };
    const plan = WorktreeTransitionPlanSchema.parse({ ...content, planId: digestValue(content) });
    return { ready: true, blockers, plan, inventory, relinquishmentBody: worktreeRelinquishmentBody(plan) };
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error));
    return { ready: false, blockers, plan: null, inventory };
  }
}

/** Original copies are immutable and content addressed; every source is checked again before capture. */
export function preserveTransitionEvidence(directory: string, inventory: readonly TransitionEvidenceFile[]): void {
  for (const file of inventory) {
    const bytes = evidenceBytes(file.source);
    if (bytes.length !== file.size || digestBytes(bytes) !== file.digest)
      throw new DeliveryError(`Historical evidence drifted: ${file.path}`);
    writeCreateOnly(join(directory, `${file.digest.slice(7)}.bin`), bytes, file.digest);
  }
}

function historicalConfiguration(context: DeliveryContext): LoadedDeliveryConfig {
  if (!context.configuration || !('policyModulePath' in context.configuration))
    throw new DeliveryError(
      'Historical repository configuration binding is unsupported by this runtime; preserve its original controller and records. No policy module was loaded.',
    );
  return context.configuration;
}
