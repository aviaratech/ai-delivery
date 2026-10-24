import { join } from 'node:path';
import { z } from 'zod';

import type { DeliveryConfig } from './config/deliveryConfig.js';
import { assertPrivateFile } from './delivery/common.js';
import {
  digestValue,
  RepositoryApprovalBindingSchema,
  type RepositoryApprovalBinding,
  type RepositoryClassificationReceipt,
} from './delivery/legacy.js';
import { DeliveryError } from './errors.js';
import { gitCommonDir } from './git.js';
import type { DeliveryContext } from './issue.js';
import { writePrivateJsonFileAtomically } from './utils/atomicJson.js';

const Sha = z.string().regex(/^[a-f0-9]{40}$/u);
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const Text = z.string().trim().min(1);
const Effort = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
export const ReviewVerdictSchema = z.strictObject({
  schemaVersion: z.literal('ai-delivery.review-verdict@1'),
  verdict: z.enum(['approve', 'request-changes']),
  summary: Text,
  issueNumber: z.number().int().positive(),
  scope: z.strictObject({
    headSha: Sha,
    headTree: Sha,
    changedPaths: z
      .array(
        z
          .string()
          .min(1)
          .refine((path) => !path.includes('\0'), 'Paths cannot contain NUL.'),
      )
      .refine(
        (paths) => paths.every((path, index) => index === 0 || paths[index - 1]! < path),
        'Paths must be complete, sorted and unique.',
      ),
  }),
  verificationReproduced: z.array(Text).min(1),
  requestedModel: Text,
  requestedEffort: Effort,
  effectiveModel: Text,
  effectiveEffort: Effort,
  elapsedMs: z.number().int().nonnegative(),
  findings: z.array(Text),
  readOnly: z.literal(true),
  nonClosing: z.boolean().optional(),
});
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export function parseReviewVerdict(raw: unknown): ReviewVerdict {
  let value: unknown;
  try {
    value = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  } catch {
    throw new DeliveryError('verdict: Invalid JSON.');
  }
  const result = ReviewVerdictSchema.safeParse(value);
  if (!result.success)
    throw new DeliveryError(
      result.error.issues.map((issue) => `${issue.path.join('.') || 'verdict'}: ${issue.message}`).join('; '),
    );
  return result.data;
}

export function buildReviewArtifact(input: {
  verdict: ReviewVerdict;
  verdictFileSha256: string;
  identity: string;
  provider: string;
  expectedHead: string;
  prNumber: number;
  authorIdentity: string;
}): ReviewArtifact {
  const verdict = parseReviewVerdict(input.verdict);
  if (!Digest.safeParse(input.verdictFileSha256).success)
    throw new DeliveryError('verdictFileSha256: Expected the exact verdict-file SHA256.');
  if (input.identity.toLowerCase() === input.authorIdentity.toLowerCase())
    throw new DeliveryError('identity: Reviewer and author must be distinct.');
  assertReviewVerdictTarget(verdict, input.provider, input.expectedHead);
  const content = {
    schemaVersion: 'ai-delivery.review-artifact@1' as const,
    verdictFileSha256: input.verdictFileSha256,
    authorIdentity: input.authorIdentity,
    reviewerIdentity: input.identity,
    head: { sha: verdict.scope.headSha, tree: verdict.scope.headTree },
    issueNumber: verdict.issueNumber,
    prNumber: input.prNumber,
    diffScopeHash: digestValue(verdict.scope.changedPaths),
    checks: verdict.verificationReproduced,
    elapsedMs: verdict.elapsedMs,
    findings: verdict.findings,
    readOnly: verdict.readOnly,
    requestedModel: verdict.requestedModel,
    requestedEffort: verdict.requestedEffort,
    effectiveModel: verdict.effectiveModel,
    effectiveEffort: verdict.effectiveEffort,
    summary: verdict.summary,
    verdict: verdict.verdict,
  };
  const artifact = ReviewArtifactSchema.parse({ ...content, artifactId: digestValue(content) });
  githubReviewBody(artifact);
  return artifact;
}

