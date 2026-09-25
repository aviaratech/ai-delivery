import type { graphql as GraphQLType } from '@octokit/graphql';
import type { Octokit } from '@octokit/rest';
import * as z from 'zod/v4';

import type { RepoCoordinates } from './repo.js';

import { CLIError, formatError, logInfo } from '../logger.js';

export interface NativeBlockerRelationship {
  id: string;
  number: number;
  state: 'CLOSED' | 'OPEN';
  title: string;
}

export interface NativeBlockerRelationshipReadback {
  blockers: NativeBlockerRelationship[];
  parentId: null | string;
  parentNumber: null | number;
}

export interface NativeRelationshipTargets {
  blockerNodeIds: ReadonlyMap<number, string>;
  unresolvedBlockers: number[];
}

interface IssueNodeParams {
  issueNumber: number;
  repo: RepoCoordinates;
  rest: Octokit;
}

interface LinkBlockedByParams extends RelationshipContext {
  blockerNodeIds?: ReadonlyMap<number, string>;
  blockers: number[];
  existingBlockers?: readonly number[];
  issueNumber: number;
}

interface LinkSubIssueParams {
  parentIssueNumber: number;
  repo: RepoCoordinates;
  rest: Octokit;
  subIssueId?: number;
  subIssueNumber: number;
}

interface RelationshipContext {
  graphql: typeof GraphQLType;
  repo: RepoCoordinates;
  rest: Octokit;
}

