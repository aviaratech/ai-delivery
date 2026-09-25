import { join } from 'node:path';
import { z } from 'zod';
import {
  assertPrivateFile,
  CoordinateSchema,
  DigestSchema,
  digestValue,
  RepositorySchema,
  stableJson,
  writeCreateOnly,
} from './common.js';
import type { Coordinate } from './common.js';
import { RepositoryClassificationReceiptSchema, validateRepositoryPolicyBoundary } from './policy.js';
import type { RepositoryClassificationReceipt, RepositoryDeliveryPolicy } from './policy.js';
import {
  assertRepositoryStageProof,
  createRepositoryStageAggregate,
  RepositoryStageAggregateSchema,
  RepositoryStageReceiptSchema,
} from './stage.js';
import type { RepositoryStageAggregate, RepositoryStageReceipt } from './stage.js';

export const RepositoryApprovalBindingSchema = z
  .object({
    authorIdentity: z.string().min(1),
    diffScopeHash: DigestSchema,
    head: CoordinateSchema,
    result: z.literal('approved'),
    reviewerIdentity: z.string().min(1),
    reviewReceiptId: DigestSchema,
  })
  .strict()
  .refine(
    (value) => value.authorIdentity !== value.reviewerIdentity,
    'Approval requires a distinct reviewer identity.',
  );
export type RepositoryApprovalBinding = z.infer<typeof RepositoryApprovalBindingSchema>;

export const RepositoryMergeReadbackSchema = z
  .object({
    blockedBy: z.array(z.number().int().positive()),
    checksPassed: z.boolean(),
    head: CoordinateSchema,
    mergeable: z.boolean(),
    observedAt: z.iso.datetime(),
  })
  .strict();
export type RepositoryMergeReadback = z.infer<typeof RepositoryMergeReadbackSchema>;

export const RepositoryDeliveryEvidenceSchema = z
  .object({
    aggregateId: DigestSchema,
    approval: RepositoryApprovalBindingSchema.nullable(),
    base: CoordinateSchema,
    boundaryId: DigestSchema,
    classificationReceiptId: DigestSchema,
    configDigest: DigestSchema,
    evidenceId: DigestSchema,
    head: CoordinateSchema,
    phase: z.enum(['verify', 'publish', 'merge']),
    policyDigest: DigestSchema,
    repository: RepositorySchema,
    result: z.literal('passed'),
    schemaVersion: z.literal('ai-delivery.delivery-evidence@1'),
  })
  .strict()
  .superRefine((value, ctx) => {
    const { evidenceId, ...content } = value;
    if (evidenceId !== digestValue(content) || (value.phase === 'merge' && value.approval === null))
      ctx.addIssue({ code: 'custom', message: 'Delivery evidence identity or approval is invalid.' });
  });
export type RepositoryDeliveryEvidence = z.infer<typeof RepositoryDeliveryEvidenceSchema>;

export interface RepositoryDeliveryEvidenceInput {
  aggregate: RepositoryStageAggregate;
  approval?: RepositoryApprovalBinding;
  approvalRoles: { authorIdentity: string; reviewerIdentity: string };
  classification: RepositoryClassificationReceipt;
  configDigest: string;
  currentBase: Coordinate;
  currentHead: Coordinate;
  gitCommonDir: string;
  mergeReadback?: RepositoryMergeReadback;
  now?: () => Date;
  phase: 'verify' | 'publish' | 'merge';
  policy: RepositoryDeliveryPolicy;
  policySourcePath: string;
  repoRoot: string;
  stageReceipts: readonly RepositoryStageReceipt[];
}

