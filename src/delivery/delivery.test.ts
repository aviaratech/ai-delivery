import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  classifyRepositoryExactRange,
  createRepositoryDeliveryEvidence,
  createRepositoryStageAggregate,
  createRepositoryStageInput,
  createRepositoryStageReceipt,
  digestBytes,
  digestValue,
  loadRepositoryStageCheckpoint,
  loadSelectedRepositoryPolicy,
  loadValidRepositoryDeliveryEvidence,
  writeRepositoryCommandOutput,
  writeRepositoryDeliveryEvidence,
  writeRepositoryStageCheckpoint,
} from './index.js';
import type { RepositoryDeliveryPolicy, RepositoryStageReceipt } from './index.js';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ai-delivery-test-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'delivery@example.test');
  git(root, 'config', 'user.name', 'Delivery Test');
  writeFileSync(
    join(root, 'policy.mjs'),
    `export default { schemaVersion: 'RepositoryDeliveryPolicy@1', classifyExactRange() {}, validateBoundary() {} };\n`,
  );
  writeFileSync(join(root, 'artifact.txt'), 'proof');
  writeFileSync(join(root, 'output.txt'), 'stage artifact');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  const base = { sha: git(root, 'rev-parse', 'HEAD'), tree: git(root, 'rev-parse', 'HEAD^{tree}') };
  writeFileSync(join(root, 'change.txt'), 'changed');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'head');
  const head = { sha: git(root, 'rev-parse', 'HEAD'), tree: git(root, 'rev-parse', 'HEAD^{tree}') };
  const policyDigest = digestBytes(readFileSync(join(root, 'policy.mjs')));
  const configDigest = digestValue({ repository: 'example/delivery', policy: 'policy.mjs' });
  const gitCommonDir = join(root, '.git');
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return { root, base, head, policyDigest, configDigest, gitCommonDir, cleanup };
}

function makePolicy(state: ReturnType<typeof setup>, risk: 'standard' | 'high' = 'standard'): RepositoryDeliveryPolicy {
  const hash = digestValue;
  const definition = {
    commands: [{ argv: ['node', '--version'], label: 'check' }],
    dependsOn: [],
    id: 'check',
    resourceClass: 'source_only' as const,
    semanticInputKeys: ['source'],
  };
  return {
    schemaVersion: 'RepositoryDeliveryPolicy@1',
    classifyExactRange(input) {
      const content = {
        artifacts: [
          {
            digest: digestBytes(readFileSync(join(state.root, 'artifact.txt'))),
            path: 'artifact.txt',
            producer: 'synthetic',
          },
        ],
        base: { sha: input.baseSha, tree: input.baseTree },
        configDigest: input.configDigest,
        head: { sha: input.headSha, tree: input.headTree },
        opaquePayload: 'synthetic proof',
        policyDigest: state.policyDigest,
        producer: 'synthetic',
        repository: input.repository,
        schemaVersion: 'ai-delivery.policy-evidence@1' as const,
      };
      return {
        policyDigest: state.policyDigest,
        policyEvidence: { ...content, evidenceId: hash(content) },
        requiredStages: [definition],
        risk,
      };
    },
    validateBoundary(input) {
      const content = {
        additionalConstraints: { exactBaseHeadLease: true, requiredAttestationIds: [] },
        classificationReceiptId: input.classificationReceiptId,
        configDigest: input.configDigest,
        currentBase: input.currentBase,
        currentHead: input.currentHead,
        phase: input.phase,
        policyEvidenceId: input.policyEvidence.evidenceId,
        schemaVersion: 'ai-delivery.policy-boundary@1' as const,
        stageReceiptSetHash: hash(input.stageReceiptIds),
      };
      return { ...content, boundaryId: hash(content) };
    },
  };
}

function proof(state: ReturnType<typeof setup>, policy = makePolicy(state)) {
  const classification = classifyRepositoryExactRange({
    repoRoot: state.root,
    repository: 'example/delivery',
    base: state.base,
    head: state.head,
    changedPaths: ['change.txt'],
    configDigest: state.configDigest,
    policySourcePath: './policy.mjs',
    policy,
  });
  const stageInput = createRepositoryStageInput({
    classification,
    environmentDigest: digestValue('environment'),
    semanticInputs: [{ digest: digestValue(state.head.tree), key: 'source' }],
    stageId: 'check',
    upstream: [],
  });
  const outputDigest = writeRepositoryCommandOutput({
    bytes: Buffer.from('node 22'),
    gitCommonDir: state.gitCommonDir,
  });
  const receipt = createRepositoryStageReceipt({
    classification,
    stageInput,
    artifacts: [{ digest: digestBytes(readFileSync(join(state.root, 'output.txt'))), path: 'output.txt' }],
    commands: [{ exitCode: 0, label: 'check', outputDigest }],
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
  });
  const aggregate = createRepositoryStageAggregate({ classification, receipts: [receipt] });
  const input = {
    aggregate,
    classification,
    approvalRoles: { authorIdentity: 'author', reviewerIdentity: 'reviewer' },
    configDigest: state.configDigest,
    currentBase: state.base,
    currentHead: state.head,
    gitCommonDir: state.gitCommonDir,
    phase: 'verify' as const,
    policy,
    policySourcePath: './policy.mjs',
    repoRoot: state.root,
    stageReceipts: [receipt],
  };
  return { classification, stageInput, receipt, aggregate, input };
}

