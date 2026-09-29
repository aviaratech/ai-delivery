import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  assertArtifact,
  assertExactRange,
  CoordinateSchema,
  DigestSchema,
  digestBytes,
  digestValue,
  git,
  isUniqueSorted,
  RepositorySchema,
  resolveRepositoryFile,
  stableJson,
  StageIdSchema,
} from './common.js';
import type { Coordinate } from './common.js';

const ArtifactSchema = z
  .object({ digest: DigestSchema, path: z.string().min(1), producer: z.string().min(1) })
  .strict();
export const RepositoryStageDefinitionSchema = z
  .object({
    attestationKey: z.string().min(1).optional(),
    commands: z.array(z.object({ argv: z.array(z.string().min(1)).min(1), label: z.string().min(1) }).strict()),
    dependsOn: z.array(StageIdSchema),
    id: StageIdSchema,
    resourceClass: z.enum(['source_only', 'focused_node', 'canonical_verify', 'model', 'postgres_docker']),
    semanticInputKeys: z.array(z.string().min(1)).min(1),
    semanticInputs: z
      .array(z.object({ digest: DigestSchema, key: z.string().min(1) }).strict())
      .min(1)
      .optional(),
  })
  .strict();
export type RepositoryStageDefinition = z.infer<typeof RepositoryStageDefinitionSchema>;

export const RepositoryPolicyEvidenceSchema = z
  .object({
    artifacts: z.array(ArtifactSchema).min(1),
    base: CoordinateSchema,
    configDigest: DigestSchema,
    evidenceId: DigestSchema,
    head: CoordinateSchema,
    opaquePayload: z.string().min(1),
    policyDigest: DigestSchema,
    producer: z.string().min(1),
    repository: RepositorySchema,
    schemaVersion: z.literal('ai-delivery.policy-evidence@1'),
  })
  .strict()
  .superRefine((value, ctx) => {
    const { evidenceId, ...content } = value;
    if (evidenceId !== digestValue(content) || !isUniqueSorted(value.artifacts.map((a) => a.path)))
      ctx.addIssue({ code: 'custom', message: 'Policy evidence identity or artifacts are invalid.' });
  });
export type RepositoryPolicyEvidence = z.infer<typeof RepositoryPolicyEvidenceSchema>;

export const RepositoryPolicyClassificationSchema = z
  .object({
    policyDigest: DigestSchema,
    policyEvidence: RepositoryPolicyEvidenceSchema,
    requiredStages: z.array(RepositoryStageDefinitionSchema).min(1),
    risk: z.enum(['standard', 'high']),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const stage of value.requiredStages) {
      if (
        seen.has(stage.id) ||
        stage.dependsOn.some((d) => !seen.has(d)) ||
        new Set(stage.dependsOn).size !== stage.dependsOn.length ||
        !isUniqueSorted(stage.semanticInputKeys) ||
        (stage.semanticInputs !== undefined &&
          (!isUniqueSorted(stage.semanticInputs.map((entry) => entry.key)) ||
            stableJson(stage.semanticInputs.map((entry) => entry.key)) !== stableJson(stage.semanticInputKeys))) ||
        (stage.commands.length === 0) !== (stage.attestationKey !== undefined)
      )
        ctx.addIssue({ code: 'custom', message: 'Policy stages must be unique, ordered and proof complete.' });
      seen.add(stage.id);
    }
  });
export type RepositoryPolicyClassification = z.infer<typeof RepositoryPolicyClassificationSchema>;

