import { z } from 'zod';

import type {
  DeliveryConfig,
  GitHubDeliveryConfig,
  LoadedDeliveryConfig,
  LoadedGitHubConfig,
} from './config/deliveryConfig.js';
import { loadDeliveryConfig, WipLimits, type WipLane } from './config/deliveryConfig.js';
import { digestValue } from './delivery/legacy.js';
import { DeliveryError } from './errors.js';
import { createDeliveryGitHubClients, type GitHubClients } from './github/client.js';
import {
  NATIVE_ISSUE_API_VERSION,
  clearConfiguredNativeIssuePoints,
  getConfiguredNativeIssueMetadata,
  nativeIssueSettingsFromDeliveryConfig,
  setConfiguredNativeIssueMetadata,
} from './github/nativeIssueMetadata.js';
import {
  getIssueProjectStatus,
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
  issueStartFooter,
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
  const accepted =
    'body' in input ? RawIssueCommentSchema.parse(input) : (JournalInputSchema.parse(input) as JournalInput);
  const rawBody = 'body' in accepted ? accepted.body : undefined;
  if (rawBody !== undefined && lifecycleKey !== undefined)
    throw new DeliveryError('Raw issue comments do not accept a lifecycle journal key.');
  const marker =
    rawBody === undefined
      ? `<!-- ai-delivery:journal@1:${digestValue({ issueNumber: accepted.issueNumber, key: lifecycleKey ?? accepted })} -->`
      : undefined;
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
            (marker === undefined ? comment.body === body : comment.body?.endsWith(marker)) &&
            comment.user?.login.toLowerCase() === actor.toLowerCase(),
        ),
      );
      if (batch.length < 100) break;
      if (page === 20) throw new DeliveryError('Issue comment history exceeds the bounded readback window.');
    }
    if (matches.length > 1) throw new DeliveryError('Issue comment has duplicate authored retry matches.');
    const existing = matches[0];
    const created =
      existing ??
      (await context.clients.rest.issues.createComment({ ...context.repo, issue_number: input.issueNumber, body }))
        .data;
    const readback = (await context.clients.rest.issues.getComment({ ...context.repo, comment_id: created.id })).data;
    const expectedIssuePath = `/repos/${context.repo.owner}/${context.repo.repo}/issues/${String(input.issueNumber)}`;
    if (
      !Number.isSafeInteger(readback.id) ||
      readback.id <= 0 ||
      readback.id !== created.id ||
      readback.html_url !== created.html_url ||
      readback.body !== (existing?.body ?? body) ||
      (lifecycleKey === undefined && readback.body !== body) ||
      readback.user?.login.toLowerCase() !== actor.toLowerCase() ||
      new URL(readback.issue_url).pathname.toLowerCase() !== expectedIssuePath.toLowerCase() ||
      !readback.html_url.startsWith('https://')
    )
      throw new DeliveryError('Issue comment readback disagrees with the authored issue comment.');
    return { commentId: readback.id, url: readback.html_url, body: readback.body!, reused: existing !== undefined };
  };
  return operation();
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
  clients: GitHubClients;
  reviewerClients?: GitHubClients;
  configuration?: LoadedDeliveryConfig | LoadedGitHubConfig;
  projectConfiguration?: ProjectDeliveryConfiguration;
  config: DeliveryConfig | GitHubDeliveryConfig;
  repo: RepoCoordinates;
  root: string;
}

