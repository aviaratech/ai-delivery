/** Replays the issue-scoped Project items lookup from board-style item rows. */
export function issueProjectItemsResponse(
  variables: Record<string, unknown> | undefined,
  items: readonly Record<string, unknown>[],
  project: { id: string; number: number } = { id: 'PROJECT', number: 1 },
) {
  return {
    node: {
      id: variables?.issueNodeId,
      projectItems: {
        nodes: items.map((item) => ({ project, ...item })),
        pageInfo: { hasNextPage: false },
      },
    },
  };
}
