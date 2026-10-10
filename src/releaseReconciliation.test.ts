import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { Script } from 'node:vm';
import { test } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const scripts = [...workflow.matchAll(/node --input-type=module <<'JS'\n([\s\S]*?)\n\s+JS/gu)];
const publishedScript = scripts.at(-1)?.[1];
assert.ok(publishedScript, 'The actual release workflow must contain its publication script.');
// Substitute only external imports; all publication decisions and guards execute unchanged.
const program = publishedScript.replace(/^\s*import .+;\n/gmu, '');
const archive = Buffer.from('independently reviewed synthetic archive');
const digest = createHash('sha256').update(archive).digest('hex');
const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
const source = 'a'.repeat(40);
const registry = 'https://registry.npmjs.org';
const packageUrl = `${registry}/@aviaratech%2fai-delivery`;
const version = '0.8.1';
const archivePath = posix.resolve('/synthetic/package-artifact', `aviaratech-ai-delivery-${version}.tgz`);
const pkg = {
  name: '@aviaratech/ai-delivery',
  version,
  private: false,
  license: 'MIT',
  repository: { url: 'git+https://github.com/aviaratech/ai-delivery.git' },
};
const manifest = {
  name: pkg.name,
  version,
  dist: {
    integrity,
    tarball: `${registry}/@aviaratech/ai-delivery/-/ai-delivery-${version}.tgz`,
    attestations: { provenance: { predicateType: 'https://slsa.dev/provenance/v1' } },
  },
};

type Fixture = {
  occupied?: boolean;
  versionReadyAt?: number;
  archiveReadyAt?: number;
  provenanceReadyAt?: number;
  indexReadyAt?: number;
  latestReadyAt?: number;
  corruptArchive?: boolean;
  publishStatus?: number | null;
  conflict?: 'name' | 'version' | 'integrity' | 'provenance' | 'origin' | 'credentials' | 'index' | 'latest' | 'main';
  errorPhase?: 'main' | 'version' | 'index' | 'archive';
  errorStatus?: number;
  networkFailure?: boolean;
  oversizedManifest?: boolean;
  fetchDurationMs?: number;
  bodyDeadlineExceeded?: boolean;
};

