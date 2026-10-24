import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  scope: string;
  status: string;
  fullSuccess: boolean;
  exitCode: number;
  omitted: string[];
  commands: { stage: string; status: string; command: string[] }[];
  selectedTestFiles?: string[];
  error?: string;
  observedTests?: { total: number; passed: number; failed: number };
  artifactQualified: boolean;
};
type CaseIdentity = { file: string; title: string };
type ReleaseContext = {
  contractPath: string;
  checkpoint: { path: string; sha256: string };
  sourceCommit: string;
  sourceTree: string;
  sourceManifestSha256: string;
  sourceLockSha256: string;
  producerSha256: string;
  archiveSha256: string;
};
type TestReport = {
  success: boolean;
  numTotalTests: number;
  numPassedTests: number;
  testResults: {
    name: string;
    status: string;
    assertionResults: { fullName: string; status: string; tags?: string[] }[];
  }[];
};
type Toolchain = {
  controller: { version: string; executable: string };
  npm: { version: string; executable: string };
  libraryConsumer: { version: string; executable: string };
};
type Checks = {
  RELEASE_CASES: (CaseIdentity & { kind: 'mandatory' | 'external-historical-qualification' })[];
  FULL_GATES: string[];
  FAST_GATES: string[];
  safeEnvironment(input: Record<string, string>): Record<string, string>;
  validateToolchain(cwd: string, env: Record<string, string>): Toolchain;
  expectedTests(cwd: string, mode?: string): string[];
  assertCleanSelection(cwd: string): string[];
  treeIdentity(cwd: string): { sha256: string };
  analyzeTests(
    report: TestReport,
    expected: string[],
    cwd: string,
    output: string,
    env?: Record<string, string>,
    lane?: 'pr' | 'release',
  ): {
    files: number;
    total: number;
    passed: number;
    skips: object[];
    selectedCases: CaseIdentity[];
    laneExcluded: CaseIdentity[];
  };
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
    testFiles?: string[];
    buildPlugin?: boolean;
    install?: boolean;
    toolchain?: () => Toolchain;
    execute?: Checks['executeCommand'];
    environment?: Record<string, string>;
    release?: ReleaseContext;
  }): Promise<Report>;
};
const checks = (await import(new URL('../scripts/checks.mjs', import.meta.url).href)) as Checks;
const repository = fileURLToPath(new URL('../', import.meta.url));

test('Vitest source and compiled projects select every input once with core-aware workers', async () => {
  const f = fixture();
  try {
    const { default: configure } = (await import(pathToFileURL(join(repository, 'vitest.config.ts')).href)) as {
      default: (env: { mode: string }) => {
        test: {
          testTimeout: number;
          pool: string;
          projects: {
            test: { name: string; maxWorkers: number; fileParallelism: boolean; sequence: { groupOrder: number } };
          }[];
        };
      };
    };
    assert.equal(typeof configure, 'function');
    for (const mode of ['source', 'compiled']) {
      const config = configure({ mode }).test;
      const parallel = config.projects.find((project) => project.test.name === 'parallel')!.test;
      const serial = config.projects.find((project) => project.test.name === 'serial')!.test;
      assert.ok(Number.isFinite(config.testTimeout) && config.testTimeout > 0);
      assert.equal(config.pool, 'forks');
      assert.equal(parallel.maxWorkers, availableParallelism());
      assert.equal(serial.fileParallelism, false);
      assert.equal(serial.maxWorkers, 1);
      assert.ok(parallel.sequence.groupOrder < serial.sequence.groupOrder);
      const output = join(f.base, `projects-${mode}.json`);
      execFileSync(
        process.execPath,
        [
          join(repository, 'node_modules/vitest/vitest.mjs'),
          'list',
          `--mode=${mode}`,
          '--filesOnly',
          `--json=${output}`,
        ],
        {
          cwd: repository,
          env: checks.safeEnvironment({ PATH: process.env.PATH ?? '' }),
          encoding: 'utf8',
          maxBuffer: 1024 ** 2,
        },
      );
      const rows = JSON.parse(readFileSync(output, 'utf8')) as { file: string; projectName: string }[];
      const selected = rows.map((row) => relative(repository, row.file).replaceAll('\\', '/'));
      assert.deepEqual([...selected].sort(), checks.expectedTests(repository, mode));
      assert.equal(new Set(selected).size, selected.length, 'No file may belong to both projects');
      assert.deepEqual([...new Set(rows.map((row) => row.projectName))].sort(), ['parallel', 'serial']);
      for (const name of ['setup', 'lifecycle', 'contributorChecks']) {
        assert.ok(
          rows.some(
            (row) =>
              row.file.endsWith(mode === 'compiled' ? `/dist/${name}.test.js` : `/src/${name}.test.ts`) &&
              row.projectName === 'serial',
          ),
        );
      }
    }
  } finally {
    f.cleanup();
  }
});

test('ordinary full and focused checks exclude release cases without claiming archive proof', async () => {
  for (const focused of [false, true]) {
    const f = fixture();
    try {
      const delegated = executor(f);
      const report = await checks.runChecks({
        cwd: f.cwd,
        resultsDir: join(f.base, 'checks'),
        ...(focused ? { fast: true, testFiles: ['dist/original.test.js'] } : {}),
        toolchain: () => f.toolchain,
        environment: {
          ...checks.safeEnvironment({}),
          AI_DELIVERY_TEST_LANE: 'release',
          AI_DELIVERY_RELEASE_CONTRACT: '/ambient/untrusted',
        },
        execute: (command, options) => {
          assert.equal(options.env.AI_DELIVERY_TEST_LANE, 'pr');
          assert.equal(options.env.AI_DELIVERY_RELEASE_CONTRACT, undefined);
          return delegated(command, options);
        },
      });
      const testCommand = report.commands.find((command) => command.stage === 'tests')!.command;
      assert.equal(
        testCommand.some((argument) => argument.startsWith('--maxWorkers')),
        false,
      );
      assert.equal(report.status, focused ? 'partial-passed' : 'passed');
      assert.equal(report.artifactQualified, false);
      if (!focused) assert.deepEqual(report.omitted, []);
      const command = report.commands.find((command) => command.stage === 'tests')?.command;
      assert.ok(command?.includes('--tags-filter=!release'));
      assert.ok(
        !report.commands.some((command) =>
          command.command.some((arg) => /current-consumer|current-qualification/u.test(arg)),
        ),
      );
    } finally {
      f.cleanup();
    }
  }
});

