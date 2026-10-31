import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

import { resolveGitRemoteName } from './github/repo.js';

import { DeliveryError } from './errors.js';
import { assertClean, defaultBaseRef, git, gitCommonDir, gitExitCode, gitRoot, primaryGitRoot } from './git.js';
import type { WorktreeEntry } from './services/worktreeRegistry.js';

function assertSafePath(root: string, target: string): void {
  const rel = relative(join(root, '.worktrees'), target);
  if (rel === '' || rel.startsWith('..') || rel.startsWith('/')) {
    throw new DeliveryError('Worktree path must be inside the repository .worktrees directory.');
  }
}

function assertIssueNumber(issueNumber: number): void {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) throw new DeliveryError('Issue number must be positive.');
}

/** @internal Shared physical custody check for preparation and same-owner continuation. */
export function assertIssueWorktreeLocation(row: WorktreeEntry, root: string): void {
  assertIssueNumber(row.issueNumber ?? 0);
  const branch = `issue/${String(row.issueNumber)}`;
  const target = join(root, '.worktrees', `issue-${String(row.issueNumber)}`);
  if (
    row.type !== 'issue' ||
    row.path !== target ||
    row.branch !== branch ||
    !existsSync(target) ||
    gitRoot(target) !== realpathSync(target) ||
    gitCommonDir(target) !== gitCommonDir(root)
  ) {
    throw new DeliveryError('Registered worktree disagrees with its exact repository, path or branch.');
  }
  if (git(target, 'branch', '--show-current') !== branch) throw new DeliveryError('Registered branch drifted.');
}

function gitWorktreeRows(root: string): string[][] {
  return git(root, 'worktree', 'list', '--porcelain')
    .split('\n\n')
    .filter(Boolean)
    .map((block) => block.split('\n'));
}
function pathPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export interface MergeCleanupAttestation {
  baseBranch: string;
  baseSha: string;
  headBranch: string;
  headSha: string;
  mergeSha: string;
  mergeTree: string;
  remoteBaseSha: string;
  remoteHeadSha: string | null;
  strategy: 'merge' | 'squash' | 'rebase';
}

function removeMergedIssueSource(
  row: WorktreeEntry,
  root: string,
  remote: string | undefined,
  attestation: MergeCleanupAttestation | undefined,
  allowAbsent: boolean,
): void {
  assertSafePath(root, row.path);
  if (row.status !== 'merged' || row.path !== join(root, '.worktrees', `issue-${String(row.issueNumber)}`)) {
    throw new DeliveryError('Only the exact registered merged issue worktree can be cleaned.');
  }
  const present = existsSync(row.path);
  if (present && gitRoot(row.path) !== realpathSync(row.path)) {
    throw new DeliveryError('Registered worktree points elsewhere.');
  }
  if (!present && !allowAbsent) {
    throw new DeliveryError('Registered worktree is missing.');
  }
  if (present) assertClean(row.path);
  const base = defaultBaseRef(root, remote);
  const branchIncluded = gitExitCode(root, 'merge-base', '--is-ancestor', row.branch, base) === 0;
  if (attestation) {
    if (
      attestation.headBranch !== row.branch ||
      attestation.headSha !== git(present ? row.path : root, 'rev-parse', present ? 'HEAD' : row.branch) ||
      (attestation.remoteHeadSha !== null && attestation.remoteHeadSha !== attestation.headSha) ||
      attestation.baseBranch !== base.slice(`refs/remotes/${resolveGitRemoteName(root, remote)}/`.length) ||
      attestation.remoteBaseSha !== git(root, 'rev-parse', base) ||
      gitExitCode(root, 'merge-base', '--is-ancestor', attestation.baseSha, attestation.mergeSha) !== 0 ||
      gitExitCode(root, 'merge-base', '--is-ancestor', attestation.mergeSha, base) !== 0 ||
      git(root, 'rev-parse', `${attestation.mergeSha}^{tree}`) !== attestation.mergeTree ||
      (!branchIncluded && attestation.strategy === 'merge')
    ) {
      throw new DeliveryError('Exact merged-result cleanup attestation disagrees with Git or remote readback.');
    }
  } else if (!branchIncluded) {
    throw new DeliveryError(
      'Branch is not included in the current base and exact merged-result attestation is absent.',
    );
  }
  if (present) git(root, 'worktree', 'remove', row.path);
}

