import { spawn, spawnSync } from 'node:child_process';
import { createRequire, findPackageJSON } from 'node:module';
import { types } from 'node:util';
import { existsSync, readFileSync, readdirSync, realpathSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { digestBytes, digestValue, writeCreateOnly } from './delivery/common.js';
import { DeliveryError } from './errors.js';
import { gitCommonDir } from './git.js';

export interface VerificationResourceBounds {
  maxAggregateRssBytes: number;
  maxNewOutputBytes?: number;
  minFreeDiskBytes: number;
  outputRoots?: readonly string[];
}

function availableDiskBytes(path: string): bigint {
  let existing = path;
  for (;;) {
    try {
      const disk = statfsSync(existing, { bigint: true });
      return disk.bavail * disk.bsize;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(existing) === existing) throw error;
      existing = dirname(existing);
    }
  }
}

function freeDiskBytes(repoRoot: string): number {
  const available = availableDiskBytes(repoRoot);
  if (available > BigInt(Number.MAX_SAFE_INTEGER)) throw new DeliveryError('Free disk observation overflowed.');
  return Number(available);
}

interface ObservedProcess {
  identity: string;
  pgid: number;
  pid: number;
  ppid: number;
  rssBytes: number;
  status: string;
}

export interface OwnedProcessState {
  rootIdentity?: string;
  rootPid: number;
  sampled: boolean;
  tracked: Map<number, ObservedProcess>;
}

class ProcessSnapshotError extends DeliveryError {}

export function processSnapshot(): Map<number, ObservedProcess> {
  const psPath = existsSync('/usr/bin/ps') ? '/usr/bin/ps' : '/bin/ps';
  const started = performance.now();
  const result = spawnSync(psPath, ['-A', '-o', 'pid=,ppid=,pgid=,rss=,stat=,lstart='], {
    encoding: 'utf8',
    // The absolute observer needs no author tokens, App keys or preload selectors.
    env: { LC_ALL: 'C' },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 1_000,
  });
  if (result.status !== 0 || result.error || result.signal || !result.stdout.endsWith('\n')) {
    const elapsedMs = Math.round(performance.now() - started);
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    let completeLines = 0;
    for (let index = 0; index < stdout.length; index++) if (stdout.charCodeAt(index) === 10) completeLines++;
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    const signal = result.signal;
    // Only fixed labels, bounded numbers and completeness flags leave this observation.
    const metadata = {
      status: Number.isSafeInteger(result.status) ? result.status : null,
      errorCode:
        code === undefined
          ? null
          : ['EACCES', 'EPERM', 'ETIMEDOUT', 'ENOENT', 'ENOBUFS', 'EAGAIN', 'ENOMEM', 'EIO', 'EINVAL'].includes(code)
            ? code
            : 'other',
      signal:
        signal === null
          ? null
          : ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGHUP', 'SIGQUIT', 'SIGPIPE'].includes(
                signal,
              )
            ? signal
            : 'other',
      stdoutPresent: typeof result.stdout === 'string',
      stdoutTerminated: typeof result.stdout === 'string' && result.stdout.endsWith('\n'),
      elapsedMs,
      stdoutBytes: Buffer.byteLength(stdout),
      completeLines,
    };
    throw new ProcessSnapshotError(`Owned process resource observation failed. ${JSON.stringify(metadata)}`);
  }
  const snapshot = new Map<number, ObservedProcess>();
  for (const line of result.stdout.trim().split('\n')) {
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u.exec(line.trim());
    if (!match) throw new DeliveryError('Owned process resource observation is ambiguous.');
    const observed = {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      rssBytes: Number(match[4]) * 1_024,
      status: match[5]!,
      identity: match[6]!,
    };
    if (
      !Number.isSafeInteger(observed.pid) ||
      observed.pid <= 0 ||
      !Number.isSafeInteger(observed.ppid) ||
      !Number.isSafeInteger(observed.pgid) ||
      !Number.isSafeInteger(observed.rssBytes) ||
      snapshot.has(observed.pid)
    )
      throw new DeliveryError('Owned process resource observation is ambiguous.');
    snapshot.set(observed.pid, observed);
  }
  return snapshot;
}

