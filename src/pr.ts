import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';

import { loadDeliveryConfig } from './config/deliveryConfig.js';
import { assertPrivateFile, digestBytes } from './delivery/common.js';
import {
  digestValue,
  loadSelectedRepositoryPolicy,
  validateRepositoryPolicyBoundary,
  type RepositoryApprovalBinding,
} from './delivery/index.js';
import { DeliveryError } from './errors.js';
import { coordinate, defaultBaseRef, git, gitCommonDir, gitExitCode, gitRoot } from './git.js';
import { resolveGitRemoteName } from './github/repo.js';
import { createDeliveryGitHubClients, withAuthorGitToken, type GitHubClients } from './github/client.js';
import {
  getConfiguredNativeIssueMetadata,
  nativeIssueSettingsFromDeliveryConfig,
} from './github/nativeIssueMetadata.js';
import { getNativeBlockerRelationships } from './github/relationships.js';
import {
  getIssueProjectStatus,
  projectSettingsFromDeliveryConfig,
  syncIssueProjectStatus,
} from './github/projectDelivery.js';
import { commentIssue, type DeliveryContext } from './issue.js';
import { acceptanceCriteria, issueFollowUps } from './issueJournal.js';
import {
  loadPrepublicationArtifact,
  loadSubmittedReview,
  reviewArtifactApproval,
  assertSubmittedReviewCurrent,
  parseReviewArtifact,
  readRequiredReviewState,
  submitReview,
} from './review.js';
import {
  getIssueWorktreeStrict,
  listWorktreesStrict,
  updateIssueWorktreeDelivery,
  type WorktreeEntry,
} from './services/worktreeRegistry.js';
import { getDeliveryRecords, recordMergedDelivery, type DeliveryRecord } from './services/deliveryRecordService.js';
import {
  createIssuePhaseEvidence,
  loadHistoricalMergedRun,
  loadRemovedMergedRun,
  loadVerifiedRun,
  type VerificationRun,
} from './verification.js';
import { writePrivateJsonFileAtomically } from './utils/atomicJson.js';
import { readNativeWorktreePrLineage } from './worktreeTransition.js';
import { cleanupMergedIssueWorktree, preparePrWorktree } from './worktree.js';

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const Sha = z.string().regex(/^[a-f0-9]{40}$/u);

const PublicationSchema = z
  .object({
    baseSha: Sha,
    evidenceId: Digest,
    headSha: Sha,
    issueNumber: z.number().int().positive(),
    prNumber: z.number().int().positive(),
    publicationId: Digest,
    schemaVersion: z.literal('ai-delivery.publication@1'),
  })
  .strict()
  .superRefine((value, ctx) => {
    const { publicationId, ...content } = value;
    if (publicationId !== digestValue(content))
      ctx.addIssue({ code: 'custom', message: 'Publication identity is invalid.' });
  });
type Publication = z.infer<typeof PublicationSchema>;

const MergeStrategy = z.enum(['merge', 'squash', 'rebase']);
const MergeIntentShape = z
  .object({
    baseBranch: z.string().regex(/^[A-Za-z0-9._/-]+$/u),
    baseSha: Sha,
    evidenceId: Digest,
    exactBaseHeadLease: z.boolean(),
    headBranch: z.string().regex(/^[A-Za-z0-9._/-]+$/u),
    headSha: Sha,
    headTree: Sha,
    intentId: Digest,
    issueNumber: z.number().int().positive(),
    prNumber: z.number().int().positive(),
    reviewReceiptId: Digest,
    schemaVersion: z.literal('ai-delivery.merge-intent@2'),
    strategy: MergeStrategy,
  })
  .strict();
const MergeIntentSchema = MergeIntentShape.superRefine((value, ctx) => {
  const { intentId, ...content } = value;
  if (intentId !== digestValue(content)) ctx.addIssue({ code: 'custom', message: 'Merge intent identity is invalid.' });
});
type MergeIntent = z.infer<typeof MergeIntentSchema>;
const MergeAttemptSchema = z
  .object({
    actor: z.string().min(1),
    actorLogin: z.string().min(1),
    attemptId: Digest,
    authSource: z.enum(['app', 'personal']),
    credentialIdentity: z.string().min(1),
    intentId: Digest,
    operation: z.enum(['pulls.merge', 'updateRefs']),
    schemaVersion: z.literal('ai-delivery.merge-attempt@1'),
  })
  .strict()
  .superRefine((value, ctx) => {
    const { attemptId, ...content } = value;
    if (attemptId !== digestValue(content))
      ctx.addIssue({ code: 'custom', message: 'Merge attempt identity is invalid.' });
  });
type MergeAttempt = z.infer<typeof MergeAttemptSchema>;
const MergeResultSchema = z
  .object({
    attemptId: Digest,
    mergeSha: Sha,
    resultId: Digest,
    schemaVersion: z.literal('ai-delivery.merge-result@1'),
  })
  .strict()
  .superRefine((value, ctx) => {
    const { resultId, ...content } = value;
    if (resultId !== digestValue(content))
      ctx.addIssue({ code: 'custom', message: 'Merge result identity is invalid.' });
  });
const MergeSchema = MergeIntentShape.omit({ intentId: true, schemaVersion: true })
  .extend({
    intentId: Digest,
    mergeId: Digest,
    mergeSha: Sha,
    mergeTree: Sha,
    schemaVersion: z.literal('ai-delivery.merge@3'),
  })
  .strict()
  .superRefine((value, ctx) => {
    const { mergeId, ...content } = value;
    if (mergeId !== digestValue(content)) ctx.addIssue({ code: 'custom', message: 'Merge identity is invalid.' });
  });
type MergeReceipt = z.infer<typeof MergeSchema>;

