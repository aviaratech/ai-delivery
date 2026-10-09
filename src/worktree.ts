import { existsSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';

import { resolveGitRemoteName } from './github/repo.js';

import { DeliveryError } from './errors.js';
import type { WorktreeTransitionPlan } from './worktreeTransition.js';
import { assertClean, defaultBaseRef, git, gitCommonDir, gitExitCode, gitRoot, primaryGitRoot } from './git.js';
import { assertIssueWorktreeTransitionAdmission, type WorktreeEntry } from './services/worktreeRegistry.js';

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
