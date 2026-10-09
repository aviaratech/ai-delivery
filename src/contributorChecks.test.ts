import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

type CommandResult = {
  status: string;
  exitCode: number | null;
  stdoutPath: string;
  stderrPath: string;
  cleanupConfirmed?: boolean;
  observedProcesses?: { pid: number; birth: string }[];
};
type CommandOptions = {
  cwd: string;
  env: Record<string, string>;
  directory: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  progress?: (record: object) => void;
};
type Report = {
  status: string;
  fullSuccess: boolean;
  exitCode: number;
  omitted: string[];
  commands: { stage: string; status: string }[];
  selectedTestFiles?: string[];
  error?: string;
  observedTests?: { total: number; passed: number; failed: number };
};
type TestReport = {
  success: boolean;
  numTotalTests: number;
  numPassedTests: number;
  testResults: { name: string; status: string; assertionResults: { fullName: string; status: string }[] }[];
};
type Toolchain = {
  controller: { version: string; executable: string };
  npm: { version: string; executable: string };
  libraryConsumer: { version: string; executable: string };
};
type Checks = {
  FULL_GATES: string[];
  FAST_GATES: string[];
  safeEnvironment(input: Record<string, string>): Record<string, string>;
  validateToolchain(cwd: string, env: Record<string, string>): Toolchain;
  assertCleanSelection(cwd: string): string[];
  treeIdentity(cwd: string): { sha256: string };
  analyzeTests(
    report: TestReport,
    expected: string[],
    cwd: string,
    output: string,
    env?: Record<string, string>,
  ): { files: number; total: number; passed: number; skips: object[] };
  coverageBaseline(
    directory: string,
    cwd: string,
  ): {
    files: { path: string }[];
    unmeasuredContributorScripts: { path: string; threshold: null; reason: string }[];
    thresholdProposal: string;
  };
  executeCommand(command: string[], options: CommandOptions): Promise<CommandResult>;
  runChecks(options: {
    cwd: string;
    resultsDir: string;
    fast?: boolean;
    toolchain?: () => Toolchain;
    execute?: Checks['executeCommand'];
  }): Promise<Report>;
};
const checks = (await import(new URL('../scripts/checks.mjs', import.meta.url).href)) as Checks;
const repository = fileURLToPath(new URL('../', import.meta.url));

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'contributor-check-fixture-'));
  const cwd = join(base, 'repo');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, '.gitignore'), '/dist/\n/node_modules/\n');
  writeFileSync(join(cwd, 'src/original.test.ts'), '// synthetic original test\n');
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({
      name: '@example/fixture',
      version: '1.0.0',
      bin: { fixture: './dist/cli.js' },
      exports: { '.': { default: './dist/index.js' } },
    }),
  );
  execFileSync('git', ['init', '-q', cwd]);
  execFileSync('git', ['add', '.'], { cwd });
  const toolchain: Toolchain = {
    controller: { version: 'v24.21.0', executable: process.execPath },
    npm: { version: '11.19.0', executable: 'synthetic-npm' },
    libraryConsumer: { version: 'v26.2.0', executable: 'synthetic-node26' },
  };
  const cleanup = () => rmSync(base, { recursive: true, force: true });
  return { base, cwd, toolchain, cleanup };
}

function passingReport(cwd: string, names: string[]): TestReport {
  return {
    success: true,
    numTotalTests: names.length,
    numPassedTests: names.length,
    testResults: names.map((name) => ({
      name: join(cwd, name),
      status: 'passed',
      assertionResults: [{ fullName: 'synthetic assertion', status: 'passed' }],
    })),
  };
}

