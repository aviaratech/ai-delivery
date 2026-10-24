import {
  producer,
  fixture,
  git,
  admitInput,
  beginControllerObservation,
  runtimeSetupState,
  type SetupInput,
  type Stage,
} from './fixtures/runtimeSetup.js';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  truncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { afterEach, test, vi } from 'vitest';

import { loadDeliveryConfig } from './config/deliveryConfig.js';
import * as privateFiles from './delivery/common.js';
import { digestBytes, digestValue } from './delivery/index.js';
import { assertDeliveryRuntimeAdmitted, type RuntimeAdmission } from './services/deliveryAdmission.js';
import * as atomicJson from './utils/atomicJson.js';

const { actors, controllerObservation, syncFailure, sharedOutputRead, retirementFailure } = runtimeSetupState;
afterEach(() => vi.unstubAllEnvs());

function assertReviewedResolved(actual: unknown, expected: string): void {
  try {
    assert.equal(actual, expected);
  } catch (cause) {
    if (!(cause instanceof assert.AssertionError)) throw cause;
    // Separate real construction sites make these lexical categories visible to the bounded frame projection.
    if (actual === undefined) throw new Error('Resolved closure metadata is absent', { cause });
    if (typeof actual !== 'string') throw new Error('Resolved closure metadata is not a string', { cause });
    if (actual.startsWith('file:')) {
      if (isAbsolute(actual.slice(5))) throw new Error('Resolved closure absolute file target differs', { cause });
      throw new Error('Resolved closure relative file target differs', { cause });
    }
    throw new Error('Resolved closure metadata has another mismatch', { cause });
  }
}

test('resolved closure diagnostics preserve strict equality and the original assertion', () => {
  const expected = 'file:/expected/reviewed-archive.tgz';
  assert.doesNotThrow(() => assertReviewedResolved(expected, expected));
  const origins = new Map<string, string>();
  const cases: [unknown, string][] = [
    [undefined, 'Resolved closure metadata is absent'],
    [null, 'Resolved closure metadata is not a string'],
    [42, 'Resolved closure metadata is not a string'],
    [{ privateValue: true }, 'Resolved closure metadata is not a string'],
    ['file:reviewed-archive.tgz', 'Resolved closure relative file target differs'],
    ['file:', 'Resolved closure relative file target differs'],
    ['file:/different/reviewed-archive.tgz', 'Resolved closure absolute file target differs'],
    ['private-value', 'Resolved closure metadata has another mismatch'],
  ];
  for (const [actual, message] of cases) {
    const equal: typeof assert.equal = assert.equal;
    let original: Error | undefined;
    let properties: PropertyDescriptorMap | undefined;
    const observer = vi.spyOn(assert, 'equal').mockImplementationOnce((...args) => {
      try {
        equal(...args);
      } catch (error) {
        assert.ok(error instanceof Error);
        original = error;
        void error.stack;
        properties = Object.getOwnPropertyDescriptors(error);
        throw error;
      }
    });
    let failure: unknown;
    try {
      assertReviewedResolved(actual, expected);
    } catch (error) {
      failure = error;
    } finally {
      observer.mockRestore();
    }
    assert.ok(original instanceof assert.AssertionError);
    assert.ok(failure instanceof Error && !(failure instanceof assert.AssertionError));
    assert.equal(failure.message, message);
    assert.equal(failure.cause, original);
    assert.deepEqual(Object.getOwnPropertyDescriptors(original), properties);
    assert.equal(original.actual, actual);
    assert.equal(original.expected, expected);
    assert.equal(original.operator, 'strictEqual');
    const origin = failure.stack?.split('\n').find((line) => line.includes('at assertReviewedResolved '));
    assert.ok(origin);
    const previous = origins.get(message);
    if (previous !== undefined) assert.equal(origin, previous);
    else origins.set(message, origin);
  }
  assert.equal(new Set(origins.values()).size, 5);
});

test('resolved closure diagnostics preserve unexpected errors unchanged', () => {
  const unexpected = new Error('Synthetic unexpected assertion failure');
  const observer = vi.spyOn(assert, 'equal').mockImplementationOnce(() => {
    throw unexpected;
  });
  try {
    assert.throws(
      () => assertReviewedResolved(undefined, 'file:/expected/reviewed-archive.tgz'),
      (error) => error === unexpected,
    );
  } finally {
    observer.mockRestore();
  }
});

test('resolved closure diagnostics retain distinct closure invocation coordinates within four frames', () => {
  const closure = () => assertReviewedResolved(undefined, 'file:/expected/reviewed-archive.tgz');
  const failures: Error[] = [];
  try {
    closure();
  } catch (error) {
    assert.ok(error instanceof Error);
    failures.push(error);
  }
  try {
    closure();
  } catch (error) {
    assert.ok(error instanceof Error);
    failures.push(error);
  }
  assert.equal(failures.length, 2);
  const frames = failures.map((error) =>
    error.stack
      ?.split('\n')
      .flatMap((line) => {
        const coordinate = /setup\.test\.(?:ts|js):(\d+):(\d+)\)?$/.exec(line);
        return coordinate ? [coordinate.slice(1).join(':')] : [];
      })
      .slice(0, 4),
  );
  assert.equal(frames[0]?.length, 3);
  assert.equal(frames[1]?.length, 3);
  assert.deepEqual(frames[0]?.slice(0, 2), frames[1]?.slice(0, 2));
  assert.notEqual(frames[0]?.[2], frames[1]?.[2]);
});

test(
  'native stage binds exact copied runtime paths and bytes, reuses and admits only that completed stage',
  { tags: ['release'] },
  async () => {
    const f = await fixture(true);
    try {
      const api = await producer();
      const staged = await api.stageRuntime(f.input);
      assert.equal(staged.admission.cliPath, join(f.input.nativePluginRoot!, 'runtime', 'dist', 'cli.js'));
      assert.equal(staged.admission.mcpLauncherPath, join(f.input.nativePluginRoot!, 'dist', 'mcp-launcher.js'));
      const record = readFileSync(join(f.input.runtimeDirectory, 'runtime-stage.json'));
      assert.equal((await api.stageRuntime(f.input)).reused, true);
      assert.deepEqual(readFileSync(join(f.input.runtimeDirectory, 'runtime-stage.json')), record);
      assert.equal(readFileSync(f.counter, 'utf8'), 'x');
      const other = join(f.base, 'other-native-plugin');
      cpSync(f.input.nativePluginRoot!, other, { recursive: true });
      await assert.rejects(api.stageRuntime({ ...f.input, nativePluginRoot: other }), /incompatible setup intent/u);
      const admitted = await api.admitRuntime(admitInput(f.input, staged.stageId));
      assert.equal(admitted.admission.admissionId, staged.admission.admissionId);
      assert.equal((await api.admitRuntime(admitInput(f.input, staged.stageId))).reused, true);
      const readback = await assertDeliveryRuntimeAdmitted({
        repoRoot: f.root,
        runtimeEntryPath: staged.admission.cliPath,
      });
      assert.equal(readback.admissionId, staged.admission.admissionId);
      writeFileSync(join(f.input.nativePluginRoot!, 'README.md'), 'Changed native plugin bytes.\n');
      await assert.rejects(api.stageRuntime(f.input), /native plugin.*reviewed/iu);
      await assert.rejects(api.admitRuntime(admitInput(f.input, staged.stageId)), /native plugin.*reviewed/iu);
    } finally {
      f.cleanup();
    }
  },
);

test(
  'native stage refuses unreviewed cache bytes without completing or mutating the cache',
  { tags: ['release'] },
  async () => {
    const f = await fixture(true);
    try {
      const api = await producer();
      const target = join(f.input.nativePluginRoot!, 'runtime', 'dist', 'cli.js');
      const altered = 'console.log("unreviewed");\n';
      writeFileSync(target, altered);
      await assert.rejects(api.stageRuntime(f.input), /native plugin.*reviewed/iu);
      assert.equal(readFileSync(target, 'utf8'), altered);
      assert.equal(existsSync(join(f.root, '.git', 'ai-delivery', 'runtime-admission.json')), false);
      assert.equal(existsSync(f.input.runtimeDirectory), false);
    } finally {
      f.cleanup();
    }
  },
);

test('native stage rejects aliased or overlapping cache paths before installing', { tags: ['release'] }, async () => {
  const f = await fixture(true);
  try {
    const api = await producer();
    const alias = join(f.base, 'native-alias');
    symlinkSync(f.input.nativePluginRoot!, alias);
    await assert.rejects(api.stageRuntime({ ...f.input, nativePluginRoot: alias }), /symbolic link/u);
    await assert.rejects(api.stageRuntime({ ...f.input, nativePluginRoot: f.base }), /overlap/iu);
    assert.equal(existsSync(f.counter), false);
  } finally {
    f.cleanup();
  }
});

test('runtime-stage controller memory is bounded before authenticated preflight', { tags: ['release'] }, async () => {
  const api = await producer();
  const f = await fixture();
  try {
    await assert.rejects(
      api.stageRuntime({
        ...f.input,
        resourceBounds: { maxAggregateRssBytes: 1, minFreeDiskBytes: 1, maxNewOutputBytes: 128 * 1024 ** 2 },
      }),
      /RSS.*limit|RSS.*bound/u,
    );
    assert.equal(actors.authorCalls, 0, 'over-budget controller must not start authenticated preflight');
    assert.equal(existsSync(f.counter), false);
    assert.equal(existsSync(f.input.runtimeDirectory), false);
  } finally {
    f.cleanup();
  }
});

test('runtime-stage controller growth during preflight fails before installing', { tags: ['release'] }, async () => {
  const api = await producer();
  const f = await fixture();
  const memoryUsage = process.memoryUsage.bind(process);
  const memory = vi.spyOn(process, 'memoryUsage').mockImplementation(() => ({
    ...memoryUsage(),
    rss: actors.authorCalls === 0 ? 64 * 1024 ** 2 : 1024 ** 3,
  }));
  try {
    beginControllerObservation('healthy-controller');
    await assert.rejects(
      api.stageRuntime({
        ...f.input,
        resourceBounds: {
          maxAggregateRssBytes: 512 * 1024 ** 2,
          minFreeDiskBytes: 1,
          maxNewOutputBytes: 128 * 1024 ** 2,
        },
      }),
      /RSS.*limit|RSS.*bound/u,
    );
    assert.ok(actors.authorCalls > 0);
    assert.equal(existsSync(f.counter), false, 'preflight failure must not release the npm command');
    assert.equal(existsSync(f.input.runtimeDirectory), false);
  } finally {
    try {
      memory.mockRestore();
    } finally {
      try {
        f.cleanup();
      } finally {
        controllerObservation.mode = 'native';
      }
    }
  }
});

