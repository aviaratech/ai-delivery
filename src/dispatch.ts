import { existsSync, readFileSync } from 'node:fs';

import { loadDeliveryConfig, loadDeliverySettings, readDeliveryOverrides } from './config/deliveryConfig.js';
import { resolveRepoFromRemote } from './github/repo.js';
import { assertRepositoryClassificationCurrent } from './delivery/index.js';
import { DeliveryError } from './errors.js';
import { assertClean, defaultBaseRef, gitCommonDir, gitExitCode, gitRoot, primaryGitRoot } from './git.js';
import { createDeliveryGitHubClients } from './github/client.js';
import { evaluateCommandIdentityPolicy } from './github/commandIdentityPolicy.js';
import { resolveNativeRelationshipTargets } from './github/relationships.js';
import {
  cachedIssueInfo,
  CreatedTrackingIssueError,
  createIssue,
  developIssue,
  issueInfo,
  loadDeliveryContext,
  readyCheck,
  resumeCreatedIssue,
  updateIssue,
  type CreateIssueInput,
  type UpdateIssueInput,
} from './issue.js';
import { finishIssue, mergePr, preflightReviewRoute, prInfo, publishPr, submitFormalReview } from './pr.js';
import { parseReviewArtifact, reviewArtifactApproval, savePrepublicationArtifact } from './review.js';
import { evaluateAgentReadiness } from './services/agentReadinessService.js';
import { assertDeliveryRuntimeAdmitted } from './services/deliveryAdmission.js';
import { getIssueWorktreeStrict, listWorktreesStrict } from './services/worktreeRegistry.js';
import {
  createIssuePhaseEvidence,
  loadVerifiedRun,
  verifyIssue,
  type VerificationResourceBounds,
} from './verification.js';
import { prepareStandaloneWorktree } from './worktree.js';
import { getAiDeliveryMcpTool, type AiDeliveryMcpToolName } from './mcp/tools.js';

export interface ExecutionContext {
  identity?: string;
  personalAuth?: boolean;
  repo?: string;
  repoRoot: string;
  runtimeEntryPath?: string;
  signal?: AbortSignal;
}

const MUTATING_TOOLS = new Set<AiDeliveryMcpToolName>([
  'issue_create',
  'issue_start',
  'issue_update',
  'issue_develop',
  'issue_verify',
  'issue_pr_create',
  'issue_pr_review',
  'issue_pr_merge',
  'issue_finish',
  'issue_worktree_create',
]);

function requiredNumber(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new DeliveryError(`${key} must be positive.`);
  return value;
}
function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  return typeof input[key] === 'string' ? input[key] : undefined;
}
function requireString(input: Record<string, unknown>, key: string): string {
  const value = optionalString(input, key);
  if (!value?.trim()) throw new DeliveryError(`${key} is required.`);
  return value;
}
/** @internal Preserve every accepted tracking field when completing a partially created issue. */
export function resumedIssueUpdate(input: Record<string, unknown>): UpdateIssueInput {
  return {
    issueNumber: requiredNumber(input, 'issueNumber'),
    ...(input.body === undefined ? {} : { body: requireString(input, 'body') }),
    ...(input.issueType === undefined ? {} : { issueType: requireString(input, 'issueType') }),
    ...(input.points === undefined ? {} : { points: Number(input.points) }),
    ...(input.priority === undefined ? {} : { priority: requireString(input, 'priority') }),
    ...(input.title === undefined ? {} : { title: requireString(input, 'title') }),
    ...(input.labels === undefined ? {} : { labels: input.labels as string[] }),
    ...(input.milestone === undefined ? {} : { milestone: Number(input.milestone) }),
    ...(input.parentIssueNumber === undefined ? {} : { parentIssueNumber: Number(input.parentIssueNumber) }),
    ...(input.blockedBy === undefined ? {} : { blockedBy: input.blockedBy as number[] }),
  };
}
async function identityFor(input: ExecutionContext, commandName: string): Promise<string> {
  const config = await loadDeliverySettings(gitRoot(input.repoRoot));
  const identity = input.identity ?? '';
  const policy = evaluateCommandIdentityPolicy({
    commandName,
    deliveryConfig: config,
    identity,
    ...(input.personalAuth === undefined ? {} : { personalAuth: input.personalAuth }),
  });
  if (policy.error) throw new DeliveryError(policy.error);
  return identity || config.roles.author.identity;
}