function publicationPath(root: string, issueNumber: number, headSha: string): string {
  return join(gitCommonDir(root), 'ai-delivery', 'publications', String(issueNumber), `${headSha}.json`);
}
function mergePath(root: string, issueNumber: number, headSha: string): string {
  return join(gitCommonDir(root), 'ai-delivery', 'merges', String(issueNumber), `${headSha}.json`);
}
function mergeIntentPath(root: string, issueNumber: number, headSha: string): string {
  return join(gitCommonDir(root), 'ai-delivery', 'merge-intents', String(issueNumber), `${headSha}.json`);
}
function mergeAttemptPath(root: string, issueNumber: number, headSha: string): string {
  return join(gitCommonDir(root), 'ai-delivery', 'merge-attempts', String(issueNumber), `${headSha}.json`);
}
function mergeResultPath(root: string, issueNumber: number, headSha: string): string {
  return join(gitCommonDir(root), 'ai-delivery', 'merge-results', String(issueNumber), `${headSha}.json`);
}
function readOptionalPrivate<T>(path: string, parse: (value: unknown) => T): T | null {
  let raw: unknown;
  try {
    raw = JSON.parse(assertPrivateFile(path).toString('utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new DeliveryError('Stored lifecycle receipt is unreadable.');
  }
  try {
    return parse(raw);
  } catch {
    throw new DeliveryError('Stored lifecycle receipt is corrupt.');
  }
}
function readPrivate<T>(path: string, parse: (value: unknown) => T): T {
  let raw: unknown;
  try {
    raw = JSON.parse(assertPrivateFile(path).toString('utf8')) as unknown;
  } catch {
    throw new DeliveryError('Required private lifecycle receipt is missing or unreadable.');
  }
  return parse(raw);
}

export function loadPublication(root: string, issueNumber: number, headSha: string): Publication {
  return readPrivate(publicationPath(root, issueNumber, headSha), (value) => PublicationSchema.parse(value));
}

function validateDeliveryImpact(body: string): void {
  if (
    (body.match(/^## Delivery Impact\s*$/gmu) ?? []).length !== 1 ||
    (body.match(/^Roadmap impact:\s*(?:updated|none)\s*$/gmu) ?? []).length !== 1 ||
    (body.match(/^Docs impact:\s*(?:updated|none)\s*$/gmu) ?? []).length !== 1
  ) {
    throw new DeliveryError('PR body requires one Delivery Impact section with Roadmap impact and Docs impact.');
  }
}

function baseBranch(root: string, selectedRemote?: string): string {
  const remote = resolveGitRemoteName(root, selectedRemote);
  const ref = defaultBaseRef(root, remote);
  const value = ref.slice(`refs/remotes/${remote}/`.length);
  if (!/^[A-Za-z0-9._/-]+$/u.test(value)) throw new DeliveryError('Invalid configured default branch.');
  return value;
}

/** @internal Selected-author Git transport, exported for process-boundary tests. */
export async function runAuthorGit(
  context: DeliveryContext,
  path: string,
  args: string[],
  operation: string,
): Promise<void> {
  await withAuthorGitToken(context.clients, (token) => {
    const gitEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    const unsafeConfig = spawnSync(
      'git',
      ['config', '--includes', '--get-regexp', '^(url\\..*\\.(insteadof|pushinsteadof)|http(\\..*)?\\.extraheader)$'],
      {
        cwd: path,
        env: gitEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    if (unsafeConfig.error || (unsafeConfig.status !== 0 && unsafeConfig.status !== 1)) {
      throw new DeliveryError(
        `Cannot verify effective Git HTTP transport configuration (git exit ${String(unsafeConfig.status)}).`,
      );
    }
    if (unsafeConfig.status === 0) {
      throw new DeliveryError('Local Git transport configuration conflicts with selected author authentication.');
    }
    const temporary = mkdtempSync(join(tmpdir(), 'ai-delivery-git-auth-'));
    const askpass = join(temporary, 'askpass.sh');
    try {
      writeFileSync(
        askpass,
        '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" x-access-token ;;\n  *Password*) printf "%s\\n" "$AI_DELIVERY_GIT_TOKEN" ;;\n  *) exit 1 ;;\nesac\n',
        { mode: 0o700 },
      );
      execFileSync('git', ['-c', 'credential.helper=', ...args], {
        cwd: path,
        encoding: 'utf8',
        env: { ...gitEnv, AI_DELIVERY_GIT_TOKEN: token, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0' },
        maxBuffer: 4 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (cause) {
      const error = cause as Error & { stderr?: Buffer | string };
      const detail = String(error.stderr ?? '')
        .trim()
        .replaceAll(token, '[redacted]');
      throw new DeliveryError(`git ${operation} failed${detail ? `: ${detail}` : ''}`);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}

async function pushReviewedHead(context: DeliveryContext, path: string, branch: string, sha: string): Promise<void> {
  await runAuthorGit(
    context,
    path,
    ['push', `https://github.com/${context.repo.owner}/${context.repo.repo}.git`, `${sha}:refs/heads/${branch}`],
    'push',
  );
}

async function fetchMergedBase(context: DeliveryContext, branch: string): Promise<void> {
  const remote = resolveGitRemoteName(context.root, context.configuration?.remote);
  const refspec = `${branch}:refs/remotes/${remote}/${branch}`;
  const url = git(context.root, 'remote', 'get-url', remote);
  if (isAbsolute(url) || url.startsWith('file://')) {
    git(context.root, 'fetch', remote, refspec);
    return;
  }
  await runAuthorGit(
    context,
    context.root,
    ['fetch', `https://github.com/${context.repo.owner}/${context.repo.repo}.git`, refspec],
    'fetch',
  );
}

export async function prInfo(
  context: DeliveryContext,
  input: { issueNumber?: number; prNumber?: number },
): Promise<{
  number: number | null;
  state: string | null;
  headSha: string | null;
  baseSha: string | null;
  draft: boolean | null;
  authorLogin: string | null;
  url: string | null;
}> {
  if (input.prNumber !== undefined) {
    const pr = (await context.clients.rest.pulls.get({ ...context.repo, pull_number: input.prNumber })).data;
    return {
      number: pr.number,
      state: pr.state,
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      draft: pr.draft ?? null,
      authorLogin: pr.user?.login ?? null,
      url: pr.html_url,
    };
  }
  if (input.issueNumber === undefined) throw new DeliveryError('Provide an issue or PR number.');
  const row = getIssueWorktreeStrict(input.issueNumber, context.root);
  const matches = (
    await context.clients.rest.pulls.list({
      ...context.repo,
      head: `${context.repo.owner}:${row.branch}`,
      state: 'open',
      per_page: 100,
    })
  ).data;
  if (matches.length > 1) throw new DeliveryError('Multiple open PRs match the registered branch.');
  const pr = matches[0];
  return pr
    ? {
        number: pr.number,
        state: pr.state,
        headSha: pr.head.sha,
        baseSha: pr.base.sha,
        draft: pr.draft ?? null,
        authorLogin: pr.user?.login ?? null,
        url: pr.html_url,
      }
    : { number: null, state: null, headSha: null, baseSha: null, draft: null, authorLogin: null, url: null };
}

export async function listPrs(context: DeliveryContext, state: 'all' | 'closed' | 'open' = 'open') {
  const prs = await context.clients.rest.paginate(context.clients.rest.pulls.list, {
    ...context.repo,
    state,
    per_page: 100,
  });
  return {
    schemaVersion: 'ai-delivery.pr-list@1' as const,
    pullRequests: prs.map((pr) => ({
      number: pr.number,
      state: pr.state,
      draft: pr.draft ?? false,
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      url: pr.html_url,
    })),
  };
}

export async function prChecks(context: DeliveryContext, prNumber: number) {
  const pr = (await context.clients.rest.pulls.get({ ...context.repo, pull_number: prNumber })).data;
  const [checks, status, reviewState] = await Promise.all([
    context.clients.rest.checks.listForRef({ ...context.repo, ref: pr.head.sha, per_page: 100 }),
    context.clients.rest.repos.getCombinedStatusForRef({ ...context.repo, ref: pr.head.sha }),
    readRequiredReviewState(context, prNumber, pr.head.sha),
  ]);
  return {
    schemaVersion: 'ai-delivery.pr-checks@1' as const,
    prNumber: pr.number,
    headSha: pr.head.sha,
    combinedStatus: status.data.state,
    reviewState,
    checkRuns: checks.data.check_runs.map((check) => ({
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
    })),
  };
}

export async function checkoutPr(context: DeliveryContext, prNumber: number) {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) throw new DeliveryError('PR number must be positive.');
  const pr = (await context.clients.rest.pulls.get({ ...context.repo, pull_number: prNumber })).data;
  const repository = `${context.repo.owner}/${context.repo.repo}`.toLowerCase();
  if (
    pr.state !== 'open' ||
    pr.head.repo?.full_name.toLowerCase() !== repository ||
    pr.base.repo?.full_name.toLowerCase() !== repository ||
    gitExitCode(context.root, 'check-ref-format', '--branch', pr.head.ref) !== 0
  ) {
    throw new DeliveryError('PR checkout requires an open in-repository branch with a valid ref.');
  }
  const remoteHead = (await context.clients.rest.git.getRef({ ...context.repo, ref: `heads/${pr.head.ref}` })).data
    .object.sha;
  if (remoteHead !== pr.head.sha) throw new DeliveryError('PR branch ref drifted from the observed head.');
  const remote = resolveGitRemoteName(context.root, context.configuration?.remote);
  const fetchedRef = `refs/remotes/${remote}/ai-delivery-pr-${prNumber}`;
  await runAuthorGit(
    context,
    context.root,
    [
      'fetch',
      `https://github.com/${context.repo.owner}/${context.repo.repo}.git`,
      `refs/heads/${pr.head.ref}:${fetchedRef}`,
    ],
    'fetch',
  );
  if (git(context.root, 'rev-parse', fetchedRef) !== pr.head.sha) {
    throw new DeliveryError('Fetched PR branch disagrees with the live head.');
  }
  const live = (await context.clients.rest.pulls.get({ ...context.repo, pull_number: prNumber })).data;
  if (live.state !== 'open' || live.head.sha !== pr.head.sha || live.head.ref !== pr.head.ref) {
    throw new DeliveryError('PR changed during selected-App checkout.');
  }
  return preparePrWorktree({
    headSha: pr.head.sha,
    identity: context.config.roles.author.identity,
    prNumber,
    repoRoot: context.root,
  });
}

export interface ReviewRoutePreflight {
  author: { actorLogin: string; authSource: GitHubClients['authSource']; credentialSource: string; identity: string };
  reviewer: {
    actorLogin: string;
    credentialSource: string;
    effectiveContentsPermission: NonNullable<GitHubClients['effectiveContentsPermission']> | 'unknown';
    identity: string;
    repositoryAccess: 'readable';
  };
  rules: { observedRequiredApprovals: number | null; visibility: 'complete' | 'partial' | 'unknown' };
  approvalEligibility: 'unknown' | 'insufficient-permission';
  nextAction: string;
}

function requiredApprovalCount(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const count = (value as Record<string, unknown>).required_approving_review_count;
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null;
}

/** Check selected actors and rule evidence; publication also requires the configured author source. */
export async function preflightReviewRoute(
  context: DeliveryContext,
  base = baseBranch(context.root, context.configuration?.remote),
  selectedReviewer?: GitHubClients,
  purpose: 'development' | 'publication' = 'publication',
  control?: { signal: AbortSignal; checkResources: () => Promise<void> },
): Promise<ReviewRoutePreflight> {
  const check = async (): Promise<void> => {
    await control?.checkResources();
    control?.signal.throwIfAborted();
  };
  await check();
  const configuredAuthorSource = context.config.roles.author.authSource ?? 'app';
  const personalDevelopmentOverride =
    purpose === 'development' && configuredAuthorSource === 'app' && context.clients.authSource === 'personal';
  if (context.clients.authSource !== configuredAuthorSource && !personalDevelopmentOverride) {
    throw new DeliveryError(
      purpose === 'publication'
        ? 'PR publication requires the configured author credential; configure the personal author role for personal publication.'
        : 'Development access preflight requires the configured author credential or the explicit personal author override.',
    );
  }
  if (context.clients.role !== 'author' || !context.clients.authenticatedAuthor) {
    throw new DeliveryError('Delivery access preflight requires authenticated author identity readback.');
  }
  const author = await context.clients.authenticatedAuthor(control?.signal);
  await check();
  if (!author.actorLogin || !author.credentialIdentity) {
    throw new DeliveryError('Author GitHub identity readback is incomplete.');
  }
  const reviewer =
    selectedReviewer ??
    (await createDeliveryGitHubClients({
      config: context.config,
      identity: context.config.roles.reviewer.identity,
      role: 'reviewer',
      selectedAuthor: context.clients,
      ...(control === undefined ? {} : { signal: control.signal }),
    }));
  await check();
  if (reviewer.role !== 'reviewer' || reviewer.authSource !== 'app' || !reviewer.appActorLogin) {
    throw new DeliveryError('Configured reviewer GitHub App identity is unavailable.');
  }
  const reviewerActor = await reviewer.appActorLogin(control?.signal);
  await check();
  if (!reviewerActor) throw new DeliveryError('Reviewer GitHub App actor lookup is incomplete.');
  if (author.actorLogin.toLowerCase() === reviewerActor.toLowerCase()) {
    throw new DeliveryError(
      'Author and reviewer resolve to the same GitHub actor; select distinct configured credentials.',
    );
  }
  try {
    const repository = (
      await reviewer.rest.repos.get({
        ...context.repo,
        ...(control === undefined ? {} : { request: { signal: control.signal } }),
      })
    ).data;
    await check();
    if (repository.full_name.toLowerCase() !== `${context.repo.owner}/${context.repo.repo}`.toLowerCase()) {
      throw new DeliveryError('Reviewer GitHub App repository readback disagrees with the selected checkout.');
    }
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    throw new DeliveryError(
      'Reviewer GitHub App cannot read the selected repository; verify its installation and repository access.',
    );
  }
  const [rulesetResult, protectionResult] = await Promise.allSettled([
    context.clients.rest.request('GET /repos/{owner}/{repo}/rules/branches/{branch}', {
      ...context.repo,
      branch: base,
      ...(control === undefined ? {} : { request: { signal: control.signal } }),
    }),
    context.clients.rest.request('GET /repos/{owner}/{repo}/branches/{branch}/protection', {
      ...context.repo,
      branch: base,
      ...(control === undefined ? {} : { request: { signal: control.signal } }),
    }),
  ]);
  await check();
  const counts: number[] = [];
  if (rulesetResult.status === 'fulfilled' && Array.isArray(rulesetResult.value.data)) {
    for (const rule of rulesetResult.value.data) {
      if (rule.type === 'pull_request') {
        const count = requiredApprovalCount(rule.parameters);
        if (count !== null) counts.push(count);
      }
    }
  }
  if (protectionResult.status === 'fulfilled') {
    const protection = protectionResult.value.data as { required_pull_request_reviews?: unknown };
    const count = requiredApprovalCount(protection.required_pull_request_reviews);
    if (count !== null) counts.push(count);
  }
  const visible = Number(rulesetResult.status === 'fulfilled') + Number(protectionResult.status === 'fulfilled');
  const visibility = visible === 2 ? 'complete' : visible === 1 ? 'partial' : 'unknown';
  const observedRequiredApprovals = counts.length > 0 ? Math.max(...counts) : null;
  const insufficientPermission =
    observedRequiredApprovals !== null &&
    observedRequiredApprovals > 0 &&
    reviewer.effectiveContentsPermission === 'read';
  return {
    author: {
      actorLogin: author.actorLogin,
      authSource: context.clients.authSource,
      credentialSource: context.clients.credentialSource ?? 'unreported',
      identity: personalDevelopmentOverride ? 'personal' : context.config.roles.author.identity,
    },
    reviewer: {
      actorLogin: reviewerActor,
      credentialSource: reviewer.credentialSource ?? 'unreported',
      effectiveContentsPermission: reviewer.effectiveContentsPermission ?? 'unknown',
      identity: context.config.roles.reviewer.identity,
      repositoryAccess: 'readable',
    },
    rules: { observedRequiredApprovals, visibility },
    approvalEligibility: insufficientPermission ? 'insufficient-permission' : 'unknown',
    nextAction: insufficientPermission
      ? 'The reviewer App token has Contents: read, but the visible rule requires approval from a reviewer with repository write access. To use the App for required approval, grant Contents: write, accept the installation permission change, and obtain a fresh token before publication.'
      : visibility === 'complete' && observedRequiredApprovals === null
        ? 'No required approving review was observed in the visible rules. Confirm the live PR review decision after exact-head submission.'
        : visibility === 'complete'
          ? 'Confirm whether the reviewer approval counts after exact-head submission; installation scopes do not prove required-review eligibility.'
          : 'Inspect the active branch review rule with an authorized repository view and confirm whether the reviewer approval counts after exact-head submission.',
  };
}

export async function publishPr(
  context: DeliveryContext,
  input: {
    body?: string;
    draft?: boolean;
    issueNumber: number;
    title?: string;
  },
): Promise<{
  prNumber: number;
  url: string;
  publicationEvidenceId: string;
  reviewRoute?: ReviewRoutePreflight;
  reviewState?: Awaited<ReturnType<typeof readRequiredReviewState>>;
}> {
  const root = gitRoot(context.root);
  const row = getIssueWorktreeStrict(input.issueNumber, root);
  if (row.type !== 'issue' || row.status === 'merged')
    throw new DeliveryError('PR publication requires an active issue worktree.');
  const run = loadVerifiedRun(row.path, input.issueNumber);
  const head = coordinate(row.path);
  if (input.draft === false) {
    const publication = loadPublication(row.path, input.issueNumber, head.sha);
    const receipt = loadSubmittedReview(row.path, input.issueNumber, head.sha);
    if (!receipt || receipt.publicationEvidenceId !== publication.evidenceId) {
      throw new DeliveryError('Ready promotion requires a submitted review of the exact published head.');
    }
    await assertSubmittedReviewCurrent(context, receipt);
    const pr = (await context.clients.rest.pulls.get({ ...context.repo, pull_number: publication.prNumber })).data;
    if (pr.head.sha !== head.sha) throw new DeliveryError('PR head drifted before ready promotion.');
    if (pr.draft) {
      await context.clients.graphql(
        `mutation Ready($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { id isDraft } } }`,
        { id: pr.node_id },
      );
    }
    const readback = (await context.clients.rest.pulls.get({ ...context.repo, pull_number: publication.prNumber }))
      .data;
    if (readback.draft || readback.head.sha !== head.sha) throw new DeliveryError('PR ready readback failed.');
    return {
      prNumber: publication.prNumber,
      url: readback.html_url,
      publicationEvidenceId: publication.evidenceId,
      reviewState: await readRequiredReviewState(context, publication.prNumber, head.sha),
    };
  }
  const prepublication = loadPrepublicationArtifact(row.path, input.issueNumber, head.sha);
  const approval = prepublication
    ? reviewArtifactApproval({
        artifact: prepublication,
        classification: run.classification,
        config: context.config,
        issueNumber: input.issueNumber,
      })
    : undefined;
  const evidence = await createIssuePhaseEvidence({
    personalAuth: context.clients.authSource === 'personal' && context.config.roles.author.authSource !== 'personal',
    ...(approval === undefined ? {} : { approval }),
    issueNumber: input.issueNumber,
    phase: 'publish',
    repoRoot: row.path,
  });
  const issue = (await context.clients.rest.issues.get({ ...context.repo, issue_number: input.issueNumber })).data;
  const title = input.title ?? `${input.issueNumber}: ${issue.title}`;
  const body =
    input.body ?? `Closes #${input.issueNumber}\n\n## Delivery Impact\n\nRoadmap impact: none\nDocs impact: none\n`;
  validateDeliveryImpact(body);
  const remoteHead = (
    await context.clients.rest.git.getRef({
      ...context.repo,
      ref: `heads/${baseBranch(root, context.configuration?.remote)}`,
    })
  ).data.object.sha;
  if (remoteHead !== run.classification.base.sha)
    throw new DeliveryError('Remote base changed after exact-head verification.');
  const reviewRoute = await preflightReviewRoute(context, baseBranch(root, context.configuration?.remote));
  const matches = (
    await context.clients.rest.pulls.list({
      ...context.repo,
      head: `${context.repo.owner}:${row.branch}`,
      state: 'open',
      per_page: 100,
    })
  ).data;
  if (matches.length > 1) throw new DeliveryError('Multiple open PRs match the registered branch.');
  const existing = matches[0];
  if (existing?.user?.login && existing.user.login.toLowerCase() !== reviewRoute.author.actorLogin.toLowerCase()) {
    throw new DeliveryError(
      'Existing PR author differs from the configured author actor; inspect the PR and resolve the actor mismatch explicitly.',
    );
  }
  await pushReviewedHead(context, row.path, row.branch, head.sha);
  const pr = existing
    ? (await context.clients.rest.pulls.get({ ...context.repo, pull_number: existing.number })).data
    : (
        await context.clients.rest.pulls.create({
          ...context.repo,
          base: baseBranch(root, context.configuration?.remote),
          body,
          draft: true,
          head: row.branch,
          title,
        })
      ).data;
  if (pr.head.sha !== head.sha || pr.base.sha !== remoteHead || pr.state !== 'open' || !pr.draft) {
    throw new DeliveryError('Draft PR readback does not match the verified head and base.');
  }
  if (!pr.user?.login || pr.user.login.toLowerCase() !== reviewRoute.author.actorLogin.toLowerCase()) {
    throw new DeliveryError(
      'Published PR author differs from the selected author credential; inspect the PR before continuing.',
    );
  }
  const content = {
    baseSha: remoteHead,
    evidenceId: evidence.evidenceId,
    headSha: head.sha,
    issueNumber: input.issueNumber,
    prNumber: pr.number,
    schemaVersion: 'ai-delivery.publication@1' as const,
  };
  const publication = PublicationSchema.parse({ ...content, publicationId: digestValue(content) });
  writePrivateJsonFileAtomically(publicationPath(row.path, input.issueNumber, head.sha), publication);
  await updateIssueWorktreeDelivery({
    branch: row.branch,
    issueNumber: input.issueNumber,
    path: row.path,
    prNumber: pr.number,
    projectRoot: root,
    status: 'pr-published',
  });
  return { prNumber: pr.number, url: pr.html_url, publicationEvidenceId: evidence.evidenceId, reviewRoute };
}

export async function submitFormalReview(
  context: DeliveryContext,
  input: {
    artifact: string;
    issueNumber: number;
    prNumber: number;
  },
): Promise<{
  receiptId: string;
  githubReviewId: number;
  reviewState: Awaited<ReturnType<typeof readRequiredReviewState>>;
}> {
  const row = getIssueWorktreeStrict(input.issueNumber, context.root);
  const run = loadVerifiedRun(row.path, input.issueNumber);
  const publication = loadPublication(row.path, input.issueNumber, run.classification.head.sha);
  if (publication.prNumber !== input.prNumber) throw new DeliveryError('Review PR does not match exact publication.');
  const receipt = await submitReview({
    artifact: parseReviewArtifact(input.artifact),
    classification: run.classification,
    context,
    issueNumber: input.issueNumber,
    prNumber: input.prNumber,
    publicationEvidenceId: publication.evidenceId,
  });
  return {
    receiptId: receipt.receiptId,
    githubReviewId: receipt.githubReviewId,
    reviewState: await readRequiredReviewState(context, input.prNumber, run.classification.head.sha, {
      id: receipt.githubReviewId,
      login: receipt.login,
    }),
  };
}

async function checkPrMergeability(
  context: DeliveryContext,
  prNumber: number,
  expectedHead: string,
): Promise<{
  baseSha: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  blockedBy: number[];
  checksPassed: boolean;
}> {
  const pr = (await context.clients.rest.pulls.get({ ...context.repo, pull_number: prNumber })).data;
  if (pr.state !== 'open' || pr.draft || pr.head.sha !== expectedHead)
    throw new DeliveryError('PR is not clean, ready and mergeable at the exact reviewed head.');
  const reviewState = await readRequiredReviewState(context, prNumber, expectedHead);
  if (reviewState.status === 'still-required') {
    throw new DeliveryError(
      `The submitted APPROVED review is stored, but GitHub still requires a qualifying approval. ${reviewState.nextAction}`,
    );
  }
  if (reviewState.status === 'changes-requested') {
    throw new DeliveryError(`GitHub reports changes requested. ${reviewState.nextAction}`);
  }
  if (pr.mergeable !== true || pr.mergeable_state !== 'clean')
    throw new DeliveryError('PR is not clean, ready and mergeable at the exact reviewed head.');
  const issueNumber = Number(/^issue\/(\d+)$/u.exec(pr.head.ref)?.[1]);
  if (!Number.isSafeInteger(issueNumber)) throw new DeliveryError('PR branch is not a registered issue branch.');
  const relationships = await getNativeBlockerRelationships({
    graphql: context.clients.graphql,
    issueNumber,
    repo: context.repo,
  });
  const blockedBy = relationships.blockers.filter((value) => value.state === 'OPEN').map((value) => value.number);
  const [checks, statuses] = await Promise.all([
    context.clients.rest.checks.listForRef({ ...context.repo, ref: expectedHead, per_page: 100 }),
    context.clients.rest.repos.getCombinedStatusForRef({ ...context.repo, ref: expectedHead }),
  ]);
  const checksPassed =
    checks.data.total_count === checks.data.check_runs.length &&
    checks.data.check_runs.every(
      (check) => check.status === 'completed' && ['success', 'neutral', 'skipped'].includes(check.conclusion ?? ''),
    ) &&
    (statuses.data.statuses.length === 0 || statuses.data.state === 'success');
  if (!checksPassed || blockedBy.length > 0)
    throw new DeliveryError('PR has failed or pending checks or unresolved native blockers.');
  return {
    baseSha: pr.base.sha,
    baseBranch: pr.base.ref,
    headBranch: pr.head.ref,
    title: pr.title,
    blockedBy,
    checksPassed,
  };
}

/** @internal Lifecycle primitive; exported for local interruption tests. */
export async function mergeWithExactLease(
  context: DeliveryContext,
  input: {
    baseBranch: string;
    baseSha: string;
    headBranch: string;
    headSha: string;
    headTree: string;
    title: string;
    prNumber: number;
    worktreePath: string;
    beforeMutation?: () => void;
    onPreparedMergeCommit?: (sha: string) => void;
  },
): Promise<string> {
  if (gitExitCode(input.worktreePath, 'merge-base', '--is-ancestor', input.baseSha, input.headSha) !== 0) {
    throw new DeliveryError('Exact-lease merge requires the verified base to be an ancestor of the reviewed head.');
  }
  const latest = (await context.clients.rest.pulls.get({ ...context.repo, pull_number: input.prNumber })).data;
  if (
    latest.base.sha !== input.baseSha ||
    latest.head.sha !== input.headSha ||
    latest.base.ref !== input.baseBranch ||
    latest.head.ref !== input.headBranch
  )
    throw new DeliveryError('Exact base or head drifted before atomic merge.');
  const repo = await context.clients.graphql<{ repository: { id: string } | null }>(
    'query RepositoryId($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }',
    { owner: context.repo.owner, name: context.repo.repo },
  );
  if (!repo.repository?.id) throw new DeliveryError('GitHub omitted repository node identity.');
  input.beforeMutation?.();
  const created = (
    await context.clients.rest.git.createCommit({
      ...context.repo,
      message: input.title,
      parents: [input.baseSha, input.headSha],
      tree: input.headTree,
    })
  ).data;
  const mergeSha = Sha.parse(created.sha);
  input.onPreparedMergeCommit?.(mergeSha);
  const clientMutationId = `ai-delivery-exact-${mergeSha}`;
  const response = await context.clients.graphql<{ updateRefs: { clientMutationId: string | null } }>(
    'mutation UpdateExactRefs($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }',
    {
      input: {
        clientMutationId,
        repositoryId: repo.repository.id,
        refUpdates: [
          { name: `refs/heads/${input.baseBranch}`, beforeOid: input.baseSha, afterOid: mergeSha, force: false },
          { name: `refs/heads/${input.headBranch}`, beforeOid: input.headSha, afterOid: input.headSha, force: false },
        ],
      },
    },
  );
  if (response.updateRefs.clientMutationId !== clientMutationId)
    throw new DeliveryError('Atomic merge mutation identity readback failed.');
  const [base, head, commit] = await Promise.all([
    context.clients.rest.git.getRef({ ...context.repo, ref: `heads/${input.baseBranch}` }),
    context.clients.rest.git.getRef({ ...context.repo, ref: `heads/${input.headBranch}` }),
    context.clients.rest.git.getCommit({ ...context.repo, commit_sha: mergeSha }),
  ]);
  if (
    base.data.object.sha !== mergeSha ||
    head.data.object.sha !== input.headSha ||
    commit.data.tree.sha !== input.headTree ||
    commit.data.parents[0]?.sha !== input.baseSha ||
    commit.data.parents[1]?.sha !== input.headSha
  )
    throw new DeliveryError('Atomic merge ref or commit readback failed.');
  const pr = (await context.clients.rest.pulls.get({ ...context.repo, pull_number: input.prNumber })).data;
  if (pr.state !== 'closed' || !pr.merged_at || pr.merge_commit_sha !== mergeSha) {
    throw new DeliveryError('GitHub did not report the exact merge commit as the completed PR.');
  }
  return mergeSha;
}

async function readMergedResult(
  context: DeliveryContext,
  intent: MergeIntent,
  expectedSha?: string,
): Promise<{
  mergeSha: string;
  mergeTree: string;
}> {
  const pr = (await context.clients.rest.pulls.get({ ...context.repo, pull_number: intent.prNumber })).data;
  if (
    pr.state !== 'closed' ||
    !pr.merged_at ||
    pr.head.sha !== intent.headSha ||
    pr.head.ref !== intent.headBranch ||
    pr.base.ref !== intent.baseBranch
  ) {
    throw new DeliveryError('Merged PR does not match the exact prepared merge intent.');
  }
  const mergeSha = Sha.parse(pr.merge_commit_sha);
  if (expectedSha !== undefined && mergeSha !== expectedSha) {
    throw new DeliveryError('Merged PR does not match the exact prepared merge intent.');
  }
  const [base, head, commit] = await Promise.all([
    context.clients.rest.git.getRef({ ...context.repo, ref: `heads/${intent.baseBranch}` }),
    context.clients.rest.git.getRef({ ...context.repo, ref: `heads/${intent.headBranch}` }).catch((error) => {
      if ((error as { status?: number }).status === 404) return null;
      throw error;
    }),
    context.clients.rest.git.getCommit({ ...context.repo, commit_sha: mergeSha }),
  ]);
  const expectedMergeTree =
    !intent.exactBaseHeadLease && (intent.strategy === 'merge' || intent.strategy === 'squash')
      ? git(context.root, 'merge-tree', '--write-tree', intent.baseSha, intent.headSha)
      : intent.headTree;
  if (
    !base.data.object.sha ||
    (head !== null && head.data.object.sha !== intent.headSha) ||
    commit.data.sha !== mergeSha ||
    (intent.strategy === 'merge' &&
      (commit.data.parents[0]?.sha !== intent.baseSha ||
        commit.data.parents[1]?.sha !== intent.headSha ||
        commit.data.tree.sha !== expectedMergeTree)) ||
    (intent.strategy === 'squash' &&
      (commit.data.parents[0]?.sha !== intent.baseSha || commit.data.tree.sha !== expectedMergeTree))
  ) {
    throw new DeliveryError('Remote merge ref, branch or commit readback disagrees with the prepared intent.');
  }
  if (expectedSha === undefined && intent.strategy === 'rebase') {
    throw new DeliveryError('Rebase recovery lacks the returned exact merge SHA.');
  }
  return { mergeSha, mergeTree: Sha.parse(commit.data.tree.sha) };
}

async function expectedMergeAttempt(context: DeliveryContext, intent: MergeIntent): Promise<MergeAttempt> {
  if (context.clients.role !== 'author' || !context.clients.authenticatedAuthor) {
    throw new DeliveryError('Merge recovery requires authenticated author identity readback.');
  }
  const verified = await context.clients.authenticatedAuthor();
  if (!verified.actorLogin || !verified.credentialIdentity) {
    throw new DeliveryError('Authenticated author identity readback is incomplete.');
  }
  const content = {
    actor: context.config.roles.author.identity,
    actorLogin: verified.actorLogin,
    authSource: context.clients.authSource,
    credentialIdentity: verified.credentialIdentity,
    intentId: intent.intentId,
    operation: intent.exactBaseHeadLease ? ('updateRefs' as const) : ('pulls.merge' as const),
    schemaVersion: 'ai-delivery.merge-attempt@1' as const,
  };
  return MergeAttemptSchema.parse({ ...content, attemptId: digestValue(content) });
}

function persistMergeResult(root: string, intent: MergeIntent, attempt: MergeAttempt, mergeSha: string): void {
  const content = {
    attemptId: attempt.attemptId,
    mergeSha: Sha.parse(mergeSha),
    schemaVersion: 'ai-delivery.merge-result@1' as const,
  };
  writePrivateJsonFileAtomically(
    mergeResultPath(root, intent.issueNumber, intent.headSha),
    MergeResultSchema.parse({ ...content, resultId: digestValue(content) }),
  );
}

/** @internal Lifecycle primitive; exported for local interruption tests. */
export async function persistMergedResult(
  context: DeliveryContext,
  input: {
    intent: MergeIntent;
    path: string;
    worktreePath: string;
    branch: string;
    expectedSha?: string;
  },
): Promise<MergeReceipt> {
  const { mergeSha, mergeTree } = await readMergedResult(context, input.intent, input.expectedSha);
  const { schemaVersion: _version, ...intentContent } = input.intent;
  const content = { ...intentContent, mergeSha, mergeTree, schemaVersion: 'ai-delivery.merge@3' as const };
  const merged = MergeSchema.parse({ ...content, mergeId: digestValue(content) });
  writePrivateJsonFileAtomically(input.path, merged);
  await updateIssueWorktreeDelivery({
    branch: input.branch,
    issueNumber: input.intent.issueNumber,
    path: input.worktreePath,
    projectRoot: context.root,
    status: 'merged',
  });
  return merged;
}

async function validateTerminalMerge(
  context: DeliveryContext,
  row: WorktreeEntry,
  run: VerificationRun,
  publication: Publication,
  existing: MergeReceipt,
): Promise<void> {
  const head = run.classification.head;
  const pr = (await context.clients.rest.pulls.get({ ...context.repo, pull_number: existing.prNumber })).data;
  if (
    existing.prNumber !== row.prNumber ||
    existing.issueNumber !== row.issueNumber ||
    existing.headSha !== head.sha ||
    publication.prNumber !== existing.prNumber ||
    publication.issueNumber !== existing.issueNumber ||
    publication.headSha !== head.sha ||
    publication.baseSha !== run.classification.base.sha ||
    pr.state !== 'closed' ||
    !pr.merged_at ||
    pr.head.sha !== head.sha ||
    pr.head.ref !== row.branch ||
    pr.merge_commit_sha !== existing.mergeSha
  )
    throw new DeliveryError('Merged PR readback or publication disagrees with terminal receipt.');
  const intent = readOptionalPrivate(mergeIntentPath(row.path, existing.issueNumber, head.sha), (value) =>
    MergeIntentSchema.parse(value),
  );
  if (
    !intent ||
    intent.intentId !== existing.intentId ||
    intent.baseSha !== run.classification.base.sha ||
    intent.headSha !== head.sha ||
    intent.headTree !== head.tree
  )
    throw new DeliveryError('Terminal merge lacks its exact verified intent.');
  const historicalReview = loadSubmittedReview(row.path, existing.issueNumber, head.sha);
  if (
    !historicalReview ||
    historicalReview.prNumber !== existing.prNumber ||
    historicalReview.headSha !== head.sha ||
    historicalReview.artifact.issueNumber !== existing.issueNumber ||
    historicalReview.artifact.head.tree !== head.tree ||
    historicalReview.artifact.diffScopeHash !== digestValue(run.classification.changedPaths) ||
    historicalReview.artifact.verdict !== 'approve' ||
    historicalReview.publicationEvidenceId !== publication.evidenceId ||
    historicalReview.receiptId !== intent.reviewReceiptId
  )
    throw new DeliveryError('Terminal merge publication lacks its exact historical approved review.');
  const result = await readMergedResult(context, intent, existing.mergeSha);
  if (result.mergeTree !== existing.mergeTree) throw new DeliveryError('Terminal merge tree changed.');
  const { schemaVersion: _version, ...intentContent } = intent;
  const expected = { ...intentContent, ...result, schemaVersion: 'ai-delivery.merge@3' as const };
  if (existing.mergeId !== digestValue(expected))
    throw new DeliveryError('Terminal merge receipt disagrees with its intent.');
}

/** @internal Read-only ancestor validation for the locked committed-descendant continuation. */
export async function readMergedContinuationTerminal(
  context: DeliveryContext,
  row: WorktreeEntry,
  operator: { actorLogin: string; credentialIdentity: string },
): Promise<{ terminal: MergeReceipt; preserved: { path: string; digest: string }[] }> {
  if (row.status !== 'merged' || row.prNumber === undefined || row.issueNumber === undefined)
    throw new DeliveryError('Committed continuation requires exact merged issue custody.');
  const pr = (await context.clients.rest.pulls.get({ ...context.repo, pull_number: row.prNumber })).data;
  const historical = loadHistoricalMergedRun(row.path, Sha.parse(pr.head.sha));
  const head = historical.run.classification.head.sha;
  const publication = loadPublication(row.path, row.issueNumber, head);
  const path = mergePath(row.path, row.issueNumber, head);
  const terminal = readOptionalPrivate(path, (value) => MergeSchema.parse(value));
  if (!terminal || !historical.run.writer || historical.run.classification.repository !== context.config.repository)
    throw new DeliveryError('Committed continuation lacks supported exact historical terminal provenance.');
  await validateTerminalMerge(context, row, historical.run, publication, terminal);
  const lineage = await context.clients.graphql<{
    repository: { pullRequest: { closingIssuesReferences: unknown } | null } | null;
  }>(
    `query CommittedContinuationLineage($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
      closingIssuesReferences(first: 100) { nodes { number repository { nameWithOwner } } pageInfo { hasNextPage } }
    } }
  }`,
    { ...context.repo, number: row.prNumber },
  );
  const closing = z
    .object({
      nodes: z.array(
        z.object({ number: z.number().int().positive(), repository: z.object({ nameWithOwner: z.string().min(1) }) }),
      ),
      pageInfo: z.object({ hasNextPage: z.literal(false) }),
    })
    .safeParse(lineage.repository?.pullRequest?.closingIssuesReferences);
  if (
    !closing.success ||
    pr.head.repo?.full_name.toLowerCase() !== context.config.repository.toLowerCase() ||
    pr.base.repo.full_name.toLowerCase() !== context.config.repository.toLowerCase()
  )
    throw new DeliveryError(
      'Native PR lineage does not establish the exact repository and complete closing connection.',
    );
  if (
    closing.data.nodes.some(
      (issue) =>
        issue.number === row.issueNumber &&
        issue.repository.nameWithOwner.toLowerCase() === context.config.repository.toLowerCase(),
    )
  ) {
    await readNativeWorktreePrLineage(context, row.issueNumber, row.prNumber);
  } else {
    const mergedAt = Date.parse(pr.merged_at ?? '');
    if (
      closing.data.nodes.length !== 0 ||
      !new RegExp(`^Refs[ \\t]+#${String(row.issueNumber)}(?=$|[ \\t.,;:!?])`, 'imu').test(pr.body ?? '') ||
      !Number.isFinite(mergedAt) ||
      !pr.merged ||
      pr.head.ref !== row.branch ||
      !pr.base.ref ||
      !Sha.safeParse(pr.base.sha).success ||
      pr.merge_commit_sha !== terminal.mergeSha
    )
      throw new DeliveryError('Native PR lineage lacks the exact unfinished Refs relationship.');
    const reference = z.object({
      event: z.literal('cross-referenced'),
      actor: z.object({ login: z.string(), id: z.number().int().positive(), type: z.literal('User') }),
      created_at: z.string(),
      source: z.object({
        type: z.literal('issue'),
        issue: z.object({
          number: z.number().int().positive(),
          user: z.object({ login: z.string(), id: z.number().int().positive(), type: z.literal('User') }),
          repository_url: z.string(),
          html_url: z.string(),
          pull_request: z.object({ url: z.string() }),
        }),
      }),
    });
    let matched = false;
    // Read every page before accepting even a matching first-page reference.
    for (let page = 1; ; page += 1) {
      const events = await context.clients.rest.issues.listEventsForTimeline({
        ...context.repo,
        issue_number: row.issueNumber,
        per_page: 100,
        page,
      });
      if (!Array.isArray(events.data)) throw new DeliveryError('Native PR lineage timeline is incomplete.');
      for (const event of events.data) {
        const parsed = reference.safeParse(event);
        if (!parsed.success) continue;
        const native = parsed.data;
        const at = Date.parse(native.created_at);
        matched ||=
          Number.isFinite(at) &&
          at < mergedAt &&
          native.actor.login.toLowerCase() === operator.actorLogin.toLowerCase() &&
          `user:${String(native.actor.id)}` === operator.credentialIdentity &&
          native.source.issue.number === row.prNumber &&
          native.source.issue.user.login.toLowerCase() === operator.actorLogin.toLowerCase() &&
          `user:${String(native.source.issue.user.id)}` === operator.credentialIdentity &&
          native.source.issue.repository_url === pr.base.repo.url &&
          native.source.issue.html_url === pr.html_url &&
          native.source.issue.pull_request.url === pr.url;
      }
      if (events.data.length < 100 && !/;\s*rel="next"/u.test(events.headers.link ?? '')) break;
    }
    if (!matched)
      throw new DeliveryError('Native PR lineage lacks complete authenticated before-merge cross-reference evidence.');
  }
  const attemptPath = mergeAttemptPath(row.path, row.issueNumber, head);
  const resultPath = mergeResultPath(row.path, row.issueNumber, head);
  const attempt = readOptionalPrivate(attemptPath, (value) => MergeAttemptSchema.parse(value));
  const result = readOptionalPrivate(resultPath, (value) => MergeResultSchema.parse(value));
  if (
    pr.number !== row.prNumber ||
    pr.user?.type !== 'User' ||
    pr.user.login.toLowerCase() !== operator.actorLogin.toLowerCase() ||
    `user:${String(pr.user.id)}` !== operator.credentialIdentity ||
    !attempt ||
    attempt.authSource !== 'personal' ||
    attempt.actorLogin.toLowerCase() !== operator.actorLogin.toLowerCase() ||
    attempt.credentialIdentity !== operator.credentialIdentity ||
    attempt.intentId !== terminal.intentId ||
    !result ||
    result.attemptId !== attempt.attemptId ||
    result.mergeSha !== terminal.mergeSha
  )
    throw new DeliveryError(
      'Committed continuation authenticated host author disagrees with native historical custody.',
    );
  return {
    terminal,
    preserved: [
      historical.path,
      publicationPath(row.path, row.issueNumber, head),
      join(gitCommonDir(row.path), 'ai-delivery', 'reviews', String(row.issueNumber), `${head}.json`),
      mergeIntentPath(row.path, row.issueNumber, head),
      attemptPath,
      resultPath,
      path,
    ].map((file) => ({ path: file, digest: digestBytes(assertPrivateFile(file)) })),
  };
}

export async function mergePr(
  context: DeliveryContext,
  input: {
    issueNumber: number;
    prNumber: number;
    strategy?: 'merge' | 'squash' | 'rebase';
  },
): Promise<MergeReceipt> {
  const row = getIssueWorktreeStrict(input.issueNumber, context.root);
  const receiptRoot = existsSync(row.path) ? row.path : context.root;
  const run =
    receiptRoot === row.path
      ? loadVerifiedRun(row.path, input.issueNumber)
      : loadRemovedMergedRun(context.root, input.issueNumber);
  const head = run.classification.head;
  const publication = loadPublication(receiptRoot, input.issueNumber, head.sha);
  if (
    publication.prNumber !== input.prNumber ||
    publication.issueNumber !== input.issueNumber ||
    publication.headSha !== head.sha ||
    publication.baseSha !== run.classification.base.sha
  )
    throw new DeliveryError('Merge publication does not match its exact issue, PR or verified coordinates.');
  const existingPath = mergePath(receiptRoot, input.issueNumber, head.sha);
  const existing = readOptionalPrivate(existingPath, (value) => MergeSchema.parse(value));
  if (existing) {
    await validateTerminalMerge(
      context,
      { ...row, path: receiptRoot, prNumber: input.prNumber },
      run,
      publication,
      existing,
    );
    await updateIssueWorktreeDelivery({
      branch: row.branch,
      issueNumber: input.issueNumber,
      path: row.path,
      projectRoot: context.root,
      status: 'merged',
    });
    return existing;
  }
  if (receiptRoot !== row.path) {
    throw new DeliveryError('Removed merged worktree lacks its terminal merge receipt.');
  }
  const intentPath = mergeIntentPath(row.path, input.issueNumber, head.sha);
  const prepared = readOptionalPrivate(intentPath, (value) => MergeIntentSchema.parse(value));
  const attemptPath = mergeAttemptPath(row.path, input.issueNumber, head.sha);
  const priorAttempt = readOptionalPrivate(attemptPath, (value) => MergeAttemptSchema.parse(value));
  const priorResult = readOptionalPrivate(mergeResultPath(row.path, input.issueNumber, head.sha), (value) =>
    MergeResultSchema.parse(value),
  );
  if ((priorAttempt !== null || priorResult !== null) && prepared === null) {
    throw new DeliveryError('Merge operation record lacks its prepared intent.');
  }
  const review = loadSubmittedReview(row.path, input.issueNumber, head.sha);
  if (!review || review.prNumber !== input.prNumber || review.publicationEvidenceId !== publication.evidenceId) {
    throw new DeliveryError('Exact publication lacks its bound submitted independent review.');
  }
  await assertSubmittedReviewCurrent(context, review);
  if (prepared) {
    if (
      prepared.issueNumber !== input.issueNumber ||
      prepared.prNumber !== input.prNumber ||
      prepared.headSha !== head.sha ||
      prepared.headTree !== head.tree ||
      prepared.reviewReceiptId !== review.receiptId ||
      prepared.headBranch !== row.branch ||
      prepared.baseSha !== run.classification.base.sha ||
      (input.strategy !== undefined && input.strategy !== prepared.strategy)
    ) {
      throw new DeliveryError('Prepared merge intent disagrees with this retry.');
    }
    if (priorAttempt !== null) {
      const expected = await expectedMergeAttempt(context, prepared);
      if (
        priorAttempt.attemptId !== expected.attemptId ||
        (priorResult !== null && priorResult.attemptId !== priorAttempt.attemptId)
      ) {
        throw new DeliveryError('Merge attempt disagrees with its exact source, operation or author.');
      }
      const remote = (await context.clients.rest.pulls.get({ ...context.repo, pull_number: input.prNumber })).data;
      if (remote.state !== 'closed' || !remote.merged_at) {
        throw new DeliveryError(
          'Merge mutation was attempted; remote readback is unresolved. Retry readback without another mutation.',
        );
      }
      return persistMergedResult(context, {
        branch: row.branch,
        intent: prepared,
        path: existingPath,
        worktreePath: row.path,
        ...(priorResult === null ? {} : { expectedSha: priorResult.mergeSha }),
      });
    }
    if (priorResult !== null) throw new DeliveryError('Merge result lacks its bound attempt.');
    const remote = (await context.clients.rest.pulls.get({ ...context.repo, pull_number: input.prNumber })).data;
    if (remote.state === 'closed' && remote.merged_at) {
      return persistMergedResult(context, {
        branch: row.branch,
        intent: prepared,
        path: existingPath,
        worktreePath: row.path,
      });
    }
    if (
      remote.state !== 'open' ||
      remote.head.sha !== head.sha ||
      remote.head.ref !== row.branch ||
      remote.base.ref !== prepared.baseBranch ||
      remote.base.sha !== prepared.baseSha
    ) {
      throw new DeliveryError('Prepared merge retry disagrees with the remote PR.');
    }
  }
  const currentPublication = await createIssuePhaseEvidence({
    personalAuth: context.clients.authSource === 'personal' && context.config.roles.author.authSource !== 'personal',
    ...(run.classification.risk === 'high'
      ? {
          approval: reviewArtifactApproval({
            artifact: review.artifact,
            classification: run.classification,
            config: context.config,
            issueNumber: input.issueNumber,
            prNumber: input.prNumber,
          }),
        }
      : {}),
    issueNumber: input.issueNumber,
    phase: 'publish',
    repoRoot: row.path,
  });
  if (currentPublication.evidenceId !== publication.evidenceId) {
    throw new DeliveryError('Publication evidence changed after formal review.');
  }
  const readback = await checkPrMergeability(context, input.prNumber, head.sha);
  if (readback.baseSha !== run.classification.base.sha || readback.headBranch !== row.branch) {
    throw new DeliveryError('PR base or registered head drifted after verification.');
  }
  const approval: RepositoryApprovalBinding = {
    authorIdentity: context.config.roles.author.identity,
    reviewerIdentity: context.config.roles.reviewer.identity,
    diffScopeHash: review.artifact.diffScopeHash,
    head,
    result: 'approved',
    reviewReceiptId: review.receiptId,
  };
  const evidence = await createIssuePhaseEvidence({
    personalAuth: context.clients.authSource === 'personal' && context.config.roles.author.authSource !== 'personal',
    approval,
    issueNumber: input.issueNumber,
    mergeReadback: {
      blockedBy: readback.blockedBy,
      checksPassed: readback.checksPassed,
      head,
      mergeable: true,
      observedAt: new Date().toISOString(),
    },
    phase: 'merge',
    repoRoot: row.path,
  });
  const loaded = await loadDeliveryConfig(row.path, {
    personalAuth: context.clients.authSource === 'personal' && context.config.roles.author.authSource !== 'personal',
  });
  const selected = await loadSelectedRepositoryPolicy({
    repoRoot: row.path,
    policySourcePath: loaded.config.policy.module,
  });
  const boundary = validateRepositoryPolicyBoundary({
    classification: run.classification,
    configDigest: loaded.configDigest,
    currentBase: run.classification.base,
    currentHead: head,
    phase: 'merge',
    policy: selected.policy,
    policySourcePath: loaded.config.policy.module,
    repoRoot: row.path,
    stageReceiptIds: run.aggregate.stages.map((stage) => ({ stageId: stage.stageId, receiptId: stage.receiptId })),
  });
  if (boundary.additionalConstraints.exactBaseHeadLease && input.strategy && input.strategy !== 'merge') {
    throw new DeliveryError('Exact base/head lease requires merge-commit strategy.');
  }
  const strategy = boundary.additionalConstraints.exactBaseHeadLease
    ? 'merge'
    : (input.strategy ?? prepared?.strategy ?? 'squash');
  const intentContent = {
    baseBranch: readback.baseBranch,
    baseSha: readback.baseSha,
    exactBaseHeadLease: boundary.additionalConstraints.exactBaseHeadLease,
    evidenceId: prepared?.evidenceId ?? evidence.evidenceId,
    headBranch: readback.headBranch,
    headSha: head.sha,
    headTree: head.tree,
    issueNumber: input.issueNumber,
    prNumber: input.prNumber,
    reviewReceiptId: review.receiptId,
    schemaVersion: 'ai-delivery.merge-intent@2' as const,
    strategy,
  };
  const intent = MergeIntentSchema.parse({ ...intentContent, intentId: digestValue(intentContent) });
  if (prepared && prepared.intentId !== intent.intentId) {
    throw new DeliveryError('Prepared merge intent no longer matches reviewed inputs.');
  }
  if (!prepared) writePrivateJsonFileAtomically(intentPath, intent);
  const attempt = await expectedMergeAttempt(context, intent);
  let mergeSha: string;
  if (boundary.additionalConstraints.exactBaseHeadLease) {
    mergeSha = await mergeWithExactLease(context, {
      baseBranch: readback.baseBranch,
      baseSha: readback.baseSha,
      headBranch: readback.headBranch,
      headSha: head.sha,
      headTree: head.tree,
      title: readback.title,
      prNumber: input.prNumber,
      worktreePath: row.path,
      beforeMutation: () => writePrivateJsonFileAtomically(attemptPath, attempt),
      onPreparedMergeCommit: (sha) => persistMergeResult(row.path, intent, attempt, sha),
    });
  } else {
    writePrivateJsonFileAtomically(attemptPath, attempt);
    mergeSha = (
      await context.clients.rest.pulls.merge({
        ...context.repo,
        pull_number: input.prNumber,
        sha: head.sha,
        merge_method: strategy,
      })
    ).data.sha;
  }
  persistMergeResult(row.path, intent, attempt, mergeSha);
  return persistMergedResult(context, {
    branch: row.branch,
    intent,
    path: existingPath,
    worktreePath: row.path,
    expectedSha: Sha.parse(mergeSha),
  });
}

export async function finishIssue(
  context: DeliveryContext,
  input: {
    issueNumber: number;
    prNumber: number;
    strategy?: 'merge' | 'squash' | 'rebase';
  },
): Promise<{ mergeSha: string; issueClosed: true; cleaned: true }> {
  const matches = listWorktreesStrict(context.root).filter(
    (entry) => entry.type === 'issue' && entry.issueNumber === input.issueNumber,
  );
  if (matches.length === 0) return readCompletedIssue(context, input);
  if (matches.length !== 1) throw new DeliveryError('Issue has duplicate worktree registry rows.');
  const row = getIssueWorktreeStrict(input.issueNumber, context.root);
  const metadata = await getConfiguredNativeIssueMetadata({
    issueNumber: input.issueNumber,
    owner: context.repo.owner,
    repo: context.repo.repo,
    rest: context.clients.rest,
    settings: nativeIssueSettingsFromDeliveryConfig(context.config),
  });
  if (metadata.points === undefined || !context.config.native.points.values.includes(String(metadata.points))) {
    throw new DeliveryError('Executable issue requires configured native Points before finish.');
  }
  const points = metadata.points as DeliveryRecord['points'];
  const merge = await mergePr(context, input);
  const review = loadSubmittedReview(existsSync(row.path) ? row.path : context.root, input.issueNumber, merge.headSha);
  if (!review) throw new DeliveryError('Terminal delivery requires the submitted review receipt.');
  const issue = (await context.clients.rest.issues.get({ ...context.repo, issue_number: input.issueNumber })).data;
  if (issue.state !== 'closed')
    await context.clients.rest.issues.update({
      ...context.repo,
      issue_number: input.issueNumber,
      state: 'closed',
    });
  const closed = (await context.clients.rest.issues.get({ ...context.repo, issue_number: input.issueNumber })).data;
  if (closed.state !== 'closed') throw new DeliveryError('Issue close readback failed.');
  await syncIssueProjectStatus({
    graphql: context.clients.graphql,
    issueNodeId: closed.node_id,
    org: context.config.native.organization,
    ...(context.projectConfiguration ? { configuration: context.projectConfiguration } : {}),
    settings: projectSettingsFromDeliveryConfig(context.config),
    status: 'Done',
  });
  const branch = baseBranch(context.root, context.configuration?.remote);
  await fetchMergedBase(context, branch);
  const pr = (await context.clients.rest.pulls.get({ ...context.repo, pull_number: input.prNumber })).data;
  const [remoteBase, remoteHead] = await Promise.all([
    context.clients.rest.git.getRef({ ...context.repo, ref: `heads/${branch}` }),
    context.clients.rest.git.getRef({ ...context.repo, ref: `heads/issue/${input.issueNumber}` }).catch((error) => {
      if ((error as { status?: number }).status === 404) return null;
      throw error;
    }),
  ]);
  if (
    pr.state !== 'closed' ||
    !pr.merged_at ||
    pr.merge_commit_sha !== merge.mergeSha ||
    pr.head.sha !== merge.headSha ||
    pr.head.ref !== `issue/${input.issueNumber}` ||
    pr.base.ref !== branch
  )
    throw new DeliveryError('Merged PR drifted before cleanup.');
  const attestation = {
    baseBranch: merge.baseBranch,
    baseSha: merge.baseSha,
    headBranch: merge.headBranch,
    headSha: merge.headSha,
    mergeSha: merge.mergeSha,
    mergeTree: merge.mergeTree,
    remoteBaseSha: remoteBase.data.object.sha,
    remoteHeadSha: remoteHead?.data.object.sha ?? null,
    strategy: merge.strategy,
  };
  const mergedAt = pr.merged_at;
  if (typeof mergedAt !== 'string' || Date.parse(mergedAt) < Date.parse(row.createdAt)) {
    throw new DeliveryError('Terminal delivery timeline is invalid.');
  }
  await cleanupMergedIssueWorktree({
    ...(context.configuration?.remote ? { remote: context.configuration.remote } : {}),
    issueNumber: input.issueNumber,
    repoRoot: context.root,
    merge: attestation,
    afterRemoval: async () => {
      const terminalCleanupAt = new Date().toISOString();
      const metrics = review.artifact.deliveryMetrics;
      await recordMergedDelivery(
        {
          blockerTimeMs: metrics?.blockerTimeMs ?? null,
          cycleTimeMs: Date.parse(mergedAt) - Date.parse(row.createdAt),
          firstPassApproved: metrics === undefined ? null : metrics.reviewRound === 1,
          issueNumber: input.issueNumber,
          mergedAt,
          mergeSha: merge.mergeSha,
          points,
          recordedAt: terminalCleanupAt,
          repository: `${context.repo.owner}/${context.repo.repo}`,
          reviewRounds: metrics?.reviewRound ?? null,
          schemaVersion: 'ai-delivery.delivery-record@1',
          terminalCleanupAt,
        },
        context.root,
      );
    },
  });
  await journalIssueCloseout(context, input, merge.mergeSha);
  return { mergeSha: merge.mergeSha, issueClosed: true, cleaned: true };
}

async function journalIssueCloseout(
  context: DeliveryContext,
  input: { issueNumber: number; prNumber: number },
  mergeSha: string,
): Promise<void> {
  const issue = (await context.clients.rest.issues.get({ ...context.repo, issue_number: input.issueNumber })).data;
  const pr = (await context.clients.rest.pulls.get({ ...context.repo, pull_number: input.prNumber })).data;
  const criteria = acceptanceCriteria(issue.body ?? '');
  if (!criteria.length) throw new DeliveryError('Closeout requires acceptance criteria with public delivery evidence.');
  await commentIssue(
    context,
    {
      issueNumber: input.issueNumber,
      kind: 'closeout',
      summary: `Merged delivery completed for ${issue.title}.`,
      status: 'Closed; merged and cleaned',
      acceptance: criteria.map((criterion) => ({ criterion, evidence: pr.html_url })),
      followUps: issueFollowUps(issue.body ?? ''),
      keyNumbers: [`${String(criteria.length)} acceptance criteria`, `PR #${String(input.prNumber)}`],
      evidence: [pr.html_url],
      nextStep: 'No further delivery action; see the merged PR for verification and follow-ups',
      nextDate: null,
    },
    `closeout:${mergeSha}`,
  );
}

async function readCompletedIssue(
  context: DeliveryContext,
  input: { issueNumber: number; prNumber: number },
): Promise<{ mergeSha: string; issueClosed: true; cleaned: true }> {
  const pr = (await context.clients.rest.pulls.get({ ...context.repo, pull_number: input.prNumber })).data;
  if (pr.state !== 'closed' || !pr.merged_at || !pr.merge_commit_sha || pr.head.ref !== `issue/${input.issueNumber}`) {
    throw new DeliveryError('Absent issue worktree lacks an exact completed PR.');
  }
  const receipt = readOptionalPrivate(mergePath(context.root, input.issueNumber, pr.head.sha), (value) =>
    MergeSchema.parse(value),
  );
  const intent = readOptionalPrivate(mergeIntentPath(context.root, input.issueNumber, pr.head.sha), (value) =>
    MergeIntentSchema.parse(value),
  );
  if (
    !receipt ||
    !intent ||
    receipt.issueNumber !== input.issueNumber ||
    receipt.prNumber !== input.prNumber ||
    receipt.headSha !== pr.head.sha ||
    receipt.mergeSha !== pr.merge_commit_sha ||
    receipt.intentId !== intent.intentId
  ) {
    throw new DeliveryError('Absent issue worktree lacks exact terminal merge receipts.');
  }
  const result = await readMergedResult(context, intent, receipt.mergeSha);
  const { schemaVersion: _version, ...intentContent } = intent;
  if (
    result.mergeTree !== receipt.mergeTree ||
    receipt.mergeId !== digestValue({ ...intentContent, ...result, schemaVersion: 'ai-delivery.merge@3' })
  ) {
    throw new DeliveryError('Completed merge receipt disagrees with its intent or remote result.');
  }
  const records = getDeliveryRecords(context.root).filter(
    (record) =>
      record.repository === `${context.repo.owner}/${context.repo.repo}` &&
      record.issueNumber === input.issueNumber &&
      record.mergeSha === receipt.mergeSha,
  );
  if (records.length !== 1) throw new DeliveryError('Completed issue lacks one exact terminal delivery record.');
  const issue = (await context.clients.rest.issues.get({ ...context.repo, issue_number: input.issueNumber })).data;
  if (issue.state !== 'closed' || 'pull_request' in issue) {
    throw new DeliveryError('Completed issue is not closed.');
  }
  const project = await getIssueProjectStatus({
    graphql: context.clients.graphql,
    issueNodeId: issue.node_id,
    org: context.config.native.organization,
    ...(context.projectConfiguration ? { configuration: context.projectConfiguration } : {}),
    settings: projectSettingsFromDeliveryConfig(context.config),
  });
  if (project?.status !== 'Done') throw new DeliveryError('Completed issue Project status is not Done.');
  await journalIssueCloseout(context, input, receipt.mergeSha);
  return { mergeSha: receipt.mergeSha, issueClosed: true, cleaned: true };
}