test(
  'runtime-stage unavailable initial controller observation refuses preflight and installer release',
  { tags: ['release'] },
  async () => {
    const api = await producer();
    const f = await fixture();
    try {
      beginControllerObservation('unavailable-controller');
      await assert.rejects(
        api.stageRuntime({
          ...f.input,
          resourceBounds: {
            maxAggregateRssBytes: 512 * 1024 ** 2,
            minFreeDiskBytes: 1,
            maxNewOutputBytes: 128 * 1024 ** 2,
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.name, 'DeliveryError');
          const prefix = 'Owned process resource observation failed. ';
          assert.ok(error.message.startsWith(prefix));
          const metadata = JSON.parse(error.message.slice(prefix.length)) as Record<string, unknown>;
          assert.ok(typeof metadata.elapsedMs === 'number' && Number.isSafeInteger(metadata.elapsedMs));
          assert.ok(metadata.elapsedMs >= 0);
          assert.deepEqual(metadata, {
            status: null,
            errorCode: 'ETIMEDOUT',
            signal: 'SIGTERM',
            stdoutPresent: true,
            stdoutTerminated: false,
            elapsedMs: metadata.elapsedMs,
            stdoutBytes: 0,
            completeLines: 0,
          });
          return true;
        },
      );
      assert.equal(actors.authorCalls, 0, 'unavailable observation must refuse before authenticated preflight');
      assert.equal(existsSync(f.counter), false, 'unavailable observation must not release the npm command');
      assert.equal(existsSync(f.input.runtimeDirectory), false);
    } finally {
      try {
        f.cleanup();
      } finally {
        controllerObservation.mode = 'native';
      }
    }
  },
);

for (const interruption of ['resource breach', 'caller cancellation'] as const) {
  test(
    `runtime-stage ${interruption} aborts a delayed preflight request and releases ownership before continuation`,
    { tags: ['release'] },
    async () => {
      const api = await producer();
      const f = await fixture();
      const cancellation = new AbortController();
      const actualMemory = process.memoryUsage.bind(process);
      const memory = vi.spyOn(process, 'memoryUsage').mockImplementation(() => ({
        ...actualMemory(),
        rss: interruption === 'resource breach' && actors.authorStarted ? 1024 ** 3 : 64 * 1024 ** 2,
      }));
      actors.pauseAuthor = true;
      try {
        const rejected = assert.rejects(
          api.stageRuntime({
            ...f.input,
            signal: cancellation.signal,
            resourceBounds: {
              maxAggregateRssBytes: 512 * 1024 ** 2,
              minFreeDiskBytes: 1,
              maxNewOutputBytes: 128 * 1024 ** 2,
              maxCapturedOutputBytes: 1024 ** 2,
            },
          }),
          interruption === 'resource breach' ? /aggregate RSS .* exceeded limit/u : /cancelled/u,
        );
        if (interruption === 'caller cancellation') {
          while (!actors.authorStarted) await new Promise((resolve) => setTimeout(resolve, 10));
          cancellation.abort();
        }
        await rejected;
        assert.equal(actors.authorAborted, true, 'in-flight author request must receive scope cancellation');
        assert.equal(actors.reviewerCalls, 0, 'reviewer preflight must not continue after detection');
        assert.equal(existsSync(f.counter), false);
        assert.equal(existsSync(f.input.runtimeDirectory), false);
        assert.equal(digestBytes(readFileSync(f.input.archivePath)), f.input.expectedArchiveSha256);
        memory.mockRestore();
        actors.pauseAuthor = false;
        const retry = await api.stageRuntime(f.input);
        assert.equal(retry.reused, false, 'cancelled preflight must release writer ownership for a clean retry');
        assert.equal(readFileSync(f.counter, 'utf8'), 'x');
        assert.equal(existsSync(join(f.root, '.git/ai-delivery/runtime-admission.json')), false);
      } finally {
        memory.mockRestore();
        f.cleanup();
      }
    },
  );
}

test(
  'runtime-stage failure logs honor the caller retained-output cap outside the stage',
  { tags: ['release'] },
  async () => {
    const api = await producer();
    const f = await fixture();
    const logLimit = 1024 ** 2;
    try {
      writeFileSync(join(f.base, 'log-bytes'), String(2 * logLimit));
      writeFileSync(join(f.base, 'fail'), 'go');
      await assert.rejects(
        api.stageRuntime({
          ...f.input,
          resourceBounds: {
            maxAggregateRssBytes: 512 * 1024 ** 2,
            minFreeDiskBytes: 1,
            maxNewOutputBytes: 128 * 1024 ** 2,
            maxCapturedOutputBytes: logLimit,
          },
        }),
        /captured output exceeded/u,
      );
      const outputDirectory = join(f.root, '.git/ai-delivery/verification@1/command-output');
      const logs = readdirSync(outputDirectory);
      assert.equal(logs.length, 1);
      assert.ok(lstatSync(join(outputDirectory, logs[0]!)).size <= logLimit);
      assert.equal(existsSync(f.input.runtimeDirectory), false);
      assert.equal(digestBytes(readFileSync(f.input.archivePath)), f.input.expectedArchiveSha256);
    } finally {
      f.cleanup();
    }
  },
);

test(
  'runtime-stage retries share the retained-output allowance and preserve earlier failure evidence',
  { tags: ['release'] },
  async () => {
    const api = await producer();
    const f = await fixture();
    const logLimit = 1024 ** 2;
    const input = {
      ...f.input,
      resourceBounds: {
        maxAggregateRssBytes: 512 * 1024 ** 2,
        minFreeDiskBytes: 1,
        maxNewOutputBytes: 128 * 1024 ** 2,
        maxCapturedOutputBytes: logLimit,
      },
    };
    const outputDirectory = join(f.root, '.git/ai-delivery/verification@1/command-output');
    try {
      writeFileSync(join(f.base, 'fail'), 'go');
      writeFileSync(join(f.base, 'log-bytes'), String(600 * 1024));
      await assert.rejects(api.stageRuntime(input), /failed/u);
      const prior = readdirSync(outputDirectory).map((name) => ({
        name,
        bytes: readFileSync(join(outputDirectory, name)),
      }));
      writeFileSync(join(f.base, 'log-bytes'), String(700 * 1024));
      await assert.rejects(api.stageRuntime(input), /failed|captured output exceeded/u);
      const total = readdirSync(outputDirectory).reduce(
        (bytes, name) => bytes + lstatSync(join(outputDirectory, name)).size,
        0,
      );
      assert.ok(total <= logLimit, `Retained retry logs ${total} exceed total allowance ${logLimit}.`);
      for (const evidence of prior)
        assert.deepEqual(readFileSync(join(outputDirectory, evidence.name)), evidence.bytes);
      assert.equal(readFileSync(f.counter, 'utf8'), 'xx');
      await assert.rejects(api.stageRuntime(input), /retained.*exhausted/u);
      assert.equal(
        readFileSync(f.counter, 'utf8'),
        'xx',
        'exhausted allowance must refuse another installer invocation',
      );
      assert.equal(existsSync(f.input.runtimeDirectory), false);
      assert.equal(digestBytes(readFileSync(f.input.archivePath)), f.input.expectedArchiveSha256);
    } finally {
      f.cleanup();
    }
  },
);

for (const existing of ['oversized', 'corrupt', 'valid', 'empty'] as const) {
  test(
    `runtime-stage first publication bounds ${existing} shared output absent from its ledger`,
    { tags: ['release'] },
    async () => {
      const api = await producer();
      const f = await fixture();
      const bytes = Buffer.alloc(existing === 'empty' ? 0 : 100 * 1024, 65);
      const digest = digestBytes(bytes);
      const directory = join(f.root, '.git/ai-delivery/verification@1/command-output');
      const evidence = join(directory, `${digest.slice(7)}.bin`);
      const ledgerDirectory = join(
        f.root,
        '.git/ai-delivery/verification@1/runtime-output',
        digestValue(f.root).slice(7),
      );
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        writeFileSync(evidence, existing === 'corrupt' ? Buffer.alloc(bytes.length, 66) : bytes, { mode: 0o600 });
        if (existing === 'oversized') truncateSync(evidence, 9 * 1024 ** 2);
        const originalDigest = digestBytes(readFileSync(evidence));
        const originalIdentity = lstatSync(evidence);
        assert.equal(existsSync(ledgerDirectory), false, 'shared evidence must precede this stage ledger');
        writeFileSync(join(f.base, 'fail'), 'go');
        writeFileSync(join(f.base, 'log-bytes'), String(bytes.length));
        sharedOutputRead.path = evidence;
        sharedOutputRead.unboundedReads = 0;
        await assert.rejects(api.stageRuntime(f.input), /exit 7/u);
        assert.equal(sharedOutputRead.unboundedReads, 0, 'publication must bound existing evidence before reading it');
        assert.equal(readFileSync(f.counter, 'utf8'), 'x');
        const ledgerPath = join(ledgerDirectory, readdirSync(ledgerDirectory)[0]!);
        const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as {
          outputs: { digest: string; bytes: number; status: string }[];
        };
        const refused = existing === 'oversized' || existing === 'corrupt';
        assert.deepEqual(ledger.outputs, [{ digest, bytes: bytes.length, status: refused ? 'reserved' : 'complete' }]);
        const retainedLedger = readFileSync(ledgerPath);
        await assert.rejects(api.stageRuntime(f.input), refused ? /corrupt|size.*bound/u : /exit 7/u);
        assert.equal(readFileSync(f.counter, 'utf8'), refused ? 'x' : 'xx');
        assert.equal(sharedOutputRead.unboundedReads, 0);
        assert.deepEqual(
          readFileSync(ledgerPath),
          retainedLedger,
          'retry must preserve the existing reservation or completed charge',
        );
        sharedOutputRead.path = '';
        assert.equal(
          digestBytes(readFileSync(evidence)),
          originalDigest,
          'existing shared evidence must remain immutable',
        );
        const after = lstatSync(evidence);
        assert.equal(after.ino, originalIdentity.ino);
        assert.equal(after.size, originalIdentity.size);
        assert.equal(existsSync(f.input.runtimeDirectory), false);
      } finally {
        sharedOutputRead.path = '';
        sharedOutputRead.unboundedReads = 0;
        f.cleanup();
      }
    },
  );
}

for (const fault of [
  'corrupt ledger',
  'incompatible controller',
  'missing evidence',
  'corrupt evidence',
  'oversized evidence',
] as const) {
  test(
    `runtime-stage retained-output ${fault} refuses another installer without resetting its allowance`,
    { tags: ['release'] },
    async () => {
      const api = await producer();
      const f = await fixture();
      try {
        writeFileSync(join(f.base, 'fail'), 'go');
        writeFileSync(join(f.base, 'log-bytes'), String(100 * 1024));
        await assert.rejects(api.stageRuntime(f.input), /exit 7/u);
        const directory = join(f.root, '.git/ai-delivery/verification@1/runtime-output', digestValue(f.root).slice(7));
        const path = join(directory, readdirSync(directory)[0]!);
        const ledger = JSON.parse(readFileSync(path, 'utf8')) as {
          contentDigest: string;
          producerDigest: string;
          outputs: { digest: string }[];
        };
        const evidence = join(
          f.root,
          '.git/ai-delivery/verification@1/command-output',
          `${ledger.outputs[0]!.digest.slice(7)}.bin`,
        );
        if (fault === 'corrupt ledger') {
          ledger.contentDigest = `sha256:${'0'.repeat(64)}`;
          writeFileSync(path, JSON.stringify(ledger));
        } else if (fault === 'incompatible controller') {
          ledger.producerDigest = `sha256:${'0'.repeat(64)}`;
          const { contentDigest: _digest, ...content } = ledger;
          ledger.contentDigest = digestValue(content);
          writeFileSync(path, JSON.stringify(ledger));
        } else if (fault === 'missing evidence') rmSync(evidence);
        else if (fault === 'oversized evidence') truncateSync(evidence, 9 * 1024 ** 2);
        else writeFileSync(evidence, 'changed immutable output');
        const retained = readFileSync(path);
        await assert.rejects(api.stageRuntime(f.input), /corrupt|incompatible|ENOENT|size.*bound/u);
        assert.equal(readFileSync(f.counter, 'utf8'), 'x');
        assert.deepEqual(readFileSync(path), retained, 'failed integrity check must preserve the charged ledger');
        assert.equal(readdirSync(directory).length, 1);
        assert.equal(existsSync(f.input.runtimeDirectory), false);
      } finally {
        f.cleanup();
      }
    },
  );
}

test(
  'runtime-stage explicitly isolates npm cache, logs, configuration and temporary destinations',
  { tags: ['release'] },
  async () => {
    const api = await producer();
    const f = await fixture();
    try {
      await api.stageRuntime(f.input);
      const settings = JSON.parse(readFileSync(join(f.base, 'installer-settings'), 'utf8')) as {
        args: string[];
        cwd: string;
        TMPDIR: string;
        TMP: string;
        TEMP: string;
      };
      const stage = f.input.runtimeDirectory;
      for (const option of ['--cache', '--logs-dir', '--userconfig', '--globalconfig']) {
        assert.ok(settings.args.includes(option), `missing explicit npm ${option}`);
        const value = settings.args[settings.args.indexOf(option) + 1]!;
        assert.ok(value.startsWith(`${stage}/`), `npm ${option} must stay inside the owned stage`);
        assert.ok(existsSync(value));
      }
      assert.equal(settings.cwd, stage);
      for (const key of ['TMPDIR', 'TMP', 'TEMP'] as const) {
        assert.ok(settings[key].startsWith(`${stage}/`), `${key} must stay inside the owned stage`);
        assert.ok(existsSync(settings[key]));
      }
      assert.equal((await api.stageRuntime(f.input)).reused, true);
      assert.equal(readFileSync(f.counter, 'utf8'), 'x');
    } finally {
      f.cleanup();
    }
  },
);

