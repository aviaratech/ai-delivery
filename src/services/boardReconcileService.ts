import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { z } from 'zod';
import { NativeDeliveryConfigSchema } from '../config/deliveryConfig.js';
import { digestValue } from '../delivery/common.js';
import {
  CollectionLimitError,
  DeliveryError,
  getRateLimitDiagnostics,
  getMachineRequestDiagnostics,
} from '../errors.js';
import { GIT_EXECUTABLE, gitEnvironment, inertGitArguments } from '../gitProcess.js';
import { resolveRepoFromRemote } from '../github/repo.js';
import { getNativeBlockerRelationships, hasNativeSubIssues } from '../github/relationships.js';
import {
  getProjectDeliveryConfiguration,
  projectSettingsFromDeliveryConfig,
  readProjectDeliveryItems,
  type ProjectDeliveryConfiguration,
  type ProjectDeliveryStatus,
  type ProjectItemObservation,
} from '../github/projectDelivery.js';
import {
  assertIssueStartCapacity,
  capacityNextPage,
  readIssueNativeFields,
  linkedIssueBranches,
  readyCheck,
  type DeliveryContext,
} from '../issue.js';
import {
  nativeIssueSettingsFromDeliveryConfig,
  parseConfiguredNativeIssueMetadata,
} from '../github/nativeIssueMetadata.js';
import { parseIssueBody } from '../issueContract.js';
import { readPackageArtifactIdentity } from '../version.js';

const MAX_BYTES = 16 * 1024 * 1024;
const ALGORITHM = 'board-reconcile@1';
const Id = z.string().min(1).max(512);
const Sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const Repo = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
const Status = z.enum(['Todo', 'In Progress', 'Blocked', 'Done']);
const Count = z.number().int().nonnegative().safe();
const CheckoutSchema = z.strictObject({
  repository: Repo,
  issueNumber: z.number().int().positive().safe(),
  path: z.string().max(4096).refine(isAbsolute),
});
const ActorSchema = z.strictObject({ actorLogin: Id, credentialIdentity: Id });
const ArtifactSchema = z.strictObject({ packageVersion: Id, packageManifestDigest: Sha256, packageDistDigest: Sha256 });
const StatusIds = z.strictObject({ Todo: Id, 'In Progress': Id, Blocked: Id, Done: Id });
const RoutingSchema = z.strictObject({
  repository: Repo,
  repositoryId: Id,
  projectId: Id,
  projectSource: z.enum(['explicit', 'linked']),
  statusFieldId: Id,
  statusOptionIds: StatusIds,
  pointsFieldId: Id,
  priorityFieldId: Id,
  native: NativeDeliveryConfigSchema,
});
const BindingSchema = z.strictObject({
  repository: Repo,
  configDigest: Sha256,
  checkoutRootsDigest: Sha256,
  actor: ActorSchema.nullable(),
  routing: RoutingSchema,
});
const GapSchema = z.strictObject({
  repository: Repo,
  projectId: Id.optional(),
  stage: z.string().min(1).max(80),
  reason: z.string().min(1).max(200),
  collection: z.string().max(100).optional(),
  pagesRequested: Count.optional(),
  rowsObserved: Count.optional(),
  limit: Count.optional(),
});
export type ReconcileGap = z.infer<typeof GapSchema>;
const DiagnosticSchema = z.strictObject({
  code: z.enum(['missing-points', 'parent-points', 'duplicate-field-label', 'unknown-metadata']),
  field: Id,
  message: z.string().max(200),
  fixHint: z.string().max(200),
  fieldId: Id.nullable(),
  authoritativeValue: z.union([z.string().max(512), z.number().finite(), z.null()]),
  label: z.string().max(128).nullable(),
  labelValue: z.string().max(128).nullable(),
  mapping: z.enum(['exact', 'conflicting', 'unknown']).nullable(),
});
const BlockerSchema = z.strictObject({
  id: Id,
  repository: Repo,
  number: z.number().int().positive().safe(),
  state: z.enum(['OPEN', 'CLOSED']),
});
const ObservationSchema = z.strictObject({
  path: z.string().max(4096),
  clone: z.string().max(4096),
  commonDirectory: z.string().max(4096),
  branch: Id,
  head: z.string().regex(/^[a-f0-9]{40}$/u),
  repository: Repo,
  issueNodeId: Id,
  linkedRefName: Id,
  linkedRefOid: z.string().regex(/^[a-f0-9]{40}$/u),
});
const ActivitySchema = z.strictObject({
  state: z.enum(['observed-checkout', 'unknown']),
  observation: ObservationSchema.nullable(),
});
const MembershipSchema = z.strictObject({
  kind: z.enum(['absent', 'present', 'not-required', 'archived-preserved', 'duplicate', 'unknown']),
  itemId: Id.nullable(),
  itemIds: z.array(Id),
});
const NativeSchema = z.strictObject({
  state: z.enum(['open', 'closed']),
  bodyDigest: Sha256,
  canonical: z.boolean(),
  draft: z.boolean().nullable(),
  deferred: z.boolean().nullable(),
  blockers: z.array(BlockerSchema).nullable(),
  hasChildren: z.boolean().nullable(),
  points: z.number().finite().nullable(),
  priority: z.string().max(512).nullable(),
});
const StatusObservationSchema = z.strictObject({
  current: Status.nullable(),
  kind: z.enum(['verified', 'unset', 'unreadable']),
  name: Id.nullable(),
  optionId: Id.nullable(),
});
const IssueSchema = z.strictObject({
  repository: Repo,
  issueNodeId: Id,
  issueNumber: z.number().int().positive().safe(),
  projectId: Id,
  native: NativeSchema,
  membership: MembershipSchema,
  status: StatusObservationSchema.extend({
    target: Status.nullable(),
    rule: z.enum(['closed', 'blocker', 'parked', 'active', 'unknown', 'preserved']),
  }),
  activity: ActivitySchema,
  metadata: z.array(DiagnosticSchema),
  gaps: z.array(GapSchema),
});
const OperationSchema = z.strictObject({
  operationId: Sha256,
  repository: Repo,
  issueNodeId: Id,
  issueNumber: z.number().int().positive().safe(),
  projectId: Id,
  kind: z.enum(['add-membership', 'set-status']),
  prerequisiteDigest: Sha256,
  expected: z.strictObject({
    membership: z.enum(['absent', 'present']),
    itemId: Id.nullable(),
    status: Status.nullable(),
  }),
  target: Status.nullable(),
  fieldId: Id.nullable(),
  optionId: Id.nullable(),
});
const BoundsSchema = z.strictObject({
  repositories: z.literal(10),
  issuesPerRepository: z.literal(500),
  pagesPerCollection: z.literal(20),
  retainedBytes: z.literal(MAX_BYTES),
});
export const BoardReconcilePlanSchema = z.strictObject({
  schemaVersion: z.literal('ai-delivery.board-reconcile-plan@1'),
  planId: Sha256,
  algorithm: z.literal(ALGORITHM),
  packageIdentity: ArtifactSchema.nullable(),
  collectionStartedAt: z.iso.datetime(),
  collectionCompletedAt: z.iso.datetime(),
  scope: z.array(Repo).min(1).max(10),
  checkouts: z.array(CheckoutSchema),
  bindings: z.array(BindingSchema),
  bounds: BoundsSchema,
  scopeComplete: z.boolean(),
  issues: z.array(IssueSchema).max(5000),
  operations: z.array(OperationSchema).max(10000),
  gaps: z.array(GapSchema),
  summary: z.strictObject({ proposed: Count, noops: Count, refused: Count, unresolved: Count }),
});
export type BoardReconcilePlan = z.infer<typeof BoardReconcilePlanSchema>;
type IssueRecord = z.infer<typeof IssueSchema>;
type Binding = z.infer<typeof BindingSchema>;
type Operation = z.infer<typeof OperationSchema>;
const Outcome = z.enum(['applied', 'satisfied', 'failed', 'drifted', 'refused', 'unknown']);
const ItemEvidenceSchema = z.strictObject({ itemId: Id, status: StatusObservationSchema, archived: z.literal(false) });
const AttemptEvidenceSchema = z.strictObject({
  outcome: Outcome,
  attempted: z.boolean(),
  before: ItemEvidenceSchema.nullable(),
  readback: ItemEvidenceSchema.nullable(),
});
const ResultOperationSchema = OperationSchema.extend({
  outcome: Outcome,
  attempted: z.boolean(),
  before: ItemEvidenceSchema.nullable(),
  readback: ItemEvidenceSchema.nullable(),
  priorEvidence: z.array(AttemptEvidenceSchema),
});
export const BoardReconcileResultSchema = z.strictObject({
  schemaVersion: z.literal('ai-delivery.board-reconcile-result@1'),
  planId: Sha256,
  scope: z.array(Repo).min(1).max(10),
  scopeComplete: z.boolean(),
  observedBindings: z.array(BindingSchema),
  operations: z.array(ResultOperationSchema).max(10000),
  issues: z.array(IssueSchema).max(5000),
  gaps: z.array(GapSchema),
  summary: z.strictObject({
    applied: Count,
    satisfied: Count,
    failed: Count,
    drifted: Count,
    refused: Count,
    unknown: Count,
    unresolved: Count,
  }),
});
export type BoardReconcileResult = z.infer<typeof BoardReconcileResultSchema>;

