import { z } from 'zod';
import type { DeliveryContext } from '../issue.js';
import { DeliveryError } from '../errors.js';

const Event = z.object({
  __typename: z.enum([
    'BlockedByAddedEvent',
    'BlockedByRemovedEvent',
    'ProjectV2ItemStatusChangedEvent',
    'AddedToProjectV2Event',
    'RemovedFromProjectV2Event',
    'ClosedEvent',
  ]),
  id: z.string().min(1),
  createdAt: z.iso.datetime(),
  blockingIssue: z
    .object({
      id: z.string().min(1),
      number: z.number().int().positive(),
      repository: z.object({ nameWithOwner: z.string() }),
    })
    .nullable()
    .optional(),
  project: z
    .object({ id: z.string().min(1) })
    .nullable()
    .optional(),
  status: z.string().nullable().optional(),
});
export type IssueHistoryEvent = z.infer<typeof Event>;
export interface IssueHistory {
  events: IssueHistoryEvent[];
  complete: boolean;
  reason?: string;
}

/** Native timeline evidence only; comments are deliberately excluded. */
export async function readIssueHistory(
  context: DeliveryContext,
  number: number,
  maxPages = 20,
  expectedNodeId?: string,
): Promise<IssueHistory> {
  const events = new Map<string, IssueHistoryEvent>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let issueNodeId = expectedNodeId;
  const gaps = new Set<string>();
  for (let page = 0; page < maxPages; page++) {
    const raw = await context.clients.graphql(
      `query NativeIssueHistory($owner:String!,$repo:String!,$number:Int!,$cursor:String) {
      repository(owner:$owner,name:$repo) { nameWithOwner issue(number:$number) { id number repository { nameWithOwner }
        timelineItems(first:100,after:$cursor,itemTypes:[BLOCKED_BY_ADDED_EVENT,BLOCKED_BY_REMOVED_EVENT,PROJECT_V2_ITEM_STATUS_CHANGED_EVENT,ADDED_TO_PROJECT_V2_EVENT,REMOVED_FROM_PROJECT_V2_EVENT,CLOSED_EVENT]) {
          nodes { __typename ... on BlockedByAddedEvent { id createdAt blockingIssue { id number repository { nameWithOwner } } }
            ... on BlockedByRemovedEvent { id createdAt blockingIssue { id number repository { nameWithOwner } } }
            ... on ProjectV2ItemStatusChangedEvent { id createdAt project { id } status }
            ... on AddedToProjectV2Event { id createdAt project { id } }
            ... on RemovedFromProjectV2Event { id createdAt project { id } }
            ... on ClosedEvent { id createdAt } }
          pageInfo { hasNextPage endCursor }
        }
      } }
    }`,
      { ...context.repo, number, ...(cursor === undefined ? {} : { cursor }) },
    );
    const parsed = z
      .object({
        repository: z.object({
          nameWithOwner: z.string(),
          issue: z.object({
            id: z.string().min(1),
            number: z.number(),
            repository: z.object({ nameWithOwner: z.string() }),
            timelineItems: z.object({
              nodes: z.array(Event).max(100),
              pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
            }),
          }),
        }),
      })
      .parse(raw);
    const repository = `${context.repo.owner}/${context.repo.repo}`.toLowerCase();
    const issue = parsed.repository.issue;
    if (
      issue.number !== number ||
      parsed.repository.nameWithOwner.toLowerCase() !== repository ||
      issue.repository.nameWithOwner.toLowerCase() !== repository
    )
      throw new DeliveryError('Native timeline repository or issue identity disagrees.');
    if (issueNodeId !== undefined && issue.id !== issueNodeId)
      throw new DeliveryError('Native timeline issue node identity changed.');
    issueNodeId = issue.id;
    for (const event of issue.timelineItems.nodes) {
      if (event.__typename === 'BlockedByRemovedEvent' && !event.blockingIssue)
        gaps.add('Removal event has unavailable blocker identity');
      if (
        ['ProjectV2ItemStatusChangedEvent', 'AddedToProjectV2Event', 'RemovedFromProjectV2Event'].includes(
          event.__typename,
        ) &&
        !event.project
      )
        gaps.add('Project transition has unavailable Project identity');
      if (event.__typename === 'ProjectV2ItemStatusChangedEvent' && event.status == null)
        gaps.add('Project transition has unavailable status');
      const previous = events.get(event.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(event))
        throw new DeliveryError('Conflicting native timeline event identities.');
      events.set(event.id, event);
    }
    const info = issue.timelineItems.pageInfo;
    if (!info.hasNextPage)
      return {
        events: [...events.values()],
        complete: gaps.size === 0,
        ...(gaps.size ? { reason: [...gaps].join('; ') } : {}),
      };
    if (!info.endCursor || cursors.has(info.endCursor))
      return { events: [...events.values()], complete: false, reason: 'Repeated or missing timeline cursor' };
    cursors.add(info.endCursor);
    cursor = info.endCursor;
  }
  return { events: [...events.values()], complete: false, reason: 'Timeline page limit reached' };
}

/** Status must be anchored in a proven configured-Project membership episode. */
export function historicalActivityEvidence(
  history: IssueHistory,
  event: IssueHistoryEvent,
  projectId: string,
  activeStatus: string,
  knownStatuses: readonly string[] = [activeStatus],
): { activity: 'active' | 'inactive' | 'unknown'; reason?: string } {
  if (!history.complete) return { activity: 'unknown', reason: history.reason ?? 'Incomplete native timeline' };
  const at = Date.parse(event.createdAt);
  const transitions = history.events.filter(
    (value) =>
      value.project?.id === projectId &&
      ['AddedToProjectV2Event', 'RemovedFromProjectV2Event', 'ProjectV2ItemStatusChangedEvent'].includes(
        value.__typename,
      ),
  );
  if (transitions.some((value) => Date.parse(value.createdAt) === at))
    return { activity: 'unknown', reason: 'Project transition shares the blocker event timestamp' };
  const preceding = transitions
    .filter((value) => Date.parse(value.createdAt) < at)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  let member = false;
  let status: string | undefined;
  for (let index = 0; index < preceding.length; index++) {
    const value = preceding[index]!;
    if (preceding[index + 1] && Date.parse(preceding[index + 1]!.createdAt) === Date.parse(value.createdAt))
      return { activity: 'unknown', reason: 'Equal-time Project transitions cannot be ordered' };
    if (value.__typename === 'AddedToProjectV2Event') {
      member = true;
      status = undefined;
    } else if (value.__typename === 'RemovedFromProjectV2Event') {
      member = false;
      status = undefined;
    } else if (member) status = value.status ?? undefined;
  }
  if (!member || status === undefined)
    return {
      activity: 'unknown',
      reason: !member
        ? 'No proven configured-Project membership at event time'
        : 'No status anchor in the membership episode',
    };
  if (!knownStatuses.includes(status))
    return { activity: 'unknown', reason: 'Historical status name is outside the configured status catalog' };
  return { activity: status === activeStatus ? 'active' : 'inactive' };
}

export function historicalActivity(
  history: IssueHistory,
  event: IssueHistoryEvent,
  projectId: string,
  activeStatus: string,
  knownStatuses: readonly string[] = [activeStatus],
): 'active' | 'inactive' | 'unknown' {
  return historicalActivityEvidence(history, event, projectId, activeStatus, knownStatuses).activity;
}
