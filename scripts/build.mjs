#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { build, stop } from 'esbuild';
import { buildPlugin } from './build-plugin.mjs';

const root = process.cwd();
const flags = new Set(process.argv.slice(2));
assert.ok(
  [...flags].every((flag) => ['--clean', '--declarations', '--plugin'].includes(flag)),
  'Unknown build option.',
);
try {
  if (flags.has('--clean')) rmSync(join(root, 'dist'), { recursive: true, force: true });
  if (flags.has('--declarations')) {
    execFileSync(
      process.execPath,
      [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json', '--emitDeclarationOnly'],
      { cwd: root, stdio: 'inherit' },
    );
  }
  const sources = readdirSync(join(root, 'src'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  assert.ok(sources.length, 'No TypeScript sources to emit.');
  await build({
    absWorkingDir: root,
    entryPoints: sources,
    outbase: 'src',
    outdir: 'dist',
    platform: 'node',
    format: 'esm',
    target: 'node24',
    sourcemap: true,
    logLevel: 'warning',
  });
  chmodSync(join(root, 'dist/cli.js'), 0o755);
  if (flags.has('--plugin')) await buildPlugin(root);
} finally {
  await stop();
}