function observeOwnedProcesses(state: OwnedProcessState, snapshot: Map<number, ObservedProcess>): ObservedProcess[] {
  const root = snapshot.get(state.rootPid);
  if (state.rootIdentity === undefined) {
    if (root === undefined || root.status.startsWith('Z') || root.pgid !== state.rootPid) {
      throw new DeliveryError('Owned process identity could not be established before the command exited.');
    }
    state.rootIdentity = root.identity;
    state.tracked.set(root.pid, root);
  } else if (root !== undefined && root.identity !== state.rootIdentity) {
    throw new DeliveryError('Owned process identity changed during verification.');
  }
  const selected = new Map<number, ObservedProcess>();
  for (const [pid, previous] of state.tracked) {
    const current = snapshot.get(pid);
    if (current === undefined || current.status.startsWith('Z')) state.tracked.delete(pid);
    else if (current.identity !== previous.identity) {
      throw new DeliveryError('Tracked process identity changed during verification.');
    } else selected.set(pid, current);
  }
  for (const member of snapshot.values()) {
    if (!member.status.startsWith('Z') && member.pgid === state.rootPid) selected.set(member.pid, member);
  }
  const children = new Map<number, ObservedProcess[]>();
  for (const member of snapshot.values()) {
    const siblings = children.get(member.ppid) ?? [];
    siblings.push(member);
    children.set(member.ppid, siblings);
  }
  const pending = [...selected.values()];
  for (const parent of pending)
    for (const child of children.get(parent.pid) ?? []) {
      if (!child.status.startsWith('Z') && !selected.has(child.pid)) {
        selected.set(child.pid, child);
        pending.push(child);
      }
    }
  for (const member of selected.values()) state.tracked.set(member.pid, member);
  state.sampled = true;
  return [...selected.values()];
}

function sampleOwnedTree(
  state: OwnedProcessState,
  repoRoot: string,
  bounds: VerificationResourceBounds,
  controllerRssBytes = 0,
  includeControllerTree = false,
): void {
  const snapshot = processSnapshot();
  const owned = observeOwnedProcesses(state, snapshot);
  const controller = includeControllerTree
    ? controllerTreeRssBytes(snapshot, new Set(owned.map((member) => member.pid)))
    : controllerRssBytes;
  const rssBytes = owned.reduce((total, member) => total + member.rssBytes, controller);
  if (!Number.isSafeInteger(rssBytes))
    throw new DeliveryError('Owned aggregate RSS is outside the safe integer range.');
  if (rssBytes > bounds.maxAggregateRssBytes) {
    throw new DeliveryError(`Owned aggregate RSS ${rssBytes} exceeded limit ${bounds.maxAggregateRssBytes}.`);
  }
  const available = freeDiskBytes(repoRoot);
  if (available < bounds.minFreeDiskBytes)
    throw new DeliveryError(`Free disk fell below limit ${bounds.minFreeDiskBytes}.`);
}

/** Accounting includes the caller's tree; containment remains restricted to the recorded command. */
function controllerTreeRssBytes(snapshot = processSnapshot(), excluded = new Set<number>()): number {
  const controller = snapshot.get(process.pid);
  if (controller === undefined || controller.status.startsWith('Z'))
    throw new DeliveryError('Runtime setup controller resource observation is unavailable.');
  const selected = new Set([process.pid]);
  let bytes = process.memoryUsage().rss;
  for (const pid of selected)
    for (const member of snapshot.values())
      if (member.ppid === pid && !member.status.startsWith('Z') && !selected.has(member.pid)) {
        selected.add(member.pid);
        if (!excluded.has(member.pid)) bytes += member.rssBytes;
      }
  if (!Number.isSafeInteger(bytes)) throw new DeliveryError('Controller aggregate RSS observation overflowed.');
  return bytes;
}

