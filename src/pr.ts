import { DeliveryError } from './errors.js';
import { createDeliveryGitHubClients, type GitHubClients } from './github/client.js';
import { getNativeBlockerRelationships } from './github/relationships.js';
import { issueBranch, startIssueBranch, type DeliveryContext } from './issue.js';
import {
  parseGitHubReviewArtifact,
  parseReviewArtifact,
  readGitHubPrScopeHash,
  readRequiredReviewState,
  submitReview,
} from './review.js';

const Sha = /^[a-f0-9]{40}$/u;
const Branch = /^(?!.*(?:\.\.|@\{|\/\/))[A-Za-z0-9._/-]+$/u;

function validSha(value: unknown): value is string {
  return typeof value === 'string' && Sha.test(value);
}
function validBranch(value: string): void {
  if (!Branch.test(value) || value.startsWith('/') || value.endsWith('/') || value.endsWith('.lock'))
    throw new DeliveryError('Invalid GitHub branch name.');
}
async function getPr(context: DeliveryContext, prNumber: number) {
  if (context.config.repository.toLowerCase() !== `${context.repo.owner}/${context.repo.repo}`.toLowerCase())
    throw new DeliveryError('Configured and selected GitHub repository identities disagree.');
  const pr = (await context.clients.rest.pulls.get({ ...context.repo, pull_number: prNumber })).data;
  if (
    pr.number !== prNumber ||
    pr.base.repo?.full_name.toLowerCase() !== context.config.repository.toLowerCase() ||
    pr.head.repo?.full_name.toLowerCase() !== context.config.repository.toLowerCase() ||
    !validSha(pr.head.sha)
  )
    throw new DeliveryError('GitHub PR identity or exact head readback is invalid.');
  return pr;
}
async function mergedIssueAssociation(context: DeliveryContext, prNumber: number, issueNumber: number): Promise<void> {
  let cursor: string | null = null;
  const cursors = new Set<string>();
  let matches = 0;
  for (let page = 0; page < 20; page++) {
    const result: ClosingIssuesQuery = await context.clients.graphql<ClosingIssuesQuery>(
      'query DeliveryClosingIssues($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){closingIssuesReferences(first:100,after:$cursor){nodes{number repository{nameWithOwner}} pageInfo{hasNextPage endCursor}}}}}',
      { ...context.repo, number: prNumber, cursor },
    );
    const connection = result.repository?.pullRequest?.closingIssuesReferences;
    if (!connection || !Array.isArray(connection.nodes) || typeof connection.pageInfo?.hasNextPage !== 'boolean')
      throw new DeliveryError('Incomplete merged GitHub PR issue association readback.');
    for (const issue of connection.nodes) {
      if (!issue || !Number.isSafeInteger(issue.number) || issue.number <= 0 || !issue.repository?.nameWithOwner)
        throw new DeliveryError('Incomplete merged PR issue identity.');
      if (
        issue.number === issueNumber &&
        issue.repository.nameWithOwner.toLowerCase() === context.config.repository.toLowerCase()
      )
        matches++;
    }
    if (!connection.pageInfo.hasNextPage) {
      if (matches !== 1)
        throw new DeliveryError('Merged GitHub PR does not identify the intended issue; issue remains open.');
      return;
    }
    const next = connection.pageInfo.endCursor;
    if (!next || cursors.has(next)) throw new DeliveryError('Merged PR issue pagination did not advance.');
    cursors.add(next);
    cursor = next;
  }
  throw new DeliveryError('Merged PR issue association exceeds the bounded readback window.');
}
interface ClosingIssuesQuery {
  repository: {
    pullRequest: {
      closingIssuesReferences: {
        nodes: Array<{ number: number; repository: { nameWithOwner: string } } | null>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } | null;
  } | null;
}
async function matchingPrs(context: DeliveryContext, branch: string, base?: string) {
  const matches: Awaited<ReturnType<typeof context.clients.rest.pulls.list>>['data'] = [];
  for (let page = 1; page <= 20; page++) {
    const batch = (
      await context.clients.rest.pulls.list({
        ...context.repo,
        head: `${context.repo.owner}:${branch}`,
        ...(base === undefined ? {} : { base }),
        state: 'all',
        page,
        per_page: 100,
      })
    ).data;
    matches.push(...batch);
    if (batch.length < 100) return matches;
  }
  throw new DeliveryError('GitHub PR match history exceeds the bounded readback window.');
}
async function verifyIssuePr(context: DeliveryContext, issueNumber: number, prNumber: number) {
  const pr = await getPr(context, prNumber);
  await mergedIssueAssociation(context, prNumber, issueNumber);
  if (!pr.merged) {
    const branch = await issueBranch(context, issueNumber, pr.head.ref);
    if (pr.head.ref !== branch) throw new DeliveryError('GitHub PR is not linked to the requested issue branch.');
  }
  return pr;
}
export async function prInfo(context: DeliveryContext, input: { issueNumber?: number; prNumber?: number }) {
  let number = input.prNumber;
  if (number === undefined) {
    if (input.issueNumber === undefined) throw new DeliveryError('prNumber or issueNumber is required.');
    const branch = await issueBranch(context, input.issueNumber);
    const matches = await matchingPrs(context, branch);
    if (matches.length !== 1)
      throw new DeliveryError('Select an explicit PR number when the remote issue branch has zero or multiple PRs.');
    number = matches[0]!.number;
  }
  const pr = await getPr(context, number);
  return {
    prNumber: pr.number,
    url: pr.html_url,
    state: pr.state,
    draft: pr.draft,
    headSha: pr.head.sha,
    headBranch: pr.head.ref,
    baseBranch: pr.base.ref,
    merged: pr.merged,
  };
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
  base?: string,
  selectedReviewer?: GitHubClients,
  purpose: 'development' | 'publication' = 'publication',
  control?: { signal: AbortSignal; checkResources: () => Promise<void> },
): Promise<ReviewRoutePreflight> {
  if (base === undefined) {
    try {
      base = (await context.clients.rest.repos.get({ ...context.repo })).data.default_branch;
    } catch {
      throw new DeliveryError('Author cannot read the selected GitHub repository; verify configured access.');
    }
  }
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
    context.reviewerClients ??
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
    issueNumber: number;
    body?: string;
    title?: string;
    draft?: boolean;
    headBranch?: string;
    baseBranch?: string;
    dryRun?: boolean;
  },
) {
  const branch = await issueBranch(context, input.issueNumber, input.headBranch);
  if (input.headBranch !== undefined && input.headBranch !== branch)
    throw new DeliveryError('Requested PR branch differs from the GitHub-linked issue branch.');
  validBranch(branch);
  const issue = (await context.clients.rest.issues.get({ ...context.repo, issue_number: input.issueNumber })).data;
  if ('pull_request' in issue || issue.number !== input.issueNumber || issue.state !== 'open')
    throw new DeliveryError('PR creation requires the requested open GitHub issue.');
  const defaultBranch = (await context.clients.rest.repos.get({ ...context.repo })).data.default_branch;
  const base = input.baseBranch ?? defaultBranch;
  if (base !== defaultBranch)
    throw new DeliveryError('PR delivery requires the repository default branch for durable issue association.');
  validBranch(base);
  const ref = (await context.clients.rest.git.getRef({ ...context.repo, ref: `heads/${branch}` })).data;
  if (!validSha(ref.object.sha)) throw new DeliveryError('Remote issue branch head is invalid.');
  const requestedBody = input.body ?? `Closes #${input.issueNumber}`;
  if (!requestedBody.trim()) throw new DeliveryError('PR body must contain text.');
  const body = new RegExp(`(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\\s+#${input.issueNumber}(?![0-9])`, 'iu').test(
    requestedBody,
  )
    ? requestedBody
    : `${requestedBody}\n\nCloses #${input.issueNumber}`;
  const matches = await matchingPrs(context, branch, base);
  if (matches.length > 1) throw new DeliveryError('Remote issue branch has conflicting PR matches.');
  let pr = matches[0] === undefined ? undefined : await getPr(context, matches[0].number);
  if (
    pr &&
    (pr.head.sha !== ref.object.sha ||
      pr.head.ref !== branch ||
      pr.base.ref !== base ||
      pr.state !== 'open' ||
      (input.body !== undefined && pr.body !== body) ||
      (input.title !== undefined && pr.title !== input.title))
  )
    throw new DeliveryError('Existing remote PR conflicts with the requested branch, intent or state.');
  const reviewRoute = await preflightReviewRoute(context, base);
  if (pr && pr.user?.login.toLowerCase() !== reviewRoute.author.actorLogin.toLowerCase())
    throw new DeliveryError('Existing PR author differs from the configured authenticated author.');
  if (pr) await mergedIssueAssociation(context, pr.number, input.issueNumber);
  if (input.dryRun) return { dryRun: true, headSha: ref.object.sha, headBranch: branch, baseBranch: base, reviewRoute };
  if (pr) {
    if (input.draft === false && pr.draft) {
      await context.clients.graphql(
        'mutation DeliveryReadyPr($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id isDraft}}}',
        { id: pr.node_id },
      );
      pr = await getPr(context, pr.number);
      if (pr.draft) throw new DeliveryError('PR promotion readback is still draft.');
    }
  } else {
    pr = (
      await context.clients.rest.pulls.create({
        ...context.repo,
        head: branch,
        base,
        title: input.title ?? issue.title,
        body,
        draft: input.draft !== false,
      })
    ).data;
    pr = await getPr(context, pr.number);
  }
  if (pr.head.sha !== ref.object.sha || pr.head.ref !== branch || pr.base.ref !== base)
    throw new DeliveryError('GitHub PR creation readback drifted.');
  if (pr.user?.login.toLowerCase() !== reviewRoute.author.actorLogin.toLowerCase())
    throw new DeliveryError('Published PR author differs from the configured authenticated author.');
  await mergedIssueAssociation(context, pr.number, input.issueNumber);
  return { prNumber: pr.number, url: pr.html_url, headSha: pr.head.sha, draft: pr.draft, reviewRoute };
}

export async function submitFormalReview(
  context: DeliveryContext,
  input: { artifact: string; issueNumber: number; prNumber: number; dryRun?: boolean },
) {
  await verifyIssuePr(context, input.issueNumber, input.prNumber);
  return submitReview({
    context,
    artifact: parseReviewArtifact(input.artifact),
    issueNumber: input.issueNumber,
    prNumber: input.prNumber,
    ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
  });
}
async function allReviews(context: DeliveryContext, prNumber: number) {
  const reviews: Awaited<ReturnType<typeof context.clients.rest.pulls.listReviews>>['data'] = [];
  for (let page = 1; page <= 20; page++) {
    const batch = (
      await context.clients.rest.pulls.listReviews({ ...context.repo, pull_number: prNumber, page, per_page: 100 })
    ).data;
    reviews.push(...batch);
    if (batch.length < 100) return reviews;
  }
  throw new DeliveryError('GitHub review history exceeds the bounded readback window.');
}
export async function mergePr(
  context: DeliveryContext,
  input: {
    issueNumber: number;
    prNumber: number;
    strategy?: 'merge' | 'squash' | 'rebase';
    reviewedHeadSha?: string;
    dryRun?: boolean;
  },
) {
  if (
    context.clients.role !== 'author' ||
    context.clients.authSource !== (context.config.roles.author.authSource ?? 'app') ||
    !context.clients.authenticatedAuthor
  )
    throw new DeliveryError('Merge and finish require the configured authenticated author role.');
  const author = await context.clients.authenticatedAuthor();
  if (!author.actorLogin || !author.credentialIdentity)
    throw new DeliveryError('Author identity readback is incomplete.');
  let pr = await verifyIssuePr(context, input.issueNumber, input.prNumber);
  if (input.reviewedHeadSha !== undefined && input.reviewedHeadSha !== pr.head.sha)
    throw new DeliveryError('Requested reviewed head differs from the GitHub PR.');
  if (pr.merged && pr.state === 'closed' && validSha(pr.merge_commit_sha))
    return { mergeSha: pr.merge_commit_sha, headSha: pr.head.sha, reused: true };
  const route = await preflightReviewRoute(context, pr.base.ref);
  if (route.approvalEligibility === 'insufficient-permission')
    throw new DeliveryError('Configured reviewer App is ineligible for the required approval.');
  if (pr.state !== 'open' || pr.draft) throw new DeliveryError('GitHub PR must be open and ready for merge.');
  const reviewer =
    context.reviewerClients ??
    (await createDeliveryGitHubClients({
      config: context.config,
      identity: context.config.roles.reviewer.identity,
      role: 'reviewer',
      selectedAuthor: context.clients,
    }));
  if (reviewer.role !== 'reviewer' || reviewer.authSource !== 'app' || !reviewer.appActorLogin)
    throw new DeliveryError('Independent reviewer App route is unavailable.');
  const actor = await reviewer.appActorLogin();
  if (!pr.user?.login || actor.toLowerCase() === pr.user.login.toLowerCase())
    throw new DeliveryError('Reviewer App must differ from the PR author.');
  const reviews = (await allReviews(context, input.prNumber)).filter(
    (review) =>
      review.user?.login.toLowerCase() === actor.toLowerCase() &&
      review.commit_id === pr.head.sha &&
      review.state === 'APPROVED' &&
      /<!-- ai-delivery-review-artifact: sha256:[a-f0-9]{64} -->/u.test(review.body ?? ''),
  );
  if (reviews.length !== 1)
    throw new DeliveryError('GitHub requires one unambiguous exact-head independent App review.');
  const approved = reviews[0]!;
  const readReview = (
    await context.clients.rest.pulls.getReview({ ...context.repo, pull_number: input.prNumber, review_id: approved.id })
  ).data;
  if (
    readReview.id !== approved.id ||
    readReview.state !== 'APPROVED' ||
    readReview.commit_id !== pr.head.sha ||
    readReview.user?.login.toLowerCase() !== actor.toLowerCase() ||
    readReview.body !== approved.body
  )
    throw new DeliveryError('Independent GitHub review readback changed or was dismissed.');
  const artifact = parseGitHubReviewArtifact(readReview.body);
  if (
    artifact.verdict !== 'approve' ||
    artifact.issueNumber !== input.issueNumber ||
    (artifact.prNumber !== null && artifact.prNumber !== input.prNumber) ||
    artifact.authorIdentity !== context.config.roles.author.identity ||
    artifact.reviewerIdentity !== context.config.roles.reviewer.identity ||
    artifact.head.sha !== pr.head.sha
  )
    throw new DeliveryError('Independent review artifact binding is stale, foreign or rejected.');
  const commit = (await context.clients.rest.git.getCommit({ ...context.repo, commit_sha: pr.head.sha })).data;
  if (commit.sha !== artifact.head.sha || commit.tree.sha !== artifact.head.tree)
    throw new DeliveryError('Independent review tree differs from the remote commit.');
  if (artifact.diffScopeHash !== (await readGitHubPrScopeHash(context, input.prNumber, pr.changed_files)))
    throw new DeliveryError('Independent review scope differs from the remote PR diff.');
  const reviewedHead = artifact.head.sha;
  if (input.reviewedHeadSha !== undefined && input.reviewedHeadSha !== reviewedHead)
    throw new DeliveryError('Requested reviewed head differs from the independent GitHub review.');
  const decision = await readRequiredReviewState(context, input.prNumber, reviewedHead!, {
    id: approved.id,
    login: actor,
  });
  if (decision.submittedReviewAuthorCanPushToRepository !== true)
    throw new DeliveryError('Specific reviewer App approval is not verifiably qualifying for required review.');
  if (decision.status !== 'satisfied')
    throw new DeliveryError(`GitHub review eligibility is ${decision.status}: ${decision.nextAction}`);
  const blockers = await getNativeBlockerRelationships({
    graphql: context.clients.graphql,
    issueNumber: input.issueNumber,
    repo: context.repo,
  });
  if (blockers.blockers.some((value) => value.state === 'OPEN'))
    throw new DeliveryError('GitHub issue has unresolved native blockers.');
  pr = await verifyIssuePr(context, input.issueNumber, input.prNumber);
  if (
    pr.head.sha !== reviewedHead ||
    pr.state !== 'open' ||
    pr.draft ||
    pr.mergeable !== true ||
    pr.mergeable_state !== 'clean'
  )
    throw new DeliveryError(
      `GitHub merge eligibility is ${pr.mergeable_state ?? 'unknown'}; CLEAN at the reviewed head is required.`,
    );
  const currentBase = (await context.clients.rest.git.getRef({ ...context.repo, ref: `heads/${pr.base.ref}` })).data
    .object.sha;
  if (!validSha(currentBase) || currentBase !== pr.base.sha)
    throw new DeliveryError('GitHub base moved; refresh clean eligibility and independent review before merge.');
  if (input.dryRun) return { dryRun: true, headSha: reviewedHead, prNumber: pr.number };
  const result = (
    await context.clients.rest.pulls.merge({
      ...context.repo,
      pull_number: input.prNumber,
      sha: reviewedHead,
      merge_method: input.strategy ?? 'squash',
    })
  ).data;
  if (!result.merged || !validSha(result.sha)) throw new DeliveryError('GitHub refused the reviewed-head merge.');
  const readback = await verifyIssuePr(context, input.issueNumber, input.prNumber);
  if (
    !readback.merged ||
    readback.state !== 'closed' ||
    readback.head.sha !== reviewedHead ||
    readback.merge_commit_sha !== result.sha
  )
    throw new DeliveryError('GitHub merged PR readback disagrees with the reviewed-head mutation.');
  return { mergeSha: result.sha, headSha: reviewedHead, reused: false };
}
export async function finishIssue(
  context: DeliveryContext,
  input: {
    issueNumber: number;
    prNumber: number;
    strategy?: 'merge' | 'squash' | 'rebase';
    reviewedHeadSha?: string;
    dryRun?: boolean;
  },
) {
  const result = await mergePr(context, input);
  if (input.dryRun) return result;
  const pr = await verifyIssuePr(context, input.issueNumber, input.prNumber);
  if (!pr.merged || pr.state !== 'closed' || pr.merge_commit_sha !== result.mergeSha)
    throw new DeliveryError('Intended GitHub PR is not verifiably merged; issue remains open.');
  const issue = (await context.clients.rest.issues.get({ ...context.repo, issue_number: input.issueNumber })).data;
  if (issue.number !== input.issueNumber || 'pull_request' in issue)
    throw new DeliveryError('Finish target is not the intended GitHub issue.');
  if (issue.state !== 'closed')
    await context.clients.rest.issues.update({
      ...context.repo,
      issue_number: input.issueNumber,
      state: 'closed',
      state_reason: 'completed',
    });
  const readback = (await context.clients.rest.issues.get({ ...context.repo, issue_number: input.issueNumber })).data;
  if (readback.number !== input.issueNumber || readback.state !== 'closed')
    throw new DeliveryError('GitHub issue closure readback disagrees.');
  return { ...result, issueClosed: true };
}
export { startIssueBranch };
