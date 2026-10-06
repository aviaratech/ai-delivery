import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

import {
  assertPrivateFile,
  CoordinateSchema,
  DigestSchema,
  digestBytes,
  stableJson,
  writeCreateOnly,
} from '../delivery/common.js';
import { digestValue } from '../delivery/index.js';
import { gitCommonDir } from '../git.js';
import { RuntimeAdmissionSchema } from './deliveryAdmission.js';
import type { WorktreeTransitionPlan } from '../worktreeTransition.js';
import { logInfo, logWarn } from '../logger.js';
import { ensureDataDirectory, ISSUE_CLI_DATA_DIR } from '../utils/filesystem.js';
import {
  ensurePrivateDirectoryDurably,
  writeJsonFileAtomically,
  writePrivateJsonFileAtomically,
} from '../utils/atomicJson.js';
import { withLock } from '../utils/lockfile.js';

export interface WorktreeEntry {
  branch: string;
  createdAt: string;
  /** Agent identity that prepared the worktree; hook-context commands (lint-guard) fall back to it. */
  identity?: string;
  issueNumber?: number;
  path: string;
  prNumber?: number;
  status: WorktreeStatus;
  type: 'issue' | 'pr' | 'standalone';
  updatedAt: string;
}

export type WorktreeStatus = 'active' | 'error' | 'merged' | 'pr-published' | 'stale';

interface WorktreeRegistry {
  worktrees: WorktreeEntry[];
}

const REGISTRY_PATH = `${ISSUE_CLI_DATA_DIR}/worktrees.json`;
const LOCK_RETRY_MESSAGE = 'Worktree registry locked by another process. Retrying...';

const ContinuationRowSchema = z
  .strictObject({
    branch: z.string().min(1),
    createdAt: z.string().min(1),
    identity: z.string().min(1),
    issueNumber: z.number().int().positive(),
    path: z.string().min(1),
    prNumber: z.number().int().positive().optional(),
    status: z.enum(['active', 'error', 'merged', 'pr-published', 'stale']),
    type: z.literal('issue'),
    updatedAt: z.string().min(1),
  })
  .transform(({ prNumber, ...row }) => ({ ...row, ...(prNumber === undefined ? {} : { prNumber }) }));
/** @internal Private exact-plan checkpoint; it is not a public transition purpose. */
export const CommittedContinuationPlanSchema = z
  .strictObject({
    schemaVersion: z.literal('ai-delivery.committed-continuation-plan@1'),
    planId: DigestSchema,
    repository: z.string().min(1),
    repoRoot: z.string().min(1),
    configDigest: DigestSchema,
    currentRuntime: RuntimeAdmissionSchema,
    row: ContinuationRowSchema,
    replacement: ContinuationRowSchema,
    head: CoordinateSchema,
    terminalHead: CoordinateSchema,
    terminalMergeId: DigestSchema,
    operator: z.strictObject({
      actorLogin: z.string().min(1),
      credentialIdentity: z.string().regex(/^user:[1-9]\d*$/u),
    }),
    reviewerActor: z.string().min(1),
    preserved: z.array(z.strictObject({ path: z.string().min(1), digest: DigestSchema })).min(1),
  })
  .superRefine((plan, ctx) => {
    const { planId, ...content } = plan;
    const { prNumber: _pr, identity: _identity, status: _status, updatedAt: _updated, ...original } = plan.row;
    const { identity: _newIdentity, status: _newStatus, updatedAt: _newUpdated, ...replacement } = plan.replacement;
    if (
      planId !== digestValue(content) ||
      plan.row.status !== 'merged' ||
      !plan.row.prNumber ||
      plan.replacement.status !== 'active' ||
      plan.replacement.prNumber !== undefined ||
      stableJson(original) !== stableJson(replacement) ||
      plan.head.sha === plan.terminalHead.sha ||
      new Set(plan.preserved.map((file) => file.path)).size !== plan.preserved.length
    )
      ctx.addIssue({ code: 'custom', message: 'Committed continuation plan identity or disposition is invalid.' });
  });
export type CommittedContinuationPlan = z.infer<typeof CommittedContinuationPlanSchema>;
const ContinuationIntentSchema = z
  .strictObject({
    schemaVersion: z.literal('ai-delivery.committed-continuation-intent@1'),
    intentId: DigestSchema,
    plan: CommittedContinuationPlanSchema,
    authorityCommentId: z.number().int().positive(),
    acceptanceCommentId: z.number().int().positive(),
  })
  .superRefine(({ intentId, ...content }, ctx) => {
    if (intentId !== digestValue(content))
      ctx.addIssue({ code: 'custom', message: 'Continuation intent identity is invalid.' });
  });
type ContinuationIntent = z.infer<typeof ContinuationIntentSchema>;
const ContinuationCompletionSchema = z
  .strictObject({
    schemaVersion: z.literal('ai-delivery.committed-continuation-completion@1'),
    completionId: DigestSchema,
    intentId: DigestSchema,
    planId: DigestSchema,
    row: ContinuationRowSchema,
    head: CoordinateSchema,
    completed: z.literal(true),
  })
  .superRefine(({ completionId, ...content }, ctx) => {
    if (completionId !== digestValue(content))
      ctx.addIssue({ code: 'custom', message: 'Continuation completion identity is invalid.' });
  });