export function assertReviewVerdictTarget(
  verdict: ReviewVerdict,
  selectedProvider: string,
  expectedHead: string,
): void {
  const provider = (model: string) =>
    /^(?:gpt-|o[134](?:-|$))/u.test(model)
      ? 'openai'
      : model.startsWith('claude-')
        ? 'anthropic'
        : model.startsWith('gemini-')
          ? 'google'
          : /^qwen[\d.-]/iu.test(model)
            ? 'qwen'
            : null;
  if (
    provider(verdict.requestedModel) === null ||
    provider(verdict.requestedModel) !== selectedProvider ||
    provider(verdict.effectiveModel) !== selectedProvider
  )
    throw new DeliveryError(
      'identity: Configured reviewer provider must match both requestedModel and effectiveModel families.',
    );
  if (!Sha.safeParse(expectedHead).success || expectedHead !== verdict.scope.headSha)
    throw new DeliveryError('scope.headSha: Verdict and requested exact head differ.');
}
export const ReviewArtifactSchema = z
  .object({
    artifactId: Digest,
    verdictFileSha256: Digest.optional(),
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
  observed?: boolean;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  submittedReviewAuthorCanPushToRepository: boolean | null;
  status: 'satisfied' | 'changes-requested' | 'still-required' | 'unknown';
  nextAction: string;
}

/** GitHub's PR decision is the live requirement state, not the state of one submitted review. */
export async function readRequiredReviewState(
  context: Pick<DeliveryContext, 'clients' | 'repo'>,
  prNumber: number,
  expectedHead: string,
  submittedReview?: { id: number; login: string; state?: 'APPROVED' | 'CHANGES_REQUESTED' },
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
      observed: false,
      reviewDecision: null,
      submittedReviewAuthorCanPushToRepository: null,
      status: 'unknown',
      nextAction: 'Inspect the PR review requirement in GitHub before merge; review decision readback is unavailable.',
    };
  }
  const pr = response.repository?.pullRequest;
  if (!pr) {
    return {
      observed: false,
      reviewDecision: null,
      submittedReviewAuthorCanPushToRepository: null,
      status: 'unknown',
      nextAction: 'Inspect the PR review requirement in GitHub before merge; PR decision readback is unavailable.',
    };
  }
  if (pr.headRefOid !== expectedHead) {
    throw new DeliveryError('GitHub review decision does not match the exact PR head.');
  }
  if (
    pr.reviewDecision !== null &&
    pr.reviewDecision !== 'APPROVED' &&
    pr.reviewDecision !== 'REVIEW_REQUIRED' &&
    pr.reviewDecision !== 'CHANGES_REQUESTED'
  ) {
    return {
      observed: false,
      reviewDecision: null,
      submittedReviewAuthorCanPushToRepository: null,
      status: 'unknown',
      nextAction: 'Inspect the PR review requirement in GitHub before merge; review decision readback is malformed.',
    };
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
          review.state === (submittedReview.state ?? 'APPROVED'),
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
      observed: true,
      reviewDecision: 'APPROVED',
      submittedReviewAuthorCanPushToRepository,
      status: 'satisfied',
      nextAction: 'Continue only after required checks pass.',
    };
  }
  if (pr.reviewDecision === 'REVIEW_REQUIRED') {
    return {
      observed: true,
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
      observed: true,
      reviewDecision: 'CHANGES_REQUESTED',
      submittedReviewAuthorCanPushToRepository,
      status: 'changes-requested',
      nextAction: 'Resolve the blocking review and obtain a fresh exact-head independent approval.',
    };
  }
  return {
    observed: true,
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

/** Preserve the original binding: GitHub can remap a review's commit_id after a rebase. */
export function parseGitHubReviewArtifact(body: string | null | undefined): ReviewArtifact {
  try {
    if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > 64 * 1024) throw new Error('Invalid size.');
    const markers = body.match(/<!-- ai-delivery-review-artifact:[\s\S]*?-->/gu) ?? [];
    const payloads = body.match(/<!-- ai-delivery-review-artifact-data:[\s\S]*?-->/gu) ?? [];
    if (markers.length !== 1 || payloads.length !== 1) throw new Error('Ambiguous binding.');
    const id = markers[0]!.match(/^<!-- ai-delivery-review-artifact: (sha256:[a-f0-9]{64}) -->$/u)?.[1];
    const encoded = payloads[0]!.match(/^<!-- ai-delivery-review-artifact-data: ([A-Za-z0-9_-]+) -->$/u)?.[1];
    if (!id || !encoded) throw new Error('Invalid binding.');
    const bytes = Buffer.from(encoded, 'base64url');
    const json = bytes.toString('utf8');
    if (bytes.toString('base64url') !== encoded || !Buffer.from(json, 'utf8').equals(bytes))
      throw new Error('Invalid encoding.');
    const artifact = parseReviewArtifact(json);
    if (artifact.artifactId !== id) throw new Error('Artifact identity differs.');
    return artifact;
  } catch {
    throw new DeliveryError('GitHub review artifact binding is missing, invalid or ambiguous; obtain a fresh review.');
  }
}