test('synthetic exact delivery, private checkpoint resume and phase evidence', async () => {
  const state = setup();
  try {
    const selected = await loadSelectedRepositoryPolicy({ repoRoot: state.root, policySourcePath: './policy.mjs' });
    assert.equal(selected.policyDigest, state.policyDigest);
    const p = proof(state);
    writeRepositoryStageCheckpoint({ gitCommonDir: state.gitCommonDir, receipt: p.receipt, repoRoot: state.root });
    assert.equal(
      loadRepositoryStageCheckpoint({
        gitCommonDir: state.gitCommonDir,
        stageInput: p.stageInput,
        classification: p.classification,
        repoRoot: state.root,
        configDigest: state.configDigest,
        policySourcePath: './policy.mjs',
      })?.receiptId,
      p.receipt.receiptId,
    );
    const evidence = createRepositoryDeliveryEvidence(p.input);
    writeRepositoryDeliveryEvidence({ evidence, gitCommonDir: state.gitCommonDir });
    assert.equal(
      loadValidRepositoryDeliveryEvidence({ createInput: p.input, evidenceId: evidence.evidenceId }).evidenceId,
      evidence.evidenceId,
    );
  } finally {
    state.cleanup();
  }
});

test('missing policy, wrong repository, changed config and stale head fail closed', async () => {
  const state = setup();
  try {
    await assert.rejects(loadSelectedRepositoryPolicy({ repoRoot: state.root, policySourcePath: 'missing.mjs' }));
    const policy = makePolicy(state);
    assert.throws(() =>
      classifyRepositoryExactRange({
        repoRoot: state.root,
        repository: 'wrong/repository',
        base: state.base,
        head: state.head,
        changedPaths: ['change.txt'],
        configDigest: state.configDigest,
        policySourcePath: './policy.mjs',
        policy: {
          ...policy,
          classifyExactRange: (input) => policy.classifyExactRange({ ...input, repository: 'example/delivery' }),
        },
      }),
    );
    const p = proof(state, policy);
    assert.throws(() => createRepositoryDeliveryEvidence({ ...p.input, configDigest: digestValue('drift') }));
    assert.throws(() =>
      createRepositoryDeliveryEvidence({ ...p.input, currentHead: { ...state.head, tree: state.base.tree } }),
    );
    writeFileSync(join(state.root, 'policy.mjs'), 'export default {};\n');
    assert.throws(() => createRepositoryDeliveryEvidence(p.input));
  } finally {
    state.cleanup();
  }
});

test('missing stage, corrupt artifact/output and blocked merge or wrong approval fail closed', () => {
  const state = setup();
  try {
    const p = proof(state);
    assert.throws(() => createRepositoryStageAggregate({ classification: p.classification, receipts: [] }));
    const approval = {
      authorIdentity: 'author',
      reviewerIdentity: 'author',
      diffScopeHash: digestValue(['change.txt']),
      head: state.head,
      result: 'approved' as const,
      reviewReceiptId: digestValue('review'),
    };
    assert.throws(() => createRepositoryDeliveryEvidence({ ...p.input, phase: 'merge', approval }));
    const validApproval = { ...approval, reviewerIdentity: 'reviewer' };
    assert.throws(() =>
      createRepositoryDeliveryEvidence({
        ...p.input,
        phase: 'merge',
        approval: { ...validApproval, reviewerIdentity: 'outsider' },
      }),
    );
    assert.throws(() =>
      createRepositoryDeliveryEvidence({
        ...p.input,
        phase: 'merge',
        approval: validApproval,
        now: () => new Date('2026-01-01T00:00:10.000Z'),
        mergeReadback: {
          blockedBy: [17],
          checksPassed: true,
          head: state.head,
          mergeable: true,
          observedAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    );
    writeFileSync(join(state.root, 'artifact.txt'), 'tampered');
    assert.throws(() => createRepositoryDeliveryEvidence(p.input));
    writeFileSync(join(state.root, 'artifact.txt'), 'proof');
    writeFileSync(join(state.root, 'output.txt'), 'tampered stage artifact');
    assert.throws(() => createRepositoryDeliveryEvidence(p.input));
    writeFileSync(join(state.root, 'output.txt'), 'stage artifact');
    const outputPath = join(
      state.gitCommonDir,
      'ai-delivery',
      'verification@1',
      'command-output',
      `${p.receipt.commands[0]!.outputDigest.slice(7)}.bin`,
    );
    writeFileSync(outputPath, 'corrupt command output');
    assert.throws(() => createRepositoryDeliveryEvidence(p.input));
    const bad: RepositoryStageReceipt = {
      ...p.receipt,
      commands: [{ ...p.receipt.commands[0]!, outputDigest: digestValue('absent') }],
    };
    assert.throws(() => createRepositoryDeliveryEvidence({ ...p.input, stageReceipts: [bad] }));
  } finally {
    state.cleanup();
  }
});
