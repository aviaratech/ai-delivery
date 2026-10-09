import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, test, vi } from 'vitest';
import { digestValue } from './delivery/common.js';
import { withRuntimeSetupWriter, type VerificationResourceBounds } from './verification.js';

let node26Package: { executable: string; root: string; temporary: string } | undefined;
const scripts = new Map<string, string>();
async function fixture(input: { firstStageScript?: string } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-runtime-runner-')));
  execFileSync('git', ['init', '-q', root]);
  scripts.set(root, input.firstStageScript ?? '');
  return { root };
}
async function hostFixtureCheckout(input: {
  repoRoot: string;
  issueNumber: number;
  identity: string;
  baseRef: string;
}) {
  return { path: input.repoRoot };
}
async function runRuntimeFixture(input: {
  repoRoot: string;
  issueNumber: number;
  resourceBounds: VerificationResourceBounds;
  signal?: AbortSignal;
}) {
  return withRuntimeSetupWriter(input.repoRoot, (runner) =>
    runner.run([process.execPath, '-e', scripts.get(input.repoRoot)!], input.resourceBounds, input.signal),
  );
}
afterAll(() => {
  if (node26Package) rmSync(node26Package.temporary, { recursive: true, force: true });
});

function packedNode26Consumer(): { executable: string; root: string; temporary: string } {
  if (node26Package !== undefined) return node26Package;
  assert.equal(process.version, 'v24.21.0', 'canonical verification controller must remain Node 24.21.0');
  const executable = process.env['AI_DELIVERY_NODE26_EXECUTABLE'];
  assert.ok(executable, 'set AI_DELIVERY_NODE26_EXECUTABLE to the actual Node 26.2.0 executable');
  assert.equal(execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim(), 'v26.2.0');
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-node26-')));
  try {
    const source = fileURLToPath(new URL('../', import.meta.url));
    const pack = JSON.parse(
      execFileSync('npm', ['pack', '--json', '--pack-destination', temporary], {
        cwd: source,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      }),
    ) as [{ filename: string }];
    execFileSync('tar', ['-xzf', join(temporary, pack[0].filename), '-C', temporary]);
    const root = join(temporary, 'package');
    symlinkSync(join(source, 'node_modules'), join(root, 'node_modules'), 'dir');
    process.stderr.write(
      `ai-delivery.node26-consumer ${JSON.stringify({
        controller: process.version,
        consumer: 'v26.2.0',
        archiveSha256: createHash('sha256')
          .update(readFileSync(join(temporary, pack[0].filename)))
          .digest('hex'),
        manifestSha256: createHash('sha256')
          .update(readFileSync(join(root, 'package.json')))
          .digest('hex'),
      })}\n`,
    );
    node26Package = { executable: realpathSync(executable), root, temporary };
    return node26Package;
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function node26ConsumerScript(script: string): string {
  const consumer = packedNode26Consumer();
  return `
require('node:assert/strict').equal(process.version, 'v24.21.0');
const child = require('node:child_process').spawnSync(${JSON.stringify(consumer.executable)}, ['-e', ${JSON.stringify(script)}], { cwd: ${JSON.stringify(consumer.root)}, stdio: 'inherit' });
if (child.error) throw child.error;
process.exit(child.status ?? 1);`;
}

function filesystemFixtureScript(
  output: string,
  mode: 'pass' | 'assertion' | 'abrupt' | 'block' | 'cancel',
  runtime: 'node24' | 'node26' = 'node24',
): string {
  const script = `
(async () => {
  const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path'), assert = require('node:assert/strict');
  assert.equal(process.version, ${JSON.stringify(runtime === 'node26' ? 'v26.2.0' : 'v24.21.0')});
  const { withVerificationFilesystemFixture } = await import(${JSON.stringify(runtime === 'node26' ? '@aviaratech/ai-delivery/agent' : new URL('./agent.js', import.meta.url).href)});
  const { loadValidRepositoryDeliveryEvidence } = await import(${JSON.stringify(runtime === 'node26' ? new URL('./delivery/evidence.js', import.meta.url).href : new URL('./delivery/evidence.js', import.meta.url).href)});
  const output = ${JSON.stringify(output)}, fifo = path.join(output, 'fifo'), events = path.join(output, 'events');
  const evidenceId = 'sha256:' + 'a'.repeat(64), currentHead = { sha: 'b'.repeat(40), tree: 'c'.repeat(40) };
  const evidence = path.join(output, 'ai-delivery', 'receipts', 'delivery@1', currentHead.sha, evidenceId.slice(7) + '.json');
  fs.mkdirSync(path.dirname(evidence), { recursive: true });
  const rejectPrivateFile = file => {
    fs.renameSync(file, evidence);
    try { assert.throws(() => loadValidRepositoryDeliveryEvidence({ createInput: { gitCommonDir: output, currentHead }, evidenceId }), /private regular file/); }
    finally { fs.renameSync(evidence, file); }
  };
  const gate = JSON.parse(process.env.AI_DELIVERY_OUTPUT_OBSERVATION_GATE);
  const trace = value => fs.appendFileSync(events, value + '\\n');
  await withVerificationFilesystemFixture(async () => {
    cp.execFileSync('mkfifo', ['-m', '600', fifo]);
    fs.writeFileSync(path.join(output, 'capability'), JSON.stringify(gate));
    trace('created');
    try {
      if (${JSON.stringify(mode)} === 'abrupt') process.exit(9);
      if (${JSON.stringify(mode)} === 'cancel') await new Promise(() => { setInterval(() => {}, 1000); });
      if (${JSON.stringify(mode)} === 'block') fs.readFileSync(fifo);
      while (fs.readdirSync(path.join(gate.directory, 'requests')).length === 0) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(fs.existsSync(fifo)); trace('scan-queued');
      rejectPrivateFile(fifo); trace('reader-rejected');
      const regular = path.join(output, 'regular'), hard = path.join(output, 'hard'), alias = path.join(output, 'alias');
      fs.writeFileSync(regular, 'x'.repeat(128), { mode: 0o600 });
      fs.linkSync(regular, hard); rejectPrivateFile(hard); fs.unlinkSync(hard);
      fs.symlinkSync('./regular', alias); rejectPrivateFile(alias); fs.unlinkSync(alias);
      if (${JSON.stringify(mode)} === 'assertion') throw new Error('synthetic reader assertion failure');
    } finally { fs.unlinkSync(fifo); trace('cleaned'); }
  });
  trace('released');
})().catch(error => { console.error(error.message); process.exitCode = 1; });`;
  return runtime === 'node26' ? node26ConsumerScript(script) : script;
}

test.each([
  ['pass', 'node24'],
  ['assertion', 'node24'],
  ['pass', 'node26'],
  ['assertion', 'node26'],
] as const)(
  'filesystem fixture gate deterministically queues a scan through reader rejection and %s teardown on %s',
  async (mode, runtime) => {
    const output = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-fixture-gate-')));
    const { root } = await fixture({ firstStageScript: filesystemFixtureScript(output, mode, runtime) });
    try {
      const row = await hostFixtureCheckout({
        baseRef: 'main',
        identity: 'synthetic-author',
        issueNumber: 17,
        repoRoot: root,
      });
      const run = runRuntimeFixture({
        issueNumber: 17,
        repoRoot: row.path,
        resourceBounds: {
          maxAggregateRssBytes: 1_000_000_000,
          minFreeDiskBytes: 1,
          maxNewOutputBytes: 2048,
          outputRoots: [output],
        },
      });
      if (mode === 'assertion') await assert.rejects(run, /exit 1/u);
      else await run;
      assert.equal(existsSync(join(output, 'fifo')), false);
      const events = readFileSync(join(output, 'events'), 'utf8').trim().split('\n');
      assert.deepEqual(
        events,
        mode === 'pass'
          ? ['created', 'scan-queued', 'reader-rejected', 'cleaned', 'released']
          : ['created', 'scan-queued', 'reader-rejected', 'cleaned'],
      );
      const capability = JSON.parse(readFileSync(join(output, 'capability'), 'utf8')) as { directory: string };
      assert.equal(existsSync(capability.directory), false);
      assert.equal(readFileSync(join(output, 'regular'), 'utf8').length, 128);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true });
    }
  },
);

