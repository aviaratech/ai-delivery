import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

type Snapshot = {
  index: string;
  originalIndexSha256: string;
  tree: string;
  snapshot: string;
  directory: string;
  fileCount: number;
};
type StagedResult = {
  status: string;
  exitCode: number;
  fullSuccess: boolean;
  stagedTree?: string;
  cleanupConfirmed: boolean;
  sourceIndexUnchanged?: boolean;
  sourceIndexPath?: string;
  error?: string;
  ownedDirectory: string;
};
type Staged = {
  prepareStagedSnapshot(cwd: string, directory: string): Snapshot;
  runStagedChecks(options: {
    cwd: string;
    resultsDir: string;
    signal?: AbortSignal;
    testFiles?: string[];
    execute?: () => Promise<{ status: string; cleanupConfirmed: boolean }>;
  }): Promise<StagedResult>;
};
const staged = (await import(new URL('../scripts/pre-commit.mjs', import.meta.url).href)) as Staged;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function fixture(runner?: string) {
  const base = mkdtempSync(join(tmpdir(), 'staged-check-fixture-'));
  const cwd = join(base, 'repo');
  mkdirSync(join(cwd, 'scripts'), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Synthetic Contributor');
  git('config', 'user.email', 'contributor@example.test');
  writeFileSync(join(cwd, 'partial.txt'), 'original\n');
  writeFileSync(join(cwd, 'delete.txt'), 'tracked deletion\n');
  writeFileSync(join(cwd, '.gitignore'), '/node_modules/\n/dist/\n');
  const manifest = { name: 'staged-fixture', version: '1.0.0', dependencies: { 'fixture-dependency': '1.0.0' } };
  const packages = {
    '': manifest,
    'node_modules/fixture-dependency': { version: '1.0.0', dependencies: { 'fixture-transitive': '1.0.0' } },
    'node_modules/fixture-transitive': { version: '1.0.0' },
  };
  writeFileSync(join(cwd, 'package.json'), JSON.stringify(manifest));
  writeFileSync(
    join(cwd, 'package-lock.json'),
    JSON.stringify({ lockfileVersion: 3, synthetic: 'original', packages }),
  );
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src/selected.test.ts'), '// selected synthetic contract\n');
  mkdirSync(join(cwd, 'node_modules/fixture-dependency'), { recursive: true });
  writeFileSync(
    join(cwd, 'node_modules/fixture-dependency/package.json'),
    JSON.stringify({ name: 'fixture-dependency', version: '1.0.0', dependencies: { 'fixture-transitive': '1.0.0' } }),
  );
  writeFileSync(
    join(cwd, 'node_modules/.package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/fixture-dependency': { version: '1.0.0', dependencies: { 'fixture-transitive': '1.0.0' } },
        'node_modules/fixture-transitive': { version: '1.0.0' },
      },
    }),
  );
  mkdirSync(join(cwd, 'node_modules/fixture-transitive'));
  writeFileSync(
    join(cwd, 'node_modules/fixture-transitive/package.json'),
    JSON.stringify({ name: 'fixture-transitive', version: '1.0.0' }),
  );
  if (runner !== undefined) writeFileSync(join(cwd, 'scripts/checks.mjs'), runner);
  git('add', '.');
  git('commit', '-qm', 'Synthetic baseline');
  return { cwd, base, git, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test(
  'exact staged tree isolates partial edits, additions, deletions and lockfile changes without index/unstaged writes',
  { tags: ['release'] },
  () => {
    const f = fixture();
    try {
      writeFileSync(join(f.cwd, 'partial.txt'), 'staged content\n');
      writeFileSync(join(f.cwd, 'added.txt'), 'staged addition\n');
      writeFileSync(join(f.cwd, 'package-lock.json'), '{"synthetic":"staged lock"}\n');
      f.git('rm', '-q', 'delete.txt');
      f.git('add', 'partial.txt', 'added.txt', 'package-lock.json');
      writeFileSync(join(f.cwd, 'partial.txt'), 'unstaged content must survive\n');
      writeFileSync(join(f.cwd, 'package-lock.json'), '{"synthetic":"unstaged lock"}\n');
      writeFileSync(join(f.cwd, 'delete.txt'), 'unstaged recreated file\n');
      writeFileSync(join(f.cwd, 'untracked.txt'), 'unrelated local file\n');
      const index = join(f.cwd, '.git/index');
      const before = hash(readFileSync(index));
      const snapshot = staged.prepareStagedSnapshot(f.cwd, join(f.base, 'snapshot-owner'));
      assert.equal(readFileSync(join(snapshot.snapshot, 'partial.txt'), 'utf8'), 'staged content\n');
      assert.equal(readFileSync(join(snapshot.snapshot, 'added.txt'), 'utf8'), 'staged addition\n');
      assert.equal(readFileSync(join(snapshot.snapshot, 'package-lock.json'), 'utf8'), '{"synthetic":"staged lock"}\n');
      assert.equal(existsSync(join(snapshot.snapshot, 'delete.txt')), false);
      assert.equal(existsSync(join(snapshot.snapshot, 'untracked.txt')), false);
      assert.equal(snapshot.originalIndexSha256, before);
      assert.equal(hash(readFileSync(index)), before);
      assert.equal(readFileSync(join(f.cwd, 'partial.txt'), 'utf8'), 'unstaged content must survive\n');
      assert.equal(readFileSync(join(f.cwd, 'package-lock.json'), 'utf8'), '{"synthetic":"unstaged lock"}\n');
      assert.equal(readFileSync(join(f.cwd, 'delete.txt'), 'utf8'), 'unstaged recreated file\n');
      assert.equal(readFileSync(join(f.cwd, 'untracked.txt'), 'utf8'), 'unrelated local file\n');
      assert.match(snapshot.tree, /^[0-9a-f]{40}$/u);
    } finally {
      f.cleanup();
    }
  },
);

function syntheticRunner(focused = true) {
  return `import fs from 'node:fs';import path from 'node:path';
const args=process.argv.slice(2);const tree=args[args.indexOf('--staged-tree')+1],dir=args[args.indexOf('--results-dir')+1];
if(args.includes('--install')||!args.includes('--fast')||!args.includes('--test-file'))process.exit(8);
if(JSON.parse(fs.readFileSync('package-lock.json','utf8')).synthetic!=='original')process.exit(9);
if(process.env.GH_TOKEN||process.env.NODE_OPTIONS||process.env.NODE_PATH)process.exit(10);
fs.mkdirSync('node_modules/.vite',{recursive:true});fs.writeFileSync('node_modules/.vite/owned-cache','synthetic cache');
fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({scope:'${focused ? 'focused' : 'fast'}',status:'partial-passed',fullSuccess:false,artifactQualified:false,selectedTestFiles:['dist/selected.test.js'],tests:{files:1,total:1,passed:1},tree:{stagedGitTree:tree}}));`;
}

test(
  'missing explicit hook selection refuses before validation without provisioning dependencies',
  { tags: ['release'] },
  async () => {
    const f = fixture(syntheticRunner());
    try {
      const result = await staged.runStagedChecks({ cwd: f.cwd, resultsDir: join(f.base, 'missing-selection') });
      assert.equal(result.status, 'failed');
      assert.match(result.error!, /explicit.*selection/iu);
      assert.equal(result.cleanupConfirmed, true);
    } finally {
      f.cleanup();
    }
  },
);

test(
  'staged dependency incompatibility refuses instead of installing or accepting different package versions',
  { tags: ['release'] },
  async () => {
    for (const scenario of [
      'version',
      'package-version',
      'missing',
      'missing-transitive',
      'missing-metadata-entry',
      'staged-manifest',
    ]) {
      const f = fixture(syntheticRunner());
      try {
        const metadata = join(f.cwd, 'node_modules/.package-lock.json');
        if (scenario === 'missing') rmSync(join(f.cwd, 'node_modules'), { recursive: true });
        else if (scenario === 'missing-transitive')
          rmSync(join(f.cwd, 'node_modules/fixture-transitive'), { recursive: true });
        else if (scenario === 'package-version')
          writeFileSync(
            join(f.cwd, 'node_modules/fixture-transitive/package.json'),
            JSON.stringify({ name: 'fixture-transitive', version: '2.0.0' }),
          );
        else if (scenario === 'staged-manifest') {
          writeFileSync(
            join(f.cwd, 'package.json'),
            JSON.stringify({
              name: 'staged-fixture',
              version: '1.0.0',
              dependencies: { 'fixture-dependency': '2.0.0' },
            }),
          );
          f.git('add', 'package.json');
        } else
          writeFileSync(
            metadata,
            JSON.stringify({
              lockfileVersion: 3,
              packages: { 'node_modules/fixture-dependency': { version: scenario === 'version' ? '2.0.0' : '1.0.0' } },
            }),
          );
        const result = await staged.runStagedChecks({
          cwd: f.cwd,
          resultsDir: join(f.base, 'incompatible'),
          testFiles: ['dist/selected.test.js'],
        });
        assert.equal(result.status, 'failed');
        assert.match(result.error!, /dependenc|compatible|setup/iu);
        assert.equal(result.cleanupConfirmed, true);
        assert.equal(result.sourceIndexUnchanged, true);
      } finally {
        f.cleanup();
      }
    }
  },
);

test(
  'observable installed dependency metadata drift cannot become successful hook evidence',
  { tags: ['release'] },
  async () => {
    for (const changedMetadata of ['.package-lock.json', 'fixture-transitive/package.json']) {
      const f = fixture(syntheticRunner());
      try {
        const result = await staged.runStagedChecks({
          cwd: f.cwd,
          resultsDir: join(f.base, 'drift'),
          testFiles: ['dist/selected.test.js'],
          execute: async () => {
            const metadata = join(f.cwd, 'node_modules', changedMetadata);
            writeFileSync(metadata, readFileSync(metadata, 'utf8') + '\n');
            return { status: 'passed', cleanupConfirmed: true };
          },
        });
        assert.equal(result.status, 'failed');
        assert.match(result.error!, /dependenc.*(changed|drift)/iu);
        assert.equal(result.cleanupConfirmed, true);
      } finally {
        f.cleanup();
      }
    }
  },
);

test(
  'tracked entry reuses transitive dependencies with staged code and cleans only owned snapshot',
  { tags: ['release'] },
  async () => {
    const f = fixture(syntheticRunner());
    try {
      writeFileSync(join(f.cwd, 'scripts/checks.mjs'), "throw Error('Unstaged runner must not execute');\n");
      writeFileSync(join(f.cwd, 'package-lock.json'), '{"synthetic":"unstaged must not install"}\n');
      writeFileSync(
        join(f.cwd, 'package.json'),
        JSON.stringify({
          name: 'staged-fixture',
          version: '1.0.0',
          dependencies: { 'fixture-dependency': '1.0.0' },
          description: 'unstaged manifest must survive',
        }),
      );
      const index = hash(readFileSync(join(f.cwd, '.git/index')));
      const resultsDir = join(f.base, 'results');
      const result = await staged.runStagedChecks({ cwd: f.cwd, resultsDir, testFiles: ['dist/selected.test.js'] });
      assert.equal(result.status, 'partial-passed');
      assert.equal(result.fullSuccess, false);
      assert.equal(result.sourceIndexUnchanged, true);
      assert.equal(result.cleanupConfirmed, true);
      assert.equal(existsSync(result.ownedDirectory), false);
      assert.equal(existsSync(join(resultsDir, 'focused/result.json')), true);
      assert.equal(existsSync(join(f.cwd, 'node_modules/.vite')), false);
      assert.equal(
        (
          JSON.parse(readFileSync(join(f.cwd, 'node_modules/fixture-dependency/package.json'), 'utf8')) as {
            version: string;
          }
        ).version,
        '1.0.0',
      );
      assert.equal(hash(readFileSync(join(f.cwd, '.git/index'))), index);
      assert.match(readFileSync(join(f.cwd, 'scripts/checks.mjs'), 'utf8'), /Unstaged runner/u);
      assert.match(readFileSync(join(f.cwd, 'package-lock.json'), 'utf8'), /unstaged must not install/u);
      assert.match(readFileSync(join(f.cwd, 'package.json'), 'utf8'), /unstaged manifest must survive/u);
      await assert.rejects(staged.runStagedChecks({ cwd: f.cwd, resultsDir }), /Existing staged result/u);
    } finally {
      f.cleanup();
    }
  },
);

test(
  'fast-only or missing staged runner cannot become focused hook success; unrelated source survives failure',
  { tags: ['release'] },
  async () => {
    for (const runner of [undefined, syntheticRunner(false)]) {
      const f = fixture(runner);
      try {
        const before = hash(readFileSync(join(f.cwd, '.git/index')));
        const result = await staged.runStagedChecks({
          cwd: f.cwd,
          resultsDir: join(f.base, 'result'),
          testFiles: ['dist/selected.test.js'],
        });
        assert.equal(result.fullSuccess, false);
        assert.equal(result.status, 'failed');
        assert.equal(result.cleanupConfirmed, true);
        assert.equal(hash(readFileSync(join(f.cwd, '.git/index'))), before);
        assert.equal(readFileSync(join(f.cwd, 'partial.txt'), 'utf8'), 'original\n');
      } finally {
        f.cleanup();
      }
    }
  },
);

test(
  'unsafe staged symlink is refused before commands and cleanup preserves the source index',
  { tags: ['release'] },
  async () => {
    const f = fixture(syntheticRunner());
    try {
      symlinkSync('../outside', join(f.cwd, 'link'));
      f.git('add', 'link');
      const before = hash(readFileSync(join(f.cwd, '.git/index')));
      const result = await staged.runStagedChecks({
        cwd: f.cwd,
        resultsDir: join(f.base, 'result'),
        testFiles: ['dist/selected.test.js'],
      });
      assert.equal(result.status, 'failed');
      assert.match(result.error!, /symlink index entry/u);
      assert.equal(result.cleanupConfirmed, true);
      assert.equal(hash(readFileSync(join(f.cwd, '.git/index'))), before);
    } finally {
      f.cleanup();
    }
  },
);

test(
  'staged graph cancellation preserves source and partial evidence after owned child cleanup',
  { tags: ['release'] },
  async () => {
    const f = fixture("console.log('synthetic staged graph started');setInterval(()=>{},1000);\n");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 750);
    try {
      const before = hash(readFileSync(join(f.cwd, '.git/index')));
      const resultsDir = join(f.base, 'result');
      const result = await staged.runStagedChecks({
        cwd: f.cwd,
        resultsDir,
        signal: controller.signal,
        testFiles: ['dist/selected.test.js'],
      });
      assert.equal(result.status, 'cancelled');
      assert.equal(result.exitCode, 130);
      assert.equal(result.sourceIndexUnchanged, true);
      assert.equal(result.cleanupConfirmed, true);
      assert.equal(hash(readFileSync(join(f.cwd, '.git/index'))), before);
      assert.match(readFileSync(join(resultsDir, 'process/stdout.txt'), 'utf8'), /synthetic staged graph started/u);
    } finally {
      clearTimeout(timer);
      f.cleanup();
    }
  },
);

