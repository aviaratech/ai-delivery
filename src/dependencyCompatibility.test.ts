import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SourceMapConsumer, SourceMapGenerator, SourceNode, type RawSourceMap } from 'source-map-js';
import { test, vi } from 'vitest';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const sourceMapPackage = JSON.parse(readFileSync(require.resolve('source-map-js/package.json'), 'utf8')) as {
  version: string;
};
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')) as {
  packages: Record<string, { version: string }>;
};
assert.equal(
  sourceMapPackage.version,
  lock.packages['node_modules/source-map-js']?.version,
  'A stale dependency installation must not skip the selected lockfile regressions.',
);
const version = /^(\d+)\.(\d+)\.(\d+)$/u.exec(sourceMapPackage.version);
assert.ok(version, 'An unrecognized source-map-js version requires explicit compatibility review.');
const [major, minor, patch] = version.slice(1).map(Number);
assert.equal(major, 1, 'An unknown source-map-js major version requires explicit compatibility review.');
const patchedSourceMap = major === 1 && (minor! > 2 || (minor === 2 && patch! >= 2));

// On the old lock these are reported as skips, never as passed patched regressions.
// The selected 1.2.2 candidate enables them. Unknown major versions require review.
const patchedTest = test.skipIf(!patchedSourceMap);

type IndexedMap = {
  version: 3;
  sections: { offset: { line: unknown; column: unknown }; map: RawSourceMap | IndexedMap }[];
};

function flatMap(): RawSourceMap {
  const generator = new SourceMapGenerator({ file: 'synthetic.js' });
  generator.addMapping({
    generated: { line: 1, column: 0 },
    original: { line: 1, column: 0 },
    source: 'synthetic.ts',
  });
  generator.setSourceContent('synthetic.ts', 'run();\n');
  return generator.toJSON();
}

function indexedMap(line: unknown, column: unknown, map: RawSourceMap | IndexedMap = flatMap()): IndexedMap {
  return { version: 3, sections: [{ offset: { line, column }, map }] };
}

function consume(map: RawSourceMap | IndexedMap): SourceMapConsumer {
  // This dependency's declarations describe flat maps only; its public consumer also accepts indexed maps.
  return new SourceMapConsumer(map as RawSourceMap);
}

test('SDK stdio starts a synthetic server, discovers a tool, validates input and closes', async () => {
  const server = `
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
const server = new McpServer({ name: 'synthetic-dependency-compatibility', version: '1.0.0' });
server.registerTool('synthetic_echo', {
  description: 'Return a bounded synthetic value',
  inputSchema: { message: z.string().max(64) },
}, ({ message }) => ({ content: [{ type: 'text', text: message }] }));
await server.connect(new StdioServerTransport());
`;
  const environment: Record<string, string> = {};
  for (const key of ['HOME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR']) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--max-old-space-size=96', '--input-type=module', '-e', server],
    cwd: packageRoot,
    env: environment,
    stderr: 'pipe',
    maxBufferSize: 64 * 1024,
  });
  const client = new Client({ name: 'synthetic-dependency-client', version: '1.0.0' });
  let stderr = '';
  transport.stderr?.on('data', (bytes: Buffer) => {
    stderr = (stderr + bytes.toString()).slice(0, 4096);
  });
  try {
    await client.connect(transport, { timeout: 3000 });
    assert.deepEqual(client.getServerVersion(), { name: 'synthetic-dependency-compatibility', version: '1.0.0' });
    assert.ok(transport.pid !== null, 'The stdio transport must start its own synthetic child.');
    const discovery = await client.listTools({}, { timeout: 3000 });
    assert.deepEqual(
      discovery.tools.map((tool) => tool.name),
      ['synthetic_echo'],
    );
    assert.deepEqual(discovery.tools[0]?.inputSchema.required, ['message']);
    const response = await client.callTool(
      { name: 'synthetic_echo', arguments: { message: 'synthetic value' } },
      undefined,
      { timeout: 3000 },
    );
    assert.equal(response.isError, undefined);
    assert.deepEqual(response.content, [{ type: 'text', text: 'synthetic value' }]);
    const rejected = await client.callTool({ name: 'synthetic_echo', arguments: { message: 7 } }, undefined, {
      timeout: 3000,
    });
    assert.equal(rejected.isError, true);
    assert.equal(stderr, '', `Synthetic server stderr: ${stderr}`);
  } finally {
    await client.close();
    await transport.close();
  }
  assert.equal(transport.pid, null);
});

