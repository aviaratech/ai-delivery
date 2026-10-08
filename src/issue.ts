import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import type { DeliveryConfig, LoadedDeliveryConfig } from './config/deliveryConfig.js';
import { loadDeliveryConfig } from './config/deliveryConfig.js';
import { assertPrivateFile, digestBytes, stableJson } from './delivery/common.js';
import { digestValue } from './delivery/index.js';
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
import { resolveDeliveryRepo, type RepoCoordinates } from './github/repo.js';
import { assertClean, git, gitCommonDir, gitExitCode, gitRoot, primaryGitRoot } from './git.js';
import { mergePr, preflightReviewRoute, readMergedContinuationTerminal } from './pr.js';
import { evaluateAgentReadiness, type AgentReadinessResult } from './services/agentReadinessService.js';
import { assertDeliveryRuntimeAdmitted } from './services/deliveryAdmission.js';
import {
  addWorktreeEntry,
  assertNativeIssueTrackingAdmission,
  getIssueWorktreeStrict,
  getWorktreeByIssue,
  listWorktreesStrict,
  committedContinuationPlanPath,
  CommittedContinuationPlanSchema,
  pendingCommittedContinuation,
  withCommittedContinuationRegistry,
  writeCommittedContinuationCheckpoint,
  type CommittedContinuationPlan,
  type WorktreeEntry,
} from './services/worktreeRegistry.js';
import { withRuntimeSetupWriter, withWorktreeTransitionWriterAbsent } from './verification.js';
import { authenticatedWorktreeActors, assertNativeWorktreeAcceptance } from './worktreeTransition.js';
import { assertIssueWorktreeLocation, prepareIssueWorktree } from './worktree.js';
import { ensurePrivateDirectoryDurably, writePrivateJsonFileAtomically } from './utils/atomicJson.js';
import { withLock } from './utils/lockfile.js';
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
  const directory = join(gitCommonDir(context.root), 'ai-delivery', 'journals');
  ensurePrivateDirectoryDurably(directory);
  return withLock(join(directory, String(input.issueNumber)), {
    operation: async () => {
      const issue = (await context.clients.rest.issues.get({ ...context.repo, issue_number: input.issueNumber })).data;
      if ('pull_request' in issue || issue.number !== input.issueNumber)
        throw new DeliveryError('Issue comment target is not the requested issue.');
      const matches = [];
      for (let page = 1; ; page += 1) {
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
    },
  });
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
  configuration?: LoadedDeliveryConfig;
  projectConfiguration?: ProjectDeliveryConfiguration;
  config: DeliveryConfig;
  repo: RepoCoordinates;
  root: string;
}

export async function loadDeliveryContext(input: {
  identity: string;
  personalAuth?: boolean;
  repoRoot: string;
  role: 'author' | 'reviewer';
  signal?: AbortSignal;
}): Promise<DeliveryContext> {
  const root = gitRoot(input.repoRoot);
  const loaded = await loadDeliveryConfig(root, {
    ...(input.personalAuth === undefined ? {} : { personalAuth: input.personalAuth }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const config = loaded.config;
  const repo = resolveDeliveryRepo(config, root, loaded.remote);
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
  return { clients, config, configuration: loaded, projectConfiguration, repo, root: primaryGitRoot(root) };
}

function labels(input: readonly string[] | undefined): string[] {
  const selected = input ?? [];
  if (selected.some((label) => !/^(?:area|risk):[^\s:]+$/u.test(label)) || new Set(selected).size !== selected.length) {
    throw new DeliveryError('Issue labels must be unique area:* or risk:* taxonomy labels.');
  }
  return [...selected];
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
  for (const related of new Set(
    [...(input.blockedBy ?? []), input.parentIssueNumber].filter((number): number is number => number !== undefined),
  )) {
    assertNativeIssueTrackingAdmission(related, context.root);
  }
  const created = await clients.rest.issues.create({
    body: input.body ?? '',
    labels: labels(input.labels),
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
  assertNativeIssueTrackingAdmission(input.issueNumber, context.root);
  const { clients, config, repo } = context;
  const acceptedLabels = input.labels === undefined ? undefined : labels(input.labels);
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

function issueSnapshotPath(repoRoot: string, issueNumber: number): string {
  return join(gitCommonDir(repoRoot), 'ai-delivery', 'issue-info', `${issueNumber}.json`);
}

export function cachedIssueInfo(repoRoot: string, issueNumber: number): IssueInfo {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) throw new DeliveryError('Issue number must be positive.');
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(readFileSync(issueSnapshotPath(repoRoot, issueNumber), 'utf8')) as unknown;
  } catch {
    throw new DeliveryError('No readable cached issue snapshot exists.');
  }
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new DeliveryError('Cached issue snapshot is invalid.');
  }
  const { snapshotId, ...content } = snapshot as Record<string, unknown>;
  if (
    content.schemaVersion !== 'ai-delivery.issue-info@1' ||
    typeof content.savedAt !== 'string' ||
    typeof snapshotId !== 'string' ||
    snapshotId !== digestValue(content) ||
    typeof content.issue !== 'object' ||
    content.issue === null ||
    (content.issue as Record<string, unknown>).issueNumber !== issueNumber
  ) {
    throw new DeliveryError('Cached issue snapshot is invalid or foreign.');
  }
  return content.issue as unknown as IssueInfo;
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
    worktree: getWorktreeByIssue(issueNumber, context.root)?.path ?? null,
  };
  const content = {
    issue: info,
    savedAt: new Date().toISOString(),
    schemaVersion: 'ai-delivery.issue-info@1' as const,
  };
  writePrivateJsonFileAtomically(issueSnapshotPath(context.root, issueNumber), {
    ...content,
    snapshotId: digestValue(content),
  });
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
    repoRoot: context.root,
    title: info.title,
    trackingParent,
  });
}