test(
  'unconfirmed child completion preserves the owned snapshot and marks cleanup unproved',
  { tags: ['release'] },
  async () => {
    const f = fixture(syntheticRunner());
    let ownedDirectory: string | undefined;
    try {
      const before = hash(readFileSync(join(f.cwd, '.git/index')));
      const result = await staged.runStagedChecks({
        cwd: f.cwd,
        resultsDir: join(f.base, 'uncertain'),
        testFiles: ['dist/selected.test.js'],
        execute: async () => ({ status: 'failed', cleanupConfirmed: false }),
      });
      ownedDirectory = result.ownedDirectory;
      assert.equal(result.fullSuccess, false);
      assert.equal(result.cleanupConfirmed, false);
      assert.equal(existsSync(ownedDirectory), true);
      assert.match(result.error!, /quiescence is unconfirmed/u);
      assert.equal(hash(readFileSync(join(f.cwd, '.git/index'))), before);
    } finally {
      // The injected executor launched no process; this fixture owns safe cleanup.
      if (ownedDirectory) rmSync(ownedDirectory, { recursive: true, force: true });
      f.cleanup();
    }
  },
);

test(
  'caller relative alternate index supplies the exact tree and preserves both indexes and unstaged bytes',
  { tags: ['release'] },
  () => {
    const f = fixture();
    const previous = process.env.GIT_INDEX_FILE;
    try {
      const primary = join(f.cwd, '.git/index');
      const alternate = join(f.cwd, '.git/alternate-index');
      writeFileSync(join(f.cwd, 'partial.txt'), 'primary staged\n');
      f.git('add', 'partial.txt');
      copyFileSync(primary, alternate);
      writeFileSync(join(f.cwd, 'partial.txt'), 'alternate staged\n');
      execFileSync('git', ['add', 'partial.txt'], { cwd: f.cwd, env: { ...process.env, GIT_INDEX_FILE: alternate } });
      writeFileSync(join(f.cwd, 'partial.txt'), 'final unstaged bytes\n');
      const primaryHash = hash(readFileSync(primary)),
        alternateHash = hash(readFileSync(alternate));
      assert.notEqual(primaryHash, alternateHash);
      process.env.GIT_INDEX_FILE = '.git/alternate-index';
      const snapshot = staged.prepareStagedSnapshot(f.cwd, join(f.base, 'alternate-snapshot'));
      assert.equal(snapshot.index, alternate);
      assert.equal(snapshot.originalIndexSha256, alternateHash);
      assert.equal(readFileSync(join(snapshot.snapshot, 'partial.txt'), 'utf8'), 'alternate staged\n');
      assert.equal(hash(readFileSync(primary)), primaryHash);
      assert.equal(hash(readFileSync(alternate)), alternateHash);
      assert.equal(readFileSync(join(f.cwd, 'partial.txt'), 'utf8'), 'final unstaged bytes\n');
    } finally {
      if (previous === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = previous;
      f.cleanup();
    }
  },
);

test(
  'synthetic commit -a and path-limited hooks validate the Git-supplied temporary commit index',
  { tags: ['release'] },
  () => {
    const entry = fileURLToPath(new URL('../scripts/pre-commit.mjs', import.meta.url));
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    for (const mode of ['all', 'path']) {
      const f = fixture(syntheticRunner());
      try {
        const resultsDir = join(f.base, 'hook-results');
        const hook = join(f.cwd, '.git/hooks/pre-commit');
        writeFileSync(
          hook,
          `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(entry)} --results-dir ${quote(resultsDir)}${mode === 'path' ? ' --test-file dist/selected.test.js' : ''}\n`,
        );
        chmodSync(hook, 0o755); // Only this disposable synthetic repository owns the hook.
        writeFileSync(join(f.cwd, 'partial.txt'), `${mode} committed content\n`);
        if (mode === 'path') writeFileSync(join(f.cwd, 'delete.txt'), 'unrelated unstaged content\n');
        execFileSync(
          'git',
          ['commit', '-qm', `Synthetic ${mode} commit`, ...(mode === 'all' ? ['-a'] : ['--', 'partial.txt'])],
          {
            cwd: f.cwd,
            env: { ...process.env, AI_DELIVERY_FOCUSED_TESTS: '["dist/selected.test.js"]' },
          },
        );
        const result = JSON.parse(readFileSync(join(resultsDir, 'staged.json'), 'utf8')) as StagedResult;
        assert.equal(result.fullSuccess, false);
        assert.equal(result.status, 'partial-passed');
        assert.equal(result.sourceIndexUnchanged, true);
        assert.equal(result.cleanupConfirmed, true);
        assert.notEqual(resolve(result.sourceIndexPath!), join(f.cwd, '.git/index'));
        assert.equal(result.stagedTree, f.git('rev-parse', 'HEAD^{tree}'));
        assert.equal(f.git('show', 'HEAD:partial.txt'), `${mode} committed content`);
        if (mode === 'path')
          assert.equal(readFileSync(join(f.cwd, 'delete.txt'), 'utf8'), 'unrelated unstaged content\n');
      } finally {
        f.cleanup();
      }
    }
  },
);