const NativeBlockerPageSchema = z
  .object({
    repository: z
      .object({
        issue: z
          .object({
            blockedBy: z
              .object({
                nodes: z.array(
                  z
                    .object({
                      id: z.string(),
                      number: z.number().int().positive(),
                      state: z.enum(['OPEN', 'CLOSED']),
                      title: z.string(),
                    })
                    .strict(),
                ),
                pageInfo: z
                  .object({
                    endCursor: z.string().nullable(),
                    hasNextPage: z.boolean(),
                  })
                  .strict(),
              })
              .strict(),
            parent: z.object({ id: z.string(), number: z.number().int().positive().optional() }).strict().nullable(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

const NativeBlockingPageSchema = z
  .object({
    repository: z
      .object({
        issue: z
          .object({
            blocking: z
              .object({
                nodes: z.array(
                  z
                    .object({
                      id: z.string(),
                      number: z.number().int().positive(),
                      state: z.enum(['OPEN', 'CLOSED']),
                      title: z.string(),
                    })
                    .strict(),
                ),
                pageInfo: z.object({ endCursor: z.string().nullable(), hasNextPage: z.boolean() }).strict(),
              })
              .strict(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export async function getNativeBlockerNumbers(
  params: Omit<RelationshipContext, 'rest'> & { issueNumber: number },
): Promise<number[]> {
  return (await getNativeBlockerRelationships(params)).blockers.map((blocker) => blocker.number);
}

export async function getNativeBlockerRelationships({
  graphql,
  issueNumber,
  repo,
}: Omit<RelationshipContext, 'rest'> & { issueNumber: number }): Promise<NativeBlockerRelationshipReadback> {
  const blockers = new Map<number, NativeBlockerRelationship>();
  let cursor: null | string = null;
  let hasNextPage = true;
  let parentId: null | string = null;
  let parentNumber: null | number = null;
  const seenCursors = new Set<string>();
  while (hasNextPage) {
    const response: unknown = await graphql(
      `
        query ($owner: String!, $name: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $name) {
            issue(number: $number) {
              parent {
                id
                number
              }
              blockedBy(first: 100, after: $cursor) {
                nodes {
                  id
                  number
                  title
                  state
                }
                pageInfo {
                  endCursor
                  hasNextPage
                }
              }
            }
          }
        }
      `,
      { cursor, name: repo.repo, number: issueNumber, owner: repo.owner },
    );
    const parsed = NativeBlockerPageSchema.safeParse(response);
    if (!parsed.success) {
      throw new CLIError(`GitHub returned invalid blocked-by relationship evidence for issue #${String(issueNumber)}.`);
    }
    const issue = parsed.data.repository.issue;
    for (const blocker of issue.blockedBy.nodes) {
      blockers.set(blocker.number, blocker);
    }
    parentId = issue.parent?.id ?? null;
    parentNumber = issue.parent?.number ?? null;
    hasNextPage = issue.blockedBy.pageInfo.hasNextPage;
    const nextCursor = issue.blockedBy.pageInfo.endCursor;
    if (hasNextPage && nextCursor === null) {
      throw new CLIError(`Native blocked-by pagination for issue #${String(issueNumber)} omitted its next cursor.`);
    }
    if (hasNextPage && nextCursor !== null && (nextCursor === cursor || seenCursors.has(nextCursor))) {
      throw new CLIError(
        `Native blocked-by pagination for issue #${String(issueNumber)} repeated a non-advancing cursor.`,
      );
    }
    if (nextCursor !== null) seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return {
    blockers: [...blockers.values()].sort((left, right) => left.number - right.number),
    parentId,
    parentNumber,
  };
}

/** Return the issues that declare this issue as a native blocker. */
export async function getNativeBlockingRelationships({
  graphql,
  issueNumber,
  repo,
}: Omit<RelationshipContext, 'rest'> & { issueNumber: number }): Promise<NativeBlockerRelationship[]> {
  const dependents = new Map<number, NativeBlockerRelationship>();
  let cursor: null | string = null;
  let hasNextPage = true;
  const seenCursors = new Set<string>();
  while (hasNextPage) {
    const response: unknown = await graphql(
      `
        query ($owner: String!, $name: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $name) {
            issue(number: $number) {
              blocking(first: 100, after: $cursor) {
                nodes {
                  id
                  number
                  title
                  state
                }
                pageInfo {
                  endCursor
                  hasNextPage
                }
              }
            }
          }
        }
      `,
      { cursor, name: repo.repo, number: issueNumber, owner: repo.owner },
    );
    const parsed = NativeBlockingPageSchema.safeParse(response);
    if (!parsed.success) {
      throw new CLIError(`GitHub returned invalid blocking relationship evidence for issue #${String(issueNumber)}.`);
    }
    const page = parsed.data.repository.issue.blocking;
    for (const dependent of page.nodes) dependents.set(dependent.number, dependent);
    hasNextPage = page.pageInfo.hasNextPage;
    const nextCursor = page.pageInfo.endCursor;
    if (hasNextPage && nextCursor === null) {
      throw new CLIError(`Native blocking pagination for issue #${String(issueNumber)} omitted its next cursor.`);
    }
    if (hasNextPage && nextCursor !== null && (nextCursor === cursor || seenCursors.has(nextCursor))) {
      throw new CLIError(
        `Native blocking pagination for issue #${String(issueNumber)} repeated a non-advancing cursor.`,
      );
    }
    if (nextCursor !== null) seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return [...dependents.values()].sort((left, right) => left.number - right.number);
}

/** Native sub-issues make an issue a planning container rather than an executable delivery. */
export async function hasNativeSubIssues({
  issueNumber,
  repo,
  rest,
}: {
  issueNumber: number;
  repo: RepoCoordinates;
  rest: Octokit;
}): Promise<boolean> {
  const response = await rest.issues.listSubIssues({
    issue_number: issueNumber,
    owner: repo.owner,
    per_page: 1,
    repo: repo.repo,
  });
  return response.data.length > 0;
}

export async function linkBlockedBy({
  blockerNodeIds,
  blockers,
  existingBlockers = [],
  graphql,
  issueNumber,
  repo,
  rest,
}: LinkBlockedByParams): Promise<void> {
  if (blockers.length === 0) {
    return;
  }
  const requestedBlockers = [...new Set(blockers)];
  const existing = new Set([...existingBlockers, ...(await getNativeBlockerNumbers({ graphql, issueNumber, repo }))]);
  const blockersToAdd = requestedBlockers.filter((blocker) => !existing.has(blocker));
  if (blockersToAdd.length > 0) {
    const issueNodeId = await issueNumberToNode({ issueNumber, repo, rest });
    for (const blocker of blockersToAdd) {
      const blockerNodeId =
        blockerNodeIds?.get(blocker) ?? (await issueNumberToNode({ issueNumber: blocker, repo, rest }));

      await graphql(
        `
          mutation ($issue: ID!, $blocking: ID!) {
            addBlockedBy(input: { issueId: $issue, blockingIssueId: $blocking }) {
              issue {
                number
              }
            }
          }
        `,
        {
          blocking: blockerNodeId,
          issue: issueNodeId,
        },
      );

      logInfo(`Linked issue #${String(issueNumber)} as blocked by issue #${String(blocker)}.`);
    }
  }

  const observed = new Set(await getNativeBlockerNumbers({ graphql, issueNumber, repo }));
  const missing = requestedBlockers.filter((blocker) => !observed.has(blocker));
  if (missing.length > 0) {
    throw new CLIError(
      `Native blocked-by readback for issue #${String(issueNumber)} omitted requested blocker(s): ${missing
        .map((blocker) => `#${String(blocker)}`)
        .join(', ')}.`,
    );
  }
}

export async function linkSubIssue({
  parentIssueNumber,
  repo,
  rest,
  subIssueId,
  subIssueNumber,
}: LinkSubIssueParams): Promise<void> {
  if (parentIssueNumber === subIssueNumber) {
    throw new CLIError(`Issue #${String(subIssueNumber)} cannot be its own parent.`);
  }

  const resolvedSubIssueId =
    typeof subIssueId === 'number' && Number.isFinite(subIssueId)
      ? subIssueId
      : await issueNumberToId({ issueNumber: subIssueNumber, repo, rest });

  if (await parentContainsSubIssue({ parentIssueNumber, repo, rest, subIssueNumber })) {
    logInfo(`Issue #${String(subIssueNumber)} is already a sub-issue of issue #${String(parentIssueNumber)}.`);
    return;
  }

  await rest.issues.addSubIssue({
    issue_number: parentIssueNumber,
    owner: repo.owner,
    repo: repo.repo,
    sub_issue_id: resolvedSubIssueId,
  });

  if (!(await parentContainsSubIssue({ parentIssueNumber, repo, rest, subIssueNumber }))) {
    throw new CLIError(
      `Native sub-issue readback for parent #${String(parentIssueNumber)} omitted requested issue #${String(subIssueNumber)}.`,
    );
  }

  logInfo(`Linked issue #${String(subIssueNumber)} as sub-issue of issue #${String(parentIssueNumber)}.`);
}

/** Replace, rather than append to, the native blocked-by edge set. */
export async function replaceBlockedBy({
  blockers,
  graphql,
  issueNumber,
  repo,
  rest,
}: LinkBlockedByParams): Promise<void> {
  const requested = [...new Set(blockers)].sort((left, right) => left - right);
  const before = await getNativeBlockerRelationships({ graphql, issueNumber, repo });
  const requestedSet = new Set(requested);
  const issueNodeId = await issueNumberToNode({ issueNumber, repo, rest });
  for (const blocker of before.blockers.filter((candidate) => !requestedSet.has(candidate.number))) {
    await graphql(
      `
        mutation ($issue: ID!, $blocking: ID!) {
          removeBlockedBy(input: { issueId: $issue, blockingIssueId: $blocking }) {
            issue {
              number
            }
          }
        }
      `,
      { blocking: blocker.id, issue: issueNodeId },
    );
  }
  const existing = new Set(before.blockers.map((blocker) => blocker.number));
  for (const blocker of requested.filter((candidate) => !existing.has(candidate))) {
    const blockerNodeId = await issueNumberToNode({ issueNumber: blocker, repo, rest });
    await graphql(
      `
        mutation ($issue: ID!, $blocking: ID!) {
          addBlockedBy(input: { issueId: $issue, blockingIssueId: $blocking }) {
            issue {
              number
            }
          }
        }
      `,
      { blocking: blockerNodeId, issue: issueNodeId },
    );
  }
  const observed = (await getNativeBlockerNumbers({ graphql, issueNumber, repo })).sort((left, right) => left - right);
  if (observed.join(',') !== requested.join(',')) {
    throw new CLIError(
      `Native blocked-by replacement readback mismatch for issue #${String(issueNumber)}: expected ${requested.join(',') || '(none)'}, found ${observed.join(',') || '(none)'}.`,
    );
  }
}

/** Replace or clear the issue's single native parent relationship. */
export async function replaceParentIssue({
  graphql,
  issueNumber,
  parentIssueNumber,
  repo,
  rest,
}: RelationshipContext & { issueNumber: number; parentIssueNumber: null | number }): Promise<void> {
  if (parentIssueNumber === issueNumber) {
    throw new CLIError(`Issue #${String(issueNumber)} cannot be its own parent.`);
  }
  const before = await getNativeBlockerRelationships({ graphql, issueNumber, repo });
  if (before.parentNumber === parentIssueNumber) return;
  const subIssueId = await issueNumberToId({ issueNumber, repo, rest });
  if (before.parentNumber !== null) {
    await rest.issues.removeSubIssue({
      issue_number: before.parentNumber,
      owner: repo.owner,
      repo: repo.repo,
      sub_issue_id: subIssueId,
    });
  }
  if (parentIssueNumber !== null) {
    await linkSubIssue({ parentIssueNumber, repo, rest, subIssueId, subIssueNumber: issueNumber });
  }
  const after = await getNativeBlockerRelationships({ graphql, issueNumber, repo });
  if (after.parentNumber !== parentIssueNumber) {
    const expectedParent = parentIssueNumber === null ? '(none)' : `#${String(parentIssueNumber)}`;
    const observedParent = after.parentNumber === null ? '(none)' : `#${String(after.parentNumber)}`;
    throw new CLIError(
      `Native parent replacement readback mismatch for issue #${String(issueNumber)}: expected ${expectedParent}, found ${observedParent}.`,
    );
  }
}

/** Resolve every existing relationship target before a new tracking issue is created. */
export async function resolveNativeRelationshipTargets({
  blockers,
  parentIssueNumber,
  repo,
  rest,
}: {
  blockers: readonly number[];
  parentIssueNumber?: number;
  repo: RepoCoordinates;
  rest: Octokit;
}): Promise<NativeRelationshipTargets> {
  const blockerNodeIds = new Map<number, string>();
  const unresolvedBlockers: number[] = [];
  for (const blocker of new Set(blockers)) {
    const target = await resolveBlockerTarget({ issueNumber: blocker, repo, rest });
    blockerNodeIds.set(blocker, target.nodeId);
    if (target.state === 'OPEN') unresolvedBlockers.push(blocker);
  }
  if (parentIssueNumber !== undefined) {
    await requireIssueTarget({ issueNumber: parentIssueNumber, relationship: 'parent', repo, rest });
  }
  return { blockerNodeIds, unresolvedBlockers };
}

async function issueNumberToId({ issueNumber, repo, rest }: IssueNodeParams): Promise<number> {
  try {
    const issue = await rest.issues.get({
      issue_number: issueNumber,
      owner: repo.owner,
      repo: repo.repo,
    });
    const issueId = issue.data.id;
    if (typeof issueId !== 'number') {
      throw new CLIError(`GitHub omitted the numeric issue id for issue #${String(issueNumber)}.`);
    }
    return issueId;
  } catch (error: unknown) {
    if (error instanceof CLIError) {
      throw error;
    }
    throw new CLIError(`Unable to resolve sub-issue id for issue #${String(issueNumber)}: ${formatError(error)}.`);
  }
}

async function issueNumberToNode({ issueNumber, repo, rest }: IssueNodeParams): Promise<string> {
  try {
    const issue = await rest.issues.get({
      issue_number: issueNumber,
      owner: repo.owner,
      repo: repo.repo,
    });
    const nodeId = issue.data.node_id;
    if (typeof nodeId !== 'string') {
      throw new CLIError(`GitHub omitted the node id for issue #${String(issueNumber)}.`);
    }
    return nodeId;
  } catch (error: unknown) {
    if (error instanceof CLIError) {
      throw error;
    }
    throw new CLIError(`Unable to resolve blocker issue #${String(issueNumber)}: ${formatError(error)}.`);
  }
}

async function parentContainsSubIssue({
  parentIssueNumber,
  repo,
  rest,
  subIssueNumber,
}: {
  parentIssueNumber: number;
  repo: RepoCoordinates;
  rest: Octokit;
  subIssueNumber: number;
}): Promise<boolean> {
  const observed = await rest.paginate(rest.issues.listSubIssues, {
    issue_number: parentIssueNumber,
    owner: repo.owner,
    per_page: 100,
    repo: repo.repo,
  });
  return observed.some((issue) => issue.number === subIssueNumber);
}

async function requireIssueTarget({
  issueNumber,
  relationship,
  repo,
  rest,
}: IssueNodeParams & { relationship: string }): Promise<void> {
  try {
    await rest.issues.get({
      issue_number: issueNumber,
      owner: repo.owner,
      repo: repo.repo,
    });
  } catch (error: unknown) {
    throw new CLIError(`Unable to resolve ${relationship} issue #${String(issueNumber)}: ${formatError(error)}.`);
  }
}

async function resolveBlockerTarget({
  issueNumber,
  repo,
  rest,
}: IssueNodeParams): Promise<{ nodeId: string; state: 'CLOSED' | 'OPEN' }> {
  try {
    const issue = await rest.issues.get({
      issue_number: issueNumber,
      owner: repo.owner,
      repo: repo.repo,
    });
    const nodeId = issue.data.node_id;
    const state = issue.data.state;
    if (typeof nodeId !== 'string' || (state !== 'open' && state !== 'closed')) {
      throw new CLIError(`GitHub omitted the node id or state for blocker issue #${String(issueNumber)}.`);
    }
    return { nodeId, state: state === 'open' ? 'OPEN' : 'CLOSED' };
  } catch (error: unknown) {
    if (error instanceof CLIError) {
      throw error;
    }
    throw new CLIError(`Unable to resolve blocker issue #${String(issueNumber)}: ${formatError(error)}.`);
  }
}