function bounded(value: unknown): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new DeliveryError('Reconciliation evidence must be serializable JSON.');
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_BYTES)
    throw new DeliveryError('Reconciliation retained input/output exceeds 16 MiB UTF-8 or is not JSON.');
}
function normalizedScope(scope: readonly string[]): string[] {
  return scope.map((r) => r.trim().toLowerCase()).sort();
}
function sameScope(a: readonly string[], b: readonly string[]): boolean {
  return digestValue(normalizedScope(a)) === digestValue(normalizedScope(b));
}
function operationId(operation: Omit<Operation, 'operationId'>): string {
  return digestValue(operation);
}
function planId(plan: BoardReconcilePlan): string {
  const { planId: _id, collectionStartedAt: _start, collectionCompletedAt: _end, ...semantic } = plan;
  return digestValue(semantic);
}
function validatePlan(plan: BoardReconcilePlan): void {
  bounded(plan);
  if (plan.planId !== planId(plan) || !plan.scopeComplete || !plan.packageIdentity)
    throw new DeliveryError('Apply requires a complete original plan with valid integrity and package identity.');
  const ids = new Set<string>();
  for (const operation of plan.operations) {
    const { operationId: id, ...intent } = operation;
    if (id !== operationId(intent) || ids.has(id)) throw new DeliveryError('Plan operation integrity is invalid.');
    ids.add(id);
  }
}
function validatePrior(plan: BoardReconcilePlan, prior: BoardReconcileResult): void {
  bounded(prior);
  if (
    prior.planId !== plan.planId ||
    !sameScope(prior.scope, plan.scope) ||
    prior.operations.length !== plan.operations.length
  )
    throw new DeliveryError('Prior result does not bind to this exact plan and operation set.');
  const byId = new Map(prior.operations.map((o) => [o.operationId, o]));
  if (byId.size !== prior.operations.length) throw new DeliveryError('Prior result repeats operation identities.');
  for (const operation of plan.operations) {
    const found = byId.get(operation.operationId);
    if (!found) throw new DeliveryError('Prior result omitted a plan operation.');
    const {
      outcome: _outcome,
      attempted: _attempted,
      before: _before,
      readback: _readback,
      priorEvidence: _prior,
      ...intent
    } = found;
    if (digestValue(intent) !== digestValue(operation))
      throw new DeliveryError('Prior result changes original operation intent.');
  }
}
export const BoardReconcileInput = z
  .strictObject({
    repositories: z.array(Repo).min(1).max(10),
    repo: Repo.optional(),
    mode: z.enum(['dry-run', 'apply']).default('dry-run'),
    checkouts: z.array(CheckoutSchema).optional(),
    plan: BoardReconcilePlanSchema.optional(),
    priorResult: BoardReconcileResultSchema.optional(),
  })
  .superRefine((value, context) => {
    const refuse = (message: string) => context.addIssue({ code: 'custom', message });
    try {
      bounded(value);
    } catch {
      refuse('Reconciliation input exceeds its retained JSON bound.');
    }
    const scope = normalizedScope(value.repositories);
    if (new Set(scope).size !== scope.length) refuse('Repositories must be unique after case folding.');
    if (value.repo !== undefined && (scope.length !== 1 || scope[0] !== value.repo.toLowerCase()))
      refuse('Singular and plural repository selectors must agree.');
    if (value.mode === 'dry-run') {
      if (value.plan !== undefined || value.priorResult !== undefined) refuse('Dry-run forbids plan/priorResult.');
    } else {
      if (value.plan === undefined || value.checkouts !== undefined)
        refuse('Apply requires a plan and forbids extra checkout selectors.');
      else
        try {
          validatePlan(value.plan);
          if (!sameScope(value.repositories, value.plan.scope))
            throw new DeliveryError('Apply repository scope changed.');
          if (value.priorResult !== undefined) validatePrior(value.plan, value.priorResult);
        } catch {
          refuse('Apply plan/prior-result integrity or scope is invalid.');
        }
    }
    const subjects = new Set<string>(),
      paths = new Set<string>();
    for (const selected of value.checkouts ?? []) {
      const key = `${selected.repository.toLowerCase()}:${String(selected.issueNumber)}`;
      if (!scope.includes(selected.repository.toLowerCase()) || subjects.has(key) || paths.has(selected.path))
        refuse('Checkout selectors must be in scope and unambiguous.');
      subjects.add(key);
      paths.add(selected.path);
    }
  });