test.each([
  ['abrupt', 'node24'],
  ['block', 'node24'],
  ['cancel', 'node24'],
  ['abrupt', 'node26'],
  ['block', 'node26'],
  ['cancel', 'node26'],
] as const)(
  'filesystem fixture gate preserves leaked FIFO and unrelated files after %s on %s',
  async (mode, runtime) => {
    const output = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-fixture-failure-')));
    writeFileSync(join(output, 'unrelated'), 'preserved');
    const { root } = await fixture({ firstStageScript: filesystemFixtureScript(output, mode, runtime) });
    const controller = new AbortController();
    let running: Promise<unknown> | undefined;
    const progress = vi.spyOn(process.stderr, 'write');
    try {
      const row = await hostFixtureCheckout({
        baseRef: 'main',
        identity: 'synthetic-author',
        issueNumber: 17,
        repoRoot: root,
      });
      const bounds = {
        maxAggregateRssBytes: 1_000_000_000,
        minFreeDiskBytes: 1,
        maxNewOutputBytes: 2048,
        outputRoots: [output],
      };
      running = runRuntimeFixture({
        issueNumber: 17,
        repoRoot: row.path,
        resourceBounds: bounds,
        signal: controller.signal,
      }).catch((error: unknown) => error);
      if (mode === 'cancel') {
        for (let attempt = 0; attempt < 300 && !existsSync(join(output, 'capability')); attempt++)
          await new Promise((resolve) => setTimeout(resolve, 20));
        assert.ok(existsSync(join(output, 'capability')));
        const cap = JSON.parse(readFileSync(join(output, 'capability'), 'utf8')) as { directory: string };
        for (let attempt = 0; attempt < 300 && readdirSync(join(cap.directory, 'requests')).length === 0; attempt++)
          await new Promise((resolve) => setTimeout(resolve, 20));
        assert.ok(readdirSync(join(cap.directory, 'requests')).length > 0);
        controller.abort();
      }
      const failure = String(await running);
      assert.match(
        failure,
        mode === 'abrupt' ? /exit 9/u : mode === 'block' ? /reader or teardown is stalled/u : /cancelled/u,
      );
      assert.doesNotMatch(failure, /cleanup failed|live holder/u);
      const capability = JSON.parse(readFileSync(join(output, 'capability'), 'utf8')) as { directory: string };
      assert.equal(existsSync(capability.directory), false);
      assert.ok(existsSync(join(output, 'fifo')));
      assert.equal(readFileSync(join(output, 'unrelated'), 'utf8'), 'preserved');
      if (mode !== 'abrupt')
        assert.ok(progress.mock.calls.filter(([line]) => String(line).includes('sampledAggregateRssBytes')).length > 2);
      await assert.rejects(
        runRuntimeFixture({ issueNumber: 17, repoRoot: row.path, resourceBounds: bounds }),
        /unsupported file/u,
      );
    } finally {
      controller.abort();
      await running;
      progress.mockRestore();
      rmSync(root, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true });
    }
  },
);

