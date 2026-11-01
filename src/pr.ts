import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { DeliveryError } from './errors.js';
import * as githubClients from './github/client.js';
import type { GitHubClients } from './github/client.js';
import { issueBranch, linkedIssueBranches, startIssueBranch, type DeliveryContext } from './issue.js';
import { parseReviewArtifact, readRequiredReviewState, ReviewSubmissionError, submitReview } from './review.js';
import { parseIssueBody } from './issueContract.js';

const Sha = /^[a-f0-9]{40}$/u;
const Branch = /^(?!.*(?:\.\.|@\{|\/\/))[A-Za-z0-9._/-]+$/u;

export type PrReadContext = Pick<DeliveryContext, 'clients' | 'repo'>;

const DeliveryPrFooter = '\n\n<!-- ai-delivery:pr@1 -->';
function activeMarkerPositions(text: string, pattern: RegExp): number[] | null {
  // A bounded context reader, not a Markdown renderer. Resolve blocks before inline
  // quoting; unsupported container/HTML interactions cannot prove a usage marker.
  const ignored: Array<[number, number]> = [];
  const uncertain: Array<[number, number]> = [];
  const inline: Array<[number, number]> = [];
  let paragraph: number | null = null;
  let fence: string | null = null;
  let comment = false;
  let htmlEnd: 'blank' | RegExp | null = null;
  let container = false;
  let quoted = false;
  let blank = true;
  const flush = (end: number) => {
    if (paragraph !== null) inline.push([paragraph, end]);
    paragraph = null;
  };
  for (const line of text.matchAll(/[^\n]*(?:\n|$)/gu)) {
    if (!line[0]) continue;
    const start = line.index;
    const end = start + line[0].length;
    const content = line[0].replace(/\r?\n$/u, '');
    if (comment) {
      const closing = content.indexOf('-->');
      ignored.push([start, closing < 0 ? end : start + closing + 3]);
      if (closing >= 0) comment = false;
      continue;
    }
    if (htmlEnd !== null) {
      if (htmlEnd === 'blank' && !content.trim()) htmlEnd = null;
      else {
        uncertain.push([start, end]);
        if (htmlEnd !== 'blank' && htmlEnd.test(content)) htmlEnd = null;
        continue;
      }
    }
    const edge = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(content);
    if (fence !== null) {
      ignored.push([start, end]);
      if (edge && edge[1]![0] === fence[0] && edge[1]!.length >= fence.length && !edge[2]!.trim()) fence = null;
      continue;
    }
    if (!content.trim()) {
      flush(start);
      quoted = false;
      blank = true;
      continue;
    }
    if (/^ {0,3}>/u.test(content)) {
      flush(start);
      ignored.push([start, end]);
      quoted = true;
      blank = false;
      continue;
    }
    if (blank && /^\S/u.test(content) && !/^[-+*\d]/u.test(content)) container = false;
    const indented = /^(?: {4}| {0,3}\t)/u.test(content);
    if (indented && paragraph === null) {
      (container || quoted ? uncertain : ignored).push([start, end]);
      continue;
    }
    if (edge && (edge[1]![0] !== '`' || !edge[2]!.includes('`'))) {
      flush(start);
      if (container || quoted) uncertain.push([start, text.length]);
      ignored.push([start, end]);
      fence = edge[1]!;
    } else if (/^ {0,3}<!--/u.test(content)) {
      flush(start);
      const opening = content.indexOf('<!--');
      const closing = content.indexOf('-->', opening + 4);
      ignored.push([start + opening + 4, closing < 0 ? end : start + closing + 3]);
      if (closing < 0) comment = true;
    } else if (/^ {0,3}<\/?[A-Za-z!?]/u.test(content)) {
      flush(start);
      uncertain.push([start, end]);
      const closing = /^ {0,3}<\?/u.test(content)
        ? /\?>/u
        : /^ {0,3}<!\[CDATA\[/u.test(content)
          ? /\]\]>/u
          : /^ {0,3}<!/u.test(content)
            ? />/u
            : /^ {0,3}<(?:pre|script|style|textarea)(?:[ \t>]|$)/iu.test(content)
              ? /<\/(?:pre|script|style|textarea)>/iu
              : null;
      htmlEnd = closing === null ? 'blank' : closing.test(content) ? null : closing;
    } else if (
      /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:[-+*]|\d+[.)])[ \t])/u.test(content) ||
      /^ {0,3}(?:=+|-+)[ \t]*$/u.test(content) ||
      /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/u.test(content)
    ) {
      flush(start);
      inline.push([start, end]);
      container = /^ {0,3}(?:[-+*]|\d+[.)])[ \t]/u.test(content);
    } else {
      if (quoted || container) uncertain.push([start, end]);
      paragraph ??= start;
    }
    blank = false;
  }
  flush(text.length);
  for (const [start, end] of inline) {
    const unit = text.slice(start, end);
    const tokens = /\\[\\`<]|`+|<!--/gu;
    for (let token = tokens.exec(unit); token; token = tokens.exec(unit)) {
      if (token[0].startsWith('\\')) {
        ignored.push([start + token.index + 1, start + tokens.lastIndex]);
      } else if (token[0] === '<!--') {
        const closing = unit.indexOf('-->', tokens.lastIndex);
        if (closing < 0) uncertain.push([start + token.index, end]);
        else {
          ignored.push([start + tokens.lastIndex, start + closing + 3]);
          tokens.lastIndex = closing + 3;
        }
      } else {
        const ticks = /`+/gu;
        ticks.lastIndex = tokens.lastIndex;
        for (let closing = ticks.exec(unit); closing; closing = ticks.exec(unit)) {
          if (closing[0].length !== token[0].length) continue;
          ignored.push([start + token.index, start + ticks.lastIndex]);
          tokens.lastIndex = ticks.lastIndex;
          break;
        }
      }
    }
  }
  const candidates = [...text.matchAll(pattern)].map((match) => match.index);
  if (candidates.some((position) => uncertain.some(([start, end]) => position >= start && position < end))) return null;
  return candidates.filter((position) => !ignored.some(([start, end]) => position >= start && position < end));
}
/** A forgeable usage indicator, not publication or merge authority. */
export function hasDeliveryPrMarker(body: string): boolean {
  if (!body.endsWith(DeliveryPrFooter)) return false;
  const prefix = body.slice(0, -DeliveryPrFooter.length);
  const active = activeMarkerPositions(body, /<!--\s*ai-delivery:pr@[^\n]*?(?:-->|$)/gmu);
  return Boolean(prefix.trim()) && active?.length === 1 && active[0] === prefix.length + 2;
}
function publicationBody(body: string, previous: string | null | undefined): string {
  function marked(value: string): boolean {
    const active = activeMarkerPositions(value, /<!--\s*ai-delivery:pr@[^\n]*?(?:-->|$)/gmu);
    if (active === null || (active.length > 0 && !hasDeliveryPrMarker(value)))
      throw new DeliveryError('PR marker footer is malformed, misplaced or ambiguous; reconcile without repair.');
    return active.length === 1;
  }
  const previousMarked = typeof previous === 'string' && marked(previous);
  const requestedMarked = marked(body);
  if (previous !== undefined && !previousMarked) {
    if (requestedMarked) throw new DeliveryError('Historical unmarked PRs cannot receive a marker footer backfill.');
    return body;
  }
  if (requestedMarked) return body;
  const decorated = body + DeliveryPrFooter;
  if (!hasDeliveryPrMarker(decorated))
    throw new DeliveryError('PR marker footer would be ambiguous; retain the original body without repair.');
  return decorated;
}

function hasClosingLink(body: string | null, issueNumber: number) {
  const line = `Closes #${issueNumber}`;
  return body === line || body?.startsWith(`${line}\n`) === true || body?.startsWith(`${line}\r\n`) === true;
}
function closingBody(issue: { number: number; title: string; body?: string | null }, requested?: string) {
  const line = `Closes #${issue.number}`;
  if (requested !== undefined)
    return requested.startsWith(`${line}\n`) || requested === line ? requested : `${line}\n\n${requested}`;
  const { outcome, acceptanceCriteria } = parseIssueBody(issue.body ?? '', { title: issue.title }).issue;
  return [
    line,
    ...(outcome ? [`## Outcome\n\n${outcome}`] : []),
    ...(acceptanceCriteria.length
      ? [
          `## Acceptance criteria\n\n${acceptanceCriteria.map((ac) => `- [ ] ${ac.behavior}\n  Verified by: ${ac.verifiedBy}`).join('\n')}`,
        ]
      : []),
  ].join('\n\n');
}

// Conservative refusals also cover Markdown decoration/escaped references.
// This is a closure safety check, never authority for an issue association.
function refuseClosingDirective(text: unknown): asserts text is string {
  if (typeof text !== 'string') throw new DeliveryError('Incomplete non-closing message readback.');
  const normalized = text.replace(/\[[^\]\r\n]*\]\(([^()\s]+)\)/gu, '$1').replace(/[*_~`\\<>[\]]/gu, '');
  if (
    /(?<![\p{L}\p{N}_-])(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)(?:\s*:\s*|\s+)(?:#[0-9]+|[A-Za-z0-9.-]+\/[A-Za-z0-9.-]+#[0-9]+|https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9.-]+\/[A-Za-z0-9.-]+\/(?:issues|pull)\/[0-9]+)/iu.test(
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
function hasReferenceBody(context: DeliveryContext, issueNumber: number, body: unknown): boolean {
  try {
    verifyReferenceBody(context, issueNumber, body);
    return true;
  } catch {
    return false;
  }
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
            ...(context.credentialEnvironment === undefined ? {} : { env: context.credentialEnvironment }),
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
async function readNonClosingReference(context: DeliveryContext, issueNumber: number, pr: RemotePr, forReview = false) {
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
  let closesTarget: boolean | undefined;
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
          event.actor.login.toLowerCase() !== route.author.actorLogin.toLowerCase()
        )
          throw new DeliveryError('Conflicting, closing or unauthorized native PR reference.');
        if (closesTarget !== undefined && closesTarget !== event.willCloseTarget)
          throw new DeliveryError('Conflicting native PR closing-reference semantics.');
        closesTarget = event.willCloseTarget;
        matched = true;
      }
    }
    cursor = pageCursor(connection, cursors);
    if (cursor === null) break;
    if (page === 19) throw new DeliveryError('Native non-closing references exceed the bounded readback window.');
  }
  if (!matched) throw new DeliveryError('Missing authorized native non-closing PR-to-issue reference.');
  const allClosing = await readClosingReferenceIds(context, issueNumber, issue.node_id, repository.node_id, pr);
  const manualClosing = await readClosingReferenceIds(
    context,
    issueNumber,
    issue.node_id,
    repository.node_id,
    pr,
    true,
  );
  await verifyNonClosingCommits(context, pr);
  if (!pr.merged) {
    const ref = (await context.clients.rest.git.getRef({ ...context.repo, ref: `heads/${pr.base.ref}` })).data;
    if (
      ref.ref !== `refs/heads/${pr.base.ref}` ||
      ref.object.type !== 'commit' ||
      !validSha(ref.object.sha) ||
      (!forReview && ref.object.sha !== pr.base.sha)
    )
      throw new DeliveryError('Non-closing default base has moved or is incomplete.');
  }
  const after = await openReferenceIssue(context, issueNumber);
  sameReferenceIssue(issue, after);
  sameReferencePr(pr, await getPr(context, pr.number));
  return { issue, closesTarget: closesTarget!, allClosing, manualClosing };
}

// Both strict verification and the explicit action consume the same complete graph.
// Reading a closing edge here never supplies authority to remove it.
async function readClosingReferenceIds(
  context: DeliveryContext,
  issueNumber: number,
  issueId: string,
  repositoryId: string,
  pr: RemotePr,
  manual = false,
) {
  let cursor: string | null = null;
  const cursors = new Set<string>();
  const ids = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const result: ClosingIssuesQuery = await context.clients.graphql(
      `query DeliveryClosingIssues($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){nameWithOwner pullRequest(number:$number){id number closingIssuesReferences(first:100,after:$cursor${manual ? ',userLinkedOnly:true' : ''}){nodes{__typename id number repository{id nameWithOwner}} pageInfo{hasNextPage endCursor}}}}}`,
      { ...context.repo, number: pr.number, cursor },
    );
    const connection = result.repository?.pullRequest?.closingIssuesReferences;
    if (
      result.repository?.nameWithOwner?.toLowerCase() !== context.config.repository.toLowerCase() ||
      result.repository.pullRequest?.id !== pr.node_id ||
      result.repository.pullRequest.number !== pr.number ||
      !connection ||
      !Array.isArray(connection.nodes) ||
      connection.nodes.length > 100
    )
      throw new DeliveryError('Incomplete or conflicting native closing-reference graph.');
    for (const issue of connection.nodes) {
      if (
        !issue ||
        issue.__typename !== 'Issue' ||
        issue.id !== issueId ||
        issue.number !== issueNumber ||
        issue.repository?.id !== repositoryId ||
        issue.repository.nameWithOwner?.toLowerCase() !== context.config.repository.toLowerCase() ||
        ids.has(issue.id)
      )
        throw new DeliveryError(
          'Non-closing PR has an unintended, duplicate or incomplete native closing association.',
        );
      ids.add(issue.id);
    }
    cursor = pageCursor(connection, cursors);
    if (cursor === null) return [...ids];
  }
  throw new DeliveryError('Native closing-reference graph exceeds the bounded readback window.');
}
async function verifyNonClosingReference(
  context: DeliveryContext,
  issueNumber: number,
  pr: RemotePr,
  forReview = false,
) {
  const graph = await readNonClosingReference(context, issueNumber, pr, forReview);
  if (graph.closesTarget || graph.allClosing.length || graph.manualClosing.length)
    throw new DeliveryError('Non-closing PR has a closing native PR reference/association.');
  return graph.issue;
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
  expectedPrId?: string,
  onlyIntended = false,
  expectedIssueId?: string,
  expectedRepositoryId?: string,
  options: { allowMissing?: boolean; missingMessage?: string } = {},
): Promise<number> {
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
      if (matches !== 1 && !(matches === 0 && options.allowMissing))
        throw new DeliveryError(
          matches === 0 && options.missingMessage
            ? options.missingMessage
            : 'Native GitHub PR closing-issue association does not identify the intended issue.',
        );
      return matches;
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
async function matchingPrs(context: DeliveryContext, branch: string, base?: string, state: 'all' | 'open' = 'all') {
  const matches: Awaited<ReturnType<typeof context.clients.rest.pulls.list>>['data'] = [];
  for (let page = 1; page <= 20; page++) {
    const batch = (
      await context.clients.rest.pulls.list({
        ...context.repo,
        head: `${context.repo.owner}:${branch}`,
        ...(base === undefined ? {} : { base }),
        state,
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
async function verifyIssuePr(
  context: DeliveryContext,
  issueNumber: number,
  prNumber: number,
  nonClosing = false,
  forReview = false,
) {
  const pr = await getPr(context, prNumber);
  if (nonClosing) await verifyNonClosingReference(context, issueNumber, pr, forReview);
  else
    await verifyPrIssueAssociation(
      context,
      prNumber,
      issueNumber,
      undefined,
      false,
      undefined,
      undefined,
      forReview && !hasClosingLink(pr.body, issueNumber)
        ? {
            missingMessage: `Missing \`Closes #${issueNumber}\` in PR #${prNumber}. Restore it with issue_pr_create(${JSON.stringify({ repo: context.config.repository, issueNumber, head: pr.head.ref })}).`,
          }
        : {},
    );
  if (!pr.merged) {
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

/** Enumerate configured requirements even when a check has never reported. */
async function readRequiredCheckNames(context: PrReadContext, base: string) {
  const sources = await branchRuleSources(context, base);
  const { confirmedUnprotected, confirmedRulesetOnly } = await corroborateClassicProtectionAbsence(
    context,
    base,
    sources,
  );
  const names = new Set<string>();
  const required = new Map<string, { name: string; appId: number | null }>();
  let complete = true;
  for (const [index, result] of sources.entries()) {
    if (index === 1 && (confirmedUnprotected || confirmedRulesetOnly)) continue;
    if (
      result.status !== 'fulfilled' ||
      result.value.status !== 200 ||
      !result.value.headers ||
      result.value.headers.link
    ) {
      complete = false;
      continue;
    }
    const data = result.value.data;
    const lists: unknown[] = [];
    if (index === 0) {
      if (!Array.isArray(data)) {
        complete = false;
        continue;
      }
      for (const rule of data) {
        if (typeof rule?.type !== 'string') complete = false;
        if (rule?.type === 'required_status_checks') lists.push(rule.parameters?.required_status_checks);
      }
    } else if (Array.isArray(data) || !data || typeof data !== 'object') complete = false;
    else if (data.required_status_checks === null) lists.push([]);
    else {
      const checks = data?.required_status_checks;
      if (Array.isArray(checks?.checks)) lists.push(checks.checks);
      if (Array.isArray(checks?.contexts))
        lists.push(
          checks.contexts
            .filter(
              (context: unknown) =>
                !Array.isArray(checks?.checks) ||
                !checks.checks.some((check: { context?: unknown } | null) => check?.context === context),
            )
            .map((context: unknown) => ({ context })),
        );
      if (!Array.isArray(checks?.checks) && !Array.isArray(checks?.contexts)) complete = false;
    }
    for (const list of lists) {
      const parsed = z
        .array(
          z.object({
            context: z.string().min(1),
            app_id: z.number().int().nullable().optional(),
            integration_id: z.number().int().nullable().optional(),
          }),
        )
        .safeParse(list);
      if (!parsed.success) complete = false;
      else
        for (const check of parsed.data) {
          names.add(check.context);
          const selected = index === 0 ? check.integration_id : check.app_id;
          if (selected !== undefined && selected !== null && selected !== -1 && selected <= 0) complete = false;
          const appId = selected === undefined || selected === null || selected === -1 ? null : selected;
          required.set(JSON.stringify([check.context, appId]), { name: check.context, appId });
        }
    }
  }
  return { names: [...names].sort(), complete, required: [...required.values()] };
}

export async function queueChecks(context: DeliveryContext, base: string, sha: string) {
  return readRequiredCheckProof(context, base, sha, false);
}
async function readRequiredCheckProof(context: PrReadContext, base: string, sha: string, allowEmpty: boolean) {
  const requirements = await readRequiredCheckNames(context, base);
  if (!requirements.complete || (!allowEmpty && requirements.required.length === 0))
    return { state: 'waiting' as const, reason: 'Required queue checks are absent or incompletely discovered.' };
  if (requirements.required.length === 0)
    return { state: 'passed' as const, reason: 'Native requirements are completely observed and empty.', proof: [] };
  const [runs, statuses] = await Promise.all([
    context.clients.rest.checks.listForRef({ ...context.repo, ref: sha, filter: 'latest', per_page: 100 }),
    context.clients.rest.repos.getCombinedStatusForRef({ ...context.repo, ref: sha, per_page: 100 }),
  ]);
  if (
    runs.status !== 200 ||
    statuses.status !== 200 ||
    !runs.headers ||
    !statuses.headers ||
    runs.headers?.link ||
    statuses.headers?.link ||
    runs.data.total_count !== runs.data.check_runs.length ||
    statuses.data.total_count !== statuses.data.statuses.length ||
    statuses.data.sha !== sha ||
    runs.data.check_runs.some((run) => run.head_sha !== sha)
  )
    return { state: 'waiting' as const, reason: 'Queue SHA check/status pagination or identity is incomplete.' };
  const proof: { name: string; appId: number | null; id: number }[] = [];
  for (const required of requirements.required) {
    const status = statuses.data.statuses.filter((s) => s.context === required.name).sort((a, b) => b.id - a.id)[0];
    let waiting: string | undefined;
    if (status) {
      if (required.appId !== null) waiting = `Queue status ${required.name} required App source cannot be established.`;
      else if (!Number.isSafeInteger(status.id) || status.id <= 0)
        waiting = `Queue status ${required.name} attempt is unknown.`;
      else if (status.state === 'failure' || status.state === 'error')
        return { state: 'failed' as const, reason: `Queue status ${required.name} is ${status.state}.` };
      else if (status.state !== 'success')
        waiting = `Queue status ${required.name} is ${status.state === 'pending' ? 'pending' : 'unknown'}.`;
      else proof.push({ ...required, id: status.id });
    }
    const candidates = runs.data.check_runs
      .filter((run) => run.name === required.name && (required.appId === null || run.app?.id === required.appId))
      .sort((a, b) => b.id - a.id);
    const run = candidates[0];
    if (run) {
      if (!Number.isSafeInteger(run.id) || run.id <= 0 || !run.app?.id)
        return { state: 'waiting' as const, reason: `Queue check ${required.name} producer/attempt is unknown.` };
      if (run.status !== 'completed')
        return { state: 'waiting' as const, reason: `Queue check ${required.name} is pending.` };
      if (
        run.conclusion !== 'success' &&
        !['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'].includes(
          run.conclusion ?? '',
        )
      )
        return {
          state: 'waiting' as const,
          reason: `Queue check ${required.name} conclusion is unknown or not successful.`,
        };
      if (run.conclusion !== 'success')
        return {
          state: 'failed' as const,
          reason: `Queue check ${required.name} concluded ${run.conclusion ?? 'unknown'}.`,
        };
      proof.push({ ...required, id: run.id });
    } else if (!status) waiting = `Queue check ${required.name} has not reported from its required source.`;
    if (waiting) return { state: 'waiting' as const, reason: waiting };
  }
  return { state: 'passed' as const, reason: 'Current required queue SHA checks passed.', proof };
}

export async function prChecks(context: DeliveryContext, prNumber: number) {
  const pr = await getPr(context, prNumber);
  const requirements = await readRequiredCheckNames(context, pr.base.ref);
  const [checks, status, reviewState] = await Promise.all([
    context.clients.rest.checks.listForRef({ ...context.repo, ref: pr.head.sha, per_page: 100 }),
    context.clients.rest.repos.getCombinedStatusForRef({ ...context.repo, ref: pr.head.sha, per_page: 100 }),
    readRequiredReviewState(context, prNumber, pr.head.sha),
  ]);
  const headChecksComplete =
    checks.data.total_count === checks.data.check_runs.length &&
    status.data.total_count === status.data.statuses.length;
  return {
    schemaVersion: 'ai-delivery.pr-checks@1' as const,
    prNumber: pr.number,
    headSha: pr.head.sha,
    combinedStatus: status.data.state,
    mergeStateStatus: pr.mergeable_state ?? 'unknown',
    requiredCheckDiscovery: requirements.complete ? 'complete' : 'partial',
    headChecksComplete,
    requiredChecks: requirements.names.map((name) => {
      const states = [
        ...checks.data.check_runs
          .filter((check) => check.name === name)
          .map((check) => `check: ${check.status}/${check.conclusion ?? 'pending'}`),
        ...status.data.statuses.filter((check) => check.context === name).map((check) => `status: ${check.state}`),
      ];
      return { name, headState: states.join('; ') || (headChecksComplete ? 'not-reported' : 'unknown') };
    }),
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

function branchRuleSources(context: PrReadContext, base: string, control?: { signal: AbortSignal }) {
  return Promise.allSettled([
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
}

async function corroborateClassicProtectionAbsence(
  context: PrReadContext,
  base: string,
  [rulesetResult, protectionResult]: Awaited<ReturnType<typeof branchRuleSources>>,
  control?: { signal: AbortSignal; checkResources: () => Promise<void> },
) {
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
    await control?.checkResources();
    control?.signal.throwIfAborted();
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
  return { confirmedUnprotected, confirmedRulesetOnly };
}

async function routeAuthor(
  context: DeliveryContext,
  purpose: 'development' | 'publication',
  check: () => Promise<void> = async () => {},
  signal?: AbortSignal,
): Promise<ReviewRoutePreflight['author']> {
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
  const author = await context.clients.authenticatedAuthor(signal);
  await check();
  if (!author.actorLogin || !author.credentialIdentity) {
    throw new DeliveryError('Author GitHub identity readback is incomplete.');
  }
  return {
    actorLogin: author.actorLogin,
    authSource: context.clients.authSource,
    credentialSource: context.clients.credentialSource ?? 'unreported',
    identity: personalDevelopmentOverride ? 'personal' : context.config.roles.author.identity,
  };
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
  const author = await routeAuthor(context, purpose, check, control?.signal);
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
  const [rulesetResult, protectionResult] = await branchRuleSources(context, base, control);
  await check();
  const { confirmedUnprotected, confirmedRulesetOnly } = await corroborateClassicProtectionAbsence(
    context,
    base,
    [rulesetResult, protectionResult],
    control,
  );
  const counts: number[] = [];
  let countsKnown = rulesetResult.status === 'fulfilled' && completeRulePage(rulesetResult.value);
  if (rulesetResult.status === 'fulfilled' && Array.isArray(rulesetResult.value.data)) {
    for (const rule of rulesetResult.value.data) {
      if (typeof rule !== 'object' || rule === null || typeof rule.type !== 'string' || !rule.type) countsKnown = false;
      if (rule?.type === 'pull_request') {
        const count = requiredApprovalCount(rule.parameters);
        if (count === null) countsKnown = false;
        else counts.push(count);
      }
    }
  }
  if (protectionResult.status === 'fulfilled') {
    const protection = protectionResult.value.data as { required_pull_request_reviews?: unknown };
    const count =
      typeof protection === 'object' && protection !== null && !Array.isArray(protection)
        ? requiredApprovalCount(protection.required_pull_request_reviews)
        : null;
    if (protectionResult.value.status !== 200 || count === null) countsKnown = false;
    if (count !== null) counts.push(count);
  } else if (!confirmedUnprotected && !confirmedRulesetOnly) countsKnown = false;
  const rulesVisible =
    rulesetResult.status === 'fulfilled' &&
    Array.isArray(rulesetResult.value.data) &&
    (rulesetResult.value.headers?.link === undefined || rulesetResult.value.headers.link === '');
  const visible =
    Number(rulesVisible) +
    Number(protectionResult.status === 'fulfilled' || confirmedUnprotected || confirmedRulesetOnly);
  const visibility = visible === 2 ? 'complete' : visible === 1 ? 'partial' : 'unknown';
  // A positive observation is a conservative lower bound for permission checks.
  // Zero requires complete, valid requirement evidence from every source.
  const observedRequiredApprovals =
    counts.length > 0 && (countsKnown || counts.some((count) => count > 0))
      ? Math.max(...counts)
      : countsKnown && confirmedUnprotected
        ? 0
        : null;
  const insufficientPermission =
    observedRequiredApprovals !== null &&
    observedRequiredApprovals > 0 &&
    reviewer.effectiveContentsPermission === 'read';
  return {
    author,
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
    reconcileNonClosingReference?: boolean;
    expectedHeadSha?: string;
    expectedBaseSha?: string;
    body?: string;
    title?: string;
    draft?: boolean;
    headBranch?: string;
    baseBranch?: string;
    dryRun?: boolean;
  },
) {
  const nonClosing = nonClosingMode(input.nonClosing);
  const reconcileReference = nonClosingMode(input.reconcileNonClosingReference);
  if (reconcileReference) {
    if (
      context.clients.role !== 'author' ||
      context.clients.authSource !== (context.config.roles.author.authSource ?? 'app') ||
      !context.clients.authenticatedAuthor
    )
      throw new DeliveryError('Reference reconciliation requires the configured authenticated author role.');
    if (
      !nonClosing ||
      input.draft === false ||
      !validSha(input.expectedHeadSha) ||
      !validSha(input.expectedBaseSha) ||
      typeof input.body !== 'string' ||
      !input.body.trim()
    )
      throw new DeliveryError(
        'Reference reconciliation requires nonClosing, DRAFT, explicit safe body and exact expected head/base SHAs.',
      );
    refuseClosingDirective(input.body);
  } else if (input.expectedHeadSha !== undefined || input.expectedBaseSha !== undefined)
    throw new DeliveryError('Expected head/base inputs require explicit reconcileNonClosingReference.');
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
  const explicitPromotion = nonClosing && input.draft === false && input.headBranch !== undefined;
  const selectedMatches = explicitPromotion ? await matchingPrs(context, input.headBranch!, base) : undefined;
  const branch = explicit
    ? explicit.head.ref
    : nonClosing
      ? explicitPromotion && selectedMatches!.length > 0
        ? input.headBranch!
        : await issueBranch(context, input.issueNumber, input.headBranch)
      : (input.headBranch ?? (await issueBranch(context, input.issueNumber)));
  if (input.headBranch !== undefined && branch !== input.headBranch)
    throw new DeliveryError('Explicit PR and head selectors disagree.');
  validBranch(branch);
  const ref = (await context.clients.rest.git.getRef({ ...context.repo, ref: `heads/${branch}` })).data;
  if (ref.ref !== `refs/heads/${branch}` || ref.object.type !== 'commit' || !validSha(ref.object.sha))
    throw new DeliveryError('Remote issue branch head/ref readback is invalid.');
  const matches = selectedMatches ?? (await matchingPrs(context, branch, base, nonClosing ? 'all' : 'open'));
  if (matches.length > 1 || (explicit && (matches.length !== 1 || matches[0]!.number !== explicit.number)))
    throw new DeliveryError('Remote issue branch has conflicting PR matches.');
  let pr = explicit ?? (matches[0] === undefined ? undefined : await getPr(context, matches[0].number));
  if (
    pr &&
    input.draft === false &&
    input.headBranch === undefined &&
    input.prNumber === undefined &&
    (await linkedIssueBranches(context, input.issueNumber)).filter((entry) => entry.name === branch).length !== 1
  )
    throw new DeliveryError('Select an explicit PR or head after GitHub-linked branch references disappear.');
  if (reconcileReference && pr && !explicit)
    throw new DeliveryError(
      'Reference reconciliation of an existing match requires explicit --pr and caller-reconciled authority/attempt receipts.',
    );
  if (nonClosing && !pr && !reconcileReference)
    throw new DeliveryError(
      'New linked-branch non-closing publication requires explicitly authorized --reconcile-non-closing-reference --expected-head SHA --expected-base SHA and --body-file PATH; bare --non-closing grants no removal authority.',
    );
  if (reconcileReference && ref.object.sha !== input.expectedHeadSha)
    throw new DeliveryError('Reference reconciliation expected head differs from the exact remote linked head.');
  const requestedBody =
    input.body ?? pr?.body ?? (nonClosing ? referenceLine(context, input.issueNumber) : closingBody(issue));
  if ((nonClosing || input.body !== undefined) && !requestedBody.trim())
    throw new DeliveryError('PR body must contain text.');
  const body = publicationBody(
    nonClosing ? nonClosingBody(context, input.issueNumber, requestedBody) : closingBody(issue, requestedBody),
    pr?.body,
  );
  const closingRepair = !nonClosing && pr !== undefined && !hasClosingLink(pr.body, input.issueNumber);
  const transition = nonClosing && pr !== undefined && pr.body !== body;
  // A PR that already references the issue changes only its body; a closing PR converts (#238).
  const referenceUpdate = transition && hasReferenceBody(context, input.issueNumber, pr?.body);
  if (reconcileReference && transition)
    throw new DeliveryError('Reference reconciliation refuses body transition; retain exact original intent.');
  if (transition && (input.prNumber === undefined || input.body === undefined))
    throw new DeliveryError('Non-closing body transition requires an explicit existing PR number and body.');
  if (
    pr &&
    (pr.head.sha !== ref.object.sha ||
      pr.head.ref !== branch ||
      pr.base.ref !== base ||
      pr.state !== 'open' ||
      pr.merged ||
      (!transition && input.body !== undefined && pr.body !== input.body && pr.body !== body) ||
      (input.title !== undefined && pr.title !== input.title))
  )
    throw new DeliveryError('Existing remote PR conflicts with the requested branch, intent or state.');
  // Opening a closing PR needs only the author; review submission checks the reviewer App.
  const reviewRoute = nonClosing
    ? await nonClosingRoute(context, base)
    : { author: await routeAuthor(context, 'publication') };
  if (pr && pr.user.login.toLowerCase() !== reviewRoute.author.actorLogin.toLowerCase())
    throw new DeliveryError('Existing PR author differs from the configured authenticated author.');
  if (pr && (typeof pr.node_id !== 'string' || !pr.node_id))
    throw new DeliveryError('Existing PR publication identity is incomplete.');
  if (nonClosing) refuseClosingDirective(input.title ?? pr?.title ?? issue.title);
  const creationTitle = input.title ?? issue.title;
  let publicationBaseSha: string | undefined;
  const existing = pr;
  let pendingTransition = transition;
  let pendingClosingRepair = closingRepair;
  let expectedBody = pr?.body;
  const transitionDraft = pr?.draft;
  let promotionApplied = false;
  let removalState: 'not attempted' | 'acknowledged' | 'uncertain' = 'not attempted';
  const preserveIssue = async () => {
    if (nonClosing) sameReferenceIssue(issue, await openReferenceIssue(context, input.issueNumber));
  };
  const readReconciliation = async (selected: RemotePr) => {
    try {
      if (
        selected.state !== 'open' ||
        selected.draft !== true ||
        selected.merged ||
        selected.head.sha !== input.expectedHeadSha ||
        selected.base.sha !== input.expectedBaseSha ||
        selected.head.ref !== branch ||
        selected.base.ref !== base ||
        selected.body !== body ||
        selected.title !== (existing?.title ?? creationTitle) ||
        selected.user.login.toLowerCase() !== reviewRoute.author.actorLogin.toLowerCase()
      )
        throw new DeliveryError('Reference reconciliation DRAFT, exact head/base, message or author drifted.');
      const graph = await readNonClosingReference(context, input.issueNumber, selected);
      sameReferenceIssue(issue, graph.issue);
      const safe = !graph.closesTarget && !graph.allClosing.length && !graph.manualClosing.length;
      if (!safe && !(graph.closesTarget && graph.allClosing.length === 1 && graph.manualClosing.length === 1))
        throw new DeliveryError(
          'Reference removal requires only the intended manual closing pair and closing cross-reference.',
        );
      const currentHead = (await context.clients.rest.git.getRef({ ...context.repo, ref: `heads/${branch}` })).data;
      if (
        currentHead.ref !== ref.ref ||
        currentHead.object.type !== 'commit' ||
        currentHead.object.sha !== input.expectedHeadSha
      )
        throw new DeliveryError('Reference reconciliation source head drifted.');
      sameReferencePr(selected, await getPr(context, selected.number));
      await preserveIssue();
      return !safe;
    } catch (error) {
      throw new DeliveryError(
        `PR #${selected.number}; reference removal ${removalState}. Reconcile read-only; do not retry without caller-established authority and attempt history. ${error instanceof Error ? error.message : 'Unknown failure'}`,
      );
    }
  };
  const readExisting = async () => {
    const current =
      reconcileReference || pendingClosingRepair
        ? await getPr(context, existing!.number)
        : await verifyIssuePr(
            context,
            input.issueNumber,
            existing!.number,
            nonClosing && (!pendingTransition || referenceUpdate),
          );
    if (
      current.state !== 'open' ||
      current.merged ||
      current.node_id !== existing!.node_id ||
      current.head.sha !== ref.object.sha ||
      current.head.ref !== branch ||
      current.base.ref !== base ||
      current.base.sha !== existing!.base.sha ||
      current.user.login.toLowerCase() !== reviewRoute.author.actorLogin.toLowerCase() ||
      ((transition || closingRepair) && !promotionApplied && current.draft !== transitionDraft) ||
      current.body !== expectedBody ||
      current.title !== existing!.title
    )
      throw new DeliveryError('Existing PR publication head, identity, intent or author readback drifted.');
    if (reconcileReference) await readReconciliation(current);
    if (pendingClosingRepair) {
      await verifyPrIssueAssociation(
        context,
        current.number,
        input.issueNumber,
        current.node_id,
        true,
        issue.node_id,
        repository.node_id,
        { allowMissing: true },
      );
      const currentRef = (await context.clients.rest.git.getRef({ ...context.repo, ref: `heads/${branch}` })).data;
      if (currentRef.ref !== ref.ref || currentRef.object.type !== 'commit' || currentRef.object.sha !== ref.object.sha)
        throw new DeliveryError('Closing-link repair remote head drifted; reconcile read-only.');
      sameReferencePr(current, await getPr(context, current.number));
    }
    if (pendingTransition && !referenceUpdate) {
      await verifyPrIssueAssociation(
        context,
        current.number,
        input.issueNumber,
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
    if (reconcileReference && publicationBaseSha !== input.expectedBaseSha)
      throw new DeliveryError('Reference reconciliation expected default base differs from the remote base.');
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
      ...(pr === undefined ? { body } : {}),
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
      ...(closingRepair ? { closingLinkAdded: false, body } : {}),
      ...(reconcileReference ? { referenceRemoval: 'pending', nonClosingVerified: false } : {}),
    };
  let created = false;
  const warnings: string[] = [];
  if (pr) {
    if (pendingClosingRepair) {
      pr = await readExisting();
      try {
        await context.clients.rest.pulls.update({ ...context.repo, pull_number: pr.number, body });
      } catch (error) {
        throw new DeliveryError(
          `PR #${pr.number} closing-link repair acknowledgement is uncertain; reconcile this PR read-only before retrying. ${error instanceof Error ? error.message : 'Unknown failure'}`,
        );
      }
      pendingClosingRepair = false;
      expectedBody = body;
      pr = await readExisting();
    }
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
      if (reconcileReference && (await readReconciliation(pr))) {
        // The trusted caller owns the exact grant and prior-attempt history.
        // This invocation never retries this non-transactional native action.
        if (await readReconciliation(pr)) {
          removalState = 'uncertain';
          try {
            const removed = await context.clients.graphql<{
              removeCloseIssueReferences?: { issue?: { id: string } | null } | null;
            }>(
              'mutation DeliveryRemoveClosingReference($issueId:ID!,$pullRequestIds:[ID!]!,$clientMutationId:String!){removeCloseIssueReferences(input:{issueId:$issueId,pullRequestIds:$pullRequestIds,clientMutationId:$clientMutationId}){issue{id}}}',
              { issueId: issue.node_id, pullRequestIds: [pr.node_id], clientMutationId: randomUUID() },
            );
            if (removed.removeCloseIssueReferences?.issue?.id !== issue.node_id)
              throw new DeliveryError('Incomplete reference-removal acknowledgement.');
            removalState = 'acknowledged';
          } catch (error) {
            throw new DeliveryError(
              `PR #${pr.number}; reference removal acknowledgement is uncertain. Reconcile read-only; no automatic retry or rollback. ${error instanceof Error ? error.message : 'Unknown failure'}`,
            );
          }
        }
      }
      const verified = await verifyIssuePr(context, input.issueNumber, pr.number, true);
      sameReferencePr(pr, verified);
      pr = verified;
      await preserveIssue();
    } else if (
      // GitHub lists a new PR's closing link a few seconds after creation (aviaratech/ai#3780).
      (await verifyPrIssueAssociation(context, pr.number, input.issueNumber, undefined, false, undefined, undefined, {
        allowMissing: created,
      })) === 0
    )
      warnings.push(
        `GitHub has not yet listed PR #${pr.number} as closing #${input.issueNumber}; confirm with issue_pr_info.`,
      );
    if (created) {
      const final = await getPr(context, pr.number);
      sameReferencePr(pr, final);
      pr = final;
    }
  } catch (error) {
    if (!created && !reconcileReference) throw error;
    throw new DeliveryError(
      `GitHub ${created ? 'created' : 'selected'} PR #${pr.number} (${pr.html_url}) at ${pr.head.sha}; post-publication association/identity verification is unresolved.${reconcileReference ? ` Reference removal ${removalState}.` : ''} Reconcile this PR read-only; do not create again. ${error instanceof Error ? error.message : 'Unknown failure'}`,
    );
  }
  return {
    prNumber: pr.number,
    url: pr.html_url,
    headSha: pr.head.sha,
    state: pr.draft ? 'draft' : pr.state,
    ...(closingRepair ? { closingLinkAdded: true } : {}),
    ...(nonClosing ? { nonClosing: true, nonClosingVerified: true } : {}),
    ...(reconcileReference ? { referenceRemoval: removalState } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

export async function submitFormalReview(
  context: DeliveryContext,
  input: { artifact: string; issueNumber: number; prNumber: number; dryRun?: boolean; nonClosing?: boolean },
) {
  const nonClosing = nonClosingMode(input.nonClosing);
  const pr = await verifyIssuePr(context, input.issueNumber, input.prNumber, nonClosing, true);
  const issue = nonClosing ? await openReferenceIssue(context, input.issueNumber) : undefined;
  const result = await submitReview({
    context,
    artifact: parseReviewArtifact(input.artifact),
    issueNumber: input.issueNumber,
    prNumber: input.prNumber,
    ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
  });
  try {
    if (nonClosing) {
      sameReferencePr(pr, await verifyIssuePr(context, input.issueNumber, input.prNumber, true, true));
      sameReferenceIssue(issue!, await openReferenceIssue(context, input.issueNumber));
    }
    if ('dryRun' in result) return result;
    return {
      ...result,
      requiredReview: await readRequiredReviewState(context, input.prNumber, result.headSha, {
        id: result.githubReviewId,
        login: result.login,
        state: result.state,
      }),
    };
  } catch (error) {
    if ('dryRun' in result) throw error;
    throw new ReviewSubmissionError(
      error instanceof DeliveryError ? error.message : 'Post-submission status is unavailable.',
      {
        artifactId: result.artifact.artifactId,
        repository: result.repository,
        headSha: result.headSha,
        prNumber: result.prNumber,
        githubReviewId: result.githubReviewId,
        githubReviewUrl: result.githubReviewUrl,
      },
    );
  }
}
export { startIssueBranch };
