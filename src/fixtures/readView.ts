/**
 * Public GitHub responses for aviaratech/ai-delivery, recorded on 2026-10-31 through the exact queries in
 * readView.ts (`ISSUE_LINKS_QUERY` for issue 233, `PR_SUMMARY_QUERY` for PR 235). The bodies are unmodified;
 * `data` is removed because the GraphQL client already unwraps it. Failing, pending and stale-review cases in
 * readView.test.ts are labeled synthetic edits of these.
 */
export const recordedIssue233Links = {
  repository: {
    issue: {
      id: 'I_kwDOUrrSHM8AAAABauPwDg',
      state: 'CLOSED',
      comments: {
        nodes: [
          {
            author: {
              login: 'PaulSavignano',
            },
            body: 'Work started on Lead typed journal comments with status and next step.\n\n**Kind:** start. **Status:** Started\n\n**Outcome:** Lead typed journal comments with status and next step\n\n**Key numbers:** Issue #233\n\n**Next:** Implement the issue acceptance criteria and run its verification (date not scheduled).\n\n**Evidence:** https://github.com/aviaratech/ai-delivery/issues/233\n\n<!-- ai-delivery:journal@1:sha256:1ed32423d4dbdad95f2fb06cc4c33e958dc98e313aae0ee873d2fbe8a53d1b1e -->',
            createdAt: '2026-10-28T22:10:18Z',
            url: 'https://github.com/aviaratech/ai-delivery/issues/233#issuecomment-6481948952',
          },
        ],
      },
      timelineItems: {
        nodes: [
          {
            source: {
              __typename: 'PullRequest',
              repository: {
                nameWithOwner: 'aviaratech/ai-delivery',
              },
              number: 235,
              url: 'https://github.com/aviaratech/ai-delivery/pull/235',
              state: 'MERGED',
              isDraft: false,
              mergeStateStatus: 'UNKNOWN',
              reviewDecision: 'APPROVED',
              headRefOid: 'bc9bbf9fe154c5e9c13366a94527edccd07b805b',
              latestReviews: {
                nodes: [
                  {
                    author: {
                      login: 'at-gpt-reviewer',
                    },
                    state: 'APPROVED',
                    commit: {
                      oid: 'bc9bbf9fe154c5e9c13366a94527edccd07b805b',
                    },
                  },
                ],
              },
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        state: 'SUCCESS',
                        contexts: {
                          nodes: [
                            {
                              __typename: 'CheckRun',
                              name: 'checks',
                              status: 'COMPLETED',
                              conclusion: 'SUCCESS',
                            },
                            {
                              __typename: 'CheckRun',
                              name: 'secrets',
                              status: 'COMPLETED',
                              conclusion: 'SUCCESS',
                            },
                          ],
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    },
  },
};

export const recordedPr235Summary = {
  repository: {
    pullRequest: {
      number: 235,
      url: 'https://github.com/aviaratech/ai-delivery/pull/235',
      state: 'MERGED',
      isDraft: false,
      mergeStateStatus: 'UNKNOWN',
      reviewDecision: 'APPROVED',
      headRefOid: 'bc9bbf9fe154c5e9c13366a94527edccd07b805b',
      latestReviews: {
        nodes: [
          {
            author: {
              login: 'at-gpt-reviewer',
            },
            state: 'APPROVED',
            commit: {
              oid: 'bc9bbf9fe154c5e9c13366a94527edccd07b805b',
            },
          },
        ],
      },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: 'SUCCESS',
                contexts: {
                  nodes: [
                    {
                      __typename: 'CheckRun',
                      name: 'checks',
                      status: 'COMPLETED',
                      conclusion: 'SUCCESS',
                    },
                    {
                      __typename: 'CheckRun',
                      name: 'secrets',
                      status: 'COMPLETED',
                      conclusion: 'SUCCESS',
                    },
                  ],
                },
              },
            },
          },
        ],
      },
      closingIssuesReferences: {
        nodes: [
          {
            number: 233,
            repository: {
              nameWithOwner: 'aviaratech/ai-delivery',
            },
          },
        ],
      },
    },
  },
};

/** An issue with no comments and no references, for mocks that only need the read to succeed. */
export function quietReadViewResponse(query: string, variables: Record<string, unknown> = {}): unknown {
  if (query.includes('query ReadIssueLinks'))
    return {
      repository: {
        issue: {
          id: `ISSUE${String(variables.number)}`,
          state: 'OPEN',
          comments: { nodes: [] },
          timelineItems: { nodes: [] },
        },
      },
    };
  if (query.includes('query ReadPrSummary'))
    return {
      repository: {
        pullRequest: {
          ...recordedPr235Summary.repository.pullRequest,
          number: variables.number,
          closingIssuesReferences: { nodes: [] },
        },
      },
    };
  return undefined;
}