function executor(f: ReturnType<typeof fixture>, failStage = ''): Checks['executeCommand'] {
  return async (command, options) => {
    mkdirSync(options.directory, { recursive: true });
    const stdoutPath = join(options.directory, 'stdout.txt');
    const stderrPath = join(options.directory, 'stderr.txt');
    writeFileSync(stdoutPath, '');
    writeFileSync(stderrPath, '');
    const stage = options.directory.split('/').at(-1)!;
    if (stage === 'build') {
      assert.equal(
        existsSync(join(f.cwd, 'dist/stale.test.js')),
        false,
        'clean before build, rather than after selection',
      );
      mkdirSync(join(f.cwd, 'dist'), { recursive: true });
      const source = existsSync(join(f.cwd, 'src/renamed.test.ts')) ? 'renamed' : 'original';
      writeFileSync(join(f.cwd, `dist/${source}.test.js`), '// compiled synthetic test\n');
    }
    if (stage === 'tests') {
      const names = command.filter((arg) => arg.startsWith('dist/') && arg.endsWith('.test.js'));
      assert.equal(names.length, 1);
      const path = command
        .find((arg) => arg.startsWith('--outputFile.json='))!
        .split('=')
        .slice(1)
        .join('=');
      writeFileSync(path, JSON.stringify(passingReport(f.cwd, names)));
    }
    if (stage === 'inventory') {
      writeFileSync(
        stdoutPath,
        JSON.stringify([
          {
            name: '@example/fixture',
            version: '1.0.0',
            files: [
              'dist/cli.js',
              'dist/index.js',
              'plugins/ai-delivery/runtime/dist/cli.js',
              'plugins/ai-delivery/dist/mcp-launcher.js',
            ].map((path) => ({ path, mode: 0o755 })),
          },
        ]),
      );
      const coverage = options.env.NODE_V8_COVERAGE!;
      mkdirSync(coverage, { recursive: true });
      writeFileSync(
        join(coverage, 'synthetic.json'),
        JSON.stringify({
          result: [
            {
              url: new URL(`file://${join(f.cwd, 'dist/index.js')}`).href,
              functions: [{ ranges: [{ startOffset: 0, endOffset: 1, count: 1 }] }],
            },
          ],
        }),
      );
    }
    const result = {
      status: stage === failStage ? 'failed' : 'passed',
      exitCode: stage === failStage ? 7 : 0,
      stdoutPath,
      stderrPath,
    };
    options.progress?.(result);
    return result;
  };
}

test('local and CI share full entry; fast explicitly omits gates and no CI duplicate build', () => {
  const manifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(manifest.scripts.checks, 'node scripts/current-qualification.mjs');
  assert.equal(manifest.scripts['checks:producer'], 'node scripts/current-qualification.mjs --producer-only');
  assert.equal(manifest.scripts['checks:fast'], 'node scripts/checks.mjs --fast');
  const ci = readFileSync(join(repository, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /npm run checks -- --results-dir/u);
  assert.doesNotMatch(ci, /npm run build|npm pack/u);
  assert.match(ci, /if: always\(\)/u);
  assert.deepEqual(checks.FULL_GATES, ['format', 'lint', 'types', 'build', 'tests', 'inventory']);
});

test('clean full graph removes deleted/renamed compiled tests and retains exact command evidence', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.cwd, 'dist'));
    writeFileSync(join(f.cwd, 'dist/stale.test.js'), '// deleted source output\n');
    renameSync(join(f.cwd, 'src/original.test.ts'), join(f.cwd, 'src/renamed.test.ts'));
    const resultsDir = join(f.base, 'results');
    const report = await checks.runChecks({
      cwd: f.cwd,
      resultsDir,
      toolchain: () => f.toolchain,
      execute: executor(f),
    });
    assert.equal(report.fullSuccess, true);
    assert.deepEqual(
      report.commands.map((entry) => entry.stage),
      checks.FULL_GATES,
    );
    assert.deepEqual(report.selectedTestFiles, ['dist/renamed.test.js']);
    assert.match(readFileSync(join(resultsDir, 'result.txt'), 'utf8'), /FULL contributor checks: passed/u);
    assert.equal(existsSync(join(f.cwd, 'dist/stale.test.js')), false);
    await assert.rejects(checks.runChecks({ cwd: f.cwd, resultsDir }), /Existing result/u);
    writeFileSync(join(f.cwd, 'dist/stale.test.js'), '// unexpected survivor\n');
    assert.throws(() => checks.assertCleanSelection(f.cwd), /stale, deleted, renamed/u);
  } finally {
    f.cleanup();
  }
});

test('fast success and command failure remain partial and preserve omitted/remaining proof', async () => {
  const f = fixture();
  try {
    const fast = await checks.runChecks({
      cwd: f.cwd,
      resultsDir: join(f.base, 'fast'),
      fast: true,
      toolchain: () => f.toolchain,
      execute: executor(f),
    });
    assert.equal(fast.status, 'partial-passed');
    assert.equal(fast.fullSuccess, false);
    assert.deepEqual(fast.omitted, ['build', 'tests', 'inventory']);
    const failed = await checks.runChecks({
      cwd: f.cwd,
      resultsDir: join(f.base, 'failed'),
      toolchain: () => f.toolchain,
      execute: executor(f, 'lint'),
    });
    assert.equal(failed.exitCode, 1);
    assert.equal(failed.fullSuccess, false);
    assert.deepEqual(
      failed.commands.map((entry) => entry.stage),
      ['format', 'lint'],
    );
    assert.match(failed.error!, /lint: failed/u);
    const testFailure = await checks.runChecks({
      cwd: f.cwd,
      resultsDir: join(f.base, 'failed-tests'),
      toolchain: () => f.toolchain,
      execute: executor(f, 'tests'),
    });
    assert.equal(testFailure.fullSuccess, false);
    assert.equal(testFailure.observedTests?.total, 1);
    assert.match(readFileSync(join(f.base, 'failed-tests/result.txt'), 'utf8'), /Observed test results/u);
    assert.equal(testFailure.commands.at(-1)!.status, 'failed');
  } finally {
    f.cleanup();
  }
});