test('PR reports exclude release identities while scoped release reports require all mandatory outcomes', () => {
  assert.ok(Array.isArray(checks.RELEASE_CASES));
  const mandatory = checks.RELEASE_CASES.filter((test) => test.kind === 'mandatory');
  assert.equal(new Set(mandatory.map(({ file, title }) => JSON.stringify([file, title]))).size, mandatory.length);
  const f = fixture();
  const files = [...new Set(checks.RELEASE_CASES.map((test) => test.file))];
  const report = (release: boolean): TestReport => {
    const testResults = files.map((file) => ({
      name: join(f.cwd, file),
      status: 'passed',
      assertionResults: [
        ...(release ? [] : [{ fullName: 'synthetic retained unit', status: 'passed' }]),
        ...checks.RELEASE_CASES.filter((test) => test.file === file).map((test) => ({
          fullName: test.title,
          status: release && test.kind === 'mandatory' ? 'passed' : 'pending',
        })),
      ],
    }));
    const cases = testResults.flatMap((file) => file.assertionResults);
    return {
      success: true,
      testResults,
      numTotalTests: cases.length,
      numPassedTests: cases.filter((test) => test.status === 'passed').length,
    };
  };
  try {
    const pr = checks.analyzeTests(
      report(false),
      files,
      f.cwd,
      '',
      { AI_DELIVERY_REAL_PACKAGE_ARCHIVE: '/explicit-historical-input' },
      'pr',
    );
    assert.equal(pr.passed, files.length);
    assert.equal(pr.total, files.length);
    assert.deepEqual(pr.skips, []);
    assert.equal(pr.laneExcluded.length, checks.RELEASE_CASES.length);
    const release = checks.analyzeTests(report(true), files, f.cwd, '', {}, 'release');
    assert.equal(release.passed, checks.RELEASE_CASES.filter((test) => test.kind === 'mandatory').length);
    assert.equal(release.skips.length, 1);
    for (const failure of ['missing', 'duplicate', 'unexpected', 'failed', 'pr-executed', 'historical-input']) {
      const data = report(failure !== 'pr-executed');
      const tests = data.testResults[0]!.assertionResults;
      if (failure === 'missing') tests.shift();
      if (failure === 'duplicate') tests.push({ ...tests[0]! });
      if (failure === 'unexpected') tests.push({ fullName: 'unreviewed release case', status: 'passed' });
      if (failure === 'failed') tests[0]!.status = 'failed';
      if (failure === 'pr-executed') tests[1]!.status = 'passed';
      const cases = data.testResults.flatMap((file) => file.assertionResults);
      data.numTotalTests = cases.length;
      data.numPassedTests = cases.filter((test) => test.status === 'passed').length;
      assert.throws(
        () =>
          checks.analyzeTests(
            data,
            files,
            f.cwd,
            '',
            failure === 'historical-input' ? { AI_DELIVERY_REAL_PACKAGE_ARCHIVE: '/explicit-historical-input' } : {},
            failure === 'pr-executed' ? 'pr' : 'release',
          ),
        failure,
      );
    }
  } finally {
    f.cleanup();
  }
});

test('runtime-expanded tags match every reviewed mandatory identity without executing cases', () => {
  const f = fixture();
  try {
    const config = join(f.base, 'collection-only.config.mjs');
    const base = pathToFileURL(join(repository, 'vitest.config.ts')).href;
    writeFileSync(
      config,
      `if(!process.argv.includes('list'))throw new Error('Collection only');const base=(await import(${JSON.stringify(base)})).default({mode:'compiled'});export default {...base,test:{...base.test,tags:base.test.tags.map(tag=>tag.name==='release'?{...tag,skip:false}:tag)}};`,
    );
    const output = join(f.base, 'inventory.json');
    execFileSync(
      process.execPath,
      [
        join(repository, 'node_modules/vitest/vitest.mjs'),
        'list',
        ...new Set(checks.RELEASE_CASES.map((test) => test.file)),
        '--tags-filter=release',
        '--no-staticParse',
        '--maxWorkers=1',
        `--config=${config}`,
        `--json=${output}`,
      ],
      {
        cwd: repository,
        env: { ...checks.safeEnvironment({ PATH: process.env.PATH ?? '' }), AI_DELIVERY_TEST_LANE: 'pr' },
        encoding: 'utf8',
        maxBuffer: 1024 ** 2,
      },
    );
    const rows = JSON.parse(readFileSync(output, 'utf8')) as { file: string; name: string }[];
    const actual = rows.map((row) => ({
      file: relative(repository, row.file).replaceAll('\\', '/'),
      title: row.name.replaceAll(' > ', ' '),
    }));
    const expected = checks.RELEASE_CASES.filter((test) => test.kind === 'mandatory').map(({ file, title }) => ({
      file,
      title,
    }));
    assert.equal(actual.length, expected.length);
    const compare = (a: CaseIdentity, b: CaseIdentity) => JSON.stringify(a).localeCompare(JSON.stringify(b));
    assert.deepEqual(actual.sort(compare), expected.sort(compare));
  } finally {
    f.cleanup();
  }
});

