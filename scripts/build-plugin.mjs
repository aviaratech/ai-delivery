import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, stop } from 'esbuild';

/** Collect full notices even for dependencies without legal source comments.
 * @param {string} root @param {import('esbuild').Metafile} metafile */
function dependencyNotices(root, metafile) {
  const packages = /** @type {Map<string, string>} */ (new Map());
  for (const input of Object.keys(metafile.inputs)) {
    if (!input.split('/').includes('node_modules')) continue;
    let directory = dirname(resolve(root, input));
    while (directory !== parse(directory).root) {
      const path = join(directory, 'package.json');
      if (existsSync(path)) {
        const metadata = /** @type {Record<string, unknown>} */ (JSON.parse(readFileSync(path, 'utf8')));
        if (typeof metadata.name === 'string' && typeof metadata.version === 'string') {
          const key = `${metadata.name}@${metadata.version}`;
          if (!packages.has(key)) {
            const license =
              typeof metadata.license === 'string'
                ? metadata.license
                : (JSON.stringify(metadata.license) ?? 'see package notices');
            const notices = readdirSync(directory)
              .filter((name) => /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/iu.test(name))
              .sort()
              .map((name) => `### ${name}\n\n${readFileSync(join(directory, name), 'utf8').trim()}\n`);
            packages.set(key, `## ${key}\n\nLicense: ${license}\n\n${notices.join('\n')}`);
          }
          break;
        }
      }
      directory = dirname(directory);
    }
  }
  return `# Bundled dependency notices\n\n${[...packages]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, notice]) => notice)
    .join('\n')}`;
}

/** @param {string} root */
export async function buildPlugin(root) {
  const metadata = /** @type {Record<string, unknown>} */ (
    JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  );
  const pluginRoot = join(root, 'plugins/ai-delivery');
  const runtimeRoot = join(pluginRoot, 'runtime');
  const portable = /** @type {Record<string, unknown>} */ (
    JSON.parse(readFileSync(join(pluginRoot, 'plugin.json'), 'utf8'))
  );
  const compatibility = /** @type {Record<string, unknown>} */ (
    JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin/plugin.json'), 'utf8'))
  );
  for (const plugin of [portable, compatibility]) {
    assert.equal(plugin.name, 'ai-delivery');
    assert.equal(plugin.version, metadata.version, 'Native manifest must match the package version');
  }
  assert.equal(compatibility.packageVersion, metadata.version);
  assert.equal(compatibility.deliveryCapabilityVersion, 2);
  rmSync(join(runtimeRoot, 'dist'), { recursive: true, force: true });
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['dist/cli.js'],
    outfile: join(runtimeRoot, 'dist/cli.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    minify: true,
    keepNames: true,
    metafile: true,
    legalComments: 'eof',
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module";const require = __createRequire(import.meta.url);',
    },
    logLevel: 'warning',
  });
  writeFileSync(join(runtimeRoot, 'dist/THIRD-PARTY-NOTICES.md'), dependencyNotices(root, result.metafile));
  writeFileSync(
    join(runtimeRoot, 'package.json'),
    `${JSON.stringify({ name: metadata.name, version: metadata.version, type: metadata.type, bin: metadata.bin, license: metadata.license, engines: metadata.engines }, null, 2)}\n`,
  );
  chmodSync(join(runtimeRoot, 'dist/cli.js'), 0o755);
  rmSync(join(pluginRoot, 'dist'), { recursive: true, force: true });
  mkdirSync(join(pluginRoot, 'dist'));
  copyFileSync(join(root, 'scripts/mcp-launcher.mjs'), join(pluginRoot, 'dist/mcp-launcher.js'));
  chmodSync(join(pluginRoot, 'dist/mcp-launcher.js'), 0o755);
  copyFileSync(join(root, 'LICENSE'), join(pluginRoot, 'LICENSE'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await buildPlugin(process.cwd());
  } finally {
    await stop();
  }
}