export function committedContinuationPlanPath(root: string, issueNumber: number, head: string): string {
  return join(gitCommonDir(root), 'ai-delivery', 'continuations', String(issueNumber), `${head}.plan.json`);
}
function continuationIntentPath(plan: CommittedContinuationPlan): string {
  return committedContinuationPlanPath(plan.repoRoot, plan.row.issueNumber, plan.head.sha).replace(
    /\.plan\.json$/u,
    '.intent.json',
  );
}
function continuationCompletionPath(plan: CommittedContinuationPlan): string {
  return continuationIntentPath(plan).replace(/\.intent\.json$/u, '.completion.json');
}
function continuationBeforeimagePath(plan: CommittedContinuationPlan, digest: string): string {
  return join(gitCommonDir(plan.repoRoot), 'ai-delivery', 'continuations', 'evidence', `${digest.slice(7)}.bin`);
}
function assertContinuationPreserved(plan: CommittedContinuationPlan, beforeimages = false): void {
  for (const file of plan.preserved) {
    if (
      digestBytes(assertPrivateFile(file.path)) !== file.digest ||
      (beforeimages && digestBytes(assertPrivateFile(continuationBeforeimagePath(plan, file.digest))) !== file.digest)
    )
      throw new Error('Committed continuation original evidence changed.');
  }
  if (beforeimages) {
    const bytes = Buffer.from(stableJson(plan.row));
    if (!assertPrivateFile(continuationBeforeimagePath(plan, digestBytes(bytes))).equals(bytes))
      throw new Error('Committed continuation original row beforeimage changed.');
  }
}

/** @internal Pending intents are recoverable only by the same supported develop boundary. */
export function pendingCommittedContinuation(issueNumber: number, root: string): ContinuationIntent | undefined {
  const directory = join(gitCommonDir(root), 'ai-delivery', 'continuations', String(issueNumber));
  if (!existsSync(directory)) return undefined;
  let pending: ContinuationIntent | undefined;
  for (const name of readdirSync(directory)
    .filter((name) => name.endsWith('.intent.json'))
    .sort()) {
    const intent = ContinuationIntentSchema.parse(
      JSON.parse(assertPrivateFile(join(directory, name)).toString('utf8')),
    );
    const plan = intent.plan;
    if (
      plan.repoRoot !== resolve(root) ||
      plan.row.issueNumber !== issueNumber ||
      join(directory, name) !== continuationIntentPath(plan)
    )
      throw new Error('Committed continuation checkpoint identity disagrees.');
    assertContinuationPreserved(plan, true);
    const completionPath = continuationCompletionPath(plan);
    if (existsSync(completionPath)) {
      const completion = ContinuationCompletionSchema.parse(
        JSON.parse(assertPrivateFile(completionPath).toString('utf8')),
      );
      if (
        completion.intentId !== intent.intentId ||
        completion.planId !== plan.planId ||
        stableJson(completion.row) !== stableJson(plan.replacement) ||
        stableJson(completion.head) !== stableJson(plan.head)
      )
        throw new Error('Committed continuation completion disagrees with its intent.');
      assertOwnerWitness(plan.replacement, root);
      // Terminal recovery validates existing ancestors and repairs their directory durability.
      prepareCommittedContinuationDirectory(root, directory, false);
      prepareCommittedContinuationDirectory(
        root,
        dirname(continuationBeforeimagePath(plan, plan.preserved[0]!.digest)),
        false,
      );
      syncCommittedContinuationDirectory(completionPath);
    } else {
      if (pending) throw new Error('Issue has multiple incomplete committed continuations.');
      pending = intent;
    }
  }
  return pending;
}

function ownerContent(entry: WorktreeEntry): Record<string, unknown> {
  if (!entry.identity) throw new Error('ai-delivery worktree ownership requires the preparing identity.');
  return {
    branch: entry.branch,
    identity: entry.identity,
    ...(entry.issueNumber === undefined ? {} : { issueNumber: entry.issueNumber }),
    path: entry.path,
    ...(entry.prNumber === undefined || entry.type === 'issue' ? {} : { prNumber: entry.prNumber }),
    schemaVersion: 'ai-delivery.worktree-owner@1',
    type: entry.type,
  };
}

function ownerPath(root: string, entry: WorktreeEntry): string {
  const id = digestValue(ownerContent(entry)).slice('sha256:'.length);
  return join(gitCommonDir(root), 'ai-delivery', 'worktree-owners', `${id}.json`);
}

function assertNoIncompleteWorktreeTransition(entry: WorktreeEntry, root: string): void {
  if (entry.type !== 'issue' || entry.issueNumber === undefined) return;
  const path = join(
    gitCommonDir(root),
    'ai-delivery',
    'worktree-owners',
    `issue-${String(entry.issueNumber)}.transition.json`,
  );
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('Worktree transition is incomplete or unreadable.');
  }
  try {
    const intent = JSON.parse(assertPrivateFile(path).toString('utf8')) as {
      schemaVersion: string;
      intentId: string;
      plan: WorktreeTransitionPlan;
    };
    const { intentId, ...content } = intent;
    const { planId, ...planContent } = intent.plan;
    if (
      intent.schemaVersion !== 'ai-delivery.worktree-transition-intent@1' ||
      intentId !== digestValue(content) ||
      planId !== digestValue(planContent) ||
      intent.plan.repoRoot !== resolve(root) ||
      intent.plan.row.issueNumber !== entry.issueNumber
    )
      throw new Error('Invalid transition intent.');
    if (intent.plan.purpose === 'merged-cleanup')
      throw new Error('Worktree transition is terminal and cannot authorize ordinary source operations.');
    const completionPath = join(`${path}.evidence`, 'completion.json');
    const completion = JSON.parse(assertPrivateFile(completionPath).toString('utf8')) as {
      schemaVersion: string;
      planId: string;
      intentId: string;
      completed: boolean;
      completionId: string;
    };
    const { completionId, ...completionContent } = completion;
    if (
      completion.schemaVersion !== 'ai-delivery.worktree-transition-completion@1' ||
      completion.planId !== planId ||
      completion.intentId !== intentId ||
      completion.completed !== true ||
      completionId !== digestValue(completionContent) ||
      JSON.stringify(ownerContent(entry)) !== JSON.stringify(ownerContent(intent.plan.row as WorktreeEntry))
    )
      throw new Error('Invalid transition completion.');
    return;
  } catch (error) {
    if (error instanceof Error && error.message.includes('transition is terminal')) throw error;
    throw new Error('Worktree transition is incomplete or unreadable; resume its exact approved plan.');
  }
}