test('toolchain preflight rejects absent/inaccessible/wrong consumer before gates; environment excludes credentials and ambient preloads', async () => {
  const env = checks.safeEnvironment({
    PATH: process.env.PATH!,
    HOME: process.env.HOME!,
    GH_TOKEN: 'fictional-do-not-forward',
    GH_PRIVATE_KEY_GPT_REVIEWER: 'fictional-ref',
    NODE_OPTIONS: '--require fictional',
    NODE_PATH: 'checkout-only',
    NPM_TOKEN: 'fictional-token',
    AI_DELIVERY_REAL_PACKAGE_ARCHIVE: '/synthetic/explicit-historical.tgz',
  });
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NODE_PATH, undefined);
  assert.equal(env.NPM_TOKEN, undefined);
  assert.equal(env.AI_DELIVERY_REAL_PACKAGE_ARCHIVE, '/synthetic/explicit-historical.tgz');
  assert.throws(() => checks.validateToolchain(repository, env), /AI_DELIVERY_NODE26_EXECUTABLE/u);
  assert.throws(
    () =>
      checks.validateToolchain(repository, { ...env, AI_DELIVERY_NODE26_EXECUTABLE: '/nonexistent/synthetic-node' }),
    /ENOENT/u,
  );
  assert.throws(
    () => checks.validateToolchain(repository, { ...env, AI_DELIVERY_NODE26_EXECUTABLE: process.execPath }),
    /Node 26\.2\.0/u,
  );
  const f = fixture();
  try {
    const report = await checks.runChecks({
      cwd: f.cwd,
      resultsDir: join(f.base, 'missing'),
      toolchain: () => {
        throw new Error('missing runtime');
      },
    });
    assert.equal(report.fullSuccess, false);
    assert.deepEqual(report.commands, []);
  } finally {
    f.cleanup();
  }
});

test('selection, counts and explicit skip reasons reject unexpected/zero/excluded or unproved results', () => {
  const cwd = '/synthetic/repo';
  const report = passingReport(cwd, ['dist/setup.test.js']);
  const file = report.testResults[0]!;
  file.assertionResults = [
    {
      fullName:
        'stopped setup owners stay busy and orphan recovery confirms cleanup before retrying the incomplete install',
      status: 'passed',
    },
    {
      fullName:
        'native stopped setup owners stay busy and orphan recovery confirms cleanup before retrying the incomplete install',
      status: 'passed',
    },
    { fullName: 'setup interruption child', status: 'pending' },
    {
      fullName:
        'actual reviewed 0.3.4 archive qualifies with real npm production installation in a temporary synthetic consumer',
      status: 'pending',
    },
  ];
  report.numTotalTests = 4;
  report.numPassedTests = 2;
  const result = checks.analyzeTests(report, ['dist/setup.test.js'], cwd, 'SETUP_INTERRUPTION_RECEIPT');
  assert.equal(result.skips.length, 2);
  assert.throws(
    () =>
      checks.analyzeTests(report, ['dist/setup.test.js'], cwd, 'SETUP_INTERRUPTION_RECEIPT', {
        AI_DELIVERY_REAL_PACKAGE_ARCHIVE: '/synthetic/explicit.tgz',
      }),
    /skipped despite explicit/u,
  );
  assert.match(JSON.stringify(result.skips), /qualification is unexecuted/u);
  assert.throws(() => checks.analyzeTests(report, ['dist/setup.test.js'], cwd, ''), /proof is missing/u);
  assert.throws(() => checks.analyzeTests(report, ['dist/other.test.js'], cwd, ''), /unexpected file/u);
  file.assertionResults[2]!.fullName = 'unexpected conditional skip';
  assert.throws(() => checks.analyzeTests(report, ['dist/setup.test.js'], cwd, ''), /Unexpected skip/u);
  assert.throws(
    () => checks.analyzeTests({ success: true, numTotalTests: 0, numPassedTests: 0, testResults: [] }, [], cwd, ''),
    /Zero tests/u,
  );
});

test('real failed and explicitly timed-out commands preserve logs and prove owned cleanup', async () => {
  const f = fixture();
  try {
    const env = checks.safeEnvironment(process.env as Record<string, string>);
    const failed = await checks.executeCommand(
      [process.execPath, '-e', "console.log('partial failure evidence');process.exit(7)"],
      { cwd: f.cwd, env, directory: join(f.base, 'failure') },
    );
    assert.equal(failed.status, 'failed');
    assert.equal(failed.exitCode, 7);
    assert.match(readFileSync(failed.stdoutPath, 'utf8'), /partial failure evidence/u);
    const timed = await checks.executeCommand(
      [process.execPath, '-e', "console.log('started');setInterval(()=>{},1000)"],
      { cwd: f.cwd, env, directory: join(f.base, 'timeout'), timeoutMs: 200 },
    );
    assert.equal(timed.status, 'command-timeout');
    assert.equal(timed.cleanupConfirmed, true);
    assert.ok(timed.observedProcesses!.length > 0);
    assert.ok(timed.observedProcesses!.every((row) => row.birth.length > 0));
  } finally {
    f.cleanup();
  }
});