function githubReviewBody(artifact: ReviewArtifact): string {
  ReviewArtifactSchema.parse(artifact);
  const metadata =
    artifact.verdictFileSha256 === undefined
      ? ''
      : `\n\nVerdict: ${artifact.verdict}\nRequested model/effort: ${artifact.requestedModel} / ${artifact.requestedEffort}\nEffective model/effort: ${artifact.effectiveModel} / ${artifact.effectiveEffort}\nElapsed milliseconds: ${artifact.elapsedMs}\nVerdict-file SHA256: ${artifact.verdictFileSha256}\nFindings: ${artifact.findings.length ? artifact.findings.join('; ') : 'none'}`;
  const body = `${artifact.summary}${metadata}\n\n<!-- ai-delivery-review-artifact: ${artifact.artifactId} -->\n<!-- ai-delivery-review-artifact-data: ${Buffer.from(JSON.stringify(artifact)).toString('base64url')} -->`;
  if (Buffer.byteLength(body) > 64 * 1024)
    throw new DeliveryError('Review body exceeds the 64 KiB publication limit; provide a concise verdict.');
  parseGitHubReviewArtifact(body);
  return body;
}

export async function readGitHubPrScopeHash(
  context: DeliveryContext,
  prNumber: number,
  changedFiles: number,
): Promise<string> {
  const files: string[] = [];
  for (let page = 1; page <= 30; page++) {
    const batch = (
      await context.clients.rest.pulls.listFiles({ ...context.repo, pull_number: prNumber, page, per_page: 100 })
    ).data;
    files.push(...batch.map((file) => file.filename));
    if (batch.length < 100) break;
  }
  if (!Number.isSafeInteger(changedFiles) || files.length !== changedFiles || new Set(files).size !== files.length)
    throw new DeliveryError('Independent review scope is incomplete or differs from the remote PR diff.');
  return digestValue(files.sort());
}