export type BoardReconcileRawInput = z.input<typeof BoardReconcileInput>;
type ParsedRequest = z.output<typeof BoardReconcileInput>;
export type DryRunBoardReconcileRequest = Omit<ParsedRequest, 'mode' | 'plan' | 'priorResult'> & {
  mode: 'dry-run';
  plan?: never;
  priorResult?: never;
};
export type ApplyBoardReconcileRequest = Omit<ParsedRequest, 'mode' | 'plan' | 'checkouts'> & {
  mode: 'apply';
  plan: BoardReconcilePlan;
  checkouts?: never;
};
export type BoardReconcileRequest = DryRunBoardReconcileRequest | ApplyBoardReconcileRequest;
export function parseBoardReconcileRequest(raw: unknown): BoardReconcileRequest {
  bounded(raw);
  const parsed = BoardReconcileInput.parse(raw);
  const { mode, plan, priorResult, checkouts, ...common } = parsed;
  if (mode === 'apply') {
    if (!plan) throw new DeliveryError('Apply requires its validated original plan.');
    return { ...common, mode, plan, ...(priorResult === undefined ? {} : { priorResult }) };
  }
  return { ...common, mode, ...(checkouts === undefined ? {} : { checkouts }) };
}

function globalFailureReason(error: unknown): 'rate-limit' | 'authentication' | null {
  if (getRateLimitDiagnostics(error, true) !== undefined) return 'rate-limit';
  if (
    getMachineRequestDiagnostics(error)?.status === 401 ||
    (error instanceof Error && Object.getOwnPropertyDescriptor(error, 'status')?.value === 401)
  )
    return 'authentication';
  return null;
}
function gap(repository: string, stage: string, error?: unknown, projectId?: string): ReconcileGap {
  return {
    repository,
    stage,
    reason:
      error instanceof CollectionLimitError
        ? 'collection-limit'
        : (globalFailureReason(error) ?? 'evidence-unavailable'),
    ...(projectId === undefined ? {} : { projectId }),
    ...(error instanceof CollectionLimitError
      ? {
          collection: error.collection,
          pagesRequested: error.pagesRequested,
          rowsObserved: error.rowsObserved,
          limit: error.limit,
        }
      : {}),
  };
}
function emptyPlan(request: DryRunBoardReconcileRequest): BoardReconcilePlan {
  const now = new Date().toISOString();
  return {
    schemaVersion: 'ai-delivery.board-reconcile-plan@1',
    planId: `sha256:${'0'.repeat(64)}`,
    algorithm: ALGORITHM,
    packageIdentity: null,
    collectionStartedAt: now,
    collectionCompletedAt: now,
    scope: [...request.repositories].sort(),
    checkouts: [...(request.checkouts ?? [])].sort((a, b) =>
      `${a.repository}:${a.issueNumber}`.localeCompare(`${b.repository}:${b.issueNumber}`),
    ),
    bindings: [],
    bounds: { repositories: 10, issuesPerRepository: 500, pagesPerCollection: 20, retainedBytes: MAX_BYTES },
    scopeComplete: true,
    issues: [],
    operations: [],
    gaps: [],
    summary: { proposed: 0, noops: 0, refused: 0, unresolved: 0 },
  };
}
function finishPlan(plan: BoardReconcilePlan): BoardReconcilePlan {
  plan.issues.sort((a, b) => a.repository.localeCompare(b.repository) || a.issueNodeId.localeCompare(b.issueNodeId));
  plan.operations.sort(
    (a, b) =>
      a.repository.localeCompare(b.repository) ||
      a.issueNodeId.localeCompare(b.issueNodeId) ||
      (a.kind === b.kind ? 0 : a.kind === 'add-membership' ? -1 : 1),
  );
  plan.bindings.sort((a, b) => a.repository.localeCompare(b.repository));
  plan.collectionCompletedAt = new Date().toISOString();
  const refusedStatus = new Set(
    plan.issues
      .filter((issue) => issue.status.target !== null && issue.status.kind === 'unreadable')
      .map((issue) => issue.issueNodeId),
  );
  plan.summary = {
    proposed: plan.operations.length,
    noops: plan.issues.filter(
      (i) => !refusedStatus.has(i.issueNodeId) && !plan.operations.some((o) => o.issueNodeId === i.issueNodeId),
    ).length,
    refused: (plan.scopeComplete ? 0 : plan.operations.length) + refusedStatus.size,
    unresolved: plan.gaps.length + plan.issues.reduce((n, i) => n + i.gaps.length, 0),
  };
  plan.planId = planId(plan);
  bounded(plan);
  return BoardReconcilePlanSchema.parse(plan);
}
export function incompleteBoardReconcile(
  request: DryRunBoardReconcileRequest,
  failure: ReconcileGap,
): BoardReconcilePlan;
export function incompleteBoardReconcile(
  request: ApplyBoardReconcileRequest,
  failure: ReconcileGap,
): BoardReconcileResult;
export function incompleteBoardReconcile(
  request: BoardReconcileRequest,
  failure: ReconcileGap,
): BoardReconcilePlan | BoardReconcileResult {
  if (request.mode === 'dry-run') {
    const plan = emptyPlan(request);
    plan.scopeComplete = false;
    plan.gaps.push(failure);
    return finishPlan(plan);
  }
  const prior = new Map(request.priorResult?.operations.map((o) => [o.operationId, o]));
  const operations = request.plan.operations.map((operation) => {
    const old = prior.get(operation.operationId);
    const outcome = old?.outcome === 'unknown' ? ('unknown' as const) : ('refused' as const);
    return {
      ...operation,
      outcome,
      attempted: false,
      before: null,
      readback: null,
      priorEvidence: old
        ? [
            ...old.priorEvidence,
            { outcome: old.outcome, attempted: old.attempted, before: old.before, readback: old.readback },
          ]
        : [],
    };
  });
  const result: BoardReconcileResult = {
    schemaVersion: 'ai-delivery.board-reconcile-result@1',
    planId: request.plan.planId,
    scope: request.plan.scope,
    scopeComplete: false,
    observedBindings: [],
    operations,
    issues: [],
    gaps: [failure],
    summary: {
      applied: 0,
      satisfied: 0,
      failed: 0,
      drifted: 0,
      refused: operations.filter((o) => o.outcome === 'refused').length,
      unknown: operations.filter((o) => o.outcome === 'unknown').length,
      unresolved: 1,
    },
  };
  bounded(result);
  return BoardReconcileResultSchema.parse(result);
}

