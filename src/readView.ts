import { z } from 'zod';

import { getIssueProjectStatus, projectSettingsFromDeliveryConfig } from './github/projectDelivery.js';
import { issueInfo, type DeliveryContext } from './issue.js';
import { prInfo } from './pr.js';

/** One-call reads: the existing readers plus the PR, check, review and journal facts agents otherwise fetch with gh. */

const Context = z.union([
  z.object({
    __typename: z.literal('CheckRun'),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
  }),
  z.object({ __typename: z.literal('StatusContext'), context: z.string(), state: z.string() }),
]);
const PrNode = z.object({
  number: z.number().int().positive(),
  url: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  mergeStateStatus: z.string(),
  reviewDecision: z.string().nullable(),
  headRefOid: z.string(),
  latestReviews: z.object({
    nodes: z.array(
      z.object({
        author: z.object({ login: z.string() }).nullable(),
        state: z.string(),
        commit: z.object({ oid: z.string() }).nullable(),
      }),
    ),
  }),
  commits: z.object({
    nodes: z.array(
      z.object({
        commit: z.object({
          statusCheckRollup: z
            .object({ state: z.string(), contexts: z.object({ nodes: z.array(Context) }) })
            .nullable(),
        }),
      }),
    ),
  }),
});
const PR_FIELDS = `number url state isDraft mergeStateStatus reviewDecision headRefOid
  latestReviews(first: 10) { nodes { author { login } state commit { oid } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 50) { nodes {
    __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state }
  } } } } } }`;

export function summarizePr(raw: unknown) {
  const pr = PrNode.parse(raw);
  const contexts = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
  const named = contexts.map((c) =>
    c.__typename === 'CheckRun'
      ? {
          name: c.name,
          done: c.status === 'COMPLETED',
          ok: c.conclusion === 'SUCCESS' || c.conclusion === 'NEUTRAL' || c.conclusion === 'SKIPPED',
        }
      : { name: c.context, done: c.state !== 'PENDING' && c.state !== 'EXPECTED', ok: c.state === 'SUCCESS' },
  );
  return {
    number: pr.number,
    url: pr.url,
    state: pr.state.toLowerCase(),
    draft: pr.isDraft,
    mergeState: pr.mergeStateStatus.toLowerCase(),
    checks: {
      state: pr.commits.nodes[0]?.commit.statusCheckRollup?.state.toLowerCase() ?? 'none',
      failing: named.filter((c) => c.done && !c.ok).map((c) => c.name),
      pending: named.filter((c) => !c.done).map((c) => c.name),
    },
    reviews: {
      decision: pr.reviewDecision?.toLowerCase() ?? 'none',
      latest: pr.latestReviews.nodes.map((review) => ({
        by: review.author?.login ?? 'unknown',
        state: review.state.toLowerCase(),
        current: review.commit?.oid === pr.headRefOid,
      })),
    },
  };
}

const Comment = z.object({ body: z.string(), createdAt: z.string(), url: z.string() });
const JOURNAL_MARKER = /<!--\s*ai-delivery:journal@1:sha256:[a-f0-9]{64}\s*-->\s*$/u;

/** The newest typed journal comment, reduced to its own `Status: … Next: …` preview line. */
export function latestJournal(comments: readonly z.infer<typeof Comment>[]) {
  const journal = comments.findLast((comment) => JOURNAL_MARKER.test(comment.body));
  return journal ? { url: journal.url, createdAt: journal.createdAt, preview: journal.body.split('\n')[0]! } : null;
}

function sameRepository(source: unknown, repository: string): boolean {
  const { repository: found } = z.object({ repository: z.object({ nameWithOwner: z.string() }) }).parse(source);
  return found.nameWithOwner.toLowerCase() === repository;
}

const IssueLinks = z.object({
  repository: z.object({
    issue: z.object({
      id: z.string(),
      state: z.enum(['OPEN', 'CLOSED']),
      comments: z.object({ nodes: z.array(Comment) }),
      timelineItems: z.object({
        nodes: z.array(
          z.object({
            source: z.looseObject({ __typename: z.string() }),
          }),
        ),
      }),
    }),
  }),
});