export async function confirmOwnedCleanup(state: OwnedProcessState): Promise<void> {
  if (!state.sampled || state.rootIdentity === undefined) {
    throw new DeliveryError('Owned process cleanup cannot be verified without a root identity.');
  }
  const deadline = Date.now() + 2_000;
  for (;;) {
    const snapshot = processSnapshot();
    const root = snapshot.get(state.rootPid);
    if (root !== undefined && root.identity !== state.rootIdentity) {
      throw new DeliveryError('Owned process group identity changed before cleanup readback.');
    }
    const groupAlive = [...snapshot.values()].some(
      (member) => member.pgid === state.rootPid && !member.status.startsWith('Z'),
    );
    const trackedAlive = [...state.tracked.values()].some((previous) => {
      const current = snapshot.get(previous.pid);
      if (current === undefined || current.status.startsWith('Z')) return false;
      if (current.identity !== previous.identity)
        throw new DeliveryError('Tracked process identity changed before cleanup readback.');
      return true;
    });
    if (!groupAlive && !trackedAlive) return;
    if (Date.now() >= deadline) throw new DeliveryError('Owned process cleanup did not release every sampled process.');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Signal only birth identities established by this command, including observed detached children. */
export function terminateOwnedProcesses(state: OwnedProcessState): void {
  if (!state.sampled || state.rootIdentity === undefined) throw new DeliveryError('Owned process identity is unknown.');
  const snapshot = processSnapshot();
  const root = snapshot.get(state.rootPid);
  if (root !== undefined && root.identity !== state.rootIdentity)
    throw new DeliveryError('Owned process group identity changed before cleanup.');
  const alive = [...state.tracked.values()].flatMap((previous) => {
    const current = snapshot.get(previous.pid);
    if (current === undefined || current.status.startsWith('Z')) return [];
    if (current.identity !== previous.identity)
      throw new DeliveryError('Tracked process identity changed before cleanup.');
    return [current];
  });
  const group = [...snapshot.values()].filter(
    (member) => member.pgid === state.rootPid && !member.status.startsWith('Z'),
  );
  if (group.length > 0 && !alive.some((member) => member.pgid === state.rootPid))
    throw new DeliveryError('Owned process group has no surviving recorded identity; cleanup is ambiguous.');
  const signal = (pid: number): void => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return;
      if (code !== 'EPERM') throw error;
      // macOS can return EPERM when the last group member exits after our snapshot.
      // Accept only fresh absence/zombie proof; a live target remains a cleanup failure.
      const readback = processSnapshot();
      if (pid < 0) {
        const currentRoot = readback.get(state.rootPid);
        if (currentRoot !== undefined && currentRoot.identity !== state.rootIdentity)
          throw new DeliveryError('Owned process group identity changed during cleanup signal readback.');
        if ([...readback.values()].some((member) => member.pgid === state.rootPid && !member.status.startsWith('Z')))
          throw error;
      } else {
        const current = readback.get(pid);
        if (current !== undefined && current.identity !== state.tracked.get(pid)?.identity)
          throw new DeliveryError('Tracked process identity changed during cleanup signal readback.');
        if (current !== undefined && !current.status.startsWith('Z')) throw error;
      }
    }
  };
  if (group.length > 0) signal(-state.rootPid);
  for (const member of alive.reverse()) signal(member.pid);
}

interface VerificationWriter {
  starting(): void;
  observed(state: OwnedProcessState): void;
  idle(): void;
  assertQuiescent(): void;
}

