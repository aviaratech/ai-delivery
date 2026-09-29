import { join } from 'node:path';
import { z } from 'zod';

import type { DeliveryConfig } from './config/deliveryConfig.js';
import { assertPrivateFile } from './delivery/common.js';
import {
  digestValue,
  RepositoryApprovalBindingSchema,
  type RepositoryApprovalBinding,
  type RepositoryClassificationReceipt,
} from './delivery/index.js';
import { DeliveryError } from './errors.js';
import { gitCommonDir } from './git.js';
import type { DeliveryContext } from './issue.js';
import { writePrivateJsonFileAtomically } from './utils/atomicJson.js';

const Sha = z.string().regex(/^[a-f0-9]{40}$/u);
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const ReviewArtifactSchema = z
  .object({
    artifactId: Digest,
    authorIdentity: z.string().min(1),
    checks: z.array(z.string().min(1)).min(1),
    diffScopeHash: Digest,
    deliveryMetrics: z
      .object({ blockerTimeMs: z.number().int().nonnegative().nullable(), reviewRound: z.number().int().positive() })
      .strict()
      .optional(),
    elapsedMs: z.number().int().nonnegative(),
    findings: z.array(z.string()),
    head: z.object({ sha: Sha, tree: Sha }).strict(),
    issueNumber: z.number().int().positive(),
    prNumber: z.number().int().positive().nullable(),
    readOnly: z.literal(true),
    requestedEffort: z.string().min(1),
    requestedModel: z.string().min(1),
    effectiveEffort: z.string().min(1),
    effectiveModel: z.string().min(1),
    reviewerIdentity: z.string().min(1),
    schemaVersion: z.literal('ai-delivery.review-artifact@1'),
    summary: z.string().min(1),
    verdict: z.enum(['approve', 'request-changes']),
  })
  .strict()
  .superRefine((artifact, ctx) => {
    const { artifactId, ...content } = artifact;
    if (artifactId !== digestValue(content) || artifact.authorIdentity === artifact.reviewerIdentity) {
      ctx.addIssue({ code: 'custom', message: 'Review artifact identity or role separation is invalid.' });
    }
  });
export type ReviewArtifact = z.infer<typeof ReviewArtifactSchema>;

export const SubmittedReviewReceiptSchema = z
  .object({
    artifact: ReviewArtifactSchema,
    completedAt: z.iso.datetime(),
    githubReviewId: z.number().int().positive(),
    githubReviewUrl: z.url(),
    headSha: Sha,
    login: z.string().min(1),
    prNumber: z.number().int().positive(),
    publicationEvidenceId: Digest,
    receiptId: Digest,
    schemaVersion: z.literal('ai-delivery.review-receipt@1'),
    state: z.literal('APPROVED'),
  })
  .strict()
  .superRefine((receipt, ctx) => {
    const { receiptId, ...content } = receipt;
    if (
      receiptId !== digestValue(content) ||
      receipt.headSha !== receipt.artifact.head.sha ||
      (receipt.artifact.prNumber !== null && receipt.artifact.prNumber !== receipt.prNumber)
    ) {
      ctx.addIssue({ code: 'custom', message: 'Submitted review receipt is not bound to its artifact.' });
    }
  });
export type SubmittedReviewReceipt = z.infer<typeof SubmittedReviewReceiptSchema>;

export interface RequiredReviewState {
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  submittedReviewAuthorCanPushToRepository: boolean | null;
  status: 'satisfied' | 'changes-requested' | 'still-required' | 'unknown';
  nextAction: string;
}

