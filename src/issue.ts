import { z } from 'zod';

import type {
  DeliveryConfig,
  GitHubDeliveryConfig,
  LoadedDeliveryConfig,
  LoadedGitHubConfig,
} from './config/deliveryConfig.js';
import { loadDeliveryConfig } from './config/deliveryConfig.js';
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
  type ProjectDeliveryConfiguration,
  projectSettingsFromDeliveryConfig,
  syncIssueProjectStatus,
} from './github/projectDelivery.js';
import {
  getNativeBlockerRelationships,
  hasNativeSubIssues,
  replaceBlockedBy,
  replaceParentIssue,
  resolveNativeRelationshipTargets,
} from './github/relationships.js';
import { type RepoCoordinates } from './github/repo.js';
import { evaluateAgentReadiness, type AgentReadinessResult } from './services/agentReadinessService.js';
import { JournalInputSchema, renderJournal, type JournalInput } from './issueJournal.js';

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

export interface CreateIssueInput {
  blockedBy?: number[];
  body?: string;
  issueType?: string;
  labels?: string[];
  milestone?: number;
  parentIssueNumber?: number;
  points?: number;
  priority?: string;
  title: string;
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
}> {
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
    if ((input.blockedBy?.length ?? 0) > 0)
      await replaceBlockedBy({
        blockers: input.blockedBy ?? [],
        graphql: clients.graphql,
        issueNumber,
        repo,
        rest: clients.rest,
      });
    await syncIssueProjectStatus({
      graphql: clients.graphql,
      issueNodeId: created.data.node_id,
      org: config.native.organization,
      ...(context.projectConfiguration ? { configuration: context.projectConfiguration } : {}),
      settings: projectSettingsFromDeliveryConfig(config),
      status: targets.unresolvedBlockers.length > 0 ? 'Blocked' : 'Todo',
    });
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
  state: z.enum(['open', 'closed']),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
  type: z.object({ name: z.string() }).nullable().optional(),
  html_url: z.url(),
  updated_at: z.iso.datetime({ offset: true }),
});
export interface ListedTrackingIssue {
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

async function issueFieldPages(
  context: DeliveryContext,
  route: string,
  parameters: Record<string, unknown>,
): Promise<unknown[]> {
  const values: unknown[] = [];
  const seenPages = new Set<string>();
  for (let page = 1; ; page += 1) {
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
    if (response.data.length < 100) return values;
  }
}

/** A bounded GitHub page; local filters can produce an empty page with a nextPage. */
export async function listIssues(
  context: DeliveryContext,
  input: ListIssuesInput,
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
    raw = (
      await context.clients.rest.issues.listForRepo({
        ...context.repo,
        state: input.state ?? 'open',
        ...(input.labels === undefined ? {} : { labels: input.labels.join(',') }),
        ...(input.updatedSince === undefined ? {} : { since: input.updatedSince }),
        page,
        per_page: perPage,
        sort: 'updated',
        direction: 'desc',
        headers: { 'X-GitHub-Api-Version': NATIVE_ISSUE_API_VERSION },
      })
    ).data;
    nextPage = raw.length === perPage ? page + 1 : null;
  }
  const catalog = z
    .array(FieldCatalogEntry)
    .parse(await issueFieldPages(context, 'GET /orgs/{org}/issue-fields', { org: context.config.native.organization }));
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
      org: context.config.native.organization,
      ...(context.projectConfiguration ? { configuration: context.projectConfiguration } : {}),
      settings: projectSettingsFromDeliveryConfig(context.config),
    });
    if (input.projectStatus !== undefined && (project?.status ?? null) !== input.projectStatus) continue;
    const fields: ListedTrackingIssue['fields'] = Object.fromEntries(catalog.map((field) => [field.name, null]));
    const values = z.array(FieldValueEntry).parse(
      await issueFieldPages(context, 'GET /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values', {
        ...context.repo,
        issue_number: current.number,
      }),
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

export interface UpdateIssueInput {
  blockedBy?: number[];
  body?: string;
  issueNumber: number;
  issueType?: string;
  labels?: string[];
  milestone?: number | null;
  parentIssueNumber?: number | null;
  park?: true;
  points?: number;
  priority?: string;
  state?: 'open' | 'closed';
  preserveHistory?: boolean;
  closeReason?: 'completed' | 'not_planned' | 'duplicate';
  supersededBy?: number;
  title?: string;
}

export interface UpdateIssueResult extends IssueInfo {
  historyComment?: IssueCommentReadback;
  closure?: IssueClosureReadback & { supersededBy: number | null; comment: IssueCommentReadback };
}

export async function updateIssue(context: DeliveryContext, input: UpdateIssueInput): Promise<UpdateIssueResult> {
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
  let priorContent: { title: string; body: string } | undefined;
  if (input.preserveHistory === true && (input.title !== undefined || input.body !== undefined)) {
    const current = (await clients.rest.issues.get({ ...repo, issue_number: input.issueNumber })).data;
    if (current.number !== input.issueNumber || 'pull_request' in current)
      throw new DeliveryError('History target is not the requested issue.');
    const prior = { title: current.title, body: current.body ?? '' };
    if (
      (input.title !== undefined && input.title !== prior.title) ||
      (input.body !== undefined && input.body !== prior.body)
    ) {
      const body = renderIssueHistory(prior.title, prior.body);
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
      throw new DeliveryError(
        'Issue content changed after history readback; retry against the current title and body.',
      );
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
  if (input.blockedBy !== undefined)
    await replaceBlockedBy({
      blockers: input.blockedBy,
      graphql: clients.graphql,
      issueNumber: input.issueNumber,
      repo,
      rest: clients.rest,
    });
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
    (input.preserveHistory === true || closeReason !== undefined) &&
    ((input.title !== undefined && readback.title !== input.title) ||
      (input.body !== undefined && readback.body !== input.body) ||
      (input.state !== undefined && readback.state !== input.state))
  )
    throw new DeliveryError('Issue update readback disagrees with the requested content or state.');
  return {
    ...readback,
    ...(historyComment === undefined ? {} : { historyComment }),
    ...(closure === undefined || closureComment === undefined
      ? {}
      : { closure: { ...closure, supersededBy: input.supersededBy ?? null, comment: closureComment } }),
  };
}

/** Complete the native tracking and Project state of an issue created before an interrupted response. */
export async function resumeCreatedIssue(context: DeliveryContext, input: UpdateIssueInput): Promise<IssueInfo> {
  return updateIssue(context, input);
}

export interface IssueInfo {
  routing?: LoadedDeliveryConfig['routing'];
  blockedBy: number[];
  body: string;
  issueNumber: number;
  issueType: string | null;
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
    ...(context.configuration ? { routing: context.configuration.routing } : {}),
    blockedBy: relationships.blockers.filter((blocker) => blocker.state === 'OPEN').map((blocker) => blocker.number),
    body: issue.body ?? '',
    issueNumber,
    issueType: issue.type?.name ?? null,
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