test(
  'runtime-stage cancellation shares prior failure charges and identical evidence is reused',
  { tags: ['release'] },
  async () => {
    const api = await producer();
    const f = await fixture();
    const cancellation = new AbortController();
    const input = {
      ...f.input,
      resourceBounds: {
        maxAggregateRssBytes: 512 * 1024 ** 2,
        minFreeDiskBytes: 1,
        maxNewOutputBytes: 128 * 1024 ** 2,
        maxCapturedOutputBytes: 1024 ** 2,
      },
    };
    const directory = join(f.root, '.git/ai-delivery/verification@1/command-output');
    const write = process.stderr.write.bind(process.stderr);
    let sawCaptured = false;
    const observation = vi.spyOn(process.stderr, 'write').mockImplementation((chunk, ...args) => {
      const text = String(chunk);
      if (text.startsWith('ai-delivery.verify ')) {
        const value = JSON.parse(text.slice('ai-delivery.verify '.length)) as { capturedOutputBytes?: number };
        if (value.capturedOutputBytes === 200 * 1024) {
          sawCaptured = true;
          cancellation.abort();
        }
      }
      return write(chunk, ...args);
    });
    try {
      writeFileSync(join(f.base, 'fail'), 'go');
      writeFileSync(join(f.base, 'log-bytes'), String(100 * 1024));
      await assert.rejects(api.stageRuntime(input), /exit 7/u);
      await assert.rejects(api.stageRuntime(input), /exit 7/u);
      assert.equal(readdirSync(directory).length, 1, 'identical complete command evidence must be reused');
      const prior = readFileSync(join(directory, readdirSync(directory)[0]!));
      rmSync(join(f.base, 'fail'));
      writeFileSync(join(f.base, 'wait'), 'go');
      writeFileSync(join(f.base, 'log-bytes'), String(200 * 1024));
      await assert.rejects(api.stageRuntime({ ...input, signal: cancellation.signal }), /cancelled/u);
      assert.equal(sawCaptured, true, 'cancel only after the full owned output is captured');
      assert.ok(readdirSync(directory).some((name) => readFileSync(join(directory, name)).equals(prior)));
      const ledgerRoot = join(f.root, '.git/ai-delivery/verification@1/runtime-output', digestValue(f.root).slice(7));
      const ledger = JSON.parse(readFileSync(join(ledgerRoot, readdirSync(ledgerRoot)[0]!), 'utf8')) as {
        outputs: { bytes: number }[];
      };
      assert.equal(
        ledger.outputs.reduce((total, output) => total + output.bytes, 0),
        300 * 1024,
      );
      assert.equal(readFileSync(f.counter, 'utf8'), 'xxx');
      assert.equal(existsSync(f.input.runtimeDirectory), false);
    } finally {
      cancellation.abort();
      observation.mockRestore();
      f.cleanup();
    }
  },
);

test('runtime-stage post-install preflight growth cannot publish completion', { tags: ['release'] }, async () => {
  const api = await producer();
  const f = await fixture();
  const memoryUsage = process.memoryUsage.bind(process);
  const memory = vi.spyOn(process, 'memoryUsage').mockImplementation(() => ({
    ...memoryUsage(),
    rss: actors.authorCalls < 2 ? 64 * 1024 ** 2 : 1024 ** 3,
  }));
  try {
    await assert.rejects(
      api.stageRuntime({
        ...f.input,
        resourceBounds: {
          maxAggregateRssBytes: 512 * 1024 ** 2,
          minFreeDiskBytes: 1,
          maxNewOutputBytes: 128 * 1024 ** 2,
        },
      }),
      /RSS.*limit|RSS.*bound/u,
    );
    assert.equal(readFileSync(f.counter, 'utf8'), 'x', 'installation must finish before the failing final preflight');
    assert.equal(existsSync(f.input.runtimeDirectory), false);
    assert.equal(existsSync(join(f.root, '.git/ai-delivery/runtime-admission.json')), false);
  } finally {
    memory.mockRestore();
    f.cleanup();
  }
});

test(
  'runtime-stage bounds actual controller and npm memory and preserves an unrelated live peer',
  { tags: ['release'] },
  async () => {
    const api = await producer();
    const f = await fixture();
    const peer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const closed = new Promise<void>((resolve) => peer.once('close', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        peer.once('spawn', () => resolve());
        peer.once('error', reject);
      });
      writeFileSync(join(f.base, 'memory-bytes'), String(512 * 1024 ** 2));
      await assert.rejects(
        api.stageRuntime({
          ...f.input,
          resourceBounds: {
            maxAggregateRssBytes: 512 * 1024 ** 2,
            minFreeDiskBytes: 1,
            maxNewOutputBytes: 128 * 1024 ** 2,
            maxCapturedOutputBytes: 1024 ** 2,
          },
        }),
        /aggregate RSS .* exceeded limit/u,
      );
      const ownedPid = Number(readFileSync(f.marker, 'utf8'));
      assert.throws(() => process.kill(ownedPid, 0), { code: 'ESRCH' });
      assert.equal(peer.exitCode, null);
      process.kill(peer.pid!, 0);
      assert.equal(existsSync(f.input.runtimeDirectory), false);
      assert.equal(existsSync(join(f.root, '.git/ai-delivery/runtime-admission.json')), false);
      assert.equal(digestBytes(readFileSync(f.input.archivePath)), f.input.expectedArchiveSha256);
    } finally {
      peer.kill('SIGKILL');
      await closed;
      f.cleanup();
    }
  },
);

test(
  'runtime-stage changed resource intent preserves compatible completed bytes without reinstalling',
  { tags: ['release'] },
  async () => {
    const api = await producer();
    const f = await fixture();
    try {
      const stage = await api.stageRuntime(f.input);
      const path = join(f.input.runtimeDirectory, 'runtime-stage.json');
      const completion = readFileSync(path);
      await assert.rejects(
        api.stageRuntime({
          ...f.input,
          resourceBounds: {
            maxAggregateRssBytes: 512 * 1024 ** 2,
            minFreeDiskBytes: 1,
            maxNewOutputBytes: 128 * 1024 ** 2,
            maxCapturedOutputBytes: 512 * 1024,
          },
        }),
        /incompatible setup intent/u,
      );
      assert.deepEqual(readFileSync(path), completion);
      assert.equal(readFileSync(f.counter, 'utf8'), 'x');
      assert.equal((await api.stageRuntime(f.input)).stageId, stage.stageId);
    } finally {
      f.cleanup();
    }
  },
);

for (const mode of ['success', 'failure', 'cancel'] as const) {
  test(
    `real npm ${mode} disables file logs and preserves unrelated host destinations`,
    { tags: ['release'] },
    async () => {
      const api = await producer();
      const realPath = process.env.PATH;
      const f = await fixture();
      const cancellation = new AbortController();
      let operation: Promise<Stage> | undefined;
      const previous = {
        cache: process.env.npm_config_cache,
        logs: process.env.npm_config_logs_dir,
        userconfig: process.env.npm_config_userconfig,
      };
      try {
        process.env.PATH = realPath;
        const outside = join(f.base, 'unrelated-host');
        mkdirSync(outside);
        const cache = join(outside, 'cache');
        const logs = join(outside, 'logs');
        for (const path of [cache, logs]) {
          mkdirSync(path);
          writeFileSync(join(path, 'keep'), 'unrelated');
        }
        const userconfig = join(outside, 'user.npmrc');
        const config = `cache=${cache}\nlogs-dir=${logs}\n`;
        writeFileSync(userconfig, config);
        const nativeBin = join(f.base, 'native-bin');
        mkdirSync(nativeBin);
        const probe = join(f.base, 'native-npm-observation.json');
        const npmRoot = join(dirname(process.execPath), '../lib/node_modules/npm');
        writeFileSync(
          join(nativeBin, 'npm'),
          `#!${process.execPath}\nconst fs=require('node:fs'),os=require('node:os'),path=require('node:path');\nconst observation={args:process.argv.slice(2),cwd:process.cwd(),tmpdir:os.tmpdir(),npmVersion:require(${JSON.stringify(join(npmRoot, 'package.json'))}).version};\nconst LogFile=require(${JSON.stringify(join(npmRoot, 'lib/utils/log-file.js'))}),load=LogFile.prototype.load;\nconst observe=()=>{const directory=path.join(process.cwd(),'.npm/logs');observation.fileLogs=fs.existsSync(directory)?fs.readdirSync(directory):[];observation.fileLogBytes=observation.fileLogs.reduce((sum,name)=>sum+fs.statSync(path.join(directory,name)).size,0);fs.writeFileSync(${JSON.stringify(probe)},JSON.stringify(observation),{mode:0o600});};\nLogFile.prototype.load=function(options){const result=load.call(this,options);observation.logsMax=options.logsMax;observe();${mode === 'cancel' ? 'setInterval(observe,20);' : ''}return result;};\nprocess.on('exit',observe);\n${mode === 'failure' ? 'process.argv[2]="synthetic-unknown-command";' : ''}\nrequire(${JSON.stringify(join(npmRoot, 'bin/npm-cli.js'))});\n`,
        );
        chmodSync(join(nativeBin, 'npm'), 0o755);
        process.env.PATH = `${nativeBin}:${realPath ?? ''}`;
        process.env.npm_config_cache = cache;
        process.env.npm_config_logs_dir = logs;
        process.env.npm_config_userconfig = userconfig;
        operation = api.stageRuntime({
          ...f.input,
          signal: cancellation.signal,
          resourceBounds: {
            maxAggregateRssBytes: 512 * 1024 ** 2,
            minFreeDiskBytes: 1,
            maxNewOutputBytes: 128 * 1024 ** 2,
            maxCapturedOutputBytes: 1024 ** 2,
          },
        });
        void operation.catch(() => undefined);
        if (mode === 'cancel') {
          for (let i = 0; i < 1000 && !existsSync(probe); i++) await new Promise((resolve) => setTimeout(resolve, 20));
          assert.equal(existsSync(probe), true, 'actual npm log configuration was not observed');
          cancellation.abort();
          await assert.rejects(operation, /cancelled/u);
        } else if (mode === 'failure') await assert.rejects(operation, /exit 1/u);
        else {
          const stage = await operation;
          assert.equal(existsSync(f.counter), false, 'synthetic npm must not execute');
          assert.equal(
            execFileSync(process.execPath, [stage.admission.cliPath, '--version'], { encoding: 'utf8' }).trim(),
            '0.3.5',
          );
          assert.ok(readdirSync(join(f.input.runtimeDirectory, '.npm/cache')).length > 0);
          assert.deepEqual(readdirSync(join(f.input.runtimeDirectory, '.npm/logs')), []);
        }
        const native = JSON.parse(readFileSync(probe, 'utf8')) as {
          args: string[];
          cwd: string;
          tmpdir: string;
          npmVersion: string;
          logsMax: number;
          fileLogs: string[];
          fileLogBytes: number;
        };
        assert.equal(native.npmVersion, '11.19.0');
        assert.equal(native.cwd, f.input.runtimeDirectory);
        assert.equal(native.tmpdir, join(f.input.runtimeDirectory, '.npm/tmp'));
        assert.equal(native.logsMax, 0);
        assert.equal(native.fileLogBytes, 0);
        assert.deepEqual(native.fileLogs, []);
        if (mode !== 'success') assert.equal(existsSync(f.input.runtimeDirectory), false);
        for (const option of ['--cache', '--logs-dir', '--userconfig', '--globalconfig']) {
          assert.ok(native.args.includes(option));
          assert.ok(native.args[native.args.indexOf(option) + 1]!.startsWith(`${f.input.runtimeDirectory}/`));
        }
        assert.deepEqual(readdirSync(cache), ['keep']);
        assert.deepEqual(readdirSync(logs), ['keep']);
        assert.equal(readFileSync(userconfig, 'utf8'), config);
        assert.equal(existsSync(join(f.root, '.git/ai-delivery/runtime-admission.json')), false);
        console.log(
          'REAL_NPM_ISOLATION_RECEIPT',
          JSON.stringify({
            mode,
            npmFileLogBytes: native.fileLogBytes,
            npmFileLogsDisabled: true,
            temporaryAndConfigInsideStage: true,
            unrelatedHostPreserved: true,
            controllerInclusiveMemoryBytes: 512 * 1024 ** 2,
            retainedLogCapBytes: 1024 ** 2,
            hostActivated: false,
            sharedAdmissionWritten: false,
          }),
        );
      } finally {
        cancellation.abort();
        await operation?.catch(() => undefined);
        for (const [name, value] of [
          ['npm_config_cache', previous.cache],
          ['npm_config_logs_dir', previous.logs],
          ['npm_config_userconfig', previous.userconfig],
        ] as const) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        f.cleanup();
      }
    },
  );
}

