import { existsSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { resolveGitRemoteName } from './github/repo.js';

import { DeliveryError } from './errors.js';
import { assertClean, defaultBaseRef, git, gitExitCode, gitRoot, primaryGitRoot } from './git.js';
import {
  addWorktreeEntry,
  assertAiDeliveryWorktreeOwner,
  getIssueWorktreeStrict,
  listWorktreesStrict,
  removeWorktreeEntry,
  type WorktreeEntry,
} from './services/worktreeRegistry.js';

function assertSafePath(root: string, target: string): void {
  const rel = relative(join(root, '.worktrees'), target);
  if (rel === '' || rel.startsWith('..') || rel.startsWith('/')) {
    throw new DeliveryError('Worktree path must be inside the repository .worktrees directory.');
  }
}

function assertIssueNumber(issueNumber: number): void {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) throw new DeliveryError('Issue number must be positive.');
}

export async function prepareIssueWorktree(input: {
  baseRef?: string;
  identity: string;
  issueNumber: number;
  repoRoot: string;
  remote?: string;
}): Promise<WorktreeEntry> {
  assertIssueNumber(input.issueNumber);
  const root = primaryGitRoot(input.repoRoot);
  const branch = `issue/${input.issueNumber}`;
  const target = join(root, '.worktrees', `issue-${input.issueNumber}`);
  assertSafePath(root, target);
  const existing = listWorktreesStrict(root).filter(
    (row) => row.type === 'issue' && row.issueNumber === input.issueNumber,
  );
  if (existing.length > 1) throw new DeliveryError('Issue has duplicate worktree registry rows.');
  if (existing.length === 1) {
    const row = existing[0]!;
    assertAiDeliveryWorktreeOwner(row, root);
    if (row.status !== 'active' && row.status !== 'pr-published') {
      throw new DeliveryError('Only an active issue worktree can be resumed.');
    }
    if (
      row.path !== target ||
      row.branch !== branch ||
      !existsSync(target) ||
      gitRoot(target) !== realpathSync(target)
    ) {
      throw new DeliveryError('Registered worktree disagrees with its exact path or branch.');
    }
    if (git(target, 'branch', '--show-current') !== branch) throw new DeliveryError('Registered branch drifted.');
    return row;
  }
  if (existsSync(target)) throw new DeliveryError('An unregistered issue worktree path already exists.');
  const base = input.baseRef ?? defaultBaseRef(root, input.remote);
  if (!base || gitExitCode(root, 'rev-parse', '--verify', '--quiet', base) !== 0) {
    throw new DeliveryError('Default base ref is missing.');
  }
  const branchExists = gitExitCode(root, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`) === 0;
  if (branchExists) {
    git(root, 'worktree', 'add', target, branch);
  } else {
    git(root, 'worktree', 'add', '-b', branch, target, base);
  }
  const now = new Date().toISOString();
  const row: WorktreeEntry = {
    branch,
    createdAt: now,
    identity: input.identity,
    issueNumber: input.issueNumber,
    path: target,
    status: 'active',
    type: 'issue',
    updatedAt: now,
  };
  try {
    await addWorktreeEntry(row, root);
  } catch (error) {
    if (git(target, 'status', '--porcelain', '--untracked-files=all') === '') {
      git(root, 'worktree', 'remove', target);
    }
    throw error;
  }
  return row;
}

export async function prepareStandaloneWorktree(input: {
  baseRef?: string;
  branch: string;
  identity: string;
  name: string;
  repoRoot: string;
  remote?: string;
}): Promise<WorktreeEntry> {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(input.name) || !/^[A-Za-z0-9._/-]+$/u.test(input.branch)) {
    throw new DeliveryError('Invalid standalone worktree name or branch.');
  }
  const root = primaryGitRoot(input.repoRoot);
  const target = resolve(root, '.worktrees', input.name);
  assertSafePath(root, target);
  if (
    existsSync(target) ||
    listWorktreesStrict(root).some((row) => row.path === target || row.branch === input.branch)
  ) {
    throw new DeliveryError('Standalone worktree name or branch already exists.');
  }
  const base = input.baseRef ?? defaultBaseRef(root, input.remote);
  git(root, 'worktree', 'add', '-b', input.branch, target, base);
  const now = new Date().toISOString();
  const row: WorktreeEntry = {
    branch: input.branch,
    createdAt: now,
    identity: input.identity,
    path: target,
    status: 'active',
    type: 'standalone',
    updatedAt: now,
  };
  try {
    await addWorktreeEntry(row, root);
  } catch (error) {
    assertClean(target);
    git(root, 'worktree', 'remove', target);
    throw error;
  }
  return row;
}

/** Register the exact head of an in-repository PR after its selected-App fetch. */
export async function preparePrWorktree(input: {
  headSha: string;
  identity: string;
  prNumber: number;
  repoRoot: string;
}): Promise<WorktreeEntry> {
  assertIssueNumber(input.prNumber);
  if (!/^[a-f0-9]{40}$/u.test(input.headSha)) throw new DeliveryError('PR head SHA is invalid.');
  const root = primaryGitRoot(input.repoRoot);
  const branch = `pr/${input.prNumber}`;
  const target = join(root, '.worktrees', `pr-${input.prNumber}`);
  assertSafePath(root, target);
  if (gitExitCode(root, 'cat-file', '-e', `${input.headSha}^{commit}`) !== 0) {
    throw new DeliveryError('Fetched PR head object is unavailable.');
  }
  const matches = listWorktreesStrict(root).filter((row) => row.type === 'pr' && row.prNumber === input.prNumber);
  if (matches.length > 1) throw new DeliveryError('PR has duplicate worktree registry rows.');
  if (matches.length === 1) {
    const row = matches[0]!;
    assertAiDeliveryWorktreeOwner(row, root);
    if (
      row.status !== 'active' ||
      row.path !== target ||
      row.branch !== branch ||
      !existsSync(target) ||
      gitRoot(target) !== realpathSync(target) ||
      git(target, 'branch', '--show-current') !== branch
    ) {
      throw new DeliveryError('Registered PR worktree disagrees with its exact path or branch.');
    }
    if (git(target, 'rev-parse', 'HEAD') !== input.headSha) {
      throw new DeliveryError('Registered PR worktree head differs from the fetched PR head.');
    }
    return row;
  }
  if (existsSync(target)) throw new DeliveryError('An unregistered PR worktree path already exists.');
  const branchExists = gitExitCode(root, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`) === 0;
  if (branchExists && git(root, 'rev-parse', `refs/heads/${branch}`) !== input.headSha) {
    throw new DeliveryError('Retained PR branch differs from the fetched PR head.');
  }
  if (branchExists) git(root, 'worktree', 'add', target, branch);
  else git(root, 'worktree', 'add', '-b', branch, target, input.headSha);
  const now = new Date().toISOString();
  const row: WorktreeEntry = {
    branch,
    createdAt: now,
    identity: input.identity,
    path: target,
    prNumber: input.prNumber,
    status: 'active',
    type: 'pr',
    updatedAt: now,
  };
  try {
    await addWorktreeEntry(row, root);
  } catch (error) {
    assertClean(target);
    git(root, 'worktree', 'remove', target);
    throw error;
  }
  return row;
}

