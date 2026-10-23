import { types } from 'node:util';
import { z } from 'zod';

import type {
  DeliveryConfig,
  GitHubDeliveryConfig,
  LoadedDeliveryConfig,
  LoadedGitHubConfig,
  LoadedDeliverySettings,
} from './config/deliveryConfig.js';
import { loadDeliveryConfig, WipLimits, type WipLane } from './config/deliveryConfig.js';
import { digestValue } from './delivery/legacy.js';
import {
  CollectionLimitError,
  DeliveryError,
  getRateLimitDiagnostics,
  getMachineRequestDiagnostics,
  setMachineRequestDiagnostics,
  type RateLimitDiagnostics,
} from './errors.js';
import { createDeliveryGitHubClients, type GitHubClients } from './github/client.js';
import {
  NATIVE_ISSUE_API_VERSION,
  applyNativeIssueDates,
  prepareNativeIssueDates,
  parseConfiguredNativeIssueMetadata,
  type NativeIssueDatePatch,
  clearConfiguredNativeIssuePoints,
  getConfiguredNativeIssueMetadata,
  nativeIssueSettingsFromDeliveryConfig,
  setConfiguredNativeIssueMetadata,
} from './github/nativeIssueMetadata.js';
import {
  getIssueProjectStatus,
  assertIssueProjectWritable,
  getProjectDeliveryConfiguration,
  type ProjectDeliveryConfiguration,
  projectSettingsFromDeliveryConfig,
  syncIssueProjectStatus,
} from './github/projectDelivery.js';
import {
  getNativeBlockerRelationships,
  hasNativeSubIssues,
  linkBlockedBy,
  replaceBlockedBy,
  replaceParentIssue,
  resolveNativeRelationshipTargets,
} from './github/relationships.js';
import { prepareBlockerGuard, OverrideReason } from './services/blockerGuardService.js';
import { type RepoCoordinates } from './github/repo.js';
import { evaluateAgentReadiness, type AgentReadinessResult } from './services/agentReadinessService.js';
import { JournalInputSchema, renderJournal, type JournalInput } from './issueJournal.js';
import {
  IssueFields,
  IssueWriteFields,
  CreateIssueStatus,
  IssueStatusPatch,
  requireIssueStatus,
  parseIssueBody,
  requireIssue,
  renderIssueBody,
  issueWarnings,
  issueBodyDiff,
  issueTrackingFooter,
  validateIssue,
  IssueValidationError,
  type IssueFieldsInput,
  type IssueDiagnostic,
  type IssueStatusData,
  type IssueDeferralData,
  requireDeferralPatch,
} from './issueContract.js';

export interface IssueCommentReadback {
  commentId: number;
  url: string;
  body: string;
  reused: boolean;
}

// Matches GitHub's first-party JavaScript comment-length validation:
// https://github.com/github/gh-aw/blob/3ead8042c7b1edc2128ba1b28b1b80d00b7f4c22/actions/setup/js/comment_limit_helpers.cjs
export const ISSUE_COMMENT_BODY_LIMIT = 65_536;
export type IssueCommentInput = JournalInput | { issueNumber: number; body: string };
const RawIssueCommentSchema = z.strictObject({ issueNumber: z.number().int().positive(), body: z.string() });

/** One canonical exact-body operation shared by direct calls, MCP, and lifecycle journals. */
export async function commentIssue(
  context: DeliveryContext,
  input: IssueCommentInput,
  lifecycleKey?: string,
): Promise<IssueCommentReadback> {
  return writeAuthenticatedIssueComment(context, input, lifecycleKey);
}

async function writeAuthenticatedIssueComment(
  context: DeliveryContext,
  input: IssueCommentInput,
  lifecycleKey?: string,
  rawMarker?: string,
): Promise<IssueCommentReadback> {
  const accepted =
    'body' in input ? RawIssueCommentSchema.parse(input) : (JournalInputSchema.parse(input) as JournalInput);
  const rawBody = 'body' in accepted ? accepted.body : undefined;
  if (rawBody !== undefined && lifecycleKey !== undefined)
    throw new DeliveryError('Raw issue comments do not accept a lifecycle journal key.');
  const marker =
    rawBody === undefined
      ? `<!-- ai-delivery:journal@1:${digestValue({ issueNumber: accepted.issueNumber, key: lifecycleKey ?? accepted })} -->`
      : rawMarker;
  const body = rawBody ?? renderJournal(accepted as JournalInput, marker);
  if (body.length > ISSUE_COMMENT_BODY_LIMIT || !body.trim())
    throw new DeliveryError(
      `Issue comment body must contain text and fit ${String(ISSUE_COMMENT_BODY_LIMIT)} UTF-16 code units.`,
    );
  if (context.clients.role !== 'author' || !context.clients.authenticatedAuthor)
    throw new DeliveryError('Issue comments require the authenticated author role.');
  const actor = (await context.clients.authenticatedAuthor()).actorLogin;
  if (!actor) throw new DeliveryError('Issue comment author identity is missing.');
  const operation = async () => {
    const issue = (await context.clients.rest.issues.get({ ...context.repo, issue_number: input.issueNumber })).data;
    if ('pull_request' in issue || issue.number !== input.issueNumber)
      throw new DeliveryError('Issue comment target is not the requested issue.');
    const matches = [];
    for (let page = 1; page <= 20; page += 1) {
      const batch = (
        await context.clients.rest.issues.listComments({
          ...context.repo,
          issue_number: input.issueNumber,
          page,
          per_page: 100,
        })
      ).data;
      matches.push(
        ...batch.filter(
          (comment) =>
            (marker === undefined
              ? comment.body === body
              : rawMarker === undefined
                ? comment.body?.endsWith(marker)
                : comment.body?.includes(marker)) && comment.user?.login.toLowerCase() === actor.toLowerCase(),
        ),
      );
      if (batch.length < 100) break;
      if (page === 20) throw new DeliveryError('Issue comment history exceeds the bounded readback window.');
    }
    if (matches.length > 1) throw new DeliveryError('Issue comment has duplicate authored retry matches.');
    const existing = matches[0];
    if (rawMarker !== undefined && existing && existing.body !== body)
      throw new DeliveryError('Issue comment conflicts with its authored operation marker.');
    const created =
      existing ??
      (await context.clients.rest.issues.createComment({ ...context.repo, issue_number: input.issueNumber, body }))
        .data;
    if (lifecycleKey === undefined && (existing?.body ?? body) !== body)
      throw new DeliveryError('Issue comment readback disagrees with the authored issue comment.');
    const readback = await readAuthoredIssueComment(context, input.issueNumber, created, existing?.body ?? body, actor);
    return { ...readback, reused: existing !== undefined };
  };
  return operation();
}

async function readAuthoredIssueComment(
  context: DeliveryContext,
  issueNumber: number,
  created: { id: number; html_url: string },
  body: string,
  actor: string,
): Promise<Omit<IssueCommentReadback, 'reused'>> {
  const readback = (await context.clients.rest.issues.getComment({ ...context.repo, comment_id: created.id })).data;
  const expectedIssuePath = `/repos/${context.repo.owner}/${context.repo.repo}/issues/${String(issueNumber)}`;
  if (
    !Number.isSafeInteger(readback.id) ||
    readback.id <= 0 ||
    readback.id !== created.id ||
    readback.html_url !== created.html_url ||
    readback.body !== body ||
    readback.user?.login.toLowerCase() !== actor.toLowerCase() ||
    new URL(readback.issue_url).pathname.toLowerCase() !== expectedIssuePath.toLowerCase() ||
    !readback.html_url.startsWith('https://')
  )
    throw new DeliveryError('Issue comment readback disagrees with the authored issue comment.');
  return { commentId: readback.id, url: readback.html_url, body: readback.body! };
}

export async function journalIssueStart(context: DeliveryContext, issueNumber: number): Promise<IssueCommentReadback> {
  const issue = (await context.clients.rest.issues.get({ ...context.repo, issue_number: issueNumber })).data;
  return commentIssue(
    context,
    {
      issueNumber,
      kind: 'start',
      summary: `Work started on ${issue.title}.`,
      status: 'Started',
      outcome: issue.title,
      keyNumbers: [`Issue #${String(issueNumber)}`],
      evidence: [issue.html_url],
      nextStep: 'Implement the issue acceptance criteria and run its verification',
      nextDate: null,
    },
    `start:${issue.created_at}`,
  );
}

export interface DeliveryContext {
  credentialEnvironment?: NodeJS.ProcessEnv;
  readPageLimit?: number;
  clients: GitHubClients;
  reviewerClients?: GitHubClients;
  configuration?: LoadedDeliveryConfig | LoadedGitHubConfig;
  projectConfiguration?: ProjectDeliveryConfiguration;
  config: DeliveryConfig | GitHubDeliveryConfig;
  repo: RepoCoordinates;
  root: string;
}