test('cancellation reaps observed detached descendants and preserves an unrelated peer', async () => {
  const f = fixture();
  const peer = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  try {
    const controller = new AbortController();
    const marker = join(f.base, 'owned-child');
    const script = `const cp=require('node:child_process'),fs=require('node:fs');const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(marker)},String(c.pid));setInterval(()=>{},1000);`;
    const timer = setInterval(() => {
      if (existsSync(marker)) {
        clearInterval(timer);
        setTimeout(() => controller.abort(), 250);
      }
    }, 20);
    const result = await checks.executeCommand([process.execPath, '-e', script], {
      cwd: f.cwd,
      env: checks.safeEnvironment(process.env as Record<string, string>),
      directory: join(f.base, 'cancelled'),
      signal: controller.signal,
    });
    clearInterval(timer);
    assert.equal(result.status, 'cancelled');
    assert.equal(result.cleanupConfirmed, true);
    const ownedPid = readFileSync(marker, 'utf8');
    const state = execFileSync('/bin/ps', ['-p', ownedPid, '-o', 'stat='], { encoding: 'utf8' }).trim();
    assert.ok(state.startsWith('Z'));
    process.kill(peer.pid!, 0);
  } catch (error) {
    // ps exits1 for an absent child, which is also confirmed cleanup.
    if (!(error instanceof Error && 'status' in error && error.status === 1)) throw error;
    process.kill(peer.pid!, 0);
  } finally {
    peer.kill('SIGKILL');
    await new Promise<void>((done) => {
      if (peer.exitCode !== null || peer.signalCode !== null) done();
      else peer.once('close', () => done());
    });
    f.cleanup();
  }
});

test('existing temporary aliases resolve to the same physical directory without creating a new destination', () => {
  const f = fixture();
  try {
    const target = join(f.base, 'existing-temp');
    const alias = join(f.base, 'temp-alias');
    mkdirSync(target);
    symlinkSync(target, alias);
    const env = checks.safeEnvironment({ TMPDIR: alias, TEMP: alias, TMP: alias });
    assert.equal(env.TMPDIR, realpathSync(target));
    assert.equal(env.TEMP, realpathSync(target));
    assert.equal(env.TMP, realpathSync(target));
    assert.equal(readFileSync(join(f.cwd, 'src/original.test.ts'), 'utf8'), '// synthetic original test\n');
  } finally {
    f.cleanup();
  }
});

test('source identity preserves leading filename whitespace and refuses dangling tracked symlinks', () => {
  const f = fixture();
  try {
    const path = join(f.cwd, ' leading.txt');
    writeFileSync(path, 'first source bytes');
    execFileSync('git', ['add', '--', ' leading.txt'], { cwd: f.cwd });
    const before = checks.treeIdentity(f.cwd).sha256;
    writeFileSync(path, 'changed source bytes');
    assert.notEqual(checks.treeIdentity(f.cwd).sha256, before);
    symlinkSync('nonexistent-target', join(f.cwd, 'dangling-link'));
    execFileSync('git', ['add', '--', 'dangling-link'], { cwd: f.cwd });
    assert.throws(() => checks.treeIdentity(f.cwd), /regular tracked\/source files/u);
  } finally {
    f.cleanup();
  }
});