export const RepositoryPolicyBoundarySchema = z
  .object({
    additionalConstraints: z
      .object({ exactBaseHeadLease: z.boolean(), requiredAttestationIds: z.array(DigestSchema) })
      .strict(),
    boundaryId: DigestSchema,
    classificationReceiptId: DigestSchema,
    configDigest: DigestSchema,
    currentBase: CoordinateSchema,
    currentHead: CoordinateSchema,
    phase: z.enum(['verify', 'publish', 'merge']),
    policyEvidenceId: DigestSchema,
    schemaVersion: z.literal('ai-delivery.policy-boundary@1'),
    stageReceiptSetHash: DigestSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const { boundaryId, ...content } = value;
    if (boundaryId !== digestValue(content) || !isUniqueSorted(value.additionalConstraints.requiredAttestationIds))
      ctx.addIssue({ code: 'custom', message: 'Policy boundary identity or attestation inventory is invalid.' });
  });
export type RepositoryPolicyBoundary = z.infer<typeof RepositoryPolicyBoundarySchema>;

export interface RepositoryDeliveryPolicy {
  readonly schemaVersion: 'RepositoryDeliveryPolicy@1' | 'RepositoryDeliveryPolicy@2';
  classifyExactRange(input: {
    repository: string;
    baseSha: string;
    baseTree: string;
    headSha: string;
    headTree: string;
    changedPaths: readonly string[];
    configDigest: string;
  }): RepositoryPolicyClassification;
  validateBoundary(input: {
    phase: 'verify' | 'publish' | 'merge';
    classificationReceiptId: string;
    policyEvidence: RepositoryPolicyEvidence;
    currentBase: Coordinate;
    currentHead: Coordinate;
    configDigest: string;
    stageReceiptIds: readonly { receiptId: string; stageId: string }[];
  }): RepositoryPolicyBoundary;
}

export const RepositoryClassificationReceiptSchema = z
  .object({
    base: CoordinateSchema,
    changedPaths: z.array(z.string().min(1)),
    configDigest: DigestSchema,
    head: CoordinateSchema,
    policyDigest: DigestSchema,
    policyEvidence: RepositoryPolicyEvidenceSchema,
    receiptId: DigestSchema,
    repository: RepositorySchema,
    requiredStages: z.array(RepositoryStageDefinitionSchema).min(1),
    risk: z.enum(['standard', 'high']),
    schemaVersion: z.enum(['ai-delivery.classification@1', 'ai-delivery.classification@2']),
  })
  .strict()
  .superRefine((value, ctx) => {
    const { receiptId, ...content } = value;
    if (
      receiptId !== digestValue(content) ||
      !isUniqueSorted(value.changedPaths) ||
      (value.base.sha !== value.head.sha && value.changedPaths.length === 0) ||
      value.policyEvidence.repository !== value.repository ||
      stableJson(value.policyEvidence.base) !== stableJson(value.base) ||
      stableJson(value.policyEvidence.head) !== stableJson(value.head) ||
      value.policyEvidence.configDigest !== value.configDigest ||
      value.policyEvidence.policyDigest !== value.policyDigest ||
      value.requiredStages.some(
        (stage) => (stage.semanticInputs !== undefined) !== (value.schemaVersion === 'ai-delivery.classification@2'),
      ) ||
      !RepositoryPolicyClassificationSchema.safeParse({
        policyDigest: value.policyDigest,
        policyEvidence: value.policyEvidence,
        requiredStages: value.requiredStages,
        risk: value.risk,
      }).success
    )
      ctx.addIssue({ code: 'custom', message: 'Repository classification is unbound or invalid.' });
  });
export type RepositoryClassificationReceipt = z.infer<typeof RepositoryClassificationReceiptSchema>;

export async function loadSelectedRepositoryPolicy(input: {
  repoRoot: string;
  policySourcePath: string;
}): Promise<{ policy: RepositoryDeliveryPolicy; policyDigest: `sha256:${string}` }> {
  const path = resolveRepositoryFile(input.repoRoot, input.policySourcePath);
  git(input.repoRoot, ['ls-files', '--error-unmatch', '--', input.policySourcePath]);
  const policyDigest = digestBytes(readFileSync(path));
  const loaded: unknown = await import(`${pathToFileURL(path).href}?policy=${policyDigest.slice(7)}`);
  const policy = (loaded as { default?: unknown }).default;
  if (
    policy === null ||
    typeof policy !== 'object' ||
    !['RepositoryDeliveryPolicy@1', 'RepositoryDeliveryPolicy@2'].includes(
      (policy as RepositoryDeliveryPolicy).schemaVersion,
    ) ||
    typeof (policy as RepositoryDeliveryPolicy).classifyExactRange !== 'function' ||
    typeof (policy as RepositoryDeliveryPolicy).validateBoundary !== 'function'
  )
    throw new Error('Selected repository policy module is missing or invalid.');
  return { policy: policy as RepositoryDeliveryPolicy, policyDigest };
}