/** GitHub's PR decision is the live requirement state, not the state of one submitted review. */
export async function readRequiredReviewState(
  context: DeliveryContext,
  prNumber: number,
  expectedHead: string,
  submittedReview?: { id: number; login: string },
): Promise<RequiredReviewState> {
  let response: {
    repository: {
      pullRequest: { headRefOid: string; reviewDecision: RequiredReviewState['reviewDecision'] } | null;
    } | null;
  };
  try {
    response = await context.clients.graphql<typeof response>(
      'query DeliveryReviewDecision($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { headRefOid reviewDecision } } }',
      { owner: context.repo.owner, name: context.repo.repo, number: prNumber },
    );
  } catch {
    return {
      reviewDecision: null,
      submittedReviewAuthorCanPushToRepository: null,
      status: 'unknown',
      nextAction: 'Inspect the PR review requirement in GitHub before merge; review decision readback is unavailable.',
    };
  }
  const pr = response.repository?.pullRequest;
  if (!pr) {
    return {
      reviewDecision: null,
      submittedReviewAuthorCanPushToRepository: null,
      status: 'unknown',
      nextAction: 'Inspect the PR review requirement in GitHub before merge; PR decision readback is unavailable.',
    };
  }
  if (pr.headRefOid !== expectedHead) {
    throw new DeliveryError('GitHub review decision does not match the exact PR head.');
  }
  let submittedReviewAuthorCanPushToRepository: boolean | null = null;
  if (submittedReview) {
    try {
      const access = await context.clients.graphql<{
        repository: {
          pullRequest: {
            reviews: {
              nodes: Array<{
                author: { login: string } | null;
                authorCanPushToRepository: boolean;
                commit: { oid: string } | null;
                fullDatabaseId: string | number | null;
                state: string;
              } | null>;
            };
          } | null;
        } | null;
      }>(
        'query DeliveryReviewAccess($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviews(last: 100) { nodes { fullDatabaseId author { login } authorCanPushToRepository commit { oid } state } } } } }',
        { owner: context.repo.owner, name: context.repo.repo, number: prNumber },
      );
      // REST review receipts include [bot], while GraphQL may omit it for the same App actor.
      const submittedActor = submittedReview.login.toLowerCase().replace(/\[bot\]$/u, '');
      const exact = access.repository?.pullRequest?.reviews.nodes.find(
        (review) =>
          review !== null &&
          String(review.fullDatabaseId) === String(submittedReview.id) &&
          review.author?.login.toLowerCase().replace(/\[bot\]$/u, '') === submittedActor &&
          review.commit?.oid === expectedHead &&
          review.state === 'APPROVED',
      );
      if (typeof exact?.authorCanPushToRepository === 'boolean') {
        submittedReviewAuthorCanPushToRepository = exact.authorCanPushToRepository;
      }
    } catch {
      // A review access read failure does not erase the live PR decision.
    }
  }
  if (pr.reviewDecision === 'APPROVED') {
    return {
      reviewDecision: 'APPROVED',
      submittedReviewAuthorCanPushToRepository,
      status: 'satisfied',
      nextAction: 'Continue only after required checks pass.',
    };
  }
  if (pr.reviewDecision === 'REVIEW_REQUIRED') {
    return {
      reviewDecision: 'REVIEW_REQUIRED',
      submittedReviewAuthorCanPushToRepository,
      status: 'still-required',
      nextAction:
        submittedReviewAuthorCanPushToRepository === false
          ? 'GitHub still requires a qualifying approval; the submitted reviewer App review has no repository write access. Inspect the active rule and the App installation Contents grant, then obtain approval from an eligible independent reviewer.'
          : 'GitHub still requires a qualifying approval. Inspect the active rule and obtain approval from an eligible independent reviewer; do not change actors or protections automatically.',
    };
  }
  if (pr.reviewDecision === 'CHANGES_REQUESTED') {
    return {
      reviewDecision: 'CHANGES_REQUESTED',
      submittedReviewAuthorCanPushToRepository,
      status: 'changes-requested',
      nextAction: 'Resolve the blocking review and obtain a fresh exact-head independent approval.',
    };
  }
  return {
    reviewDecision: null,
    submittedReviewAuthorCanPushToRepository,
    status: 'unknown',
    nextAction: 'Inspect the PR review requirement in GitHub before merge; no required-review decision was exposed.',
  };
}

export function parseReviewArtifact(raw: unknown): ReviewArtifact {
  const value = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  return ReviewArtifactSchema.parse(value);
}