export function createRepositoryDeliveryEvidence(input: RepositoryDeliveryEvidenceInput): RepositoryDeliveryEvidence {
  const classification = RepositoryClassificationReceiptSchema.parse(input.classification);
  const aggregate = RepositoryStageAggregateSchema.parse(input.aggregate);
  const receipts = input.stageReceipts.map((x) => RepositoryStageReceiptSchema.parse(x));
  const expected = createRepositoryStageAggregate({ classification, receipts });
  if (aggregate.aggregateId !== expected.aggregateId)
    throw new Error('Delivery evidence requires complete GREEN stage aggregate.');
  for (const receipt of receipts)
    assertRepositoryStageProof({ gitCommonDir: input.gitCommonDir, receipt, repoRoot: input.repoRoot });
  const boundary = validateRepositoryPolicyBoundary({
    classification,
    configDigest: input.configDigest,
    currentBase: input.currentBase,
    currentHead: input.currentHead,
    phase: input.phase,
    policy: input.policy,
    policySourcePath: input.policySourcePath,
    repoRoot: input.repoRoot,
    stageReceiptIds: aggregate.stages.map((stage) => ({ receiptId: stage.receiptId, stageId: stage.stageId })),
  });
  const approval = input.approval === undefined ? null : RepositoryApprovalBindingSchema.parse(input.approval);
  if (
    input.approvalRoles.authorIdentity === input.approvalRoles.reviewerIdentity ||
    !input.approvalRoles.authorIdentity ||
    !input.approvalRoles.reviewerIdentity
  )
    throw new Error('Delivery requires distinct configured author and reviewer roles.');
  if ((classification.risk === 'high' || input.phase === 'merge') && approval === null)
    throw new Error('Delivery boundary requires independent exact-head approval.');
  if (
    approval !== null &&
    (stableJson(approval.head) !== stableJson(classification.head) ||
      approval.diffScopeHash !== digestValue(classification.changedPaths) ||
      approval.authorIdentity !== input.approvalRoles.authorIdentity ||
      approval.reviewerIdentity !== input.approvalRoles.reviewerIdentity)
  )
    throw new Error('Approval does not cover configured roles, exact head and changed paths.');
  if (input.phase === 'merge') {
    const readback = RepositoryMergeReadbackSchema.parse(input.mergeReadback);
    const age = (input.now ?? (() => new Date()))().getTime() - Date.parse(readback.observedAt);
    if (
      stableJson(readback.head) !== stableJson(classification.head) ||
      !readback.mergeable ||
      !readback.checksPassed ||
      readback.blockedBy.length !== 0 ||
      age < 0 ||
      age > 30_000
    )
      throw new Error('Merge requires current clean native blocker and check readback.');
  }
  const content = {
    aggregateId: aggregate.aggregateId,
    approval,
    base: classification.base,
    boundaryId: boundary.boundaryId,
    classificationReceiptId: classification.receiptId,
    configDigest: classification.configDigest,
    head: classification.head,
    phase: input.phase,
    policyDigest: classification.policyDigest,
    repository: classification.repository,
    result: 'passed' as const,
    schemaVersion: 'ai-delivery.delivery-evidence@1' as const,
  };
  return RepositoryDeliveryEvidenceSchema.parse({ ...content, evidenceId: digestValue(content) });
}

function evidencePath(gitCommonDir: string, head: Coordinate, evidenceId: string): string {
  return join(
    gitCommonDir,
    'ai-delivery',
    'receipts',
    'delivery@1',
    head.sha,
    `${DigestSchema.parse(evidenceId).slice(7)}.json`,
  );
}
export function writeRepositoryDeliveryEvidence(input: {
  evidence: RepositoryDeliveryEvidence;
  gitCommonDir: string;
}): string {
  const evidence = RepositoryDeliveryEvidenceSchema.parse(input.evidence);
  return writeCreateOnly(
    evidencePath(input.gitCommonDir, evidence.head, evidence.evidenceId),
    Buffer.from(stableJson(evidence), 'utf8'),
  );
}
export function loadValidRepositoryDeliveryEvidence(input: {
  createInput: RepositoryDeliveryEvidenceInput;
  evidenceId: string;
}): RepositoryDeliveryEvidence {
  const path = evidencePath(input.createInput.gitCommonDir, input.createInput.currentHead, input.evidenceId);
  const bytes = assertPrivateFile(path);
  const stored = RepositoryDeliveryEvidenceSchema.parse(JSON.parse(bytes.toString('utf8')));
  const current = createRepositoryDeliveryEvidence(input.createInput);
  if (
    !bytes.equals(Buffer.from(stableJson(stored), 'utf8')) ||
    current.evidenceId !== stored.evidenceId ||
    stored.evidenceId !== input.evidenceId
  )
    throw new Error('Delivery evidence is stale, foreign or corrupt.');
  return stored;
}