test('SourceNode preserves bounded valid indexed-map code, positions and source content', () => {
  const code = 'prefix\nprefix\n    run();\n';
  const node = SourceNode.fromStringWithSourceMap(code, consume(indexedMap(2, 4)));
  assert.equal(node.toString(), code);
  const rendered = node.toStringWithSourceMap({ file: 'synthetic.js' });
  assert.equal(rendered.code, code);
  const roundTrip = consume(rendered.map.toJSON());
  assert.deepEqual(roundTrip.originalPositionFor({ line: 3, column: 4 }), {
    source: 'synthetic.ts',
    line: 1,
    column: 0,
    name: null,
  });
  assert.equal(roundTrip.sourceContentFor('synthetic.ts'), 'run();\n');
});

test('SourceNode preserves bounded valid nested indexed-map positions and content', () => {
  const code = 'prefix\nprefix\n    run();\n';
  const node = SourceNode.fromStringWithSourceMap(code, consume(indexedMap(1, 0, indexedMap(1, 4))));
  const rendered = node.toStringWithSourceMap({ file: 'synthetic.js' });
  assert.equal(rendered.code, code);
  const roundTrip = consume(rendered.map.toJSON());
  assert.deepEqual(roundTrip.originalPositionFor({ line: 3, column: 4 }), {
    source: 'synthetic.ts',
    line: 1,
    column: 0,
    name: null,
  });
  assert.equal(roundTrip.sourceContentFor('synthetic.ts'), 'run();\n');
});

test('consumer-to-generator serialization preserves a small valid flat map', () => {
  const original = consume(flatMap());
  const generator = SourceMapGenerator.fromSourceMap(original);
  const serialized = generator.toString();
  assert.ok(serialized.length < 2048, 'The valid fixture must stay small.');
  const roundTrip = consume(JSON.parse(serialized) as RawSourceMap);
  assert.deepEqual(roundTrip.originalPositionFor({ line: 1, column: 0 }), {
    source: 'synthetic.ts',
    line: 1,
    column: 0,
    name: null,
  });
  assert.equal(roundTrip.sourceContentFor('synthetic.ts'), 'run();\n');
});

patchedTest('patched SourceNode skips exhausted code with a strict operation bound', () => {
  let additions = 0;
  const originalAdd = SourceNode.prototype.add;
  const add = vi.spyOn(SourceNode.prototype, 'add').mockImplementation(function (this: SourceNode, chunk: string) {
    additions += 1;
    assert.ok(additions <= 64, 'Stop a regressed loop before it can do excessive work.');
    return originalAdd.call(this, chunk);
  });
  try {
    const code = 'run();\n';
    const node = SourceNode.fromStringWithSourceMap(code, consume(indexedMap(2048, 0)));
    assert.equal(node.toString(), code);
    assert.ok(additions < 16, 'Exhausted code must not iterate through empty generated lines.');
  } finally {
    add.mockRestore();
  }
});

patchedTest('patched consumer rejects extreme offsets before SourceNode or generator conversion', () => {
  // These constant-size maps are constructed only on a patched version. Never flatten an accepted huge offset.
  assert.throws(() => consume(indexedMap(10_000_001, 0)), /Section offset line must not exceed/u);
  assert.throws(
    () => consume(indexedMap(6_000_000, 0, indexedMap(6_000_000, 0))),
    /including offsets of nested sections/u,
  );
});

patchedTest.each([
  ['negative line', -1, 0],
  ['negative column', 0, -1],
  ['fractional line', 0.5, 0],
  ['fractional column', 0, 0.5],
  ['string line', '1', 0],
  ['string column', 0, '1'],
  ['NaN line', Number.NaN, 0],
  ['NaN column', 0, Number.NaN],
  ['infinite line', Number.POSITIVE_INFINITY, 0],
  ['infinite column', 0, Number.POSITIVE_INFINITY],
  ['unsafe integer line', Number.MAX_SAFE_INTEGER + 1, 0],
  ['unsafe integer column', 0, Number.MAX_SAFE_INTEGER + 1],
])('patched consumer rejects %s without serialization', (_name, line, column) => {
  assert.throws(
    () => consume(indexedMap(line, column)),
    /Section offset line and column must be non-negative integers/u,
  );
});
