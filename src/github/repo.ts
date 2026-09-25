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
  config: DeliveryConfig,
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
  const remotes = spawnSync('git', ['remote'], { cwd: repoRoot, encoding: 'utf8' });
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
  const result = spawnSync('git', ['config', '--get', `remote.${remoteName}.url`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
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