export async function loadDeliveryContext(input: {
  identity: string;
  personalAuth?: boolean;
  repoRoot: string;
  role: 'author' | 'reviewer';
  repository?: string;
  signal?: AbortSignal;
}): Promise<DeliveryContext> {
  const loaded = await loadDeliveryConfig(input.repoRoot, {
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
  return { clients, config, configuration: loaded, projectConfiguration, repo, root: '' };
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

export interface CreateIssueInput extends Partial<IssueFieldsInput> {
  status?: { nextMilestone?: string };
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
    (source === undefined || parsed.legacy ? '' : issueStartFooter(source));
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
  ) {
    super(
      `Issue #${created.number} was created but native tracking did not complete: ${String(cause)}. Resume this known issue; do not create another.`,
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
  const prepared = prepareIssueWrite(input);
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
  const created = await clients.rest.issues.create({
    body: input.body ?? '',
    labels: await labels(context, input.labels),
    ...(input.milestone === undefined ? {} : { milestone: input.milestone }),
    owner: repo.owner,
    repo: repo.repo,
    title: input.title,
    ...(input.issueType === undefined ? {} : { type: input.issueType }),
  });
  const issueNumber = created.data.number;
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
    if (input.points !== undefined || input.priority !== undefined)
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
    if (input.parentIssueNumber !== undefined)
      await replaceParentIssue({
        graphql: clients.graphql,
        issueNumber,
        parentIssueNumber: input.parentIssueNumber,
        repo,
        rest: clients.rest,
      });
    if (input.parentIssueNumber !== undefined)
      await clearConfiguredNativeIssuePoints({
        issueNumber: input.parentIssueNumber,
        org: config.native.organization,
        owner: repo.owner,
        repo: repo.repo,
        rest: clients.rest,
        settings: nativeIssueSettingsFromDeliveryConfig(config),
      });
    await syncIssueProjectStatus({
      graphql: clients.graphql,
      issueNodeId: created.data.node_id,
      org: config.native.organization,
      ...(context.projectConfiguration ? { configuration: context.projectConfiguration } : {}),
      settings: projectSettingsFromDeliveryConfig(config),
      status: targets.unresolvedBlockers.length > 0 ? 'Blocked' : 'Todo',
    });
    if ((input.blockedBy?.length ?? 0) > 0)
      await replaceBlockedBy({
        beforeAdd,
        blockers: input.blockedBy ?? [],
        graphql: clients.graphql,
        issueNumber,
        repo,
        rest: clients.rest,
      });
    for (const dependent of new Set(input.blocks ?? []))
      await linkBlockedBy({
        beforeAdd,
        blockers: [issueNumber],
        graphql: clients.graphql,
        issueNumber: dependent,
        repo,
        rest: clients.rest,
      });
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

function capacityNextPage(
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

async function issueFieldPages(
  context: DeliveryContext,
  route: string,
  parameters: Record<string, unknown>,
  maxPages?: number,
): Promise<unknown[]> {
  const values: unknown[] = [];
  const seenPages = new Set<string>();
  for (let page = 1; ; page += 1) {
    if (maxPages !== undefined && page > maxPages)
      throw new DeliveryError('WIP capacity native field pagination is incomplete.');
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
    if (maxPages === undefined ? response.data.length < 100 : capacityNextPage(response, page, 100) === null)
      return values;
  }
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
  const catalog = z
    .array(FieldCatalogEntry)
    .parse(
      await issueFieldPages(
        context,
        'GET /orgs/{org}/issue-fields',
        { org: context.config.native.organization },
        options.capacityRead ? 20 : undefined,
      ),
    );
  if (
    new Set(catalog.map((field) => field.name)).size !== catalog.length ||
    new Set(catalog.map((field) => field.id)).size !== catalog.length
  )
    throw new DeliveryError('Native issue field catalog has duplicate identities or names.');
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
      org: context.config.native.organization,
      ...(context.projectConfiguration ? { configuration: context.projectConfiguration } : {}),
      settings: projectSettingsFromDeliveryConfig(context.config),
    });
    if (input.projectStatus !== undefined && (project?.status ?? null) !== input.projectStatus) continue;
    const fields: ListedTrackingIssue['fields'] = Object.fromEntries(catalog.map((field) => [field.name, null]));
    const values = z.array(FieldValueEntry).parse(
      await issueFieldPages(
        context,
        'GET /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values',
        {
          ...context.repo,
          issue_number: current.number,
        },
        options.capacityRead ? 20 : undefined,
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
        ((field.data_type === 'single_select' && !field.single_select_option) ||
          (field.data_type === 'multi_select' && field.multi_select_options === undefined)) &&
        field.value !== null &&
        field.value !== undefined
      )
        throw new DeliveryError('Native select field omitted its named option readback.');
      const value =
        field.data_type === 'single_select'
          ? (field.single_select_option?.name ?? null)
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

export interface UpdateIssueInput extends Omit<Partial<IssueFieldsInput>, 'deferral'> {
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

export async function updateIssue(context: DeliveryContext, input: UpdateIssueInput): Promise<UpdateIssueResult> {
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
  const currentContent = await issueInfo(context, input.issueNumber);
  const prepared = prepareIssueWrite(input, currentContent);
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
  let historyComment: IssueCommentReadback | undefined;
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
      historyComment = await commentIssue(context, { issueNumber: input.issueNumber, body });
    }
  }
  let closureComment: IssueCommentReadback | undefined;
  if (closeReason !== undefined)
    closureComment = await commentIssue(context, {
      issueNumber: input.issueNumber,
      body: `Requested closure reason: ${closeReason}.${input.supersededBy === undefined ? '' : `\nSuperseded by ${repo.owner}/${repo.repo}#${String(input.supersededBy)}.`}`,
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
  await clients.rest.issues.update({
    issue_number: input.issueNumber,
    owner: repo.owner,
    repo: repo.repo,
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.issueType === undefined ? {} : { type: input.issueType }),
    ...(acceptedLabels === undefined ? {} : { labels: acceptedLabels }),
    ...(input.milestone === undefined ? {} : { milestone: input.milestone }),
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(closeReason === undefined
      ? {}
      : { state_reason: closeReason, headers: { 'X-GitHub-Api-Version': NATIVE_ISSUE_API_VERSION } }),
    ...(closeReason !== 'duplicate' || supersedingIssueId === undefined
      ? {}
      : { duplicate_issue_id: supersedingIssueId }),
    ...(input.title === undefined ? {} : { title: input.title }),
  });
  const closure = closeReason === undefined ? undefined : await readIssueClosure(context, input.issueNumber);
  if (closure !== undefined) assertClosure(closure);
  if (input.points !== undefined || input.priority !== undefined)
    await setConfiguredNativeIssueMetadata({
      issueNumber: input.issueNumber,
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
  if (input.parentIssueNumber !== undefined)
    await replaceParentIssue({
      graphql: clients.graphql,
      issueNumber: input.issueNumber,
      parentIssueNumber: input.parentIssueNumber,
      repo,
      rest: clients.rest,
    });
  if (input.parentIssueNumber !== undefined && input.parentIssueNumber !== null)
    await clearConfiguredNativeIssuePoints({
      issueNumber: input.parentIssueNumber,
      org: config.native.organization,
      owner: repo.owner,
      repo: repo.repo,
      rest: clients.rest,
      settings: nativeIssueSettingsFromDeliveryConfig(config),
    });
  try {
    if (input.blockedBy !== undefined)
      await replaceBlockedBy({
        ...(beforeAdd === undefined ? {} : { beforeAdd }),
        blockers: input.blockedBy,
        graphql: clients.graphql,
        issueNumber: input.issueNumber,
        repo,
        rest: clients.rest,
      });
    for (const dependent of new Set(input.blocks ?? []))
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
  const info = await issueInfo(context, input.issueNumber);
  const status =
    info.state === 'closed' || info.projectStatus === 'Done'
      ? 'Done'
      : info.blockedBy.length > 0
        ? 'Blocked'
        : input.park === true || input.blockedBy !== undefined || info.projectStatus === null
          ? 'Todo'
          : info.projectStatus === 'In Progress' || (info.projectStatus === 'Blocked' && input.state === undefined)
            ? info.projectStatus
            : 'Todo';
  const issue = (await clients.rest.issues.get({ issue_number: input.issueNumber, ...repo })).data;
  await syncIssueProjectStatus({
    graphql: clients.graphql,
    issueNodeId: issue.node_id,
    org: config.native.organization,
    ...(context.projectConfiguration ? { configuration: context.projectConfiguration } : {}),
    settings: projectSettingsFromDeliveryConfig(config),
    status,
  });
  const readback = await issueInfo(context, input.issueNumber);
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

/** Complete the native tracking and Project state of an issue created before an interrupted response. */
export async function resumeCreatedIssue(context: DeliveryContext, input: UpdateIssueInput): Promise<IssueInfo> {
  // Tracking recovery must not trigger an unrelated first render omission and change the retry intent.
  return updateIssue(context, { ...input, preserveHistory: input.preserveHistory ?? false });
}

export interface IssueInfo {
  deferred?: IssueDeferralData | null;
  routing?: LoadedDeliveryConfig['routing'];
  blockedBy: number[];
  body: string;
  issueNumber: number;
  issueType: string | null;
  labels: string[];
  milestone: number | null;
  parentIssueNumber: number | null;
  points?: number;
  priority?: string;
  projectStatus: string | null;
  state: string;
  title: string;
  url: string;
  worktree: string | null;
}

export async function issueInfo(context: DeliveryContext, issueNumber: number): Promise<IssueInfo> {
  const { clients, config, repo } = context;
  const issue = (await clients.rest.issues.get({ issue_number: issueNumber, owner: repo.owner, repo: repo.repo })).data;
  if ('pull_request' in issue) throw new DeliveryError('Requested issue number is a pull request.');
  const [metadata, relationships, project] = await Promise.all([
    getConfiguredNativeIssueMetadata({
      issueNumber,
      owner: repo.owner,
      repo: repo.repo,
      rest: clients.rest,
      settings: nativeIssueSettingsFromDeliveryConfig(config),
    }),
    getNativeBlockerRelationships({ graphql: clients.graphql, issueNumber, repo }),
    getIssueProjectStatus({
      graphql: clients.graphql,
      issueNodeId: issue.node_id,
      org: config.native.organization,
      ...(context.projectConfiguration ? { configuration: context.projectConfiguration } : {}),
      settings: projectSettingsFromDeliveryConfig(config),
    }),
  ]);
  const info: IssueInfo = {
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
    parentIssueNumber: relationships.parentNumber,
    ...(metadata.points === undefined ? {} : { points: metadata.points }),
    ...(metadata.priority === undefined ? {} : { priority: metadata.priority }),
    projectStatus: project?.status ?? null,
    state: issue.state,
    title: issue.title,
    url: issue.html_url,
    worktree: null,
  };
  return info;
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

export async function listIssueSubissues(context: DeliveryContext, issueNumber: number): Promise<number[]> {
  const issue = (await context.clients.rest.issues.get({ ...context.repo, issue_number: issueNumber })).data;
  if ('pull_request' in issue) throw new DeliveryError('Requested issue number is a pull request.');
  const children = await context.clients.rest.paginate(context.clients.rest.issues.listSubIssues, {
    ...context.repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  return children.map((child) => child.number).sort((left, right) => left - right);
}

export async function readyCheck(context: DeliveryContext, issueNumber: number): Promise<AgentReadinessResult> {
  const info = await issueInfo(context, issueNumber);
  const trackingParent = await hasNativeSubIssues({ issueNumber, repo: context.repo, rest: context.clients.rest });
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
  for (let page = 0; page < 20; page++) {
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
    const body = `WIP capacity override.\n\n\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\`\n\n<!-- ai-delivery:wip-override@1:${digestValue(record)} -->`;
    const publicRecord = validateIssue({ title: 'WIP capacity override', legacyBody: body, draft: true }, false);
    if (publicRecord.failures.length) throw new IssueValidationError(publicRecord.failures);
    await commentIssue(context, { issueNumber, body });
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