test(
  'real npm keeps the reviewed tarball closure after hidden-lock invalidation and completed reuse',
  { tags: ['release'] },
  async () => {
    const api = await producer();
    const realPath = process.env.PATH;
    const f = await fixture();
    try {
      const npmRoot = join(dirname(process.execPath), '../lib/node_modules/npm');
      const npmCli = join(npmRoot, 'bin/npm-cli.js');
      assert.equal(
        (JSON.parse(readFileSync(join(npmRoot, 'package.json'), 'utf8')) as { version: string }).version,
        '11.19.0',
      );
      const bin = join(f.base, 'real-npm-bin');
      mkdirSync(bin);
      writeFileSync(
        join(bin, 'npm'),
        `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv[2]==='install')fs.appendFileSync(${JSON.stringify(f.counter)},'x');require(${JSON.stringify(npmCli)});\n`,
      );
      chmodSync(join(bin, 'npm'), 0o755);
      process.env.PATH = `${bin}:${realPath ?? ''}`;
      const manifestPath = join(f.base, 'archive/package/package.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      manifest.scripts = { preinstall: 'node -e "process.exit(91)"', install: 'node -e "process.exit(92)"' };
      writeFileSync(manifestPath, JSON.stringify(manifest));
      execFileSync('tar', ['-czf', f.input.archivePath, '-C', join(f.base, 'archive'), 'package']);
      f.input.expectedArchiveSha256 = digestBytes(readFileSync(f.input.archivePath));
      const installed = join(f.input.runtimeDirectory, 'node_modules');
      const hidden = join(installed, '.package-lock.json');
      const stage = await api.stageRuntime(f.input);
      const completeBytes = readFileSync(join(f.input.runtimeDirectory, 'runtime-stage.json'));
      const metadataPaths = ['package.json', 'package-lock.json'].map((name) => join(f.input.runtimeDirectory, name));
      const metadataBytes = metadataPaths.map((path) => readFileSync(path));
      const inspectClosure = () =>
        spawnSync(
          process.execPath,
          [npmCli, 'ls', '--prefix', f.input.runtimeDirectory, '--omit=dev', '--all', '--json', '--logs-max', '0'],
          { cwd: f.root, encoding: 'utf8', maxBuffer: 1024 ** 2 },
        );
      const closure = () => {
        const result = inspectClosure();
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stderr + result.stdout);
        const graph = JSON.parse(result.stdout) as {
          problems?: string[];
          dependencies: Record<string, { version: string; resolved?: string; invalid?: boolean; missing?: boolean }>;
        };
        assert.equal(graph.problems, undefined);
        const target = graph.dependencies['@aviaratech/ai-delivery']!;
        assert.equal(target.version, '0.3.5');
        assert.equal(target.invalid, undefined);
        assert.equal(target.missing, undefined);
        assertReviewedResolved(target.resolved, `file:${join(f.input.runtimeDirectory, 'reviewed-archive.tgz')}`);
      };
      closure();
      const lockTime = lstatSync(hidden).mtime;
      utimesSync(installed, new Date(lockTime.getTime() + 2000), new Date(lockTime.getTime() + 2000));
      assert.ok(lstatSync(installed).mtimeMs > lstatSync(hidden).mtimeMs);
      closure();
      assert.deepEqual(await api.stageRuntime(f.input), { ...stage, reused: true });
      assert.deepEqual(readFileSync(join(f.input.runtimeDirectory, 'runtime-stage.json')), completeBytes);
      assert.deepEqual(
        metadataPaths.map((path) => readFileSync(path)),
        metadataBytes,
      );
      rmSync(hidden);
      closure();
      assert.deepEqual(await api.stageRuntime(f.input), { ...stage, reused: true });
      await api.admitRuntime(admitInput(f.input, stage.stageId));
      assert.equal(readFileSync(f.counter, 'utf8'), 'x', 'completed reuse must never reinstall');
      assert.deepEqual(readFileSync(join(f.input.runtimeDirectory, 'runtime-stage.json')), completeBytes);
      assert.deepEqual(
        metadataPaths.map((path) => readFileSync(path)),
        metadataBytes,
      );
      const admissionPath = join(f.root, '.git/ai-delivery/runtime-admission.json');
      const admissionBytes = readFileSync(admissionPath);
      for (const { field, edges, problem } of [
        { field: 'optionalDependencies', edges: { '@aviaratech/ai-delivery': 'file:other.tgz' }, problem: /invalid:/u },
        { field: 'peerDependencies', edges: { 'missing-runtime-stage-peer': '1.0.0' }, problem: /missing:/u },
      ]) {
        const changed = JSON.parse(metadataBytes[0]!.toString('utf8')) as Record<string, unknown>;
        changed[field] = edges;
        writeFileSync(metadataPaths[0]!, JSON.stringify(changed));
        const damaged = readFileSync(metadataPaths[0]!);
        const native = inspectClosure();
        assert.equal(native.error, undefined);
        assert.equal(native.status, 1, native.stderr + native.stdout);
        const graph = JSON.parse(native.stdout) as { error?: { code: string }; problems?: string[] };
        assert.equal(graph.error?.code, 'ELSPROBLEMS');
        assert.ok(graph.problems?.some((entry) => problem.test(entry)));
        await assert.rejects(api.stageRuntime(f.input), /dependency metadata/iu);
        await assert.rejects(api.admitRuntime(admitInput(f.input, stage.stageId)), /dependency metadata/iu);
        assert.deepEqual(readFileSync(metadataPaths[0]!), damaged);
        assert.deepEqual(readFileSync(metadataPaths[1]!), metadataBytes[1]);
        assert.deepEqual(readFileSync(join(f.input.runtimeDirectory, 'runtime-stage.json')), completeBytes);
        assert.deepEqual(readFileSync(admissionPath), admissionBytes);
        assert.equal(readFileSync(f.counter, 'utf8'), 'x');
        writeFileSync(metadataPaths[0]!, metadataBytes[0]!);
      }
    } finally {
      f.cleanup();
      process.env.PATH = realPath;
    }
  },
);

test(
  'completed stages refuse missing, corrupt or incompatible dependency metadata without reinstalling or rewriting',
  { tags: ['release'] },
  async () => {
    const api = await producer();
    const f = await fixture();
    try {
      const staged = await api.stageRuntime(f.input);
      const record = join(f.input.runtimeDirectory, 'runtime-stage.json');
      const complete = readFileSync(record);
      const paths = ['package.json', 'package-lock.json'].map((name) => join(f.input.runtimeDirectory, name));
      const retained = paths.map((path) => (existsSync(path) ? readFileSync(path) : undefined));
      for (const [index, path] of paths.entries()) {
        for (const fault of [
          'missing',
          'corrupt',
          'incompatible',
          'symlink',
          'hardlink',
          'fifo',
          ...(index === 1 ? ['version', 'resolved', 'integrity'] : []),
        ]) {
          const sentinel = join(f.base, `unrelated-metadata-${index}-${fault}`);
          if (fault === 'missing') rmSync(path, { force: true });
          else if (fault === 'symlink' || fault === 'hardlink') {
            writeFileSync(sentinel, retained[index]!);
            rmSync(path);
            if (fault === 'symlink') symlinkSync(sentinel, path);
            else linkSync(sentinel, path);
          } else if (fault === 'fifo') {
            rmSync(path);
            execFileSync('mkfifo', [path]);
          } else if (['version', 'resolved', 'integrity'].includes(fault)) {
            const lock = JSON.parse(retained[index]!.toString('utf8')) as {
              packages: Record<string, Record<string, unknown>>;
            };
            lock.packages['node_modules/@aviaratech/ai-delivery']![fault] = 'incompatible';
            writeFileSync(path, JSON.stringify(lock));
          } else
            writeFileSync(
              path,
              fault === 'corrupt'
                ? '{'
                : JSON.stringify(
                    index === 0
                      ? { dependencies: { '@aviaratech/ai-delivery': 'file:other.tgz' } }
                      : { lockfileVersion: 99, packages: {} },
                  ),
            );
          const damaged = fault !== 'fifo' && existsSync(path) ? readFileSync(path) : undefined;
          await assert.rejects(
            api.stageRuntime(f.input),
            fault === 'symlink' ? /symbolic link/iu : fault === 'fifo' ? /unsupported file/iu : /dependency metadata/iu,
          );
          await assert.rejects(api.admitRuntime(admitInput(f.input, staged.stageId)), /dependency metadata/iu);
          assert.deepEqual(readFileSync(record), complete);
          if (fault === 'fifo') assert.equal(lstatSync(path).isFIFO(), true);
          else assert.deepEqual(existsSync(path) ? readFileSync(path) : undefined, damaged);
          if (fault === 'symlink' || fault === 'hardlink') {
            assert.deepEqual(readFileSync(sentinel), retained[index]);
            assert.equal(lstatSync(path).isSymbolicLink(), fault === 'symlink');
          }
          assert.equal(readFileSync(f.counter, 'utf8'), 'x', 'metadata refusal must not reinstall');
          rmSync(path, { force: true });
          if (retained[index] !== undefined) writeFileSync(path, retained[index]!);
        }
      }
    } finally {
      f.cleanup();
    }
  },
);

for (const metadata of ['package.json', 'package-lock.json']) {
  test(
    `lost completion response refuses ${metadata} drift during final preflight without reinstalling`,
    { tags: ['release'] },
    async () => {
      const api = await producer();
      const f = await fixture();
      let operation: Promise<Stage> | undefined;
      try {
        const record = join(f.input.runtimeDirectory, 'runtime-stage.json');
        const target = join(f.input.runtimeDirectory, metadata);
        let complete: Buffer | undefined;
        let notifyWritten: (() => void) | undefined;
        const written = new Promise<void>((resolve) => {
          notifyWritten = resolve;
        });
        const actual = atomicJson.writePrivateJsonFileAtomically;
        vi.spyOn(atomicJson, 'writePrivateJsonFileAtomically').mockImplementation((path, value) => {
          actual(path, value);
          if (path === record && (value as { status?: string }).status === 'complete') {
            complete = readFileSync(record);
            actors.authorStarted = false;
            actors.pauseAuthor = true;
            notifyWritten!();
            throw new Error('Synthetic completion response lost after durable write');
          }
        });
        operation = api.stageRuntime(f.input);
        const settled = operation.then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (error: unknown) => ({ status: 'rejected' as const, error }),
        );
        const prematurelySettled = settled.then((result) => {
          if (result.status === 'rejected') throw result.error;
          throw new Error('Stage completed before the recovery fault was injected.');
        });
        await Promise.race([written, prematurelySettled]);
        while (!actors.authorStarted)
          await Promise.race([new Promise((resolve) => setTimeout(resolve, 10)), prematurelySettled]);
        assert.ok(complete);
        assert.equal((JSON.parse(complete.toString('utf8')) as { status: string }).status, 'complete');
        if (metadata === 'package.json') rmSync(target);
        else writeFileSync(target, '{');
        const damaged = existsSync(target) ? readFileSync(target) : undefined;
        await assert.rejects(operation, /dependency metadata/iu);
        assert.deepEqual(readFileSync(record), complete);
        assert.deepEqual(existsSync(target) ? readFileSync(target) : undefined, damaged);
        assert.equal(readFileSync(f.counter, 'utf8'), 'x');
        assert.equal(existsSync(join(f.root, '.git/ai-delivery/runtime-admission.json')), false);
      } finally {
        await operation?.catch(() => undefined);
        actors.pauseAuthor = false;
        vi.restoreAllMocks();
        f.cleanup();
      }
    },
  );
}

