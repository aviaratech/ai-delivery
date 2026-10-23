import { deliveryHealth, type DeliveryHealthRequest } from './services/deliveryHealthService.js';
import {
  boardReconcile,
  boardReconcileGap,
  parseBoardReconcileRequest,
  incompleteBoardReconcile,
} from './services/boardReconcileService.js';
import { loadDeliverySettings, type LoadedDeliverySettings } from './config/deliveryConfig.js';
import { resolveCheckout, resolveRepoFromRemote } from './github/repo.js';
import { DeliveryError } from './errors.js';
import { digestValue } from './delivery/common.js';
import { evaluateCommandIdentityPolicy } from './github/commandIdentityPolicy.js';
import {
  CreatedTrackingIssueError,
  createIssue,
  canonicalIssueBody,
  commentIssue,
  issueInfo,
  listIssues,
  journalIssueStart,
  loadDeliveryContext,
  readyCheck,
  resumeCreatedIssue,
  startIssueBranch,
  startIssueProject,
  assertIssueStartCapacity,
  updateIssue,
  batchUpdateIssues,
  type BatchUpdateIssueInput,
  type CreateIssueInput,
  type ListIssuesInput,
  type UpdateIssueInput,
} from './issue.js';
import type { JournalInput } from './issueJournal.js';
import {
  finishInvestigation,
  finishIssue,
  mergePr,
  prInfo,
  publishPr,
  registerInvestigation,
  submitFormalReview,
} from './pr.js';
import {
  applyWorktreeTransition,
  inspectWorktreeTransition,
  type InspectWorktreeTransitionInput,
} from './worktreeTransition.js';
import { stageRuntime, admitRuntime, type StageRuntimeInput, type AdmitRuntimeInput } from './setup.js';
import { getAiDeliveryMcpTool, type AiDeliveryMcpToolName } from './mcp/tools.js';
import { IssueValidationError } from './issueContract.js';

