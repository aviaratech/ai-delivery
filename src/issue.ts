import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DeliveryConfig, LoadedDeliveryConfig } from './config/deliveryConfig.js';
import { loadDeliveryConfig } from './config/deliveryConfig.js';
import { digestValue } from './delivery/index.js';
import { DeliveryError } from './errors.js';
import { createDeliveryGitHubClients, type GitHubClients } from './github/client.js';
import {
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
import { gitCommonDir, gitRoot, primaryGitRoot } from './git.js';
import { evaluateAgentReadiness, type AgentReadinessResult } from './services/agentReadinessService.js';
import { assertNoForeignIssueWorktree, getWorktreeByIssue } from './services/worktreeRegistry.js';
import { prepareIssueWorktree } from './worktree.js';
import { writePrivateJsonFileAtomically } from './utils/atomicJson.js';

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
}): Promise<DeliveryContext> {
  const root = gitRoot(input.repoRoot);
  const loaded = await loadDeliveryConfig(
    root,
    input.personalAuth === undefined ? {} : { personalAuth: input.personalAuth },
  );
  const config = loaded.config;
  const repo = resolveDeliveryRepo(config, root, loaded.remote);
  const clients = await createDeliveryGitHubClients({
    config,
    identity: input.identity,
    ...(input.personalAuth ? { personalAuth: { enabled: true as const } } : {}),
    role: input.role,
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
    assertNoForeignIssueWorktree(related, context.root);
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

export interface UpdateIssueInput {
  blockedBy?: number[];
  body?: string;
  issueNumber: number;
  issueType?: string;
  labels?: string[];
  milestone?: number | null;
  parentIssueNumber?: number | null;
  points?: number;
  priority?: string;
  state?: 'open' | 'closed';
  title?: string;
}

export async function updateIssue(
  context: DeliveryContext,
  input: UpdateIssueInput,
): Promise<Awaited<ReturnType<typeof issueInfo>>> {
  assertNoForeignIssueWorktree(input.issueNumber, context.root);
  const { clients, config, repo } = context;
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
    const related = new Set([
      current.parentNumber,
      ...current.blockers.map((blocker) => blocker.number),
      input.parentIssueNumber,
      ...(input.blockedBy ?? []),
    ]);
    for (const number of related) {
      if (number !== null && number !== undefined) assertNoForeignIssueWorktree(number, context.root);
    }
  }
  if (input.blockedBy !== undefined)
    await resolveNativeRelationshipTargets({
      blockers: input.blockedBy,
      repo,
      rest: clients.rest,
    });
  await clients.rest.issues.update({
    issue_number: input.issueNumber,
    owner: repo.owner,
    repo: repo.repo,
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.issueType === undefined ? {} : { type: input.issueType }),
    ...(input.labels === undefined ? {} : { labels: labels(input.labels) }),
    ...(input.milestone === undefined ? {} : { milestone: input.milestone }),
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(input.title === undefined ? {} : { title: input.title }),
  });
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
  return issueInfo(context, input.issueNumber);
}

/** Complete the native tracking and Project state of an issue created before an interrupted response. */
export async function resumeCreatedIssue(context: DeliveryContext, input: UpdateIssueInput): Promise<IssueInfo> {
  const info = await updateIssue(context, input);
  const issue = (await context.clients.rest.issues.get({ issue_number: input.issueNumber, ...context.repo })).data;
  await syncIssueProjectStatus({
    graphql: context.clients.graphql,
    issueNodeId: issue.node_id,
    org: context.config.native.organization,
    ...(context.projectConfiguration ? { configuration: context.projectConfiguration } : {}),
    settings: projectSettingsFromDeliveryConfig(context.config),
    status: info.blockedBy.length > 0 ? 'Blocked' : 'Todo',
  });
  return issueInfo(context, input.issueNumber);
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

export async function developIssue(
  context: DeliveryContext,
  issueNumber: number,
): Promise<{ path: string; branch: string }> {
  const initialIssue = (await context.clients.rest.issues.get({ issue_number: issueNumber, ...context.repo })).data;
  if (initialIssue.state === 'closed')
    throw new DeliveryError(`Issue #${issueNumber} is closed. Reopen it before developing.`);
  const readiness = await readyCheck(context, issueNumber);
  if (!readiness.ready)
    throw new DeliveryError(
      `Issue #${issueNumber} is not ready: ${readiness.failures.map((f) => f.message).join('; ')}`,
    );
  const row = await prepareIssueWorktree({
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
  return { branch: row.branch, path: row.path };
}