/** An immutable witness separates new rows from legacy rows in the same canonical registry. */
export function assertAiDeliveryWorktreeOwner(entry: WorktreeEntry, root: string): void {
  assertNoIncompleteWorktreeTransition(entry, root);
  if (entry.issueNumber !== undefined && pendingCommittedContinuation(entry.issueNumber, root))
    throw new Error('Committed continuation is pending or incomplete; resume supported develop.');
  assertOwnerWitness(entry, root);
}

function assertOwnerWitness(entry: WorktreeEntry, root: string): void {
  const content = ownerContent(entry);
  const path = ownerPath(root, entry);
  let stored: unknown;
  try {
    stored = JSON.parse(assertPrivateFile(path).toString('utf8')) as unknown;
  } catch {
    throw new Error('Worktree lacks its exact ai-delivery ownership witness.');
  }
  if (JSON.stringify(stored) !== JSON.stringify({ ...content, ownerId: digestValue(content) })) {
    throw new Error('Worktree ownership witness disagrees with the canonical registry identity.');
  }
}

/** Ordinary source mutations also refuse terminal/pending issue intent after the row was removed. */
export function assertIssueWorktreeTransitionAdmission(
  issueNumber: number,
  root: string,
  committedRecovery = false,
): void {
  if (pendingCommittedContinuation(issueNumber, root) && !committedRecovery)
    throw new Error('Committed continuation is pending or incomplete; resume supported develop.');
  const path = join(
    gitCommonDir(root),
    'ai-delivery',
    'worktree-owners',
    `issue-${String(issueNumber)}.transition.json`,
  );
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('Worktree transition is incomplete or unreadable.');
  }
  let row: WorktreeEntry;
  try {
    row = (JSON.parse(assertPrivateFile(path).toString('utf8')) as { plan: { row: WorktreeEntry } }).plan.row;
    if (row.type !== 'issue' || row.issueNumber !== issueNumber)
      throw new Error('Transition embedded issue identity disagrees.');
  } catch {
    throw new Error('Worktree transition is incomplete or unreadable.');
  }
  assertNoIncompleteWorktreeTransition(row, root);
}

function writeWorktreeOwner(entry: WorktreeEntry, root: string, transition = false): void {
  const content = ownerContent(entry);
  writeCreateOnly(ownerPath(root, entry), Buffer.from(JSON.stringify({ ...content, ownerId: digestValue(content) })));
  if (!transition) assertAiDeliveryWorktreeOwner(entry, root);
}

/** @internal New continuation checkpoints are published only while both owning locks are held. */
export function writeCommittedContinuationCheckpoint(path: string, value: unknown): void {
  const assertEqual = () => {
    const stored: unknown = JSON.parse(assertPrivateFile(path).toString('utf8')) as unknown;
    if (stableJson(stored) !== stableJson(value)) throw new Error('Committed continuation checkpoint changed.');
  };
  try {
    assertEqual();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    writePrivateJsonFileAtomically(path, value);
    assertEqual();
  }
  // Retry completes durability if the prior publisher died after rename but before directory sync.
  syncCommittedContinuationDirectory(path);
}