test('unknown lane and mismatched release context fail before child launch', async () => {
  const f = fixture();
  try {
    let calls = 0;
    const release: ReleaseContext = {
      contractPath: join(f.base, 'missing/contract.json'),
      checkpoint: { path: join(f.base, 'missing/checkpoint.json'), sha256: 'a'.repeat(64) },
      sourceCommit: 'a'.repeat(40),
      sourceTree: 'b'.repeat(40),
      sourceManifestSha256: 'a'.repeat(64),
      sourceLockSha256: 'b'.repeat(64),
      producerSha256: 'c'.repeat(64),
      archiveSha256: 'd'.repeat(64),
    };
    for (const options of [
      { environment: { AI_DELIVERY_TEST_LANE: 'unknown' } },
      { release },
      { release, fast: true },
    ]) {
      const result = await checks.runChecks({
        cwd: f.cwd,
        resultsDir: join(f.base, `invalid-${calls}-${Object.keys(options).join('-')}`),
        toolchain: () => f.toolchain,
        ...options,
        execute: (command, options) => {
          calls++;
          return executor(f)(command, options);
        },
      });
      assert.equal(result.status, 'failed');
      assert.equal(calls, 0);
    }
  } finally {
    f.cleanup();
  }
});

function directFocus(f: ReturnType<typeof fixture>, title: string, env: Record<string, string>, name: string) {
  const marker = join(f.base, `${name}-npm-launched`);
  const loaded = join(f.base, `${name}-guard-loaded`);
  const guard = join(f.base, `${name}-guard.mjs`);
  writeFileSync(
    guard,
    `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {appendFileSync,writeFileSync} from 'node:fs';appendFileSync(${JSON.stringify(loaded)},String(process.pid)+String.fromCharCode(10));for(const name of ['spawn','spawnSync','execFile','execFileSync','exec','execSync','fork']){const original=cp[name];cp[name]=function(command,args,...rest){if([command,...(Array.isArray(args)?args:[])].some(x=>['npm','npm-cli.js'].includes(String(x).split('/').at(-1)))){writeFileSync(${JSON.stringify(marker)},'forbidden npm launch');throw new Error('Controlled direct-focus guard forbids npm');}return Reflect.apply(original,this,[command,args,...rest]);};}syncBuiltinESMExports();`,
  );
  const guardUrl = pathToFileURL(guard).href;
  const workerArgs = ['--maxWorkers=1', '--pool=forks', `--execArgv=--import=${guardUrl}`, '--no-cache'];
  const childEnv = { ...checks.safeEnvironment({ PATH: process.env.PATH ?? '' }), ...env };
  // Prove interception inside the pinned worker before selecting any real-case body.
  // A broken preload can only try the probe's nonexistent script, which cannot run npm.
  mkdirSync(join(f.cwd, 'dist'), { recursive: true });
  if (!existsSync(join(f.cwd, 'node_modules')))
    symlinkSync(join(repository, 'node_modules'), join(f.cwd, 'node_modules'));
  const config = join(f.cwd, 'guard.config.mjs');
  writeFileSync(
    config,
    `import {defineConfig} from 'vitest/config';export default defineConfig({test:{include:['dist/guard.test.js']}});`,
  );
  writeFileSync(
    join(f.cwd, 'dist/guard.test.js'),
    `import assert from 'node:assert/strict';import {execFileSync,spawnSync} from 'node:child_process';import {test} from 'vitest';test('controlled worker npm guard',()=>{assert.throws(()=>execFileSync(process.execPath,['/controlled/nonexistent/npm-cli.js']),/Controlled direct-focus guard forbids npm/);});test('controlled shell npm guard',()=>{assert.throws(()=>spawnSync('/bin/sh',['-c','exit 125','controlled','/controlled/nonexistent/npm']),/Controlled direct-focus guard forbids npm/);});`,
  );
  const probeReport = join(f.base, `${name}-probe.json`);
  const probe = spawnSync(
    process.execPath,
    [
      '--import',
      guardUrl,
      join(repository, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--root',
      f.cwd,
      '--config',
      config,
      ...workerArgs,
      '--reporter=json',
      `--outputFile.json=${probeReport}`,
    ],
    { cwd: f.cwd, env: childEnv, encoding: 'utf8', maxBuffer: 1024 ** 2 },
  );
  assert.equal(probe.status, 0, probe.stderr.slice(-1500));
  assert.equal((JSON.parse(readFileSync(probeReport, 'utf8')) as TestReport).numPassedTests, 2);
  assert.equal(existsSync(marker), true, 'The fake npm invocation must be intercepted inside the worker.');
  assert.ok(readFileSync(loaded, 'utf8').trim().split(String.fromCharCode(10)).length >= 2);
  rmSync(marker);
  const reportPath = join(f.base, `${name}.json`);
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      guardUrl,
      join(repository, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--mode=compiled',
      'dist/setup.test.js',
      ...workerArgs,
      '-t',
      title,
      '--reporter=json',
      `--outputFile.json=${reportPath}`,
    ],
    { cwd: repository, env: childEnv, encoding: 'utf8', maxBuffer: 1024 ** 2 },
  );
  assert.equal(existsSync(marker), false, 'No npm subprocess may launch, even if the direct-entry guard regresses.');
  assert.ok(existsSync(loaded), 'The direct-process npm guard must load.');
  return { result, reportPath, loaded };
}

test('direct-focus npm interception reaches the pinned worker before real-case selection', () => {
  const f = fixture();
  try {
    const run = directFocus(f, 'controlled nonexistent selection', {}, 'worker-probe');
    assert.equal(run.result.status, 0);
  } finally {
    f.cleanup();
  }
});

