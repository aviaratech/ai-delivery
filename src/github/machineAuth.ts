import { execFile } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { z } from 'zod';

import { DeliveryError } from '../errors.js';

/** This package's repository/API contract currently supports github.com only. */
export function assertSupportedAuthorHost(env: NodeJS.ProcessEnv): void {
  if (env.GH_HOST !== undefined && env.GH_HOST.trim().toLowerCase() !== 'github.com')
    throw new DeliveryError('GitHub delivery supports github.com only; the selected GH_HOST is unsupported.');
}

export function machineAuthorEligible(reference: string, env: NodeJS.ProcessEnv): boolean {
  // A present but empty explicit value is an invalid selection, not permission
  // to silently change actors. Custom references always require their value.
  return reference === 'GH_TOKEN' && env.GH_TOKEN === undefined;
}

export const MACHINE_AUTH_ENV_NAMES = [
  'HOME',
  'USER',
  'LOGNAME',
  'PATH',
  'LANG',
  'LC_ALL',
  'GH_HOST',
  'GH_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
] as const;

const Status = z.object({
  hosts: z.record(
    z.string(),
    z.array(
      z.object({
        active: z.boolean(),
        host: z.string(),
        login: z.string(),
        state: z.string(),
      }),
    ),
  ),
});

function executable(env: NodeJS.ProcessEnv): string {
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    // Never use cwd or a shell profile to recover a GUI's missing PATH.
    if (!isAbsolute(directory)) continue;
    try {
      const path = realpathSync(join(directory, process.platform === 'win32' ? 'gh.exe' : 'gh'));
      if (!statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      /* Continue only the explicitly supplied PATH search. */
    }
  }
  throw new DeliveryError(
    'GitHub CLI gh is unavailable on this process PATH; verify the native host launch environment.',
  );
}

function sessionEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of MACHINE_AUTH_ENV_NAMES) if (env[name] !== undefined) result[name] = env[name];
  for (const name of ['HOME', 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    if (result[name] !== undefined && (!isAbsolute(result[name]!) || !statDirectory(result[name]!)))
      throw new DeliveryError('Machine GitHub session home/configuration selector is unavailable or invalid.');
  }
  if (process.platform !== 'win32' && result.HOME === undefined)
    throw new DeliveryError('Machine GitHub session requires the native process HOME; verify its launch environment.');
  if (process.platform === 'win32' && result.APPDATA === undefined && result.HOME === undefined)
    throw new DeliveryError('Machine GitHub session requires the native process home/configuration environment.');
  return {
    ...result,
    GH_HOST: 'github.com',
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
    GH_TELEMETRY: '0',
  };
}

function statDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

async function capture(path: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    execFile(
      path,
      args,
      {
        env,
        cwd: env.HOME ?? env.APPDATA,
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
        ...(signal === undefined ? {} : { signal }),
      },
      (error, stdout) => {
        // stderr and Error may contain a token, keyring path or upstream body.
        // Keep capture private; never return them or attach them as an error cause.
        if (error !== null)
          reject(
            new DeliveryError('Machine GitHub session lookup failed; verify gh and the selected github.com account.'),
          );
        else resolve(stdout);
      },
    );
  });
}

/** Privately supplies only the selected existing session to the auth client. */
export async function withMachineAuthorCredential<T>(
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  use: (token: string, selected: { login: string; executable: string }) => Promise<T>,
): Promise<T> {
  assertSupportedAuthorHost(env);
  const selectedEnvironment = sessionEnvironment(env);
  const path = executable(selectedEnvironment);
  let login: string;
  try {
    // JSON exit zero does not prove success. Inactive accounts must neither
    // invalidate the selected account nor become an alternate identity.
    const status = Status.parse(
      JSON.parse(
        await capture(
          path,
          ['auth', 'status', '--hostname', 'github.com', '--active', '--json', 'hosts'],
          selectedEnvironment,
          signal,
        ),
      ) as unknown,
    );
    if (Object.keys(status.hosts).length !== 1 || !status.hosts['github.com']) throw new Error('Host mismatch');
    const active = status.hosts['github.com'].filter((entry) => entry.active);
    const account = active[0];
    if (
      active.length !== 1 ||
      account?.host !== 'github.com' ||
      account.state !== 'success' ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(account.login)
    )
      throw new Error('Account unavailable');
    login = account.login;
  } catch {
    throw new DeliveryError(
      'Machine GitHub session has no unambiguous healthy active github.com user; verify gh auth status for this host.',
    );
  }
  const token = (
    await capture(path, ['auth', 'token', '--hostname', 'github.com', '--user', login], selectedEnvironment, signal)
  ).trim();
  if (!/^[A-Za-z0-9_-]{1,4096}$/u.test(token))
    throw new DeliveryError('Machine GitHub session token is unavailable or invalid; verify the selected account.');
  return use(token, { login, executable: path });
}