function continuationOperatorBody(plan: CommittedContinuationPlan): string {
  return stableJson({
    schemaVersion: 'ai-delivery.worktree-continuation-authority@1',
    plan,
    acceptedScope: 'the-complete-content-addressed-committed-descendant-plan-and-every-original',
    operationalClosure: 'all-other-launchers-and-writers-are-quiescent-no-unknown-writers',
    maintainedExclusion: 'all-other-launchers-and-writers-remain-excluded-through-apply-and-exact-plan-replay',
    historicalAuthority: 'preservation-only-no-current-verification-review-retirement-or-hold-release',
  });
}
function continuationReviewerBody(plan: CommittedContinuationPlan, authorityCommentId: number): string {
  return stableJson({
    schemaVersion: 'ai-delivery.worktree-continuation-acceptance@1',
    plan,
    authorityCommentId,
    authorityDigest: digestBytes(Buffer.from(continuationOperatorBody(plan))),
    acceptedScope: 'independent-acceptance-of-the-complete-plan-and-maintained-writer-exclusion',
    result: 'approved',
  });
}

async function continueCommittedDescendant(
  context: DeliveryContext,
  issueNumber: number,
  selected: WorktreeEntry,
  runtimeEntryPath?: string,
): Promise<void> {
  if (context.config.roles.author.authSource !== 'personal')
    throw new DeliveryError('Committed continuation requires configured personal author authentication.');
  await withWorktreeTransitionWriterAbsent(context.root, selected.path, () =>
    withCommittedContinuationRegistry(context.root, issueNumber, async (registry) => {
      const original = registry.pending?.plan.row ?? registry.current;
      assertIssueWorktreeLocation(original, context.root);
      assertClean(original.path);
      const actors = await authenticatedWorktreeActors(context);
      const historical = await readMergedContinuationTerminal(context, original, actors.operator);
      const head = {
        sha: git(original.path, 'rev-parse', 'HEAD'),
        tree: git(original.path, 'rev-parse', 'HEAD^{tree}'),
      };
      if (
        head.sha === historical.terminal.headSha ||
        gitExitCode(original.path, 'merge-base', '--is-ancestor', historical.terminal.headSha, head.sha) !== 0
      )
        throw new DeliveryError(
          'Committed continuation requires a strict committed descendant of its exact terminal head.',
        );
      if (!context.configuration)
        throw new DeliveryError('Committed continuation requires discovered current configuration.');
      const readRuntime = () =>
        assertDeliveryRuntimeAdmitted({
          repoRoot: context.root,
          configuration: context.configuration!,
          ...(runtimeEntryPath === undefined ? {} : { runtimeEntryPath }),
        });
      const currentRuntime = await readRuntime();
      const path = committedContinuationPlanPath(context.root, issueNumber, head.sha);
      const stored =
        registry.pending?.plan ??
        (existsSync(path)
          ? CommittedContinuationPlanSchema.parse(
              (JSON.parse(assertPrivateFile(path).toString('utf8')) as { plan: unknown }).plan,
            )
          : undefined);
      const { prNumber: _priorPr, ...retained } = original;
      const content = {
        schemaVersion: 'ai-delivery.committed-continuation-plan@1' as const,
        repository: context.config.repository,
        repoRoot: context.root,
        configDigest: context.configuration.configDigest,
        currentRuntime,
        row: original,
        replacement: {
          ...retained,
          type: 'issue' as const,
          issueNumber,
          identity: context.config.roles.author.identity,
          status: 'active' as const,
          updatedAt: stored?.replacement.updatedAt ?? new Date().toISOString(),
        },
        head,
        terminalHead: { sha: historical.terminal.headSha, tree: historical.terminal.headTree },
        terminalMergeId: historical.terminal.mergeId,
        operator: actors.operator,
        reviewerActor: actors.reviewerActor,
        preserved: [...historical.preserved, registry.ownerWitness],
      };
      const plan = CommittedContinuationPlanSchema.parse({ ...content, planId: digestValue(content) });
      if (stored && stableJson(stored) !== stableJson(plan))
        throw new DeliveryError('Committed continuation approved source, configuration or custody plan drifted.');
      registry.prepare();
      writeCommittedContinuationCheckpoint(path, {
        plan,
        operatorBody: continuationOperatorBody(plan),
        reviewerBody: continuationReviewerBody(plan, 0),
      });
      let ids = registry.pending && {
        authorityCommentId: registry.pending.authorityCommentId,
        acceptanceCommentId: registry.pending.acceptanceCommentId,
      };
      if (!ids) {
        const comments = [];
        for (let page = 1; ; page += 1) {
          const batch = (
            await context.clients.rest.issues.listComments({
              ...context.repo,
              issue_number: issueNumber,
              per_page: 100,
              page,
            })
          ).data;
          comments.push(...batch);
          if (batch.length < 100) break;
        }
        const authorities = comments.filter(
          (comment) =>
            comment.body === continuationOperatorBody(plan) &&
            comment.user?.type === 'User' &&
            comment.user.login.toLowerCase() === actors.operator.actorLogin.toLowerCase() &&
            `user:${String(comment.user.id)}` === actors.operator.credentialIdentity,
        );
        const authority = authorities.length === 1 ? authorities[0] : undefined;
        const acceptances = authority
          ? comments.filter(
              (comment) =>
                comment.body === continuationReviewerBody(plan, authority.id) &&
                comment.user?.type === 'Bot' &&
                comment.user.login.toLowerCase() === actors.reviewerActor.toLowerCase(),
            )
          : [];
        if (!authority || acceptances.length !== 1 || !acceptances[0])
          throw new DeliveryError(
            `Committed continuation requires exact native operator and configured reviewer-App acceptance. Saved plan: ${path}`,
          );
        ids = { authorityCommentId: authority.id, acceptanceCommentId: acceptances[0].id };
      }
      const assertAuthority = () =>
        assertNativeWorktreeAcceptance(context, {
          repository: plan.repository,
          subject: issueNumber,
          operator: plan.operator,
          reviewerActor: plan.reviewerActor,
          ...ids,
          operatorBody: continuationOperatorBody(plan),
          reviewerBody: continuationReviewerBody(plan, ids.authorityCommentId),
          revokedBody: stableJson({
            schemaVersion: 'ai-delivery.worktree-continuation-revocation@1',
            planId: plan.planId,
            authorityCommentId: ids.authorityCommentId,
          }),
        });
      const assertPreservedSource = async () => {
        const issue = (await context.clients.rest.issues.get({ ...context.repo, issue_number: issueNumber })).data;
        if (issue.state !== 'open' || !(await readyCheck(context, issueNumber)).ready)
          throw new DeliveryError('Committed continuation requires an open, ready unfinished issue.');
        assertIssueWorktreeLocation(original, context.root);
        assertClean(original.path);
        if (
          git(original.path, 'rev-parse', 'HEAD') !== plan.head.sha ||
          git(original.path, 'rev-parse', 'HEAD^{tree}') !== plan.head.tree
        )
          throw new DeliveryError('Committed continuation source changed during exact-plan recovery.');
        const fresh = await readMergedContinuationTerminal(context, original, plan.operator);
        if (
          fresh.terminal.mergeId !== plan.terminalMergeId ||
          stableJson([...fresh.preserved, registry.ownerWitness]) !== stableJson(plan.preserved)
        )
          throw new DeliveryError('Committed continuation original lineage changed.');
        await assertAuthority();
        if (stableJson(await readRuntime()) !== stableJson(plan.currentRuntime))
          throw new DeliveryError('Committed continuation runtime admission changed during exact-plan recovery.');
      };
      await assertPreservedSource();
      registry.begin(plan, ids);
      await assertPreservedSource();
      registry.commit();
      await assertPreservedSource();
      registry.complete();
    }),
  );
}

