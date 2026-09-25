import type {
  ConfiguredNativeIssueMetadata as NativeIssueMetadata,
  NativePointValue,
  NativePriorityValue,
} from '../github/nativeIssueMetadata.js';
import type { ProjectDeliveryStatus } from '../github/projectDelivery.js';
import { DeliveryError } from '../errors.js';
import { z } from 'zod';

const isRetainedTaxonomyLabel = (value: string): boolean => /^(?:area|risk):[^\s:]+$/u.test(value);
const isRetainedIssueLabel = isRetainedTaxonomyLabel;

export interface CanonicalMigratedIssueState extends NativeIssueMetadata {
  blockedBy: number[];
  issueType?: string;
  projectStatus: ProjectDeliveryStatus;
}
export interface LegacyIssueMigrationInput {
  body: string;
  existingNative?: LegacyNativeIssueState | undefined;
  labels: string[];
  resolvedLegacyBlockers?: LegacyNativeBlockerRelationship[] | undefined;
  trackingParent?: boolean | undefined;
}

export interface LegacyIssueMigrationPlan extends LegacyIssueMigrationResult {
  number: number;
}

export interface LegacyIssueMigrationResult {
  body: string;
  clearPoints: boolean;
  native: CanonicalMigratedIssueState;
  retainedLabels: string[];
  retiredLabels: string[];
}

export interface LegacyIssueMigrationRun {
  mode: 'dry-run';
  plans: LegacyIssueMigrationPlan[];
  retiredRepositoryLabels: string[];
  schemaVersion: 'ai-delivery.legacy-issue-migration@1';
  validated: number;
}