/** Remove only a finished, retained source and its exact local branch; never force Git removal. */
export function removeFinishedIssueSource(
  row: WorktreeEntry,
  root: string,
  headSha: string,
  attestation?: MergeCleanupAttestation,
): void {
  assertIssueNumber(row.issueNumber ?? 0);
  if (
    row.branch !== `issue/${String(row.issueNumber)}` ||
    row.path !== join(root, '.worktrees', `issue-${String(row.issueNumber)}`)
  )
    throw new DeliveryError('Registered path or branch differs from the finished issue; preserve the source.');
  if (gitExitCode(root, 'symbolic-ref', '--quiet', `refs/heads/${row.branch}`) === 0)
    throw new DeliveryError('Registered branch is symbolic; preserve its target and restore direct branch ownership.');
  if (pathPresent(row.path) && realpathSync(row.path) !== row.path)
    throw new DeliveryError('Registered source has a symlinked path; preserve its physical worktree.');
  const current = relative(row.path, realpathSync(process.cwd()));
  if (row.path === primaryGitRoot(root) || !(current === '..' || current.startsWith(`..${sep}`) || isAbsolute(current)))
    throw new DeliveryError('Cleanup targets the current or primary worktree; run finish from outside that worktree.');
  const rows = gitWorktreeRows(root).filter(
    (lines) => lines.includes(`worktree ${row.path}`) || lines.includes(`branch refs/heads/${row.branch}`),
  );
  if (pathPresent(row.path)) {
    if (lstatSync(row.path).isSymbolicLink())
      throw new DeliveryError('Registered source is a symlink; preserve the source.');
    assertIssueWorktreeLocation(row, root);
    try {
      assertClean(row.path);
    } catch {
      throw new DeliveryError('Worktree contains local changes; preserve them before cleanup.');
    }
    if (rows.length !== 1 || rows[0]!.some((line) => /^(?:locked|prunable)(?: |$)/u.test(line)))
      throw new DeliveryError('Worktree custody is ambiguous or locked; preserve the source.');
    if (
      git(row.path, 'ls-files', '-v', '-z')
        .split('\0')
        .some((entry) => /^(?:[a-z]|S) /u.test(entry))
    )
      throw new DeliveryError('Worktree has hidden index entries; preserve local data before cleanup.');
    if (git(row.path, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z') !== '')
      throw new DeliveryError('Worktree contains ignored files; preserve local data before cleanup.');
  } else if (rows.length !== 0)
    throw new DeliveryError('Missing worktree still has Git custody; reconcile it without forced cleanup.');
  if (gitExitCode(root, 'show-ref', '--verify', '--quiet', `refs/heads/${row.branch}`) !== 0) {
    if (!pathPresent(row.path)) return;
    throw new DeliveryError('Registered branch is absent; preserve the source.');
  }
  if (git(root, 'rev-parse', `refs/heads/${row.branch}`) !== headSha)
    throw new DeliveryError('Local branch differs from the finished PR head; preserve its commits.');
  removeMergedIssueSource(row, root, undefined, attestation, true);
  git(root, 'update-ref', '--no-deref', '-d', `refs/heads/${row.branch}`, headSha);
  if (pathPresent(row.path) || gitExitCode(root, 'show-ref', '--verify', '--quiet', `refs/heads/${row.branch}`) === 0)
    throw new DeliveryError('Cleanup readback is incomplete; inspect the retained source without retrying removal.');
}