function selectedPolicyDigest(repoRoot: string, policySourcePath: string): `sha256:${string}` {
  const path = resolveRepositoryFile(repoRoot, policySourcePath);
  git(repoRoot, ['ls-files', '--error-unmatch', '--', policySourcePath]);
  return digestBytes(readFileSync(path));
}

export function classifyRepositoryExactRange(input: {
  repoRoot: string;
  repository: string;
  base: Coordinate;
  head: Coordinate;
  changedPaths: readonly string[];
  configDigest: string;
  policySourcePath: string;
  policy: RepositoryDeliveryPolicy;
}): RepositoryClassificationReceipt {
  if (!['RepositoryDeliveryPolicy@1', 'RepositoryDeliveryPolicy@2'].includes(input.policy.schemaVersion))
    throw new Error('Unknown repository policy version.');
  const base = CoordinateSchema.parse(input.base);
  const head = CoordinateSchema.parse(input.head);
  const repository = RepositorySchema.parse(input.repository);
  const configDigest = DigestSchema.parse(input.configDigest);
  const changedPaths = [...input.changedPaths].sort();
  assertExactRange({ repoRoot: input.repoRoot, base, head, changedPaths });
  const policyDigest = selectedPolicyDigest(input.repoRoot, input.policySourcePath);
  const selected = RepositoryPolicyClassificationSchema.parse(
    input.policy.classifyExactRange({
      repository,
      baseSha: base.sha,
      baseTree: base.tree,
      headSha: head.sha,
      headTree: head.tree,
      changedPaths,
      configDigest,
    }),
  );
  if (
    selected.policyDigest !== policyDigest ||
    selected.policyEvidence.policyDigest !== policyDigest ||
    selected.policyEvidence.repository !== repository ||
    stableJson(selected.policyEvidence.base) !== stableJson(base) ||
    stableJson(selected.policyEvidence.head) !== stableJson(head) ||
    selected.policyEvidence.configDigest !== configDigest
  )
    throw new Error('Selected policy did not bind the exact repository, config, source and policy bytes.');
  for (const artifact of selected.policyEvidence.artifacts) assertArtifact(input.repoRoot, artifact);
  const content = {
    base,
    changedPaths,
    configDigest,
    head,
    policyDigest,
    policyEvidence: selected.policyEvidence,
    repository,
    requiredStages: selected.requiredStages,
    risk: selected.risk,
    schemaVersion:
      input.policy.schemaVersion === 'RepositoryDeliveryPolicy@2'
        ? ('ai-delivery.classification@2' as const)
        : ('ai-delivery.classification@1' as const),
  };
  return RepositoryClassificationReceiptSchema.parse({ ...content, receiptId: digestValue(content) });
}

export function assertRepositoryClassificationCurrent(input: {
  repoRoot: string;
  classification: RepositoryClassificationReceipt;
  configDigest: string;
  policySourcePath: string;
}): void {
  const classification = RepositoryClassificationReceiptSchema.parse(input.classification);
  if (
    input.configDigest !== classification.configDigest ||
    selectedPolicyDigest(input.repoRoot, input.policySourcePath) !== classification.policyDigest
  )
    throw new Error('Repository classification is stale against config or policy source.');
  assertExactRange({
    repoRoot: input.repoRoot,
    base: classification.base,
    head: classification.head,
    changedPaths: classification.changedPaths,
  });
  for (const artifact of classification.policyEvidence.artifacts) assertArtifact(input.repoRoot, artifact);
}