function producerContent(root: string) {
  const code: { path: string; digest: string }[] = [];
  const collect = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.test.js'))
        code.push({ path: path.slice(root.length + 1), digest: digestBytes(readFileSync(path)) });
    }
  };
  collect(root);
  const dependencies = new Map<string, string>();
  const collectDependencies = (manifestPath: string): void => {
    if (dependencies.has(manifestPath)) return;
    const bytes = readFileSync(manifestPath);
    const manifest = z
      .object({ dependencies: z.record(z.string(), z.string()).optional() })
      .parse(JSON.parse(bytes.toString('utf8')));
    dependencies.set(manifestPath, digestBytes(bytes));
    const require = createRequire(manifestPath);
    for (const name of Object.keys(manifest.dependencies ?? {}).sort()) {
      let resolved: string;
      try {
        resolved = require.resolve(`${name}/package.json`);
      } catch {
        try {
          resolved = require.resolve(name);
        } catch (error) {
          if (!types.isNativeError(error) || Reflect.get(error, 'code') !== 'ERR_PACKAGE_PATH_NOT_EXPORTED')
            throw error;
          const manifest = findPackageJSON(name, manifestPath);
          if (!manifest) throw error;
          resolved = manifest;
        }
      }
      let directory = dirname(resolved);
      for (;;) {
        const path = join(directory, 'package.json');
        if (existsSync(path)) {
          const candidate = z.object({ name: z.string().optional() }).parse(JSON.parse(readFileSync(path, 'utf8')));
          if (candidate.name === name) {
            collectDependencies(path);
            break;
          }
        }
        const parent = dirname(directory);
        if (parent === directory) throw new DeliveryError(`Producer dependency identity is unavailable for ${name}.`);
        directory = parent;
      }
    }
  };
  collectDependencies(join(dirname(root), 'package.json'));
  return { code, dependencies: [...dependencies].sort(([a], [b]) => a.localeCompare(b)) };
}

function producerDigest(root = dirname(fileURLToPath(import.meta.url))): string {
  return digestValue(producerContent(root));
}

/** @internal Retained public code is hashed as data; it is never imported or executed. */
export function retainedWorktreeTransitionProducerDigest(distDirectory: string): string {
  return producerDigest(realpathSync(distDirectory));
}

function writeCommandOutput(bytes: Buffer, commonDir: string): string {
  const digest = digestBytes(bytes);
  const path = join(commonDir, 'ai-delivery', 'verification@1', 'command-output', `${digest.slice(7)}.bin`);
  writeCreateOnly(path, bytes, digest);
  return digest;
}

