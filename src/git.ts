import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import { GIT_EXECUTABLE, inertGitArguments, gitEnvironment } from './gitProcess.js';

import { DeliveryError } from './errors.js';
import { resolveGitRemoteName } from './github/repo.js';

export interface GitCoordinate {
  sha: string;
  tree: string;
}

export function git(cwd: string, ...args: string[]): string {
  try {
    return execFileSync(GIT_EXECUTABLE, [...inertGitArguments(cwd), ...args], {
      env: gitEnvironment(),
      cwd,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (cause) {
    const error = cause as Error & { stderr?: Buffer | string };
    const detail = String(error.stderr ?? '').trim();
    throw new DeliveryError(`git ${args[0] ?? ''} failed${detail ? `: ${detail}` : ''}`);
  }
}

export function gitExitCode(cwd: string, ...args: string[]): number {
  const result = spawnSync(GIT_EXECUTABLE, [...inertGitArguments(cwd), ...args], {
    env: gitEnvironment(),
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function gitRoot(cwd: string): string {
  return realpathSync(resolve(cwd, git(cwd, 'rev-parse', '--show-toplevel')));
}

export function gitCommonDir(cwd: string): string {
  return realpathSync(resolve(cwd, git(cwd, 'rev-parse', '--git-common-dir')));
}

export function primaryGitRoot(cwd: string): string {
  const common = gitCommonDir(cwd);
  if (basename(common) !== '.git') throw new DeliveryError('Expected a conventional non-bare Git repository.');
  return dirname(common);
}

export function coordinate(cwd: string, ref = 'HEAD'): GitCoordinate {
  const sha = git(cwd, 'rev-parse', '--verify', ref);
  const tree = git(cwd, 'rev-parse', `${sha}^{tree}`);
  if (!/^[a-f0-9]{40}$/u.test(sha) || !/^[a-f0-9]{40}$/u.test(tree)) {
    throw new DeliveryError('Git coordinate is not a SHA-1 commit and tree.');
  }
  return { sha, tree };
}

export function assertClean(cwd: string): void {
  if (git(cwd, 'status', '--porcelain', '--untracked-files=all') !== '') {
    throw new DeliveryError('Delivery requires an exact clean worktree.');
  }
}

export function changedPaths(cwd: string, baseSha: string, headSha: string): string[] {
  const output = git(cwd, 'diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', baseSha, headSha);
  return output.split('\0').filter(Boolean).sort();
}

export function defaultBaseRef(cwd: string, selectedRemote?: string): string {
  const remote = resolveGitRemoteName(cwd, selectedRemote);
  const prefix = `refs/remotes/${remote}/`;
  if (gitExitCode(cwd, 'symbolic-ref', '--quiet', `${prefix}HEAD`) === 0) {
    const ref = git(cwd, 'symbolic-ref', '--quiet', `${prefix}HEAD`);
    if (!ref.startsWith(prefix)) throw new DeliveryError('Selected remote HEAD points outside its tracking refs.');
    return ref;
  }
  if (gitExitCode(cwd, 'show-ref', '--verify', '--quiet', `${prefix}main`) === 0) return `${prefix}main`;
  throw new DeliveryError(`Fetch the selected remote ${remote} and set its default branch before delivery.`);
}