export const ISSUE_LINKS_QUERY = `query ReadIssueLinks($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $number) {
            id state
            comments(last: 30) { nodes { body createdAt url } }
            timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: 5) { nodes { ... on CrossReferencedEvent {
              source { __typename ... on PullRequest { repository { nameWithOwner } ${PR_FIELDS} } }
            } } }
          }
        }
      }`;

export async function readIssueLinks(context: DeliveryContext, issueNumber: number) {
  const data = IssueLinks.parse(
    await context.clients.graphql(ISSUE_LINKS_QUERY, { ...context.repo, number: issueNumber }),
  ).repository.issue;
  const repository = `${context.repo.owner}/${context.repo.repo}`.toLowerCase();
  const seen = new Set<number>();
  const pullRequests = data.timelineItems.nodes
    .toReversed()
    .flatMap(({ source }) =>
      source.__typename === 'PullRequest' && sameRepository(source, repository) ? [summarizePr(source)] : [],
    )
    .filter((pr) => !seen.has(pr.number) && seen.add(pr.number));
  return {
    id: data.id,
    state: data.state.toLowerCase(),
    pullRequests,
    latestJournal: latestJournal(data.comments.nodes),
  };
}

/** issue_info plus the linked PRs (state, checks, reviews) and the latest journal, in one call. */
export async function issueView(context: DeliveryContext, issueNumber: number, options: { verbose: boolean }) {
  const [info, links] = await Promise.all([
    issueInfo(context, issueNumber, { childDetail: options.verbose }),
    readIssueLinks(context, issueNumber),
  ]);
  return { ...info, pullRequests: links.pullRequests, latestJournal: links.latestJournal };
}

async function readIssueBrief(context: DeliveryContext, issueNumber: number) {
  const links = await readIssueLinks(context, issueNumber);
  const status = await getIssueProjectStatus({
    graphql: context.clients.graphql,
    issueNodeId: links.id,
    org: context.config.native.organization,
    ...(context.projectConfiguration ? { configuration: context.projectConfiguration } : {}),
    settings: projectSettingsFromDeliveryConfig(context.config),
  });
  return {
    number: issueNumber,
    state: links.state,
    projectStatus: status?.status ?? null,
    latestJournal: links.latestJournal,
  };
}

/** issue_pr_info plus checks, reviews and the linked issues' state, board Status and latest journal. */
export async function prView(
  context: DeliveryContext,
  input: { issueNumber?: number; prNumber?: number; nonClosing?: boolean },
) {
  const [info, early, given] = await Promise.all([
    prInfo(context, input),
    input.prNumber === undefined ? undefined : readPrSummary(context, input.prNumber),
    input.issueNumber === undefined ? undefined : readIssueBrief(context, input.issueNumber),
  ]);
  const summary = early ?? (await readPrSummary(context, info.prNumber));
  const others = await Promise.all(
    summary.closes.filter((number) => number !== input.issueNumber).map((number) => readIssueBrief(context, number)),
  );
  const { checks, reviews, mergeState } = summary;
  return { ...info, mergeState, checks, reviews, issues: [...(given ? [given] : []), ...others] };
}

export const PR_SUMMARY_QUERY = `query ReadPrSummary($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) { ${PR_FIELDS} closingIssuesReferences(first: 5) { nodes { number } } }
          }
        }`;

export async function readPrSummary(context: DeliveryContext, prNumber: number) {
  const data = z
    .object({
      repository: z.object({
        pullRequest: PrNode.extend({
          closingIssuesReferences: z.object({ nodes: z.array(z.object({ number: z.number().int().positive() })) }),
        }),
      }),
    })
    .parse(await context.clients.graphql(PR_SUMMARY_QUERY, { ...context.repo, number: prNumber }))
    .repository.pullRequest;
  return { ...summarizePr(data), closes: data.closingIssuesReferences.nodes.map((issue) => issue.number) };
}