test(
  'public producer stages exact bytes, explicitly admits and reuses completed work without installing again',
  { tags: ['release'] },
  async () => {
    const api = await producer();
    const f = await fixture();
    try {
      const staged = await api.stageRuntime(f.input);
      const admissionPath = join(f.root, '.git/ai-delivery/runtime-admission.json');
      assert.equal(existsSync(admissionPath), false);
      assert.equal(staged.admission.sourceCommit, f.input.expectedSourceCommit);
      assert.equal(staged.admission.sourceArchiveSha256, f.input.expectedArchiveSha256);
      const admitted = await api.admitRuntime(admitInput(f.input, staged.stageId));
      assert.equal(
        (await assertDeliveryRuntimeAdmitted({ repoRoot: f.root, runtimeEntryPath: staged.admission.cliPath }))
          .admissionId,
        admitted.admission.admissionId,
      );
      assert.equal((await api.stageRuntime(f.input)).reused, true);
      assert.equal((await api.admitRuntime(admitInput(f.input, staged.stageId))).reused, true);
      assert.equal(readFileSync(f.counter, 'utf8'), 'x');
    } finally {
      f.cleanup();
    }
  },
);

test(
  'archive replacement and restoration during install cannot admit alternate bytes under the reviewed digest',
  { tags: ['release'] },
  async () => {
    const api = await producer();
    const f = await fixture();
    try {
      const reviewed = readFileSync(f.input.archivePath);
      const cli = join(f.base, 'archive/package/dist/cli.js');
      const expectedCli = readFileSync(cli);
      writeFileSync(cli, "#!/usr/bin/env node\nconsole.log('same version, alternate archive bytes');\n");
      execFileSync('tar', ['-czf', join(f.base, 'replacement.tgz'), '-C', join(f.base, 'archive'), 'package']);
      assert.notEqual(digestBytes(readFileSync(join(f.base, 'replacement.tgz'))), f.input.expectedArchiveSha256);
      // The separate installer process replaces the public pathname before extraction and restores A afterward.
      const staged = await api.stageRuntime(f.input);
      const admitted = await api.admitRuntime(admitInput(f.input, staged.stageId));
      assert.ok(
        readFileSync(f.input.archivePath).equals(reviewed),
        'the original archive was restored before revalidation',
      );
      assert.ok(
        readFileSync(admitted.admission.cliPath).equals(expectedCli),
        'alternate archive B was installed and admitted under reviewed archive A digest',
      );
      assert.equal(admitted.admission.sourceArchiveSha256, digestBytes(reviewed));
      assert.equal(admitted.admission.cliSha256, digestBytes(expectedCli));
      const snapshot = join(f.input.runtimeDirectory, 'reviewed-archive.tgz');
      assert.equal(readFileSync(join(f.base, 'installer-archive'), 'utf8'), snapshot);
      assert.ok(readFileSync(snapshot).equals(reviewed));
      const metadata = lstatSync(snapshot);
      assert.ok(metadata.isFile() && !metadata.isSymbolicLink());
      assert.equal(metadata.mode & 0o777, 0o600);
      assert.equal(metadata.nlink, 1);
      assert.equal((await api.stageRuntime(f.input)).reused, true);
      assert.equal(readFileSync(f.counter, 'utf8'), 'x');
      console.log(
        'ARCHIVE_SUBSTITUTION_RECEIPT',
        JSON.stringify({
          stageId: staged.stageId,
          archiveSha256: digestBytes(reviewed),
          installedCliSha256: digestBytes(expectedCli),
          originalRestored: true,
          privateSnapshotInstalled: true,
          completeRetrySkipped: true,
        }),
      );
    } finally {
      f.cleanup();
    }
  },
);

for (const corruption of ['missing', 'corrupt', 'symlink', 'hardlink'] as const) {
  test(
    `completed snapshot ${corruption} rejects reuse and admission while preserving current admission`,
    { tags: ['release'] },
    async () => {
      const api = await producer();
      const f = await fixture();
      try {
        const staged = await api.stageRuntime(f.input);
        await api.admitRuntime(admitInput(f.input, staged.stageId));
        const admissionPath = join(f.root, '.git/ai-delivery/runtime-admission.json');
        const prior = readFileSync(admissionPath);
        const snapshot = join(f.input.runtimeDirectory, 'reviewed-archive.tgz');
        assert.ok(existsSync(snapshot), 'completed stage must retain its verified archive snapshot');
        if (corruption === 'corrupt') writeFileSync(snapshot, 'alternate bytes');
        else {
          rmSync(snapshot);
          if (corruption === 'symlink') symlinkSync(f.input.archivePath, snapshot);
          if (corruption === 'hardlink') linkSync(f.input.archivePath, snapshot);
        }
        await assert.rejects(api.stageRuntime(f.input));
        await assert.rejects(api.admitRuntime(admitInput(f.input, staged.stageId)));
        assert.ok(readFileSync(admissionPath).equals(prior));
        assert.equal(existsSync(f.input.runtimeDirectory), true);
        assert.equal(readFileSync(f.counter, 'utf8'), 'x');
      } finally {
        f.cleanup();
      }
    },
  );
}

test(
  'archive snapshot consumes the bounded stage output allowance before running npm',
  { tags: ['release'] },
  async () => {
    const api = await producer();
    const f = await fixture();
    try {
      await assert.rejects(
        api.stageRuntime({
          ...f.input,
          resourceBounds: {
            maxAggregateRssBytes: 1024 ** 3,
            minFreeDiskBytes: 256 * 1024 ** 2,
            maxNewOutputBytes: readFileSync(f.input.archivePath).length - 1,
          },
        }),
        /output.*limit|allowance/u,
      );
      assert.equal(existsSync(f.counter), false);
      assert.equal(existsSync(f.input.runtimeDirectory), false);
      assert.equal(digestBytes(readFileSync(f.input.archivePath)), f.input.expectedArchiveSha256);
    } finally {
      f.cleanup();
    }
  },
);

test(
  'snapshot durability failure removes the owned partial copy and preserves the original and unrelated files',
  { tags: ['release'] },
  async () => {
    const api = await producer();
    const f = await fixture();
    const actual = privateFiles.writeCreateOnly;
    const snapshot = join(f.input.runtimeDirectory, 'reviewed-archive.tgz');
    const unrelated = join(f.base, 'unrelated');
    try {
      writeFileSync(unrelated, 'keep');
      const write = vi.spyOn(privateFiles, 'writeCreateOnly').mockImplementation((path, bytes, digest) => {
        if (path === snapshot) syncFailure.directory = dirname(path);
        try {
          return actual(path, bytes, digest);
        } finally {
          syncFailure.directory = '';
        }
      });
      await assert.rejects(api.stageRuntime(f.input), /durability unavailable/u);
      write.mockRestore();
      assert.equal(existsSync(f.counter), false);
      assert.equal(existsSync(f.input.runtimeDirectory), false);
      assert.equal(digestBytes(readFileSync(f.input.archivePath)), f.input.expectedArchiveSha256);
      assert.equal(readFileSync(unrelated, 'utf8'), 'keep');
      const stage = await api.stageRuntime(f.input);
      assert.equal(stage.reused, false);
      assert.equal(readFileSync(f.counter, 'utf8'), 'x');
    } finally {
      syncFailure.directory = '';
      vi.restoreAllMocks();
      f.cleanup();
    }
  },
);

for (const denied of [
  'authority',
  'archive',
  'version',
  'source',
  'config',
  'identity',
  'same-actor',
  'reviewer-access',
  'unowned',
] as const) {
  test(`stage rejects ${denied} before adopting or publishing a runtime`, { tags: ['release'] }, async () => {
    const api = await producer();
    const f = await fixture();
    try {
      const input = { ...f.input };
      if (denied === 'authority') input.authority = '';
      if (denied === 'archive') writeFileSync(input.archivePath, 'corrupt archive');
      if (denied === 'version') input.packageVersion = '0.3.4';
      if (denied === 'source') input.expectedSourceCommit = 'a'.repeat(40);
      if (denied === 'config') input.expectedConfigDigest = `sha256:${'a'.repeat(64)}`;
      if (denied === 'identity') input.identity = 'ambient-author';
      if (denied === 'same-actor') actors.reviewer = actors.author;
      if (denied === 'reviewer-access') actors.access = false;
      if (denied === 'unowned') {
        mkdirSync(input.runtimeDirectory);
        writeFileSync(join(input.runtimeDirectory, 'preserve'), 'unrelated');
      }
      await assert.rejects(api.stageRuntime(input));
      assert.equal(existsSync(join(f.root, '.git/ai-delivery/runtime-admission.json')), false);
      if (denied === 'unowned')
        assert.equal(readFileSync(join(input.runtimeDirectory, 'preserve'), 'utf8'), 'unrelated');
      else assert.equal(existsSync(input.runtimeDirectory), false);
    } finally {
      f.cleanup();
    }
  });
}

test(
  'admission rejects CAS and actual byte or actor drift while preserving the prior record',
  { tags: ['release'] },
  async () => {
    const api = await producer();
    const f = await fixture();
    try {
      const staged = await api.stageRuntime(f.input);
      const path = join(f.root, '.git/ai-delivery/runtime-admission.json');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'prior admission\n', { mode: 0o600 });
      await assert.rejects(api.admitRuntime(admitInput(f.input, staged.stageId)), /prior|conflict|compare/u);
      const prior = digestBytes(readFileSync(path));
      actors.author = 'changed-host-user';
      await assert.rejects(api.admitRuntime(admitInput(f.input, staged.stageId, prior)), /actor|route/u);
      actors.author = 'host-user';
      writeFileSync(staged.admission.cliPath, 'changed bytes');
      await assert.rejects(api.admitRuntime(admitInput(f.input, staged.stageId, prior)), /source|bytes|admission/u);
      assert.equal(readFileSync(path, 'utf8'), 'prior admission\n');
    } finally {
      f.cleanup();
    }
  },
);

test(
  'post-rename errors reconcile desired bytes and never overwrite third-party replacement',
  { tags: ['release'] },
  async () => {
    const api = await producer();
    const f = await fixture();
    try {
      const staged = await api.stageRuntime(f.input);
      const path = join(f.root, '.git/ai-delivery/runtime-admission.json');
      const actual = atomicJson.writePrivateJsonFileAtomically;
      const write = vi.spyOn(atomicJson, 'writePrivateJsonFileAtomically').mockImplementation((target, value) => {
        actual(target, value);
        if (target === path) throw new Error('Synthetic response lost after rename');
      });
      assert.equal(
        (await api.admitRuntime(admitInput(f.input, staged.stageId))).admission.admissionId,
        staged.admission.admissionId,
      );
      write.mockRestore();
      assert.equal((await api.admitRuntime(admitInput(f.input, staged.stageId))).reused, true);
      rmSync(path);
      const replacement = vi.spyOn(atomicJson, 'writePrivateJsonFileAtomically').mockImplementation((target, value) => {
        actual(target, value);
        if (target === path) {
          writeFileSync(path, 'third-party replacement\n');
          throw new Error('Synthetic concurrent replacement');
        }
      });
      await assert.rejects(api.admitRuntime(admitInput(f.input, staged.stageId)), /conflict|replacement/u);
      replacement.mockRestore();
      assert.equal(readFileSync(path, 'utf8'), 'third-party replacement\n');
    } finally {
      vi.restoreAllMocks();
      f.cleanup();
    }
  },
);