export function validateRepositoryPolicyBoundary(input: {
  repoRoot: string;
  classification: RepositoryClassificationReceipt;
  configDigest: string;
  currentBase: Coordinate;
  currentHead: Coordinate;
  phase: 'verify' | 'publish' | 'merge';
  policySourcePath: string;
  policy: RepositoryDeliveryPolicy;
  stageReceiptIds: readonly { receiptId: string; stageId: string }[];
}): RepositoryPolicyBoundary {
  const classification = RepositoryClassificationReceiptSchema.parse(input.classification);
  const base = CoordinateSchema.parse(input.currentBase);
  const head = CoordinateSchema.parse(input.currentHead);
  if (
    !['RepositoryDeliveryPolicy@1', 'RepositoryDeliveryPolicy@2'].includes(input.policy.schemaVersion) ||
    (input.policy.schemaVersion === 'RepositoryDeliveryPolicy@2'
      ? 'ai-delivery.classification@2'
      : 'ai-delivery.classification@1') !== classification.schemaVersion ||
    input.configDigest !== classification.configDigest ||
    selectedPolicyDigest(input.repoRoot, input.policySourcePath) !== classification.policyDigest ||
    stableJson(base) !== stableJson(classification.base) ||
    stableJson(head) !== stableJson(classification.head)
  )
    throw new Error('Repository policy boundary is stale against source, config or policy.');
  assertRepositoryClassificationCurrent({
    repoRoot: input.repoRoot,
    classification,
    configDigest: input.configDigest,
    policySourcePath: input.policySourcePath,
  });
  const selected = RepositoryPolicyClassificationSchema.parse(
    input.policy.classifyExactRange({
      repository: classification.repository,
      baseSha: base.sha,
      baseTree: base.tree,
      headSha: head.sha,
      headTree: head.tree,
      changedPaths: classification.changedPaths,
      configDigest: classification.configDigest,
    }),
  );
  if (
    stableJson(selected) !==
    stableJson({
      policyDigest: classification.policyDigest,
      policyEvidence: classification.policyEvidence,
      requiredStages: classification.requiredStages,
      risk: classification.risk,
    })
  )
    throw new Error('Repository policy no longer selects the classified stage plan.');
  const stageReceiptIds = input.stageReceiptIds.map((entry) => ({
    receiptId: DigestSchema.parse(entry.receiptId),
    stageId: StageIdSchema.parse(entry.stageId),
  }));
  if (
    stageReceiptIds.length !== classification.requiredStages.length ||
    stageReceiptIds.some((entry, index) => entry.stageId !== classification.requiredStages[index]?.id)
  )
    throw new Error('Policy boundary lacks complete ordered stage receipts.');
  const boundary = RepositoryPolicyBoundarySchema.parse(
    input.policy.validateBoundary({
      phase: input.phase,
      classificationReceiptId: classification.receiptId,
      policyEvidence: classification.policyEvidence,
      currentBase: base,
      currentHead: head,
      configDigest: classification.configDigest,
      stageReceiptIds,
    }),
  );
  if (
    boundary.policyEvidenceId !== classification.policyEvidence.evidenceId ||
    boundary.classificationReceiptId !== classification.receiptId ||
    boundary.configDigest !== classification.configDigest ||
    boundary.phase !== input.phase ||
    stableJson(boundary.currentBase) !== stableJson(base) ||
    stableJson(boundary.currentHead) !== stableJson(head) ||
    boundary.stageReceiptSetHash !== digestValue(stageReceiptIds) ||
    boundary.additionalConstraints.requiredAttestationIds.some(
      (id) => !stageReceiptIds.some((stage) => stage.receiptId === id),
    )
  )
    throw new Error('Repository policy boundary returned unbound constraints.');
  return boundary;
}
