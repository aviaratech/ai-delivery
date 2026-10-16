import { DeliveryError } from './errors.js';
import * as githubClients from './github/client.js';
import type { GitHubClients } from './github/client.js';
import { getNativeBlockerRelationships } from './github/relationships.js';
import {
  commentIssue,
  issueBranch,
  linkedIssueBranches,
  readIssueClosure,
  startIssueBranch,
  type DeliveryContext,
} from './issue.js';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertPrivateFile, digestBytes, digestValue, stableJson } from './delivery/common.js';
import { gitCommonDir, primaryGitRoot } from './git.js';
import { ensurePrivateDirectoryDurably } from './utils/atomicJson.js';
import { resolveRepoFromRemote } from './github/repo.js';
import { authenticatedWorktreeActors, assertNativeWorktreeAcceptance } from './worktreeTransition.js';
import { withWorktreeTransitionWriterAbsent } from './verification.js';
import { assertInvestigationSource, investigationSourceIdentity, removeInvestigationSource } from './worktree.js';
import {
  InvestigationPreparationSchema,
  completeInvestigationCustody,
  readInvestigationAcknowledgement,
  readInvestigationPreparation,
  registerInvestigationCustody,
  type InvestigationPreparation,
} from './services/worktreeRegistry.js';
import {
  parseGitHubReviewArtifact,
  parseReviewArtifact,
  readGitHubPrScopeHash,
  readRequiredReviewState,
  submitReview,
} from './review.js';

