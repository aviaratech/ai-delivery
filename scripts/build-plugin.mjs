import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

import metadata from '../package.json' with { type: 'json' };
import compatibility from '../plugins/ai-delivery/.claude-plugin/plugin.json' with { type: 'json' };
import portable from '../plugins/ai-delivery/plugin.json' with { type: 'json' };

const root = fileURLToPath(new URL('../', import.meta.url));
const pluginRoot = join(root, 'plugins', 'ai-delivery');
const runtimeRoot = join(pluginRoot, 'runtime');
for (const plugin of [portable, compatibility]) {
  assert.equal(plugin.name, 'ai-delivery');
  assert.equal(plugin.version, metadata.version, 'Native manifest must match the package version');
}
assert.equal(compatibility.packageVersion, metadata.version);
assert.equal(compatibility.deliveryCapabilityVersion, 2);

// Reuse the builder already pinned in the canonical npm lockfile. Bundle the
// existing CLI into an actual plugin-local runtime, preserving the real entry
// path and adjacent package identity used by admission and producer hashing.
await build({
  configFile: false,
  root,
  ssr: { noExternal: true },
  logLevel: 'warn',
  build: {
    ssr: join(root, 'dist', 'cli.js'),
    outDir: join(runtimeRoot, 'dist'),
    emptyOutDir: true,
    copyPublicDir: false,
    minify: true,
    license: { fileName: 'THIRD-PARTY-NOTICES.md' },
    rolldownOptions: {
      output: {
        entryFileNames: 'cli.js',
        codeSplitting: false,
      },
    },
  },
});
writeFileSync(
  join(runtimeRoot, 'package.json'),
  `${JSON.stringify({ name: metadata.name, version: metadata.version, type: metadata.type, bin: metadata.bin, license: metadata.license, engines: metadata.engines }, null, 2)}\n`,
);
chmodSync(join(runtimeRoot, 'dist', 'cli.js'), 0o755);
rmSync(join(pluginRoot, 'dist'), { recursive: true, force: true });
mkdirSync(join(pluginRoot, 'dist'));
copyFileSync(join(root, 'scripts', 'mcp-launcher.mjs'), join(pluginRoot, 'dist', 'mcp-launcher.js'));
chmodSync(join(pluginRoot, 'dist', 'mcp-launcher.js'), 0o755);
copyFileSync(join(root, 'LICENSE'), join(pluginRoot, 'LICENSE'));
