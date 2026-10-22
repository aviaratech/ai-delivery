// Public GitHub response projections; see recordedGitHubFlows.md for hashes,
// redaction, missing-field semantics and explicitly synthetic transitions.

export const recordedZeroApproval = {
  repository: {
    pullRequest: {
      headRefOid: '4b54bd4b663a32957e4571e2af112f828fbc0a58',
      baseRefOid: '8c80ecd100bf5973cd5313dd45558035b95c34b8',
      state: 'OPEN',
      isDraft: true,
      reviewDecision: null,
      baseRef: {
        branchProtectionRule: {
          pattern: 'main',
          requiredApprovingReviewCount: 0,
          dismissesStaleReviews: false,
          isAdminEnforced: true,
          requiresApprovingReviews: true,
        },
      },
    },
  },
} as const;

export const recordedBaseDrift = {
  before: {
    repository: {
      defaultBranchRef: {
        target: {
          oid: '3759b8e124a0c0979d5341fe6f0a202f08bc57e4',
        },
      },
      pullRequest: {
        state: 'OPEN',
        isDraft: false,
        headRefOid: '47cb7643c494c44bdecdfe8ca7449c7b3b884aaa',
        baseRefOid: '3759b8e124a0c0979d5341fe6f0a202f08bc57e4',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        reviewDecision: 'APPROVED',
        mergedAt: null,
        autoMergeRequest: null,
      },
    },
  },
  after: {
    repository: {
      defaultBranchRef: {
        target: {
          oid: 'd26873a8c214221d9e2bca23ebe6c15259a963f6',
          tree: {
            oid: 'ef1b9ca51232408b16d51f3d972fe104b76f959a',
          },
        },
      },
      pullRequest: {
        state: 'OPEN',
        headRefOid: '47cb7643c494c44bdecdfe8ca7449c7b3b884aaa',
        baseRefOid: '3759b8e124a0c0979d5341fe6f0a202f08bc57e4',
        mergeable: 'UNKNOWN',
        mergeStateStatus: 'UNKNOWN',
        reviewDecision: 'APPROVED',
        mergedAt: null,
      },
    },
  },
} as const;

export const recordedReassociation = {
  historicalReview: {
    id: 5607142466,
    state: 'APPROVED',
    commit_id: 'aec1b0caa0d6acb44c025cdb4247d43b401e2166',
    html_url: 'https://github.com/aviaratech/ai-delivery/pull/154#pullrequestreview-5607142466',
  },
  historicalArtifact: {
    artifactId: 'sha256:fe0043ab6a61118b8812ee56963aeda60a423ac3ed0789906bd04196991545e4',
    head: {
      sha: '6534bdad0e431f966b541092df5c0881f3bbd3f9',
      tree: 'ef6ac1241cbf7c91635f07cd6154fa3107fe5374',
    },
  },
  currentReview: {
    id: 5607508810,
    state: 'APPROVED',
    commit_id: 'aec1b0caa0d6acb44c025cdb4247d43b401e2166',
    html_url: 'https://github.com/aviaratech/ai-delivery/pull/154#pullrequestreview-5607508810',
  },
  currentArtifact: {
    artifactId: 'sha256:bc7212015b774e127f801118519cdb44e515c67e220b6f1d2064b1ca4581de6e',
    head: {
      sha: 'aec1b0caa0d6acb44c025cdb4247d43b401e2166',
      tree: '2cd3b7f0fcfdf853e4f04ece00367c24df786570',
    },
  },
} as const;