async function runRelease(fixture: Fixture = {}) {
  let publications = 0;
  let reads = 0;
  let elapsed = 0;
  const requests: { url: string; method: string; at: number }[] = [];
  const commands: { command: string; args: string[] }[] = [];
  const waits: number[] = [];
  const timeouts: number[] = [];
  const messages: string[] = [];
  const ready = (at = 1) => reads >= at;
  const published = () => fixture.occupied || publications > 0;
  const visibleManifest = (indexed = false) => {
    const value = structuredClone(manifest);
    if (!ready(fixture.provenanceReadyAt)) Reflect.deleteProperty(value.dist, 'attestations');
    if (fixture.conflict === 'name') value.name = '@someone/else';
    if (fixture.conflict === 'version') value.version = '0.8.0';
    if (fixture.conflict === 'integrity' || (indexed && fixture.conflict === 'index'))
      value.dist.integrity = 'sha512-conflicting';
    if (fixture.conflict === 'provenance')
      value.dist.attestations = { provenance: { predicateType: 'https://unexpected.example/predicate' } };
    if (fixture.conflict === 'origin') value.dist.tarball = 'https://unexpected.example/archive.tgz';
    if (fixture.conflict === 'credentials') {
      const tarball = new URL('/archive.tgz', registry);
      tarball.username = 'user';
      tarball.password = 'password';
      value.dist.tarball = tarball.href;
    }
    return value;
  };
  const fetch = async (input: string | URL, options: RequestInit = {}) => {
    const url = String(input);
    requests.push({ url, method: options.method ?? 'GET', at: elapsed });
    assert.equal(options.redirect, 'error');
    elapsed += fixture.fetchDurationMs ?? 100;
    const phase = url.includes('api.github.com')
      ? 'main'
      : url === packageUrl
        ? 'index'
        : url === `${packageUrl}/${version}`
          ? 'version'
          : 'archive';
    if (phase === fixture.errorPhase && (published() || phase === 'main')) {
      if (fixture.networkFailure) throw new Error('synthetic network failure');
      return new Response(null, { status: fixture.errorStatus ?? 503 });
    }
    if (url === 'https://api.github.com/repos/aviaratech/ai-delivery/branches/main') {
      return Response.json({
        name: 'main',
        protected: true,
        commit: { sha: fixture.conflict === 'main' ? 'b'.repeat(40) : source },
        protection: { required_status_checks: { enforcement_level: 'everyone', contexts: ['checks', 'secrets'] } },
      });
    }
    if (url === `${packageUrl}/${version}`) {
      if (published()) reads++;
      return published() && ready(fixture.versionReadyAt)
        ? fixture.oversizedManifest
          ? new Response('x'.repeat(4 * 1024 * 1024 + 1))
          : Response.json(visibleManifest())
        : new Response(null, { status: 404 });
    }
    if (url === manifest.dist.tarball) {
      if (fixture.bodyDeadlineExceeded) {
        return new Response(
          new ReadableStream({
            start: (controller) => {
              elapsed += 5 * 60_000;
              controller.error(new DOMException('Readback body timed out', 'TimeoutError'));
            },
          }),
        );
      }
      return ready(fixture.archiveReadyAt)
        ? new Response(fixture.corruptArchive ? Buffer.from('conflicting registry bytes') : archive)
        : new Response(null, { status: 404 });
    }
    if (url === packageUrl) {
      return Response.json({
        name: pkg.name,
        'dist-tags': {
          latest:
            published() && fixture.conflict === 'latest'
              ? '0.8.2'
              : published() && ready(fixture.latestReadyAt)
                ? version
                : '0.8.0',
        },
        versions: published() && ready(fixture.indexReadyAt) ? { [version]: visibleManifest(true) } : {},
      });
    }
    throw new Error(`Unexpected external request: ${url}`);
  };
  const context = {
    createHash,
    resolve: (path: string) => posix.resolve('/synthetic/package-artifact/unpacked/package', path),
    readFileSync: (path: string) => {
      assert.equal(path, archivePath);
      return archive;
    },
    spawnSync: (command: string, args: string[]) => {
      commands.push({ command, args: [...args] });
      assert.equal(command, 'npm');
      assert.equal(args[0], 'publish');
      assert.equal(args[1], archivePath);
      publications++;
      return { status: fixture.publishStatus === undefined ? 0 : fixture.publishStatus };
    },
    pkg,
    process: {
      env: {
        GITHUB_SHA: source,
        REVIEWED_SOURCE_SHA: source,
        RELEASE_VERSION: version,
        REVIEWED_ARCHIVE_SHA256: digest,
        GH_TOKEN: 'synthetic',
      },
    },
    fetch,
    AbortSignal: {
      timeout: (ms: number) => {
        timeouts.push(ms);
        return new AbortController().signal;
      },
    },
    URL,
    Buffer,
    performance: { now: () => elapsed },
    console: {
      log: (message: unknown) => {
        messages.push(String(message));
      },
    },
    setTimeout: (callback: () => void, ms: number) => {
      waits.push(ms);
      elapsed += ms;
      queueMicrotask(callback);
      return 0;
    },
  };
  let error: string | null = null;
  try {
    await (new Script(`(async () => {${program}\n})()`).runInNewContext(context) as Promise<void>);
  } catch (failure) {
    error = String(failure);
  }
  return { error, publications, requests, commands, waits, timeouts, messages, elapsed, reads };
}

test('successful publication reconciles staggered registry visibility without another npm invocation', async () => {
  const result = await runRelease({
    versionReadyAt: 2,
    archiveReadyAt: 3,
    provenanceReadyAt: 4,
    indexReadyAt: 5,
    latestReadyAt: 6,
  });
  assert.equal(result.error, null);
  assert.equal(result.publications, 1);
  assert.equal(result.commands.length, 1);
  assert.deepEqual(result.commands[0]?.args, [
    'publish',
    archivePath,
    '--ignore-scripts',
    '--access',
    'public',
    '--tag',
    'latest',
    '--registry',
    registry,
    '--provenance',
  ]);
  assert.ok(result.waits.length > 0, 'Stale reads must be paced.');
  assert.ok(result.waits.every((ms) => ms > 0));
  assert.ok(result.requests.every((request) => request.method === 'GET'));
  assert.ok(result.timeouts.every((ms) => ms > 0 && ms <= 30_000));
  assert.ok(result.messages.some((message) => /exact reviewed registry/iu.test(message)));
});

test('matching occupied release reconciles latest without publication or retag', async () => {
  const result = await runRelease({ occupied: true, latestReadyAt: 3 });
  assert.equal(result.error, null);
  assert.equal(result.publications, 0);
  assert.deepEqual(result.commands, []);
  assert.ok(result.messages.some((message) => /no publication repeated/iu.test(message)));
});

