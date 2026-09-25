import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { z } from 'zod';

export const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const ShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);
export const RepositorySchema = z.string().regex(/^[^/\s]+\/[^/\s]+$/u);
export const StageIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/u);
export const CoordinateSchema = z.object({ sha: ShaSchema, tree: ShaSchema }).strict();
export type Coordinate = z.infer<typeof CoordinateSchema>;

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Delivery evidence contains an unsupported value.');
  return encoded;
}

export function digestValue(value: unknown): `sha256:${string}` {
  return digestBytes(Buffer.from(stableJson(value), 'utf8'));
}

export function digestBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function isUniqueSorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

export function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function assertExactRange(input: {
  repoRoot: string;
  base: Coordinate;
  head: Coordinate;
  changedPaths: readonly string[];
}): void {
  const { repoRoot, base, head, changedPaths } = input;
  CoordinateSchema.parse(base);
  CoordinateSchema.parse(head);
  if (!isUniqueSorted(changedPaths) || (base.sha !== head.sha && changedPaths.length === 0))
    throw new Error('Exact Git range requires complete sorted changed paths.');
  if (
    git(repoRoot, ['rev-parse', 'HEAD']) !== head.sha ||
    git(repoRoot, ['rev-parse', `${base.sha}^{tree}`]) !== base.tree ||
    git(repoRoot, ['rev-parse', `${head.sha}^{tree}`]) !== head.tree ||
    git(repoRoot, ['status', '--porcelain', '--untracked-files=all']) !== ''
  )
    throw new Error('Repository delivery requires exact clean Git source coordinates.');
  const actual = git(repoRoot, ['diff', '--name-only', '-z', base.sha, head.sha]).split('\0').filter(Boolean).sort();
  if (stableJson(actual) !== stableJson(changedPaths))
    throw new Error('Changed paths do not match the exact Git range.');
}

export function resolveRepositoryFile(repoRoot: string, sourcePath: string): string {
  const root = realpathSync(repoRoot);
  if (isAbsolute(sourcePath) || sourcePath === '' || sourcePath.includes('\0'))
    throw new Error('Repository file path must be relative.');
  const path = resolve(root, sourcePath);
  const relativePath = relative(root, path);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || relativePath === '')
    throw new Error('Repository file escapes its root.');
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || realpathSync(path) !== path)
    throw new Error('Repository file must be one regular file beneath the root.');
  return path;
}

export function assertArtifact(repoRoot: string, artifact: { digest: string; path: string }): void {
  DigestSchema.parse(artifact.digest);
  const path = resolveRepositoryFile(repoRoot, artifact.path);
  if (digestBytes(readFileSync(path)) !== artifact.digest)
    throw new Error(`Repository artifact is corrupt: ${artifact.path}`);
}

export function assertPrivateFile(path: string): Buffer {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600)
    throw new Error('Delivery evidence must be a private regular file.');
  return readFileSync(path);
}

export function writeCreateOnly(path: string, bytes: Buffer): string {
  try {
    if (!assertPrivateFile(path).equals(bytes)) throw new Error('Content addressed evidence path collision.');
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !assertPrivateFile(path).equals(bytes)) throw error;
  } finally {
    unlinkSync(temporary);
  }
  if (!assertPrivateFile(path).equals(bytes)) throw new Error('Content addressed evidence write failed.');
  return path;
}