export async function loadDeliveryContext(input: {
  settings?: LoadedDeliverySettings;
  env?: NodeJS.ProcessEnv;
  readPageLimit?: number;
  requireWritableProject?: boolean;
  identity: string;
  personalAuth?: boolean;
  repoRoot: string;
  role: 'author' | 'reviewer';
  repository?: string;
  signal?: AbortSignal;
}): Promise<DeliveryContext> {
  const loaded = await loadDeliveryConfig(input.repoRoot, {
    ...(input.settings === undefined ? {} : { settings: input.settings }),
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.readPageLimit === undefined ? {} : { readPageLimit: input.readPageLimit }),
    ...(input.requireWritableProject === undefined ? {} : { requireWritableProject: input.requireWritableProject }),
    ...(input.repository === undefined ? {} : { repository: input.repository }),
    ...(input.personalAuth === undefined ? {} : { personalAuth: input.personalAuth }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const config = loaded.config;
  const [owner, repositoryName] = config.repository.split('/');
  if (!owner || !repositoryName) throw new DeliveryError('Repository must be owner/name.');
  const repo = { owner, repo: repositoryName };
  const clients = await createDeliveryGitHubClients({
    config,
    identity: input.identity,
    ...(input.personalAuth ? { personalAuth: { enabled: true as const } } : {}),
    role: input.role,
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const routing = loaded.routing;
  const projectConfiguration: ProjectDeliveryConfiguration = {
    projectId: routing.projectId,
    projectNumber: config.native.project.number,
    title: config.native.project.title,
    pointsFieldId: routing.pointsFieldId,
    priorityFieldId: routing.priorityFieldId,
    statusFieldId: routing.statusFieldId,
    statusOptionIds: routing.statusOptionIds,
    settings: projectSettingsFromDeliveryConfig(config),
    writable: true,
  };
  return {
    clients,
    ...(input.env === undefined ? {} : { credentialEnvironment: input.env }),
    config,
    configuration: loaded,
    ...(input.requireWritableProject === false ? {} : { projectConfiguration }),
    repo,
    root: '',
    ...(input.readPageLimit === undefined ? {} : { readPageLimit: input.readPageLimit }),
  };
}

async function labels(context: DeliveryContext, input: readonly string[] | undefined): Promise<string[]> {
  const selected = input ?? [];
  if (
    selected.some((label) => !label.trim()) ||
    new Set(selected.map((label) => label.toLowerCase())).size !== selected.length
  )
    throw new DeliveryError('Issue labels must be non-empty and unique.');
  if (selected.length === 0) return [];
  const available = new Set<string>();
  for (let page = 1; page <= 100; page++) {
    if (context.readPageLimit !== undefined && page > context.readPageLimit)
      throw new CollectionLimitError({
        collection: 'repository-labels',
        pagesRequested: page - 1,
        rowsObserved: available.size,
        limit: context.readPageLimit,
      });
    const batch = (await context.clients.rest.issues.listLabelsForRepo({ ...context.repo, page, per_page: 100 })).data;
    for (const label of batch) available.add(label.name.toLowerCase());
    if (batch.length < 100) {
      const missing = selected.filter((label) => !available.has(label.toLowerCase()));
      if (missing.length) throw new DeliveryError(`Unknown repository label(s): ${missing.join(', ')}.`);
      return [...selected];
    }
  }
  throw new DeliveryError('Repository label listing exceeds the bounded readback window.');
}

export interface CreateIssueInput extends Partial<IssueFieldsInput>, NativeIssueDatePatch {
  status?: { nextMilestone?: string };
  /** Stable retry identity scoped to this repository and authenticated author. */
  opId?: string;
  blockedBy?: number[];
  /** Add this issue as a blocker of these dependents without replacing their other blockers. */
  blocks?: number[];
  overrideReason?: string;
  body?: string;
  issueType?: string | undefined;
  labels?: string[];
  milestone?: number;
  parentIssueNumber?: number;
  points?: number | undefined;
  priority?: string;
  title: string;
}

function prepareIssueWrite(
  input: Partial<IssueFieldsInput> & {
    body?: string;
    park?: true;
    defer?: IssueDeferralData;
    undefer?: true;
    status?: { nextMilestone?: string; blockers?: string; latestJournal?: string };
    blockedBy?: number[];
    preserveHistory?: boolean;
  },
  current?: IssueInfo,
  forIntent = false,
) {
  const patch =
    input.status === undefined
      ? undefined
      : requireIssueStatus(
          IssueStatusPatch,
          current === undefined ? requireIssueStatus(CreateIssueStatus, input.status) : input.status,
        );
  if (input.blockedBy !== undefined && patch && 'blockers' in patch)
    throw new DeliveryError('Choose native blockedBy or display-only status.blockers in one update, not both.');
  const statusOnly =
    patch !== undefined &&
    Object.entries(input).every(
      ([key, value]) => value === undefined || ['repo', 'issueNumber', 'status'].includes(key),
    );
  const title = input.title ?? current?.title ?? '';
  const source = input.body ?? current?.body;
  const prior = current?.body ?? source;
  const currentParsed =
    current === undefined
      ? undefined
      : parseIssueBody(current.body, {
          title: current.title,
          ...(current.points === undefined ? {} : { points: current.points }),
          ...(current.issueType === null ? {} : { issueType: current.issueType }),
        });
  const currentLegacy = currentParsed?.legacy === true;
  if (statusOnly && currentLegacy)
    throw new DeliveryError('Convert the legacy contract explicitly before a status-only update.');
  const points = statusOnly ? currentParsed?.issue.points : (input.points ?? current?.points);
  const issueType = statusOnly ? currentParsed?.issue.issueType : (input.issueType ?? current?.issueType ?? undefined);
  const metadata = {
    title: input.body === undefined && current ? current.title : title,
    ...(points === undefined ? {} : { points }),
    ...(issueType === undefined ? {} : { issueType }),
  };
  const parsed: ReturnType<typeof parseIssueBody> =
    source === undefined ? { issue: IssueFields.parse({ title }), legacy: false } : parseIssueBody(source, metadata);
  let legacyBody = currentParsed?.issue.legacyBody ?? parsed.issue.legacyBody;
  if (
    parsed.issue.legacyBody !== undefined &&
    legacyBody !== undefined &&
    !legacyBody.includes(parsed.issue.legacyBody)
  )
    legacyBody += '\n\n' + parsed.issue.legacyBody;
  const incomingLegacy =
    current !== undefined &&
    parsed.issue.legacyBody !== undefined &&
    parsed.issue.legacyBody !== currentParsed?.issue.legacyBody &&
    parsed.issue.legacyBody !== current.body;
  const fields = Object.fromEntries(
    Object.keys(IssueWriteFields).flatMap((key) => {
      const value = input[key as keyof IssueFieldsInput];
      return value === undefined ? [] : [[key, value]];
    }),
  );
  const issue = requireIssue({
    ...parsed.issue,
    // Body replacements and unrelated typed patches cannot implicitly resume deferred work.
    deferral:
      input.undefer === true
        ? undefined
        : (input.defer ?? (current === undefined ? parsed.issue.deferral : currentParsed?.issue.deferral)),
    ...metadata,
    ...fields,
    title,
    ...(legacyBody === undefined ? {} : { legacyBody }),
    ...(input.retainLegacyBody !== undefined
      ? { retainLegacyBody: input.retainLegacyBody }
      : incomingLegacy
        ? { retainLegacyBody: true }
        : current !== undefined && legacyBody !== undefined && input.preserveHistory !== false && !statusOnly
          ? { retainLegacyBody: false }
          : {}),
    ...(input.park ? { draft: true } : {}),
  });
  const unchangedContract =
    currentParsed !== undefined && JSON.stringify(issue) === JSON.stringify(currentParsed.issue);
  const legacyFormatting = unchangedContract && parsed.legacyFormatting === true;
  const base = parsed.status ?? currentParsed?.status;
  const proposed: IssueStatusData = {
    state: issue.draft ? 'Draft' : 'Ready',
    lastUpdated: base?.lastUpdated ?? new Date(Date.now()).toISOString(),
    nextMilestone: patch?.nextMilestone ?? base?.nextMilestone ?? 'Not started',
    blockers: patch?.blockers ?? base?.blockers ?? 'None',
    latestJournal: patch?.latestJournal ?? base?.latestJournal ?? 'None yet',
    ...(input.blockedBy === undefined
      ? {}
      : {
          blockers: input.blockedBy.length ? input.blockedBy.map((number) => '#' + String(number)).join(', ') : 'None',
        }),
  };
  const unchangedDisplay =
    currentParsed?.status !== undefined &&
    (['state', 'nextMilestone', 'blockers', 'latestJournal'] as const).every(
      (key) => proposed[key] === currentParsed.status![key],
    );
  const displayChanged = JSON.stringify(proposed) !== JSON.stringify(base);
  const status = forIntent
    ? undefined
    : current === undefined
      ? {
          ...proposed,
          state: issue.draft ? ('Draft' as const) : ('Ready' as const),
          lastUpdated: new Date(Date.now()).toISOString(),
          blockers: input.blockedBy?.length ? input.blockedBy.map((number) => '#' + String(number)).join(', ') : 'None',
          latestJournal: 'None yet',
        }
      : unchangedContract && unchangedDisplay
        ? currentParsed?.status
        : !unchangedContract ||
            (patch !== undefined && displayChanged) ||
            (input.blockedBy !== undefined && displayChanged)
          ? {
              ...proposed,
              lastUpdated: new Date(Date.now()).toISOString(),
            }
          : base;
  const body =
    renderIssueBody(issue, status, forIntent ? false : legacyFormatting) +
    (source === undefined || parsed.legacy ? '' : issueTrackingFooter(source));
  return {
    issue,
    body,
    statusOnly,
    preserveHistory:
      input.preserveHistory ??
      ((currentLegacy ||
        parsed.legacy ||
        (legacyBody !== undefined &&
          issue.retainLegacyBody === false &&
          currentParsed?.issue.retainLegacyBody !== false)) &&
        !statusOnly),
    warnings: issueWarnings(issue, status, legacyFormatting),
    ...((currentLegacy || parsed.legacy) && prior !== undefined
      ? { conversion: { priorBody: prior, canonicalBody: body, diff: issueBodyDiff(prior, body) } }
      : {}),
  };
}
/** Display timestamps are excluded from the contract-bound normal-start retry intent. */
export function canonicalIssueBody(input: CreateIssueInput): string {
  return prepareIssueWrite(input, undefined, true).body;
}

export class CreatedTrackingIssueError extends DeliveryError {
  constructor(
    readonly created: { number: number; title: string; url: string },
    cause: unknown,
    readonly failedStep?: string,
    readonly remainingSteps?: readonly string[],
    readonly opId?: string,
  ) {
    super(
      `Issue #${created.number} was created but native tracking did not complete: ${String(cause)}. ${failedStep === undefined ? '' : `Failed step: ${failedStep}. Remaining steps: ${remainingSteps?.join(', ')}. `}${opId === undefined ? 'Resume this known issue; do not create another.' : 'Repeat issue_create with the same opId and original arguments to finish this known issue.'}`,
    );
  }
}

export async function createIssue(
  context: DeliveryContext,
  input: CreateIssueInput,
): Promise<{
  body: string;
  created: { number: number; title: string; url: string };
  routing?: LoadedDeliveryConfig['routing'];
  warnings: IssueDiagnostic[];
}> {
  if (context.clients.role !== 'author') throw new DeliveryError('Issue writes require the configured author role.');
  const canonicalBody = canonicalIssueBody(input);
  const prepared = prepareIssueWrite(input);
  const originalIntent = digestValue(
    Object.fromEntries(
      Object.entries({ ...input, opId: undefined, body: canonicalBody }).filter(([, value]) => value !== undefined),
    ),
  );
  const dateChanges = await prepareIssueDates(context, input);
  input = {
    ...input,
    title: prepared.issue.title,
    body: prepared.body,
    ...(prepared.issue.issueType === undefined ? {} : { issueType: prepared.issue.issueType }),
    ...(prepared.issue.points === undefined ? {} : { points: prepared.issue.points }),
  };
  if (!input.title.trim()) throw new DeliveryError('Issue title is required.');
  if (input.issueType !== undefined && !context.config.native.issueTypes.includes(input.issueType)) {
    throw new DeliveryError('Unsupported configured Issue Type.');
  }
  if (input.points !== undefined && !context.config.native.points.values.includes(String(input.points))) {
    throw new DeliveryError('Unsupported configured Points value.');
  }
  if (input.priority !== undefined && !context.config.native.priority.values.includes(input.priority)) {
    throw new DeliveryError('Unsupported configured Priority value.');
  }
  const { clients, config, repo } = context;
  const targets = await resolveNativeRelationshipTargets({
    blockers: input.blockedBy ?? [],
    ...(input.parentIssueNumber === undefined ? {} : { parentIssueNumber: input.parentIssueNumber }),
    repo,
    rest: clients.rest,
  });
  const beforeAdd =
    (input.blocks?.length ?? 0) > 0 || (input.blockedBy?.length ?? 0) > 0
      ? await prepareBlockerGuard(
          context,
          (input.blocks ?? []).map((dependent) => ({ dependent, blockers: [], pendingBlocker: true })),
          input.overrideReason,
          input.blockedBy ?? [],
        )
      : async () => {};
  let prior: Awaited<ReturnType<typeof clients.rest.issues.listForRepo>>['data'][number] | undefined;
  if (input.opId !== undefined) {
    const opId = z.string().trim().min(1).max(256).parse(input.opId);
    const actor = (await clients.authenticatedAuthor?.())?.actorLogin;
    if (!actor) throw new DeliveryError('Create retry requires authenticated author identity.');
    const key = digestValue({ repository: config.repository.toLowerCase(), actor: actor.toLowerCase(), opId });
    const marker = `<!-- ai-delivery-create: ${key} intent: ${originalIntent} -->`;
    const matches: (typeof prior)[] = [];
    for (let page = 1; page <= Math.min(20, context.readPageLimit ?? 20); page++) {
      const batch = (await clients.rest.issues.listForRepo({ ...repo, state: 'all', page, per_page: 100 })).data;
      matches.push(
        ...batch.filter(
          (row) => !('pull_request' in row) && row.body?.includes(`<!-- ai-delivery-create: ${key} intent:`),
        ),
      );
      if (batch.length < 100) break;
      if (page === Math.min(20, context.readPageLimit ?? 20))
        throw new DeliveryError('Create retry search exceeds the bounded readback window; reconcile the known issue.');
    }
    if (matches.length > 1) throw new DeliveryError('Conflicting issues claim the same create opId.');
    prior = matches[0];
    if (prior) {
      const footer = issueTrackingFooter(prior.body ?? '');
      if (
        prior.user?.login.toLowerCase() !== actor.toLowerCase() ||
        prior.state !== 'open' ||
        prior.title !== input.title ||
        footer !== `\n\n${marker}` ||
        canonicalIssueBody({ title: prior.title, body: (prior.body ?? '').slice(0, -footer.length) }) !== canonicalBody
      )
        throw new DeliveryError('Prior create opId conflicts with its author, original intent or current issue state.');
      input.body = prior.body ?? '';
    } else input.body = `${input.body}\n\n${marker}`;
  }
  const created = prior
    ? { data: prior }
    : await clients.rest.issues.create({
        body: input.body ?? '',
        labels: await labels(context, input.labels),
        ...(input.milestone === undefined ? {} : { milestone: input.milestone }),
        owner: repo.owner,
        repo: repo.repo,
        title: input.title,
        ...(input.issueType === undefined ? {} : { type: input.issueType }),
      });
  const issueNumber = created.data.number;
  const steps = [
    'created-readback',
    ...(input.points !== undefined || input.priority !== undefined ? ['metadata'] : []),
    ...(dateChanges.length ? ['dates'] : []),
    'project',
    ...(input.parentIssueNumber !== undefined ? ['parent', 'parent-points'] : []),
    ...((input.blockedBy?.length ?? 0) > 0 ? ['blockers'] : []),
    ...((input.blocks?.length ?? 0) > 0 ? ['dependents'] : []),
    'readback',
  ];
  let step = steps[0]!;
  try {
    if (
      created.data.title !== input.title ||
      (created.data.body ?? '') !== input.body ||
      !Number.isSafeInteger(issueNumber) ||
      issueNumber <= 0 ||
      new URL(created.data.html_url).pathname.toLowerCase() !==
        `/${repo.owner}/${repo.repo}/issues/${String(issueNumber)}`.toLowerCase()
    )
      throw new DeliveryError(
        'Created issue content or repository identity readback disagrees; reconcile this existing issue before retrying.',
      );
    const existing = prior === undefined ? undefined : await issueInfo(context, issueNumber);
    const existingRelationships =
      prior === undefined
        ? undefined
        : await getNativeBlockerRelationships({ graphql: clients.graphql, issueNumber, repo });
    if (
      existing &&
      (existing.projectStatus === 'In Progress' ||
        existing.projectStatus === 'Done' ||
        (input.points !== undefined && existing.points !== undefined && existing.points !== input.points) ||
        (input.priority !== undefined && existing.priority !== undefined && existing.priority !== input.priority) ||
        dateChanges.some(
          (change) => existing.fields[change.name] != null && existing.fields[change.name] !== change.value,
        ) ||
        (existing.parentIssueNumber !== null && existing.parentIssueNumber !== (input.parentIssueNumber ?? null)) ||
        existingRelationships!.blockers.some((blocker) => !(input.blockedBy ?? []).includes(blocker.number)))
    )
      throw new DeliveryError('Prior create opId conflicts with later native tracking changes.');
    step = 'metadata';
    if (
      (input.points !== undefined && existing?.points !== input.points) ||
      (input.priority !== undefined && existing?.priority !== input.priority)
    )
      await setConfiguredNativeIssueMetadata({
        issueNumber,
        metadata: {
          ...(input.points === undefined ? {} : { points: input.points }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
        },
        org: config.native.organization,
        owner: repo.owner,
        repo: repo.repo,
        rest: clients.rest,
        settings: nativeIssueSettingsFromDeliveryConfig(config),
      });
    step = 'dates';
    await applyNativeIssueDates({
      changes: dateChanges.filter(
        (change) => existing === undefined || (existing.fields[change.name] ?? null) !== change.value,
      ),
      issueNumber,
      ...repo,
      rest: clients.rest,
    });
    step = 'project';
    if (existing?.projectStatus !== (targets.unresolvedBlockers.length > 0 ? 'Blocked' : 'Todo'))
      await syncIssueProjectStatus({
        graphql: clients.graphql,
        issueNodeId: created.data.node_id,
        org: config.native.organization,
        ...(context.projectConfiguration ? { configuration: context.projectConfiguration } : {}),
        settings: projectSettingsFromDeliveryConfig(config),
        status: targets.unresolvedBlockers.length > 0 ? 'Blocked' : 'Todo',
      });
    step = 'parent';
    if (input.parentIssueNumber !== undefined)
      await replaceParentIssue({
        graphql: clients.graphql,
        issueNumber,
        parentIssueNumber: input.parentIssueNumber,
        repo,
        rest: clients.rest,
      });
    step = 'parent-points';
    if (input.parentIssueNumber !== undefined)
      await clearConfiguredNativeIssuePoints({
        issueNumber: input.parentIssueNumber,
        org: config.native.organization,
        owner: repo.owner,
        repo: repo.repo,
        rest: clients.rest,
        settings: nativeIssueSettingsFromDeliveryConfig(config),
      });
    step = 'blockers';
    if ((input.blockedBy?.length ?? 0) > 0)
      await replaceBlockedBy({
        beforeAdd,
        blockers: input.blockedBy ?? [],
        graphql: clients.graphql,
        issueNumber,
        repo,
        rest: clients.rest,
      });
    step = 'dependents';
    for (const dependent of new Set(input.blocks ?? []))
      await linkBlockedBy({
        beforeAdd,
        blockers: [issueNumber],
        graphql: clients.graphql,
        issueNumber: dependent,
        repo,
        rest: clients.rest,
      });
    step = 'readback';
    const readback = await issueInfo(context, issueNumber);
    if (
      readback.title !== input.title ||
      readback.body !== input.body ||
      (input.points !== undefined && readback.points !== input.points) ||
      (input.issueType !== undefined && readback.issueType !== input.issueType)
    )
      throw new DeliveryError('Created issue native content or metadata readback disagrees; resume this known issue.');
  } catch (error) {
    throw new CreatedTrackingIssueError(
      { number: issueNumber, title: created.data.title, url: created.data.html_url },
      error,
      step,
      steps.slice(steps.indexOf(step)),
      input.opId,
    );
  }
  return {
    ...(context.configuration ? { routing: context.configuration.routing } : {}),
    body: created.data.body ?? input.body ?? '',
    created: { number: issueNumber, title: created.data.title, url: created.data.html_url },
    warnings: prepared.warnings,
  };
}

export interface ListIssuesInput {
  query?: string;
  state?: 'open' | 'closed' | 'all';
  labels?: string[];
  parentIssueNumber?: number | null;
  issueType?: string;
  projectStatus?: 'Todo' | 'In Progress' | 'Blocked' | 'Done' | null;
  updatedSince?: string;
  page?: number;
  perPage?: number;
}

const FieldCatalogEntry = z.object({
  id: z.number().int().positive().safe(),
  name: z.string().min(1),
  data_type: z.enum(['text', 'number', 'date', 'single_select', 'multi_select']),
});
const FieldValueEntry = z.object({
  issue_field_id: z.number().int().positive().safe(),
  issue_field_name: z.string().min(1),
  data_type: FieldCatalogEntry.shape.data_type,
  value: z.unknown().optional(),
  single_select_option: z
    .object({ name: z.string().min(1) })
    .nullable()
    .optional(),
  multi_select_options: z.array(z.object({ name: z.string().min(1) })).optional(),
});
const ListedIssue = z.object({
  number: z.number().int().positive().safe(),
  node_id: z.string().min(1),
  title: z.string(),
  body: z.string().nullable().optional(),
  state: z.enum(['open', 'closed']),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
  type: z.object({ name: z.string() }).nullable().optional(),
  html_url: z.url(),
  updated_at: z.iso.datetime({ offset: true }),
});
export interface ListedTrackingIssue {
  nodeId?: string;
  fieldIds?: Record<string, number>;
  deferred?: IssueDeferralData | null;
  number: number;
  title: string;
  state: 'open' | 'closed';
  labels: string[];
  issueType: string | null;
  parentIssueNumber: number | null;
  parent: { repository: string; number: number } | null;
  blockers: { repository: string; number: number; title: string; state: 'OPEN' | 'CLOSED' }[];
  projectStatus: string | null;
  fields: Record<string, string | number | string[] | null>;
  url: string;
  updatedAt: string;
}

export function capacityNextPage(
  response: { data: unknown; headers?: { link?: string } },
  page: number,
  perPage: number,
): number | null {
  if (!Array.isArray(response.data) || response.data.length > perPage)
    throw new DeliveryError('WIP capacity pagination returned invalid native data.');
  const link = response.headers?.link;
  if (link === undefined || link === '') return response.data.length === perPage ? page + 1 : null;
  const parts = [...link.matchAll(/<([^>]+)>;\s*rel="([^"]+)"/gu)];
  const next = parts.filter((part) => part[2] === 'next');
  const residue = link.replace(/<([^>]+)>;\s*rel="([^"]+)"/gu, '').replace(/[,\s]/gu, '');
  if (
    !parts.length ||
    residue ||
    next.length > 1 ||
    parts.some((part) => !['first', 'prev', 'next', 'last'].includes(part[2]!))
  )
    throw new DeliveryError('WIP capacity native pagination is malformed.');
  if (!next.length) return null;
  const url = new URL(next[0]![1]!);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'api.github.com' ||
    url.searchParams.get('page') !== String(page + 1) ||
    url.searchParams.get('per_page') !== String(perPage)
  )
    throw new DeliveryError('WIP capacity native pagination did not advance consistently.');
  return page + 1;
}

function nativeReadNextPage(
  response: { data: unknown; headers?: { link?: string } },
  page: number,
  path: string,
): number | null {
  if (!Array.isArray(response.data) || response.data.length > 100)
    throw new DeliveryError('Parent progress native pagination returned invalid page data.');
  const link = response.headers?.link;
  if (link === undefined || link === '') return response.data.length === 100 ? page + 1 : null;
  if (typeof link !== 'string') throw new DeliveryError('Parent progress native pagination is malformed.');
  const parts = [...link.matchAll(/<([^>]+)>;\s*rel="([^"]+)"/gu)];
  const residue = link.replace(/<([^>]+)>;\s*rel="([^"]+)"/gu, '').replace(/[,\s]/gu, '');
  const next = parts.filter((part) => part[2] === 'next');
  if (
    !parts.length ||
    residue ||
    new Set(parts.map((part) => part[2])).size !== parts.length ||
    parts.some((part) => !['first', 'prev', 'next', 'last'].includes(part[2]!))
  )
    throw new DeliveryError('Parent progress native pagination is malformed.');
  for (const part of parts) {
    let url: URL;
    try {
      url = new URL(part[1]!);
    } catch {
      throw new DeliveryError('Parent progress native pagination URL is malformed.');
    }
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'api.github.com' ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname.toLowerCase() !== path.toLowerCase() ||
      url.searchParams.getAll('page').length !== 1 ||
      url.searchParams.getAll('per_page').length !== 1 ||
      [...url.searchParams.keys()].some((key) => !['page', 'per_page'].includes(key)) ||
      !/^[1-9]\d*$/u.test(url.searchParams.get('page') ?? '') ||
      url.searchParams.get('per_page') !== '100'
    )
      throw new DeliveryError('Parent progress native pagination changed repository, endpoint or page scope.');
    const declaredPage = Number(url.searchParams.get('page'));
    const afterLast = response.data.length === 0 && declaredPage === page - 1 && !next.length;
    if (
      !Number.isSafeInteger(declaredPage) ||
      (part[2] === 'next' && declaredPage !== page + 1) ||
      (part[2] === 'prev' && declaredPage !== page - 1) ||
      (part[2] === 'first' && declaredPage !== 1) ||
      (part[2] === 'last' && !afterLast && (declaredPage < page || declaredPage > page !== next.length > 0))
    )
      throw new DeliveryError('Parent progress native pagination did not advance consistently.');
  }
  if (next.length && response.data.length === 0)
    throw new DeliveryError('Parent progress native pagination claims continuation after an empty page.');
  return next.length ? page + 1 : null;
}

async function issueFieldPages(
  context: DeliveryContext,
  route: string,
  parameters: Record<string, unknown>,
  maxPages?: number,
  strictRead = false,
): Promise<unknown[]> {
  const values: unknown[] = [];
  const seenPages = new Set<string>();
  for (let page = 1; ; page += 1) {
    if (maxPages !== undefined && page > maxPages) {
      if (context.readPageLimit !== undefined)
        throw new CollectionLimitError({
          collection: route.includes('/orgs/') ? 'native-field-catalog' : 'native-field-values',
          pagesRequested: page - 1,
          rowsObserved: values.length,
          limit: maxPages,
        });
      throw new DeliveryError('WIP capacity native field pagination is incomplete.');
    }
    const response = await context.clients.rest.request(route, {
      ...parameters,
      headers: { 'X-GitHub-Api-Version': NATIVE_ISSUE_API_VERSION },
      page,
      per_page: 100,
    });
    if (!Array.isArray(response.data)) throw new DeliveryError('GitHub returned invalid native issue fields.');
    const fingerprint = digestValue(response.data);
    if (response.data.length > 0 && seenPages.has(fingerprint))
      throw new DeliveryError('Native issue fields repeated a pagination page.');
    seenPages.add(fingerprint);
    values.push(...(response.data as unknown[]));
    const next = strictRead
      ? nativeReadNextPage(
          response,
          page,
          route.slice(4).replace(/\{([^}]+)\}/gu, (_match, key: string) => encodeURIComponent(String(parameters[key]))),
        )
      : maxPages === undefined
        ? response.data.length < 100
          ? null
          : page + 1
        : capacityNextPage(response, page, 100);
    if (next === null) return values;
  }
}

