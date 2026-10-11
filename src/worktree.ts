import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { resolveGitRemoteName } from './github/repo.js';

import { DeliveryError } from './errors.js';
import type { WorktreeTransitionPlan } from './worktreeTransition.js';
import { assertClean, defaultBaseRef, git, gitCommonDir, gitExitCode, gitRoot, primaryGitRoot } from './git.js';
import {
  assertIssueWorktreeTransitionAdmission,
  type WorktreeEntry,
  type InvestigationPreparation,
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

/** @internal Preservation-only refusal for callers of the removed issue-worktree API. */
export async function prepareIssueWorktree(input: {
  identity: string;
  issueNumber: number;
  repoRoot: string;
}): Promise<WorktreeEntry> {
  assertIssueNumber(input.issueNumber);
  assertIssueWorktreeTransitionAdmission(input.issueNumber, primaryGitRoot(input.repoRoot));
  throw new DeliveryError(
    'Issue worktree preparation was removed; prepare a host-owned worktree from the GitHub-linked branch.',
  );
}

function investigationGitRows(root: string): string[][] {
  return git(root, 'worktree', 'list', '--porcelain')
    .split('\n\n')
    .filter(Boolean)
    .map((block) => block.split('\n'));
}
function investigationPathPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Observe a host-created, restricted worktree; registration never creates or adopts legacy source. */
export function investigationSourceIdentity(
  root: string,
  issueNumber: number,
): Pick<InvestigationPreparation, 'head' | 'physical'> {
  assertIssueNumber(issueNumber);
  const target = join(root, '.worktrees', `issue-${String(issueNumber)}`);
  const branch = `issue/${String(issueNumber)}`;
  assertIssueWorktreeLocation(
    { path: target, branch, issueNumber, type: 'issue', status: 'active', createdAt: '', updatedAt: '' },
    root,
  );
  // Lowercase tags hide assume-unchanged entries; S/s hides skip-worktree entries.
  // Do not let Git's own cleanliness checks turn hidden working bytes into removal authority.
  if (
    git(target, 'ls-files', '-v', '-z')
      .split('\0')
      .some((entry) => /^(?:[a-z]|S) /u.test(entry))
  )
    throw new DeliveryError(
      'Investigation source has assume-unchanged or skip-worktree index entries; preserve hidden local data.',
    );
  assertClean(target);
  if (git(target, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z') !== '')
    throw new DeliveryError('Investigation source contains ignored files; preserve them before completion.');
  const rows = investigationGitRows(root).filter(
    (row) => row.includes(`worktree ${target}`) || row.includes(`branch refs/heads/${branch}`),
  );
  if (rows.length !== 1 || rows[0]!.some((line) => /^(?:locked|prunable)(?: |$)/u.test(line)))
    throw new DeliveryError('Investigation Git worktree custody is ambiguous or locked.');
  const directory = realpathSync(resolve(target, git(target, 'rev-parse', '--git-dir')));
  const metadata = lstatSync(target);
  const administration = lstatSync(directory);
  return {
    head: { sha: git(target, 'rev-parse', 'HEAD'), tree: git(target, 'rev-parse', 'HEAD^{tree}') },
    physical: {
      device: metadata.dev,
      inode: metadata.ino,
      gitDirectory: directory,
      gitDevice: administration.dev,
      gitInode: administration.ino,
    },
  };
}

/** Commit equality refuses new same-tree commits as well as source changes and unpushed history. */
export function assertInvestigationSource(
  preparation: InvestigationPreparation,
  launchDirectory: string,
  allowAbsent = false,
): void {
  const { repoRoot: root, row, head } = preparation;
  assertSafePath(root, row.path);
  if (
    row.path !== join(root, '.worktrees', `issue-${String(row.issueNumber)}`) ||
    row.branch !== `issue/${String(row.issueNumber)}`
  )
    throw new DeliveryError('Investigation path or branch disagrees.');
  if (row.path === primaryGitRoot(root) || row.path === gitRoot(launchDirectory))
    throw new DeliveryError('Investigation completion refuses the primary or current worktree.');
  // --repo-root must not hide an invocation launched inside the removable worktree.
  const currentRelative = relative(row.path, realpathSync(process.cwd()));
  if (currentRelative === '' || (!currentRelative.startsWith('..') && !currentRelative.startsWith('/')))
    throw new DeliveryError('Investigation completion refuses the current worktree.');
  if (git(root, 'rev-parse', `refs/heads/${row.branch}`) !== head.sha)
    throw new DeliveryError('Investigation retaining branch has new or unpushed commits.');
  const rows = investigationGitRows(root).filter(
    (candidate) => candidate.includes(`worktree ${row.path}`) || candidate.includes(`branch refs/heads/${row.branch}`),
  );
  if (!investigationPathPresent(row.path)) {
    // Git removal must have completed both disk and administration before row retirement.
    if (!allowAbsent || rows.length !== 0 || investigationPathPresent(preparation.physical.gitDirectory))
      throw new DeliveryError('Investigation source is missing without exact completed Git removal.');
    return;
  }
  const observed = investigationSourceIdentity(root, row.issueNumber);
  if (
    JSON.stringify(observed.head) !== JSON.stringify(head) ||
    JSON.stringify(observed.physical) !== JSON.stringify(preparation.physical)
  )
    throw new DeliveryError('Investigation source commit, tree or physical identity changed.');
}

export function removeInvestigationSource(preparation: InvestigationPreparation, launchDirectory: string): void {
  assertInvestigationSource(preparation, launchDirectory, true);
  if (investigationPathPresent(preparation.row.path))
    git(preparation.repoRoot, 'worktree', 'remove', preparation.row.path);
  if (
    investigationPathPresent(preparation.row.path) ||
    investigationPathPresent(preparation.physical.gitDirectory) ||
    investigationGitRows(preparation.repoRoot).some((row) => row.includes(`worktree ${preparation.row.path}`))
  )
    throw new DeliveryError('Investigation removal disk/Git readback is incomplete.');
  assertInvestigationSource(preparation, launchDirectory, true);
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

/** @internal Exact terminal transition uses the existing non-force removal and retaining-ref proof. */
export function removeMergedSourceForTransition(plan: WorktreeTransitionPlan, remote: string | undefined): void {
  if (plan.purpose !== 'merged-cleanup' || plan.disposition !== 'remove' || plan.retainedHoldCommentIds.length !== 0)
    throw new DeliveryError('Transition cannot remove held or nonterminal source.');
  const terminal = plan.lineage.find((pr) => pr.prNumber === plan.terminalPrNumber);
  if (!terminal?.merged || !terminal.mergeSha)
    throw new DeliveryError('Transition lacks exact native terminal merge lineage.');
  const mergeTree = git(plan.repoRoot, 'rev-parse', `${terminal.mergeSha}^{tree}`);
  const strategy =
    gitExitCode(plan.repoRoot, 'merge-base', '--is-ancestor', plan.head.sha, terminal.mergeSha) === 0
      ? 'merge'
      : 'squash';
  if (strategy === 'squash' && mergeTree !== plan.head.tree)
    throw new DeliveryError('Transition lacks exact retained tree proof for non-merge source removal.');
  if (!plan.remoteRefs || (plan.remoteRefs.headSha !== null && plan.remoteRefs.headSha !== plan.head.sha))
    throw new DeliveryError('Transition lacks exact authenticated remote branch readback.');
  removeMergedIssueSource(
    { ...plan.row, status: 'merged', prNumber: terminal.prNumber } as WorktreeEntry,
    plan.repoRoot,
    remote,
    {
      baseBranch: terminal.baseBranch,
      baseSha: terminal.baseSha,
      headBranch: plan.row.branch,
      headSha: plan.head.sha,
      mergeSha: terminal.mergeSha,
      mergeTree,
      remoteBaseSha: plan.remoteRefs.baseSha,
      remoteHeadSha: plan.remoteRefs.headSha,
      strategy,
    },
    true,
  );
}
