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

export function resolveDeliveryRepo(config: DeliveryConfig, repoRoot: string): RepoCoordinates {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(config.repository)) {
    throw new DeliveryError('Invalid configured delivery repository.');
  }
  const [owner, repo] = config.repository.split('/');
  if (!owner || !repo) throw new DeliveryError('Invalid configured delivery repository.');
  const remote = resolveRepoFromRemote(repoRoot);
  if (owner.toLowerCase() !== remote.owner.toLowerCase() || repo.toLowerCase() !== remote.repo.toLowerCase()) {
    throw new DeliveryError('Configured delivery repository does not match remote.origin.url.');
  }
  return { owner, repo };
}

export function resolveRepoFromRemote(repoRoot: string): RepoCoordinates {
  const result = spawnSync('git', ['config', '--get', 'remote.origin.url'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new DeliveryError('Unable to determine canonical repository identity from remote.origin.url.');
  }
  const remote = result.stdout.trim();
  const match =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(
      remote,
    );
  if (!match?.[1] || !match[2]) {
    throw new DeliveryError('remote.origin.url must be a GitHub repository URL.');
  }
  return { owner: match[1], repo: match[2] };
}
