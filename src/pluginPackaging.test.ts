import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { test } from 'vitest';

import pkg from '../package.json' with { type: 'json' };
import { AI_DELIVERY_MCP_TOOLS } from './mcp/tools.js';
import type { LoadedDeliveryConfig } from './config/deliveryConfig.js';
import { buildRuntimeAdmission, validateRuntimeAdmission } from './services/deliveryAdmission.js';
import { retainedWorktreeTransitionProducerDigest } from './verification.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const pluginRoot = join(packageRoot, 'plugins', 'ai-delivery');

test('CLI reports the selected package version', () => {
  const displayed = execFileSync(process.execPath, [join(packageRoot, 'dist', 'cli.js'), '--version'], {
    encoding: 'utf8',
    maxBuffer: 65536,
  }).trim();
  assert.equal(displayed, pkg.version);
});

test('portable and Claude plugin metadata bind the same package and launcher', () => {
  const portable = JSON.parse(readFileSync(join(pluginRoot, 'plugin.json'), 'utf8')) as {
    $schema: string;
    name: string;
    version: string;
  };
  const claude = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')) as {
    name: string;
    version: string;
    packageVersion: string;
    deliveryCapabilityVersion: number;
  };
  assert.equal(portable.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(portable.name, 'ai-delivery');
  assert.equal(portable.version, pkg.version);
  assert.equal(claude.name, portable.name);
  assert.equal(claude.version, pkg.version);
  assert.equal(claude.packageVersion, pkg.version);
  assert.equal(claude.deliveryCapabilityVersion, 2);
  const mcp = JSON.parse(readFileSync(join(pluginRoot, 'mcp.json'), 'utf8')) as {
    $schema: string;
    mcpServers: Record<string, { type: string; command: string; args: string[] }>;
  };
  assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  assert.deepEqual(mcp.mcpServers['ai-delivery'], {
    type: 'stdio',
    command: 'node',
    args: ['${PLUGIN_ROOT}/dist/mcp-launcher.js'],
  });
});

test('a copied plugin root starts its exact MCP contract without a parent runtime installation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-delivery-plugin-cache-'));
  const copiedRoot = join(directory, 'plugin');
  cpSync(pluginRoot, copiedRoot, { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(copiedRoot, 'dist', 'mcp-launcher.js')],
    cwd: copiedRoot,
    env: { PATH: process.env.PATH ?? '', TMPDIR: tmpdir(), NODE_OPTIONS: '--max-old-space-size=2048' },
    stderr: 'pipe',
    maxBufferSize: 1024 * 1024,
  });
  const client = new Client({ name: 'isolated-plugin-cache-test', version: '1.0.0' });
  let pid: number | null = null;
  try {
    await client.connect(transport, { timeout: 30000 });
    pid = transport.pid;
    assert.equal(client.getServerVersion()?.version, pkg.version);
    const result = await client.listTools({}, { timeout: 30000 });
    assert.deepEqual(
      result.tools.map((tool) => tool.name).sort(),
      AI_DELIVERY_MCP_TOOLS.map((tool) => tool.name).sort(),
    );
    assert.equal(existsSync(join(copiedRoot, '.issue-cli')), false);
  } finally {
    await client.close();
    await transport.close();
    const ownedPid = pid;
    try {
      if (ownedPid !== null) assert.throws(() => process.kill(ownedPid, 0), { code: 'ESRCH' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('standalone plugin ships application and bundled dependency notices', () => {
  assert.equal(readFileSync(join(pluginRoot, 'LICENSE'), 'utf8'), readFileSync(join(packageRoot, 'LICENSE'), 'utf8'));
  const notices = readFileSync(join(pluginRoot, 'runtime', 'dist', 'THIRD-PARTY-NOTICES.md'), 'utf8');
  assert.match(notices, /@modelcontextprotocol\/sdk/u);
  assert.match(notices, /commander/u);
});

test('a copied plugin has a real CLI and producer identity that existing admission can bind', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-native-identity-')));
  const copiedRoot = join(directory, 'plugin');
  cpSync(pluginRoot, copiedRoot, { recursive: true });
  // The validator only reads repository/configDigest. No repository config,
  // credentials, admission publication or lifecycle authority exists here.
  const configuration = {
    config: { repository: 'example/widget' },
    configDigest: `sha256:${'a'.repeat(64)}`,
  } as unknown as LoadedDeliveryConfig;
  try {
    const cliPath = join(copiedRoot, 'runtime', 'dist', 'cli.js');
    assert.equal(
      execFileSync(process.execPath, [cliPath, '--version'], { encoding: 'utf8', maxBuffer: 65536 }).trim(),
      pkg.version,
    );
    const admission = buildRuntimeAdmission({
      cliPath,
      mcpLauncherPath: join(copiedRoot, 'dist', 'mcp-launcher.js'),
      pluginManifestPath: join(copiedRoot, '.claude-plugin', 'plugin.json'),
      packageVersion: pkg.version,
      sourceArchiveSha256: `sha256:${'b'.repeat(64)}`,
      sourceCommit: '1'.repeat(40),
      configuration,
    });
    assert.equal(validateRuntimeAdmission(admission, configuration, cliPath).admissionId, admission.admissionId);
    assert.match(
      retainedWorktreeTransitionProducerDigest(join(copiedRoot, 'runtime', 'dist')),
      /^sha256:[a-f0-9]{64}$/u,
    );
    const otherRoot = join(directory, 'other');
    cpSync(copiedRoot, otherRoot, { recursive: true });
    assert.throws(() =>
      validateRuntimeAdmission(admission, configuration, join(otherRoot, 'runtime', 'dist', 'cli.js')),
    );
    writeFileSync(cliPath, `${readFileSync(cliPath, 'utf8')}\n/* altered runtime */\n`);
    assert.throws(() => validateRuntimeAdmission(admission, configuration, cliPath));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
