import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const repository = fileURLToPath(new URL('../', import.meta.url));

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-build-')));
  const write = (path: string, content: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  write(
    'package.json',
    JSON.stringify({
      name: 'fictional-build',
      version: '1.0.0',
      type: 'module',
      license: 'MIT',
      bin: { fixture: './dist/cli.js' },
    }),
  );
  write('src/nested/value.ts', 'export const answer: number = 42;\n');
  write(
    'src/cli.ts',
    '#!/usr/bin/env node\nimport { answer } from "./nested/value.js"; process.stdout.write(String(answer));\n',
  );
  return { root, write, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function build(root: string, ...flags: string[]) {
  const result = spawnSync(process.execPath, [join(repository, 'scripts/build.mjs'), ...flags], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 ** 2,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}

test(
  'JavaScript emit preserves nested ESM imports, source maps, executable CLI and prepared declarations',
  { tags: ['release'] },
  () => {
    const f = fixture();
    try {
      f.write('dist/nested/value.d.ts', 'export declare const answer: number;\n');
      build(f.root);
      const output = spawnSync(process.execPath, [join(f.root, 'dist/cli.js')], { encoding: 'utf8' });
      assert.equal(output.status, 0, output.stderr);
      assert.equal(output.stdout, '42');
      assert.ok(statSync(join(f.root, 'dist/cli.js')).mode & 0o111);
      assert.ok(readFileSync(join(f.root, 'dist/cli.js'), 'utf8').startsWith('#!/usr/bin/env node\n'));
      assert.equal(
        readFileSync(join(f.root, 'dist/nested/value.d.ts'), 'utf8'),
        'export declare const answer: number;\n',
      );
      const map = JSON.parse(readFileSync(join(f.root, 'dist/nested/value.js.map'), 'utf8')) as { sources: string[] };
      assert.deepEqual(map.sources, ['../../src/nested/value.ts']);
    } finally {
      f.cleanup();
    }
  },
);

test('explicit clean emit removes stale outputs without retaining deleted test files', { tags: ['release'] }, () => {
  const f = fixture();
  try {
    f.write('dist/deleted.test.js', 'throw new Error("stale");\n');
    build(f.root, '--clean');
    assert.equal(existsSync(join(f.root, 'dist/deleted.test.js')), false);
    assert.equal(existsSync(join(f.root, 'dist/nested/value.js')), true);
  } finally {
    f.cleanup();
  }
});

test('plugin emit retains standalone CLI identity and full bundled package license text', { tags: ['release'] }, () => {
  const f = fixture();
  try {
    f.write(
      'src/cli.ts',
      '#!/usr/bin/env node\nimport { answer } from "fictional-dependency";process.stdout.write(String(answer));\n',
    );
    f.write(
      'node_modules/fictional-dependency/package.json',
      JSON.stringify({
        name: 'fictional-dependency',
        version: '2.0.0',
        type: 'module',
        main: 'index.js',
        license: 'MIT',
      }),
    );
    f.write('node_modules/fictional-dependency/index.js', 'export const answer = 42;\n');
    f.write(
      'node_modules/fictional-dependency/LICENSE',
      'Fictional full license text without a legal source comment.\n',
    );
    f.write('LICENSE', 'Fictional application license.\n');
    f.write('scripts/mcp-launcher.mjs', '#!/usr/bin/env node\n');
    f.write('plugins/ai-delivery/plugin.json', JSON.stringify({ name: 'ai-delivery', version: '1.0.0' }));
    f.write(
      'plugins/ai-delivery/.claude-plugin/plugin.json',
      JSON.stringify({ name: 'ai-delivery', version: '1.0.0', packageVersion: '1.0.0', deliveryCapabilityVersion: 2 }),
    );
    build(f.root, '--plugin');
    const runtime = join(f.root, 'plugins/ai-delivery/runtime');
    const output = spawnSync(process.execPath, [join(runtime, 'dist/cli.js')], { encoding: 'utf8' });
    assert.equal(output.status, 0, output.stderr);
    assert.equal(output.stdout, '42');
    const metadata = JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    assert.equal(metadata.name, 'fictional-build');
    assert.equal(metadata.version, '1.0.0');
    const notices = readFileSync(join(runtime, 'dist/THIRD-PARTY-NOTICES.md'), 'utf8');
    assert.match(notices, /fictional-dependency@2\.0\.0/u);
    assert.match(notices, /Fictional full license text without a legal source comment\./u);
    assert.equal(readFileSync(join(f.root, 'plugins/ai-delivery/LICENSE'), 'utf8'), 'Fictional application license.\n');
    assert.ok(statSync(join(f.root, 'plugins/ai-delivery/dist/mcp-launcher.js')).mode & 0o111);
  } finally {
    f.cleanup();
  }
});