test('historical archive input cannot override direct-focus PR exclusion', () => {
  const f = fixture();
  const title =
    'actual reviewed 0.3.4 archive qualifies with real npm production installation in a temporary synthetic consumer';
  try {
    for (const lane of ['absent', 'pr']) {
      const run = directFocus(
        f,
        title,
        {
          ...(lane === 'pr' ? { AI_DELIVERY_TEST_LANE: lane } : {}),
          AI_DELIVERY_REAL_PACKAGE_ARCHIVE: join(f.base, 'explicit-unavailable-historical-input'),
        },
        lane,
      );
      assert.equal(run.result.status, 0, run.result.stderr.slice(-1500));
      const report = JSON.parse(readFileSync(run.reportPath, 'utf8')) as TestReport;
      const selected = report.testResults
        .flatMap((file) => file.assertionResults)
        .find((test) => test.fullName === title);
      assert.ok(selected && ['pending', 'skipped'].includes(selected.status));
      assert.ok(selected.tags?.includes('release'));
      assert.ok(
        readFileSync(run.loaded, 'utf8').trim().split('\n').length >= 2,
        'The controlled guard must reach the forked worker.',
      );
    }
  } finally {
    f.cleanup();
  }
});

test('direct release focus rejects invalid contracts before any npm launch', () => {
  const f = fixture();
  try {
    for (const kind of ['absent', 'missing', 'malformed']) {
      const contractPath = join(f.base, kind, 'contract.json');
      if (kind === 'malformed') {
        mkdirSync(dirname(contractPath));
        writeFileSync(contractPath, '{broken');
      }
      const run = directFocus(
        f,
        '(?!)',
        {
          AI_DELIVERY_TEST_LANE: 'release',
          ...(kind === 'absent' ? {} : { AI_DELIVERY_RELEASE_CONTRACT: contractPath }),
        },
        kind,
      );
      assert.notEqual(run.result.status, 0);
      assert.match(run.result.stderr + run.result.stdout, /contract|checkpoint/iu);
    }
  } finally {
    f.cleanup();
  }
});

test('qualification CLI finishes module loading before its owned graph reuses the validator', () => {
  const f = fixture();
  try {
    const scripts = join(f.cwd, 'scripts');
    mkdirSync(scripts);
    const entry = join(scripts, 'current-qualification.mjs');
    writeFileSync(entry, readFileSync(join(repository, 'scripts/current-qualification.mjs')));
    const marker = join(f.base, 'module-ready');
    writeFileSync(
      join(scripts, 'checks.mjs'),
      `export {RELEASE_CASES,confirmCommandQuiescence,errorMessage,executeCommand,safeEnvironment,treeIdentity} from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/checks.mjs')).href)};import {writeFileSync} from 'node:fs';export async function runChecks(){await import('./current-qualification.mjs');writeFileSync(${JSON.stringify(marker)},'ready');throw new Error('Controlled stop before pack');}`,
    );
    writeFileSync(
      join(scripts, 'current-consumer.mjs'),
      `export {inspectCandidate,sha256,verifyProducerJoin} from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/current-consumer.mjs')).href)};`,
    );
    writeFileSync(
      join(f.cwd, 'package.json'),
      JSON.stringify({ type: 'module', name: '@example/entry-fixture', version: '0.0.0' }),
    );
    writeFileSync(join(f.cwd, 'package-lock.json'), '{}\n');
    execFileSync('git', ['add', '.'], { cwd: f.cwd });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fictional Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'controlled entry source',
      ],
      { cwd: f.cwd },
    );
    const output = join(f.base, 'entry-result');
    const result = spawnSync(process.execPath, [entry, '--results-dir', output], {
      cwd: f.cwd,
      env: checks.safeEnvironment(process.env as Record<string, string>),
      encoding: 'utf8',
      maxBuffer: 1024 ** 2,
    });
    assert.equal(
      existsSync(marker),
      true,
      'The entry module must finish evaluating before its graph awaits its validation exports.',
    );
    assert.equal(result.status, 1);
    const report = JSON.parse(readFileSync(join(output, 'result.json'), 'utf8')) as {
      status: string;
      error: string;
      pack?: unknown;
      consumer?: unknown;
    };
    assert.equal(report.status, 'failed');
    assert.match(report.error, /Controlled stop before pack/u);
    assert.equal(report.pack, undefined);
    assert.equal(report.consumer, undefined);
  } finally {
    f.cleanup();
  }
});

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'contributor-check-fixture-'));
  const cwd = join(base, 'repo');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(
    join(cwd, '.gitignore'),
    '/dist/\n/node_modules/\n/plugins/ai-delivery/runtime/dist/\n/plugins/ai-delivery/dist/\n',
  );
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
      for (const source of readdirSync(join(f.cwd, 'src')).filter((name) => name.endsWith('.test.ts')))
        writeFileSync(join(f.cwd, 'dist', source.replace(/\.ts$/u, '.js')), '// compiled synthetic test\n');
      for (const path of [
        'dist/cli.js',
        'dist/index.js',
        'plugins/ai-delivery/runtime/dist/cli.js',
        'plugins/ai-delivery/dist/mcp-launcher.js',
      ]) {
        mkdirSync(dirname(join(f.cwd, path)), { recursive: true });
        writeFileSync(join(f.cwd, path), '// fictional packaged output\n');
        chmodSync(join(f.cwd, path), 0o755);
      }
    }
    if (stage === 'tests') {
      const names = command.filter((arg) => /^(?:dist\/.*\.test\.js|src\/.*\.test\.ts)$/u.test(arg));
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
            ].map((path) => ({ path, mode: 0o755, size: readFileSync(join(f.cwd, path)).length })),
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

