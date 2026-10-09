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
import { syntheticDiscoveryConfig } from './fixtures/discovery.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const pluginRoot = join(packageRoot, 'plugins', 'ai-delivery');

test('README and delivery skill CLI examples name supported commands and required options', () => {
  const cli = readFileSync(join(packageRoot, 'src', 'cli.ts'), 'utf8');
  const declarations = [...cli.matchAll(/\.command\('([^']+)'\)/gu)];
  const required = new Map(
    declarations.map((match) => {
      const next = cli.indexOf('.command(', match.index + match[0].length);
      return [
        match[1]!,
        [...cli.slice(match.index, next < 0 ? undefined : next).matchAll(/\.requiredOption\('--([a-z0-9-]+)/gu)].map(
          (option) => `--${option[1]}`,
        ),
      ];
    }),
  );
  const globals = new Set(['--repo', '--repo-root', '--identity']);
  for (const path of [
    'README.md',
    'plugins/ai-delivery/skills/worktree-lifecycle/SKILL.md',
    'plugins/ai-delivery/skills/pr-handoff/SKILL.md',
  ]) {
    const source = readFileSync(join(packageRoot, path), 'utf8').replace(/\\\r?\n\s*/gu, ' ');
    for (const match of source.matchAll(/^ai-delivery\s+(.+)$/gmu)) {
      const words = match[1]!.split(/\s+/u);
      let index = 0;
      while (globals.has(words[index] ?? '')) index += 2;
      const command = words[index]!;
      const subcommand = command === 'plugin' ? words[index + 1] : undefined;
      const help = execFileSync(
        process.execPath,
        [join(packageRoot, 'dist', 'cli.js'), command, ...(subcommand === undefined ? [] : [subcommand]), '--help'],
        { encoding: 'utf8', maxBuffer: 65536 },
      );
      for (const flag of required.get(command) ?? [])
        assert.ok(words.includes(flag), `${path}: ${command} requires ${flag}`);
      for (const flag of words.filter((word) => word.startsWith('--')))
        assert.ok(globals.has(flag) || help.includes(flag), `${path}: ${command} does not support ${flag}`);
    }
  }
});

for (const launchCheckout of [false, true]) {
  test(`the bundled launcher creates and updates repository B from ${launchCheckout ? 'checkout A' : 'a non-Git directory'} without an identity environment`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'delivery-launch-routing-')));
    if (launchCheckout) {
      execFileSync('git', ['init', '-q', directory]);
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/a.git'], { cwd: directory });
    }
    const preload = join(directory, 'mock-github.mjs');
    const calls = join(directory, 'requests.json');
    const settings = join(directory, 'user.json');
    writeFileSync(
      settings,
      JSON.stringify({
        schemaVersion: 'ai-delivery.user@1',
        roles: {
          author: { authSource: 'personal', identity: 'operator', credentialEnv: { token: 'SYNTHETIC_TOKEN' } },
          reviewer: {
            identity: 'reviewer',
            credentialEnv: { appId: 'REVIEW_APP', installationId: 'REVIEW_INSTALL', privateKeyPath: 'REVIEW_KEY' },
          },
        },
        project: 1,
        checkoutRoots: [],
        pointsField: 'Estimate',
        priorityField: 'Urgency',
        statusField: 'Flow',
        statuses: syntheticDiscoveryConfig.native.project.statuses,
      }),
    );
    writeFileSync(
      preload,
      `
import {writeFileSync} from 'node:fs';
import {syntheticDiscoveryClients} from ${JSON.stringify(new URL('./fixtures/discovery.js', import.meta.url).href)};
const configuration=${JSON.stringify(syntheticDiscoveryConfig)};
const requests=[];
let issue={id:117,number:17,node_id:'ISSUE17',title:'Widget',body:'',state:'open',labels:[],html_url:'https://github.com/example/b/issues/17'};
const page=nodes=>({nodes,pageInfo:{hasNextPage:false,endCursor:null}});
globalThis.fetch=async(url,init)=>{
  const path=new URL(String(url)).pathname;const method=init?.method??'GET';
  requests.push({path,method});writeFileSync(${JSON.stringify(calls)},JSON.stringify(requests));
  const json=init?.body?JSON.parse(init.body):{};
  let data;
  if(path==='/graphql'){
    const query=json.query;
    if(query.includes('ProjectDeliveryItems'))data={organization:{projectV2:{items:page([{id:'ITEM17',isArchived:false,content:{id:'ISSUE17'},fieldValueByName:{name:'Queued',optionId:'STATUS-0'}}])}}};
    else if(query.includes('blockedBy('))data={repository:{issue:{parent:null,blockedBy:page([])}}};
    else data=await syntheticDiscoveryClients({...configuration,repository:'example/'+(json.variables?.repo??'b')}).graphql(query,json.variables);
    return new Response(JSON.stringify({data}),{status:200,headers:{'content-type':'application/json'}});
  }
  if(path.endsWith('/labels'))data=[{name:'enhancement'},{name:'bug'}];
  else if(path.endsWith('/issue-field-values'))data=[];
  else if(path.endsWith('/issues')&&method==='POST'){issue={...issue,...json};data=issue;}
  else if(path.endsWith('/issues/17')){if(method==='PATCH')issue={...issue,...json};data=issue;}
  else throw new Error('Unexpected synthetic request '+method+' '+path);
  return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
};
`,
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(pluginRoot, 'dist', 'mcp-launcher.js')],
      cwd: directory,
      env: {
        PATH: process.env.PATH ?? '',
        TMPDIR: tmpdir(),
        AI_DELIVERY_CONFIG: settings,
        SYNTHETIC_TOKEN: 'inert-personal-token',
        NODE_OPTIONS: `--v8-pool-size=1 --import=${preload}`,
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'actual-launch-routing', version: '1' });
    try {
      await client.connect(transport, { timeout: 30000 });
      const created = await client.callTool({
        name: 'issue_create',
        arguments: { repo: 'example/b', title: 'Widget', labels: ['enhancement'] },
      });
      assert.equal(created.isError, undefined, JSON.stringify(created));
      const updated = await client.callTool({
        name: 'issue_update',
        arguments: { repo: 'example/b', issueNumber: 17, labels: ['bug'] },
      });
      assert.equal(updated.isError, undefined, JSON.stringify(updated));
      const unknown = await client.callTool({
        name: 'issue_create',
        arguments: { repo: 'example/b', title: 'Unknown', labels: ['missing-label'] },
      });
      assert.equal(unknown.isError, true);
      assert.match(JSON.stringify(unknown), /Unknown repository label.*missing-label/u);
      const requests = JSON.parse(readFileSync(calls, 'utf8')) as Array<{ path: string; method: string }>;
      assert.equal(requests.filter((call) => call.path.endsWith('/issues') && call.method === 'POST').length, 1);
      assert.equal(existsSync(join(directory, '.issue-cli')), false);
    } finally {
      await client.close();
      await transport.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

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
