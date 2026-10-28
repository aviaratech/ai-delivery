import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const LIMIT = 65_536;
const DECLARED = 'file:reviewed-archive.tgz';
const PACKAGE = 'node_modules/@aviaratech/ai-delivery';
type State = 'valid' | 'missing' | 'unsafe' | 'oversized' | 'invalid';
type Json = Record<string, unknown>;

function object(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
}

function parseBuffer(bytes: Buffer): { state: State; value?: Json } {
  if (bytes.length > LIMIT) return { state: 'oversized' };
  try {
    const value = object(JSON.parse(bytes.toString('utf8')));
    return value ? { state: 'valid', value } : { state: 'invalid' };
  } catch {
    return { state: 'invalid' };
  }
}

function read(path: string): { state: State; value?: Json } {
  let fd: number | undefined;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || realpathSync(path) !== path) throw 0;
    if (before.size > LIMIT) return { state: 'oversized' };
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1)
      throw 0;
    const bytes = Buffer.alloc(before.size + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd),
      named = lstatSync(path);
    if (
      after.size !== before.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      named.dev !== before.dev ||
      named.ino !== before.ino ||
      count !== before.size ||
      realpathSync(path) !== path
    )
      throw 0;
    return parseBuffer(bytes.subarray(0, count));
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unsafe' };
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {
        /* Diagnostic cleanup cannot replace the assertion. */
      }
  }
}

function kind(value: unknown): string {
  if (value === undefined) return 'missing';
  if (typeof value !== 'string') return 'non-string';
  if (!value.startsWith('file:')) return 'other';
  return isAbsolute(value.slice(5)) ? 'absolute-file' : 'relative-file';
}
function facts(value: unknown, expected: string, actual: unknown): Json {
  return {
    present: value !== undefined,
    kind: kind(value),
    matchesDeclared: value === DECLARED,
    matchesExpected: typeof value === 'string' && value === expected,
    matchesActual: typeof value === 'string' && typeof actual === 'string' && value === actual,
  };
}

export function withResolvedClosureDiagnostic(
  input: { runtimeDirectory: string; fixtureRoot: string; rootPackage: Buffer; rootLock: Buffer; actual: unknown },
  assertion: () => void,
  emit: (line: string) => void = (line) => process.stdout.write(line),
): void {
  try {
    assertion();
    return;
  } catch (failure) {
    try {
      const expected = `file:${join(input.runtimeDirectory, 'reviewed-archive.tgz')}`;
      const pkgRecord = parseBuffer(input.rootPackage);
      const lockRecord = parseBuffer(input.rootLock);
      const lockPackages = object(lockRecord.value?.packages);
      const rootDependencies = object(object(lockPackages?.[''])?.dependencies);
      const lockTarget = object(lockPackages?.[PACKAGE]);
      const hidden = read(join(input.runtimeDirectory, 'node_modules/.package-lock.json'));
      const installed = read(join(input.runtimeDirectory, PACKAGE, 'package.json'));
      const hiddenTarget = object(object(hidden.value?.packages)?.[PACKAGE]);
      const receipt = {
        schemaVersion: 'ai-delivery.resolved-closure-origin@1',
        observationOnly: true,
        root: {
          previouslyCaptured: true,
          packageState: pkgRecord.state,
          lockState: lockRecord.state,
          declaredMatches: object(pkgRecord.value?.dependencies)?.['@aviaratech/ai-delivery'] === DECLARED,
          lockEdgeMatches: rootDependencies?.['@aviaratech/ai-delivery'] === DECLARED,
          lockResolved: facts(lockTarget?.resolved, expected, input.actual),
        },
        actual: { kind: kind(input.actual), matchesExpected: input.actual === expected },
        hidden: { state: hidden.state, resolved: facts(hiddenTarget?.resolved, expected, input.actual) },
        installed: {
          state: installed.state,
          resolved: facts(installed.value?._resolved, expected, input.actual),
          wherePresent: installed.value?._where !== undefined,
          whereKind: typeof installed.value?._where,
          whereEqualsRuntime: installed.value?._where === input.runtimeDirectory,
          whereEqualsFixture: installed.value?._where === input.fixtureRoot,
        },
      };
      const line = `RESOLVED_CLOSURE_ORIGIN_RECEIPT ${JSON.stringify(receipt)}\n`;
      if (Buffer.byteLength(line) <= 2048) emit(line);
    } catch {
      /* Reporting failures never replace the original assertion. */
    }
    throw failure;
  }
}