test('cancellation discovers children born from a detached owner after the root exits and preserves a peer', async () => {
  const f = fixture();
  const peer = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const marker = join(f.base, 'late-children.json');
  const controller = new AbortController();
  const identity = (pid: number) => {
    const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'stat=,lstart='], { encoding: 'utf8' });
    assert.ok(!result.error, result.error?.message);
    assert.ok(result.status === 0 || result.status === 1, result.stderr);
    return result.status === 1 ? undefined : result.stdout.trim();
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    const descendant = `const cp=require('node:child_process'),fs=require('node:fs');
const id=(pid)=>cp.execFileSync('/bin/ps',['-p',String(pid),'-o','stat=,lstart='],{encoding:'utf8'}).trim().split(/\\s+/).slice(1).join(' ');
const record={a:process.pid,aBirth:id(process.pid)};fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(record));
process.once('SIGTERM',()=>setTimeout(()=>{
const root=cp.spawnSync('/bin/ps',['-p',process.argv[1],'-o','stat='],{encoding:'utf8'});
record.rootExited=root.status===1||root.stdout.trim().startsWith('Z');
const b=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
record.b=b.pid;record.bBirth=id(b.pid);fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(record));
},200));setInterval(()=>{},1000);`;
    // The root exits on TERM. Its detached child ignores TERM and births B later.
    const script = `const cp=require('node:child_process');cp.spawn(process.execPath,['-e',${JSON.stringify(descendant)},String(process.pid)],{detached:true,stdio:'ignore'});setInterval(()=>{},1000);`;
    timer = setInterval(() => {
      if (existsSync(marker)) {
        clearInterval(timer);
        setTimeout(() => controller.abort(), 250);
      }
    }, 20);
    const result = await checks.executeCommand([process.execPath, '-e', script], {
      cwd: f.cwd,
      env: checks.safeEnvironment(process.env as Record<string, string>),
      directory: join(f.base, 'late-cancellation'),
      signal: controller.signal,
    });
    const children = JSON.parse(readFileSync(marker, 'utf8')) as {
      a: number;
      aBirth: string;
      b: number;
      bBirth: string;
      rootExited: boolean;
    };
    assert.ok(children.b, 'The TERM-resistant owner must create a late descendant.');
    assert.equal(children.rootExited, true, 'The late descendant must be born after the root exits.');
    assert.equal(result.status, 'cancelled');
    assert.equal(result.cleanupConfirmed, true);
    assert.ok(result.observedProcesses?.some((row) => row.pid === children.b && row.birth === children.bBirth));
    for (const pid of [children.a, children.b]) assert.ok(identity(pid)?.startsWith('Z') ?? true);
    process.kill(peer.pid!, 0);
  } finally {
    clearInterval(timer);
    // On a failing assertion, signal only the synthetic identities this fixture recorded.
    if (existsSync(marker)) {
      const children = JSON.parse(readFileSync(marker, 'utf8')) as {
        a: number;
        aBirth: string;
        b?: number;
        bBirth?: string;
      };
      for (const [pid, birth] of [
        [children.a, children.aBirth],
        [children.b, children.bBirth],
      ] as const) {
        if (pid && birth) {
          const state = identity(pid);
          if (state && !state.startsWith('Z') && state.split(/\s+/u).slice(1).join(' ') === birth)
            process.kill(pid, 'SIGKILL');
        }
      }
    }
    peer.kill('SIGKILL');
    await new Promise<void>((done) => {
      if (peer.exitCode !== null || peer.signalCode !== null) done();
      else peer.once('close', () => done());
    });
    f.cleanup();
  }
});

test('coverage labels unobserved contributor scripts without synthesizing measured ranges or floors', () => {
  const f = fixture();
  try {
    const directory = join(f.base, 'unit-coverage');
    mkdirSync(directory);
    writeFileSync(
      join(directory, 'fixture.json'),
      JSON.stringify({
        result: [
          {
            url: new URL('scripts/build-plugin.mjs', `file://${f.cwd}/`).href,
            functions: [{ ranges: [{ startOffset: 0, endOffset: 1, count: 1 }] }],
          },
        ],
      }),
    );
    const baseline = checks.coverageBaseline(directory, f.cwd);
    assert.deepEqual(
      baseline.files.map((file) => file.path),
      ['scripts/build-plugin.mjs'],
    );
    assert.deepEqual(
      baseline.unmeasuredContributorScripts.map((file) => file.path),
      [
        'scripts/checks.mjs',
        'scripts/pre-commit.mjs',
        'scripts/current-qualification.mjs',
        'scripts/current-consumer.mjs',
      ],
    );
    assert.ok(baseline.unmeasuredContributorScripts.every((file) => file.threshold === null && file.reason.length > 0));
    assert.match(baseline.thresholdProposal, /no derived floor until actual instrumentation/u);
    // This controlled parser fixture is not the measured canonical graph baseline.
  } finally {
    f.cleanup();
  }
});