export function reviewArtifactApproval(input: {
  artifact: ReviewArtifact;
  classification: RepositoryClassificationReceipt;
  config: DeliveryConfig;
  issueNumber: number;
  prNumber?: number;
}): RepositoryApprovalBinding {
  const { artifact, classification, config } = input;
  ReviewArtifactSchema.parse(artifact);
  if (
    artifact.verdict !== 'approve' ||
    artifact.issueNumber !== input.issueNumber ||
    artifact.authorIdentity !== config.roles.author.identity ||
    artifact.reviewerIdentity !== config.roles.reviewer.identity ||
    artifact.head.sha !== classification.head.sha ||
    artifact.head.tree !== classification.head.tree ||
    artifact.diffScopeHash !== digestValue(classification.changedPaths) ||
    (input.prNumber !== undefined && artifact.prNumber !== null && artifact.prNumber !== input.prNumber)
  ) {
    throw new DeliveryError('Independent review artifact is stale, foreign, rejected, or covers another scope.');
  }
  return RepositoryApprovalBindingSchema.parse({
    authorIdentity: artifact.authorIdentity,
    diffScopeHash: artifact.diffScopeHash,
    head: artifact.head,
    result: 'approved',
    reviewerIdentity: artifact.reviewerIdentity,
    reviewReceiptId: artifact.artifactId,
  });
}

function receiptPath(repoRoot: string, issueNumber: number, headSha: string): string {
  return join(gitCommonDir(repoRoot), 'ai-delivery', 'reviews', String(issueNumber), `${headSha}.json`);
}

function prepublicationPath(repoRoot: string, issueNumber: number, headSha: string): string {
  return join(gitCommonDir(repoRoot), 'ai-delivery', 'reviews', String(issueNumber), `${headSha}.prepublication.json`);
}

export function savePrepublicationArtifact(input: {
  artifact: ReviewArtifact;
  classification: RepositoryClassificationReceipt;
  config: DeliveryConfig;
  issueNumber: number;
  repoRoot: string;
}): void {
  if (input.artifact.prNumber !== null) throw new DeliveryError('Prepublication review must have a null PR number.');
  reviewArtifactApproval(input);
  writePrivateJsonFileAtomically(
    prepublicationPath(input.repoRoot, input.issueNumber, input.artifact.head.sha),
    input.artifact,
  );
}