async function readIssueFieldCatalog(context: DeliveryContext, capacityRead = false, strictRead = false) {
  const catalog = z
    .array(FieldCatalogEntry)
    .parse(
      await issueFieldPages(
        context,
        'GET /orgs/{org}/issue-fields',
        { org: context.config.native.organization },
        capacityRead ? Math.min(context.readPageLimit ?? 20, 20) : context.readPageLimit,
        strictRead,
      ),
    );
  if (
    new Set(catalog.map((field) => field.name)).size !== catalog.length ||
    new Set(catalog.map((field) => field.id)).size !== catalog.length
  )
    throw new DeliveryError('Native issue field catalog has duplicate identities or names.');
  return catalog;
}

async function readIssueFields(
  context: DeliveryContext,
  issueNumber: number,
  catalog: Awaited<ReturnType<typeof readIssueFieldCatalog>>,
  capacityRead = false,
  strictRead = false,
) {
  const fields: ListedTrackingIssue['fields'] = Object.fromEntries(catalog.map((field) => [field.name, null]));
  const values = z.array(FieldValueEntry).parse(
    await issueFieldPages(
      context,
      'GET /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values',
      {
        ...context.repo,
        issue_number: issueNumber,
      },
      capacityRead ? Math.min(context.readPageLimit ?? 20, 20) : context.readPageLimit,
      strictRead,
    ),
  );
  const observed = new Set<number>();
  for (const field of values) {
    const definition = catalog.find((candidate) => candidate.id === field.issue_field_id);
    if (
      !definition ||
      definition.name !== field.issue_field_name ||
      definition.data_type !== field.data_type ||
      observed.has(field.issue_field_id)
    )
      throw new DeliveryError('Native issue field readback conflicts with its catalog.');
    observed.add(field.issue_field_id);
    if (
      capacityRead &&
      (field.data_type === 'single_select'
        ? field.single_select_option === undefined && field.value !== null
        : field.data_type === 'multi_select'
          ? field.multi_select_options === undefined && field.value !== null
          : field.value === undefined)
    )
      throw new DeliveryError('WIP capacity native field value payload is missing.');
    // Existing issue-info metadata accepts configured option names as raw values.
    // Preserve that exact compatibility without treating numeric option IDs as names.
    const configuredOptionName =
      !capacityRead &&
      field.data_type === 'single_select' &&
      typeof field.value === 'string' &&
      ((field.issue_field_name === context.config.native.points.name &&
        String(field.issue_field_id) === context.config.native.points.databaseId &&
        context.config.native.points.values.includes(field.value)) ||
        (field.issue_field_name === context.config.native.priority.name &&
          String(field.issue_field_id) === context.config.native.priority.databaseId &&
          context.config.native.priority.values.includes(field.value)))
        ? field.value
        : undefined;
    if (
      strictRead &&
      (field.data_type === 'single_select'
        ? field.single_select_option == null && configuredOptionName === undefined && field.value !== null
        : field.data_type === 'multi_select'
          ? field.multi_select_options === undefined && field.value !== null
          : field.value === undefined)
    )
      throw new DeliveryError('Parent progress native field value payload is missing or malformed.');
    if (
      ((field.data_type === 'single_select' && !field.single_select_option && configuredOptionName === undefined) ||
        (field.data_type === 'multi_select' && field.multi_select_options === undefined)) &&
      field.value !== null &&
      field.value !== undefined
    )
      throw new DeliveryError('Native select field omitted its named option readback.');
    const value =
      field.data_type === 'single_select'
        ? (field.single_select_option?.name ?? configuredOptionName ?? null)
        : field.data_type === 'multi_select'
          ? field.multi_select_options?.map((option) => option.name)
          : field.value;
    if (field.data_type === 'date' && value !== null && value !== undefined && !z.iso.date().safeParse(value).success)
      throw new DeliveryError('Native date field has an invalid date value.');
    if (value === null || value === undefined) fields[definition.name] = null;
    else if (
      field.data_type === 'number'
        ? typeof value === 'number' && Number.isFinite(value)
        : field.data_type === 'multi_select'
          ? Array.isArray(value)
          : typeof value === 'string'
    )
      fields[definition.name] = value as string | number | string[];
    else throw new DeliveryError('Native issue field has an invalid value type.');
  }
  return { fields, values, catalog };
}

/** The same native-field composition used by issue-info, without unrelated Project/relationship reads. */
export async function readIssueNativeFields(context: DeliveryContext, issueNumber: number, strictRead = false) {
  return readIssueFields(
    context,
    issueNumber,
    await readIssueFieldCatalog(context, false, strictRead),
    false,
    strictRead,
  );
}

async function prepareIssueDates(context: DeliveryContext, patch: NativeIssueDatePatch) {
  if (patch.startDate === undefined && patch.targetDate === undefined) return [];
  return prepareNativeIssueDates(patch, await readIssueFieldCatalog(context));
}