// Fictional orchestration fixtures exercise the real producer-join validator.
// Archive safety/runtime qualification is covered by the separately owned #90 fixture.
type SyntheticContract = {
  sourceRoot: string;
  sourceCommit: string;
  sourceTree: string;
  sourceManifestSha256: string;
  sourceLockSha256: string;
  packageVersion: string;
  archivePath: string;
  archiveSha256: string;
  dryInventory: { path: string; size: number; mode: number }[];
  producer: {
    checksResultPath: string;
    checksResultSha256: string;
    artifactReceiptPath: string;
    artifactReceiptSha256: string;
  };
};
type Candidate = {
  archiveSha256: string;
  sourceManifestSha256: string;
  sourceLockSha256: string;
  archiveManifestSha256: string;
  packageVersion: string;
  inventorySha256: string;
  inventory: { path: string; size: number; mode: number; sha256: string }[];
  skills: { path: string; sha256: string }[];
};
type QualificationOptions = {
  cwd: string;
  resultsDir: string;
  producerOnly?: boolean;
  resume?: string;
  consumerResult?: string;
  signal?: AbortSignal;
  checks?: (options: { resultsDir: string }) => Promise<Record<string, unknown>>;
  execute?: (command: string[], options: CommandOptions) => Promise<CommandResult>;
  inspect?: (contract: SyntheticContract) => Candidate;
  consumer?: (
    contract: SyntheticContract,
    options: { authorizeInstall: boolean; signal?: AbortSignal },
  ) => Promise<Record<string, unknown>>;
};
const qualification = (await import(new URL('../scripts/current-qualification.mjs', import.meta.url).href)) as {
  sourceIdentity(cwd: string): {
    commit: string;
    tree: string;
    fingerprint: { kind: string; sha256: string; fileCount: number };
  };
  validateCheckpoint(path: string, cwd: string, inspect: NonNullable<QualificationOptions['inspect']>): unknown;
  runQualification(
    options: QualificationOptions,
  ): Promise<{ status: string; qualified: boolean; exitCode: number; error?: string }>;
};
const consumerProof = (await import(new URL('../scripts/current-consumer.mjs', import.meta.url).href)) as {
  sha256(bytes: string | Buffer): string;
  verifyProducerJoin(contract: SyntheticContract, candidate: Candidate): Record<string, unknown>;
};

function qualificationFixture() {
  const f = fixture();
  writeFileSync(join(f.cwd, 'package-lock.json'), '{}\n');
  execFileSync('git', ['add', '.'], { cwd: f.cwd });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fictional fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      'fictional clean source',
    ],
    { cwd: f.cwd },
  );
  let producers = 0;
  let packs = 0;
  let consumers = 0;
  let packStatus = 'passed';
  let cleanup = true;
  let mutateProducer: (report: Record<string, unknown>) => void = () => {};
  const members = [{ path: 'package.json', size: readFileSync(join(f.cwd, 'package.json')).length, mode: 0o644 }];
  const inspect: NonNullable<QualificationOptions['inspect']> = (contract) => {
    assert.equal(consumerProof.sha256(readFileSync(contract.archivePath)), contract.archiveSha256);
    assert.deepEqual(contract.dryInventory, members);
    const inventory = members.map((item) => ({
      ...item,
      sha256: consumerProof.sha256(readFileSync(join(f.cwd, item.path))),
    }));
    return {
      archiveSha256: contract.archiveSha256,
      sourceManifestSha256: contract.sourceManifestSha256,
      sourceLockSha256: contract.sourceLockSha256,
      archiveManifestSha256: contract.sourceManifestSha256,
      packageVersion: contract.packageVersion,
      inventorySha256: consumerProof.sha256(JSON.stringify(inventory)),
      inventory,
      skills: ['intake-create', 'worktree-lifecycle', 'pr-handoff'].map((path) => ({ path, sha256: 'a'.repeat(64) })),
    };
  };
  const produce: NonNullable<QualificationOptions['checks']> = async ({ resultsDir }) => {
    producers++;
    mkdirSync(resultsDir);
    const report: Record<string, unknown> = {
      schemaVersion: 'contributor-checks@1',
      runId: 'fictional-one-producer',
      scope: 'full',
      status: 'passed',
      fullSuccess: true,
      exitCode: 0,
      gates: checks.FULL_GATES,
      omitted: [],
      tree: qualification.sourceIdentity(f.cwd).fingerprint,
      commands: checks.FULL_GATES.map((stage) => ({
        stage,
        status: 'passed',
        exitCode: 0,
        signal: null,
        cleanupConfirmed: true,
      })),
      tests: { files: 1, total: 1, passed: 1, skips: [] },
      selectedTestFiles: ['dist/original.test.js'],
      toolchain: f.toolchain,
      inventory: {
        kind: 'dry-inventory-only',
        name: '@aviaratech/ai-delivery',
        version: '1.0.0',
        fileCount: members.length,
        files: members,
      },
    };
    mutateProducer(report);
    writeFileSync(join(resultsDir, 'result.json'), JSON.stringify(report));
    return report;
  };
  const pack: NonNullable<QualificationOptions['execute']> = async (command, options) => {
    packs++;
    assert.deepEqual(command.slice(2, 5), ['pack', '--ignore-scripts', '--json']);
    mkdirSync(options.directory);
    const destination = command.at(-1)!;
    writeFileSync(join(destination, 'fictional.tgz'), 'fictional archive boundary');
    const stdoutPath = join(options.directory, 'stdout.txt');
    const stderrPath = join(options.directory, 'stderr.txt');
    writeFileSync(stdoutPath, JSON.stringify([{ filename: 'fictional.tgz', files: members }]));
    writeFileSync(stderrPath, '');
    return {
      command,
      startedAt: 'fictional',
      status: packStatus,
      exitCode: packStatus === 'passed' ? 0 : 9,
      signal: null,
      stdoutPath,
      stderrPath,
      cleanupConfirmed: cleanup,
    };
  };
  const consume: NonNullable<QualificationOptions['consumer']> = async (contract, options) => {
    consumers++;
    assert.equal(options.authorizeInstall, true);
    const candidate = inspect(contract);
    return {
      schemaVersion: 'ai-delivery.current-consumer@1',
      boundary: 'current-artifact',
      status: 'passed',
      qualified: true,
      sourceIdentityVerified: true,
      scriptsDisabled: true,
      sourceCommit: contract.sourceCommit,
      sourceTree: contract.sourceTree,
      sourceManifestSha256: contract.sourceManifestSha256,
      sourceLockSha256: contract.sourceLockSha256,
      archiveManifestSha256: contract.sourceManifestSha256,
      archiveSha256: contract.archiveSha256,
      packageVersion: contract.packageVersion,
      inventorySha256: candidate.inventorySha256,
      inventory: candidate.inventory,
      producerJoin: consumerProof.verifyProducerJoin(contract, candidate),
      cleanup: { quiescent: true, removed: true },
      productionClosure: {},
      mcp: {},
      skills: candidate.skills,
      resolutions: ['fictional owned resolution'],
      phases: [
        'node24',
        'node26',
        'npm',
        'production-install',
        'production-closure',
        'cli-version',
        'cli-json',
        'exports-node24',
        'library-node26',
        'packaged-mcp',
      ].map((phase) => ({ phase, code: 0, signal: null, quiescent: true })),
    };
  };
  const options: QualificationOptions = {
    cwd: f.cwd,
    resultsDir: join(f.base, 'qualification'),
    checks: produce,
    execute: pack,
    inspect,
    consumer: consume,
  };
  return {
    ...f,
    options,
    inspect,
    consume,
    counts: () => ({ producers, packs, consumers }),
    mutate: (fn: typeof mutateProducer) => {
      mutateProducer = fn;
    },
    packFailure: (status: string, quiescent = true) => {
      packStatus = status;
      cleanup = quiescent;
    },
  };
}