export function loadPrepublicationArtifact(
  repoRoot: string,
  issueNumber: number,
  headSha: string,
): ReviewArtifact | null {
  let raw: unknown;
  try {
    raw = JSON.parse(assertPrivateFile(prepublicationPath(repoRoot, issueNumber, headSha)).toString('utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new DeliveryError('Stored prepublication review is unreadable.');
  }
  return ReviewArtifactSchema.parse(raw);
}

async function listAllReviews(context: DeliveryContext, prNumber: number) {
  const reviews: Awaited<ReturnType<typeof context.clients.rest.pulls.listReviews>>['data'] = [];
  for (let page = 1; page <= 20; page += 1) {
    const result = await context.clients.rest.pulls.listReviews({
      ...context.repo,
      pull_number: prNumber,
      per_page: 100,
      page,
    });
    reviews.push(...result.data);
    if (result.data.length < 100) return reviews;
  }
  throw new DeliveryError('Review history exceeds the bounded readback window.');
}

export async function submitReview(input: {
  artifact: ReviewArtifact;
  context: DeliveryContext;
  issueNumber: number;
  prNumber: number;
  publicationEvidenceId: string;
  classification: RepositoryClassificationReceipt;
}): Promise<SubmittedReviewReceipt> {
  const { artifact, context, issueNumber, prNumber } = input;
  reviewArtifactApproval({
    artifact,
    classification: input.classification,
    config: context.config,
    issueNumber,
    prNumber,
  });
  if (context.clients.authSource !== 'app' || context.clients.role !== 'reviewer' || !context.clients.appActorLogin) {
    throw new DeliveryError('Formal review requires the reviewer GitHub App role.');
  }
  const pr = (await context.clients.rest.pulls.get({ ...context.repo, pull_number: prNumber })).data;
  if (pr.head.sha !== artifact.head.sha || pr.state !== 'open')
    throw new DeliveryError('PR head changed before formal review.');
  const actor = await context.clients.appActorLogin();
  if (!actor || !pr.user?.login || actor.toLowerCase() === pr.user.login.toLowerCase()) {
    throw new DeliveryError('Reviewer GitHub actor must differ from PR author.');
  }
  const existing = loadSubmittedReview(context.root, issueNumber, artifact.head.sha);
  if (existing) {
    if (
      existing.artifact.artifactId !== artifact.artifactId ||
      existing.prNumber !== prNumber ||
      existing.publicationEvidenceId !== input.publicationEvidenceId ||
      existing.login.toLowerCase() !== actor.toLowerCase()
    ) {
      throw new DeliveryError('An exact-head review receipt already binds different review evidence.');
    }
    await assertSubmittedReviewCurrent(context, existing);
    return existing;
  }
  const marker = `<!-- ai-delivery-review-artifact: ${artifact.artifactId} -->`;
  const matches = (await listAllReviews(context, prNumber)).filter((review) => review.body?.includes(marker));
  if (matches.length > 1) throw new DeliveryError('Multiple GitHub reviews claim the same artifact identity.');
  const prior = matches[0];
  if (
    prior &&
    (prior.state !== 'APPROVED' ||
      prior.commit_id !== artifact.head.sha ||
      prior.user?.login?.toLowerCase() !== actor.toLowerCase() ||
      !prior.html_url)
  ) {
    throw new DeliveryError('Prior GitHub review marker does not match exact approval.');
  }
  const submitted =
    prior ??
    (
      await context.clients.rest.pulls.createReview({
        ...context.repo,
        pull_number: prNumber,
        commit_id: artifact.head.sha,
        body: `${artifact.summary}\n\n${marker}`,
        event: 'APPROVE',
      })
    ).data;
  if (
    !submitted.id ||
    submitted.state !== 'APPROVED' ||
    submitted.commit_id !== artifact.head.sha ||
    submitted.user?.login?.toLowerCase() !== actor.toLowerCase() ||
    !submitted.html_url
  ) {
    throw new DeliveryError('GitHub did not return complete exact-head approval readback.');
  }
  const content = {
    artifact,
    completedAt: new Date().toISOString(),
    githubReviewId: submitted.id,
    githubReviewUrl: submitted.html_url,
    headSha: artifact.head.sha,
    login: submitted.user.login,
    prNumber,
    publicationEvidenceId: input.publicationEvidenceId,
    schemaVersion: 'ai-delivery.review-receipt@1' as const,
    state: 'APPROVED' as const,
  };
  const receipt = SubmittedReviewReceiptSchema.parse({ ...content, receiptId: digestValue(content) });
  await assertSubmittedReviewCurrent(context, receipt);
  writePrivateJsonFileAtomically(receiptPath(context.root, issueNumber, artifact.head.sha), receipt);
  return receipt;
}

export function loadSubmittedReview(
  repoRoot: string,
  issueNumber: number,
  headSha: string,
): SubmittedReviewReceipt | null {
  let raw: unknown;
  try {
    raw = JSON.parse(assertPrivateFile(receiptPath(repoRoot, issueNumber, headSha)).toString('utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new DeliveryError('Stored review receipt is unreadable.');
  }
  return SubmittedReviewReceiptSchema.parse(raw);
}

export async function assertSubmittedReviewCurrent(
  context: DeliveryContext,
  receipt: SubmittedReviewReceipt,
): Promise<void> {
  SubmittedReviewReceiptSchema.parse(receipt);
  const review = (await listAllReviews(context, receipt.prNumber)).find(
    (candidate) => candidate.id === receipt.githubReviewId,
  );
  if (
    !review ||
    review.state !== 'APPROVED' ||
    review.commit_id !== receipt.headSha ||
    review.user?.login !== receipt.login ||
    review.html_url !== receipt.githubReviewUrl ||
    !review.body?.includes(`<!-- ai-delivery-review-artifact: ${receipt.artifact.artifactId} -->`)
  ) {
    throw new DeliveryError('GitHub exact-head review no longer matches the stored receipt.');
  }
}