function assertRepositorySelector(input: Record<string, unknown>, execution: ExecutionContext): void {
  const selector = input.repo ?? execution.repo;
  if (selector === undefined) return;
  const root = gitRoot(execution.repoRoot);
  const selected = resolveRepoFromRemote(root, readDeliveryOverrides(root).overrides.remote);
  const configured = `${selected.owner}/${selected.repo}`;
  if (typeof selector !== 'string' || selector.toLowerCase() !== configured.toLowerCase()) {
    throw new DeliveryError('Repository selector must match the configured repository for this Git checkout.');
  }
}

export async function contextFor(input: ExecutionContext, commandName: string, role: 'author' | 'reviewer' = 'author') {
  assertRepositorySelector({}, input);
  const identity = await identityFor(input, commandName);
  return loadDeliveryContext({
    identity,
    ...(input.personalAuth === undefined ? {} : { personalAuth: input.personalAuth }),
    repoRoot: input.repoRoot,
    role,
  });
}

function sourceRootFor(name: AiDeliveryMcpToolName, input: Record<string, unknown>, execution: ExecutionContext) {
  if (
    name !== 'issue_verify' &&
    name !== 'issue_pr_create' &&
    name !== 'issue_pr_review' &&
    name !== 'issue_pr_merge' &&
    name !== 'issue_finish' &&
    !(name === 'issue_pr_info' && input.issueNumber !== undefined)
  )
    return undefined;
  const primary = primaryGitRoot(execution.repoRoot);
  const requested = gitRoot(execution.repoRoot);
  const issueNumber = requiredNumber(input, 'issueNumber');
  if (
    name === 'issue_finish' &&
    !listWorktreesStrict(primary).some((row) => row.type === 'issue' && row.issueNumber === issueNumber)
  )
    return primary;
  const row = getIssueWorktreeStrict(issueNumber, primary);
  if (requested !== primary && requested !== row.path) {
    throw new DeliveryError('Source-bound operations require the primary or exact registered issue checkout.');
  }
  // Terminal owners validate retained immutable receipts and the remote result.
  // A removed merged checkout must not be imported or reconstructed here.
  if ((name === 'issue_finish' || name === 'issue_pr_merge') && row.status === 'merged' && !existsSync(row.path)) {
    return primary;
  }
  if (gitCommonDir(row.path) !== gitCommonDir(primary)) {
    throw new DeliveryError('Registered issue source must belong to the primary Git repository.');
  }
  assertClean(row.path);
  return row.path;
}

/** @internal Keep CLI and MCP start routing on the same native lifecycle owner. */
export async function startTrackedIssue(
  context: Awaited<ReturnType<typeof loadDeliveryContext>>,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const knownIssue = input.issueNumber === undefined ? undefined : requiredNumber(input, 'issueNumber');
  if (input.resumeCreated === true && (knownIssue === undefined || input.develop !== true)) {
    throw new DeliveryError('Resume of a known created issue requires issueNumber and develop=true.');
  }
  if (knownIssue !== undefined && input.resumeCreated !== true) {
    const row = await developIssue(context, knownIssue);
    const title = (await issueInfo(context, knownIssue)).title;
    return {
      issueNumber: knownIssue,
      mode: 'existing-issue',
      title,
      branch: row.branch,
      path: row.path,
      worktreePath: row.path,
    };
  }
  const request = optionalString(input, 'request');
  const title = optionalString(input, 'title') ?? requireString(input, 'request');
  const points = input.points === undefined ? 2 : requiredNumber(input, 'points');
  const tracking: CreateIssueInput = {
    body: optionalString(input, 'body') ?? request ?? title,
    title,
    points,
    ...(input.issueType === undefined ? {} : { issueType: requireString(input, 'issueType') }),
    ...(input.priority === undefined ? {} : { priority: requireString(input, 'priority') }),
    ...(input.blockedBy === undefined ? {} : { blockedBy: input.blockedBy as number[] }),
    ...(input.labels === undefined ? {} : { labels: input.labels as string[] }),
    ...(input.milestone === undefined ? {} : { milestone: Number(input.milestone) }),
    ...(input.parentIssueNumber === undefined ? {} : { parentIssueNumber: Number(input.parentIssueNumber) }),
  };
  if (input.develop === true) await preflightStartDevelopment(context, tracking);
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  const createdNotStarted = (
    createdIssue: { number: number; title: string; url: string },
    phase: 'tracking' | 'development',
    error: unknown,
  ) => ({
    schemaVersion: 'ai-delivery.issue-start-registration@1',
    status: 'created-not-started',
    provider: 'github',
    repository,
    identity: context.config.roles.author.identity,
    createdIssue,
    failure: { phase, message: error instanceof Error ? error.message : String(error) },
    safeResume: {
      tool: 'issue_start',
      arguments: {
        ...tracking,
        ...(input.repo === undefined ? {} : { repo: input.repo }),
        issueNumber: createdIssue.number,
        develop: true,
        resumeCreated: true,
      },
    },
  });
  let created: { number: number; title: string; url: string };
  if (knownIssue !== undefined) {
    const existing = (await context.clients.rest.issues.get({ ...context.repo, issue_number: knownIssue })).data;
    if (existing.number !== knownIssue || 'pull_request' in existing) {
      throw new DeliveryError('Known-created issue readback disagrees with the requested issue.');
    }
    created = { number: existing.number, title: existing.title, url: existing.html_url };
    try {
      await resumeCreatedIssue(context, resumedIssueUpdate(input));
    } catch (error) {
      return createdNotStarted(created, 'tracking', error);
    }
  } else {
    try {
      created = (await createIssue(context, tracking)).created;
    } catch (error) {
      if (input.develop === true && error instanceof CreatedTrackingIssueError) {
        return createdNotStarted(error.created, 'tracking', error);
      }
      throw error;
    }
  }
  if (input.develop === true) {
    try {
      const row = await developIssue(context, created.number);
      return {
        schemaVersion: 'ai-delivery.issue-start-registration@1',
        status: 'started',
        provider: 'github',
        repository,
        identity: context.config.roles.author.identity,
        issue: created,
        branch: row.branch,
        worktreePath: row.path,
      };
    } catch (error) {
      return createdNotStarted(created, 'development', error);
    }
  }
  return { issueNumber: created.number, issueUrl: created.url, mode: 'created-issue', title: created.title };
}

