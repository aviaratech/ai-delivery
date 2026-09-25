import { join } from 'node:path';
import { z } from 'zod';
import {
  assertArtifact,
  assertPrivateFile,
  DigestSchema,
  digestBytes,
  digestValue,
  isUniqueSorted,
  stableJson,
  StageIdSchema,
  writeCreateOnly,
} from './common.js';
import { assertRepositoryClassificationCurrent, RepositoryClassificationReceiptSchema } from './policy.js';
import type { RepositoryClassificationReceipt } from './policy.js';

const SemanticInputSchema = z.object({ digest: DigestSchema, key: z.string().min(1) }).strict();
const UpstreamSchema = z.object({ receiptId: DigestSchema, stageId: StageIdSchema }).strict();
export const RepositoryStageInputSchema = z
  .object({
    classificationReceiptId: DigestSchema,
    definitionHash: DigestSchema,
    environmentDigest: DigestSchema,
    inputId: DigestSchema,
    policyDigest: DigestSchema,
    schemaVersion: z.literal('ai-delivery.stage-input@1'),
    semanticInputs: z.array(SemanticInputSchema).min(1),
    stageId: StageIdSchema,
    upstream: z.array(UpstreamSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    const { inputId, ...content } = value;
    if (
      inputId !== digestValue(content) ||
      !isUniqueSorted(value.semanticInputs.map((x) => x.key)) ||
      !isUniqueSorted(value.upstream.map((x) => x.stageId))
    )
      ctx.addIssue({ code: 'custom', message: 'Stage input identity or inventory is invalid.' });
  });
export type RepositoryStageInput = z.infer<typeof RepositoryStageInputSchema>;

export const RepositoryStageReceiptSchema = z
  .object({
    artifacts: z.array(z.object({ digest: DigestSchema, path: z.string().min(1) }).strict()),
    commands: z.array(
      z
        .object({ exitCode: z.number().int().nonnegative(), label: z.string().min(1), outputDigest: DigestSchema })
        .strict(),
    ),
    completedAt: z.iso.datetime(),
    input: RepositoryStageInputSchema,
    receiptId: DigestSchema,
    result: z.literal('passed'),
    schemaVersion: z.literal('ai-delivery.stage-receipt@1'),
    startedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const { receiptId, ...content } = value;
    if (
      receiptId !== digestValue(content) ||
      Date.parse(value.completedAt) < Date.parse(value.startedAt) ||
      value.commands.some((command) => command.exitCode !== 0) ||
      !isUniqueSorted(value.artifacts.map((a) => a.path))
    )
      ctx.addIssue({ code: 'custom', message: 'Stage receipt has incomplete or corrupt proof.' });
  });
export type RepositoryStageReceipt = z.infer<typeof RepositoryStageReceiptSchema>;

export const RepositoryStageAggregateSchema = z
  .object({
    aggregateId: DigestSchema,
    classificationReceiptId: DigestSchema,
    policyDigest: DigestSchema,
    result: z.literal('passed'),
    schemaVersion: z.literal('ai-delivery.stage-aggregate@1'),
    stages: z
      .array(z.object({ inputId: DigestSchema, receiptId: DigestSchema, stageId: StageIdSchema }).strict())
      .min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const { aggregateId, ...content } = value;
    if (
      aggregateId !== digestValue(content) ||
      new Set(value.stages.map((x) => x.stageId)).size !== value.stages.length
    )
      ctx.addIssue({ code: 'custom', message: 'Stage aggregate identity or inventory is invalid.' });
  });
export type RepositoryStageAggregate = z.infer<typeof RepositoryStageAggregateSchema>;

export function createRepositoryStageInput(input: {
  classification: RepositoryClassificationReceipt;
  environmentDigest: string;
  semanticInputs: readonly { digest: string; key: string }[];
  stageId: string;
  upstream: readonly { receiptId: string; stageId: string }[];
}): RepositoryStageInput {
  const classification = RepositoryClassificationReceiptSchema.parse(input.classification);
  const definition = classification.requiredStages.find((stage) => stage.id === input.stageId);
  if (definition === undefined) throw new Error('Stage is absent from selected policy.');
  const semanticInputs = [...input.semanticInputs]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((x) => SemanticInputSchema.parse(x));
  const upstream = [...input.upstream]
    .sort((a, b) => a.stageId.localeCompare(b.stageId))
    .map((x) => UpstreamSchema.parse(x));
  if (
    stableJson(semanticInputs.map((x) => x.key)) !== stableJson(definition.semanticInputKeys) ||
    stableJson(upstream.map((x) => x.stageId)) !== stableJson([...definition.dependsOn].sort())
  )
    throw new Error('Stage input lacks required semantic or upstream proof.');
  const content = {
    classificationReceiptId: classification.receiptId,
    definitionHash: digestValue(definition),
    environmentDigest: DigestSchema.parse(input.environmentDigest),
    policyDigest: classification.policyDigest,
    schemaVersion: 'ai-delivery.stage-input@1' as const,
    semanticInputs,
    stageId: definition.id,
    upstream,
  };
  return RepositoryStageInputSchema.parse({ ...content, inputId: digestValue(content) });
}

export function createRepositoryStageReceipt(input: {
  artifacts: readonly { digest: string; path: string }[];
  classification: RepositoryClassificationReceipt;
  commands: readonly { exitCode: number; label: string; outputDigest: string }[];
  completedAt: string;
  stageInput: RepositoryStageInput;
  startedAt: string;
}): RepositoryStageReceipt {
  const classification = RepositoryClassificationReceiptSchema.parse(input.classification);
  const stageInput = RepositoryStageInputSchema.parse(input.stageInput);
  const definition = classification.requiredStages.find((stage) => stage.id === stageInput.stageId);
  if (
    definition === undefined ||
    stageInput.classificationReceiptId !== classification.receiptId ||
    stageInput.policyDigest !== classification.policyDigest ||
    stageInput.definitionHash !== digestValue(definition) ||
    stableJson(stageInput.semanticInputs.map((x) => x.key)) !== stableJson(definition.semanticInputKeys) ||
    stableJson(stageInput.upstream.map((x) => x.stageId)) !== stableJson([...definition.dependsOn].sort()) ||
    input.commands.length !== definition.commands.length ||
    input.commands.some(
      (command, index) => command.label !== definition.commands[index]?.label || command.exitCode !== 0,
    ) ||
    (definition.attestationKey !== undefined && input.artifacts.length === 0)
  )
    throw new Error('Stage receipt does not prove selected definition.');
  const content = {
    artifacts: [...input.artifacts].sort((a, b) => a.path.localeCompare(b.path)),
    commands: input.commands.map((x) => ({ ...x })),
    completedAt: input.completedAt,
    input: stageInput,
    result: 'passed' as const,
    schemaVersion: 'ai-delivery.stage-receipt@1' as const,
    startedAt: input.startedAt,
  };
  return RepositoryStageReceiptSchema.parse({ ...content, receiptId: digestValue(content) });
}

export function createRepositoryStageAggregate(input: {
  classification: RepositoryClassificationReceipt;
  receipts: readonly RepositoryStageReceipt[];
}): RepositoryStageAggregate {
  const classification = RepositoryClassificationReceiptSchema.parse(input.classification);
  if (input.receipts.length !== classification.requiredStages.length)
    throw new Error('Aggregate requires every selected stage.');
  const receipts = input.receipts.map((receipt) => RepositoryStageReceiptSchema.parse(receipt));
  const byStage = new Map(receipts.map((receipt) => [receipt.input.stageId, receipt]));
  if (byStage.size !== receipts.length) throw new Error('Aggregate contains duplicate stages.');
  for (const definition of classification.requiredStages) {
    const receipt = byStage.get(definition.id);
    if (
      receipt === undefined ||
      receipt.input.classificationReceiptId !== classification.receiptId ||
      receipt.input.policyDigest !== classification.policyDigest ||
      receipt.input.definitionHash !== digestValue(definition) ||
      stableJson(receipt.input.upstream) !==
        stableJson(
          definition.dependsOn
            .map((stageId) => ({ stageId, receiptId: byStage.get(stageId)?.receiptId }))
            .sort((a, b) => a.stageId.localeCompare(b.stageId)),
        ) ||
      createRepositoryStageReceipt({
        artifacts: receipt.artifacts,
        classification,
        commands: receipt.commands,
        completedAt: receipt.completedAt,
        stageInput: receipt.input,
        startedAt: receipt.startedAt,
      }).receiptId !== receipt.receiptId
    )
      throw new Error('Aggregate contains missing, foreign or stale stage proof.');
  }
  const content = {
    classificationReceiptId: classification.receiptId,
    policyDigest: classification.policyDigest,
    result: 'passed' as const,
    schemaVersion: 'ai-delivery.stage-aggregate@1' as const,
    stages: classification.requiredStages.map((stage) => {
      const receipt = byStage.get(stage.id)!;
      return { inputId: receipt.input.inputId, receiptId: receipt.receiptId, stageId: stage.id };
    }),
  };
  return RepositoryStageAggregateSchema.parse({ ...content, aggregateId: digestValue(content) });
}

function storeRoot(gitCommonDir: string): string {
  return join(gitCommonDir, 'ai-delivery', 'verification@1');
}
function outputPath(gitCommonDir: string, digest: string): string {
  return join(storeRoot(gitCommonDir), 'command-output', `${DigestSchema.parse(digest).slice(7)}.bin`);
}
function checkpointPath(gitCommonDir: string, stageInput: RepositoryStageInput): string {
  return join(storeRoot(gitCommonDir), 'stages', stageInput.stageId, `${stageInput.inputId.slice(7)}.json`);
}
export function writeRepositoryCommandOutput(input: { bytes: Buffer; gitCommonDir: string }): `sha256:${string}` {
  if (input.bytes.length > 8 * 1024 * 1024) throw new Error('Command output exceeds bounded evidence limit.');
  const digest = digestBytes(input.bytes);
  writeCreateOnly(outputPath(input.gitCommonDir, digest), input.bytes);
  return digest;
}
export function assertRepositoryStageProof(input: {
  gitCommonDir: string;
  receipt: RepositoryStageReceipt;
  repoRoot: string;
}): void {
  const receipt = RepositoryStageReceiptSchema.parse(input.receipt);
  for (const artifact of receipt.artifacts) assertArtifact(input.repoRoot, artifact);
  for (const command of receipt.commands)
    if (digestBytes(assertPrivateFile(outputPath(input.gitCommonDir, command.outputDigest))) !== command.outputDigest)
      throw new Error('Command output bytes are missing or corrupt.');
}
export function writeRepositoryStageCheckpoint(input: {
  gitCommonDir: string;
  receipt: RepositoryStageReceipt;
  repoRoot: string;
}): string {
  const receipt = RepositoryStageReceiptSchema.parse(input.receipt);
  assertRepositoryStageProof({ ...input, receipt });
  return writeCreateOnly(checkpointPath(input.gitCommonDir, receipt.input), Buffer.from(stableJson(receipt), 'utf8'));
}
export function loadRepositoryStageCheckpoint(input: {
  gitCommonDir: string;
  stageInput: RepositoryStageInput;
  repoRoot: string;
  classification: RepositoryClassificationReceipt;
  configDigest: string;
  policySourcePath: string;
}): RepositoryStageReceipt | undefined {
  const stageInput = RepositoryStageInputSchema.parse(input.stageInput);
  assertRepositoryClassificationCurrent(input);
  let bytes: Buffer;
  try {
    bytes = assertPrivateFile(checkpointPath(input.gitCommonDir, stageInput));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const receipt = RepositoryStageReceiptSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (
    !bytes.equals(Buffer.from(stableJson(receipt), 'utf8')) ||
    receipt.input.inputId !== stageInput.inputId ||
    createRepositoryStageReceipt({
      artifacts: receipt.artifacts,
      classification: input.classification,
      commands: receipt.commands,
      completedAt: receipt.completedAt,
      stageInput,
      startedAt: receipt.startedAt,
    }).receiptId !== receipt.receiptId
  )
    throw new Error('Stage checkpoint is corrupt or belongs to another input.');
  assertRepositoryStageProof({ gitCommonDir: input.gitCommonDir, receipt, repoRoot: input.repoRoot });
  return receipt;
}
export function writeRepositoryStageAggregate(input: {
  gitCommonDir: string;
  aggregate: RepositoryStageAggregate;
}): string {
  const aggregate = RepositoryStageAggregateSchema.parse(input.aggregate);
  return writeCreateOnly(
    join(storeRoot(input.gitCommonDir), 'aggregates', `${aggregate.aggregateId.slice(7)}.json`),
    Buffer.from(stableJson(aggregate), 'utf8'),
  );
}