export interface ExecutionContext {
  settings?: LoadedDeliverySettings;
  reviewSubmission?: boolean;
  identity?: string;
  personalAuth?: boolean;
  repo?: string;
  repoRoot: string;
  runtimeEntryPath?: string;
  signal?: AbortSignal;
}
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
/** Preserve every accepted tracking field when completing a partially created issue. */
export function resumedIssueUpdate(input: Record<string, unknown>): UpdateIssueInput {
  const {
    issueNumber,
    request: _request,
    requestId: _requestId,
    repo: _repo,
    resumeCreated: _resume,
    branch: _branch,
    ...fields
  } = input;
  return { ...fields, issueNumber: requiredNumber({ issueNumber }, 'issueNumber') } as UpdateIssueInput;
}
export async function contextFor(
  input: ExecutionContext,
  commandName: string,
  role: 'author' | 'reviewer' = 'author',
  readPageLimit?: number,
  requireWritableProject?: boolean,
) {
  const settings =
    input.settings ??
    (await loadDeliverySettings(
      undefined,
      input.reviewSubmission === true
        ? { reviewerIdentity: input.identity ?? '', prepareEnvironment: true }
        : undefined,
    ));
  if (input.reviewSubmission === true && role === 'author' && settings.roles.author.authSource !== 'personal')
    throw new DeliveryError(
      'review submit requires the configured personal author for pre-key reads; another App key will not be loaded.',
    );
  const identity =
    input.reviewSubmission === true && role === 'author'
      ? settings.roles.author.identity
      : (input.identity ?? settings.roles[role].identity);
  const policy = evaluateCommandIdentityPolicy({
    commandName,
    deliveryConfig: settings,
    identity,
    ...(input.personalAuth === undefined ? {} : { personalAuth: input.personalAuth }),
  });
  if (policy.error) throw new DeliveryError(policy.error);
  return loadDeliveryContext({
    settings,
    ...(settings.environment === undefined ? {} : { env: settings.environment }),
    identity,
    repoRoot: input.repoRoot,
    role,
    ...(input.repo === undefined ? {} : { repository: input.repo }),
    ...(input.personalAuth === undefined ? {} : { personalAuth: input.personalAuth }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(readPageLimit === undefined ? {} : { readPageLimit }),
    ...(requireWritableProject === undefined ? {} : { requireWritableProject }),
  });
}
/** GitHub owns branch linkage; hosts own worktree preparation. */
export async function startTrackedIssue(
  context: Awaited<ReturnType<typeof loadDeliveryContext>>,
  input: Record<string, unknown>,
) {
  let number = input.issueNumber === undefined ? undefined : requiredNumber(input, 'issueNumber');
  let created: { number: number; title: string; url: string } | undefined;
  let createdBody: string | undefined;
  let branch: Awaited<ReturnType<typeof startIssueBranch>> | undefined;
  let branchAttempted = false;
  let phase = 'branch-or-journal';
  const registration = (phase: string, error: unknown) => ({
    status: 'created-not-started' as const,
    repository: context.config.repository,
    createdIssue: created,
    failure: { phase, message: error instanceof Error ? error.message : String(error) },
    safeResume: {
      tool: 'issue_start',
      arguments: {
        // Replay tracking only when that phase is incomplete; later recovery preserves native edits/parking.
        ...(phase === 'tracking'
          ? { ...input, ...(createdBody === undefined ? {} : { body: createdBody }), resumeCreated: true }
          : {}),
        repo: context.config.repository,
        issueNumber: number,
        ...(input.overrideReason === undefined ? {} : { overrideReason: input.overrideReason }),
        ...((branch?.branch ?? optionalString(input, 'branch')) === undefined
          ? {}
          : { branch: branch?.branch ?? optionalString(input, 'branch') }),
      },
    },
  });
  if (number === undefined) {
    const title = optionalString(input, 'title') ?? requireString(input, 'request');
    const tracking = {
      ...input,
      title,
      body: optionalString(input, 'body') ?? optionalString(input, 'request') ?? title,
    } as unknown as CreateIssueInput;
    tracking.body = canonicalIssueBody(tracking);
    const intent = digestValue(
      Object.fromEntries(
        Object.entries({
          title,
          body: tracking.body,
          issueType: tracking.issueType,
          points: tracking.points,
          priority: tracking.priority,
          labels: tracking.labels,
          blockedBy: tracking.blockedBy,
          blocks: tracking.blocks,
          overrideReason: tracking.overrideReason,
          parentIssueNumber: tracking.parentIssueNumber,
          milestone: tracking.milestone,
          branch: input.branch,
        }).filter(([, value]) => value !== undefined),
      ),
    );
    const requestKey = optionalString(input, 'requestId') ?? intent;
    const marker = `<!-- ai-delivery-start: ${digestValue({ repository: context.config.repository.toLowerCase(), requestKey })} -->`;
    tracking.body = `${tracking.body}\n\n<!-- ai-delivery-start-intent: ${intent} -->\n${marker}`;
    createdBody = tracking.body;
    let completed = false;
    const matches: Awaited<ReturnType<typeof context.clients.rest.issues.listForRepo>>['data'] = [];
    for (let page = 1; page <= 20; page++) {
      const batch = (
        await context.clients.rest.issues.listForRepo({ ...context.repo, state: 'all', page, per_page: 100 })
      ).data;
      matches.push(...batch.filter((value) => !('pull_request' in value) && value.body?.includes(marker)));
      if (batch.length < 100) {
        completed = true;
        break;
      }
    }
    if (!completed)
      throw new DeliveryError(
        'Issue-start retry search exceeds the bounded readback window; select a known issue number.',
      );
    if (matches.length > 1) throw new DeliveryError('Conflicting issues claim the same start request.');
    const prior = matches[0];
    if (
      prior &&
      (prior.title !== title ||
        canonicalIssueBody({ title: prior.title, body: prior.body ?? '' }) !== tracking.body ||
        prior.state !== 'open')
    )
      throw new DeliveryError('Prior issue-start request conflicts with the requested intent or state.');
    try {
      if (prior) {
        createdBody = prior.body ?? '';
        created = { number: prior.number, title: prior.title, url: prior.html_url };
        number = prior.number;
        await resumeCreatedIssue(context, { ...tracking, issueNumber: number });
      } else {
        const result = await createIssue(context, tracking);
        created = result.created;
        createdBody = result.body;
        number = created.number;
      }
    } catch (error) {
      if (error instanceof CreatedTrackingIssueError) {
        created = error.created;
        number = created.number;
      } else if (!created) throw error;
      return registration('tracking', error);
    }
  } else if (input.resumeCreated === true) {
    const issue = (await context.clients.rest.issues.get({ ...context.repo, issue_number: number })).data;
    if (issue.number !== number || 'pull_request' in issue)
      throw new DeliveryError('Known-created issue readback disagrees.');
    created = { number, title: issue.title, url: issue.html_url };
    try {
      await resumeCreatedIssue(context, resumedIssueUpdate(input));
    } catch (error) {
      return registration('tracking', error);
    }
  }
  try {
    const readiness = await readyCheck(context, number);
    if (!readiness.ready) throw new IssueValidationError(readiness.failures);
    await assertIssueStartCapacity(context, number, optionalString(input, 'overrideReason'));
    branchAttempted = true;
    branch = await startIssueBranch(context, number, optionalString(input, 'branch'));
    phase = 'project-status';
    await startIssueProject(context, number, optionalString(input, 'overrideReason'));
    phase = 'journal';
    await journalIssueStart(context, number);
    return {
      issueNumber: number,
      repository: context.config.repository,
      branch: branch.branch,
      headSha: branch.headSha,
      reused: branch.reused,
    };
  } catch (error) {
    if (created) return registration(phase, error);
    if (!branchAttempted) throw error;
    return {
      status: 'start-incomplete' as const,
      issueNumber: number,
      repository: context.config.repository,
      failure: { phase, message: error instanceof Error ? error.message : String(error) },
      safeResume: {
        tool: 'issue_start',
        arguments: {
          repo: context.config.repository,
          issueNumber: number,
          ...(input.overrideReason === undefined ? {} : { overrideReason: input.overrideReason }),
          ...((branch?.branch ?? optionalString(input, 'branch')) === undefined
            ? {}
            : { branch: branch?.branch ?? optionalString(input, 'branch') }),
        },
      },
    };
  }
}

export async function executeTool(
  name: AiDeliveryMcpToolName,
  raw: unknown,
  execution: ExecutionContext,
): Promise<unknown> {
  const definition = getAiDeliveryMcpTool(name);
  if (!definition) throw new DeliveryError(`Unknown ai-delivery tool ${name}.`);
  if (name === 'board_reconcile') {
    let request = parseBoardReconcileRequest(raw);
    if (execution.repo !== undefined) {
      if (request.repo !== undefined && request.repo.toLowerCase() !== execution.repo.trim().toLowerCase())
        throw new DeliveryError('Tool and execution repository selectors disagree.');
      request = parseBoardReconcileRequest({ ...request, repo: execution.repo });
    }
    if (request.mode === 'apply' && execution.personalAuth === true)
      throw new DeliveryError(
        'Board apply forbids the legacy personal-auth development override; use the configured author.',
      );
    let repository = request.repositories[0]!;
    let checkoutRoots: readonly string[] = [];
    const contexts: Awaited<ReturnType<typeof loadDeliveryContext>>[] = [];
    try {
      const settings = await loadDeliverySettings();
      checkoutRoots = settings.checkoutRoots;
      for (const selected of request.repositories) {
        repository = selected;
        contexts.push(
          await contextFor({ ...execution, repoRoot: '', repo: selected }, definition.commandName, 'author', 20, false),
        );
      }
    } catch (error) {
      const failure = boardReconcileGap(repository, 'context', error);
      return incompleteBoardReconcile(request, failure);
    }
    return boardReconcile(contexts, request, {
      checkoutRoots,
      ...(execution.signal === undefined ? {} : { signal: execution.signal }),
    });
  }
  const { repo: selected, ...input } = definition.inputSchema.parse(raw) as Record<string, unknown>;
  if (name === 'issue_finish' && input.nonClosing === true)
    throw new DeliveryError('Non-closing delivery cannot finish or close its retained issue.');
  if (selected !== undefined && execution.repo !== undefined && selected !== execution.repo)
    throw new DeliveryError('Tool and execution repository selectors disagree.');
  // Ready diagnostics need no repository checkout, configuration or credential lookup.
  if (name === 'issue_create') canonicalIssueBody(input as unknown as CreateIssueInput);
  const repo = typeof selected === 'string' ? selected : execution.repo;
  const selectedExecution = { ...execution, ...(repo === undefined ? {} : { repo }) };
  const local =
    name === 'runtime_stage' ||
    name === 'runtime_admit' ||
    name.startsWith('issue_worktree_transition_') ||
    (name === 'issue_start' && input.investigationWorktree !== undefined) ||
    (name === 'issue_finish' && input.investigation === true);
  let root = execution.repoRoot;
  if (local) {
    const settings = await loadDeliverySettings();
    const coordinates =
      repo ??
      (() => {
        const r = resolveRepoFromRemote(root, 'origin');
        return `${r.owner}/${r.repo}`;
      })();
    root = resolveCheckout({ repository: coordinates, launchDirectory: root, checkoutRoots: settings.checkoutRoots });
    if (name === 'runtime_stage' || name === 'runtime_admit') {
      const setup = {
        ...input,
        repoRoot: root,
        identity: optionalString(input, 'identity') ?? execution.identity ?? settings.roles.author.identity,
        ...(execution.personalAuth === undefined ? {} : { personalAuth: execution.personalAuth }),
        ...(execution.signal === undefined ? {} : { signal: execution.signal }),
      };
      return name === 'runtime_stage'
        ? stageRuntime(setup as unknown as StageRuntimeInput)
        : admitRuntime(setup as unknown as AdmitRuntimeInput);
    }
  }
  const requestedIdentity = name === 'issue_pr_review' ? optionalString(input, 'identity') : undefined;
  const context = await contextFor(
    { ...selectedExecution, ...(requestedIdentity === undefined ? {} : { identity: requestedIdentity }) },
    definition.commandName,
    name === 'issue_pr_review' ? 'reviewer' : 'author',
  );
  if (local) context.root = root;
  switch (name) {
    case 'delivery_health':
      return deliveryHealth(context, { ...input, repo: repo! } as DeliveryHealthRequest);
    case 'issue_comment':
      return commentIssue(context, input as JournalInput);
    case 'issue_create':
      return createIssue(context, input as unknown as CreateIssueInput);
    case 'issue_start':
      if (input.investigationWorktree !== undefined)
        return registerInvestigation(context, {
          issueNumber: requiredNumber(input, 'issueNumber'),
          investigationWorktree: requireString(input, 'investigationWorktree'),
          expectedHeadSha: requireString(input, 'expectedHeadSha'),
        });
      return startTrackedIssue(context, input);
    case 'issue_batch_update':
      return batchUpdateIssues(context, input as unknown as BatchUpdateIssueInput, selectedExecution.signal);
    case 'issue_update':
      return updateIssue(context, input as unknown as UpdateIssueInput);
    case 'issue_list':
    case 'issue_search':
      return listIssues(context, input as ListIssuesInput);
    case 'issue_info':
      return issueInfo(context, requiredNumber(input, 'issueNumber'));
    case 'issue_ready_check':
      return readyCheck(context, requiredNumber(input, 'issueNumber'));
    case 'issue_pr_create':
      return publishPr(context, {
        ...(input.prNumber === undefined ? {} : { prNumber: requiredNumber(input, 'prNumber') }),
        issueNumber: requiredNumber(input, 'issueNumber'),
        ...(input.nonClosing === undefined ? {} : { nonClosing: input.nonClosing === true }),
        ...(input.reconcileNonClosingReference === undefined
          ? {}
          : { reconcileNonClosingReference: input.reconcileNonClosingReference === true }),
        ...(input.expectedHeadSha === undefined ? {} : { expectedHeadSha: requireString(input, 'expectedHeadSha') }),
        ...(input.expectedBaseSha === undefined ? {} : { expectedBaseSha: requireString(input, 'expectedBaseSha') }),
        ...(input.body === undefined ? {} : { body: requireString(input, 'body') }),
        ...(input.title === undefined ? {} : { title: requireString(input, 'title') }),
        ...(input.head === undefined && input.headBranch === undefined
          ? {}
          : { headBranch: requireString(input, input.head === undefined ? 'headBranch' : 'head') }),
        ...(input.base === undefined ? {} : { baseBranch: requireString(input, 'base') }),
        draft: input.draft !== false,
        dryRun: input.dryRun === true,
      });
    case 'issue_pr_info':
      return prInfo(context, input as { issueNumber?: number; prNumber?: number; nonClosing?: boolean });
    case 'issue_pr_review':
      return submitFormalReview(context, {
        artifact: requireString(input, 'artifact'),
        issueNumber: requiredNumber(input, 'issueNumber'),
        ...(input.nonClosing === undefined ? {} : { nonClosing: input.nonClosing === true }),
        prNumber: requiredNumber(input, 'prNumber'),
        dryRun: input.dryRun === true,
      });
    case 'issue_pr_merge':
    case 'issue_finish': {
      if (name === 'issue_finish' && input.investigation === true)
        return finishInvestigation(context, {
          issueNumber: requiredNumber(input, 'issueNumber'),
          resultPath: requireString(input, 'resultPath'),
          ...(input.authorityCommentId === undefined
            ? {}
            : { authorityCommentId: requiredNumber(input, 'authorityCommentId') }),
          ...(input.acceptanceCommentId === undefined
            ? {}
            : { acceptanceCommentId: requiredNumber(input, 'acceptanceCommentId') }),
          dryRun: input.dryRun === true,
        });
      const merge = {
        issueNumber: requiredNumber(input, 'issueNumber'),
        ...(input.nonClosing === undefined ? {} : { nonClosing: input.nonClosing === true }),
        prNumber: requiredNumber(input, 'prNumber'),
        ...(input.strategy === undefined ? {} : { strategy: input.strategy as 'merge' | 'squash' | 'rebase' }),
        ...(input.reviewedHeadSha === undefined ? {} : { reviewedHeadSha: requireString(input, 'reviewedHeadSha') }),
        dryRun: input.dryRun === true,
      };
      return name === 'issue_finish' ? finishIssue(context, merge) : mergePr(context, merge);
    }
    case 'issue_worktree_transition_inspect':
      return inspectWorktreeTransition(context, {
        ...input,
        ...(execution.runtimeEntryPath === undefined ? {} : { runtimeEntryPath: execution.runtimeEntryPath }),
      } as unknown as InspectWorktreeTransitionInput);
    case 'issue_worktree_transition_apply':
      return applyWorktreeTransition(context, {
        authority: 'worktree:transition',
        planPath: requireString(input, 'planPath'),
        expectedPlanId: requireString(input, 'expectedPlanId'),
        relinquishmentCommentId: requiredNumber(input, 'relinquishmentCommentId'),
        acceptanceCommentId: requiredNumber(input, 'acceptanceCommentId'),
        ...(execution.runtimeEntryPath === undefined ? {} : { runtimeEntryPath: execution.runtimeEntryPath }),
      });
  }
}
