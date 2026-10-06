import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DeliveryConfig, LoadedDeliveryConfig } from './config/deliveryConfig.js';
import { loadDeliveryConfig } from './config/deliveryConfig.js';
import { assertPrivateFile, digestBytes, stableJson } from './delivery/common.js';
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
  title?: string;
}

export async function updateIssue(
  context: DeliveryContext,
  input: UpdateIssueInput,
): Promise<Awaited<ReturnType<typeof issueInfo>>> {
  assertNativeIssueTrackingAdmission(input.issueNumber, context.root);
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
  return issueInfo(context, input.issueNumber);
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
  return { branch: row.branch, path: row.path };
}