const NativeIssueSchema = z.object({
  number: z.number().int().positive().safe(),
  node_id: Id,
  state: z.enum(['open', 'closed']),
  title: z.string().max(512),
  body: z.string().nullable().optional(),
  html_url: z.string().url(),
  labels: z.array(z.union([z.string().max(128), z.object({ name: z.string().max(128) })])).default([]),
});
type NativeIssue = z.infer<typeof NativeIssueSchema>;
const InventoryIdentitySchema = NativeIssueSchema.pick({ number: true, node_id: true });
const PullRequestInventorySchema = InventoryIdentitySchema.extend({
  html_url: z.string().url(),
  pull_request: z.object({ url: z.string().url() }),
});
interface ReconcileOptions {
  checkoutRoots: readonly string[];
  signal?: AbortSignal;
}

function nativeIssue(value: unknown, repository: string): NativeIssue {
  const issue = NativeIssueSchema.parse(value);
  const url = new URL(issue.html_url);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.search ||
    url.hash ||
    url.pathname.toLowerCase() !== `/${repository}/issues/${String(issue.number)}`.toLowerCase()
  )
    throw new DeliveryError('Native issue identity does not match the selected repository.');
  return issue;
}
async function inventory(
  context: DeliveryContext,
  rows: Map<string, NativeIssue>,
  signal?: AbortSignal,
): Promise<void> {
  const numbers = new Set<number>();
  const nodeIds = new Set<string>();
  for (let page = 1; ; page++) {
    signal?.throwIfAborted();
    if (page > 20)
      throw new CollectionLimitError({
        collection: 'repository-issues',
        pagesRequested: page - 1,
        rowsObserved: rows.size,
        limit: 20,
      });
    const response = await context.clients.rest.issues.listForRepo({
      ...context.repo,
      state: 'all',
      page,
      per_page: 100,
      sort: 'created',
      direction: 'asc',
    });
    if (!Array.isArray(response.data) || response.data.length > 100)
      throw new DeliveryError('Native issue inventory is incomplete.');
    for (const value of response.data) {
      const identity = InventoryIdentitySchema.parse(value);
      if (numbers.has(identity.number) || nodeIds.has(identity.node_id))
        throw new DeliveryError('Issue inventory repeats a native issue or pull-request identity.');
      numbers.add(identity.number);
      nodeIds.add(identity.node_id);
      if ('pull_request' in value) {
        const pr = PullRequestInventorySchema.parse(value),
          api = new URL(pr.pull_request.url),
          html = new URL(pr.html_url);
        if (
          api.protocol !== 'https:' ||
          api.hostname !== 'api.github.com' ||
          api.search ||
          api.hash ||
          api.pathname.toLowerCase() !==
            `/repos/${context.config.repository}/pulls/${String(pr.number)}`.toLowerCase() ||
          html.protocol !== 'https:' ||
          html.hostname !== 'github.com' ||
          html.search ||
          html.hash ||
          html.pathname.toLowerCase() !== `/${context.config.repository}/pull/${String(pr.number)}`.toLowerCase()
        )
          throw new DeliveryError('Issue inventory has an unreadable or foreign pull-request identity.');
        continue;
      }
      const issue = nativeIssue(value, context.config.repository);
      if (rows.size >= 500)
        throw new CollectionLimitError({
          collection: 'repository-issues',
          pagesRequested: page,
          rowsObserved: rows.size,
          limit: 500,
        });
      rows.set(issue.node_id, issue);
    }
    if (capacityNextPage(response, page, 100) === null) return;
  }
}
function projectIdentity(configuration: ProjectDeliveryConfiguration): string {
  const { writable: _writable, ...identity } = configuration;
  return digestValue(identity);
}
function localGit(path: string, args: string[], signal?: AbortSignal): string {
  signal?.throwIfAborted();
  const result = spawnSync(GIT_EXECUTABLE, [...inertGitArguments(path), ...args], {
    cwd: path,
    env: gitEnvironment(),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  signal?.throwIfAborted();
  if (result.error || result.status !== 0) throw new DeliveryError('Physical Git observation is unavailable.');
  return result.stdout.replace(/\n$/u, '');
}
function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('../'));
}
async function activity(
  context: DeliveryContext,
  issue: NativeIssue,
  selected: z.infer<typeof CheckoutSchema> | undefined,
  options: ReconcileOptions,
): Promise<z.infer<typeof ActivitySchema>> {
  if (!selected) return { state: 'unknown', observation: null };
  const path = realpathSync(selected.path);
  const roots = options.checkoutRoots.map((root) => realpathSync(root));
  if (
    !roots.some((root) => inside(root, path)) ||
    realpathSync(localGit(path, ['rev-parse', '--show-toplevel'], options.signal)) !== path ||
    localGit(path, ['rev-parse', '--is-bare-repository'], options.signal) !== 'false'
  )
    throw new DeliveryError('Selected checkout does not match a configured physical root.');
  const commonDirectory = realpathSync(
    localGit(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'], options.signal),
  );
  const branch = localGit(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'], options.signal);
  const head = localGit(path, ['rev-parse', 'HEAD'], options.signal);
  const entries: Record<string, string>[] = [];
  for (const field of localGit(path, ['worktree', 'list', '--porcelain', '-z'], options.signal).split('\0')) {
    if (field.startsWith('worktree ')) entries.push({ worktree: field.slice(9) });
    else if (field) {
      const split = field.indexOf(' ');
      const entry = entries.at(-1);
      if (entry) entry[split < 0 ? field : field.slice(0, split)] = split < 0 ? '' : field.slice(split + 1);
    }
  }
  const matches = entries.filter((entry) => {
    try {
      return entry.worktree !== undefined && realpathSync(entry.worktree) === path;
    } catch {
      return false;
    }
  });
  const entry = matches[0],
    primary = entries[0]?.worktree;
  if (
    matches.length !== 1 ||
    !entry ||
    'locked' in entry ||
    'prunable' in entry ||
    entry.branch !== `refs/heads/${branch}` ||
    entry.HEAD !== head ||
    !primary
  )
    throw new DeliveryError('Selected checkout is detached, locked, prunable or ambiguous.');
  const clone = realpathSync(primary);
  if (
    !roots.some((root) => inside(root, clone)) ||
    localGit(clone, ['rev-parse', '--is-bare-repository'], options.signal) !== 'false' ||
    realpathSync(localGit(clone, ['rev-parse', '--path-format=absolute', '--git-common-dir'], options.signal)) !==
      commonDirectory
  )
    throw new DeliveryError('Selected checkout has no matching configured clone/common directory.');
  for (const root of [clone, path]) {
    const remote = resolveRepoFromRemote(root);
    if (`${remote.owner}/${remote.repo}`.toLowerCase() !== context.config.repository.toLowerCase())
      throw new DeliveryError('Selected checkout repository changed.');
  }
  const refs = (await linkedIssueBranches(context, issue.number)).filter(
    (ref) => ref.name === branch && ref.repository.toLowerCase() === context.config.repository.toLowerCase(),
  );
  if (refs.length !== 1) throw new DeliveryError('No unambiguous live native branch link proves this checkout.');
  const observation = ObservationSchema.parse({
    path,
    clone,
    commonDirectory,
    branch,
    head,
    repository: context.config.repository,
    issueNodeId: issue.node_id,
    linkedRefName: refs[0]!.name,
    linkedRefOid: refs[0]!.sha,
  });
  return { state: 'observed-checkout', observation };
}
function diagnostic(
  code: z.infer<typeof DiagnosticSchema>['code'],
  field: string,
  fieldId: string | null,
  value: string | number | null,
  fixHint: string,
): z.infer<typeof DiagnosticSchema> {
  return {
    code,
    field,
    fieldId,
    authoritativeValue: value,
    fixHint,
    message: fixHint,
    label: null,
    labelValue: null,
    mapping: null,
  };
}
function metadata(
  context: DeliveryContext,
  issue: NativeIssue,
  configuration: ProjectDeliveryConfiguration,
  native: IssueRecord['native'],
  knownNativeFields: boolean,
  currentStatus: ProjectDeliveryStatus | null,
  knownStatus: boolean,
): IssueRecord['metadata'] {
  const reports: IssueRecord['metadata'] = [];
  const points = context.config.native.points;
  if (native.hasChildren === null || !knownNativeFields)
    reports.push(
      diagnostic(
        'unknown-metadata',
        points.name,
        points.databaseId,
        null,
        'Resolve incomplete native child/field evidence before migration.',
      ),
    );
  else if (native.hasChildren && native.points !== null)
    reports.push(
      diagnostic(
        'parent-points',
        points.name,
        points.databaseId,
        native.points,
        'Use a separately authorized explicit native Points clear for this planning parent.',
      ),
    );
  else if (!native.hasChildren && native.state === 'open' && native.points === null)
    reports.push(
      diagnostic(
        'missing-points',
        points.name,
        points.databaseId,
        null,
        'Explicitly select supported native Points before execution.',
      ),
    );
  const normalize = (name: string) => name.trim().toLowerCase().replace(/\s+/gu, ' ');
  for (const raw of issue.labels) {
    const label = typeof raw === 'string' ? raw : raw.name;
    const separator = label.indexOf(':');
    if (separator < 0) continue;
    const prefix = normalize(label.slice(0, separator)),
      labelValue = label.slice(separator + 1).trim();
    const field =
      prefix === 'points' || prefix === normalize(points.name)
        ? {
            name: points.name,
            id: points.databaseId,
            value: native.points,
            known: knownNativeFields,
            status: false,
            values: points.values,
          }
        : prefix === 'priority' || prefix === normalize(context.config.native.priority.name)
          ? {
              name: context.config.native.priority.name,
              id: context.config.native.priority.databaseId,
              value: native.priority,
              known: knownNativeFields,
              status: false,
              values: context.config.native.priority.values,
            }
          : prefix === 'status' || prefix === normalize(configuration.settings.statusField)
            ? {
                name: configuration.settings.statusField,
                id: configuration.statusFieldId,
                value: currentStatus === null ? null : configuration.settings.statuses[currentStatus],
                known: knownStatus,
                status: true,
                values: Object.values(configuration.settings.statuses),
              }
            : null;
    if (!field) continue;
    const target = field.status
      ? (Object.entries(configuration.settings.statuses).find(([canonical, configured]) =>
          [normalize(canonical), normalize(canonical.replace(/ /gu, '-')), normalize(configured)].includes(
            normalize(labelValue),
          ),
        )?.[1] ?? null)
      : (field.values.find((value) => normalize(value) === normalize(labelValue)) ?? null);
    reports.push({
      ...diagnostic(
        'duplicate-field-label',
        field.name,
        field.id,
        field.value,
        'Resolve the native/Project value explicitly before removing this duplicate label through its existing owner.',
      ),
      label,
      labelValue,
      mapping:
        field.known && target !== null
          ? normalize(String(field.value)) === normalize(target)
            ? 'exact'
            : 'conflicting'
          : 'unknown',
    });
  }
  return reports;
}
function prerequisites(issue: IssueRecord, kind: Operation['kind']): unknown {
  if (kind === 'add-membership') return { state: 'open' };
  switch (issue.status.rule) {
    case 'closed':
      return { state: issue.native.state };
    case 'blocker':
      return { state: issue.native.state, openBlockers: issue.native.blockers?.filter((b) => b.state === 'OPEN') };
    case 'parked':
      return {
        state: issue.native.state,
        bodyDigest: issue.native.bodyDigest,
        blockers: issue.native.blockers,
        draft: issue.native.draft,
        deferred: issue.native.deferred,
      };
    case 'active': {
      const { priority: _priority, ...native } = issue.native;
      return { native, activity: issue.activity };
    }
    default:
      throw new DeliveryError('No proven Status rule authorizes an operation.');
  }
}
function propose(issue: IssueRecord, configuration: ProjectDeliveryConfiguration): Operation[] {
  const operations: Operation[] = [];
  const add = (kind: Operation['kind'], target: ProjectDeliveryStatus | null) => {
    const intent: Omit<Operation, 'operationId'> = {
      repository: issue.repository,
      issueNodeId: issue.issueNodeId,
      issueNumber: issue.issueNumber,
      projectId: issue.projectId,
      kind,
      prerequisiteDigest: digestValue(prerequisites(issue, kind)),
      expected: {
        membership: issue.membership.kind === 'absent' ? 'absent' : 'present',
        itemId: issue.membership.itemId,
        status: kind === 'set-status' ? issue.status.current : null,
      },
      target,
      fieldId: target === null ? null : configuration.statusFieldId,
      optionId: target === null ? null : configuration.statusOptionIds[target],
    };
    operations.push({ ...intent, operationId: operationId(intent) });
  };
  if (issue.membership.kind === 'absent' && issue.native.state === 'open') add('add-membership', null);
  if (
    ['present', 'absent'].includes(issue.membership.kind) &&
    issue.status.kind !== 'unreadable' &&
    issue.status.target !== null &&
    issue.status.target !== issue.status.current
  )
    add('set-status', issue.status.target);
  return operations;
}

export async function collectBoardReconcilePlan(
  contexts: readonly DeliveryContext[],
  raw: DryRunBoardReconcileRequest,
  options: ReconcileOptions,
): Promise<BoardReconcilePlan> {
  const parsed = parseBoardReconcileRequest(raw);
  if (parsed.mode !== 'dry-run') throw new DeliveryError('The read-only collector requires dry-run mode.');
  const plan = emptyPlan(parsed);
  try {
    plan.packageIdentity = readPackageArtifactIdentity();
  } catch (error) {
    plan.scopeComplete = false;
    plan.gaps.push(gap(plan.scope[0]!, 'package-identity', error));
  }
  const selected = new Map(contexts.map((context) => [context.config.repository.toLowerCase(), context]));
  if (
    selected.size !== contexts.length ||
    contexts.length !== plan.scope.length ||
    contexts.some((context) => !normalizedScope(plan.scope).includes(context.config.repository.toLowerCase()))
  )
    throw new DeliveryError('Reconciliation contexts must match the exact explicit repository scope.');
  plan.scope = plan.scope
    .map((repository) => selected.get(repository.toLowerCase())?.config.repository ?? repository)
    .sort();
  plan.checkouts = plan.checkouts.map((checkout) => ({
    ...checkout,
    repository: selected.get(checkout.repository.toLowerCase())?.config.repository ?? checkout.repository,
  }));
  const projects = new Map<string, { identity: string; items: ProjectItemObservation[] | null }>();
  const stoppedProjects = new Set<string>();
  const failedFieldCatalogs = new Map<string, CollectionLimitError>();
  let globalReadFailure: unknown;
  let retainedRecordsBytes = 0;
  let currentRepository = plan.scope[0]!;
  try {
    for (const repository of plan.scope) {
      currentRepository = repository;
      const context = selected.get(repository.toLowerCase());
      if (!context) {
        plan.scopeComplete = false;
        plan.gaps.push(gap(repository, 'context'));
        continue;
      }
      if (
        context.readPageLimit !== 20 ||
        context.clients.role !== 'author' ||
        `${context.repo.owner}/${context.repo.repo}`.toLowerCase() !== repository.toLowerCase()
      )
        throw new DeliveryError('Reconciliation requires a bounded configured author context.');
      const rows = new Map<string, NativeIssue>();
      try {
        if (globalReadFailure !== undefined) throw globalReadFailure;
        await inventory(context, rows, options.signal);
      } catch (error) {
        plan.scopeComplete = false;
        if (globalFailureReason(error) !== null) globalReadFailure = error;
        plan.gaps.push(gap(repository, 'issue-inventory', error));
      }
      let configuration: ProjectDeliveryConfiguration | null = null;
      let items: ProjectItemObservation[] | null = null;
      try {
        options.signal?.throwIfAborted();
        if (globalReadFailure !== undefined) throw globalReadFailure;
        if (context.configuration && stoppedProjects.has(context.configuration.routing.projectId))
          throw new DeliveryError('Shared Project collection previously stopped.');
        configuration = await getProjectDeliveryConfiguration({
          graphql: context.clients.graphql,
          org: context.config.native.organization,
          settings: projectSettingsFromDeliveryConfig(context.config),
          requireWritable: false,
          maxPages: 20,
        });
        const identity = projectIdentity(configuration),
          previous = projects.get(configuration.projectId);
        if (previous && previous.identity !== identity)
          throw new DeliveryError('Selected repositories disagree on their shared Project mapping.');
        if (previous) items = previous.items;
        else {
          projects.set(configuration.projectId, { identity, items: null });
          items = await readProjectDeliveryItems({
            graphql: context.clients.graphql,
            org: context.config.native.organization,
            configuration,
            maxPages: 20,
          });
          projects.set(configuration.projectId, { identity, items });
        }
        if (!items) throw new DeliveryError('Shared Project inventory is incomplete.');
        if (!context.configuration) throw new DeliveryError('Configured repository routing is unavailable.');
        const routing = context.configuration.routing;
        if (
          routing.projectId !== configuration.projectId ||
          routing.statusFieldId !== configuration.statusFieldId ||
          digestValue(routing.statusOptionIds) !== digestValue(configuration.statusOptionIds) ||
          routing.pointsFieldId !== configuration.pointsFieldId ||
          routing.priorityFieldId !== configuration.priorityFieldId
        )
          throw new DeliveryError('Project routing changed during collection.');
        let actor: Binding['actor'] = null;
        try {
          if (!context.clients.authenticatedAuthor)
            throw new DeliveryError('Configured author readback is unavailable.');
          actor = ActorSchema.parse(await context.clients.authenticatedAuthor(options.signal));
        } catch (error) {
          plan.scopeComplete = false;
          if (globalFailureReason(error) !== null) globalReadFailure = error;
          plan.gaps.push(gap(repository, 'actor', error, configuration.projectId));
        }
        plan.bindings.push({
          repository,
          routing,
          actor,
          configDigest: context.configuration.configDigest,
          checkoutRootsDigest: digestValue([...options.checkoutRoots].sort()),
        });
      } catch (error) {
        plan.scopeComplete = false;
        if (globalFailureReason(error) !== null) globalReadFailure = error;
        const projectId = configuration?.projectId ?? context.configuration?.routing.projectId;
        if (projectId !== undefined) stoppedProjects.add(projectId);
        plan.gaps.push(gap(repository, 'project-inventory', error, configuration?.projectId));
      }
      for (const listed of rows.values()) {
        options.signal?.throwIfAborted();
        const gaps: ReconcileGap[] = [];
        const missing = (stage: string, error?: unknown) => {
          gaps.push(gap(repository, stage, error, configuration?.projectId));
          if (globalFailureReason(error) !== null) {
            plan.scopeComplete = false;
            globalReadFailure = error;
          }
          if (error instanceof CollectionLimitError) {
            plan.scopeComplete = false;
            if (configuration) stoppedProjects.add(configuration.projectId);
            if (error.collection === 'native-field-catalog')
              failedFieldCatalogs.set(context.config.native.organization.toLowerCase(), error);
          }
        };
        let native = listed;
        try {
          if (globalReadFailure !== undefined) throw globalReadFailure;
          native = nativeIssue(
            (await context.clients.rest.issues.get({ ...context.repo, issue_number: listed.number })).data,
            repository,
          );
          if (native.number !== listed.number || native.node_id !== listed.node_id)
            throw new DeliveryError('Native issue identity changed.');
        } catch (error) {
          missing('native-identity', error);
          plan.scopeComplete = false;
        }
        options.signal?.throwIfAborted();
        let canonical = false,
          draft: boolean | null = null,
          deferred: boolean | null = null;
        try {
          const body = parseIssueBody(native.body ?? '', { title: native.title });
          if (!body.legacy) {
            canonical = true;
            draft = body.issue.draft ?? false;
            deferred = body.issue.deferral != null;
          } else missing('canonical-body');
        } catch (error) {
          missing('canonical-body', error);
        }
        let blockers: z.infer<typeof BlockerSchema>[] | null = null;
        try {
          if (globalReadFailure !== undefined) throw globalReadFailure;
          const relationships = await getNativeBlockerRelationships({
            graphql: context.clients.graphql,
            repo: context.repo,
            issueNumber: native.number,
            issueNodeId: native.node_id,
            requireRepositoryIdentity: true,
            maxPages: 20,
          });
          blockers = relationships.blockers
            .map((b) => BlockerSchema.parse({ id: b.id, repository: b.repository, number: b.number, state: b.state }))
            .sort((a, b) => a.id.localeCompare(b.id));
        } catch (error) {
          missing('native-blockers', error);
        }
        options.signal?.throwIfAborted();
        let tracking: ReturnType<typeof parseConfiguredNativeIssueMetadata> | null = null;
        try {
          if (globalReadFailure !== undefined) throw globalReadFailure;
          const failed = failedFieldCatalogs.get(context.config.native.organization.toLowerCase());
          if (failed) throw failed;
          const fields = await readIssueNativeFields(context, native.number);
          tracking = parseConfiguredNativeIssueMetadata(
            fields.values,
            nativeIssueSettingsFromDeliveryConfig(context.config),
          );
        } catch (error) {
          missing('native-metadata', error);
        }
        options.signal?.throwIfAborted();
        let hasChildren: boolean | null = null;
        try {
          if (globalReadFailure !== undefined) throw globalReadFailure;
          hasChildren = await hasNativeSubIssues({
            issueNumber: native.number,
            repo: context.repo,
            rest: context.clients.rest,
            requireComplete: true,
          });
        } catch (error) {
          missing('native-children', error);
        }
        let observed: IssueRecord['activity'] = { state: 'unknown', observation: null };
        try {
          if (globalReadFailure !== undefined) throw globalReadFailure;
          observed = await activity(
            context,
            native,
            plan.checkouts.find(
              (checkout) => checkout.repository === repository && checkout.issueNumber === native.number,
            ),
            options,
          );
        } catch (error) {
          missing('checkout', error);
        }
        const matches =
          items?.filter((item) => item.contentKind === 'issue' && item.contentId === native.node_id) ?? [];
        if (
          matches.some(
            (item) => item.repository?.toLowerCase() !== repository.toLowerCase() || item.issueNumber !== native.number,
          )
        ) {
          missing('membership-identity');
          plan.scopeComplete = false;
        }
        const member = matches.length === 1 ? matches[0]! : null;
        const membership: IssueRecord['membership'] = {
          kind:
            items === null
              ? 'unknown'
              : matches.length > 1
                ? 'duplicate'
                : member?.archived
                  ? 'archived-preserved'
                  : member
                    ? 'present'
                    : native.state === 'closed'
                      ? 'not-required'
                      : 'absent',
          itemId: member?.id ?? null,
          itemIds: matches.map((item) => item.id).sort(),
        };
        if (membership.kind === 'unknown' || membership.kind === 'duplicate') {
          missing('membership');
          plan.scopeComplete = false;
        }
        const record: IssueRecord = {
          repository,
          issueNodeId: native.node_id,
          issueNumber: native.number,
          projectId: configuration?.projectId ?? context.configuration?.routing.projectId ?? 'unresolved-project',
          native: {
            state: native.state,
            bodyDigest: digestValue(native.body ?? ''),
            canonical,
            draft,
            deferred,
            blockers,
            hasChildren,
            points: tracking?.points ?? null,
            priority: tracking?.priority ?? null,
          },
          membership,
          status: {
            current: member?.status ?? null,
            kind:
              member?.statusRead ??
              (membership.kind === 'absent' || membership.kind === 'not-required' ? 'unset' : 'unreadable'),
            name: member?.statusName ?? null,
            optionId: member?.statusOptionId ?? null,
            target: null,
            rule: 'unknown',
          },
          activity: observed,
          metadata: [],
          gaps,
        };
        if (member && !member.archived && record.status.kind === 'unreadable') missing('project-status');
        if (!['present', 'absent'].includes(membership.kind)) record.status.rule = 'preserved';
        else if (native.state === 'closed') record.status = { ...record.status, target: 'Done', rule: 'closed' };
        else if (blockers?.some((blocker) => blocker.state === 'OPEN'))
          record.status = { ...record.status, target: 'Blocked', rule: 'blocker' };
        else if (blockers !== null && canonical && (draft === true || deferred === true))
          record.status = { ...record.status, target: 'Todo', rule: 'parked' };
        else if (
          blockers !== null &&
          canonical &&
          draft === false &&
          deferred === false &&
          observed.state === 'observed-checkout' &&
          tracking !== null &&
          tracking.points !== undefined &&
          hasChildren === false &&
          configuration !== null &&
          !stoppedProjects.has(configuration.projectId)
        ) {
          try {
            const ready = await readyCheck(context, native.number);
            if (!ready.ready) throw new DeliveryError('Readiness is not satisfied.');
            await assertIssueStartCapacity(context, native.number);
            record.status = { ...record.status, target: 'In Progress', rule: 'active' };
          } catch (error) {
            missing('readiness-capacity', error);
          }
        }
        if (record.status.rule === 'unknown') missing('status-evidence');
        const operations = configuration ? propose(record, configuration) : [];
        if (configuration)
          record.metadata = metadata(
            context,
            native,
            configuration,
            record.native,
            tracking !== null,
            record.status.current,
            member !== null && record.status.kind !== 'unreadable',
          );
        const recordBytes =
          Buffer.byteLength(JSON.stringify(record), 'utf8') +
          operations.reduce((n, operation) => n + Buffer.byteLength(JSON.stringify(operation), 'utf8') + 1, 0) +
          1;
        const overhead = Buffer.byteLength(JSON.stringify({ ...plan, issues: [], operations: [] }), 'utf8');
        if (retainedRecordsBytes + recordBytes + overhead + 4096 > MAX_BYTES) {
          plan.scopeComplete = false;
          plan.gaps.push(gap(repository, 'retained-output'));
          return finishPlan(plan);
        }
        retainedRecordsBytes += recordBytes;
        plan.operations.push(...operations);
        plan.issues.push(record);
      }
    }
  } catch (error) {
    plan.scopeComplete = false;
    plan.gaps.push(gap(currentRepository, 'collection', error));
  }
  return finishPlan(plan);
}