/** A bounded GitHub page; local filters can produce an empty page with a nextPage. */
export async function listIssues(
  context: DeliveryContext,
  input: ListIssuesInput,
  options: { capacityRead?: boolean } = {},
): Promise<{ issues: ListedTrackingIssue[]; page: number; perPage: number; nextPage: number | null }> {
  const page = input.page ?? 1;
  const perPage = input.perPage ?? 30;
  if (!Number.isSafeInteger(page) || page <= 0 || !Number.isSafeInteger(perPage) || perPage <= 0 || perPage > 100)
    throw new DeliveryError('Issue pagination must use a positive page and perPage from 1 to 100.');
  if (input.query !== undefined && (!input.query.trim() || input.query.length > 256 || /["\\\r\n]/u.test(input.query)))
    throw new DeliveryError('Issue search requires literal text without quotes, backslashes or newlines.');
  if (input.labels?.some((label) => !label || /["\\\r\n]/u.test(label)))
    throw new DeliveryError('Issue filter labels must be nonempty literal names.');
  if (input.updatedSince !== undefined && !z.iso.datetime({ offset: true }).safeParse(input.updatedSince).success)
    throw new DeliveryError('updatedSince must be an ISO timestamp.');
  let raw: unknown[];
  let nextPage: number | null;
  if (input.query !== undefined) {
    const q = [
      `repo:${context.repo.owner}/${context.repo.repo}`,
      'is:issue',
      JSON.stringify(input.query.trim()),
      ...(input.state === undefined || input.state === 'all' ? [] : [`is:${input.state}`]),
      ...(input.labels ?? []).map((label) => `label:${JSON.stringify(label)}`),
      ...(input.updatedSince === undefined ? [] : [`updated:>=${input.updatedSince}`]),
    ].join(' ');
    const response = (
      await context.clients.rest.search.issuesAndPullRequests({
        q,
        page,
        per_page: perPage,
        sort: 'updated',
        order: 'desc',
        headers: { 'X-GitHub-Api-Version': NATIVE_ISSUE_API_VERSION },
      })
    ).data;
    if (response.incomplete_results)
      throw new DeliveryError('GitHub issue search returned incomplete results; narrow the query.');
    if (response.total_count > 1000)
      throw new DeliveryError('GitHub issue search exceeds its 1000-result window; narrow the query.');
    raw = response.items;
    nextPage = page * perPage < response.total_count ? page + 1 : null;
  } else {
    const response = await context.clients.rest.issues.listForRepo({
      ...context.repo,
      state: input.state ?? 'open',
      ...(input.labels === undefined ? {} : { labels: input.labels.join(',') }),
      ...(input.updatedSince === undefined ? {} : { since: input.updatedSince }),
      page,
      per_page: perPage,
      sort: 'updated',
      direction: 'desc',
      headers: { 'X-GitHub-Api-Version': NATIVE_ISSUE_API_VERSION },
    });
    raw = response.data;
    nextPage = options.capacityRead
      ? capacityNextPage(response, page, perPage)
      : raw.length === perPage
        ? page + 1
        : null;
  }
  const catalog = await readIssueFieldCatalog(context, options.capacityRead);
  const issues: ListedTrackingIssue[] = [];
  const seen = new Set<number>();
  for (const entry of raw) {
    if (typeof entry === 'object' && entry !== null && 'pull_request' in entry) continue;
    const current = ListedIssue.parse(entry);
    if (seen.has(current.number)) throw new DeliveryError('GitHub issue page repeats an issue.');
    seen.add(current.number);
    if (
      new URL(current.html_url).pathname.toLowerCase() !==
      `/${context.repo.owner}/${context.repo.repo}/issues/${String(current.number)}`.toLowerCase()
    )
      throw new DeliveryError('GitHub issue list returned a foreign repository issue.');
    const selectedLabels = current.labels.map((label) => (typeof label === 'string' ? label : label.name));
    if (options.capacityRead) {
      const url = new URL(current.html_url);
      if (url.protocol !== 'https:' || url.hostname !== 'github.com')
        throw new DeliveryError('WIP capacity issue URL is not the selected GitHub repository.');
      const native = (await context.clients.rest.issues.get({ ...context.repo, issue_number: current.number })).data;
      if (
        'pull_request' in native ||
        native.number !== current.number ||
        native.node_id !== current.node_id ||
        native.html_url !== current.html_url ||
        native.state !== current.state
      )
        throw new DeliveryError('WIP capacity issue identity or state changed during native readback.');
    }
    if (input.state !== undefined && input.state !== 'all' && current.state !== input.state) continue;
    if (
      (input.labels ?? []).some(
        (label) => !selectedLabels.some((selected) => selected.toLowerCase() === label.toLowerCase()),
      )
    )
      continue;
    if (input.issueType !== undefined && current.type?.name !== input.issueType) continue;
    if (input.updatedSince !== undefined && Date.parse(current.updated_at) < Date.parse(input.updatedSince)) continue;
    const relationships = await getNativeBlockerRelationships({
      graphql: context.clients.graphql,
      issueNumber: current.number,
      repo: context.repo,
      requireRepositoryIdentity: true,
      ...(context.readPageLimit === undefined ? {} : { maxPages: context.readPageLimit, issueNodeId: current.node_id }),
    });
    const localParent =
      relationships.parentRepository?.toLowerCase() === `${context.repo.owner}/${context.repo.repo}`.toLowerCase()
        ? relationships.parentNumber
        : null;
    if (
      input.parentIssueNumber !== undefined &&
      (input.parentIssueNumber === null ? relationships.parentNumber !== null : localParent !== input.parentIssueNumber)
    )
      continue;
    const project = await getIssueProjectStatus({
      graphql: context.clients.graphql,
      issueNodeId: current.node_id,
      ...(options.capacityRead ? { capacityRead: true, maxPages: 20 } : {}),
      ...(context.readPageLimit === undefined
        ? {}
        : { maxPages: Math.min(context.readPageLimit, options.capacityRead ? 20 : context.readPageLimit) }),
      org: context.config.native.organization,
      ...(context.projectConfiguration ? { configuration: context.projectConfiguration } : {}),
      settings: projectSettingsFromDeliveryConfig(context.config),
    });
    if (input.projectStatus !== undefined && (project?.status ?? null) !== input.projectStatus) continue;
    const { fields } = await readIssueFields(context, current.number, catalog, options.capacityRead);
    issues.push({
      ...(options.capacityRead
        ? { nodeId: current.node_id, fieldIds: Object.fromEntries(catalog.map((field) => [field.name, field.id])) }
        : {}),
      ...deferralReadback(current.body, current.title),
      number: current.number,
      title: current.title,
      state: current.state,
      labels: selectedLabels,
      issueType: current.type?.name ?? null,
      parentIssueNumber: localParent,
      parent:
        relationships.parentNumber === null
          ? null
          : { repository: relationships.parentRepository!, number: relationships.parentNumber },
      blockers: relationships.blockers.map(({ number, title, state, repository }) => ({
        repository: repository!,
        number,
        title,
        state,
      })),
      projectStatus: project?.status ?? null,
      fields,
      url: current.html_url,
      updatedAt: current.updated_at,
    });
  }
  return { issues, page, perPage, nextPage };
}

/** @internal Render previous content as inert text without trimming or interpreting its Markdown. */
export function renderIssueHistory(title: string, body: string): string {
  const escape = (value: string): string =>
    value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<details>\n<summary>Previous issue title and body</summary>\n\nTitle:\n<pre>${escape(title)}</pre>\n\nBody:\n<pre>${escape(body)}</pre>\n\n</details>`;
}

export type IssueCloseReason = 'completed' | 'not_planned' | 'duplicate';
export interface IssueClosureReadback {
  state: 'open' | 'closed';
  closeReason: IssueCloseReason | null;
  duplicateOf: { number: number; repository: string } | null;
}

/** @internal Native closure evidence is independent of an input or a posted comment. */
export async function readIssueClosure(context: DeliveryContext, issueNumber: number): Promise<IssueClosureReadback> {
  const Repository = z.object({ nameWithOwner: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u) });
  const response: unknown = await context.clients.graphql(
    `
    query IssueClosureReadback($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        issue(number: $number) {
          number repository { nameWithOwner } state stateReason
          duplicateOf { number repository { nameWithOwner } }
        }
      }
    }
  `,
    { owner: context.repo.owner, name: context.repo.repo, number: issueNumber },
  );
  const parsed = z
    .object({
      repository: z.object({
        issue: z.object({
          number: z.number().int().positive().safe(),
          repository: Repository,
          state: z.enum(['OPEN', 'CLOSED']),
          stateReason: z.enum(['COMPLETED', 'NOT_PLANNED', 'DUPLICATE', 'REOPENED']).nullable(),
          duplicateOf: z.object({ number: z.number().int().positive().safe(), repository: Repository }).nullable(),
        }),
      }),
    })
    .parse(response).repository.issue;
  if (
    parsed.number !== issueNumber ||
    parsed.repository.nameWithOwner.toLowerCase() !== `${context.repo.owner}/${context.repo.repo}`.toLowerCase()
  )
    throw new DeliveryError('Native closure readback returned a foreign issue identity.');
  if (
    (parsed.state === 'OPEN' && parsed.stateReason !== null && parsed.stateReason !== 'REOPENED') ||
    (parsed.state === 'CLOSED' && parsed.stateReason === 'REOPENED') ||
    (parsed.duplicateOf !== null && parsed.stateReason !== 'DUPLICATE')
  )
    throw new DeliveryError('Native closure readback has contradictory state evidence.');
  return {
    state: parsed.state === 'OPEN' ? 'open' : 'closed',
    closeReason:
      parsed.stateReason === null || parsed.stateReason === 'REOPENED'
        ? null
        : (parsed.stateReason.toLowerCase() as IssueCloseReason),
    duplicateOf:
      parsed.duplicateOf === null
        ? null
        : { number: parsed.duplicateOf.number, repository: parsed.duplicateOf.repository.nameWithOwner },
  };
}

export interface UpdateIssueInput extends Omit<Partial<IssueFieldsInput>, 'deferral'>, NativeIssueDatePatch {
  defer?: IssueDeferralData;
  undefer?: true;
  status?: { nextMilestone?: string; blockers?: string; latestJournal?: string };
  blockedBy?: number[];
  /** Add this issue as a blocker of these dependents without replacing their other blockers. */
  blocks?: number[];
  overrideReason?: string;
  body?: string;
  issueNumber: number;
  issueType?: string | undefined;
  labels?: string[];
  milestone?: number | null;
  parentIssueNumber?: number | null;
  park?: true;
  points?: number | undefined;
  priority?: string;
  state?: 'open' | 'closed';
  preserveHistory?: boolean;
  closeReason?: 'completed' | 'not_planned' | 'duplicate';
  supersededBy?: number;
  title?: string;
}

export interface UpdateIssueResult extends IssueInfo {
  warnings: IssueDiagnostic[];
  conversion?: { priorBody: string; canonicalBody: string; diff: string };
  historyComment?: IssueCommentReadback;
  closure?: IssueClosureReadback & { supersededBy: number | null; comment: IssueCommentReadback };
}

interface IncompleteIssueUpdateResult {
  status: 'update-incomplete';
  rateLimit?: RateLimitDiagnostics;
  native: {
    status: 'confirmed' | 'unknown';
    repository: string;
    issueNumber: number;
    readback: IssueInfo | null;
    readbackError?: string;
    closure?: UpdateIssueResult['closure'];
    historyComment?: IssueCommentReadback;
  };
  project: { status: 'pending' | 'unknown'; desiredStatus: string | null; reason: 'archived' | 'unavailable' };
  recovery: { tool: 'issue_batch_update'; instruction: string };
}

const incompleteUpdates = new WeakMap<object, IncompleteIssueUpdateResult>();

/** Native writes may have committed; this is never an ordinary success or a safe full retry. */
export class IssueUpdateIncompleteError extends DeliveryError {
  constructor(readonly result: IncompleteIssueUpdateResult) {
    super('Issue update is incomplete; reconcile native state and only remaining Project work.');
    incompleteUpdates.set(this, result);
  }
}

/** Identity-bound results do not inspect hostile error proxies or accessors. */
export function getIncompleteIssueUpdate(error: unknown): IncompleteIssueUpdateResult | undefined {
  return typeof error === 'object' && error !== null ? incompleteUpdates.get(error) : undefined;
}

function updateProjectStatus(info: IssueInfo, input: UpdateIssueInput) {
  return info.state === 'closed' || info.projectStatus === 'Done'
    ? 'Done'
    : info.blockedBy.length > 0
      ? 'Blocked'
      : input.park === true || input.blockedBy !== undefined || info.projectStatus === null
        ? 'Todo'
        : info.projectStatus === 'In Progress' || (info.projectStatus === 'Blocked' && input.state === undefined)
          ? info.projectStatus
          : 'Todo';
}

async function prepareIssueUpdate(context: DeliveryContext, input: UpdateIssueInput) {
  requireDeferralPatch({
    ...(input.defer === undefined ? {} : { defer: input.defer }),
    ...(input.undefer === undefined ? {} : { undefer: input.undefer }),
  });
  if ('deferral' in input) throw new DeliveryError('Use defer or undefer to change deferral state.');
  if (context.clients.role !== 'author') throw new DeliveryError('Issue writes require the configured author role.');
  if (
    (input.closeReason !== undefined && !['completed', 'not_planned', 'duplicate'].includes(input.closeReason)) ||
    ((input.closeReason !== undefined || input.supersededBy !== undefined) && input.state !== 'closed')
  )
    throw new DeliveryError('Closure details require state closed and a supported close reason.');
  if (
    input.supersededBy !== undefined &&
    (!Number.isSafeInteger(input.supersededBy) || input.supersededBy <= 0 || input.supersededBy === input.issueNumber)
  )
    throw new DeliveryError('A superseding issue must be a different positive issue number.');
  const { clients, config, repo } = context;
  const preserveArchived = Object.keys(input).every((key) =>
    ['issueNumber', 'title', 'state', 'closeReason', 'supersededBy', 'preserveHistory'].includes(key),
  );
  const dateChanges = await prepareIssueDates(context, input);
  const currentContent = await issueInfo(context, input.issueNumber);
  const archivedItemId = preserveArchived
    ? await assertIssueProjectWritable({
        preserveArchived: true,
        graphql: clients.graphql,
        issueNodeId: (await clients.rest.issues.get({ ...repo, issue_number: input.issueNumber })).data.node_id,
        org: config.native.organization,
        ...(context.projectConfiguration ? { configuration: context.projectConfiguration } : {}),
        settings: projectSettingsFromDeliveryConfig(config),
      })
    : null;
  const legacyNativeEdit =
    archivedItemId !== null && !currentContent.body.trimStart().startsWith('<!-- ai-delivery:issue@1 -->');
  const prepared: ReturnType<typeof prepareIssueWrite> = legacyNativeEdit
    ? {
        issue: IssueFields.parse({ title: input.title ?? currentContent.title, draft: true }),
        body: currentContent.body,
        statusOnly: true,
        preserveHistory: input.preserveHistory ?? false,
        warnings: [],
      }
    : prepareIssueWrite(input, currentContent);
  input = {
    ...input,
    body: prepared.body,
    ...(prepared.statusOnly
      ? {}
      : {
          title: prepared.issue.title,
          ...(prepared.issue.issueType === undefined ? {} : { issueType: prepared.issue.issueType }),
          ...(prepared.issue.points === undefined ? {} : { points: prepared.issue.points }),
          ...(prepared.issue.draft ? { park: true as const } : {}),
        }),
    preserveHistory: prepared.preserveHistory,
  };
  const acceptedLabels = input.labels === undefined ? undefined : await labels(context, input.labels);
  if (input.issueType !== undefined && !config.native.issueTypes.includes(input.issueType)) {
    throw new DeliveryError('Unsupported configured Issue Type.');
  }
  if (input.points !== undefined && !config.native.points.values.includes(String(input.points))) {
    throw new DeliveryError('Unsupported configured Points value.');
  }
  if (input.priority !== undefined && !config.native.priority.values.includes(input.priority)) {
    throw new DeliveryError('Unsupported configured Priority value.');
  }
  if (input.parentIssueNumber !== undefined || input.blockedBy !== undefined) {
    const current = await getNativeBlockerRelationships({
      graphql: clients.graphql,
      issueNumber: input.issueNumber,
      repo,
    });
    // Tracking edges validate native endpoints without adopting their source worktrees.
    await resolveNativeRelationshipTargets({
      blockers: current.blockers.map((blocker) => blocker.number),
      ...(current.parentNumber === null ? {} : { parentIssueNumber: current.parentNumber }),
      repo,
      rest: clients.rest,
    });
    await resolveNativeRelationshipTargets({
      blockers: input.blockedBy ?? [],
      ...(input.parentIssueNumber === undefined || input.parentIssueNumber === null
        ? {}
        : { parentIssueNumber: input.parentIssueNumber }),
      repo,
      rest: clients.rest,
    });
  }
  const beforeAdd =
    input.blockedBy !== undefined || input.blocks !== undefined
      ? await prepareBlockerGuard(
          context,
          [
            ...(input.blockedBy === undefined ? [] : [{ dependent: input.issueNumber, blockers: input.blockedBy }]),
            ...(input.blocks ?? []).map((dependent) => ({ dependent, blockers: [input.issueNumber] })),
          ],
          input.overrideReason,
        )
      : undefined;
  const closeReason = input.closeReason ?? (input.supersededBy === undefined ? undefined : 'completed');
  let supersedingIssueId: number | undefined;
  if (input.supersededBy !== undefined) {
    const target = (await clients.rest.issues.get({ ...repo, issue_number: input.supersededBy })).data;
    if (
      target.number !== input.supersededBy ||
      'pull_request' in target ||
      !Number.isSafeInteger(target.id) ||
      target.id <= 0 ||
      new URL(target.html_url).pathname.toLowerCase() !==
        `/${repo.owner}/${repo.repo}/issues/${String(input.supersededBy)}`.toLowerCase()
    )
      throw new DeliveryError('Superseding issue readback is not the requested repository issue.');
    supersedingIssueId = target.id;
  }
  const assertClosure = (closure: IssueClosureReadback): void => {
    if (
      closure.state !== 'closed' ||
      closure.closeReason !== closeReason ||
      (closeReason === 'duplicate' &&
        input.supersededBy !== undefined &&
        (closure.duplicateOf?.number !== input.supersededBy ||
          closure.duplicateOf.repository.toLowerCase() !== `${repo.owner}/${repo.repo}`.toLowerCase()))
    )
      throw new DeliveryError('Native closure readback disagrees with the requested reason or superseding issue.');
  };
  if (closeReason !== undefined) {
    const current = await readIssueClosure(context, input.issueNumber);
    if (current.state === 'closed') {
      try {
        assertClosure(current);
      } catch {
        throw new DeliveryError('Issue is already closed with different closure evidence; reopen it explicitly first.');
      }
    }
  }
  let historyBody: string | undefined;
  let priorContent: { title: string; body: string } | undefined =
    input.status === undefined ? undefined : { title: currentContent.title, body: currentContent.body };
  if (input.preserveHistory === true && (input.title !== undefined || input.body !== undefined)) {
    const current = (await clients.rest.issues.get({ ...repo, issue_number: input.issueNumber })).data;
    if (current.number !== input.issueNumber || 'pull_request' in current)
      throw new DeliveryError('History target is not the requested issue.');
    const prior = { title: current.title, body: current.body ?? '' };
    if (prior.title !== currentContent.title || prior.body !== currentContent.body)
      throw new DeliveryError('Issue content changed after preparation; retry against the current title and body.');
    if (
      (input.title !== undefined && input.title !== prior.title) ||
      (input.body !== undefined && input.body !== prior.body)
    ) {
      const body = renderIssueHistory(prior.title, prior.body);
      const publicHistory = validateIssue({ title: prior.title, legacyBody: prior.body, draft: true }, false);
      if (publicHistory.failures.length) throw new IssueValidationError(publicHistory.failures);
      if (body.length > ISSUE_COMMENT_BODY_LIMIT)
        throw new DeliveryError(
          'Complete issue history exceeds the supported comment body limit; issue was not rewritten.',
        );
      priorContent = prior;
      historyBody = body;
    }
  }
  const closureBody =
    closeReason === undefined
      ? undefined
      : `Requested closure reason: ${closeReason}.${input.supersededBy === undefined ? '' : `\nSuperseded by ${repo.owner}/${repo.repo}#${String(input.supersededBy)}.`}`;
  const target = (await clients.rest.issues.get({ ...repo, issue_number: input.issueNumber })).data;
  if (
    target.number !== input.issueNumber ||
    'pull_request' in target ||
    !target.node_id ||
    target.html_url !== currentContent.url ||
    new URL(target.html_url).pathname.toLowerCase() !==
      `/${repo.owner}/${repo.repo}/issues/${String(input.issueNumber)}`.toLowerCase()
  )
    throw new DeliveryError('History target is not the requested issue.');
  await assertIssueProjectWritable({
    preserveArchived,
    graphql: clients.graphql,
    issueNodeId: target.node_id,
    org: config.native.organization,
    ...(context.projectConfiguration ? { configuration: context.projectConfiguration } : {}),
    settings: projectSettingsFromDeliveryConfig(config),
  });
  return {
    input,
    prepared,
    acceptedLabels,
    beforeAdd,
    closeReason,
    supersedingIssueId,
    assertClosure,
    currentContent,
    preserveArchived,
    nativeTarget: { nodeId: target.node_id, url: target.html_url },
    dateChanges,
    priorContent,
    historyBody,
    closureBody,
  };
}

type PreparedIssueUpdate = Awaited<ReturnType<typeof prepareIssueUpdate>>;

export async function updateIssue(context: DeliveryContext, input: UpdateIssueInput): Promise<UpdateIssueResult> {
  return applyIssueUpdate(context, await prepareIssueUpdate(context, input));
}

async function applyIssueUpdate(
  context: DeliveryContext,
  plan: PreparedIssueUpdate,
  changes?: Record<string, unknown>,
): Promise<UpdateIssueResult> {
  const { clients, config, repo } = context;
  const {
    input,
    prepared,
    acceptedLabels,
    beforeAdd,
    closeReason,
    supersedingIssueId,
    assertClosure,
    priorContent,
    historyBody,
    closureBody,
  } = plan;
  const pending = (key: string) => changes === undefined || key in changes;
  const historyComment =
    historyBody === undefined
      ? undefined
      : await commentIssue(context, { issueNumber: input.issueNumber, body: historyBody });
  let closureComment: IssueCommentReadback | undefined;
  if (closureBody !== undefined)
    closureComment = await commentIssue(context, {
      issueNumber: input.issueNumber,
      body: closureBody,
    });
  if (priorContent !== undefined) {
    const current = (await clients.rest.issues.get({ ...repo, issue_number: input.issueNumber })).data;
    if (
      current.number !== input.issueNumber ||
      'pull_request' in current ||
      current.title !== priorContent.title ||
      (current.body ?? '') !== priorContent.body
    )
      throw new DeliveryError('Issue content changed after preparation; retry against the current title and body.');
  }
  if (['body', 'issueType', 'labels', 'milestone', 'state', 'closeReason', 'supersededBy', 'title'].some(pending))
    await clients.rest.issues.update({
      issue_number: input.issueNumber,
      owner: repo.owner,
      repo: repo.repo,
      ...(input.body === undefined || !pending('body') ? {} : { body: input.body }),
      ...(input.issueType === undefined || !pending('issueType') ? {} : { type: input.issueType }),
      ...(acceptedLabels === undefined || !pending('labels') ? {} : { labels: acceptedLabels }),
      ...(input.milestone === undefined || !pending('milestone') ? {} : { milestone: input.milestone }),
      ...(input.state === undefined || !pending('state') ? {} : { state: input.state }),
      ...(closeReason === undefined || (!pending('closeReason') && !pending('state'))
        ? {}
        : { state_reason: closeReason, headers: { 'X-GitHub-Api-Version': NATIVE_ISSUE_API_VERSION } }),
      ...(closeReason !== 'duplicate' ||
      supersedingIssueId === undefined ||
      (!pending('supersededBy') && !pending('state'))
        ? {}
        : { duplicate_issue_id: supersedingIssueId }),
      ...(input.title === undefined || !pending('title') ? {} : { title: input.title }),
    });
  const closure = closeReason === undefined ? undefined : await readIssueClosure(context, input.issueNumber);
  if (closure !== undefined) assertClosure(closure);
  if ((input.points !== undefined && pending('points')) || (input.priority !== undefined && pending('priority')))
    await setConfiguredNativeIssueMetadata({
      issueNumber: input.issueNumber,
      metadata: {
        ...(input.points === undefined || !pending('points') ? {} : { points: input.points }),
        ...(input.priority === undefined || !pending('priority') ? {} : { priority: input.priority }),
      },
      org: config.native.organization,
      owner: repo.owner,
      repo: repo.repo,
      rest: clients.rest,
      settings: nativeIssueSettingsFromDeliveryConfig(config),
    });
  await applyNativeIssueDates({
    changes: plan.dateChanges.filter((change) => pending(change.name === 'Start date' ? 'startDate' : 'targetDate')),
    issueNumber: input.issueNumber,
    ...repo,
    rest: clients.rest,
  });
  if (input.parentIssueNumber !== undefined && pending('parentIssueNumber'))
    await replaceParentIssue({
      graphql: clients.graphql,
      issueNumber: input.issueNumber,
      parentIssueNumber: input.parentIssueNumber,
      repo,
      rest: clients.rest,
    });
  if (input.parentIssueNumber !== undefined && input.parentIssueNumber !== null && pending('parentPoints'))
    await clearConfiguredNativeIssuePoints({
      issueNumber: input.parentIssueNumber,
      org: config.native.organization,
      owner: repo.owner,
      repo: repo.repo,
      rest: clients.rest,
      settings: nativeIssueSettingsFromDeliveryConfig(config),
    });
  try {
    if (input.blockedBy !== undefined && pending('blockedBy'))
      await replaceBlockedBy({
        ...(beforeAdd === undefined ? {} : { beforeAdd }),
        blockers: input.blockedBy,
        graphql: clients.graphql,
        issueNumber: input.issueNumber,
        repo,
        rest: clients.rest,
      });
    for (const dependent of new Set(pending('blocks') ? (input.blocks ?? []) : []))
      await linkBlockedBy({
        ...(beforeAdd === undefined ? {} : { beforeAdd }),
        blockers: [input.issueNumber],
        graphql: clients.graphql,
        issueNumber: dependent,
        repo,
        rest: clients.rest,
      });
  } catch (error) {
    throw new DeliveryError(
      `Issue #${input.issueNumber} content or metadata may have changed, but dependency tracking did not complete: ${error instanceof Error ? error.message : String(error)}. Inspect native state and resume this existing issue.`,
    );
  }
  let status: ReturnType<typeof updateProjectStatus> = updateProjectStatus(
    { ...plan.currentContent, state: input.state ?? plan.currentContent.state },
    input,
  );
  let readback: IssueInfo;
  let latestProjectStatus = plan.currentContent.projectStatus;
  const priorRateObservation = clients.rateLimitObservation?.();
  try {
    const info = await issueInfo(context, input.issueNumber);
    latestProjectStatus = info.projectStatus;
    status = updateProjectStatus(info, input);
    const target = (await clients.rest.issues.get({ issue_number: input.issueNumber, ...repo })).data;
    if (
      target.node_id !== plan.nativeTarget.nodeId ||
      target.html_url !== plan.nativeTarget.url ||
      target.number !== input.issueNumber ||
      'pull_request' in target
    )
      throw new DeliveryError('Native closure readback returned a foreign issue identity.');
    const archivedItemId = plan.preserveArchived
      ? await assertIssueProjectWritable({
          preserveArchived: true,
          graphql: clients.graphql,
          issueNodeId: target.node_id,
          org: config.native.organization,
          ...(context.projectConfiguration ? { configuration: context.projectConfiguration } : {}),
          settings: projectSettingsFromDeliveryConfig(config),
        })
      : null;
    if (archivedItemId !== null) {
      readback = info;
      prepared.warnings.push({
        code: 'project.archived',
        field: 'project',
        message: `Archived Project item ${archivedItemId} was preserved.`,
        fixHint: `Archived Project item ${archivedItemId} was preserved.`,
      });
    } else {
      await syncIssueProjectStatus({
        graphql: clients.graphql,
        issueNodeId: target.node_id,
        org: config.native.organization,
        ...(context.projectConfiguration ? { configuration: context.projectConfiguration } : {}),
        settings: projectSettingsFromDeliveryConfig(config),
        status,
      });
      readback = await issueInfo(context, input.issueNumber);
      if (readback.projectStatus !== status)
        throw new DeliveryError('Project Status readback disagrees with the requested outcome.');
    }
  } catch (error) {
    const observedRate = clients.rateLimitObservation?.();
    const limit = getRateLimitDiagnostics(error) ?? (observedRate !== priorRateObservation ? observedRate : undefined);
    const diagnostic = getMachineRequestDiagnostics(error);
    const cancelled =
      diagnostic?.code === 'ABORT_ERR' ||
      (!types.isProxy(error) && error instanceof DOMException && error.name === 'AbortError');
    const result: IncompleteIssueUpdateResult = {
      status: 'update-incomplete',
      ...(limit === undefined ? {} : { rateLimit: limit }),
      native: {
        status: 'unknown',
        repository: `${repo.owner}/${repo.repo}`,
        issueNumber: input.issueNumber,
        readback: null,
        readbackError:
          limit !== undefined || cancelled
            ? 'Readback deferred after rate-limit exhaustion or cancellation.'
            : 'Native issue evidence is unavailable or inconsistent.',
      },
      project: {
        status:
          localBatchFailureReason(error) === 'The issue delivery Project item is archived and cannot be updated.'
            ? 'pending'
            : 'unknown',
        desiredStatus: input.blockedBy === undefined ? status : null,
        reason:
          localBatchFailureReason(error) === 'The issue delivery Project item is archived and cannot be updated.'
            ? 'archived'
            : 'unavailable',
      },
      recovery: {
        tool: 'issue_batch_update',
        instruction:
          'Reconcile this existing issue with the original desired fields through issue_batch_update. Do not replay the full issue_update. An archived Project item requires separately authorized restoration before projection-only recovery.',
      },
    };
    if (limit === undefined && !cancelled) {
      try {
        const native = await updateProjection(context, plan, true);
        const desired = await desiredUpdateValues(context, plan);
        delete desired.projectStatus;
        if (Object.keys(pendingUpdateValues(desired, native.values)).length)
          throw new DeliveryError('Issue update readback disagrees with the requested content or state.');
        if (historyBody !== undefined && !(await hasUpdateComment(context, input.issueNumber, historyBody)))
          throw new DeliveryError('Issue comment readback disagrees with the authored issue comment.');
        result.project.desiredStatus = updateProjectStatus(
          { ...native.readback, projectStatus: latestProjectStatus },
          input,
        );
        result.native = {
          ...result.native,
          status: 'confirmed',
          readback: native.readback,
          ...(historyComment === undefined ? {} : { historyComment }),
          ...(closure === undefined || closureComment === undefined
            ? {}
            : { closure: { ...closure, supersededBy: input.supersededBy ?? null, comment: closureComment } }),
        };
        delete result.native.readbackError;
      } catch (readbackError) {
        const latest = clients.rateLimitObservation?.();
        const readbackLimit =
          getRateLimitDiagnostics(readbackError) ?? (latest !== priorRateObservation ? latest : undefined);
        if (readbackLimit !== undefined) result.rateLimit = readbackLimit;
        /* Missing or contradictory native evidence must remain unknown. */
      }
    }
    const incomplete = new IssueUpdateIncompleteError(result);
    if (diagnostic !== undefined) setMachineRequestDiagnostics(incomplete, diagnostic);
    throw incomplete;
  }
  if (
    (input.title !== undefined && readback.title !== input.title) ||
    (input.body !== undefined && readback.body !== input.body) ||
    (input.state !== undefined && readback.state !== input.state) ||
    (input.points !== undefined && readback.points !== input.points) ||
    (input.issueType !== undefined && readback.issueType !== input.issueType)
  )
    throw new DeliveryError('Issue update readback disagrees with the requested content or state.');
  return {
    ...readback,
    warnings: prepared.warnings,
    ...(prepared.conversion === undefined ? {} : { conversion: prepared.conversion }),
    ...(historyComment === undefined ? {} : { historyComment }),
    ...(closure === undefined || closureComment === undefined
      ? {}
      : { closure: { ...closure, supersededBy: input.supersededBy ?? null, comment: closureComment } }),
  };
}

export interface BatchUpdateIssueInput {
  items: (UpdateIssueInput & { repo?: string })[];
  dryRun?: boolean;
}
interface UpdateProjection {
  readback: IssueInfo;
  values: Record<string, unknown>;
}
interface BatchUpdateItemResult {
  issueNumber: number;
  status: 'planned' | 'applied' | 'unchanged' | 'failed';
  changes?: Record<string, unknown>;
  readback: IssueInfo | null;
  relatedReadback?: Record<string, unknown>;
  reason?: string;
  readbackError?: string;
  diagnostics?: ReturnType<typeof getMachineRequestDiagnostics>;
  incomplete?: IncompleteIssueUpdateResult;
}

/** Read-only inspection of the same authenticated closure journal used by updateIssue. */
async function hasUpdateComment(context: DeliveryContext, issueNumber: number, body: string): Promise<boolean> {
  if (!context.clients.authenticatedAuthor) throw new DeliveryError('Authenticated update journal author is missing.');
  const actor = (await context.clients.authenticatedAuthor()).actorLogin;
  if (!actor) throw new DeliveryError('Update journal author identity is missing.');
  const matches: { id: number; html_url: string }[] = [];
  let complete = false;
  for (let page = 1; page <= 20; page++) {
    const comments = (
      await context.clients.rest.issues.listComments({
        ...context.repo,
        issue_number: issueNumber,
        per_page: 100,
        page,
      })
    ).data;
    matches.push(
      ...comments.filter(
        (comment) => comment.user?.login?.toLowerCase() === actor.toLowerCase() && comment.body === body,
      ),
    );
    if (comments.length < 100) {
      complete = true;
      break;
    }
  }
  if (!complete) throw new DeliveryError('Update journal readback exceeds the bounded history window.');
  if (matches.length > 1) throw new DeliveryError('Issue comment has duplicate authored retry matches.');
  if (!matches[0]) return false;
  await readAuthoredIssueComment(context, issueNumber, matches[0], body, actor);
  return true;
}

async function updateProjection(
  context: DeliveryContext,
  plan: PreparedIssueUpdate,
  nativeOnly = false,
): Promise<UpdateProjection> {
  const { input } = plan;
  const { info: readback } = await readIssueInfo(
    context,
    input.issueNumber,
    !nativeOnly,
    nativeOnly ? plan.nativeTarget : undefined,
  );
  const values: Record<string, unknown> = { ...readback };
  const relationships = async (issueNumber: number) => {
    const native = await getNativeBlockerRelationships({
      graphql: context.clients.graphql,
      repo: context.repo,
      issueNumber,
      requireRepositoryIdentity: true,
    });
    const repository = `${context.repo.owner}/${context.repo.repo}`.toLowerCase();
    const edges = [
      ...native.blockers,
      ...(native.parentNumber === null
        ? []
        : [{ number: native.parentNumber, id: native.parentId, repository: native.parentRepository }]),
    ];
    if (edges.some((edge) => edge.repository?.toLowerCase() !== repository))
      throw new DeliveryError('Native batch relationship belongs to a different repository.');
    const targets = await resolveNativeRelationshipTargets({
      blockers: edges.map((edge) => edge.number),
      repo: context.repo,
      rest: context.clients.rest,
    });
    if (edges.some((edge) => edge.id !== targets.blockerNodeIds.get(edge.number)))
      throw new DeliveryError('Native batch relationship node identity disagrees with its repository issue.');
    return native;
  };
  if (input.blockedBy !== undefined || input.parentIssueNumber !== undefined) {
    const native = await relationships(input.issueNumber);
    if (native.parentNumber !== readback.parentIssueNumber)
      throw new DeliveryError('Native parent changed during batch readback; reconcile the current state.');
    if (input.blockedBy !== undefined)
      values.blockedBy = native.blockers.map((value) => value.number).sort((a, b) => a - b);
  }
  if (input.parentIssueNumber !== undefined && input.parentIssueNumber !== null) {
    const metadata = await getConfiguredNativeIssueMetadata({
      issueNumber: input.parentIssueNumber,
      ...context.repo,
      rest: context.clients.rest,
      settings: nativeIssueSettingsFromDeliveryConfig(context.config),
    });
    values.parentPoints = { issueNumber: input.parentIssueNumber, points: metadata.points ?? null };
  }
  if (input.blocks !== undefined) {
    values.blocks = await Promise.all(
      [...new Set(input.blocks)].map(async (dependent) => ({
        issueNumber: dependent,
        linked: (await relationships(dependent)).blockers.some((value) => value.number === input.issueNumber),
      })),
    );
  }
  if (plan.closeReason !== undefined) {
    const closure = await readIssueClosure(context, input.issueNumber);
    if (nativeOnly) plan.assertClosure(closure);
    values.closeReason = closure.closeReason;
    if (plan.closeReason === 'duplicate' && input.supersededBy !== undefined)
      values.supersededBy = closure.duplicateOf?.number ?? null;
    values.closureComment = await hasUpdateComment(context, input.issueNumber, plan.closureBody!);
  }
  return { readback, values };
}

async function desiredUpdateValues(
  context: DeliveryContext,
  plan: PreparedIssueUpdate,
): Promise<Record<string, unknown>> {
  const { input } = plan;
  const values: Record<string, unknown> = {};
  for (const key of [
    'title',
    'body',
    'issueType',
    'points',
    'priority',
    'startDate',
    'targetDate',
    'milestone',
    'state',
    'parentIssueNumber',
  ] as const) {
    if (input[key] !== undefined) values[key] = input[key];
  }
  if (plan.acceptedLabels !== undefined) values.labels = [...plan.acceptedLabels].sort();
  let openBlockers = plan.currentContent.blockedBy;
  if (input.blockedBy !== undefined) {
    values.blockedBy = [...new Set(input.blockedBy)].sort((a, b) => a - b);
    const targets = await Promise.all(
      input.blockedBy.map(
        async (number) => (await context.clients.rest.issues.get({ ...context.repo, issue_number: number })).data,
      ),
    );
    openBlockers = targets.filter((target) => target.state === 'open').map((target) => target.number);
  }
  values.projectStatus = updateProjectStatus(
    {
      ...plan.currentContent,
      state: input.state ?? plan.currentContent.state,
      blockedBy: openBlockers,
    },
    input,
  );
  if (input.parentIssueNumber !== undefined && input.parentIssueNumber !== null)
    values.parentPoints = { issueNumber: input.parentIssueNumber, points: null };
  if (input.blocks !== undefined)
    values.blocks = [...new Set(input.blocks)].map((issueNumber) => ({ issueNumber, linked: true }));
  if (plan.closeReason !== undefined) {
    values.closeReason = plan.closeReason;
    if (plan.closeReason === 'duplicate' && input.supersededBy !== undefined) values.supersededBy = input.supersededBy;
    values.closureComment = true;
  }
  return values;
}

function pendingUpdateValues(
  desired: Record<string, unknown>,
  actual: Record<string, unknown>,
): Record<string, unknown> {
  const labels = (value: unknown): unknown =>
    Array.isArray(value) && value.every((label: unknown): label is string => typeof label === 'string')
      ? value.map((label) => label.toLowerCase()).sort()
      : value;
  return Object.fromEntries(
    Object.entries(desired).filter(
      ([key, value]) =>
        JSON.stringify(key === 'labels' ? labels(value) : value) !==
        JSON.stringify(key === 'labels' ? labels(actual[key]) : actual[key]),
    ),
  );
}

function localBatchFailureReason(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || types.isProxy(error)) return undefined;
  const prototype: unknown = Object.getPrototypeOf(error);
  if (prototype === IssueValidationError.prototype) return 'Requested issue fields do not satisfy the issue contract.';
  if (prototype !== DeliveryError.prototype) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'message');
  const message: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  if (typeof message !== 'string') return undefined;
  if (
    [
      'Choose a valid defer condition or explicit undefer, never both.',
      'Use defer or undefer to change deferral state.',
      'Choose native blockedBy or display-only status.blockers in one update, not both.',
      'Convert the legacy contract explicitly before a status-only update.',
      'Issue labels must be non-empty and unique.',
      'Repository label listing exceeds the bounded readback window.',
      'Unsupported configured Issue Type.',
      'Unsupported configured Points value.',
      'Unsupported configured Priority value.',
      'Closure details require state closed and a supported close reason.',
      'A superseding issue must be a different positive issue number.',
      'Superseding issue readback is not the requested repository issue.',
      'Issue is already closed with different closure evidence; reopen it explicitly first.',
      'Native closure readback disagrees with the requested reason or superseding issue.',
      'Native closure readback returned a foreign issue identity.',
      'Native closure readback has contradictory state evidence.',
      'History target is not the requested issue.',
      'Issue content changed after preparation; retry against the current title and body.',
      'Complete issue history exceeds the supported comment body limit; issue was not rewritten.',
      'Issue update readback disagrees with the requested content or state.',
      'Issue comments require the authenticated author role.',
      'Issue comment author identity is missing.',
      'Issue comment target is not the requested issue.',
      'Issue comment history exceeds the bounded readback window.',
      'Issue comment has duplicate authored retry matches.',
      'Issue comment conflicts with its authored operation marker.',
      'Issue comment readback disagrees with the authored issue comment.',
      'Authenticated update journal author is missing.',
      'Update journal author identity is missing.',
      'Update journal readback exceeds the bounded history window.',
      'An issue cannot be its own parent or blocker.',
      'Native blockers must be unique.',
      'Native Points and Priority catalogs must select distinct issue fields.',
      'Dependency endpoint must be a positive issue number.',
      'Dependency endpoint is not the requested repository issue.',
      'Dependency writes require configured author authority.',
      'Dependency author identity is unavailable.',
      'An issue cannot block itself.',
      'Dependency removal episode is ambiguous.',
      'Complete dependency history is required for an active blocker override.',
      'Override comment author, body or issue readback disagrees; native dependency was not added.',
      'Override comment search is incomplete or has duplicate authoritative markers.',
      'Override comment evidence is malformed.',
      'Existing override comment conflicts with the requested reason or endpoint evidence.',
      'Native batch relationship belongs to a different repository.',
      'Native batch relationship node identity disagrees with its repository issue.',
      'Native parent changed during batch readback; reconcile the current state.',
      'Native issue changed during batch preparation; reconcile the current state.',
      'Native batch readback disagrees with the requested outcomes.',
      'The issue delivery Project item is archived and cannot be updated.',
    ].includes(message)
  )
    return message;
  if (message.startsWith('Unknown repository label(s): '))
    return 'One or more requested labels do not exist in the selected repository.';
  if (/^Adding a blocker to active issue #\d+ requires overrideReason\.$/u.test(message))
    return 'Adding a blocker to an active issue requires overrideReason.';
  if (/^Project status for dependent #\d+ is unresolved; dependency additions were refused\.$/u.test(message))
    return 'Project status for a dependent is unresolved; dependency additions were refused.';
  if (message.startsWith('Complete dependency history is required for an active blocker override: '))
    return 'Complete dependency history is required for an active blocker override.';
  if (/^Issue #\d+ content or metadata may have changed, but dependency tracking did not complete: /u.test(message))
    return 'Issue content or metadata may have changed, but dependency tracking did not complete. Inspect native state and resume this existing issue.';
  return undefined;
}

/** One serial operation; each application uses the existing single-update mutation owner. */
export async function batchUpdateIssues(context: DeliveryContext, input: BatchUpdateIssueInput, signal?: AbortSignal) {
  if (context.clients.role !== 'author') throw new DeliveryError('Batch updates require the configured author role.');
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 50)
    throw new DeliveryError('Provide 1–50 batch items.');
  const repository = `${context.repo.owner}/${context.repo.repo}`.toLowerCase();
  if (input.items.some((item) => item.repo !== undefined && item.repo.toLowerCase() !== repository))
    throw new DeliveryError('Every batch item must use the selected repository.');
  const results: BatchUpdateItemResult[] = [];
  const rateLimits: RateLimitDiagnostics[] = [];
  const priorRateObservation = context.clients.rateLimitObservation?.();
  let limited = false;
  for (const { repo: _repo, ...item } of input.items) {
    if (limited || signal?.aborted) {
      results.push({
        issueNumber: item.issueNumber,
        status: 'failed',
        reason: limited ? 'Not attempted: GitHub rate limit exhausted.' : 'Not attempted: operation cancelled.',
        readback: null,
        readbackError: 'No new readback requested after rate-limit exhaustion or cancellation.',
      });
      continue;
    }
    let phase = 'preparation';
    try {
      const plan = await prepareIssueUpdate(context, item);
      const desired = await desiredUpdateValues(context, plan);
      const before = await updateProjection(context, plan);
      if (JSON.stringify(before.readback) !== JSON.stringify(plan.currentContent))
        throw new DeliveryError('Native issue changed during batch preparation; reconcile the current state.');
      if (context.clients.rateLimitObservation?.() !== priorRateObservation)
        throw new DeliveryError('A native request exhausted its rate limit during batch preparation.');
      const changes = pendingUpdateValues(desired, before.values);
      if (Object.keys(changes).length === 0 || input.dryRun === true) {
        results.push({
          issueNumber: item.issueNumber,
          status: Object.keys(changes).length === 0 ? 'unchanged' : 'planned',
          changes,
          readback: before.readback,
          relatedReadback: before.values,
        });
        continue;
      }
      phase = 'application';
      await applyIssueUpdate(
        context,
        {
          ...plan,
          priorContent: { title: before.readback.title, body: before.readback.body },
        },
        changes,
      );
      phase = 'readback';
      const after = await updateProjection(context, plan);
      if (Object.keys(pendingUpdateValues(desired, after.values)).length)
        throw new DeliveryError('Native batch readback disagrees with the requested outcomes.');
      results.push({
        issueNumber: item.issueNumber,
        status: 'applied',
        changes,
        readback: after.readback,
        relatedReadback: after.values,
      });
    } catch (error) {
      const observed = context.clients.rateLimitObservation?.();
      const incomplete = getIncompleteIssueUpdate(error);
      const limit =
        getRateLimitDiagnostics(error) ??
        incomplete?.rateLimit ??
        (observed !== priorRateObservation ? observed : undefined);
      if (limit !== undefined) {
        limited = true;
        rateLimits.push(limit);
      }
      const diagnostics = getMachineRequestDiagnostics(error);
      const failed: BatchUpdateItemResult = {
        issueNumber: item.issueNumber,
        status: 'failed',
        readback: null,
        reason:
          limit !== undefined
            ? 'GitHub rate limit exhausted; reconcile native state before retrying.'
            : (localBatchFailureReason(error) ??
              `Issue update ${phase} failed; inspect native readback before retrying.`),
        ...(diagnostics === undefined ? {} : { diagnostics }),
        ...(incomplete === undefined ? {} : { incomplete }),
      };
      if (!limited && !signal?.aborted) {
        try {
          failed.readback = await issueInfo(context, item.issueNumber);
        } catch (readbackError) {
          const latest = context.clients.rateLimitObservation?.();
          const readbackLimit =
            getRateLimitDiagnostics(readbackError) ?? (latest !== priorRateObservation ? latest : undefined);
          if (readbackLimit !== undefined) {
            limited = true;
            rateLimits.push(readbackLimit);
          }
          failed.readbackError = 'Native issue readback unavailable; reconcile this existing issue before retrying.';
        }
      } else failed.readbackError = 'Readback deferred after rate-limit exhaustion or cancellation.';
      results.push(failed);
    }
  }
  return {
    dryRun: input.dryRun === true,
    results,
    summary: {
      total: results.length,
      applied: results.filter((item) => item.status === 'applied').length,
      planned: results.filter((item) => item.status === 'planned').length,
      unchanged: results.filter((item) => item.status === 'unchanged').length,
      failed: results.filter((item) => item.status === 'failed').length,
      rateLimits,
    },
  };
}

/** Complete the native tracking and Project state of an issue created before an interrupted response. */
export async function resumeCreatedIssue(context: DeliveryContext, input: UpdateIssueInput): Promise<IssueInfo> {
  // Tracking recovery must not trigger an unrelated first render omission and change the retry intent.
  return updateIssue(context, { ...input, preserveHistory: input.preserveHistory ?? false });
}

export interface IssueChildProgress {
  childCount: number;
  closedChildCount: number;
  percentClosed: number;
  pointsTotal: number | null;
  inProgressChildren: number[] | null;
  nextTargetDate: string | null;
  missingPoints: number[];
  missingProjectStatus: number[];
  undatedOpenChildren: number[];
  targetDateConfigured: boolean;
}

export interface IssueInfo {
  childProgress?: IssueChildProgress;
  deferred?: IssueDeferralData | null;
  routing?: LoadedDeliveryConfig['routing'];
  blockedBy: number[];
  body: string;
  issueNumber: number;
  issueType: string | null;
  labels: string[];
  milestone: number | null;
  fields: ListedTrackingIssue['fields'];
  startDate?: string | null;
  targetDate?: string | null;
  parentIssueNumber: number | null;
  points?: number;
  priority?: string;
  projectStatus: string | null;
  state: string;
  title: string;
  url: string;
  worktree: string | null;
}

async function readIssueInfo(
  context: DeliveryContext,
  issueNumber: number,
  includeProject = true,
  expectedTarget?: { nodeId: string; url: string },
) {
  const { clients, config, repo } = context;
  const issue = (await clients.rest.issues.get({ issue_number: issueNumber, owner: repo.owner, repo: repo.repo })).data;
  if ('pull_request' in issue) throw new DeliveryError('Requested issue number is a pull request.');
  if (
    !includeProject &&
    (issue.number !== issueNumber ||
      issue.node_id !== expectedTarget?.nodeId ||
      issue.html_url !== expectedTarget?.url ||
      new URL(issue.html_url).pathname.toLowerCase() !==
        `/${repo.owner}/${repo.repo}/issues/${String(issueNumber)}`.toLowerCase())
  )
    throw new DeliveryError('Native closure readback returned a foreign issue identity.');
  const children = includeProject ? await readDirectIssueChildren(context, issueNumber, issue) : [];
  const strictRead = children.length > 0;
  const [nativeFields, relationships, project] = await Promise.all([
    readIssueNativeFields(context, issueNumber, strictRead),
    getNativeBlockerRelationships({
      graphql: clients.graphql,
      issueNumber,
      repo,
      ...(context.readPageLimit === undefined
        ? {}
        : { maxPages: context.readPageLimit, requireRepositoryIdentity: true, issueNodeId: issue.node_id }),
    }),
    includeProject
      ? getIssueProjectStatus({
          graphql: clients.graphql,
          issueNodeId: issue.node_id,
          org: config.native.organization,
          ...(context.readPageLimit === undefined ? {} : { maxPages: context.readPageLimit }),
          ...(context.projectConfiguration ? { configuration: context.projectConfiguration } : {}),
          settings: projectSettingsFromDeliveryConfig(config),
        })
      : Promise.resolve(null),
  ]);
  const metadata = parseConfiguredNativeIssueMetadata(
    nativeFields.values,
    nativeIssueSettingsFromDeliveryConfig(config),
  );
  const info: IssueInfo = {
    ...(children.length ? { childProgress: await readChildProgress(context, children, nativeFields.catalog) } : {}),
    ...deferralReadback(issue.body, issue.title),
    ...(context.configuration ? { routing: context.configuration.routing } : {}),
    blockedBy: relationships.blockers.filter((blocker) => blocker.state === 'OPEN').map((blocker) => blocker.number),
    body: issue.body ?? '',
    issueNumber,
    issueType: issue.type?.name ?? null,
    labels: (issue.labels ?? []).flatMap((label) =>
      typeof label === 'string' ? [label] : label.name === undefined ? [] : [label.name],
    ),
    milestone: issue.milestone?.number ?? null,
    fields: nativeFields.fields,
    ...(nativeFields.catalog.some((field) => field.name === 'Start date' && field.data_type === 'date')
      ? { startDate: nativeFields.fields['Start date'] as string | null }
      : {}),
    ...(nativeFields.catalog.some((field) => field.name === 'Target date' && field.data_type === 'date')
      ? { targetDate: nativeFields.fields['Target date'] as string | null }
      : {}),
    parentIssueNumber: relationships.parentNumber,
    ...(metadata.points === undefined ? {} : { points: metadata.points }),
    ...(metadata.priority === undefined ? {} : { priority: metadata.priority }),
    projectStatus: project?.status ?? null,
    state: issue.state,
    title: issue.title,
    url: issue.html_url,
    worktree: null,
  };
  return { info, issueNodeId: issue.node_id, issueNumber: issue.number };
}

export async function issueInfo(context: DeliveryContext, issueNumber: number): Promise<IssueInfo> {
  return (await readIssueInfo(context, issueNumber)).info;
}

/** Invalid canonical content stays inspectable; omitted state is unknown, never an assertion of undeferred. */
function deferralReadback(body: string | null | undefined, title: string): { deferred?: IssueDeferralData | null } {
  if (body === undefined) return {};
  try {
    return { deferred: parseIssueBody(body ?? '', { title }).issue.deferral ?? null };
  } catch (error) {
    if (!(error instanceof IssueValidationError)) throw error;
    return {};
  }
}

const DirectIssueChild = z.object({
  id: z.number().int().positive().safe(),
  number: z.number().int().positive().safe(),
  node_id: z
    .string()
    .min(1)
    .refine((value) => value.trim() === value && value.trim().length > 0),
  state: z.enum(['open', 'closed']),
  url: z.url(),
  html_url: z.url(),
  repository_url: z.url(),
});

async function readDirectIssueChildren(
  context: DeliveryContext,
  issueNumber: number,
  parent: { id: number; node_id: string },
) {
  const children: z.infer<typeof DirectIssueChild>[] = [];
  const numbers = new Set<number>(),
    ids = new Set<number>(),
    nodes = new Set<string>();
  const repositoryPath = `/repos/${context.repo.owner}/${context.repo.repo}`;
  for (let page = 1; ; page += 1) {
    if (context.readPageLimit !== undefined && page > context.readPageLimit)
      throw new CollectionLimitError({
        collection: 'native-sub-issues',
        pagesRequested: page - 1,
        rowsObserved: children.length,
        limit: context.readPageLimit,
      });
    const response = await context.clients.rest.issues.listSubIssues({
      ...context.repo,
      issue_number: issueNumber,
      page,
      per_page: 100,
    });
    const next = nativeReadNextPage(response, page, `${repositoryPath}/issues/${issueNumber}/sub_issues`);
    for (const raw of response.data) {
      if (Object.hasOwn(raw, 'pull_request')) throw new DeliveryError('Parent progress child is a pull request.');
      const child = DirectIssueChild.parse(raw);
      if (
        child.number === issueNumber ||
        child.id === parent.id ||
        child.node_id === parent.node_id ||
        numbers.has(child.number) ||
        ids.has(child.id) ||
        nodes.has(child.node_id)
      )
        throw new DeliveryError('Parent progress has duplicate or self-referencing child identities.');
      for (const [value, host, path] of [
        [child.url, 'api.github.com', `${repositoryPath}/issues/${child.number}`],
        [child.repository_url, 'api.github.com', repositoryPath],
        [child.html_url, 'github.com', `/${context.repo.owner}/${context.repo.repo}/issues/${child.number}`],
      ]) {
        const url = new URL(value!);
        if (
          url.protocol !== 'https:' ||
          url.hostname !== host ||
          url.port ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          url.pathname.toLowerCase() !== path!.toLowerCase()
        )
          throw new DeliveryError('Parent progress child repository or issue-number identity disagrees.');
      }
      numbers.add(child.number);
      ids.add(child.id);
      nodes.add(child.node_id);
      children.push(child);
    }
    if (next === null) return children.sort((left, right) => left.number - right.number);
  }
}

async function readChildProgress(
  context: DeliveryContext,
  children: Awaited<ReturnType<typeof readDirectIssueChildren>>,
  catalog: Awaited<ReturnType<typeof readIssueFieldCatalog>>,
): Promise<IssueChildProgress> {
  const date = catalog.find((field) => field.name === 'Target date');
  if (date && date.data_type !== 'date')
    throw new DeliveryError('Parent progress Target date has an incompatible type.');
  const pointField = catalog.find((field) => field.name === context.config.native.points.name);
  if (
    pointField &&
    (String(pointField.id) !== context.config.native.points.databaseId || pointField.data_type !== 'single_select')
  )
    throw new DeliveryError('Parent progress configured Points field identity or type disagrees.');
  const configuration =
    context.projectConfiguration ??
    (await getProjectDeliveryConfiguration({
      graphql: context.clients.graphql,
      org: context.config.native.organization,
      settings: projectSettingsFromDeliveryConfig(context.config),
      ...(context.readPageLimit === undefined ? {} : { maxPages: context.readPageLimit }),
    }));
  const progress: IssueChildProgress = {
    childCount: children.length,
    closedChildCount: children.filter((child) => child.state === 'closed').length,
    percentClosed: 0,
    pointsTotal: 0,
    inProgressChildren: [],
    nextTargetDate: null,
    missingPoints: [],
    missingProjectStatus: [],
    undatedOpenChildren: [],
    targetDateConfigured: date !== undefined,
  };
  let pointsTotal = 0;
  const inProgress: number[] = [];
  for (const child of children) {
    const fields = await readIssueFields(context, child.number, catalog, false, true);
    const points = fields.values.find(
      (field) => String(field.issue_field_id) === context.config.native.points.databaseId,
    );
    if (!points || (points.value === null && points.single_select_option == null))
      progress.missingPoints.push(child.number);
    else {
      const parsed = parseConfiguredNativeIssueMetadata(
        [points],
        nativeIssueSettingsFromDeliveryConfig(context.config),
      );
      if (parsed.points === undefined)
        throw new DeliveryError('Parent progress configured Points readback is missing.');
      pointsTotal += parsed.points;
      if (!Number.isSafeInteger(pointsTotal))
        throw new DeliveryError('Parent progress Points aggregate exceeds the safe integer range.');
    }
    const status = await getIssueProjectStatus({
      graphql: context.clients.graphql,
      org: context.config.native.organization,
      issueNodeId: child.node_id,
      configuration,
      settings: projectSettingsFromDeliveryConfig(context.config),
      capacityRead: true,
      ...(context.readPageLimit === undefined ? {} : { maxPages: context.readPageLimit }),
    });
    if (status === null) progress.missingProjectStatus.push(child.number);
    else if (status.status === 'In Progress') inProgress.push(child.number);
    if (child.state === 'open') {
      const value = date === undefined ? null : fields.fields['Target date'];
      if (typeof value !== 'string') progress.undatedOpenChildren.push(child.number);
      else if (progress.nextTargetDate === null || value < progress.nextTargetDate) progress.nextTargetDate = value;
    }
  }
  progress.percentClosed = Math.round((1000 * progress.closedChildCount) / progress.childCount) / 10;
  progress.pointsTotal = progress.missingPoints.length ? null : pointsTotal;
  progress.inProgressChildren = progress.missingProjectStatus.length ? null : inProgress;
  return progress;
}

export async function listIssueSubissues(context: DeliveryContext, issueNumber: number): Promise<number[]> {
  const issue = (await context.clients.rest.issues.get({ ...context.repo, issue_number: issueNumber })).data;
  if ('pull_request' in issue) throw new DeliveryError('Requested issue number is a pull request.');
  return (await readDirectIssueChildren(context, issueNumber, issue)).map((child) => child.number);
}

export async function readyCheck(
  context: DeliveryContext,
  issueNumber: number,
  onReadback?: (observation: {
    info: IssueInfo;
    issueNodeId: string;
    issueNumber: number;
    trackingParent: boolean;
  }) => void,
): Promise<AgentReadinessResult> {
  const observation = await readIssueInfo(context, issueNumber);
  const { info } = observation;
  const trackingParent = await hasNativeSubIssues({
    issueNumber,
    repo: context.repo,
    rest: context.clients.rest,
    requireComplete: context.readPageLimit !== undefined,
  });
  onReadback?.({ ...observation, trackingParent });
  return evaluateAgentReadiness({
    blockedBy: info.blockedBy,
    body: info.body,
    ...(info.points === undefined ? {} : { points: info.points }),
    repoRoot: undefined,
    title: info.title,
    ...(info.issueType === null ? {} : { issueType: info.issueType }),
    trackingParent,
  });
}

interface LinkedIssueBranch {
  name: string;
  sha: string;
  repository: string;
}
interface BranchQuery {
  repository: {
    issue: {
      linkedBranches: {
        nodes: Array<{
          ref: { name: string; target: { oid: string }; repository: { nameWithOwner: string } } | null;
        } | null>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } | null;
  } | null;
}
export async function linkedIssueBranches(context: DeliveryContext, issueNumber: number): Promise<LinkedIssueBranch[]> {
  const branches: LinkedIssueBranch[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  const limit = Math.min(context.readPageLimit ?? 20, 20);
  for (let page = 0; page < limit; page++) {
    const response: BranchQuery = await context.clients.graphql<{
      repository: {
        issue: {
          linkedBranches: {
            nodes: Array<{
              ref: { name: string; target: { oid: string }; repository: { nameWithOwner: string } } | null;
            } | null>;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        } | null;
      } | null;
    }>(
      'query DeliveryIssueBranches($owner:String!,$repo:String!,$issue:Int!,$cursor:String){repository(owner:$owner,name:$repo){issue(number:$issue){linkedBranches(first:100,after:$cursor){nodes{ref{name target{oid} repository{nameWithOwner}}} pageInfo{hasNextPage endCursor}}}}}',
      { owner: context.repo.owner, repo: context.repo.repo, issue: issueNumber, cursor },
    );
    const connection = response.repository?.issue?.linkedBranches;
    if (!connection || !Array.isArray(connection.nodes) || typeof connection.pageInfo?.hasNextPage !== 'boolean')
      throw new DeliveryError('Incomplete GitHub linked issue branch readback.');
    for (const node of connection.nodes) {
      const ref = node?.ref;
      if (!ref || !ref.name || !/^[a-f0-9]{40}$/u.test(ref.target.oid) || !ref.repository.nameWithOwner)
        throw new DeliveryError('Incomplete GitHub linked branch identity.');
      if (ref.repository.nameWithOwner.toLowerCase() === context.config.repository.toLowerCase())
        branches.push({ name: ref.name, sha: ref.target.oid, repository: ref.repository.nameWithOwner });
    }
    if (!connection.pageInfo.hasNextPage) return branches;
    const next = connection.pageInfo.endCursor;
    if (!next || cursors.has(next)) throw new DeliveryError('GitHub linked branch pagination did not advance.');
    cursors.add(next);
    cursor = next;
  }
  if (context.readPageLimit !== undefined)
    throw new CollectionLimitError({
      collection: 'linked-branches',
      pagesRequested: limit,
      rowsObserved: branches.length,
      limit,
    });
  throw new DeliveryError('GitHub linked issue branches exceed the bounded readback window.');
}
export async function issueBranch(context: DeliveryContext, issueNumber: number, selected?: string): Promise<string> {
  const branches = (await linkedIssueBranches(context, issueNumber)).filter(
    (branch) => selected === undefined || branch.name === selected,
  );
  if (branches.length !== 1)
    throw new DeliveryError(
      'Select exactly one GitHub-linked issue branch; no local worktree or receipt fallback is available.',
    );
  return branches[0]!.name;
}
export async function startIssueBranch(context: DeliveryContext, issueNumber: number, selected?: string) {
  const issue = (await context.clients.rest.issues.get({ ...context.repo, issue_number: issueNumber })).data;
  if (issue.number !== issueNumber || 'pull_request' in issue || issue.state !== 'open')
    throw new DeliveryError('Start requires the requested open GitHub issue.');
  const branches = await linkedIssueBranches(context, issueNumber);
  const name = selected ?? (branches.length === 1 ? branches[0]!.name : `issue/${issueNumber}`);
  if (
    !/^(?!.*(?:\.\.|@\{|\/\/))[A-Za-z0-9._/-]+$/u.test(name) ||
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.endsWith('.lock')
  )
    throw new DeliveryError('Invalid issue branch name.');
  const existing = branches.filter((branch) => branch.name === name);
  if (branches.length > 0 && existing.length !== 1)
    throw new DeliveryError('Select exactly one existing GitHub-linked issue branch before start.');
  if (existing.length > 1) throw new DeliveryError('GitHub issue branch has conflicting linked matches.');
  if (existing.length === 1)
    return { issueNumber, issueUrl: issue.html_url, branch: name, headSha: existing[0]!.sha, reused: true };
  const repository = (await context.clients.rest.repos.get({ ...context.repo })).data;
  const base = (await context.clients.rest.git.getRef({ ...context.repo, ref: `heads/${repository.default_branch}` }))
    .data.object.sha;
  if (!/^[a-f0-9]{40}$/u.test(base) || !repository.node_id)
    throw new DeliveryError('GitHub repository default branch identity is incomplete.');
  await context.clients.graphql(
    'mutation DeliveryStartBranch($input:CreateLinkedBranchInput!){createLinkedBranch(input:$input){linkedBranch{ref{name target{oid}}}}}',
    {
      input: {
        issueId: issue.node_id,
        repositoryId: repository.node_id,
        oid: base,
        name,
        clientMutationId: digestValue({ repository: context.config.repository, issueNumber, name, base }),
      },
    },
  );
  const readback = (await linkedIssueBranches(context, issueNumber)).filter((branch) => branch.name === name);
  if (readback.length !== 1 || readback[0]!.sha !== base)
    throw new DeliveryError(
      'Started GitHub branch/link readback disagrees; resume this issue without creating another.',
    );
  return { issueNumber, issueUrl: issue.html_url, branch: name, headSha: base, reused: false };
}

/** Recheck native eligibility before an explicit start changes its selected Project. */
export async function startIssueProject(context: DeliveryContext, issueNumber: number, overrideReason?: string) {
  const readiness = await readyCheck(context, issueNumber);
  if (!readiness.ready) throw new IssueValidationError(readiness.failures);
  const issue = (await context.clients.rest.issues.get({ ...context.repo, issue_number: issueNumber })).data;
  if (issue.number !== issueNumber || 'pull_request' in issue || issue.state !== 'open' || !issue.node_id)
    throw new DeliveryError('Start requires the requested open GitHub issue before Project synchronization.');
  return syncIssueProjectStatus({
    graphql: context.clients.graphql,
    issueNodeId: issue.node_id,
    org: context.config.native.organization,
    ...(context.projectConfiguration === undefined ? {} : { configuration: context.projectConfiguration }),
    settings: projectSettingsFromDeliveryConfig(context.config),
    status: 'In Progress',
    beforeAdvance: async () => {
      const eligible = await readyCheck(context, issueNumber);
      if (!eligible.ready) throw new IssueValidationError(eligible.failures);
      await assertIssueStartCapacity(context, issueNumber, overrideReason, true);
      const current = await issueInfo(context, issueNumber);
      if (current.state !== 'open') throw new DeliveryError('Start requires the requested open issue.');
      const finalEligibility = await readyCheck(context, issueNumber);
      if (!finalEligibility.ready) throw new IssueValidationError(finalEligibility.failures);
    },
  });
}

/** A complete observed-capacity guard, not a cross-writer GitHub transaction. */
export async function assertIssueStartCapacity(
  context: DeliveryContext,
  issueNumber: number,
  overrideReason?: string,
  recordOverride = false,
): Promise<string | undefined> {
  const lanes = WipLimits.parse(context.config.wipLimits ?? []).filter(
    (lane) => lane.repository.toLowerCase() === context.config.repository.toLowerCase(),
  );
  if (!lanes.length) return undefined;
  const configuration =
    context.projectConfiguration ??
    (await getProjectDeliveryConfiguration({
      graphql: context.clients.graphql,
      org: context.config.native.organization,
      settings: projectSettingsFromDeliveryConfig(context.config),
      ...(context.readPageLimit === undefined ? {} : { maxPages: context.readPageLimit }),
    }));
  const capacityContext = { ...context, projectConfiguration: configuration };
  const reason = overrideReason === undefined ? undefined : OverrideReason.parse(overrideReason);
  const publicReason = validateIssue({ title: 'WIP capacity override', legacyBody: reason ?? '', draft: true }, false);
  if (publicReason.failures.length) throw new IssueValidationError(publicReason.failures);
  if (context.config.repository.toLowerCase() !== `${context.repo.owner}/${context.repo.repo}`.toLowerCase())
    throw new DeliveryError('WIP capacity repository identity disagrees with the selected repository.');
  const configuredLabels = lanes.flatMap((lane) => ('label' in lane.match ? [lane.match.label] : []));
  if (configuredLabels.length)
    await labels(context, [...new Map(configuredLabels.map((label) => [label.toLowerCase(), label])).values()]);
  const rows: ListedTrackingIssue[] = [];
  const seen = new Set<number>();
  for (let page = 1; ; page++) {
    if (context.readPageLimit !== undefined && page > Math.min(context.readPageLimit, 20))
      throw new CollectionLimitError({
        collection: 'wip-issues',
        pagesRequested: page - 1,
        rowsObserved: rows.length,
        limit: Math.min(context.readPageLimit, 20),
      });
    if (page > 20) throw new DeliveryError('WIP capacity issue pagination is incomplete.');
    const batch = await listIssues(capacityContext, { state: 'open', page, perPage: 100 }, { capacityRead: true });
    for (const row of batch.issues) {
      if (seen.has(row.number)) throw new DeliveryError('WIP capacity repeats a native issue across pages.');
      seen.add(row.number);
      rows.push(row);
    }
    if (batch.nextPage === null) break;
    if (batch.nextPage !== page + 1) throw new DeliveryError('WIP capacity pagination did not advance.');
  }
  const target = rows.find((row) => row.number === issueNumber);
  if (!target?.nodeId)
    throw new DeliveryError('WIP capacity target is missing from the complete native issue readback.');
  const matches = (lane: WipLane, row: ListedTrackingIssue): boolean => {
    if ('label' in lane.match) {
      const selected = lane.match.label;
      return row.labels.some((label) => label.toLowerCase() === selected.toLowerCase());
    }
    const { field, value } = lane.match;
    if (!row.fieldIds?.[field] || row.fieldIds[field] !== target.fieldIds?.[field] || !Object.hasOwn(row.fields, field))
      throw new DeliveryError(`WIP capacity native field ${field} is unknown or changed identity.`);
    const observed = row.fields[field];
    return Array.isArray(observed) ? typeof value === 'string' && observed.includes(value) : observed === value;
  };
  const observations = lanes.flatMap((lane) => {
    // Validate every configured field across the full snapshot, even when the target does not match it.
    const matching = rows.filter((row) => matches(lane, row));
    if (!matches(lane, target)) return [];
    const count = matching.filter((row) => row.projectStatus === 'In Progress').length;
    return [
      {
        name: lane.name,
        match: lane.match,
        ...('field' in lane.match ? { fieldId: target.fieldIds![lane.match.field] } : {}),
        count,
        limit: lane.limit,
      },
    ];
  });
  const exceeded =
    target.projectStatus === 'In Progress' ? [] : observations.filter((lane) => lane.count + 1 > lane.limit);
  if (exceeded.length && reason === undefined)
    throw new DeliveryError(
      `WIP capacity limit exceeded: ${exceeded.map((lane) => `${lane.name} (${lane.count}/${lane.limit})`).join(', ')}. Supply overrideReason for a recorded capacity exception.`,
    );
  const evidence = {
    schema: 'ai-delivery.wip-override@1',
    repository: context.config.repository,
    projectId: configuration.projectId,
    issue: { number: issueNumber, id: target.nodeId },
    observedStatus: target.projectStatus,
    lanes: observations,
  };
  if (!evidence.projectId) throw new DeliveryError('WIP capacity configured Project identity is unavailable.');
  const snapshot = JSON.stringify(evidence);
  if (exceeded.length && recordOverride) {
    if (context.clients.role !== 'author' || !context.clients.authenticatedAuthor)
      throw new DeliveryError('WIP capacity override requires the authenticated configured author.');
    const author = await context.clients.authenticatedAuthor();
    if (!author.actorLogin || !author.credentialIdentity)
      throw new DeliveryError('WIP capacity author identity is incomplete.');
    const record = { ...evidence, author: author.actorLogin, reason };
    const marker = `<!-- ai-delivery:wip-override@1:${digestValue(record)} -->`;
    const body = `WIP capacity override.\n\n\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\`\n\n${marker}`;
    const publicRecord = validateIssue({ title: 'WIP capacity override', legacyBody: body, draft: true }, false);
    if (publicRecord.failures.length) throw new IssueValidationError(publicRecord.failures);
    await writeAuthenticatedIssueComment(context, { issueNumber, body }, undefined, marker);
    const finalAuthor = await context.clients.authenticatedAuthor();
    if (finalAuthor.actorLogin !== author.actorLogin || finalAuthor.credentialIdentity !== author.credentialIdentity)
      throw new DeliveryError('WIP capacity override author changed during comment verification.');
    if ((await assertIssueStartCapacity(context, issueNumber, reason)) !== snapshot)
      throw new DeliveryError(
        'WIP capacity changed while recording the override; inspect native state and resume this issue.',
      );
  }
  return snapshot;
}