const MigrationIssueSchema = z
  .object({
    number: z.number().int().positive(),
    body: z.string(),
    labels: z.array(z.string()),
    trackingParent: z.boolean().optional(),
    resolvedLegacyBlockers: z
      .array(z.object({ number: z.number().int().positive(), state: z.enum(['OPEN', 'CLOSED']) }).strict())
      .optional(),
    existingNative: z
      .object({
        blockedBy: z.array(
          z.object({ number: z.number().int().positive(), state: z.enum(['OPEN', 'CLOSED']) }).strict(),
        ),
        issueType: z.string().optional(),
        points: z.number().int().positive().optional(),
        priority: z.string().optional(),
        projectStatus: z.enum(['Todo', 'In Progress', 'Blocked', 'Done']).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Offline only: emit native conversion plans without touching live issues or active receipts. */
export function planOfflineLegacyIssueMigration(raw: unknown): LegacyIssueMigrationRun {
  const input = z
    .object({ issues: z.array(MigrationIssueSchema), repositoryLabels: z.array(z.string()).optional() })
    .strict()
    .parse(raw);
  const numbers = input.issues.map((issue) => issue.number);
  if (new Set(numbers).size !== numbers.length) throw new DeliveryError('Legacy issue input repeats an issue number.');
  return {
    mode: 'dry-run',
    plans: input.issues.map((issue) => {
      const native = issue.existingNative;
      const existingNative =
        native === undefined
          ? undefined
          : {
              blockedBy: native.blockedBy,
              ...(native.issueType === undefined ? {} : { issueType: native.issueType }),
              ...(native.points === undefined ? {} : { points: native.points }),
              ...(native.priority === undefined ? {} : { priority: native.priority }),
              ...(native.projectStatus === undefined ? {} : { projectStatus: native.projectStatus }),
            };
      return {
        number: issue.number,
        ...normalizeLegacyIssue({
          body: issue.body,
          labels: issue.labels,
          ...(existingNative === undefined ? {} : { existingNative }),
          ...(issue.resolvedLegacyBlockers === undefined
            ? {}
            : { resolvedLegacyBlockers: issue.resolvedLegacyBlockers }),
          ...(issue.trackingParent === undefined ? {} : { trackingParent: issue.trackingParent }),
        }),
      };
    }),
    retiredRepositoryLabels: resolveRetiredRepositoryLabels(input.repositoryLabels ?? []),
    schemaVersion: 'ai-delivery.legacy-issue-migration@1',
    validated: 0,
  };
}

export interface LegacyNativeBlockerRelationship {
  number: number;
  state: 'CLOSED' | 'OPEN';
}

export interface LegacyNativeIssueState extends NativeIssueMetadata {
  blockedBy: LegacyNativeBlockerRelationship[];
  issueType?: string;
  projectStatus?: ProjectDeliveryStatus;
}

const effortPoints = new Map<string, NativePointValue>([
  ['effort:l', 5],
  ['effort:m', 3],
  ['effort:medium', 3],
  ['effort:s', 2],
  ['effort:xl', 8],
  ['effort:xs', 1],
]);

const priorityValues = new Map<string, NativePriorityValue>([
  ['priority:high', 'P1'],
  ['priority:p0', 'P0'],
  ['priority:p1', 'P1'],
  ['priority:p2', 'P2'],
  ['priority:p3', 'P3'],
  ['priority:p4', 'P4'],
]);

const typeValues = new Map<string, string>([
  ['type:bug', 'Bug'],
  ['type:design', 'Task'],
  ['type:epic', 'Task'],
  ['type:feature', 'Feature'],
  ['type:spike', 'Task'],
  ['type:task', 'Task'],
  ['type:tracking', 'Task'],
]);

export function normalizeLegacyIssue(input: LegacyIssueMigrationInput): LegacyIssueMigrationResult {
  const labels = [...new Set(input.labels.map((label) => label.trim()).filter(Boolean))];
  const legacyBody = normalizeLegacyBody(input.body);
  const executionContract = readCommentObject(input.body, 'executionContract');
  const dependencyDeclaration = readCommentObject(input.body, 'dependencyDeclaration');
  const related = readCommentObject(input.body, 'related');
  const existingBlockers = normalizeNativeBlockers([
    ...(input.existingNative?.blockedBy ?? []),
    ...(input.resolvedLegacyBlockers ?? []),
  ]);
  const legacyBlockers = resolveBlockedBy({ dependencyDeclaration, executionContract, related });
  const blockedBy = [...new Set([...existingBlockers.keys(), ...legacyBlockers])].sort((left, right) => left - right);
  const unresolvedBlockers = new Set(blockedBy.filter((number) => existingBlockers.get(number) !== 'CLOSED'));
  const hasLegacyTrackingLabel = labels.some((label) => label.toLowerCase() === 'type:tracking');
  if (hasLegacyTrackingLabel && input.trackingParent !== true) {
    throw new DeliveryError(
      'Legacy type:tracking requires a native sub-issue relationship before its label can be retired.',
    );
  }
  const trackingParent = input.trackingParent === true;
  const points = trackingParent
    ? undefined
    : (input.existingNative?.points ??
      resolvePoints({
        ...(legacyBody.points === undefined ? {} : { bodyPoint: legacyBody.points }),
        executionContract,
        labels,
      }));
  const priority =
    input.existingNative?.priority ?? resolveSingleMappedValue({ label: 'priority', labels, mapping: priorityValues });
  const issueType =
    input.existingNative?.issueType ?? resolveSingleMappedValue({ label: 'issue type', labels, mapping: typeValues });
  if (input.existingNative?.projectStatus === 'Done') {
    throw new DeliveryError('An open issue cannot retain Project Done during legacy migration.');
  }
  const projectStatus = resolveMigrationProjectStatus({
    existing: input.existingNative?.projectStatus,
    labels,
    unresolvedBlockers,
  });
  const retainedLabels = labels.filter(isRetainedTaxonomyLabel);
  retainedLabels.sort();
  const retiredLabels = labels.filter((label) => !retainedLabels.includes(label)).sort();

  return {
    body: removeLegacyComments(legacyBody.body),
    clearPoints: trackingParent && input.existingNative?.points !== undefined,
    native: {
      blockedBy,
      ...(issueType === undefined ? {} : { issueType }),
      ...(points === undefined ? {} : { points }),
      ...(priority === undefined ? {} : { priority }),
      projectStatus,
    },
    retainedLabels,
    retiredLabels,
  };
}

/** Read legacy dependency declarations without activating them as a runtime workflow contract. */
export function readLegacyBlockerNumbers(body: string): number[] {
  return resolveBlockedBy({
    dependencyDeclaration: readCommentObject(body, 'dependencyDeclaration'),
    executionContract: readCommentObject(body, 'executionContract'),
    related: readCommentObject(body, 'related'),
  });
}

export function resolveRetiredRepositoryLabels(labels: readonly string[]): string[] {
  return [...new Set(labels.map((label) => label.trim()).filter((label) => label.length > 0))]
    .filter((label) => !isRetainedIssueLabel(label))
    .sort((left, right) => left.localeCompare(right));
}

/**
 * The sole legacy conversion path. Dry-run performs no writes; apply validates
 * every open issue after mutation before retired labels may be deleted.
 */
function normalizeLegacyBody(body: string): { body: string; points?: NativePointValue } {
  const lines = body.split(/\r?\n/u);
  const headings = lines.flatMap((line, index) => (line.trim().toLowerCase() === '## fibonacci points' ? [index] : []));
  if (headings.length === 0) return { body };
  if (headings.length > 1) {
    throw new DeliveryError('Found duplicate legacy Fibonacci points sections.');
  }
  const start = headings[0];
  if (start === undefined) return { body };
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]?.trimStart().startsWith('## ') === true) {
      end = index;
      break;
    }
  }
  const values = lines
    .slice(start + 1, end)
    .map((line) => line.trim())
    .filter(Boolean);
  if (values.length !== 1 || !/^(?:1|2|3|5|8|13)$/u.test(values[0] ?? '')) {
    throw new DeliveryError('Legacy Fibonacci points section must contain exactly one supported numeric value.');
  }
  return {
    body: [...lines.slice(0, start), ...lines.slice(end)].join('\n'),
    points: Number(values[0]) as NativePointValue,
  };
}

function isIssueNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function normalizeNativeBlockers(
  blockers: readonly LegacyNativeBlockerRelationship[],
): ReadonlyMap<number, LegacyNativeBlockerRelationship['state']> {
  const states = new Map<number, LegacyNativeBlockerRelationship['state']>();
  for (const blocker of blockers) {
    if (!isIssueNumber(blocker.number)) {
      throw new DeliveryError('Native blocked-by relationship evidence is malformed.');
    }
    const existing = states.get(blocker.number);
    if (existing !== undefined && existing !== blocker.state) {
      throw new DeliveryError(`Native blocker #${String(blocker.number)} has conflicting relationship states.`);
    }
    states.set(blocker.number, blocker.state);
  }
  return states;
}

function parseLegacyIssueNumber(value: unknown): number | undefined {
  if (isIssueNumber(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const match = /^#?([1-9]\d*)$/u.exec(value.trim());
  const parsed = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  return isIssueNumber(parsed) ? parsed : undefined;
}

function readCommentObject(body: string, key: string): Record<string, unknown> | undefined {
  const match = new RegExp(`<!--\\s*${key}:\\s*([\\s\\S]*?)\\s*-->`, 'u').exec(body);
  const payload = match?.[1];
  if (payload === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new DeliveryError(`Invalid legacy ${key} payload.`);
  }
}

function removeLegacyComments(body: string): string {
  return body.replace(/<!--\s*(?:executionContract|dependencyDeclaration|related):[\s\S]*?-->\s*/gu, '').trim();
}

function resolveBlockedBy({
  dependencyDeclaration,
  executionContract,
  related,
}: {
  dependencyDeclaration: Record<string, unknown> | undefined;
  executionContract: Record<string, unknown> | undefined;
  related: Record<string, unknown> | undefined;
}): number[] {
  const values: number[] = [];
  const dependencies = executionContract?.dependencies;
  if (Array.isArray(dependencies)) {
    for (const dependency of dependencies) {
      if (typeof dependency !== 'object' || dependency === null) continue;
      const candidate = dependency as { issue?: unknown; type?: unknown };
      const issueNumber = parseLegacyIssueNumber(candidate.issue);
      if (candidate.type === 'blockedBy' && issueNumber !== undefined) {
        values.push(issueNumber);
      }
    }
  }
  values.push(...resolveLegacyIssueNumbers(dependencyDeclaration?.blockedBy));
  values.push(...resolveLegacyIssueNumbers(related?.blockedBy));
  return [...new Set(values)].sort((left, right) => left - right);
}

function resolveLegacyIssueNumbers(raw: unknown): number[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map(parseLegacyIssueNumber).filter((value): value is number => value !== undefined);
}

function resolveMigrationProjectStatus(input: {
  existing: ProjectDeliveryStatus | undefined;
  labels: string[];
  unresolvedBlockers: ReadonlySet<number>;
}): ProjectDeliveryStatus {
  if (input.unresolvedBlockers.size > 0) return 'Blocked';
  const legacyTaskOwned = input.labels.some((label) =>
    ['status:in-progress', 'status:review'].includes(label.toLowerCase()),
  );
  return input.existing === 'In Progress' || legacyTaskOwned ? 'In Progress' : 'Todo';
}

function resolvePoints(input: {
  bodyPoint?: NativePointValue;
  executionContract: Record<string, unknown> | undefined;
  labels: string[];
}): NativePointValue {
  const candidates: NativePointValue[] = [];
  for (const label of input.labels) {
    const effort = effortPoints.get(label.toLowerCase());
    if (effort !== undefined) {
      candidates.push(effort);
    }
    const pointMatch = /^points:(1|2|3|5|8|13)$/u.exec(label.toLowerCase());
    if (pointMatch?.[1] !== undefined) {
      candidates.push(Number(pointMatch[1]) as NativePointValue);
    }
  }
  const contractEffort = input.executionContract?.effort;
  if (typeof contractEffort === 'string') {
    const normalized = contractEffort.startsWith('effort:') ? contractEffort : `effort:${contractEffort}`;
    const mapped = effortPoints.get(normalized.toLowerCase());
    if (mapped !== undefined) {
      candidates.push(mapped);
    }
  }
  if (input.bodyPoint !== undefined) {
    candidates.push(input.bodyPoint);
  }
  const distinct = [...new Set(candidates)];
  if (distinct.length > 1) {
    throw new DeliveryError(`Found conflicting legacy sizing values: ${distinct.join(', ')}.`);
  }
  const [points] = distinct;
  if (points === undefined) {
    throw new DeliveryError('Issue has no canonical Fibonacci sizing value; assign native Points before migration.');
  }
  return points;
}

function resolveSingleMappedValue<T>({
  label,
  labels,
  mapping,
}: {
  label: string;
  labels: string[];
  mapping: Map<string, T>;
}): T | undefined {
  const candidates = labels.flatMap((value) => {
    const mapped = mapping.get(value.toLowerCase());
    return mapped === undefined ? [] : [mapped];
  });
  const distinct = [...new Set(candidates)];
  if (distinct.length > 1) {
    throw new DeliveryError(`Found conflicting legacy ${label} values.`);
  }
  return distinct[0];
}