test('conflicting archive bytes fail immediately after one publication', async () => {
  const result = await runRelease({ corruptArchive: true });
  assert.match(result.error ?? '', /archive differs/iu);
  assert.equal(result.publications, 1);
  assert.deepEqual(result.waits, []);
});

test('unresolved visibility reports the external reconciliation bound without republishing', async () => {
  const result = await runRelease({ versionReadyAt: Infinity });
  assert.match(result.error ?? '', /reconciliation unresolved/iu);
  assert.equal(result.publications, 1);
  assert.ok(result.waits.length > 0);
  assert.ok(result.elapsed < 10 * 60_000, 'Reconciliation must fit the existing external publish job.');
  assert.ok(
    result.timeouts.some((ms) => ms < 30_000),
    'Requests must respect the remaining reconciliation allowance.',
  );
});

test('an occupied version visible only in the index never enters publication', async () => {
  const result = await runRelease({ occupied: true, versionReadyAt: 3, latestReadyAt: 4 });
  assert.equal(result.error, null);
  assert.deepEqual(result.commands, []);
  assert.ok(result.waits.length > 0);
});

for (const conflict of [
  'name',
  'version',
  'integrity',
  'provenance',
  'origin',
  'credentials',
  'index',
  'latest',
] as const) {
  test(`present ${conflict} conflict is refused without another publication`, async () => {
    const result = await runRelease({ conflict });
    assert.match(result.error ?? '', /differs|unexpected|advanced/iu);
    assert.equal(result.publications, 1);
    // The package index is initially absent; its conflict is observed on the second read.
    if (conflict !== 'index') assert.deepEqual(result.waits, []);
    else assert.equal(result.waits.length, 1);
  });
}

for (const errorPhase of ['version', 'index', 'archive'] as const) {
  for (const errorStatus of [401, 403, 429, 503]) {
    test(`${errorPhase} HTTP ${errorStatus} remains a permanent failure`, async () => {
      const result = await runRelease({ errorPhase, errorStatus });
      assert.match(result.error ?? '', new RegExp(`readback failed: ${errorStatus}`, 'u'));
      assert.equal(result.publications, 1);
      assert.deepEqual(result.waits, []);
    });
  }
}

test('network failure is not retried as propagation', async () => {
  const result = await runRelease({ errorPhase: 'version', networkFailure: true });
  assert.match(result.error ?? '', /synthetic network failure/u);
  assert.equal(result.publications, 1);
  assert.deepEqual(result.waits, []);
});

for (const publishStatus of [1, null]) {
  test(`publish status ${publishStatus} remains ambiguous after matching readback`, async () => {
    const result = await runRelease({ publishStatus, versionReadyAt: 3 });
    assert.match(result.error ?? '', /failed or was ambiguous/iu);
    assert.equal(result.publications, 1);
    assert.ok(result.messages.some((message) => message.includes(`"status":${publishStatus}`)));
    assert.ok(result.messages.some((message) => /exact reviewed registry/iu.test(message)));
  });
}

test('an occupied conflicting release is never republished', async () => {
  const result = await runRelease({ occupied: true, conflict: 'integrity' });
  assert.match(result.error ?? '', /integrity differs/iu);
  assert.deepEqual(result.commands, []);
});

test('protected source drift refuses publication', async () => {
  const result = await runRelease({ conflict: 'main' });
  assert.match(result.error ?? '', /protected main.*drifted/iu);
  assert.deepEqual(result.commands, []);
});

test('oversized registry metadata fails within the readback output bound', async () => {
  const result = await runRelease({ oversizedManifest: true });
  assert.match(result.error ?? '', /readback bound/iu);
  assert.equal(result.publications, 1);
  assert.deepEqual(result.waits, []);
});

test('a body timeout at the reconciliation bound retains an explicit unresolved result', async () => {
  const result = await runRelease({ bodyDeadlineExceeded: true });
  assert.match(result.error ?? '', /reconciliation unresolved/iu);
  assert.equal(result.publications, 1);
});

for (const phase of ['archiveReadyAt', 'provenanceReadyAt', 'indexReadyAt', 'latestReadyAt'] as const) {
  test(`unresolved ${phase} cannot be accepted as a completed release`, async () => {
    const result = await runRelease({ [phase]: Infinity });
    assert.match(result.error ?? '', /reconciliation unresolved/iu);
    assert.equal(result.publications, 1);
  });
}