async function cancelNativeStageWhenReady(
  running: Promise<Stage>,
  input: SetupInput,
  controller: AbortController,
  onReady: () => void = () => {},
) {
  const settled = running.then(
    () => ({ status: 'fulfilled' as const }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  );
  let failed = false;
  let failure: unknown;
  let outcome: Awaited<typeof settled> | undefined;
  try {
    // The real operation retains its native request/resource/cancellation/drain guards.
    // Readiness is an installer condition, not an assumed elapsed preparation duration.
    while (!existsSync(join(input.runtimeDirectory, 'node_modules/.bin/ai-delivery'))) {
      const outcome = await Promise.race([
        settled,
        new Promise<undefined>((resolve) => setTimeout(resolve, 20, undefined)),
      ]);
      if (outcome?.status === 'rejected') throw outcome.reason;
      assert.notEqual(outcome?.status, 'fulfilled', 'Stage completed before the pending installer became ready');
    }
    assert.equal(
      digestBytes(readFileSync(join(input.runtimeDirectory, 'reviewed-archive.tgz'))),
      input.expectedArchiveSha256,
    );
    onReady();
    controller.abort();
    await assert.rejects(running, /cancelled/u);
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    controller.abort();
    outcome = await settled;
  }
  if (outcome?.status === 'rejected' && !/cancelled/u.test(String(outcome.reason)) && outcome.reason !== failure) {
    if (failed) throw new AggregateError([failure, outcome.reason], 'Native fixture assertion and staging both failed');
    throw outcome.reason;
  }
  if (failed) throw failure;
}

for (const native of [false, true]) {
  test(
    `${native ? 'native ' : ''}failure and cancellation remove only the owned incomplete stage and preserve unrelated output`,
    { tags: ['release'] },
    async () => {
      const api = await producer();
      const f = await fixture(native);
      const controller = new AbortController();
      try {
        const unrelated = join(f.base, 'unrelated');
        mkdirSync(unrelated);
        writeFileSync(join(unrelated, 'keep'), 'keep');
        writeFileSync(join(f.base, 'fail'), 'go');
        await assert.rejects(api.stageRuntime(f.input), /exit 7/u);
        assert.equal(existsSync(f.input.runtimeDirectory), false);
        rmSync(join(f.base, 'fail'));
        writeFileSync(join(f.base, 'wait'), 'go');
        const running = api.stageRuntime({ ...f.input, signal: controller.signal });
        if (native) await cancelNativeStageWhenReady(running, f.input, controller);
        else {
          void running.catch(() => undefined);
          for (let i = 0; i < 100 && !existsSync(join(f.input.runtimeDirectory, 'node_modules/.bin/ai-delivery')); i++)
            await new Promise((resolve) => setTimeout(resolve, 20));
          assert.equal(
            digestBytes(readFileSync(join(f.input.runtimeDirectory, 'reviewed-archive.tgz'))),
            f.input.expectedArchiveSha256,
          );
          controller.abort();
          await assert.rejects(running, /cancelled/u);
        }
        assert.equal(existsSync(f.input.runtimeDirectory), false);
        assert.equal(readFileSync(join(unrelated, 'keep'), 'utf8'), 'keep');
        assert.equal(digestBytes(readFileSync(f.input.archivePath)), f.input.expectedArchiveSha256);
        if (native)
          assert.equal(
            readFileSync(join(f.input.nativePluginRoot!, 'README.md'), 'utf8'),
            'Synthetic copied native plugin.\n',
          );
      } finally {
        controller.abort();
        f.cleanup();
      }
    },
  );
}

test('native cancellation fixture waits for delayed installer readiness', { tags: ['release'] }, async () => {
  const api = await producer();
  const f = await fixture(true);
  const controller = new AbortController();
  writeFileSync(join(f.base, 'wait'), 'go');
  writeFileSync(join(f.base, 'unrelated'), 'keep');
  actors.pauseAuthor = true;
  const running = api.stageRuntime({ ...f.input, signal: controller.signal });
  const settled = running.then(
    () => 'fulfilled' as const,
    () => 'rejected' as const,
  );
  try {
    await cancelNativeStageWhenReady(running, f.input, controller);
    assert.equal(actors.authorStarted, true);
    assert.equal(readFileSync(f.counter, 'utf8'), 'x');
    assert.equal(existsSync(f.input.runtimeDirectory), false);
    assert.equal(readFileSync(join(f.base, 'unrelated'), 'utf8'), 'keep');
    assert.equal(digestBytes(readFileSync(f.input.archivePath)), f.input.expectedArchiveSha256);
    assert.equal(
      readFileSync(join(f.input.nativePluginRoot!, 'README.md'), 'utf8'),
      'Synthetic copied native plugin.\n',
    );
  } finally {
    controller.abort();
    await settled;
    actors.pauseAuthor = false;
    f.cleanup();
  }
});

test('native cancellation fixture preserves an early staging rejection', { tags: ['release'] }, async () => {
  const api = await producer();
  const f = await fixture(true);
  const controller = new AbortController();
  const input = { ...f.input, authority: '', signal: controller.signal };
  const running = api.stageRuntime(input);
  const settled = running.then(
    () => 'fulfilled' as const,
    () => 'rejected' as const,
  );
  try {
    await assert.rejects(
      cancelNativeStageWhenReady(running, input, controller),
      /Explicit runtime:stage authority is required/u,
    );
    assert.equal(existsSync(f.counter), false);
    assert.equal(existsSync(f.input.runtimeDirectory), false);
  } finally {
    controller.abort();
    await settled;
    f.cleanup();
  }
});

test(
  'native cancellation fixture settles a real installer before assertion-failure cleanup',
  { tags: ['release'] },
  async () => {
    const api = await producer();
    const f = await fixture(true);
    const controller = new AbortController();
    writeFileSync(join(f.base, 'wait'), 'go');
    writeFileSync(join(f.base, 'unrelated'), 'keep');
    const running = api.stageRuntime({ ...f.input, signal: controller.signal });
    let finished = false;
    const settled = running.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    const fault = new Error('Synthetic assertion failed with a pending native installer');
    try {
      // Establish readiness independently so this regression isolates teardown ordering.
      while (!existsSync(join(f.input.runtimeDirectory, 'node_modules/.bin/ai-delivery'))) {
        if (finished) await running;
        assert.equal(finished, false, 'Stage settled before the pending installer became ready');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await assert.rejects(
        cancelNativeStageWhenReady(running, f.input, controller, () => {
          throw fault;
        }),
        (error) => error === fault,
      );
      assert.equal(finished, true, 'Fixture cleanup must wait for actual staging settlement');
      assert.equal(existsSync(f.input.runtimeDirectory), false);
      assert.equal(readFileSync(f.counter, 'utf8'), 'x');
      assert.equal(readFileSync(join(f.base, 'unrelated'), 'utf8'), 'keep');
      assert.equal(
        readFileSync(join(f.input.nativePluginRoot!, 'README.md'), 'utf8'),
        'Synthetic copied native plugin.\n',
      );
    } finally {
      controller.abort();
      await settled;
      f.cleanup();
    }
  },
);

async function assertRetirementErrorBoundaries(error: Error, repoRoot: string, forbidden: string[]): Promise<void> {
  const { printCommandError } = await import('./cliResult.js');
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const exitCode = process.exitCode;
  let cliOutput: string;
  try {
    printCommandError(error);
    cliOutput = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    assert.equal(process.exitCode, 1);
  } finally {
    stderr.mockRestore();
    process.exitCode = exitCode;
  }
  const dispatch = await import('./dispatch.js');
  const invoke = vi.spyOn(dispatch, 'executeTool').mockRejectedValueOnce(error);
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createAiDeliveryMcpServer } = await import('./mcp/index.js');
  const server = createAiDeliveryMcpServer({ repoRoot });
  const client = new Client({ name: 'retirement-cause-privacy', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: 'issue_info',
      arguments: { repo: 'example/widget', issueNumber: 17 },
    });
    assert.equal(invoke.mock.calls.length, 1);
    assert.equal(result.isError, true);
    assert.deepEqual(result.content, [{ type: 'text', text: error.message }]);
    const output = cliOutput + JSON.stringify(result);
    assert.ok(output.length < 2048);
    for (const value of forbidden) assert.equal(output.includes(value), false);
  } finally {
    await client.close();
    await server.close();
    invoke.mockRestore();
  }
}

for (const fault of [
  'installer',
  'accessors',
  'cycle',
  'proxy',
  'observer',
  'observer-zero',
  'observer-retired',
  'observer-missing',
  'observer-negative',
  'observer-fractional',
  'observer-unsafe',
  'observer-nonfinite',
  'observer-string',
  'observer-array',
  'observer-malformed',
  'observer-trailing',
  'inherited-message',
  'proxy-root',
] as const) {
  test(
    `output retirement retains a bounded operation cause without exposing ${fault} failure data`,
    { tags: ['release'] },
    async () => {
      const api = await producer();
      const f = await fixture();
      const secret = 'fictional_operation_credential';
      const priorSecret = 'fictional_existing_cause_credential';
      const prior = new Error(priorSecret);
      Object.defineProperty(prior, 'cause', { value: prior });
      const primary = new Error('Synthetic retirement refusal', { cause: prior });
      let reads = 0;
      let operation: unknown = new Error(secret.repeat(2048));
      let expectedNumbers: string | undefined;
      if (fault.startsWith('observer') || fault === 'inherited-message' || fault === 'proxy-root') {
        const metadata: Record<string, unknown> = {
          errorCode: 'ETIMEDOUT',
          elapsedMs: 1001,
          stdoutBytes: 57,
          completeLines: 1,
          rawRows: secret,
          argv: [secret],
        };
        if (fault === 'observer-missing') {
          delete metadata.completeLines;
          Object.defineProperty(metadata, '__proto__', { value: { completeLines: 1 }, enumerable: true });
        } else if (fault === 'observer-negative') metadata.elapsedMs = -1;
        else if (fault === 'observer-fractional') metadata.stdoutBytes = 0.5;
        else if (fault === 'observer-unsafe') metadata.completeLines = Number.MAX_SAFE_INTEGER + 1;
        else if (fault === 'observer-nonfinite') metadata.elapsedMs = Infinity;
        else if (fault === 'observer-string') metadata.stdoutBytes = '57';
        else if (fault === 'observer-zero') {
          metadata.elapsedMs = 0;
          metadata.stdoutBytes = 0;
          metadata.completeLines = 0;
        }
        let payload = JSON.stringify(fault === 'observer-array' ? [metadata] : metadata);
        if (fault === 'observer-malformed') payload = `{"errorCode":"ETIMEDOUT","rawRows":"${secret}"`;
        else if (fault === 'observer-trailing') payload += secret;
        else if (fault === 'observer-retired') payload += ' Output-gate retirement: wrappedOperation=failed.';
        const message = 'Owned process resource observation failed. ' + payload;
        operation = new Error(message);
        if (fault === 'observer' || fault === 'observer-retired')
          expectedNumbers = 'elapsedMs=1001; stdoutBytes=57; completeLines=1';
        else if (fault === 'observer-zero') expectedNumbers = 'elapsedMs=0; stdoutBytes=0; completeLines=0';
        if (fault === 'inherited-message') {
          Reflect.deleteProperty(operation as Error, 'message');
          Object.setPrototypeOf(
            operation,
            Object.create(Error.prototype, {
              message: {
                get: () => {
                  reads++;
                  throw new Error(message);
                },
              },
            }) as object,
          );
        } else if (fault === 'proxy-root') {
          const trap = (): never => {
            reads++;
            throw new Error(secret);
          };
          operation = new Proxy(operation as Error, { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
        }
      }
      if (fault === 'accessors') {
        operation = Object.defineProperties(new Error(), {
          message: {
            get: () => {
              reads++;
              throw new Error(secret);
            },
          },
          name: {
            get: () => {
              reads++;
              throw new Error(secret);
            },
          },
          stack: {
            get: () => {
              reads++;
              throw new Error(secret);
            },
          },
          cause: {
            get: () => {
              reads++;
              throw new Error(secret);
            },
          },
        });
      } else if (fault === 'cycle') {
        Object.defineProperty(operation, 'cause', { value: operation });
        Object.freeze(operation);
      } else if (fault === 'proxy') {
        const trap = (): never => {
          reads++;
          throw new Error(secret);
        };
        operation = new Error(secret, {
          // The spy checks the thrown root with instanceof; the diagnostic must never inspect its hostile cause.
          cause: new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap }),
        });
      }
      const write = atomicJson.writePrivateJsonFileAtomically;
      const injected = vi.spyOn(atomicJson, 'writePrivateJsonFileAtomically').mockImplementation((path, value) => {
        if (fault !== 'installer' && path === join(f.input.runtimeDirectory, 'runtime-stage.json')) throw operation;
        write(path, value);
      });
      try {
        if (fault === 'installer') writeFileSync(join(f.base, 'fail'), '');
        retirementFailure.directory = join(f.root, '.git/ai-delivery/output-observation');
        retirementFailure.error = primary;
        retirementFailure.hits = 0;
        let received: unknown;
        try {
          await api.stageRuntime(f.input);
        } catch (error) {
          received = error;
        }
        assert.equal(retirementFailure.hits, 1, 'the actual gate must retire before the injected refusal');
        assert.equal(received, primary, 'retirement failure keeps its original instance and precedence');
        assert.equal(primary.message, 'Synthetic retirement refusal');
        const cause: unknown = Object.getOwnPropertyDescriptor(primary, 'cause')?.value;
        assert.notEqual(cause, prior, 'the masked operation must have its own bounded diagnostic cause');
        assert.ok(cause instanceof Error);
        assert.match(cause.message, /^Wrapped operation failed/u);
        if (fault === 'installer') assert.match(cause.message, /exit=7/u);
        if (fault.startsWith('observer')) assert.match(cause.message, /observation=ETIMEDOUT/u);
        if (expectedNumbers === undefined)
          assert.doesNotMatch(cause.message, /elapsedMs=|stdoutBytes=|completeLines=/u);
        else assert.ok(cause.message.includes(expectedNumbers));
        assert.ok(cause.message.length < 1024);
        assert.equal(cause.message.includes(secret), false);
        assert.equal(
          Object.getOwnPropertyDescriptor(cause, 'cause')?.value,
          prior,
          'existing retirement cause is retained',
        );
        assert.equal(reads, 0, 'operation getters, proxy traps and cause graphs are never evaluated');
        await assertRetirementErrorBoundaries(primary, f.root, [secret, priorSecret]);
        assert.equal(reads, 0);
        assert.equal(existsSync(f.input.runtimeDirectory), false);
        if (fault === 'installer') assert.equal(readFileSync(f.counter, 'utf8'), 'x');
        else assert.equal(existsSync(f.counter), false);
      } finally {
        retirementFailure.directory = '';
        retirementFailure.error = undefined;
        injected.mockRestore();
        f.cleanup();
      }
    },
  );
}

