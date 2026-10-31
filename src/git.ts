import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { GIT_EXECUTABLE, inertGitArguments, gitEnvironment } from './gitProcess.js';

import { DeliveryError } from './errors.js';

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

export function gitCommonDir(cwd: string): string {
  return realpathSync(resolve(cwd, git(cwd, 'rev-parse', '--git-common-dir')));
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