const Sha = /^[a-f0-9]{40}$/u;
const Branch = /^(?!.*(?:\.\.|@\{|\/\/))[A-Za-z0-9._/-]+$/u;

// Conservative refusals also cover Markdown decoration/escaped references.
// This is a closure safety check, never authority for an issue association.
function refuseClosingDirective(text: unknown): asserts text is string {
  if (typeof text !== 'string') throw new DeliveryError('Incomplete non-closing message readback.');
  const normalized = text.replace(/[*_~`\\<>[\]]/gu, '');
  if (
    /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\b(?:\s*:\s*|\s+)[^\n]*?(?:#[0-9]+|[A-Za-z0-9.-]+\/[A-Za-z0-9.-]+#[0-9]+|https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9.-]+\/[A-Za-z0-9.-]+\/(?:issues|pull)\/[0-9]+)/iu.test(
      normalized,
    )
  )
    throw new DeliveryError('Non-closing delivery refuses closing directives in body, title or commit messages.');
}
function referenceLine(context: DeliveryContext, issueNumber: number) {
  return `References ${context.config.repository}#${issueNumber}`;
}
function nonClosingBody(context: DeliveryContext, issueNumber: number, requested: string) {
  refuseClosingDirective(requested);
  const line = referenceLine(context, issueNumber);
  const body = requested.startsWith(`${line}\n`) || requested === line ? requested : `${line}\n\n${requested}`;
  verifyReferenceBody(context, issueNumber, body);
  return body;
}
function verifyReferenceBody(context: DeliveryContext, issueNumber: number, body: unknown): asserts body is string {
  refuseClosingDirective(body);
  const lines = body.split(/\r?\n/u);
  if (
    lines[0] !== referenceLine(context, issueNumber) ||
    lines.filter((line) => /^References\s/iu.test(line)).length !== 1
  )
    throw new DeliveryError('Non-closing PR body must retain one leading canonical References line.');
}
function pageCursor(connection: { pageInfo?: { hasNextPage: boolean; endCursor: string | null } }, seen: Set<string>) {
  const info = connection.pageInfo;
  if (
    !info ||
    typeof info.hasNextPage !== 'boolean' ||
    !(info.endCursor === null || typeof info.endCursor === 'string')
  )
    throw new DeliveryError('Incomplete non-closing native pagination.');
  if (!info.hasNextPage) return null;
  if (!info.endCursor || seen.has(info.endCursor))
    throw new DeliveryError('Non-closing native pagination did not advance.');
  seen.add(info.endCursor);
  return info.endCursor;
}
async function openReferenceIssue(context: DeliveryContext, issueNumber: number) {
  const issue = (await context.clients.rest.issues.get({ ...context.repo, issue_number: issueNumber })).data;
  if (
    issue.number !== issueNumber ||
    'pull_request' in issue ||
    issue.state !== 'open' ||
    typeof issue.node_id !== 'string' ||
    !issue.node_id ||
    typeof issue.title !== 'string' ||
    typeof issue.body !== 'string' ||
    issue.html_url?.toLowerCase() !==
      `https://github.com/${context.config.repository}/issues/${issueNumber}`.toLowerCase()
  )
    throw new DeliveryError('Non-closing delivery requires the exact canonical OPEN issue and complete title/body.');
  return issue;
}
type RemotePr = Awaited<ReturnType<typeof getPr>>;
function sameReferencePr(before: RemotePr, after: RemotePr, expectedMerge = false) {
  if (
    expectedMerge
      ? before.state !== 'open' ||
        before.draft ||
        before.merged ||
        after.state !== 'closed' ||
        after.draft ||
        !after.merged
      : before.state !== after.state || before.draft !== after.draft || before.merged !== after.merged
  )
    throw new DeliveryError('Non-closing PR state/draft/merged readback drifted; reconcile read-only.');
  if (
    before.node_id !== after.node_id ||
    before.head.sha !== after.head.sha ||
    before.head.ref !== after.head.ref ||
    before.base.sha !== after.base.sha ||
    before.base.ref !== after.base.ref ||
    before.body !== after.body ||
    before.title !== after.title ||
    before.user.login.toLowerCase() !== after.user.login.toLowerCase()
  )
    throw new DeliveryError('Non-closing PR identity, reference, message or head/base drifted; reconcile read-only.');
}
function sameReferenceIssue(
  before: Awaited<ReturnType<typeof openReferenceIssue>>,
  after: Awaited<ReturnType<typeof openReferenceIssue>>,
) {
  if (before.node_id !== after.node_id || before.title !== after.title || before.body !== after.body)
    throw new DeliveryError('Non-closing issue identity/title/criteria drifted; reconcile read-only.');
}
function nonClosingMode(value: unknown) {
  if (value !== undefined && typeof value !== 'boolean') throw new DeliveryError('nonClosing must be a boolean.');
  return value === true;
}
async function nonClosingRoute(context: DeliveryContext, base: string) {
  const authorContext =
    context.clients.role === 'author'
      ? context
      : {
          ...context,
          clients: await githubClients.createDeliveryGitHubClients({
            config: context.config,
            identity: context.config.roles.author.identity,
            role: 'author',
          }),
          reviewerClients: context.clients,
        };
  const route = await preflightReviewRoute(authorContext, base);
  if (route.rules.visibility !== 'complete' || route.approvalEligibility === 'insufficient-permission')
    throw new DeliveryError(
      'Non-closing delivery requires complete native rule visibility and an independent reviewer route.',
    );
  return route;
}
async function verifyNonClosingCommits(context: DeliveryContext, pr: RemotePr) {
  let cursor: string | null = null;
  const cursors = new Set<string>();
  const commits = new Map<string, string>();
  let total: number | undefined;
  for (let page = 0; page < 20; page++) {
    const data: {
      repository?: {
        nameWithOwner: string;
        pullRequest?: {
          id: string;
          number: number;
          headRefOid: string;
          baseRefOid: string;
          baseRefName: string;
          commits: {
            totalCount: number;
            nodes: Array<{
              commit: {
                oid: string;
                message: string;
                parents: {
                  totalCount: number;
                  nodes: Array<{ oid: string }>;
                  pageInfo: { hasNextPage: boolean; endCursor: string | null };
                };
              };
            }>;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        };
      };
    } = await context.clients.graphql(
      'query DeliveryNonClosingCommits($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){nameWithOwner pullRequest(number:$number){id number headRefOid baseRefOid baseRefName commits(first:100,after:$cursor){totalCount nodes{commit{oid message parents(first:100){totalCount nodes{oid} pageInfo{hasNextPage endCursor}}}} pageInfo{hasNextPage endCursor}}}}}',
      { ...context.repo, number: pr.number, cursor },
    );
    const live = data.repository?.pullRequest;
    const connection = live?.commits;
    if (
      data.repository?.nameWithOwner?.toLowerCase() !== context.config.repository.toLowerCase() ||
      live?.id !== pr.node_id ||
      live.number !== pr.number ||
      live.headRefOid !== pr.head.sha ||
      live.baseRefOid !== pr.base.sha ||
      live.baseRefName !== pr.base.ref ||
      !connection ||
      !Array.isArray(connection.nodes) ||
      connection.nodes.length > 100 ||
      !Number.isSafeInteger(connection.totalCount) ||
      connection.totalCount < 1 ||
      connection.totalCount > 2000 ||
      (total !== undefined && total !== connection.totalCount)
    )
      throw new DeliveryError('Incomplete or moved introduced commit graph at the non-closing head/base.');
    total = connection.totalCount;
    for (const node of connection.nodes) {
      const commit = node?.commit;
      if (
        !commit ||
        !validSha(commit.oid) ||
        commits.has(commit.oid) ||
        !commit.parents ||
        !Array.isArray(commit.parents.nodes) ||
        commit.parents.nodes.length > 100 ||
        !Number.isSafeInteger(commit.parents.totalCount) ||
        commit.parents.totalCount < 1 ||
        commit.parents.totalCount !== commit.parents.nodes.length ||
        commit.parents.pageInfo?.hasNextPage !== false ||
        commit.parents.nodes.some((parent) => !validSha(parent?.oid))
      )
        throw new DeliveryError('Incomplete, duplicate or truncated introduced commit identity/parents.');
      refuseClosingDirective(commit.message);
      commits.set(commit.oid, commit.message);
    }
    cursor = pageCursor(connection, cursors);
    if (cursor === null) {
      if (commits.size !== total || !commits.has(pr.head.sha))
        throw new DeliveryError('Introduced commit count/head is incomplete.');
      return;
    }
  }
  throw new DeliveryError('Non-closing commit graph exceeds the bounded readback window.');
}
async function verifyUnpublishedCommits(context: DeliveryContext, baseSha: string, headSha: string) {
  const commits = new Set<string>();
  let total: number | undefined;
  for (let page = 1; page <= 20; page++) {
    const comparison = (
      await context.clients.rest.repos.compareCommitsWithBasehead({
        ...context.repo,
        basehead: `${baseSha}...${headSha}`,
        per_page: 100,
        page,
      })
    ).data;
    if (
      comparison.base_commit?.sha !== baseSha ||
      !validSha(comparison.merge_base_commit?.sha) ||
      !['ahead', 'diverged'].includes(comparison.status) ||
      !Number.isSafeInteger(comparison.total_commits) ||
      comparison.total_commits < 1 ||
      comparison.total_commits > 2000 ||
      (total !== undefined && total !== comparison.total_commits) ||
      !Array.isArray(comparison.commits) ||
      comparison.commits.length > 100
    )
      throw new DeliveryError('Incomplete introduced commit range before non-closing publication.');
    total = comparison.total_commits;
    for (const commit of comparison.commits) {
      if (
        !validSha(commit.sha) ||
        commits.has(commit.sha) ||
        !Array.isArray(commit.parents) ||
        commit.parents.length < 1 ||
        commit.parents.length > 100 ||
        commit.parents.some((parent) => !validSha(parent.sha))
      )
        throw new DeliveryError('Incomplete or duplicate introduced commit identity.');
      refuseClosingDirective(commit.commit?.message);
      commits.add(commit.sha);
    }
    if (commits.size === total && commits.has(headSha)) return;
    if (comparison.commits.length < 100)
      throw new DeliveryError('Truncated introduced commit range before publication.');
  }
  throw new DeliveryError('Introduced commit range exceeds the bounded readback window.');
}
async function verifyNonClosingReference(context: DeliveryContext, issueNumber: number, pr: RemotePr) {
  if (
    typeof pr.node_id !== 'string' ||
    !pr.node_id ||
    pr.html_url?.toLowerCase() !== `https://github.com/${context.config.repository}/pull/${pr.number}`.toLowerCase()
  )
    throw new DeliveryError('Incomplete non-closing PR node identity.');
  verifyReferenceBody(context, issueNumber, pr.body);
  refuseClosingDirective(pr.title);
  const issue = await openReferenceIssue(context, issueNumber);
  const repository = (await context.clients.rest.repos.get({ ...context.repo })).data;
  if (
    repository.full_name?.toLowerCase() !== context.config.repository.toLowerCase() ||
    pr.base.ref !== repository.default_branch ||
    typeof repository.node_id !== 'string' ||
    !repository.node_id
  )
    throw new DeliveryError('Non-closing PR must target the canonical default repository/base.');
  const route = await nonClosingRoute(context, pr.base.ref);
  if (pr.user.login.toLowerCase() !== route.author.actorLogin.toLowerCase())
    throw new DeliveryError('Non-closing PR author differs from the configured author.');
  let cursor: string | null = null;
  const cursors = new Set<string>();
  const events = new Map<string, string>();
  let matched = false;
  for (let page = 0; page < 20; page++) {
    type Subject = {
      __typename: string;
      id: string;
      number: number;
      repository: { id: string; nameWithOwner: string };
    };
    const data: {
      repository?: {
        id: string;
        nameWithOwner: string;
        issue?: {
          id: string;
          number: number;
          state: string;
          timelineItems: {
            nodes: Array<{
              id: string;
              actor: { login: string } | null;
              isCrossRepository: boolean;
              willCloseTarget: boolean;
              source: Subject;
              target: Subject;
            }>;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        };
      };
    } = await context.clients.graphql(
      'query DeliveryNonClosingReferences($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){id nameWithOwner issue(number:$number){id number state timelineItems(first:100,after:$cursor,itemTypes:[CROSS_REFERENCED_EVENT]){nodes{... on CrossReferencedEvent{id actor{login} isCrossRepository willCloseTarget source{__typename ... on Issue{id number repository{id nameWithOwner}} ... on PullRequest{id number repository{id nameWithOwner}}} target{__typename ... on Issue{id number repository{id nameWithOwner}} ... on PullRequest{id number repository{id nameWithOwner}}}}} pageInfo{hasNextPage endCursor}}}}}',
      { ...context.repo, number: issueNumber, cursor },
    );
    const target = data.repository?.issue;
    const connection = target?.timelineItems;
    if (
      data.repository?.id !== repository.node_id ||
      data.repository.nameWithOwner?.toLowerCase() !== context.config.repository.toLowerCase() ||
      target?.id !== issue.node_id ||
      target.number !== issueNumber ||
      target.state !== 'OPEN' ||
      !connection ||
      !Array.isArray(connection.nodes) ||
      connection.nodes.length > 100
    )
      throw new DeliveryError('Incomplete or conflicting native non-closing issue identity.');
    for (const event of connection.nodes) {
      const source = event?.source;
      const referenced = event?.target;
      if (
        !event ||
        !nativeId(event.id) ||
        !source ||
        !referenced ||
        !['Issue', 'PullRequest'].includes(source.__typename) ||
        !nativeId(source.id) ||
        !Number.isSafeInteger(source.number) ||
        source.number <= 0 ||
        !nativeId(source.repository?.id) ||
        typeof source.repository.nameWithOwner !== 'string' ||
        referenced.__typename !== 'Issue' ||
        referenced.id !== issue.node_id ||
        referenced.number !== issueNumber ||
        referenced.repository?.id !== repository.node_id ||
        referenced.repository.nameWithOwner?.toLowerCase() !== context.config.repository.toLowerCase() ||
        typeof event.isCrossRepository !== 'boolean' ||
        typeof event.willCloseTarget !== 'boolean' ||
        !nativeId(event.actor?.login)
      )
        throw new DeliveryError('Incomplete native cross-reference event identity/actor.');
      const signature = JSON.stringify([
        source.__typename,
        source.id,
        source.number,
        source.repository.id,
        source.repository.nameWithOwner.toLowerCase(),
        referenced.id,
        referenced.number,
        referenced.repository.id,
        referenced.repository.nameWithOwner.toLowerCase(),
        event.actor.login.toLowerCase(),
        event.isCrossRepository,
        event.willCloseTarget,
      ]);
      if (events.has(event.id) && events.get(event.id) !== signature)
        throw new DeliveryError('Conflicting duplicate native reference event.');
      events.set(event.id, signature);
      if (
        source.id === pr.node_id ||
        (source.__typename === 'PullRequest' &&
          source.number === pr.number &&
          source.repository.nameWithOwner.toLowerCase() === context.config.repository.toLowerCase())
      ) {
        if (
          source.__typename !== 'PullRequest' ||
          source.id !== pr.node_id ||
          source.number !== pr.number ||
          source.repository.id !== repository.node_id ||
          source.repository.nameWithOwner.toLowerCase() !== context.config.repository.toLowerCase() ||
          event.isCrossRepository ||
          event.willCloseTarget !== false ||
          event.actor.login.toLowerCase() !== route.author.actorLogin.toLowerCase()
        )
          throw new DeliveryError('Conflicting, closing or unauthorized native PR reference.');
        matched = true;
      }
    }
    cursor = pageCursor(connection, cursors);
    if (cursor === null) break;
    if (page === 19) throw new DeliveryError('Native non-closing references exceed the bounded readback window.');
  }
  if (!matched) throw new DeliveryError('Missing authorized native non-closing PR-to-issue reference.');
  await verifyPrIssueAssociation(context, pr.number, issueNumber, true, pr.node_id);
  await verifyNonClosingCommits(context, pr);
  if (!pr.merged) {
    const ref = (await context.clients.rest.git.getRef({ ...context.repo, ref: `heads/${pr.base.ref}` })).data;
    if (ref.ref !== `refs/heads/${pr.base.ref}` || ref.object.type !== 'commit' || ref.object.sha !== pr.base.sha)
      throw new DeliveryError('Non-closing default base has moved or is incomplete.');
  }
  const after = await openReferenceIssue(context, issueNumber);
  sameReferenceIssue(issue, after);
  sameReferencePr(pr, await getPr(context, pr.number));
  return issue;
}

function nativeId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function validSha(value: unknown): value is string {
  return typeof value === 'string' && Sha.test(value);
}
function validBranch(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !Branch.test(value) ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.endsWith('.lock')
  )
    throw new DeliveryError('Invalid GitHub branch name.');
}
async function getPr(context: DeliveryContext, prNumber: number) {
  if (context.config.repository.toLowerCase() !== `${context.repo.owner}/${context.repo.repo}`.toLowerCase())
    throw new DeliveryError('Configured and selected GitHub repository identities disagree.');
  const pr = (await context.clients.rest.pulls.get({ ...context.repo, pull_number: prNumber })).data;
  if (
    pr.number !== prNumber ||
    typeof pr.base.repo?.full_name !== 'string' ||
    typeof pr.head.repo?.full_name !== 'string' ||
    pr.base.repo?.full_name.toLowerCase() !== context.config.repository.toLowerCase() ||
    pr.head.repo?.full_name.toLowerCase() !== context.config.repository.toLowerCase() ||
    !validSha(pr.head.sha) ||
    !validSha(pr.base.sha) ||
    (pr.state !== 'open' && pr.state !== 'closed') ||
    typeof pr.merged !== 'boolean' ||
    typeof pr.draft !== 'boolean' ||
    (pr.merged && pr.state !== 'closed')
  )
    throw new DeliveryError('GitHub PR identity or exact head readback is invalid.');
  validBranch(pr.head.ref);
  validBranch(pr.base.ref);
  return pr;
}
async function verifyPrIssueAssociation(
  context: DeliveryContext,
  prNumber: number,
  issueNumber: number,
  nonClosing = false,
  expectedPrId?: string,
  onlyIntended = false,
  expectedIssueId?: string,
  expectedRepositoryId?: string,
): Promise<void> {
  let cursor: string | null = null;
  const cursors = new Set<string>();
  let matches = 0;
  for (let page = 0; page < 20; page++) {
    const result: ClosingIssuesQuery = await context.clients.graphql<ClosingIssuesQuery>(
      'query DeliveryClosingIssues($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){nameWithOwner pullRequest(number:$number){id number closingIssuesReferences(first:100,after:$cursor){nodes{__typename id number repository{id nameWithOwner}} pageInfo{hasNextPage endCursor}}}}}',
      { ...context.repo, number: prNumber, cursor },
    );
    const connection = result.repository?.pullRequest?.closingIssuesReferences;
    if (
      typeof result.repository?.nameWithOwner !== 'string' ||
      result.repository.nameWithOwner.toLowerCase() !== context.config.repository.toLowerCase() ||
      result.repository?.pullRequest?.number !== prNumber ||
      (expectedPrId !== undefined && result.repository?.pullRequest?.id !== expectedPrId) ||
      !connection ||
      !Array.isArray(connection.nodes) ||
      connection.nodes.length > 100 ||
      typeof connection.pageInfo?.hasNextPage !== 'boolean' ||
      !(connection.pageInfo.endCursor === null || typeof connection.pageInfo.endCursor === 'string')
    )
      throw new DeliveryError('Incomplete or conflicting native GitHub PR issue association readback.');
    for (const issue of connection.nodes) {
      if (
        onlyIntended &&
        (!issue ||
          issue.__typename !== 'Issue' ||
          !nativeId(expectedIssueId) ||
          issue.id !== expectedIssueId ||
          !nativeId(expectedRepositoryId) ||
          issue.repository?.id !== expectedRepositoryId)
      )
        throw new DeliveryError(
          'Incomplete or conflicting typed closing issue/repository identity before body transition.',
        );
      if (nonClosing) throw new DeliveryError('Non-closing PR has an unintended native closing association.');
      if (
        !issue ||
        !Number.isSafeInteger(issue.number) ||
        issue.number <= 0 ||
        typeof issue.repository?.nameWithOwner !== 'string' ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(issue.repository.nameWithOwner)
      )
        throw new DeliveryError('Incomplete native PR closing-issue identity.');
      if (
        issue.number === issueNumber &&
        issue.repository.nameWithOwner.toLowerCase() === context.config.repository.toLowerCase()
      )
        matches++;
      else if (onlyIntended)
        throw new DeliveryError('Existing PR has conflicting closing associations; body transition refused.');
    }
    if (!connection.pageInfo.hasNextPage) {
      if (!nonClosing && matches !== 1)
        throw new DeliveryError('Native GitHub PR closing-issue association does not identify the intended issue.');
      return;
    }
    const next = connection.pageInfo.endCursor;
    if (!next || cursors.has(next)) throw new DeliveryError('Native PR issue pagination did not advance.');
    cursors.add(next);
    cursor = next;
  }
  throw new DeliveryError('Native PR issue association exceeds the bounded readback window.');
}
interface ClosingIssuesQuery {
  repository: {
    nameWithOwner: string;
    pullRequest: {
      id?: string;
      number: number;
      closingIssuesReferences: {
        nodes: Array<{
          __typename?: string;
          id?: string;
          number: number;
          repository: { id?: string; nameWithOwner: string };
        } | null>;
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
    if (!Array.isArray(batch) || batch.some((pr) => !pr || !Number.isSafeInteger(pr.number) || pr.number <= 0))
      throw new DeliveryError('Incomplete GitHub PR match readback.');
    matches.push(...batch);
    if (batch.length < 100) return matches;
  }
  throw new DeliveryError('GitHub PR match history exceeds the bounded readback window.');
}
async function verifyIssuePr(context: DeliveryContext, issueNumber: number, prNumber: number, nonClosing = false) {
  const pr = await getPr(context, prNumber);
  if (nonClosing) await verifyNonClosingReference(context, issueNumber, pr);
  else await verifyPrIssueAssociation(context, prNumber, issueNumber);
  if (!pr.merged) {
    // GitHub replaces the issue's branch connection with its PR on publication.
    // Existing connections remain consistency evidence, never a fallback authority.
    const branches = await linkedIssueBranches(context, issueNumber);
    if (branches.length > 0) {
      const matches = branches.filter((branch) => branch.name === pr.head.ref);
      if (matches.length !== 1 || matches[0]!.sha !== pr.head.sha)
        throw new DeliveryError('Native linked issue branches conflict with the exact PR head/ref.');
    }
    const ref = (await context.clients.rest.git.getRef({ ...context.repo, ref: `heads/${pr.head.ref}` })).data;
    if (ref.ref !== `refs/heads/${pr.head.ref}` || ref.object.type !== 'commit' || ref.object.sha !== pr.head.sha)
      throw new DeliveryError('Current remote PR head/ref readback is incomplete or has moved.');
  }
  return pr;
}
export async function prInfo(
  context: DeliveryContext,
  input: { issueNumber?: number; prNumber?: number; nonClosing?: boolean },
) {
  const nonClosing = nonClosingMode(input.nonClosing);
  if (nonClosing && (input.issueNumber === undefined || input.prNumber === undefined))
    throw new DeliveryError('Non-closing inspection requires explicit canonical issue and PR numbers.');
  let number = input.prNumber;
  if (number === undefined) {
    if (input.issueNumber === undefined) throw new DeliveryError('prNumber or issueNumber is required.');
    const branches = await linkedIssueBranches(context, input.issueNumber);
    if (branches.length !== 1)
      throw new DeliveryError(
        'Issue-only PR inspection requires one GitHub-linked issue branch. After publication, supply the exact issue and PR numbers (CLI --issue and --pr) to verify the native PR closing-issue association.',
      );
    const branch = branches[0]!.name;
    const matches = await matchingPrs(context, branch);
    if (matches.length !== 1)
      throw new DeliveryError('Select an explicit PR number when the remote issue branch has zero or multiple PRs.');
    number = matches[0]!.number;
  }
  const pr =
    input.issueNumber === undefined
      ? await getPr(context, number)
      : await verifyIssuePr(context, input.issueNumber, number, nonClosing);
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

function completeRulePage(response: { status: number; data: unknown; headers: { link?: unknown } }): boolean {
  return (
    response.status === 200 &&
    Array.isArray(response.data) &&
    response.headers !== undefined &&
    response.headers !== null &&
    (response.headers.link === undefined || response.headers.link === '')
  );
}

/** Absence is proved only by an empty successful first page with no continuation evidence. */
function emptyRulePage(response: { status: number; data: unknown; headers: { link?: unknown } }): boolean {
  return completeRulePage(response) && Array.isArray(response.data) && response.data.length === 0;
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
    (await githubClients.createDeliveryGitHubClients({
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
  let confirmedUnprotected = false;
  let confirmedRulesetOnly = false;
  if (
    rulesetResult.status === 'fulfilled' &&
    completeRulePage(rulesetResult.value) &&
    protectionResult.status === 'rejected' &&
    githubClients.hasBranchProtectionAbsence(protectionResult.reason, context.clients, context.repo, base)
  ) {
    // A generic/permission 404 is never absence. Corroborate the named branch,
    // selected author's write access, and all repository/parent rulesets.
    const parameters = { ...context.repo, ...(control === undefined ? {} : { request: { signal: control.signal } }) };
    const [repository, branch, rulesets] = await Promise.allSettled([
      context.clients.rest.request('GET /repos/{owner}/{repo}', parameters),
      context.clients.rest.request('GET /repos/{owner}/{repo}/branches/{branch}', { ...parameters, branch: base }),
      context.clients.rest.request('GET /repos/{owner}/{repo}/rulesets', {
        ...parameters,
        includes_parents: true,
        per_page: 100,
        page: 1,
      }),
    ]);
    await check();
    if (repository.status === 'fulfilled' && branch.status === 'fulfilled' && rulesets.status === 'fulfilled') {
      const repoData = repository.value.data as {
        full_name?: string;
        permissions?: { push?: boolean; admin?: boolean };
      } | null;
      const branchData = branch.value.data as {
        name?: string;
        protected?: boolean;
        protection?: { enabled?: boolean };
      } | null;
      const corroborated =
        repository.value.status === 200 &&
        branch.value.status === 200 &&
        typeof repoData?.full_name === 'string' &&
        repoData.full_name.toLowerCase() === `${context.repo.owner}/${context.repo.repo}`.toLowerCase() &&
        (repoData.permissions?.push === true || repoData.permissions?.admin === true) &&
        branchData?.name === base;
      confirmedUnprotected =
        corroborated &&
        emptyRulePage(rulesetResult.value) &&
        branchData?.protected === false &&
        branchData.protection?.enabled === false &&
        emptyRulePage(rulesets.value);
      // The applicable-rules endpoint includes all active repository/parent
      // rules. A classic-protection 404 needs independent identity and active
      // ruleset readbacks, not just an observed approval count. The aggregate
      // protected flag and nested enabled summary need not be equal.
      confirmedRulesetOnly =
        corroborated &&
        branchData?.protected === true &&
        typeof branchData.protection?.enabled === 'boolean' &&
        completeRulePage(rulesets.value) &&
        rulesetResult.value.data.length > 0 &&
        rulesetResult.value.data.every((rule) => {
          if (
            typeof rule !== 'object' ||
            rule === null ||
            typeof rule.type !== 'string' ||
            !rule.type ||
            typeof rule.ruleset_id !== 'number' ||
            !Number.isSafeInteger(rule.ruleset_id) ||
            rule.ruleset_id <= 0 ||
            typeof rule.ruleset_source !== 'string' ||
            (rule.ruleset_source_type === 'Repository'
              ? rule.ruleset_source.toLowerCase() !== `${context.repo.owner}/${context.repo.repo}`.toLowerCase()
              : rule.ruleset_source_type !== 'Organization' ||
                rule.ruleset_source.toLowerCase() !== context.repo.owner.toLowerCase()) ||
            (rule.type === 'pull_request' && requiredApprovalCount(rule.parameters) === null)
          )
            return false;
          const matches = rulesets.value.data.filter((ruleset) => ruleset?.id === rule.ruleset_id);
          return (
            matches.length === 1 &&
            matches[0]?.source_type === rule.ruleset_source_type &&
            matches[0]?.source === rule.ruleset_source &&
            matches[0]?.enforcement === 'active'
          );
        });
    }
  }
  const counts: number[] = [];
  if (rulesetResult.status === 'fulfilled' && Array.isArray(rulesetResult.value.data)) {
    for (const rule of rulesetResult.value.data) {
      if (rule?.type === 'pull_request') {
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
  const rulesVisible =
    rulesetResult.status === 'fulfilled' &&
    Array.isArray(rulesetResult.value.data) &&
    (rulesetResult.value.headers?.link === undefined || rulesetResult.value.headers.link === '');
  const visible =
    Number(rulesVisible) +
    Number(protectionResult.status === 'fulfilled' || confirmedUnprotected || confirmedRulesetOnly);
  const visibility = visible === 2 ? 'complete' : visible === 1 ? 'partial' : 'unknown';
  const observedRequiredApprovals = counts.length > 0 ? Math.max(...counts) : confirmedUnprotected ? 0 : null;
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
    prNumber?: number;
    nonClosing?: boolean;
    body?: string;
    title?: string;
    draft?: boolean;
    headBranch?: string;
    baseBranch?: string;
    dryRun?: boolean;
  },
) {
  const nonClosing = nonClosingMode(input.nonClosing);
  if (input.prNumber !== undefined && (!Number.isSafeInteger(input.prNumber) || input.prNumber <= 0))
    throw new DeliveryError('Existing PR selector must be a positive safe integer.');
  const issue = nonClosing
    ? await openReferenceIssue(context, input.issueNumber)
    : (await context.clients.rest.issues.get({ ...context.repo, issue_number: input.issueNumber })).data;
  if ('pull_request' in issue || issue.number !== input.issueNumber || issue.state !== 'open')
    throw new DeliveryError('PR creation requires the requested open GitHub issue.');
  const repository = (await context.clients.rest.repos.get({ ...context.repo })).data;
  if (
    repository.full_name?.toLowerCase() !== context.config.repository.toLowerCase() ||
    context.config.repository.toLowerCase() !== `${context.repo.owner}/${context.repo.repo}`.toLowerCase()
  )
    throw new DeliveryError('Configured and selected GitHub repository identities disagree.');
  if (nonClosing && !nativeId(repository.node_id))
    throw new DeliveryError('Incomplete canonical non-closing repository node identity.');
  const base = input.baseBranch ?? repository.default_branch;
  if (base !== repository.default_branch)
    throw new DeliveryError('PR delivery requires the repository default branch for durable issue association.');
  validBranch(base);
  if (input.headBranch !== undefined) validBranch(input.headBranch);
  const explicit = input.prNumber === undefined ? undefined : await getPr(context, input.prNumber);
  const explicitPromotion = input.draft === false && input.headBranch !== undefined;
  const selectedMatches = explicit
    ? await matchingPrs(context, explicit.head.ref, base)
    : explicitPromotion
      ? await matchingPrs(context, input.headBranch!, base)
      : undefined;
  const branch = explicit
    ? explicit.head.ref
    : explicitPromotion && selectedMatches!.length > 0
      ? input.headBranch!
      : await issueBranch(context, input.issueNumber, input.headBranch);
  if (input.headBranch !== undefined && branch !== input.headBranch)
    throw new DeliveryError('Explicit PR and head selectors disagree.');
  validBranch(branch);
  const ref = (await context.clients.rest.git.getRef({ ...context.repo, ref: `heads/${branch}` })).data;
  if (ref.ref !== `refs/heads/${branch}` || ref.object.type !== 'commit' || !validSha(ref.object.sha))
    throw new DeliveryError('Remote issue branch head/ref readback is invalid.');
  const matches = selectedMatches ?? (await matchingPrs(context, branch, base));
  if (matches.length > 1 || (explicit && (matches.length !== 1 || matches[0]!.number !== explicit.number)))
    throw new DeliveryError('Remote issue branch has conflicting PR matches.');
  let pr = explicit ?? (matches[0] === undefined ? undefined : await getPr(context, matches[0].number));
  const requestedBody =
    input.body ??
    (nonClosing ? (pr?.body ?? referenceLine(context, input.issueNumber)) : `Closes #${input.issueNumber}`);
  if (!requestedBody.trim()) throw new DeliveryError('PR body must contain text.');
  const body = nonClosing
    ? nonClosingBody(context, input.issueNumber, requestedBody)
    : new RegExp(`(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\\s+#${input.issueNumber}(?![0-9])`, 'iu').test(
          requestedBody,
        )
      ? requestedBody
      : `${requestedBody}\n\nCloses #${input.issueNumber}`;
  const transition = nonClosing && pr !== undefined && pr.body !== body;
  if (transition && (input.prNumber === undefined || input.body === undefined))
    throw new DeliveryError('Non-closing body transition requires an explicit existing PR number and body.');
  if (
    pr &&
    (pr.head.sha !== ref.object.sha ||
      pr.head.ref !== branch ||
      pr.base.ref !== base ||
      pr.state !== 'open' ||
      pr.merged ||
      (!transition && input.body !== undefined && pr.body !== body) ||
      (input.title !== undefined && pr.title !== input.title))
  )
    throw new DeliveryError('Existing remote PR conflicts with the requested branch, intent or state.');
  const reviewRoute = nonClosing ? await nonClosingRoute(context, base) : await preflightReviewRoute(context, base);
  if (pr && pr.user.login.toLowerCase() !== reviewRoute.author.actorLogin.toLowerCase())
    throw new DeliveryError('Existing PR author differs from the configured authenticated author.');
  if (pr && (typeof pr.node_id !== 'string' || !pr.node_id))
    throw new DeliveryError('Existing PR publication identity is incomplete.');
  if (nonClosing) refuseClosingDirective(input.title ?? pr?.title ?? issue.title);
  const creationTitle = input.title ?? issue.title;
  let publicationBaseSha: string | undefined;
  const existing = pr;
  let pendingTransition = transition;
  let expectedBody = pr?.body;
  const transitionDraft = pr?.draft;
  let promotionApplied = false;
  const preserveIssue = async () => {
    if (nonClosing) sameReferenceIssue(issue, await openReferenceIssue(context, input.issueNumber));
  };
  const readExisting = async () => {
    const current = await verifyIssuePr(context, input.issueNumber, existing!.number, nonClosing && !pendingTransition);
    if (
      current.state !== 'open' ||
      current.merged ||
      current.node_id !== existing!.node_id ||
      current.head.sha !== ref.object.sha ||
      current.head.ref !== branch ||
      current.base.ref !== base ||
      current.base.sha !== existing!.base.sha ||
      current.user.login.toLowerCase() !== reviewRoute.author.actorLogin.toLowerCase() ||
      (transition && !promotionApplied && current.draft !== transitionDraft) ||
      current.body !== expectedBody ||
      current.title !== existing!.title
    )
      throw new DeliveryError('Existing PR publication head, identity, intent or author readback drifted.');
    if (pendingTransition) {
      await verifyPrIssueAssociation(
        context,
        current.number,
        input.issueNumber,
        false,
        current.node_id,
        true,
        issue.node_id,
        repository.node_id,
      );
      refuseClosingDirective(current.title);
      await verifyNonClosingCommits(context, current);
      const baseRef = (await context.clients.rest.git.getRef({ ...context.repo, ref: `heads/${base}` })).data;
      if (
        baseRef.ref !== `refs/heads/${base}` ||
        baseRef.object.type !== 'commit' ||
        baseRef.object.sha !== current.base.sha
      )
        throw new DeliveryError('Non-closing transition default base drifted.');
      sameReferencePr(current, await getPr(context, current.number));
    }
    await preserveIssue();
    return current;
  };
  const readNew = async () => {
    const baseRef = (await context.clients.rest.git.getRef({ ...context.repo, ref: `heads/${base}` })).data;
    if (baseRef.ref !== `refs/heads/${base}` || baseRef.object.type !== 'commit' || !validSha(baseRef.object.sha))
      throw new DeliveryError('Incomplete publication default base.');
    if (publicationBaseSha !== undefined && publicationBaseSha !== baseRef.object.sha)
      throw new DeliveryError('Publication default base drifted before creation.');
    publicationBaseSha = baseRef.object.sha;
    if (nonClosing) await verifyUnpublishedCommits(context, baseRef.object.sha, ref.object.sha);
    const afterHead = (await context.clients.rest.git.getRef({ ...context.repo, ref: `heads/${branch}` })).data;
    const afterBase = (await context.clients.rest.git.getRef({ ...context.repo, ref: `heads/${base}` })).data;
    if (
      afterHead.ref !== ref.ref ||
      afterHead.object.type !== 'commit' ||
      afterHead.object.sha !== ref.object.sha ||
      afterBase.ref !== baseRef.ref ||
      afterBase.object.type !== 'commit' ||
      afterBase.object.sha !== baseRef.object.sha
    )
      throw new DeliveryError('Non-closing publication head/base drifted.');
    await preserveIssue();
  };
  if (pr) pr = await readExisting();
  else await readNew();
  if (input.dryRun)
    return {
      dryRun: true,
      ...(pr === undefined ? {} : { prNumber: pr.number, draft: pr.draft }),
      ...(nonClosing
        ? {
            nonClosing: true,
            nonClosingVerified: pr !== undefined && !pendingTransition,
            body,
            bodyTransition: pendingTransition,
          }
        : {}),
      headSha: ref.object.sha,
      headBranch: branch,
      baseBranch: base,
      reviewRoute,
    };
  let created = false;
  if (pr) {
    if (pendingTransition) {
      pr = await readExisting();
      await context.clients.rest.pulls.update({ ...context.repo, pull_number: pr.number, body });
      pendingTransition = false;
      expectedBody = body;
      pr = await readExisting();
    }
    if (input.draft === false && pr.draft) {
      pr = await readExisting();
      if (pr.draft) {
        const promoted = await context.clients.graphql<{
          markPullRequestReadyForReview: { pullRequest: { id: string; isDraft: boolean } | null } | null;
        }>(
          'mutation DeliveryReadyPr($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id isDraft}}}',
          { id: pr.node_id },
        );
        if (
          promoted?.markPullRequestReadyForReview?.pullRequest?.id !== pr.node_id ||
          promoted.markPullRequestReadyForReview.pullRequest.isDraft !== false
        )
          throw new DeliveryError('PR promotion mutation readback is incomplete or conflicting; reconcile this PR.');
        promotionApplied = true;
      }
      pr = await readExisting();
      if (pr.draft) throw new DeliveryError('PR promotion readback is still draft.');
    }
  } else {
    await readNew();
    let response;
    try {
      response = await context.clients.rest.pulls.create({
        ...context.repo,
        head: branch,
        base,
        title: creationTitle,
        body,
        draft: input.draft !== false,
      });
    } catch (error) {
      throw new DeliveryError(
        `PR creation acknowledgement is uncertain; reconcile the remote head read-only before any new mutation. ${error instanceof Error ? error.message : 'Unknown failure'}`,
      );
    }
    if (!Number.isSafeInteger(response.data.number) || response.data.number <= 0)
      throw new DeliveryError(
        'PR creation acknowledgement lacks a valid PR identity; reconcile the remote head read-only, do not create again.',
      );
    created = true;
    try {
      pr = await getPr(context, response.data.number);
    } catch (error) {
      throw new DeliveryError(
        `GitHub returned created PR #${response.data.number}; identity readback is unresolved. Reconcile read-only; do not create again. ${error instanceof Error ? error.message : 'Unknown failure'}`,
      );
    }
  }
  try {
    if (
      created &&
      (pr.body !== body ||
        pr.title !== creationTitle ||
        pr.draft !== (input.draft !== false) ||
        pr.state !== 'open' ||
        pr.merged ||
        pr.base.sha !== publicationBaseSha)
    )
      throw new DeliveryError(
        'Created PR body, title, draft/open state or default base differs from publication intent.',
      );
    if (pr.head.sha !== ref.object.sha || pr.head.ref !== branch || pr.base.ref !== base)
      throw new DeliveryError('GitHub PR creation readback drifted.');
    if (pr.user.login.toLowerCase() !== reviewRoute.author.actorLogin.toLowerCase())
      throw new DeliveryError('Published PR author differs from the configured authenticated author.');
    if (nonClosing) {
      const verified = await verifyIssuePr(context, input.issueNumber, pr.number, true);
      sameReferencePr(pr, verified);
      pr = verified;
      await preserveIssue();
    } else await verifyPrIssueAssociation(context, pr.number, input.issueNumber);
    if (created) {
      const final = await getPr(context, pr.number);
      sameReferencePr(pr, final);
      pr = final;
    }
  } catch (error) {
    if (!created) throw error;
    throw new DeliveryError(
      `GitHub created PR #${pr.number} (${pr.html_url}) at ${pr.head.sha}; post-publication association/identity verification is unresolved. Reconcile this PR read-only; do not create again. ${error instanceof Error ? error.message : 'Unknown failure'}`,
    );
  }
  return {
    prNumber: pr.number,
    url: pr.html_url,
    headSha: pr.head.sha,
    draft: pr.draft,
    reviewRoute,
    ...(nonClosing ? { nonClosing: true } : {}),
  };
}

export async function submitFormalReview(
  context: DeliveryContext,
  input: { artifact: string; issueNumber: number; prNumber: number; dryRun?: boolean; nonClosing?: boolean },
) {
  const nonClosing = nonClosingMode(input.nonClosing);
  const pr = await verifyIssuePr(context, input.issueNumber, input.prNumber, nonClosing);
  const issue = nonClosing ? await openReferenceIssue(context, input.issueNumber) : undefined;
  const result = await submitReview({
    context,
    artifact: parseReviewArtifact(input.artifact),
    issueNumber: input.issueNumber,
    prNumber: input.prNumber,
    ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
  });
  if (nonClosing) {
    sameReferencePr(pr, await verifyIssuePr(context, input.issueNumber, input.prNumber, true));
    sameReferenceIssue(issue!, await openReferenceIssue(context, input.issueNumber));
  }
  return result;
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
    nonClosing?: boolean;
  },
) {
  const nonClosing = nonClosingMode(input.nonClosing);
  if (nonClosing && input.strategy !== undefined && input.strategy !== 'squash')
    throw new DeliveryError('Non-closing merge requires squash with explicit safe messages.');
  if (
    context.clients.role !== 'author' ||
    context.clients.authSource !== (context.config.roles.author.authSource ?? 'app') ||
    !context.clients.authenticatedAuthor
  )
    throw new DeliveryError('Merge and finish require the configured authenticated author role.');
  const author = await context.clients.authenticatedAuthor();
  if (!author.actorLogin || !author.credentialIdentity)
    throw new DeliveryError('Author identity readback is incomplete.');
  let pr = await verifyIssuePr(context, input.issueNumber, input.prNumber, nonClosing);
  const initialPr = pr;
  const issue = nonClosing ? await openReferenceIssue(context, input.issueNumber) : undefined;
  const squash = nonClosing
    ? {
        commit_title: pr.title,
        commit_message: `${referenceLine(context, input.issueNumber)}\n\nDelivered by PR #${pr.number}.`,
      }
    : undefined;
  if (squash) {
    refuseClosingDirective(squash.commit_title);
    refuseClosingDirective(squash.commit_message);
  }
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
    (await githubClients.createDeliveryGitHubClients({
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
  // Unavailable or malformed decisions carry no qualifying review-access
  // evidence. An observed null may accompany an independently confirmed zero.
  const noReviewsRequired =
    decision.status === 'unknown' &&
    decision.reviewDecision === null &&
    route.rules.visibility === 'complete' &&
    route.rules.observedRequiredApprovals === 0;
  if (decision.status !== 'satisfied' && !noReviewsRequired)
    throw new DeliveryError(`GitHub review eligibility is ${decision.status}: ${decision.nextAction}`);
  const blockers = await getNativeBlockerRelationships({
    graphql: context.clients.graphql,
    issueNumber: input.issueNumber,
    repo: context.repo,
  });
  if (blockers.blockers.some((value) => value.state === 'OPEN'))
    throw new DeliveryError('GitHub issue has unresolved native blockers.');
  pr = await verifyIssuePr(context, input.issueNumber, input.prNumber, nonClosing);
  if (nonClosing) {
    sameReferencePr(initialPr, pr);
    sameReferenceIssue(issue!, await openReferenceIssue(context, input.issueNumber));
    refuseClosingDirective(squash!.commit_title);
    refuseClosingDirective(squash!.commit_message);
  }
  if (noReviewsRequired && (pr.base.ref !== initialPr.base.ref || pr.base.sha !== initialPr.base.sha))
    throw new DeliveryError('GitHub base changed; refresh the zero-review requirement observation before merge.');
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
  if (input.dryRun)
    return {
      dryRun: true,
      headSha: reviewedHead,
      prNumber: pr.number,
      ...(squash === undefined ? {} : { nonClosing: true, ...squash }),
    };
  const result = (
    await context.clients.rest.pulls.merge({
      ...context.repo,
      pull_number: input.prNumber,
      sha: reviewedHead,
      merge_method: input.strategy ?? 'squash',
      ...squash,
    })
  ).data;
  if (!result.merged || !validSha(result.sha)) throw new DeliveryError('GitHub refused the reviewed-head merge.');
  const readback = await verifyIssuePr(context, input.issueNumber, input.prNumber, nonClosing);
  if (nonClosing) {
    sameReferencePr(initialPr, readback, true);
    sameReferenceIssue(issue!, await openReferenceIssue(context, input.issueNumber));
  }
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
    nonClosing?: boolean;
  },
) {
  if (nonClosingMode(input.nonClosing))
    throw new DeliveryError('Non-closing delivery cannot finish or close its retained issue.');
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

function investigationRoot(context: DeliveryContext): string {
  const root = primaryGitRoot(context.root);
  const repo = resolveRepoFromRemote(root, 'origin');
  if (
    `${repo.owner}/${repo.repo}`.toLowerCase() !== context.config.repository.toLowerCase() ||
    `${context.repo.owner}/${context.repo.repo}`.toLowerCase() !== context.config.repository.toLowerCase()
  )
    throw new DeliveryError('Investigation repository identity disagrees.');
  return root;
}
async function withInvestigationExclusion<T>(root: string, target: string, operation: () => Promise<T>): Promise<T> {
  const common = gitCommonDir(root);
  for (const directory of [join(common, 'ai-delivery'), join(common, 'ai-delivery', 'writers@1')]) {
    try {
      const metadata = lstatSync(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new DeliveryError('Investigation writer namespace is unsafe.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    ensurePrivateDirectoryDurably(directory);
  }
  return withWorktreeTransitionWriterAbsent(root, target, operation);
}
async function investigationNativeSource(
  context: DeliveryContext,
  issueNumber: number,
  headSha: string,
  state: 'open' | 'closed',
) {
  const issue = (await context.clients.rest.issues.get({ ...context.repo, issue_number: issueNumber })).data;
  if (
    issue.number !== issueNumber ||
    'pull_request' in issue ||
    issue.state !== state ||
    new URL(issue.html_url).pathname.toLowerCase() !==
      `/${context.config.repository}/issues/${String(issueNumber)}`.toLowerCase()
  )
    throw new DeliveryError('Investigation requires the exact native issue and expected state.');
  const branches = await linkedIssueBranches(context, issueNumber);
  if (branches.length !== 1 || branches[0]!.name !== `issue/${String(issueNumber)}` || branches[0]!.sha !== headSha)
    throw new DeliveryError('Investigation requires one exact unchanged native linked branch.');
  const prs = (
    await context.clients.rest.pulls.list({
      ...context.repo,
      state: 'all',
      head: `${context.repo.owner}:${branches[0]!.name}`,
      per_page: 100,
    })
  ).data;
  if (prs.length !== 0) throw new DeliveryError('Investigation completion cannot substitute for PR delivery.');
}
export function investigationPreparationBody(preparation: InvestigationPreparation): string {
  return stableJson({
    schemaVersion: 'ai-delivery.investigation-preparation-acknowledgement@1',
    preparation,
    authority: 'prospective-registration-before-investigation-no-legacy-adoption',
  });
}
export function investigationAuthorityBody(preparation: InvestigationPreparation, resultDigest: string): string {
  return stableJson({
    schemaVersion: 'ai-delivery.investigation-removal-authority@1',
    preparationId: preparation.preparationId,
    repository: preparation.repository,
    issueNumber: preparation.row.issueNumber,
    head: preparation.head,
    worktree: preparation.row.path,
    branch: preparation.row.branch,
    resultDigest,
    disposition: 'remove-only-this-unchanged-investigation-worktree-retain-branch-and-evidence',
    operationalClosure:
      'all-investigation-producers-quiescent-and-excluded-through-completion-and-resume-no-outstanding-holds',
  });
}
export function investigationAcceptanceBody(
  preparation: InvestigationPreparation,
  resultDigest: string,
  authorityCommentId: number,
): string {
  return stableJson({
    schemaVersion: 'ai-delivery.investigation-result-acceptance@1',
    authority: JSON.parse(investigationAuthorityBody(preparation, resultDigest)) as unknown,
    authorityCommentId,
    verdict: 'approved',
    independentlyReviewed: 'complete-durable-result-exact-source-and-removal-scope',
  });
}

/** Explicit author mode for a host-created worktree; ordinary start remains remote-only. */
export async function registerInvestigation(
  context: DeliveryContext,
  input: {
    issueNumber: number;
    investigationWorktree: string;
    expectedHeadSha: string;
  },
) {
  if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0 || !Sha.test(input.expectedHeadSha))
    throw new DeliveryError('Investigation preparation requires a positive issue and expected commit.');
  const root = investigationRoot(context);
  const target = join(root, '.worktrees', `issue-${String(input.issueNumber)}`);
  if (input.investigationWorktree !== target || realpathSync(target) !== target)
    throw new DeliveryError('Investigation worktree must be the exact canonical .worktrees/issue-N path.');
  if (existsSync(join(root, '.issue-cli', 'issues', String(input.issueNumber))))
    throw new DeliveryError('Historical issue custody remains preservation-only; investigation cannot adopt it.');
  const actors = await authenticatedWorktreeActors(context);
  const observed = investigationSourceIdentity(root, input.issueNumber);
  const prior = readInvestigationPreparation(root, input.issueNumber);
  await investigationNativeSource(context, input.issueNumber, observed.head.sha, 'open');
  if (observed.head.sha !== input.expectedHeadSha)
    throw new DeliveryError('Investigation preparation source drifted from the expected head.');
  if (prior === undefined) {
    const repository = (await context.clients.rest.repos.get({ ...context.repo })).data;
    if (repository.full_name.toLowerCase() !== context.config.repository.toLowerCase() || !repository.default_branch)
      throw new DeliveryError('Investigation native repository identity is incomplete.');
    const base = (await context.clients.rest.git.getRef({ ...context.repo, ref: `heads/${repository.default_branch}` }))
      .data;
    if (base.object.sha !== observed.head.sha)
      throw new DeliveryError('Prospective investigation must begin at the current native default commit.');
  }
  const date = new Date().toISOString();
  const content = {
    schemaVersion: 'ai-delivery.investigation-preparation@1' as const,
    repository: context.config.repository,
    repoRoot: root,
    row: prior?.row ?? {
      branch: `issue/${String(input.issueNumber)}`,
      createdAt: date,
      identity: context.config.roles.author.identity,
      issueNumber: input.issueNumber,
      path: target,
      status: 'active' as const,
      type: 'issue' as const,
      updatedAt: date,
    },
    ...observed,
    operator: { actorLogin: actors.operator.actorLogin, credentialIdentity: actors.operator.credentialIdentity },
    reviewerActor: actors.reviewerActor,
  };
  const preparation = InvestigationPreparationSchema.parse({ ...content, preparationId: digestValue(content) });
  await withInvestigationExclusion(root, target, () =>
    registerInvestigationCustody(preparation, async () => {
      if (stableJson(investigationSourceIdentity(root, input.issueNumber)) !== stableJson(observed))
        throw new DeliveryError('Investigation source changed before preparation acknowledgement.');
      await investigationNativeSource(context, input.issueNumber, observed.head.sha, 'open');
      const { commentId, url, body } = await commentIssue(context, {
        issueNumber: input.issueNumber,
        body: investigationPreparationBody(preparation),
      });
      if (stableJson(investigationSourceIdentity(root, input.issueNumber)) !== stableJson(observed))
        throw new DeliveryError('Investigation source changed during preparation acknowledgement.');
      return { commentId, url, body };
    }),
  );
  return { preparation, acknowledgement: readInvestigationAcknowledgement(root, input.issueNumber), registered: true };
}

/** One non-mergeable completion path. No PR, issue close, reviewer submission or branch deletion occurs. */
export async function finishInvestigation(
  context: DeliveryContext,
  input: {
    issueNumber: number;
    resultPath: string;
    authorityCommentId?: number;
    acceptanceCommentId?: number;
    dryRun?: boolean;
  },
) {
  if (['prNumber', 'strategy', 'reviewedHeadSha', 'nonClosing'].some((key) => key in input))
    throw new DeliveryError('Investigation completion refuses PR or merge options.');
  const root = investigationRoot(context);
  const preparation = readInvestigationPreparation(root, input.issueNumber);
  if (!preparation)
    throw new DeliveryError('No prospective investigation preparation; historical custody cannot be reconstructed.');
  const resultPath = resolve(input.resultPath);
  const resultRelative = relative(preparation.row.path, resultPath);
  const resultOutside = resultRelative === '..' || resultRelative.startsWith(`..${sep}`) || isAbsolute(resultRelative);
  if (realpathSync(resultPath) !== resultPath || !resultOutside)
    throw new DeliveryError('Durable investigation result must be canonical and outside the removable worktree.');
  const result = assertPrivateFile(resultPath, { maxBytes: 512 * 1024 });
  if (result.length === 0) throw new DeliveryError('Investigation result must contain durable evidence.');
  const resultDigest = digestBytes(result);
  const authorityBody = investigationAuthorityBody(preparation, resultDigest);
  const acceptanceBody =
    input.authorityCommentId === undefined
      ? undefined
      : investigationAcceptanceBody(preparation, resultDigest, input.authorityCommentId);
  const authorize = async () => {
    await investigationNativeSource(context, input.issueNumber, preparation.head.sha, 'closed');
    const closure = await readIssueClosure(context, input.issueNumber);
    if (closure.state !== 'closed' || closure.closeReason !== 'completed' || closure.duplicateOf !== null)
      throw new DeliveryError('Investigation requires native completed closed-issue authority.');
    const acknowledgement = readInvestigationAcknowledgement(root, input.issueNumber);
    const native = (
      await context.clients.rest.issues.getComment({ ...context.repo, comment_id: acknowledgement.commentId })
    ).data;
    if (
      native.id !== acknowledgement.commentId ||
      native.body !== investigationPreparationBody(preparation) ||
      native.body !== acknowledgement.body ||
      native.issue_url.toLowerCase() !==
        `https://api.github.com/repos/${preparation.repository}/issues/${String(input.issueNumber)}`.toLowerCase() ||
      native.user?.type !== 'User' ||
      native.user.login.toLowerCase() !== preparation.operator.actorLogin.toLowerCase() ||
      `user:${String(native.user.id)}` !== preparation.operator.credentialIdentity
    )
      throw new DeliveryError('Native prospective preparation acknowledgement changed.');
    if (
      input.authorityCommentId === undefined ||
      input.acceptanceCommentId === undefined ||
      acceptanceBody === undefined
    )
      throw new DeliveryError('Existing authentic operator and independent App acceptance comments are required.');
    const authority = await assertNativeWorktreeAcceptance(context, {
      repository: preparation.repository,
      subject: input.issueNumber,
      operator: preparation.operator,
      reviewerActor: preparation.reviewerActor,
      authorityCommentId: input.authorityCommentId,
      acceptanceCommentId: input.acceptanceCommentId,
      operatorBody: authorityBody,
      reviewerBody: acceptanceBody,
      revokedBody: stableJson({
        schemaVersion: 'ai-delivery.investigation-removal-revocation@1',
        preparationId: preparation.preparationId,
        resultDigest,
        authorityCommentId: input.authorityCommentId,
      }),
    });
    const preparedAt = Date.parse(native.created_at);
    for (const value of [authority.relinquishment, authority.acceptance]) {
      const createdAt = Date.parse((value as { created_at: string }).created_at);
      if (!Number.isFinite(preparedAt) || !Number.isFinite(createdAt) || createdAt < preparedAt)
        throw new DeliveryError('Investigation acceptance must follow its prospective preparation.');
    }
    return { acknowledgement: native, closure, ...authority };
  };
  if (input.dryRun && (input.authorityCommentId === undefined || input.acceptanceCommentId === undefined)) {
    assertInvestigationSource(preparation, context.root);
    await investigationNativeSource(context, input.issueNumber, preparation.head.sha, 'closed');
    return {
      completed: false,
      ready: false,
      preparationId: preparation.preparationId,
      resultDigest,
      authorityBody,
      ...(acceptanceBody === undefined ? {} : { acceptanceBody }),
      missingEvidence:
        'Existing authentic operator and configured-App exact-result acceptance are prerequisites; no submission route is supplied.',
    };
  }
  if (
    !Number.isSafeInteger(input.authorityCommentId) ||
    !Number.isSafeInteger(input.acceptanceCommentId) ||
    input.authorityCommentId! <= 0 ||
    input.acceptanceCommentId! <= 0
  )
    throw new DeliveryError('Investigation evidence requires positive native comment IDs.');
  return withInvestigationExclusion(root, preparation.row.path, () =>
    completeInvestigationCustody({
      preparation,
      result,
      authorityCommentId: input.authorityCommentId!,
      acceptanceCommentId: input.acceptanceCommentId!,
      dryRun: input.dryRun === true,
      authorize,
      assertSource: (allowAbsent) => assertInvestigationSource(preparation, context.root, allowAbsent),
      removeSource: () => removeInvestigationSource(preparation, context.root),
    }),
  );
}
