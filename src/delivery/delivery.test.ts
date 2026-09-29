import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('explicit component policy reuses compatible stages across heads and invalidates dependencies', () => {
  const state = setup();
  try {
    const legacy = makePolicy(state);
    let component = digestValue('component a');
    const policy = {
      ...legacy,
      schemaVersion: 'RepositoryDeliveryPolicy@2',
      classifyExactRange(input: Parameters<RepositoryDeliveryPolicy['classifyExactRange']>[0]) {
        const selected = legacy.classifyExactRange(input);
        const definition = selected.requiredStages[0]!;
        return {
          ...selected,
          requiredStages: [
            {
              ...definition,
              semanticInputKeys: ['B', 'a'],
              semanticInputs: [
                { key: 'B', digest: component },
                { key: 'a', digest: digestValue('mixed-case component') },
              ],
            },
            { ...definition, id: 'independent', semanticInputs: [{ key: 'source', digest: digestValue('b') }] },
            {
              ...definition,
              id: 'downstream',
              dependsOn: ['check'],
              semanticInputs: [{ key: 'source', digest: digestValue('c') }],
            },
          ],
        };
      },
    } as unknown as RepositoryDeliveryPolicy;
    const classify = () =>
      classifyRepositoryExactRange({
        repoRoot: state.root,
        repository: 'example/delivery',
        base: state.base,
        head: { sha: git(state.root, 'rev-parse', 'HEAD'), tree: git(state.root, 'rev-parse', 'HEAD^{tree}') },
        changedPaths: git(state.root, 'diff', '--name-only', state.base.sha, 'HEAD').split('\n'),
        configDigest: state.configDigest,
        policySourcePath: './policy.mjs',
        policy,
      });
    const inputs = (classification: ReturnType<typeof classify>, receipts: RepositoryStageReceipt[] = []) =>
      classification.requiredStages.map((stage) =>
        createRepositoryStageInput({
          classification,
          environmentDigest: digestValue('producer/worktree/environment'),
          stageId: stage.id,
          semanticInputs: (stage as unknown as { semanticInputs: { key: string; digest: string }[] }).semanticInputs,
          upstream: stage.dependsOn.map((stageId) => ({
            stageId,
            receiptId: receipts.find((r) => r.input.stageId === stageId)!.receiptId,
          })),
        }),
      );
    const first = classify();
    const outputDigest = writeRepositoryCommandOutput({
      bytes: Buffer.from('passed'),
      gitCommonDir: state.gitCommonDir,
    });
    const receipts: RepositoryStageReceipt[] = [];
    for (const stage of first.requiredStages) {
      const stageInput = createRepositoryStageInput({
        classification: first,
        stageId: stage.id,
        environmentDigest: digestValue('producer/worktree/environment'),
        semanticInputs: stage.semanticInputs!,
        upstream: stage.dependsOn.map((stageId) => ({
          stageId,
          receiptId: receipts.find((r) => r.input.stageId === stageId)!.receiptId,
        })),
      });
      const receipt = createRepositoryStageReceipt({
        classification: first,
        stageInput,
        artifacts: [],
        commands: [{ exitCode: 0, label: 'check', outputDigest }],
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:01.000Z',
      });
      receipts.push(receipt);
      writeRepositoryStageCheckpoint({ gitCommonDir: state.gitCommonDir, receipt, repoRoot: state.root });
    }
    writeFileSync(join(state.root, 'unrelated.txt'), 'documentation');
    git(state.root, 'add', '.');
    git(state.root, 'commit', '-qm', 'unrelated');
    const current = classify();
    assert.notEqual(current.receiptId, first.receiptId);
    const currentInputs = inputs(current, receipts);
    for (const [index, stageInput] of currentInputs.entries()) {
      assert.equal(stageInput.inputId, receipts[index]!.input.inputId);
      assert.equal(
        loadRepositoryStageCheckpoint({
          gitCommonDir: state.gitCommonDir,
          stageInput,
          classification: current,
          repoRoot: state.root,
          configDigest: state.configDigest,
          policySourcePath: './policy.mjs',
        })?.receiptId,
        receipts[index]!.receiptId,
      );
    }
    assert.equal(
      createRepositoryStageAggregate({ classification: current, receipts }).classificationReceiptId,
      current.receiptId,
    );
    component = digestValue('changed component a');
    const changed = classify();
    const changedInputs = inputs(changed, receipts);
    assert.notEqual(changedInputs[0]!.inputId, currentInputs[0]!.inputId);
    assert.equal(changedInputs[1]!.inputId, currentInputs[1]!.inputId);
    assert.throws(() => createRepositoryStageAggregate({ classification: changed, receipts }));
    assert.throws(() =>
      createRepositoryStageInput({
        classification: changed,
        stageId: 'check',
        environmentDigest: digestValue('producer/worktree/environment'),
        upstream: [],
        semanticInputs: [{ key: 'source', digest: digestValue('inferred value') }],
      }),
    );
    const replacement = createRepositoryStageReceipt({
      classification: changed,
      stageInput: changedInputs[0]!,
      artifacts: [],
      commands: [{ exitCode: 0, label: 'check', outputDigest }],
      startedAt: '2026-01-02T00:00:00.000Z',
      completedAt: '2026-01-02T00:00:01.000Z',
    });
    assert.notEqual(inputs(changed, [replacement])[2]!.inputId, currentInputs[2]!.inputId);
    assert.throws(() =>
      classifyRepositoryExactRange({
        repoRoot: state.root,
        repository: current.repository,
        base: current.base,
        head: current.head,
        changedPaths: current.changedPaths,
        configDigest: state.configDigest,
        policySourcePath: './policy.mjs',
        policy: { ...policy, schemaVersion: 'RepositoryDeliveryPolicy@1' },
      }),
    );
  } finally {
    state.cleanup();
  }
});

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