test('qualification checkpoints one producer and pack, resumes without replay, and retains immutable digests', async () => {
  const f = qualificationFixture();
  try {
    const report = await qualification.runQualification({ ...f.options, producerOnly: true });
    assert.equal(report.status, 'incomplete');
    assert.equal(report.qualified, false);
    assert.equal(report.exitCode, 2);
    assert.deepEqual(f.counts(), { producers: 1, packs: 1, consumers: 0 });
    const checkpoint = join(f.options.resultsDir, 'checkpoint.json');
    const producer = readFileSync(join(f.options.resultsDir, 'producer/result.json'));
    const resumed = await qualification.runQualification({
      ...f.options,
      resume: checkpoint,
      resultsDir: join(f.base, 'resumed'),
    });
    assert.equal(resumed.qualified, true);
    assert.equal(resumed.exitCode, 0);
    assert.deepEqual(f.counts(), { producers: 1, packs: 1, consumers: 1 });
    assert.deepEqual(readFileSync(join(f.options.resultsDir, 'producer/result.json')), producer);
    await assert.rejects(
      qualification.runQualification({ ...f.options, resume: checkpoint, resultsDir: join(f.base, 'resumed') }),
      /Existing overall result/u,
    );
  } finally {
    f.cleanup();
  }
});

test('full qualification executes one producer, actual pack and consumer in order', async () => {
  const f = qualificationFixture();
  try {
    const report = await qualification.runQualification(f.options);
    assert.equal(report.qualified, true);
    assert.deepEqual(f.counts(), { producers: 1, packs: 1, consumers: 1 });
  } finally {
    f.cleanup();
  }
});

for (const mutation of ['zero-selection', 'counts', 'skip', 'inventory', 'command-cleanup', 'ordered-gates']) {
  test(`qualification rejects ${mutation} producer proof without installation`, async () => {
    const f = qualificationFixture();
    try {
      f.mutate((report) => {
        if (mutation === 'zero-selection') report.selectedTestFiles = [];
        if (mutation === 'counts') report.tests = { files: 1, total: 99, passed: 1, skips: [] };
        if (mutation === 'skip')
          report.tests = {
            files: 1,
            total: 2,
            passed: 1,
            skips: [{ file: 'dist/original.test.js', title: 'unreviewed', kind: 'arbitrary' }],
          };
        if (mutation === 'inventory')
          report.inventory = {
            kind: 'dry-inventory-only',
            name: '@aviaratech/ai-delivery',
            version: '1.0.0',
            fileCount: 0,
            files: [],
          };
        if (mutation === 'command-cleanup')
          report.commands = checks.FULL_GATES.map((stage) => ({
            stage,
            status: 'passed',
            exitCode: 0,
            signal: null,
            cleanupConfirmed: false,
          }));
        if (mutation === 'ordered-gates') report.gates = [...checks.FULL_GATES].reverse();
      });
      const report = await qualification.runQualification(f.options);
      assert.equal(report.qualified, false);
      assert.equal(report.status, 'failed');
      assert.equal(f.counts().consumers, 0);
    } finally {
      f.cleanup();
    }
  });
}

