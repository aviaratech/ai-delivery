import { spawnSync } from 'node:child_process';
import { DeliveryError } from './errors.js';

/** Local probes use the system Git, never a checkout's PATH shim. */
export const GIT_EXECUTABLE = '/usr/bin/git';
export const GIT_INERT_ARGUMENTS = [
  '--no-replace-objects',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'diff.external=',
] as const;
export function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}
/** Even status can invoke a tracked attribute's clean filter; neutralize every configured driver. */
export function inertGitArguments(cwd: string): string[] {
  const result = spawnSync(
    GIT_EXECUTABLE,
    [
      ...GIT_INERT_ARGUMENTS,
      'config',
      '--includes',
      '--name-only',
      '--get-regexp',
      '^filter\\..*\\.(clean|smudge|process|required)$',
    ],
    {
      cwd,
      env: gitEnvironment(),
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.error || (result.status !== 0 && result.status !== 1))
    throw new DeliveryError('Unable to inspect Git filters safely.');
  const keys = result.stdout.trim().split('\n').filter(Boolean);
  if (
    keys.length > 4096 ||
    keys.some((key) => !/^filter\.[^\r\n]+\.(clean|smudge|process|required)$/u.test(key) || key.length > 1024)
  )
    throw new DeliveryError('Git filter configuration exceeds the safe probe boundary.');
  return [
    ...GIT_INERT_ARGUMENTS,
    ...keys.flatMap((key) => ['-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`]),
  ];
}