export function reviewArtifactApproval(input: {
  artifact: ReviewArtifact;
  classification: RepositoryClassificationReceipt;
  config: Pick<DeliveryConfig, 'roles'>;
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
  config: Pick<DeliveryConfig, 'roles'>;
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

interface ReviewSubmissionInput {
  artifact: ReviewArtifact;
  context: DeliveryContext;
  issueNumber: number;
  prNumber: number;
  dryRun?: boolean;
  publicationEvidenceId?: string;
  classification?: RepositoryClassificationReceipt;
}
export interface GitHubReviewReceipt {
  artifact: ReviewArtifact;
  repository: string;
  baseSha: string;
  headSha: string;
  githubReviewId: number;
  githubReviewUrl: string;
  login: string;
  prNumber: number;
  schemaVersion: 'ai-delivery.github-review@1';
  state: 'APPROVED' | 'CHANGES_REQUESTED';
  receiptId: string;
}
export class ReviewSubmissionError extends DeliveryError {
  constructor(
    message: string,
    readonly submission: {
      artifactId: string;
      repository: string;
      headSha: string;
      prNumber: number;
      githubReviewId?: number;
      githubReviewUrl?: string;
    },
  ) {
    super(`${message} Reconcile this artifact's remote review before retrying; no automatic retry was attempted.`);
  }
}
export interface ReviewDryRun {
  dryRun: true;
  artifactId: string;
  headSha: string;
}
export async function validateReviewTarget(context: DeliveryContext, artifact: ReviewArtifact, prNumber: number) {
  const pr = (await context.clients.rest.pulls.get({ ...context.repo, pull_number: prNumber })).data;
  if (
    pr.number !== prNumber ||
    pr.head.sha !== artifact.head.sha ||
    pr.state !== 'open' ||
    pr.base.repo?.full_name.toLowerCase() !== context.config.repository.toLowerCase() ||
    pr.head.repo?.full_name.toLowerCase() !== context.config.repository.toLowerCase()
  )
    throw new DeliveryError('PR identity or head changed before formal review.');
  const commit = (await context.clients.rest.git.getCommit({ ...context.repo, commit_sha: artifact.head.sha })).data;
  if (commit.sha !== artifact.head.sha || commit.tree.sha !== artifact.head.tree)
    throw new DeliveryError('Independent review tree differs from the remote commit.');
  if (artifact.diffScopeHash !== (await readGitHubPrScopeHash(context, prNumber, pr.changed_files)))
    throw new DeliveryError('Independent review scope is incomplete or differs from the remote PR diff.');
  return pr;
}

export function submitReview(input: ReviewSubmissionInput & { dryRun: true }): Promise<ReviewDryRun>;
export function submitReview(input: ReviewSubmissionInput & { dryRun?: false }): Promise<GitHubReviewReceipt>;
export function submitReview(input: ReviewSubmissionInput): Promise<GitHubReviewReceipt | ReviewDryRun>;
export async function submitReview(input: ReviewSubmissionInput): Promise<GitHubReviewReceipt | ReviewDryRun> {
  const { artifact, context, issueNumber, prNumber } = input;
  ReviewArtifactSchema.parse(artifact);
  if (
    artifact.issueNumber !== issueNumber ||
    artifact.authorIdentity !== context.config.roles.author.identity ||
    artifact.reviewerIdentity !== context.config.roles.reviewer.identity ||
    (artifact.prNumber !== null && artifact.prNumber !== prNumber)
  )
    throw new DeliveryError('Independent review artifact is foreign or rejected.');
  if (context.clients.authSource !== 'app' || context.clients.role !== 'reviewer' || !context.clients.appActorLogin)
    throw new DeliveryError('Formal review requires the independent reviewer GitHub App role.');
  const pr = await validateReviewTarget(context, artifact, prNumber);
  const actor = await context.clients.appActorLogin();
  if (!actor || !pr.user?.login || actor.toLowerCase() === pr.user.login.toLowerCase())
    throw new DeliveryError('Reviewer GitHub actor must differ from PR author.');
  const body = githubReviewBody(artifact);
  const expectedState = artifact.verdict === 'approve' ? ('APPROVED' as const) : ('CHANGES_REQUESTED' as const);
  const event = artifact.verdict === 'approve' ? ('APPROVE' as const) : ('REQUEST_CHANGES' as const);
  const marker = `<!-- ai-delivery-review-artifact: ${artifact.artifactId} -->`;
  const history = await listAllReviews(context, prNumber);
  const matches = history.filter((review) => review.body?.includes(marker));
  if (matches.length > 1) throw new DeliveryError('Conflicting GitHub reviews claim the same artifact identity.');
  const prior = matches[0];
  if (
    prior &&
    (prior.state !== expectedState ||
      prior.commit_id !== artifact.head.sha ||
      prior.user?.login.toLowerCase() !== actor.toLowerCase() ||
      !prior.html_url ||
      parseGitHubReviewArtifact(prior.body).artifactId !== artifact.artifactId)
  )
    throw new DeliveryError('Prior GitHub review marker conflicts with exact-head approval.');
  const fresh = (await context.clients.rest.pulls.get({ ...context.repo, pull_number: prNumber })).data;
  if (fresh.head.sha !== artifact.head.sha || fresh.base.sha !== pr.base.sha || fresh.state !== 'open')
    throw new DeliveryError('PR moved during independent review validation.');
  if (input.dryRun) return { dryRun: true as const, artifactId: artifact.artifactId, headSha: artifact.head.sha };
  const pending = {
    artifactId: artifact.artifactId,
    repository: context.config.repository,
    headSha: artifact.head.sha,
    prNumber,
  };
  let submitted;
  try {
    submitted =
      prior ??
      (
        await context.clients.rest.pulls.createReview({
          ...context.repo,
          pull_number: prNumber,
          commit_id: artifact.head.sha,
          body,
          event,
        })
      ).data;
  } catch {
    throw new ReviewSubmissionError('Review submission acknowledgement is unknown.', pending);
  }
  const known = {
    ...pending,
    ...(submitted.id ? { githubReviewId: submitted.id } : {}),
    ...(submitted.html_url ? { githubReviewUrl: submitted.html_url } : {}),
  };
  try {
    if (
      !submitted.id ||
      submitted.state !== expectedState ||
      submitted.commit_id !== artifact.head.sha ||
      submitted.user?.login.toLowerCase() !== actor.toLowerCase() ||
      !submitted.html_url
    )
      throw new DeliveryError('GitHub did not return complete exact-head independent approval.');
    const content = {
      artifact,
      repository: context.config.repository,
      baseSha: pr.base.sha,
      headSha: artifact.head.sha,
      githubReviewId: submitted.id,
      githubReviewUrl: submitted.html_url,
      login: submitted.user.login,
      prNumber,
      schemaVersion: 'ai-delivery.github-review@1' as const,
      state: expectedState,
    };
    const receipt = { ...content, receiptId: digestValue(content) };
    const readback = (
      await context.clients.rest.pulls.getReview({ ...context.repo, pull_number: prNumber, review_id: submitted.id })
    ).data;
    if (
      readback.id !== receipt.githubReviewId ||
      readback.html_url !== receipt.githubReviewUrl ||
      readback.state !== expectedState ||
      readback.commit_id !== receipt.headSha ||
      readback.user?.login !== receipt.login ||
      parseGitHubReviewArtifact(readback.body).artifactId !== artifact.artifactId
    )
      throw new DeliveryError('GitHub exact-head App review readback disagrees.');

    const current = (await context.clients.rest.pulls.get({ ...context.repo, pull_number: prNumber })).data;
    if (current.head.sha !== artifact.head.sha || current.base.sha !== pr.base.sha || current.state !== 'open')
      throw new DeliveryError('PR moved during independent review submission; approval is not current.');
    return receipt;
  } catch (error) {
    throw new ReviewSubmissionError(
      error instanceof DeliveryError ? error.message : 'Review post-submission readback is unavailable.',
      known,
    );
  }
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
    parseGitHubReviewArtifact(review.body).artifactId !== receipt.artifact.artifactId
  ) {
    throw new DeliveryError('GitHub exact-head review no longer matches the stored receipt.');
  }
}