function syncCommittedContinuationDirectory(path: string): void {
  const directory = openSync(dirname(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

/** Repair only this new namespace, anchored at the existing Git common directory. */
function prepareCommittedContinuationDirectory(root: string, directory: string, create = true): void {
  const deliveryDirectory = join(gitCommonDir(root), 'ai-delivery');
  const continuationRoot = join(deliveryDirectory, 'continuations');
  const paths = [deliveryDirectory, continuationRoot, directory];
  const validate = (path: string, missing: boolean) => {
    let metadata;
    try {
      metadata = lstatSync(path);
    } catch (error) {
      if (missing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (path !== deliveryDirectory && (metadata.mode & 0o077) !== 0)
    )
      throw new Error('Committed continuation evidence requires a private directory.');
  };
  for (const path of paths) validate(path, create && path !== deliveryDirectory);
  if (create) ensurePrivateDirectoryDurably(directory);
  for (const path of paths) {
    validate(path, false);
    // Existing mkdir state can be recovery from death before its parent was synced.
    syncCommittedContinuationDirectory(path);
  }
}

/** @internal One canonical row, its immutable witnesses, and the existing registry lock own this recovery. */
export async function withCommittedContinuationRegistry<T>(
  root: string,
  issueNumber: number,
  operation: (input: {
    current: WorktreeEntry;
    pending: ContinuationIntent | undefined;
    ownerWitness: { path: string; digest: string };
    prepare(this: void): void;
    begin(
      this: void,
      plan: CommittedContinuationPlan,
      ids: { authorityCommentId: number; acceptanceCommentId: number },
    ): void;
    commit(this: void): void;
    complete(this: void): void;
  }) => Promise<T>,
): Promise<T> {
  ensureRegistryDirectory(root);
  return withLock(REGISTRY_PATH, {
    projectRoot: root,
    timeout: 5000,
    operation: async () => {
      const pending = pendingCommittedContinuation(issueNumber, root);
      let intent = pending;
      let current: WorktreeEntry;
      const readCurrent = () => {
        const registry = loadRegistryStrict(root);
        const matches = registry.worktrees.filter((row) => row.type === 'issue' && row.issueNumber === issueNumber);
        const row = matches[0];
        if (matches.length !== 1 || !row)
          throw new Error('Committed continuation requires one exact canonical issue row.');
        if (registry.worktrees.some((other) => other !== row && registryIdentitiesOverlap(other, row)))
          throw new Error('Committed continuation overlaps another canonical owner.');
        assertNoIncompleteWorktreeTransition(row, root);
        assertOwnerWitness(row, root);
        return { registry, row };
      };
      current = readCurrent().row;
      if (
        pending &&
        ![pending.plan.row, pending.plan.replacement].some((row) => stableJson(row) === stableJson(current))
      )
        throw new Error('Committed continuation canonical row drifted.');
      const original = pending?.plan.row ?? current;
      assertOwnerWitness(original, root);
      const witnessPath = ownerPath(root, original);
      const ownerWitness = { path: witnessPath, digest: digestBytes(assertPrivateFile(witnessPath)) };
      return operation({
        current,
        pending,
        ownerWitness,
        prepare: () =>
          prepareCommittedContinuationDirectory(
            root,
            join(gitCommonDir(root), 'ai-delivery', 'continuations', String(issueNumber)),
          ),
        begin: (raw, ids) => {
          const plan = CommittedContinuationPlanSchema.parse(raw);
          if (
            plan.repoRoot !== resolve(root) ||
            plan.row.issueNumber !== issueNumber ||
            stableJson(plan.row) !== stableJson(original) ||
            !plan.preserved.some((file) => stableJson(file) === stableJson(ownerWitness))
          )
            throw new Error('Committed continuation lacks exact original custody.');
          const content = { schemaVersion: 'ai-delivery.committed-continuation-intent@1' as const, plan, ...ids };
          const next = ContinuationIntentSchema.parse({ ...content, intentId: digestValue(content) });
          if (intent && stableJson(next) !== stableJson(intent))
            throw new Error('Committed continuation intent drifted.');
          assertContinuationPreserved(plan);
          const evidenceDirectory = dirname(continuationBeforeimagePath(plan, plan.preserved[0]!.digest));
          prepareCommittedContinuationDirectory(root, evidenceDirectory);
          for (const file of plan.preserved)
            writeCreateOnly(continuationBeforeimagePath(plan, file.digest), assertPrivateFile(file.path), file.digest);
          const rowBytes = Buffer.from(stableJson(plan.row));
          writeCreateOnly(continuationBeforeimagePath(plan, digestBytes(rowBytes)), rowBytes, digestBytes(rowBytes));
          writeCommittedContinuationCheckpoint(continuationIntentPath(plan), next);
          intent = next;
        },
        commit: () => {
          if (!intent) throw new Error('Committed continuation lacks its durable intent.');
          const { registry, row } = readCurrent();
          if (stableJson(row) !== stableJson(current))
            throw new Error('Committed continuation canonical row changed before commit.');
          assertContinuationPreserved(intent.plan, true);
          const replacementOwner = ownerContent(intent.plan.replacement);
          writeCommittedContinuationCheckpoint(ownerPath(root, intent.plan.replacement), {
            ...replacementOwner,
            ownerId: digestValue(replacementOwner),
          });
          registry.worktrees.splice(registry.worktrees.indexOf(row), 1, intent.plan.replacement);
          saveRegistryStrict(root, registry);
          current = intent.plan.replacement;
        },
        complete: () => {
          if (!intent || stableJson(readCurrent().row) !== stableJson(intent.plan.replacement))
            throw new Error('Committed continuation replacement row is incomplete.');
          assertContinuationPreserved(intent.plan, true);
          assertOwnerWitness(intent.plan.replacement, root);
          const content = {
            schemaVersion: 'ai-delivery.committed-continuation-completion@1' as const,
            intentId: intent.intentId,
            planId: intent.plan.planId,
            row: intent.plan.replacement,
            head: intent.plan.head,
            completed: true as const,
          };
          writeCommittedContinuationCheckpoint(continuationCompletionPath(intent.plan), {
            ...content,
            completionId: digestValue(content),
          });
        },
      });
    },
  });
}

/** @internal The explicit transition owner holds the existing registry lock through its exact planned mutation. */
export async function withWorktreeTransitionRegistry<T>(
  plan: WorktreeTransitionPlan,
  operation: (input: {
    current: WorktreeEntry | undefined;
    writeOwner(this: void): void;
    commitRow(this: void): WorktreeEntry;
    removeRow(this: void): void;
  }) => Promise<T>,
): Promise<T> {
  const root = plan.repoRoot;
  if (pendingCommittedContinuation(plan.row.issueNumber, root))
    throw new Error('Committed continuation is pending or incomplete; resume supported develop.');
  ensureRegistryDirectory(root);
  return withLock(REGISTRY_PATH, {
    projectRoot: root,
    timeout: 5000,
    operation: async () => {
      const registry = loadRegistryStrict(root);
      const matches = registry.worktrees.filter(
        (entry) => entry.type === 'issue' && entry.issueNumber === plan.row.issueNumber,
      );
      if (matches.length > 1) throw new Error('Transition has duplicate canonical issue rows.');
      if (
        registry.worktrees.some(
          (entry) => !matches.includes(entry) && registryIdentitiesOverlap(entry, plan.row as WorktreeEntry),
        )
      )
        throw new Error('Transition conflicts with another canonical registry path, branch or PR identity.');
      let current = matches[0];
      const original: WorktreeEntry = {
        ...plan.row,
        ...(plan.row.prNumber === undefined ? {} : { prNumber: plan.row.prNumber }),
      } as WorktreeEntry;
      const replacement: WorktreeEntry =
        plan.purpose === 'active-resume'
          ? original
          : {
              ...original,
              prNumber: plan.terminalPrNumber!,
              status: 'merged',
            };
      if (
        current !== undefined &&
        ![original, replacement].some((allowed) => stableJson(current) === stableJson(allowed))
      )
        throw new Error('Transition canonical row drifted.');
      const intentPath = join(
        gitCommonDir(root),
        'ai-delivery',
        'worktree-owners',
        `issue-${String(plan.row.issueNumber)}.transition.json`,
      );
      const requireIntent = () => {
        const intent = JSON.parse(assertPrivateFile(intentPath).toString('utf8')) as { plan?: { planId?: string } };
        if (intent.plan?.planId !== plan.planId) throw new Error('Transition lacks its exact durable intent.');
      };
      return operation({
        current,
        writeOwner: () => {
          requireIntent();
          writeWorktreeOwner(replacement, root, true);
        },
        commitRow: () => {
          requireIntent();
          if (current === undefined) throw new Error('Transition cannot recreate a removed canonical row.');
          registry.worktrees.splice(registry.worktrees.indexOf(current), 1, replacement);
          current = replacement;
          saveRegistryStrict(root, registry);
          return replacement;
        },
        removeRow: () => {
          requireIntent();
          if (
            plan.purpose !== 'merged-cleanup' ||
            plan.disposition !== 'remove' ||
            plan.retainedHoldCommentIds.length !== 0
          )
            throw new Error('Transition lacks explicit unheld terminal source disposition.');
          if (current !== undefined) {
            registry.worktrees.splice(registry.worktrees.indexOf(current), 1);
            saveRegistryStrict(root, registry);
            current = undefined;
          }
        },
      });
    },
  });
}

/** @internal Validate the existing immutable witness without granting ordinary terminal admission. */
export function assertTransitionOwnerWitness(plan: WorktreeTransitionPlan): void {
  const row = plan.row as WorktreeEntry;
  const content = ownerContent(row);
  const stored = JSON.parse(assertPrivateFile(ownerPath(plan.repoRoot, row)).toString('utf8')) as unknown;
  if (stableJson(stored) !== stableJson({ ...content, ownerId: digestValue(content) }))
    throw new Error('Sealed transition owner witness drifted.');
}

/**
 * The only recovery transition for a worktree that remained active after its
 * delivery completed elsewhere. Callers must establish the terminal delivery
 * from GitHub and immutable receipts before invoking this locked transition.
 */
export interface CompletedIssueWorktreeReconciliation {
  branch: string;
  issueNumber: number;
  path: string;
  prNumber: number;
  projectRoot?: string;
}

type IssueWorktreeDeliveryTransition =
  | {
      branch: string;
      issueNumber: number;
      path: string;
      prNumber: number;
      projectRoot?: string;
      status: 'pr-published';
    }
  | {
      branch: string;
      issueNumber: number;
      path: string;
      projectRoot?: string;
      status: 'merged';
    };

export async function addWorktreeEntry(entry: WorktreeEntry, projectRoot?: string): Promise<void> {
  const root = projectRoot ?? process.cwd();
  const normalizedEntry: WorktreeEntry = {
    ...entry,
    status: entry.status,
    updatedAt: entry.updatedAt,
  };

  ensureRegistryDirectory(root);
  await withLock(REGISTRY_PATH, {
    onTimeout: () => {
      logWarn(LOCK_RETRY_MESSAGE);
    },
    operation: () => {
      assertNoIncompleteWorktreeTransition(normalizedEntry, root);
      const registry = loadRegistryStrict(root);

      const collisions = registry.worktrees.filter((existing) => registryIdentitiesOverlap(existing, normalizedEntry));
      const [existing] = collisions;
      if (collisions.length > 0) {
        if (collisions.length === 1 && existing !== undefined && isIdempotentRegistration(existing, normalizedEntry)) {
          assertAiDeliveryWorktreeOwner(existing, root);
          logInfo(`Worktree already registered: ${normalizedEntry.path}`);
          return;
        }
        if (collisions.length === 1 && existing !== undefined && isMergedIssueReactivation(existing, normalizedEntry)) {
          assertAiDeliveryWorktreeOwner(existing, root);
          const existingIndex = registry.worktrees.indexOf(existing);
          registry.worktrees.splice(existingIndex, 1, {
            ...normalizedEntry,
            createdAt: existing.createdAt,
          });
          saveRegistryStrict(root, registry);
          logInfo(`Reactivated merged issue worktree: ${normalizedEntry.path}`);
          return;
        }
        throw new Error(
          `New worktree entry conflicts with existing canonical registry identity: ${normalizedEntry.path}.`,
        );
      }

      writeWorktreeOwner(normalizedEntry, root);
      registry.worktrees.push(normalizedEntry);
      logInfo(`Added to worktree registry: ${normalizedEntry.path}`);
      saveRegistryStrict(root, registry);
    },
    projectRoot: root,
    timeout: 5000,
  });
}

/** Resolve the sole canonical issue row for a provider-mutating lifecycle transition. */
export function getIssueWorktreeStrict(issueNumber: number, projectRoot?: string): WorktreeEntry {
  const root = projectRoot ?? process.cwd();
  const registry = loadRegistryStrict(root);
  const matching = registry.worktrees.filter((entry) => entry.type === 'issue' && entry.issueNumber === issueNumber);
  const entry = matching[0];
  if (matching.length !== 1 || entry === undefined) {
    throw new Error(
      `Expected exactly one canonical registry row for issue #${String(issueNumber)}; found ${String(matching.length)}.`,
    );
  }
  assertAiDeliveryWorktreeOwner(entry, root);
  return entry;
}

/** Native metadata never adopts source; retain every transition and canonical registry fence. */
export function assertNativeIssueTrackingAdmission(issueNumber: number, root: string): void {
  assertIssueWorktreeTransitionAdmission(issueNumber, root);
  const matches = listWorktreesStrict(root).filter(
    (entry) => entry.type === 'issue' && entry.issueNumber === issueNumber,
  );
  if (matches.length > 1) throw new Error(`Issue #${String(issueNumber)} has duplicate worktree owners.`);
}

export function getStaleWorktrees(daysOld: number, projectRoot?: string): WorktreeEntry[] {
  const root = projectRoot ?? process.cwd();
  const registry = loadRegistry(root);
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);

  return registry.worktrees.filter((entry) => {
    const updatedAt = new Date(entry.updatedAt);
    return updatedAt < cutoffDate || entry.status === 'stale' || entry.status === 'merged';
  });
}

export function getWorktreeByIssue(issueNumber: number, projectRoot?: string): null | WorktreeEntry {
  const root = projectRoot ?? process.cwd();
  const registry = loadRegistry(root);
  return registry.worktrees.find((w) => w.type === 'issue' && w.issueNumber === issueNumber) ?? null;
}

export function getWorktreeByPR(prNumber: number, projectRoot?: string): null | WorktreeEntry {
  const root = projectRoot ?? process.cwd();
  const registry = loadRegistry(root);
  return registry.worktrees.find((w) => w.type === 'pr' && w.prNumber === prNumber) ?? null;
}

export function listWorktrees(projectRoot?: string): WorktreeEntry[] {
  const root = projectRoot ?? process.cwd();
  const registry = loadRegistry(root);
  return registry.worktrees;
}

/**
 * Reads the registry for a terminal safety decision. Unlike the operational
 * listing helper, this fails closed if an existing registry cannot be read.
 */
export function listWorktreesStrict(projectRoot?: string): WorktreeEntry[] {
  const root = projectRoot ?? process.cwd();
  const registry = loadRegistryStrict(root);
  return registry.worktrees;
}

export async function markStaleEntries(thresholdMs: number, projectRoot?: string): Promise<number> {
  const root = projectRoot ?? process.cwd();
  let updated = 0;
  ensureRegistryDirectory(root);
  await withLock(REGISTRY_PATH, {
    onTimeout: () => {
      logWarn(LOCK_RETRY_MESSAGE);
    },
    operation: () => {
      const registry = loadRegistryStrict(root);
      const now = Date.now();
      const newWorktrees = registry.worktrees.map((entry) => {
        const age = now - new Date(entry.updatedAt).getTime();
        if (
          age >= thresholdMs &&
          entry.type !== 'standalone' &&
          entry.status !== 'stale' &&
          entry.status !== 'merged'
        ) {
          assertAiDeliveryWorktreeOwner(entry, root);
          updated += 1;
          return {
            ...entry,
            status: 'stale' as const,
            updatedAt: new Date().toISOString(),
          };
        }
        return entry;
      });
      if (updated > 0) {
        registry.worktrees = newWorktrees;
        saveRegistryStrict(root, registry);
      }
    },
    projectRoot: root,
    timeout: 5000,
  });
  return updated;
}

/** Atomically reconcile one verified terminal PR without changing its original producer identity. */
export async function reconcileCompletedIssueWorktreeDelivery(
  options: CompletedIssueWorktreeReconciliation,
): Promise<'already-reconciled' | 'reconciled'> {
  if (!Number.isSafeInteger(options.prNumber) || options.prNumber <= 0) {
    throw new Error(`Canonical PR number must be a positive integer for issue #${String(options.issueNumber)}.`);
  }
  const root = options.projectRoot ?? process.cwd();
  ensureRegistryDirectory(root);
  return await withLock(REGISTRY_PATH, {
    onTimeout: () => {
      logWarn(LOCK_RETRY_MESSAGE);
    },
    operation: () => {
      const registry = loadRegistryStrict(root);
      const matchingIndex = requireCanonicalIssueIndex({ ...options, registry });
      const entry = registry.worktrees[matchingIndex];
      if (entry === undefined) {
        throw new Error(
          `Canonical registry row for issue #${String(options.issueNumber)} disappeared during reconciliation.`,
        );
      }
      assertAiDeliveryWorktreeOwner(entry, root);
      if (entry.status === 'merged' && entry.prNumber === options.prNumber) {
        return 'already-reconciled';
      }
      if (
        !(entry.status === 'active' && entry.prNumber === undefined) &&
        !(entry.status === 'pr-published' && entry.prNumber === options.prNumber)
      ) {
        throw new Error(
          `Invalid completed-delivery reconciliation for #${String(options.issueNumber)}: ${entry.status}.`,
        );
      }
      registry.worktrees.splice(matchingIndex, 1, {
        ...entry,
        prNumber: options.prNumber,
        status: 'merged',
        updatedAt: new Date().toISOString(),
      });
      saveRegistryStrict(root, registry);
      assertIssueDeliveryReadback({
        options: { ...options, status: 'merged' },
        registry: loadRegistryStrict(root),
      });
      return 'reconciled';
    },
    projectRoot: root,
    timeout: 5000,
  });
}

/** Remove one exact active standalone row without weakening registry parsing or identity checks. */
export async function removeActiveStandaloneWorktreeEntry(input: {
  branch: string;
  path: string;
  projectRoot: string;
}): Promise<void> {
  const root = input.projectRoot;
  ensureRegistryDirectory(root);
  await withLock(REGISTRY_PATH, {
    onTimeout: () => {
      logWarn(LOCK_RETRY_MESSAGE);
    },
    operation: () => {
      const registry = loadRegistryStrict(root);
      const matchingIndexes = registry.worktrees.flatMap((entry, index) =>
        entry.path === input.path || entry.branch === input.branch ? [index] : [],
      );
      const [matchingIndex] = matchingIndexes;
      const entry = matchingIndex === undefined ? undefined : registry.worktrees[matchingIndex];
      if (
        matchingIndexes.length !== 1 ||
        entry === undefined ||
        entry.path !== input.path ||
        entry.branch !== input.branch ||
        entry.type !== 'standalone' ||
        entry.status !== 'active' ||
        entry.issueNumber !== undefined ||
        entry.prNumber !== undefined
      ) {
        throw new Error('Expected one exact active standalone registry row for qualification cleanup.');
      }
      if (matchingIndex === undefined) {
        throw new Error('Qualification cleanup registry identity disappeared before removal.');
      }
      assertAiDeliveryWorktreeOwner(entry, root);
      registry.worktrees.splice(matchingIndex, 1);
      saveRegistryStrict(root, registry);
      const readback = loadRegistryStrict(root).worktrees;
      if (readback.some((candidate) => candidate.path === input.path || candidate.branch === input.branch)) {
        throw new Error('Qualification cleanup registry readback retained the standalone identity.');
      }
    },
    projectRoot: root,
    timeout: 5000,
  });
}

export async function removeWorktreeEntry(path: string, projectRoot?: string): Promise<boolean> {
  const root = projectRoot ?? process.cwd();

  ensureRegistryDirectory(root);
  return await withLock(REGISTRY_PATH, {
    onTimeout: () => {
      logWarn(LOCK_RETRY_MESSAGE);
    },
    operation: () => {
      const registry = loadRegistryStrict(root);
      const matching = registry.worktrees.filter((row) => row.path === path);
      if (matching.length > 1) throw new Error('Worktree registry contains duplicate paths.');
      if (matching[0] !== undefined) {
        assertAiDeliveryWorktreeOwner(matching[0], root);
        registry.worktrees = registry.worktrees.filter((row) => row.path !== path);
        saveRegistryStrict(root, registry);
        logInfo(`Removed from worktree registry: ${path}`);
        return true;
      }

      return false;
    },
    projectRoot: root,
    timeout: 5000,
  });
}

export async function updateIssueWorktreeDelivery(options: IssueWorktreeDeliveryTransition): Promise<void> {
  const { branch, issueNumber, path, status } = options;
  const root = options.projectRoot ?? process.cwd();
  ensureRegistryDirectory(root);
  await withLock(REGISTRY_PATH, {
    onTimeout: () => {
      logWarn(LOCK_RETRY_MESSAGE);
    },
    operation: () => {
      const registry = loadRegistryStrict(root);
      const matchingIndex = requireCanonicalIssueIndex({ branch, issueNumber, path, registry });
      const entry = registry.worktrees[matchingIndex];
      if (entry === undefined) {
        throw new Error(`Canonical registry row for issue #${String(issueNumber)} disappeared during transition.`);
      }
      assertAiDeliveryWorktreeOwner(entry, root);
      assertIssueDeliveryTransition({ entry, options });
      registry.worktrees.splice(matchingIndex, 1, {
        ...entry,
        ...(options.status === 'pr-published' ? { prNumber: options.prNumber } : {}),
        status,
        updatedAt: new Date().toISOString(),
      });
      saveRegistryStrict(root, registry);
      assertIssueDeliveryReadback({ options, registry: loadRegistryStrict(root) });
    },
    projectRoot: root,
    timeout: 5000,
  });
}

function assertIssueDeliveryReadback({
  options,
  registry,
}: {
  options: IssueWorktreeDeliveryTransition;
  registry: WorktreeRegistry;
}): void {
  const rows = registry.worktrees.filter(
    (candidate) => candidate.type === 'issue' && candidate.issueNumber === options.issueNumber,
  );
  const entry = rows[0];
  if (
    rows.length !== 1 ||
    entry === undefined ||
    entry.branch !== options.branch ||
    entry.path !== options.path ||
    entry.status !== options.status ||
    (options.status === 'pr-published' && entry.prNumber !== options.prNumber)
  ) {
    throw new Error(`Canonical registry transition readback failed for issue #${String(options.issueNumber)}.`);
  }
}

function assertIssueDeliveryTransition({
  entry,
  options,
}: {
  entry: WorktreeEntry;
  options: IssueWorktreeDeliveryTransition;
}): void {
  if (options.status === 'pr-published') {
    if (!Number.isSafeInteger(options.prNumber) || options.prNumber <= 0) {
      throw new Error(`Canonical PR number must be a positive integer for issue #${String(options.issueNumber)}.`);
    }
    if (entry.status === 'active' && entry.prNumber === undefined) {
      return;
    }
    if (entry.status === 'pr-published' && entry.prNumber === options.prNumber) {
      return;
    }
    if (entry.status === 'pr-published' && entry.prNumber !== undefined) {
      throw new Error(
        `Issue #${String(options.issueNumber)} cannot replace canonical PR #${String(entry.prNumber)} with #${String(options.prNumber)}.`,
      );
    }
    throw new Error(
      `Invalid issue delivery transition for #${String(options.issueNumber)}: ${entry.status} -> pr-published.`,
    );
  }

  if (
    (entry.status === 'pr-published' || entry.status === 'merged') &&
    entry.prNumber !== undefined &&
    Number.isSafeInteger(entry.prNumber) &&
    entry.prNumber > 0
  ) {
    return;
  }
  throw new Error(`Invalid issue delivery transition for #${String(options.issueNumber)}: ${entry.status} -> merged.`);
}

function ensureRegistryDirectory(root: string): void {
  ensureDataDirectory(root);
}

function isIdempotentRegistration(existing: WorktreeEntry, incoming: WorktreeEntry): boolean {
  return (
    existing.branch === incoming.branch &&
    existing.identity === incoming.identity &&
    existing.issueNumber === incoming.issueNumber &&
    existing.path === incoming.path &&
    existing.prNumber === incoming.prNumber &&
    existing.status === incoming.status &&
    existing.type === incoming.type
  );
}

function isMergedIssueReactivation(existing: WorktreeEntry, incoming: WorktreeEntry): boolean {
  return (
    existing.branch === incoming.branch &&
    existing.identity === incoming.identity &&
    existing.issueNumber === incoming.issueNumber &&
    existing.path === incoming.path &&
    existing.prNumber !== undefined &&
    existing.status === 'merged' &&
    existing.type === 'issue' &&
    incoming.prNumber === undefined &&
    incoming.status === 'active' &&
    incoming.type === 'issue'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadRegistry(root: string): WorktreeRegistry {
  const registryPath = resolve(root, REGISTRY_PATH);
  if (!existsSync(registryPath)) {
    return { worktrees: [] };
  }
  try {
    const raw = readFileSync(registryPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      worktrees: (Partial<WorktreeEntry> & Pick<WorktreeEntry, 'branch' | 'createdAt' | 'path' | 'type'>)[];
    };
    return {
      worktrees: parsed.worktrees.map((entry) => {
        const status = normalizeStatus(entry.status);
        return {
          branch: entry.branch,
          createdAt: entry.createdAt,
          ...(entry.identity !== undefined ? { identity: entry.identity } : {}),
          ...(entry.issueNumber !== undefined ? { issueNumber: entry.issueNumber } : {}),
          path: entry.path,
          ...(entry.prNumber !== undefined ? { prNumber: entry.prNumber } : {}),
          status,
          type: entry.type,
          updatedAt: entry.updatedAt ?? entry.createdAt,
        };
      }),
    };
  } catch (error: unknown) {
    logWarn(`Failed to load worktree registry: ${error instanceof Error ? error.message : String(error)}`);
    return { worktrees: [] };
  }
}

function loadRegistryStrict(root: string): WorktreeRegistry {
  const registryPath = resolve(root, REGISTRY_PATH);
  if (!existsSync(registryPath)) {
    return { worktrees: [] };
  }
  try {
    const raw = readFileSync(registryPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || Object.keys(parsed).length !== 1 || !Array.isArray(parsed.worktrees)) {
      throw new Error('Registry must be an object with a worktrees array.');
    }
    return {
      worktrees: parsed.worktrees.map((entry, index) => normalizeStrictWorktreeEntry(entry, index)),
    };
  } catch (error: unknown) {
    throw new Error(`Unable to read worktree registry: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeStatus(raw: unknown): WorktreeStatus {
  if (raw === 'merged' || raw === 'pr-published' || raw === 'active' || raw === 'error' || raw === 'stale') {
    return raw;
  }
  throw new Error('Worktree registry status is invalid.');
}

function normalizeStrictWorktreeEntry(entry: unknown, index: number): WorktreeEntry {
  if (!isRecord(entry)) {
    throw new Error(`worktrees[${String(index)}] must be an object.`);
  }
  const allowed = new Set([
    'branch',
    'createdAt',
    'identity',
    'issueNumber',
    'path',
    'prNumber',
    'status',
    'type',
    'updatedAt',
  ]);
  const unknown = Object.keys(entry).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`worktrees[${String(index)}] has unsupported fields: ${unknown.join(', ')}.`);
  }
  const branch = requiredString(entry.branch, `worktrees[${String(index)}].branch`);
  const createdAt = requiredString(entry.createdAt, `worktrees[${String(index)}].createdAt`);
  const path = requiredString(entry.path, `worktrees[${String(index)}].path`);
  const type = requiredWorktreeType(entry.type, `worktrees[${String(index)}].type`);
  const status = requiredWorktreeStatus(entry.status, `worktrees[${String(index)}].status`);
  const identity = optionalString(entry.identity, `worktrees[${String(index)}].identity`);
  const issueNumber = optionalPositiveInteger(entry.issueNumber, `worktrees[${String(index)}].issueNumber`);
  const prNumber = optionalPositiveInteger(entry.prNumber, `worktrees[${String(index)}].prNumber`);
  const updatedAt = requiredString(entry.updatedAt, `worktrees[${String(index)}].updatedAt`);

  if (type === 'issue' && issueNumber === undefined) {
    throw new Error(`worktrees[${String(index)}].issueNumber is required for issue worktrees.`);
  }
  return {
    branch,
    createdAt,
    ...(identity === undefined ? {} : { identity }),
    ...(issueNumber === undefined ? {} : { issueNumber }),
    path,
    ...(prNumber === undefined ? {} : { prNumber }),
    status,
    type,
    updatedAt,
  };
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requiredString(value, label);
}

function registryIdentitiesOverlap(left: WorktreeEntry, right: WorktreeEntry): boolean {
  return (
    left.path === right.path ||
    left.branch === right.branch ||
    (left.issueNumber !== undefined && right.issueNumber !== undefined && left.issueNumber === right.issueNumber) ||
    (left.prNumber !== undefined && right.prNumber !== undefined && left.prNumber === right.prNumber)
  );
}

function requireCanonicalIssueIndex({
  branch,
  issueNumber,
  path,
  registry,
}: {
  branch: string;
  issueNumber: number;
  path: string;
  registry: WorktreeRegistry;
}): number {
  const issueIndexes = registry.worktrees.flatMap((entry, index) =>
    entry.type === 'issue' && entry.issueNumber === issueNumber ? [index] : [],
  );
  if (issueIndexes.length !== 1) {
    throw new Error(
      `Expected exactly one canonical registry row for issue #${String(issueNumber)}; found ${String(issueIndexes.length)}.`,
    );
  }
  const matchingIndex = issueIndexes[0];
  const entry = matchingIndex === undefined ? undefined : registry.worktrees[matchingIndex];
  if (matchingIndex === undefined || entry === undefined) {
    throw new Error(`Canonical registry row for issue #${String(issueNumber)} disappeared during transition.`);
  }
  if (entry.branch !== branch || entry.path !== path) {
    throw new Error(
      `Canonical registry row for issue #${String(issueNumber)} does not match branch ${branch} and path ${path}.`,
    );
  }
  return matchingIndex;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requiredWorktreeStatus(value: unknown, label: string): WorktreeStatus {
  if (value === 'merged' || value === 'pr-published' || value === 'active' || value === 'error' || value === 'stale') {
    return value;
  }
  throw new Error(`${label} is invalid.`);
}

function requiredWorktreeType(value: unknown, label: string): WorktreeEntry['type'] {
  if (value === 'issue' || value === 'pr' || value === 'standalone') {
    return value;
  }
  throw new Error(`${label} is invalid.`);
}

function saveRegistryStrict(root: string, registry: WorktreeRegistry): void {
  ensureRegistryDirectory(root);
  const registryPath = resolve(root, REGISTRY_PATH);
  try {
    writeJsonFileAtomically(registryPath, registry);
  } catch (error: unknown) {
    throw new Error(`Unable to save worktree registry: ${error instanceof Error ? error.message : String(error)}`);
  }
}