async function preflightStartDevelopment(
  context: Awaited<ReturnType<typeof loadDeliveryContext>>,
  tracking: CreateIssueInput,
): Promise<void> {
  const targets = await resolveNativeRelationshipTargets({
    blockers: tracking.blockedBy ?? [],
    ...(tracking.parentIssueNumber === undefined ? {} : { parentIssueNumber: tracking.parentIssueNumber }),
    repo: context.repo,
    rest: context.clients.rest,
  });
  const readiness = evaluateAgentReadiness({
    blockedBy: targets.unresolvedBlockers,
    body: tracking.body ?? '',
    ...(tracking.points === undefined ? {} : { points: tracking.points }),
    repoRoot: context.root,
    title: tracking.title,
  });
  if (!readiness.ready) {
    throw new DeliveryError(
      `New issue is not ready: ${readiness.failures.map((failure) => failure.message).join('; ')}`,
    );
  }
  listWorktreesStrict(context.root);
  if (
    gitExitCode(context.root, 'rev-parse', '--verify', defaultBaseRef(context.root, context.configuration?.remote)) !==
    0
  ) {
    throw new DeliveryError('Default base ref is missing before tracked issue creation.');
  }
  await preflightReviewRoute(context, undefined, undefined, 'development');
}

function scratchStart(input: Record<string, unknown>, execution: ExecutionContext, identity: string, remote?: string) {
  const title = (optionalString(input, 'title') ?? requireString(input, 'request'))
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 90)
    .trim();
  const branchOverride = optionalString(input, 'branch');
  const source = (branchOverride ?? optionalString(input, 'request') ?? title).replace(/\//gu, '-');
  const slug =
    source
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 56)
      .replace(/-+$/gu, '') || 'scratch';
  const branch = branchOverride ?? `scratch/${slug}`;
  const name = `scratch-${slug}`;
  return prepareStandaloneWorktree({
    branch,
    identity,
    name,
    repoRoot: execution.repoRoot,
    ...(remote ? { remote } : {}),
  }).then((row) => ({
    mode: 'scratch' as const,
    title,
    branch: row.branch,
    worktreePath: row.path,
  }));
}

