import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { test } from 'vitest';

import pkg from '../package.json' with { type: 'json' };
import { AI_DELIVERY_MCP_TOOLS } from './mcp/tools.js';
import type { LoadedDeliveryConfig } from './config/deliveryConfig.js';
import { buildRuntimeAdmission, validateRuntimeAdmission } from './services/deliveryAdmission.js';
import { retainedWorktreeTransitionProducerDigest } from './verification.js';
import { syntheticDiscoveryConfig } from './fixtures/discovery.js';
import { BoardReconcilePlanSchema, BoardReconcileResultSchema } from './services/boardReconcileService.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const pluginRoot = join(packageRoot, 'plugins', 'ai-delivery');
const qualificationOwner = (await import(new URL('../scripts/current-qualification.mjs', import.meta.url).href)) as {
  copyReleaseArchive(
    contractPath: string,
    cwd: string,
    destination: string,
  ): { archivePath: string; archiveSha256: string };
};

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
  test(
    `the ${launchCheckout ? 'bundled' : 'packed'} launcher creates, updates and journals repository B from ${launchCheckout ? 'checkout A' : 'a non-Git directory'} without an identity environment`,
    { tags: launchCheckout ? [] : ['release'] },
    async () => {
      const directory = realpathSync(mkdtempSync(join(tmpdir(), 'delivery-launch-routing-')));
      let selectedPluginRoot = pluginRoot;
      let discoveryFixture = new URL('./fixtures/discovery.js', import.meta.url).href;
      if (!launchCheckout) {
        try {
          const archive = qualificationOwner.copyReleaseArchive(
            process.env.AI_DELIVERY_RELEASE_CONTRACT ?? '',
            packageRoot,
            join(directory, 'qualified.tgz'),
          );
          const unpacked = join(directory, 'unpacked');
          mkdirSync(unpacked);
          execFileSync('tar', ['-xzf', archive.archivePath, '-C', unpacked]);
          selectedPluginRoot = join(directory, 'plugin-cache');
          // Detach the packed native plugin so the launcher uses its bundled runtime,
          // rather than the package-local CLI whose npm dependencies are not installed here.
          cpSync(join(unpacked, 'package', 'plugins', 'ai-delivery'), selectedPluginRoot, { recursive: true });
          discoveryFixture = pathToFileURL(join(unpacked, 'package', 'dist', 'fixtures', 'discovery.js')).href;
          assert.equal(existsSync(join(selectedPluginRoot, 'runtime', 'dist', 'cli.js')), true);
        } catch (error) {
          rmSync(directory, { recursive: true, force: true });
          throw error;
        }
      }
      if (launchCheckout) {
        execFileSync('git', ['init', '-q', directory]);
        execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/a.git'], { cwd: directory });
      }
      const preload = join(directory, 'mock-github.mjs');
      const calls = join(directory, 'requests.json');
      const settings = join(directory, 'user.json');
      const boardStatePath = join(directory, 'board-state.json');
      writeFileSync(boardStatePath, JSON.stringify({ member: 'ITEM17', status: 'Todo', writes: [] }));
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
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {syntheticDiscoveryClients} from ${JSON.stringify(discoveryFixture)};
const configuration=${JSON.stringify(syntheticDiscoveryConfig)};
const comments=[];
const fields=[configuration.native.points,configuration.native.priority].map(field=>({id:Number(field.databaseId),name:field.name,data_type:'single_select',options:field.values.map(name=>({name:String(name)}))}));
let fieldValues=[];
let issue={id:117,number:17,node_id:'ISSUE17',title:'Widget',body:'',state:'open',labels:[],html_url:'https://github.com/example/b/issues/17'};
const page=nodes=>({nodes,pageInfo:{hasNextPage:false,endCursor:null}});
globalThis.fetch=async(url,init)=>{
  const requests=existsSync(${JSON.stringify(calls)})?JSON.parse(readFileSync(${JSON.stringify(calls)},'utf8')):[];
  const boardState=JSON.parse(readFileSync(${JSON.stringify(boardStatePath)},'utf8'));
  const saveBoard=()=>writeFileSync(${JSON.stringify(boardStatePath)},JSON.stringify(boardState));
  const path=new URL(String(url)).pathname;const method=init?.method??'GET';
  requests.push({path,method});writeFileSync(${JSON.stringify(calls)},JSON.stringify(requests));
  const json=init?.body?JSON.parse(init.body):{};
  let data;
  if(path==='/graphql'){
    const query=json.query;
    const item=()=>({id:boardState.member,isArchived:false,project:{id:'PROJECT-1',number:1},content:{__typename:'Issue',id:'ISSUE17',number:17,repository:{nameWithOwner:'example/b'}},fieldValueByName:boardState.status===null?null:{name:'Queued',optionId:'STATUS-0'}});
    if(boardState.failDiscovery==='access'&&query.includes('DeliveryRepository'))return new Response(JSON.stringify({message:'Synthetic access denied'}),{status:403,headers:{'content-type':'application/json'}});
    if(query.includes('AddProjectDeliveryItem')){
      boardState.member='ADDED17';boardState.status='Todo';boardState.writes.push('add');
      const lost=boardState.failAddResponse;boardState.failAddResponse=false;saveBoard();
      if(lost)throw new Error('Synthetic lost add response');
      data={addProjectV2ItemById:{item:{id:boardState.member}}};
    }
    else if(query.includes('ProjectDeliveryItems'))data={organization:{projectV2:{id:'PROJECT-1',number:1,items:page(boardState.member?[item()]:[])}}};
    else if(query.includes('ProjectDeliveryItemReadback'))data={node:boardState.member===json.variables.itemId?item():null};
    else if(query.includes('blockedBy('))data={repository:{issue:{id:'ISSUE17',number:17,repository:{nameWithOwner:'example/b'},parent:null,blockedBy:page([])}}};
    else if(query.includes('DeliveryIssueBranches'))data={repository:{issue:{linkedBranches:page([])}}};
    else {
      data=await syntheticDiscoveryClients({...configuration,repository:'example/'+(json.variables?.repo??'b')}).graphql(query,json.variables);
      if(boardState.failDiscovery==='pages'&&query.includes('ProjectDeliveryConfiguration')){
        if(json.variables.cursor!=null)data.organization.projectV2.fields.nodes=[];
        data.organization.projectV2.fields.pageInfo={hasNextPage:true,endCursor:'next-'+String(json.variables.cursor??'first')};
      }
    }
    return new Response(JSON.stringify({data}),{status:200,headers:{'content-type':'application/json'}});
  }
  if(path==='/user')data={id:1,login:'operator'};
  else if(path.endsWith('/issues/17/comments')){
    if(method==='POST'){
      const id=91+comments.length;
      data={id,body:json.body,html_url:'https://github.com/example/b/issues/17#issuecomment-'+id,issue_url:'https://api.github.com/repos/example/b/issues/17',user:{login:'operator'}};
      comments.push(data);
    }else data=comments;
  }
  else if(path.includes('/issues/comments/'))data=comments.find(comment=>comment.id===Number(path.split('/').at(-1)));
  else if(path.endsWith('/labels'))data=[{name:'enhancement'},{name:'bug'}];
  else if(path==='/repos/example/b/issues/17/sub_issues'&&method==='GET')data=[];
  else if(path.endsWith('/issue-fields'))data=fields;
  else if(path.endsWith('/issue-field-values')){
    if(method==='POST')fieldValues=json.issue_field_values.map(entry=>({issue_field_id:entry.field_id,issue_field_name:fields.find(field=>field.id===entry.field_id).name,data_type:'single_select',value:entry.value}));
    data=fieldValues;
  }
  else if(path.endsWith('/issues')&&method==='POST'){issue={...issue,...json};data=issue;}
  else if(path.endsWith('/issues')&&method==='GET')data=[issue];
  else if(path.endsWith('/sub_issues'))data=[];
  else if(path.endsWith('/issues/17')){if(method==='PATCH')issue={...issue,...json};data=issue;}
  else throw new Error('Unexpected synthetic request '+method+' '+path);
  return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
};
`,
      );
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(selectedPluginRoot, 'dist', 'mcp-launcher.js')],
        cwd: directory,
        env: {
          PATH: process.env.PATH ?? '',
          TMPDIR: tmpdir(),
          HOME: directory,
          AI_DELIVERY_CONFIG: settings,
          SYNTHETIC_TOKEN: 'inert-personal-token',
          NODE_OPTIONS: `--v8-pool-size=1 --import=${preload}`,
        },
        stderr: 'pipe',
      });
      const client = new Client({ name: 'actual-launch-routing', version: '1' });
      try {
        await client.connect(transport, { timeout: 30000 });
        const readyInput = {
          repo: 'example/b',
          title: 'Validate widget launch routing across repositories',
          points: 2,
          problem: 'A launcher can bind a widget issue to the checkout repository instead of the explicit caller.',
          outcome: 'Create and update the issue only in explicitly selected repository B.',
          acceptanceCriteria: [
            {
              behavior: 'Create, update and journal requests address repository B with zero repository A requests.',
              verifiedBy: 'Packaged stdio client results and captured REST path assertions.',
            },
          ],
          outOfScope: ['Live authentication and host configuration.'],
        };
        const created = await client.callTool({
          name: 'issue_create',
          arguments: { ...readyInput, labels: ['enhancement'] },
        });
        assert.equal(created.isError, undefined, JSON.stringify(created));
        const updated = await client.callTool({
          name: 'issue_update',
          arguments: { repo: 'example/b', issueNumber: 17, labels: ['bug'] },
        });
        assert.equal(updated.isError, undefined, JSON.stringify(updated));
        const common = {
          repo: 'example/b',
          issueNumber: 17,
          summary: 'Packed journal validation works.',
          status: 'In progress',
          nextStep: 'Independent review',
          nextDate: '2026-10-09',
          keyNumbers: ['5 journal kinds'],
          evidence: ['https://github.com/example/b/issues/17'],
        };
        const journals = [
          { ...common, kind: 'start', outcome: 'Deliver strict validation' },
          { ...common, kind: 'progress', done: ['Added regression'], decisionNeeded: 'None' },
          { ...common, kind: 'decision', decision: 'Keep variants strict', rationale: 'Preserve the contract' },
          { ...common, kind: 'blocker', blocker: 'Review pending', resolution: 'Independent acceptance' },
          {
            ...common,
            kind: 'closeout',
            acceptance: [{ criterion: 'Explicit repo works', evidence: common.evidence[0] }],
            followUps: [],
          },
        ];
        const decoded = (response: unknown) =>
          JSON.parse((response as { content: { text: string }[] }).content[0]!.text) as {
            commentId: number;
            url: string;
            body: string;
            reused: boolean;
          };
        for (const [index, journal] of journals.entries()) {
          const response = await client.callTool({ name: 'issue_comment', arguments: { ...journal, verbose: true } });
          assert.equal(response.isError, undefined, JSON.stringify(response));
          const readback = decoded(response);
          assert.equal(readback.commentId, 91 + index);
          assert.equal(readback.url, `https://github.com/example/b/issues/17#issuecomment-${String(91 + index)}`);
          assert.equal(readback.body.split('\n')[0], common.summary);
          assert.ok(readback.body.includes(`**Kind:** ${journal.kind}.`));
          assert.match(readback.body, /<!-- ai-delivery:journal@1:sha256:[a-f0-9]{64} -->$/u);
          assert.equal(readback.reused, false);
        }
        const retried = await client.callTool({ name: 'issue_comment', arguments: journals[1]! });
        assert.equal(retried.isError, undefined, JSON.stringify(retried));
        assert.equal(decoded(retried).commentId, 92);
        assert.equal(decoded(retried).reused, true);
        const beforeInvalidRequests = (JSON.parse(readFileSync(calls, 'utf8')) as unknown[]).length;
        for (const invalid of [
          { ...journals[1], unknown: true },
          { ...journals[1], outcome: 'Wrong variant' },
          { ...journals[1], kind: 'unsupported' },
          { ...journals[1], nextDate: '2026-02-30' },
          { ...journals[1], repo: 'invalid' },
        ]) {
          const refused = await client.callTool({ name: 'issue_comment', arguments: invalid }).then(
            (result) => result.isError === true,
            () => true,
          );
          assert.equal(refused, true);
        }
        assert.equal(
          (JSON.parse(readFileSync(calls, 'utf8')) as unknown[]).length,
          beforeInvalidRequests,
          'invalid packed journals never reach configuration discovery, author authentication or writes',
        );
        const unknown = await client.callTool({
          name: 'issue_create',
          arguments: { ...readyInput, labels: ['missing-label'] },
        });
        assert.equal(unknown.isError, true);
        assert.match(JSON.stringify(unknown), /Unknown repository label.*missing-label/u);
        // Exercise the actual bundled coordinator and CLI against the same synthetic provider state.
        const boardValue = async (arguments_: Record<string, unknown>) => {
          const response = await client.callTool({ name: 'board_reconcile', arguments: arguments_ });
          assert.equal(response.isError, undefined, JSON.stringify(response));
          return JSON.parse((response.content as { text: string }[])[0]!.text) as unknown;
        };
        const boardEnv = {
          PATH: process.env.PATH ?? '',
          TMPDIR: tmpdir(),
          HOME: directory,
          AI_DELIVERY_CONFIG: settings,
          SYNTHETIC_TOKEN: 'inert-personal-token',
          NODE_OPTIONS: `--v8-pool-size=1 --import=${preload}`,
        };
        const activeCli = launchCheckout
          ? join(packageRoot, 'dist', 'cli.js')
          : join(selectedPluginRoot, 'runtime', 'dist', 'cli.js');
        const boardCli = (...args: string[]) =>
          spawnSync(process.execPath, [activeCli, 'board:reconcile', '--repositories', 'example/b', ...args], {
            cwd: directory,
            env: boardEnv,
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
          });
        writeFileSync(
          boardStatePath,
          JSON.stringify({ member: null, status: null, writes: [], failAddResponse: true }),
        );
        const plan = BoardReconcilePlanSchema.parse(await boardValue({ repositories: ['example/b'] }));
        assert.equal(plan.scopeComplete, true);
        assert.equal(plan.operations.length, 1);
        assert.equal(plan.operations[0]!.kind, 'add-membership');
        const rootLibrary = spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `import {executeTool} from ${JSON.stringify(pathToFileURL(join(packageRoot, 'dist', 'agent.js')).href)};console.log(JSON.stringify(await executeTool('board_reconcile',{repositories:['example/b']},{repoRoot:process.cwd()})));`,
          ],
          { cwd: directory, env: boardEnv, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
        );
        assert.equal(rootLibrary.status, 0, rootLibrary.stderr);
        const rootPlan = BoardReconcilePlanSchema.parse(JSON.parse(rootLibrary.stdout));
        assert.equal(rootPlan.packageIdentity!.packageVersion, plan.packageIdentity!.packageVersion);
        assert.deepEqual(rootPlan.scope, plan.scope);
        assert.deepEqual(rootPlan.operations, plan.operations);
        if (!launchCheckout) {
          assert.notDeepEqual(rootPlan.packageIdentity, plan.packageIdentity);
          const crossArtifact = BoardReconcileResultSchema.parse(
            await boardValue({ repositories: rootPlan.scope, mode: 'apply', plan: rootPlan }),
          );
          assert.equal(crossArtifact.summary.applied, 0);
          assert.equal(crossArtifact.summary.refused, 1);
        } else assert.deepEqual(rootPlan.packageIdentity, plan.packageIdentity);
        const interrupted = BoardReconcileResultSchema.parse(
          await boardValue({ repositories: plan.scope, mode: 'apply', plan }),
        );
        assert.equal(interrupted.summary.unknown, 1);
        assert.equal(interrupted.operations[0]!.attempted, true);
        const planFile = join(directory, 'plan.json'),
          priorFile = join(directory, 'prior-result.json');
        writeFileSync(planFile, JSON.stringify(plan));
        writeFileSync(priorFile, JSON.stringify(interrupted));
        const resumedCli = boardCli('--apply', '--plan-file', planFile, '--prior-result-file', priorFile);
        assert.equal(resumedCli.status, 1, resumedCli.stderr);
        const resumed = BoardReconcileResultSchema.parse(JSON.parse(resumedCli.stdout));
        assert.equal(resumed.summary.applied, 0);
        assert.equal(resumed.summary.satisfied, 1);
        assert.equal(resumed.operations[0]!.priorEvidence.at(-1)!.outcome, 'unknown');
        assert.equal(resumed.summary.unresolved, 1);
        assert.deepEqual((JSON.parse(readFileSync(boardStatePath, 'utf8')) as { writes: string[] }).writes, ['add']);
        writeFileSync(boardStatePath, JSON.stringify({ member: null, status: null, writes: [] }));
        const partialCli = boardCli('--apply', '--plan-file', planFile);
        assert.equal(partialCli.status, 1, partialCli.stderr);
        const applied = BoardReconcileResultSchema.parse(JSON.parse(partialCli.stdout));
        assert.equal(applied.summary.applied, 1);
        assert.equal(applied.operations[0]!.readback!.itemId, 'ADDED17');
        const historical = structuredClone(applied);
        historical.operations[0]!.outcome = 'unknown';
        historical.summary.applied = 0;
        historical.summary.unknown = 1;
        writeFileSync(priorFile, JSON.stringify(historical));
        const emptyPlan = BoardReconcilePlanSchema.parse(await boardValue({ repositories: ['example/b'] }));
        assert.equal(emptyPlan.operations.length, 0);
        for (const failure of ['pages', 'access']) {
          writeFileSync(
            boardStatePath,
            JSON.stringify({ member: 'ADDED17', status: 'Todo', writes: ['add'], failDiscovery: failure }),
          );
          for (const value of [
            await boardValue({ repositories: plan.scope, mode: 'apply', plan, priorResult: historical }),
            ...(() => {
              const result = boardCli('--apply', '--plan-file', planFile, '--prior-result-file', priorFile);
              assert.equal(result.status, 1, result.stderr);
              return [JSON.parse(result.stdout) as unknown];
            })(),
          ]) {
            const result = BoardReconcileResultSchema.parse(value);
            assert.equal(result.scopeComplete, false);
            assert.equal(result.planId, plan.planId);
            assert.equal(result.summary.applied, 0);
            assert.equal(result.summary.satisfied, 0);
            assert.equal(result.operations[0]!.attempted, false);
            assert.equal(result.operations[0]!.operationId, plan.operations[0]!.operationId);
            assert.ok(result.operations[0]!.knownItemIds.includes('ADDED17'));
            assert.deepEqual(result.operations[0]!.priorEvidence.at(-1)!.readback, historical.operations[0]!.readback);
            if (failure === 'pages') assert.equal(result.gaps[0]!.pagesRequested, 20);
          }
          const dry = boardCli('--dry-run');
          assert.equal(dry.status, 1, dry.stderr);
          assert.equal(BoardReconcilePlanSchema.parse(JSON.parse(dry.stdout)).scopeComplete, false);
          const empty = BoardReconcileResultSchema.parse(
            await boardValue({ repositories: emptyPlan.scope, mode: 'apply', plan: emptyPlan }),
          );
          assert.equal(empty.scopeComplete, false);
          assert.deepEqual(empty.operations, []);
        }
        writeFileSync(boardStatePath, JSON.stringify({ member: 'ADDED17', status: 'Todo', writes: ['add'] }));
        const completeDry = boardCli('--dry-run');
        assert.equal(completeDry.status, 0, completeDry.stderr);
        assert.equal(BoardReconcilePlanSchema.parse(JSON.parse(completeDry.stdout)).scopeComplete, true);
        const requests = JSON.parse(readFileSync(calls, 'utf8')) as Array<{ path: string; method: string }>;
        assert.equal(
          requests.some((call) => call.path.startsWith('/repos/example/a/')),
          false,
        );
        assert.equal(requests.filter((call) => call.path.endsWith('/issues') && call.method === 'POST').length, 1);
        assert.equal(
          requests.filter((call) => call.path.endsWith('/issues/17/comments') && call.method === 'POST').length,
          5,
          'five authored journals read back; retry adds no sixth write',
        );
        assert.equal(existsSync(join(directory, '.issue-cli')), false);
      } finally {
        await client.close();
        await transport.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
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
    const instructions = client.getInstructions();
    assert.equal(typeof instructions, 'string', 'the copied native plugin must retain initialize guidance');
    assert.match(instructions ?? '', /\brepo\b/u);
    assert.match(instructions ?? '', /\bissue_info\b/u);
    const result = await client.listTools({}, { timeout: 30000 });
    const issueInfo = result.tools.find((tool) => tool.name === 'issue_info');
    assert.ok(issueInfo);
    const properties = issueInfo.inputSchema.properties as Record<string, { description?: string }>;
    assert.equal(typeof properties.repo?.description, 'string');
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