test('separate processes can read and reuse shared output during publication and after publisher interruption', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-delivery-publication-'));
  const ready = join(directory, 'ready');
  const release = join(directory, 'release');
  const moduleUrl = new URL('./stage.js', import.meta.url).href;
  const input = { gitCommonDir: directory };
  const publish = `const {writeRepositoryCommandOutput}=await import(${JSON.stringify(moduleUrl)});writeRepositoryCommandOutput({ ...${JSON.stringify(input)}, bytes: Buffer.from('shared immutable output') });`;
  const worker = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    for (const key of ['linkSync','renameSync']) { const original=fs[key]; fs[key]=(...args)=>{
      const result=original(...args); if(String(args[1]).endsWith('.bin')) {
        fs.writeFileSync(${JSON.stringify(ready)},'published');
        while(!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
      } return result;
    }; } syncBuiltinESMExports(); ${publish}
  `,
    ],
    { stdio: 'ignore' },
  );
  const closed = new Promise((resolve) => worker.once('close', resolve));
  try {
    for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(existsSync(ready));
    const peer = spawnSync(process.execPath, ['--input-type=module', '-e', publish], {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 32_768,
    });
    assert.equal(peer.status, 0, peer.stderr);
    worker.kill('SIGKILL');
    await closed;
    const output = writeRepositoryCommandOutput({ ...input, bytes: Buffer.from('shared immutable output') });
    assert.match(output, /^sha256:/u);
    console.log(
      'SHARED_OUTPUT_PUBLICATION_RECEIPT',
      JSON.stringify({ peerSucceeded: true, interruptedPublisherOutputReused: true, digest: output }),
    );
  } finally {
    writeFileSync(release, 'ready');
    if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
    await closed;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('separate processes durably create shared writer directories and reject a raced non-directory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-delivery-directory-'));
  const shared = join(directory, 'shared');
  const target = join(shared, 'writers@1');
  const release = join(directory, 'release');
  const moduleUrl = new URL('../utils/atomicJson.js', import.meta.url).href;
  const workers = [0, 1].map((index) => {
    const ready = join(directory, `ready-${String(index)}`);
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      const original=fs.mkdirSync; fs.mkdirSync=(path, options)=>{
        if(path===${JSON.stringify(shared)}) {
          fs.writeFileSync(${JSON.stringify(ready)},'ready');
          while(!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
        } return original(path,options);
      }; syncBuiltinESMExports();
      const {writePrivateJsonFileAtomically}=await import(${JSON.stringify(moduleUrl)});
      writePrivateJsonFileAtomically(${JSON.stringify(join(target, `${String(index)}.json`))},{peer:${String(index)}});
    `,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
    return { child, ready, closed, stderr: () => stderr };
  });
  try {
    for (let attempt = 0; attempt < 100 && !workers.every((worker) => existsSync(worker.ready)); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(workers.every((worker) => existsSync(worker.ready)));
    writeFileSync(release, 'ready');
    const statuses = await Promise.all(workers.map((worker) => worker.closed));
    workers.forEach((worker, index) => assert.equal(statuses[index], 0, worker.stderr()));
    for (const index of [0, 1])
      assert.deepEqual(JSON.parse(readFileSync(join(target, `${String(index)}.json`), 'utf8')), { peer: index });
    const racedFile = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      const original=fs.mkdirSync; fs.mkdirSync=(path,options)=>{
        if(path===${JSON.stringify(join(directory, 'raced-file'))}) fs.writeFileSync(path,'unsafe');
        return original(path,options);
      }; syncBuiltinESMExports();
      const {ensurePrivateDirectoryDurably}=await import(${JSON.stringify(moduleUrl)});
      ensurePrivateDirectoryDurably(${JSON.stringify(join(directory, 'raced-file'))});
    `,
      ],
      { encoding: 'utf8', timeout: 2_000, maxBuffer: 32_768 },
    );
    assert.notEqual(racedFile.status, 0);
    assert.match(racedFile.stderr, /directory/u);
  } finally {
    writeFileSync(release, 'ready');
    for (const worker of workers)
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL');
    await Promise.all(workers.map((worker) => worker.closed));
    rmSync(directory, { recursive: true, force: true });
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
    assert.throws(() =>
      createRepositoryDeliveryEvidence({
        ...p.input,
        policy: { ...policy, schemaVersion: 'RepositoryDeliveryPolicy@99' } as unknown as RepositoryDeliveryPolicy,
      }),
    );
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