/** Remove only a clean registered PR or standalone worktree; issue cleanup remains receipt-bound. */
export async function cleanupNonIssueWorktree(input: {
  name?: string;
  prNumber?: number;
  repoRoot: string;
  remote?: string;
}): Promise<void> {
  if ((input.name === undefined) === (input.prNumber === undefined)) {
    throw new DeliveryError('Select exactly one registered PR number or standalone name.');
  }
  if (input.prNumber !== undefined) assertIssueNumber(input.prNumber);
  if (input.name !== undefined && !/^[a-z0-9][a-z0-9._-]*$/u.test(input.name)) {
    throw new DeliveryError('Standalone worktree name is invalid.');
  }
  const root = primaryGitRoot(input.repoRoot);
  const target =
    input.prNumber === undefined
      ? join(root, '.worktrees', input.name!)
      : join(root, '.worktrees', `pr-${input.prNumber}`);
  assertSafePath(root, target);
  const matches = listWorktreesStrict(root).filter((row) => row.path === target);
  if (
    matches.length !== 1 ||
    (input.prNumber === undefined
      ? matches[0]!.type !== 'standalone'
      : matches[0]!.type !== 'pr' || matches[0]!.prNumber !== input.prNumber)
  ) {
    throw new DeliveryError('Selected non-issue worktree has no exact registry owner.');
  }
  const row = matches[0]!;
  assertAiDeliveryWorktreeOwner(row, root);
  if (
    !existsSync(target) ||
    gitRoot(target) !== realpathSync(target) ||
    git(target, 'branch', '--show-current') !== row.branch
  ) {
    throw new DeliveryError('Registered non-issue worktree is missing or drifted.');
  }
  assertClean(target);
  const head = git(target, 'rev-parse', 'HEAD');
  const remote = resolveGitRemoteName(root, input.remote);
  const remoteRef =
    input.prNumber === undefined
      ? `refs/remotes/${remote}/${row.branch}`
      : `refs/remotes/${remote}/ai-delivery-pr-${input.prNumber}`;
  const retainedByBase =
    gitExitCode(root, 'merge-base', '--is-ancestor', head, defaultBaseRef(root, input.remote)) === 0;
  const retainedByRemote =
    gitExitCode(root, 'show-ref', '--verify', '--quiet', remoteRef) === 0 &&
    gitExitCode(root, 'merge-base', '--is-ancestor', head, remoteRef) === 0;
  if (!retainedByBase && !retainedByRemote) {
    throw new DeliveryError('Clean worktree has an unpublished commit; cleanup requires an exact retaining ref.');
  }
  git(root, 'worktree', 'remove', target);
  await removeWorktreeEntry(target, root);
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

export async function cleanupMergedIssueWorktree(input: {
  issueNumber: number;
  repoRoot: string;
  remote?: string;
  merge?: MergeCleanupAttestation;
  afterRemoval?: () => Promise<void>;
}): Promise<void> {
  assertIssueNumber(input.issueNumber);
  const root = primaryGitRoot(input.repoRoot);
  const row = getIssueWorktreeStrict(input.issueNumber, root);
  assertSafePath(root, row.path);
  if (row.status !== 'merged' || row.path !== join(root, '.worktrees', `issue-${input.issueNumber}`)) {
    throw new DeliveryError('Only the exact registered merged issue worktree can be cleaned.');
  }
  const present = existsSync(row.path);
  if (present && gitRoot(row.path) !== realpathSync(row.path)) {
    throw new DeliveryError('Registered worktree points elsewhere.');
  }
  if (!present && input.afterRemoval === undefined) {
    throw new DeliveryError('Registered worktree is missing.');
  }
  if (present) assertClean(row.path);
  const base = defaultBaseRef(root, input.remote);
  const branchIncluded = gitExitCode(root, 'merge-base', '--is-ancestor', row.branch, base) === 0;
  const attestation = input.merge;
  if (attestation) {
    if (
      attestation.headBranch !== row.branch ||
      attestation.headSha !== git(present ? row.path : root, 'rev-parse', present ? 'HEAD' : row.branch) ||
      (attestation.remoteHeadSha !== null && attestation.remoteHeadSha !== attestation.headSha) ||
      attestation.baseBranch !== base.slice(`refs/remotes/${resolveGitRemoteName(root, input.remote)}/`.length) ||
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
  await input.afterRemoval?.();
  await removeWorktreeEntry(row.path, root);
}
