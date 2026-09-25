import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Create a private directory hierarchy and durably publish every new directory entry. */
export function ensurePrivateDirectoryDurably(path: string): void {
  ensureDirectoryDurably(path, 0o700);
}

/** Publish a complete JSON file with a same-directory durable rename. */
export function writeJsonFileAtomically(path: string, value: unknown): void {
  writeJsonAtomically({ directoryMode: 0o777, mode: 0o666, path, value });
}

/** Publish private JSON evidence with the same durable rename contract. */
export function writePrivateJsonFileAtomically(path: string, value: unknown): void {
  writeJsonAtomically({ directoryMode: 0o700, mode: 0o600, path, value });
}

function ensureDirectoryDurably(directory: string, mode: number): void {
  const missing: string[] = [];
  let candidate = directory;
  while (!existsSync(candidate)) {
    missing.push(candidate);
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  for (const path of missing.reverse()) {
    mkdirSync(path, { mode });
    fsyncDirectory(dirname(path));
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeJsonAtomically({
  directoryMode,
  mode,
  path,
  value,
}: {
  directoryMode: number;
  mode: number;
  path: string;
  value: unknown;
}): void {
  const directory = dirname(path);
  ensureDirectoryDurably(directory, directoryMode);
  const temporaryPath = join(directory, `.${String(process.pid)}.${randomUUID()}.tmp`);
  let creationDescriptor: number | undefined;
  let fileDescriptor: number | undefined;
  let directoryDescriptor: number | undefined;
  try {
    creationDescriptor = openSync(temporaryPath, 'wx', mode);
    closeSync(creationDescriptor);
    creationDescriptor = undefined;
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fileDescriptor = openSync(temporaryPath, 'r');
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = undefined;
    renameSync(temporaryPath, path);
    directoryDescriptor = openSync(directory, 'r');
    fsyncSync(directoryDescriptor);
    closeSync(directoryDescriptor);
    directoryDescriptor = undefined;
  } catch (error: unknown) {
    if (creationDescriptor !== undefined) closeSync(creationDescriptor);
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
    if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file was never created or has already been renamed.
    }
    throw error;
  }
}