export async function executeTool(
  name: AiDeliveryMcpToolName,
  raw: unknown,
  execution: ExecutionContext,
): Promise<unknown> {
  const definition = getAiDeliveryMcpTool(name);
  if (!definition) throw new DeliveryError(`Unknown ai-delivery tool ${name}.`);
  const input = definition.inputSchema.parse(raw) as Record<string, unknown>;
  assertRepositorySelector(input, execution);
  if (name === 'issue_info' && input.cached === true)
    return cachedIssueInfo(execution.repoRoot, requiredNumber(input, 'issueNumber'));
  const commands: Record<AiDeliveryMcpToolName, string> = {
    issue_create: 'create',
    issue_start: 'start',
    issue_update: 'update',
    issue_info: 'info',
    issue_ready_check: 'ready:check',
    issue_develop: 'develop',
    issue_verify: 'verify',
    issue_pr_create: 'pr:create',
    issue_pr_info: 'pr:info',
    issue_pr_review: 'pr:review',
    issue_pr_merge: 'pr:merge',
    issue_finish: 'finish',
    issue_worktree_create: 'worktree:create',
  };
  const requestedIdentity = name === 'issue_pr_review' ? optionalString(input, 'identity') : undefined;
  const selectedExecution = requestedIdentity === undefined ? execution : { ...execution, identity: requestedIdentity };
  const sourceRoot = sourceRootFor(name, input, execution);
  const context = await contextFor(
    sourceRoot === undefined ? selectedExecution : { ...selectedExecution, repoRoot: sourceRoot },
    commands[name],
    name === 'issue_pr_review' ? 'reviewer' : 'author',
  );
  let controllerConfiguration = context.configuration;
  if (sourceRoot !== undefined) {
    const primary = primaryGitRoot(execution.repoRoot);
    const settings = await loadDeliverySettings(primary);
    if (settings.repository.toLowerCase() !== context.config.repository.toLowerCase()) {
      throw new DeliveryError('Registered issue source and primary controller must select the same repository.');
    }
    const authorClients =
      name === 'issue_pr_review'
        ? await createDeliveryGitHubClients({
            config: context.config,
            identity: context.config.roles.author.identity,
            ...(execution.personalAuth ? { personalAuth: { enabled: true as const } } : {}),
            role: 'author',
          })
        : context.clients;
    // Discover the controller's metadata through the configured source author,
    // while retaining the controller's policy, settings and admission digest.
    controllerConfiguration = await loadDeliveryConfig(primary, { clients: authorClients });
  }
  if (MUTATING_TOOLS.has(name) && input.dryRun !== true) {
    await assertDeliveryRuntimeAdmitted({
      ...execution,
      repoRoot: sourceRoot === undefined ? execution.repoRoot : primaryGitRoot(execution.repoRoot),
      ...(controllerConfiguration === undefined ? {} : { configuration: controllerConfiguration }),
    });
  }
  if (sourceRoot !== undefined && (name === 'issue_pr_create' || name === 'issue_pr_review')) {
    if (context.configuration === undefined)
      throw new DeliveryError('Source-bound operation requires discovered candidate configuration.');
    const run = loadVerifiedRun(sourceRoot, requiredNumber(input, 'issueNumber'));
    assertRepositoryClassificationCurrent({
      classification: run.classification,
      configDigest: context.configuration.configDigest,
      policySourcePath: context.config.policy.module,
      repoRoot: sourceRoot,
    });
  }
  switch (name) {
    case 'issue_create': {
      return createIssue(context, input as unknown as CreateIssueInput);
    }
    case 'issue_start': {
      const identity = await identityFor(execution, 'start');
      if (input.resumeCreated === true && (input.issueNumber === undefined || input.develop !== true)) {
        throw new DeliveryError('Resume of a known created issue requires issueNumber and develop=true.');
      }
      if (input.scratch === true) {
        if (input.issueNumber !== undefined || input.develop === true || input.resumeCreated === true) {
          throw new DeliveryError('Scratch worktree cannot claim a tracked issue.');
        }
        await preflightReviewRoute(context, undefined, undefined, 'development');
        return scratchStart(input, execution, identity, context.configuration?.remote);
      }
      return startTrackedIssue(context, input);
    }
    case 'issue_update': {
      return updateIssue(context, input as unknown as UpdateIssueInput);
    }
    case 'issue_info': {
      if (input.cached === true) return cachedIssueInfo(execution.repoRoot, requiredNumber(input, 'issueNumber'));
      return issueInfo(context, requiredNumber(input, 'issueNumber'));
    }
    case 'issue_ready_check': {
      return readyCheck(context, requiredNumber(input, 'issueNumber'));
    }
    case 'issue_develop': {
      const issueNumber = requiredNumber(input, 'issueNumber');
      const result = await developIssue(context, issueNumber);
      if (input.assignee !== undefined)
        await context.clients.rest.issues.addAssignees({
          ...context.repo,
          issue_number: issueNumber,
          assignees: [requireString(input, 'assignee')],
        });
      return result;
    }
    case 'issue_verify': {
      const issueNumber = requiredNumber(input, 'issueNumber');
      const root = primaryGitRoot(execution.repoRoot);
      const row = getIssueWorktreeStrict(issueNumber, root);
      const run = await verifyIssue({
        personalAuth:
          context.clients.authSource === 'personal' && context.config.roles.author.authSource !== 'personal',
        issueNumber,
        repoRoot: row.path,
        ...(execution.signal === undefined ? {} : { signal: execution.signal }),
        ...(input.resourceBounds === undefined
          ? {}
          : { resourceBounds: input.resourceBounds as VerificationResourceBounds }),
        ...(input.admit === undefined
          ? {}
          : { admittedResourceClasses: ['source_only', ...(input.admit as string[])] }),
      });
      let approval;
      if (input.prepublicationReview !== undefined) {
        const artifact = parseReviewArtifact(readFileSync(requireString(input, 'prepublicationReview'), 'utf8'));
        const config = (
          await loadDeliveryConfig(
            row.path,
            execution.personalAuth === undefined ? {} : { personalAuth: execution.personalAuth },
          )
        ).config;
        savePrepublicationArtifact({
          artifact,
          classification: run.classification,
          config,
          issueNumber,
          repoRoot: row.path,
        });
        approval = reviewArtifactApproval({ artifact, classification: run.classification, config, issueNumber });
      }
      const evidence = await createIssuePhaseEvidence({
        personalAuth:
          context.clients.authSource === 'personal' && context.config.roles.author.authSource !== 'personal',
        ...(approval === undefined ? {} : { approval }),
        issueNumber,
        phase: 'verify',
        repoRoot: row.path,
      });
      return {
        classificationReceiptId: run.classification.receiptId,
        aggregateId: run.aggregate.aggregateId,
        evidenceId: evidence.evidenceId,
        manifestId: run.manifestId,
        ...(run.resources === undefined ? {} : { resources: run.resources }),
      };
    }
    case 'issue_pr_create': {
      const issueNumber = requiredNumber(input, 'issueNumber');
      if (input.dryRun === true) {
        const row = getIssueWorktreeStrict(issueNumber, context.root);
        const run = loadVerifiedRun(row.path, issueNumber);
        return {
          dryRun: true,
          headSha: run.classification.head.sha,
          risk: run.classification.risk,
          reviewRoute: await preflightReviewRoute(context),
        };
      }
      return publishPr(context, {
        issueNumber,
        ...(input.body === undefined ? {} : { body: requireString(input, 'body') }),
        ...(input.title === undefined ? {} : { title: requireString(input, 'title') }),
        draft: input.draft !== false,
      });
    }
    case 'issue_pr_info': {
      return prInfo(context, {
        ...(input.issueNumber === undefined ? {} : { issueNumber: Number(input.issueNumber) }),
        ...(input.prNumber === undefined ? {} : { prNumber: Number(input.prNumber) }),
      });
    }
    case 'issue_pr_review': {
      if (input.dryRun === true) {
        const issueNumber = requiredNumber(input, 'issueNumber');
        const row = getIssueWorktreeStrict(issueNumber, context.root);
        const run = loadVerifiedRun(row.path, issueNumber);
        const artifact = parseReviewArtifact(requireString(input, 'artifact'));
        reviewArtifactApproval({
          artifact,
          classification: run.classification,
          config: context.config,
          issueNumber,
          prNumber: requiredNumber(input, 'prNumber'),
        });
        return { dryRun: true, artifactId: artifact.artifactId };
      }
      return submitFormalReview(context, {
        artifact: requireString(input, 'artifact'),
        issueNumber: requiredNumber(input, 'issueNumber'),
        prNumber: requiredNumber(input, 'prNumber'),
      });
    }
    case 'issue_pr_merge':
    case 'issue_finish': {
      const issueNumber = requiredNumber(input, 'issueNumber');
      const prNumber = requiredNumber(input, 'prNumber');
      if (input.dryRun === true) {
        const row = getIssueWorktreeStrict(issueNumber, context.root);
        const run = loadVerifiedRun(row.path, issueNumber);
        return { dryRun: true, headSha: run.classification.head.sha, prNumber };
      }
      const strategy = input.strategy as 'merge' | 'squash' | 'rebase' | undefined;
      return name === 'issue_finish'
        ? finishIssue(context, { issueNumber, prNumber, ...(strategy === undefined ? {} : { strategy }) })
        : mergePr(context, { issueNumber, prNumber, ...(strategy === undefined ? {} : { strategy }) });
    }
    case 'issue_worktree_create': {
      const identity = await identityFor(execution, 'worktree:create');
      await preflightReviewRoute(context, undefined, undefined, 'development');
      return prepareStandaloneWorktree({
        ...(context.configuration?.remote ? { remote: context.configuration.remote } : {}),
        branch: requireString(input, 'branch'),
        identity,
        name: requireString(input, 'name'),
        repoRoot: execution.repoRoot,
      });
    }
  }
}