test('local and CI share the PR producer while explicit release owns package qualification', () => {
  const manifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(manifest.scripts.checks, 'node scripts/checks.mjs');
  assert.equal(manifest.scripts['checks:release'], 'node scripts/current-qualification.mjs');
  assert.equal(manifest.scripts['checks:producer'], 'node scripts/current-qualification.mjs --producer-only');
  assert.equal(manifest.scripts['checks:fast'], 'node scripts/checks.mjs --fast');
  const ci = readFileSync(join(repository, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /npm run checks -- --results-dir/u);
  assert.doesNotMatch(ci, /npm run build|npm pack/u);
  assert.doesNotMatch(ci, /checks:release|current-qualification/u);
  assert.match(ci, /Retain PR producer and interrupted check evidence/u);
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
    assert.equal(report.fullSuccess, true, report.error);
    assert.deepEqual(
      report.commands.map((entry) => entry.stage),
      checks.FULL_GATES,
    );
    assert.deepEqual(report.selectedTestFiles, ['src/renamed.test.ts']);
    assert.ok(report.commands[2]!.command.includes('--emitDeclarationOnly'));
    assert.deepEqual(report.commands[3]!.command.slice(1), [join(f.cwd, 'scripts/build.mjs'), '--plugin']);
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

test('explicit focused files run only their compilation and tests without install, inventory or plugin bundling', async () => {
  for (const selected of ['original', 'tooling']) {
    const f = fixture();
    try {
      writeFileSync(join(f.cwd, 'src/tooling.test.ts'), '// another changed contract\n');
      const report = await checks.runChecks({
        cwd: f.cwd,
        resultsDir: join(f.base, 'focused'),
        fast: true,
        testFiles: [`dist/${selected}.test.js`],
        toolchain: () => f.toolchain,
        execute: executor(f),
      });
      assert.equal(report.exitCode, 0, report.error);
      assert.equal(report.scope, 'focused');
      assert.equal(report.status, 'partial-passed');
      assert.equal(report.fullSuccess, false);
      assert.deepEqual(report.selectedTestFiles, [`dist/${selected}.test.js`]);
      assert.deepEqual(
        report.commands.map((entry) => entry.stage),
        ['format', 'lint', 'types', 'build', 'tests'],
      );
      assert.deepEqual(report.commands[3]!.command.slice(1), [join(f.cwd, 'scripts/build.mjs')]);
      assert.ok(report.omitted.includes('unselected tests'));
      assert.ok(report.omitted.includes('inventory'));
      assert.equal(
        report.commands.some((entry) => entry.command.includes('ci') || entry.command.includes('pack')),
        false,
      );
    } finally {
      f.cleanup();
    }
  }
});

test('invalid focused selection or local dependency install refuses before launching any gate', async () => {
  for (const options of [
    { fast: true, testFiles: [] },
    { fast: true, testFiles: ['dist/missing.test.js'] },
    { fast: true, testFiles: ['../dist/original.test.js'] },
    { fast: true, testFiles: ['dist/*.test.js'] },
    { fast: true, testFiles: ['dist/original.test.js', 'dist/original.test.js'] },
    { testFiles: ['dist/original.test.js'] },
    { fast: true, install: true },
  ]) {
    const f = fixture();
    try {
      const report = await checks.runChecks({
        cwd: f.cwd,
        resultsDir: join(f.base, 'invalid'),
        ...options,
        toolchain: () => f.toolchain,
        execute: executor(f),
      });
      assert.equal(report.exitCode, 1);
      assert.equal(report.fullSuccess, false);
      assert.deepEqual(report.commands, []);
      assert.match(report.error!, /focused|install|selection|explicit/iu);
    } finally {
      f.cleanup();
    }
  }
});

test('focused plugin bundling requires an explicit artifact-dependent selection', async () => {
  const f = fixture();
  try {
    const report = await checks.runChecks({
      cwd: f.cwd,
      resultsDir: join(f.base, 'plugin-focused'),
      fast: true,
      testFiles: ['dist/original.test.js'],
      buildPlugin: true,
      toolchain: () => f.toolchain,
      execute: executor(f),
    });
    assert.equal(report.exitCode, 0, report.error);
    assert.deepEqual(
      report.commands.map((entry) => entry.stage),
      ['format', 'lint', 'types', 'build', 'plugin-build', 'tests'],
    );
    assert.equal(report.fullSuccess, false);
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
  assert.equal(result.skips.length, 1);
  assert.equal(
    checks.analyzeTests(report, ['dist/setup.test.js'], cwd, 'SETUP_INTERRUPTION_RECEIPT', {
      AI_DELIVERY_REAL_PACKAGE_ARCHIVE: '/synthetic/explicit.tgz',
    }).skips.length,
    1,
  );
  assert.ok(result.laneExcluded.some((test) => test.title.startsWith('actual reviewed 0.3.4')));
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
  reconcileConsumer?: boolean;
  signal?: AbortSignal;
  checks?: (options: {
    resultsDir: string;
    release?: ReleaseContext;
    signal?: AbortSignal;
  }) => Promise<Record<string, unknown>>;
  execute?: (command: string[], options: CommandOptions) => Promise<CommandResult>;
  inspect?: (contract: SyntheticContract) => Candidate;
};
const qualification = (await import(new URL('../scripts/current-qualification.mjs', import.meta.url).href)) as {
  sourceIdentity(cwd: string): {
    commit: string;
    tree: string;
    fingerprint: { kind: string; sha256: string; fileCount: number };
  };
  validateCheckpoint(path: string, cwd: string, inspect: NonNullable<QualificationOptions['inspect']>): unknown;
  runQualification(options: QualificationOptions): Promise<{
    status: string;
    qualified: boolean;
    exitCode: number;
    error?: string;
    omitted: string[];
    releaseTests?: { path: string; sha256: string };
  }>;
};
const consumerProof = (await import(new URL('../scripts/current-consumer.mjs', import.meta.url).href)) as {
  sha256(bytes: string | Buffer): string;
  verifyProducerJoin(contract: SyntheticContract, candidate: Candidate): Record<string, unknown>;
};

function qualificationFixture() {
  const f = fixture();
  mkdirSync(join(f.cwd, 'dist'));
  writeFileSync(join(f.cwd, 'dist/generated.js'), 'original');
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
  let releases = 0;
  let releaseHook: (options: {
    resultsDir: string;
    signal?: AbortSignal;
  }) => Promise<CommandResult | void> = async () => {};
  const order: string[] = [];
  let packStatus = 'passed';
  let cleanup = true;
  let mutateProducer: (report: Record<string, unknown>) => void = () => {};
  const members = [
    { path: 'dist/generated.js', size: 8, mode: 0o644 },
    { path: 'package.json', size: readFileSync(join(f.cwd, 'package.json')).length, mode: 0o644 },
  ];
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
  const produce: NonNullable<QualificationOptions['checks']> = async ({ resultsDir, release, signal }) => {
    if (release) {
      releases++;
      order.push('release');
      mkdirSync(resultsDir);
      const observed = await releaseHook({ resultsDir, ...(signal ? { signal } : {}) });
      const historical = checks.RELEASE_CASES.find((test) => test.kind === 'external-historical-qualification')!;
      const cancelled = signal?.aborted === true;
      const report = {
        schemaVersion: 'contributor-checks@1',
        runId: 'fictional-release',
        scope: 'release',
        status: cancelled ? 'cancelled' : 'passed',
        exitCode: cancelled ? 130 : 0,
        fullSuccess: false,
        artifactQualified: false,
        gates: ['tests'],
        omitted: ['PR producer and consumer'],
        resultsDir,
        tree: qualification.sourceIdentity(f.cwd).fingerprint,
        toolchain: f.toolchain,
        release: {
          ...release,
          contractSha256: consumerProof.sha256(readFileSync(release.contractPath)),
          historicalInputSupplied: false,
          temporary: { path: join(resultsDir, 'temporary'), dev: 1, ino: 1, quiescent: true, removed: true },
        },
        commands: [
          {
            stage: 'tests',
            status: cancelled ? 'cancelled' : 'passed',
            exitCode: cancelled ? 130 : 0,
            signal: cancelled ? 'SIGTERM' : null,
            cleanupConfirmed: true,
            ...observed,
          },
        ],
        selectedTestFiles: [...new Set(checks.RELEASE_CASES.map((test) => test.file))],
        tests: {
          lane: 'release',
          files: new Set(checks.RELEASE_CASES.map((test) => test.file)).size,
          total: checks.RELEASE_CASES.length,
          passed: checks.RELEASE_CASES.filter((test) => test.kind === 'mandatory').length,
          skips: [historical],
          selectedCases: checks.RELEASE_CASES.map(({ file, title }) => ({ file, title })),
          laneExcluded: [],
        },
      };
      writeFileSync(join(resultsDir, 'result.json'), JSON.stringify(report));
      return report;
    }
    producers++;
    order.push('producer');
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
      selectedTestFiles: ['src/original.test.ts'],
      toolchain: f.toolchain,
      inventory: {
        kind: 'dry-inventory-only',
        name: '@aviaratech/ai-delivery',
        version: '1.0.0',
        fileCount: members.length,
        files: members.map((item) => ({ ...item, sha256: consumerProof.sha256(readFileSync(join(f.cwd, item.path))) })),
      },
    };
    mutateProducer(report);
    writeFileSync(join(resultsDir, 'result.json'), JSON.stringify(report));
    return report;
  };
  const execute: NonNullable<QualificationOptions['execute']> = async (command, options) => {
    if (command.at(-1) === '--authorize-install') {
      const contractPath = command[2];
      const resultPath = command[3];
      assert.ok(contractPath && resultPath, 'Synthetic consumer requires contract and result paths.');
      const contract = JSON.parse(readFileSync(contractPath, 'utf8')) as SyntheticContract;
      const receipt = await consume(contract, { authorizeInstall: true });
      mkdirSync(options.directory);
      const stdoutPath = join(options.directory, 'stdout.txt');
      const stderrPath = join(options.directory, 'stderr.txt');
      writeFileSync(stdoutPath, 'fictional supervised consumer');
      writeFileSync(stderrPath, '');
      writeFileSync(resultPath, JSON.stringify(receipt));
      const result = {
        command,
        status: 'passed',
        exitCode: 0,
        signal: null,
        stdoutPath,
        stderrPath,
        cleanupConfirmed: true,
      };
      options.progress?.(result);
      return result;
    }
    packs++;
    order.push('pack');
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
  const consume = async (contract: SyntheticContract, options: { authorizeInstall: boolean }) => {
    consumers++;
    order.push('consumer');
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
    execute,
    inspect,
  };
  return {
    ...f,
    options,
    inspect,
    consume,
    counts: () => ({ producers, packs, consumers }),
    releases: () => releases,
    order,
    releaseHook: (hook: typeof releaseHook) => {
      releaseHook = hook;
    },
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

test('qualification joins producer pack release tests and consumer in order', async () => {
  const f = qualificationFixture();
  try {
    const report = await qualification.runQualification(f.options);
    assert.equal(report.qualified, true);
    assert.deepEqual(f.counts(), { producers: 1, packs: 1, consumers: 1 });
    assert.equal(f.releases(), 1);
    assert.deepEqual(f.order, ['producer', 'pack', 'release', 'consumer']);
    assert.ok(report.releaseTests);
  } finally {
    f.cleanup();
  }
});

test('producer-only omits release and consumer proof', async () => {
  const f = qualificationFixture();
  try {
    const report = await qualification.runQualification({ ...f.options, producerOnly: true });
    assert.equal(f.releases(), 0);
    assert.match(report.omitted.join(' '), /release/u);
    assert.equal(report.releaseTests, undefined);
  } finally {
    f.cleanup();
  }
});

test('resume reuses compatible completed release proof', async () => {
  const f = qualificationFixture();
  try {
    const first = await qualification.runQualification(f.options);
    assert.ok(first.releaseTests);
    const original = readFileSync(first.releaseTests.path);
    const resumed = await qualification.runQualification({
      ...f.options,
      resume: join(f.options.resultsDir, 'checkpoint.json'),
      resultsDir: join(f.base, 'outer-reuse'),
    });
    assert.equal(resumed.qualified, true, resumed.error);
    assert.deepEqual(resumed.releaseTests, first.releaseTests);
    assert.deepEqual(readFileSync(first.releaseTests.path), original);
    assert.equal(f.releases(), 1);
    assert.deepEqual(f.counts(), { producers: 1, packs: 1, consumers: 1 });
  } finally {
    f.cleanup();
  }
});

test('uncertain release attempt blocks a duplicate launch through fresh outer results', async () => {
  const f = qualificationFixture();
  try {
    await qualification.runQualification({ ...f.options, producerOnly: true });
    f.releaseHook(async () => {
      throw new Error('fictional lost release response');
    });
    const resume = join(f.options.resultsDir, 'checkpoint.json');
    const first = await qualification.runQualification({
      ...f.options,
      resume,
      resultsDir: join(f.base, 'release-lost'),
    });
    assert.match(first.error!, /lost release/u);
    const second = await qualification.runQualification({
      ...f.options,
      resume,
      resultsDir: join(f.base, 'release-uncertain'),
    });
    assert.match(second.error!, /Unresolved release/u);
    assert.equal(f.releases(), 1);
    assert.deepEqual(f.counts(), { producers: 1, packs: 1, consumers: 0 });
  } finally {
    f.cleanup();
  }
});

test('interrupted release retry preserves prior evidence and skips completed producer and pack', async () => {
  const f = qualificationFixture();
  try {
    await qualification.runQualification({ ...f.options, producerOnly: true });
    const controller = new AbortController();
    const sentinel = join(f.base, 'unrelated');
    writeFileSync(sentinel, 'preserve');
    f.releaseHook(async ({ resultsDir, signal }) =>
      checks.executeCommand(
        [process.execPath, '-e', "console.log('controlled release started');setInterval(()=>{},1000)"],
        {
          cwd: f.cwd,
          env: checks.safeEnvironment({}),
          directory: join(resultsDir, 'tests'),
          ...(signal ? { signal } : {}),
          progress: (partial) => {
            if ((partial as CommandResult).observedProcesses?.length) controller.abort();
          },
        },
      ),
    );
    const resume = join(f.options.resultsDir, 'checkpoint.json');
    const interrupted = await qualification.runQualification({
      ...f.options,
      resume,
      signal: controller.signal,
      resultsDir: join(f.base, 'release-interrupted'),
    });
    assert.equal(interrupted.status, 'cancelled');
    const attemptPath = join(f.options.resultsDir, 'release-tests-attempt.json');
    const old = readFileSync(attemptPath);
    const prior = JSON.parse(old.toString()) as {
      directory: string;
      receipt: { path: string };
      command: CommandResult;
    };
    assert.equal(prior.command.cleanupConfirmed, true);
    assert.ok(prior.command.observedProcesses?.length);
    const receipt = readFileSync(prior.receipt.path);
    f.releaseHook(async () => {});
    const retried = await qualification.runQualification({
      ...f.options,
      resume,
      resultsDir: join(f.base, 'release-retry'),
    });
    assert.equal(retried.qualified, true, retried.error);
    assert.deepEqual(readFileSync(join(prior.directory, 'retired-attempt.json')), old);
    assert.deepEqual(readFileSync(prior.receipt.path), receipt);
    assert.equal(readFileSync(sentinel, 'utf8'), 'preserve');
    assert.equal(f.releases(), 2);
    assert.deepEqual(f.counts(), { producers: 1, packs: 1, consumers: 1 });
    const uninterrupted = qualificationFixture();
    try {
      assert.equal((await qualification.runQualification(uninterrupted.options)).qualified, true);
      assert.deepEqual(uninterrupted.order, ['producer', 'pack', 'release', 'consumer']);
    } finally {
      uninterrupted.cleanup();
    }
  } finally {
    f.cleanup();
  }
});

test('two competing resumes release at most one checkpoint-owned test child', async () => {
  const f = qualificationFixture();
  try {
    await qualification.runQualification({ ...f.options, producerOnly: true });
    let started!: () => void, complete!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      complete = resolve;
    });
    f.releaseHook(async () => {
      started();
      await gate;
    });
    const resume = join(f.options.resultsDir, 'checkpoint.json');
    const first = qualification.runQualification({ ...f.options, resume, resultsDir: join(f.base, 'race-a') });
    await Promise.race([
      start,
      first.then(() => {
        throw new Error('Release stage never started.');
      }),
    ]);
    const second = await qualification.runQualification({ ...f.options, resume, resultsDir: join(f.base, 'race-b') });
    complete();
    assert.equal((await first).qualified, true);
    assert.match(second.error!, /Unresolved release/u);
    assert.equal(f.releases(), 1);
  } finally {
    f.cleanup();
  }
});

test('producer byte inventory rejects a same-length ignored build change before consumer launch', async () => {
  const f = qualificationFixture();
  try {
    const before = qualification.sourceIdentity(f.cwd).fingerprint;
    f.mutate(() => writeFileSync(join(f.cwd, 'dist/generated.js'), 'replaced'));
    const report = await qualification.runQualification(f.options);
    assert.deepEqual(qualification.sourceIdentity(f.cwd).fingerprint, before);
    assert.equal(report.qualified, false);
    assert.match(report.error!, /Archive bytes differ from the successful producer/u);
    assert.deepEqual(f.counts(), { producers: 1, packs: 1, consumers: 0 });
    assert.equal(existsSync(join(f.options.resultsDir, 'checkpoint.json')), false);
  } finally {
    f.cleanup();
  }
});

test('resume rejects changed generated bytes and missing retained producer member hashes', async () => {
  for (const change of ['bytes', 'missing-digest']) {
    const f = qualificationFixture();
    try {
      if (change === 'missing-digest')
        f.mutate((report) => {
          const inventory = report.inventory as { files: { sha256?: string }[] };
          const first = inventory.files[0];
          assert.ok(first, 'Synthetic producer inventory must contain a member.');
          delete first.sha256;
        });
      const produced = await qualification.runQualification({ ...f.options, producerOnly: true });
      if (change === 'bytes') {
        assert.equal(produced.status, 'incomplete');
        writeFileSync(join(f.cwd, 'dist/generated.js'), 'replaced');
        const resumed = await qualification.runQualification({
          ...f.options,
          resume: join(f.options.resultsDir, 'checkpoint.json'),
          resultsDir: join(f.base, 'changed-bytes'),
        });
        assert.match(resumed.error!, /Archive bytes differ|freshness join is incomplete/u);
      } else assert.equal(produced.status, 'failed');
      assert.deepEqual(f.counts(), { producers: 1, packs: 1, consumers: 0 });
    } finally {
      f.cleanup();
    }
  }
});

test('consumer cancellation retains actual PID/birth and logs, and resume cannot duplicate it', async () => {
  const f = qualificationFixture();
  try {
    await qualification.runQualification({ ...f.options, producerOnly: true });
    const controller = new AbortController();
    let launches = 0;
    const execute: NonNullable<QualificationOptions['execute']> = async (_command, options) => {
      launches++;
      return checks.executeCommand(
        [process.execPath, '-e', "console.log('fictional consumer started');setInterval(()=>{},1000)"],
        {
          ...options,
          progress: (partial) => {
            options.progress?.(partial);
            if ((partial as CommandResult).observedProcesses?.length) controller.abort();
          },
        },
      );
    };
    const resume = join(f.options.resultsDir, 'checkpoint.json');
    const report = await qualification.runQualification({
      ...f.options,
      execute,
      resume,
      signal: controller.signal,
      resultsDir: join(f.base, 'cancelled-consumer'),
    });
    assert.equal(report.status, 'cancelled');
    const attempt = JSON.parse(readFileSync(join(f.options.resultsDir, 'consumer-attempt.json'), 'utf8')) as {
      status: string;
      tempRoot: string;
      command: CommandResult;
    };
    assert.equal(attempt.status, 'completed');
    assert.equal(attempt.command.status, 'cancelled');
    assert.equal(attempt.command.cleanupConfirmed, true);
    assert.ok(attempt.command.observedProcesses!.every((row) => row.birth.length > 0));
    assert.ok(existsSync(attempt.tempRoot));
    const retried = await qualification.runQualification({
      ...f.options,
      execute,
      resume,
      resultsDir: join(f.base, 'blocked-retry'),
    });
    assert.equal(retried.qualified, false);
    assert.equal(launches, 1);
    assert.deepEqual(f.counts(), { producers: 1, packs: 1, consumers: 0 });
  } finally {
    f.cleanup();
  }
});

test('lost consumer completion retains a reservation, blocks duplicate launch and reconciles without producer or pack replay', async () => {
  const f = qualificationFixture();
  try {
    await qualification.runQualification({ ...f.options, producerOnly: true });
    const resume = join(f.options.resultsDir, 'checkpoint.json');
    const contract = JSON.parse(readFileSync(join(f.options.resultsDir, 'contract.json'), 'utf8')) as SyntheticContract;
    const fictionalReceipt = await f.consume(contract, { authorizeInstall: true });
    let launches = 0;
    const execute: NonNullable<QualificationOptions['execute']> = async (command, options) => {
      launches++;
      const resultPath = command[3];
      assert.ok(resultPath, 'Synthetic consumer requires a result path.');
      // A real credential-free child writes fictional application evidence.
      // Withhold terminal supervisor transport after its actual quiescent exit.
      const code = "const fs=require('node:fs');setTimeout(()=>fs.writeFileSync(process.argv[1],process.argv[2]),200)";
      const completed = await checks.executeCommand(
        [process.execPath, '-e', code, resultPath, JSON.stringify(fictionalReceipt)],
        {
          ...options,
          progress: (partial) => {
            if (!(partial as { completedAt?: string }).completedAt) options.progress?.(partial);
          },
        },
      );
      assert.equal(completed.cleanupConfirmed, true);
      throw new Error('fictional controller lost terminal consumer response');
    };
    const lost = await qualification.runQualification({
      ...f.options,
      execute,
      resume,
      resultsDir: join(f.base, 'lost-response'),
    });
    assert.equal(lost.qualified, false);
    const attemptPath = join(f.options.resultsDir, 'consumer-attempt.json');
    const attempt = JSON.parse(readFileSync(attemptPath, 'utf8')) as { status: string; command: CommandResult };
    assert.equal(attempt.status, 'running');
    assert.ok(attempt.command.observedProcesses!.length > 0);
    const blocked = await qualification.runQualification({
      ...f.options,
      execute,
      resume,
      resultsDir: join(f.base, 'unreconciled'),
    });
    assert.match(blocked.error!, /Unresolved consumer attempt/u);
    const reconciled = await qualification.runQualification({
      ...f.options,
      execute,
      resume,
      reconcileConsumer: true,
      resultsDir: join(f.base, 'reconciled'),
    });
    assert.equal(reconciled.qualified, true);
    assert.equal(launches, 1);
    assert.deepEqual(f.counts(), { producers: 1, packs: 1, consumers: 1 });
    assert.equal((JSON.parse(readFileSync(attemptPath, 'utf8')) as { status: string }).status, 'reconciled');
  } finally {
    f.cleanup();
  }
});

test('reservation before launch survives an uncertain spawn and refuses automatic retry', async () => {
  const f = qualificationFixture();
  try {
    await qualification.runQualification({ ...f.options, producerOnly: true });
    let launches = 0;
    const execute: NonNullable<QualificationOptions['execute']> = async () => {
      launches++;
      throw new Error('fictional spawn response unknown');
    };
    const resume = join(f.options.resultsDir, 'checkpoint.json');
    await qualification.runQualification({
      ...f.options,
      execute,
      resume,
      resultsDir: join(f.base, 'uncertain-launch'),
    });
    const blocked = await qualification.runQualification({
      ...f.options,
      execute,
      resume,
      reconcileConsumer: true,
      resultsDir: join(f.base, 'uncertain-retry'),
    });
    assert.match(blocked.error!, /launch identity is unavailable/u);
    assert.equal(launches, 1);
    assert.deepEqual(f.counts(), { producers: 1, packs: 1, consumers: 0 });
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
