import { readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { GIT_EXECUTABLE, inertGitArguments, gitEnvironment } from '../gitProcess.js';

import { spawnSync } from 'node:child_process';

import type { DeliveryConfig } from '../config/deliveryConfig.js';

import { DeliveryError } from '../errors.js';

export interface RepoCoordinates {
  owner: string;
  repo: string;
}

export function formatRepoCoordinates(repo: RepoCoordinates): string {
  return `${repo.owner}/${repo.repo}`;
}

export function resolveDeliveryRepo(
  config: Pick<DeliveryConfig, 'repository'>,
  repoRoot: string,
  selectedRemote?: string,
): RepoCoordinates {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(config.repository)) {
    throw new DeliveryError('Invalid configured delivery repository.');
  }
  const [owner, repo] = config.repository.split('/');
  if (!owner || !repo) throw new DeliveryError('Invalid configured delivery repository.');
  const remote = resolveRepoFromRemote(repoRoot, selectedRemote);
  if (owner.toLowerCase() !== remote.owner.toLowerCase() || repo.toLowerCase() !== remote.repo.toLowerCase()) {
    throw new DeliveryError('Configured delivery repository does not match remote selection.');
  }
  return { owner, repo };
}

export function resolveGitRemoteName(repoRoot: string, selectedRemote?: string): string {
  const remotes = spawnSync(GIT_EXECUTABLE, [...inertGitArguments(repoRoot), 'remote'], {
    env: gitEnvironment(),
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (remotes.status !== 0) throw new DeliveryError('Unable to list Git remotes.');
  const names = remotes.stdout.trim().split('\n').filter(Boolean);
  if (selectedRemote !== undefined && !names.includes(selectedRemote)) {
    throw new DeliveryError('Selected Git remote does not exist in this checkout.');
  }
  if (selectedRemote === undefined && names.length !== 1) {
    throw new DeliveryError('Select a Git remote explicitly when the checkout has zero or multiple remotes.');
  }
  const remoteName = selectedRemote ?? names[0];
  if (!remoteName) throw new DeliveryError('Git remote selection is missing.');
  return remoteName;
}

export function resolveRepoFromRemote(repoRoot: string, selectedRemote?: string): RepoCoordinates {
  const remoteName = resolveGitRemoteName(repoRoot, selectedRemote);
  const result = spawnSync(
    GIT_EXECUTABLE,
    [...inertGitArguments(repoRoot), 'config', '--local', '--no-includes', '--get', `remote.${remoteName}.url`],
    {
      env: gitEnvironment(),
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    throw new DeliveryError('Unable to determine repository identity from the selected Git remote.');
  }
  const remote = result.stdout.trim();
  const match =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(
      remote,
    );
  if (!match?.[1] || !match[2]) {
    throw new DeliveryError('The selected Git remote must be a github.com repository URL.');
  }
  return { owner: match[1], repo: match[2] };
}

/** No process-wide checkout binding: select an origin-matched clone on each local call. */
export function resolveCheckout(input: {
  repository: string;
  launchDirectory: string;
  checkoutRoots: string[];
}): string {
  const matches = (path: string): string | null => {
    try {
      const remote = resolveRepoFromRemote(path, 'origin');
      if (formatRepoCoordinates(remote).toLowerCase() !== input.repository.toLowerCase()) return null;
      const result = spawnSync(GIT_EXECUTABLE, [...inertGitArguments(path), 'rev-parse', '--show-toplevel'], {
        env: gitEnvironment(),
        cwd: path,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
      return result.status === 0 ? realpathSync(result.stdout.trim()) : null;
    } catch {
      return null;
    }
  };
  const current = matches(input.launchDirectory);
  if (current) return current;
  const candidates = new Set<string>();
  for (const root of input.checkoutRoots) {
    const direct = matches(root);
    if (direct) {
      candidates.add(direct);
      continue;
    }
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      throw new DeliveryError(`Checkout root is unreadable: ${root}`);
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const path = matches(join(root, entry.name));
      if (path) candidates.add(path);
    }
  }
  if (candidates.size !== 1)
    throw new DeliveryError(
      `Repository ${input.repository} has ${candidates.size === 0 ? 'no matching' : 'ambiguous'} checkout; select its checkout with --repo-root or configure checkoutRoots.`,
    );
  return [...candidates][0]!;
}