for (const shape of ['nonextensible', 'readonly', 'accessor', 'mutable-nonextensible'] as const) {
  test(`output retirement preserves primary cause descriptors for ${shape} errors`, { tags: ['release'] }, async () => {
    const api = await producer();
    const f = await fixture();
    const secret = 'fictional_descriptor_credential';
    const prior = new Error(secret);
    const primary = new Error('Synthetic retirement refusal');
    let reads = 0;
    if (shape === 'readonly')
      Object.defineProperty(primary, 'cause', { value: prior, configurable: false, writable: false, enumerable: true });
    else if (shape === 'accessor')
      Object.defineProperty(primary, 'cause', {
        configurable: true,
        get: () => {
          reads++;
          throw new Error(secret);
        },
      });
    else if (shape === 'mutable-nonextensible')
      Object.defineProperty(primary, 'cause', { value: prior, configurable: false, writable: true, enumerable: true });
    if (shape === 'nonextensible' || shape === 'mutable-nonextensible') Object.preventExtensions(primary);
    const before = Object.getOwnPropertyDescriptor(primary, 'cause');
    const operation = new Error(
      'Owned process resource observation failed. {"errorCode":"ETIMEDOUT","elapsedMs":1001,"stdoutBytes":57,"completeLines":1}',
    );
    const write = atomicJson.writePrivateJsonFileAtomically;
    const injected = vi.spyOn(atomicJson, 'writePrivateJsonFileAtomically').mockImplementation((path, value) => {
      if (path === join(f.input.runtimeDirectory, 'runtime-stage.json')) throw operation;
      write(path, value);
    });
    try {
      retirementFailure.directory = join(f.root, '.git/ai-delivery/output-observation');
      retirementFailure.error = primary;
      retirementFailure.hits = 0;
      let received: unknown;
      try {
        await api.stageRuntime(f.input);
      } catch (error) {
        received = error;
      }
      assert.equal(received, primary);
      assert.equal(primary.message, 'Synthetic retirement refusal');
      assert.equal(retirementFailure.hits, 1);
      const after = Object.getOwnPropertyDescriptor(primary, 'cause');
      if (shape === 'mutable-nonextensible') {
        assert.ok(after?.value instanceof Error);
        assert.notEqual(after.value, prior);
        assert.match(after.value.message, /elapsedMs=1001; stdoutBytes=57; completeLines=1/u);
        assert.equal(Object.getOwnPropertyDescriptor(after.value, 'cause')?.value, prior);
        assert.deepEqual({ ...after, value: undefined }, { ...before, value: undefined });
      } else assert.deepEqual(after, before);
      assert.equal(Object.isExtensible(primary), shape === 'readonly' || shape === 'accessor');
      assert.equal(reads, 0);
      await assertRetirementErrorBoundaries(primary, f.root, [secret]);
      assert.equal(reads, 0);
      assert.equal(existsSync(f.input.runtimeDirectory), false);
      assert.equal(existsSync(f.counter), false);
    } finally {
      retirementFailure.directory = '';
      retirementFailure.error = undefined;
      injected.mockRestore();
      f.cleanup();
    }
  });
}

test(
  'output retirement preserves an operation failure when native retirement succeeds',
  { tags: ['release'] },
  async () => {
    const api = await producer();
    const f = await fixture();
    try {
      writeFileSync(join(f.base, 'fail'), '');
      await assert.rejects(api.stageRuntime(f.input), /exit 7/u);
      assert.equal(readFileSync(f.counter, 'utf8'), 'x');
      assert.equal(existsSync(f.input.runtimeDirectory), false);
    } finally {
      f.cleanup();
    }
  },
);

test(
  'output retirement preserves its existing cause after a successful real stage',
  { tags: ['release'] },
  async () => {
    const api = await producer();
    const f = await fixture();
    const prior = new Error('Existing retirement cause');
    const primary = new Error('Synthetic retirement refusal', { cause: prior });
    try {
      retirementFailure.directory = join(f.root, '.git/ai-delivery/output-observation');
      retirementFailure.error = primary;
      retirementFailure.hits = 0;
      await assert.rejects(api.stageRuntime(f.input), (error: unknown) => error === primary);
      assert.equal(retirementFailure.hits, 1);
      assert.equal(primary.cause, prior, 'successful operation does not add a failure cause');
      assert.equal(
        (JSON.parse(readFileSync(join(f.input.runtimeDirectory, 'runtime-stage.json'), 'utf8')) as { status: string })
          .status,
        'complete',
      );
      assert.equal((await api.stageRuntime(f.input)).reused, true);
      assert.equal(readFileSync(f.counter, 'utf8'), 'x');
    } finally {
      retirementFailure.directory = '';
      retirementFailure.error = undefined;
      f.cleanup();
    }
  },
);

test(
  'admission reports unknown durability with exact same-stage reconciliation and preserves desired bytes',
  { tags: ['release'] },
  async () => {
    const api = await producer();
    const f = await fixture();
    try {
      const stage = await api.stageRuntime(f.input);
      const path = join(f.root, '.git/ai-delivery/runtime-admission.json');
      syncFailure.directory = dirname(path);
      await assert.rejects(api.admitRuntime(admitInput(f.input, stage.stageId)), /commit-status-unknown.*same stage/u);
      const desired = readFileSync(path, 'utf8');
      assert.equal((JSON.parse(desired) as RuntimeAdmission).admissionId, stage.admission.admissionId);
      syncFailure.directory = '';
      assert.equal((await api.admitRuntime(admitInput(f.input, stage.stageId))).reused, true);
      assert.equal(readFileSync(path, 'utf8'), desired);
    } finally {
      syncFailure.directory = '';
      f.cleanup();
    }
  },
);

for (const denied of [
  'candidate',
  'symlink',
  'capability',
  'complete-corrupt',
  'archive-drift',
  'source-drift',
  'config-drift',
] as const) {
  test(`setup preserves completed output and admission on ${denied}`, { tags: ['release'] }, async () => {
    const api = await producer();
    const f = await fixture();
    try {
      if (denied === 'candidate') {
        const candidate = join(f.base, 'candidate');
        git(f.root, 'worktree', 'add', '-qb', 'candidate', candidate);
        await assert.rejects(api.stageRuntime({ ...f.input, repoRoot: candidate }), /primary/u);
        assert.equal(existsSync(f.input.runtimeDirectory), false);
        return;
      }
      if (denied === 'symlink') {
        symlinkSync(f.base, join(f.base, 'alias'));
        await assert.rejects(
          api.stageRuntime({ ...f.input, runtimeDirectory: join(f.base, 'alias', 'stage') }),
          /symbolic link/u,
        );
        return;
      }
      if (denied === 'capability') {
        const manifest = join(f.base, 'archive/package/plugins/ai-delivery/.claude-plugin/plugin.json');
        writeFileSync(
          manifest,
          JSON.stringify({ name: 'ai-delivery', packageVersion: '0.3.5', deliveryCapabilityVersion: 1 }),
        );
        execFileSync('tar', ['-czf', f.input.archivePath, '-C', join(f.base, 'archive'), 'package']);
        f.input.expectedArchiveSha256 = digestBytes(readFileSync(f.input.archivePath));
        await assert.rejects(api.stageRuntime(f.input), /capability/u);
        assert.equal(existsSync(f.input.runtimeDirectory), false);
        return;
      }
      const stage = await api.stageRuntime(f.input);
      await api.admitRuntime(admitInput(f.input, stage.stageId));
      const path = join(f.root, '.git/ai-delivery/runtime-admission.json');
      const before = readFileSync(path, 'utf8');
      if (denied === 'complete-corrupt')
        writeFileSync(join(f.input.runtimeDirectory, 'runtime-stage.json'), 'corrupt completion');
      if (denied === 'archive-drift') writeFileSync(f.input.archivePath, 'changed archive');
      if (denied === 'source-drift') git(f.root, 'commit', '--allow-empty', '-qm', 'source drift');
      if (denied === 'config-drift') {
        const userPath = process.env.AI_DELIVERY_CONFIG!;
        const settings = JSON.parse(readFileSync(userPath, 'utf8')) as { roles: { author: { identity: string } } };
        settings.roles.author.identity = 'changed-author';
        writeFileSync(userPath, JSON.stringify(settings));
      }

      await assert.rejects(api.admitRuntime(admitInput(f.input, stage.stageId)));
      assert.equal(readFileSync(path, 'utf8'), before);
      assert.equal(existsSync(f.input.runtimeDirectory), true);
      assert.equal(readFileSync(f.counter, 'utf8'), 'x');
    } finally {
      f.cleanup();
    }
  });
}

test(
  'setup interruption child',
  { tags: ['release'], skip: !process.env.AI_DELIVERY_SETUP_INTERRUPT_INPUT },
  async () => {
    const api = await producer();
    const phase = process.env.AI_DELIVERY_SETUP_LOG_INTERRUPT_PHASE;
    if (phase) {
      const actual = atomicJson.writePrivateJsonFileAtomically;
      vi.spyOn(atomicJson, 'writePrivateJsonFileAtomically').mockImplementation((path, value) => {
        const record = value as { outputs?: { status: string }[] };
        const interrupt =
          path.includes('/runtime-output/') &&
          record.outputs?.[0]?.status === (phase === 'reservation' ? 'reserved' : 'complete');
        if (!(interrupt && phase === 'publication')) actual(path, value);
        if (interrupt) {
          writeFileSync(
            process.env.AI_DELIVERY_SETUP_LOG_INTERRUPT_MARKER!,
            JSON.stringify({ phase, path, owner: process.pid }),
          );
          process.kill(process.pid, 'SIGKILL');
        }
      });
    }
    await api.stageRuntime(JSON.parse(process.env.AI_DELIVERY_SETUP_INTERRUPT_INPUT!) as SetupInput);
  },
);