export async function developIssue(
  context: DeliveryContext,
  issueNumber: number,
  runtimeEntryPath?: string,
): Promise<{ path: string; branch: string }> {
  await preflightReviewRoute(context, undefined, undefined, 'development');
  const initialIssue = (await context.clients.rest.issues.get({ issue_number: issueNumber, ...context.repo })).data;
  if (initialIssue.state === 'closed')
    throw new DeliveryError(`Issue #${issueNumber} is closed. Reopen it before developing.`);
  const readiness = await readyCheck(context, issueNumber);
  if (!readiness.ready)
    throw new DeliveryError(
      `Issue #${issueNumber} is not ready: ${readiness.failures.map((f) => f.message).join('; ')}`,
    );
  const registered = listWorktreesStrict(context.root).filter(
    (entry) => entry.type === 'issue' && entry.issueNumber === issueNumber,
  );
  if (registered.length > 1) throw new DeliveryError('Issue has duplicate worktree registry rows.');
  const pending = pendingCommittedContinuation(issueNumber, context.root);
  const selected = registered[0];
  if (
    pending ||
    (selected?.status === 'merged' &&
      context.clients.authSource === 'personal' &&
      !existsSync(
        join(
          gitCommonDir(selected.path),
          'ai-delivery',
          'merges',
          String(issueNumber),
          `${git(selected.path, 'rev-parse', 'HEAD')}.json`,
        ),
      ))
  ) {
    if (!selected) throw new DeliveryError('Committed continuation canonical custody is missing.');
    await continueCommittedDescendant(context, issueNumber, selected, runtimeEntryPath);
  } else if (selected?.status === 'merged') {
    const previous = getIssueWorktreeStrict(issueNumber, context.root);
    if (previous.identity !== context.config.roles.author.identity || previous.prNumber === undefined)
      throw new DeliveryError('Merged continuation requires the same preparing owner and exact prior PR.');
    assertIssueWorktreeLocation(previous, context.root);
    assertClean(previous.path);
    const head = git(previous.path, 'rev-parse', 'HEAD');
    if (!existsSync(join(gitCommonDir(previous.path), 'ai-delivery', 'merges', String(issueNumber), `${head}.json`)))
      throw new DeliveryError('Merged continuation lacks its exact terminal merge receipt.');
    await withRuntimeSetupWriter(previous.path, async (writer) => {
      writer.assertQuiescent();
      // Existing terminal recovery validates the historical run, publication, intent and remote merge.
      await mergePr(context, { issueNumber, prNumber: previous.prNumber! });
      const currentIssue = (await context.clients.rest.issues.get({ issue_number: issueNumber, ...context.repo })).data;
      if (currentIssue.state !== 'open' || !(await readyCheck(context, issueNumber)).ready)
        throw new DeliveryError('Merged continuation requires an open, ready unfinished issue.');
      assertIssueWorktreeLocation(previous, context.root);
      assertClean(previous.path);
      if (git(previous.path, 'rev-parse', 'HEAD') !== head)
        throw new DeliveryError('Merged continuation source changed during terminal readback.');
      const { prNumber: _priorPr, ...sameOwner } = previous;
      await addWorktreeEntry({ ...sameOwner, status: 'active', updatedAt: new Date().toISOString() }, context.root);
      writer.assertQuiescent();
    });
  }
  const row = await prepareIssueWorktree({
    ...(context.configuration?.remote ? { remote: context.configuration.remote } : {}),
    identity: context.config.roles.author.identity,
    issueNumber,
    repoRoot: context.root,
  });
  const issue = (await context.clients.rest.issues.get({ issue_number: issueNumber, ...context.repo })).data;
  await syncIssueProjectStatus({
    graphql: context.clients.graphql,
    issueNodeId: issue.node_id,
    org: context.config.native.organization,
    ...(context.projectConfiguration ? { configuration: context.projectConfiguration } : {}),
    settings: projectSettingsFromDeliveryConfig(context.config),
    status: 'In Progress',
  });
  await journalIssueStart(context, issueNumber);
  return { branch: row.branch, path: row.path };
}