for (const mutation of ['wrong-head', 'producer-digest', 'archive-digest', 'contract-digest']) {
  test(`resume rejects ${mutation} without replaying any process`, async () => {
    const f = qualificationFixture();
    try {
      await qualification.runQualification({ ...f.options, producerOnly: true });
      const checkpoint = join(f.options.resultsDir, 'checkpoint.json');
      if (mutation === 'wrong-head')
        execFileSync(
          'git',
          [
            '-c',
            'user.name=Fictional fixture',
            '-c',
            'user.email=fixture@example.invalid',
            '-c',
            'core.hooksPath=/dev/null',
            'commit',
            '--allow-empty',
            '-qm',
            'different head same tree',
          ],
          { cwd: f.cwd },
        );
      if (mutation === 'producer-digest') writeFileSync(join(f.options.resultsDir, 'producer/result.json'), '{}');
      if (mutation === 'archive-digest') writeFileSync(join(f.options.resultsDir, 'pack/fictional.tgz'), 'changed');
      if (mutation === 'contract-digest') {
        const value = JSON.parse(readFileSync(checkpoint, 'utf8')) as { contractSha256: string };
        value.contractSha256 = '0'.repeat(64);
        writeFileSync(checkpoint, JSON.stringify(value));
      }
      const resumed = await qualification.runQualification({
        ...f.options,
        resume: checkpoint,
        resultsDir: join(f.base, 'resume-bad'),
      });
      assert.equal(resumed.status, 'failed');
      assert.equal(resumed.qualified, false);
      assert.deepEqual(f.counts(), { producers: 1, packs: 1, consumers: 0 });
    } finally {
      f.cleanup();
    }
  });
}

test('external consumer join never installs twice and rejects unconfirmed owned removal', async () => {
  const f = qualificationFixture();
  try {
    await qualification.runQualification({ ...f.options, producerOnly: true });
    const contract = JSON.parse(readFileSync(join(f.options.resultsDir, 'contract.json'), 'utf8')) as SyntheticContract;
    const receipt = await f.consume(contract, { authorizeInstall: true });
    const consumerResult = join(f.base, 'external-consumer.json');
    writeFileSync(consumerResult, JSON.stringify(receipt));
    const resume = join(f.options.resultsDir, 'checkpoint.json');
    const joined = await qualification.runQualification({
      ...f.options,
      resume,
      consumerResult,
      resultsDir: join(f.base, 'join'),
    });
    assert.equal(joined.qualified, true);
    assert.deepEqual(f.counts(), { producers: 1, packs: 1, consumers: 1 });
    receipt.cleanup = { quiescent: true, removed: false };
    writeFileSync(consumerResult, JSON.stringify(receipt));
    const bad = await qualification.runQualification({
      ...f.options,
      resume,
      consumerResult,
      resultsDir: join(f.base, 'bad-join'),
    });
    assert.equal(bad.qualified, false);
    assert.match(bad.error!, /removal/u);
  } finally {
    f.cleanup();
  }
});

for (const status of ['failed', 'timed-out', 'cancelled', 'cleanup-unconfirmed']) {
  test(`actual pack ${status} cannot produce a successful checkpoint`, async () => {
    const f = qualificationFixture();
    try {
      f.packFailure(status === 'cleanup-unconfirmed' ? 'passed' : status, status !== 'cleanup-unconfirmed');
      const report = await qualification.runQualification(f.options);
      assert.equal(report.qualified, false);
      assert.equal(existsSync(join(f.options.resultsDir, 'checkpoint.json')), false);
      assert.equal(f.counts().consumers, 0);
    } finally {
      f.cleanup();
    }
  });
}

test('pre-start cancellation and inside-source evidence refuse all graph launches', async () => {
  const f = qualificationFixture();
  try {
    const controller = new AbortController();
    controller.abort();
    const report = await qualification.runQualification({ ...f.options, signal: controller.signal });
    assert.equal(report.status, 'cancelled');
    assert.equal(report.exitCode, 130);
    assert.deepEqual(f.counts(), { producers: 0, packs: 0, consumers: 0 });
    await assert.rejects(
      qualification.runQualification({ ...f.options, resultsDir: join(f.cwd, '..looks-outside') }),
      /outside source/u,
    );
    assert.deepEqual(f.counts(), { producers: 0, packs: 0, consumers: 0 });
  } finally {
    f.cleanup();
  }
});