export function runStageCommand(
  repoRoot: string,
  argv: readonly string[],
  abortSignal?: AbortSignal,
  resourceBounds?: VerificationResourceBounds,
  writer?: VerificationWriter,
  execution?: {
    environment: NodeJS.ProcessEnv;
    cwd?: string;
    maxCapturedOutputBytes?: number;
    includeControllerTree?: boolean;
    onCaptured?(bytes: number): void;
    onCleanupFailure?(reason: string): void;
    failedOutput?(bytes: Buffer): string;
    stdoutOnly?: boolean;
  },
): Promise<Buffer> {
  const [executable, ...args] = argv;
  if (!executable) throw new DeliveryError('Policy selected an empty stage command.');
  if (abortSignal?.aborted) throw new DeliveryError('Selected policy stage command cancelled.');
  writer?.starting();
  return new Promise((resolve, reject) => {
    // The shell waits for our ownership receipt, then exec preserves its PID, birth identity and process group.
    const child = spawn(
      '/bin/sh',
      [
        '-c',
        'IFS= read -r ready || exit 125; [ "$ready" = run ] || exit 125; exec "$@" </dev/null',
        'ai-delivery-command',
        executable,
        ...args,
      ],
      {
        cwd: execution?.cwd ?? repoRoot,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(execution === undefined ? {} : { env: execution.environment }),
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const owned: OwnedProcessState | undefined =
      process.platform === 'win32' || child.pid === undefined
        ? undefined
        : { rootPid: child.pid, sampled: false, tracked: new Map() };
    let outputBytes = 0;
    let retainedOutputBytes = 0;
    const outputLimit = execution?.maxCapturedOutputBytes ?? 8 * 1024 * 1024;
    let failure: string | undefined;
    let cleanupFailure: string | undefined;
    let writerFailure: string | undefined;
    let closed = false;
    let settled = false;
    let commandReleased = false;
    const failedOutput = (): string => {
      try {
        const bytes = Buffer.concat([...stdout, ...stderr]);
        if (execution?.failedOutput) return execution.failedOutput(bytes);
        return ` Command output ${writeCommandOutput(bytes, gitCommonDir(repoRoot))}.`;
      } catch (error) {
        return ` Command output persistence failed (${error instanceof Error ? error.message : String(error)}).`;
      }
    };
    let closeTimer: NodeJS.Timeout | undefined;
    let exitPipeTimer: NodeJS.Timeout | undefined;
    let resourceTimer: NodeJS.Timeout | undefined;
    const clearWatchers = (): void => {
      if (resourceTimer !== undefined) clearInterval(resourceTimer);
      if (closeTimer !== undefined) clearTimeout(closeTimer);
      if (exitPipeTimer !== undefined) clearTimeout(exitPipeTimer);
      abortSignal?.removeEventListener('abort', onAbort);
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    };
    const killOwned = (): void => {
      if (child.pid === undefined) return;
      if (owned?.sampled) {
        try {
          observeOwnedProcesses(owned, processSnapshot());
        } catch (error) {
          cleanupFailure ??= error instanceof Error ? error.message : String(error);
        }
        try {
          writer?.observed(owned);
        } catch (error) {
          writerFailure ??= error instanceof Error ? error.message : String(error);
        }
        // Durable state failure cannot prevent identity-checked termination of known-owned processes.
        try {
          terminateOwnedProcesses(owned);
        } catch (error) {
          cleanupFailure ??= error instanceof Error ? error.message : String(error);
        }
      } else {
        try {
          // The still-owned direct child is the only safe signal target before identity observation.
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          if (commandReleased) cleanupFailure ??= 'owned process identity was not observed before cleanup';
        } catch (error) {
          cleanupFailure ??= error instanceof Error ? error.message : String(error);
        }
      }
    };
    const stop = (reason: string): void => {
      if (failure !== undefined) return;
      failure = reason;
      killOwned();
      if (!closed) {
        closeTimer = setTimeout(() => {
          if (settled || closed) return;
          settled = true;
          clearWatchers();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          execution?.onCleanupFailure?.('Owned command pipes did not close; descendant cleanup could not be verified.');
          reject(
            new DeliveryError(
              `Selected policy stage command failed (${failure}).${failedOutput()}${writerFailure === undefined ? '' : ` Writer state persistence failed (${writerFailure}).`} Owned process cleanup failed (owned command pipes did not close; descendant cleanup could not be verified).`,
            ),
          );
        }, 2_000);
      }
    };
    const capture = (chunks: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      execution?.onCaptured?.(outputBytes);
      if (
        execution !== undefined &&
        resourceBounds?.maxNewOutputBytes !== undefined &&
        outputBytes > resourceBounds.maxNewOutputBytes
      ) {
        stop('source-phase captured output exceeded remaining cumulative allowance');
        return;
      }
      if (outputBytes > outputLimit) {
        const remaining = outputLimit - retainedOutputBytes;
        if (remaining > 0) {
          chunks.push(Buffer.from(chunk.subarray(0, remaining)));
          retainedOutputBytes += Math.min(remaining, chunk.length);
        }
        stop(
          execution?.maxCapturedOutputBytes === undefined
            ? 'captured output exceeded 8 MiB'
            : `captured output exceeded ${outputLimit} bytes`,
        );
        return;
      }
      chunks.push(chunk);
      retainedOutputBytes += chunk.length;
    };
    child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk));
    child.stdout.once('error', (error) => stop(error.message));
    child.stderr.once('error', (error) => stop(error.message));
    child.stdin.once('error', (error) => stop(error.message));
    child.once('error', (error) => {
      if (child.pid === undefined) writer?.idle();
      stop(error.message);
    });
    child.once('exit', (code, signal) => {
      if (code !== 0 || signal !== null) stop(`exit ${String(code)}${signal === null ? '' : ` signal ${signal}`}`);
      else if (!closed) {
        exitPipeTimer = setTimeout(() => {
          if (!closed) stop('owned command pipes did not close after direct child exit');
        }, 1_000);
      }
    });
    child.once('spawn', () => {
      const sample = (): void => {
        if (failure !== undefined || child.pid === undefined) return;
        try {
          if (owned === undefined) throw new DeliveryError('Owned process identity is unavailable on this platform.');
          observeOwnedProcesses(owned, processSnapshot());
          writer?.observed(owned);
          if (resourceBounds !== undefined)
            sampleOwnedTree(
              owned,
              repoRoot,
              resourceBounds,
              execution === undefined ? 0 : process.memoryUsage().rss,
              execution?.includeControllerTree,
            );
          if (!closed && failure === undefined && !commandReleased) {
            commandReleased = true;
            child.stdin.end('run\n');
          }
        } catch (error) {
          stop(error instanceof Error ? error.message : String(error));
        }
      };
      sample();
      resourceTimer = setInterval(sample, 1_000);
      resourceTimer.unref();
    });
    const onAbort = (): void => stop('cancelled');
    const onSigint = (): void => stop('cancelled by SIGINT');
    const onSigterm = (): void => stop('cancelled by SIGTERM');
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    if (abortSignal?.aborted) onAbort();
    const handleClose = async (code: number | null, signal: NodeJS.Signals | null): Promise<void> => {
      closed = true;
      if (settled) return;
      if (failure === undefined && owned !== undefined) {
        try {
          if (resourceBounds !== undefined)
            sampleOwnedTree(
              owned,
              repoRoot,
              resourceBounds,
              execution === undefined ? 0 : process.memoryUsage().rss,
              execution?.includeControllerTree,
            );
          if (!owned.sampled) throw new DeliveryError('Owned process resource observation was unavailable.');
          const remaining = observeOwnedProcesses(owned, processSnapshot());
          if (remaining.length > 0) throw new DeliveryError('A sampled owned descendant survived command exit.');
        } catch (error) {
          stop(error instanceof Error ? error.message : String(error));
        }
      }
      if (failure !== undefined || code !== 0 || signal !== null) {
        const reason = failure ?? `exit ${String(code)}${signal === null ? '' : ` signal ${signal}`}`;
        let cleanupConfirmed = child.pid === undefined || !commandReleased;
        if (owned !== undefined && owned.sampled) {
          try {
            await confirmOwnedCleanup(owned);
            cleanupConfirmed = true;
          } catch (error) {
            cleanupFailure ??= error instanceof Error ? error.message : String(error);
          }
        }
        if (cleanupConfirmed) {
          try {
            writer?.idle();
          } catch (error) {
            writerFailure ??= error instanceof Error ? error.message : String(error);
          }
        }
        settled = true;
        if (cleanupFailure !== undefined) execution?.onCleanupFailure?.(cleanupFailure);
        reject(
          new DeliveryError(
            `Selected policy stage command failed (${reason}). Command exit ${String(code)}${signal === null ? '' : ` signal ${signal}`}.${failedOutput()}${writerFailure === undefined ? '' : ` Writer state persistence failed (${writerFailure}).`}${cleanupFailure === undefined ? '' : ` Owned process cleanup failed (${cleanupFailure}).`}`,
          ),
        );
        return;
      }
      writer?.idle();
      settled = true;
      resolve(execution?.stdoutOnly ? Buffer.concat(stdout) : Buffer.concat([...stdout, ...stderr], outputBytes));
    };
    child.once('close', (code, signal) => {
      void handleClose(code, signal)
        .catch((error: unknown) => {
          settled = true;
          reject(error);
        })
        .finally(clearWatchers);
    });
  });
}
