import { z } from 'zod';
import type { DeliveryContext } from '../issue.js';
import { DeliveryError } from '../errors.js';
import {
  getIssueProjectStatus,
  getProjectDeliveryConfiguration,
  projectSettingsFromDeliveryConfig,
} from '../github/projectDelivery.js';
import { historicalActivityEvidence, readIssueHistory } from '../github/issueHistory.js';

export const DeliveryHealthInput = z
  .strictObject({
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    maxIssues: z.number().int().positive().max(500).default(200),
    maxProjectPages: z.number().int().positive().max(20).default(5),
    maxTimelinePages: z.number().int().positive().max(20).default(5),
    oldestLimit: z.number().int().positive().max(20).default(10),
  })
  .refine((value) => Date.parse(value.from) < Date.parse(value.to), { message: 'from must precede to', path: ['to'] })
  .refine((value) => Date.parse(value.to) <= Date.now(), {
    message: 'to must be at or before collection time',
    path: ['to'],
  });
export type DeliveryHealthRequest = z.input<typeof DeliveryHealthInput>;
const RepositoryIssue = z.object({
  number: z.number().int().positive(),
  node_id: z.string().min(1),
  created_at: z.iso.datetime(),
  state: z.enum(['open', 'closed']),
  html_url: z.string().url(),
  title: z.string(),
  pull_request: z.unknown().optional(),
});

