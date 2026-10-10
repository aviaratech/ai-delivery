import { loadDeliverySettings } from './config/deliveryConfig.js';
import { resolveCheckout, resolveRepoFromRemote } from './github/repo.js';
import { DeliveryError } from './errors.js';
import { digestValue } from './delivery/common.js';
import { evaluateCommandIdentityPolicy } from './github/commandIdentityPolicy.js';
import {
  CreatedTrackingIssueError,
  createIssue,
  commentIssue,
  issueInfo,
  listIssues,
  journalIssueStart,
  loadDeliveryContext,
  readyCheck,
  resumeCreatedIssue,
  startIssueBranch,
  updateIssue,
  type CreateIssueInput,
  type ListIssuesInput,
  type UpdateIssueInput,
} from './issue.js';
import type { JournalInput } from './issueJournal.js';
import { finishIssue, mergePr, prInfo, publishPr, submitFormalReview } from './pr.js';
import {
  applyWorktreeTransition,
  inspectWorktreeTransition,
  type InspectWorktreeTransitionInput,
} from './worktreeTransition.js';
import { stageRuntime, admitRuntime, type StageRuntimeInput, type AdmitRuntimeInput } from './setup.js';
import { getAiDeliveryMcpTool, type AiDeliveryMcpToolName } from './mcp/tools.js';

export interface ExecutionContext {
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
export async function contextFor(input: ExecutionContext, commandName: string, role: 'author' | 'reviewer' = 'author') {
  const settings = await loadDeliverySettings();
  const identity = input.identity ?? settings.roles[role].identity;
  const policy = evaluateCommandIdentityPolicy({
    commandName,
    deliveryConfig: settings,
    identity,
    ...(input.personalAuth === undefined ? {} : { personalAuth: input.personalAuth }),
  });
  if (policy.error) throw new DeliveryError(policy.error);
  return loadDeliveryContext({
    identity,
    repoRoot: input.repoRoot,
    role,
    ...(input.repo === undefined ? {} : { repository: input.repo }),
    ...(input.personalAuth === undefined ? {} : { personalAuth: input.personalAuth }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}
/** GitHub owns branch linkage; hosts own worktree preparation. */
export async function startTrackedIssue(
  context: Awaited<ReturnType<typeof loadDeliveryContext>>,
  input: Record<string, unknown>,
) {
  let number = input.issueNumber === undefined ? undefined : requiredNumber(input, 'issueNumber');
  let created: { number: number; title: string; url: string } | undefined;
  const registration = (phase: string, error: unknown) => ({
    status: 'created-not-started',
    repository: context.config.repository,
    createdIssue: created,
    failure: { phase, message: error instanceof Error ? error.message : String(error) },
    safeResume: {
      tool: 'issue_start',
      arguments: { ...input, repo: context.config.repository, issueNumber: number, resumeCreated: true },
    },
  });
  if (number === undefined) {
    const title = optionalString(input, 'title') ?? requireString(input, 'request');
    const tracking = {
      ...input,
      title,
      body: optionalString(input, 'body') ?? optionalString(input, 'request') ?? title,
    } as unknown as CreateIssueInput;
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
          parentIssueNumber: tracking.parentIssueNumber,
          milestone: tracking.milestone,
          branch: input.branch,
        }).filter(([, value]) => value !== undefined),
      ),
    );
    const requestKey = optionalString(input, 'requestId') ?? intent;
    const marker = `<!-- ai-delivery-start: ${digestValue({ repository: context.config.repository.toLowerCase(), requestKey })} -->`;
    tracking.body = `${tracking.body}\n\n<!-- ai-delivery-start-intent: ${intent} -->\n${marker}`;
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
    if (prior && (prior.title !== title || prior.body !== tracking.body || prior.state !== 'open'))
      throw new DeliveryError('Prior issue-start request conflicts with the requested intent or state.');
    try {
      if (prior) {
        created = { number: prior.number, title: prior.title, url: prior.html_url };
        number = prior.number;
        await resumeCreatedIssue(context, { ...tracking, issueNumber: number });
      } else {
        created = (await createIssue(context, tracking)).created;
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
    const branch = await startIssueBranch(context, number, optionalString(input, 'branch'));
    await journalIssueStart(context, number);
    return {
      issueNumber: number,
      repository: context.config.repository,
      branch: branch.branch,
      headSha: branch.headSha,
      reused: branch.reused,
    };
  } catch (error) {
    if (created) return registration('branch-or-journal', error);
    throw error;
  }
}

export async function executeTool(
  name: AiDeliveryMcpToolName,
  raw: unknown,
  execution: ExecutionContext,
): Promise<unknown> {
  const definition = getAiDeliveryMcpTool(name);
  if (!definition) throw new DeliveryError(`Unknown ai-delivery tool ${name}.`);
  const { repo: selected, ...input } = definition.inputSchema.parse(raw) as Record<string, unknown>;
  if (name === 'issue_finish' && input.nonClosing === true)
    throw new DeliveryError('Non-closing delivery cannot finish or close its retained issue.');
  if (selected !== undefined && execution.repo !== undefined && selected !== execution.repo)
    throw new DeliveryError('Tool and execution repository selectors disagree.');
  const repo = typeof selected === 'string' ? selected : execution.repo;
  const selectedExecution = { ...execution, ...(repo === undefined ? {} : { repo }) };
  const local = name === 'runtime_stage' || name === 'runtime_admit' || name.startsWith('issue_worktree_transition_');
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
    case 'issue_comment':
      return commentIssue(context, input as JournalInput);
    case 'issue_create':
      return createIssue(context, input as unknown as CreateIssueInput);
    case 'issue_start':
      return startTrackedIssue(context, input);
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
        ...(input.body === undefined ? {} : { body: requireString(input, 'body') }),
        ...(input.title === undefined ? {} : { title: requireString(input, 'title') }),
        ...(input.headBranch === undefined ? {} : { headBranch: requireString(input, 'headBranch') }),
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