test.each(['node24', 'node26'] as const)(
  'filesystem fixture gate still enforces positive byte limits after deterministic contention on %s',
  async (runtime) => {
    const output = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-fixture-limit-')));
    const { root } = await fixture({ firstStageScript: filesystemFixtureScript(output, 'pass', runtime) });
    try {
      const row = await hostFixtureCheckout({
        baseRef: 'main',
        identity: 'synthetic-author',
        issueNumber: 17,
        repoRoot: root,
      });
      await assert.rejects(
        runRuntimeFixture({
          issueNumber: 17,
          repoRoot: row.path,
          resourceBounds: {
            maxAggregateRssBytes: 1_000_000_000,
            minFreeDiskBytes: 1,
            maxNewOutputBytes: 64,
            outputRoots: [output],
          },
        }),
        /filesystem output.*exceeded/u,
      );
      assert.equal(existsSync(join(output, 'fifo')), false);
      assert.equal(readFileSync(join(output, 'regular'), 'utf8').length, 128);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true });
    }
  },
);

test.each(['verification', 'runtime'] as const)(
  'filesystem fixture gate preserves observation and cancellation after direct %s command closure',
  async (mode) => {
    const output = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-fixture-close-')));
    writeFileSync(join(output, 'unrelated'), 'preserved');
    const script = `
(async () => {
  const fs = require('node:fs'), cp = require('node:child_process');
  const child = cp.spawn(process.execPath, ['-e', ${JSON.stringify(filesystemFixtureScript(output, 'cancel'))}], { stdio: 'ignore' });
  child.unref();
  fs.writeFileSync(${JSON.stringify(join(output, 'pids'))}, JSON.stringify({ root: process.pid, descendant: child.pid }));
  while (!fs.existsSync(${JSON.stringify(join(output, 'exit-parent'))})) await new Promise(resolve => setTimeout(resolve, 10));
  process.exit(0);
})().catch(error => { console.error(error.message); process.exitCode = 1; });`;
    const { root } = await fixture({ firstStageScript: script });
    const controller = new AbortController();
    const progress = vi.spyOn(process.stderr, 'write');
    let running: Promise<unknown> | undefined;
    try {
      const row = await hostFixtureCheckout({
        baseRef: 'main',
        identity: 'synthetic-author',
        issueNumber: 17,
        repoRoot: root,
      });
      const bounds = {
        maxAggregateRssBytes: 1_000_000_000,
        minFreeDiskBytes: 1,
        maxNewOutputBytes: 4096,
        outputRoots: [output],
      };
      const { withRuntimeSetupWriter } = await import('./verification.js');
      running = (
        mode === 'verification'
          ? runRuntimeFixture({
              issueNumber: 17,
              repoRoot: row.path,
              resourceBounds: bounds,
              signal: controller.signal,
            })
          : withRuntimeSetupWriter(row.path, (runner) =>
              runner.run([process.execPath, '-e', script], bounds, controller.signal),
            )
      ).catch((error: unknown) => error);
      for (let attempt = 0; attempt < 300 && !existsSync(join(output, 'capability')); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(existsSync(join(output, 'capability')));
      const cap = JSON.parse(readFileSync(join(output, 'capability'), 'utf8')) as { directory: string };
      const pids = JSON.parse(readFileSync(join(output, 'pids'), 'utf8')) as { root: number; descendant: number };
      const writerPath = join(root, '.git', 'ai-delivery', 'writers@1', digestValue(row.path).slice(7) + '.json');
      const descendantObserved = (): boolean => {
        const state = JSON.parse(readFileSync(writerPath, 'utf8')) as { command: { tracked?: { pid: number }[] } };
        return state.command.tracked?.some((member) => member.pid === pids.descendant) === true;
      };
      for (
        let attempt = 0;
        attempt < 300 && (!descendantObserved() || readdirSync(join(cap.directory, 'requests')).length === 0);
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(descendantObserved());
      assert.ok(readdirSync(join(cap.directory, 'requests')).length > 0);
      writeFileSync(join(output, 'exit-parent'), 'exit');
      const parentAlive = (): boolean =>
        spawnSync('ps', ['-p', String(pids.root), '-o', 'stat='], { encoding: 'utf8' }).stdout.trim().length > 0;
      for (let attempt = 0; attempt < 100 && parentAlive(); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(parentAlive(), false);
      const samples = (): number =>
        progress.mock.calls.filter(([line]) => String(line).includes('sampledAggregateRssBytes')).length;
      const afterExit = samples();
      for (let attempt = 0; attempt < 100 && samples() === afterExit; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      const observedAfterExit = samples() > afterExit;
      controller.abort();
      const failure = String(await running);
      assert.match(failure, /cancelled/u);
      assert.doesNotMatch(failure, /cleanup failed|live holder/u);
      assert.ok(observedAfterExit, 'RSS and disk observation continues while the closed command awaits its scan');
      assert.equal(existsSync(cap.directory), false);
      assert.ok(existsSync(join(output, 'fifo')));
      assert.equal(readFileSync(join(output, 'unrelated'), 'utf8'), 'preserved');
      assert.equal(
        spawnSync('ps', ['-p', String(pids.descendant), '-o', 'stat='], { encoding: 'utf8' }).stdout.trim().length,
        0,
      );
      assert.equal(
        progress.mock.calls.some(([line]) => String(line).includes('"state":"completed"')),
        false,
      );
    } finally {
      controller.abort();
      await running;
      progress.mockRestore();
      rmSync(root, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true });
    }
  },
);

test('Node 26 packed public exports preserve standalone and malformed-capability behavior', () => {
  const consumer = packedNode26Consumer();
  execFileSync(
    consumer.executable,
    [
      '-e',
      `
(async () => {
  const assert = require('node:assert/strict');
  assert.equal(process.version, 'v26.2.0');
  const [root, agent, delivery, mcp] = await Promise.all([
    import('@aviaratech/ai-delivery'), import('@aviaratech/ai-delivery/agent'),
    import('@aviaratech/ai-delivery/delivery'), import('@aviaratech/ai-delivery/mcp'),
  ]);
  assert.equal(root.withVerificationFilesystemFixture, agent.withVerificationFilesystemFixture);
  assert.equal(typeof agent.verifyIssue, 'undefined');
  assert.equal(typeof delivery.loadValidRepositoryDeliveryEvidence, 'undefined');
  assert.equal(typeof mcp.createAiDeliveryMcpServer, 'function');
  const manifest = JSON.parse(require('node:fs').readFileSync('package.json', 'utf8'));
  assert.deepEqual(Object.keys(manifest.exports).sort(), ['.', './agent', './delivery', './mcp']);
  const prior = process.env.AI_DELIVERY_OUTPUT_OBSERVATION_GATE;
  delete process.env.AI_DELIVERY_OUTPUT_OBSERVATION_GATE;
  assert.equal(await agent.withVerificationFilesystemFixture(() => 'standalone'), 'standalone');
  process.env.AI_DELIVERY_OUTPUT_OBSERVATION_GATE = '{}';
  let executed = false;
  await assert.rejects(agent.withVerificationFilesystemFixture(() => { executed = true; }), /invalid or stale/);
  assert.equal(executed, false);
  if (prior === undefined) delete process.env.AI_DELIVERY_OUTPUT_OBSERVATION_GATE;
  else process.env.AI_DELIVERY_OUTPUT_OBSERVATION_GATE = prior;
})().catch(error => { console.error(error); process.exitCode = 1; });
`,
    ],
    { cwd: consumer.root, stdio: 'pipe' },
  );
});

test('filesystem fixture helper runs standalone and fails closed on malformed capability', async () => {
  const { withVerificationFilesystemFixture } = await import('./agent.js');
  assert.equal(await withVerificationFilesystemFixture(() => 'standalone'), 'standalone');
  const prior = process.env['AI_DELIVERY_OUTPUT_OBSERVATION_GATE'];
  try {
    process.env['AI_DELIVERY_OUTPUT_OBSERVATION_GATE'] = '{}';
    let executed = false;
    await assert.rejects(
      withVerificationFilesystemFixture(() => {
        executed = true;
      }),
      /invalid or stale/u,
    );
    assert.equal(executed, false);
  } finally {
    if (prior === undefined) delete process.env['AI_DELIVERY_OUTPUT_OBSERVATION_GATE'];
    else process.env['AI_DELIVERY_OUTPUT_OBSERVATION_GATE'] = prior;
  }
});

test('nested runtime setup inherits the outer gate for its baseline and child command', async () => {
  const output = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-nested-fixture-')));
  const inner = await fixture();
  const worker = filesystemFixtureScript(output, 'pass');
  const { root } = await fixture({
    firstStageScript: `
(async () => {
  const fs = require('node:fs'), cp = require('node:child_process'), assert = require('node:assert/strict');
  const { withRuntimeSetupWriter } = await import(${JSON.stringify(new URL('./verification.js', import.meta.url).href)});
  const capability = process.env.AI_DELIVERY_OUTPUT_OBSERVATION_GATE;
  const child = cp.spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], { stdio: ['ignore', 'inherit', 'inherit'] });
  const closed = new Promise((resolve, reject) => child.once('exit', code => code === 0 ? resolve() : reject(new Error('fixture child exit ' + code))));
  while (!fs.existsSync(${JSON.stringify(join(output, 'capability'))})) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fs.readFileSync(${JSON.stringify(join(output, 'capability'))}, 'utf8'), capability);
  await withRuntimeSetupWriter(${JSON.stringify(inner.root)}, async runner => {
    await runner.run([process.execPath, '-e', 'require("node:assert/strict").equal(process.env.AI_DELIVERY_OUTPUT_OBSERVATION_GATE, ' + JSON.stringify(capability) + ')'], { maxAggregateRssBytes: 1000000000, minFreeDiskBytes: 1, maxNewOutputBytes: 2048, outputRoots: [${JSON.stringify(output)}] });
  });
  await closed;
})().catch(error => { console.error(error.message); process.exitCode = 1; });`,
  });
  try {
    const row = await hostFixtureCheckout({
      baseRef: 'main',
      identity: 'synthetic-author',
      issueNumber: 17,
      repoRoot: root,
    });
    await runRuntimeFixture({
      issueNumber: 17,
      repoRoot: row.path,
      resourceBounds: {
        maxAggregateRssBytes: 1_000_000_000,
        minFreeDiskBytes: 1,
        maxNewOutputBytes: 2048,
        outputRoots: [output],
      },
    });
    assert.deepEqual(readFileSync(join(output, 'events'), 'utf8').trim().split('\n'), [
      'created',
      'scan-queued',
      'reader-rejected',
      'cleaned',
      'released',
    ]);
    assert.equal(existsSync(join(inner.root, '.git', 'ai-delivery', 'output-observation')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(inner.root, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});