/** A bounded, non-atomic read-only view of one repository lane in the configured Project. */
export async function deliveryHealth(context: DeliveryContext, raw: DeliveryHealthRequest) {
  const input = DeliveryHealthInput.parse(raw);
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  if (repository.toLowerCase() !== input.repo.toLowerCase())
    throw new DeliveryError('Health repository selector disagrees with the configured context.');
  const collectionStartedAt = new Date().toISOString();
  const asOf = collectionStartedAt;
  const issues = new Map<number, z.infer<typeof RepositoryIssue>>();
  const limitations: { issueNumber?: number; scope: string; reason: string }[] = [];
  const configuration =
    context.projectConfiguration ??
    (await getProjectDeliveryConfiguration({
      graphql: context.clients.graphql,
      org: context.config.native.organization,
      settings: projectSettingsFromDeliveryConfig(context.config),
    }));
  let listingComplete = false;
  for (let page = 1; page <= 20; page++) {
    try {
      const batch = (
        await context.clients.rest.issues.listForRepo({
          ...context.repo,
          state: 'all',
          sort: 'created',
          direction: 'asc',
          per_page: 100,
          page,
        })
      ).data;
      for (const value of batch) {
        if ('pull_request' in value) continue;
        const issue = RepositoryIssue.parse(value);
        const url = new URL(issue.html_url);
        if (
          url.hostname !== 'github.com' ||
          url.protocol !== 'https:' ||
          url.pathname.toLowerCase() !== `/${repository}/issues/${issue.number}`.toLowerCase()
        )
          throw new DeliveryError('Health issue repository identity disagrees.');
        if (!issues.has(issue.number) && issues.size === input.maxIssues)
          throw new DeliveryError('Repository issue limit reached');
        issues.set(issue.number, issue);
      }
      if (batch.length < 100) {
        listingComplete = true;
        break;
      }
    } catch (error) {
      limitations.push({
        scope: 'repository inventory',
        reason: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
      });
      break;
    }
  }
  if (!listingComplete && !limitations.length)
    limitations.push({ scope: 'repository inventory', reason: 'Repository listing page limit reached' });
  const within = (time: string) =>
    Date.parse(time) >= Date.parse(input.from) && Date.parse(time) < Date.parse(input.to);
  const opened = [...issues.values()].filter((issue) => within(issue.created_at)).length;
  const closed = new Set<number>();
  const blockerEvents = new Map<string, 'active' | 'inactive' | 'unknown'>();
  const active: z.infer<typeof RepositoryIssue>[] = [];
  let currentStatusUnknown = 0;
  let historyComplete = true;
  const historicalUnknownReasons = new Map<string, number>();
  for (const issue of issues.values()) {
    try {
      const status = await getIssueProjectStatus({
        graphql: context.clients.graphql,
        issueNodeId: issue.node_id,
        org: context.config.native.organization,
        configuration,
        maxPages: input.maxProjectPages,
      });
      if (status === null) {
        currentStatusUnknown++;
        limitations.push({
          issueNumber: issue.number,
          scope: 'current Project status',
          reason: 'No resolvable current configured-Project status',
        });
      }
      if (issue.state === 'open' && status?.status === 'In Progress') active.push(issue);
    } catch (error) {
      currentStatusUnknown++;
      limitations.push({
        issueNumber: issue.number,
        scope: 'current Project status',
        reason: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
      });
    }
    try {
      const history = await readIssueHistory(context, issue.number, input.maxTimelinePages, issue.node_id);
      if (!history.complete) {
        historyComplete = false;
        limitations.push({
          issueNumber: issue.number,
          scope: 'native timeline',
          reason: history.reason ?? 'Incomplete timeline',
        });
      }
      for (const event of history.events.filter((value) => within(value.createdAt))) {
        if (event.__typename === 'ClosedEvent') closed.add(issue.number);
        if (event.__typename === 'BlockedByAddedEvent' && !blockerEvents.has(event.id)) {
          const evidence = historicalActivityEvidence(
            history,
            event,
            configuration.projectId,
            context.config.native.project.statuses.inProgress,
            Object.values(context.config.native.project.statuses),
          );
          blockerEvents.set(event.id, evidence.activity);
          if (evidence.reason)
            historicalUnknownReasons.set(evidence.reason, (historicalUnknownReasons.get(evidence.reason) ?? 0) + 1);
        }
      }
    } catch (error) {
      historyComplete = false;
      limitations.push({
        issueNumber: issue.number,
        scope: 'native timeline',
        reason: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
      });
    }
  }
  const classifications = [...blockerEvents.values()];
  return {
    repository,
    lane: { kind: 'repository', repository, projectId: configuration.projectId },
    window: { from: input.from, to: input.to, bounds: '[from,to)' },
    snapshot: { asOf, collectionStartedAt, collectionFinishedAt: new Date().toISOString(), atomic: false },
    completeness: {
      complete: listingComplete && limitations.length === 0 && historicalUnknownReasons.size === 0,
      issuesObserved: issues.size,
      listingComplete,
      limitations,
      metricCoverage: {
        opened: listingComplete,
        closed: listingComplete && historyComplete,
        active: listingComplete && currentStatusUnknown === 0,
        blockerAdditions: listingComplete && historyComplete,
        historicalActivity: listingComplete && historyComplete && historicalUnknownReasons.size === 0,
      },
      limits: {
        maxIssues: input.maxIssues,
        maxTimelinePages: input.maxTimelinePages,
        maxProjectPages: input.maxProjectPages,
      },
    },
    countsBasis: 'Observed counts; metrics with incomplete coverage are lower bounds.',
    historicalUnknownReasons: [...historicalUnknownReasons].map(([reason, count]) => ({ reason, count })),
    counts: {
      opened,
      closed: closed.size,
      active: active.length,
      currentStatusUnknown,
      blockerAdditions: {
        total: blockerEvents.size,
        active: classifications.filter((value) => value === 'active').length,
        inactive: classifications.filter((value) => value === 'inactive').length,
        unknown: classifications.filter((value) => value === 'unknown').length,
      },
    },
    oldestActive: active
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.number - b.number)
      .slice(0, input.oldestLimit)
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        url: issue.html_url,
        createdAt: issue.created_at,
        createdAgeDays: Math.max(0, Math.floor((Date.parse(asOf) - Date.parse(issue.created_at)) / 86400000)),
      })),
    semantics: {
      closed: 'Distinct issues with a native ClosedEvent in the window; reopen/reclose counts once.',
      blockerAdditions:
        'Distinct native BlockedByAddedEvent IDs; comments alone do not count. Unknown historical activity is not a policy violation.',
      oldestActive:
        'Current open In Progress issues ordered by creation time; age is since creation, not time in progress.',
      scope:
        'One explicitly selected repository; Project grouping defines the repository lane. Missing or inaccessible status and history are reported, not inferred.',
    },
  };
}