for (const phase of ['reservation', 'publication'] as const) {
  test(
    `runtime-stage retained-output recovery preserves charges after hard interruption at ${phase}`,
    { tags: ['release'] },
    async () => {
      const api = await producer();
      const f = await fixture();
      const marker = join(f.base, 'log-interruption-marker');
      const input = {
        ...f.input,
        resourceBounds: {
          maxAggregateRssBytes: 512 * 1024 ** 2,
          minFreeDiskBytes: 1,
          maxNewOutputBytes: 128 * 1024 ** 2,
          maxCapturedOutputBytes: 1024 ** 2,
        },
      };
      let child: ReturnType<typeof spawn> | undefined;
      try {
        writeFileSync(join(f.base, 'fail'), 'go');
        writeFileSync(join(f.base, 'log-bytes'), String(100 * 1024));
        child = spawn(
          process.execPath,
          [
            join(process.cwd(), 'node_modules/vitest/vitest.mjs'),
            'run',
            '--mode=compiled',
            new URL(import.meta.url).pathname,
            '-t',
            '^setup interruption child$',
            '--maxWorkers=1',
            '--no-file-parallelism',
          ],
          {
            env: {
              ...process.env,
              AI_DELIVERY_SETUP_INTERRUPT_INPUT: JSON.stringify(input),
              AI_DELIVERY_SETUP_LOG_INTERRUPT_PHASE: phase,
              AI_DELIVERY_SETUP_LOG_INTERRUPT_MARKER: marker,
            },
            stdio: 'ignore',
          },
        );
        await new Promise<void>((resolve) => child!.once('close', () => resolve()));
        assert.equal(existsSync(marker), true, 'hard interruption must occur at the selected durable log boundary');
        const writerPath = join(f.root, '.git/ai-delivery/writers@1', `${digestValue(f.root).slice(7)}.json`);
        const stale = new Date(Date.now() - 20_000);
        utimesSync(`${writerPath}.lock`, stale, stale);
        const { path } = JSON.parse(readFileSync(marker, 'utf8')) as { path: string };
        const prior = JSON.parse(readFileSync(path, 'utf8')) as {
          outputs: { bytes: number; digest: string; status: string }[];
        };
        assert.equal(prior.outputs[0]!.status, 'reserved');
        assert.equal(prior.outputs[0]!.bytes, 100 * 1024);
        const outputDirectory = join(f.root, '.git/ai-delivery/verification@1/command-output');
        const priorOutput = join(outputDirectory, `${prior.outputs[0]!.digest.slice(7)}.bin`);
        assert.equal(existsSync(priorOutput), phase === 'publication');
        const preserved = phase === 'publication' ? readFileSync(priorOutput) : undefined;
        writeFileSync(join(f.base, 'log-bytes'), String(128 * 1024));
        await assert.rejects(api.stageRuntime(input), /exit 7/u);
        const recovered = JSON.parse(readFileSync(path, 'utf8')) as typeof prior;
        assert.equal(
          recovered.outputs.reduce((total, output) => total + output.bytes, 0),
          228 * 1024,
        );
        assert.equal(recovered.outputs[0]!.status, phase === 'publication' ? 'complete' : 'reserved');
        if (preserved) assert.deepEqual(readFileSync(priorOutput), preserved);
        if (phase === 'reservation') {
          writeFileSync(join(f.base, 'log-bytes'), String(100 * 1024));
          await assert.rejects(api.stageRuntime(input), /identical output cannot be rewritten/u);
          assert.equal(
            existsSync(priorOutput),
            false,
            'unresolved reservation must not authorize a second raw-log write',
          );
        }
        rmSync(join(f.base, 'fail'));
        rmSync(join(f.base, 'log-bytes'));
        const completed = await api.stageRuntime(input);
        const count = readFileSync(f.counter, 'utf8');
        assert.equal(completed.reused, false);
        assert.equal((await api.stageRuntime(input)).reused, true);
        assert.equal(readFileSync(f.counter, 'utf8'), count, 'completed recovered stage must skip the installer');
        assert.equal(readFileSync(completed.admission.cliPath, 'utf8'), "#!/usr/bin/env node\nconsole.log('0.3.5');\n");
      } finally {
        if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        f.cleanup();
      }
    },
  );
}

for (const native of [false, true]) {
  test(
    `${native ? 'native ' : ''}stopped setup owners stay busy and orphan recovery confirms cleanup before retrying the incomplete install`,
    { tags: ['release'] },
    async () => {
      const api = await producer();
      const f = await fixture(native);
      let child: ReturnType<typeof spawn> | undefined;
      let ownedPid: number | undefined;
      let ownedIdentity: string | undefined;
      let ownerPid: number | undefined;
      const peer = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
      try {
        writeFileSync(join(f.base, 'wait'), 'go');
        child = spawn(
          process.execPath,
          [
            join(process.cwd(), 'node_modules/vitest/vitest.mjs'),
            'run',
            '--mode=compiled',
            'dist/setup.test.js',
            '-t',
            '^setup interruption child$',
          ],
          {
            cwd: process.cwd(),
            stdio: 'ignore',
            env: { ...process.env, AI_DELIVERY_SETUP_INTERRUPT_INPUT: JSON.stringify(f.input) },
          },
        );
        const closed = new Promise((resolve) => child!.once('close', resolve));
        const writerPath = join(
          f.root,
          '.git/ai-delivery/writers@1',
          `${(await import('./delivery/index.js')).digestValue(f.root).slice(7)}.json`,
        );
        let record:
          | { owner: { pid: number }; command: { phase: string; root?: { pid: number; identity: string } } }
          | undefined;
        // Bound this cold installer-start observation, not the recovery run.
        for (let i = 0; i < 1000; i++) {
          if (existsSync(writerPath)) record = JSON.parse(readFileSync(writerPath, 'utf8')) as typeof record;
          if (record?.command.phase === 'running' && existsSync(f.marker)) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(record?.command.phase, 'running');
        assert.equal(existsSync(f.marker), true, 'interrupt only after the owned installer actually starts');
        const snapshot = join(f.input.runtimeDirectory, 'reviewed-archive.tgz');
        assert.equal(digestBytes(readFileSync(snapshot)), f.input.expectedArchiveSha256);
        ownerPid = record!.owner.pid;
        ownedPid = record!.command.root!.pid;
        ownedIdentity = record!.command.root!.identity;
        process.kill(ownerPid, 'SIGSTOP');
        const stale = new Date(Date.now() - 20_000);
        utimesSync(`${writerPath}.lock`, stale, stale);
        await assert.rejects(api.stageRuntime(f.input), /live verification writer/u);
        assert.equal(readFileSync(f.counter, 'utf8'), 'x');
        process.kill(ownerPid, 'SIGKILL');
        ownerPid = undefined;
        await closed;
        process.kill(ownedPid, 0);
        writeFileSync(snapshot, 'interrupted incomplete snapshot');
        rmSync(join(f.base, 'wait'));
        const recovered = await api.stageRuntime(f.input).catch((error: unknown) => {
          if (error instanceof Error)
            error.message += ` Fictional setup interruption phase=orphan-recovery; native=${native}.`;
          throw error;
        });
        assert.equal(recovered.reused, false);
        assert.equal(readFileSync(f.counter, 'utf8'), 'xx');
        assert.equal(existsSync(writerPath), false);
        assert.equal(digestBytes(readFileSync(snapshot)), f.input.expectedArchiveSha256);
        const completedSnapshot = lstatSync(snapshot);
        process.kill(peer.pid!, 0);
        const state = spawnSync('/bin/ps', ['-p', String(ownedPid), '-o', 'stat='], { encoding: 'utf8' });
        assert.ok(state.status === 1 || state.stdout.trim().startsWith('Z'));
        ownedPid = undefined;
        assert.equal((await api.stageRuntime(f.input)).reused, true);
        assert.equal(readFileSync(f.counter, 'utf8'), 'xx');
        assert.equal(lstatSync(snapshot).ino, completedSnapshot.ino);
        console.log(
          'SETUP_INTERRUPTION_RECEIPT',
          JSON.stringify({
            completedStageId: recovered.stageId,
            installerExecutions: 2,
            peerPreserved: true,
            ownedCleanupConfirmed: true,
            completedRetrySkipped: true,
            incompleteSnapshotRebuilt: true,
            completedSnapshotReused: true,
            archiveSha256: f.input.expectedArchiveSha256,
            nativePluginRoot: f.input.nativePluginRoot ?? null,
          }),
        );
      } finally {
        if (ownerPid !== undefined) {
          process.kill(ownerPid, 'SIGCONT');
          process.kill(ownerPid, 'SIGKILL');
        }
        if (
          ownedPid !== undefined &&
          spawnSync('/bin/ps', ['-p', String(ownedPid), '-o', 'lstart='], { encoding: 'utf8' }).stdout.trim() ===
            ownedIdentity
        )
          process.kill(ownedPid, 'SIGKILL');
        if (peer.exitCode === null && peer.signalCode === null) peer.kill('SIGKILL');
        if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        f.cleanup();
      }
    },
  );
}

test(
  'actual reviewed 0.3.4 archive qualifies with real npm production installation in a temporary synthetic consumer',
  {
    tags: ['release'],
    skip: process.env.AI_DELIVERY_TEST_LANE !== 'release' || !process.env.AI_DELIVERY_REAL_PACKAGE_ARCHIVE,
    timeout: 0,
  },
  async () => {
    const realPath = process.env.PATH;
    const api = await producer();
    const f = await fixture();
    try {
      process.env.PATH = realPath;
      const input = {
        ...f.input,
        archivePath: process.env.AI_DELIVERY_REAL_PACKAGE_ARCHIVE!,
        packageVersion: '0.3.4',
        expectedArchiveSha256: 'sha256:4e5171a4d398dcc486852f08e58f2ef4267765e6f33a34a3ecd5e1ad01830e6d',
      };
      const stage = await api.stageRuntime(input);
      assert.equal(
        execFileSync(process.execPath, [stage.admission.cliPath, '--version'], { encoding: 'utf8' }).trim(),
        '0.3.4',
      );
      assert.equal(stage.admission.capability.mcp, 2);
      assert.equal(existsSync(f.counter), false);
      await api.admitRuntime(admitInput(input, stage.stageId));
      const installedValidatorUrl = new URL(
        `file://${join(dirname(stage.admission.cliPath), 'services/deliveryAdmission.js')}`,
      ).href;
      const installed = (await import(installedValidatorUrl)) as typeof import('./services/deliveryAdmission.js');
      const admitted = await installed.assertDeliveryRuntimeAdmitted({
        repoRoot: f.root,
        runtimeEntryPath: stage.admission.cliPath,
        configuration: await loadDeliveryConfig(f.root),
      });
      assert.equal(admitted.admissionId, stage.admission.admissionId);
      assert.equal((await api.stageRuntime(input)).reused, true);
      console.log(
        'REAL_INSTALLER_QUALIFICATION_RECEIPT',
        JSON.stringify({
          archiveSha256: input.expectedArchiveSha256,
          packageVersion: admitted.packageVersion,
          packageDistSha256: admitted.packageDistSha256,
          cliSha256: admitted.cliSha256,
          pluginManifestSha256: admitted.pluginManifestSha256,
          installedValidator: true,
          installer: 'real npm production dependencies; ignore-scripts',
          httpBoundary: 'synthetic GitHub authentication/discovery',
          temporaryConsumer: true,
          hostActivated: false,
          sharedAdmissionWritten: false,
        }),
      );
    } finally {
      f.cleanup();
    }
  },
);

test(
  'live routing and reviewer access drift cannot replace an already admitted stage',
  { tags: ['release'] },
  async () => {
    const api = await producer();
    const f = await fixture();
    try {
      const stage = await api.stageRuntime(f.input);
      await api.admitRuntime(admitInput(f.input, stage.stageId));
      const path = join(f.root, '.git/ai-delivery/runtime-admission.json');
      const before = readFileSync(path);
      actors.projectId = 'PROJECT-2';
      await assert.rejects(api.admitRuntime(admitInput(f.input, stage.stageId)), /config digest/u);
      const changed = { ...f.input, expectedConfigDigest: (await loadDeliveryConfig(f.root)).configDigest };
      await assert.rejects(api.admitRuntime(admitInput(changed, stage.stageId)), /configuration/u);
      actors.projectId = 'PROJECT-1';
      actors.access = false;
      await assert.rejects(api.admitRuntime(admitInput(f.input, stage.stageId)), /cannot read/u);
      actors.access = true;
      await assert.rejects(api.admitRuntime({ ...admitInput(f.input, stage.stageId), authority: '' }), /authority/u);
      await assert.rejects(api.stageRuntime({ ...f.input, packageVersion: '0.3.4' }), /incompatible/u);
      assert.deepEqual(readFileSync(path), before);
      assert.equal(readFileSync(f.counter, 'utf8'), 'x');
    } finally {
      f.cleanup();
    }
  },
);
