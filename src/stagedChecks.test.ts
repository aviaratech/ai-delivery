import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  error?: string;
  ownedDirectory: string;
};
type Staged = {
  prepareStagedSnapshot(cwd: string, directory: string): Snapshot;
  runStagedChecks(options: {
    cwd: string;
    resultsDir: string;
    signal?: AbortSignal;
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
  writeFileSync(join(cwd, 'package-lock.json'), '{"synthetic":"original"}\n');
  if (runner !== undefined) writeFileSync(join(cwd, 'scripts/checks.mjs'), runner);
  git('add', '.');
  git('commit', '-qm', 'Synthetic baseline');
  return { cwd, base, git, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('exact staged tree isolates partial edits, additions, deletions and lockfile changes without index/unstaged writes', () => {
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
});

function syntheticRunner(fullSuccess = true) {
  return `import fs from 'node:fs';import path from 'node:path';
const args=process.argv.slice(2);const tree=args[args.indexOf('--staged-tree')+1],dir=args[args.indexOf('--results-dir')+1];
if(!args.includes('--install'))process.exit(8);
if(fs.readFileSync('package-lock.json','utf8')!=='{"synthetic":"original"}\\n')process.exit(9);
if(process.env.GH_TOKEN||process.env.NODE_OPTIONS||process.env.NODE_PATH)process.exit(10);
fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({fullSuccess:${fullSuccess},tree:{stagedGitTree:tree}}));`;
}

test('tracked entry executes staged runner rather than unstaged code and cleans only owned snapshot', async () => {
  const f = fixture(syntheticRunner());
  try {
    writeFileSync(join(f.cwd, 'scripts/checks.mjs'), "throw Error('Unstaged runner must not execute');\n");
    writeFileSync(join(f.cwd, 'package-lock.json'), '{"synthetic":"unstaged must not install"}\n');
    const index = hash(readFileSync(join(f.cwd, '.git/index')));
    const resultsDir = join(f.base, 'results');
    const result = await staged.runStagedChecks({ cwd: f.cwd, resultsDir });
    assert.equal(result.status, 'passed');
    assert.equal(result.fullSuccess, true);
    assert.equal(result.sourceIndexUnchanged, true);
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(existsSync(result.ownedDirectory), false);
    assert.equal(existsSync(join(resultsDir, 'full/result.json')), true);
    assert.equal(hash(readFileSync(join(f.cwd, '.git/index'))), index);
    assert.match(readFileSync(join(f.cwd, 'scripts/checks.mjs'), 'utf8'), /Unstaged runner/u);
    assert.match(readFileSync(join(f.cwd, 'package-lock.json'), 'utf8'), /unstaged must not install/u);
    await assert.rejects(staged.runStagedChecks({ cwd: f.cwd, resultsDir }), /Existing staged result/u);
  } finally {
    f.cleanup();
  }
});

test('fast or missing staged runner cannot become hook full success; unrelated source survives failure', async () => {
  for (const runner of [undefined, syntheticRunner(false)]) {
    const f = fixture(runner);
    try {
      const before = hash(readFileSync(join(f.cwd, '.git/index')));
      const result = await staged.runStagedChecks({ cwd: f.cwd, resultsDir: join(f.base, 'result') });
      assert.equal(result.fullSuccess, false);
      assert.equal(result.status, 'failed');
      assert.equal(result.cleanupConfirmed, true);
      assert.equal(hash(readFileSync(join(f.cwd, '.git/index'))), before);
      assert.equal(readFileSync(join(f.cwd, 'partial.txt'), 'utf8'), 'original\n');
    } finally {
      f.cleanup();
    }
  }
});

test('unsafe staged symlink is refused before commands and cleanup preserves the source index', async () => {
  const f = fixture(syntheticRunner());
  try {
    symlinkSync('../outside', join(f.cwd, 'link'));
    f.git('add', 'link');
    const before = hash(readFileSync(join(f.cwd, '.git/index')));
    const result = await staged.runStagedChecks({ cwd: f.cwd, resultsDir: join(f.base, 'result') });
    assert.equal(result.status, 'failed');
    assert.match(result.error!, /symlink index entry/u);
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(hash(readFileSync(join(f.cwd, '.git/index'))), before);
  } finally {
    f.cleanup();
  }
});

test('staged graph cancellation preserves source and partial evidence after owned child cleanup', async () => {
  const f = fixture("console.log('synthetic staged graph started');setInterval(()=>{},1000);\n");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 750);
  try {
    const before = hash(readFileSync(join(f.cwd, '.git/index')));
    const resultsDir = join(f.base, 'result');
    const result = await staged.runStagedChecks({ cwd: f.cwd, resultsDir, signal: controller.signal });
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
});

test('unconfirmed child completion preserves the owned snapshot and marks cleanup unproved', async () => {
  const f = fixture(syntheticRunner());
  let ownedDirectory: string | undefined;
  try {
    const before = hash(readFileSync(join(f.cwd, '.git/index')));
    const result = await staged.runStagedChecks({
      cwd: f.cwd,
      resultsDir: join(f.base, 'uncertain'),
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
});
